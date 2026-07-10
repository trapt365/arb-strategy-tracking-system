---
title: '[D20/D21/D22] Приём аудио встречи существующего клиента → недельный отчёт'
type: 'feature'
created: '2026-07-10'
status: 'done'
baseline_revision: '5e88c24483cdafb91a9f12b52623fce9fb473b88'
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** Аудио- и видеофайлы встреч, отправленные боту в операционном режиме (активный клиент выбран), полностью игнорируются — нет обработчика `message:audio` / `message:video` в `src/bot.ts`. Из-за этого F1-конвейер никогда не запускается по Telegram-файлу, и недельный отчёт (9.7) показывает «Встреч за неделю не обработано».

**Approach:** Добавить обработчик `message:audio` (и `message:video`) в `src/bot.ts`: скачать файл через `downloadTelegramFile`, сохранить во временный файл, создать `ReportJob` с полем `filePath`, поставить в очередь с немедленным ack. Расширить `processJob` — новая ветка для `job.filePath`: транскрипция через новую функцию `transcribeFromFilePath` в `src/adapters/transcript.ts` (реиспользует Soniox-шаги из `transcribeFromUrl`, минуя скачивание с URL). F1 и недельный отчёт (9.7) подхватывают результат автоматически — без изменений.

## Boundaries & Constraints

**Always:**
- `getActiveClient(chatId)` — единственный источник клиента; fallback на `'geonline'` не использовать (у audio-intake нет аргумента clientId).
- Cleanup tmp-файла — в `finally`-блоке `processJob`, до конца функции.
- Progress messages через существующую queue (ack до enqueue, как в `/report`).
- `transcribeFromFilePath` добавить в `BotDeps` как injectable dep (по образцу `transcribeFromUrl`), чтобы `bot.test.ts` мог подменять её.
- Порядок handler-ов: `message:audio` и `message:video` — после `message:voice` (F0), чтобы voice handler (F0-онбординг) не перехватывал.
- Canary + golden + vitest + tsc зелёные; боевая таблица Geonline не затрагивается.

**Block If:**
- Telegram возвращает `file_path === undefined` для audio/video файла — не пытаться скачивать без пути: ответить пользователю, alertOps, return.
- Если в `ReportJobSchema` обнаруживается `.refine()` или `.superRefine()`, делающий `url` обязательным (beyond just the field type) — это меняет схему сложнее, чем описано; HALT и уточнить.

**Never:**
- Не менять `src/f1-report.ts`, `src/utils/weekly-report.ts`, `src/client-registry.ts`.
- Не удалять/перезаписывать метаданные встречи из других источников (не мёрджить чужой clientId).
- Не создавать отдельный сервис или новый формат персиста — F1 уже персистит в `data/{clientId}/{date}/`.
- Не обрабатывать `message:voice` как meeting (уже занят F0-онбордингом).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Happy path: audio file, active client | `message:audio` + активный клиент выбран | Immediate ack → очередь → F1 → `*.report.json` сохранён → недельный отчёт включает встречу | — |
| Happy path: video file, active client | `message:video` + активный клиент | Аналогично audio | — |
| Нет активного клиента | `message:audio` / `message:video`, `getActiveClient` → undefined | Ответ: «Выбери клиента через /start, прежде чем отправлять запись встречи.» | — |
| Non-tracker chat | audio в чате не из `trackerChatIds` | Игнорируется (ранний return) | — |
| `getFile()` без `file_path` | Telegram не вернул `file_path` | Error logged + alertOps + сообщение пользователю | — |
| Неделя без встреч | Нет обработанных audio/video на этой ISO-неделе | 9.7 показывает «встреч не обработано» (без изменений) | — |
| Неделя с обработанной встречей | `*.report.json` создан в `data/{clientId}/{date}/` | 9.7 включает встречу в агрегат | — |
| Несколько клиентов | audio в chatA (clientA), audio в chatB (clientB) | Каждый job читает `getActiveClient` своего chatId; результаты в разных `data/` директориях | — |

</intent-contract>

## Code Map

- `src/types.ts:242` — `ReportJobSchema`: `url` становится `optional`, добавить `filePath: z.string().optional()`
- `src/adapters/transcript.ts:37` — добавить `transcribeFromFilePath(filePath, meta, deps?)`: Soniox-шаги без download; экспортируется
- `src/bot.ts:157` — `BotDeps`: добавить `transcribeFromFilePath?: typeof defaultTranscribeFromFilePath`
- `src/bot.ts:721` — `processJob`: ветка `job.filePath` → `transcribeFromFilePath`; cleanup tmp в finally; `sanitizeUrlForLog` защитить от `undefined`
- `src/bot.ts:~3900` — добавить `bot.on('message:audio', ...)` и `bot.on('message:video', ...)` после `message:voice`
- `src/adapters/transcript.test.ts` — unit-тест для `transcribeFromFilePath` (happy path + Soniox-ошибка)

## Tasks & Acceptance

**Execution:**

- `src/types.ts` — в `ReportJobSchema` изменить `url: z.string().min(1)` → `url: z.string().optional()`, добавить `filePath: z.string().optional()` — даёт типовую поддержку нового job-source без breaking change для существующих jobs

- `src/adapters/transcript.ts` — добавить экспортируемую функцию `transcribeFromFilePath(filePath: string, meta: TranscriptMeta, deps?: Pick<TranscribeFromUrlDeps, 'sonioxClient' | 'logger'>): Promise<Transcript>`: создаёт Soniox-клиент, вызывает `uploadFile(filePath)` → `createTranscription` → `pollUntilCompleted` → `fetchTranscript` → `deleteFile` (в finally), затем `parseSonioxTokens(tokens, meta)` → валидирует через `TranscriptSchema.parse` → возвращает `Transcript`; alertOps + logging аналогично `transcribeFromUrl` (шаг `transcript`)

- `src/bot.ts` — в `BotDeps` добавить `transcribeFromFilePath?: typeof defaultTranscribeFromFilePath` (импорт из `transcript.ts`); в теле `createBot` разрешить dep: `const transcribeFromFilePath = deps.transcribeFromFilePath ?? defaultTranscribeFromFilePath`

- `src/bot.ts` — в `processJob` добавить ветку сразу перед `transcribeFromUrl`: `if (job.filePath) { transcript = await transcribeFromFilePath(job.filePath, meta, { sonioxClient, logger }); } else { transcript = await transcribeFromUrl(job.url!, meta, ...); }` — в `failureMessageForTranscriptError` и `sanitizeUrlForLog` защитить от `undefined url` (`job.url ?? '[telegram-file]'`); в `finally` добавить cleanup tmp-файла: `if (job.filePath) { await unlink(job.filePath).catch(() => {}); }`

- `src/bot.ts` — добавить `bot.on('message:audio', async (ctx) => { ... })` после `bot.on('message:voice', ...)`: (1) ранний return для не-tracker chat (`if (!trackerChatIds.has(chatId)) return`); (2) overflow pre-check аналогично `/report`; (3) `clientId = await getActiveClient(chatId)` → если undefined — reply «Выбери клиента через /start, прежде чем отправлять запись встречи.» и return; (4) `topName = (await getClientTopName(clientId)) ?? (await getClientName(clientId)) ?? 'Клиент'` — точный паттерн из `/report`-команды; (5) `assertClientId(clientId)` — та же проверка; (6) `file = await ctx.getFile()` → если `file.file_path === undefined` — alertOps + reply и return; (7) `buf = await downloadTelegramFile(file.file_path)` → `tmpPath = join(tmpdir(), \`meeting-\${randomUUID()}\`)` → `await writeFile(tmpPath, buf)`; (8) создать `ReportJob` с `filePath: tmpPath`, `url: undefined`, `meetingDate: now().toISOString()`, `clientId`, `topName`, `id: randomUUID().slice(0,8)`, `status: 'queued'`, `retryCount: 0`, `queuedAt: now().toISOString()`; (9) ack-сообщение → `job.progressMessageId = ackMessageId`; (10) `queue.enqueue(job)`

- `src/bot.ts` — добавить `bot.on('message:video', async (ctx) => { ... })` аналогично `message:audio` (идентичная логика, разный Telegram object: `ctx.message.video` вместо `ctx.message.audio`); или вынести общую функцию `handleMeetingFileIntake(ctx, chatId)` и вызвать из обоих обработчиков

- `src/adapters/transcript.test.ts` — добавить `describe('transcribeFromFilePath', ...)` с двумя тестами: happy path (mock Soniox-клиент возвращает валидные токены → `Transcript`) и ошибка Soniox (`uploadFile` throws → `TranscriptValidationError` или исходная ошибка прокидывается)

**Acceptance Criteria:**

- Given выбран активный клиент и в чате трекера получен аудиофайл (`.m4a`, `.ogg`), when файл поступает в `message:audio`, then бот немедленно отвечает ack-сообщением, ставит job в очередь, после обработки файл `*.report.json` появляется в `data/{clientId}/{YYYY-MM-DD}/`; клиенты не смешиваются (другой chatId → другой clientId)

- Given обработанная встреча персистирована через F1, when трекер запрашивает недельный отчёт (9.7) в той же ISO-неделе, then встреча учтена в агрегате; ISO-неделя без встреч по-прежнему возвращает «встреч не обработано» (логика 9.7 не меняется)

- Given мультиклиентность и регресс Geonline, when audio intake внедрён, then пер-встречный `/report` работает как раньше (job создаётся с `url`, не `filePath`); `npm test` + `tsc --noEmit` + `npm run canary` зелёные

## Spec Change Log

## Review Triage Log

### Pass 1 — 2026-07-10 (iteration 0, 4 reviewers: Blind Hunter · Edge Case Hunter · Verification Gap · Intent Alignment)

**patch (auto-fixed):**
- [medium] `downloadTelegramFile` + `writeFile` в `handleMeetingFileIntake` не обёрнуты try/catch → при сетевой ошибке или нехватке диска исключение проглатывается grammY, пользователь не получает обратную связь, tmp-файл не чистится. **Исправлено:** добавлены отдельные try/catch с `alertOps` + user reply + ранний return.

**defer (записаны в deferred-work.md):**
- [low] processJob filePath-ветка не покрыта сквозным тестом (только enqueue проверяется).
- [low] `unlink` tmp-файла не верифицирован spy-тестом.
- [low] Нет расширения в tmpPath — риск при смене транскрипшн-провайдера.
- [low] `meetingDate` = время получения, не дата встречи; проблема при позднем upload.
- [low] `ReportJobSchema` без `.refine()` на взаимоисключение url/filePath.

**reject (шум):**
- Double alertOps risk — ZodError оборачивается до внешнего catch, реального дублирования нет.
- processJob OOM crash до finally — вне scope MVP, общесистемный вопрос.
- Voice memos не принимаются как meeting — intentional per spec (F0-онбординг занят `message:voice`).

## Design Notes

**`transcribeFromFilePath` — минимальный дубликат, не рефактор `transcribeFromUrl`.**
`transcribeFromUrl` скачивает файл с URL через `downloadAudio` (Google Drive / Zoom), затем вызывает Soniox. Для Telegram-файлов файл уже на диске — скачивание выполнено в handler до enqueue. Выносить общий «Soniox-core» в третью функцию — нецелесообразно: в MVP только один новый caller. Простая копия шагов из `transcribeFromUrl` (от `uploadFile` до `parseSonioxTokens`) с той же обработкой ошибок — правильный выбор.

**Tmp-файл: handler пишет, processJob чистит.**
Telegram-файл скачивается в handler немедленно (до enqueue), потому что `file_path` Telegram Bot API протухает. Handler пишет в `os.tmpdir()` / uuid-имя. `processJob` чистит в `finally`. Если processJob упал до очистки — файл останется в tmp; это допустимо для MVP (OS периодически чистит tmp).

**`url` → optional: безопасно для существующих jobs.**
Существующие `/report` jobs всегда создаются с `url`. Zod `optional` не добавляет `undefined` в уже созданные объекты; runtime проверка `job.url ?? '[telegram-file]'` защищает `sanitizeUrlForLog`. Нет смысла добавлять `.refine()` — MVP, ошибка выдаст ясное сообщение в runtime.

## Verification

**Commands:**
- `npm test` -- expected: all vitest tests green, включая новые тесты `transcribeFromFilePath`
- `tsc --noEmit` -- expected: no type errors (особенно на `job.url` как `string | undefined`)
- `npm run canary` -- expected: canary green (Geonline F1-цикл не сломан)
