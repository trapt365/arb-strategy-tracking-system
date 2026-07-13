---
title: 'Пакетный приём команды и front-load онбординга'
type: 'feature'
created: '2026-07-13'
status: 'done'
baseline_revision: '370f7af384e88f479d15c225d78c3cdb587de7ce'
final_revision: '3555c712ff4f8fa00933790eb263e7febdbe1a68'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** В фазе профиля A3.2 (участники команды) трекер вынужден добавлять каждого участника по одному — текстом или голосом. Нет возможности прислать весь список разом: скриншот, документ с оргструктурой или PDF; бот не принимает фото ни в каком контексте. После пакетного извлечения нет review-экрана — данные либо принимаются молча, либо Q&A ведётся вопрос за вопросом.

**Approach:** Добавить batch-intake на вопрос A3.2: принимать фото (Claude Vision → список участников) и текстовые документы (txt/md/docx/pdf → `extractAllTopsWithLlm`). После пакетного извлечения показывать review-экран «Принять / Добавить ещё» вместо молчаливого добавления. На вопрос A3.2 добавить front-load подсказку о доступных batch-опциях (фото 📸, документ 📎, голос 🎤 уже работает поодиночке).

## Boundaries & Constraints

**Always:**
- Batch-intake активен ТОЛЬКО в `session.phase === 'profile'` при `currentProfileQuestion.id === 'a3_2'` и `!profileOfferPending(session)`.
- Ошибка извлечения (Claude API, пустой результат, download fail) → graceful fallback: сообщение об ошибке, сессия остаётся в A3.2, пользователь добавляет вручную.
- `topsBatchPending` — in-memory поле F0Session (не персистируется); review сбрасывается при перезапуске бота.
- Голосовой путь A3.2 не изменяется: по-прежнему через `extractTopWithLlm` (один участник) — batch для голоса не вводится.
- Регресс: аудио/видео intake (F1), collecting-фаза, A3.1 (оргструктура-файл), A3.3 (decision maker), questionnaire, filling — без изменений. `npm test` и `npm run typecheck` зелёные.
- Изображения: Telegram photo — скачивать самый большой вариант (последний элемент `ctx.message.photo`); допустимые MIME для Vision: `image/jpeg`, `image/png`, `image/gif`, `image/webp`.

**Block If:** нет.

**Never:**
- Не изменять голосовой путь A3.2 (Story 11.5 + существующая механика).
- Не принимать документы в A3.2 если session.mode уже зафиксирован как `import` — нет: в profile-фазе `session.mode` ещё не установлен, проверка не нужна.
- Не трогать collecting-фазу document-handler (batch там — про стратегию, не про команду).
- Не добавлять `topsBatchPending` в `F0PersistedSessionSchema` — трансиентное состояние.
- Не менять `renderF0DraftSummaryMessage`, `runF0FullDraft`, F0-очередь, F1-пайплайн.
- Не использовать LLM для OCR, если можно обойтись без него: для фото используем Claude Vision (один вызов: видит изображение и извлекает список участников структурированно).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Трекер, profile/A3.2, фото оргструктуры | `message:photo`, jpeg ≤20 МБ | "🔍 Анализирую фото…" → Vision API → review-экран с N участниками + кнопки | Claude error / empty list → "⚠️ Не удалось извлечь... добавь вручную" |
| Трекер, profile/A3.2, PDF/DOCX/txt со списком | `message:document`, supported, ≤20 МБ | "📄 Разбираю документ…" → extract text → `extractAllTopsWithLlm` → review-экран | Error → "🔴 Не удалось разобрать..." |
| Review-экран, пользователь нажал ✅ Принять | `f0p_batch_ok` callback | Все pending tops добавлены в profile.tops; advance → A3.3 | stale/no pending → F0_PROFILE_STALE_TEXT |
| Review-экран, пользователь нажал ✏️ Добавить ещё | `f0p_batch_more` callback | Pending tops добавлены; показана клавиатура f0ProfileTopsKeyboard (ещё 1 по 1) | stale → F0_PROFILE_STALE_TEXT |
| Фото > 20 МБ в profile/A3.2 | Большое фото | "⚠️ Файл больше 20 МБ..." | — |
| Фото НЕ в profile/A3.2 (другой вопрос или фаза) | `message:photo`, session.phase ≠ profile или q ≠ a3_2 | F0_PROFILE_FIRST_TEXT (если в profile-фазе) или игнорирование (если нет сессии) | — |
| Документ в profile/A3.2 (unsupported тип) | `.xlsx` или `.exe` в A3.2 | F0_UNSUPPORTED_TEXT | — |
| Трекер, profile/A3.2, text/voice (существующее) | Текст «Дамир, CEO» | Без изменений: `extractTopWithLlm` → "✅ Топ добавлен" | Без изменений |
| session.processing = true | Фото или документ в batch-режиме | F0_BUSY_TEXT | — |

</intent-contract>

## Code Map

- `src/types.ts:399-405` — `ClientTopSchema` — добавить `export const ClientTopArraySchema = z.array(ClientTopSchema)` рядом; импортировать в bot.ts
- `src/adapters/claude.ts:371-408` — `callClaude`/`callClaudeSafe` — добавить после них `export async function callClaudeWithImage<T>(imageBuffer, imageMimeType, textPrompt, opts)`
- `src/bot.ts:83-84` — импорт `ClientTopSchema` из types.ts — добавить `ClientTopArraySchema`
- `src/bot.ts:118` — импорт `callClaudeSafe` из claude.js — добавить `callClaudeWithImage`
- `src/bot.ts:202-208` — `BotDeps` — добавить `extractAllTopsWithLlm?` и `extractAllTopsWithLlmFromImage?`
- `src/bot.ts:240-257` — инициализация `extractTopWithLlm` — добавить рядом инициализацию обоих новых deps
- `src/bot.ts:346-401` — `F0Session` interface — добавить `topsBatchPending?: ClientTop[]`
- `src/bot.ts:1276-1315` — `askNextProfileQuestion` — добавить batch-hint при `q.id === 'a3_2'`
- `src/bot.ts:2539-2552` — `message:document` profile-block — добавить ветку для A3.2 перед A3.1
- `src/bot.ts:~4194` — после `bot.on('message:voice', ...)` — добавить `bot.on('message:photo', ...)`
- `src/bot.ts:1449-1460` — после `f0p_top_done` callback — добавить `f0p_batch_ok` и `f0p_batch_more`
- `src/bot.ts:~4380` — после `handleMeetingTextTranscript` — добавить `handleProfileA3BatchDocument`, `handleProfileA3BatchPhoto`, `deliverTopsBatchReview`
- `src/bot.test.ts:280-330` — `BuildOpts`/`buildBot` — добавить `extractAllTopsWithLlm?` и `extractAllTopsWithLlmFromImage?`
- `prompts/extract-all-tops.md` — НОВЫЙ prompt для batch participant extraction

## Tasks & Acceptance

**Execution:**

- `prompts/extract-all-tops.md` — создать новый prompt:
  ```
  Extract ALL people from the text below as a JSON array.

  Text: {{text}}

  Return a JSON array of objects with exactly these fields per object:
  - "name": string (required)
  - "title": string or null (job title / role)
  - "authority": string or null (scope of authority / responsibilities)
  - "area": string or null (area of responsibility / zone)

  Rules:
  - Include every distinct person mentioned. Do NOT invent values not in the text.
  - If a field cannot be identified, set it to null.
  - Return only the JSON array, no extra text.
  ```

- `src/adapters/claude.ts` — добавить после `callClaudeSafe`:
  ```typescript
  export async function callClaudeWithImage<T>(
    imageBuffer: Buffer,
    imageMimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
    textPrompt: string,
    opts: CallClaudeOpts<T>,
  ): Promise<CallClaudeResult<T>>
  ```
  Реализация: повторяет `executeClaudeCall` логику retry/error, но `messages[0].content` = массив `[{ type: 'image', source: { type: 'base64', media_type: imageMimeType, data: imageBuffer.toString('base64') } }, { type: 'text', text: textPrompt }]`. Парсинг через `parseClaudeJSON` как в `callClaude`.

- `src/bot.ts` — `BotDeps` (~line 202): добавить:
  ```typescript
  /** Story 11.8: batch extraction from text for A3.2 team list (тесты подменяют). */
  extractAllTopsWithLlm?: (text: string) => Promise<ClientTop[]>;
  /** Story 11.8: batch extraction from image for A3.2 (тесты подменяют). */
  extractAllTopsWithLlmFromImage?: (buf: Buffer, mimeType: string) => Promise<ClientTop[]>;
  ```

- `src/bot.ts` — инициализация в `createBot` рядом с `extractTopWithLlm` (~line 241): добавить default-реализации обоих инжектируемых:
  - `extractAllTopsWithLlm`: загружает prompt `extract-all-tops`, вызывает `callClaudeSafe(..., { schema: z.array(ClientTopSchema), maxTokens: 800 })`, возвращает `parsed ?? []`.
  - `extractAllTopsWithLlmFromImage`: формирует строку-prompt «Extract ALL people from this image as a JSON array. Fields: name, title, authority, area (null if missing). Return only JSON array.», вызывает `callClaudeWithImage(buf, mimeType as ..., prompt, { schema: z.array(ClientTopSchema), maxTokens: 800, stepName: 'f0.extract_all_tops_image' })`, возвращает `parsed`.

- `src/bot.ts` — `F0Session` interface (~line 346): добавить после `companyMismatchPending?: boolean`:
  ```typescript
  // Story 11.8: pending batch-review список участников (только in-memory).
  topsBatchPending?: ClientTop[];
  ```
  НЕ добавлять в `saveF0Session` / `F0PersistedSessionSchema`.

- `src/bot.ts` — `askNextProfileQuestion` (~line 1307): перед вызовом `ctx.reply(text, ...)` добавить:
  ```typescript
  // Story 11.8: front-load batch hint at A3.2 when no tops yet.
  if (q.id === 'a3_2' && (profile.tops ?? []).length === 0 && !inExt) {
    text +=
      '\n\n💡 Можешь прислать список разом — фото 📸, документ 📎 (PDF/DOCX/TXT) или голос 🎤 (добавляю по одному). Или вводи текстом по одному.';
  }
  ```

- `src/bot.ts` — `message:document` handler, block `if (session.phase === 'profile')` (~line 2539): вставить ПЕРЕД `if (q?.id === 'a3_1' ...)` новую ветку:
  ```typescript
  // Story 11.8: A3.2 batch document intake — document at a3_2 extracts full team list.
  if (q?.id === 'a3_2' && !profileOfferPending(session)) {
    await handleProfileA3BatchDocument(ctx, chatId, session);
    return;
  }
  ```

- `src/bot.ts` — добавить `bot.on('message:photo', ...)` handler после `bot.on('message:voice', ...)`:
  ```typescript
  bot.on('message:photo', async (ctx) => {
    const chatId = ctx.chat.id;
    if (!trackerChatIds.has(chatId)) return;
    const session = await getOrRestoreF0Session(chatId);
    if (session === undefined || session.phase !== 'profile') return; // не в онбординге
    const q = currentProfileQuestion(session);
    if (q?.id !== 'a3_2' || profileOfferPending(session)) {
      await ctx.reply(F0_PROFILE_FIRST_TEXT).catch(() => {});
      return;
    }
    await handleProfileA3BatchPhoto(ctx, chatId, session);
  });
  ```

- `src/bot.ts` — добавить callback `f0p_batch_ok` после `bot.callbackQuery('f0p_top_done', ...)`:
  - Получить сессию через `getProfileSessionForCallback(ctx, 'a3_2')`.
  - Если `session.topsBatchPending` пуст → `F0_PROFILE_STALE_TEXT`, return.
  - `session.profile.tops = [...(session.profile.tops ?? []), ...session.topsBatchPending]`.
  - `session.topsBatchPending = undefined`.
  - reply `✅ Добавлено N участников (всего: M).` → `advanceProfileQuestion(ctx, session, q, 'answered')`.

- `src/bot.ts` — добавить callback `f0p_batch_more` аналогично `f0p_batch_ok`:
  - Те же шаги добавления pending tops.
  - НЕ вызывать `advanceProfileQuestion`; вместо этого `saveF0Session` + reply `✅ Добавлено N. Пришли следующего участника свободной фразой.` с `reply_markup: f0ProfileTopsKeyboard`.

- `src/bot.ts` — добавить функции `handleProfileA3BatchDocument`, `handleProfileA3BatchPhoto`, `deliverTopsBatchReview` после `handleMeetingTextTranscript`:
  - `handleProfileA3BatchDocument(ctx, chatId, session)`: проверить `isSupportedF0Document` + размер (→ F0_UNSUPPORTED_TEXT / F0_TOO_LARGE_TEXT при нарушении); `session.processing = true`; reply "📄 Разбираю…"; download → `extractTextFromDocument` → `extractAllTopsWithLlm(extracted.text)`; если пусто → "⚠️ Не нашёл участников..."; иначе `deliverTopsBatchReview`; в catch → "🔴 Не удалось разобрать..."; finally `session.processing = false`.
  - `handleProfileA3BatchPhoto(ctx, chatId, session)`: взять `ctx.message?.photo?.[ctx.message.photo.length - 1]`; проверить размер; `session.processing = true`; reply "🔍 Анализирую фото…"; download → `extractAllTopsWithLlmFromImage(buf, 'image/jpeg')`; если пусто → "⚠️ Не удалось извлечь..."; иначе `deliverTopsBatchReview`; в catch → "🔴 Не удалось разобрать фото..."; finally `session.processing = false`.
  - `deliverTopsBatchReview(ctx, chatId, session, tops, sourceName)`: `session.topsBatchPending = tops`; `saveF0Session`; сформировать текст «👥 Извлёк N участников (из: sourceName):\n  1. [renderTopShort]...»; reply с InlineKeyboard «✅ Принять» (`f0p_batch_ok`) + «✏️ Добавить ещё» (`f0p_batch_more`).

- `src/bot.test.ts` — добавить в `BuildOpts` и `buildBot`: `extractAllTopsWithLlm?: BotDeps['extractAllTopsWithLlm']` и `extractAllTopsWithLlmFromImage?: BotDeps['extractAllTopsWithLlmFromImage']`; defaults: `extractAllTopsWithLlm: opts.extractAllTopsWithLlm ?? (async () => [])`, `extractAllTopsWithLlmFromImage: opts.extractAllTopsWithLlmFromImage ?? (async () => [])`.

- `src/bot.test.ts` — добавить `photoUpdate(chatId = TEST_TRACKER_CHAT_ID): Update` вспомогательную функцию рядом с `documentUpdate`:
  ```typescript
  function photoUpdate(chatId = TEST_TRACKER_CHAT_ID): Update {
    return { update_id: updateCounter++, message: { message_id: 2000 + updateCounter, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private', first_name: 'Test' }, from: { id: chatId, is_bot: false, first_name: 'Test' }, photo: [{ file_id: 'photo-1', file_unique_id: 'pu-1', width: 100, height: 100, file_size: 1024 }] } } as unknown as Update;
  }
  ```

- `src/bot.test.ts` — добавить `describe('bot — Story 11.8: пакетный приём команды A3.2', ...)` с `beforeEach(cleanOnboardingArtifacts)` / `afterEach(cleanOnboardingArtifacts)`. Переиспользовать паттерн `setupA32` из Story 11.5:
  ```typescript
  async function setupA32_118(bot) {
    await bot.handleUpdate(commandUpdate('/newclient'));
    await bot.handleUpdate(plainTextUpdate('Ромашка'));
    await bot.handleUpdate(plainTextUpdate('Продаём ромашки бизнесу'));
    await bot.handleUpdate(callbackUpdate('f0p_ext')); // → extended profile → A3.2
  }
  ```
  Тесты (все используют `buildBot({ downloadTelegramFile: async () => Buffer.from('x'), extractTextFromDocument: async () => ({ sourceName: 'file', kind: 'text', text: 'список команды' }), ... })`):
  1. `(a) document в A3.2 → extractAllTopsWithLlm вызван → review-экран с кнопками` — `extractAllTopsWithLlm: vi.fn().mockResolvedValue([{ name: 'Иван', title: 'CEO', authority: null, area: null }])`; отправить `documentUpdate('team.docx')` после `setupA32_118`. Проверить: `extractAllTopsWithLlm` вызван; среди replies есть текст «👥 Извлёк 1»; последний sendMessage payload содержит `reply_markup` с кнопкой `f0p_batch_ok`.
  2. `(b) фото в A3.2 → extractAllTopsWithLlmFromImage вызван → review-экран` — `extractAllTopsWithLlmFromImage: vi.fn().mockResolvedValue([{ name: 'Мария', title: 'CMO', authority: null, area: null }, { name: 'Жанель', title: 'CFO', authority: null, area: null }])`; отправить `photoUpdate()` после `setupA32_118`. Проверить: spy вызван; reply содержит «2 участников».
  3. `(c) f0p_batch_ok → все tops добавлены → переход к A3.3` — после `setupA32_118`, вызвать `f0p_batch_ok` callback при наличии `topsBatchPending` в сессии (setup: предварительно отправить document и дождаться review). Проверить: reply содержит «Добавлено»; следующий вопрос — A3.3 (decision maker).
  4. `(d) extractAllTopsWithLlm возвращает [] → fallback сообщение` — `extractAllTopsWithLlm: async () => []`; отправить `documentUpdate('empty.docx')`; reply содержит «Не нашёл участников».
  5. `(e) фото вне A3.2 (A1.1, начало) → F0_PROFILE_FIRST_TEXT` — после `commandUpdate('/newclient')` (сессия в A1.1); отправить `photoUpdate()`; reply содержит «Сначала профиль клиента» (F0_PROFILE_FIRST_TEXT).

**Acceptance Criteria:**

- Given трекер в profile/A3.2 (нет топов), when бот задаёт вопрос A3.2, then текст содержит подсказку о batch-опциях (фото, документ).

- Given трекер в profile/A3.2, when отправляет JPEG-фото команды (≤20 МБ), then `extractAllTopsWithLlmFromImage` вызван с буфером; показан review-экран с именами участников и кнопками [✅ Принять | ✏️ Добавить ещё].

- Given трекер в profile/A3.2, when отправляет docx/pdf/txt с оргструктурой (≤20 МБ, supported), then `extractAllTopsWithLlm` вызван с извлечённым текстом; показан review-экран.

- Given review-экран после batch-извлечения, when пользователь нажимает ✅ Принять, then все pending tops добавлены в profile.tops; диалог переходит к A3.3.

- Given review-экран, when пользователь нажимает ✏️ Добавить ещё, then pending tops добавлены; показана клавиатура для ввода следующего участника по одному.

- Given трекер в profile НЕ в A3.2, when отправляет фото, then получает F0_PROFILE_FIRST_TEXT (не падает, не перехватывается batch-обработчиком).

- Given `extractAllTopsWithLlm` возвращает пустой массив, when трекер отправляет документ в A3.2, then показано сообщение об ошибке извлечения, диалог остаётся в A3.2.

- Given любые изменения, when `npm test` запущен, then все тесты зелёные. When `npm run typecheck`, then нет ошибок TypeScript.

## Design Notes

**Почему `topsBatchPending` не персистируется:** Это временное состояние review (как `voicePending`), но voice-pending персистируется (повторная запись голоса — friction). Для документов/фото повторная отправка дешевле, чем усложнение persist-схемы. Если потребуется — добавить в будущей story.

**Photo mime type:** Telegram отдаёт фото без mime-type в поле `document`, но через `message:photo` это стандартные JPEG. Для `callClaudeWithImage` hardcode `'image/jpeg'` при photo-handler. PNG/GIF/WebP поддерживаются в Vision API, но Telegram photos — всегда JPEG.

**`callClaudeWithImage` — отдельная функция, не параметр:** Минимальные изменения `executeClaudeCall`; image-логика изолирована в новой функции. Retry/error handling — копия из `executeClaudeCall` (DRY нарушается намеренно: объединение сделает сигнатуру executeClaudeCall нечитаемой).

**Пустой batch:** `extractAllTopsWithLlm` возвращает `[]` при ошибке Claude или 0 участников. Бот показывает graceful-сообщение, не throw. Trace остаётся в логах через `f0Log.warn`.

## Verification

**Commands:**
- `npm test` — expected: все тесты зелёные, включая describe Story 11.8
- `npm run typecheck` — expected: нет ошибок TypeScript

## Auto Run Result

**Status:** done

**Summary:** Реализован пакетный приём участников команды (A3.2) через фото (Claude Vision) и документы (txt/md/docx/pdf → LLM-экстракция), front-load подсказка при первом вопросе A3.2, review-экран «✅ Принять / ✏️ Добавить ещё» после пакетного извлечения. Добавлен новый Vision API адаптер `callClaudeWithImage`.

**Files changed:**
- `prompts/extract-all-tops.md` — NEW: prompt для пакетной экстракции участников
- `src/adapters/claude.ts` — NEW `callClaudeWithImage<T>` (Vision API с base64 + retry/error logic)
- `src/types.ts` — добавлен `ClientTopArraySchema`
- `src/bot.ts` — 9 изменений: импорты, BotDeps, F0Session, default deps, front-load hint, A3.2 document branch, message:photo handler, f0p_batch_ok/more callbacks, 3 новые helper-функции
- `src/bot.test.ts` — photoUpdate helper, 10 новых тестов (a-j) для Story 11.8; cleanSessionArtifacts в Story 11.8 describe
- `src/bot-start-9-3.test.ts` — добавлены imports fs/path, cleanSessionArtifacts, afterEach; chatId изменён 7890→7893 для избежания cross-file race

**Verification:**
- `npm run typecheck` — passed (0 errors)
- `npm test` — 798/798 tests passed (37 files), including 10 Story 11.8 tests; run twice — stable

**Review findings:**
- Patches applied: 2 (void chatId removed from f0p_batch_ok; void total + total removed from f0p_batch_more)
- Items deferred: 2 (callClaudeWithImage adapter unit tests; document processing concurrency test)
- Items rejected: 16

**Residual risks:**
- `callClaudeWithImage` adapter-level path untested; logic mirrors callClaudeSafe
- `topsBatchPending` not persisted — on restart user must re-send photo/document

## Spec Change Log

## Review Triage Log

### 2026-07-13 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (low 2)
- defer: 2: (medium 1, low 1)
- reject: 16
- addressed_findings:
  - `low` `patch` Удалён мёртвый `void chatId` в `f0p_batch_ok` — переменная не нужна, `advanceProfileQuestion` сохраняет сессию
  - `low` `patch` Удалён мёртвый `void total` / `const total` в `f0p_batch_more` — итог не использовался в reply; заодно найдена и исправлена race condition с `session-7890.json` в `bot-start-9-3.test.ts` (chatId изменён на 7893)
