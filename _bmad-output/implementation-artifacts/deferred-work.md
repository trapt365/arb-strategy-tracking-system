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
- **Sheets write-side adapter (F5 metrics, ops logs)** — Story 1.3 покрывает только read. Append/write для ops logs (Story 1.9) и F5 manual entry (Story 1.10) добавят `appendRow` / `writeF5Metric` с обратной конверсией `camelToSnake`.

## Deferred from: implementation of story-1.4a (2026-04-30)

- **Claude circuit breaker (3 fail/5 min → fallback)** — на 1.4a `src/adapters/claude.ts:isClaudeCircuitOpen()` всегда возвращает `false` (заглушка). Caller-логика (Story 1.5 telegram bot) не реализует ветвь fallback. Триггер: первая прод-инцидентная серия 5xx от Anthropic API. Story 1.9 заменит тело + добавит state (in-memory счётчик с TTL).
- **Auto-cleanup `*.raw.txt` через 14 дней** — `data/{clientId}/{date}/f1-*.{step}.raw.txt` накапливаются без TTL. На MVP первого месяца disk usage <100 MB. Триггер: Story 1.9.x. Решение: cron-задача `find data/ -name '*.raw.txt' -mtime +14 -delete` или scheduled component.
- **Smart transcript trimming для context_length_exceeded** — на длинных встречах (> 90 мин транскрипт) Claude может вернуть `context_length_exceeded`. На 1.4a — fail с понятным сообщением (не retryable). Триггер: первая такая встреча в проде. Решение: умная нарезка по segments + map-reduce summarize.
- ~~**Запись/обновление статусов commitments в data/** — Story 1.4a реализует только чтение open commitments (`src/utils/commitments-history.ts`); analysis возвращает `commitments_status_updates`, но caller их НЕ применяет к источнику истины. Story 1.4b/1.10 добавит persistence-слой с записью `status: 'open'|'completed'|'overdue'`.~~ **PARTIALLY CLOSED 2026-04-30 (Story 1.4b):** `runF1Steps34` записывает `commitments-updates.json` overlay-файл (audit trail). **Source-of-truth update в `*.extraction.json`** ВСЁ ЕЩЁ deferred — append-only invariant сохранён в 1.4b; `loadOpenCommitments` (1.4a) пока НЕ читает overlay. Полная интеграция — Story 1.10.
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

- **Auto-cleanup `*.format.raw.txt` через 14 дней** — analogично 1.4a deferred для `.extraction.raw.txt` / `.analysis.raw.txt`; теперь `*.format.raw.txt` тоже накапливается. Триггер: Story 1.9.x (один cron на все `*.raw.txt`).
- **Auto-cleanup `*.report.json` / `*.commitments-updates.json`** — на MVP retention неограничен; для GDPR-compliant offboarding (Story 1.10) нужен retention policy. Триггер: 2-й клиент или legal review.
- **Полный persistence-слой commitments (read+update в источнике истины + интеграция overlay в `loadOpenCommitments`)** — Story 1.4b записывает `commitments-updates.json` overlay, но `loadOpenCommitments` пока НЕ учитывает их при чтении прошлых extraction'ов. Story 1.10 интегрирует: либо merge overlay при чтении, либо мигрирует на PostgreSQL и убирает overlay-файлы.
- **Telegram rendering: `formatHeader()`, `approveKeyboard()`, message split > 4096** — Story 1.5/1.6. На 1.4b возвращается `DeliveryReadyReport` объект; сериализация в Telegram-сообщение делает bot.ts.
- **Smart transcript trimming для context_length_exceeded на шаге 3** — формат-промпт получает `extractionOutput` + `analysisOutput` + `commitmentsBefore` + `alerts` → на длинных встречах payload может разрастись. На 1.4b — fail с partial result. Триггер: первый `context_length_exceeded` на шаге 3 в проде.
- **F3-lite formatting (`format-ceo.md` промпт)** — Epic 4. Не пересекается с 1.4b.

## Deferred from: code review of story-1.1 (2026-04-21)

- `/health` строгое матчинг URL — `/health?x=1`, `/health/`, `/HEALTH` дают 404. Docker internal probe работает на точном `/health`; внешние probe придут в Story 1.14 (Hostinger VPS deploy).
- `TZ` в Zod схеме — `z.string().default('Asia/Almaty')` без `.refine` через `Intl.DateTimeFormat` — Node молча падает на UTC при невалидной зоне. Hardening, не блокер.
- ~~`GOOGLE_SERVICE_ACCOUNT_JSON` — относительный путь; Zod проверяет только непустую строку, не существование файла. Sheets adapter в Story 1.3 сам упадёт при отсутствии файла — FS-проверка переедет туда.~~ **CLOSED 2026-04-30 (Story 1.3):** валидация существования файла + JSON-shape перенесена в `loadServiceAccountCredentials()` (`src/utils/google-auth.ts`); используется в `drive.ts` и `sheets.ts`.
- `src/config.ts` вызывает `loadConfig()` + `process.exit(1)` на module top-level → любой импортёр не может быть unit-тестирован без реальных env. Тестовая инфраструктура появится в Story 1.11 (canary + golden dataset).
- `startTime = Date.now()` в `src/server.ts` захвачен на import, а не на `listen()`. Для singleton разница невидима.
- AC #5 не имеет явного теста, подтверждающего паттерн `logger.child({pipeline, step, clientId})` — тесты придут со Story 1.11.

## Deferred from: code review of story-1.4a (2026-05-15)

- **Task 10.10 — regression test против `data/golden/transcript-N.json` + `f1-reference-N.json`** — pure 1.4a тесты используют тип-фикстуры. Триггер: Story 1.11 (canary test).
- **`deps.now` инъекция не пробрасывается во все `Date.now()` calls в `src/f1-report.ts`** — Task 6.5 объявил deps.now, использован только в `loadOpenCommitments`. SLA-тест может использовать `vi.useFakeTimers`. Полный рефакторинг — отдельная задача.
- **`persistStep` записывает `.raw.txt`, потом `.json` — silent loss `extraction.json` при ENOSPC между ними** (`src/f1-report.ts:122-129`). Warn-only design (spec AC #8). Триггер: Story 1.9 (ops + retry-on-persist-fail).
- **`commitments-history` maxAgeDays cutoff в UTC vs локальный TZ — off-by-5h** (`src/utils/commitments-history.ts:54`). На Asia/Almaty (+05) граничный день может отрезаться неверно. Effect: ≤1 встреча на квартал. Триггер: ощутимое расхождение в проде.
- **Memory pressure при > 100k char транскриптах** — `JSON.stringify(extraction, null, 2)` + transcript text в памяти. Acceptable для MVP (≤90 мин). Триггер: 4-часовые сессии или multi-client batch.
- **Smoke-script CWD-relative paths и `??=` для metadata** (`scripts/f1-smoke.ts`). Manual-tool design; ломается только при запуске не из project-root. Acceptable.
- **`topNameSlug` collision для разных топов с одинаковым именем** (`src/utils/commitments-history.ts:20-26`). При 2-х топах со слагом `жанель` дедуп `who+what+deadline` смешает истории. MVP-limit (1 клиент с уникальными именами). Триггер: 2-й клиент ИЛИ дубликат slug в `stakeholders[]` одного клиента. Решение: добавить `clientId` в dedup-key или валидировать уникальность slug на readClientContext.
- **`reportId = randomUUID().slice(0, 8)` — 32-bit collision risk** (`src/f1-report.ts:227`). Same-day rerun overwrite вероятность ~1/4B; статистически невозможна на 5 встречах/нед в MVP. Триггер: переход на batch-pipeline (Story 3.0/Scheduler) или auditable filename-collision logs.
