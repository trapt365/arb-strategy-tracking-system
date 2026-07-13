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

Наблюдения из живого прогона онбординга нового клиента в проде (нативный pm2, см. память `project_prod_deploy_native_pm2`). **GROOMED 2026-07-08 (correct-course):** все открытые пункты секции оформлены в **Epic 8 «Прод-фидбэк онбординга»** (`_bmad-output/planning-artifacts/sprint-change-proposal-2026-07-08-epic8-onboarding-feedback.md` + epics.md + sprint-status.yaml). Маппинг: PROD BUG шаблона → story 8.1 (P0); фича #5 → 8.2; #4 → 8.3; #1 → 8.4; #2+#3 → 8.5.

### BUG (высокий приоритет)

- **[PROD BUG] Созданная таблица клиента содержит данные Geonline, а не онбордингового клиента** — онбординг AIPLUS создал таблицу `ai-plus-ai` (`1JwqnA0T1GXD0_LvmrvYcf93z70C7Mkk8r089DHwwkjA`) со СЧЁТЧИКАМИ AIPLUS (OKR 27 · гипотезы 24 · участники 15), но ВИДИМОЕ содержимое — Geonline. **Корень:** `F0_SHEETS_TEMPLATE_ID` указывает на копию боевой таблицы Geonline («Geonline Стратегический трекинг v2.0 (14)»), а не на чистый бланк. Человекочитаемые листы шаблона забиты данными Geonline: `Vision&Strategy` («СТРАТЕГИЯ КОМПАНИИ GEONLINE»), персональные `OKR Дамир/Шынгыс/Максат/Жанель/…`, `Банк гипотез идей задач`, `Ограничения узелки`. F0 (`src/f0-sheets.ts`) пишет данные клиента ТОЛЬКО в скрытые машинные листы `_okr`/`_stakeholder_map`/`_hypotheses`; десятки видимых листов копируются из шаблона как есть → каждый новый клиент получает дашборды Geonline.
  - **Fix A (шаблон, основной):** сделать ЧИСТЫЙ бланк v2.0 — пустые/обезличенные человекочитаемые листы, без данных и имён Geonline; `F0_SHEETS_TEMPLATE_ID` → на него.
  - **Fix B (дизайн, желательно):** человекочитаемые панели должны быть формульными (ссылаться на `_okr`/`_stakeholder_map`/`_f5_metrics`), чтобы запись в машинные листы авто-рендерила дашборды под клиента. Сейчас они статичные → показывают контент шаблона.
  - **Fix C (онбординг):** F0 мог бы чистить/наполнять и видимые листы, но их много и они бесбойные — надёжнее чинить шаблон (Fix A/B).
  - Связано с #5 (даже название шаблона = «Geonline»). Orphan для удаления: `1JwqnA0T1GXD0_LvmrvYcf93z70C7Mkk8r089DHwwkjA`. После чистого шаблона — пере-онбордить.

- ~~**[PROD BUG] Сборка F0-черновика падает: `F1PipelineError:claude_api` → `f0.draft_failed`**~~ **RESOLVED 2026-07-08 (`0cb12b2` + `b5d388d`):** оказалось НЕ инфра/сеть (TLS до `api.anthropic.com` здоров). Две причины: (1) F0-экстракция (16k→теперь 32k `max_tokens`, вход ~168k токенов) не влезала в 120с клиентский таймаут SDK → `Request timed out`; фикс — per-call `timeoutMs` (F0=720с) + `shouldRetryClaude` ловит таймаут. (2) выход обрывался на потолке токенов → `claude_response_invalid` (backtick незакрытого фенса); фикс — детект `stop_reason=max_tokens` + подняли потолок. Черновик успешно собран (`49981c76`, 168с). Дубль-запись с гипотезами диагностики удалена 2026-07-08 (correct-course) — история в git (`719549e`).

### FEATURES

1. **Стартовое меню бота вместо старого приветствия** — сейчас `/start` шлёт статический `formatWelcomeMessage` (`src/bot.ts:805`). Нужно интерактивное меню: (а) что бот умеет; (б) «Онбординг нового клиента»; (в) «Клиенты» → список из реестра (`listClientIds`/`getClientSheetId`, `src/client-registry.ts`) → по клику статус клиента + выбор «с кем работаем». Затрагивает welcome-handler + `setMyCommands` (`src/bot.ts:1983`) + клиентский селектор (inline-keyboard, хранить выбранного клиента в сессии).

2. **Онбординг принимает только текст — добавить Excel** — на этапе онбординга бот не принимает `.xlsx`. Пакет `xlsx` уже в зависимостях (`package.json`). Нужно: принять spreadsheet-документ в F0 document-handler, распарсить листы в текст/структуру для extraction (`src/f0-onboarding.ts`). Связано с фичей 3.

3. **Два алгоритма входа онбординга: готовая стратегия vs синтез из документов** — предпочтительный путь: трекер грузит **готовую согласованную** стратегию (Excel и/или текст) → импорт напрямую в структуру (минимум LLM, максимум маппинг колонок → `_okr`/`_stakeholder_map`/`_f5_metrics`). Fallback: если готовой нет — обрабатывать сырые документы трекера (текущий LLM-extraction), но это **другой алгоритм** (синтез, а не импорт). Развилку выбирать в начале онбординга. Связано с фичами 2 и 4.

4. **Длинные сообщения с таблицами плохо читаются в Telegram** — вместо простыней с таблицами давать **ссылку на документ** (Google Drive / созданный Sheet) + 1-2 предложения-саммари. Затрагивает доставку F0-черновика (`src/bot.ts` draft-delivery, ~1060-1110) и, вероятно, F1-доставку отчёта. Использовать URL уже создаваемой таблицы (`f0-sheets.ts`) вместо инлайн-таблиц.

5. **Переименовать бота — «Geonline» это клиент, не продукт** — «Geonline» осталось как имя/бренд в сообщениях и дефолтах, хотя это один из клиентов. Провести аудит: `src/bot.ts`, `prompts/`, `src/config.ts` (внимательно — там же `GEONLINE_F0_SHEET_ID` и `clientId==='geonline'` fallback-логика: **переименовывать бренд/тексты, НЕ ломая clientId-регресс geonline**). Также имя/описание бота в BotFather.

## Deferred from: code review of story 9.2 (2026-07-09)

- source_spec: `_bmad-output/implementation-artifacts/spec-9-2-grounding-profil-edinstvennyy-istochnik-imyon.md`
  summary: Bot.ts wiring of profileParticipants to runF0FullDraftFn not tested at integration level — a bot.test.ts spy test could verify session.profile.tops → non-empty profileParticipants in runF0FullDraft call.
  evidence: All bot tests mock runF0FullDraft as opaque stub; none assert on the profileParticipants argument; regression would be silent if the conditional in bot.ts:2274-2276 broke.

- source_spec: `_bmad-output/implementation-artifacts/spec-9-2-grounding-profil-edinstvennyy-istochnik-imyon.md`
  summary: Duplicate profileParticipants ternary in two bot.ts runF0FullDraftFn call sites — minor maintenance concern.
  evidence: Lines ~2274-2276 and ~2354-2356 contain identical conditional; a future change to profile-tops-context logic must be applied to both call sites.

## Deferred from: code review of story 9.3 (2026-07-09)

- source_spec: `_bmad-output/implementation-artifacts/spec-9-3-startovyy-flow-deystvuyushchego-trekera.md`
  summary: `start_client:{id}` callback wiring not integration-tested at bot level — a bot.test.ts spy test could verify that `setActiveClient` is called with the correct chatId and clientId.
  evidence: bot-start-9-3.test.ts test (4) covers the happy path via a separate test file with vi.hoisted mocks; the main bot.test.ts has no corresponding test for start_client flow; regression in the callback registration order would be silent.

- source_spec: `_bmad-output/implementation-artifacts/spec-9-3-startovyy-flow-deystvuyushchego-trekera.md`
  summary: `/start` and `/help` handlers share near-identical logic (loadRegistry + buildStartMenuKeyboard + formatShortWelcome) — maintenance concern if handlers diverge.
  evidence: Both handlers are ~15 LOC with identical try/catch structure; a shared `sendStartMenu(ctx)` helper would reduce drift risk; deferred since 9.3 spec explicitly states identical behavior is required.

- source_spec: `_bmad-output/implementation-artifacts/spec-9-3-startovyy-flow-deystvuyushchego-trekera.md`
  summary: `buildStartMenuKeyboard` not directly unit-tested — only covered transitively via /start and /help bot handler tests.
  evidence: Pure function with conditional branching (clients.length > 0 vs 0) is straightforward to test in isolation; deferred as transitively covered and low risk.

- source_spec: `_bmad-output/implementation-artifacts/spec-9-3-startovyy-flow-deystvuyushchego-trekera.md`
  summary: Contextual missing_arg hint text contains `/report https://` as a stub URL prefix — may need UX polish to avoid confusing users who copy it literally.
  evidence: Contextual hint: «/report https:// — отчёт по встрече» — the `https://` placeholder is intentional per spec but may be mistaken for a working URL. Deferred: polish in a future UX story (9.7 or later).

## Deferred from: code review of story 9.7 (2026-07-09)

- source_spec: `_bmad-output/implementation-artifacts/spec-9-7-nedelnyy-otchyot-trekera-po-klientu.md`
  summary: `loadWeekReports` has no direct unit tests — file-reading, week-filtering, schema-skip, and sort logic are only exercised via bot-level integration tests with the function mocked out.
  evidence: All 4 tests in `bot-weekly-9-7.test.ts` mock `loadWeekReports` via `vi.hoisted`; any bug in the real `fs.readdir` scan, `DATE_DIR_RE` filter, ISO week comparison, or `DeliveryReadyReportSchema.safeParse` skip would ship undetected. A `src/utils/weekly-report.test.ts` with tmpdir fixtures would close this gap.

- source_spec: `_bmad-output/implementation-artifacts/spec-9-7-nedelnyy-otchyot-trekera-po-klientu.md`
  summary: `weekly:` callback keyboard (Таблица URL) is attached to every `splitForTelegram` chunk, producing duplicate buttons if the report is long enough to split.
  evidence: `splitForTelegram` splits at 4096 chars; a weekly report with many meetings and commitments could exceed this. Pre-existing pattern in other handlers; fix: attach `kb` only to the last chunk.

- source_spec: `_bmad-output/implementation-artifacts/spec-9-7-nedelnyy-otchyot-trekera-po-klientu.md`
  summary: `clientId` in `weekly:` callback is not sanitized for path-traversal before being passed to `loadWeekReports` → `join(rootDir, clientId)`.
  evidence: Same pattern as `client:`, `client_use:`, `start_client:` callbacks (pre-existing); `clientId` values in callback data originate from bot-generated inline keyboards, so the vector requires an authorized user to craft a raw callback query. Low risk for this internal tool.

- source_spec: `_bmad-output/implementation-artifacts/spec-9-7-nedelnyy-otchyot-trekera-po-klientu.md`
  summary: `getClientName` and `getClientSheetId` in `weekly:` callback have no `.catch()` — a registry I/O error crashes the handler with an unhandled rejection.
  evidence: Same pattern as `start_client:{id}` handler (9.3); `data/clients/registry.json` I/O errors would leave the Telegram callback query unanswered (spinner). Fix: wrap both awaits in `.catch(() => clientId/undefined)`.

- source_spec: `_bmad-output/implementation-artifacts/spec-9-7-nedelnyy-otchyot-trekera-po-klientu.md`
  summary: Weekly report commitments aggregated without per-meeting context (date/topName not shown per commitment line).
  evidence: `formatWeeklyReport` lists `• who → what, до deadline` but drops which meeting originated the commitment; with 2+ meetings/week the origin is ambiguous. UX polish for a future iteration.

- source_spec: `_bmad-output/implementation-artifacts/spec-9-4-edinyy-vkhod-prezentacii-v-dokumentakh-robastnyy-xlsx.md`
  summary: Stub `f0_mode_questionnaire` handler не проверяет фазу сессии — отвечает при любом состоянии.
  evidence: `chooseF0Mode` (import/synthesis) имеет guard на `phase !== 'collecting'`; questionnaire-stub его не имеет. Хэндлер temporary до 9.5 — guard добавит 9.5.

- source_spec: `_bmad-output/implementation-artifacts/spec-9-4-edinyy-vkhod-prezentacii-v-dokumentakh-robastnyy-xlsx.md`
  summary: `{{presentationHint}}` в промпте создаёт лишнюю пустую строку между `## Инструкции` и `### 1.` когда hint пустой.
  evidence: Промпт-шаблон: `## Инструкции\n\n{{presentationHint}}\n\n### 1.` → при empty hint: двойной blank. Косметика, LLM-обработку не нарушает.

- source_spec: `_bmad-output/implementation-artifacts/spec-9-4-edinyy-vkhod-prezentacii-v-dokumentakh-robastnyy-xlsx.md`
  summary: `parseInt(name.replace(/\D/g, ''), 10)` в sort-компараторе `extractPptxText` возвращает NaN для slide-файлов без цифр в имени.
  evidence: Валидные PPTX всегда имеют `slideN.xml`; corner case только для поломанных PPTX. Решение: `|| 0` fallback в parseInt.

- source_spec: `_bmad-output/implementation-artifacts/spec-9-4-edinyy-vkhod-prezentacii-v-dokumentakh-robastnyy-xlsx.md`
  summary: Расширение словаря синонимов xlsx не покрыто тестами — нет regression-guard для новых синонимов.
  evidence: Файл `ARB_Solutions_Стратегический_трекер_v1_1_1.xlsx` отсутствует в репозитории; spec Design Notes явно откладывает snapshot-тест до появления файла. Добавить как test fixture когда файл будет доступен.

## Deferred from: code review of story 9.5 (2026-07-09)

- source_spec: `_bmad-output/implementation-artifacts/spec-9-5-voprosnik-s-golosovymi-otvetami.md`
  summary: Questionnaire session persist-restore round-trip untested — no test exercises disk round-trip for questionnaire-phase state (qnObjectives, qnKrData, qnHypotheses, etc.).
  evidence: All 9.5 tests use a single bot instance; getOrRestoreF0Session always returns in-memory session, never exercising the Zod parse → restore path. Profile and filling phases have analogous restart tests (bot.test.ts:2350, :1960); questionnaire does not. Silent regression if any qn* field is dropped from saveF0Session serialization.

- source_spec: `_bmad-output/implementation-artifacts/spec-9-5-voprosnik-s-golosovymi-otvetami.md`
  summary: voice_ok pressed with no voicePending (stale button) has no test coverage.
  evidence: The "ℹ️ Нет ожидающего голосового ответа." branch exists in production code (bot.ts:voice_ok callback) but is exercised by no test. A stale voice_ok button after bot restart would hit this path in production.

- source_spec: `_bmad-output/implementation-artifacts/spec-9-5-voprosnik-s-golosovymi-otvetami.md`
  summary: startF0SessionGuarded progress description has no questionnaire branch — shows "файлов в пакете: 0" when /newclient is issued during active questionnaire phase.
  evidence: f0SessionAtRisk returns true for questionnaire phase, triggering the progress prompt; the description-building logic has no questionnaire case, so it defaults to a collecting-phase-style summary that is misleading. Rare edge case (user types /newclient while in questionnaire).

- source_spec: `_bmad-output/implementation-artifacts/spec-9-5-voprosnik-s-golosovymi-otvetami.md`
  summary: Voice duration boundary at exactly 300s not tested — only 301s (rejected) is covered.
  evidence: Test (c) sends voiceUpdate(301) and verifies rejection. The guard is `voice.duration > 300`, so duration=300 should be accepted. No test verifies this boundary, leaving an off-by-one risk invisible.

## Deferred from: adversarial review эпика 9 (2026-07-10, be61940..bc3f1b4, 8 углов × verify)

> **Обновление 2026-07-10:** топ-2 + все 10 подтверждённых находок ИСПРАВЛЕНЫ (2 коммита «fix(review-e9)»). 670 тестов + tsc + canary PASS, задеплоено в прод. Остались 4 недоверифицированных cleanup ниже — не баги, ждут отдельного захода. REFUTED-запись — для истории.

- **[ИСПРАВЛЕНО 2026-07-10] callback_data > 64 байт в клавиатуре владельца** — `src/bot.ts:1658,1755`: `f0q_owner:${i}:${top.name}` с кириллическим именем >26 симв. превышает лимит Telegram → BUTTON_DATA_INVALID проглочен `.catch(()=>{})` → вопросник молча замерзает на B2.2, /resume перестраивает ту же клавиатуру. Решение: только индекс в callback_data (handler уже имеет `ctx.match[1]`, имя читать из `session.profile.tops[idx]`); заодно `.row()` на >8 топов. Триггер: первый клиент с длинными именами топов.
- **[ИСПРАВЛЕНО 2026-07-10] Grounding 9.2 ломает «дословный» импорт xlsx** — `src/f0-sheets.ts:352` + `src/f0-grounding.ts:19`: точный матчинг имён; «Петров» (Excel) vs «Иван Петров» (профиль) → `🔴 Петров` в _okr, uniqueOwners отфильтровывает → личные листы пустые. Решение: fuzzy-матчинг (фамилия-подмножество) ИЛИ на import-пути писать owner verbatim + предупреждение о несовпадениях вместо 🔴-переписывания. Триггер: первый онбординг через xlsx с сокращёнными именами.
- **[ИСПРАВЛЕНО 2026-07-10] '/skip' сохраняется как формулировка KR** — `src/bot.ts:3008`: `krData[objIdx]={formulation:'/skip',owner:null}` течёт через buildQnDraft (без sentinel-фильтра) в черновик, дозаполнение и _okr-лист. Решение: /skip на шаге KR → objective без KR (krData не заполнять), симметрично profile-skip. Триггер: любой /skip в вопроснике.
- **[ИСПРАВЛЕНО 2026-07-10] f0_mode_questionnaire без guard «путь уже определён»** — `src/bot.ts:1594`: проверяет только phase; при mode='import'/документах тап молча бросает принятый пакет, f0q_hypo_done:1911 перезаписывает mode='synthesis'. Решение: guard как в chooseF0Mode:1560-1567 («Путь уже определён… /newclient»). Триггер: смешанный онбординг (файлы+вопросник).
- **[ИСПРАВЛЕНО 2026-07-10] /confirm молчит о недозаполненных KR вне success-ветки** — `src/bot.ts:3279`: счётчик+ссылка только в try-success createSheetForSession:3225; no-template:3183 / F0SheetsError:3246 / unexpected:3251 — ноль упоминаний (до 9.6 предупреждение было безусловным). Решение: warning-строку в сам /confirm-ответ до вызова Sheets. Триггер: любой /confirm при сбое Sheets.
- **[ИСПРАВЛЕНО 2026-07-10] groundedStakeholderRows затирает собранные контакты** — `src/f0-grounding.ts:60-73`: профильная строка заменяет участника целиком (contact:=null, role:=title??null), а не merge по полям → ответы на gap participant_contact и роли из документов выбрасываются; в _stakeholder_map уходит role='', department='—' → F1 деградирует. Решение: пополевой merge (профиль побеждает только непустыми полями). Триггер: первый F1-отчёт нового клиента с «—» в шапке.
- **[ИСПРАВЛЕНО 2026-07-10, смягчён] Голосовое подтверждение без splitForTelegram** — `src/bot.ts:3814`: транскрипт >4096 симв. → MESSAGE_TOO_LONG проглочен → кнопки ✅/✏️/🎤 не приходят, voicePending протухает (восстановимо текстом/новым войсом, но транскрипция потеряна молча). Решение: splitForTelegram как в 474/670/2123/4027 (кнопки к последней части). Триггер: голосовые >3 мин.
- **[ИСПРАВЛЕНО 2026-07-10] Голосовая транскрипция невидима для ops** — `src/bot.ts:3749-3765`: копия Soniox-цепочки без alertOps/recordOpsEvent/таксономии (у transcribeFromUrl — на каждом классе сбоя). Решение: buffer/file-входная точка в adapters/transcript.ts, переиспользовать обвязку. Триггер: серия молчаливых сбоев голоса.
- **[ИСПРАВЛЕНО 2026-07-10] Обрезка user-текста бытовым slice** — `src/bot.ts:1679,1789`: `slice(0,60)` режет суррогатную пару эмодзи → lone surrogate валит sendMessage (прецедент: telegram-formatter.ts:218-221, commit 736b560). Оговорка: truncateEllipsis сам surrogate-unsafe (:378-380) — чинить надо его (charCodeAt 0xD800-0xDBFF guard) и использовать в обоих местах.
- **[ИСПРАВЛЕНО 2026-07-10] Протухшие кнопки вопросника молчат** — `src/bot.ts:1857→1862,1896→1901`: безусловный answerCallbackQuery при входе + второй answer для того же query id в stale-ветке → Telegram отклоняет, ни тоста ни сообщения (f0q_owner:1877 вообще silent return). Решение: паттерн f0_new_yes:1972 (staleness ДО answer) либо ctx.reply как в f0p_*.
- **[не доверифицировано] persist-поля в 3 точках синхронизации** — interface F0Session + saveF0Session spread + restore literal (+zod): каждое новое поле требует 3 правки, забытая = silent drop при рестарте (класс бага уже материализовался: топ-2 фикс documents/importResult). Решение: сгруппировать в session.qn / session.profileState суб-объекты, персистить одним spread.
- **[не доверифицировано] writeProfileToCard на каждый вопрос** — `src/bot.ts:~1241`: card-fill режим перечитывает+переписывает card.json на каждом ответе (14 циклов на расширенный профиль) при уже существующем session-persist. Решение: писать card.json один раз в finishProfileDialog.
- **[не доверифицировано] Дубль маппинга топов** — `src/f0-questionnaire.ts:~105` buildQnDraft повторяет tops→participant из groundedStakeholderRows → questionnaire- и document-клиенты разойдутся в _stakeholder_map при изменении ClientTop. Решение: один экспортируемый маппер в f0-grounding.ts.
- **[не доверифицировано] Диск-чтения в hot-path** — `src/bot.ts:~3965` fallback-хендлер читает active-clients.json+registry.json на каждое непойманное сообщение; `:2083,2107` start_client/weekly парсят registry дважды последовательно. Решение: write-through кэш реестра (все писатели в одном процессе) + Promise.all.
- **[REFUTED, для истории] ISO-неделя UTC vs local** — обе стороны (meetingDate и недельный расчёт) на UTC → рассинхрона нет, только косметика заголовка для встреч пн 00:00-05:00 Алматы.

## Deferred from: review of story-10.2 (2026-07-10)

- source_spec: `_bmad-output/implementation-artifacts/spec-10-2-proshchayushchiy-vkhod-klienta.md`
  summary: `/advanced` no-session path recreates fill session even when all ext questions already answered — `finishProfileDialog` fires immediately with a confusing response.
  evidence: Same behavior as pre-existing `profile_fill:{clientId}` callback. Triggered when user calls `/advanced` on a client with fully filled extended profile. Story 10.7 cosmetics pass could add a "profile complete" guard.

- source_spec: `_bmad-output/implementation-artifacts/spec-10-2-proshchayushchiy-vkhod-klienta.md`
  summary: `completeProfileMinimum` test helper sends `f0p_go` without first asserting offer screen appeared — fragile if `PROFILE_MIN_COUNT` ever changes.
  evidence: Helper is used in ~10 tests. If `PROFILE_MIN_COUNT` changes, helper silently sends a stale callback and downstream tests fail with cryptic errors instead of a clear "offer screen missing" failure.

- source_spec: `_bmad-output/implementation-artifacts/spec-10-2-proshchayushchiy-vkhod-klienta.md`
  summary: Test assertions use magic-number `(1/16)`, `(3/16)` etc. instead of `PROFILE_EXT_COUNT` constant — maintenance landmine if ext-questions count changes.
  evidence: Future additions to `PROFILE_EXT_QUESTIONS` (e.g. Story 10.5) will break these tests with opaque number mismatches.

## Deferred from: review of story-10.1 (2026-07-10)

- **[defer] processJob filePath-ветка не покрыта сквозным тестом** — bot.test.ts тесты 10.1 проверяют enqueue (filePath в job), но processJob сам мокируется; `transcribeFromFilePath` + F1 вызов через filePath-путь в интеграционном тесте отсутствует. Триггер: первый баг в processJob filePath-ветке в проде. Решение: интеграционный тест processJob с `job.filePath` mock.
- **[defer] unlink tmp-файла не верифицирован в тестах** — `processJob` finally `unlink(job.filePath)` не покрыт тестом (spy на `unlink` не установлен). Риск: утечка tmp-файлов при изменении finally-блока. Триггер: изменение cleanup-логики processJob. Решение: добавить spy-тест unlink в bot.test.ts.
- **[defer] Нет расширения файла в tmpPath** — `meeting-${randomUUID()}` без расширения. Soniox определяет кодек по расширению при части реализаций; текущий Soniox-клиент принимает файл без расширения (проверено в Story 1.x). Если в будущем обновить soniox-клиент или добавить другой провайдер — нужно передавать `ctx.message.audio.mime_type` → расширение. Триггер: смена/обновление транскрипшн-провайдера.
- **[defer] meetingDate = время получения, не дата встречи** — `now().toISOString()` в `handleMeetingFileIntake` фиксирует момент загрузки файла, а не реальную дату встречи. Для MVP приемлемо (встречи обрабатываются сразу). Триггер: пользователи загружают записи встреч с задержкой > 1 дня. Решение: UI-диалог «Когда прошла встреча?» или парсинг имени файла.
- **[defer] `ReportJobSchema` без `.refine()` на url/filePath** — схема позволяет job без url и без filePath; runtime catch выдаст понятное сообщение, но статическая проверка отсутствует. Триггер: третий job-source без явного guard. Решение: `.refine(d => d.url || d.filePath, { message: 'job must have url or filePath' })` — не сделано в MVP, т.к. меняет форму схемы и требует обновления всех create-точек.

## Deferred from: review of story-10.3 (2026-07-10)

- source_spec: `_bmad-output/implementation-artifacts/spec-10-3-bagfiks-grounding-flag-smesheniya-klientov.md`
  summary: Второй `/draft` пока `companyMismatchPending` активен перезаписывает `pendingMismatchDraft` без предупреждения.
  evidence: `buildF0Draft` не проверяет `session.companyMismatchPending` в начале; при повторном вызове новый `result` молча заменяет первый pending. Узкое окно (нужно дважды нажать /draft за секунды), но потеря черновика безмолвна. Решение: guard в начале `buildF0Draft` — если `session.companyMismatchPending` → ℹ️ «Уже ждёт подтверждения (cmi_proceed/cmi_cancel)».

- source_spec: `_bmad-output/implementation-artifacts/spec-10-3-bagfiks-grounding-flag-smesheniya-klientov.md`
  summary: Нет structured-логирования при обнаружении mismatch и при cmi_proceed/cmi_cancel.
  evidence: Все значимые события F0 пишут `f0Log.info` — mismatch detection, confirm, cancel не пишут ничего. Невозможен post-mortem анализ случаев смешения клиентов в продакшне. Решение: `f0Log.warn({ step: 'company_mismatch', extracted, profile, chatId }, ...)` + `f0Log.info({ step: 'cmi_proceed/cancel', chatId }, ...)`.

- source_spec: `_bmad-output/implementation-artifacts/spec-10-3-bagfiks-grounding-flag-smesheniya-klientov.md`
  summary: Import-path (`buildF0DraftFromImport`) не проходит через mismatch-проверку и не покрыт assertive тестом на это.
  evidence: По дизайну (spec: «import path не проверяется — нет LLM-извлечённого company»), но намерение нигде не задокументировано тестом. Если `F0ImportResult.extraction.company` когда-либо заполнится при импорте xlsx — баг станет незаметным. Решение: добавить тест «import path + mismatched company → нет mismatch-диалога» как assertive regression guard.

## Deferred from: review of story-10.4 (2026-07-10)

- source_spec: `_bmad-output/implementation-artifacts/spec-10-4-bagfiks-xlsx-realnyy-fayl-arb-v1-1.md`
  summary: Потенциальная prefix-коллизия синонима `'тип'` → objective при заголовке `'тип операции'`.
  evidence: Синоним `'тип'` точный (exact-pass только), поэтому `'тип операции'` не захватывается сейчас. Но если в будущем в другой категории добавят prefix-синоним `'тип'` — коллизия возникнет. Риск pre-existing паттерн, не введён этой историей. Триггер: расширение KR_COLUMN_SYNONYMS новыми prefix-синонимами с `'тип'`. Решение: при добавлении новых синонимов проверять prefix-пересечения.

- source_spec: `_bmad-output/implementation-artifacts/spec-10-4-bagfiks-xlsx-realnyy-fayl-arb-v1-1.md`
  summary: Нет бинарной фикстуры реального ARB Solutions v1.1 файла в тестах — фикстура синтетическая.
  evidence: Реальный файл в `/mnt/c/Users/Timur/Downloads/ARB Solutions Стратегический трекер v1.1 (1).xlsx` — не в репозитории. Prod-логи подтверждают `import_unmappable` до фикса. Синтетическая фикстура покрывает структуру и маппинг, но не binary edge-кейсы (merged cells, hidden rows, conditional formatting). Триггер: клиентский файл ARB-формата с нестандартным форматированием. Решение: добавить минимальный бинарный .xlsx в `src/fixtures/` при следующем ARB-баге.

- source_spec: `_bmad-output/implementation-artifacts/spec-10-5-treker-gipotez-tretiy-tip-otchyota.md`
  summary: Удалённые гипотезы (присутствующие в снимке, но отсутствующие в текущем листе) не отображаются в дельта-отчёте.
  evidence: `computeDelta` итерирует только `current` и смотрит в `snapshotMap`; обратный проход (snapshot → current) не выполняется. Пользователь, удаливший гипотезу из листа, не увидит этого в отчёте. Spec не требует `removed` секцию, но это реальный информационный gap для трекера.

- source_spec: `_bmad-output/implementation-artifacts/spec-10-5-treker-gipotez-tretiy-tip-otchyota.md`
  summary: Снимок перезаписывается каждый запуск; повторный запуск в ту же неделю после изменений сбрасывает дельту следующей недели.
  evidence: Если трекер нажимает кнопку дважды в одну неделю после изменения статуса, второй снимок совпадает с текущим листом → на следующей неделе дельта будет пустой. Single-file overwrite без weekNumber-guard. Требует редизайна (weekNumber guard или история снимков) для устранения.

- source_spec: `_bmad-output/implementation-artifacts/spec-10-5-treker-gipotez-tretiy-tip-otchyota.md`
  summary: `alertOps` не вызывается в `runHypoTracker` при HALT-ошибках чтения листа.
  evidence: При `SheetsAdapterError` с кодом `auth`/`sheet_not_found`/`header_missing` pipeline выбрасывает plain `Error`; `alertOps` уже был вызван внутри адаптера, но pipeline-уровень не добавляет собственный alert. Контраст с F1-pipeline, который вызывает `alertOps` на всех fatal path.

- source_spec: `_bmad-output/implementation-artifacts/spec-10-5-treker-gipotez-tretiy-tip-otchyota.md`
  summary: Bot handler не пробрасывает `deps.now` в `runHypoTracker`, что усложняет детерминированное тестирование через `BotDeps`.
  evidence: `now` инжектируется через `BotDeps` и используется в weekly-handler напрямую; hypo_tracker handler вызывает `runHypoTracker({ clientId, clientName })` без `now`. Pipeline вызывает `new Date()` внутри. BotDeps-тесты не могут контролировать week/year внутри pipeline.

- source_spec: `_bmad-output/implementation-artifacts/spec-10-5-treker-gipotez-tretiy-tip-otchyota.md`
  summary: `splitForTelegram` прикрепляет inline keyboard ко всем чанкам многочастного сообщения, а не только к последнему.
  evidence: `for (const msg of splitForTelegram(text)) { await ctx.reply(msg, { reply_markup: kb }) }` — kb дублируется на каждом сообщении. Pre-existing паттерн из `weekly:` handler. Косметический дефект при длинных отчётах.

## Deferred from: spec-10-8-treker-gipotez-struktura-geonline.md (review 2026-07-10)

- source_spec: `_bmad-output/implementation-artifacts/spec-10-8-treker-gipotez-struktura-geonline.md`
  summary: `computeDelta` не отслеживает удалённые гипотезы — гипотеза, исчезнувшая из листа, не показывается в отчёте.
  evidence: `DeltaResult` содержит только `changed` и `added`; нет `removed`. Колонка Δ в сводной матрице считает только addedCount. Pre-existing из 10.5.

- source_spec: `_bmad-output/implementation-artifacts/spec-10-8-treker-gipotez-struktura-geonline.md`
  summary: Per-department «Ответственный» и «Метрики» строки из оригинального backlog spec не вошли в структурный форматтер.
  evidence: Оригинальный backlog spec 10.8 упоминал "Строка Ответственный: имя · Метрики: ключевые цифры" per dept. В ready-for-dev spec и форматтере эти строки отсутствуют — были депримированы при планировании.

- source_spec: `_bmad-output/implementation-artifacts/spec-10-8-treker-gipotez-struktura-geonline.md`
  summary: Неизвестный статус гипотезы рендерится как '⬜' без warn-лога — тихий fallback не диагностируем.
  evidence: `statusEmoji()` returns `STATUS_EMOJI[norm] ?? '⬜'` без loggin. Статусы вне маппинга (архив, пауза, custom) не видны в логах.

- source_spec: `_bmad-output/implementation-artifacts/spec-10-8-treker-gipotez-struktura-geonline.md`
  summary: Только `header_missing` тестируется как HALT-условие; `auth` и `sheet_not_found` покрывают ту же ветку кода, но без явных тестов.
  evidence: `runHypoTracker — header_missing` test покрывает один из трёх HALT-кодов. Остальные два тестируются имплицитно (та же ветка), но явного теста нет.

## Deferred from: spec-10-8-treker-gipotez-struktura-geonline.md (review 2026-07-10, follow-up pass)

- source_spec: `_bmad-output/implementation-artifacts/spec-10-8-treker-gipotez-struktura-geonline.md`
  summary: Нет диагностического лога когда все F1-отчёты за неделю оказались partial и `f1ReportsText` пустой — деградация незаметна в логах.
  evidence: `loadWeekReports` возвращает отчёты, но `PartialDeliveryReport` имеет `sections: []`. Лог Step 5 пишет `count: N`, не указывая, что текст = ''. Производительные инциденты будут неотличимы от сценария «встреч не было».

- source_spec: `_bmad-output/implementation-artifacts/spec-10-8-treker-gipotez-struktura-geonline.md`
  summary: `HypoTrackerConclusionsSchema` и `HypoTrackerConclusions` — мёртвый код в `src/types.ts` после миграции F5 на `HypoStructuredInsightsSchema` (10.8).
  evidence: Поиск по кодовой базе показал, что `HypoTrackerConclusionsSchema` / `HypoTrackerConclusions` импортируются только в `src/types.ts` (как экспорт) — ни один другой файл их не использует после переименования в `src/f5-hypo-tracker.ts`.

- source_spec: `_bmad-output/implementation-artifacts/spec-10-8-treker-gipotez-struktura-geonline.md`
  summary: Нет интеграционного теста `runHypoTracker` для сценария «первый запуск с непустым листом (≥2 департамента)» — AC покрыт только на уровне pure-функции `formatHypoReportStructured`.
  evidence: Тесты A–D в `f5-hypo-tracker.test.ts` тестируют форматтер напрямую. Тест 4 (empty sheet) и Тест 5 (no changes) тестируют pipeline, но с одной гипотезой без snap. Сценарий «первый запуск, ≥2 dept, `full` содержит все гипотезы в «Новые» таблицах» не проходит через `runHypoTracker`.

## Deferred from: review of story-10.7 (2026-07-10)

- source_spec: `_bmad-output/implementation-artifacts/spec-10-7-kosmetika-marker-klienta-privetstvie-dliny.md`
  summary: `firstWord` collision — два владельца с одинаковым первым словом (напр. «Иван Петров» и «Иван Сидоров») получают одно и то же имя листа `👤 Иван`, что ведёт к объединению их персональных листов.
  evidence: Дизайн `firstWord(s.split(' ')[0])` намеренно выбран в spec (Design Notes) с осознанным ограничением; риск материализуется только при наличии двух топов с одинаковым именем в одном клиенте. Триггер: онбординг клиента с однофамильцами. Решение: использовать первые два слова (`split(' ').slice(0,2).join(' ')`) или уникальный суффикс при коллизии.

- source_spec: `_bmad-output/implementation-artifacts/spec-10-7-kosmetika-marker-klienta-privetstvie-dliny.md`
  summary: Неразрывный пробел (`\u00A0`) в имени владельца не разбивается `split(' ')` — `'Иван\u00A0Петров'.split(' ')` возвращает `['Иван\u00A0Петров']` (одно слово), лист называется `👤 Иван\u00A0Петров`.
  evidence: Pre-existing ограничение `String.prototype.split(' ')` — обрабатывает только ASCII-пробел. На практике имена из Sheets/профиля используют обычный пробел. Триггер: copy-paste имени с неразрывным пробелом из внешней системы. Решение: нормализовать через `/\s+/` вместо `' '` в `firstWord`.

- source_spec: `_bmad-output/implementation-artifacts/spec-10-7-kosmetika-marker-klienta-privetstvie-dliny.md`
  summary: `f0_cancel_stuck_no` callback (кнопка «↩️ Продолжить» в предупреждении о залипшей сессии) не имеет теста — тривиальный handler, только `answerCallbackQuery`.
  evidence: Handler добавлен для предотвращения ошибки «no handlers» при нажатии кнопки; единственное наблюдаемое поведение — spinner исчезает. Низкий риск, stub-функциональность. Триггер: если handler когда-либо изменится. Решение: добавить тест при расширении функциональности кнопки.

## Deferred from: review of story-11.1 (2026-07-13)

- source_spec: `_bmad-output/implementation-artifacts/spec-11-1-globalnyy-obrabotchik-oshibok-i-graceful-audio-20mb.md`
  summary: Тест `bot.catch` вызывает `created.bot.errorHandler` как приватное API grammY — при переименовании в версии grammY тест скомпилируется, но упадёт в рантайме.
  evidence: `(created.bot as unknown as { errorHandler: ... }).errorHandler(err)` — грязный каст к внутреннему свойству. Альтернатива: добавить отдельный assertion `expect(typeof (created.bot as any).errorHandler).toBe('function')` сразу после createBot, либо убедиться, что grammY экспортирует публичный метод доступа к зарегистрированному обработчику.

- source_spec: `_bmad-output/implementation-artifacts/spec-11-1-globalnyy-obrabotchik-oshibok-i-graceful-audio-20mb.md`
  summary: В `bot.catch` нет теста сценария, когда `err.ctx.reply` сам бросает исключение — guard `.catch(()=>{})` поглощает ошибку без следа в логах.
  evidence: Производственный хендлер вызывает `err.ctx.reply(...).catch(() => {})`. Если reply падает (нет чата, rate-limit, ошибка grammY) — ни лога, ни alertOps. Риск низкий (silencing по паттерну всего codebase), но для полноты стоит верифицировать что warn-лог в `.catch()` добавлен при следующей правке хендлера.

- source_spec: `_bmad-output/implementation-artifacts/spec-11-1-globalnyy-obrabotchik-oshibok-i-graceful-audio-20mb.md`
  summary: `err.ctx.reply` failure в `bot.catch` полностью поглощается без warn — ops не узнают о двойном сбое (ошибка хендлера + невозможность уведомить пользователя).
  evidence: `.catch(() => {})` без log внутри. Паттерн унаследован из codebase, но именно в `bot.catch` это особенно ощутимо: если и reply падает, пользователь видит зависание без ответа, а ops получает только первичный alertOps без упоминания reply failure.


- source_spec: `_bmad-output/implementation-artifacts/spec-11-2-ustoychivyy-parser-otchyota-pustoy-owner.md`
  summary: parseStakeholders не имеет logger-параметра в отличие от parseOkrs и parseF5Metrics — асимметрия накопилась после добавления log в parseOkrs (story 11.2)
  evidence: parseF5Metrics (строка 632) и parseOkrs (после 11.2) принимают log; parseStakeholders — нет. Если потребуется warn-логирование при парсинге stakeholders, придётся добавлять log ещё раз.

- source_spec: `_bmad-output/implementation-artifacts/spec-11-2-ustoychivyy-parser-otchyota-pustoy-owner.md`
  summary: Сентинел «—» используется как строковый литерал в трёх местах (f0-sheets.ts, f0-grounding.ts, sheets.ts) без общей константы — риск расхождения при опечатке
  evidence: Три места: mapOkrRows (write), parseOkrs (read), groundedOkrRows (guard) — все сравнивают/присваивают '—' независимо; en-dash vs hyphen не проверяется.

- source_spec: `_bmad-output/implementation-artifacts/spec-11-2-ustoychivyy-parser-otchyota-pustoy-owner.md`
  summary: Тест на parseOkrs не проверяет, что log.warn вызывается при пустом owner — операционная наблюдаемость не покрыта тестом
  evidence: Тест проверяет только итоговое значение ctx.okrs[0]?.owner === '—'; удаление log.warn из parseOkrs не сломает тест.

- source_spec: `_bmad-output/implementation-artifacts/spec-11-3-rasshit-klientskie-tablicy-na-servis-akkaunt.md`
  summary: loadServiceAccountCredentials() в createClientSpreadsheet выбрасывает TranscriptConfigError без обёртки в mapGoogleError — ошибка JSON-файла SA не оборачивается в share_failed
  evidence: В production-пути при isGoogleOAuthConfigured()===true: если SA JSON отсутствует/некорректен, loadServiceAccountCredentials() бросает TranscriptConfigError напрямую; catch в блоке permissions.create не достигается; вызывающий код видит TranscriptConfigError вместо F0SheetsError('share_failed').

- source_spec: `_bmad-output/implementation-artifacts/spec-11-3-rasshit-klientskie-tablicy-na-servis-akkaunt.md`
  summary: Read-пайплайны F1/F5 не верифицированы интеграционно после расшивки — fix на write-side не имеет сквозного теста, подтверждающего отсутствие 403
  evidence: Все тесты story 11.3 работают на unit-уровне (mock Drive); реальная проверка что SA получает доступ и readClientContext/readHypothesesSheet проходят без 403 на новом клиенте — только в live-run.

- source_spec: `_bmad-output/implementation-artifacts/spec-11-3-rasshit-klientskie-tablicy-na-servis-akkaunt.md`
  summary: Нет теста специфично для сбоя drive.permissions.create в SA-блоке — только tracker-failure path покрыт
  evidence: Существующий тест failPerm (line 655) делает makeDrive({ failPerm }) — но с vi.mock default (isGoogleOAuthConfigured=false) SA-блок пропускается, первый permissions.create — трекер. Если SA catch-блок заменить на swallow, тест не сломается.

- source_spec: `_bmad-output/implementation-artifacts/spec-11-4-klassifikaciya-oshibok-claude-api.md`
  summary: "'too long' в classifyClaudeApiError — широкая подстрока, потенциально совпадает с несвязанными 400-сообщениями (только при httpStatus=400, риск низкий)"
  evidence: lowerMsg.includes('too long') совпадёт с любым 400-сообщением содержащим эти слова, не только с context-length. Текущий Anthropic API даёт 'prompt is too long' для context-limit, но это недокументированная строка.

- source_spec: `_bmad-output/implementation-artifacts/spec-11-4-klassifikaciya-oshibok-claude-api.md`
  summary: "Нет bot-level теста для пути anthropicErrorType (overloaded_error/rate_limit_error) — только unit-тест классификации"
  evidence: bot.test.ts покрывает rate_limit через httpStatus 429/529, но не через anthropicErrorType-поле.

- source_spec: `_bmad-output/implementation-artifacts/spec-11-4-klassifikaciya-oshibok-claude-api.md`
  summary: "billing и overloaded_error/rate_limit не различаются в alertOps — оператор не видит разницу между кредитным блоком и rate-limit в ops-системе"
  evidence: alertOps вызывается перед classifyClaudeApiError; в ops-alert всегда step='f0.draft_failed', kind не передаётся.

- source_spec: `_bmad-output/implementation-artifacts/spec-11-4-klassifikaciya-oshibok-claude-api.md`
  summary: "Forward-compatibility: billing определяется по substring в message, не по structured anthropicErrorType — если Anthropic добавит billing_error type, классификатор его не поймает"
  evidence: Anthropic API не имеет специфического error.type для billing; классификация строится на message-строке (fragile по определению).

- source_spec: `_bmad-output/implementation-artifacts/spec-11-5-llm-ekstrakciya-uchastnika-profilya-a3.md`
  summary: "extractTopWithLlm: parsed=null (Zod-ошибка) и prompt_load failure поглощаются без лога — систематический сбой промпта был бы невидим в продакшне"
  evidence: В default extractTopWithLlm при callClaudeSafe → parsed:null нет warn/info; при prompt_load failure catch { silent } не логирует F1PipelineError('prompt_load'). Fallback работает корректно, но диагностика отсутствует.

- source_spec: `_bmad-output/implementation-artifacts/spec-11-5-llm-ekstrakciya-uchastnika-profilya-a3.md`
  summary: "Нет теста для пути parsed=null (callClaudeSafe 200 OK, но Zod-валидация провалилась) внутри default extractTopWithLlm"
  evidence: Все тесты Story 11.5 инжектируют mock extractTopWithLlm целиком; внутренний путь 'if (result.parsed !== null)' в default-реализации не покрыт ни одним тестом. Требует module-level mocking callClaudeSafe или отдельного unit-теста default функции.

## Deferred from: review of story-11.6 (2026-07-13)

- source_spec: `_bmad-output/implementation-artifacts/spec-11-6-kompaktnaya-dostavka-chernovika-onbordinga.md`
  summary: "Все 1 KR считаемы." — грамматическая ошибка number-agreement в Russian ("Все 1" вместо числового согласования)
  evidence: Строка `✅ Все ${totalKrs} KR считаемы.` существовала до Story 11.6; при totalKrs=1 получается "Все 1 KR считаемы." — "все" требует множественного числа. Pre-existing паттерн, не введён этой историей.

- source_spec: `_bmad-output/implementation-artifacts/spec-11-6-kompaktnaya-dostavka-chernovika-onbordinga.md`
  summary: `expect(msg).not.toContain('🔴')` в тесте "все KR считаемы" — слишком широкий assertion; сломается если будущая ветка легитимно использует 🔴 для не-error сигнала
  evidence: Тест проверяет только что при krIssues=[] и hypothesisIssues=[] нет 🔴. Если добавится новая категория (например, предупреждение с 🔴 о synthesized hypotheses при нулевых issues), тест упадёт ложно. Low risk на текущем codebase.

## Deferred from: code review of story-11-7 (2026-07-13)

- source_spec: `_bmad-output/implementation-artifacts/spec-11-7-gotovyy-transkript-na-otchyot.md`
  summary: `transcriptText` has no upper-bound length validation before enqueueing — a 20 MB .txt file (within F0_MAX_FILE_BYTES) could be stored in-memory as job.transcriptText
  evidence: The routing block reuses F0_MAX_FILE_BYTES as the size guard; a file near that limit produces a large in-memory string in the job queue. Design choice inherited from F0_MAX_FILE_BYTES; low risk on current data volumes.

- source_spec: `_bmad-output/implementation-artifacts/spec-11-7-gotovyy-transkript-na-otchyot.md`
  summary: `estimatedPosition` in `handleMeetingTextTranscript` is sampled before ctx.reply, so the shown queue position may be stale by the time enqueue runs
  evidence: Pre-existing pattern from `handleMeetingFileIntake` (audio/video intake); same race exists there. Not introduced by Story 11.7.

- source_spec: `_bmad-output/implementation-artifacts/spec-11-7-gotovyy-transkript-na-otchyot.md`
  summary: AC "F0-сессия остаётся нетронутой" has no integration test — no test writes an F0 session then verifies it is intact after transcript routing
  evidence: Code provably cannot modify the session (early return before getOrRestoreF0Session), but the AC is not pinned by any test. Low risk; code inspection sufficient.
