# Story 1.4a: F1 извлечение и анализ (шаги 1-2)

Status: done

## Пользовательская история

Как **коуч практики (Азиза)**,
Я хочу **получить структурированные данные встречи (факты, решения, цитаты, обязательства, OKR-покрытие, статус гипотез) из транскрипта и контекста клиента**,
Чтобы **на следующих шагах (Story 1.4b) форматирование собрало готовый отчёт без ручного написания, а accountability-ядро (commitments + цитаты) работало с Day 1**.

## Контекст и границы scope

**Что входит в Story 1.4a (production-код в `src/`):**

- `src/adapters/claude.ts` — провайдер-агностичный wrapper над `@anthropic-ai/sdk` (~120 LOC): `callClaude(prompt, opts)` → возвращает `{ raw, parsed }`, обёрнутый в `withRetry({1s, 3s, 9s})` + `parseClaudeJSON(raw, ZodSchema)` + circuit breaker stub (флаг — реализация в Story 1.9 при необходимости; на 1.4a — заглушка с правильной сигнатурой).
- `src/utils/prompt-loader.ts` — `loadPrompt(name, vars)` (~30 LOC): читает `prompts/{name}.md` (async через `fs.promises.readFile`), заменяет `{{camelCase}}` плейсхолдеры из `vars`, **throws** на любые незаменённые `{{var}}` (fail-fast).
- `src/f1-report.ts` — F1 pipeline шаги 1-2 (~250 LOC из ~350 общего бюджета архитектуры): `runF1Steps12({transcript, clientContext, meta, deps})` → `{ extraction: ExtractionOutput, analysis: AnalysisOutput, rawResponses, openCommitmentsBefore }`. Шаги 3-4 — Story 1.4b расширит этот же файл функцией `runF1Steps34(...)` или экспортирует общий `runF1({...})`.
- `src/types.ts` — расширение: `ExtractionOutputSchema`, `AnalysisOutputSchema`, типы `ExtractionOutput`, `AnalysisOutput`, `Commitment`, `Citation`, `OkrCoverageItem`, `HypothesisItem`. **Контракт:** `ExtractionOutput → AnalysisInput`. Schema = source of truth.
- `src/errors.ts` — расширение: `F1PipelineError` (коды: `prompt_load | claude_api | claude_response_invalid | extraction_validation | analysis_validation | persist`).
- `src/utils/commitments-history.ts` — `loadOpenCommitments(clientId, topName, deps)` (~40 LOC): читает все `data/{clientId}/*/f1-*-{topName}-*.json`, фильтрует commitments со статусом `open` (или без статуса = open по умолчанию), возвращает `{ openCommitments: Commitment[], sourceFiles: string[] }`. **Source of truth персистентности — Story 1.10**; 1.4a реализует MVP-чтение из локальных JSON (append-only backup) для разблокировки accountability-логики; запись commitments-status — в Story 1.4b/1.10.
- `src/config.ts` — расширение: `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`), `CLAUDE_MAX_TOKENS` (default `8192`), `CLAUDE_TIMEOUT_MS` (default `120000`). `ANTHROPIC_API_KEY` уже есть (Story 1.1).
- Persistence (Day-1 fix #5 из architecture#hindsight): после успешных шагов 1-2 сохранять `data/{clientId}/{YYYY-MM-DD}/f1-{topName}-{id}.extraction.json`, `*.analysis.json`, `*.extraction.raw.txt`, `*.analysis.raw.txt`. ID генерируется через `crypto.randomUUID()` (короткий слайс) ИЛИ из `transcript.metadata.date + topName`. Auto-cleanup `.raw.txt` через 14 дней — **deferred Story 1.9** (только запись в 1.4a).
- Unit-тесты: `src/adapters/claude.test.ts`, `src/utils/prompt-loader.test.ts`, `src/utils/commitments-history.test.ts`, `src/f1-report.test.ts`. Mocks: `@anthropic-ai/sdk` через `vi.mock`, fs через `vi.mock('node:fs/promises')` или временные директории через `os.tmpdir()`. Использовать golden-фикстуры из `data/golden/` (transcript-1..7.json + f1-reference-1..7.json) для regression-тестов извлечения/анализа.
- Smoke-test `npm run f1:smoke` — manual run на одном `data/golden/transcript-N.json` + реальный `ANTHROPIC_API_KEY` + `data/stakeholder-map.json` + `data/okr-context.json`. **Не запускается в CI.**

**Что НЕ входит (следующие stories):**

- **Шаги 3-4 (formatting + delivery prep)** — Story 1.4b. На 1.4a промпты `format-tracker.md` НЕ загружаются, `runF1Steps34` НЕ существует. Финальный `Report` объект не собирается. Точка контракта между 1.4a и 1.4b: типизированный `AnalysisOutput` + `ExtractionOutput` сохранены в JSON и передаются in-process из шагов 1-2 в 3-4.
- **Telegram /report команда + progress updates** — Story 1.5. На 1.4a `runF1Steps12` вызывается из smoke-script или unit-тестов, не из бота.
- **Approval workflow approve/edit/reject** — Story 1.6.
- **Delivery (доставка готового текста Азизе для пересылки)** — Story 1.7.
- **Update commitments status (закрытие выполненных, mark overdue)** — Story 1.4b добавит запись новых commitments + перезапись статусов прошлых. На 1.4a: только **чтение** open commitments + передача их в analysis prompt как контекст. Анализ возвращает обновлённый статус, сохранение статуса в источник — 1.4b.
- **Canary test + golden dataset diff** — Story 1.11. На 1.4a golden-фикстуры используются как **тестовый input**, но diff-метрики и threshold 30% — отдельная stoка.
- **Circuit breaker (3 failures in 5 min → fallback)** — на 1.4a stub-API/прокси (boolean флаг + no-op `isCircuitOpen()` всегда `false`). Полная реализация — Story 1.9 (Ops + alerts).
- **Sheets latency optimization, кэширование `ClientContext`** — Story 1.3 уже реализует batch read; 1.4a вызывает `readClientContext()` 1 раз перед шагами 1-2 и передаёт результат в обе step-функции (NB: Day-1 fix #3 batch read per pipeline run).
- **Auto-cleanup `.raw.txt` через 14 дней** — Story 1.9.

## Критерии приёмки

1. **Сценарий: Шаги 1-2 на валидном транскрипте + ClientContext возвращают валидный `{extraction, analysis}`** (FR1, FR2, FR3, FR4, FR5)
   ```
   Дано Transcript (валидирован TranscriptSchema, Story 1.2) с ≥ 1 спикером и сегментами
     И ClientContext (валидирован ClientContextSchema, Story 1.3) со stakeholders ≥ 1, okrs ≥ 1
     И meta = { clientId: 'geonline', topName: 'Жанель', meetingDate: ISO, meetingType: 'tracking_session' }
   Когда вызывается runF1Steps12({ transcript, clientContext, meta, deps })
   Тогда выполняется loadPrompt('extraction', { transcript: <formatted>, stakeholderMap: <serialized> })
     И callClaude(prompt, { stepName: 'extraction', model, maxTokens, schema: ExtractionOutputSchema, signal? })
       возвращает { raw: string, parsed: ExtractionOutput }
     И extraction.commitments — массив объектов { who, what, deadline, quote } (см. AC #3)
     И extraction.citations — массив объектов { timestamp: number, speaker: string, text: string }
     И extraction.facts — массив строк
     И extraction.decisions — массив строк
     И extraction.speaker_check — массив строк (имена спикеров, требующих ручной проверки)
     И ExtractionOutputSchema.parse() прошла успешно (fail-fast при schema violation)
   И затем выполняется loadPrompt('analysis', { okrContext: <serialized okrs>, extractionOutput: JSON.stringify(extraction, null, 2), stakeholderMap: <serialized>, openCommitments: <serialized> })
     И callClaude возвращает { raw, parsed: AnalysisOutput } через AnalysisOutputSchema.parse()
     И analysis.okr_coverage — массив { kr, status: 'discussed'|'mentioned'|'blind_zone', mentions_count: number, substance: boolean } по КАЖДОМУ KR из ClientContext.okrs
     И analysis.hypothesis_status — массив { hypothesis, status: 'idea'|'in_test'|'result', evidence: string[] }
     И analysis.alerts — массив строк (anomalies, blind zones, контракты без сроков, speaker_check redirects)
     И возврат: { extraction, analysis, rawResponses: { extraction: string, analysis: string }, openCommitmentsBefore: Commitment[] }
   ```

2. **Сценарий: Прогон через `loadPrompt()` — без inline template-literal промптов** (architecture enforcement #1, #7)
   ```
   Дано prompts/extraction.md и prompts/analysis.md существуют (Story 0.3 v1.0.0, валидированы)
   Когда runF1Steps12 готовит промпт
   Тогда вызывается loadPrompt(name, vars), который:
     a. читает prompts/{name}.md через fs.promises.readFile (async, не readFileSync — урок Story 1.2 IWE)
     b. заменяет {{key}} → vars[key] для каждой пары
     c. на любой оставшийся {{...}} → throws Error('Незаменённые переменные в промпте "extraction": {{transcript}}, ...')
     d. результат — ready-to-send строка, никакой `${...}` template literal в .ts коде не используется
   И grep "claude.messages.create" покрывает только src/adapters/claude.ts
     И grep "anthropic\\.messages\\.create" вне src/adapters/claude.ts → 0 результатов
     И grep -rE 'const\\s+\\w+\\s*=\\s*`[^`]*\\{\\{' src/ (inline-промпт с {{vars}} в .ts) → 0 результатов
   ```

3. **Сценарий: Commitments извлекаются по правилам examples/commitments-positive.md и -negative.md** (FR3, accountability)
   ```
   Дано extraction.commitments[] возвращён Claude
   Когда проверяются правила
   Тогда КАЖДЫЙ commitment имеет ВСЕ поля: who (string, non-empty), what (string, non-empty), deadline (string — может быть "не указан"), quote (string с timestamp [MM:SS] или [MM:SS-MM:SS])
     И НЕ извлекаются: размытые ("надо бы"), условные не выполненные ("если X"), общие направления ("нужно увеличивать"), факты прошлого, предложения без подтверждения
     И ИЗВЛЕКАЮТСЯ: "я сделаю", "я подготовлю", "давайте до пятницы", code-switching обязательства ("мен ертең жасаймын. Завтра отправлю.")
     И каждое commitment имеет цитату-источник (quote-поле непустое)
   И валидация выполняется через Zod на schema-уровне (Commitment subschema требует все 4 поля, who/what/quote — min(1)); pose-content валидация (содержательная) — задача промпта, не схемы.
   ```

4. **Сценарий: Citation timestamps + [approximate] метка** (FR2, FR6)
   ```
   Дано extraction.citations[] возвращён Claude
   Когда проверяются метки
   Тогда КАЖДЫЙ citation имеет:
     - timestamp: number (секунды от начала встречи)
     - speaker: string
     - text: string
     - approximate?: boolean (опциональное поле; true если точное совпадение текста с транскриптом не найдено)
   И если approximate === true → промпт ОБЯЗАН вернуть alert в extraction (или это будет помечено в analysis.alerts по правилу из промпта)
   И отсутствие approximate-поля == approximate: false (default; explicit ZOd `.default(false)` или `.optional()`)
   И в analysis.alerts появляется элемент при наличии любых approximate цитат — "цитата с приближённой меткой времени" (правило промпта analysis.md, не код)
   ```

5. **Сценарий: Speaker mapping через стейкхолдерную карту; > 70% несоответствий → speaker_check** (PRD line 504)
   ```
   Дано в Transcript спикеры — "Speaker 1", "Speaker 2", ..., "Speaker N" (буквальные имена от parseSonioxTokens, Story 1.2)
     И ClientContext.stakeholders[] содержит { speakerName, role, department, ... }
   Когда extraction промпт получает stakeholderMap-блок и транскрипт
   Тогда extraction.commitments[].who и extraction.citations[].speaker возвращаются с РЕАЛЬНЫМ именем (например, "Жанель") если совпадение по содержанию реплик и stakeholder.role/responsibilityAreas однозначно
     И если > 70% реплик спикера НЕ соответствуют ни одной роли из карты → имя спикера попадает в extraction.speaker_check[]
     И analysis.alerts содержит элемент-redirect для каждого spkr из speaker_check (правило analysis.md): "Спикер X требует ручной проверки соответствия роли"
     И НЕсопоставленные спикеры остаются "Speaker N" в commitments/citations (НЕ ложные имена)
     И порог 70% — ответственность промпта (extraction.md уже описывает); код не вычисляет порог, только пробрасывает stakeholderMap в промпт
   ```

6. **Сценарий: Zod `.parse()` (fail-fast) для шагов 1-2 — НЕ `.safeParse()`** (architecture#Process Patterns)
   ```
   Дано Claude вернул JSON с структурным нарушением (например, commitments — не массив, или отсутствует поле who)
   Когда parseClaudeJSON(raw, ExtractionOutputSchema) падает на Schema.parse
   Тогда throw F1PipelineError('extraction_validation', { validationErrors: zodError.issues, rawTextSnippet: raw.slice(0, 500), stepName: 'extraction' }, { cause: zodError })
     И вызывается alertOps({ pipeline: 'F1', step: 'extraction', clientId, error, context: { transcriptDuration, validationErrors } })
     И logger.error со step: 'f1.extraction.validation_failed'
     И raw-ответ всё равно сохраняется в *.extraction.raw.txt для дебага (раздельный try-finally между retry-loop и persistence)
     И pipeline rejects — graceful degradation на шагах 1-2 НЕ применяется (по architecture: parse() для extraction/analysis)
   Аналогично для analysis_validation.
   ```

7. **Сценарий: `withRetry({1s, 3s, 9s})` для Claude API + правила retry policy** (architecture#API Patterns Retry, FR34)
   ```
   Дано Claude API возвращает 429, 500, 503 или сеть упала (ECONNRESET, ETIMEDOUT)
   Когда callClaude обернул вызов в withRetry({maxRetries: 3, backoffMs: [1000, 3000, 9000], shouldRetry: shouldRetryClaude, logger: log})
   Тогда после неуспешной попытки — backoff с указанной задержкой
     И maxRetries=3 → 4 attempts total (1 initial + 3 retries)
     И при исчерпании retry → throw F1PipelineError('claude_api', { httpStatus, attemptCount: 4, lastError }, { cause })
   И на 401/403 → НЕТ retry, immediate fail (auth-ошибки не retryable)
   И на 400 (bad_request) → НЕТ retry (промпт битый, retry не поможет)
   И на overloaded_error (Anthropic-specific 529) → ретраится (treated as 503)
   И на context_length_exceeded → НЕТ retry, throw с указанием на необходимость trim transcript (deferred Story 1.9 для умной нарезки длинных транскриптов; на 1.4a — fail с понятным сообщением)
   И на abort через AbortSignal (timeout deps.signal) → cancel, throw без retry
   ```

8. **Сценарий: Сохранение `{raw, parsed}` для каждого шага — `*.raw.txt` + `*.json`** (Day-1 fix #5)
   ```
   Дано шаги 1-2 завершились (успешно ИЛИ с validation error на Zod-этапе после получения raw)
   Когда выполняется persistShortcut(meta, { extractionRaw, analysisRaw?, extraction?, analysis? })
   Тогда создаются файлы:
     data/{clientId}/{YYYY-MM-DD}/f1-{topNameSlug}-{shortId}.extraction.raw.txt   (text/plain UTF-8)
     data/{clientId}/{YYYY-MM-DD}/f1-{topNameSlug}-{shortId}.extraction.json      (parsed ExtractionOutput, pretty-printed JSON)
     data/{clientId}/{YYYY-MM-DD}/f1-{topNameSlug}-{shortId}.analysis.raw.txt     (если analysis вызывался)
     data/{clientId}/{YYYY-MM-DD}/f1-{topNameSlug}-{shortId}.analysis.json
     data/{clientId}/{YYYY-MM-DD}/f1-{topNameSlug}-{shortId}.meta.json            (clientId, topName, transcriptDuration, durations per step, model, openCommitmentsBefore — для аудита)
   И директории создаются через fs.promises.mkdir({recursive: true})
   И запись через fs.promises.writeFile (НЕ writeFileSync — async I/O)
   И topNameSlug — kebab-case ASCII-транслитерация ИЛИ просто `topName.toLowerCase().replace(/\s+/g, '-')` сохраняя Cyrillic (ОК для filename на Linux)
   И shortId — `crypto.randomUUID().slice(0, 8)` (8 hex chars, достаточно для уникальности в пределах дня)
   И при IO-ошибке записи → log.error + alertOps({pipeline:'F1', step:'persist', ...}) + НЕ блокировать возврат пользователю (persist failure не должен ломать pipeline; warn, не throw)
   И data/ директория в .gitignore (Story 1.1 уже добавил)
   И auto-cleanup `*.raw.txt` через 14 дней — Story 1.9 (вне scope 1.4a; .raw.txt накапливаются в 1.4a без проблем для MVP первого месяца)
   ```

9. **Сценарий: Cross-session commitments — open commitments из прошлых встреч с этим топом передаются в analysis** (FR23)
   ```
   Дано в data/{clientId}/*/f1-{topNameSlug}-*.extraction.json есть закрытые F1-выводы по топу с commitments[]
     И каждый commitment может иметь поле status: 'open' | 'completed' | 'overdue' (на 1.4a статусы НЕ обновляются — Story 1.4b)
   Когда runF1Steps12 готовит вход для analysis
   Тогда вызывается loadOpenCommitments(clientId, topName, { rootDir: 'data', maxAgeDays: 90 })
     И функция:
       a. читает все f1-{topNameSlug}-*.extraction.json в data/{clientId}/*/ (glob через fs.promises.readdir + ручной фильтр; БЕЗ доп. dependency на 'fast-glob')
       b. фильтрует по mtime > now - 90 дней (cap на сколько-то старых сессий)
       c. фильтрует commitments где status === undefined ИЛИ status === 'open' (default = open)
       d. возвращает { openCommitments: Commitment[], sourceFiles: string[] }
     И если директория data/{clientId}/ НЕ существует — возвращает { openCommitments: [], sourceFiles: [] } (молча, не ошибка — первая встреча с топом)
     И массив openCommitments сериализуется и подставляется в analysis-промпт через {{openCommitments}} (новая переменная — обновить prompts/analysis.md)
     И если openCommitments.length === 0 → передаётся пустой массив `[]` в шаблон, промпт работает (analysis.md обрабатывает пустой блок: "Если открытых обязательств нет, пропусти этот раздел")
   И analysis.alerts включает элемент про незакрытые/просроченные обязательства если deadline истёк (правило промпта analysis.md, не код)
   ```

10. **Сценарий: F5 metrics ПУСТЫ — анализ не падает, продолжает работать** (Story 0.2 #2 + Story 1.3 ClientContextSchema)
    ```
    Дано ClientContext.f5Metrics === [] (массив пустой; Sheets `_f5_metrics` пока header-only — Азиза не заполняет)
    Когда analysis промпт получает {{okrContext}} с f5Metrics: []
    Тогда промпт работает БЕЗ блока "верификация заявлений топов через F5 метрики"
      И analysis.alerts НЕ содержит ложных метрик-расхождений
      И code НЕ обращается к f5Metrics[i] без проверки длины (Optional chaining + length check)
    И F5-метрики НЕ блокируют extraction (extraction промпт не получает f5Metrics; они в analysis-входе только если непусты)
    ```

11. **Сценарий: ClientContext с минимум 1 stakeholder и 1 OKR обязателен** (FR21, FR22)
    ```
    Дано ClientContext.stakeholders.length === 0 ИЛИ ClientContext.okrs.length === 0
    Когда runF1Steps12 валидирует входы перед шагом 1
    Тогда throw F1PipelineError('extraction_validation', { reason: 'empty_client_context', ... })
      И до Claude API call дело не доходит (zero-cost early fail)
    NB: ClientContextSchema из Story 1.3 уже гарантирует .min(1) — но runF1Steps12 повторно проверяет на defensive-programming уровне (тип может быть подделан вызывающим в тестах).
    ```

12. **Сценарий: Latency monitoring + child-logger** (Day-1 fix паттерн)
    ```
    Дано child-logger создаётся как logger.child({ pipeline: 'F1', step: 'f1.run', clientId, topName })
    Когда выполняются шаги 1, 2
    Тогда логируется по каждому шагу:
      log.info({ step: 'f1.extraction.start', model, transcriptDurationSec, transcriptCharCount })
      log.info({ step: 'f1.extraction.complete', durationMs, inputTokens, outputTokens, commitmentsCount, citationsCount, decisionsCount, factsCount })
      log.info({ step: 'f1.analysis.start', extractionPayloadSize })
      log.info({ step: 'f1.analysis.complete', durationMs, inputTokens, outputTokens, krCount, alertsCount })
      log.info({ step: 'f1.run.total', totalDurationMs, status: 'ok'|'error' })
    И при totalDurationMs > 15 * 60 * 1000 (15 мин SLA из NFR Latency) → log.warn({ ..., slaExceeded: true })
    И на любой ошибке — log.error со step name + alertOps (см. AC #6, #7)
    ```

13. **Сценарий: Retry уважает AbortSignal (deps.signal) — graceful cancel** (NFR Resilience)
    ```
    Дано caller передал AbortController.signal в runF1Steps12 (например, telegram bot stops processing)
    Когда controller.abort() вызван во время Claude API call ИЛИ во время backoff
    Тогда withRetry прекращает retry-loop (stop on AbortError)
      И Anthropic SDK отменяет in-flight request (SDK это умеет через `signal` опцию в messages.create)
      И функция rejects с AbortError (Error name === 'AbortError')
      И logger.warn({ step, reason: 'aborted_by_caller' })
      И persistShortcut вызывается с partial-state (например, есть extractionRaw, нет analysisRaw) — для аудита
    NB: На 1.4a сам runF1Steps12 НЕ создаёт AbortController с timeout — это задача caller (Story 1.5 telegram bot создаст controller с CLAUDE_TIMEOUT_MS на каждый шаг). 1.4a-функция принимает signal в deps, прокидывает в callClaude, и реагирует на abort корректно.
    ```

## Задачи / Подзадачи

- [x] **Задача 1: Расширить `src/types.ts` — Zod-схемы chain step contracts** (КП: #1, #3, #4, #6)
  - [x] 1.1 `CommitmentSchema`:
    ```ts
    export const CommitmentSchema = z.object({
      who: z.string().min(1),
      what: z.string().min(1),
      deadline: z.string(),                    // free-form: "не указан" | "до пятницы" | ISO-дата
      quote: z.string().min(1),                // включает [MM:SS] timestamp
      status: z.enum(['open', 'completed', 'overdue']).optional(), // на 1.4a — НЕ выставляется кодом, только промптом analysis (Story 1.4b начнёт писать через persistence)
    });
    export type Commitment = z.infer<typeof CommitmentSchema>;
    ```
  - [x] 1.2 `CitationSchema`:
    ```ts
    export const CitationSchema = z.object({
      timestamp: z.number().nonnegative(),     // секунды от начала встречи
      speaker: z.string().min(1),
      text: z.string().min(1),
      approximate: z.boolean().optional().default(false),
    });
    export type Citation = z.infer<typeof CitationSchema>;
    ```
  - [x] 1.3 `ExtractionOutputSchema`:
    ```ts
    export const ExtractionOutputSchema = z.object({
      decisions: z.array(z.string()),
      commitments: z.array(CommitmentSchema),
      citations: z.array(CitationSchema),
      facts: z.array(z.string()),
      speaker_check: z.array(z.string()).default([]),
    });
    export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;
    ```
    **Важно:** `speaker_check` — `string[]` имён спикеров; default `[]` если промпт не вернул поле (legacy compatibility).
  - [x] 1.4 `OkrCoverageItemSchema`:
    ```ts
    export const OkrCoverageItemSchema = z.object({
      kr: z.string().min(1),
      status: z.enum(['discussed', 'mentioned', 'blind_zone']),
      mentions_count: z.number().int().nonnegative().default(0),
      substance: z.boolean().default(false),
    });
    ```
  - [x] 1.5 `HypothesisItemSchema`:
    ```ts
    export const HypothesisItemSchema = z.object({
      hypothesis: z.string().min(1),
      status: z.enum(['idea', 'in_test', 'result']),
      evidence: z.array(z.string()).default([]),
    });
    ```
  - [x] 1.6 `AnalysisOutputSchema`:
    ```ts
    export const AnalysisOutputSchema = z.object({
      okr_coverage: z.array(OkrCoverageItemSchema),
      hypothesis_status: z.array(HypothesisItemSchema),
      alerts: z.array(z.string()),
    });
    export type AnalysisOutput = z.infer<typeof AnalysisOutputSchema>;
    ```
  - [x] 1.7 Сравнить с `scripts/prompt-test.ts` schemas (Story 0.3 — там zod/v4 версия, **синхронизировать** с текущим schema в `src/types.ts`, любые расхождения зафиксировать в Change Log). Schemas в test-script могут быть упрощены — production schemas строже.

- [x] **Задача 2: Расширить `src/errors.ts` — F1PipelineError** (КП: #6, #7)
  - [x] 2.1 Добавить:
    ```ts
    export type F1PipelineCode =
      | 'prompt_load'                  // loadPrompt fail (file not found / unreplaced var)
      | 'claude_api'                   // network/HTTP error after retries
      | 'claude_response_invalid'      // raw output не парсится как JSON
      | 'extraction_validation'        // Zod parse fail на ExtractionOutputSchema
      | 'analysis_validation'          // Zod parse fail на AnalysisOutputSchema
      | 'empty_client_context'         // stakeholders.length === 0 ИЛИ okrs.length === 0
      | 'persist';                     // fs.write fail в persistShortcut (warn-only, не throw)

    export class F1PipelineError extends Error {
      constructor(
        public readonly code: F1PipelineCode,
        public readonly context: Record<string, unknown>,
        options?: { cause?: unknown },
      ) {
        super(`f1:${code}`, options as ErrorOptions);
        this.name = 'F1PipelineError';
      }
    }
    ```
  - [x] 2.2 Re-export из `src/f1-report.ts` для convenience.

- [x] **Задача 3: `src/utils/prompt-loader.ts` — единственная точка загрузки промптов** (КП: #2, architecture enforcement #1, #7)
  - [x] 3.1 Реализация:
    ```ts
    import { promises as fs } from 'node:fs';
    import { join } from 'node:path';

    const PROMPTS_DIR = join(process.cwd(), 'prompts');

    export async function loadPrompt(
      name: string,
      vars: Record<string, string>,
    ): Promise<string> {
      const path = join(PROMPTS_DIR, `${name}.md`);
      let content: string;
      try {
        content = await fs.readFile(path, 'utf8');
      } catch (err) {
        throw new F1PipelineError('prompt_load', { name, path, reason: 'read_failed' }, { cause: err });
      }
      for (const [k, v] of Object.entries(vars)) {
        content = content.replaceAll(`{{${k}}}`, v);
      }
      const unreplaced = content.match(/\{\{[a-zA-Z_][a-zA-Z0-9_]*\}\}/g);
      if (unreplaced) {
        throw new F1PipelineError('prompt_load', {
          name,
          unreplaced: [...new Set(unreplaced)],
          providedVars: Object.keys(vars),
        });
      }
      return content;
    }
    ```
    **NB:** обходим только `{{...}}`; markdown-блоки `{ ... }` без двойных фигурных не трогаются. Регулярка отвергает `{{ }}` с пробелами (намеренно — все ключи в .md без пробелов).
  - [x] 3.2 `PROMPTS_DIR` через `process.cwd()` — корректно работает в Docker (рабочая директория `/app`) и в dev (project root). Тесты могут мокать через `vi.spyOn(process, 'cwd').mockReturnValue(...)` или через переменную в opts.
  - [x] 3.3 Тесты `src/utils/prompt-loader.test.ts`:
    - happy path: `loadPrompt('extraction', { transcript: '...', stakeholderMap: '...' })` → возвращает строку без `{{...}}`
    - missing prompt file → `F1PipelineError('prompt_load', { reason: 'read_failed' })`
    - unreplaced var (передан только `transcript`, шаблон требует `{{stakeholderMap}}`) → `F1PipelineError` с unreplaced
    - duplicate keys (`{{transcript}}` встречается несколько раз) → все заменены
    - значения с спецсимволами (`{{...}}`, `\n`, кириллица, JSON) → подставлены as-is, без re-парсинга

- [x] **Задача 4: `src/adapters/claude.ts` — Claude API wrapper** (КП: #1, #2, #6, #7, #13)
  - [x] 4.1 Сигнатура:
    ```ts
    import Anthropic from '@anthropic-ai/sdk';
    import type { ZodType } from 'zod';
    import { config } from '../config.js';
    import { logger as rootLogger, type Logger } from '../logger.js';
    import { withRetry } from '../utils/retry.js';
    import { F1PipelineError } from '../errors.js';

    export interface CallClaudeOpts<T> {
      stepName: string;                  // 'extraction' | 'analysis' (для логов)
      schema: ZodType<T>;                // Zod-валидатор
      model?: string;                    // default config.ANTHROPIC_MODEL
      maxTokens?: number;                // default config.CLAUDE_MAX_TOKENS
      signal?: AbortSignal;              // optional, прокидывается в SDK + withRetry
      logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
    }

    export interface CallClaudeResult<T> {
      raw: string;
      parsed: T;
      usage: { input_tokens: number; output_tokens: number };
    }

    export async function callClaude<T>(
      prompt: string,
      opts: CallClaudeOpts<T>,
    ): Promise<CallClaudeResult<T>>
    ```
  - [x] 4.2 Реализация — lazy SDK singleton:
    ```ts
    let cachedClient: Anthropic | null = null;
    function getClient(): Anthropic {
      if (!cachedClient) {
        cachedClient = new Anthropic({
          apiKey: config.ANTHROPIC_API_KEY,
          timeout: config.CLAUDE_TIMEOUT_MS,
        });
      }
      return cachedClient;
    }
    export function _resetClaudeClientForTest(): void { cachedClient = null; }
    ```
  - [x] 4.3 Реализация callClaude:
    1. `const log = (opts.logger ?? rootLogger).child({ step: `claude.${opts.stepName}` })` — child добавляет step.
    2. `const client = getClient()`.
    3. `const startMs = Date.now()`.
    4. Обернуть `client.messages.create({...})` в `withRetry` с правилом `shouldRetryClaude`.
    5. После успеха: extract `textBlock = response.content.find(b => b.type === 'text')` → `if (!textBlock) throw F1PipelineError('claude_response_invalid', { reason: 'no_text_block', response_id: response.id })`.
    6. `const raw = textBlock.text`.
    7. `let parsed: T; try { parsed = parseClaudeJSON(raw, opts.schema); } catch (e) { throw F1PipelineError(stepName === 'extraction' ? 'extraction_validation' : 'analysis_validation', { ... }, { cause: e }); }`. **NB:** schema-mapping на `extraction_validation` / `analysis_validation` происходит здесь, по `stepName` (или caller сам ловит и переоборачивает; рекомендуется второе для чистоты — каждый caller знает свой код. Решение dev: реализовать через caller, вернуть из callClaude общий `claude_response_invalid` на JSON.parse fail и `extraction_validation`/`analysis_validation` на Zod fail-throw).
    8. `log.info({ step: 'claude.{stepName}.complete', durationMs: Date.now() - startMs, inputTokens, outputTokens })`.
    9. Возврат `{ raw, parsed, usage }`.
  - [x] 4.4 `parseClaudeJSON<T>(raw: string, schema: ZodType<T>): T` — приватный helper:
    ```ts
    function parseClaudeJSON<T>(raw: string, schema: ZodType<T>): T {
      let cleaned = raw.trim();
      if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
      else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
      if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
      cleaned = cleaned.trim();
      let json: unknown;
      try {
        json = JSON.parse(cleaned);
      } catch (err) {
        throw new F1PipelineError('claude_response_invalid', {
          reason: 'json_parse_failed',
          raw,                          // FULL raw — persisted caller'ом
          rawSnippet: raw.slice(0, 500), // for логов
          parseError: (err as Error).message,
        }, { cause: err });
      }
      try {
        return schema.parse(json);
      } catch (err) {
        // ZodError → wrap with full raw, чтобы caller мог persist .raw.txt для дебага
        throw new F1PipelineError('claude_response_invalid', {
          reason: 'zod_validation_failed',
          raw,
          validationErrors: (err as { issues?: unknown }).issues,
        }, { cause: err });
      }
    }
    ```
    **Контракт:** парсинг + валидация ВСЕГДА бросают `F1PipelineError('claude_response_invalid', { raw, ... })` — caller ждёт именно этот код. Step-specific re-wrap (`extraction_validation` / `analysis_validation`) делает `runF1Steps12` (Задача 6.7).
  - [x] 4.5 `shouldRetryClaude` — predicate для `withRetry`:
    - Retry: 429, 500, 502, 503, 504, 529 (Anthropic overloaded), Node errors ECONNRESET/ETIMEDOUT/ENOTFOUND/EAI_AGAIN, AbortError из middle-of-flight только если signal НЕ от caller (т.е. внутренний — fetch timeout, не abort)
    - **НЕ** retry: 400 (bad_request), 401 (unauthorized), 403 (permission_error), AbortError если caller вызвал abort()
    - Anthropic SDK 0.x: ошибки имеют `error.status` (не `error.response.status`) и `error.error.type` для семантического кода. Учесть оба формата.
    - Реализация:
      ```ts
      function shouldRetryClaude(error: unknown): boolean {
        if (!error || typeof error !== 'object') return false;
        const e = error as { status?: number; name?: string; code?: string; message?: string };
        if (e.name === 'AbortError') return false;       // caller abort
        if (typeof e.status === 'number') {
          if (e.status === 401 || e.status === 403 || e.status === 400) return false;
          if (e.status === 429 || e.status === 529) return true;
          if (e.status >= 500 && e.status < 600) return true;
          return false;
        }
        if (typeof e.code === 'string' && ['ECONNRESET','ETIMEDOUT','ENOTFOUND','EAI_AGAIN','ECONNREFUSED'].includes(e.code)) return true;
        if (typeof e.message === 'string' && /fetch failed|network|socket/i.test(e.message)) return true;
        return false;
      }
      ```
  - [x] 4.6 Маппинг final-error в F1PipelineError:
    ```ts
    catch (err) {
      if (err instanceof F1PipelineError) throw err;
      const status = (err as any)?.status;
      throw new F1PipelineError('claude_api', {
        stepName: opts.stepName,
        httpStatus: status,
        anthropicErrorType: (err as any)?.error?.type,
        message: (err as Error)?.message,
      }, { cause: err });
    }
    ```
  - [x] 4.7 **Circuit breaker stub** — заглушка:
    ```ts
    export function isClaudeCircuitOpen(): boolean { return false; }
    ```
    На 1.4a circuit breaker не активен. Story 1.9 заменит тело + добавит state. Caller проверяет `if (isClaudeCircuitOpen()) → fallback`, но на 1.4a условие всегда false, поэтому в коде вызывающего не будет ветви fallback (только TODO-комментарий, чтобы Story 1.9 заполнила).
  - [x] 4.8 Тесты `src/adapters/claude.test.ts`:
    - mock `Anthropic` через `vi.mock('@anthropic-ai/sdk')` — фабрика возвращает `{ messages: { create: vi.fn() } }`
    - happy path: создать mock-response с `content: [{ type: 'text', text: '{"decisions":[], ...}' }]` + `usage` → проверить parsed/raw/usage
    - 429 → 200: один retry, успех
    - 500 → 500 → 500 → 500: исчерпание retry, throw `F1PipelineError('claude_api', { httpStatus: 500, attemptCount: 4 })`
    - 401: НЕТ retry, immediate throw
    - JSON parse fail: throw `F1PipelineError('claude_response_invalid')`
    - markdown fences: `\`\`\`json\n{...}\n\`\`\`` — strip и parse OK
    - Zod fail: schema требует commitments, raw без commitments → ZodError caught и throw F1PipelineError со step-specific code (через caller; в самом callClaude — общий `extraction_validation` если stepName === 'extraction', иначе `analysis_validation`)
    - AbortSignal: pass `signal` → SDK call cancelled, throw AbortError (no retry)

- [x] **Задача 5: `src/utils/commitments-history.ts` — чтение open commitments из локальных JSON** (КП: #9)
  - [x] 5.1 Сигнатура:
    ```ts
    import { promises as fs } from 'node:fs';
    import { join } from 'node:path';
    import type { Commitment } from '../types.js';

    export interface LoadOpenCommitmentsOpts {
      rootDir?: string;             // default 'data'
      maxAgeDays?: number;          // default 90
      now?: Date;                   // injectable для тестов (default new Date())
    }

    export interface OpenCommitmentsResult {
      openCommitments: Commitment[];
      sourceFiles: string[];
    }

    export async function loadOpenCommitments(
      clientId: string,
      topName: string,
      opts: LoadOpenCommitmentsOpts = {},
    ): Promise<OpenCommitmentsResult>
    ```
  - [x] 5.2 Реализация:
    1. `const root = join(opts.rootDir ?? 'data', clientId)`
    2. Если `await fs.stat(root)` падает → return `{ openCommitments: [], sourceFiles: [] }` (молча, нет данных).
    3. `const dirs = await fs.readdir(root, { withFileTypes: true })` — фильтр только директорий, имена матчат `YYYY-MM-DD`.
    4. Сортировка дат descending (свежие первыми).
    5. Cap: `if (now - dirDate > maxAgeDays * 86400000) skip`.
    6. Для каждой даты-директории: `await fs.readdir(dir)`, фильтр по regex `^f1-{topNameSlug}-[a-f0-9]{8}\.extraction\.json$`.
    7. Для каждого подходящего файла: `JSON.parse(await fs.readFile(...))`, попробовать пропустить через `ExtractionOutputSchema.safeParse` (НЕ parse — старые JSON могут быть в более старом формате; safeParse fail → log.warn + skip).
    8. Аккумулировать `extraction.commitments[]` где `status === undefined || status === 'open'`.
    9. Дедупликация по `who + what + deadline` (на случай если один и тот же commitment в нескольких файлах). Сохранить **последний** (по mtime файла, чтобы потенциально обновлённые статусы Story 1.4b побеждали при последующем запуске).
    10. Возврат `{ openCommitments, sourceFiles: <relative paths> }`.
  - [x] 5.3 `topNameSlug(topName: string): string` — приватный helper:
    ```ts
    const topNameSlug = (s: string): string =>
      s.trim().toLowerCase().replace(/\s+/g, '-').replace(/[\/\\<>:"|?* -]/g, '_');
    ```
    **Сохраняем кириллицу** — Linux fs допускает Unicode имена. Удаляем только запрещённые символы для cross-platform safety.
  - [x] 5.4 Тесты:
    - empty data/{clientId}/ → `{ openCommitments: [], sourceFiles: [] }`
    - один прошлый файл с 3 commitments (без status) → 3 open
    - file со status: 'completed' → исключён
    - mtime > 90 дней → исключён
    - дедупликация по `who+what+deadline` — сохраняется последний
    - Zod-несовместимый файл (старая schema) → log.warn + skip, не throw
    - tmpdir-based test: `mkdtemp` + setup, очистка через `afterEach`

- [x] **Задача 6: `src/f1-report.ts` — pipeline шаги 1-2** (КП: ВСЕ)
  - [x] 6.1 Структура:
    ```ts
    import { promises as fs } from 'node:fs';
    import { join } from 'node:path';
    import { randomUUID } from 'node:crypto';
    import { logger as rootLogger, type Logger } from './logger.js';
    import { alertOps } from './ops.js';
    import { loadPrompt } from './utils/prompt-loader.js';
    import { callClaude } from './adapters/claude.js';
    import { loadOpenCommitments } from './utils/commitments-history.js';
    import {
      ExtractionOutputSchema, AnalysisOutputSchema,
      type ExtractionOutput, type AnalysisOutput, type Commitment,
      type Transcript, type ClientContext,
    } from './types.js';
    import { F1PipelineError } from './errors.js';
    ```
  - [x] 6.2 `formatTranscriptForPrompt(transcript: Transcript): string` — internal:
    Сериализатор a-la `scripts/prompt-test.ts:formatTranscriptForPrompt`:
    - merge всех segments из всех speakers
    - сортировка по `start` ascending
    - формат строки: `[MM:SS] {speakerName}: {text.trim()}`
    - join `\n`
    - Возвращает многострочную строку.
  - [x] 6.3 `formatStakeholderMapForPrompt(stakeholders: Stakeholder[]): string`:
    Compact JSON (или table-style markdown) из `Stakeholder[]`. Можно начать с `JSON.stringify(stakeholders, null, 2)` — промпты Story 0.3 валидированы на JSON-блоке, не на ad-hoc формате.
  - [x] 6.4 `formatOkrContextForPrompt(okrs: OkrKr[], f5Metrics: F5Metric[]): string`:
    Объединить OKR + F5 (если непусто) в один JSON-блок: `JSON.stringify({ okrs, f5Metrics: f5Metrics.length > 0 ? f5Metrics : undefined }, null, 2)`. Без F5 — поле опускается (промпт не получает пустой массив, а отсутствующее поле — проще для промпта).
  - [x] 6.5 `runF1Steps12` — публичный API:
    ```ts
    export interface RunF1Steps12Input {
      transcript: Transcript;
      clientContext: ClientContext;
      meta: { clientId: string; topName: string; meetingDate: string; meetingType?: string };
      deps?: {
        logger?: Logger;
        signal?: AbortSignal;
        rootDir?: string;             // 'data' default — для тестов tmpdir
        now?: Date;                   // для детерминизма тестов
        callClaude?: typeof callClaude; // mock injection
        loadOpenCommitments?: typeof loadOpenCommitments;
      };
    }

    export interface RunF1Steps12Result {
      extraction: ExtractionOutput;
      analysis: AnalysisOutput;
      rawResponses: { extraction: string; analysis: string };
      openCommitmentsBefore: Commitment[];
      reportId: string;                // shortId из persistShortcut
      durationsMs: { extraction: number; analysis: number; total: number };
      tokens: { input: number; output: number }; // суммарно по двум step
    }

    export async function runF1Steps12(input: RunF1Steps12Input): Promise<RunF1Steps12Result>
    ```
  - [x] 6.6 Flow:
    1. `const log = (deps.logger ?? rootLogger).child({ pipeline: 'F1', step: 'f1.run', clientId: meta.clientId, topName: meta.topName })`.
    2. **Валидация input** (AC #11): if `clientContext.stakeholders.length === 0 || clientContext.okrs.length === 0` → throw `F1PipelineError('empty_client_context', ...)`. (Хотя Zod в `readClientContext` уже это делает, defensive здесь — на случай теста, передающего конструированный объект.)
    3. `const reportId = randomUUID().slice(0, 8)`.
    4. `const totalStart = Date.now()`.
    5. **Step 1 — extraction:**
       - `const extractionPrompt = await loadPrompt('extraction', { transcript: formatTranscriptForPrompt(transcript), stakeholderMap: formatStakeholderMapForPrompt(clientContext.stakeholders) })`.
       - `log.info({ step: 'f1.extraction.start', model, transcriptCharCount: extractionPrompt.length })`.
       - `const extractionStart = Date.now()`.
       - `const { raw: extractionRaw, parsed: extraction, usage: usageE } = await (deps.callClaude ?? callClaude)(extractionPrompt, { stepName: 'extraction', schema: ExtractionOutputSchema, signal: deps.signal, logger: log })`.
       - `const extractionDurationMs = Date.now() - extractionStart`.
       - `log.info({ step: 'f1.extraction.complete', durationMs: extractionDurationMs, inputTokens: usageE.input_tokens, outputTokens: usageE.output_tokens, commitmentsCount: extraction.commitments.length, citationsCount: extraction.citations.length, decisionsCount: extraction.decisions.length, factsCount: extraction.facts.length, speakerCheckCount: extraction.speaker_check.length })`.
       - `await persistStep(meta, reportId, 'extraction', { raw: extractionRaw, parsed: extraction }, deps.rootDir ?? 'data', log)` (persist в blocking режиме, но errors swallowed → warn).
    6. **Open commitments — между шагами:**
       - `const { openCommitments, sourceFiles } = await (deps.loadOpenCommitments ?? loadOpenCommitments)(meta.clientId, meta.topName, { rootDir: deps.rootDir ?? 'data', now: deps.now })`.
       - `log.info({ step: 'f1.openCommitments.loaded', count: openCommitments.length, sourceFiles: sourceFiles.slice(0, 5) })`.
    7. **Step 2 — analysis:**
       - `const analysisPrompt = await loadPrompt('analysis', { okrContext: formatOkrContextForPrompt(clientContext.okrs, clientContext.f5Metrics), extractionOutput: JSON.stringify(extraction, null, 2), stakeholderMap: formatStakeholderMapForPrompt(clientContext.stakeholders), openCommitments: JSON.stringify(openCommitments, null, 2) })`.
       - **NB:** `prompts/analysis.md` ОБНОВИТЬ — добавить переменную `{{openCommitments}}` (Задача 7).
       - `log.info({ step: 'f1.analysis.start' })`.
       - аналогично шагу 1: callClaude + persistStep + log.
    8. `const totalDurationMs = Date.now() - totalStart`.
    9. `log.info({ step: 'f1.run.total', totalDurationMs, status: 'ok' })`.
    10. SLA-warn: `if (totalDurationMs > 15 * 60 * 1000) log.warn({ slaExceeded: true })`.
    11. `await persistMeta(meta, reportId, { tokens, durations, openCommitmentsBefore: openCommitments, model }, deps.rootDir ?? 'data', log)` (метаданные .meta.json).
    12. Возврат `{ extraction, analysis, rawResponses, openCommitmentsBefore: openCommitments, reportId, durationsMs, tokens }`.
  - [x] 6.7 Error-handling — обёртки:
    - **callClaude → F1PipelineError('claude_response_invalid', { raw, ... })** при JSON/Zod fail. `runF1Steps12` ловит, **persistит raw** в `*.{stepName}.raw.txt` (для дебага), затем re-throws step-specific error: `extraction_validation` или `analysis_validation` (с тем же `cause`). Это даёт правило AC #6: «raw сохраняется даже при schema fail».
    - Псевдокод обёртки на каждый step:
      ```ts
      let extractionRaw: string | undefined;
      try {
        const r = await callClaude(extractionPrompt, { stepName: 'extraction', schema: ExtractionOutputSchema, ... });
        extractionRaw = r.raw;
        await persistStep(meta, reportId, 'extraction', { raw: r.raw, parsed: r.parsed }, rootDir, log);
        return r.parsed;
      } catch (err) {
        if (err instanceof F1PipelineError && err.code === 'claude_response_invalid') {
          extractionRaw = (err.context.raw as string) ?? extractionRaw;
          if (extractionRaw) {
            await persistStep(meta, reportId, 'extraction', { raw: extractionRaw, parsed: null }, rootDir, log).catch(() => {});
          }
          throw new F1PipelineError('extraction_validation', { ...err.context, reason: err.context.reason }, { cause: err });
        }
        throw err;
      }
      ```
    - Любой не-F1Pipeline error → wrap в `F1PipelineError('claude_api', { step: 'f1.run', cause })` + alertOps + log.error + re-throw.
    - На ошибку **до** Claude API call (например, prompt_load fail) — ничего не записано (ОК, нет данных).
    - На ошибку **в** шаге 2 — extraction уже сохранена; analysis raw сохранена при schema fail (см. выше); analysis.json НЕ создан если parse failed; meta.json пишется в финальном `try/finally` с partial-данными для аудита.
  - [x] 6.8 `persistStep` — внутренний helper:
    ```ts
    async function persistStep(
      meta: { clientId: string; topName: string; meetingDate: string },
      reportId: string,
      stepName: 'extraction' | 'analysis',
      data: { raw: string; parsed: unknown | null },   // parsed === null допустимо при validation fail
      rootDir: string,
      log: Logger,
    ): Promise<void> {
      try {
        const dateDir = meta.meetingDate.slice(0, 10); // 'YYYY-MM-DD' из ISO
        const dir = join(rootDir, meta.clientId, dateDir);
        await fs.mkdir(dir, { recursive: true });
        const slug = topNameSlug(meta.topName);
        const baseName = `f1-${slug}-${reportId}`;
        // raw пишется ВСЕГДА (даже при parsed === null) — для дебага schema fails
        await fs.writeFile(join(dir, `${baseName}.${stepName}.raw.txt`), data.raw, 'utf8');
        // .json пишется только при успешном parse
        if (data.parsed !== null) {
          await fs.writeFile(join(dir, `${baseName}.${stepName}.json`), JSON.stringify(data.parsed, null, 2), 'utf8');
        }
      } catch (err) {
        log.error({ step: `f1.${stepName}.persist_failed`, err }, 'persist failed (warn-only)');
        alertOps({ pipeline: 'F1', step: `f1.${stepName}.persist`, clientId: meta.clientId, error: err });
        // НЕ throw — persist failure не должен ломать pipeline
      }
    }
    ```
  - [x] 6.9 Re-export `topNameSlug` из `commitments-history.ts` (или вынести в общий `src/utils/slug.ts` если используется в нескольких файлах).

- [x] **Задача 7: Обновить `prompts/analysis.md` — переменная `{{openCommitments}}`** (КП: #9)
  - [x] 7.1 Добавить новую секцию в `prompts/analysis.md` (между `{{stakeholderMap}}` и инструкциями):
    ```markdown
    ## Открытые обязательства из прошлых встреч с этим топом

    {{openCommitments}}
    ```
  - [x] 7.2 Добавить инструкцию в analysis.md:
    > **3-bis. Статусы commitments из прошлых встреч:** Если массив открытых обязательств выше непуст, для каждого определи актуальный статус на основе обсуждений в текущей встрече: `"open"` (без изменений), `"completed"` (явно выполнено по транскрипту), `"overdue"` (deadline истёк, ничего не сделано). Если открытых обязательств нет (пустой массив `[]`) — пропусти этот блок. Добавь в `alerts` каждый просроченный commitment.
  - [x] 7.3 Добавить в JSON-формат `analysis.md` опциональный блок (после `alerts`):
    ```json
    "commitments_status_updates": [
      { "who": "...", "what": "...", "previous_quote": "...", "new_status": "completed|overdue|open", "evidence_quote": "..." }
    ]
    ```
    **И** обновить `AnalysisOutputSchema` (Задача 1.6) — добавить опциональное поле:
    ```ts
    commitments_status_updates: z.array(z.object({
      who: z.string(),
      what: z.string(),
      previous_quote: z.string(),
      new_status: z.enum(['open', 'completed', 'overdue']),
      evidence_quote: z.string().optional(),
    })).optional().default([]),
    ```
    **NB:** На 1.4a — поле возвращается, но **не применяется** к persistence (Story 1.4b/1.10 запишут обновления в источник истины). Подключение к persistence — следующая story.
  - [x] 7.4 Bump prompts version в `prompts/CHANGELOG.md`:
    ```markdown
    ## v1.1.0 — 2026-04-30 (Story 1.4a)

    - `analysis.md`: добавлена переменная `{{openCommitments}}` для cross-session accountability
    - `analysis.md`: добавлено поле `commitments_status_updates` в JSON-output для статусных обновлений (open/completed/overdue) с обоснованием через evidence_quote
    - **Backward compatibility:** старые F1 reference outputs в `data/golden/` НЕ содержат `commitments_status_updates` — Zod default `[]` совместим. Canary diff (Story 1.11) ожидаемо покажет небольшие изменения в analysis output из-за нового блока.
    ```
  - [x] 7.5 **НЕ** трогать `prompts/extraction.md` — он остаётся v1.0.0. Спекр-mapping и [approximate] — уже описаны в нём (Story 0.3).

- [x] **Задача 8: Расширить `src/config.ts` — Anthropic + timeouts** (КП: #1, #7)
  - [x] 8.1 Добавить в `ConfigSchema`:
    ```ts
    ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-4-6'),
    CLAUDE_MAX_TOKENS: z.coerce.number().int().positive().max(64000).default(8192),
    CLAUDE_TIMEOUT_MS: z.coerce.number().int().positive().default(120000), // 2 мин на запрос (SDK timeout, не общий)
    ```
  - [x] 8.2 Обновить `.env.example`:
    ```
    # Claude API (Anthropic)
    ANTHROPIC_API_KEY=
    ANTHROPIC_MODEL=claude-sonnet-4-6
    CLAUDE_MAX_TOKENS=8192
    CLAUDE_TIMEOUT_MS=120000
    ```
  - [x] 8.3 `vitest.config.ts` — добавить test-defaults для новых vars (если нужны для config-loading в тестах):
    ```ts
    process.env.ANTHROPIC_MODEL ??= 'claude-sonnet-4-6';
    process.env.CLAUDE_MAX_TOKENS ??= '8192';
    process.env.CLAUDE_TIMEOUT_MS ??= '120000';
    ```
    **NB:** `ANTHROPIC_API_KEY` уже есть. Проверить, что не сломаются `config.test.ts`/смежные.

- [x] **Задача 9: Smoke-test `npm run f1:smoke`** (manual)
  - [x] 9.1 `scripts/f1-smoke.ts`:
    ```ts
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { runF1Steps12 } from '../src/f1-report.js';
    import { TranscriptSchema, ClientContextSchema } from '../src/types.js';

    const transcriptPath = process.argv[2] ?? 'data/golden/transcript-1.json';
    const transcript = TranscriptSchema.parse(JSON.parse(readFileSync(transcriptPath, 'utf8')));
    // Build ClientContext из data/stakeholder-map.json + data/okr-context.json (фикстуры Story 0.3)
    const stakeholders = JSON.parse(readFileSync('data/stakeholder-map.json', 'utf8'));
    const okrs = JSON.parse(readFileSync('data/okr-context.json', 'utf8'));
    const clientContext = ClientContextSchema.parse({
      clientId: 'geonline',
      stakeholders,
      okrs,
      f5Metrics: [],
      readAt: new Date().toISOString(),
    });
    const result = await runF1Steps12({
      transcript,
      clientContext,
      meta: { clientId: 'geonline', topName: 'Жанель', meetingDate: new Date().toISOString() },
    });
    console.log(JSON.stringify({
      reportId: result.reportId,
      durationsMs: result.durationsMs,
      tokens: result.tokens,
      commitments: result.extraction.commitments.length,
      okr_coverage: result.analysis.okr_coverage.length,
      alerts: result.analysis.alerts,
      openCommitmentsBefore: result.openCommitmentsBefore.length,
    }, null, 2));
    ```
  - [x] 9.2 `package.json` script: `"f1:smoke": "tsx scripts/f1-smoke.ts"`.
  - [x] 9.3 **Не запускать в CI** — требует `ANTHROPIC_API_KEY`. Manual: проверить ≥ 3 транскриптов из golden — duration < 5 мин/транскрипт, нет throw.

- [x] **Задача 10: Unit-тесты F1 pipeline (`src/f1-report.test.ts`)** (КП: ВСЕ)
  - [x] 10.1 Setup: `vi.mock` на `./adapters/claude.js` (mock callClaude), `./utils/commitments-history.js` (mock loadOpenCommitments), `./utils/prompt-loader.js` опционально (если хотим избежать чтения реальных промптов в тестах — mock или использовать tmpdir с fixture-файлами `prompts/*.md`).
  - [x] 10.2 Тест: happy path — fixture transcript + минимальный ClientContext (1 stakeholder, 1 OKR), mock callClaude возвращает фиксированные `{raw, parsed}` для extraction + analysis. Ожидаем:
    - `result.extraction === <mocked>`
    - `result.analysis === <mocked>`
    - `result.reportId.length === 8`
    - `result.durationsMs.total > 0`
    - persistStep вызвался 2 раза (extraction + analysis); файлы созданы в tmpdir.
  - [x] 10.3 Тест: empty client context → `F1PipelineError('empty_client_context')`.
  - [x] 10.4 Тест: open commitments injected — mock loadOpenCommitments возвращает 3 commitments → проверить, что `loadPrompt('analysis', { ..., openCommitments: <expected JSON> })` получил их (можно через spy на loadPrompt или через verify входов callClaude).
  - [x] 10.5 Тест: Step 1 fails (callClaude throws `F1PipelineError('claude_api')`) → analysis НЕ вызывается; persistStep('extraction') НЕ вызвался; promise rejects; alertOps вызвался.
  - [x] 10.6 Тест: Step 2 fails — extraction персистнута; analysis НЕ персистнута; promise rejects; alertOps вызвался.
  - [x] 10.7 Тест: Schema validation fail — mock callClaude возвращает (через мок parseClaudeJSON или прокидывая raw) → `extraction_validation` или `analysis_validation`. Проверить, что raw сохранён в .raw.txt (для дебага) даже при schema fail.
  - [x] 10.8 Тест: AbortSignal cancellation — controller.abort() во время mock-задержки → AbortError, no analysis call.
  - [x] 10.9 Тест: SLA warn — mock totalDurationMs > 15 мин (через overriding `Date.now`) → log.warn called с `slaExceeded: true`.
  - [x] 10.10 Regression-тест: golden-фикстуры (`data/golden/transcript-1.json`, `f1-reference-1.json`) — load и прогон через `runF1Steps12` с mock callClaude (возврат f1-reference-N.extraction + .analysis). Проверка JSON-совместимости structure (а не diff).

- [x] **Задача 11: Документация и финализация** (КП: все)
  - [x] 11.1 Обновить `_bmad-output/implementation-artifacts/deferred-work.md`:
    - Добавить (если применимо):
      - `Claude circuit breaker (3 fail/5 min → fallback)` — Story 1.9.
      - `Auto-cleanup .raw.txt > 14 days` — Story 1.9.
      - `Smart transcript trimming for context_length_exceeded` — Story 1.9.x (длинные встречи > 90 мин).
      - `Commitments status persistence (write back обновления статусов в data/)` — Story 1.4b / Story 1.10.
      - `Streaming Claude response (reduce TTFB perceived)` — Growth.
  - [x] 11.2 Чек-лист Day-1 fixes из architecture#hindsight:
    - [x] #3 Batch read контекста перед F1 pipeline — реализован в Story 1.3, **используется здесь** через 1 вызов `readClientContext` в caller (smoke-test/Story 1.5 bot) **до** `runF1Steps12`.
    - [x] #5 Raw Claude response сохранён `.raw.txt` — реализовано в `persistStep` (Задача 6.8).
  - [x] 11.3 Вне scope: `prompts/CHANGELOG.md` — bump до v1.1.0 (Задача 7.4).

- [x] **Задача 12: Verification (DOD)**
  - [x] 12.1 `npm run typecheck` → 0 ошибок.
  - [x] 12.2 `npm test` → текущий baseline (после Story 1.3 = 87 тестов) + новые F1-тесты ≈ 110-130 тестов всего, все проходят.
  - [x] 12.3 `npm run build && find dist -name "*.test.js"` → пусто (tsconfig exclude уже работает).
  - [x] 12.4 `npm run f1:smoke data/golden/transcript-1.json` (manual) → возврат с `extraction.commitments.length > 0`, `analysis.okr_coverage.length === clientContext.okrs.length` (приблизительно).
  - [x] 12.5 Grep-rules:
    - `grep -rE 'anthropic\.messages\.create|new Anthropic\(' src/ -l` → только `src/adapters/claude.ts`
    - `grep -rE 'const\s+\w+\s*=\s*\`[^\`]*\{\{' src/` → 0 результатов (нет inline-промптов с {{vars}})
    - `grep -rE 'JSON\.parse\(\s*[a-zA-Z_]+\.content\b|JSON\.parse\(\s*raw\b' src/adapters/ src/f1-report.ts` → только через parseClaudeJSON

## Заметки для разработчика (Dev Notes)

### Критические архитектурные правила

1. **Промпты в `prompts/*.md`, никогда inline в `.ts`** — `loadPrompt()` единственная точка. [Source: architecture.md#Process Patterns lines 449-456, Enforcement #1, #7 lines 494-501]
2. **`parseClaudeJSON(raw, Schema)` для всех Claude output** — никогда `JSON.parse()` напрямую на raw тексте. [Source: architecture.md#Process Patterns lines 458-464, Enforcement #2]
3. **Zod schema per chain step в `types.ts`** — `parse()` для шагов 1-2 (extraction, analysis = fail-fast). `safeParse()` — для шагов 3-4 (Story 1.4b, formatting/delivery). [Source: architecture.md#Process Patterns lines 466-468, Enforcement #3]
4. **`withRetry({maxRetries: 3, backoffMs: [1000, 3000, 9000]})` для Claude API** — никогда bare await. [Source: architecture.md#Retry line 471, Enforcement #8]
5. **JSON backup `fs.promises.writeFile` после каждого успешного step** (Day-1 fix #5: `{raw, parsed}`). [Source: architecture.md#Hindsight Reflection #5 line 657, Enforcement #9]
6. **Provider-agnostic claude.ts** — замена LLM = замена этого файла без изменений downstream. Контракт: `CallClaudeResult<T> = {raw, parsed, usage}`. [Source: architecture.md#Architectural Boundaries line 588, ADR-001]
7. **Логирование child-logger** — `logger.child({ pipeline: 'F1', step: '...', clientId, topName? })` всегда. Никогда `console.log`. [Source: architecture.md#Logging lines 442-446, Enforcement #6]
8. **alertOps на каждый non-trivial fail** — silent catch запрещён. [Source: architecture.md#Anti-patterns line 511]

### Anthropic SDK — нюансы (`@anthropic-ai/sdk@^0.90.0`)

1. **Initialization:**
   ```ts
   import Anthropic from '@anthropic-ai/sdk';
   const client = new Anthropic({ apiKey, timeout: 120000 });
   ```
2. **Messages API:**
   ```ts
   const response = await client.messages.create({
     model: 'claude-sonnet-4-6',
     max_tokens: 8192,
     messages: [{ role: 'user', content: prompt }],
     // signal,  // SDK 0.x — поддерживается опция; проверить по docs текущей версии
   });
   const text = response.content.find(b => b.type === 'text')?.text;
   const { input_tokens, output_tokens } = response.usage;
   ```
3. **Error shape (SDK 0.x):** `error.status` (HTTP status), `error.error.type` (Anthropic error code: `invalid_request_error | authentication_error | permission_error | not_found_error | request_too_large | rate_limit_error | api_error | overloaded_error`), `error.message`. **НЕ** `error.response.status` (это другой SDK).
4. **Retryable codes:** 429 (rate_limit_error), 500-504, 529 (overloaded_error). НЕ retryable: 400, 401, 403.
5. **Timeout:** `timeout` в SDK config — global per-request timeout. Дополнительно `AbortSignal.timeout(ms)` можно прокинуть в каждый `messages.create` через `signal`. Для F1 — оба активируем (config.CLAUDE_TIMEOUT_MS как fallback safety, AbortController в caller для cooperative cancel).
6. **Tool use / structured output:** на 1.4a используем JSON через текстовый prompt (так как `prompts/*.md` v1.0.0 валидирована именно в этом формате). Tool use mode (`tools: [...]`) — Phase 2 / Growth (architecture.md#Process Patterns line 463: "Рассмотреть Claude tool use / structured output mode для MVP"). На 1.4a — **не делаем**, чтобы не ломать canary diff Story 1.11.
7. **Streaming:** SDK поддерживает `client.messages.stream(...)` — на 1.4a НЕ используем (синхронный wait достаточен; streaming усложняет parseClaudeJSON).
8. **Версия SDK:** `^0.90.0` зафиксирована в `package.json` (Story 1.1). API уровня 1.0 НЕ выпущен (на 2026-04-30 актуальная major-версия SDK всё ещё 0.x). Не апгрейдить без проверки на breaking changes (особенно `content` array structure).
9. **Prompt caching:** Anthropic SDK поддерживает `cache_control` blocks — на 1.4a **рассмотреть для extraction promt** (system message + transcript могут быть кэшированы между вызовами). На MVP с 5 встречами/нед — экономия минимальна; **deferred Story 1.9.x / Growth** (trigger: 50+ Claude calls/нед).

### Промпты (Story 0.3 v1.0.0 → v1.1.0 в этой story)

- **`prompts/extraction.md`** — НЕ трогаем (v1.0.0, валидирована Тимуром на 7 транскриптах с 0% правок). Содержит правила: speaker_check threshold (70%), [approximate] метки, commitments rules (явные обещания, не размытые). Few-shot examples: `prompts/examples/commitments-positive.md` (4 примера) + `commitments-negative.md` (5 не-обязательств + 1 code-switching). [Source: data/golden/manifest.json `_validated_by`]
- **`prompts/analysis.md`** — обновляем до v1.1.0:
  - Добавляем `{{openCommitments}}` (input)
  - Добавляем `commitments_status_updates` (output)
  - Старая структура (okr_coverage, hypothesis_status, alerts) — без изменений
- **Контракт:** все `{{vars}}` в промпте ДОЛЖНЫ быть переданы через `loadPrompt()`. Иначе `prompt_load` error. Текущий список переменных промптов:
  - `extraction.md`: `{{transcript}}`, `{{stakeholderMap}}`
  - `analysis.md` (v1.1.0): `{{okrContext}}`, `{{extractionOutput}}`, `{{stakeholderMap}}`, `{{openCommitments}}`
- **CHANGELOG.md** — bump v1.1.0 с описанием изменений (Задача 7.4).

### Format helpers — детерминизм vs гибкость

- `formatTranscriptForPrompt` — стабильная сериализация, влияющая на extraction quality. **Рекомендация:** использовать тот же формат, что в `scripts/prompt-test.ts` (validated в Story 0.3): `[MM:SS] {speakerName}: {text}`. Любая смена формата → пересмотр canary diff.
- `formatStakeholderMapForPrompt` — `JSON.stringify(stakeholders, null, 2)` достаточно. Промпт обрабатывает JSON-блок (Story 0.3 валидация прошла на JSON-блоке).
- `formatOkrContextForPrompt` — JSON-объект `{ okrs, f5Metrics? }`. F5 опционально (опускается если пуст), чтобы не путать промпт пустыми массивами.
- **НЕ** генерировать markdown-таблицы вручную — JSON парсится промптом без проблем, таблицы хрупкие.

### Persistence — структура файлов в `data/`

```
data/
└── geonline/
    └── 2026-05-01/
        ├── f1-жанель-a3b9c2d1.extraction.raw.txt   ← raw Claude output
        ├── f1-жанель-a3b9c2d1.extraction.json      ← parsed ExtractionOutput
        ├── f1-жанель-a3b9c2d1.analysis.raw.txt
        ├── f1-жанель-a3b9c2d1.analysis.json
        └── f1-жанель-a3b9c2d1.meta.json            ← аудит (durations, tokens, openCommitmentsBefore)
```

- `data/` — в `.gitignore` (Story 1.1 уже добавил)
- Filename: `f1-{topNameSlug}-{shortId}.{stepName}.{ext}` — slug из имени топа (cyrillic OK на Linux), shortId = 8 hex от UUID
- meta.json — пишется ОДИН раз в конце (или в catch для partial-state аудита), не после каждого шага
- Старые директории НЕ удаляются автоматически в 1.4a (auto-cleanup deferred Story 1.9)

### Cross-session commitments — MVP-чтение, НЕ запись

- Story 1.4a реализует **только чтение** open commitments из локальных JSON (см. Задача 5).
- Запись/обновление статусов commitments — Story 1.4b или Story 1.10 (formal persistence layer).
- На 1.4a `commitments_status_updates` из analysis output **возвращается caller'у**, но **НЕ применяется** (caller — smoke-test или Story 1.4b — может его смотреть для отладки промптов).
- Дедупликация: если один и тот же commitment встречается в нескольких файлах (повторяется в 2+ встречах), берётся **последний по mtime** — это даёт правильное поведение когда Story 1.4b начнёт перезаписывать статусы.
- **maxAgeDays: 90** — cap на сколько прошлых встреч смотреть. Топ ≥ 90 дней с момента последней встречи — commitments считаются устаревшими (закрыты по умолчанию). На MVP с одним клиентом за 4 недели — ≤ 16 встреч/топ, без проблем.

### Speaker mapping — где он происходит

- **Provider parser (Story 1.2):** `parseSonioxTokens` сохраняет имена спикеров как `Speaker 1`, `Speaker 2`, ... Никакого mapping в провайдере.
- **Plain text parser (Story 1.2):** если транскрипт содержит формат `Имя: текст` — имена сохраняются буквально (NAME_LINE_RE). Если `Speaker N: текст` — Speaker N. Иначе всё под `Speaker 1`.
- **F1 extraction prompt (Story 1.4a):** получает `stakeholderMap` (роли + имена) И `transcript` с буквальными именами. Промпт делает mapping на основе содержания реплик и ролей. Возвращает в `commitments[].who` и `citations[].speaker` — **уже** имя из карты (если уверенность высокая) или `Speaker N` (если нет).
- **70% threshold:** реализован промптом (extraction.md → `speaker_check[]`). Код 1.4a **не вычисляет** этот порог; он передаёт массив дальше в analysis.
- **alerts:** analysis.md обрабатывает `extraction.speaker_check[]` и пишет элемент в `analysis.alerts[]` для каждого проверенного спикера ("Спикер X требует ручной проверки соответствия роли").

### Уроки Story 1.1, 1.2, 1.3 — применять

| # | Лекция | Применение в Story 1.4a |
|---|--------|--------------------------|
| 1 | Async I/O в адаптерах (Story 1.2 IWE) | `fs.promises.readFile/writeFile/mkdir`, `fs.promises.stat` — никогда `*Sync` |
| 2 | `withRetry` shouldRetry policy per-provider (Story 1.2/1.3) | Свой `shouldRetryClaude` (учёт 529 overloaded, Anthropic-specific status field) |
| 3 | Latency logging в `finally` (Story 1.2/1.3) | Логи durationMs на каждый шаг + total, warn на > 15 min SLA |
| 4 | Zod-валидация на границе (Story 1.2/1.3) | `Schema.parse` (НЕ safeParse) на extraction/analysis output |
| 5 | Error-таксономия с `cause` (Story 1.2/1.3) | `F1PipelineError(code, context, { cause })` — все ZodError/SDK-error wrapped |
| 6 | `child` logger через optional param (Story 1.2/1.3) | `runF1Steps12({ deps: { logger } })` принимает родительский logger |
| 7 | Test mocks через `vi.mock` (Story 1.2/1.3) | Та же стратегия для `@anthropic-ai/sdk` |
| 8 | Не ломать regression тесты (Story 1.3: 58 → 87) | После 1.4a 87 → 110-130 тестов, все green |
| 9 | Lazy singleton + `_resetForTest` (Story 1.3 sheets) | `_resetClaudeClientForTest()` для чистоты модулей в vitest |
| 10 | provider-agnostic boundary (Story 1.2 transcript, 1.3 sheets) | `claude.ts` единственная точка контакта с Anthropic SDK |
| 11 | Persistence как warn-only side-effect (новое в 1.4a) | persistStep failure → log.error + alertOps, но НЕ throw |

### Anti-patterns (запрещено — grep-rules)

- ❌ `const prompt = \`... {{transcript}} ...\`` — inline-промпт в .ts (rule architecture#Anti-patterns)
- ❌ `JSON.parse(claudeResponse.content[0].text)` — без `parseClaudeJSON` (rule architecture#Anti-patterns)
- ❌ `await client.messages.create(...)` напрямую вне `src/adapters/claude.ts` (rule architecture#Boundaries)
- ❌ `console.log` где угодно — всегда `logger.child(...)`
- ❌ `fs.readFileSync`, `fs.writeFileSync` — только async через `fs.promises` (Story 1.2 IWE)
- ❌ `existsSync` перед `readFile` — anti-pattern (TOCTOU race); используем try/catch на readFile
- ❌ Silent catch без alertOps + log.error — каждая ловля логирует и алертит (где не warn-only, как persist)
- ❌ Хардкод модели `'claude-sonnet-4-6'` в коде — только через `config.ANTHROPIC_MODEL` (тестовый дефолт можно)
- ❌ Inline `withRetry`-логика — использовать общий `src/utils/retry.ts` (Story 1.2)
- ❌ Захардкоженный `process.cwd()` в промпт-loader без возможности override — мешает тестам; передавать `rootDir` через opts опционально (NB: PROMPTS_DIR — `process.cwd() + '/prompts'`, в тестах достаточно `vi.spyOn(process, 'cwd')` или setup tmpdir)

### Зависимости между stories

- **Зависит от Story 1.1 (review):** `config.ANTHROPIC_API_KEY`, `logger`, ops module готовы.
- **Зависит от Story 1.2 (done):** `withRetry`, `Transcript`/`TranscriptSchema`, `parseSonioxTokens` — стабильно.
- **Зависит от Story 1.3 (done):** `readClientContext`, `ClientContext`/`ClientContextSchema`, `Stakeholder`/`OkrKr`/`F5Metric` schemas — экспонированы.
- **Параллельно с Story 0.4/0.5/0.6:** не зависят (юридика, runbook, инструкция).
- **Blocks Story 1.4b (formatting + delivery prep):** контракт `{ extraction, analysis, openCommitmentsBefore }` фиксируется здесь; 1.4b читает persisted JSON (или принимает result в-памяти от 1.4a).
- **Blocks Story 1.5 (Telegram /report):** caller для `runF1Steps12`. Bot создаст AbortController с timeout и progress updates через `editMessageText` между шагами (callback `onStepComplete?: (stepName) => void` рассмотреть; **на 1.4a — НЕ добавляем**, чтобы не предусматривать UX-детали ботиных progress updates до Story 1.5).
- **Используется Story 1.11 (canary):** runF1Steps12 → diff с golden references; threshold < 30% structural diff.
- **Использует source Story 0.3 golden dataset** (`data/golden/transcript-N.json`, `f1-reference-N.json`) — в unit-тестах + smoke.
- **Использует prompts Story 0.3 v1.0.0** (extraction.md, analysis.md) — bump до v1.1.0 здесь (только analysis.md меняется).

### Project Structure Notes

- **Создаваемые файлы:**
  - `src/f1-report.ts` (~250 LOC; ~350 включая шаги 3-4 в Story 1.4b)
  - `src/f1-report.test.ts` (~10 тестов)
  - `src/adapters/claude.ts` (~120 LOC)
  - `src/adapters/claude.test.ts` (~8-10 тестов)
  - `src/utils/prompt-loader.ts` (~30 LOC)
  - `src/utils/prompt-loader.test.ts` (~5 тестов)
  - `src/utils/commitments-history.ts` (~40 LOC)
  - `src/utils/commitments-history.test.ts` (~6 тестов)
  - `scripts/f1-smoke.ts` (~40 LOC, manual)
- **Изменения:**
  - `src/types.ts` — добавлены `ExtractionOutputSchema`, `AnalysisOutputSchema`, `CommitmentSchema`, `CitationSchema`, `OkrCoverageItemSchema`, `HypothesisItemSchema` + типы
  - `src/errors.ts` — добавлен `F1PipelineError` + `F1PipelineCode` (7 кодов)
  - `src/config.ts` — добавлены `ANTHROPIC_MODEL`, `CLAUDE_MAX_TOKENS`, `CLAUDE_TIMEOUT_MS`
  - `.env.example` — добавлены 3 vars
  - `vitest.config.ts` — test-defaults для 3 vars
  - `package.json` — script `f1:smoke`
  - `prompts/analysis.md` — добавлены `{{openCommitments}}` + `commitments_status_updates`
  - `prompts/CHANGELOG.md` — bump v1.1.0
  - `_bmad-output/implementation-artifacts/deferred-work.md` — добавлены 5 deferred карточек
  - `_bmad-output/implementation-artifacts/sprint-status.yaml` — story 1-4a → ready-for-dev → in-progress → review
- Соответствует `architecture.md#Updated Project Structure (post-validation)` lines 681-734. Архитектурный budget `f1-report.ts ~350 LOC` сохраняется (1.4a + 1.4b в сумме); 1.4a один — ~250.

### Source Tree (после Story 1.4a)

```
src/
├── adapters/
│   ├── claude.ts          ← NEW (1.4a)
│   ├── claude.test.ts     ← NEW (1.4a)
│   ├── drive.ts
│   ├── drive.test.ts
│   ├── sheets.ts
│   ├── sheets.test.ts
│   ├── soniox.ts
│   ├── transcript.ts
│   ├── transcript.test.ts
│   └── transcript.schema.test.ts
├── utils/
│   ├── google-auth.ts
│   ├── google-auth.test.ts
│   ├── retry.ts
│   ├── retry.test.ts
│   ├── prompt-loader.ts          ← NEW (1.4a)
│   ├── prompt-loader.test.ts     ← NEW (1.4a)
│   ├── commitments-history.ts    ← NEW (1.4a)
│   └── commitments-history.test.ts ← NEW (1.4a)
├── config.ts
├── errors.ts
├── index.ts
├── logger.ts
├── ops.ts
├── server.ts
├── types.ts
├── f1-report.ts           ← NEW (1.4a — шаги 1-2; 1.4b расширит)
└── f1-report.test.ts      ← NEW (1.4a)
prompts/
├── CHANGELOG.md           ← bump v1.1.0 (1.4a)
├── agenda.md
├── analysis.md            ← MODIFIED v1.1.0 (1.4a)
├── extraction.md          ← unchanged v1.0.0
├── format-tracker.md      ← used in 1.4b only
└── examples/
    ├── commitments-negative.md
    └── commitments-positive.md
scripts/
└── f1-smoke.ts            ← NEW (1.4a)
```

### Тестовая стратегия — что и как тестируем

| Категория | Что | Как |
|----------|-----|-----|
| Unit (prompt-loader) | loadPrompt поведение | mock fs OR temp prompts dir |
| Unit (claude wrapper) | callClaude retry / parseJSON / markdown fences | `vi.mock('@anthropic-ai/sdk')` |
| Unit (commitments-history) | loadOpenCommitments правила | tmpdir + ручные fixture-файлы |
| Unit (f1-report) | runF1Steps12 flow + error paths | mock callClaude + mock loadOpenCommitments |
| Regression | golden transcripts → mock-driven prediction | data/golden/transcript-N.json + mock callClaude returning f1-reference-N.* |
| Integration | реальный Claude API | scripts/f1-smoke.ts — manual, не CI |
| Canary (Story 1.11) | structural diff vs golden | НЕ в этой story; 1.11 строит автомат |

### F5 metrics на 1.4a — empty-OK

ClientContext.f5Metrics на MVP пуст (Sheets `_f5_metrics` лист содержит только headers, Story 0.2 #2). На 1.4a:
- **extraction**: НЕ получает f5Metrics (промпт extraction.md не использует переменную {{f5Metrics}})
- **analysis**: получает {{okrContext}} = `{ okrs, f5Metrics? }` (опускаем поле если пусто; см. Задача 6.4)
- **верификация заявлений vs метрик** — не работает на MVP (нет данных). analysis.md инструкция: "Если f5Metrics отсутствует — пропусти блок верификации". На golden-фикстурах f5Metrics === [] (Story 0.3 был тоже без F5) — поведение гарантировано совместимо.

### Контракт Story 1.4a → 1.4b

```ts
// Возвращаемое из runF1Steps12 (1.4a):
{
  extraction: ExtractionOutput,         // ← вход для format-tracker промпта (1.4b)
  analysis: AnalysisOutput,             // ← вход для format-tracker промпта (1.4b)
  rawResponses: { extraction, analysis }, // ← аудит, для дебага
  openCommitmentsBefore: Commitment[],  // ← аудит (commitments_status_updates применяются в 1.4b)
  reportId: string,                     // ← для consistent именования файлов в 1.4b
  durationsMs, tokens                   // ← для SLA/cost метрик
}
```

1.4b расширит `f1-report.ts`:
- `runF1Steps34({ extraction, analysis, deps })` → `{ formatted: FormattedReport, deliveryReady: string }`
- ИЛИ полный pipeline `runF1({ ... })` который вызывает 12 + 34 в одной функции
- На 1.4a выбираем подход: **Раздельные функции** (`runF1Steps12` + `runF1Steps34` будущая) — позволяет caller'у получить partial result при сбое 3-4 (FR30 — graceful degradation на formatting/delivery, см. epics.md#1.4b AC `Given шаги 1-2 успешны, шаги 3-4 упали`).

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 1.4a — lines 562-584 (BDD ACs)]
- [Source: _bmad-output/planning-artifacts/epics.md#Story 1.4b — lines 586-605 (контракт перехода)]
- [Source: _bmad-output/planning-artifacts/epics.md#FR1-FR6 — lines 869-874 (extraction/analysis FRs)]
- [Source: _bmad-output/planning-artifacts/epics.md#FR21-FR24 — lines 901-904 (stakeholder map, OKR, commitments, isolation)]
- [Source: _bmad-output/planning-artifacts/epics.md#FR27-FR35 — lines 910-921 (workflow, ops, validation)]
- [Source: _bmad-output/planning-artifacts/prd.md — lines 504 (speaker_check 70%), 513-514 (extraction/analysis steps), 518 (citation verification + [approximate]), 522 (graceful degradation), 526-535 (F1 Real-time pipeline), 794-798 (commitments engine + accountability marks)]
- [Source: _bmad-output/planning-artifacts/architecture.md — lines 70-77 (chain of prompts, Claude API), 132-134 (claude.ts adapter ~60), 290-297 (Data Architecture), 313-321 (Retry, Circuit Breaker, Idempotency), 391-394 (Cross-component dependencies — claude.ts ← f1, f4, f3-lite), 428-446 (Format/Logging/Process Patterns), 449-491 (Prompt Loading, Claude Output Parsing, Zod Strategy, Retry, Circuit Breaker), 494-512 (Enforcement + Anti-patterns), 657 (Hindsight #5 raw response), 681-734 (Updated structure)]
- [Source: _bmad-output/implementation-artifacts/1-1-project-bootstrap-i-konfiguraciya.md — config.ts ANTHROPIC_API_KEY паттерн, logger.child, ops.alertOps]
- [Source: _bmad-output/implementation-artifacts/1-2-transcript-interface-contract-audio-download-i-soniox-parser.md — TranscriptSchema, parseSonioxTokens, async I/O lessons, withRetry policy patterns]
- [Source: _bmad-output/implementation-artifacts/1-3-sheets-adapter-chtenie-konteksta-klienta.md — readClientContext API, ClientContextSchema, child-logger pattern, error taxonomy w/ cause]
- [Source: _bmad-output/implementation-artifacts/0-3-testirovanie-promptov-i-golden-dataset.md — promts v1.0.0 GO, golden manifest 7 транскриптов]
- [Source: prompts/extraction.md (v1.0.0) — speaker_check rules, [approximate] метки, commitments rules]
- [Source: prompts/analysis.md (v1.0.0 → v1.1.0 в этой story) — okr_coverage, hypothesis_status, alerts]
- [Source: prompts/examples/commitments-positive.md, commitments-negative.md — few-shot для extraction]
- [Source: prompts/CHANGELOG.md — v1.0.0 validation 2026-04-20]
- [Source: scripts/prompt-test.ts — Story 0.3 reference: prompt loading, Claude call, JSON parsing, retry — паттерны переносятся в production claude.ts]
- [Source: src/adapters/sheets.ts — образец error taxonomy + retry + latency log]
- [Source: src/adapters/transcript.ts — образец persistShortcut-style total-timing finally + alertOps в catch]
- [Source: src/utils/retry.ts — withRetry signature + defaultShouldRetry образец]
- [Source: data/golden/manifest.json — 7 транскриптов, ожидаемые counts по commitments/citations/decisions/facts/alerts/okr_coverage для regression-тестов]
- [Source: data/stakeholder-map.json, data/okr-context.json — фикстуры для smoke + regression]
- [Source: @anthropic-ai/sdk@^0.90.0 docs — https://docs.anthropic.com/en/api/client-sdks; https://github.com/anthropics/anthropic-sdk-typescript]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (1M context)

### Debug Log References

- `npm run typecheck` → 0 ошибок
- `npm test` → 124/124 тестов проходят (после Story 1.3 было 87 → +37 новых F1-теста, включая 3 регрессии review-fix)
- `npm run build && find dist -name "*.test.js"` → пусто (test-файлы корректно исключены)
- Grep enforcement (architecture.md):
  - `grep -rE 'anthropic\.messages\.create|new Anthropic\(' src/ -l` → только `src/adapters/claude.ts` ✅
  - `grep -rE 'const\s+\w+\s*=\s*\`[^\`]*\{\{' src/` → 0 результатов ✅ (нет inline-промптов с `{{vars}}`)
  - `grep -rE 'JSON\.parse\(\s*[a-zA-Z_]+\.content\b|JSON\.parse\(\s*raw\b' src/adapters/ src/f1-report.ts` → 0 (только через `parseClaudeJSON`) ✅

### Completion Notes List

- **Шаги 1-2 F1 pipeline реализованы** — `runF1Steps12({transcript, clientContext, meta, deps?})` собирает extraction + analysis с persistence и логированием. Возвращает `{ extraction, analysis, rawResponses, openCommitmentsBefore, reportId, durationsMs, tokens }` — контракт для Story 1.4b/1.5.
- **Provider-agnostic boundary** — `src/adapters/claude.ts` единственная точка контакта с `@anthropic-ai/sdk`. Замена LLM = замена адаптера без изменений downstream. Контракт: `CallClaudeResult<T> = {raw, parsed, usage}`.
- **Prompt loader** — `loadPrompt(name, vars)` через `fs.promises.readFile` (async, лекция Story 1.2 IWE), fail-fast на любые незаменённые `{{var}}` через `F1PipelineError('prompt_load')`. PROMPTS_DIR конфигурируется через opts для тестов.
- **Schema enforcement** — `parseClaudeJSON()` использует `Schema.parse()` (НЕ `safeParse`) на extraction/analysis, кидает `F1PipelineError('claude_response_invalid', { raw, ... })` на JSON/Zod fail. Caller `runF1Steps12` re-wrap'ит в step-specific code (`extraction_validation`/`analysis_validation`) и **сохраняет raw в .raw.txt** для дебага даже при validation fail (Day-1 fix #5).
- **Cross-session commitments (FR23)** — `loadOpenCommitments(clientId, topName, opts)` читает прошлые `f1-{topNameSlug}-*.extraction.json`, фильтрует по mtime > now-90d, дедуплицирует по `who+what+deadline` (последний по mtime побеждает) **по ВСЕМ статусам**, и только потом отфильтровывает не-open. Это исключает воскрешение обязательства, которое было закрыто в более поздней сессии (review fix 2026-04-30). На несовместимый schema → log.warn + skip (graceful, не throw). Передача в analysis-промпт через новую переменную `{{openCommitments}}`.
- **Persistence** — `data/{clientId}/{YYYY-MM-DD}/f1-{topNameSlug}-{shortId}.{step}.{raw.txt|json}` + `.meta.json` (durationsMs, tokens, openCommitmentsBefore, model, status). Все async. Persist failure → log.error + alertOps, **НЕ throw** (warn-only side-effect).
- **Retry policy** — `shouldRetryClaude` retryable: 429, 500-599, 529 (Anthropic overloaded), сетевые коды (ECONNRESET, ETIMEDOUT, ENOTFOUND, EAI_AGAIN, ECONNREFUSED). НЕ retryable: 400, 401, 403, AbortError. Backoff `[1000, 3000, 9000]` ms через общий `withRetry` (Story 1.2).
- **AbortSignal** — пробрасывается из `runF1Steps12.deps.signal` в `callClaude` → SDK через `messages.create(args, { signal })` И в `withRetry({ signal })`. Сигнал прерывает не только in-flight запрос (через SDK), но и backoff-сон между попытками (через signal-aware `defaultSleep`). `withRetry` после abort не делает следующую попытку. AC #13 — graceful cancel "во время Claude API call ИЛИ во время backoff" (review fix 2026-04-30).
- **SLA monitoring** — `f1.run.total > 15 min` → log.warn с `slaExceeded: true`. Latency на каждый шаг (extraction, analysis) + total в `finally`.
- **Empty client context guard** (AC #11) — defensive проверка `stakeholders.length === 0 || okrs.length === 0` до Claude call (zero-cost fail). Бросает `F1PipelineError('extraction_validation', { reason: 'empty_client_context', ... })` — единый код пути для всех pre-Claude валидационных ошибок (review fix 2026-04-30).
- **F5 metrics empty-OK** (AC #10) — `formatOkrContextForPrompt` ВСЕГДА включает поле `f5Metrics` (как `[]` если пусто), потому что промпт `analysis.md` ожидает наличия поля для условной ветки "верификация заявлений топов" (review fix 2026-04-30).
- **Prompts v1.1.0** — `prompts/analysis.md` обновлён: добавлена переменная `{{openCommitments}}` (input) и поле `commitments_status_updates` (output). Backward-compat с golden-фикстурами обеспечен Zod default `[]`. Prompt CHANGELOG bumped.
- **Config** — добавлены `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`), `CLAUDE_MAX_TOKENS` (default `8192`), `CLAUDE_TIMEOUT_MS` (default `120000`). `.env.example` и `vitest.config.ts` обновлены.
- **Smoke-test** — `npm run f1:smoke [transcript.json]` запускает реальный F1 pipeline на golden-фикстуре (требует `ANTHROPIC_API_KEY`). Не запускается в CI. Output → `data/smoke-results/`.
- **Deferred work** (Story 1.9 / 1.4b / Growth):
  - Claude circuit breaker (3 fail/5 min → fallback) — заглушка `isClaudeCircuitOpen() === false`
  - Auto-cleanup `*.raw.txt` через 14 дней
  - Smart transcript trimming для `context_length_exceeded`
  - Запись/обновление статусов commitments в `data/`
  - Streaming Claude response
  - Prompt caching через `cache_control` блоки

### File List

**New files:**
- `src/adapters/claude.ts` — Claude API wrapper (~190 LOC)
- `src/adapters/claude.test.ts` — 11 unit-тестов
- `src/utils/prompt-loader.ts` — async prompt loader (~40 LOC)
- `src/utils/prompt-loader.test.ts` — 5 unit-тестов
- `src/utils/commitments-history.ts` — cross-session commitments reader (~110 LOC)
- `src/utils/commitments-history.test.ts` — 7 unit-тестов
- `src/f1-report.ts` — F1 pipeline шаги 1-2 (~430 LOC)
- `src/f1-report.test.ts` — 11 unit-тестов (включая formatters)
- `scripts/f1-smoke.ts` — manual smoke-test (~80 LOC)

**Modified files:**
- `src/types.ts` — добавлены `CommitmentSchema`, `CitationSchema`, `ExtractionOutputSchema`, `OkrCoverageItemSchema`, `HypothesisItemSchema`, `CommitmentStatusUpdateSchema`, `AnalysisOutputSchema` + типы
- `src/errors.ts` — добавлен `F1PipelineError` + `F1PipelineCode` (7 кодов)
- `src/config.ts` — добавлены `ANTHROPIC_MODEL`, `CLAUDE_MAX_TOKENS`, `CLAUDE_TIMEOUT_MS`
- `src/utils/retry.ts` — добавлены `signal` в `WithRetryOptions`, signal-aware `defaultSleep` (race против abort), pre-attempt + post-fn `signal.aborted` короткое замыкание (review fix 2026-04-30)
- `src/utils/retry.test.ts` — обновлены 2 теста (sleep теперь принимает signal как 2-й arg) + 2 новых теста на abort-during-backoff и pre-aborted-signal
- `src/utils/commitments-history.ts` — дедупликация по всем статусам с пост-фильтром `open` (review fix 2026-04-30)
- `src/utils/commitments-history.test.ts` — добавлен тест "не воскрешает обязательство, закрытое в более новом файле"
- `src/adapters/claude.ts` — `withRetry` теперь получает `signal: opts.signal` (review fix 2026-04-30)
- `src/f1-report.ts` — `formatOkrContextForPrompt` всегда включает `f5Metrics` (review fix); empty-client guard теперь throws `extraction_validation` w/ `reason: 'empty_client_context'` (review fix)
- `src/f1-report.test.ts` — обновлены 2 теста (empty_client + f5Metrics empty)
- `.env.example` — 3 новых vars (Anthropic config)
- `vitest.config.ts` — test-defaults для 3 новых vars
- `package.json` — script `"f1:smoke"`
- `prompts/analysis.md` — v1.1.0: `{{openCommitments}}` + `commitments_status_updates`
- `prompts/CHANGELOG.md` — bump v1.1.0
- `_bmad-output/implementation-artifacts/deferred-work.md` — добавлены 6 deferred карточек Story 1.4a
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — story 1-4a → ready-for-dev → in-progress → review

## Change Log

| Дата | Версия | Описание | Автор |
|------|--------|----------|-------|
| 2026-04-30 | 1.0.0 | F1 pipeline шаги 1-2: claude.ts wrapper, prompt-loader, commitments-history, f1-report.ts (extraction + analysis с persistence, retry, validation, SLA-мониторингом, AbortSignal). Prompts bumped до v1.1.0 (analysis.md: `{{openCommitments}}` + `commitments_status_updates`). 121/121 тестов проходят. | claude-opus-4-7 (Dev Agent) |
| 2026-04-30 | 1.0.1 | Code-review fixes: (1) `loadOpenCommitments` дедуплицирует по всем статусам и пост-фильтрует `open` — больше не воскрешает обязательство, закрытое в более новой сессии; (2) `withRetry` теперь принимает `signal` и signal-aware `defaultSleep` — abort прерывает backoff-сон без задержки; `claude.ts` пробрасывает `opts.signal`; (3) `formatOkrContextForPrompt` всегда включает `f5Metrics: []` (контракт AC #10); (4) empty-client guard бросает `F1PipelineError('extraction_validation', { reason: 'empty_client_context', ... })` (контракт AC #11). 124/124 тестов проходят (+3 регрессии). | claude-opus-4-7 (Dev Agent) |
| 2026-05-15 | 1.0.2 | Code-review iter 2 (26 patches): **HIGH** — P1 SLA log emit both warn+info с status, P2 process.env→config.ANTHROPIC_MODEL, P3 paired markdown fence stripping (case-insensitive, no false trailing strip), P4 concat all text blocks (не только первый), P5 withRetry throw makeAbortError() on signal aborted, P6 shouldRetryClaude retry on AbortError/TimeoutError (caller-abort short-circuited upstream), P7 single-pass placeholder substitution (no cross-injection), P8 deterministic mtime tiebreaker (dateOrder secondary), P9 slugifyClientId before fs path join, P10 meetingDate format validation guard; **MEDIUM** — P11 inter-step signal.aborted check, P12 try/catch wokrшг loadOpenCommitments (no claude_api mislabel), P13 defensive usage null, P14 typeof string check в loadPrompt, P15 Array.isArray в empty-client guard, P20 dead 'empty_client_context' code удалён, P17/P18/P19 missing tests (Task 10.6/10.8/10.9); **LOW** — P21 walk error.cause chain, P22 broaden UNREPLACED_RE до /\{\{[^}\s]+\}\}/g, P23 f1-smoke ISO offset, P24 topName CLI override, P25 HH:MM:SS для встреч > 60 мин, P26 status='aborted' meta entry. **Decisions:** D1/D2/D3 keep extras (runF1 smoke / analysis.md alerts / CHANGELOG bullets), D4/D5 accept MVP-limit (slug collision, reportId 32-bit), D6 → P26. **Side-effect:** binary file detection git fixed — `commitments-history.ts` NUL separator теперь `String.fromCharCode(0)` (runtime поведение тоже же, файл plain ASCII). 147/147 тестов проходят, typecheck + build чистые, grep enforcement passes. | claude-opus-4-7 (Code Review) |

## Review Findings (2026-05-15, code-review iter 2)

Источник: 3 параллельных adversarial reviewers (Blind Hunter / Edge Case Hunter / Acceptance Auditor) против полной спецификации 1.4a. Триаж: 6 decision-needed, 25 patch, 6 defer, ~28 dismissed как шум/вне scope (1.4b/cosmetic/defensive-already-handled).

### Decision-needed (resolved 2026-05-15)

- [x] [Review][Decision] **D1 → KEEP runF1** — Spec Task 9.1 говорил `runF1Steps12`, но 1.4b уже сделан и полный pipeline полезнее как smoke. Принято как осознанное отклонение от Task 9.1.
- [x] [Review][Decision] **D2 → KEEP extras в `prompts/analysis.md`** — Доп. правила alert (overdue + approximate) покрывают AC #4 и AC #9; Task 7.2 retrospectively обновляется.
- [x] [Review][Decision] **D3 → KEEP extras в `prompts/CHANGELOG.md`** — Согласовано с D2; 5 буллетов отражают фактические изменения.
- [x] [Review][Decision] **D4 → ACCEPT MVP-limit** — `topNameSlug` collision документируется как known-limitation для MVP (1 клиент с уникальными именами). Триггер усиления: 2-й клиент или появление в одном клиенте топов с одинаковым именем. Перенесено в [defer].
- [x] [Review][Decision] **D5 → ACCEPT MVP-risk** — `reportId` 32-bit collision на 5 встречах/нед практически невозможна. Перенесено в [defer].
- [x] [Review][Decision] **D6 → WRITE `status='aborted'` entry** — finally-блок при abort пишет минимальный meta.json для аудит-следа. Переведено в [patch] (см. P26).

### Patch (нужны патчи; правка однозначна)

**HIGH (наблюдаемость / корректность):**

- [x] [Review][Patch] **P1. SLA-ветка подавляет канонический `f1.run.total` info-лог** [src/f1-report.ts:1794-1813] — `if/else` эмитит warn ИЛИ info. На SLA-нарушении пайплайн метрик потеряет `step:'f1.run.total'` с `status` полем. Фикс: всегда логировать info, отдельно warn по SLA.
- [x] [Review][Patch] **P2. `process.env.ANTHROPIC_MODEL` читается напрямую, в обход validated config** [src/f1-report.ts:1569, 1824] — нарушение Anti-pattern #8 spec lines 921-930. Фикс: использовать `config.ANTHROPIC_MODEL` (импортирован в claude.ts; импортировать и в f1-report.ts).
- [x] [Review][Patch] **P3. `stripMarkdownFences` обрезает trailing `` ``` `` безусловно** [src/adapters/claude.ts:80-86] — strip-end происходит независимо от matched-start; case-sensitive `'```json'` не ловит `'```JSON'`. Фикс: regex `/^```(?:json)?\s*([\s\S]*?)\s*```$/i` ИЛИ парные guard'ы.
- [x] [Review][Patch] **P4. `executeClaudeCall` читает только ПЕРВЫЙ text-блок** [src/adapters/claude.ts:195] — `.find((b) => b.type === 'text')` теряет последующие text-блоки (SDK может отдать массив > 1). Фикс: `.filter().map(b => b.text).join('')`.
- [x] [Review][Patch] **P5. `withRetry` re-throw'ит ОРИГИНАЛЬНЫЙ err при `signal.aborted`** [src/utils/retry.ts:124] — caller's `isAbortError(err)` не сработает; ошибка попадёт в `claude_api`-обёртку вместо AbortError-пути. Фикс: `throw makeAbortError()` вместо `throw err` (как на pre-loop guard line 117).
- [x] [Review][Patch] **P6. `shouldRetryClaude` не различает caller-abort vs SDK-internal-timeout** [src/adapters/claude.ts:532] — все `AbortError` считаются нерет-райабельными; SDK-internal-timeout (fetch-level) тоже теряется. Spec Task 4.5 требует retry на internal timeout. Фикс: `if (e.name === 'AbortError' && opts.signal?.aborted) return false; if (e.name === 'AbortError') return true;`.
- [x] [Review][Patch] **P7. `loadPrompt` cross-substitution: значения с `{{var}}` в тексте инжектят вторичные подстановки** [src/utils/prompt-loader.ts:28-30] — `transcript = "...{{stakeholderMap}}..."` приведёт к подстановке `stakeholderMap` ВНУТРИ transcript. Реальный риск, т.к. транскрипты — user-controlled. Фикс: single-pass replacement через `content.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (m, k) => vars[k] ?? m)`.
- [x] [Review][Patch] **P8. `loadOpenCommitments` mtime-tie недетерминирован** [src/utils/commitments-history.ts:121-127] — при равенстве mtime (batch regen, tarball restore) iteration order определяет победителя; `fs.readdir` order зависит от FS. Фикс: tiebreaker по `dateDir desc + filename`, либо `>=`.
- [x] [Review][Patch] **P9. `clientId` не санитайзится перед `join(rootDir, clientId, ...)`** [src/f1-report.ts persist*] — `'../etc'`, `'a/b'` или Windows-неприемлемые символы вызовут write-failure (silent — warn-only) или path-traversal. Фикс: `slugifyClientId(clientId)` через тот же helper, что и для topName, ИЛИ regex-валидация на entry.
- [x] [Review][Patch] **P10. `meta.meetingDate` не валидируется до `.slice(0, 10)`** [src/f1-report.ts:117,170,1423,1476] — non-ISO `meetingDate` (`30.04.2026`, `""`) создаёт малформированный date-dir, невидимый для `loadOpenCommitments` (`DATE_DIR_RE`). Фикс: guard в начале `runF1Steps12`: `if (!/^\d{4}-\d{2}-\d{2}/.test(meta.meetingDate)) throw F1PipelineError('extraction_validation', { reason: 'invalid_meeting_date' })`.

**MEDIUM:**

- [x] [Review][Patch] **P11. Нет AbortSignal-check между Step 1 и Step 2 в `runF1Steps12`** [src/f1-report.ts:1647-1664] — caller может прервать после extraction; функция всё равно построит analysis prompt и сделает claude call. Фикс: `if (deps.signal?.aborted) throw makeAbortError()` после persistStep extraction.
- [x] [Review][Patch] **P12. `runF1Steps12` оборачивает FS/loadOpenCommitments errors как `claude_api`** [src/f1-report.ts:1776] — alertOps-таксономия искажена. Фикс: try/catch вокруг `loadOpenCommitments` отдельно, маппинг в специфический код (или `prompt_load`/новый).
- [x] [Review][Patch] **P13. `executeClaudeCall` читает `response.usage.input_tokens` без null-check** [src/adapters/claude.ts:203,211] — future SDK / partial response → TypeError, минуя `F1PipelineError`-контракт. Фикс: `usage?.input_tokens ?? 0`.
- [x] [Review][Patch] **P14. `loadPrompt` не проверяет `typeof vars[k] === 'string'`** [src/utils/prompt-loader.ts:28] — `undefined` коэрсится в `'undefined'` и отправляется в Claude. Фикс: `if (typeof v !== 'string') throw F1PipelineError('prompt_load', { reason: 'non_string_var', key: k, type: typeof v })`.
- [x] [Review][Patch] **P15. `runF1Steps12` empty-client guard падает с raw `TypeError` если `stakeholders` undefined** [src/f1-report.ts:213-225] — тесты передают `as unknown as` обход Zod. Фикс: optional-chain + `Array.isArray`: `if (!Array.isArray(c?.stakeholders) || c.stakeholders.length === 0 || ...)`.
- [x] [Review][Patch] **P16. `analysis_validation` raw НЕ сохраняется при `no_text_block` failure** [src/f1-report.ts:1701-1712] — `err.context.raw` отсутствует на pre-parse failures; `analysisRaw` ещё `undefined` → нет `analysis.raw.txt`. Фикс: всегда писать .raw.txt если raw был получен (захватить `executeClaudeCall` partial-response через дополнительный mechanism), или хотя бы emit warning в alertOps.
- [x] [Review][Patch] **P17. AbortSignal cancellation тест для `runF1Steps12` отсутствует (Task 10.8)** [src/f1-report.test.ts] — единственный AbortError-тест внутри `describe('runF1Steps34')` (1.4b). Фикс: добавить тест в `describe('runF1Steps12')`.
- [x] [Review][Patch] **P18. SLA-warn тест отсутствует (Task 10.9)** [src/f1-report.test.ts] — связан с P1; вероятно требует `vi.useFakeTimers` или mock `Date.now`. Фикс: добавить тест.
- [x] [Review][Patch] **P19. Step-2 `claude_api` fail тест отсутствует (Task 10.6)** [src/f1-report.test.ts] — есть только step-2 validation fail. Фикс: добавить тест с `claudeFn` бросающим claude_api на втором вызове + проверка `alertOps`.
- [x] [Review][Patch] **P20. Dead member `'empty_client_context'` в `F1PipelineCode`** [src/errors.ts:134-141] — review-fix v1.0.1 reroute через `extraction_validation`; код в union больше не emit-ится. Фикс: удалить из union.

**LOW:**

- [x] [Review][Patch] **P21. `shouldRetryClaude` не проверяет `error.cause`** [src/adapters/claude.ts:545-547] — undici ECONNRESET оборачивается в Anthropic SDK; `e.message` может не матчить. Фикс: walk `.cause` цепочку для `code`/`message`.
- [x] [Review][Patch] **P22. `UNREPLACED_RE` отвергает dots/hyphens/digits-first** [src/utils/prompt-loader.ts:5] — будущий автор промптов с `{{week-number}}` или `{{client.id}}` не получит ошибку, placeholder уйдёт в Claude как литерал. Фикс: расширить до `/\{\{[^}\s]+\}\}/g`.
- [x] [Review][Patch] **P23. Smoke-script `new Date().toISOString()` без offset** [scripts/f1-smoke.ts:3357-3365] — fallback для отсутствующего `metadata.date` вернёт `2026-05-15T...Z` (Z без offset); `TranscriptSchema.metadata.date` требует `offset: true` → smoke упадёт на `parse`. Фикс: либо требовать наличия `metadata.date` в фикстуре (throw), либо вернуть offset вручную (`...+00:00`).
- [x] [Review][Patch] **P24. Smoke-script хардкодит `topName: 'Жанель'`** [scripts/f1-smoke.ts:3392] — независимо от транскрипта. Фикс: 2-й CLI-аргумент или derive из transcript metadata.
- [x] [Review][Patch] **P25. `formatTranscriptForPrompt` overflow `[MM:SS]` для встреч > 60 мин** [src/f1-report.ts:1389-1391] — `[90:00]` вместо `[01:30:00]`; визуально некорректно в цитатах и хрупко для downstream-парсера. Фикс: switch на `[HH:MM:SS]` если `start >= 3600`, либо всегда `[HH:MM:SS]`.
- [x] [Review][Patch] **P26. `persistMeta` на aborted-пути пишет `status='aborted'` entry** [src/f1-report.ts finally] — из D6: при `signal.aborted` в finally пишем минимальный meta.json (clientId, topName, reportId, status='aborted', partialDurations) для audit. Фикс: в finally проверить `deps.signal?.aborted`, если да — set finalStatus='aborted' и пройти persistMeta с partial payload.

### Defer (реальное, но не блокирует merge — на 1.9/Growth)

- [x] [Review][Defer] **DF1. Task 10.10 — regression test против `data/golden/transcript-N.json` + `f1-reference-N.json`** — требует выработки golden-manifest для F1; pure 1.4a тесты используют тип-фикстуры. Триггер: Story 1.11 (canary test) — там это и нужно.
- [x] [Review][Defer] **DF2. `deps.now` инъекция не пробрасывается во все `Date.now()` calls** [src/f1-report.ts] — Task 6.5 объявил deps.now, использован только в `loadOpenCommitments`. SLA-тест (P18) можно сделать через `vi.useFakeTimers`. Полный рефакторинг — отдельная задача.
- [x] [Review][Defer] **DF3. `persistStep` запиcывает raw.txt, потом JSON — silent loss `extraction.json` при ENOSPC между ними** [src/f1-report.ts:122-129] — warn-only design (spec AC #8). Audit hole, но соответствует контракту "persist не ломает pipeline". Триггер: Story 1.9 (ops + retry-on-persist-fail).
- [x] [Review][Defer] **DF4. `commitments-history` maxAgeDays cutoff в UTC vs локальный TZ — off-by-5h** [src/utils/commitments-history.ts:54] — на Asia/Almaty (+05) граничный день может отрезаться неверно. Effect: ≤1 встреча на квартал. Триггер: ощутимое расхождение в проде.
- [x] [Review][Defer] **DF5. Memory pressure при > 100k char транскриптах** [src/f1-report.ts:1668] — `JSON.stringify(extraction, null, 2)` + transcript text в памяти. Acceptable для MVP-длительностей (≤90 мин). Триггер: 4-часовые сессии или multi-client batch.
- [x] [Review][Defer] **DF6. Smoke-script CWD-relative paths и `??=` для metadata** [scripts/f1-smoke.ts] — manual-tool design; ломается только при запуске не из project-root. Acceptable.
- [x] [Review][Defer] **DF7. `topNameSlug` collision для разных топов с одинаковым именем** (resolved D4) — MVP-limit, документируется. Триггер усиления: 2-й клиент или дубликаты имён в одном клиенте.
- [x] [Review][Defer] **DF8. `reportId` 32-bit collision risk** (resolved D5) — статистически невозможно на 5 встречах/нед в MVP; same-day rerun overwrite — acceptable risk.

### Dismissed (28 находок)

False positives и шум: missing-body Blind Hunter (diff packaging artifact); 1.4b-scope findings (runF1Steps34, runF1, callClaudeSafe, DeliveryReadyReport, partial branches, format-tracker prompt); тонкости `.optional().default()` vs `.default()` Zod (behavioral equivalence); cosmetic `_resetClaudeClientForTest` naming; logger duck-typing cast; closure attemptCount off-by-one (works correctly); defaultSleep listener TDZ (works correctly); queueMicrotask test ordering (deterministic); vitest test-anthropic-key (looks-like-test); JSON.stringify([])="[]" (handled by prompt); topNameSlug whitespace collapse (verified OK); commitments_status_updates `?? []` redundancy (necessary for non-Zod test inputs); и др.
