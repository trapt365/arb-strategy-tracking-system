# Story 1.8: First run experience — онбординг Азизы в бот

Status: review

## Пользовательская история

Как **коуч практики (Азиза)**,
Я хочу **при первом запуске бота получить приветствие и краткую инструкцию**,
Чтобы **понять как работать с ботом без внешней помощи (без звонка Тимуру) и сразу попробовать создать первый отчёт**.

## Контекст и границы scope

**Эта история** закрывает пробел между «Аzиза установила бот» и «Азиза знает что делать». Сейчас бот молча принимает только `/report <url>`; на любой текст без pendingEdits/pendingNotes или на `/start` бот ничего не отвечает (UX-DR «Тишина — враг»). После 1.8:

1. **`/start`** — единая точка входа. Telegram автоматически отправляет `/start` при первом открытии бота новым пользователем. Бот отвечает приветствием.
2. **`/help`** — повторный показ инструкции (если Азиза забыла что делать).
3. **Fallback на свободный текст / неизвестную команду** — короткая подсказка с указанием на `/report` и `/help` (нельзя оставлять Азизу в молчании).
4. **`setMyCommands`** — расширяется до `start | help | report` (был только `report`). Это влияет на Bot Menu в Telegram (кнопка `[/]` в поле ввода).

**Архитектурный принцип (UX-DR3 «Тишина — враг»):** Любое сообщение от бота лучше, чем молчание. На `/start`, `/help`, неизвестный текст — всегда ответ. Молчание допустимо только в `pendingEdits` / `pendingNotes` fallthrough (там пользователь явно отвечает другим reply).

**Что входит в Story 1.8 (production-код в `src/`):**

- **`src/bot.ts`** — добавить `bot.command('start', ...)`, `bot.command('help', ...)`, изменить `bot.on('message:text')` так чтобы после `pendingNotes` / `pendingEdits` fallthrough выводилась подсказка вместо молчания. Расширить `setMyCommands` в `start()`. **Запрещено** трогать `/report`, approve/edit/reject handlers, delivery flow.
- **`src/utils/telegram-formatter.ts`** — добавить `formatWelcomeMessage(firstName?: string): string` и `formatHelpHint(): string`. Plain text (НЕ MarkdownV2), так как welcome — это onboarding, escape всех `.` `(` `)` `_` зашумит.
- **`src/bot.test.ts`** — 5-7 новых тестов: `/start` → welcome, `/help` → welcome, неизвестный текст → подсказка, повторный `/start` → welcome (идемпотентность), unauthorized `/start` → unauthorized (whitelist всё ещё работает), после welcome `/report <url>` обрабатывается обычно.

**Что НЕ входит (следующие stories / out-of-scope):**

- **«Первый раз» детекция** (запомнить, что Азиза уже видела welcome) — НЕ нужно. `/start` отправляется Telegram-клиентом при первом открытии бота и при тапе на кнопку START → семантически это «покажи онбординг снова». Persistence «seen chats» — over-engineering на MVP single-user деплое.
- **Реализация Bot Menu callbacks** `[🔍 Найти]` (Story 1.13), `[📋 Повестка]` (Epic 3), `[📊 Статус]` (Story 1.12). В welcome их перечисляем как **обещание** с пометкой «скоро» — не реализуем callbacks.
- **`setChatMenuButton` с custom commands menu** — уже стоит `{ type: 'commands' }` (Story 1.5). Не меняем.
- **Inline-кнопка `[📨 Попробовать /report]`** в welcome — НЕ нужна. Telegram не даёт `/report` без аргумента быть полезной inline-кнопкой (нужен URL от пользователя). Текстовая подсказка достаточна.
- **Многоязычность** — only Russian. Communication_language=Russian per config.
- **Welcome для tops (Дамир, Жанель и др.)** — ADR-004: бот не общается с топами напрямую. Whitelist отсечёт их раньше.
- **`/cancel`, `/stop`, `/status` команды** — out-of-scope. `/status` — это Story 1.12.

**Контракт с предыдущими stories:**

```typescript
// Story 1.5 уже устанавливает:
// - whitelist middleware (bot.use → unauthorized если chatId не в TELEGRAM_TRACKER_CHAT_IDS)
// - bot.command('report', ...) — /report <url> handler
// - bot.api.setMyCommands([{ command: 'report', ... }]) в start()
// - bot.api.setChatMenuButton({ menu_button: { type: 'commands' } }) в start()

// Story 1.6/1.7 устанавливают:
// - pendingEdits, pendingNotes Map state (closure внутри createBot)
// - bot.on('message:text') handler с pendingNotes → pendingEdits fallthrough → return

// Story 1.8 НЕ ломает ни один из этих контрактов:
// - /start, /help — новые команды, не пересекаются с /report
// - setMyCommands расширяется: добавляется start, help. /report остаётся.
// - bot.on('message:text') — ПОСЛЕ существующего pendingEdits-блока fallthrough заменяется
//   с silent return на подсказку. Это меняет поведение для текста БЕЗ pending* — раньше
//   молчание, теперь "ℹ️ Не понял. Используй /report <url> или /help."
//   ВАЖНО: проверить что Story 1.6 edit reply на «не тот message_id» (existing 'Нажми [✏️]
//   под нужным отчётом.') не дублируется новой подсказкой — там уже есть явный reply.
```

## Критерии приёмки

1. **Сценарий: первый запуск (`/start`)** [Source: epics.md#Story 1.8]
   ```
   Дано Азиза впервые открыла бот и Telegram автоматически отправил `/start`
     ИЛИ Азиза вручную набрала `/start`
   И chatId Азизы в trackerChatIds (whitelist прошёл)
   Когда `/start` получен
   Тогда бот отвечает welcome-сообщением (plain text, без parse_mode):
     - Приветствие: «👋 Привет, {firstName}! Я — AI-трекинг бот.» (firstName из ctx.from.first_name,
       fallback «Привет!» если first_name пустой)
     - 1-2 строки описания возможностей: «Я слушаю записи встреч с топами и готовлю отчёты,
       которые ты пересылаешь клиенту.»
     - Объяснение основной команды:
       «Основное:\n`/report <ссылка>` — создать отчёт по записи (Google Drive / Zoom)»
     - Перечисление будущих возможностей (Bot Menu items, помечены «скоро»):
       «Скоро:\n🔍 Найти — поиск прошлых отчётов\n📋 Повестка — подготовка к встрече\n📊 Статус — текущее состояние»
     - CTA: «Отправь ссылку на запись прямо сейчас — и я сделаю первый отчёт. Команда `/help`
       — повторить эту инструкцию.»
   И `log.info({ step:'bot.start.welcomed', chatId, firstName }, 'welcome sent')`
   И queue.size() === 0 (welcome не создаёт job)
   ```

2. **Сценарий: `/help` показывает ту же инструкцию** [Source: ux-design-specification.md#«Тишина — враг» line 292]
   ```
   Дано Азиза набрала `/help` (любое время после онбординга)
   И chatId в whitelist
   Когда `/help` получен
   Тогда бот отвечает welcome-сообщением (то же содержимое что и /start)
     ИЛИ сокращённой версией с тем же CTA (любая из двух реализаций приемлема — оба варианта
     закрывают AC; ВАЖНО: одна функция-источник, без копипасты)
   И `log.info({ step:'bot.help.requested', chatId }, 'help sent')`
   ```

3. **Сценарий: повторный `/start` идемпотентен** [Source: epics.md#Story 1.8 — Telegram пользователи часто тапают START кнопку повторно]
   ```
   Дано Азиза уже видела welcome
   Когда Азиза снова отправляет `/start` (например, тапнув START кнопку в чате)
   Тогда бот снова отправляет welcome-сообщение
   И НЕ создаёт никакого pending state
   И НЕ показывает «вы уже видели приветствие»
   И log как обычный welcome
   ```

4. **Сценарий: свободный текст без pending — подсказка** [Source: ux-design-specification.md#«Тишина — враг»]
   ```
   Дано Азиза отправляет произвольный текст без команды (например, «привет», «помоги»,
     или текст без reply_to_message)
   И pendingNotes для chatId пуст
   И pendingEdits для chatId пуст
   Когда `bot.on('message:text')` обработал и не нашёл pending state
   Тогда бот отвечает короткой подсказкой (plain text):
     «ℹ️ Не понял команду. Используй `/report <ссылка>` для отчёта или `/help` для инструкции.»
   И `log.info({ step:'bot.fallback.hint', chatId, textLen }, 'fallback hint sent')`
   И НЕТ alertOps (это нормальный edge case, не ошибка)
   ```

5. **Сценарий: неизвестная команда (например, `/foo`) — подсказка** [defensive]
   ```
   Дано Азиза отправила неизвестную команду `/foo` (или `/cancel`, `/status`, любую кроме
     start/help/report)
   И chatId в whitelist
   Когда сообщение обработано всеми зарегистрированными command handlers без матча
   Тогда сработает тот же `bot.on('message:text')` fallback (Telegram-команды это тоже
     message.text с bot_command entity)
     ИЛИ отдельный handler `bot.on('message::bot_command')` — приемлемо любое из двух
   И отвечает: «ℹ️ Не понял команду. Используй `/report <ссылка>` или `/help`.»
   И log step:'bot.fallback.hint'
   ```

6. **Сценарий: unauthorized `/start` — whitelist отсекает** [regression — Story 1.5 contract]
   ```
   Дано chatId НЕ в trackerChatIds (например, посторонний пользователь нашёл бота)
   Когда отправлен `/start`
   Тогда whitelist middleware (Story 1.5) перехватывает ДО `bot.command('start')`
   И бот отвечает unauthorized: «⚠️ Доступ ограничен.»
   И alertOps вызван с step:'bot.unauthorized'
   И welcome НЕ отправляется
   И queue.size() === 0
   ```

7. **Сценарий: после welcome `/report <url>` работает штатно** [regression — Story 1.5]
   ```
   Дано Азиза получила welcome через `/start`
   Когда Азиза отправляет `/report https://drive.google.com/file/d/abc/view`
   Тогда обычный flow Story 1.5: ack «✅ Принято. Отчёт через ~15 мин.», job в очереди,
     processJob запущен
   И welcome state НЕ влияет на /report (welcome stateless)
   ```

8. **Сценарий: pendingEdits/pendingNotes reply не триггерит fallback** [regression — Story 1.6/1.7]
   ```
   Дано pendingNotes для chatId установлен (job approved, [📝 Уточнение] нажат)
   Когда Азиза отвечает на instruction message текстом «вот уточнение»
   Тогда сработает existing pendingNotes branch (отправка plain-text note)
   И НЕ срабатывает fallback hint
   И НЕ срабатывает welcome
   ```

9. **Сценарий: `setMyCommands` обновлён в `start()`** [Source: architecture.md#Telegram Format Patterns]
   ```
   Дано createBot.start() вызывается
   Когда `bot.api.setMyCommands(...)` вызван
   Тогда массив команд содержит:
     [
       { command: 'start', description: 'Начать работу с ботом' },
       { command: 'help',  description: 'Инструкция и список команд' },
       { command: 'report', description: 'Создать отчёт по встрече' },
     ]
   И порядок ИМЕННО такой (start первым — convention Telegram-ботов)
   И setMyCommands errors не валят start() (try-catch остаётся, log.warn)
   ```

10. **Сценарий: welcome БЕЗ MarkdownV2** [content design]
    ```
    Дано welcome-сообщение содержит обратные кавычки и точки/двоеточия
    Когда `ctx.reply(welcomeText)` вызван
    Тогда parse_mode НЕ передан (plain text)
    И обратные кавычки `code` отображаются буквально (или через Markdown-light если
      решим использовать parse_mode='Markdown' — но НЕ MarkdownV2; на MVP — plain text
      проще и безопаснее: никаких escape, никаких 400 errors)
    И НЕТ риска «can't parse entities» 400 error
    ```

## Задачи / Подзадачи

- [x] **Задача 1: `src/utils/telegram-formatter.ts` — welcome/hint форматирование** (АК: #1, #2, #4, #10)
  - [x] 1.1 Добавить `formatWelcomeMessage(firstName?: string): string`. Plain text (НЕ MarkdownV2). Структура:
    ```
    👋 Привет{NAME}! Я — AI-трекинг бот.

    Я слушаю записи встреч с топами и готовлю отчёты, которые ты пересылаешь клиенту.

    Основное:
    /report <ссылка> — создать отчёт по записи (Google Drive / Zoom)

    Скоро:
    🔍 Найти — поиск прошлых отчётов
    📋 Повестка — подготовка к встрече
    📊 Статус — текущее состояние

    Отправь ссылку на запись — и я сделаю первый отчёт.
    Команда /help — повторить эту инструкцию.
    ```
    Где `{NAME}` = `, ${firstName}` если `firstName` непустой, иначе пустая строка.
    **Один источник правды** для текста (НЕ копировать в `/help`).
  - [x] 1.2 Добавить `formatHelpHint(): string` — короткая подсказка для fallback:
    ```
    ℹ️ Не понял команду. Используй /report <ссылка> для отчёта или /help для инструкции.
    ```
  - [x] 1.3 Тесты в `src/utils/telegram-formatter.test.ts`:
    - `formatWelcomeMessage('Азиза')` содержит «Привет, Азиза», `/report`, `/help`, «🔍 Найти», «📋 Повестка», «📊 Статус».
    - `formatWelcomeMessage(undefined)` содержит «Привет!» без запятой (или «Привет!» вариант без имени).
    - `formatWelcomeMessage('')` — graceful: либо пустое имя обработано как undefined, либо «Привет!» без запятой.
    - `formatHelpHint()` содержит `/report` и `/help`.
    - Welcome НЕ содержит unescaped MarkdownV2-reserved символов в «опасном» контексте (это plain text — escape не требуется; тест убеждается что текст не пытается быть MarkdownV2).

- [x] **Задача 2: `src/bot.ts` — handlers `/start` и `/help`** (АК: #1, #2, #3)
  - [x] 2.1 Импортировать `formatWelcomeMessage`, `formatHelpHint` из `./utils/telegram-formatter.js`.
  - [x] 2.2 Добавить handler `bot.command('start', ...)` ПОСЛЕ whitelist middleware и ПЕРЕД `bot.command('report')`:
    ```typescript
    bot.command('start', async (ctx) => {
      const firstName = ctx.from?.first_name?.trim() || undefined;
      const welcomeText = formatWelcomeMessage(firstName);
      try {
        await ctx.reply(welcomeText); // plain text, no parse_mode
      } catch (err) {
        log.warn({ err, chatId: ctx.chat.id }, 'bot.start.reply_failed');
      }
      log.info(
        { step: 'bot.start.welcomed', chatId: ctx.chat.id, firstName },
        'welcome sent',
      );
    });
    ```
  - [x] 2.3 Добавить handler `bot.command('help', ...)` сразу после `start`:
    ```typescript
    bot.command('help', async (ctx) => {
      const firstName = ctx.from?.first_name?.trim() || undefined;
      const welcomeText = formatWelcomeMessage(firstName);
      try {
        await ctx.reply(welcomeText);
      } catch (err) {
        log.warn({ err, chatId: ctx.chat.id }, 'bot.help.reply_failed');
      }
      log.info({ step: 'bot.help.requested', chatId: ctx.chat.id }, 'help sent');
    });
    ```
    **ВАЖНО:** Использовать одну и ту же функцию `formatWelcomeMessage`, не дублировать текст.

- [x] **Задача 3: `src/bot.ts` — fallback hint в `bot.on('message:text')`** (АК: #4, #5, #8)
  - [x] 3.1 Импортировать `formatHelpHint` (если ещё не импортирован).
  - [x] 3.2 В `bot.on('message:text')` handler — после fallthrough из `pendingEdits` (когда `pending === undefined`) **заменить** existing `return` на:
    ```typescript
    // Story 1.8: fallback hint вместо молчания (UX-DR3 «Тишина — враг»).
    // Сюда падают: свободный текст без reply, и (если регистрируем bot.on здесь же) — неизвестные команды.
    try {
      await ctx.reply(formatHelpHint()); // plain text
    } catch (err) {
      log.warn({ err, chatId }, 'bot.fallback.reply_failed');
    }
    log.info(
      { step: 'bot.fallback.hint', chatId, textLen: ctx.message.text.length },
      'fallback hint sent',
    );
    return;
    ```
    **КРИТИЧНО — порядок branches в `message:text`:**
    1. `pendingNotes.get(chatId)` — если reply на note instruction → handle note, return. Иначе fallthrough.
    2. `pendingEdits.get(chatId)` — если есть pending edit:
       - reply на other message → existing «⚠️ Нажми [✏️] под нужным отчётом.» reply, return.
       - reply на edit instruction → handle edit, return.
    3. (новое) Иначе → `formatHelpHint()` reply, return.
    **НЕ менять** existing pendingEdits-block. Только заменить final implicit `return` без reply на explicit fallback hint.
  - [x] 3.3 Проверить: existing edit branch `if (replyToId !== pending.instructionMessageId) { await ctx.reply('⚠️ Нажми [✏️] под нужным отчётом.'); return; }` — это уже отдельный явный reply, fallback hint его не дублирует (branch возвращает раньше).
  - [x] 3.4 Проверить: handler `pendingNotes` уже имеет `// Reply not on note instruction — fallthrough to pendingEdits.` — fallthrough корректен, fallback hint срабатывает только когда оба pending отсутствуют.

- [x] **Задача 4: `src/bot.ts` — расширить `setMyCommands` в `start()`** (АК: #9)
  - [x] 4.1 В `createBot.start()` (около строки 1040), заменить массив:
    ```typescript
    await bot.api.setMyCommands([
      { command: 'start',  description: 'Начать работу с ботом' },
      { command: 'help',   description: 'Инструкция и список команд' },
      { command: 'report', description: 'Создать отчёт по встрече' },
    ]);
    ```
    Порядок ровно такой: `start` первым (convention Telegram-ботов: `/start` всегда в начале — Telegram автоматически предлагает его при первом открытии).
  - [x] 4.2 НЕ менять existing try/catch и `bot.api.setChatMenuButton({ menu_button: { type: 'commands' } })` — они остаются.

- [x] **Задача 5: Тесты `src/bot.test.ts` — welcome/help/fallback flow** (АК: #1–#8)
  - [x] 5.1 Хелпер для `/start` update (по аналогии с `reportUpdate`):
    ```typescript
    function startUpdate(chatId: number = TEST_TRACKER_CHAT_ID, firstName = 'Test'): Update {
      const message_id = 1000 + updateCounter;
      return {
        update_id: updateCounter++,
        message: {
          message_id,
          date: Math.floor(Date.now() / 1000),
          chat: { id: chatId, type: 'private', first_name: firstName },
          from: { id: chatId, is_bot: false, first_name: firstName },
          text: '/start',
          entities: [{ type: 'bot_command', offset: 0, length: 6 }],
        },
      } as unknown as Update;
    }
    function helpUpdate(chatId: number = TEST_TRACKER_CHAT_ID): Update { /* /help analog */ }
    function plainTextUpdate(text: string, chatId: number = TEST_TRACKER_CHAT_ID): Update {
      // Без entities — обычный текст.
    }
    ```
  - [x] 5.2 Тест: `/start` → welcome (plain text) с именем
    - Send `startUpdate(TEST_TRACKER_CHAT_ID, 'Азиза')`.
    - Verify `sendMessage` вызван с text содержащим «Привет, Азиза», «/report», «🔍 Найти», «📋 Повестка», «📊 Статус», «/help».
    - Verify payload НЕ содержит `parse_mode`.
    - Verify `queue.size() === 0`.
  - [x] 5.3 Тест: `/help` → та же welcome-инструкция
    - Verify `sendMessage` content matches (welcome содержит /report, /help).
  - [x] 5.4 Тест: повторный `/start` идемпотентен
    - Send `/start` дважды.
    - Verify 2 `sendMessage` calls с одинаковым welcome.
    - Verify нет pending state, нет ошибок.
  - [x] 5.5 Тест: свободный текст → fallback hint
    - Send `plainTextUpdate('привет бот')`.
    - Verify `sendMessage` payload.text matches `/Не понял команду.*\/report.*\/help/`.
    - Verify `queue.size() === 0`.
  - [x] 5.6 Тест: unauthorized `/start` → unauthorized reply, нет welcome
    - Send `startUpdate(TEST_UNAUTHORIZED_CHAT_ID)`.
    - Verify reply matches `/Доступ ограничен/`.
    - Verify alertOps вызван с step:'bot.unauthorized'.
    - Verify welcome НЕ отправлен (нет «Привет» в текстах).
  - [x] 5.7 Тест: после welcome `/report` обычно работает
    - Send `/start`, затем `/report https://drive.google.com/file/d/abc/view`.
    - Verify second reply содержит «Принято».
    - Verify `queue.size() === 1`.
  - [x] 5.8 Тест: fallback НЕ срабатывает когда pendingNotes/pendingEdits активны (регрессия 1.6/1.7)
    - Подготовить job в состоянии `delivered` + `pendingNotes.set(chatId, ...)`.
    - Send `textReplyUpdate('моё уточнение', noteInstructionMessageId)`.
    - Verify отправлен «📝 Уточнение к отчёту…», НЕ «Не понял команду».
  - [x] 5.9 Тест: `setMyCommands` payload содержит 3 команды в правильном порядке
    - После `created.start()` — verify `setMyCommands` call payload.commands === [start, help, report].
    - Используй existing `attachApiSpy` (он уже ловит `setMyCommands`).
    - **ВАЖНО:** для теста start() нужно подготовить `bot.api.config.use` перед вызовом start(); существующий `attachApiSpy` уже это делает в `buildBot`.

- [x] **Задача 6: Регрессия — все существующие 256+ тестов** (АК: backward compat)
  - [x] 6.1 `npm test` → все тесты зелёные.
  - [x] 6.2 `npx tsc --noEmit` → no errors.
  - [x] 6.3 Проверить тесты на edit reply «⚠️ Нажми [✏️] под нужным отчётом.» — fallback hint не должен их перебивать (там early return до fallback).
  - [x] 6.4 Проверить тест «unauthorized chatId» (Story 1.5) — он использует `reportUpdate`, не /start; welcome не должен повлиять.

- [x] **Задача 7: Sprint status + Dev Agent Record** (finalize)
  - [x] 7.1 Обновить `sprint-status.yaml`: `1-8-first-run-experience-onbording-azizy: backlog → in-progress → review` через lifecycle.
  - [x] 7.2 Обновить story file status: `ready-for-dev` → `in-progress` → `review` по мере работы.
  - [x] 7.3 Заполнить Dev Agent Record (Agent Model, Debug Log, Completion Notes, File List).

## Dev Notes

### Соответствие архитектуре

- **Inline-first interface (architecture.md#5):** `/report` остаётся единственной user-facing slash-командой для CRUD. `/start`/`/help` — служебные (онбординг + дискаверабилити), не нарушают принцип. Bot Menu (`setMyCommands`) — это discovery layer, не runtime workflow.
- **«Один файл на pipeline» (architecture.md#Structure Patterns):** Bot logic консолидирована в `bot.ts`. Текст приветствия — в `telegram-formatter.ts` как форматирующая утилита (consistency с `formatErrorMessage`, `formatProgressStep`).
- **UX-DR «Тишина — враг» (ux-design-specification.md, line 276, 284, 292):** Молчание = тревога. Любое сообщение лучше тишины. Fallback hint закрывает gap «отправила текст — бот молчит».
- **UX «Одна команда — остальное кнопки» (ux-design-specification.md, line 90-96):** Welcome **называет** будущие Bot Menu кнопки (🔍 Найти / 📋 Повестка / 📊 Статус) как обещание. На MVP они ещё не реализованы — это сознательный onboarding-нарратив, не баг.
- **Whitelist (architecture.md#Authentication & Security, Story 1.5):** Bot auth = whitelist `chat_id` в config. Welcome и hint доступны ТОЛЬКО whitelisted chat'ам — посторонние получают `unauthorized` reply раньше, чем доходят до /start handler. Регрессионный тест #6 это закрепляет.
- **Plain text для onboarding:** MarkdownV2 reserved chars (`.`, `(`, `)`, `_`, `!`) делают онбординг-текст хрупким (легко получить 400 «can't parse entities»). На MVP — plain text без `parse_mode`. Это **отличается** от `formatErrorMessage` (он тоже plain text — consistency сохраняется).
- **Logging (architecture.md#Format Patterns):** pino structured logs с полями `{pipeline:'F1', step:'bot.start.welcomed' | 'bot.help.requested' | 'bot.fallback.hint', chatId, ...}`. `pipeline` остаётся `'F1'` (bot logger child уже `pipeline:'F1', step:'bot.report'` — child override через `log.info({ step: ... })` работает корректно как в существующих handlers).
- **Никаких новых файлов:** Все изменения в `bot.ts`, `telegram-formatter.ts`, `bot.test.ts`, `telegram-formatter.test.ts`, `sprint-status.yaml`. Соответствует architecture.md «Pipeline flow — один файл».

### Source tree (изменения)

| Файл | Действие | ~LOC |
|------|----------|------|
| `src/utils/telegram-formatter.ts` | добавить `formatWelcomeMessage(firstName?)`, `formatHelpHint()` | ~30 |
| `src/utils/telegram-formatter.test.ts` | тесты welcome content, help hint | ~30 |
| `src/bot.ts` | импорты; `bot.command('start')`, `bot.command('help')` handlers; fallback hint в `message:text`; `setMyCommands` extended | ~40 |
| `src/bot.test.ts` | хелперы `startUpdate`/`helpUpdate`/`plainTextUpdate`; 7-9 новых тестов | ~120 |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | статус 1-8 lifecycle | ~2 |

Всего ~200 LOC изменений. Самая большая часть — тесты (~120 LOC).

### Testing Standards

- **Vitest** (existing). Не вызывать `bot.start()` напрямую в большинстве тестов — использовать `bot.handleUpdate(update)`. `setMyCommands` тест — единственный требующий `created.start()` (или альтернатива: mock `bot.api.config.use` и тестировать через прямой вызов `bot.api.setMyCommands(...)` — но проще через `start()`).
- **Тестовые helpers переиспользуются:** `attachApiSpy` (уже ловит `setMyCommands`/`setChatMenuButton`), `TEST_TRACKER_CHAT_ID`, `TEST_UNAUTHORIZED_CHAT_ID`, `buildBot`, `silentLogger`.
- **Новые helpers** в `bot.test.ts`: `startUpdate`, `helpUpdate`, `plainTextUpdate` — копи-пасту из `reportUpdate` минимизировать через общий builder, но при необходимости отдельные функции ОК (consistency с существующим стилем `bot.test.ts`).
- **Pattern для plain-text reply assertion:** `expect((call.payload as { parse_mode?: string }).parse_mode).toBeUndefined()` — verify нет MarkdownV2.
- **Coverage targets:** все 10 AC покрыты как минимум 1 тестом.

### Контракты с другими stories

- **Story 1.5 (whitelist + `setMyCommands` initial):** whitelist middleware гарантирует — welcome видят только trackers. setMyCommands расширяется без breaking changes.
- **Story 1.6 (pendingEdits)**: existing edit-reply branch остаётся priority над fallback hint. Регрессионный тест.
- **Story 1.7 (pendingNotes)**: existing post-delivery note branch остаётся priority над fallback hint. Регрессионный тест.
- **Story 1.9 (ops logging):** новые log steps (`bot.start.welcomed`, `bot.help.requested`, `bot.fallback.hint`) добавятся в общий ops-лог пайплайн без специальных алертов. alertOps НЕ зовётся (welcome — это норма).
- **Story 1.12 (статус pipeline для Айдара):** `[📊 Статус]` callback будет реализован там. Welcome лишь упоминает «скоро» — это не breaking promise.
- **Story 1.13 (поиск отчётов):** `[🔍 Найти]` callback там. Welcome обещает.
- **Epic 3 (F4 повестка):** `[📋 Повестка]` callback там. Welcome обещает.

### LLM-Dev-Agent Guardrails

- **НЕ дублировать текст welcome** между `/start` и `/help`. Единственный источник — `formatWelcomeMessage(firstName)`. Если нужно отличить /help содержание — добавить опциональный параметр в эту функцию (на MVP — не нужно).
- **НЕ использовать MarkdownV2 для welcome/hint.** Reserved chars (`.`, `(`, `)`, `_`, `!`) превратят онбординг в кашу из бэкслешей или 400 errors. Plain text — единственно безопасно. Это сознательный отход от внутренних отчётов (там MarkdownV2 нужен для **bold** имён).
- **НЕ добавлять persistence «seen users»** — over-engineering. `/start` идемпотентен, повторный вызов = повторный welcome (Telegram convention).
- **НЕ создавать новые файлы** — все изменения в существующих. Соответствует architecture «12 source files compact».
- **НЕ менять whitelist middleware** — он защищает все commands. Welcome — НИЖЕ middleware, не выше.
- **НЕ трогать `/report` handler**, approve/edit/reject callbacks, delivery flow, post_note handler. Story 1.8 — чисто аддитивна на уровне команд.
- **НЕ изменять existing edit-reply «⚠️ Нажми [✏️] под нужным отчётом.»** — это явный existing reply в pendingEdits branch; fallback hint срабатывает только когда pendingEdits отсутствует.
- **ПОРЯДОК `message:text` branches КРИТИЧЕН:** pendingNotes → pendingEdits → fallback hint. Не путать.
- **ВСЕГДА `log.info` после успешного reply**, не до — log отражает реальное событие (`'welcome sent'`).
- **`ctx.from?.first_name`** может быть undefined в edge cases (chat без user, hypothetical) — fallback на welcome без имени должен работать. Тест 5.2 это закрывает (Telegram practically всегда даёт first_name, но защитное кодирование — стандарт).
- **`setMyCommands` errors не валят start()** — existing try/catch остаётся. Telegram иногда возвращает 429 при rate-limit; log.warn и продолжаем.
- **НЕ `console.log`** — pino logger child `log` через closure.
- **НЕТ alertOps для fallback hint** — это нормальный edge case (Азиза могла случайно набрать текст), не ошибка. Только log.info.

### Previous Story Intelligence (Story 1.7 + 1.6 + 1.5)

**Ключевые паттерны для переиспользования:**
- `bot.command('name', async (ctx) => { ... })` — handler signature идентичен `/report` handler (Story 1.5, bot.ts:599).
- `ctx.reply(text)` без `parse_mode` → plain text (Story 1.7 уже использует для plain-text WhatsApp блока, bot.ts:161).
- `log.info({ step: 'bot.xxx.yyy', chatId, ... }, 'human message')` — pattern идентичен всем существующим log calls.
- `try { await ctx.reply(...) } catch (err) { log.warn({ err, chatId }, '...') }` — pattern из delivery handler (bot.ts:751).
- `setMyCommands` errors swallowed — existing pattern в start() (bot.ts:1043).
- Test helpers `reportUpdate`, `callbackUpdate`, `textReplyUpdate`, `attachApiSpy`, `buildBot` — все используются как есть; `startUpdate`/`helpUpdate`/`plainTextUpdate` — новые по аналогии.

**Review findings из 1.7 (relevant для 1.8):**
- `attachApiSpy` уже ловит `setMyCommands` и `setChatMenuButton` (bot.test.ts:76) — готовый mock для теста 5.9.
- pendingNotes/pendingEdits branches в `message:text` handler нужно НЕ ломать — порядок и early returns критичны (Story 1.7 review iteration 1 поймала race).

### Project Structure Notes

- Все изменения в существующих файлах (`src/bot.ts`, `src/utils/telegram-formatter.ts`, `src/bot.test.ts`, `src/utils/telegram-formatter.test.ts`).
- НЕ создавать `src/onboarding.ts`, `src/welcome.ts` — нет нужды в отдельном модуле для двух команд и одной форматирующей функции.
- НЕ создавать `prompts/welcome.md` — welcome статичен, не использует Claude.

### References

- [Source: _bmad-output/planning-artifacts/epics.md, Story 1.8 — lines 700-714]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md, lines 90-96 — «одна команда — остальное кнопки» + Bot Menu items]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md, lines 276, 284, 292 — «Тишина — враг», immediate acknowledgment]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md, line 204 — «Bot Menu: Найти / Повестка / Статус → grammY Bot Menu API → Low»]
- [Source: _bmad-output/planning-artifacts/architecture.md, line 73 — inline-first interface, `/report` единственная slash-команда]
- [Source: _bmad-output/planning-artifacts/architecture.md, lines 299-309 — Authentication & Security: whitelist chat_id]
- [Source: _bmad-output/planning-artifacts/architecture.md, lines 426-446 — Format Patterns: Telegram messages, logging]
- [Source: src/bot.ts, lines 576-596 — whitelist middleware (Story 1.5)]
- [Source: src/bot.ts, lines 598-685 — /report command (Story 1.5)]
- [Source: src/bot.ts, lines 900-927 — message:text handler с pendingNotes → pendingEdits (Story 1.6/1.7)]
- [Source: src/bot.ts, lines 1036-1054 — start() с setMyCommands / setChatMenuButton (Story 1.5)]
- [Source: src/utils/telegram-formatter.ts, lines 42-83 — formatProgressStep, formatErrorMessage, formatQueueAck (template for formatWelcomeMessage)]
- [Source: src/bot.test.ts, lines 14-82 — TEST_TRACKER_CHAT_ID, attachApiSpy, reportUpdate (template для startUpdate/helpUpdate)]
- [Source: 1-7-delivery-dostavka-otchyota-klientu.md — message:text handler контракт с pendingNotes/pendingEdits]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m] (Claude Opus 4.7, 1M context) — bmad-dev-story workflow, 2026-05-20.

### Debug Log References

- `npx vitest run src/utils/telegram-formatter.test.ts` → 41/41 pass (после Задачи 1).
- `npx vitest run src/bot.test.ts` → 48/48 pass (38 существующих + 10 новых из Story 1.8).
- `npm test` (полная регрессия) → 279/279 pass, 16/16 test files green.
- `npx tsc --noEmit` → exit 0, no errors.

### Completion Notes List

- **Task 1** (telegram-formatter): добавлены `formatWelcomeMessage(firstName?)` и `formatHelpHint()` как plain-text форматирующие функции (НЕ MarkdownV2 — escape `_`/`.`/`(` зашумит онбординг). Имя через trim+falsy-guard: `'Привет, Азиза!'` если имя есть, иначе `'Привет!'` без запятой. 6 unit-тестов покрывают непустое имя / undefined / пустую строку / содержание блоков `/report` `/help` `Скоро` `🔍 Найти` `📋 Повестка` `📊 Статус` / отсутствие backslash-escape.
- **Task 2** (handlers): `bot.command('start', ...)` и `bot.command('help', ...)` зарегистрированы ПОСЛЕ whitelist middleware и ПЕРЕД `bot.command('report')` (порядок не важен для функциональности, но соответствует convention setMyCommands). Оба используют одну и ту же `formatWelcomeMessage(firstName)` — single source of truth. Both reply без `parse_mode`. Логи: `step:'bot.start.welcomed'` и `step:'bot.help.requested'`. Failure-mode: `try { ctx.reply } catch { log.warn(..., 'bot.{start,help}.reply_failed') }`.
- **Task 3** (fallback hint в `message:text`): заменён implicit silent return на explicit `formatHelpHint()` reply при `pendingEdits === undefined` (после fallthrough из pendingNotes). Логика веток сохранена: 1) pendingNotes match → handle note, return; 2) pendingNotes mismatch → fallthrough; 3) pendingEdits undefined → **fallback hint**; 4) pendingEdits set без reply → silent return (preserves Story 1.6 «non-reply text while pending edit — silently ignored»); 5) pendingEdits set с wrong replyToId → existing «⚠️ Нажми [✏️]…»; 6) pendingEdits set с right replyToId → handle edit. Лог: `step:'bot.fallback.hint', textLen`.
- **Task 4** (setMyCommands): массив расширен до `[start, help, report]` с порядком `start` первым (Telegram convention для онбординга). Existing try-catch + `setChatMenuButton({ type:'commands' })` сохранены без изменений.
- **Task 5** (тесты): добавлены helpers `startUpdate`, `helpUpdate`, `plainTextUpdate` (по аналогии с `reportUpdate`, с bot_command entity для команд и без неё для свободного текста). Покрыты все 10 AC: AC#1 (welcome с именем + plain text + queue=0), AC#2 (/help → welcome single source), AC#3 (идемпотентность повторного /start), AC#4 (free-form text → hint), AC#5 (unknown command /foo → hint), AC#6 (unauthorized /start), AC#7 (welcome + /report flow), AC#8 (pendingNotes reply не триггерит fallback), AC#9 (setMyCommands payload порядок) + AC#1-edge (welcome без firstName → `Привет!` без запятой). Всего +10 тестов в `bot.test.ts` (38 → 48) и +6 в `telegram-formatter.test.ts` (35 → 41).
- **Task 6** (regression): 279/279 tests pass, typecheck clean. Никаких регрессий в Story 1.5/1.6/1.7 тестах. Worker termination warnings от vitest (drive/bot/transcript test files) — pre-existing, не наша история.
- **Не сделано (out-of-scope per story)**: persistence «seen chats» (по design — /start идемпотентен), Bot Menu callbacks (🔍/📋/📊 → следующие stories), `setChatMenuButton` customization, многоязычность.

### File List

- `src/utils/telegram-formatter.ts` (modified): добавлены `formatWelcomeMessage`, `formatHelpHint`.
- `src/utils/telegram-formatter.test.ts` (modified): +6 тестов для welcome/hint форматтеров.
- `src/bot.ts` (modified): импорт `formatWelcomeMessage` + `formatHelpHint`; новые `bot.command('start')` + `bot.command('help')`; fallback hint в `bot.on('message:text')` при `pendingEdits === undefined`; `setMyCommands` расширен до `[start, help, report]`.
- `src/bot.test.ts` (modified): helpers `startUpdate`/`helpUpdate`/`plainTextUpdate`; +10 тестов первого запуска (welcome/help/fallback/unauthorized/setMyCommands).
- `_bmad-output/implementation-artifacts/sprint-status.yaml` (modified): `1-8-...: ready-for-dev → in-progress → review` lifecycle.
- `_bmad-output/implementation-artifacts/1-8-first-run-experience-onbording-azizy.md` (modified): Status, checkboxes, Dev Agent Record.

### Change Log

- 2026-05-20: Story 1.8 implementation complete. /start + /help onboarding handlers added, fallback hint в `bot.on('message:text')` закрывает UX-DR3 «Тишина — враг», setMyCommands расширен до `[start, help, report]`. 16 новых тестов (10 в bot.test.ts, 6 в telegram-formatter.test.ts), 279/279 regression pass, typecheck clean. Status → review.
