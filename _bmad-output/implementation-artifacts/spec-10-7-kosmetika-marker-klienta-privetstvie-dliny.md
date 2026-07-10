---
title: '[10.7] Косметика — маркер клиента, приветствие, длины, мелочи'
type: 'chore'
created: '2026-07-10'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: false
baseline_revision: '7bb90e7532ebc85223507885a3a0d71a8af66549'
final_revision: 'ef56052276deaae95ab22f4d469b39878ae4c078'
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** Активный клиент не виден при входе через `/start`; `/help` дублирует `/start` вместо того чтобы показывать полный мануал; `formatWelcomeMessage` содержит «Скоро:»-блок с нереализованными фичами и избыточный футер; персональные листы Sheets называются полным ФИО вместо имени; `start_client:` callback показывает `✅ Клиент` даже когда карточка содержит 🔴-пункты; при попытке дозаполнить профиль во время активной сессии пользователь получает текстовое предупреждение без кнопки выхода.

**Approach:** Восемь точечных правок без изменения архитектуры: (1) добавить маркер активного клиента в `/start`-ответ; (2) сделать `/help` = полный мануал, `/start` = быстрое меню; (3) вычистить `formatWelcomeMessage` от «Скоро:» и футера; (4) сократить имена листов до первого слова; (5) убрать ✅ из подтверждения выбора клиента; (6) добавить кнопку «Отменить» к предупреждению о залипшей сессии; (7) обновить затронутые тесты.

## Boundaries & Constraints

**Always:**
- `clientId === 'geonline'` fallback и `GEONLINE_F0_SHEET_ID` — не трогать.
- Enforcement rules без исключений: `pino` с `{step, clientId}`, `withRetry` для внешних вызовов.
- Клиентская изоляция: любой доступ к данным только по активному/выбранному клиенту.
- Регресс-guardrail: `npm test && tsc --noEmit && npm run canary` зелёные.

**Block If:**
- Переименование существующих листов `👤 ИМЯ` в Sheets невозможно без миграции данных — при изменении шаблона убедиться, что задача сужена до создания НОВЫХ листов. Если требуется переименование уже существующих — HALT с условием `sheet-rename-requires-migration`.

**Never:**
- Не изменять логику F0 onboarding pipeline (сборка черновика, импорт, вопросник).
- Не переименовывать имеющиеся в реестре `clientId`.
- Не удалять `formatWelcomeMessage` — она остаётся единственным источником полного мануала.
- Не трогать F1-pipeline, F5-pipeline, weekly-report, grounding.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| `/start` без активного клиента | registry ≥ 1 клиент, активный не выбран | `formatShortWelcome` без строки "Активный:" + кнопки клиентов | — |
| `/start` с активным клиентом | активный клиент = geonline | `formatShortWelcome` + строка "Активный: Geonline" + кнопки (без дублирования) | — |
| `/help` | любое состояние | `formatWelcomeMessage` (без «Скоро:» и футера, ≤ 15 строк), без inline-keyboard | — |
| `start_client:geonline` нажата | — | Сообщение «Клиент: {name}.» (без ✅) + inline-keyboard | — |
| `profile_fill:qubiq` при активной сессии | phase = 'filling', сессия не завершена | Предупреждение с кнопкой «❌ Отменить онбординг» | если `cancelF0` не удался — warn-лог, reply не падает |
| «❌ Отменить онбординг» нажата (верная сессия) | session.id совпадает | Сессия удалена, reply «✅ Онбординг отменён.» | — |
| «❌ Отменить онбординг» нажата (протухшая кнопка) | session.id не совпадает | answerCallbackQuery «Эта кнопка устарела.», сессия не трогается | — |
| Новый персональный лист создаётся для «Иван Петров» | `o = 'Иван Петров'` | Лист называется `👤 Иван` | — |
| Однословное имя «Иван» | `o = 'Иван'` | Лист называется `👤 Иван` (без изменений) | — |
| `formatWelcomeMessage` | любой firstName | Текст без «Скоро:» и без строки «Команда /help — ...», ≤ 15 строк | — |

</intent-contract>

## Code Map

- `src/utils/telegram-formatter.ts:301` — `formatWelcomeMessage()`: удалить «Скоро:»-блок (lines 319–322) и футер (line 324)
- `src/utils/telegram-formatter.ts:332` — `formatShortWelcome(firstName?)`: добавить опциональный 2-й параметр `activeClientName?: string`
- `src/bot.ts:1012` — `/start` handler: добавить `getActiveClient` + передать имя в `formatShortWelcome`
- `src/bot.ts:1029` — `/help` handler: сменить на `formatWelcomeMessage(firstName)` без keyboard
- `src/bot.ts:2168` — `start_client:` response: убрать ✅ из заголовка подтверждения
- `src/bot.ts:1501` — `profile_fill:` stuck warning: добавить inline keyboard с `f0_cancel_stuck:{sessionId}`
- `src/bot.ts` — добавить обработчик `f0_cancel_stuck:{sessionId}`: проверить session.id, удалить сессию или ответить «кнопка устарела»
- `src/f0-sheets.ts:515,524,558` — шаблон имён листов `👤 ${o}` → `👤 ${firstWord(o)}`; добавить helper `firstWord(s: string): string` (первое слово через split)
- `src/utils/telegram-formatter.test.ts` — обновить тесты `formatWelcomeMessage` и `formatShortWelcome`
- `src/bot-start-9-3.test.ts` — обновить тест `/start` под новый маркер клиента
- `src/f0-sheets.test.ts` — обновить тест создания листов под `👤 Иван` вместо `👤 Иван Петров`

## Tasks & Acceptance

**Execution:**

- `src/utils/telegram-formatter.ts` — в `formatWelcomeMessage()` удалить строки массива: `''`, `'Скоро:'`, `'🔍 Найти — поиск прошлых отчётов'`, `'📋 Повестка — подготовка к встрече'` (пустая строка перед ними) и `'Команда /help — повторить эту инструкцию.'` (с пустой строкой до неё). Итоговый массив — 9 элементов без «Скоро» и без футера.

- `src/utils/telegram-formatter.ts` — в `formatShortWelcome(firstName?: string)` добавить 2-й параметр `activeClientName?: string`. Если передан: добавить 4-ю строку `Активный клиент: ${activeClientName}` в массив (после 3-й строки «Выбери клиента или онбордируй нового.»).

- `src/bot.ts` — в `/start` handler (line 1012): после загрузки registry добавить `const activeId = await getActiveClient(chatId).catch(() => undefined)` и `const activeName = activeId !== undefined ? ((await getClientName(activeId).catch(() => undefined)) ?? activeId) : undefined`; передать `activeName` вторым аргументом в `formatShortWelcome(firstName, activeName)`.

- `src/bot.ts` — в `/help` handler (line 1029): заменить тело на `const firstName = ctx.from?.first_name?.trim() || undefined; await ctx.reply(formatWelcomeMessage(firstName)).catch((err) => { log.warn({ err, chatId: ctx.chat.id }, 'bot.help.reply_failed'); return; }); log.info({ step: 'bot.help.requested', chatId: ctx.chat.id }, 'help sent');` — без `buildStartMenuKeyboard`, без загрузки registry.

- `src/bot.ts` — в `start_client:` callback (строка около 2168): изменить текст ответа с `✅ Клиент: ${name}.\n📊 /report ...` на `👤 Клиент: ${name}.\n📊 /report <ссылка> — отчёт по встрече\n📋 /status — готовность к неделе` (убрать ✅, оставить emoji 👤).

- `src/bot.ts` — в `profile_fill:` callback, в ветке `if (existing?.phase === 'profile' || f0SessionAtRisk(existing))` (line 1501): заменить простой `ctx.reply(...)` на `ctx.reply('⚠️ Идёт другой онбординг/диалог. Отмени его или продолжи:', { reply_markup: new InlineKeyboard().text('❌ Отменить онбординг', `f0_cancel_stuck:${existing.id}`).text('↩️ Продолжить', 'f0_cancel_stuck_no') }).catch(() => {})`.

- `src/bot.ts` — добавить обработчики для двух новых callback_data:
  1. `bot.callbackQuery(/^f0_cancel_stuck:(.+)$/, async (ctx) => {...})`: получить `chatId`, загрузить текущую сессию `getOrRestoreF0Session(chatId)`. Если `session?.id === ctx.match[1]`: вызвать `deleteF0Session(chatId)`, reply «✅ Онбординг отменён. Новый — /newclient или меню /start.». Иначе: `answerCallbackQuery('Эта кнопка устарела — онбординг уже изменился.')`. В любом случае `answerCallbackQuery().catch(() => {})`.
  2. `bot.callbackQuery('f0_cancel_stuck_no', async (ctx) => { await ctx.answerCallbackQuery().catch(() => {}); })` — просто закрыть без действия.

- `src/f0-sheets.ts` — добавить чистую функцию `function firstWord(s: string): string { return s.split(' ')[0] ?? s; }` (до функции `ensurePersonalSheets`). В трёх местах заменить `👤 ${o}` на `👤 ${firstWord(o)}` (lines 515, 524, 558).

- `src/utils/telegram-formatter.test.ts` — обновить/добавить:
  1. Тест `formatWelcomeMessage`: проверить что результат НЕ содержит «Скоро» и НЕ содержит «/help — повторить»; строк ≤ 15.
  2. Тест `formatShortWelcome` без `activeClientName`: поведение без изменений (3 строки, нет «Активный»).
  3. Тест `formatShortWelcome` с `activeClientName = 'Geonline'`: результат содержит строку «Активный клиент: Geonline».

- `src/f0-sheets.test.ts` — обновить тест создания персональных листов: при owner `'Иван Петров'` ожидать лист `👤 Иван` (не `👤 Иван Петров`).

- `src/bot-start-9-3.test.ts` — обновить тест `/start` с активным клиентом: проверить что reply-текст содержит «Активный клиент:» + имя клиента. Тест `/start` без активного клиента: «Активный клиент:» отсутствует. Обновить тест `/help` (если существует): проверить что ответ содержит «Основное:» и НЕ содержит `reply_markup`; если тест ожидал `buildStartMenuKeyboard` — убрать это ожидание.

**Acceptance Criteria:**

- Given пользователь с активным клиентом «Geonline» вызывает `/start`, when бот отвечает, then первое сообщение содержит «Активный клиент: Geonline».

- Given пользователь вызывает `/help`, when бот отвечает, then ответ содержит «Основное:» и «В онбординге:», НЕ содержит «Скоро:» и «Команда /help — повторить», reply_markup отсутствует (нет inline keyboard).

- Given `formatWelcomeMessage()` вызвана, when результат проверяется, then строк не более 15 (включая пустые) и текст не содержит «Скоро» ни в каком регистре.

- Given пользователь нажимает кнопку клиента в `/start`-меню, when бот подтверждает выбор, then первая строка ответа начинается с «👤 Клиент:» (без ✅).

- Given пользователь нажимает «➕ Дозаполнить профиль» при наличии залипшей сессии, when бот отвечает, then сообщение содержит inline-кнопку «❌ Отменить онбординг».

- Given пользователь нажимает «❌ Отменить онбординг» с актуальным session.id, when обработчик отрабатывает, then `deleteF0Session` вызывается, ответ содержит «Онбординг отменён».

- Given пользователь нажимает «❌ Отменить онбординг» с устаревшим session.id (другая сессия), when обработчик отрабатывает, then сессия не удаляется, `answerCallbackQuery` получает текст «устарела».

- Given F0 создаёт персональный лист для участника с именем «Иван Петров», when лист создаётся, then его название = `👤 Иван` (только первое слово).

- Given `npm test && tsc --noEmit && npm run canary` после слияния, then зелёные (canary pre-existing failure идентична baseline).

## Spec Change Log

## Review Triage Log

**Review pass 1 — 2026-07-10 (4-layer parallel: Blind Hunter, Edge Case Hunter, Verification Gap, Intent Alignment)**

| # | Finding | Severity | Route | Action |
|---|---------|----------|-------|--------|
| R1 | `answerCallbackQuery` вызывается ПОСЛЕ `deleteF0Session` в `f0_cancel_stuck` — нарушает established bot pattern (spinner на стороне Telegram зависает до I/O) | Medium | **PATCH** | Переставлено до `f0Sessions.delete` + `deleteF0Session` |
| R2 | `activeClientName.length > 0` не отсекает whitespace-only строки — `"   "` рендерится как пустая строка-клиент | Low | **PATCH** | Заменено на `.trim().length > 0` |
| R3 | `ctx.chat.id` в `/start` handler вне `try` — теоретически падает до catch при `null` chat | Low | **PATCH** | Заменено на `ctx.chat?.id` + early return guard |
| R4 | Нет теста идемпотентности `firstWord` при повторном прогоне когда `👤 Иван` уже существует | Low | **PATCH** | Добавлен тест в `f0-sheets.test.ts` |
| D1 | `firstWord` коллизия двух владельцев с одинаковым первым словом → объединённый лист | Low-Med | **DEFER** | `deferred-work.md` (10.7) |
| D2 | Неразрывный пробел `\u00A0` в имени не разбивается `split(' ')` — pre-existing | Low | **DEFER** | `deferred-work.md` (10.7) |
| D3 | `f0_cancel_stuck_no` не имеет теста (тривиальный stub) | Low | **DEFER** | `deferred-work.md` (10.7) |
| X1 | Intent alignment: stuck-session flow «не в 10.7 scope» — FR118 явно упоминает «залипший онбординг-стейт» | — | **REJECT** | Полностью в scope |
| X2 | `/help` теряет keyboard — намеренно per spec («без inline keyboard») | — | **REJECT** | По дизайну |
| X3 | `firstWord('')` возвращает `''` — практически невозможно (участники всегда имеют имя) | — | **REJECT** | Non-issue на практике |
| X4 | `getClientName` fallback на сырой `activeId` — приемлемая деградация | — | **REJECT** | По дизайну |
| X5 | `👤` emoji в имени листа — косметика без практического влияния | — | **REJECT** | Не баг |

**Результат:** 4 PATCH применены, 3 DEFER задокументированы, 5 REJECT. Тесты: 729 pass. tsc: 0 ошибок. Canary: pre-existing `claude_api` failure = baseline (нет API-ключа в dev).

## Design Notes

**`firstWord` logic:** `s.split(' ')[0] ?? s` — безопасен для пустой строки (возвращает пустую), не ломает `'Иван'` (один токен). Проверка `titleToId.has('👤 Иван')` на строке 515 автоматически правильная, т.к. и поиск и создание используют один и тот же `firstWord(o)`.

**`getActiveClient` в `/start`:** вызов `getActiveClient` + `getClientName` добавляет 1-2 async-операции в популярный хендлер. Оба читают файловый кэш/in-memory — накладные расходы пренебрежимые; ошибки мягко поглощаются `.catch(() => undefined)`.

**Не переименовываем уже существующие листы:** `ensurePersonalSheets` создаёт листы только если они НЕ существуют (строка 515: `!titleToId.has('👤 ${o}')`). После изменения на `firstWord(o)` новые листы будут `👤 Иван`, старые `👤 Иван Петров` останутся нетронутыми. Это безопасно — нет разрыва данных.

**`f0_cancel_stuck` vs `f0_new_yes`:** аналогичный паттерн с session.id для защиты от протухших кнопок. `f0_cancel_stuck_no` — stub без действия (только `answerCallbackQuery`), чтобы кнопка «Продолжить» не давала ошибку «no handlers».

## Auto Run Result

Status: done
Final revision: ef56052276deaae95ab22f4d469b39878ae4c078
Follow-up review recommended: false

Tests: 729 passed (729). tsc: 0 errors. Canary: pre-existing `claude_api` error identical to baseline (no API key in dev environment).

Changes vs baseline (7bb90e7):
- `src/utils/telegram-formatter.ts`: `formatWelcomeMessage` — удалены «Скоро:» блок и футер (→ 9 строк); `formatShortWelcome` — добавлен param `activeClientName?` с trim-guard
- `src/bot.ts`: `/start` — добавлен `getActiveClient`+`getClientName`, передаётся в `formatShortWelcome`; `/help` — переключён на `formatWelcomeMessage` без keyboard; `profile_fill:` stuck warning — добавлен InlineKeyboard с `f0_cancel_stuck:{id}`; `start_client:` — убран ✅; добавлены обработчики `f0_cancel_stuck:` и `f0_cancel_stuck_no`
- `src/f0-sheets.ts`: добавлен `firstWord()` helper; 3 точки создания листов: `👤 ${o}` → `👤 ${firstWord(o)}`
- Тесты: обновлены в `telegram-formatter.test.ts`, `bot-start-9-3.test.ts`, `f0-sheets.test.ts`; добавлены 3 новых теста в `bot.test.ts` (матрица строки 5-7)
- Review patches: `answerCallbackQuery` order fix, whitespace trim guard, `ctx.chat?.id` safety, idempotency test for `firstWord`

## Verification

**Commands:**
- `npm test` -- expected: все тесты зелёные (включая обновлённые в `telegram-formatter.test.ts`, `bot-start-9-3.test.ts`, `f0-sheets.test.ts`)
- `tsc --noEmit` -- expected: no type errors
- `npm run canary` -- expected: зелёный или pre-existing failure идентична baseline
