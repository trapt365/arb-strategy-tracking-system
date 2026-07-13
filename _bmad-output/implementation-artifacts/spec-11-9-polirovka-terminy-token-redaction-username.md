---
title: 'Полировка: термины «участники», token-redaction, username'
type: 'refactor'
created: '2026-07-13'
status: 'done'
baseline_revision: '0b9bac68350f258ca4711a7a3a9ac8555a677faa'
final_revision: 'cc3b176b1e2e430d14522ac446b0c8b48da9137c'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** Онбординговый UX использует внутренний жаргон «топы» вместо понятного «участники работы с трекером», вопрос A3.3 (decision maker) создаёт лишний шаг без практического применения в отчётах, а bot-токен теоретически может попасть в логи через поля `err` (URL при скачивании файла).

**Approach:** (1) Переименовать «топы/Топ» → «участники/Участник» во всех пользовательских строках онбординга. (2) Полностью удалить вопрос `a3_3`, его handler, клавиатуру и поле `decisionMaker` из схемы. (3) Добавить Pino-сериализатор `err`, маскирующий `config.TELEGRAM_BOT_TOKEN` в `message`/`stack`. (4) BotFather ребрендинг — Manual TODO Тимуру (код не нужен).

## Boundaries & Constraints

**Always:**
- Переименование только в пользовательских строках (text/reply/description/button label). Идентификаторы `tops`, `ClientTop`, `profile.tops`, `topsBatchPending`, `extractAllTopsWithLlm`, `profileTopsContext`, `buildQnOwnerKeyboard` не трогать.
- Sheets tab name `'👤 Шаблон топа'` в `src/f0-sheets.ts` не переименовывать — живое имя листа в Google Sheets.
- После удаления a3_3 flow: `f0p_top_done` → A1.3 автоматически через `advanceProfileQuestion` (без доп. routing).
- `decisionMaker` удаляется из `ClientProfileSchema`, `applyProfileAnswer`, `isQuestionAnswered`, `renderProfileCard`, `f0p_dm` handler. Существующие session-файлы с этим полем парсятся нормально: Zod стрипает неизвестные ключи.
- F0 questionnaire (`buildQnOwnerKeyboard`, `f0q_owner`) не затрагивается — выбор ответственного за KR — отдельный механизм.
- `npm test` и `npm run typecheck` зелёные.

**Block If:** нет.

**Never:**
- Переименовывать переменные/поля: `tops`, `topsBatchPending`, `extractAllTopsWithLlm*`, `profileTopsContext`.
- Трогать `'👤 Шаблон топа'` (Sheets tab name).
- Добавлять `decisionMaker` в новое место.

</intent-contract>

## Code Map

- `src/types.ts:444` — `decisionMaker: z.string().optional()` в `ClientProfileSchema` — удалить
- `src/f0-profile.ts:54` — комментарий «a3_2 и a3_3 — всегда первыми»; объект a3_3 (~66-71); `applyProfileAnswer` case a3_3 (~271-272); `isQuestionAnswered` case a3_3 (~323-324); `renderProfileCard` DM-строка (~394); A3.2 question text (~61-62)
- `src/bot.ts:1206` — кнопка `'➕ Добавить топов'`
- `src/bot.ts:1222-1231` — `profileDmKeyboard()` — удалить
- `src/bot.ts:1250` — offer message `'Добавить топов и детали сейчас'`
- `src/bot.ts:1357` — `if (q.id === 'a3_3') keyboard = profileDmKeyboard(session)` — удалить
- `src/bot.ts:1459` — `'✅ Топ добавлен:'`
- `src/bot.ts:1556-1569` — `bot.callbackQuery(/^f0p_dm:(\d+)$/, ...)` — удалить полностью
- `src/bot.ts:3366` — `'Закончить с топами'`
- `src/bot.ts:3492` — `'потом добавим топов'`
- `src/bot.ts:3670` — `' · личные листы топов:'`
- `src/bot.ts:4992` — bot command description `'Добавить топов и расширенный профиль клиента'`
- `src/utils/telegram-formatter.ts:307,331` — `'отчёты по встречам с топами'`
- `src/logger.ts` — добавить Pino serializer `err` с redaction токена
- `src/f0-profile.test.ts:34,62,94,187` — a3_3 тесты
- `src/bot.test.ts:2759,2779,2781,2795,3082,3913-3928,4317,4335` — DM тесты

## Tasks & Acceptance

**Execution:**

- `src/types.ts` — удалить строку `decisionMaker: z.string().optional(), // A3.3 🔑` из `ClientProfileSchema`

- `src/f0-profile.ts` — 5 изменений:
  1. Удалить объект `{ id: 'a3_3', ... }` из `PROFILE_EXT_QUESTIONS` (~66-71); обновить comment «a3_2 и a3_3 — всегда первыми» → «a3_2 — всегда первым» (~54)
  2. Заменить в A3.2 question text (~61): `'Кто из топов участвует'` → `'Кто из участников работы с трекером участвует'`
  3. Удалить `case 'a3_3': profile.decisionMaker = value; break;` из `applyProfileAnswer` (~271-272)
  4. Удалить `case 'a3_3': return filled(profile.decisionMaker);` из `isQuestionAnswered` (~323-324)
  5. Удалить строку с `DM: ${profile.decisionMaker}` из `renderProfileCard` (~394)

- `src/bot.ts` — 3 группы:
  1. Удалить `profileDmKeyboard()` (~1222-1231) и ветку `if (q.id === 'a3_3') keyboard = profileDmKeyboard(session)` (~1357)
  2. Удалить `bot.callbackQuery(/^f0p_dm:(\d+)$/, ...)` (~1556-1569) целиком
  3. Переименовать «топ*» в пользовательских строках:
     - 1206: `'➕ Добавить топов'` → `'➕ Добавить участников'`
     - 1250: `'Добавить топов и детали сейчас'` → `'Добавить участников и детали сейчас'`
     - 1459: `` '✅ Топ добавлен:' `` → `` '✅ Участник добавлен:' ``
     - 3366: `'Закончить с топами'` → `'Закончить с участниками'`
     - 3492: `'потом добавим топов'` → `'потом добавим участников'`
     - 3670: `' · личные листы топов:'` → `' · личные листы участников:'`
     - 4992: `'Добавить топов и расширенный профиль клиента'` → `'Добавить участников и расширенный профиль клиента'`

- `src/utils/telegram-formatter.ts` — строки ~307 и ~331: `'отчёты по встречам с топами'` → `'отчёты по встречам с участниками'`

- `src/logger.ts` — добавить `serializers` в pino options:
  ```typescript
  serializers: {
    err: (err: Error) => {
      const s = pino.stdSerializers.err(err);
      const token = config.TELEGRAM_BOT_TOKEN;
      if (token) {
        const re = new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
        if (s.message) s.message = s.message.replace(re, '[TOKEN]');
        if (s.stack) s.stack = s.stack.replace(re, '[TOKEN]');
      }
      return s;
    },
  },
  ```
  Импортировать `config` из `'./config.js'`; использовать `pino.stdSerializers` (уже доступен через импортированный `pino`).

- `src/f0-profile.test.ts` — обновить тесты, связанные с a3_3:
  1. Тест «расширенная часть: 16 вопросов; a3_2 и a3_3 первыми» (~34): удалить `'a3_3'` из ожидаемого порядка; обновить заголовок и число 16 → 15
  2. Удалить тест-assertion `expect(byId('a3_3').type).toBe('choice')` (~62)
  3. Удалить применение a3_3 и связанные expectations (~94-103)
  4. Удалить ожидание `'DM: Дамир'` в тесте renderProfileCard (~193); удалить `decisionMaker: 'Дамир'` из setup объекта профиля (~187)

- `src/bot.test.ts` — обновить тесты:
  1. ~2759: удалить `decisionMaker: 'Айгерим'` из объекта profile в beforeEach
  2. ~2779: удалить `expect(cardMsg.payload.text).toContain('DM: Айгерим')`
  3. ~2781: счётчик `2/16` → `1/15` (tops отвечены, a3_3 не существует, 15 ext вопросов)
  4. ~2794-2796: обновить комментарий; `(3/16)` → `(2/15)`
  5. ~3082: удалить строку `await bot.handleUpdate(callbackUpdate('f0p_dm:0'))` и комментарий к ней; обновить комментарий ~3083 — после f0p_top_done следующий вопрос A1.3, skip count = 14 (без изменений)
  6. ~3913-3928: переименовать тест «f0p_dm:0 работает» → «после f0p_top_done показан вопрос A1.3»; удалить шаг `f0p_dm:0` и assertion на `'Decision maker'`; добавить: `await bot.handleUpdate(callbackUpdate('f0p_top_done'))` уже есть (~3925), после него проверить что в replys содержится `'история'` или `'Год основания'` (текст вопроса A1.3)
  7. ~4317: переименовать «переход к A3.3» → «переход к A1.3»; строка ~4335 — заменить `/decision|лицо|maker|принимает решени/i` → `/история|Год основания/i`

**Acceptance Criteria:**

- Given трекер в онбординге, when бот задаёт вопрос A3.2, then текст содержит «участников работы с трекером» и не содержит слова «топов».

- Given трекер нажал «✅ Готово» после A3.2 (f0p_top_done), when бот переходит к следующему вопросу, then показывается вопрос A1.3 («Год основания»), вопрос про decision maker не появляется.

- Given callback data `f0p_dm:0` поступил в бот (например, устаревшая inline-клавиатура), when бот его получает, then не происходит краша (handler удалён, grammy тихо игнорирует неизвестный callback).

- Given клиентская карточка с заполненными `tops`, when она рендерится через `renderProfileCard`, then строка «DM:» отсутствует.

- Given pino logger настроен, when в `err.message` или `err.stack` присутствует значение `config.TELEGRAM_BOT_TOKEN`, then в log-выводе это значение заменено на `[TOKEN]`.

- Given любые изменения, when `npm test`, then все тесты зелёные. When `npm run typecheck`, then 0 ошибок TypeScript.

## Design Notes

**Счётчик расширенных вопросов:** После удаления a3_3 блок содержит 15 вопросов (было 16). Существующий счётчик в `askNextProfileQuestion` считает ответы через `PROFILE_EXT_QUESTIONS.length` — обновление автоматическое. Все тесты с хардкодным `2/16`, `3/16` нужно обновить на `1/15`, `2/15`.

**Удаление f0p_dm при наличии старых inline-клавиатур:** После деплоя старые сообщения с кнопками DM всё ещё существуют в Telegram. Нажатие вызовет callbackQuery без handler — grammy не краш, но вернёт `answerCallbackQuery` с пустым ответом. Это допустимо; при необходимости можно добавить catch-all позже.

**Pino serializer:** Токен в формате `BOT_ID:HASH` — нет regex-спецсимволов, но экранирование применяется для надёжности. Serializer регистрируется один раз при запуске — не hot-path.

## Verification

**Commands:**
- `npm test` — expected: все тесты зелёные (включая обновлённые f0-profile и bot)
- `npm run typecheck` — expected: 0 ошибок TypeScript

## Auto Run Result

**Status:** done

**Summary:** Реализована полировка терминологии: «топы/Топ» → «участники/Участник» во всех пользовательских строках онбординга; вопрос a3_3 (decision maker) и всё связанное с ним (handler, клавиатура, поле `decisionMaker` в схеме) полностью удалены; добавлен Pino-сериализатор с token redaction в logger.ts.

**Files changed:**
- `src/types.ts` — удалено `decisionMaker` из `ClientProfileSchema`
- `src/f0-profile.ts` — удалён a3_3; переименованы пользовательские строки; «Топы:» → «Участники:» в renderProfileCardLines
- `src/bot.ts` — удалены `profileDmKeyboard`, f0p_dm handler; 7 строк переименовано
- `src/utils/telegram-formatter.ts` — 2 строки «с топами» → «с участниками»
- `src/logger.ts` — добавлен `TOKEN_RE` (module-level) + err serializer с token redaction
- `src/f0-profile.test.ts` — удалены/обновлены a3_3-тесты; total: 16 → 15
- `src/bot.test.ts` — обновлены счётчики, DM-тесты, комментарии
- `src/f0-client-card.test.ts` — удалён `decisionMaker`, обновлены assertions
- `src/f0-client-card.ts` — обновлён stale comment
- `src/logger.test.ts` — NEW: 3 теста token redaction в err serializer

**Review findings:**
- Patches applied: 7 (medium: 2, low: 5)
- Items deferred: 4 (все low)
- Items rejected: 3

**Verification:**
- `npm test` — 801/801 tests passed (38 files)
- `npm run typecheck` — 0 errors

**Residual risks:**
- Старые Telegram inline-клавиатуры с кнопками DM (f0p_dm:N) не получат ответа — тихий ignore, не краш (задокументировано в Design Notes)
- Pino serializer маскирует только `err.message` и `err.stack`; кастомные свойства (err.url) не покрыты

## Review Triage Log

### 2026-07-13 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 7 (medium: 2, low: 5)
- defer: 4 (low: 4)
- reject: 3
- addressed_findings:
  - `medium` `patch` Пользовательская строка «Топы:» в `renderProfileCardLines` пропущена при rename → исправлено на «Участники:»
  - `medium` `patch` Нет теста для logger err serializer (security-critical) → создан `src/logger.test.ts` с 3 тестами
  - `low` `patch` Stale comment «топы/DM» в `f0-profile.ts:33` → обновлён
  - `low` `patch` Stale comment «топы, DM» в `f0-client-card.ts:206` → обновлён
  - `low` `patch` Regex компилировался при каждом вызове serializer → вынесен в module-level `TOKEN_RE`
  - `low` `patch` Test title в `bot.test.ts:2406` содержал «Добавить топов» → обновлён
  - `low` `patch` Stale `total: 16` в `f0-profile.test.ts` (было 2 строки) → исправлено на 15
