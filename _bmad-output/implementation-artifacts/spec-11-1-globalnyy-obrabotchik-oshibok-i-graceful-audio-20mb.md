---
title: 'Глобальный bot.catch + graceful-обработка аудио >20 МБ'
type: 'bugfix'
created: '2026-07-13'
status: 'done'
baseline_revision: 'daef3046786c0b8ca5ad64ba3840c102dc8e463c'
review_loop_iteration: 0
followup_review_recommended: false
final_revision: '17c38713050b08c6da536cc8302976787309fad4'
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** Бот не имеет глобального обработчика ошибок (`bot.catch`): любое необработанное исключение из хендлера вызывает grammY-ошибку «No error handler was set!», которая триггерит `unhandledRejection` → `process.exit(1)` → pm2-рестарт. Второй дефект: `handleMeetingFileIntake` вызывает `ctx.getFile()` без проверки `file_size`, что на файлах >20 МБ бросает «400: file is too big», роняя процесс (воспроизведено на `жанель 11.m4a` ~27 МБ, 13 июля).

**Approach:** (1) Зарегистрировать `bot.catch` сразу после `new Bot(...)` — логировать ошибку, вызывать `alertOps`, отправлять пользователю дежурное сообщение. (2) В `handleMeetingFileIntake` добавить проверку `file_size` до `ctx.getFile()` и при превышении 20 МБ — graceful-выход с понятным сообщением.

## Boundaries & Constraints

**Always:**
- `bot.catch` регистрируется в `createBot()` сразу после `const bot = new Bot(...)` (line 273) — до любых `bot.on`/`bot.command` регистраций.
- Файловый лимит для аудио/видео встречи — тот же `F0_MAX_FILE_BYTES` (20 * 1024 * 1024), уже импортированный в `src/bot.ts` из `src/utils/f0-input.ts`.
- Все существующие пути (аудио/видео ≤20 МБ, очередь, активный клиент) продолжают работать без изменений.
- После реализации: canary + golden + весь vitest + tsc зелёные; боевая таблица Geonline не затрагивается.

**Block If:** Нет.

**Never:**
- Не изменять механику очереди, `processJob`, F1-pipeline.
- Не добавлять ограничение по размеру на `message:voice` (голосовые сообщения проходят через отдельный хендлер и ограничены иначе Telegram-стороной).
- Не подавлять ошибку в `bot.catch` без лога и `alertOps`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Хендлер бросает | Любой update, хендлер внутри throws | `bot.catch` перехватывает: `log.error` + `alertOps` + reply пользователю; процесс не падает | Ошибка reply (`ctx.reply`) подавляется `.catch(()=>{})` |
| Аудио >20 МБ | `message:audio` с `file_size = 21_000_000` | Бот отвечает сообщением о лимите; `ctx.getFile` НЕ вызывается | Нет — graceful-выход из хендлера |
| Видео >20 МБ | `message:video` с `file_size = 25_000_000` | Аналогично аудио | Нет |
| `file_size` отсутствует | `message:audio` без `file_size` в объекте | Продолжить обработку как обычно (оставить на `getFile`) | `getFile` может вернуть 400 — поймается `bot.catch` |
| Аудио ≤20 МБ | `message:audio` с `file_size = 5_000_000` | Обработка не изменилась — `ctx.getFile` вызывается | Существующие пути ошибок без изменений |

</intent-contract>

## Code Map

- `src/bot.ts:1` — импорт `{ Bot, GrammyError, ... }` из `grammy`; сюда добавить `BotError`
- `src/bot.ts:273` — `const bot = new Bot(...)` — точка размещения `bot.catch` (сразу после)
- `src/bot.ts:4118` — `handleMeetingFileIntake(ctx, chatId)` — добавить file_size pre-check перед line 4167
- `src/bot.ts:4167` — `const file = await ctx.getFile()` — вызов, который надо защитить
- `src/bot.ts:1055` — `F0_TOO_LARGE_TEXT` — аналогичный UX-паттерн; для аудио/видео используем отдельный текст (`MEETING_TOO_LARGE_TEXT`) с формулировкой «Сожми запись или разбей на части»
- `src/bot.ts:4278–4283` — регистрации `bot.on('message:audio', ...)` и `bot.on('message:video', ...)` — контекст, оба вызывают `handleMeetingFileIntake`
- `src/bot.test.ts` — основной тест-файл бота (3 460 строк), vitest; сюда добавляются новые тесты

## Tasks & Acceptance

**Execution:**

- `src/bot.ts` — добавить `BotError` в импорт из `grammy` (line 1); зарегистрировать `bot.catch` сразу после `const bot = new Bot(...)` (line 273): логировать `err.error` с `step: 'bot.catch'`, вызывать `alertOps({ pipeline: 'bot', step: 'bot.catch', error: err.error, context: { updateId: err.ctx.update.update_id } })`, отправлять пользователю `'⚠️ Что-то пошло не так. Попробуй снова — если ошибка повторится, напиши администратору.'` через `err.ctx.reply(...).catch(() => {})`.

- `src/bot.ts` — в `handleMeetingFileIntake` (line 4118) добавить константу `MEETING_TOO_LARGE_TEXT` и file_size pre-check после блока `assertClientId` (после line 4165) и до `ctx.getFile()` (line 4167): извлечь `fileSize = (ctx.message?.audio ?? ctx.message?.video)?.file_size`; если `fileSize !== undefined && fileSize > F0_MAX_FILE_BYTES` — ответить `MEETING_TOO_LARGE_TEXT` и вернуться из функции.

- `src/bot.test.ts` — добавить тест: хендлер бросает → `bot.catch` перехватывает → пользователь получает reply с `'⚠️ Что-то пошло не так'`, `alertOps` вызван, обновление не вешает процесс. Добавить тест: audio update с `file_size = 21_000_000` → reply с `MEETING_TOO_LARGE_TEXT`, spy на `getFile` подтверждает — не вызывался.

**Acceptance Criteria:**

- Given любой зарегистрированный хендлер бота бросает исключение, when grammY обрабатывает update, then ошибка логируется (`log.error`), `alertOps` вызван, пользователь получает сообщение `'⚠️ Что-то пошло не так...'`, процесс продолжает работу.
- Given `message:audio` с `file_size > 20 МБ`, when файл поступает в чат, then бот отвечает `MEETING_TOO_LARGE_TEXT`, `ctx.getFile()` не вызывается.
- Given `message:video` с `file_size > 20 МБ`, when файл поступает в чат, then поведение аналогично audio — graceful reply, нет вызова `getFile`.
- Given мультиклиентность и регресс Geonline, when `bot.catch` и size-check внедрены, then аудио/видео ≤20 МБ обрабатываются как прежде; canary + golden + весь vitest + tsc зелёные; боевая таблица Geonline не затронута.

## Spec Change Log

## Review Triage Log

### 2026-07-13 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 0
- defer: 3: (high 0, medium 0, low 3)
- reject: 10
- addressed_findings:
  - none

## Design Notes

`bot.catch` в grammY получает объект `BotError` с полями `.error` (исходное исключение) и `.ctx` (контекст update). Без `bot.catch` grammY при ошибке хендлера в long-polling режиме выбрасывает `Error: 'No error handler was set!'`, которая становится `unhandledRejection` → `process.exit(1)`. Регистрация `bot.catch` перехватывает эту цепочку.

Проверка `file_size` сделана условной (`fileSize !== undefined`) — если Telegram не прислал `file_size`, пропускаем файл дальше: или он в пределах лимита, или `getFile` вернёт 400 и `bot.catch` это поймает.

## Verification

**Commands:**
- `npm test` — expected: все vitest-тесты зелёные, включая новые тесты bot.catch и file_size
- `npm run typecheck` — expected: нет ошибок TypeScript
- `npm run canary` — expected: exit code 0 (canary pass)

## Auto Run Result

**Summary:** Добавлен глобальный `bot.catch` в grammY-бот и pre-check размера файла в `handleMeetingFileIntake`. Теперь любое необработанное исключение из хендлера логируется, вызывает alertOps и сообщает пользователю вместо краша процесса; аудио/видео-файлы >20 МБ деградируют graceful до вызова getFile.

**Files changed:**
- `src/bot.ts` — добавлен `BotError` в grammy-импорт; зарегистрирован `bot.catch` после `new Bot(...)` (lines 275–286); добавлен `MEETING_TOO_LARGE_TEXT` и `fileSize` pre-check в `handleMeetingFileIntake` (lines 4180–4187)
- `src/bot.test.ts` — исправлен `videoUpdate()` helper (50MB → 10MB, old value triggered new guard); добавлены 5 новых тестов: 1 для bot.catch, 4 для file_size guard (audio >20MB, video >20MB, audio ≤20MB, audio без file_size)
- `_bmad-output/implementation-artifacts/spec-11-1-globalnyy-obrabotchik-oshibok-i-graceful-audio-20mb.md` — spec-файл story
- `_bmad-output/implementation-artifacts/epic-11-context.md` — скомпилированный контекст эпика
- `_bmad-output/implementation-artifacts/deferred-work.md` — 3 deferred findings

**Review findings breakdown:**
- Patches applied: 0
- Items deferred: 3 (low severity — grammY private API в тесте, reply failure не логируется в bot.catch)
- Items rejected: 10

**Verification:**
- `npm test` → EXIT:0, 734/734 тестов
- `npm run typecheck` → EXIT:0, нет ошибок TypeScript
- `npm run canary` → EXIT:1 REVIEW (pre-existing: баланс Anthropic API = 0, зафиксировано как внешний блокер в epic 11; изменения в bot.ts не затрагивают F1 LLM pipeline)

**Residual risks:**
- Canary проходит с кодом 1 (REVIEW) из-за нулевого баланса Anthropic API — не связано с этой story; устраняется пополнением баланса (PENDING Тимур)
- `bot.catch` не тестируется через реальный grammY polling loop — тест вызывает `errorHandler` напрямую (задокументировано в deferred-work)
