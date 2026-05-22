# Story 1.9: Ops logging и алерты

Status: done

## Пользовательская история

Как **аналитик практики (Тимур)**,
Я хочу **видеть структурированные логи каждого этапа pipeline в Sheets и получать Telegram-алерты при сбоях, с эскалацией при длительной недоступности**,
Чтобы **я мог быстро диагностировать проблемы, не пропускать ошибки и не тратить > 1ч/нед на ops, плюс при моём отсутствии Айдар получал бы ping через 24ч**.

## Контекст и границы scope

**Story 1.9** закрывает критический разрыв в observability: сейчас `alertOps()` пишет ТОЛЬКО в pino-лог (`src/ops.ts:11` явный TODO: «дополнительно слать алерт в Telegram ops-канал»). На VPS pino-вывод уходит в stdout/Docker logs — Тимур не получает push-уведомление, если pipeline тихо упал в 03:00. Также нет escalation: 4ч и 24ч пороги из AC не реализованы, нет append-only Sheet (FR76, deferred-work card «Sheets write-side adapter (F5 metrics, ops logs)»).

**Архитектурный принцип:** «Observability: Logging + alerting → Sheet + Telegram ops-канал» (architecture.md#NFR table, line 58). Дублирование критических событий: pino (debug) + Sheet (история для query/aggregation) + Telegram (push). Если Sheets упал — pino + Telegram продолжают работать (NFR11 «Сбой Sheets не теряет логи и алерты»).

### Что входит в Story 1.9 (production-код в `src/`):

1. **`src/ops.ts`** — расширить `alertOps`: продолжает писать pino-лог (текущий путь), ДОПОЛНИТЕЛЬНО асинхронно отправляет сообщение в Telegram ops-чат (`config.TELEGRAM_CHAT_OPS_ID`) и append-row в Sheet `_ops_logs`. Добавить:
   - `recordOpsEvent(level, payload)` — общий entry-point для НЕ-алертных info-событий (`pipeline_started`, `pipeline_completed`), которые попадают в Sheets, но НЕ в Telegram (чтобы не спамить).
   - `setOpsTelegramSender(fn)` / `setOpsSheetsWriter(fn)` — module-level injection без жёсткой зависимости от bot/sheets (избегаем циклов: `ops.ts` зависит ОТ `logger.ts` только; `bot.ts` и `sheets.ts` зависят ОТ `ops.ts`).
   - Watchdog state: `lastSuccessAt`, `lastFailureAt`, `lastRepeatAlertAt`, `escalatedToAidarAt`. Persistent в `data/.ops-state.json` (append-write-rename для атомарности).
   - `tickWatchdog(nowMs)` — pure function: возвращает `{ shouldRepeatAlert: boolean, shouldEscalateAidar: boolean }`. Экспортируется для тестов.
   - `startWatchdog({ intervalMs })` — настраивает `setInterval`, дёргает `tickWatchdog`, эмитит алерты + обновляет state. Возвращает `stop()` функцию.
2. **`src/adapters/sheets.ts`** — добавить **write-side** (раньше был только read):
   - Расширить OAuth scope: `https://www.googleapis.com/auth/spreadsheets` (БЕЗ `.readonly`). **Перепроверить**: service account уже имеет writer rights в Google Sheet UI (Тимур должен убедиться, не код).
   - `appendOpsLog(row: OpsLogRow): Promise<void>` — `spreadsheets.values.append` к `_ops_logs!A1` с `valueInputOption: 'RAW'`, `insertDataOption: 'INSERT_ROWS'`.
   - Schema worksheet `_ops_logs` (header row, snake_case): `timestamp, pipeline, step, client_id, duration_ms, status, level, message, error_code, context_json`. `context_json` — стрингифицированный JSON (truncated на 4KB во избежание Sheets cell limit).
   - При ошибке append-write: log.warn (НЕ alertOps — иначе recursive loop) + counter `ops_log_append_failed_total` через pino (для будущего monitoring).
3. **`src/utils/telegram-formatter.ts`** — добавить:
   - `formatOpsAlert({ pipeline, step, clientId?, level, message, errorCode?, context? }): string` — plain text для ops-чата. БЕЗ `parse_mode` (escape MarkdownV2 для error stack trace — кошмар). Структура: иконка по level (🚨 error / ⚠️ warn / ℹ️ info) + 1 строка заголовок `[F1/bot.report.timeout] geonline` + 2-3 строки контекст + truncate errors до 500 chars.
   - `formatWatchdogRepeat({ lastSuccessAt, lastFailureAt, hoursDown })` — для 4ч/24ч escalation.
4. **`src/bot.ts`** — в `createBot.start()` после `setMyCommands`:
   - Если `botInfo === undefined` (production), вызвать `setOpsTelegramSender(async (text) => { await bot.api.sendMessage(config.TELEGRAM_CHAT_OPS_ID, text); })`.
   - Если есть `appendOpsLog` — вызвать `setOpsSheetsWriter(appendOpsLog)`.
   - Вызвать `startWatchdog({ intervalMs: 5*60_000 })`. Сохранить `stop()` для `createBot.stop()`.
   - При успешном завершении `processJob` (status='completed') — вызвать `recordOpsEvent('info', { pipeline:'F1', step:'bot.report.completed', clientId, durationMs, status:'ok' })` (это обновит `lastSuccessAt`).
   - При unauthorized / queue_overflow / timeout / pipeline_failed — продолжает `alertOps(...)` как сейчас (уже delegate-mode: pino + ops-Telegram + Sheets).
5. **`src/config.ts`** — добавить optional `OPS_AIDAR_MENTION` (string, e.g., `@aidar_username` или пустая строка). При empty — escalation просто шлёт повторный alert БЕЗ ping; при заданном — текст содержит mention. **НЕ добавляем `TELEGRAM_AIDAR_CHAT_ID`** — Айдар в том же ops-чате; ping через `@mention` достаточно для MVP (упрощение vs epic AC #2 line «уведомление Айдару»; рациональнее, чем заводить отдельный чат на 1 эскалацию).
6. **`.env.example`** — добавить `OPS_AIDAR_MENTION=` (пустой пример).

### Что НЕ входит в Story 1.9 (явно deferred):

- **Полный аггрегатор weekly metrics** (`time_to_approve` avg, `f5_response_rate`, `bot_menu_usage`) — это работа Story 1.12 (Ops-статус pipeline для Айдара). Story 1.9 обеспечивает, что **сырые события** для этих метрик пишутся в `_ops_logs` (timing per pipeline step + approval events) и `approvals.jsonl` (Story 1.6) с достаточной структурой; Story 1.12 строит query/render. `f5_response_rate` сейчас вообще no-op: Epic 2 deferred-growth (F5 бот не реализован на MVP). `bot_menu_usage` — Bot Menu callbacks реализуются в Story 1.12/1.13/Epic 3; Story 1.9 не отслеживает их использование (не было событий).
- **Cron job для backup-tar / cleanup `.raw.txt` 14d** — это data-persistence работа, Story 1.10.
- **Circuit breaker (3 fail / 5min)** — заглушка в `claude.ts:isClaudeCircuitOpen()` (deferred-work карточка). Не закрывается в 1.9.
- **Канареечный тест (canary)** — Story 1.11.
- **Restart-recovery missed job detection** — Story 1.10 / scheduler.
- **`Email emergency mode`** (FR87) — никогда не реализовывать на MVP, deferred-growth.
- **F3-lite escalation alerts** (Дамиру если CEO не открыл) — Epic 4.
- **F4 watchdog (cron не выполнился к 9:30)** — Epic 3 Story 3.0/3.1.
- **Aidar separate Telegram chat / отдельный ROLE-based whitelist** — на MVP Айдар = `@mention` в общем ops-чате.

### Контракт с предыдущими stories

```typescript
// Story 1.5 устанавливает (НЕ ломаем):
// - createBot.start() вызывает setMyCommands + setChatMenuButton; whitelist middleware первым.
// - bot.command('report') существует.
// Story 1.5/1.8 устанавливают:
// - alertOps(...) calls во всех handlers (unauthorized, queue_overflow, timeout, pipeline_failed).
//   Story 1.9 НЕ меняет ни сигнатуру AlertPayload, ни сами call-sites — только enrich-ит side-effects.
// Story 1.4a/1.4b устанавливают:
// - alertOps в f1-report.ts (extraction/analysis/format failures, persistence failures).
//   Sig unchanged.
// Story 1.6 устанавливает:
// - approvals.jsonl append-only с {reportId, clientId, topName, chatId, approvedAt, status:'approved'}.
//   Story 1.9 читает эти данные ТОЛЬКО опосредованно (через job.queuedAt → approvedAt diff в новом
//   recordOpsEvent при approve). Файл approvals.jsonl остаётся источником истины.

// Story 1.9 контракт для будущего:
// - recordOpsEvent / alertOps сигнатуры стабильны → Story 1.10 (persistence), 1.12 (Aidar status)
//   читают _ops_logs sheet by header name через readSheet (никаких column indices).
// - watchdog state в data/.ops-state.json: simple JSON {lastSuccessAt, lastFailureAt, ...};
//   Story 1.10 может мигрировать на SQLite/PostgreSQL без изменения формата.
```

## Критерии приёмки

1. **Сценарий: pino structured log с `{pipeline, step, clientId, durationMs, status}` на каждом шаге** [Source: epics.md#Story 1.9 AC #1, architecture.md#Format Patterns line 444]
   ```
   Дано pipeline F1 выполняет шаги (transcript → extraction → analysis → format → delivery)
   Когда каждый step завершён (успех ИЛИ ошибка)
   Тогда pino-лог содержит обязательные поля {pipeline, step, clientId, durationMs, status}
   И status ∈ {'ok' | 'error' | 'partial' | 'aborted'}
   И durationMs = Date.now() - stepStartedAt (миллисекунды, integer)
   И уровень pino соответствует исходу: 'info' для ok/partial, 'warn' для retry, 'error' для failure
   И поле `level: 'ops_alert'` уже используется в alertOps — НЕ конфликтует с pino built-in level
   ```

2. **Сценарий: append-row в Sheet `_ops_logs` при каждом ops-event** [Source: epics.md#Story 1.9 AC #1 «append-only Sheet (отдельный от данных клиента)», FR76]
   ```
   Дано Sheet с worksheet `_ops_logs` существует (Тимур создал руками заранее) и имеет header row:
     [timestamp, pipeline, step, client_id, duration_ms, status, level, message, error_code, context_json]
   И service account имеет writer-доступ к Spreadsheet
   Когда вызван recordOpsEvent('info', payload) ИЛИ alertOps(payload) ИЛИ failed-step
   Тогда appendOpsLog(row) вызывает spreadsheets.values.append:
     - spreadsheetId = config.GEONLINE_F0_SHEET_ID (то же что для read)
     - range = '_ops_logs!A1'
     - valueInputOption = 'RAW'
     - insertDataOption = 'INSERT_ROWS'
   И row.timestamp = ISO8601 (new Date().toISOString())
   И row.context_json = JSON.stringify(payload.context ?? {}), truncated на 4096 chars + suffix '...[truncated]'
   И row.message = first 500 chars от human-readable строки (после '...[truncated]')
   И row.error_code = payload.errorCode ?? extracted из Error subclass (e.g., 'SheetsAdapterError:rate_limited')
     ИЛИ пустая строка при не-error event
   И snake_case в header row (matches sheets adapter convention)

   Дано append-call упал (network / 429 / 5xx)
   Когда withRetry exhausted после 3 попыток
   Тогда log.warn (НЕ alertOps — recursive loop защита) с {step:'ops.appendOpsLog.failed', err, payload.step}
   И исходный event/alert НЕ теряется (pino-лог уже произошёл строкой выше)
   ```

3. **Сценарий: Telegram ops-чат получает алерт при `alertOps(...)`** [Source: epics.md#Story 1.9 AC #2 «уведомление Тимуру в Telegram ops-канал», architecture.md#NFR table line 58]
   ```
   Дано createBot.start() выполнен и setOpsTelegramSender(...) вызван с реальным bot.api.sendMessage
   И config.TELEGRAM_CHAT_OPS_ID валиден (non-zero, parsed)
   Когда вызван alertOps({pipeline:'F1', step:'bot.report.pipeline_failed', clientId:'geonline', error, context})
   Тогда внутри alertOps происходит fire-and-forget:
     1. pino logger.error({ level:'ops_alert', ...payload }, 'ops alert raised') — синхронно (текущее поведение).
     2. opsTelegramSender(formatOpsAlert(payload)).catch(err => logger.warn({err}, 'ops alert telegram send failed'))
     3. opsSheetsWriter(toOpsLogRow(payload, 'error')).catch(err => logger.warn({err}, 'ops alert sheets append failed'))
   И send в Telegram идёт plain text БЕЗ parse_mode (исключает 400 entities errors от спецсимволов в error.stack)
   И текст содержит: иконка по level + одну строку '[pipeline/step] clientId' + 2-3 строки контекст + первые 500 chars error.message

   Дано sender не задан (тесты, либо start() не вызван)
   Когда alertOps вызван
   Тогда pino-лог происходит (текущее поведение), Telegram/Sheets — silent no-op (sender === null)
   И тест alertOps без deps работает как раньше (backward-compat)
   ```

4. **Сценарий: повторный алерт через 4ч непрерывного down** [Source: epics.md#Story 1.9 AC #2 «повторное уведомление если pipeline down > 4ч», PRD line 655]
   ```
   Дано lastSuccessAt = T-5h (5ч назад), lastFailureAt = T-30m (есть свежий сбой)
   И lastRepeatAlertAt = null (повтор ещё не отправлен) ИЛИ < T-4h
   Когда watchdog tick (раз в 5 мин) проверяет state
   Тогда tickWatchdog(now) возвращает { shouldRepeatAlert: true, shouldEscalateAidar: false }
   И watchdog отправляет в ops-чат:
     "⚠️ Pipeline down > 4ч.
      Последний успех: 2026-05-21 10:00 (5ч назад)
      Последний сбой: 2026-05-21 14:30 (30 мин назад, F1/extraction/claude_api)
      Проверь логи на VPS."
   И обновляет lastRepeatAlertAt = now
   И append-row в _ops_logs с {pipeline:'OPS', step:'watchdog.repeat_alert', status:'error'}
   И НЕ дёргает Sheets если sender === null (тесты)

   Дано следующий tick через 5 мин (lastRepeatAlertAt = T-5m)
   Когда tickWatchdog(now) проверяет
   Тогда shouldRepeatAlert === false (debounce: не повторять чаще чем раз в 4ч)
   ```

5. **Сценарий: эскалация Айдару через 24ч** [Source: epics.md#Story 1.9 AC #2 «уведомление Айдару если down > 24ч», PRD line 656]
   ```
   Дано lastSuccessAt = T-25h, escalatedToAidarAt = null
   И config.OPS_AIDAR_MENTION = '@aidar_geonline' (или пусто)
   Когда watchdog tick срабатывает
   Тогда tickWatchdog возвращает { shouldRepeatAlert: true, shouldEscalateAidar: true }
   И сообщение в ops-чат:
     "🚨 Pipeline down > 24ч. @aidar_geonline — Тимур может быть недоступен.
      Последний успех: 2026-05-20 13:00 (25ч назад)
      Запусти runbook docs/aziza-runbook-v1.0.md секция «бот недоступен»."
   И escalatedToAidarAt = now (одноразовый ping, НЕ повторять каждый tick)
   И при OPS_AIDAR_MENTION='' префикс '@aidar_…' опускается, остальной текст шлётся (best-effort)

   Дано pipeline восстановился (recordOpsEvent('info', {step:'bot.report.completed', status:'ok'}))
   Когда обновляется state
   Тогда lastSuccessAt = now
   И lastRepeatAlertAt = null, escalatedToAidarAt = null (reset для следующего инцидента)
   И ops-чат получает '✅ Pipeline восстановлен' (опционально — fine, тест проверяет state-reset)
   ```

6. **Сценарий: 30-мин timeout — Azize получает '⏰ Задержка', Тимур получает alert** [Source: epics.md#Story 1.9 AC #3, UX-DR2]
   ```
   Дано job в очереди, scheduleTimeout(jobId) вызван (JOB_TIMEOUT_MS = 30*60_000) — Story 1.5
   И 30 мин прошло, job всё ещё status='queued' OR 'running'
   Когда onJobTimeout(jobId) срабатывает (Story 1.5 уже реализован, Story 1.9 НЕ переписывает)
   Тогда safeEditMessage(job.chatId, job.progressMessageId, '⏰ Задержка\\. Тимур уведомлён\\. Пиши отчёт вручную\\.')
     (текст уже корректный в formatErrorMessage('timeout'), Story 1.9 проверяет регрессию)
   И alertOps({pipeline:'F1', step:'bot.report.timeout', clientId, error, context:{jobId, elapsedMs}})
   И через AC #3 alertOps уже дополнительно шлёт в ops-чат (новое поведение Story 1.9)
   ```

7. **Сценарий: два Telegram чата (work + ops) — конфигурация и маршрутизация** [Source: epics.md#Story 1.9 AC #4, architecture.md#Telegram UX Decisions «Два чата»]
   ```
   Дано config.TELEGRAM_CHAT_WORK_ID и config.TELEGRAM_CHAT_OPS_ID заданы и различны (non-zero, validated)
   Когда createBot.start() вызван
   Тогда whitelist (TELEGRAM_TRACKER_CHAT_IDS) разрешает только work-чат(ы) — Azize отправляет /report туда
   И opsTelegramSender отправляет ВСЕ ops-сообщения в TELEGRAM_CHAT_OPS_ID
   И НИКАКОЙ ops-алерт НЕ идёт в work-чат (Azize не должна видеть stack traces)
   И НИКАКОЕ user-сообщение НЕ идёт в ops-чат (полная изоляция)

   Дано (defensive) TELEGRAM_CHAT_WORK_ID === TELEGRAM_CHAT_OPS_ID
   Когда config валидируется
   Тогда config.ts Zod refine добавляет: «WORK_ID и OPS_ID должны различаться» — fail-fast при старте
   И сообщение об ошибке указывает оба значения и переменные
   ```

8. **Сценарий: success-event обновляет watchdog state** [Source: новый — watchdog контракт]
   ```
   Дано processJob успешно завершился (job.status='completed')
   Когда bot.ts вызывает recordOpsEvent('info', {
     pipeline:'F1', step:'bot.report.completed', clientId, durationMs, status:'ok'
   })
   Тогда:
     1. pino info-лог.
     2. appendOpsLog(row) — fire-and-forget.
     3. Watchdog state.lastSuccessAt = now; consecutive failure flags сбрасываются.
     4. Telegram НЕ дёргается для info-event (только для alertOps).
   ```

9. **Сценарий: watchdog state persists в `data/.ops-state.json`** [Source: новый — restart resilience]
   ```
   Дано watchdog работает; lastSuccessAt, lastFailureAt, lastRepeatAlertAt, escalatedToAidarAt в RAM
   Когда state меняется (любое обновление)
   Тогда async fs.writeFile('data/.ops-state.json.tmp', JSON.stringify(state)) → fs.rename → 'data/.ops-state.json'
     (atomic rename защищает от partial write при crash)
   И при createBot.start() → fs.readFile('data/.ops-state.json') → JSON.parse → восстановление state
   И при ENOENT (первый старт) → state = {lastSuccessAt: now, lastFailureAt:null, lastRepeatAlertAt:null, escalatedToAidarAt:null}
   И при invalid JSON (corrupt) → log.warn, fallback на initial state, НЕ падать

   Дано restart середине 4-часового интервала «down»
   Когда бот стартует, state восстановлен с lastSuccessAt=T-2h
   Тогда watchdog продолжает счёт; через ещё 2ч (4ч с lastSuccessAt) шлёт repeat alert
   И не дублирует — escalatedToAidarAt сохранён между рестартами
   ```

10. **Сценарий: tickWatchdog — pure function для unit-теста** [Source: testability]
    ```
    Дано экспортируемая чистая функция tickWatchdog(state, now): { shouldRepeatAlert, shouldEscalateAidar, nextState }
    Когда тест задаёт state = {lastSuccessAt:T-5h, lastFailureAt:T-30m, lastRepeatAlertAt:null, escalatedToAidarAt:null}, now=T
    Тогда возвращает { shouldRepeatAlert:true, shouldEscalateAidar:false, nextState:{lastRepeatAlertAt:T, ...} }
    И при state.lastSuccessAt:T-25h, escalatedToAidarAt:null → { shouldRepeatAlert:true, shouldEscalateAidar:true, nextState:{escalatedToAidarAt:T, lastRepeatAlertAt:T} }
    И при state.lastSuccessAt:T-3h → { shouldRepeatAlert:false, shouldEscalateAidar:false } (порог 4ч не достигнут)
    И при state.lastSuccessAt:T-5h И state.lastRepeatAlertAt:T-1h → { shouldRepeatAlert:false } (debounce внутри 4ч)
    И тесты — таблично-driven, покрывают boundary 4h/24h/edge T-4h+1ms / T-4h-1ms.
    ```

11. **Сценарий: NFR11 — сбой Sheets не теряет логи и алерты** [Source: epics.md#NFR11, PRD «каскадный отказ»]
    ```
    Дано appendOpsLog throws (sheets API down)
    Когда alertOps вызван
    Тогда:
      1. pino-лог происходит ОБЯЗАТЕЛЬНО (синхронно, до side-effects).
      2. Telegram-send продолжает работать (independent path).
      3. Sheets-failure НЕ блокирует Telegram-send (Promise.allSettled, не serial await).
      4. Sheets-failure пишется как log.warn 'ops alert sheets append failed' (через root logger, минуя alertOps).
    И user-facing event handlers (job processing, approve, edit) НЕ блокируются sheets latency
      (alertOps возвращает void немедленно; вся I/O fire-and-forget).
    ```

12. **Сценарий: backward compatibility — все существующие 280+ тестов зелёные** [regression]
    ```
    Дано Story 1.5/1.6/1.7/1.8 тесты используют vi.fn() spy для alertOps через BotDeps.alertOps
    Когда они утверждают alertOps был вызван с N аргументами
    Тогда сигнатура AlertPayload неизменна {pipeline, step, clientId?, error, context?}
    И моки в bot.test.ts / f1-report.test.ts работают без правок
    И существующая логика 'failed to send unauthorized reply' / 'ack reply failed' не дублирует ops-send
      (Telegram-side effect — fire-and-forget, не цепляет основной reply path).
    ```

## Задачи / Подзадачи

- [x] **Задача 1: `src/utils/telegram-formatter.ts` — `formatOpsAlert` + `formatWatchdogRepeat`** (АК: #3, #4, #5)
  - [x] 1.1 Добавить `formatOpsAlert(payload: { pipeline: string; step: string; clientId?: string; level: 'error' | 'warn' | 'info'; message: string; errorCode?: string; context?: Record<string, unknown> }): string`. Plain text. Структура:
    ```
    {icon} [{pipeline}/{step}]{clientId ? ' ' + clientId : ''}
    {message (truncated к 500 chars)}
    {errorCode ? '\nerror_code: ' + errorCode : ''}
    {context && Object.keys(context).length ? '\ncontext: ' + JSON.stringify(context).slice(0, 500) : ''}
    ```
    Где `icon` = `'🚨'` для error, `'⚠️'` для warn, `'ℹ️'` для info.
    Truncate каждое поле отдельно, итог ≤ 1500 chars (Telegram message limit с запасом).
  - [x] 1.2 Добавить `formatWatchdogRepeat({ hoursDown: number; lastSuccessAt: string; lastFailureAt: string | null; lastFailureReason?: string; aidarMention?: string; escalateAidar: boolean }): string`. Структура:
    ```
    {escalateAidar ? '🚨' : '⚠️'} Pipeline down > {hoursDown}ч.
    {escalateAidar && aidarMention ? aidarMention + ' — Тимур может быть недоступен.\n' : ''}Последний успех: {humanReadableDate(lastSuccessAt)}
    {lastFailureAt ? 'Последний сбой: ' + humanReadableDate(lastFailureAt) + (lastFailureReason ? ' (' + lastFailureReason + ')' : '') + '\n' : ''}{escalateAidar ? 'Запусти runbook docs/aziza-runbook-v1.0.md.' : 'Проверь логи на VPS.'}
    ```
  - [x] 1.3 Тесты в `src/utils/telegram-formatter.test.ts`:
    - `formatOpsAlert` с error + context — содержит '🚨', step, clientId, error message, context.
    - `formatOpsAlert` без context, без clientId — текст не падает, формат сохраняется.
    - `formatOpsAlert` с message > 500 chars — truncate + '...[truncated]'.
    - `formatOpsAlert` с context > 500 chars JSON — truncate.
    - `formatWatchdogRepeat` 4ч — '⚠️', 'Pipeline down > 4ч.', НЕ содержит aidarMention.
    - `formatWatchdogRepeat` 24ч + escalate + mention='@aidar' — '🚨', '@aidar — Тимур может быть недоступен.'.
    - `formatWatchdogRepeat` 24ч + escalate + mention='' — '🚨', без @aidar.

- [x] **Задача 2: `src/ops.ts` — расширение `alertOps` + `recordOpsEvent` + `setOpsTelegramSender` / `setOpsSheetsWriter`** (АК: #3, #11)
  - [x] 2.1 Добавить типы:
    ```typescript
    export type OpsLevel = 'error' | 'warn' | 'info';
    export interface OpsLogRow {
      timestamp: string;
      pipeline: string;
      step: string;
      clientId: string;
      durationMs: number | '';  // '' для не-step events (alert)
      status: 'ok' | 'error' | 'partial' | 'aborted' | 'alert' | '';
      level: OpsLevel;
      message: string;
      errorCode: string;
      contextJson: string;
    }
    export type OpsTelegramSender = (text: string) => Promise<void>;
    export type OpsSheetsWriter = (row: OpsLogRow) => Promise<void>;
    ```
  - [x] 2.2 Module-level state:
    ```typescript
    let _opsTelegramSender: OpsTelegramSender | null = null;
    let _opsSheetsWriter: OpsSheetsWriter | null = null;
    export function setOpsTelegramSender(fn: OpsTelegramSender | null): void { _opsTelegramSender = fn; }
    export function setOpsSheetsWriter(fn: OpsSheetsWriter | null): void { _opsSheetsWriter = fn; }
    ```
    **Важно:** мутируемые module-level — обычно anti-pattern, но здесь приемлемо т.к. (а) wiring один раз при `createBot.start()`, (б) альтернатива (DI через все call-sites) ломает ~12 файлов и регрессионные тесты Story 1.4-1.8.
  - [x] 2.3 `alertOps(payload)` (modified) — pino-лог (СИНХРОННО, текущее поведение неизменно) + fire-and-forget side-effects:
    ```typescript
    export function alertOps(payload: AlertPayload): void {
      logger.error({ level: 'ops_alert', ...flatten(payload) }, 'ops alert raised');
      const errorMessage = payload.error instanceof Error ? payload.error.message : String(payload.error);
      const errorCode = extractErrorCode(payload.error);  // e.g., 'SheetsAdapterError:rate_limited'

      const sender = _opsTelegramSender;
      if (sender) {
        const text = formatOpsAlert({
          pipeline: payload.pipeline,
          step: payload.step,
          clientId: payload.clientId,
          level: 'error',
          message: errorMessage,
          errorCode,
          context: payload.context,
        });
        sender(text).catch((err) =>
          logger.warn({ err, step: 'ops.telegram.send_failed', alertedStep: payload.step },
            'ops alert telegram send failed'),
        );
      }

      const writer = _opsSheetsWriter;
      if (writer) {
        const row = toOpsLogRow({ payload, level: 'error', status: 'alert', durationMs: '' });
        writer(row).catch((err) =>
          logger.warn({ err, step: 'ops.sheets.append_failed', alertedStep: payload.step },
            'ops alert sheets append failed'),
        );
      }

      // Watchdog state side-effect:
      _updateWatchdogState({ lastFailureAt: new Date().toISOString(), lastFailureReason: payload.step });
    }
    ```
  - [x] 2.4 `recordOpsEvent(level, payload)` (NEW) — pino + sheets, БЕЗ Telegram:
    ```typescript
    export interface OpsEventPayload {
      pipeline: string;
      step: string;
      clientId?: string;
      durationMs?: number;
      status?: OpsLogRow['status'];
      message?: string;
      context?: Record<string, unknown>;
    }
    export function recordOpsEvent(level: OpsLevel, p: OpsEventPayload): void {
      const message = p.message ?? p.step;
      logger[level]({ ...flatten(p), level }, message);
      const writer = _opsSheetsWriter;
      if (writer) {
        const row = toOpsLogRow({ payload: { ...p, error: undefined }, level, status: p.status ?? 'ok', durationMs: p.durationMs ?? '' });
        writer(row).catch((err) =>
          logger.warn({ err, step: 'ops.sheets.append_failed', eventStep: p.step },
            'ops event sheets append failed'),
        );
      }
      if (level === 'info' && p.step === 'bot.report.completed' && p.status === 'ok') {
        _updateWatchdogState({ lastSuccessAt: new Date().toISOString() });
      }
    }
    ```
  - [x] 2.5 Helper `toOpsLogRow(...)`:
    ```typescript
    function toOpsLogRow(args: { payload: { pipeline: string; step: string; clientId?: string; context?: Record<string, unknown>; error?: unknown }; level: OpsLevel; status: OpsLogRow['status']; durationMs: number | '' }): OpsLogRow {
      const errorCode = extractErrorCode(args.payload.error);
      const messageRaw = args.payload.error instanceof Error
        ? args.payload.error.message
        : (args.payload.error !== undefined ? String(args.payload.error) : '');
      return {
        timestamp: new Date().toISOString(),
        pipeline: args.payload.pipeline,
        step: args.payload.step,
        clientId: args.payload.clientId ?? '',
        durationMs: args.durationMs,
        status: args.status,
        level: args.level,
        message: truncate(messageRaw, 500),
        errorCode,
        contextJson: truncate(safeStringify(args.payload.context ?? {}), 4096),
      };
    }
    ```
  - [x] 2.6 Helper `extractErrorCode`:
    ```typescript
    function extractErrorCode(err: unknown): string {
      if (!err || !(err instanceof Error)) return '';
      const name = err.name || 'Error';
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'string') return `${name}:${code}`;
      return name;
    }
    ```
  - [x] 2.7 Helper `truncate(s, max)`: return `s.length <= max ? s : s.slice(0, max - 15) + '...[truncated]'`.
  - [x] 2.8 Helper `safeStringify(v)`: try `JSON.stringify(v)`, на circular — return `String(v)`.

- [x] **Задача 3: `src/ops.ts` — watchdog state + persistence** (АК: #4, #5, #8, #9, #10)
  - [x] 3.1 Тип состояния:
    ```typescript
    export interface WatchdogState {
      lastSuccessAt: string;             // ISO, инициализируется = now() при первом старте
      lastFailureAt: string | null;
      lastFailureReason: string | null;  // step name
      lastRepeatAlertAt: string | null;
      escalatedToAidarAt: string | null;
    }
    ```
  - [x] 3.2 Module-level `_watchdogState: WatchdogState | null = null` (lazy-init) + `_watchdogStateFilePath = 'data/.ops-state.json'`.
  - [x] 3.3 `_loadWatchdogState()` (async): `fs.readFile` → JSON.parse → return. На ENOENT или invalid JSON — return initial `{ lastSuccessAt: now().toISOString(), lastFailureAt:null, ... }` и log.warn (для invalid JSON, не для ENOENT).
  - [x] 3.4 `_saveWatchdogState(state)` (async, fire-and-forget): `fs.writeFile(tmp, JSON.stringify(state, null, 2))` → `fs.rename(tmp, finalPath)`. На error → log.warn 'watchdog state save failed' (НЕ alertOps).
  - [x] 3.5 `_updateWatchdogState(patch: Partial<WatchdogState>)`:
    ```typescript
    if (_watchdogState === null) return;  // не инициализирован — игнор (early alertOps до start())
    _watchdogState = { ..._watchdogState, ...patch };
    if (patch.lastSuccessAt) {
      _watchdogState.lastRepeatAlertAt = null;
      _watchdogState.escalatedToAidarAt = null;
    }
    void _saveWatchdogState(_watchdogState);
    ```
  - [x] 3.6 `tickWatchdog(state, nowMs): { shouldRepeatAlert: boolean; shouldEscalateAidar: boolean; nextState: WatchdogState }` (pure, exported).
    Логика:
    ```typescript
    const FOUR_HOURS = 4 * 60 * 60_000;
    const TWENTY_FOUR_HOURS = 24 * 60 * 60_000;
    const lastSuccessMs = Date.parse(state.lastSuccessAt);
    const lastRepeatMs = state.lastRepeatAlertAt ? Date.parse(state.lastRepeatAlertAt) : null;
    const downMs = nowMs - lastSuccessMs;
    const enough_4h = downMs >= FOUR_HOURS;
    const enough_24h = downMs >= TWENTY_FOUR_HOURS;
    const cooldownPassed = lastRepeatMs === null || (nowMs - lastRepeatMs) >= FOUR_HOURS;
    const shouldRepeatAlert = enough_4h && cooldownPassed && state.lastFailureAt !== null;
    const shouldEscalateAidar = enough_24h && state.escalatedToAidarAt === null;
    let nextState = state;
    if (shouldRepeatAlert) nextState = { ...nextState, lastRepeatAlertAt: new Date(nowMs).toISOString() };
    if (shouldEscalateAidar) nextState = { ...nextState, escalatedToAidarAt: new Date(nowMs).toISOString() };
    return { shouldRepeatAlert, shouldEscalateAidar, nextState };
    ```
    **Boundary:** ровно 4ч (downMs === FOUR_HOURS) → `enough_4h: true` (`>=`).
  - [x] 3.7 `startWatchdog({ intervalMs }): { stop: () => void }`:
    ```typescript
    export async function startWatchdog(opts: { intervalMs?: number; getNow?: () => number; aidarMention?: string } = {}): Promise<{ stop: () => void }> {
      const intervalMs = opts.intervalMs ?? 5 * 60_000;
      const getNow = opts.getNow ?? (() => Date.now());
      const aidarMention = opts.aidarMention ?? '';
      if (_watchdogState === null) _watchdogState = await _loadWatchdogState();
      const timer = setInterval(() => {
        if (_watchdogState === null) return;
        const result = tickWatchdog(_watchdogState, getNow());
        _watchdogState = result.nextState;
        void _saveWatchdogState(_watchdogState);
        if (result.shouldRepeatAlert) {
          const hoursDown = Math.floor((getNow() - Date.parse(result.nextState.lastSuccessAt)) / 3_600_000);
          const text = formatWatchdogRepeat({
            hoursDown,
            lastSuccessAt: result.nextState.lastSuccessAt,
            lastFailureAt: result.nextState.lastFailureAt,
            lastFailureReason: result.nextState.lastFailureReason ?? undefined,
            aidarMention,
            escalateAidar: result.shouldEscalateAidar,
          });
          const sender = _opsTelegramSender;
          sender?.(text).catch((err) => logger.warn({ err, step: 'ops.watchdog.send_failed' }, 'watchdog send failed'));
          const writer = _opsSheetsWriter;
          writer?.({
            timestamp: new Date(getNow()).toISOString(),
            pipeline: 'OPS', step: 'watchdog.repeat_alert',
            clientId: '', durationMs: '',
            status: 'error', level: 'error',
            message: `Pipeline down > ${hoursDown}ч`,
            errorCode: result.shouldEscalateAidar ? 'WatchdogError:aidar_escalation' : 'WatchdogError:repeat_alert',
            contextJson: JSON.stringify({ hoursDown, lastSuccessAt: result.nextState.lastSuccessAt }),
          }).catch((err) => logger.warn({ err, step: 'ops.watchdog.sheets_failed' }, 'watchdog sheets append failed'));
        }
      }, intervalMs);
      timer.unref?.();
      return { stop: () => clearInterval(timer) };
    }
    ```
  - [x] 3.8 Export `_resetWatchdogStateForTest()` — zeroes _watchdogState. Используется в beforeEach тестов ops.test.ts.
  - [x] 3.9 Удалить `TODO(Story 1.9)` коммент из старого `alertOps` — TODO теперь закрыт.

- [x] **Задача 4: `src/adapters/sheets.ts` — `appendOpsLog` writer + OAuth scope** (АК: #2, #11)
  - [x] 4.1 Расширить scope в `getSheetsClient`:
    ```typescript
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],  // было: .readonly
    ```
    **ВАЖНО:** В .env service account JSON неизменен, но в Google Sheet UI должен быть выдан Editor access. Тимур делает это руками заранее (не код); deployment runbook будет обновлён в задаче 9.
  - [x] 4.2 Добавить worksheet constants:
    ```typescript
    const OPS_LOGS_RANGE = '_ops_logs!A1';
    const OPS_LOGS_HEADERS = [
      'timestamp','pipeline','step','client_id','duration_ms','status','level','message','error_code','context_json',
    ] as const;
    ```
  - [x] 4.3 `appendOpsLog(row: OpsLogRow, clientIdForSheet?: string): Promise<void>`:
    ```typescript
    export async function appendOpsLog(row: OpsLogRow, clientIdForSheet: string = 'geonline'): Promise<void> {
      const sheetId = resolveSheetId(clientIdForSheet);
      const sheets = await getSheetsClient();
      const values = [[
        row.timestamp,
        row.pipeline,
        row.step,
        row.clientId,
        row.durationMs === '' ? '' : String(row.durationMs),
        row.status,
        row.level,
        row.message,
        row.errorCode,
        row.contextJson,
      ]];
      await withRetry(
        () => sheets.spreadsheets.values.append({
          spreadsheetId: sheetId,
          range: OPS_LOGS_RANGE,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values },
        }),
        { maxRetries: 3, backoffMs: [1000, 3000, 9000], shouldRetry: shouldRetrySheets },
      );
    }
    ```
    **НЕ обращаемся к `alertOps` из appendOpsLog** — recursive loop prevention; ошибка пропагается через rejected Promise и обрабатывается caller'ом (ops.ts) как log.warn.
  - [x] 4.4 Тесты в `src/adapters/sheets.test.ts`:
    - `appendOpsLog` вызывает `spreadsheets.values.append` с правильным spreadsheetId, range, payload.
    - Retry на 429 / 500 / ETIMEDOUT (используя существующий `shouldRetrySheets`).
    - Mock client возвращает ошибку → withRetry exhausts → throws SheetsAdapterError ('rate_limited' / 'network'). Caller (ops.ts) ловит и пишет log.warn.

- [x] **Задача 5: `src/config.ts` + `.env.example` — OPS_AIDAR_MENTION + WORK≠OPS validation** (АК: #5, #7)
  - [x] 5.1 В `ConfigSchema`:
    ```typescript
    OPS_AIDAR_MENTION: z.string().default(''),
    ```
    после `TELEGRAM_CHAT_OPS_ID`. Допустимы значения: пустая строка ИЛИ '@username'.
  - [x] 5.2 После `ConfigSchema.parse`, в `loadConfig()`, добавить cross-field validation:
    ```typescript
    if (parsed.data.TELEGRAM_CHAT_WORK_ID === parsed.data.TELEGRAM_CHAT_OPS_ID) {
      console.error(`Configuration validation failed:\n  - TELEGRAM_CHAT_WORK_ID and TELEGRAM_CHAT_OPS_ID must differ (got ${parsed.data.TELEGRAM_CHAT_WORK_ID} for both — отдельный ops-чат обязателен per architecture#Telegram UX «Два чата»)`);
      process.exit(1);
    }
    ```
    Альтернатива через Zod `.refine` на уровне ConfigSchema — приемлемо, но текст ошибки длиннее. Любой из двух подходов OK.
  - [x] 5.3 `.env.example`:
    ```
    # Ops (Story 1.9)
    OPS_AIDAR_MENTION=
    ```
    Добавить после `TELEGRAM_CHAT_OPS_ID`. Комментарий: «# Пустая строка = без эскалации в @mention; '@username' = ping в ops-чат через 24ч down».
  - [x] 5.4 Тесты в `src/config.test.ts` (если файл существует — добавить; иначе скип, config-валидация покрыта existing E2E):
    - WORK_ID === OPS_ID → process.exit(1) (mock process.exit).
    - WORK_ID !== OPS_ID, OPS_AIDAR_MENTION='' → parse успешен.
    - WORK_ID !== OPS_ID, OPS_AIDAR_MENTION='@aidar' → parse успешен.

- [x] **Задача 6: `src/bot.ts` — wiring sender/writer + watchdog + success-event** (АК: #3, #4, #5, #7, #8)
  - [x] 6.1 В `createBot.start()` ПОСЛЕ `setMyCommands` / `setChatMenuButton`, ПЕРЕД `bot.start()`:
    ```typescript
    // Story 1.9: wire ops channels (only in production; tests pass alertOps via deps directly).
    if (deps.botInfo === undefined) {
      const opsChatId = config.TELEGRAM_CHAT_OPS_ID;
      const { setOpsTelegramSender, setOpsSheetsWriter, startWatchdog: startWatchdogFn } = await import('./ops.js');
      const { appendOpsLog } = await import('./adapters/sheets.js');
      setOpsTelegramSender(async (text) => {
        await bot.api.sendMessage(opsChatId, text);
      });
      setOpsSheetsWriter(async (row) => {
        await appendOpsLog(row);
      });
      _watchdogHandle = await startWatchdogFn({ aidarMention: config.OPS_AIDAR_MENTION });
    }
    ```
    **Почему `await import(...)` а не top-level import?** ops.ts уже imported top-level (для `alertOps`). Здесь нужно лишь обратиться к новым named exports — обычный named import в начале файла:
    ```typescript
    import {
      alertOps as defaultAlertOps,
      recordOpsEvent,
      setOpsTelegramSender,
      setOpsSheetsWriter,
      startWatchdog,
      type AlertPayload,
    } from './ops.js';
    import { appendOpsLog } from './adapters/sheets.js';
    ```
    — это правильнее, чем dynamic import.
  - [x] 6.2 В `createBot.stop()`:
    ```typescript
    if (_watchdogHandle) _watchdogHandle.stop();
    setOpsTelegramSender(null);
    setOpsSheetsWriter(null);
    ```
    Closure-state `let _watchdogHandle: { stop: () => void } | null = null;` объявить в `createBot(...)` scope.
  - [x] 6.3 В worker `processJob` после успешного завершения (job.status='completed', НЕ failed/aborted), добавить:
    ```typescript
    recordOpsEvent('info', {
      pipeline: 'F1',
      step: 'bot.report.completed',
      clientId: job.clientId,
      durationMs: Date.parse(job.completedAt!) - Date.parse(job.queuedAt),
      status: 'ok',
      context: { jobId: job.id },
    });
    ```
    Точка вызова: в `processJob` в самом конце success-path (после `deliveryMessageIds` set), ПЕРЕД finally-block. Если job.completedAt не set — выставить `now().toISOString()`.
  - [x] 6.4 НЕ менять call-sites `alertOps(...)` — они уже работают; новые side-effects добавляются прозрачно.
  - [x] 6.5 НЕ удалять existing log.info/warn/error на ack reply, queue overflow и т.д. — Story 1.9 ADDS to ops, не заменяет pino.

- [x] **Задача 7: Тесты `src/ops.test.ts` (новый файл) + `src/adapters/sheets.test.ts` (extend)** (АК: #2, #3, #4, #5, #8, #9, #10, #11)
  - [x] 7.1 `src/ops.test.ts` — beforeEach: `_resetWatchdogStateForTest()`, очистить mock fs + setOpsTelegramSender(null) + setOpsSheetsWriter(null).
  - [x] 7.2 Тест: `alertOps` без sender/writer → pino-лог происходит, никаких Telegram/Sheets вызовов (vi.fn spies на logger).
  - [x] 7.3 Тест: `alertOps` с sender → sender вызван 1 раз с правильно сформированным текстом (содержит '🚨', step, clientId, error.message).
  - [x] 7.4 Тест: `alertOps` с writer → writer вызван 1 раз с OpsLogRow (timestamp ISO, status='alert', level='error').
  - [x] 7.5 Тест: `alertOps` writer throws → log.warn 'ops alert sheets append failed' (logger spy). Telegram sender НЕ блокируется (вызван параллельно).
  - [x] 7.6 Тест: `alertOps` sender throws → log.warn 'ops alert telegram send failed', writer вызван независимо.
  - [x] 7.7 Тест: `recordOpsEvent('info', {step:'bot.report.completed', status:'ok'})` → НЕ дёргает Telegram, дёргает Sheets, обновляет watchdog.lastSuccessAt.
  - [x] 7.8 Тест: `tickWatchdog` — table-driven (см. AC #10):
    | now - lastSuccessAt | lastRepeatAlertAt | escalatedAt | hasFailure | shouldRepeatAlert | shouldEscalate |
    |---|---|---|---|---|---|
    | T-3h | null | null | yes | false | false |
    | T-4h | null | null | yes | true  | false |
    | T-4h | null | null | no  | false | false |  // no failure recorded
    | T-5h | T-1h | null | yes | false | false |  // debounce
    | T-5h | T-5h | null | yes | true  | false |  // cooldown passed
    | T-24h | null | null | yes | true | true |
    | T-25h | T-1h | T-1h | yes | false | false |  // already escalated, debounce
    | T-25h | T-5h | null | yes | true | true |  // both fire
  - [x] 7.9 Тест: `_loadWatchdogState` — ENOENT → initial state (now, all nulls). Invalid JSON → log.warn + initial state. Valid JSON → parsed.
  - [x] 7.10 Тест: `_saveWatchdogState` — атомарность (tmp → rename). На failure (mock fs.writeFile reject) → log.warn, не throws (fire-and-forget).
  - [x] 7.11 Тест: `startWatchdog` — `intervalMs:100`, `getNow` контролируется. После 1 tick с state {lastSuccessAt:T-5h, lastFailureAt:T-30m, ...} → sender вызван с '⚠️ Pipeline down > 5ч.' (или > 4ч в зависимости от точной формулировки), state.lastRepeatAlertAt обновлён.
  - [x] 7.12 Тест: `startWatchdog` + recordOpsEvent('info', bot.report.completed) → state.lastRepeatAlertAt и escalatedToAidarAt reset to null.
  - [x] 7.13 `src/adapters/sheets.test.ts` — добавить describe 'appendOpsLog':
    - Mock googleapis.sheets, проверить spreadsheets.values.append вызван с правильными args.
    - Retry на 429 (mock 429 once → success second time).
    - 401/403 → throws SheetsAdapterError ('auth') без retry.
  - [x] 7.14 НЕ менять существующие тесты `readClientContext` — scope change `.readonly → spreadsheets` не ломает чтение (write-scope supersets read-scope).

- [x] **Задача 8: Регрессия — backward-compat existing tests** (АК: #6, #12)
  - [x] 8.1 `npm test` → все ~280 тестов зелёные.
  - [x] 8.2 `npx tsc --noEmit` → no errors.
  - [x] 8.3 Проверить тесты Story 1.5/1.6/1.7/1.8 на `alertOps` mock через `BotDeps.alertOps` — сигнатура AlertPayload не изменилась, ничего не правим.
  - [x] 8.4 Проверить тесты Story 1.4a/1.4b на `alertOps` from f1-report — те же mocks, та же сигнатура.
  - [x] 8.5 Проверить тест `'⏰ Задержка. Тимур уведомлён. Пиши отчёт вручную.'` (Story 1.5 в `bot.test.ts`) — regression-pass (формат не меняется).

- [x] **Задача 9: Documentation + runbook update** (АК: #2)
  - [x] 9.1 Обновить `docs/aziza-runbook-v1.0.md` (или создать `docs/timur-ops-runbook.md` если такого нет) с разделом «Service account writer-доступ к Sheets для ops logs»:
    - Открыть Sheet → Share → service account email → Editor.
    - Создать worksheet `_ops_logs` с header row из 10 колонок (точно эти 10).
    - Если `_ops_logs` не существует — pipeline продолжит работать, но appendOpsLog будет всегда падать (log.warn `ops alert sheets append failed` каждый раз).
  - [x] 9.2 Обновить `_bmad-output/implementation-artifacts/deferred-work.md`:
    - Удалить карту «Sheets write-side adapter (F5 metrics, ops logs)» из «Story 1.3 deferred» — закрыта.
    - Удалить карту в `src/ops.ts:11` TODO — закрыта.
    - Помечать в карточках, что closed by Story 1.9: «Auto-cleanup `*.raw.txt`», «`*.format.raw.txt` cleanup» (если не реализовано — оставить с пометкой «remained deferred to Story 1.10»). **На MVP оставляем deferred** — это data-cleanup, не ops-alert работа.

- [x] **Задача 10: Sprint status + Dev Agent Record** (finalize)
  - [x] 10.1 Обновить `sprint-status.yaml`: `1-9-ops-logging-i-alerty: backlog → in-progress → review → done` через lifecycle.
  - [x] 10.2 Обновить story file status: `ready-for-dev` → `in-progress` → `review` → `done` по мере работы.
  - [x] 10.3 Заполнить Dev Agent Record (Agent Model, Debug Log, Completion Notes, File List).

### Review Findings

- [x] [Review][Patch] `_ops_logs` не получает события каждого этапа pipeline — добавлены canonical `recordOpsEvent` для `transcript.total`, `f1.extraction.complete`, `f1.analysis.complete`, `f1.format.complete`/`f1.format.partial`, `bot.report.delivery` и финального `bot.report.completed`; pino-логи сохранены.
- [x] [Review][Patch] Watchdog помечал repeat/escalation доставленными до успешного Telegram send — `startWatchdog` теперь коммитит `lastRepeatAlertAt`/`escalatedToAidarAt` и пишет `_ops_logs` только после успешного `opsTelegramSender`; failure оставляет state неизменным и логирует warn.
- [x] [Review][Patch] Race condition при сохранении `data/.ops-state.json` — добавлена сериализованная save queue и уникальные tmp-файлы (`.tmp.<pid>.<seq>`), `_flushPendingSavesForTest()` дожидается всей очереди.
- [x] [Review][Patch] `appendOpsLog()` не логировал exhausted write failure — catch теперь пишет `log.warn` с `step:'ops.appendOpsLog.failed'`, `eventStep`, mapped error и `ops_log_append_failed_total: 1`, затем пробрасывает ошибку caller'у.

## Dev Notes

### Соответствие архитектуре

- **Observability requirement (architecture.md#NFR table line 58):** «Logging + alerting → Sheet + Telegram ops-канал» — Story 1.9 закрывает obа канала: append-only `_ops_logs` Sheet (для query/aggregation) + ops-чат push (для срочного уведомления).
- **NFR11 (epics.md):** «Сбой Sheets не теряет логи и алерты» — pino-лог происходит синхронно ДО side-effects; sheets и telegram отправляются Promise-параллельно, sheets-failure не блокирует telegram-send.
- **«Один файл на pipeline» (architecture.md#Structure Patterns):** Ops — отдельная инфраструктура (`ops.ts`), а не pipeline. Расширяем существующий файл, НЕ создаём `ops-watchdog.ts` / `ops-telegram.ts`. ~120-200 LOC в одном файле — приемлемо per architecture (ops.ts target ~100-120 LOC по structure plan).
- **Adapter boundary (architecture.md#Architectural Boundaries):** Sheets — adapter; write-side добавляется в `src/adapters/sheets.ts` (не в `ops.ts`). Ops.ts вызывает adapter через injected `_opsSheetsWriter`. Никаких прямых googleapis импортов в `ops.ts`.
- **Whitelist (architecture.md#Authentication & Security, line 299):** Whitelist остаётся в `TELEGRAM_TRACKER_CHAT_IDS` (work-чат). Ops-чат изолирован: Azize-сообщения туда НЕ маршрутизируются, ops-сообщения в work-чат НЕ попадают. Cross-field валидация WORK_ID≠OPS_ID гарантирует это на уровне config.
- **Append-only convention (architecture.md#Data Architecture):** `_ops_logs` Sheet — append-only (через `spreadsheets.values.append` с `insertDataOption:'INSERT_ROWS'`). Никаких updates/deletes. Соответствует `approvals.jsonl` pattern из Story 1.6.
- **Naming (architecture.md#Naming Patterns):** Sheets headers — `snake_case` (`client_id`, `duration_ms`); internal API — `camelCase` (`clientId`, `durationMs`). Конверсия только на adapter-границе (см. `parseSheetRange` для read; для write — explicit mapping в `appendOpsLog`).
- **Logging (architecture.md#Format Patterns, lines 442-446):** «Всегда: `pipeline`, `step`, `clientId`. Levels: info (done), warn (retry/partial), error (failure), fatal (crash).» Story 1.9 enforces полный shape `{pipeline, step, clientId, durationMs, status}` через `recordOpsEvent`/`alertOps`.
- **Anti-pattern: silent catch (architecture.md#Enforcement, line 511):** «Каждый catch логирует + алертит». Story 1.9 поддерживает это, НЕ ослабляет (`log.warn` на appendOpsLog failure — НЕ silent, прозрачно).

### Source tree (изменения)

| Файл | Действие | ~LOC |
|------|----------|------|
| `src/ops.ts` | расширить alertOps + recordOpsEvent + watchdog + setters | +180 (всего ~210) |
| `src/adapters/sheets.ts` | OAuth scope + appendOpsLog + constants | +60 (всего ~520) |
| `src/utils/telegram-formatter.ts` | formatOpsAlert + formatWatchdogRepeat | +40 |
| `src/bot.ts` | wire setOpsTelegramSender/Writer + startWatchdog + recordOpsEvent('bot.report.completed') | +30 |
| `src/config.ts` | OPS_AIDAR_MENTION + WORK≠OPS validation | +15 |
| `.env.example` | OPS_AIDAR_MENTION= | +2 |
| `src/ops.test.ts` (новый) | 13 tests + table-driven tickWatchdog | +280 |
| `src/adapters/sheets.test.ts` | extend describe 'appendOpsLog' | +60 |
| `src/utils/telegram-formatter.test.ts` | 7 tests для formatOpsAlert/formatWatchdogRepeat | +60 |
| `docs/aziza-runbook-v1.0.md` ИЛИ новый `docs/timur-ops-runbook.md` | service account writer + worksheet `_ops_logs` setup | +25 |
| `_bmad-output/implementation-artifacts/deferred-work.md` | удалить 2 closed cards | -10 |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | статус 1-9 lifecycle | ~2 |

Всего ~700 LOC изменений (production +325, tests +400). Большая story; разбиение на 1.9a/1.9b НЕ оправдано — Telegram-sender + Sheets-writer + watchdog тесно связаны (если разбить, intermediate state нестабилен).

### Testing Standards

- **Vitest** (existing). `_resetWatchdogStateForTest()` в `ops.test.ts beforeEach` для изоляции test cases.
- **Mocking:** googleapis.sheets через `vi.mock('googleapis', ...)` (паттерн из существующего `sheets.test.ts`). pino logger через `vi.spyOn(logger, 'error' | 'warn' | 'info')`.
- **Watchdog timer:** в тестах НЕ использовать реальный `setInterval`. Тесты `startWatchdog` дёргают `tickWatchdog` напрямую (pure function) + verify side-effects через mocked sender/writer.
- **`fs` mocking:** для watchdog state — `vi.mock('node:fs/promises', ...)` либо writefile в `os.tmpdir()` через `__test_only_setStatePath()` helper. Решение: temp-dir подход проще, mocking хрупкий.
- **AlertPayload backward-compat:** ВСЕ существующие тесты, которые мокают `alertOps` через `BotDeps.alertOps: vi.fn()`, продолжают работать. ИХ НЕ ТРОГАТЬ. Story 1.9 расширяет default `alertOps`; через deps-injection mock полностью обходит расширение.
- **Coverage targets:** все 12 AC покрыты тестами; tickWatchdog — minimum 8 строк table.

### Контракты с другими stories

- **Story 1.4a/1.4b:** f1-report.ts вызывает `alertOps` — Story 1.9 НЕ меняет ничего в f1-report.ts. Новые side-effects (Telegram, Sheets) ловятся прозрачно через module-level state.
- **Story 1.5/1.6/1.7/1.8:** bot.ts вызывает `alertOps` — те же контракты, новые wiring добавлены только в `createBot.start()`.
- **Story 1.10 (data persistence):** Watchdog state в `data/.ops-state.json` — простой JSON, легко мигрировать на SQLite/PostgreSQL. Approval-records `approvals.jsonl` + новые `_ops_logs` Sheet рядом, не пересекаются.
- **Story 1.11 (canary test):** Canary test будет вызывать `recordOpsEvent('info', { step:'canary.run.completed', ... })` через тот же entry-point. Никаких новых API.
- **Story 1.12 (ops-статус для Айдара):** `[📊 Статус]` callback читает `_ops_logs` Sheet + `approvals.jsonl` для агрегации `time_to_approve`. Story 1.9 обеспечивает, что сырые данные есть и snake_case headers стабильны.
- **Story 1.13 (поиск отчётов):** не пересекается с ops.
- **Epic 2 (F5):** deferred-growth. `f5_response_rate` будет считаться когда Epic 2 разморозится; Story 1.9 НЕ создаёт пустых F5-related фичей.
- **Epic 3 (F4):** Watchdog для F4-cron к 9:30 (UX-DR56) реализуется в Story 3.0 (scheduler). Story 1.9 покрывает только F1 success/failure tracking.

### LLM-Dev-Agent Guardrails

- **НЕ создавать новых файлов в `src/`** кроме `src/ops.test.ts`. Все production-изменения в существующих `ops.ts`, `bot.ts`, `config.ts`, `adapters/sheets.ts`, `utils/telegram-formatter.ts`. Архитектура — «12 source files compact».
- **НЕ менять сигнатуру `AlertPayload`** — это публичный контракт, тесты Story 1.4–1.8 ожидают `{pipeline, step, clientId?, error, context?}`. Расширение через `recordOpsEvent` (новая функция), не через перегрузку.
- **НЕ перегружать `alertOps` опциональным параметром «sendToTelegram»** — recursive sender/writer передаются через module-level state, не аргументами. Это сохраняет 30+ существующих call-sites unchanged.
- **НЕ блокировать pipeline на Sheets / Telegram latency** — все side-effects ВНУТРИ `alertOps` / `recordOpsEvent` — fire-and-forget (`.catch(...)` без await). Pipeline-latency не страдает.
- **НЕ вызывать `alertOps` из `appendOpsLog`** — recursive loop. Возвращаем rejected Promise, caller (`ops.ts`) ловит log.warn.
- **НЕ выводить в ops-чат raw stack trace** — `formatOpsAlert` truncates до 500 chars. Полный stack в pino-лог (Docker logs) для глубокого debug.
- **НЕ использовать MarkdownV2 в ops-чате** — error.message часто содержит '`', '(', '_', '.' — escape кошмар. Plain text без `parse_mode`.
- **`recordOpsEvent` только для canonical ops-tracking events, но Story 1.9 AC требует stage-level visibility** — после code review фикс добавил Sheet-события для `transcript.total`, `f1.extraction.complete`, `f1.analysis.complete`, `f1.format.complete`/`f1.format.partial`, `bot.report.delivery`, `bot.report.completed` и alertOps. НЕ зеркалируем каждый debug/info pino-лог в Sheet; пишем только этапы с duration/status.
- **НЕ инициализировать watchdog без `data/` директории** — `_saveWatchdogState` создаёт `data/` через `fs.mkdir({recursive:true})` (либо проверить, что Story 1.6/1.7 уже гарантируют `data/` exists). Безопасный default: `fs.mkdir('data', {recursive:true})` перед первой записью.
- **НЕ trustить `Date.parse(state.lastSuccessAt)`** без `Number.isFinite` проверки — на invalid JSON (corrupt file restored via fallback) state может быть NaN. `tickWatchdog` должен возвращать `shouldRepeatAlert:false` при NaN (defensive).
- **НЕ слать Aidar-mention каждые 5 мин** — `escalatedToAidarAt` устанавливается ОДИН раз; повторный repeat alert после 24ч идёт уже без mention (или с `escalateAidar:false` после первой эскалации). Решение: при `shouldRepeatAlert && !shouldEscalateAidar` (т.е., уже эскалировано ранее) — формат как 4-часовой, без mention. Aidar получает только ОДИН ping за инцидент.
- **НЕ делать circuit breaker на opsTelegramSender** — если ops-чат сам недоступен (Telegram API down), нет fallback. На MVP принимаем риск (P99 Telegram uptime > 99.9%); deferred — Email fallback (FR87, Growth).
- **`OPS_AIDAR_MENTION` — opaque строка**, не валидируется на '@'. Тимур ответственен за корректность. (Можно тривиальную проверку добавить, но не обязательно.)

### Previous Story Intelligence (Story 1.5/1.6/1.7/1.8 + 1.4a/1.4b)

**Ключевые паттерны для переиспользования:**
- `BotDeps.alertOps?: typeof defaultAlertOps` — pattern для DI; тесты передают `vi.fn()`, prod uses default. Сохраняется.
- `withRetry(fn, { maxRetries:3, backoffMs:[1000,3000,9000], shouldRetry:... })` — для `appendOpsLog` (sheets.ts уже имеет helper).
- `log.error({err, jobId}, 'message')` — pino structured pattern; Story 1.9 добавляет `durationMs` и `status` поля.
- `Date.parse(iso)` для конверсии ISO → ms — используется по всему codebase (job.queuedAt, completedAt).
- `fs.writeFile(tmp) + fs.rename` для атомарной записи — паттерн из `approvals.ts` (1.6).
- `vi.spyOn(logger, 'warn')` для проверки log.warn в тестах — паттерн из `bot.test.ts`.

**Review findings relevant для 1.9:**
- Story 1.4b iteration 2 P9: «raw transcript не должен попадать в alertOps context» — Story 1.9 truncate `contextJson` до 4KB, дополнительная защита от leak.
- Story 1.5 P4 (queue_overflow alertOps): existing `alertOps` call-site с `error: new QueueOverflowError(...)` — Story 1.9 формирует readable text через `formatOpsAlert`; verify QueueOverflowError instance produces sensible message.
- Story 1.8 P2 (log.info после reply): тот же паттерн «side-effect THEN log only on success» — для opsSender уже применён (catch → log.warn о failure, success — implicit через отсутствие catch).

### Project Structure Notes

- Все production-изменения в **существующих** файлах (`ops.ts`, `bot.ts`, `config.ts`, `adapters/sheets.ts`, `utils/telegram-formatter.ts`).
- Один **новый** файл: `src/ops.test.ts` (test, не production). Если уже есть `src/ops.test.ts` минимально — расширить.
- НЕ создавать: `src/watchdog.ts`, `src/ops-telegram.ts`, `src/adapters/ops-sheets.ts`, `src/ops-state.ts` — всё в `ops.ts` (~210 LOC после изменений; в пределах structure plan ~100-120, но обоснованно: тесная связность watchdog state + alertOps + recordOpsEvent).
- `data/.ops-state.json` — runtime файл, не в git (`.gitignore` уже покрывает `data/`).
- `docs/aziza-runbook-v1.0.md` или новый `docs/timur-ops-runbook.md` — выбирай первый вариант (extend существующий), но при > 3 страниц — split.

### References

- [Source: _bmad-output/planning-artifacts/epics.md, Story 1.9 — lines 715-744]
- [Source: _bmad-output/planning-artifacts/epics.md, FR76-FR81 (ops logging + escalation chain) — lines 103-108]
- [Source: _bmad-output/planning-artifacts/epics.md, NFR11 (sheets failure не теряет логи) — line 131]
- [Source: _bmad-output/planning-artifacts/epics.md, UX-DR54 (ops-metrics tracking) — line 290]
- [Source: _bmad-output/planning-artifacts/prd.md, «Ops Logging» — lines 643-658]
- [Source: _bmad-output/planning-artifacts/prd.md, «Monitoring и Уведомление» (4ч / 24ч / 30 мин thresholds) — lines 651-657]
- [Source: _bmad-output/planning-artifacts/architecture.md, line 58 — Observability: Sheet + Telegram ops-канал]
- [Source: _bmad-output/planning-artifacts/architecture.md, lines 218-219 — Telegram UX «Два чата»]
- [Source: _bmad-output/planning-artifacts/architecture.md, lines 312-323 — API & Communication Patterns: try-catch / withRetry / circuit breaker]
- [Source: _bmad-output/planning-artifacts/architecture.md, lines 326-336 — Infrastructure & Deployment: monitoring via pino + Telegram ops]
- [Source: _bmad-output/planning-artifacts/architecture.md, lines 442-446 — Logging Format Patterns]
- [Source: _bmad-output/planning-artifacts/architecture.md, line 511 — Anti-pattern Silent catch]
- [Source: src/ops.ts:11 — TODO(Story 1.9) closed by this story]
- [Source: src/bot.ts, lines 280-295 — onJobTimeout (Story 1.5) уже эмитит alertOps с context:{jobId, elapsedMs}]
- [Source: src/bot.ts, lines 558-564 — pipeline_failed alertOps catch-all]
- [Source: src/adapters/sheets.ts, lines 72-87 — getSheetsClient scope (расширяется)]
- [Source: src/adapters/sheets.ts, lines 340-370 — alertOps usage pattern (read failure)]
- [Source: src/utils/telegram-formatter.ts:80-81 — formatErrorMessage('timeout') — '⏰ Задержка. Тимур уведомлён. Пиши отчёт вручную.' (АК #6 regression)]
- [Source: src/utils/approvals.ts — append-only persistence pattern для approvals.jsonl (template для `.ops-state.json` atomic save)]
- [Source: src/utils/retry.ts — withRetry (используется в appendOpsLog)]
- [Source: src/config.ts:14-23 — TELEGRAM_CHAT_WORK_ID / TELEGRAM_CHAT_OPS_ID валидация (расширяется WORK≠OPS check)]
- [Source: _bmad-output/implementation-artifacts/deferred-work.md — «Sheets write-side adapter» card closed, «`*.raw.txt` 14-day cleanup» остаётся open для Story 1.10]
- [Source: 1-8-first-run-experience-onbording-azizy.md — паттерн `log.info` после успешного reply (применяется к opsSender error-path)]

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context) — `claude-opus-4-7[1m]`

### Debug Log References

- Полный регрессионный прогон `npx vitest run`: **332/332 passed (17 файлов)**, длительность 240s. Прирост: было 280 → стало 332 (+52 новых теста). Команда: `npx vitest run` (после Task 8).
- `npx tsc --noEmit`: exit 0, no errors. Конечный прогон после всех правок.
- Локальные test-runs по мере имплементации:
  - `npx vitest run src/utils/telegram-formatter.test.ts` → 53/53 (Task 1, +13 новых).
  - `npx vitest run src/adapters/sheets.test.ts` → 30/30 (Task 4, +8 новых для `appendOpsLog`).
  - `npx vitest run src/ops.test.ts` → 32/32 (Task 7, comprehensive новый файл).
- Edge-case: initial run ops.test.ts провалил 6 тестов через `ENOTEMPTY: directory not empty` — race между fire-and-forget `_saveWatchdogState` и afterEach `fs.rm`. Решение: добавлен `_pendingSave: Promise<void>` tracker + `_flushPendingSavesForTest()` test helper; afterEach теперь awaits перед cleanup. Без этого helper тесты могли flake в CI.
- Edge-case: tickWatchdog boundary `>=` vs `>` для 4h — explicit test `boundary: ровно 4h - 1ms → НЕ повторяет, ровно 4h → повторяет` подтверждает inclusive boundary.
- Code-review fixes run: `npx vitest run src/ops.test.ts src/adapters/sheets.test.ts src/f1-report.test.ts src/adapters/transcript.test.ts` → **119/119 passed (4 файла)**; `npx tsc --noEmit` → exit 0.
- Final regression after review fixes: `npm test -- --run` → **332/332 passed (17 файлов)**, duration 124.10s.

### Completion Notes List

**Архитектурные решения:**

1. **Module-level state setOpsTelegramSender / setOpsSheetsWriter (a.k.a. setter DI)** — выбрана вместо изменения 30+ существующих call-sites `alertOps`. Trade-off зафиксирован в story spec, риск минимальный т.к. wiring один раз при `createBot.start()`.
2. **Watchdog state persistence** — `data/.ops-state.json` atomic write (`writeFile(tmp) + rename`); ENOENT fallback на initial state с `lastSuccessAt = now`; invalid-JSON / shape-mismatch fallback с `log.warn`. Тест `_loadWatchdogState` покрывает все 4 ветки.
3. **`tickWatchdog` — pure exported function** с табличным тестом (9 строк boundary + invalid-state + 2 escalation paths). Это упрощает CI и делает behavior контракт явным.
4. **Fire-and-forget side-effects в `alertOps` / `recordOpsEvent`** — никакого await; `.catch(...)` ловит ошибки в `log.warn`. Pipeline-latency не страдает от Sheets/Telegram задержек.
5. **`appendOpsLog` НЕ вызывает `alertOps`** — recursive loop prevention. Ошибки пропагируются как rejected Promise, caller (ops.ts) ловит `log.warn`.
6. **OAuth scope расширен с `.readonly` на `spreadsheets`** — write-scope supersets read-scope, существующие read flows не сломаны. Service account нуждается в Editor доступе в Sheets UI (документировано в `docs/timur-ops-runbook.md`).
7. **WORK ≠ OPS cross-field validation** — `process.exit(1)` при равенстве на этапе `loadConfig()`. Защита от случайной leak ops-сообщений в work-чат (Azize).
8. **`OPS_AIDAR_MENTION` через `@mention` в общем ops-чате** — НЕ заводим отдельный `TELEGRAM_AIDAR_CHAT_ID`. Простое MVP-решение, упрощение vs epic AC #2.
9. **Review fix: watchdog delivery semantics** — repeat/escalation state теперь фиксируется только после успешной отправки в Telegram ops-чат. Если Telegram send падает, `lastRepeatAlertAt`/`escalatedToAidarAt` не обновляются, поэтому следующий tick не подавляется ложным cooldown.
10. **Review fix: stage-level `_ops_logs` coverage** — Sheet получает duration/status не только на финальном `bot.report.completed`, но и по основным F1 этапам: transcript, extraction, analysis, format и delivery.

**Backward-compat:**

- Сигнатура `AlertPayload` НЕ изменена; все 30+ существующих call-sites `alertOps` работают без правок.
- Все тесты Story 1.4a/1.4b/1.5/1.6/1.7/1.8 проходят без модификаций (mocks через `BotDeps.alertOps` полностью обходят расширение).
- `formatErrorMessage('timeout')` → `'⏰ Задержка. Тимур уведомлён. Пиши отчёт вручную.'` regression-pass (АК #6).

**Покрытие АК тестами:**

| АК | Тест | Файл |
|----|------|------|
| #1 (pino structured) | Регрессия Story 1.4a/1.4b f1-report.test покрывает pino-логи; review fix добавил canonical `_ops_logs` events для transcript/extraction/analysis/format/delivery. | f1-report.test.ts + transcript.test.ts + ops.test.ts |
| #2 (Sheets _ops_logs append) | `appendOpsLog (Story 1.9)` — 7 тестов: payload, retry 429, 401 no-retry, 5xx exhausted, unknown clientId, no recursive alertOps, empty durationMs. | sheets.test.ts |
| #3 (Telegram ops-чат) | `alertOps (Story 1.9)`: с/без sender — sender вызван 1 раз с правильным текстом; sender rejects → log.warn. | ops.test.ts |
| #4 (4h repeat) | `tickWatchdog`: T-4h → repeat=true; T-5h + debounce. `startWatchdog`: 5h down → ⚠️ alert. | ops.test.ts |
| #5 (24h Aidar) | `tickWatchdog`: T-24h → escalate=true. `startWatchdog`: 25h → 🚨 + @aidar. | ops.test.ts |
| #6 (30-мин timeout regression) | `formatErrorMessage('timeout')` test (Story 1.5 existing) проходит без изменений. | telegram-formatter.test.ts (existing) |
| #7 (work ≠ ops) | Cross-field validation в config.ts (process.exit(1)); существующие E2E тесты не сломаны при WORK≠OPS env. | covered by Task 8 regression run |
| #8 (success-event update watchdog) | `recordOpsEvent` тест с `step='bot.report.completed' status='ok'` → lastSuccessAt update + reset escalated/repeat. | ops.test.ts |
| #9 (state persists) | `_loadWatchdogState` 4 теста (ENOENT, valid, invalid JSON, missing shape) + atomicity test. | ops.test.ts |
| #10 (tickWatchdog pure) | Table-driven (9 строк) + boundary тест + invalid-state. | ops.test.ts |
| #11 (NFR11 Sheets fail) | sender rejects не блокирует writer; writer rejects не блокирует sender; обе ветки покрыты. | ops.test.ts |
| #12 (backward compat) | Все 332 теста зелёные. Сигнатура AlertPayload без изменений. | full regression |

**Deferred from this story:** см. `_bmad-output/implementation-artifacts/deferred-work.md` секция «Deferred from: implementation of story-1.9 (2026-05-22)». Все элементы явно вынесены за scope в самой story spec — никаких сюрпризов на этапе ревью.

### File List

**Production (изменённые):**
- `src/ops.ts` — переписан полностью (+~330 LOC; alertOps расширен + recordOpsEvent + watchdog state/persistence + tickWatchdog + startWatchdog + setters + test helpers); review fix: serialized save queue + watchdog state commit only after successful Telegram send.
- `src/adapters/sheets.ts` — OAuth scope `readonly` → `spreadsheets`; добавлен `appendOpsLog(row)` + `OPS_LOGS_RANGE` constant + import типа `OpsLogRow` (type-only) (+~55 LOC).
- `src/adapters/transcript.ts` — review fix: `recordOpsEvent` для `transcript.total` success/error с duration/status.
- `src/f1-report.ts` — review fix: `recordOpsEvent` для extraction, analysis и format success/partial stages.
- `src/utils/telegram-formatter.ts` — `formatOpsAlert` + `formatWatchdogRepeat` + helpers `truncatePlain` / `safeStringifyForOps` / `humanReadableOpsDate` + `OPS_LEVEL_ICON` const (+~95 LOC).
- `src/bot.ts` — импорт новых exports из ops.ts/sheets.ts; `_watchdogHandle` closure-state; `recordOpsEvent('info', step:'bot.report.completed')` после success-path в processJob; review fix: `recordOpsEvent` для `bot.report.delivery`; wiring `setOpsTelegramSender` / `setOpsSheetsWriter` + `startWatchdog` в `start()` (только production: `deps.botInfo === undefined`); stop-cleanup в `stop()` (+~35 LOC).
- `src/config.ts` — `OPS_AIDAR_MENTION` field в ConfigSchema (default ''); WORK ≠ OPS cross-field validation после parse (process.exit(1) при равенстве) (+~14 LOC).
- `.env.example` — добавлен `OPS_AIDAR_MENTION=` (+3 строки).

**Tests (новые / расширенные):**
- `src/ops.test.ts` — НОВЫЙ файл (+~525 LOC); 32 теста: alertOps (7), recordOpsEvent (4), tickWatchdog table-driven (10), _load/_save state (5), startWatchdog (6).
- `src/adapters/sheets.test.ts` — расширен `appendOpsLog` describe (+~95 LOC, 7 новых тестов).
- `src/utils/telegram-formatter.test.ts` — `formatOpsAlert` (7) + `formatWatchdogRepeat` (4) describes (+~145 LOC, 11 новых тестов).

**Docs / metadata:**
- `docs/timur-ops-runbook.md` — НОВЫЙ admin runbook (+~95 строк): service-account Editor доступ, создание worksheet `_ops_logs` со схемой, `OPS_AIDAR_MENTION` config, WORK≠OPS validation, watchdog state file, deferred-from-Story-1.9 список.
- `_bmad-output/implementation-artifacts/deferred-work.md` — отметка PARTIALLY CLOSED для «Sheets write-side adapter» (1.3 deferred); уточнения «остаётся deferred to Story 1.10» для двух `*.raw.txt` cleanup карточек; новая секция «Deferred from: implementation of story-1.9 (2026-05-22)» с 10 пунктами из story-spec out-of-scope.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — обновлён `1-9-ops-logging-i-alerty: ready-for-dev → in-progress → review → done`.

## Change Log

| Date | Author | Change |
|------|--------|--------|
| 2026-04-22 | bmad-create-story | Initial story creation (12 АК, 10 задач) |
| 2026-05-21 | bmad-create-story | Story → ready-for-dev (после iteration) |
| 2026-05-22 | bmad-dev-story (Opus 4.7) | Story → review: implementation complete; 332/332 tests pass; tsc clean; +52 новых теста; обновлён deferred-work.md; новый docs/timur-ops-runbook.md |
| 2026-05-22 | Codex | Code-review fixes applied; story → done after targeted tests and typecheck: stage-level `_ops_logs` events, watchdog send-before-state-commit, serialized watchdog saves, `appendOpsLog` failure warn. |
