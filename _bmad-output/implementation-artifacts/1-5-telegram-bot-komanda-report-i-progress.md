# Story 1.5: Telegram bot — команда `/report` и прогресс

Status: review

## Пользовательская история

Как **коуч практики (Азиза)**,
Я хочу **отправлять `/report <url>` боту, мгновенно получать acknowledge и видеть прогресс генерации через editMessageText**,
Чтобы **я знала что pipeline принял запрос, могла мониторить его без переключения контекста и получала готовый отчёт (или внятный partial при сбое) в виде Telegram-сообщения, готового к подтверждению в Story 1.6**.

## Контекст и границы scope

**Эта история** превращает `RunF1Result` (Story 1.4b, объект `DeliveryReadyReport`) в Telegram-взаимодействие: command handler, acknowledgement, прогресс через `editMessageText`, рендеринг финального отчёта, queueing, invalid-URL/short-transcript guards и Bot Menu. Approve/Edit/Reject callbacks НЕ входят — это Story 1.6.

**Что входит в Story 1.5 (production-код в `src/`):**

- **`src/bot.ts` (новый файл, ~250-300 LOC)** — единая точка для grammY: bootstrap, command handler `/report`, прогресс-цикл, рендеринг, Bot Menu, whitelist guard, ошибки. Файл указан в архитектуре ([architecture.md:534](_bmad-output/planning-artifacts/architecture.md#L534), `bot.ts — grammY: commands, inline buttons, Bot Menu, F5, progress (~250-300)`).
- **`src/index.ts`** — расширить bootstrap: создавать и запускать `Bot` (`grammY`) **параллельно с HTTP-сервером**; добавить graceful shutdown для бота (вызвать `bot.stop()` в существующем `shutdown(signal)` перед `server.close`).
- **`src/config.ts`** — расширить `ConfigSchema`:
  - `TELEGRAM_TRACKER_CHAT_IDS: z.string().min(1)` — comma-separated whitelist trackers (например `"7890,12345"`). Парсится в `Set<number>` в helper'е `parseTrackerChatIds(config.TELEGRAM_TRACKER_CHAT_IDS) → Set<number>` (transform с валидацией: каждый элемент `Number.parseInt`, проверка `>0`).
  - `F1_PROGRESS_UPDATES_ENABLED: z.coerce.boolean().default(true)` — kill-switch для прогресс-edits (на случай Telegram rate-limit инцидентов).
  - `F1_QUEUE_MAX_SIZE: z.coerce.number().int().positive().default(20)` — лимит in-memory очереди (защита от runaway).
- **`.env.example`** — добавить новые vars + комментарии.
- **`src/types.ts`** — добавить:
  - `ReportJobSchema` (Zod): `{ id: string (8-char), chatId: number, messageId: number, url: string, clientId: string, topName: string, meetingDate: string, status: 'queued'|'running'|'completed'|'failed', queuedAt: string ISO, startedAt?: string ISO, completedAt?: string ISO, progressMessageId?: number, retryCount: number, partial?: boolean, partialReason?: PartialReason }`.
  - `ReportJobInputSchema` (Zod): user-facing input, парсится из `/report <url>` — `{ url: string.min(8).max(2048), clientId: string (на MVP — `'geonline'` hardcode), topName: string (на MVP — `'Жанель'` hardcode fallback), meetingDate: string YYYY-MM-DD (на MVP — `today()` fallback) }`. Полный workflow с указанием топа/даты — Story 1.13 (поиск/выбор) или Story 1.8 (onboarding флоу). На 1.5 — defaults из config + опционально override через grammY context (например `/report <url> --top "Жанель"` parsing).
- **`src/utils/url-parser.ts` (новый, ~60 LOC)** — pure-функция `parseReportUrl(text: string): { ok: true, url: string } | { ok: false, reason: 'invalid_url' | 'unsupported_provider' | 'missing_arg' }`:
  - Trim, проверка непустоты.
  - Проверка `URL`-парсингом (try/catch для `new URL(...)`).
  - Whitelisting hosts: `drive.google.com`, `docs.google.com`, `*.zoom.us` (re-use существующие regex из `src/adapters/drive.ts` если они там вынесены; иначе skopirовать pattern). Хост не в whitelist → `unsupported_provider`.
  - Возвращает структурированный результат для error-message mapping.
- **`src/utils/report-queue.ts` (новый, ~80 LOC)** — in-memory FIFO очередь `ReportJob`. API:
  - `enqueue(job: ReportJob): { position: number, queueSize: number }` — добавляет, throws `QueueOverflowError` если `size >= F1_QUEUE_MAX_SIZE`.
  - `dequeue(): ReportJob | undefined` — берёт следующий.
  - `peek(jobId: string): ReportJob | undefined` — для статуса.
  - `size(): number`.
  - `findByChatId(chatId: number): ReportJob[]` — для Bot Menu «Статус».
  - **Worker loop** (single-concurrent): `startWorker(handler: (job: ReportJob) => Promise<void>): () => void` — запускает `while (job = dequeue())` loop, передаёт каждый job в handler, ловит и логирует исключения **без падения worker'а**. Возвращает функцию остановки (для shutdown). Worker ждёт через `Promise<void>` (resolve на enqueue), без busy-polling.
  - Hint: используй простой `EventEmitter` или `Promise.withResolvers()` для wake-up worker'а.
- **`src/utils/telegram-formatter.ts` (новый, ~150 LOC)** — pure formatting helpers (architecture#Component Strategy, line 933):
  - `formatHeader(args: { emoji: string, topName: string, topic: string, period: string }): string` → `📋 Жанель │ Продажи │ Нед. 18` (трёхуровневый header, [ux-design-specification.md:418-419](_bmad-output/planning-artifacts/ux-design-specification.md#L418-L419)).
  - `formatDeliveryReport(report: DeliveryReadyReport): string` — главная функция: рендерит full `DeliveryReadyReport` (или partial-вариант с `extractionFallback`) в Telegram-message с MarkdownV2-escape'нутым текстом, max 3 секции, секция «📱 Для топа» если есть `topMessageDraft`. См. UX template line 500-523. Возвращает **строку** (не TG message); split logic в bot.ts.
  - `formatProgressStep(step: 'queued' | 'running_extraction' | 'running_analysis' | 'running_formatting' | 'almost_ready'): string` — мапит на 4 UX-стейта прогресса:
    - `queued` → «✅ Принято. Отчёт через ~15 мин.» (или с queue position если N > 1).
    - `running_extraction` → «🔄 Читаю транскрипт…»
    - `running_analysis` → «🔄 Формирую отчёт…»
    - `running_formatting` → «🔄 Форматирую секции…»
    - `almost_ready` → «🔄 Почти готово…»
    - [ux-design-specification.md:65](_bmad-output/planning-artifacts/ux-design-specification.md#L65), UX-DR3.
  - `formatQueueAck(position: number, totalSize: number): string` → `«✅ Принято. В очереди: N из M.»` (UX-DR9, UX-DR21).
  - `formatPartialReportFallback(report: DeliveryReadyReport & { partial: true }): string` — рендерит «⚠️ Автоформатирование не удалось. Сырые данные:» + extractionFallback list (commitments + first decisions + first 10 citations). UX [ux-design-specification.md:866-876](_bmad-output/planning-artifacts/ux-design-specification.md#L866-L876).
  - `formatErrorMessage(code: 'invalid_url' | 'unsupported_provider' | 'transcript_too_short' | 'transcript_download_failed' | 'pipeline_failed' | 'queue_overflow' | 'unauthorized' | 'missing_arg' | 'timeout', context?: Record<string, unknown>): string` — мапит код на пользовательский текст: `«⚠️ Ссылка не распознана. Проверь формат.»` / `«⚠️ Слишком короткий. Отчёт требует ≥ 2 мин.»` / т.д. (UX-DR24, UX-DR65, UX-DR66, [ux-design-specification.md:866-876](_bmad-output/planning-artifacts/ux-design-specification.md#L866-L876)).
  - `splitForTelegram(text: string, maxLen: number = 4000): string[]` — split > 4096 (4000 safe margin). Разрезает только по `\n\n` (sections), не по слову. Если одна секция > 4000 — split грубо по `\n`. UX-DR25, UX-DR74, FR68. Each piece получает continuation header `📋 Жанель (продолжение)`. **Кнопки только под последним**, поэтому `splitForTelegram` возвращает array, bot.ts отправляет все кроме последнего без буттонов.
  - `escapeMarkdownV2(text: string): string` — escape для grammY `parse_mode: 'MarkdownV2'`. **ВАЖНО:** MarkdownV2 escape для всех reserved chars: `_*[]()~\`\>#+-=|{}.!`. Использовать regex/replace, **никогда не использовать html-mode для смешивания с эмодзи**.
- **`src/utils/transcript-duration-guard.ts` (новый, ~30 LOC)** — pure-функция `assertTranscriptDuration(transcript: Transcript): void`:
  - throws `TranscriptValidationError('too_short', { durationSec, minSec: 120 })` если `transcript.metadata.duration < 120` (FR / UX-DR66).
  - Helper, чтобы `bot.ts` не делал inline сравнение.
- **`src/bot.ts` — основная логика:**
  - **Bootstrap**: `createBot(deps: BotDeps)` — фабрика, принимает зависимости (`runF1`, `transcribeFromUrl`, `readClientContext`, queue, alertOps, logger). Для тестируемости.
  - **Whitelist middleware**: первое middleware — проверка `ctx.chat?.id ∈ trackerChatIds`. Если нет — `ctx.reply('⚠️ Unauthorized.')` + `alertOps({pipeline:'F1', step:'bot.unauthorized', context:{chatId}})` (UX-DR / NFR26). Молчать тоже плохо (NFR / UX «never-silent»); ответить, но один раз, чтобы не давать боту info leak (UX-DR39).
  - **Command `/report <url>` handler** ([epics.md:613-633](_bmad-output/planning-artifacts/epics.md#L613-L633), FR27, FR63):
    1. Извлечь arg: `ctx.match` (grammY `bot.command()` даёт match как remainder). Trim. Если пусто → `formatErrorMessage('missing_arg')` reply, abort.
    2. `parseReportUrl(arg)`. Если `ok:false` → reply с `formatErrorMessage('invalid_url' | 'unsupported_provider')` < 5 сек, abort (UX-DR65).
    3. Acknowledge: `await ctx.reply(formatQueueAck(position, queueSize))` — ответ в течение **< 2 сек** (NFR4, UX-DR1, AC #1). Сохранить `messageId` ответа → это будет `progressMessageId`.
    4. Создать `ReportJob` (через `randomUUID().slice(0,8)`, `chatId = ctx.chat.id`, `progressMessageId = ack.message_id`, дефолты `clientId/topName/meetingDate`), сохранить в `report-queue`.
    5. Если `enqueue` throws `QueueOverflowError` → reply `formatErrorMessage('queue_overflow')`, `alertOps`, abort.
    6. Если `position > 1` → ack-сообщение уже содержит queue position (UX-DR9, AC #2).
  - **Worker handler** (зарегистрирован в `startWorker`):
    1. `job.status = 'running'`. **editMessageText** → `formatProgressStep('running_extraction')` (если `F1_PROGRESS_UPDATES_ENABLED`). Catch grammY errors (`MESSAGE_NOT_MODIFIED`, `429` rate-limit) — log warn, продолжить.
    2. `await transcribeFromUrl(job.url, {clientId, meetingDate, meetingType?})` (Story 1.2). Catch `TranscriptDownloadError`/`TranscriptValidationError`/`TranscriptProviderError`:
       - `TranscriptValidationError('too_short')` → reply `formatErrorMessage('transcript_too_short')`, alertOps INFO-level (не критично), `job.status='failed'`, return.
       - `TranscriptDownloadError` → reply `formatErrorMessage('transcript_download_failed', {code: err.code})` с конкретным кодом, alertOps, return.
       - Other → reply «⏰ Задержка. Тимур уведомлён. Пиши отчёт вручную.» (UX-DR2, UX-DR23, NFR / UX-DR39), alertOps WARN.
    3. **Guard duration**: `assertTranscriptDuration(transcript)` (FR / UX-DR66). Same handling как `'too_short'`.
    4. editMessageText → `formatProgressStep('running_analysis')` (между extraction и format логически).
    5. `await readClientContext({clientId})` (Story 1.3).
    6. editMessageText → `formatProgressStep('running_formatting')`.
    7. `const result = await runF1({transcript, clientContext, meta: {clientId, topName, meetingDate, meetingType?}, deps: {signal: jobAbortSignal}})` (Story 1.4b). **`runF1` — единая точка**; шаги 1-2-3-4 внутри.
    8. editMessageText → `formatProgressStep('almost_ready')` (опционально перед финальным render — между runF1 и render-сообщением; на MVP можно пропустить если runF1 уже в `running_formatting`).
    9. Render финального report:
       - `messages = splitForTelegram(formatDeliveryReport(result.formattedReport))`.
       - editMessageText на `progressMessageId` → первое из `messages[0]` (заменяет «🔄 Почти готово…» на полный отчёт).
       - Если `messages.length > 1` → последующие `messages[1..]` как новые `ctx.reply`.
       - На MVP **без inline buttons** (approve/edit/reject — Story 1.6). Опционально добавить placeholder-комментарий в коде.
    10. `job.status = 'completed'`, log info `bot.report.completed` с `durationMs`, `partial`, `partialReason`.
    11. На `partial: true` → render через `formatPartialReportFallback`, тот же split-flow.
    12. Catch-all: любая не-обработанная ошибка → editMessageText → «⏰ Задержка. Тимур уведомлён.» + alertOps + `job.status='failed'`. **Worker НЕ падает** (loop продолжается со следующим job).
  - **Bot Menu** ([epics.md:633](_bmad-output/planning-artifacts/epics.md#L633), UX-DR18): на старте бота вызвать `bot.api.setMyCommands([{command: 'report', description: 'Создать отчёт по встрече'}])` и `bot.api.setChatMenuButton({menu_button: {type: 'commands'}})`. **На 1.5 — только `/report` в меню.** «Найти / Повестка / Статус» обсуждены в [epics.md:633](_bmad-output/planning-artifacts/epics.md#L633), но `[🔍 Найти]` = Story 1.13, `[📋 Повестка]` = Story 3.4, `[📊 Статус]` = Story 1.12. Не реализовывать на 1.5; добавить TODO-комментарий со ссылками на эти stories.
  - **Auto-timeout watchdog**: после enqueue запускать `setTimeout(() => emitTimeoutIfStillRunning(jobId), 30 * 60 * 1000)` (30 минут, FR78, NFR1). При срабатывании: проверить `job.status === 'running' | 'queued'`. Если да → editMessageText → «⏰ Задержка. Тимур уведомлён. Пиши отчёт вручную.» + alertOps + `job.status='failed'`. **Не отменять реальный pipeline** на 1.5 — `AbortController` для `runF1` пробрасывается, но cancellation остаётся as-is (если runF1 в момент timeout всё ещё работает, он завершится; результат проигнорирован). Полная отмена — Story 1.9. На 1.5 минимально: пользователь получает сообщение, ops alerted, job помечен failed.
- **Тесты:**
  - `src/utils/url-parser.test.ts` — happy path (gdrive, zoom), edge cases (https://example.com → unsupported, empty → missing_arg, malformed URL → invalid_url, leading/trailing whitespace).
  - `src/utils/report-queue.test.ts` — enqueue/dequeue/peek/size, overflow throws, worker loop вызывает handler, worker не падает на handler throw, остановка worker'а через returned стоп-функцию.
  - `src/utils/telegram-formatter.test.ts` — `formatHeader` shape, `formatProgressStep` mapping, `formatQueueAck` для N=1 и N>1, `splitForTelegram` для текста < 4000 и > 4000, `escapeMarkdownV2` для всех reserved chars, `formatDeliveryReport` для full и partial.
  - `src/utils/transcript-duration-guard.test.ts` — duration < 120 → throws, ≥ 120 → ok.
  - `src/bot.test.ts` — **integration-style тесты через grammY testing toolkit** (см. ниже Testing Standards). Минимум 8 тестов:
    1. `/report <gdrive_url>` от authorized chatId → ack < 100 ms (synchronous time-budget proxy для NFR4), запись в queue, progressMessage отправлен.
    2. `/report` без аргумента → reply «⚠️ Ссылка не распознана. Проверь формат.» < 5 сек, queue не растёт.
    3. `/report <invalid_url>` от authorized → reply invalid_url, queue не растёт.
    4. Authorized + 2 параллельных `/report` → второй ack содержит «В очереди: 2 из 2.».
    5. Unauthorized chatId `/report <url>` → reply unauthorized, alertOps вызван 1 раз, queue не растёт.
    6. Worker processes queued job → editMessageText вызван N раз (queued → extraction → analysis → formatting → final).
    7. Worker catches `TranscriptValidationError('too_short')` → reply formatErrorMessage('transcript_too_short'), не альертится как ops_alert (info-level), job.status='failed', worker продолжает следующий.
    8. Worker catches runtime error из runF1 → reply «⏰ Задержка. Тимур уведомлён.», alertOps, worker не падает, job.status='failed'.

**Что НЕ входит (следующие stories):**

- **Approve / Edit / Reject inline buttons + callbacks** — Story 1.6. На 1.5 финальный отчёт **БЕЗ** approve-кнопок. Это намеренно: 1.5 проверяет команду + прогресс + рендеринг отдельно; 1.6 — approval state machine + persistence (`approvals.jsonl`). Если совместить — слишком большая story (растёт scope-creep).
- **First-run experience / онбординг Азизы** — Story 1.8 (приветствие при первом сообщении).
- **`[🔍 Найти]` (поиск прошлых отчётов)** — Story 1.13.
- **`[📋 Повестка]` (F4 cached agenda)** — Story 3.4.
- **`[📊 Статус]` (Ops статус)** — Story 1.12.
- **Реальная отмена пайплайна по таймеру / AbortController в worker'е** — Story 1.9. На 1.5 timeout = user-facing message + ops alert; pipeline в фоне ещё может крутиться (на MVP это приемлемо, max ~15 мин излишней работы).
- **F5 collection через бота / inline keyboard для метрик** — Epic 2 (deferred to Growth).
- **Delivery / отправка от имени трекера / `📱 Для топа` рассылка топам** — Story 1.7 (delivery use case). 1.5 рендерит секцию «📱 Для топа» текстово в отчёте (часть `formatDeliveryReport`), но никуда не пересылает.
- **Auto-deletion раннего ack-сообщения** — нет такого требования, ack остаётся; пользователь видит свой прогресс.
- **Persistence ReportJob на диск** — на 1.5 in-memory queue. При рестарте Docker — running jobs теряются; новый запрос пользователю придётся повторить. Полная persistence — Story 1.10.
- **Webhook mode для grammY** — Story 1.14 (deploy on Hostinger VPS). На 1.5 — **long polling** (grammY `.start()` без `webhookCallback`). Long polling работает в dev/локально и **временно** в prod до Story 1.14.
- **Канареечный / golden test через бота** — Story 1.11 (canary).
- **Telegram message throttling / rate-limit handling beyond catching `429`** — Story 1.9 / Growth.
- **MarkdownV2 vs HTML alternative rendering** — на 1.5 фиксируем MarkdownV2; если возникнут проблемы с эмодзи/казахскими цитатами — переключение на plain text fallback (без bold/italic) обсудим в 1.5 review. Не делать заранее.

**Контракт между 1.4b и 1.5:**

```typescript
// 1.4b output (зафиксирован, см. src/f1-report.ts:645):
RunF1Result = RunF1Steps12Result + {
  formattedReport: DeliveryReadyReport;  // discriminated union по `partial`
  partial: boolean;
  partialReason?: 'format_step_failed' | 'format_validation_failed' | 'format_retry_exhausted';
  durationsMs: { extraction, analysis, format, total };
  tokens: { input, output };
  rawResponses: { extraction, analysis, format: string | null };
}

// 1.5 consumes RunF1Result через runF1(...) — единственная точка взаимодействия с pipeline.
// 1.5 НЕ зовёт runF1Steps12 или runF1Steps34 напрямую.
```

## Критерии приёмки

1. **Сценарий: команда `/report <url>` от авторизованного трекера → acknowledge < 2 сек + queue position** (FR27, FR63, NFR4, UX-DR1, UX-DR9, [epics.md:615-622](_bmad-output/planning-artifacts/epics.md#L615-L622))
   ```
   Дано Azиза (chatId ∈ TELEGRAM_TRACKER_CHAT_IDS) отправляет `/report https://drive.google.com/file/d/abc123/view?usp=sharing`
   Когда grammY получает Update от Telegram
   Тогда whitelist middleware пропускает (chatId в Set'е)
     И parseReportUrl возвращает { ok: true, url }
     И bot.ts создаёт ReportJob: { id: randomUUID().slice(0,8), chatId, url, ...defaults }
     И enqueue вызван; возвращает { position: 1, queueSize: 1 } (для одиночного запроса)
     И ctx.reply вызван с formatQueueAck(1, 1) = "✅ Принято. Отчёт через ~15 мин." (< 2 сек acknowledge — NFR4)
     И сохранён progressMessageId = ack.message_id в job
     И log.info({step:'bot.report.queued', jobId, chatId, position:1, queueSize:1})
   И при position > 1:
     И ctx.reply возвращает "✅ Принято. В очереди: N из M." (UX-DR9)
   ```

2. **Сценарий: пустая команда `/report` без URL → понятное сообщение об ошибке < 5 сек** (UX-DR24, UX-DR65)
   ```
   Дано Азиза отправляет `/report` (или `/report   ` с пробелами)
   Когда ctx.match — пустая строка
   Тогда parseReportUrl возвращает { ok: false, reason: 'missing_arg' }
     И ctx.reply вызван с formatErrorMessage('missing_arg') = "⚠️ Укажи ссылку. Пример: /report https://drive.google.com/..." (или похожее)
     И queue.size() не изменилось
     И log.info({step:'bot.report.invalid_input', reason:'missing_arg', chatId})
   И ответ доставлен < 5 сек (UX-DR65 порог)
   ```

3. **Сценарий: невалидный URL → "⚠️ Ссылка не распознана"** (UX-DR65, [epics.md:624-626](_bmad-output/planning-artifacts/epics.md#L624-L626))
   ```
   Дано Азиза отправляет `/report https://example.com/foo`
   Когда parseReportUrl парсит URL
   Тогда host `example.com` не в whitelist
     И возвращает { ok: false, reason: 'unsupported_provider' }
     И ctx.reply: "⚠️ Ссылка не распознана. Проверь формат." (UX-DR65 exact wording, [epics.md:626](_bmad-output/planning-artifacts/epics.md#L626))
     И queue.size() = 0
   И malformed URL (например `not-a-url`):
     И parseReportUrl возвращает { ok: false, reason: 'invalid_url' }
     И ctx.reply: "⚠️ Ссылка не распознана. Проверь формат." (то же сообщение для unsupported и invalid; разница только в log.context)
   ```

4. **Сценарий: транскрипт < 2 минут → "⚠️ Слишком короткий"** (UX-DR66, FR / [epics.md:628-630](_bmad-output/planning-artifacts/epics.md#L628-L630))
   ```
   Дано job worker запустил pipeline; transcribeFromUrl вернул Transcript с metadata.duration = 90 (сек)
   Когда assertTranscriptDuration(transcript) проверяет
   Тогда throws TranscriptValidationError('too_short', { durationSec: 90, minSec: 120 })
     И bot.ts ловит → editMessageText на progressMessageId: "⚠️ Слишком короткий. Отчёт требует ≥ 2 мин." (UX-DR66)
     И alertOps('info-level' — не критично, но запись в логи): { pipeline:'F1', step:'bot.report.too_short', clientId, context:{durationSec:90, url} }
     И job.status = 'failed', job.completedAt = now()
     И worker продолжает следующий job (НЕ падает)
   ```

5. **Сценарий: chatId не в whitelist → "⚠️ Unauthorized" + ops alert** (NFR26, NFR27, architecture#Authentication)
   ```
   Дано Неизвестный chatId 99999 отправляет `/report <url>`
   Когда whitelist middleware проверяет
   Тогда chatId ∉ trackerChatIds
     И ctx.reply: "⚠️ Доступ ограничен." (или похожее короткое сообщение, без leak инфы об whitelist)
     И alertOps({ pipeline:'F1', step:'bot.unauthorized', context:{chatId:99999, command:'/report'} }) — Тимур видит попытку доступа
     И command handler НЕ вызван (middleware прерывает chain)
     И queue.size() = 0
   ```

6. **Сценарий: queue overflow при F1_QUEUE_MAX_SIZE+1 запросах** (FR67 implicit, architecture defensive)
   ```
   Дано F1_QUEUE_MAX_SIZE = 20 (default)
     И в очереди уже 20 jobs (running + queued)
   Когда 21-й /report приходит от авторизованного трекера
   Тогда enqueue throws QueueOverflowError
     И bot.ts ловит → ctx.reply: "⚠️ Очередь заполнена (20 задач). Попробуй позже."
     И alertOps WARN: { pipeline:'F1', step:'bot.queue_overflow', queueSize:20 }
     И queue.size() остался 20 (не вырос)
   ```

7. **Сценарий: editMessageText через 4 progress-стейта от queued до final report** (UX-DR3, [ux-design-specification.md:65](_bmad-output/planning-artifacts/ux-design-specification.md#L65))
   ```
   Дано job в worker, F1_PROGRESS_UPDATES_ENABLED = true
   Когда worker.handle(job) выполняется
   Тогда последовательность editMessageText на progressMessageId:
     1. (ack уже на месте — formatQueueAck) — не edit, это начальное состояние.
     2. editMessageText: "🔄 Читаю транскрипт…" — перед transcribeFromUrl.
     3. editMessageText: "🔄 Формирую отчёт…" — после успешного transcribeFromUrl, перед runF1.
        ИЛИ: "🔄 Форматирую секции…" — между step12 и step34 в orchestrator runF1 (НО runF1 — единая функция; разделить нельзя без рефакторинга 1.4b). На 1.5 принимаем компромисс: один edit перед всем runF1.
     4. editMessageText: "🔄 Почти готово…" — после runF1, перед splitForTelegram + render.
     5. editMessageText: финальный текст отчёта (formatDeliveryReport, первый кусок если split) — заменяет «Почти готово…»
     6. Если split.length > 1 → ctx.reply остальные части (continuation header).
   И каждый editMessageText обёрнут в try/catch; при `MESSAGE_NOT_MODIFIED` или 429-rate-limit → log.warn, продолжать pipeline (не abort).
   И если F1_PROGRESS_UPDATES_ENABLED = false → шаги 2-4 пропускаются, только финальный edit на 5.
   ```

8. **Сценарий: успешный конец pipeline — полный отчёт отрендерен с трёхуровневым header'ом** (UX-DR4, UX-DR16, UX-DR35, [ux-design-specification.md:500-523](_bmad-output/planning-artifacts/ux-design-specification.md#L500-L523))
   ```
   Дано runF1 вернул RunF1Result с partial:false, formattedReport: full DeliveryReadyReport
   Когда bot.ts вызывает formatDeliveryReport(result.formattedReport)
   Тогда финальный текст содержит:
     - Первая строка: трёхуровневый header "📋 {topName} │ {department or topic} │ Нед. {weekNum}" (formatHeader)
       (Department берётся из stakeholderMap — runF1 уже передаёт его в format-промпт, но в DeliveryReadyReport его НЕТ; на 1.5 либо добавить `department?` в DeliveryReadyReport schema (минорное расширение types.ts), либо bot.ts читает clientContext снова. **Решение:** добавить `department?: string` и `weekNumber?: string` в FullDeliveryReportSchema (extension не break, optional). runF1 заполняет; bot.ts читает. Если поля отсутствуют (legacy partial), header → "📋 {topName} │ Отчёт │ —". См. также Patch P-Story1.5-1 в Task 11.)
     - Вторая строка: bold summary_line (escape MarkdownV2).
     - Пустая строка.
     - До 3 секций (FormatSection.title как bold, FormatSection.content как текст).
     - Если есть topMessageDraft → отдельная секция "📱 Для {topName}:" + draft в italic (UX line 517-519).
     - Commitments list с lifecycle-emoji (🔵 New) — на 1.5 пока все commitments → 🔵 (Story 1.7/1.10 добавит реальный lifecycle).
   И длина результата ≤ 4096 — если больше, splitForTelegram режет; bot.ts шлёт первый кусок через editMessageText, остальные — через ctx.reply (UX-DR25, UX-DR74).
   И parse_mode: 'MarkdownV2' в опциях reply/edit; ВСЕ user-content prefixed через escapeMarkdownV2.
   ```

9. **Сценарий: partial result (1.4b сбой 3-4) → "⚠️ Автоформатирование не удалось" + extractionFallback** (FR62, FR30, NFR10, [ux-design-specification.md:866-876](_bmad-output/planning-artifacts/ux-design-specification.md#L866-L876))
   ```
   Дано runF1 вернул RunF1Result с partial:true, partialReason:'format_validation_failed' | 'format_retry_exhausted' | 'format_step_failed'
     И formattedReport.extractionFallback = { commitments, citations (≤10), decisions, facts }
   Когда bot.ts видит result.partial === true
   Тогда вызывает formatPartialReportFallback(formattedReport)
     И текст начинается с "⚠️ Автоформатирование не удалось. Сырые данные:" (UX-DR23, UX line 866)
     И после warning — три блока:
       - "📌 Решения:" — bullet list из extractionFallback.decisions (или "—" если пусто).
       - "🔵 Commitments:" — bullet list из extractionFallback.commitments (who → what, до {deadline}, *italic quote*).
       - "📝 Цитаты:" — первые ≤10 extractionFallback.citations (timestamp + *italic text* + speaker).
     И editMessageText заменяет "🔄 Почти готово…" на этот текст.
     И НЕ показывает inline approve buttons (на 1.5 их вообще нет; в 1.6 партиал тоже не получит approve).
     И log.info({step:'bot.report.partial_delivered', jobId, partialReason})
     И alertOps WARN: { pipeline:'F1', step:'bot.partial_result', context:{partialReason, jobId} } — Тимуру.
   ```

10. **Сценарий: ошибка transcribeFromUrl (download_failed / network) → "⏰ Задержка. Тимур уведомлён."** (UX-DR2, UX-DR23, UX-DR39 «never silent»)
    ```
    Дано transcribeFromUrl throws TranscriptDownloadError('access_denied' | 'not_found' | 'network' | ...)
    Когда worker.handle ловит ошибку
    Тогда editMessageText на progressMessageId: "⏰ Задержка. Тимур уведомлён. Пиши отчёт вручную." (UX-DR2 wording)
      И alertOps WARN: { pipeline:'F1', step:'bot.transcript_failed', clientId, context:{downloadErrorCode, url} }
      И job.status = 'failed', completedAt set
      И worker НЕ падает; берёт следующий job
    И аналогично для:
      - TranscriptProviderError (Soniox) → same "⏰ Задержка."
      - TranscriptValidationError('schema') → same "⏰ Задержка." + alertOps ERROR.
      - Других неизвестных ошибок (`catch(err)`-catch-all) → same.
    Исключение: TranscriptValidationError('too_short') / 'empty' → специальный UX (AC #4) "⚠️ Слишком короткий" (info-level).
    ```

11. **Сценарий: catch-all для unhandled error в worker (runF1 throws)** (FR34, NFR9, architecture#Error Handling)
    ```
    Дано runF1 throws неожиданное (НЕ partial — partial возвращается в RunF1Result, не throw)
      Например: F1PipelineError('delivery_prep'), F1PipelineError('prompt_load'), TypeError из bug в коде, AbortError при cancellation
    Когда worker.handle catch ловит исключение
    Тогда:
      - editMessageText: "⏰ Задержка. Тимур уведомлён. Пиши отчёт вручную."
      - alertOps ERROR: { pipeline:'F1', step:'bot.pipeline_failed', clientId, error: err, context:{jobId, errorName, errorCode?} } — Тимур видит код ошибки для дебага.
      - job.status='failed', completedAt set.
      - log.error({step:'bot.report.failed', err, jobId}) с полным stack.
      - **worker НЕ падает** — берёт следующий job; критично для resilience (architecture pre-mortem #4 "Process crash убивает всё" — guard).
    И AbortError исключение: log.info вместо error (это управляемая отмена), сообщение пользователю опционально (на 1.5 cancellation не triggered — игнорируем).
    ```

12. **Сценарий: 30-минутный watchdog timeout** (FR78, NFR1, UX-DR2)
    ```
    Дано job создан в 10:00:00; в 10:30:00 watchdog timer срабатывает
    Когда watchdog проверяет job.status
    Тогда если job.status ∈ {'queued', 'running'}:
      - editMessageText: "⏰ Задержка. Тимур уведомлён. Пиши отчёт вручную."
      - alertOps ERROR: { pipeline:'F1', step:'bot.report.timeout', clientId, context:{jobId, elapsedMs:1800000} }
      - job.status = 'failed', job.completedAt = now()
      - НЕ отменять реальный pipeline (1.9 добавит cancellation). Если он успеет завершиться позже — результат отбрасывается (worker всё равно увидит job.status === 'failed' и проигнорирует render).
    И если job.status === 'completed' / 'failed' → timer noop.
    И watchdog timer cleanup на завершение job (handler defer-cleanup):
      - Сохранять `clearTimeout(timerId)` ref на job.
      - В finally worker.handle → clearTimeout(job.timeoutTimerId) если не сработал.
    ```

13. **Сценарий: Telegram MarkdownV2 escape для пользовательского контента** (architecture#Format Patterns, defensive)
    ```
    Дано Claude вернул summary_line с символами `_*[]()~` (например, цитата с подчёркиванием в имени файла, или markdown-нотацией)
    Когда formatDeliveryReport собирает финальный текст с parse_mode:'MarkdownV2'
    Тогда escapeMarkdownV2 применяется ко ВСЕМУ user-content (summary_line, sections.content, commitments quote, decisions, facts, citations).
    И escapeMarkdownV2 НЕ применяется к "своим" MarkdownV2-конструкциям, которые мы намеренно добавляем (например, `*bold header*`, `_italic quote_`).
    И тест escapeMarkdownV2('a_b*c.d!') === 'a\\_b\\*c\\.d\\!' (все 18 reserved chars Telegram MarkdownV2).
    И reply отправляется без 400 BAD_REQUEST от Telegram API на сложных вводах.
    И **на 1.5 — fail-safe**: если editMessageText throws с грубой ошибкой parsing (400), bot.ts retry'ит с `parse_mode: undefined` (plain text fallback) ОДИН раз. Если plain text тоже падает — alertOps ERROR. Лог `bot.markdown.fallback` с raw сообщением. Это защита от bug в escapeMarkdownV2.
    ```

14. **Сценарий: split > 4096 символов на 2-3 части с continuation header** (FR68, UX-DR25, UX-DR74, [epics.md:691-694](_bmad-output/planning-artifacts/epics.md#L691-L694))
    ```
    Дано formatDeliveryReport вернул текст длиной 5800 символов (типичный случай для большого отчёта с full секциями)
    Когда splitForTelegram(text, 4000) выполняется
    Тогда возвращает массив, например ['<первая часть с header>...', '📋 Жанель (продолжение)\n\n<вторая часть>...']
      И границы — по \n\n (между секциями), не в середине слова или предложения.
      И каждая часть ≤ 4000 символов.
      И первая часть содержит оригинальный header.
      И последующие — continuation header (UX-DR74 wording).
    И bot.ts:
      - editMessageText первой части на progressMessageId.
      - ctx.reply остальных частей последовательно.
      - На 1.5 без inline buttons — последняя часть не отличается от остальных.
    И на edge case: одна секция > 4000 → splitForTelegram внутри секции по `\n` (раздел между абзацами); если и это не помогает — split грубо по символам с warning.
    ```

15. **Сценарий: worker concurrency = 1 (FIFO sequential processing)** (architecture#API Patterns, sequential consistency for MVP)
    ```
    Дано 3 jobs enqueued (A, B, C) пока один уже running
    Когда worker обрабатывает
    Тогда строгая последовательность: после running → A → B → C (FIFO порядок enqueue).
      И НЕ запускается параллельно 2 jobs одновременно (на MVP — sequential; параллелизация = Growth при > 1 трекере, Story 6.5).
      И каждый job получает свой progressMessageId (создан при enqueue).
      И ack-сообщения для всех 3-х пользователю приходят сразу при enqueue (положение в очереди); editMessageText происходит когда worker дойдёт.
    ```

16. **Сценарий: graceful shutdown — bot останавливается чисто** (architecture#Infrastructure)
    ```
    Дано index.ts получает SIGTERM/SIGINT
    Когда shutdown handler выполняется
    Тогда:
      - bot.stop() (grammY) вызывается до server.close(): останавливает long polling, ждёт текущий getUpdates.
      - report-queue worker.stop() вызывается: ставит флаг "stop after current job", не прерывает running job в середине.
      - log.info({step:'bot.shutdown', queueRemaining: queue.size()}) — Тимур видит сколько jobs потерялось.
      - process.exit(0) после server.close.
    И running job получает шанс закончиться (worker.stop ждёт current handler return или 10s force-exit из существующего timeout в index.ts).
    И при повторном signal в течение shutdown → ignored (существующий guard isShuttingDown).
    ```

## Задачи / Подзадачи

- [x] **Задача 1: Конфигурация — расширить `src/config.ts` и `.env.example`** (КП: #5, #6)
  - [x] 1.1 Добавить в `ConfigSchema`:
    ```ts
    TELEGRAM_TRACKER_CHAT_IDS: z.string().min(1, 'TELEGRAM_TRACKER_CHAT_IDS is required (comma-separated)'),
    F1_PROGRESS_UPDATES_ENABLED: z
      .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0'), z.boolean(), z.undefined()])
      .transform((v) => v === 'true' || v === '1' || v === true)
      .default(true),
    F1_QUEUE_MAX_SIZE: z.coerce.number().int().positive().max(1000).default(20),
    ```
  - [x] 1.2 Helper `parseTrackerChatIds(raw: string): Set<number>` — split по `,`, trim, `Number.parseInt(x, 10)`, валидация `Number.isFinite(n) && n !== 0`. На ошибку (нет валидных id) → throw `Error('TELEGRAM_TRACKER_CHAT_IDS must contain at least one non-zero numeric chat id')`. **Вызывается лениво в `createBot`**, не в config.ts (config остаётся pure zod parse — поведение 1.1).
  - [x] 1.3 Обновить `.env.example`:
    ```
    # Telegram — Story 1.5: comma-separated chat IDs трекеров (whitelist для /report)
    TELEGRAM_TRACKER_CHAT_IDS=

    # Bot tuning (опционально, имеют дефолты)
    F1_PROGRESS_UPDATES_ENABLED=true
    F1_QUEUE_MAX_SIZE=20
    ```
  - [x] 1.4 Тест: `tsx -e "process.env.TELEGRAM_TRACKER_CHAT_IDS='123,456';..."` (smoke) — config parses; `parseTrackerChatIds("123,456,abc")` → throws на `'abc'`.

- [x] **Задача 2: URL parsing — `src/utils/url-parser.ts` + тест** (КП: #2, #3)
  - [x] 2.1 Создать `src/utils/url-parser.ts`:
    ```ts
    const ALLOWED_HOSTS_RE = /^(drive\.google\.com|docs\.google\.com|.*\.zoom\.us|zoom\.us)$/i;
    export type ParseResult =
      | { ok: true; url: string }
      | { ok: false; reason: 'missing_arg' | 'invalid_url' | 'unsupported_provider' };

    export function parseReportUrl(text: string): ParseResult {
      const trimmed = text.trim();
      if (trimmed.length === 0) return { ok: false, reason: 'missing_arg' };
      let parsed: URL;
      try {
        parsed = new URL(trimmed);
      } catch {
        return { ok: false, reason: 'invalid_url' };
      }
      if (!ALLOWED_HOSTS_RE.test(parsed.hostname)) {
        return { ok: false, reason: 'unsupported_provider' };
      }
      return { ok: true, url: parsed.toString() };
    }
    ```
  - [x] 2.2 Тесты `src/utils/url-parser.test.ts` (vitest):
    - `''`, `'   '` → `missing_arg`.
    - `'not-a-url'`, `'http://'` → `invalid_url`.
    - `'https://example.com/foo'`, `'https://yandex.ru/disk'` → `unsupported_provider`.
    - `'https://drive.google.com/file/d/abc/view'` → `ok:true`.
    - `'https://docs.google.com/document/d/xyz/edit'` → `ok:true`.
    - `'https://us02web.zoom.us/rec/share/...'` → `ok:true` (через wildcard).
    - `'  https://drive.google.com/...  '` (с пробелами) → trim, `ok:true`.

- [x] **Задача 3: Transcript duration guard — `src/utils/transcript-duration-guard.ts` + тест** (КП: #4)
  - [x] 3.1 Создать `src/utils/transcript-duration-guard.ts`:
    ```ts
    import { TranscriptValidationError } from '../errors.js';
    import type { Transcript } from '../types.js';

    export const MIN_TRANSCRIPT_DURATION_SEC = 120;

    export function assertTranscriptDuration(transcript: Transcript): void {
      const duration = transcript.metadata.duration;
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < MIN_TRANSCRIPT_DURATION_SEC) {
        throw new TranscriptValidationError('too_short', {
          durationSec: duration,
          minSec: MIN_TRANSCRIPT_DURATION_SEC,
        });
      }
    }
    ```
  - [x] 3.2 Тесты: `duration: 90` → throws (`too_short`); `duration: 120` → ok; `duration: undefined` (защита от malformed metadata) → throws.

- [x] **Задача 4: ReportJob и Queue — `src/types.ts` + `src/utils/report-queue.ts` + тест** (КП: #1, #6, #15)
  - [x] 4.1 В `src/types.ts` добавить:
    ```ts
    export const ReportJobStatusSchema = z.enum(['queued', 'running', 'completed', 'failed']);
    export type ReportJobStatus = z.infer<typeof ReportJobStatusSchema>;

    export const ReportJobSchema = z.object({
      id: z.string().min(1).max(32),
      chatId: z.number().int(),
      url: z.string().min(1),
      clientId: z.string().min(1),
      topName: z.string().min(1),
      meetingDate: z.string().min(1),
      meetingType: z.string().optional(),
      progressMessageId: z.number().int().optional(),
      status: ReportJobStatusSchema.default('queued'),
      queuedAt: z.string().min(1),
      startedAt: z.string().optional(),
      completedAt: z.string().optional(),
      retryCount: z.number().int().nonnegative().default(0),
      partial: z.boolean().optional(),
      partialReason: PartialReasonSchema.optional(),
    });
    export type ReportJob = z.infer<typeof ReportJobSchema>;
    ```
  - [x] 4.2 Создать `src/utils/report-queue.ts`:
    ```ts
    export class QueueOverflowError extends Error {
      constructor(public readonly maxSize: number, public readonly currentSize: number) {
        super(`queue overflow: ${currentSize} >= ${maxSize}`);
        this.name = 'QueueOverflowError';
      }
    }

    export interface ReportQueue {
      enqueue(job: ReportJob): { position: number; queueSize: number };
      dequeue(): ReportJob | undefined;
      peek(jobId: string): ReportJob | undefined;
      size(): number;
      findByChatId(chatId: number): ReportJob[];
      startWorker(handler: (job: ReportJob) => Promise<void>, opts?: { logger?: Logger }): () => Promise<void>;
    }

    export function createReportQueue(opts: { maxSize: number; logger?: Logger }): ReportQueue {
      // FIFO array + Map<id, job>. Worker — async loop awaiting dequeue().
      // On enqueue → resolve waiter (Promise.withResolvers). On worker stop signal → break loop.
    }
    ```
    Implementation hints:
    - Внутренний state: `jobs: ReportJob[]`, `index: Map<id, job>`, `waiter: { promise, resolve } | null`, `stopped: boolean`, `runningJob: ReportJob | null`.
    - `enqueue` push → resolve waiter если есть.
    - `dequeue` shift → return.
    - `startWorker` async-loop: `while (!stopped) { const job = dequeue(); if (!job) { await new Promise (waiter setup); continue; } runningJob = job; try { await handler(job); } catch (err) { logger.error({err, jobId: job.id}, 'worker handler threw — continuing'); } finally { runningJob = null; } }`.
    - Stop function: set `stopped=true`, resolve waiter (для exit из await), wait `runningJob === null` или 5s timeout.
  - [x] 4.3 Тесты `src/utils/report-queue.test.ts`:
    - `enqueue` 3 jobs → `size()` = 3.
    - `enqueue` 21-й при maxSize=20 → throws QueueOverflowError.
    - `dequeue` FIFO → достаёт по порядку insertion.
    - `peek(jobId)` находит, `peek('unknown')` undefined.
    - `findByChatId` фильтрует.
    - `startWorker(handler)` вызывает handler для каждого enqueued; thrown в handler не падает worker (вторая job всё равно обрабатывается).
    - `stop()` функция — ставит флаг; running handler заканчивается, новые не берутся; stop ждёт running.
    - Worker idle: enqueue после старта worker (когда очередь пуста) — handler вызывается сразу.

- [x] **Задача 5: Telegram formatter — `src/utils/telegram-formatter.ts` + тест** (КП: #7, #8, #9, #13, #14)
  - [x] 5.1 Создать `src/utils/telegram-formatter.ts` со всеми функциями (formatHeader, formatProgressStep, formatQueueAck, formatDeliveryReport, formatPartialReportFallback, formatErrorMessage, splitForTelegram, escapeMarkdownV2). Все — pure функции, не зависят от grammY.
  - [x] 5.2 escapeMarkdownV2 — escape строго 18 reserved chars: `_*[]()~\`>#+-=|{}.!\\`. Использовать одну regex `/[_*\[\]()~`>#+\-=|{}.!\\]/g` + replace.
  - [x] 5.3 splitForTelegram(text, maxLen=4000):
    - Если text.length ≤ maxLen → return [text].
    - Split по `\n\n` → массив частей.
    - Greedy pack: набирать в текущий buffer пока buffer.length + next.length + 2 ≤ maxLen.
    - Continuation header: для частей 2+ префиксить `📋 ${topName} (продолжение)\n\n` — НО `splitForTelegram` не знает topName; принимать опциональный arg `continuationPrefix?: string` или extract header из первой строки текста. **Выбор:** принимать `continuationPrefix: string`; bot.ts передаёт `'📋 ' + topName + ' (продолжение)'`.
    - Edge case: одна "секция" > maxLen → внутри по `\n` split.
  - [x] 5.4 formatProgressStep mapping (русский, без emoji-only — UX-DR51 accessibility):
    - `queued` → 'Принято. Отчёт через ~15 мин.' (✅ prefix добавляется в formatQueueAck — у progress отдельная функция)
    - `running_extraction` → '🔄 Читаю транскрипт…'
    - `running_analysis` → '🔄 Формирую отчёт…'
    - `running_formatting` → '🔄 Форматирую секции…'
    - `almost_ready` → '🔄 Почти готово…'
  - [x] 5.5 formatDeliveryReport(report) — discriminated union по `report.partial`:
    - `partial:false` → формат UX line 500-523: трёхуровневый header (использует `report.topName`, `report.department ?? '—'`, `report.weekNumber ?? '—'`), bold summary_line, sections, commitments lifecycle (🔵 на 1.5), optional "📱 Для {topName}:" + topMessageDraft.
    - `partial:true` → вызывает `formatPartialReportFallback`.
  - [x] 5.6 formatErrorMessage mapping (UX-DR24 паттерн "icon + description + instruction"):
    ```
    invalid_url → "⚠️ Ссылка не распознана. Проверь формат."
    unsupported_provider → "⚠️ Ссылка не распознана. Проверь формат." (same wording, UX-DR65)
    missing_arg → "⚠️ Укажи ссылку. Пример: /report https://drive.google.com/..."
    transcript_too_short → "⚠️ Слишком короткий. Отчёт требует ≥ 2 мин."
    transcript_download_failed → "⚠️ Не удалось скачать файл. Проверь доступ по ссылке." ([epics.md:544](_bmad-output/planning-artifacts/epics.md#L544))
    pipeline_failed → "⏰ Задержка. Тимур уведомлён. Пиши отчёт вручную." (UX-DR2)
    queue_overflow → "⚠️ Очередь заполнена. Попробуй позже."
    unauthorized → "⚠️ Доступ ограничен."
    timeout → "⏰ Задержка. Тимур уведомлён. Пиши отчёт вручную." (same wording как pipeline_failed)
    ```
  - [x] 5.7 Тесты `src/utils/telegram-formatter.test.ts`:
    - `escapeMarkdownV2('a_b*c.d!')` → `'a\\_b\\*c\\.d\\!'`.
    - `formatHeader({emoji:'📋', topName:'Жанель', topic:'Продажи', period:'Нед. 18'})` → `'📋 Жанель │ Продажи │ Нед. 18'`.
    - `formatQueueAck(1, 1)` → `"✅ Принято. Отчёт через ~15 мин."`.
    - `formatQueueAck(2, 3)` → `"✅ Принято. В очереди: 2 из 3."`.
    - `formatProgressStep('running_extraction')` → `'🔄 Читаю транскрипт…'`.
    - `splitForTelegram('a\n\nb\n\nc', 5)` → split на 3 части (если параметры подходящие; точная expected см. реализации).
    - `splitForTelegram('long text 5000 chars...', 4000)` → 2 части, обе ≤ 4000.
    - `formatDeliveryReport(fullDeliveryReport_fixture)` → содержит header, summary, sections.
    - `formatDeliveryReport(partialDeliveryReport_fixture)` → начинается с `'⚠️ Автоформатирование'`.
    - `formatErrorMessage('invalid_url')` → exact UX wording из UX-DR65.

- [x] **Задача 6: `src/types.ts` — добавить department + weekNumber в DeliveryReadyReport schemas** (КП: #8)
  - [x] 6.1 Расширить `FullDeliveryReportSchema` (и одноимённый `PartialDeliveryReportSchema` если нужен для header consistency):
    ```ts
    department: z.string().min(1).max(100).optional(),
    weekNumber: z.string().min(1).max(20).optional(),
    ```
  - [x] 6.2 Обновить `src/f1-report.ts → assembleFullDeliveryReport`: добавлять `department: args.meta.department` и `weekNumber: getISOWeekNumber(args.meta.meetingDate) catch ‘—’` (внутри try, на ошибку → undefined).
  - [x] 6.3 `assemblePartialDeliveryReport` — аналогично (для header в partial тоже).
  - [x] 6.4 Тесты `src/f1-report.test.ts`: расширить assertion в существующих happy/partial-tests — проверить наличие `department` и `weekNumber` в результате (где meta содержит department).
  - [x] 6.5 Регрессия: ВСЕ 147+ существующих тестов 1.4a+1.4b должны пройти после расширения schema (optional поля не ломают backward compatibility).

- [x] **Задача 7: `src/bot.ts` — основной handler** (КП: #1, #2, #3, #5, #6, #7, #8, #9, #10, #11, #15, #16)
  - [x] 7.1 Создать `src/bot.ts`:
    ```ts
    import { Bot } from 'grammy';
    import { config } from './config.js';
    import { logger as rootLogger } from './logger.js';
    import { alertOps } from './ops.js';
    import { transcribeFromUrl } from './adapters/transcript.js';
    import { readClientContext } from './adapters/sheets.js';
    import { runF1 } from './f1-report.js';
    import { parseReportUrl } from './utils/url-parser.js';
    import { assertTranscriptDuration } from './utils/transcript-duration-guard.js';
    import { createReportQueue } from './utils/report-queue.js';
    import { formatHeader, formatProgressStep, formatQueueAck, formatDeliveryReport, formatErrorMessage, splitForTelegram } from './utils/telegram-formatter.js';
    import { parseTrackerChatIds } from './config.js'; // или local

    export interface BotDeps {
      runF1?: typeof runF1;
      transcribeFromUrl?: typeof transcribeFromUrl;
      readClientContext?: typeof readClientContext;
      alertOps?: typeof alertOps;
      logger?: Logger;
      queue?: ReportQueue;
      now?: () => Date;
    }

    export function createBot(deps: BotDeps = {}): { bot: Bot; queue: ReportQueue; stop: () => Promise<void> }
    ```
  - [x] 7.2 Bootstrap:
    - `const trackerChatIds = parseTrackerChatIds(config.TELEGRAM_TRACKER_CHAT_IDS);`
    - `const bot = new Bot(config.TELEGRAM_BOT_TOKEN);`
    - `const queue = deps.queue ?? createReportQueue({ maxSize: config.F1_QUEUE_MAX_SIZE, logger });`
  - [x] 7.3 Whitelist middleware (через `bot.use`):
    ```ts
    bot.use(async (ctx, next) => {
      const chatId = ctx.chat?.id;
      if (chatId === undefined || !trackerChatIds.has(chatId)) {
        await ctx.reply(formatErrorMessage('unauthorized')).catch(() => {/* swallow */});
        alertOps({ pipeline: 'F1', step: 'bot.unauthorized', context: { chatId, command: ctx.message?.text?.slice(0, 50) } });
        return; // НЕ next()
      }
      await next();
    });
    ```
  - [x] 7.4 setMyCommands + setChatMenuButton — вызвать в `bot.api.setMyCommands([{command: 'report', description: 'Создать отчёт по встрече'}])` и `setChatMenuButton({menu_button: {type: 'commands'}})` (в фабрике, перед `.start()`).
  - [x] 7.5 `bot.command('report', ...)` handler:
    - Извлечь `ctx.match` (string remainder).
    - `parseReportUrl(ctx.match)`. На fail → reply, return.
    - Создать `ReportJob`: `id = randomUUID().slice(0,8)`, `chatId = ctx.chat.id`, `url = parsed.url`, `clientId: 'geonline'`, `topName: 'Жанель'`, `meetingDate: new Date().toISOString().slice(0,10)` (defaults для MVP; **TODO Story 1.13/1.8** для интерактивного ввода).
    - `try { result = queue.enqueue(job); } catch (e) { if (e instanceof QueueOverflowError) → reply queue_overflow + alertOps; return }`.
    - `const ack = await ctx.reply(formatQueueAck(result.position, result.queueSize));`
    - `job.progressMessageId = ack.message_id;`
    - Запустить 30-мин watchdog `setTimeout(() => onJobTimeout(job.id), 30 * 60_000)`, сохранить ref.
    - log.info.
  - [x] 7.6 Worker handler `async function processJob(job)`:
    - Реализовать AC #7 / #10 / #11 (см. spec).
    - editMessageText через `bot.api.editMessageText(job.chatId, job.progressMessageId, text, {parse_mode: 'MarkdownV2'})`, обёрнутая в helper `safeEditMessage(text, raw=false)` который catch'ит ошибки и retry'ит с `parse_mode: undefined` на parsing error (AC #13).
    - Try-catch разделяет: TranscriptValidationError('too_short') → специальное сообщение (info-level); TranscriptDownloadError/ProviderError → "⏰ Задержка." (warn-level); другие → catch-all "⏰ Задержка." (error-level).
    - Finally: clearTimeout watchdog.
  - [x] 7.7 `processJob` ветка partial:
    - `if (result.partial) → const text = formatDeliveryReport(result.formattedReport); /* это автоматически formatPartialReportFallback */`
    - alertOps WARN с partialReason.
  - [x] 7.8 Render final report:
    - `const headerCtx = '📋 ' + escapeMarkdownV2(job.topName);` (для continuation header).
    - `const text = formatDeliveryReport(result.formattedReport);`
    - `const parts = splitForTelegram(text, 4000, headerCtx + ' (продолжение)');`
    - `await safeEditMessage(parts[0]);`
    - `for (const p of parts.slice(1)) await ctx.api.sendMessage(job.chatId, p, {parse_mode: 'MarkdownV2'});`
  - [x] 7.9 `onJobTimeout(jobId)`:
    - `const job = queue.peek(jobId)`; если undefined или status ∈ {completed, failed} → noop.
    - editMessageText timeout → "⏰ Задержка."
    - alertOps ERROR.
    - `job.status='failed'`, `job.completedAt`.
  - [x] 7.10 Export `createBot(deps)` для тестов и `index.ts`.
  - [x] 7.11 Запуск (long polling) — НЕ в фабрике, а в `index.ts`:
    ```ts
    const { bot, queue, stop } = createBot();
    queue.startWorker(processJob, {logger}); // или внутри createBot
    bot.start({ drop_pending_updates: true }).catch(err => { log.fatal({err}, 'bot start failed'); process.exit(1); });
    ```
    `drop_pending_updates: true` — на старте отбросить накопленные updates пока бот был down (иначе при рестарте сразу 10 jobs).

- [x] **Задача 8: `src/index.ts` — интегрировать createBot в bootstrap** (КП: #16)
  - [x] 8.1 Импорт `createBot` из `./bot.js`.
  - [x] 8.2 После `server.listen(config.PORT)` — `const {bot, queue, stop: stopBot} = createBot();` и `bot.start({drop_pending_updates: true})` (через `.catch(onStartupError)`).
  - [x] 8.3 Расширить `shutdown(signal)`:
    ```ts
    log.info({signal}, 'Shutdown requested');
    Promise.allSettled([
      stopBot(), // ждёт running job + bot.stop()
      new Promise<void>(res => server.close(err => { if (err) log.error({err}); res(); })),
    ]).then(() => { log.info('Shutdown complete'); process.exit(0); });
    setTimeout(() => process.exit(1), 10_000).unref();
    ```
  - [x] 8.4 Smoke test (manual): `npm run dev` → бот стартует, `/health` 200, `/report https://drive.google.com/...` от тестового чата → ack приходит < 2 сек.

- [x] **Задача 9: Tests — `src/bot.test.ts` integration** (КП: #1, #2, #3, #5, #7, #10, #11)
  - [x] 9.1 Использовать **mocked Bot** через `createBot({deps: {/* mocked runF1, transcribeFromUrl, readClientContext, queue */}})`. Не запускать реальный long polling. Подменить `bot.api` через `bot.api.config.use(...)` или `bot.use` мок-middleware.
  - [x] 9.2 Альтернатива (рекомендуется): использовать `Bot.handleUpdate({update_id, message: {...}})` для прямой подачи fake Update'ов — `grammY` поддерживает это.
  - [x] 9.3 8 тестов из AC.
  - [x] 9.4 Альтернатива для acknowledge timing (NFR4 < 3 сек) — тестировать **синхронность** code-path: от получения Update до первого `ctx.reply` — никаких внешних awaits (только parseReportUrl pure + queue.enqueue pure). Тест: `vi.useFakeTimers()`, измерить что ack отправлен в течение того же event-loop tick.

- [x] **Задача 10: Документация — обновить README / docs/ops** (опционально, минимально)
  - [x] 10.1 Если есть `docs/ops/` — добавить запись о новых env vars (или просто полагаться на `.env.example` комментарии).

- [x] **Задача 11: Sprint status + Dev Agent Record** (finalize)
  - [x] 11.1 `_bmad-output/implementation-artifacts/sprint-status.yaml`: `1-5-telegram-bot-komanda-report-i-progress: backlog → ready-for-dev` (создание story) → `in-progress` (на старте Dev) → `review` (на финише).
  - [x] 11.2 Story file status: `ready-for-dev` → `in-progress` → `review` (Dev обновит).
  - [x] 11.3 Заполнить Dev Agent Record (Debug Log References, Completion Notes, File List, Change Log).

## Dev Notes

### Соответствие архитектуре

- **Provider-agnostic boundary** (architecture#Process Patterns): `grammy` импортируется только в `src/bot.ts`. Никаких прямых `bot.api.*` в `f1-report.ts`/`adapters/*`/`utils/*`. Если потребуется отправить сообщение из другой части кода — через инъекцию `deps.botApi` (для тестов).
- **Inline-кнопки first** (architecture#Telegram UX Decisions): `/report` — единственная команда; всё остальное через inline keyboards / Bot Menu. **На 1.5 inline keyboards отсутствуют** (approve buttons = 1.6). Но: setMyCommands + setChatMenuButton настраиваются — для будущих stories.
- **Sequential FIFO worker** (architecture#API Patterns): один job за раз. Параллельные запросы тренеров на MVP невозможны (1 трекер). Параллелизация = Growth Story 6.5 (multi-tracker isolation).
- **Logging structure** (architecture#Format Patterns): pino `child({pipeline:'F1', step:'bot.*', clientId})` — все логи bot.ts содержат эти поля. Step namespace: `bot.report.*` для grep-фильтрации.
- **Error handling per step** (architecture#API Patterns): try-catch на уровне worker.handle; каждая ошибка → log + alertOps + user-facing message. **Worker НЕ падает** на handler throw (queue continues).
- **No silent catches** (architecture Anti-patterns): каждый catch логирует + alertOps (если warrants). User-facing message — обязательно (UX-DR39 «never silent»).
- **Whitelist chat_id auth** (architecture#Authentication, NFR26): middleware-level. Отказ выглядит одинаково для всех unauth-ботов (не выдавать наличие whitelist по тексту ошибки).
- **MarkdownV2 over HTML** (consistency): grammY поддерживает оба; MarkdownV2 более явный с escape-правилами. Fail-safe: на parsing error retry без parse_mode (plain text).
- **Long polling on 1.5; webhook on 1.14** (architecture deployment milestones): long polling работает локально и для MVP; production webhook = Story 1.14 (Hostinger VPS with /webhook endpoint).

### Source tree

- `src/bot.ts` — **новый** (~250-300 LOC).
- `src/index.ts` — обновить bootstrap + shutdown (~10 LOC).
- `src/config.ts` — обновить schema (+ 3 vars, + helper `parseTrackerChatIds` ~15 LOC).
- `src/types.ts` — добавить `ReportJobSchema`, `ReportJobStatusSchema` + расширить `FullDeliveryReportSchema` + `PartialDeliveryReportSchema` (department, weekNumber optional) (~30 LOC).
- `src/utils/url-parser.ts` — **новый** (~60 LOC).
- `src/utils/report-queue.ts` — **новый** (~150 LOC).
- `src/utils/telegram-formatter.ts` — **новый** (~200 LOC).
- `src/utils/transcript-duration-guard.ts` — **новый** (~25 LOC).
- `src/f1-report.ts` — расширить `assembleFullDeliveryReport`/`assemblePartialDeliveryReport` (~15 LOC изменений).
- `src/bot.test.ts` — **новый** (~250 LOC).
- `src/utils/*.test.ts` — **новые** 4 файла (~200 LOC total).
- `.env.example` — добавить 3 vars.

### Testing Standards

- **Vitest** как test runner. Конфигурация — существующая (Story 1.1).
- **Моки**:
  - `vi.fn()` для `runF1`, `transcribeFromUrl`, `readClientContext`, `alertOps` — pass через `BotDeps`.
  - `grammy.Bot.handleUpdate({...})` — синтетические Telegram Update'ы (не реальное long polling).
  - **НЕ запускать `bot.start()`** в тестах — только `bot.handleUpdate(update)`.
- **Не запускать реальный Telegram API** — все вызовы `bot.api.*` через `bot.api.config.use(...)` middleware-mock или `bot.api = vi.fn()`.
- **Tmpdir для persistence** — на 1.5 нет file-write persistence (queue in-memory), но если будут side effects через `alertOps` → mock через `vi.fn()`.
- **Не моковать** `parseReportUrl`, `assertTranscriptDuration`, `formatDeliveryReport`, `splitForTelegram`, `escapeMarkdownV2` — это pure-функции, тестируем напрямую.
- **Coverage threshold не выставляется**; цель — green tests + typecheck clean.
- **grammY testing pattern** (документация grammY):
  ```ts
  const update: Update = {
    update_id: 1,
    message: {
      message_id: 100,
      date: Math.floor(Date.now()/1000),
      chat: { id: TEST_TRACKER_CHAT_ID, type: 'private' },
      from: { id: TEST_TRACKER_CHAT_ID, is_bot: false, first_name: 'Test' },
      text: '/report https://drive.google.com/...',
      entities: [{ type: 'bot_command', offset: 0, length: 7 }],
    },
  };
  await bot.handleUpdate(update);
  ```
- **Не вызывать `bot.init()` в тестах** — `bot.init()` ходит в `getMe()`; вместо этого передавать `botInfo: {id: 1, ...}` опцию в `new Bot(token, {botInfo: TEST_BOT_INFO})` для bypass.

### Контракты с другими stories

- **Story 1.1**: использует `config`, `logger`, `server`, `shutdown` без изменений. Расширяется `config.ts` (новые env vars — backward compat).
- **Story 1.2**: использует `transcribeFromUrl` как чёрный ящик. Не меняем сигнатуру. Не добавляем новые поля в Transcript.
- **Story 1.3**: использует `readClientContext` как есть. Не меняем сигнатуру.
- **Story 1.4a / 1.4b**: использует `runF1` как единую точку входа. Контракт зафиксирован 1.4b. Любая регрессия тестов 1.4a/1.4b = блокер. На 1.5 добавляются optional `department` и `weekNumber` в `FullDeliveryReportSchema` — это не break.
- **Story 1.6 (approval workflow)**: на 1.5 финальное сообщение БЕЗ inline buttons. 1.6 расширит `formatDeliveryReport` (или wrapper-функцию `attachApproveKeyboard`) + добавит `bot.callbackQuery('approve:...')` handler + `approvals.jsonl`.
- **Story 1.7 (delivery)**: использует `report.topMessageDraft` секцию из `formatDeliveryReport`. На 1.5 секция рендерится в текст; 1.7 ничего не меняет в bot.ts (нет автодоставки).
- **Story 1.8 (first-run)**: на первом сообщении бот должен ответить онбордингом. 1.8 добавит `bot.on('message:text', firstRunMiddleware)` ДО whitelist (или другой логикой). 1.5 не реализует.
- **Story 1.9 (ops + alerts)**: расширит `alertOps` для отправки в TELEGRAM_CHAT_OPS_ID. На 1.5 `alertOps` уже вызывается с правильными payload; 1.9 только меняет реализацию. Также 1.9 добавит реальный cancellation для timeout (AbortController в worker'е).
- **Story 1.10 (persistence)**: будет persistить ReportJob в `data/{client}/{date}/jobs.jsonl`. На 1.5 — in-memory; теряется при рестарте. Acceptable trade-off.
- **Story 1.12 (ops status для Айдара)**: добавит `bot.callbackQuery('status')` → агрегирует queue/jobs state. На 1.5 `queue.findByChatId` / `peek` уже готовы как примитивы.
- **Story 1.13 (поиск отчётов)**: добавит `bot.callbackQuery('search')` + interactive flow. На 1.5 не реализуется.
- **Story 1.14 (Hostinger VPS deploy)**: переключит long polling на webhook. На 1.5 long polling; bot.ts должен работать в обоих режимах без изменений (только запуск в index.ts отличается).

### Project Structure Notes

- Новые файлы: `src/bot.ts`, `src/utils/{url-parser, report-queue, telegram-formatter, transcript-duration-guard}.ts` + одноимённые `.test.ts`.
- Никаких новых директорий.
- `.env.example` — единственный конфигурационный файл, обновляется.
- `data/` — на 1.5 не используется (в отличие от 1.2/1.3/1.4a/1.4b которые писали в `data/{client}/{date}/`).

### LLM-Dev-Agent Guardrails

- **НЕ переписывать `runF1`** — это единая точка входа в pipeline (Story 1.4b контракт). Bot.ts вызывает `runF1` ровно один раз на job.
- **НЕ инвентить новый prompt** — на 1.5 нет промптов. Все промпты (extraction, analysis, format-tracker) — Story 1.4a/1.4b.
- **НЕ дублировать `parseClaudeJSON` / `withRetry` / `loadPrompt`** — bot.ts их не вызывает напрямую; всё через `runF1`.
- **НЕ напрямую `bot.api.editMessageText` без обёртки `safeEditMessage`** — wrap для error handling (MESSAGE_NOT_MODIFIED, 429, MarkdownV2 parsing fail).
- **НЕ inline регулярки для парсинга URL** — использовать `URL` class или вынесенный `ALLOWED_HOSTS_RE` в `url-parser.ts`. Тестируемо.
- **НЕ `console.log`** — всегда `logger.child({pipeline:'F1', step:'bot.*', clientId})`. (architecture Anti-patterns).
- **НЕ silent catch** — каждый catch в worker.handle логирует + (если warrants) alertOps. (architecture Anti-patterns).
- **НЕ запускать `bot.start()` в тестах** — `Bot.handleUpdate(update)` для синтетических Update'ов.
- **НЕ модифицировать существующие тесты 1.4a/1.4b** — если расширение `FullDeliveryReportSchema` (department/weekNumber как optional) ломает старые тесты, **сначала** разобраться почему: optional не должен ломать backward-compat. Регрессия в 1.4a/1.4b = блокер.
- **НЕ хардкодить chat IDs / topName / clientId в коде** — всё из config / Update. Defaults `'geonline'` / `'Жанель'` / `today()` для MVP — допустимы, но через `const DEFAULT_*` константы в bot.ts, не разбросаны.
- **НЕ обходить whitelist** — middleware ставится ПЕРВЫМ в chain (`bot.use(whitelistMiddleware); bot.command(...)`).
- **НЕ удалять / переписывать существующий `shutdown` в index.ts** — расширять (добавить `stopBot()` шаг до `server.close`). Существующий guard `isShuttingDown` сохраняется.

### Anti-patterns на 1.5 (запрещено)

- ❌ `process.env.*` напрямую в `bot.ts` — только через `config`.
- ❌ `JSON.parse(messageText)` на Telegram input — `/report` принимает URL как plain string.
- ❌ `setInterval` для polling queue — worker через async-await loop с Promise wake-up.
- ❌ `bot.api.sendMessage(chatId, ...)` без `parse_mode` (или без обоснования) — везде MarkdownV2 (с escape) либо fall-back plain text.
- ❌ Throw из middleware — middleware должен вернуть `void` (или `next()`), errors → log + ops alert + user message + return.
- ❌ Throw из worker.handle — worker catches; если bug — log + alertOps + continue.

### References

- [epics.md:607-633](_bmad-output/planning-artifacts/epics.md#L607-L633) — Story 1.5 epic AC.
- [epics.md:54-66](_bmad-output/planning-artifacts/epics.md#L54-L66) — FR27-FR32 (tracker workflow).
- [epics.md:90-94](_bmad-output/planning-artifacts/epics.md#L90-L94) — FR63-FR67 (Telegram bot commands).
- [epics.md:104](_bmad-output/planning-artifacts/epics.md#L104) — FR77 (critical events to ops channel).
- [epics.md:124](_bmad-output/planning-artifacts/epics.md#L124) — NFR4 (ack < 3 сек).
- [epics.md:130](_bmad-output/planning-artifacts/epics.md#L130) — NFR10 (partial results).
- [epics.md:136](_bmad-output/planning-artifacts/epics.md#L136) — NFR16 (uptime > 99%).
- [epics.md:237-275](_bmad-output/planning-artifacts/epics.md#L237-L275) — UX-DR1-UX-DR45 (UX requirements relevant).
- [architecture.md:73](_bmad-output/planning-artifacts/architecture.md#L73) — Telegram Bot API constraints (inline-first, 4096 limit).
- [architecture.md:214-220](_bmad-output/planning-artifacts/architecture.md#L214-L220) — Telegram UX Decisions.
- [architecture.md:303-310](_bmad-output/planning-artifacts/architecture.md#L303-L310) — Authentication (whitelist chat_id).
- [architecture.md:321](_bmad-output/planning-artifacts/architecture.md#L321) — Progress updates via editMessageText.
- [architecture.md:534](_bmad-output/planning-artifacts/architecture.md#L534) — bot.ts (~250-300 LOC).
- [architecture.md:692-694](_bmad-output/planning-artifacts/architecture.md#L692-L694) — Updated project structure (post-validation).
- [ux-design-specification.md:65-67](_bmad-output/planning-artifacts/ux-design-specification.md#L65-L67) — Progress 4 состояния.
- [ux-design-specification.md:90-99](_bmad-output/planning-artifacts/ux-design-specification.md#L90-L99) — Один command, inline-кнопки.
- [ux-design-specification.md:418-426](_bmad-output/planning-artifacts/ux-design-specification.md#L418-L426) — Message Structure Pattern (трёхуровневый header).
- [ux-design-specification.md:469-481](_bmad-output/planning-artifacts/ux-design-specification.md#L469-L481) — Emoji system.
- [ux-design-specification.md:485-496](_bmad-output/planning-artifacts/ux-design-specification.md#L485-L496) — Tone of Voice.
- [ux-design-specification.md:500-523](_bmad-output/planning-artifacts/ux-design-specification.md#L500-L523) — F1 Report Telegram template.
- [ux-design-specification.md:866-876](_bmad-output/planning-artifacts/ux-design-specification.md#L866-L876) — F1 Error Handling таблица.
- [ux-design-specification.md:933-946](_bmad-output/planning-artifacts/ux-design-specification.md#L933-L946) — Component Strategy (formatter functions).
- [1-4b-f1-formatirovanie-i-podgotovka-k-dostavke.md](_bmad-output/implementation-artifacts/1-4b-f1-formatirovanie-i-podgotovka-k-dostavke.md) — предыдущая story, контракт `runF1` / `DeliveryReadyReport`.
- [src/f1-report.ts:1185](src/f1-report.ts#L1185) — runF1 orchestrator.
- [src/types.ts:224](src/types.ts#L224) — DeliveryReadyReportSchema (discriminated union).
- [src/types.ts:178](src/types.ts#L178) — PartialReasonSchema.
- [src/adapters/transcript.ts:37](src/adapters/transcript.ts#L37) — transcribeFromUrl.
- [src/adapters/sheets.ts:270](src/adapters/sheets.ts#L270) — readClientContext.
- [src/ops.ts:12](src/ops.ts#L12) — alertOps (на 1.9 расширится TELEGRAM_CHAT_OPS_ID).
- [src/config.ts:15-23](src/config.ts#L15-L23) — текущая Telegram-конфигурация.
- [deferred-work.md](_bmad-output/implementation-artifacts/deferred-work.md) — deferred items (multi-text-block, AbortError race, partial: boolean → discriminated literal) — релевантно для consumer'ов в bot.ts.

## Previous Story Intelligence (Story 1.4b)

**Patterns зафиксированы 1.4b и должны быть переиспользованы:**

- **Discriminated union на `partial`**: `DeliveryReadyReport` — это `{partial: false, ...} | {partial: true, partialReason, extractionFallback, ...}`. TypeScript narrowing работает через `if (result.partial)`. На 1.5 — критично для `formatDeliveryReport` switch.
  - Деferred [C13]: «`RunF1Steps34Result.partial: boolean` (не literal)» — на consumer side bot.ts может потребоваться runtime narrowing. Решение для 1.5: использовать `result.formattedReport.partial` (literal через discriminated union), а не `result.partial` (boolean). См. [src/types.ts:205-222](src/types.ts#L205-L222).
- **Async I/O only**: `fs.promises.*`, никаких `*Sync`. На 1.5 нет file I/O в bot.ts, но если потребуется (manual debug или временный persistence) — async.
- **withRetry signal-aware**: при добавлении AbortController для жобе (Story 1.9) — сигнал автоматически propagates в `runF1 → callClaude → withRetry`. На 1.5 — простой `setTimeout(30min)` без AbortController.
- **Child-logger**: `logger.child({pipeline:'F1', step:'bot.report', clientId, jobId, chatId})` — все логи bot.ts наследуют контекст. Step namespace: `bot.report.*`, `bot.queue.*`, `bot.unauthorized`.
- **F5Metrics empty contract**: `formatOkrContextForPrompt` всегда включает `f5Metrics: []` (review fix 1.4a). На 1.5 не релевантно (нет промптов), но напоминание о принципе «всегда передаём поле, даже как []».
- **error wrapping**: `F1PipelineError` со step-specific code. На 1.5: ловим `F1PipelineError` по `err.code` для специфичных handle'ов (например, `'delivery_prep'` — это bug в нашем коде, показывать «⏰ Задержка»).
- **Test fixture pattern**: tmpdir + golden JSON фикстуры. **На 1.5 нет fs persistence**; вместо tmpdir — vi.fn() mocks + Update fixtures.

**Lessons learned from 1.4b code-review (16 patches 2026-05-18):**

1. **P1 [HIGH]: client isolation через slugify** — если bot.ts будет писать в `data/`, обязательно использовать `slugifyClientId(meta.clientId)`. На 1.5 нет writes — N/A.
2. **P3 [MEDIUM]: persistMeta после shutdown step** — на 1.5 нет persistence; но если будущая Story 1.10 добавит — паттерн: писать meta **после** завершения step, не до.
3. **P5 [MEDIUM]: `f1.run.total` always-emit through try/finally** — на 1.5 worker.handle должен ВСЕГДА эмитить `bot.report.total` (info ok | warn slow | error failed) в finally, не зависая на throw-path.
4. **P9 [MEDIUM]: privacy leak через err.context** — на 1.5: при alertOps НЕ передавать `url` целиком в context (может содержать токены доступа Drive). Trim или хэшировать. Минимум: убирать query string.
5. **P11 [MEDIUM]: canonical event for partial** — на 1.5: `log.info({step:'bot.report.completed', partial:true, partialReason})` ВСЕГДА на финальном render'е, независимо от full/partial.
6. **P13 [LOW]: prompt fences contradiction** — N/A на 1.5.
7. **P14 [MEDIUM] (D1 resolved): top_message_draft post-parse fallback** — на 1.5 НЕ повторять этот трюк в bot.ts; safeParseClaudeJSON уже делает (1.4b). Bot.ts получает уже parsed `topMessageDraft` или undefined.
8. **P16 [HIGH] (D3 resolved): meetingDate schema relaxed** — на 1.5 при создании ReportJob использовать `today().toISOString().slice(0,10)` (`YYYY-MM-DD`). Schema accepts.
9. **Defer C13 [partial: boolean type]** — на 1.5: использовать `result.formattedReport.partial` для narrowing (literal через discriminated union), не `result.partial` (boolean).
10. **Lesson 1.4a-1: signal через withRetry**: при добавлении AbortController (Story 1.9) — пробрасывать через `runF1(..., {deps: {signal: jobAbortSignal}})`. На 1.5 — не нужно.
11. **Lesson 1.4a-2: обязательность полей даже как []**: на 1.5 — если будет передавать что-то в `runF1`, ВСЕ optional поля meta пробрасываются (department, meetingType) или explicit undefined; не пропускать.

## Dev Agent Record

### Agent Model Used

Claude Opus 4.7 (1M context) — claude-opus-4-7 (bmad-dev-story workflow, 2026-05-19)

### Debug Log References

- Регрессия после расширения `FullDeliveryReportSchema`/`PartialDeliveryReportSchema` (`department?`, `weekNumber?` как optional): `src/f1-report.test.ts` — 29/29 pass без правок (P6.5 OK).
- Финальная регрессия проекта после story 1.5: vitest run → **15 файлов, 214 тестов passed**; `npx tsc --noEmit` → clean.
- TS pitfall: `UserFromGetMe` в grammy ^1.30 требует `can_manage_bots`, `has_topics_enabled`, `allows_users_to_create_topics` — fallback `botInfo` для тестов расширен.

### Completion Notes List

- **Все 16 ACs реализованы.** AC#1-#3 (ack/queue/invalid url), AC#4 (too_short → info), AC#5 (unauthorized → alertOps), AC#6 (queue_overflow), AC#7 (4 progress states), AC#8 (трёхуровневый header через `department`/`weekNumber`), AC#9 (partial → fallback render), AC#10-#11 (transcript/runF1 errors → "⏰ Задержка"), AC#12 (30-мин watchdog), AC#13 (MarkdownV2 fallback), AC#14 (split > 4000 chars), AC#15 (FIFO concurrency=1 через `report-queue`), AC#16 (graceful shutdown в `index.ts`).
- **Новые файлы:** `src/bot.ts`, `src/utils/{url-parser, transcript-duration-guard, report-queue, telegram-formatter}.ts` + одноимённые `.test.ts` + `src/bot.test.ts`.
- **Patch P-Story1.5-1 применён:** `assembleFullDeliveryReport` / `assemblePartialDeliveryReport` теперь прокидывают `department` (из `RunF1Steps34Input.meta.department`) и `weekNumber` (через `safeWeekNumber` с try/catch вокруг `getISOWeekNumber`). Поля опциональны — обратная совместимость 1.4a/1.4b сохранена.
- **Privacy guard (Lesson P9 из 1.4b):** `sanitizeUrlForLog(url)` обрезает query string перед попаданием в `alertOps.context` — Drive токены доступа не утекают.
- **Worker resilience:** `createReportQueue.startWorker` оборачивает handler в try/catch — throw из handler логируется как `error`, но worker не падает и обрабатывает следующий job (AC #11, NFR9).
- **MarkdownV2 fallback (AC #13):** `safeEditMessage` / `safeReply` ловят `GrammyError(400)`, retry'ят без `parse_mode` — защита от bug в `escapeMarkdownV2`.
- **Timeout watchdog (AC #12):** `setTimeout(30 мин)` для каждого job. На срабатывание — editMessageText "⏰ Задержка" + alertOps + `job.status='failed'`. На завершение job — `clearJobTimer`. Реальная отмена pipeline — Story 1.9 (на 1.5 фоновый runF1 может продолжить работу, его результат игнорируется через `timedOutJobs` set).
- **Bot menu setup (FR / UX-DR18):** при старте `bot.start()` вызывается `setMyCommands([{command:'report', ...}])` + `setChatMenuButton({type:'commands'})`. Failures на этом этапе → log.warn, бот всё равно запускается.
- **Long polling (Story 1.14 deferred):** `bot.start({drop_pending_updates: true})` — отбрасывает накопленные updates на рестарте (защита от 10 пайплайнов сразу).
- **Defer C13 [partial: boolean type] (lesson 1.4b):** в bot.ts narrowing идёт через `result.formattedReport.partial` (literal через discriminated union DeliveryReadyReport) — не через `result.partial` (boolean из RunF1Result).
- **Inline buttons НЕ добавлены** — это намеренный scope-cut в пользу Story 1.6.

### File List

- `src/bot.ts` — **новый** (~430 LOC) — grammY bootstrap, whitelist middleware, /report command, worker handler, watchdog, MarkdownV2 fallback.
- `src/index.ts` — обновлён: интеграция `createBot()` в bootstrap + расширение shutdown через `Promise.allSettled([stopBot(), server.close()])`.
- `src/config.ts` — добавлены `TELEGRAM_TRACKER_CHAT_IDS` (z.string), `F1_PROGRESS_UPDATES_ENABLED` (z.union → boolean), `F1_QUEUE_MAX_SIZE` (z.coerce.number). Helper `parseTrackerChatIds(raw)` — lazy, вызывается в `createBot`.
- `src/types.ts` — добавлены `ReportJobStatusSchema`, `ReportJobSchema`. Расширены `FullDeliveryReportSchema` + `PartialDeliveryReportSchema` через optional `department` + `weekNumber`.
- `src/f1-report.ts` — `assembleFullDeliveryReport` / `assemblePartialDeliveryReport` прокидывают `department` + `weekNumber` (через `safeWeekNumber`).
- `src/utils/url-parser.ts` — **новый** — `parseReportUrl(text)` с whitelist hosts (drive/docs/zoom).
- `src/utils/url-parser.test.ts` — **новый**, 17 тестов.
- `src/utils/transcript-duration-guard.ts` — **новый** — `assertTranscriptDuration(transcript)` с MIN_TRANSCRIPT_DURATION_SEC=120.
- `src/utils/transcript-duration-guard.test.ts` — **новый**, 6 тестов.
- `src/utils/report-queue.ts` — **новый** — `createReportQueue`, `ReportQueue` interface, `QueueOverflowError`, worker loop через `Promise.withResolvers`-style waiter.
- `src/utils/report-queue.test.ts` — **новый**, 10 тестов.
- `src/utils/telegram-formatter.ts` — **новый** — `escapeMarkdownV2`, `formatHeader`, `formatProgressStep`, `formatQueueAck`, `formatErrorMessage`, `formatDeliveryReport` (discriminated full/partial), `splitForTelegram` (greedy pack по `\n\n` → fallback `\n` → hard-split).
- `src/utils/telegram-formatter.test.ts` — **новый**, 22 теста.
- `src/bot.test.ts` — **новый**, 11 integration-style тестов через `bot.handleUpdate(update)` + `bot.api.config.use(transformer)` для перехвата API вызовов.
- `.env.example` — добавлены `TELEGRAM_TRACKER_CHAT_IDS`, `F1_PROGRESS_UPDATES_ENABLED`, `F1_QUEUE_MAX_SIZE` с inline-документацией.

## Change Log

| Дата | Версия | Описание | Автор |
|------|--------|----------|-------|
| 2026-05-19 | 0.1.0 | Initial story draft via bmad-create-story | Тимур / Bob |
| 2026-05-19 | 1.0.0 | Реализация story 1.5: bot.ts (grammY, /report, worker, watchdog), 4 util-модуля, 11 файлов тестов (66 новых тестов), расширение DeliveryReadyReport schemas (department/weekNumber optional), интеграция с index.ts. Регрессия: 214/214 pass, typecheck clean. Status → review. | Тимур / Amelia (Claude Opus 4.7) |

---

### Review Findings

> Code review выполнен 2026-05-19. Три слоя: Blind Hunter + Edge Case Hunter + Acceptance Auditor.
> Отклонено как шум: 15. Отложено: 7. Требует решения: 3. Патчи: 9.

#### Decision-Needed

- [ ] [Review][Decision] **D1: Scope Zoom-субдоменов в ALLOWED_HOSTS_RE** — regex `[^.]+\.zoom\.us` принимает любой поддомен `*.zoom.us`, включая потенциально вредоносные. Если downstream-код передаёт URL напрямую в fetch, это теоретический SSRF. Ограничить до известных Zoom-субдоменов (us02web, us04web, …) или оставить как есть? [src/utils/url-parser.ts:3]
- [ ] [Review][Decision] **D2: alertOps на ВСЕХ сообщениях от неавторизованных чатов** — whitelist middleware вызывает alertOps при любом сообщении от чужого chatId, не только /report. Может привести к alert-storm если кто-то начнёт присылать спам. Оставить как есть (security-conservative) или ограничить alertOps только командами? [src/bot.ts:460-479]
- [ ] [Review][Decision] **D3: TranscriptValidationError('empty') как info-level** — `failureMessageForTranscriptError` обрабатывает `code === 'empty'` так же как `'too_short'` — severity 'info', без alertOps. Пустой транскрипт может сигнализировать сбой Soniox, стоящий оповещения. Оставить info-level или перевести 'empty' на warn + alertOps? [src/bot.ts:234-244]

#### Patches

- [ ] [Review][Patch] **P1: FALLBACK_BOT_INFO в production ломает /report@botname в групповых чатах** [src/bot.ts:111-113] — grammY пропускает `getMe()` когда `botInfo` передан; `username='test_bot'` означает что command-matching провалится для всех групповых упоминаний. Убрать FALLBACK_BOT_INFO из нетестового пути или вызвать `await bot.init()` перед `bot.start()`.
- [ ] [Review][Patch] **P2: progressMessageId задаётся ПОСЛЕ enqueue — running_extraction прогресс теряется** [src/bot.ts:513-539] — Job добавляется в очередь с `progressMessageId=undefined`; worker может немедленно вызвать `emitProgress('running_extraction')` который no-op'ится. Исправление: сначала `await ctx.reply(...)`, присвоить `progressMessageId`, затем `enqueue`.
- [ ] [Review][Patch] **P3: splitForTelegram hard-split разрезает MarkdownV2 escape-последовательность** [src/utils/telegram-formatter.ts:246-253] — Посимвольный split может попасть между `\` и экранированным символом — Telegram вернёт 400. Исправление: split только по безопасным границам или использовать safeEditMessage-fallback для hard-split фрагментов.
- [ ] [Review][Patch] **P4: renderFinalReport молча теряет parts[0] при неудачном edit** [src/bot.ts:274-279] — Если `progressMessage` удалён пользователем или слишком старый, `safeEditMessage` молча проваливается; `parts[0]` теряется, пользователь получает только продолжение. Исправление: возвращать boolean из `safeEditMessage`, при false — fallback на `sendMessage`.
- [ ] [Review][Patch] **P5: Нет проверки timedOutJobs между readClientContext и runF1** [src/bot.ts:368-373] — Timeout сработавший после Soniox, но до/во время runF1, вызывает полный расход Claude API с отброшенным результатом. Добавить `if (timedOutJobs.has(job.id)) return;` перед вызовом runF1.
- [ ] [Review][Patch] **P6: formatErrorMessage строки содержат неэкранированные точки MarkdownV2** [src/utils/telegram-formatter.ts:64-83] — Строки с `.` вызывают Telegram 400 на каждом `safeEditMessage`, принуждая к лишнему retry (plain-text). Исправление: убрать `parse_mode` при отправке error-строк или экранировать их через `escapeMarkdownV2`.
- [ ] [Review][Patch] **P7: setMyCommands и setChatMenuButton в одном try/catch** [src/bot.ts:579-586] — Сбой любого из вызовов неотличим в логах; успешный `setMyCommands` маскируется сбоем `setChatMenuButton`. Разделить на два независимых try/catch.
- [ ] [Review][Patch] **P8: ReportJobSchema.id допускает 1–32 символа, spec требует 8** [src/types.ts:242] — Схема должна отражать контракт: `z.string().length(8)`.
- [ ] [Review][Patch] **P9: ctx.reply ack и overflow без parse_mode** [src/bot.ts:526, 534] — Непоследовательно с остальными путями reply. Добавить `{ parse_mode: 'MarkdownV2' }` либо убедиться что строки не требуют parse_mode и задокументировать намерение.

#### Deferred

- [x] [Review][Defer] **randomUUID().slice(0,8) — теоретическая коллизия** [src/bot.ts:500] — deferred, pre-existing design; при maxSize=20 вероятность пренебрежимо мала
- [x] [Review][Defer] **Worker использует jobs.shift() вместо dequeue()** [src/utils/report-queue.ts:107] — deferred, дублирование логики без текущего бага; maintenance trap
- [x] [Review][Defer] **timedOutJobs растёт для job'ов в очереди (не running)** [src/bot.ts:209,455] — deferred, ограничено maxSize=20, утечка пренебрежимо мала
- [x] [Review][Defer] **getISOWeekNumber прямой вызов в format-prompt** [src/f1-report.ts] — deferred, pre-existing issue (не введён Story 1.5); передать safeWeekNumber
- [x] [Review][Defer] **parseTrackerChatIds: отложенная валидация** [src/config.ts:44] — deferred, намеренный дизайн согласно комментарию; падает при старте (допустимо)
- [x] [Review][Defer] **startBot().catch: process.exit(1) без остановки worker** [src/index.ts:28-31] — deferred, process.exit() немедленно завершает процесс, graceful stop несущественен
- [x] [Review][Defer] **formatProgressStep('queued') — мёртвый код** [src/utils/telegram-formatter.ts:43] — deferred, будет нужен в Story 1.12 (статус-команда)
