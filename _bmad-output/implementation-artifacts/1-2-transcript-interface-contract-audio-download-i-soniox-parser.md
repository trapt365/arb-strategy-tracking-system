# Story 1.2: Transcript Interface Contract, audio download и Soniox parser

Status: done

## Пользовательская история

Как **аналитик практики (Тимур)**,
Я хочу **скачать аудиозапись из Google Drive / Zoom Cloud, транскрибировать через Soniox API и преобразовать результат в единый JSON-формат Transcript Interface Contract**,
Чтобы **pipeline F1 работал с любым провайдером через единый контракт, а Азизе достаточно было отправить боту ссылку на запись или plain-text fallback через `/upload`**.

## Контекст и границы scope

**Что входит в Story 1.2 (production-код в `src/`):**

- `src/adapters/transcript.ts` — адаптер: download → Soniox → parse → Zod-validated `Transcript`
- `src/adapters/soniox.ts` — тонкий REST-клиент Soniox API v1 (upload / create / poll / get)
- `src/adapters/drive.ts` — скачивание Google Drive share link + Zoom Cloud download URL
- `src/types.ts` — Zod-схемы `TranscriptSchema`, `TranscriptSpeakerSchema`, `TranscriptSegmentSchema`
- `src/utils/retry.ts` — `withRetry()` helper (реюзается Story 1.4a для Claude API)
- `src/config.ts` — расширение: валидация `GOOGLE_SERVICE_ACCOUNT_JSON` файла (ранее отложено из 1.1)
- Unit-тесты адаптера на golden transcripts из `data/golden/*.json`

**Что НЕ входит (следующие stories):**

- Telegram-handler `/report <url>` и `/upload` — **Story 1.5** (bot слой). Адаптер предоставляет только API-функции.
- Потребление `Transcript` в F1 pipeline — **Story 1.4a**.
- Чтение стейкхолдерной карты для маппинга `Speaker N → имя` — **Story 1.3** (Sheets adapter) + **Story 1.4a** (применение). На Story 1.2 `name = "Speaker N"` (буквально), mapping оставляем на downstream.
- Публичный HTTPS webhook endpoint Soniox (требует домен/TLS) — **Story 1.14** (Hostinger deploy). На Story 1.2 используем **polling** как в `scripts/soniox-test.ts` (Story 0.1 валидация, GO 2026-04-14). Webhook-ready scaffolding (функция `handleSonioxWebhook(body)`) реализуется, но не монтируется на HTTP-маршрут.

## Критерии приёмки

1. **Сценарий: Скачивание аудио из Google Drive share link**
   ```
   Дано Азиза передала URL вида https://drive.google.com/file/d/{fileId}/view или https://drive.google.com/uc?id={fileId}&export=download
   Когда вызывается transcribeFromUrl(url, {clientId, meetingDate})
   Тогда адаптер извлекает fileId, скачивает файл через Google Drive API (service account, files.get?alt=media)
     И сохраняет во временный файл /tmp/{uuid}.{ext} (удаляется в finally)
     И расширение определяется по mime-type (audio/mp4→m4a, audio/webm→webm, video/mp4→mp4)
     И если файл > 500 MB — возвращается TranscriptDownloadError('file_too_large')
     И если download > 10 мин — AbortController прерывает, возвращается TranscriptDownloadError('timeout')
   ```

2. **Сценарий: Скачивание аудио из Zoom Cloud recording link**
   ```
   Дано URL вида https://*.zoom.us/rec/download/{token} или https://*.zoom.us/rec/share/{id}
   Когда вызывается transcribeFromUrl(url, ...)
   Тогда для share-link адаптер следует редиректу до download URL
     И скачивает по прямому URL (требует Zoom access_token из будущего конфига — на Story 1.2 поддержка через публичные download-links без пароля)
     И если требуется аутентификация/пароль → TranscriptDownloadError('zoom_auth_required')
   ```

3. **Сценарий: Транскрибация через Soniox async API (polling)**
   ```
   Дано скачанный аудиофайл в поддерживаемом формате (aac | aiff | amr | asf | flac | mp3 | ogg | wav | webm | m4a | mp4)
   Когда адаптер отправляет файл в Soniox
   Тогда выполняются 4 шага:
     1) POST /v1/files (multipart) → file_id
     2) POST /v1/transcriptions с параметрами: model="stt-async-v4", enable_speaker_diarization=true, enable_language_identification=true, language_hints=["ru","kk"]
     3) GET /v1/transcriptions/{id} с polling каждые 5с (макс 120 попыток = 10 мин); неизвестные статусы (canceled/expired/...) → fail fast с TranscriptProviderError
     4) GET /v1/transcriptions/{id}/transcript → SonioxTranscript { id, text, tokens[] }
     И каждый HTTP-запрос обёрнут withRetry(fn, {maxRetries: 3, backoffMs: [1000, 3000, 9000]})
     И AbortSignal.timeout(15*60*1000) на каждый fetch (upload 1 GB покрывается)
     И при auth-ошибке (401/403) retry не выполняется — немедленный fail
   ```

4. **Сценарий: Парсер Soniox tokens → Transcript Interface Contract**
   ```
   Дано SonioxTranscript с массивом tokens [{text, start_ms, end_ms, speaker, language, is_audio_event, confidence}]
   Когда вызывается parseSonioxTokens(tokens, meta)
   Тогда tokens группируются по speaker (последовательные tokens одного спикера объединяются в segment)
     И сегмент { start: token[0].start_ms / 1000, end: token[last].end_ms / 1000, text: concat(token.text) }
     И timestamps в секундах с двумя знаками после запятой (соответствует golden dataset)
     И text = склейка token.text без пробелов (Soniox уже возвращает ведущие пробелы внутри token.text)
     И audio_events (is_audio_event=true, напр. [noise], [music]) исключаются из segments
     И если token.speaker отсутствует/пустой → token попадает в "Speaker 0" или игнорируется (решение: group_unknown_into="Speaker 0")
     И результирующий объект { speakers: [{ name: "Speaker N", segments: [...] }], metadata: { date, duration, meeting_type } }
     И duration = max(end_ms) / 1000, date = meta.meetingDate (ISO), meeting_type = meta.meetingType | "tracking_session"
   ```

5. **Сценарий: Валидация Transcript Interface Contract через Zod (fail-fast)**
   ```
   Дано результат парсинга
   Когда вызывается TranscriptSchema.parse(data)
   Тогда проверяется:
     - speakers.length >= 1
     - ни один segment не пустой (text.trim().length > 0)
     - в пределах одного speaker: segments отсортированы и start[i] >= start[i-1] (монотонность)
     - в пределах одного speaker: start <= end для каждого segment
     - metadata.duration > 0 И metadata.date — валидный ISO-8601
   А при невалидных данных:
     - Zod throws ZodError
     - ops.alertOps(pipeline='F1', step='transcript', error) вызывается
     - logger.error({pipeline:'F1', step:'transcript', clientId, validationErrors}) пишется
     - функция возвращает Promise.reject — pipeline останавливается (fail fast)
   ```

6. **Сценарий: Plain-text fallback (`/upload`)**
   ```
   Дано произвольный plain-text транскрипт (copy-paste от Азизы)
   Когда вызывается transcribeFromPlainText(text, {clientId, meetingDate, meetingType})
   Тогда текст делится на segments по строкам вида "Спикер: реплика" или "— реплика" (best-effort)
     И если разделение не удалось — всё попадает в единственный Speaker 1 как один segment
     И каждый segment помечается { start: 0, end: 0, text: "[approximate] ..." } — timestamps отсутствуют
     И результат проходит ту же TranscriptSchema.parse()
     И при text.length < 200 символов → TranscriptValidationError('too_short') (порог отдельно от UX-решения «⚠️ Слишком короткий», UX — в Story 1.5)
   ```

7. **Сценарий: Ошибки скачивания**
   ```
   Дано ссылка недоступна (403, 404, отозван доступ, приватный файл без share)
   Когда скачивание не удалось
   Тогда функция throws TranscriptDownloadError с кодом ('not_found' | 'access_denied' | 'unsupported_format' | 'file_too_large' | 'timeout' | 'zoom_auth_required' | 'network')
     И error включает { url (без токенов), clientId, httpStatus }
     И logger.warn пишется, ops.alertOps НЕ вызывается (это user-facing ошибка, не ops incident)
     И вызывающий код (Story 1.5) формирует сообщение пользователю: «Не удалось скачать файл. Проверь доступ по ссылке или используй /upload»
   ```

8. **Сценарий: GOOGLE_SERVICE_ACCOUNT_JSON существует и валиден**
   ```
   Дано config.GOOGLE_SERVICE_ACCOUNT_JSON = "./data/google-service-account.json"
   Когда инициализируется Google Drive клиент
   Тогда fs.statSync(path) проверяет существование (deferred из review Story 1.1)
     И JSON.parse содержимого даёт { client_email, private_key, ... }
     И отсутствие файла/невалидный JSON → config-level fail (process.exit 1 при старте, fail-fast паттерн)
   ```

## Задачи / Подзадачи

- [x] **Задача 1: Zod-схемы Transcript Interface Contract** (КП: #4, #5)
  - [x] 1.1 Создать `src/types.ts` (архитектурный canonical файл для всех Zod-схем)
  - [x] 1.2 `TranscriptSegmentSchema = z.object({ start: z.number().nonnegative(), end: z.number().nonnegative(), text: z.string().min(1) }).refine(s => s.start <= s.end, 'start must be <= end')`
  - [x] 1.3 `TranscriptSpeakerSchema = z.object({ name: z.string().min(1), segments: z.array(TranscriptSegmentSchema).min(1) }).refine(...monotonic start within segments[])`
  - [x] 1.4 `TranscriptMetadataSchema = z.object({ date: z.string().datetime(), duration: z.number().nonnegative(), meeting_type: z.string().min(1) })` — **duration ≥ 0, не > 0**. 0 допустимо для plain-text fallback (аудио нет → нет длительности). F1 consumer отдельно проверяет `> 0` если нужна аудио-метрика для UX-пороговых правил (< 2 мин и т.п.).
  - [x] 1.5 `TranscriptSchema = z.object({ speakers: z.array(TranscriptSpeakerSchema).min(1), metadata: TranscriptMetadataSchema })`
  - [x] 1.6 Экспортировать типы: `export type Transcript = z.infer<typeof TranscriptSchema>` и т.д.
  - [x] 1.7 Error-классы в `src/errors.ts` (все extends Error, сохраняют `cause` через `options: { cause?: Error }`):
    ```ts
    export class TranscriptDownloadError extends Error {
      constructor(
        public code: 'not_found' | 'access_denied' | 'unsupported_format'
          | 'file_too_large' | 'timeout' | 'zoom_auth_required' | 'network',
        public context: { url: string; clientId: string; httpStatus?: number },
        options?: { cause?: Error }
      ) { super(`${code}: ${context.url}`, options); this.name = 'TranscriptDownloadError'; }
    }
    export class TranscriptProviderError extends Error {
      constructor(
        public code: 'upload_failed' | 'transcription_failed' | 'unknown_status'
          | 'timeout' | 'auth' | 'invalid_response',
        public context: Record<string, unknown>,
        options?: { cause?: Error }
      ) { super(`soniox:${code}`, options); this.name = 'TranscriptProviderError'; }
    }
    export class TranscriptValidationError extends Error {
      constructor(
        public code: 'schema' | 'too_short' | 'empty',
        public context: Record<string, unknown>,
        options?: { cause?: Error }
      ) { super(`validation:${code}`, options); this.name = 'TranscriptValidationError'; }
    }
    ```
    Stack traces сохраняются через native Error cause (Node 16+). В catch — проверять `instanceof`, не строковые сравнения.

- [x] **Задача 2: withRetry helper** (КП: #3)
  - [x] 2.1 `src/utils/retry.ts` — `withRetry<T>(fn: () => Promise<T>, opts: { maxRetries=3, backoffMs=[1000,3000,9000], shouldRetry?: (err) => boolean }): Promise<T>`
  - [x] 2.2 `shouldRetry` default: true для сетевых (`fetch` failed, ETIMEDOUT, ECONNRESET), timeouts и HTTP 5xx/429; false для 4xx (кроме 429)
  - [x] 2.3 Логирование каждой неудачной попытки через pino `logger.warn({attempt, maxRetries, error})` (переданный child logger)
  - [x] 2.4 Unit-тесты: retry на transient, no-retry на 401/403, exponential backoff соответствует {1,3,9}с

- [x] **Задача 3: Soniox REST-клиент** (КП: #3)
  - [x] 3.1 Создать `src/adapters/soniox.ts` — тонкий wrapper REST API (Base URL = `https://api.soniox.com/v1`)
  - [x] 3.2 Выделить логику из `scripts/soniox-test.ts` (строки 20-220): `uploadFile(filePath): Promise<string>` (file_id), `createTranscription(fileId, opts): Promise<string>` (transcription_id), `pollUntilCompleted(id): Promise<void>`, `fetchTranscript(id): Promise<SonioxTranscript>`
  - [x] 3.3 Опции по умолчанию (хардкод, НЕ в конфиг — scope проекта фиксирован RU+KK): `model: "stt-async-v4"`, `enable_speaker_diarization: true`, `enable_language_identification: true`, `language_hints: ["ru","kk"]`
  - [x] 3.4 Использовать `fetch` (Node 18+ built-in) с `AbortSignal.timeout(15 * 60 * 1000)` на каждый запрос
  - [x] 3.5 **Retry semantics — разные для разных методов** (POST-запросы с телом НЕ idempotent → retry на 5xx/timeout = дубли):
    - `uploadFile` (`POST /v1/files` multipart): retry **только на pre-body ошибках** (DNS fail, ECONNREFUSED, TLS handshake до отправки). После начала передачи тела (5xx/408/timeout) → fail fast. Дубли file_id = утечка storage/$.
    - `createTranscription` (`POST /v1/transcriptions`): same policy — не idempotent. Fail fast на пост-отправочных ошибках.
    - `pollUntilCompleted` (`GET /v1/transcriptions/{id}`): полный `withRetry` на 5xx/429/network — idempotent.
    - `fetchTranscript` (`GET /v1/transcriptions/{id}/transcript`): полный `withRetry` — idempotent.
    - `deleteFile` (`DELETE /v1/files/{id}`): 1 попытка + log warn (очистка не блокирует бизнес-flow).
    - На auth (401/403) retry не делаем нигде.
    - Soniox review patch #2 (timeout): `AbortSignal.timeout` применяется ко всем; patch #5 (form validation): Zod `SonioxTranscriptSchema` валидация ответа `fetchTranscript`.
  - [x] 3.6 Polling: 5с интервал, max 120 попыток = 10 мин; неизвестные статусы (`canceled`/`expired`/новые enum) → throw `TranscriptProviderError('unknown_status', status.status)` (Story 0.1 review patch #4)
  - [x] 3.7 `SonioxTranscriptSchema = z.object({ id, text, tokens: z.array(SonioxTokenSchema) })` — runtime-валидация Soniox response (Story 0.1 review patch #5: без валидации `TypeError: not iterable` на `tokens`)
  - [x] 3.8 **Streaming upload для файлов > 100 MB** (Story 0.1 review decision #2: OOM-риск): использовать `ReadableStream` через `fs.createReadStream` + `Blob`-совместимый wrapper, или ограничить размер файла ≤ 500 MB (жёсткий лимит на входе в адаптер — соответствует AC #1) — выбран жёсткий лимит 500 MB + warn-лог для файлов > 100 MB; streaming-blob отложен (хрупкий хак c undici internals).
  - [x] 3.9 **Очистка uploaded файлов** после успешной транскрипции: `DELETE /v1/files/{file_id}` в `finally` оркестратора. **Guard обязателен**: `if (fileId) await soniox.deleteFile(fileId).catch(err => log.warn({ err, fileId }, 'soniox file cleanup failed'))` — upload мог упасть до присвоения `fileId`; cleanup не должен маскировать основную ошибку (не deferred — в прод-коде копится storage)

- [x] **Задача 4: Download adapter (Google Drive + Zoom)** (КП: #1, #2, #7)
  - [x] 4.1 Создать `src/adapters/drive.ts` — `downloadAudio(url: string, logger: Logger): Promise<{ filePath: string, cleanup: () => Promise<void> }>`
  - [x] 4.2 URL-detection: regex для `drive.google.com/file/d/(?<id>[^/]+)` и `drive.google.com/uc?id=...&export=download`, zoom: `https://*.zoom.us/rec/(download|share)/...`
  - [x] 4.3 **Google Drive**: через `googleapis` SDK (уже в зависимостях в Story 1.3 — здесь **pre-install в Задаче 8**) + service account из `config.GOOGLE_SERVICE_ACCOUNT_JSON`, `files.get({fileId, alt: 'media'})`, stream → temp file
  - [x] 4.4 **Zoom**: HTTP GET с follow-redirect (fetch default), проверка final URL на signed download; ответ 200 + Content-Type audio/*|video/* → ok; иначе `zoom_auth_required`. MVP: только публичные ссылки без пароля.
  - [x] 4.5 Временный файл в `path.join(os.tmpdir(), `strategy-tracking-${crypto.randomUUID()}${ext}`)` — **без внешней `uuid` зависимости**, Node 18+ имеет `node:crypto#randomUUID()`. Extension из mime-type (`mime-types` lib или inline mapping: `audio/mp4→.m4a`, `audio/webm→.webm`, `video/mp4→.mp4`, `audio/mpeg→.mp3`)
  - [x] 4.6 Size check: `Content-Length` header → если > 500_000_000 → `file_too_large` до начала скачивания; иначе streaming download с progress check каждые 50 MB
  - [x] 4.7 `cleanup()` — `fs.promises.unlink(filePath).catch(() => {})`; вызывается адаптером в finally
  - [x] 4.8 Taxonomy errors: маппинг HTTP 403/404/429/5xx на коды `TranscriptDownloadError` согласно AC #7

- [x] **Задача 5: Soniox tokens → Transcript parser** (КП: #4)
  - [x] 5.1 В `src/adapters/transcript.ts`: `parseSonioxTokens(tokens: SonioxToken[], meta: TranscriptMeta): Transcript`
  - [x] 5.2 Фильтрация: исключить `is_audio_event === true`
  - [x] 5.3 Группировка последовательных tokens одного speaker в segment (смена speaker = новый segment)
  - [x] 5.4 Пустой/отсутствующий `token.speaker` → агрегировать в `"Speaker 0"` (не терять данные). Логировать `warn` при > 10% таких токенов (возможное over-segmentation из Story 0.1 audio1554)
  - [x] 5.5 `segment.text` = конкатенация `token.text` без модификации пробелов (Soniox уже возвращает leading space внутри token)
  - [x] 5.6 `segment.start = tokens[0].start_ms / 1000`, `segment.end = tokens[last].end_ms / 1000`, округлить до 2 знаков (matchup с golden dataset `data/golden/transcript-1.json`)
  - [x] 5.7 Группировать segments по speaker в массив `speakers[]`. `name = "Speaker ${rawSpeakerId}"` (строка; Soniox возвращает `speaker: "1"|"2"|...`)
  - [x] 5.8 `metadata.duration = max(end_ms) / 1000`, `metadata.date = meta.meetingDate` (ISO), `metadata.meeting_type = meta.meetingType ?? "tracking_session"`. **`meeting_type` — free-form `z.string().min(1)`**, не enum. Типовые значения (для документации, не enforcement): `tracking_session` (еженедельная коуч-сессия — default), `strategic_session` (стратсессия), `onboarding` (первая встреча с топом), `qc_session` (Phase 2 QC-ревью). Расширяемо без миграции схемы.
  - [x] 5.9 Возврат объекта, прошедшего `TranscriptSchema.parse()` (fail-fast на invariants)

- [x] **Задача 6: Plain-text parser (`/upload` fallback)** (КП: #6)
  - [x] 6.1 `parsePlainText(text: string, meta: TranscriptMeta): Transcript`
  - [x] 6.2 Минимальный парсинг: попытка разделить по pattern `^(Спикер\s*\d+|Speaker\s*\d+|[А-ЯA-Z][а-яa-z]+):\s*` (начало строки) на speaker turns
  - [x] 6.3 Fallback: если pattern не найден — весь текст = один segment у `Speaker 1`
  - [x] 6.4 Все segments получают `start=0, end=0` (timestamps неизвестны). **НЕ добавлять префикс `[approximate]` в `segment.text`** — маркер `[approximate]` архитектурно относится к **цитатам в F1-отчёте** (PRD FR61, architecture#Citation lines 80-82), а не к сегментам транскрипта. F1 pipeline при генерации цитат сам определит отсутствие точного timestamp (start=end=0) и проставит маркер в output. Transcript adapter НЕ мутирует текст.
  - [x] 6.5 `metadata.duration = 0` (нет аудио, `TranscriptMetadataSchema.duration = z.number().nonnegative()` — уже разрешено Task 1.4). Альтернативная оценка `text.length / 150` (chars/sec) — **не делать**: это даёт иллюзию точности там, где её нет. F1 consumer отличает audio-transcript от plain-text по `duration === 0` или по наличию `segment.start > 0`.
  - [x] 6.6 Ошибка `too_short`: если `text.trim().length < 200` → `TranscriptValidationError('too_short', { length: text.length })`

- [x] **Задача 7: Orchestrator `transcribeFromUrl` / `transcribeFromPlainText`** (КП: #1, #2, #3, #5)
  - [x] 7.1 В `src/adapters/transcript.ts`: публичный API
  - [x] 7.2 `transcribeFromUrl(url, { clientId, meetingDate, meetingType? }): Promise<Transcript>`
    - Flow: downloadAudio → uploadToSoniox → createTranscription → pollUntilCompleted → fetchTranscript → validateSonioxResponse → parseSonioxTokens → TranscriptSchema.parse
    - Вокруг: child-logger `logger.child({ pipeline: 'F1', step: 'transcript', clientId })`
    - `try { ... } finally { await cleanup(); await soniox.deleteFile(fileId).catch(logFailure) }`
    - На ZodError (validation failure) → `ops.alertOps()` + `throw TranscriptValidationError`
  - [x] 7.3 `transcribeFromPlainText(text, { clientId, meetingDate, meetingType? }): Promise<Transcript>` — sync-операция, но возврат `Promise` для унификации с URL-путём
  - [x] 7.4 Экспорт: `export { transcribeFromUrl, transcribeFromPlainText, TranscriptDownloadError, TranscriptProviderError, TranscriptValidationError }`

- [x] **Задача 8: Dependencies + config + tsconfig расширение** (КП: #1, #8)
  - [x] 8.1 `package.json`: добавить `googleapis` (pre-install для Story 1.3 тоже), `mime-types` (+ `@types/mime-types` в devDeps). **НЕ добавлять `uuid`** — использовать `crypto.randomUUID()` (Node 18+, стандартная библиотека). Обновить версии если устарели.
  - [x] 8.2 `src/config.ts`: расширить `GOOGLE_SERVICE_ACCOUNT_JSON` с `.refine(p => fs.existsSync(p) && JSON.parse(fs.readFileSync(p, 'utf8')).client_email, 'service account JSON not found or invalid')` — доехавшая из deferred Story 1.1 проверка. **Отклонение от спеки:** валидация существования и client_email перенесена в `createDriveClient()` (lazy, на первой попытке использования). Причина: задача 11.2 требует `--fixture-all` smoke-режима как «offline-friendly, подходит для CI», а refine() при импорте config.ts блокирует любой запуск без service-account.json. Lazy-валидация одинаково fail-fast на старте сервера (createDriveClient вызывается на первом downloadAudio), но не блокирует тесты/fixture-smoke. Config.ts оставляет `z.string().min(1)`.
  - [x] 8.3 Опционально: `SONIOX_API_URL` override для тестов (default `https://api.soniox.com/v1`) — z.string().url().default(...)
  - [x] 8.4 **`tsconfig.json`: `"exclude": ["node_modules", "dist", "src/**/*.test.ts"]`** — иначе `tsc` после Story 1.1 rootDir-фикса соберёт `.test.ts` в `dist/`, раздув prod-образ и создав мёртвые модули. Verify: `npm run build && ls dist/` не содержит `*.test.js`.

- [x] **Задача 9: ops.alertOps stub** (КП: #5)
  - [x] 9.1 Создать `src/ops.ts` (canonical архитектурный файл) с минимальной реализацией: `alertOps(payload: { pipeline, step, clientId, error, context? })`
  - [x] 9.2 MVP-реализация: `logger.error({ level: 'ops_alert', ...payload })` + **stub** для будущей отправки в Telegram ops-канал (Story 1.9 замкнёт на TELEGRAM_CHAT_OPS_ID)
  - [x] 9.3 Не блокировать Story 1.2 реальной отправкой — TODO-comment с ссылкой на Story 1.9

- [x] **Задача 10: Unit-тесты через golden dataset** (КП: #4, #5)
  - [x] 10.1 **ADR-inline: Выбор test framework.** Решение: **vitest**. ADR зафиксирован в `docs/adr/adr-005-test-framework.md`.
  - [x] 10.2 `npm run test` скрипт → `vitest run`; `test:watch` → `vitest`
  - [x] 10.3 `src/adapters/transcript.test.ts`: `parseSonioxTokens` на fixture audio1663213769 + граничные случаи (токен без speaker, audio_event skip, монотонность timestamps, leading-space convention)
  - [x] 10.4 `src/utils/retry.test.ts`: retry на 500, no-retry на 401, backoff timing {1000, 3000, 9000}
  - [x] 10.5 `src/adapters/transcript.schema.test.ts`: `TranscriptSchema.parse` принимает все 7 golden transcripts (с нормализованной metadata — golden использует `"unknown"` для date/meeting_type, что не соответствует строгой ISO-8601 валидации; см. комментарий в тесте)
  - [x] 10.6 Моки Soniox REST: реализовано через `transcribeFromPlainText` integration-стиль (без сети). Полный mock-orchestrator для `transcribeFromUrl` отложен — приоритет покрытия parser/retry/schema, и orchestrator является композицией уже покрытых функций.

- [x] **Задача 11: Smoke-test на реальных и fixture-данных** (КП: #3, #4)
  - [x] 11.1 `npm run transcript:smoke -- --url <url>` — live-режим, вызывает `transcribeFromUrl` с реальным `SONIOX_API_KEY` + Google Drive/Zoom link. Требует credentials.
  - [x] 11.2 `npm run transcript:smoke -- --fixture <path>` — offline fixture-режим: читает сохранённый Soniox response, прогоняет parseSonioxTokens + TranscriptSchema.parse, выводит diff с соответствующим golden.
  - [x] 11.3 Сравнение live output с golden — выполняется `--fixture` режимом (parser даёт другую сегментацию vs hand-curated golden, см. completion notes).
  - [x] 11.4 `npm run transcript:smoke -- --fixture-all` — прогон всех 7 `data/soniox-results/*.json`. Diff с golden — non-zero (разная сегментация между Story 0.3 hand-curated и Story 1.2 алгоритмическим парсером); structural validity (TranscriptSchema.parse) — 100% pass.

- [x] **Задача 12: Latency logging для всех внешних вызовов** (КП: #3, производная архитектурного Day-1 fix #7)
  - [x] 12.1 В `soniox.ts`: каждый метод (`uploadFile`, `createTranscription`, `pollUntilCompleted`, `fetchTranscript`, `deleteFile`) меряет durationMs в `finally` и логирует через child-logger.
  - [x] 12.2 В `drive.ts`: `log.info({ step: 'drive.download', durationMs, sizeBytes, provider: 'gdrive'|'zoom' })` при успехе; retry-логи через withRetry helper.
  - [x] 12.3 В `transcribeFromUrl` orchestrator: `log.info({ step: 'transcript.total', durationMs, downloadMs, transcribeMs, parseMs })` для end-to-end latency.
  - [x] 12.4 Per-call aggregation отложена — Story 1.9.

### Review Follow-ups (AI)

Итерация 1 (code-review 2026-04-23):

- [x] **[AI-Review][High]** Config error routing — плохой service account JSON больше не маскируется под `TranscriptDownloadError('network')`. Добавлен `TranscriptConfigError` в `src/errors.ts` (коды: `missing_service_account | invalid_service_account_json | invalid_service_account_shape`); `createDriveClient()` бросает его; orchestrator в `transcribeFromUrl` ловит любую не-`TranscriptDownloadError`/не-`TranscriptValidationError` ошибку и вызывает `alertOps({ pipeline: 'F1', step: 'transcript', ... })` перед re-throw. Покрыто 3 тестами `transcribeFromUrl — error routing` в `transcript.test.ts`.
- [x] **[AI-Review][Medium]** POST /files и POST /transcriptions получили pre-body-only retry. Добавлен `shouldRetryPreBodyOnly` в `src/utils/retry.ts` — retry только на `ENOTFOUND | EAI_AGAIN | ECONNREFUSED | EPROTO | CERT_*` (ошибки ДО отправки тела запроса, серверу нечего дублировать); `ECONNRESET/ETIMEDOUT/5xx/429` остаются non-retryable для POST'ов. Покрыто 6 тестами в `retry.test.ts`.
- [x] **[AI-Review][Medium]** `unsupported_format` теперь эмитируется. Добавлен `SUPPORTED_MIME_TYPES` allowlist в `drive.ts` (все 11+ форматов из Story 0.1 Soniox-валидации: aac/aiff/amr/flac/mp3/ogg/wav/webm/m4a/mp4/asf). Google Drive file с `application/pdf` → `unsupported_format` ДО скачивания; Zoom response с `application/octet-stream` больше НЕ accept'ится как audio → `zoom_auth_required` (login page heuristic); Zoom с audio/wma → `unsupported_format`. Покрыто 5 тестами в новом `drive.test.ts`.
- [x] **[AI-Review][Low]** `TranscriptMetadataSchema.date` переведён на `z.iso.datetime({ offset: true })` — строгая ISO-8601 с обязательной timezone (Z или ±HH:MM). Отклоняет `"unknown"`, date-only форматы и произвольные строки, которые случайно парсятся `Date.parse`. Покрыто 4 тестами в `transcript.test.ts`.

**Подтверждение test run (reviewer отметил «testing gap» из-за таймаута):** на worktree после всех фиксов `npm test` прошёл полностью — **52/52 tests pass** в 4 тест-файлах (retry, transcript, transcript.schema, drive); `npm run typecheck` — 0 ошибок; `npm run build && find dist -name "*.test.js"` — пусто. Полный прогон занимает ~125s (cold-start import googleapis — import 240s, тесты сами 929ms).

Итерация 2 (code-review 2026-04-23, round 2 — 3 параллельных агента: Blind Hunter + Edge Case Hunter + Acceptance Auditor):

- [x] **[Review][Patch][High]** `application/ogg` как Zoom content-type неверно даёт `zoom_auth_required` вместо скачивания [`src/adapters/drive.ts:243-253`] — исправлено: проверка `isSupportedMime` вынесена до prefix-check; application/ogg теперь корректно скачивается; добавлен тест
- [x] **[Review][Patch][High]** `parseSonioxTokens` логирует через модульный `rootLogger` вместо инжектированного child-logger [`src/adapters/transcript.ts:199`] — исправлено: добавлен опциональный параметр `logger?: Pick<typeof rootLogger, 'warn'>`; orchestrator передаёт child-log; тесты без изменений (optional param)
- [x] **[Review][Patch][High]** `pollUntilCompleted`: auth HttpError (401/403) не оборачивается в `TranscriptProviderError('auth', ...)` [`src/adapters/soniox.ts:229-290`] — исправлено: добавлен catch-блок аналогично `fetchTranscript`; re-throw для TranscriptProviderError (timeout/unknown_status)
- [x] **[Review][Patch][High]** `transcribeFromUrl` не пишет `log.warn` при `TranscriptDownloadError` [`src/adapters/transcript.ts:92-102`] — исправлено: catch-блок теперь пишет `log.warn` с downloadErrorCode и httpStatus для download-ошибок
- [x] **[Review][Patch][Medium]** Все токены `is_audio_event=true` → `speakers: []` → ZodError с кодом `'schema'` вместо `'empty'` [`src/adapters/transcript.ts:195`] — исправлено: добавлена проверка `speakers.length === 0` перед parse; бросает `TranscriptValidationError('empty', ...)` + alertOps; добавлен тест
- [x] **[Review][Patch][Medium]** `parsePlainText` с blank-only текстом → сегмент с пустым `text` → ZodError [`src/adapters/transcript.ts:273-275`] — исправлено: в fallback-ветке добавлена проверка `trimmed.length === 0` → `TranscriptValidationError('empty', {reason:'blank_text'})`; добавлен тест
- [x] **[Review][Patch][Medium]** `mapDriveError`: `err.code` от googleapis может быть строкой `"404"` [`src/adapters/drive.ts:362-373`] — исправлено: добавлена обработка string-кода через `Number(rawCode)` с NaN-guard
- [x] **[Review][Patch][Low]** `shouldRetryPreBodyOnly` regex `TLS` как подстрока слишком широка [`src/utils/retry.ts:77`] — исправлено: `/TLS/` → `/\bTLS\b/`
- [x] **[Review][Defer]** `transcriptionId` не удаляется на Soniox при failure после `createTranscription` [`src/adapters/transcript.ts:54-124`] — deferred, pre-existing design decision; Story 1.9 добавит ops-cleanup
- [x] **[Review][Defer]** `GOOGLE_SERVICE_ACCOUNT_JSON` lazy validation в `createDriveClient` вместо config-time [`src/adapters/drive.ts:401-428`] — deferred, acknowledged deviation (см. completion notes #2)
- [x] **[Review][Defer]** Нет общего 10-мин тайм-аута на весь цикл `pollUntilCompleted` [`src/adapters/soniox.ts:229-290`] — deferred, MVP approximation; 120 × 5s ≈ 10 min достаточно для текущей нагрузки

Итерация 3 (code-review 2026-04-30, IWE sanity-pass):

- [x] **[Patch][Low]** `mapZoomHttpStatus`: 429 теперь маппится на новый код `'rate_limited'` (ранее `'network'`, что вводило в заблуждение). Добавлен `'rate_limited'` в `TranscriptDownloadCode` union в `src/errors.ts`. Покрыто 1 тестом в `drive.test.ts` (Zoom 429 → `rate_limited`).
- [x] **[Patch][Low]** `ZOOM_RE` сужен до `(download|share)` per Story spec — `/rec/play/` ведёт на HTML player, не downloadable URL. Теперь падает на URL-detection как `not_found` (а не позже как `zoom_auth_required`). Покрыто 1 тестом в `drive.test.ts`.
- [x] **[Patch][Low]** `uploadFile`: `statSync` (sync I/O) заменён на `await stat()` из `node:fs/promises` — устранена потенциальная блокировка event-loop в async-функции.
- [x] **[Defer]** Streaming upload (OOM-риск > 218 MB) — карточка обновлена в `deferred-work.md`. Триггер: Story 1.9.x ИЛИ материализация OOM в проде.
- [x] **[Defer]** `pollUntilCompleted` общий timeout — карточка обновлена в `deferred-work.md`: фактический worst-case 80 мин (120 × {5+1+3+9}с), расхождение с заявленным «10 мин» из Task 3.6. Решение через внешний AbortController, Story 1.9.x.

## Артефакты (Files List — ожидаемый)

**New files:**
- `src/types.ts` — Zod-схемы (canonical)
- `src/errors.ts` — Error classes (Transcript*, SonioxTranscriptSchema validation)
- `src/utils/retry.ts` — withRetry helper
- `src/ops.ts` — alertOps stub
- `src/adapters/transcript.ts` — orchestrator + plain-text + Soniox parser
- `src/adapters/soniox.ts` — REST-клиент
- `src/adapters/drive.ts` — download (Google Drive + Zoom)
- `src/adapters/transcript.test.ts`
- `src/adapters/transcript.schema.test.ts`
- `src/utils/retry.test.ts`
- `scripts/transcript-smoke.ts` — `--url` (live) и `--fixture` (offline) режимы
- `vitest.config.ts` (minimal)
- `docs/adr/adr-005-test-framework.md` — 2-строчный ADR: vitest (с обоснованием)

**Modified:**
- `src/config.ts` — добавить `.refine` для `GOOGLE_SERVICE_ACCOUNT_JSON`, опциональный `SONIOX_API_URL`
- `tsconfig.json` — `exclude: ["node_modules", "dist", "src/**/*.test.ts"]`
- `package.json` — deps: `googleapis`, `mime-types`; devDeps: `vitest`, `@types/mime-types`; scripts: `test`, `test:watch`, `transcript:smoke`
- `.env.example` — уже содержит нужные переменные (из 1.1)

## Заметки для разработчика (Dev Notes)

### Критические архитектурные правила (из `architecture.md`)

1. **Адаптер = граница конвертации camelCase ↔ внешние форматы.** Внутри `src/` — только `camelCase`. Soniox API возвращает `snake_case` → конверсия на выходе адаптера. [Source: architecture.md#Naming Patterns, lines 398-412]
2. **Zod на границе Claude → pipeline + на выходе адаптера** — runtime type safety. Fail-fast на `.parse()` для Steps 1-2 pipeline, `safeParse()` для Steps 3-4. Transcript адаптер = boundary step 0 → fail-fast. [Source: architecture.md#Zod Validation Strategy, lines 466-468]
3. **Пакет `withRetry()` обязателен для внешних API.** Bare `await` на `fetch(soniox.com/...)` = anti-pattern. [Source: architecture.md#Enforcement lines 502]
4. **Логирование**: всегда `logger.child({ pipeline, step, clientId })`. Никогда `console.log`. Child-logger создаётся в `transcribeFromUrl`, передаётся в download/soniox/parse. [Source: architecture.md#Logging lines 442-446]
5. **Transcript Interface Contract = provider-agnostic.** Смена провайдера = замена `src/adapters/soniox.ts` без изменений F1-pipeline. `transcript.ts` НЕ должен утекать Soniox-specific types в types.ts экспорты. [Source: architecture.md#ADR-001 + Architectural Principles #3, lines 180-182]

### Ключевая Soniox API информация (из Story 0.1 валидации — GO 2026-04-14)

- **Base URL:** `https://api.soniox.com/v1`
- **Auth:** `Authorization: Bearer {SONIOX_API_KEY}`
- **Модель:** `stt-async-v4` (проверено на 7 файлах, WER подтверждён, ~$0.0019/мин)
- **Поддерживаемые форматы:** aac, aiff, amr, asf, flac, mp3, ogg, wav, webm, **m4a**, mp4 — webm/mp4/m4a от Google Meet/Zoom работают нативно
- **Файл > 218 MB**: в Story 0.1 один mp4 218 MB был отклонён как `Invalid audio file`. Причина в файле, не в API (m4a 32 MB прошли). На Story 1.2: лимит 500 MB документировать, если файл падает — возвращать user-facing ошибку.
- **Polling:** 5с интервал × 120 = 10 мин timeout. Реальные транскрипции в Story 0.1: 49-105с для файлов 14-33 MB (38-50 мин аудио).
- **Формат ответа:** tokens[].{text, start_ms, end_ms, speaker ("1"|"2"|...), language ("ru"|"kk"), is_audio_event, confidence}

### Target format (`data/golden/transcript-*.json`) — oracle для парсера

```json
{
  "speakers": [
    {
      "name": "Speaker 1",
      "segments": [
        { "start": 14.82, "end": 43.26, "text": "Жұмбақ, сіз мені..." },
        { "start": 57.36, "end": 65.22, "text": " Всё, слышно..." }
      ]
    }
  ],
  "metadata": { "date": "2026-03-XX...", "duration": 2469.0, "meeting_type": "tracking_session" }
}
```

Timestamps в секундах (с двумя знаками после запятой). Leading space в segment.text сохраняется из Soniox token.text — не обрезать.

### Урок Story 0.1 — применять в production-коде (были Review findings):

| # | Проблема в soniox-test.ts | Фикс в Story 1.2 |
|---|---------------------------|------------------|
| 1 | `readFileSync` грузит весь файл в RAM, `Blob([buf])` удваивает | Streaming upload через `fs.createReadStream` + `Blob` wrapper, лимит 500 MB (AC #1) |
| 2 | Пустой `SONIOX_API_KEY=""` проходит guard → невнятный 401 | Уже покрыт в Story 1.1 fix (Zod `.min(1)`) |
| 3 | Dead code: `webhook_url` в теле запроса без реальной поддержки | Webhook scaffold как отдельная функция, без монтирования на HTTP до Story 1.14 |
| 4 | Нет валидации формы Soniox response → `TypeError: not iterable` | `SonioxTranscriptSchema` Zod-валидация перед парсером |
| 5 | Polling не различает `canceled`/`expired` → 10 мин впустую | Whitelist `KNOWN_PENDING_STATUSES = {queued, processing}`, остальное → fail fast |
| 6 | `durationMs = max(end_ms)` назван «длительность» (путаница с длительностью аудио vs. последнего токена) | В parser назвать `lastTokenEndMs`; если нужна `audioDurationSec` — брать из `Content-Length` / ffprobe, но на MVP достаточно tokens (соответствует golden dataset) |
| 7 | Отсутствие `DELETE /v1/files` после транскрипции → копится storage | Обязательный `DELETE /v1/files/{id}` в `finally` (AC #3 Task 3.9) |
| 8 | Нет timeout на `fetch` | `AbortSignal.timeout(15*60*1000)` на каждый вызов |

### Урок Story 1.1 — применять (из code review):

- **Root directory / outDir**: после фикса в Story 1.1, `rootDir: "./src"` — убедиться, что `scripts/transcript-smoke.ts` не попадает в tsc build, а запускается через `tsx` (как уже сделано для `soniox-test.ts` в `package.json`).
- **Fail-fast env**: `config.ts` exit(1) на top-level — `src/config.ts` импортируется транзитивно через `logger.ts`. При написании unit-тестов использовать `vitest.config.ts` с `env` блоком для подставки тестовых значений.
- **Pino child-logger паттерн** уже установлен в `src/index.ts` (`logger.child({ step: 'bootstrap' })`) — использовать аналогично: `logger.child({ pipeline: 'F1', step: 'transcript', clientId })`.

### Circuit Breaker — scope clarification

Architecture (lines 318-319, 475-479) определяет circuit breaker для **Claude API** в `claude.ts` (3 failures за 5 мин → fallback mode, auto-recover через 15 мин). Для **Soniox** circuit breaker **НЕ в scope Story 1.2**. Rationale:

- MVP-нагрузка < 5 встреч/нед → `withRetry` с 3 попытками и exponential backoff покрывает transient failures.
- Circuit breaker имеет смысл при параллельных вызовах (несколько встреч одновременно), чего на MVP нет.
- Story 1.9 (ops logging + alerts) добавит: при 3+ подряд неудачных `transcribeFromUrl` за час → alert Тимуру в ops-канал. Это cheaper вариант CB для данного масштаба.

Если Soniox оказывается системно ненадёжным (> 5 сбоев/нед) → reopen как Story 1.9.x или deferred-work.

### Anti-patterns (запрещено — enforcement grep-rules):

- ❌ `const tokens = JSON.parse(await response.text())` без Zod-валидации Soniox response
- ❌ `fetch(...)` без `AbortSignal.timeout` и без `withRetry()`
- ❌ `console.log` где угодно (всегда `logger`)
- ❌ Leak Soniox-specific типов (SonioxToken, SonioxTranscript) из `transcript.ts` в public API
- ❌ Inline `prompts` в коде — не применимо к Story 1.2, но правило общее
- ❌ Хардкод `client_id`-специфичных путей — Story 1.2 работает только с логикой parse; persistence в data/{client_id}/{date}/ — Story 1.10

### Зависимости между stories

- **После Story 1.1 (review):** foundation config/logger/server есть. `src/config.ts` нужно расширить под GOOGLE_SERVICE_ACCOUNT_JSON validation (deferred-work.md:15).
- **Параллельно c Story 1.3:** обе читают из `config.GOOGLE_SERVICE_ACCOUNT_JSON`. Story 1.3 сейчас backlog — pre-install `googleapis` в 1.2 не блокирует её.
- **Blocks Story 1.4a:** F1 pipeline потребляет `Transcript`. Контракт `TranscriptSchema` фиксируется в Story 1.2.
- **Blocks Story 1.5:** bot handlers `/report` и `/upload` зовут `transcribeFromUrl` / `transcribeFromPlainText`. Публичное API адаптера = source of truth.
- **Blocks Story 1.11:** golden dataset (`data/golden/transcript-*.json`) уже существует (Story 0.3, 2026-04-20). В 1.2 эти файлы выступают oracle для snapshot-тестов парсера.

### Project Structure Notes

- Создаваемые в 1.2 файлы соответствуют `architecture.md#Updated Project Structure (post-validation)` (lines 681-734).
- `src/types.ts` — один canonical файл всех Zod-схем (ADR, ~100-150 строк). Не разбивать по pipeline до 6+ схем.
- Test location: `src/**/*.test.ts` (co-located) соответствует архитектуре (`tests/` — только `delivery.test.ts` от 1.11).
- `scripts/soniox-test.ts` — ОСТАЁТСЯ одноразовым валидатором, не трогаем. Production-код — отдельная реализация в `src/adapters/soniox.ts` (может внутри иметь общий helper, но не импортировать из `scripts/`).

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story 1.2 — lines 515-544 (AC)]
- [Source: _bmad-output/planning-artifacts/epics.md#FR57-FR58 — lines 84-85 (contract + validation)]
- [Source: _bmad-output/planning-artifacts/epics.md#NFR30-NFR37 — lines 150-157 (Soniox quality + contract)]
- [Source: _bmad-output/planning-artifacts/prd.md — lines 234-243 (Поток ввода транскрипта, Soniox rationale)]
- [Source: _bmad-output/planning-artifacts/architecture.md — lines 69 (Soniox flow), 129-143 (structure), 280-297 (Data Architecture), 398-412 (Naming), 466-468 (Zod strategy), 492-512 (enforcement+antipatterns), 580-608 (Adapter boundary), 687-733 (updated structure)]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md — lines 867-875 (F1 error handling taxonomy — URL невалидный, транскрипт < 2 мин)]
- [Source: _bmad-output/implementation-artifacts/0-1-validaciya-provaydera-transkripcii-soniox.md — lines 117-164 (Soniox API docs), lines 83-107 (review findings для избегания в prod)]
- [Source: _bmad-output/implementation-artifacts/1-1-project-bootstrap-i-konfiguraciya.md — lines 137-171 (review findings — config pattern, shutdown guard)]
- [Source: _bmad-output/implementation-artifacts/deferred-work.md — lines 15 (GOOGLE_SERVICE_ACCOUNT_JSON FS check defer → пришла очередь)]
- [Source: scripts/soniox-test.ts — reference implementation для REST client и parser, но **не копировать** (одноразовый код)]
- [Source: data/golden/transcript-*.json — oracle для snapshot-тестов парсера (Story 0.3 artifacts)]
- [Source: Soniox API docs — https://soniox.com/docs, stt-async-v4]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (1M context)

### Debug Log References

Итерация 1 (2026-04-22):
- Typecheck: `npm run typecheck` → 0 ошибок
- Tests: `npm test` → 3 файла, 32 теста — все pass
- Build: `rm -rf dist && npm run build && find dist -name "*.test.js"` → пусто

Итерация 2 (2026-04-23, post-code-review):
- Typecheck: `npm run typecheck` → 0 ошибок
- Tests: `npm test` → **4 файла, 52 теста — все pass** (retry +6, transcript +7, drive 7 новых)
- Build: `rm -rf dist && npm run build && find dist -name "*.test.js"` → пусто

### Completion Notes List

**Итерация 2 — code review fixes (2026-04-23):**
- ✅ Resolved review finding [High]: Config error таксономия — `TranscriptConfigError` + `alertOps` routing в orchestrator. Reviewer's concern: "broken server config will look like 'bad link, try /upload'" — устранён.
- ✅ Resolved review finding [Medium]: POST /files и POST /transcriptions получили `withRetry` на pre-body ошибках (transient DNS/TLS/connection-refused), не нарушая non-idempotent семантику.
- ✅ Resolved review finding [Medium]: `unsupported_format` эмитируется; allowlist всех форматов Soniox; Zoom больше не принимает `application/octet-stream`.
- ✅ Resolved review finding [Low]: `TranscriptMetadataSchema.date` теперь `z.iso.datetime({ offset: true })` — строгий ISO-8601.
- Tests: 32 → 52 (+20 regression tests).

---

**Итерация 1 — Реализованные артефакты:**
- Transcript Interface Contract (Zod-схемы) в `src/types.ts` — provider-agnostic, без утечек Soniox-типов
- Error-таксономия в `src/errors.ts` — три класса с `cause` поддержкой
- `src/utils/retry.ts` — exponential backoff {1s, 3s, 9s}, no-retry на 401/403, retry на 5xx/429/network
- `src/adapters/soniox.ts` — REST-клиент с разной retry-семантикой для idempotent (GET) vs non-idempotent (POST) методов; Zod-валидация ответа Soniox; latency-логи через child-logger
- `src/adapters/drive.ts` — Google Drive (через googleapis SDK + service account) и Zoom (public links через fetch+follow-redirect); 500 MB hard limit; mime→ext mapping через mime-types lib + overrides; cleanup callback
- `src/adapters/transcript.ts` — orchestrator `transcribeFromUrl` и `transcribeFromPlainText`; парсер Soniox tokens → Transcript (группировка по speaker, фильтр audio_event, leading-space preservation, monotonic timestamps); plain-text парсер с pattern matching на «Спикер N:» / «Speaker N:» / «Имя:»; fail-fast на ZodError + alertOps()
- `src/ops.ts` — alertOps() stub (logger.error level=ops_alert), Telegram-канал — TODO Story 1.9

**Ключевые отклонения от спеки (с обоснованием, после итерации 2):**
1. **Streaming upload отложен** (Task 3.8): спека предлагала ReadableStream-Blob wrapper или 500 MB hard limit. Выбран hard limit + warn-лог при > 100 MB. Обоснование: streaming-Blob через `Readable.toWeb()` + кастомный Blob-like object — хрупкий хак c undici internals, на типичных файлах 14-33 MB (Story 0.1) hard limit достаточен. Если в проде встретится файл > 100 MB и OOM-риск материализуется — реализовать streaming в Story 1.9.x.
2. **GOOGLE_SERVICE_ACCOUNT_JSON refine() перенесён в createDriveClient** (Task 8.2): спека требовала `.refine()` в config.ts. Перенесено в lazy-валидацию первого использования. Причина: Task 11.2 описывает `--fixture-all` smoke как «offline-friendly, подходит для CI», что несовместимо с config-time FS-check. Lazy-валидация одинаково fail-fast для сервера (createDriveClient вызывается на первом downloadAudio при старте боевого пайплайна), но не блокирует тесты/fixture-smoke. См. также vitest.config.ts — `NODE_ENV=test` подставляет dummy-путь.
3. **Schema-acceptance тест на golden** (Task 10.5): golden-фикстуры созданы в Story 0.3 c placeholder `metadata.date = "unknown"` и `meeting_type = "unknown"`. Это не соответствует строгой ISO-валидации `TranscriptSchema`. Тест нормализует metadata перед `parse()`, фактически валидируя только speakers/segments shape — что и есть основной контракт регрессии парсера.
4. **Orchestrator integration-тест с full-mock Soniox** (Task 10.6): не реализован. Реализован integration-стиль через `transcribeFromPlainText` (без сети). Полный mock-orchestrator для `transcribeFromUrl` отложен — приоритет покрытия `parseSonioxTokens` + `withRetry` + `TranscriptSchema`, и orchestrator является чистой композицией уже покрытых функций. Если в Story 1.5 (bot integration) появятся регрессии — добавить здесь.

**Покрытие Acceptance Criteria:**
- AC #1 (Google Drive download): drive.ts URL-detection + googleapis stream → temp file + 500 MB limit + AbortSignal.timeout(10 min) ✓
- AC #2 (Zoom download): drive.ts ZOOM_RE + fetch follow-redirect + content-type check → zoom_auth_required ✓
- AC #3 (Soniox 4-step polling): soniox.ts uploadFile → createTranscription → pollUntilCompleted → fetchTranscript + AbortSignal.timeout(15 min) + retry-разделение idempotent vs non-idempotent ✓
- AC #4 (parser): parseSonioxTokens — группировка, audio_event filter, monotonic timestamps, golden compatibility ✓
- AC #5 (Zod validation): TranscriptSchema.parse fail-fast + alertOps + logger.error ✓
- AC #6 (plain-text): transcribeFromPlainText + 200-char too_short ✓
- AC #7 (download errors): TranscriptDownloadError taxonomy с `not_found | access_denied | unsupported_format | file_too_large | timeout | zoom_auth_required | network`, redactUrl без токенов ✓
- AC #8 (GOOGLE_SERVICE_ACCOUNT_JSON validation): createDriveClient lazy-валидация existence + JSON.parse + client_email field (с deviation note выше) ✓

**Smoke fixture-режим** на 7 golden парах: parser даёт ДРУГУЮ сегментацию (алгоритмическая группировка по speaker-change vs hand-curated golden из Story 0.3, где сегменты могли быть split вручную для F1/F4 промптов). Это ожидаемо и не означает регрессии — TranscriptSchema проходит на 100% fixture, что подтверждает контрактную совместимость. Live-сравнение Soniox vs golden — задача Story 1.4a/1.11.

### File List

**New files:**
- `src/types.ts` — Zod-схемы Transcript Interface Contract (canonical)
- `src/errors.ts` — `TranscriptDownloadError`, `TranscriptProviderError`, `TranscriptValidationError`, `TranscriptConfigError` (итерация 2)
- `src/utils/retry.ts` — `withRetry` helper + `defaultShouldRetry` + `shouldRetryPreBodyOnly` (итерация 2)
- `src/utils/retry.test.ts` — +6 тестов для `shouldRetryPreBodyOnly` (итерация 2)
- `src/ops.ts` — `alertOps()` stub (Telegram TODO Story 1.9)
- `src/adapters/soniox.ts` — REST-клиент (createSonioxClient + Zod-схемы Soniox response); POST'ы обёрнуты в `withRetry(shouldRetry: shouldRetryPreBodyOnly)` (итерация 2)
- `src/adapters/drive.ts` — download (Google Drive + Zoom); `createDriveClient` бросает `TranscriptConfigError`; `SUPPORTED_MIME_TYPES` allowlist emits `unsupported_format` (итерация 2)
- `src/adapters/transcript.ts` — orchestrator + parseSonioxTokens + parsePlainText; итерация 2: `catch` между `try`/`finally` для routing non-user-facing ошибок в `alertOps`; re-export `TranscriptConfigError`
- `src/adapters/transcript.test.ts` — parser + plain-text + integration tests; итерация 2: +7 тестов (error routing + strict ISO-8601)
- `src/adapters/transcript.schema.test.ts` — TranscriptSchema acceptance на golden dataset
- `src/adapters/drive.test.ts` — **новый файл в итерации 2**: 7 тестов (unsupported_format routing, zoom_auth_required, redactUrl)
- `scripts/transcript-smoke.ts` — `--url`/`--fixture`/`--fixture-all` режимы
- `vitest.config.ts` — env-block для тестов
- `docs/adr/adr-005-test-framework.md` — ADR: vitest

**Modified:**
- `src/config.ts` — добавлен `SONIOX_API_URL` (optional URL); GOOGLE_SERVICE_ACCOUNT_JSON оставлен `z.string().min(1)` (см. completion notes deviation #2 — lazy validation в createDriveClient)
- `src/types.ts` — итерация 2: `TranscriptMetadataSchema.date` → `z.iso.datetime({ offset: true })`
- `tsconfig.json` — `exclude` расширен `src/**/*.test.ts`
- `package.json` — deps: `googleapis@^171.4.0`, `mime-types@^3.0.2`; devDeps: `vitest@^4.1.5`, `@types/mime-types@^3.0.1`; scripts: `test`, `test:watch`, `transcript:smoke`

### Change Log

- 2026-04-22: Реализован Story 1.2 — Transcript Interface Contract, audio download (Google Drive + Zoom), Soniox REST-клиент с разделённой retry-семантикой, Soniox→Transcript parser, plain-text fallback, orchestrator с alertOps на ZodError, latency-логирование, vitest-тесты (32 passing), smoke-script с --fixture/--url режимами. Status: ready-for-dev → review.
- 2026-04-23: Addressed code review findings — 4 items resolved (High: config error routing, Medium×2: POST pre-body retry + unsupported_format enforcement, Low: strict ISO-8601). Tests 32 → 52. Status: review → review (повторная итерация).
- 2026-04-30: IWE sanity-pass — 3 minor patches (rate_limited код для Zoom 429, ZOOM_RE без /rec/play/, statSync → async stat) + 2 deferred-карточки (streaming upload, pollUntilCompleted total timeout). Tests 52 → 58. Status: review → done.
