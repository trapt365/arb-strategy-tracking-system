# Deferred Work

## Deferred from: code review of story-0.1 (2026-04-09)

- Загруженные на Soniox файлы никогда не удаляются (`DELETE /files`) — накапливается storage в аккаунте. Приемлемо для one-shot валидационного скрипта; ручная очистка через console.soniox.com.
- Файл без расширения отвергается как "Неподдерживаемый формат:" — corner case без mime sniffing fallback.
- Нет signal-handler (SIGINT/SIGTERM) и атомарных записей (temp + rename) — для одноразового скрипта приемлемо.
- Hardcoded `language_hints: ["ru","kk"]` без конфигурации — фиксированный scope проекта (RU+KK), не нужно делать настраиваемым.
- `tsconfig` Node16 resolution + `type: module` без явных `.js` extensions в импортах — сейчас работает (нет relative imports), но сломается при future split на модули.

## Deferred from: code review of story-1.2 (2026-04-23)

- `transcriptionId` не удаляется на Soniox при failure после `createTranscription` — нет `DELETE /v1/transcriptions/{id}` API в Soniox (только `DELETE /files`); transcription истекает самостоятельно. Story 1.9 добавит ops-alert при аномальных накоплениях.
- ~~`GOOGLE_SERVICE_ACCOUNT_JSON` lazy validation в `createDriveClient` вместо config-time — intentional deviation, обеспечивает offline/CI-friendly smoke-тесты; Story 1.3 подтвердит поведение при реальном использовании.~~ **CLOSED 2026-04-30 (Story 1.3):** lazy validation вынесена в общий helper `loadServiceAccountCredentials()` (`src/utils/google-auth.ts`), используется в `drive.ts` и `sheets.ts`. Решение «keep lazy» подтверждено: offline-friendly tests + smoke без credentials, единая точка валидации, memoization избегает повторных I/O.
- Нет общего 10-мин тайм-аута на весь цикл `pollUntilCompleted` — MVP approximation: 120 × 5s ≈ 10 min; добавить внешний AbortController если polling в продакшне превышает 12 мин (Story 1.9). **Уточнение 2026-04-30:** анализ кода показал worst-case 120 × (5 + 4×9) ≈ 80 мин при долгих 5xx-сериях (каждый poll-attempt в своём `withRetry` с {1,3,9}с backoff). Расхождение с Task 3.6 («10 мин») зафиксировано. Решение: внешний `AbortController` со `startTime`-check ИЛИ счётчик total elapsed → fail на превышении 10 мин. Триггер: Story 1.9.x.

## Deferred from: code review of story-1.2 (2026-04-30, IWE sanity-pass)

- **Soniox streaming upload (OOM-риск на > 218 MB)** — `src/adapters/soniox.ts:148-150` использует `readFile() + new Blob([buffer])` ≈ 2× RAM. На 500 MB файле это ~1 GB в RAM. Story 0.1 review #1 уже фиксировал паттерн; в Story 1.2 принят hard-limit 500 MB + warn > 100 MB как MVP-подход. Триггер: Story 1.9.x ИЛИ материализация OOM в проде на видеофайле > 218 MB. Решение: streaming через `Readable.toWeb()` + Blob-like wrapper или undici fetch с stream-телом.

## Deferred from: implementation of story-1.3 (2026-04-30)

- **Sheets API rate limiter / queue** — Sheets API имеет лимит 100 req/100 s/user. На MVP с одним клиентом и ~5 встречами/неделю → ~5 batchGet в неделю, ничтожная нагрузка. Триггер: 3-й клиент или > 80 req/min в логах. Решение: in-memory token bucket или библиотека `bottleneck`. [architecture.md, Growth phase]
- **Local cache для OKR/stakeholder data** — `readClientContext` бьёт Sheets API на каждый pipeline-запуск (~2-3 секунды латентности). На MVP допустимо. Триггер: устойчивая медиана `sheets.batchGet durationMs` > 2000ms (агрегированные warn-логи Story 1.9). Решение: in-memory TTL cache (5 мин) с inv. на manual refresh. [architecture.md, Growth phase]
- **Multi-client `resolveSheetId`** — на MVP whitelisting `clientId === 'geonline'` с одним env var `GEONLINE_F0_SHEET_ID`. На 2-м клиенте: расширить `config.CLIENTS = { geonline: 'sheetId1', clientB: 'sheetId2' }` или вынести в data-table. Архитектурный stub `resolveSheetId(clientId)` уже есть — менять только тело. Триггер: Epic 6 / Story 6.2.
- ~~**Sheets write-side adapter (F5 metrics, ops logs)** — Story 1.3 покрывает только read. Append/write для ops logs (Story 1.9) и F5 manual entry (Story 1.10) добавят `appendRow` / `writeF5Metric` с обратной конверсией `camelToSnake`.~~ **PARTIALLY CLOSED 2026-05-22 (Story 1.9):** `appendOpsLog(row)` в `src/adapters/sheets.ts` пишет в worksheet `_ops_logs` через `spreadsheets.values.append` (RAW, INSERT_ROWS). OAuth scope расширен до `spreadsheets`. **F5 manual entry remains deferred** — пересмотрено 2026-05-23 (Story 1.10): F5 entire scope перенесён в Epic 2 (deferred-growth) / Story 6.x; `writeF5Metric` НЕ в scope Story 1.10.

## Deferred from: implementation of story-1.4a (2026-04-30)

- **Claude circuit breaker (3 fail/5 min → fallback)** — на 1.4a `src/adapters/claude.ts:isClaudeCircuitOpen()` всегда возвращает `false` (заглушка). Caller-логика (Story 1.5 telegram bot) не реализует ветвь fallback. Триггер: первая прод-инцидентная серия 5xx от Anthropic API. Story 1.9 заменит тело + добавит state (in-memory счётчик с TTL).
- ~~**Auto-cleanup `*.raw.txt` через 14 дней** — `data/{clientId}/{date}/f1-*.{step}.raw.txt` накапливаются без TTL.~~ **CLOSED 2026-05-23 (Story 1.10):** `src/utils/raw-cleanup.ts` + `src/scheduler.ts` (in-process setInterval, cleanup 03:00 Asia/Almaty). Рекурсивно сканирует `data/{client}/{YYYY-MM-DD}/`, удаляет `*.raw.txt` старше 14 дней; `*.json` / `approvals.jsonl` / state-файлы не трогаются. Ignore-paths: `test-audio`, `golden`, `soniox-results`, `prompt-results`, `test-inputs`, `week-*`, `.backups`. Atomic state `data/.scheduler-state.json` (writeFile+rename). Ошибки → `alertOps('scheduler.cleanup_failed')`. node-cron + missed-job detection — Story 3.0.
- **Smart transcript trimming для context_length_exceeded** — на длинных встречах (> 90 мин транскрипт) Claude может вернуть `context_length_exceeded`. На 1.4a — fail с понятным сообщением (не retryable). Триггер: первая такая встреча в проде. Решение: умная нарезка по segments + map-reduce summarize.
- ~~**Запись/обновление статусов commitments в data/** — Story 1.4a реализует только чтение open commitments; analysis возвращает `commitments_status_updates`, но caller их НЕ применяет к источнику истины.~~ **FULLY CLOSED 2026-05-23 (Story 1.10):** `loadOpenCommitments` в `src/utils/commitments-history.ts` теперь читает `*.commitments-updates.json` overlay (схема через `CommitmentStatusUpdateSchema`) ПОСЛЕ загрузки base extraction и применяет статусы по dedup-key `(who, what)` с newer-wins по mtime. Append-only invariant в `*.extraction.json` сохранён (overlay-only updates). Schema-invalid overlay entries → `log.warn('commitments_overlay.update_invalid')` + skip; полный файл без `updates[]` → `commitments_overlay.schema_skip`. PostgreSQL migration (Growth) уберёт overlay, но external API `loadOpenCommitments` остаётся стабилен.
- **Streaming Claude response (TTFB)** — на 1.4a синхронный `messages.create` ждёт полного ответа (~30-60 с на extraction). Streaming через `messages.stream` сократит perceived latency, но усложнит `parseClaudeJSON` (нужен буфер на полный JSON). Триггер: Growth phase / pain в UX.
- **Prompt caching через `cache_control` блоки** — Anthropic SDK поддерживает кэширование system + transcript между вызовами; экономия минимальна на 5 встречах/нед. Триггер: 50+ Claude calls/нед.

## Deferred from: code review of story-1.4b (2026-05-18)

- **topNameSlug collisions cross-stakeholder data leak** — `"Жанель Иванова"` vs `"Жанель  Иванова"` (двойной пробел) → одинаковый slug; `loadOpenCommitments` смешивает истории. Триггер: 2-й клиент с похожими именами или duplicate stakeholders в Sheets. Решение: Story 1.10 — collision detection при write или migration на UUID-based filenames. [B1]
- **multi text-block concat ломает JSON при interleaved tool_use** — `src/adapters/claude.ts:220` `join('')`. С текущим prompting tools не используются. Триггер: добавление function-calling в Story 1.9+. [B6]
- **AbortError race в shouldRetryClaude** — `shouldRetryClaude` возвращает true на AbortError; полагается на withRetry signal short-circuit. Микросекундная race-window возможна. Story 1.9. [B7 + A6]
- **MEETING_DATE_PREFIX_RE пропускает невалидные даты ("9999-99-99")** — `/^\d{4}-\d{2}-\d{2}/` структурно ОК, но семантически невалидная дата создаёт мусорные директории. Story 1.10 (полная date validation). [B8]
- **prompt_load AbortError эмитит ложный alertOps** — `loadPrompt` сейчас не поддерживает abort; если в будущем добавится I/O cancellation, ops получит ложный alert. Story 1.9. [B12]
- **report_sections.length === 0 от Claude → forced partial** — `FormatOutputSchema.report_sections.min(1)` отвергает корректный edge-case 5-min check-in. Редкий; Story 1.9. [C4]
- **extractionFallback.citations.slice(0,10) без priority sorting** — берёт первые 10, не сортированные по `approximate:false`. Story 1.9 (citation ranking). [C6]
- **persistDeliveryReport не поддерживает AbortSignal** — `fs.promises.*` не принимает signal в Node 20. Wasted IO после abort но не корректность. Story 1.9. [C8]
- **commitment_count независим от commitments.length (schema drift)** — нет cross-field refinement в FormatOutputSchema. Claude может вернуть `commitment_count: 99` при 2 элементах. Story 1.9. [C9]
- **split-persist race: report.json есть, commitments-updates.json нет** — оба warn-only; ENOSPC между await'ами → silent inconsistency. Story 1.10 (atomic batch persist). [C10]
- **getISOWeekNumber без года — W1 2026 vs W53 2025** — meeting 2025-12-29 (Mon) → ISO week 1 2026. Promp header «нед. 1» без года. Story 1.9 (вернуть `W{NN}-{YYYY}`). [C11]
- **partial: boolean не literal — ломает type narrowing у consumers** — `RunF1Steps34Result.partial: boolean` вместо `true | false`. Story 1.5 (bot.ts) делает runtime narrowing. Story 1.5/1.10 — рефакторинг. [C13]
- **test 1-2 fail слабо проверяет non-call шага 3** — `expect(claudeSafe).not.toHaveBeenCalled()` только; не проверяет loadPrompt + persistence absence. Hardening, не блокер. [A10]
- **AC #4 test (retry_exhausted) не проверяет summaryLine/sections/commitments** — AC спек (line 142-147) требует точные значения; тест проверяет partial/partialReason/rawResponses. Hardening. [A11]
- **runF1 не проверяет signal между step12 и step34** — caller abort в зазоре всё равно делает prompt load + первую попытку Claude. Минимальный latency leak. [A14]
- **alertOps shape непоследовательный между f1.format.* событиями** — `validation_failed` передаёт `context: {validationErrors}`, `response_invalid` — только `error: err`. Story 1.9 (ops alerting refinement). [A15]

## Deferred from: implementation of story-1.4b (2026-04-30)

- ~~**Auto-cleanup `*.format.raw.txt` через 14 дней**~~ **CLOSED 2026-05-23 (Story 1.10):** покрыто общим `cleanupRawFiles` — все `*.raw.txt` (extraction, analysis, format) удаляются единой схемой `mtime < now-14d`.
- **Auto-cleanup `*.report.json` / `*.commitments-updates.json`** — на MVP retention неограничен; для GDPR-compliant offboarding (Story 1.10) нужен retention policy. Триггер: 2-й клиент или legal review.
- ~~**Полный persistence-слой commitments (read+update в источнике истины + интеграция overlay в `loadOpenCommitments`)**~~ **CLOSED 2026-05-23 (Story 1.10):** overlay-merge интегрирован в `loadOpenCommitments` (`src/utils/commitments-history.ts`); `*.commitments-updates.json` применяется на base buckets с newer-wins по mtime; статусы `completed`/`overdue` корректно исключают коммитменты из `openCommitments[]` на следующей встрече. Source-of-truth (`*.extraction.json`) остаётся append-only — overlay не переписывает базу. PostgreSQL migration (Growth) уберёт overlay-файлы, оставив API стабильным.
- **Telegram rendering: `formatHeader()`, `approveKeyboard()`, message split > 4096** — Story 1.5/1.6. На 1.4b возвращается `DeliveryReadyReport` объект; сериализация в Telegram-сообщение делает bot.ts.
- **Smart transcript trimming для context_length_exceeded на шаге 3** — формат-промпт получает `extractionOutput` + `analysisOutput` + `commitmentsBefore` + `alerts` → на длинных встречах payload может разрастись. На 1.4b — fail с partial result. Триггер: первый `context_length_exceeded` на шаге 3 в проде.
- **F3-lite formatting (`format-ceo.md` промпт)** — Epic 4. Не пересекается с 1.4b.

## Deferred from: code review of 1-6-approval-workflow-approve-edit-reject (2026-05-19)

- **`applyEditToReport` нет AbortSignal / timeout** — при зависшем Claude пользователь застревает на «⏳ Применяю правку…» бесконечно; `pendingEdits` уже очищен, нет способа отменить. Триггер: Story 1.9 timeout infrastructure. [src/f1-report.ts:1389]
- **`applyEditToReport` нет `stop_reason` проверки** — `max_tokens:2000`; если ответ Claude обрезан, весь отчёт молча усекается и отправляется как исправленный. Триггер: длинные отчёты > 2000 output tokens. Story 1.9. [src/f1-report.ts]
- ~~**`appendApproval` failure: in-memory `approvalStatus='approved'`, нет disk record**~~ **PARTIALLY CLOSED 2026-05-23 (Story 1.10):** disk-level idempotency guard через `isAlreadyApproved(clientId, reportId)` теперь активен в approve callback ПЕРЕД in-memory check. После рестарта повторное нажатие [✅ Подтвердить] для уже одобренного reportId → `ℹ️ Уже отправлено.` + `bot.approve.disk_idempotency_hit` лог; повторная `appendApproval` и `deliverReport` не вызываются. `appendApproval` failure всё ещё warn-only (in-memory отчитывается «Подтверждено», disk-line отсутствует) — но guard прочтёт line при следующем тапе. Восстановление-после-фейла disk-write в одной транзакции — Phase 2.
- ~~**`isAlreadyApproved` определён но не вызывается**~~ **CLOSED 2026-05-23 (Story 1.10):** wired в approve callback (`src/bot.ts`); fs read error → `log.warn('bot.approve.idempotency_check_failed')` + continue (защитный механизм не должен блокировать happy path).
- **Старая approve-клавиатура остаётся после edit** — после применения правки новое сообщение получает кнопки, но старое сообщение с кнопками тоже остаётся. Оба указывают на тот же jobId. Story 1.7 UX. [src/bot.ts]
- **`pendingEdits` ключ только по chatId — коллизия в группах** — несколько авторизованных пользователей в одном чате перезаписывают друг другу pending edit. MVP: один пользователь (Азиза). Story 6.x (multi-tracker). [src/bot.ts:130]
- **`completedJobs` нет TTL** — неограниченное время одобрения: week-old отчёты остаются доступными для approve callbacks. Story 1.10 пересмотрено: MAX_COMPLETED_JOBS=100 bound в 1.5 достаточен для MVP; TTL eviction — Story 6.x. [src/bot.ts:127]

## Deferred from: code review of story-1.1 (2026-04-21)

- `/health` строгое матчинг URL — `/health?x=1`, `/health/`, `/HEALTH` дают 404. Docker internal probe работает на точном `/health`; внешние probe придут в Story 1.14 (Hostinger VPS deploy).
- `TZ` в Zod схеме — `z.string().default('Asia/Almaty')` без `.refine` через `Intl.DateTimeFormat` — Node молча падает на UTC при невалидной зоне. Hardening, не блокер.
- ~~`GOOGLE_SERVICE_ACCOUNT_JSON` — относительный путь; Zod проверяет только непустую строку, не существование файла. Sheets adapter в Story 1.3 сам упадёт при отсутствии файла — FS-проверка переедет туда.~~ **CLOSED 2026-04-30 (Story 1.3):** валидация существования файла + JSON-shape перенесена в `loadServiceAccountCredentials()` (`src/utils/google-auth.ts`); используется в `drive.ts` и `sheets.ts`.
- ~~`src/config.ts` вызывает `loadConfig()` + `process.exit(1)` на module top-level → любой импортёр не может быть unit-тестирован без реальных env. Тестовая инфраструктура появится в Story 1.11 (canary + golden dataset).~~ **CLOSED 2026-05-23 (Story 1.11) — partial:** canary CLI (`scripts/canary.ts`) даёт первый regression-harness против реального Claude API через `runF1`; pure-unit-инфраструктура для `src/config.ts` остаётся deferred до Story 6.x (`process.exit` рефактор для безопасных импортов).
- `startTime = Date.now()` в `src/server.ts` захвачен на import, а не на `listen()`. Для singleton разница невидима.
- ~~AC #5 не имеет явного теста, подтверждающего паттерн `logger.child({pipeline, step, clientId})` — тесты придут со Story 1.11.~~ **CLOSED 2026-05-23 (Story 1.11):** canary CLI создаёт `logger.child({pipeline:'CANARY', step:'canary.<step>', clientId})` per item; pattern проверяется в реальном run против golden dataset.

## Deferred from: code review of story-1.4a (2026-05-15)

- ~~**Task 10.10 — regression test против `data/golden/transcript-N.json` + `f1-reference-N.json`** — pure 1.4a тесты используют тип-фикстуры. Триггер: Story 1.11 (canary test).~~ **CLOSED 2026-05-23 (Story 1.11):** `scripts/canary.ts` запускает `runF1` на 7 golden транскриптах и сравнивает structural diff против `f1-reference-N.json` (8 dimensions + 3 semantic assertions + verdict thresholds 30/50%).
- **`deps.now` инъекция не пробрасывается во все `Date.now()` calls в `src/f1-report.ts`** — Task 6.5 объявил deps.now, использован только в `loadOpenCommitments`. SLA-тест может использовать `vi.useFakeTimers`. Полный рефакторинг — отдельная задача.
- **`persistStep` записывает `.raw.txt`, потом `.json` — silent loss `extraction.json` при ENOSPC между ними** (`src/f1-report.ts:122-129`). Warn-only design (spec AC #8). Триггер: Story 1.9 (ops + retry-on-persist-fail).
- **`commitments-history` maxAgeDays cutoff в UTC vs локальный TZ — off-by-5h** (`src/utils/commitments-history.ts:54`). На Asia/Almaty (+05) граничный день может отрезаться неверно. Effect: ≤1 встреча на квартал. Триггер: ощутимое расхождение в проде.
- **Memory pressure при > 100k char транскриптах** — `JSON.stringify(extraction, null, 2)` + transcript text в памяти. Acceptable для MVP (≤90 мин). Триггер: 4-часовые сессии или multi-client batch.
- **Smoke-script CWD-relative paths и `??=` для metadata** (`scripts/f1-smoke.ts`). Manual-tool design; ломается только при запуске не из project-root. Acceptable.
- **`topNameSlug` collision для разных топов с одинаковым именем** (`src/utils/commitments-history.ts:20-26`). При 2-х топах со слагом `жанель` дедуп `who+what+deadline` смешает истории. MVP-limit (1 клиент с уникальными именами). Триггер: 2-й клиент ИЛИ дубликат slug в `stakeholders[]` одного клиента. Решение: добавить `clientId` в dedup-key или валидировать уникальность slug на readClientContext.
- **`reportId = randomUUID().slice(0, 8)` — 32-bit collision risk** (`src/f1-report.ts:227`). Same-day rerun overwrite вероятность ~1/4B; статистически невозможна на 5 встречах/нед в MVP. Триггер: переход на batch-pipeline (Story 3.0/Scheduler) или auditable filename-collision logs.
## Deferred from: code review of 1-5-telegram-bot-komanda-report-i-progress (2026-05-19)

- **randomUUID().slice(0,8) коллизия** — теоретическая, пренебрежимо при maxSize=20
- **Worker jobs.shift() vs dequeue()** — дублирование логики, maintenance trap, не баг
- **timedOutJobs утечка для queued-но-не-running jobs** — ограничена maxSize=20
- **getISOWeekNumber прямой вызов в format-prompt f1-report.ts** — pre-existing, заменить на safeWeekNumber
- **parseTrackerChatIds deferred validation** — намеренный дизайн, падает при старте
- **startBot().catch без graceful stop worker** — несущественно при process.exit(1)
- **formatProgressStep('queued') мёртвый код** — нужен в Story 1.12

## Deferred from: code review of story 1-8-first-run-experience-onbording-azizy (2026-05-20)

- **Redundant первый вариант AC#9 теста** [src/bot.test.ts:1291-1314] — тестирует grammY API (`bot.api.setMyCommands`) напрямую, а не нашу обёртку. Второй вариант через `built.start()` (line 1316) полностью покрывает AC. Удалить при следующей правке тестов.

## Deferred from: implementation of story-1.9 (2026-05-22)

Все эти пункты явно вынесены из scope Story 1.9 в самой story spec (секция «Что НЕ входит в Story 1.9»). Перечислены здесь для централизованного учёта:

- **Weekly aggregated metrics aggregator** (`time_to_approve` avg, `f5_response_rate`, `bot_menu_usage`) — Story 1.9 обеспечивает только сырые события (`_ops_logs` + `approvals.jsonl`). Реализация query/render — Story 1.12 (Ops-статус pipeline для Айдара). `f5_response_rate` зависит от Epic 2 (deferred-growth).
- ~~**Cron job для backup-tar + cleanup `*.raw.txt` (14d)**~~ **CLOSED 2026-05-23 (Story 1.10):** реализовано через `src/scheduler.ts` (setInterval, без node-cron — это Story 3.0). Cleanup 03:00 + backup 04:00 Asia/Almaty, state в `data/.scheduler-state.json` atomic. tar archives в `data/.backups/data-backup-{date}.tar.gz`, retention 7 дней, excludes `*.raw.txt` + ignore-dirs. Ошибки → `alertOps('scheduler.{cleanup,backup}_failed')`.
- **Circuit breaker для Claude (3 fail / 5min)** — заглушка в `src/adapters/claude.ts:isClaudeCircuitOpen()`. Триггер: первая прод-инцидентная серия 5xx от Anthropic. Целевая story — Story 1.10 или Story 1.12 (бывшая mis-attribution на Story 1.9 в `1-4a` deferred — пересмотрено).
- ~~**Canary test (synthetic golden meeting)** — Story 1.11.~~ **CLOSED 2026-05-23 (Story 1.11):** реализован MVP — `npm run canary` запускает `runF1` на golden dataset, structural diff (8 dims) + 3 semantic assertions, verdict pass/review/rollback/error c exit codes 0/1/2/3, Markdown + JSON отчёты. Weekly cron автоматизация — Story 3.0; F4 canary — Epic 3.
- **Restart-recovery missed-job detection** — переадресовано в Story 3.0 (scheduler shared component). Story 1.10 покрыло cleanup/backup через `setInterval` + idempotent `lastCleanupDay/lastBackupDay` check, но НЕ реализует cron-style missed-job detection (Mon 9:00 F4 ramp).
- **`Email emergency mode` (FR87)** — deferred-growth; никогда не реализовывать на MVP.
- **F3-lite escalation alerts (Дамиру если CEO не открыл)** — Epic 4.
- **F4 watchdog (cron не выполнился к 9:30)** — Epic 3 (Story 3.0 / 3.1).
- **Aidar separate Telegram chat / ROLE-based whitelist** — на MVP Айдар в общем ops-чате через `@mention`. Epic 6 / Story 6.2.
- **Story 1.4b deferred items ранее помечены `Story 1.9` как trigger (lines 13, 15, 19, 30, 41, 43-49, 54, 67-68, 88)** — это были ошибочные scoped tags. Они остаются deferred до конкретных целевых stories (1.10, 1.11, 1.12, или Epic 3+). Не закрываются Story 1.9.

## Прод-демо Ф2 онбординга — баги и фичи (2026-07-08)

Наблюдения из живого прогона онбординга нового клиента в проде (нативный pm2, см. память `project_prod_deploy_native_pm2`). Предварительный бэклог — до формального BMAD-груминга.

### BUG (высокий приоритет)

- **[PROD BUG] Сборка F0-черновика падает: `F1PipelineError:claude_api` → `f0.draft_failed`** — на «✅ Собрать черновик» бот отвечает «⚠️ Не удалось собрать черновик…». Воспроизвелось и на пакете из 4 транскриптов (`sessionId 9484a033, files:4`), и на 1 объединённом файле сущностей (`sessionId 3952b00a, files:1`) — т.е. не только про размер пакета. Точка: `src/bot.ts:1106` (`f0.draft_failed`), Claude-вызов в `src/f0-onboarding.ts` через общий адаптер (`src/adapters/claude.ts`, ошибка типизируется как `F1PipelineError:claude_api`, `src/errors.ts:116`).
  - **Гипотеза A (инфра, вероятная):** тот же сетевой сбой WSL→интернет, что и с `sheets.googleapis.com` — крупный TLS-payload (транскрипты стратсессии) дропается (MTU/fragmentation) → `claude_api` fail на `api.anthropic.com`. Проверить: `curl -w %{time_total} https://api.anthropic.com/v1/...` из прод-WSL; попробовать понизить MTU на eth0. Если так — чинит и Sheets, и Claude разом.
  - **Гипотеза B (лимит токенов):** обрезка/переполнение контекста на большом входе (комментарий в `bot.ts` прямо упоминает «обрезка JSON по лимиту токенов»). Проверить фактический размер промпта vs `CLAUDE_MAX_TOKENS`/context.
  - **Гипотеза C (модель):** `ANTHROPIC_MODEL` дефолт `claude-sonnet-4-6` (`src/config.ts:11`) — убедиться, что ID валиден для текущего API.
  - Действие: воспроизвести с логами (`data/pm2/err-0.log`), достать реальный HTTP-статус/тело ошибки Anthropic (сейчас наружу отдаётся только `claude_api`).

### FEATURES

1. **Стартовое меню бота вместо старого приветствия** — сейчас `/start` шлёт статический `formatWelcomeMessage` (`src/bot.ts:805`). Нужно интерактивное меню: (а) что бот умеет; (б) «Онбординг нового клиента»; (в) «Клиенты» → список из реестра (`listClientIds`/`getClientSheetId`, `src/client-registry.ts`) → по клику статус клиента + выбор «с кем работаем». Затрагивает welcome-handler + `setMyCommands` (`src/bot.ts:1983`) + клиентский селектор (inline-keyboard, хранить выбранного клиента в сессии).

2. **Онбординг принимает только текст — добавить Excel** — на этапе онбординга бот не принимает `.xlsx`. Пакет `xlsx` уже в зависимостях (`package.json`). Нужно: принять spreadsheet-документ в F0 document-handler, распарсить листы в текст/структуру для extraction (`src/f0-onboarding.ts`). Связано с фичей 3.

3. **Два алгоритма входа онбординга: готовая стратегия vs синтез из документов** — предпочтительный путь: трекер грузит **готовую согласованную** стратегию (Excel и/или текст) → импорт напрямую в структуру (минимум LLM, максимум маппинг колонок → `_okr`/`_stakeholder_map`/`_f5_metrics`). Fallback: если готовой нет — обрабатывать сырые документы трекера (текущий LLM-extraction), но это **другой алгоритм** (синтез, а не импорт). Развилку выбирать в начале онбординга. Связано с фичами 2 и 4.

4. **Длинные сообщения с таблицами плохо читаются в Telegram** — вместо простыней с таблицами давать **ссылку на документ** (Google Drive / созданный Sheet) + 1-2 предложения-саммари. Затрагивает доставку F0-черновика (`src/bot.ts` draft-delivery, ~1060-1110) и, вероятно, F1-доставку отчёта. Использовать URL уже создаваемой таблицы (`f0-sheets.ts`) вместо инлайн-таблиц.

5. **Переименовать бота — «Geonline» это клиент, не продукт** — «Geonline» осталось как имя/бренд в сообщениях и дефолтах, хотя это один из клиентов. Провести аудит: `src/bot.ts`, `prompts/`, `src/config.ts` (внимательно — там же `GEONLINE_F0_SHEET_ID` и `clientId==='geonline'` fallback-логика: **переименовывать бренд/тексты, НЕ ломая clientId-регресс geonline**). Также имя/описание бота в BotFather.
