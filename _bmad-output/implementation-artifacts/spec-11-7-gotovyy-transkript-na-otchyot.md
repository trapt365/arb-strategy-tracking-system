---
title: '/report принимает готовый транскрипт (md/txt/docx)'
type: 'feature'
created: '2026-07-13'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '7e40db9543bbb251a66b9f4c54c658ae71470573'
final_revision: '0eb60dbb78f03fd4d0f862df0fff005327e16461'
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** Трекер с готовым текстовым транскриптом (md/txt/docx) не может отправить его в `/report`-конвейер — при наличии активной F0-сессии файл перехватывается онбординг-обработчиком (`message:document`), а при её отсутствии отклоняется с «Нет сессии онбординга».

**Approach:** В обработчике `message:document` добавить предварительный этап: для трекеров с активным клиентом скачать текстовый документ (md/txt/docx), определить эвристически «транскрипт встречи» vs «документ онбординга» и при положительном детекте поставить задание в F1-очередь через новую функцию `handleMeetingTextTranscript` (поле `transcriptText` в `ReportJob` вместо `filePath`). В `processJob` добавить ветку `transcriptText` с вызовом `transcribeFromPlainText` и отключением `assertTranscriptDuration`.

## Boundaries & Constraints

**Always:**
- Детект запускается только если: `trackerChatIds.has(chatId)` И файл — text-кандидат (md/txt/docx по расширению или MIME) И `getActiveClient(chatId) !== undefined`.
- Ошибка на этапе детекта (download fail, extract fail, schema fail) → тихий fallthrough к существующему F0-потоку; обработчик не падает.
- `assertTranscriptDuration` пропускается только для jobs с `transcriptText` (duration = 0 из `parsePlainText` — это норма, не ошибка).
- Регресс: аудио/видео/URL-задания, xlsx-импорт, F0-сессия — без изменений. `npm test` и `npm run typecheck` зелёные.
- `transcribeFromPlainText` и `isTranscriptDocument` инжектируются в `BotDeps` для тестируемости.

**Block If:** нет.

**Never:**
- Не менять логику `handleMeetingFileIntake` (аудио/видео intake).
- Не добавлять LLM-классификацию типа документа — только лёгкая текстовая эвристика.
- Не трогать `renderF0DraftSummaryMessage`, `runF0FullDraft`, F0-сессию.
- Не скачивать файл дважды для transcript-случая (download один раз, передать `extracted.text` в job).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Трекер, активный клиент, md с ≥5 временными метками | `message:document` с `transcript.md` | Job с `transcriptText` поставлен в очередь; пользователь получает ack-сообщение | — |
| Трекер, активный клиент, md без transcript-сигналов | `strategy.md` без меток/спикеров | Fallthrough к F0-потоку (сессия проверяется как обычно) | — |
| Трекер, НЕТ активного клиента | Любой md-файл | Fallthrough к F0-потоку (нет `clientId`) | — |
| Не-трекер | Любой md-файл | Fallthrough к F0-потоку без детекта | — |
| Файл > 20 МБ (трекер + активный клиент) | `big.md`, `file_size > F0_MAX_FILE_BYTES` | Fallthrough к F0-потоку (детект пропускается по size guard) | — |
| Ошибка скачивания при детекте | `getFile` или `downloadTelegramFile` throws | Тихий fallthrough к F0-потоку | catch, silent |
| `transcriptText`-job в processJob | Job с `transcriptText`, text < 200 символов | `transcript_too_short` через существующий `failureMessageForTranscriptError` | TranscriptValidationError('too_short') |
| `transcriptText`-job, текст > 200 символов | Нормальный транскрипт | F1 pipeline выполняется, отчёт доставляется | — |

</intent-contract>

## Code Map

- `src/utils/transcript-detect.ts` — НОВЫЙ: `isTranscriptDocument(text): boolean` + `isTranscriptCandidateType(fileName, mimeType): boolean`
- `src/utils/transcript-detect.test.ts` — НОВЫЙ: тесты для обеих функций
- `src/types.ts:278-302` — `ReportJobSchema`: добавить `transcriptText: z.string().optional()`
- `src/bot.ts:18-21` — импорт transcript adapter: добавить `transcribeFromPlainText as defaultTranscribeFromPlainText`
- `src/bot.ts:95-116` — импорт utils/f0-input.js: добавить импорт `isTranscriptCandidateType` (или из нового модуля)
- `src/bot.ts:164-199` — `BotDeps`: добавить `transcribeFromPlainText?` и `isTranscriptDocument?`
- `src/bot.ts:257-259` — dep assignments: добавить `transcribeFromPlainText` и `isTranscriptDocument`
- `src/bot.ts:776-790` — `processJob` transcription block: добавить ветку `job.transcriptText !== undefined`
- `src/bot.ts:822-843` — `assertTranscriptDuration` block: обернуть в `if (job.transcriptText === undefined)`
- `src/bot.ts:2486-2492` — `message:document` handler: добавить routing block до `getOrRestoreF0Session`
- `src/bot.ts:~4325` — после `handleMeetingFileIntake`: добавить `handleMeetingTextTranscript`
- `src/bot.test.ts:265-325` — `BuildOpts` + `buildBot`: добавить `transcribeFromPlainText?` и `isTranscriptDocument?`

## Tasks & Acceptance

**Execution:**

- `src/utils/transcript-detect.ts` — создать файл с двумя функциями:
  - `isTranscriptCandidateType(fileName?, mimeType?): boolean` — возвращает true для .md/.markdown/.txt/.docx (по расширению или MIME `text/plain`, `text/markdown`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`)
  - `isTranscriptDocument(text: string): boolean` — timestamp-heuristic: `(text.match(/\b\d{1,2}:\d{2}(:\d{2})?\b/g) ?? []).length >= 5` → true; иначе count строк совпадающих `/^\s*(?:Спикер|Speaker)\s+\d+\s*[:\-—]/im` ≥5 → true; иначе false

- `src/utils/transcript-detect.test.ts` — создать: (1) `isTranscriptDocument`: тест с ≥5 временными метками → true; тест с ≥5 «Speaker N:» строками → true; тест со стратегическим doc (OKR-секции без меток) → false; тест с 4 метками + 4 спикерами → false; (2) `isTranscriptCandidateType`: .md → true; .txt → true; .docx → true; .pdf → false; .xlsx → false

- `src/types.ts` — в `ReportJobSchema` добавить `transcriptText: z.string().optional()` после `filePath: z.string().optional()`

- `src/bot.ts` — импорты: добавить `transcribeFromPlainText as defaultTranscribeFromPlainText` к существующему `import { transcribeFromUrl, transcribeFromFilePath }` из `./adapters/transcript.js`; добавить `import { isTranscriptDocument as defaultIsTranscriptDocument, isTranscriptCandidateType } from './utils/transcript-detect.js'`

- `src/bot.ts` — `BotDeps`: добавить `transcribeFromPlainText?: typeof defaultTranscribeFromPlainText` (Story 11.7: text transcript processing) и `isTranscriptDocument?: (text: string) => boolean` (Story 11.7: testable detection)

- `src/bot.ts` — в `createBot` после `const transcribeFromFilePath = ...`: добавить `const transcribeFromPlainText = deps.transcribeFromPlainText ?? defaultTranscribeFromPlainText;` и `const isTranscriptDocument = deps.isTranscriptDocument ?? defaultIsTranscriptDocument;`

- `src/bot.ts` — `processJob` (~line 776): перед `if (job.filePath)` добавить ветку `if (job.transcriptText !== undefined)` → `transcript = await transcribeFromPlainText(job.transcriptText, { clientId: job.clientId, meetingDate: job.meetingDate, meetingType: job.meetingType }, { logger: baseLogger })`. Ошибка попадает в существующий `failureMessageForTranscriptError` catch-блок (без изменений).

- `src/bot.ts` — `processJob` (~line 822): заменить `assertTranscriptDuration(transcript)` и весь его try/catch-блок на: `if (job.transcriptText === undefined) { try { assertTranscriptDuration(transcript); } catch (err) { /* существующая обработка */ } }`

- `src/bot.ts` — `message:document` handler (~line 2486): вставить routing block ПЕРЕД `const session = await getOrRestoreF0Session(chatId)`. Использовать `ctx.message.document` напрямую (без объявления `const doc`, чтобы не конфликтовать с одноимённой переменной ниже на line 2530):
  ```typescript
  // Story 11.7: text transcript → F1 routing (before F0 session check).
  if (trackerChatIds.has(chatId) && isTranscriptCandidateType(ctx.message.document.file_name, ctx.message.document.mime_type)) {
    const transcriptClientId = await getActiveClient(chatId);
    if (transcriptClientId !== undefined && !(ctx.message.document.file_size !== undefined && ctx.message.document.file_size > F0_MAX_FILE_BYTES)) {
      try {
        const transcriptFile = await ctx.getFile();
        if (transcriptFile.file_path !== undefined) {
          const transcriptBuf = await downloadTelegramFile(transcriptFile.file_path);
          const transcriptExtracted = await extractTextFromDocument(transcriptBuf, ctx.message.document.file_name, ctx.message.document.mime_type);
          if (isTranscriptDocument(transcriptExtracted.text)) {
            await handleMeetingTextTranscript(ctx, chatId, transcriptClientId, transcriptExtracted.text, transcriptExtracted.sourceName);
            return;
          }
        }
      } catch { /* silent: fall through to F0 flow */ }
    }
  }
  ```
  Затем существующий код `const session = await getOrRestoreF0Session(chatId)` без изменений.

- `src/bot.ts` — добавить функцию `handleMeetingTextTranscript(ctx, chatId, clientId, text, sourceName)` после `handleMeetingFileIntake` (line ~4325): структурно аналогична `handleMeetingFileIntake` (queue overflow check → `getClientTopName`/`getClientName` → `assertClientId` → создать `ReportJob` с `transcriptText: text, url: undefined, filePath: undefined` → `ctx.reply(formatQueueAck(...))` → `queue.enqueue` → `scheduleTimeout` → `log.info`). Лог step: `'bot.document_transcript.queued'`.

- `src/bot.test.ts` — добавить в `BuildOpts`: `transcribeFromPlainText?: BotDeps['transcribeFromPlainText']` и `isTranscriptDocument?: BotDeps['isTranscriptDocument']`. В `buildBot` добавить: `transcribeFromPlainText: opts.transcribeFromPlainText ?? (async () => validTranscript)` и `isTranscriptDocument: opts.isTranscriptDocument ?? (() => false)` (default: не детектировать транскрипт — безопасный дефолт для существующих тестов).

- `src/bot.test.ts` — добавить в конце файла `describe('bot — Story 11.7: приём текстового транскрипта', ...)` с шаблоном beforeEach/afterEach идентичным Story 10.1: backup+restore `registry.json` + `active-clients.json`; beforeEach пишет `registry.json` с `TEST_CLIENT_ID` и удаляет `active-clients.json` (`fsp.rm(..., { force: true })`); каждый тест, требующий активного клиента, сам пишет `active-clients.json` (`{ [String(TEST_TRACKER_CHAT_ID)]: TEST_CLIENT_ID }`). Тесты:
  1. «(a) трекер + активный клиент + isTranscriptDocument=true → job c transcriptText в очереди» — спай-очередь, `isTranscriptDocument: () => true`, `extractTextFromDocument: async () => ({ sourceName: 'meeting.md', kind: 'text' as const, text: 'transcript' })`, `downloadTelegramFile: async () => Buffer.from('x')`. Отправить `documentUpdate('meeting.md')`. Проверить: `enqueued.length === 1`; `enqueued[0].transcriptText !== undefined`; `enqueued[0].filePath === undefined`.
  2. «(b) isTranscriptDocument=false → fallthrough к F0 (нет сессии → F0_NO_SESSION_TEXT)» — `isTranscriptDocument: () => false`, отправить `documentUpdate('strategy.md')`, проверить reply содержит «/newclient» (из `F0_NO_SESSION_TEXT`); ничего не добавлено в очередь.
  3. «(c) нет активного клиента → fallthrough к F0 (нет сессии)» — не писать active-clients.json; `isTranscriptDocument: () => true`; отправить `documentUpdate('meeting.md')`; verify ничего в очереди.
  4. «(d) processJob с transcriptText: transcribeFromPlainText вызван → отчёт доставлен» — мокнуть `transcribeFromPlainText` как `vi.fn().mockResolvedValue(validTranscript)`, создать job с полем `transcriptText: 'x'.repeat(200)`, вызвать `processJob(job)`, verify `transcribeFromPlainTextSpy` вызван; в replies есть финальный текст отчёта.

**Acceptance Criteria:**

- Given трекер с активным клиентом присылает md-файл содержащий ≥5 временных меток (`\d:\d{2}`), when обработчик `message:document` отрабатывает, then в очереди появляется job с `job.transcriptText !== undefined` и `job.filePath === undefined`.

- Given активный F0-онбординг (session.phase = 'collecting') у трекера с активным клиентом, when трекер присылает md-файл с transcript-сигналами, then файл идёт в F1-конвейер (не перехватывается F0); F0-сессия остаётся нетронутой.

- Given md-файл без timestamp/speaker-сигналов у трекера с активным клиентом, when обработчик отрабатывает, then файл попадает в F0-поток (не создаётся F1-job).

- Given job c `transcriptText`, when `processJob` выполняется, then `transcribeFromPlainText` вызван; `assertTranscriptDuration` НЕ вызван; отчёт доставляется как обычно.

- Given аудио-job (без `transcriptText`), when `processJob` выполняется, then поведение `assertTranscriptDuration` не изменилось.

- Given изменения применены, when `npm test` запущен, then все тесты зелёные. When `npm run typecheck` запущен, then нет TypeScript ошибок.

## Design Notes

**Эвристика детекта (консервативная):** false-negative (транскрипт не распознан) → безопасный fallthrough к F0. False-positive (стратдок роутится в F1) → нежелательно, но маловероятно: стратдоки не содержат ни 5 временных меток, ни 5 «Speaker N:»-строк. Только numbered speaker pattern (`Speaker N:` / `Спикер N:`) проверяется в secondary rule — не общий NAME_LINE_RE (для избежания ложных срабатываний на «Цель N: ...»).

**Двойного скачивания нет:** при успешном детекте (transcript) текст уже извлечён и передаётся в job как `transcriptText`. Повторного `getFile`/`downloadTelegramFile` не происходит. При fallthrough (не транскрипт) F0-обработчик скачивает файл повторно — это допустимо.

**`transcribeFromPlainText` уже существует** в `src/adapters/transcript.ts` и обрабатывает формат `parsePlainText` → `TranscriptSchema.parse`. Минимальная длина 200 символов; при fail — `TranscriptValidationError('too_short')`, перехватывается существующим `failureMessageForTranscriptError`.

## Verification

**Commands:**
- `npm test` — expected: все тесты зелёные, включая новый describe Story 11.7
- `npm run typecheck` — expected: нет ошибок TypeScript

## Auto Run Result

**Summary:** Реализован роутинг текстовых транскриптов в F1-конвейер. md/txt/docx файлы от трекеров с активным клиентом эвристически детектируются (`isTranscriptDocument`): ≥5 временных меток или ≥5 нумерованных строк «Спикер N:». При положительном детекте — новая функция `handleMeetingTextTranscript` ставит job с полем `transcriptText` в очередь, минуя F0-поток. В `processJob` добавлена ветка `transcriptText` и `assertTranscriptDuration` пропускается для plain-text jobs (duration=0 — норма для `parsePlainText`).

**Files changed:**
- `src/utils/transcript-detect.ts` — новый модуль: `isTranscriptDocument` (эвристика) + `isTranscriptCandidateType` (тип файла)
- `src/utils/transcript-detect.test.ts` — новый: 16 unit-тестов обеих функций
- `src/types.ts` — `ReportJobSchema`: добавлен `transcriptText: z.string().optional()`
- `src/bot.ts` — импорты; `BotDeps` + `createBot` wiring; ветка `transcriptText` в `processJob`; guard `assertTranscriptDuration` только для `job.transcriptText === undefined`; routing block в `message:document` до F0 session check; новая функция `handleMeetingTextTranscript`
- `src/bot.test.ts` — `BuildOpts` + `buildBot` defaults; describe Story 11.7 с 8 тестами (a)–(h); тест (d) патчан коротким duration:30 для пиннинга guard-skip

**Review findings breakdown:**
- Patches applied: 1 (test (d) — `assertTranscriptDuration` skip not pinned; fixed by using transcript with duration:30)
- Items deferred: 3 (all low)
- Items rejected: ~20

**Verification:**
- `npm run typecheck` → EXIT:0, нет ошибок TypeScript
- `npm test` → EXIT:0, 788/788 тестов

**Residual risks:**
- Double-download при fallthrough strategy-doc (md-файл трекера с активным клиентом, не транскрипт) — принято по дизайну

## Spec Change Log

## Review Triage Log

### 2026-07-13 — Review pass 1

- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 0, low 1)
- defer: 3: (high 0, medium 0, low 3)
- reject: 20
- addressed_findings:
  - `[low]` `[patch]` test (d): `assertTranscriptDuration` skip not observable — `transcribeFromPlainText` mock now returns transcript with `duration:30` (<120s threshold); without the `if (job.transcriptText === undefined)` guard, the test would fail as job rejected 'too_short' instead of delivering the report
