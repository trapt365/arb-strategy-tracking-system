---
title: 'Story 9.3: [CR-2] Стартовый flow действующего трекера'
type: 'feature'
created: '2026-07-09'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '3c309fb450af73f29b68d3ed472f5579c7651d1b'
final_revision: '76f1c637add4a805b9e0189c351d8ed766a8d6cb'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** Действующий трекер с клиентами в реестре делает 2 лишних клика до работы: `/start` → «Клиенты» → выбор → «Работать с клиентом». Приветствие — 17-строчная инструкция. `/help` та же простыня без клавиатуры. `/report` без URL и произвольный текст при активном клиенте возвращают generic подсказки без упоминания, кто сейчас активен.

**Approach:** `/start` и `/help` загружают реестр и показывают идентичное меню: короткое приветствие (3–5 строк) + кнопки клиентов прямо в `/start` + «Онбординг нового клиента» + «Что умеет бот». Нажатие кнопки клиента немедленно устанавливает активного клиента и показывает меню действий (отчёт / статус / таблица). Полная справка остаётся за «Что умеет бот». `/report` без URL и произвольный текст при активном клиенте показывают контекстную подсказку с именем клиента.

## Boundaries & Constraints

**Always:**
- `/start` и `/help` показывают кнопки клиентов только из `Object.keys(registry)` (только реально зарегистрированные); geonline-fallback остаётся в `menu:clients` и НЕ добавляется в `/start` menu.
- Пустой реестр (`Object.keys(registry).length === 0`) → прежние 3 кнопки buildMainMenuKeyboard (Что умеет бот / Онбординг / Клиенты).
- Полная справка `formatWelcomeMessage` остаётся без изменений — показывается через `menu:help` («Что умеет бот»).
- Кнопки «🆕 Онбординг нового клиента» и «ℹ️ Что умеет бот» сохраняются во всех вариантах клавиатуры.
- `client:{id}` и `client_use:{id}` callbacks не удалять — используются из `menu:clients`.
- canary + vitest + tsc зелёные после изменений.

**Block If:**
- Нужно менять F0_START_TEXT, экраны /confirm или дозаполнения — это 9.4/9.6.

**Never:**
- Добавлять «📅 Недельный отчёт» в меню действий клиента — это 9.7.
- Переименовывать DEFAULT_CLIENT_ID / clientId geonline.
- Убирать существующие `client:{id}` / `client_use:{id}` callback handlers.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `/start`/`/help` с клиентами в реестре | registry={qubiq:{name:'Qubiq',...}} | Текст ≤5 строк + кнопка «Qubiq» callback `start_client:qubiq` + «Онбординг» + «Что умеет бот»; полная справка НЕ в тексте | — |
| `/start`/`/help` пустой реестр | registry={} (0 записей) | Прежние 3 кнопки (buildMainMenuKeyboard); geonline-fallback НЕ показывается в start-меню | — |
| `start_client:{id}` нажата | clientId='qubiq', sheetId='abc' | setActiveClient вызван; ответ: имя клиента + /report подсказка + /status подсказка + кнопка «📁 Таблица» URL на sheetId | — |
| `/report` без URL, active client установлен | urlArg='', active='qubiq' name='Qubiq' | Ответ содержит «Qubiq» и «/report https://»; НЕ generic `formatErrorMessage('missing_arg')` | — |
| `/report` без URL, нет active | urlArg='', active=undefined | Прежнее `formatErrorMessage('missing_arg')` | — |
| `/report` с невалидным URL, active установлен | urlArg='bad', active='qubiq' | Прежнее `formatErrorMessage('invalid_url')` (контекстная подсказка только для missing_arg) | — |
| Произвольный текст, active client установлен | free text, active='qubiq' name='Qubiq' | Ответ содержит «Qubiq» и /report; НЕ generic `formatHelpHint()` | — |
| Произвольный текст, нет active | free text, active=undefined | Прежнее `formatHelpHint()` | — |

</intent-contract>

## Code Map

- `src/utils/telegram-formatter.ts:301–326` — `formatWelcomeMessage` (полная справка, без изменений); добавить `formatShortWelcome(firstName?)`
- `src/bot.ts:906–913` — `buildMainMenuKeyboard()` → переименовать в `buildStartMenuKeyboard(clients: {id:string;name:string}[])`; вызовы обновить
- `src/bot.ts:915–940` — `/start` и `/help` handlers: `await loadRegistry()` + buildStartMenuKeyboard + formatShortWelcome
- `src/bot.ts:1651–1660` — `menu:help` callback: без изменений (formatWelcomeMessage)
- `src/bot.ts:1662+` — добавить `bot.callbackQuery(/^start_client:(.+)$/, ...)` между `menu:clients` и `client:` handlers
- `src/bot.ts:2826–2831` — `/report` missing URL branch: checkActiveClient → contextual hint; else → formatErrorMessage
- `src/bot.ts:3266–3273` — text fallback: checkActiveClient → contextual hint; else → formatHelpHint
- `src/client-registry.ts:28,67,134,143` — `loadRegistry`, `getClientSheetId`, `getActiveClient`, `setActiveClient` — читаются без изменений

## Tasks & Acceptance

**Execution:**
- `src/utils/telegram-formatter.ts` — добавить `export function formatShortWelcome(firstName?: string): string` — 3 строки: `«👋 {Привет, firstName! / Привет!} Я — AI-трекинг бот практики.\nВеду онбординг стратегий и отчёты по встречам с топами.\nВыбери клиента ниже или онбордируй нового.»`
- `src/bot.ts` — переименовать `buildMainMenuKeyboard()` → `buildStartMenuKeyboard(clients: {id:string;name:string}[])`: если `clients.length > 0` — для каждого client добавить `.text(client.name, \`start_client:\${client.id}\`).row()`, затем `.text('🆕 Онбординг нового клиента','menu:new').row().text('ℹ️ Что умеет бот','menu:help')`; если `clients.length === 0` — прежние 3 кнопки (Что умеет бот / Онбординг / Клиенты); в `/start` и `/help` handlers: `const registry = await loadRegistry(); const clients = Object.keys(registry).map(id => ({id, name: registry[id]!.name})); ctx.reply(formatShortWelcome(firstName), {reply_markup: buildStartMenuKeyboard(clients)})`
- `src/bot.ts` — добавить callback `bot.callbackQuery(/^start_client:(.+)$/, async ctx => {})`: `await ctx.answerCallbackQuery().catch(()=>{})`; `setActiveClient(chatId, clientId)`; `name = await getClientName(clientId) ?? clientId`; `sheetId = await getClientSheetId(clientId)`; `card = await loadClientCard(clientId)`; reply «✅ Клиент: {name}.\n📊 /report \<ссылка\> — отчёт по встрече\n📋 /status — готовность к неделе» + InlineKeyboard `.url('📁 Таблица', \`https://docs.google.com/spreadsheets/d/\${sheetId}\`)` + если `card !== null`: `.row().text('➕ Дозаполнить профиль', \`profile_fill:\${clientId}\`)`; лог `{step:'bot.start_client.selected', chatId, clientId}`
- `src/bot.ts:2826–2831` — изменить ветку `reason === 'missing_arg'` ТОЛЬКО: если `active !== undefined` → контекстная подсказка с именем; иначе → `formatErrorMessage('missing_arg')`; для `invalid_url` и `unsupported_provider` оставить `formatErrorMessage(reason)` без изменений
- `src/bot.ts:3266–3273` — изменить text fallback: `const active = await getActiveClient(chatId); if (active !== undefined) { const name = (await getClientName(active)) ?? active; await ctx.reply(\`Активный клиент: \${name}. /report \<ссылка\> для отчёта · /help для меню.\`).catch(()=>{}); } else { await ctx.reply(formatHelpHint()); }`
- `src/bot.test.ts` — обновить существующий describe «bot — onboarding /start (Story 1.8)»: в AC#1 убрать `toContain('/report')`, `.toContain('/help')`, `.toContain('🔍 Найти')`, `.toContain('📋 Повестка')`, `.toContain('/status')`, `.toContain('/newclient')` — эти строки теперь в formatShortWelcome отсутствуют (полная справка переехала за «Что умеет бот»); оставить `toContain('Привет, Азиза!')` и `toContain('AI-трекинг бот')`; в AC#2 аналогично убрать проверку `toContain('/report')` и `toContain('/help')` из текста; AC#3–AC#6 не трогать
- `src/bot-start-9-3.test.ts` (новый файл) — `vi.mock('./client-registry.js', ...)` на уровне модуля (не в describe, чтобы vitest hoisting работал корректно); `vi.mocked` в beforeEach сбрасывает и конфигурирует моки; тесты: (1) /start с {qubiq} → текст ≤5 строк + в inline_keyboard_markup есть callback_data `start_client:qubiq` + `menu:new` + `menu:help`; (2) /start пустой клиентский список → в keyboard есть `menu:clients` (3-button fallback); (3) /help с {qubiq} → та же структура keyboard что /start (client button + menu:new + menu:help); (4) callback `start_client:qubiq` → setActiveClient вызван с правильным clientId + ответ содержит «Qubiq»; (5) /report без URL, getActiveClient='qubiq' → ответ содержит «Qubiq» и «/report https://»; (6) свободный текст, getActiveClient='qubiq' → ответ содержит «Qubiq» и «/report»

**Acceptance Criteria:**
- Given реестр содержит клиента 'qubiq' (name='Qubiq'), when пользователь отправляет `/start`, then ответ: текст не длиннее 5 строк, клавиатура содержит кнопку с callback `start_client:qubiq`, кнопки «Онбординг» и «Что умеет бот»; текст НЕ содержит `/newclient` или `/draft`
- Given активный клиент 'qubiq' (name='Qubiq') установлен через `getActiveClient`, when `/report` без аргументов, then ответ содержит «Qubiq» и «/report https://» и НЕ равен строке `formatErrorMessage('missing_arg')`
- Given активный клиент 'qubiq' (name='Qubiq') установлен через `getActiveClient`, when произвольный текст (не команда, нет активного онбординга), then ответ содержит «Qubiq» и «/report» и НЕ равен строке `formatHelpHint()`

## Spec Change Log

## Review Triage Log

### 2026-07-09 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 4, low 1)
- defer: 4: (high 0, medium 2, low 2)
- reject: N (noise, pre-existing, already-handled findings)
- addressed_findings:
  - `[medium]` `[patch]` `formatShortWelcome` text «ниже или онбордируй нового» некорректно при пустом реестре (нет кнопок клиентов) — убрано «ниже» (`telegram-formatter.ts`)
  - `[medium]` `[patch]` `loadRegistry()` вызывался до `try` в `/start` и `/help` — перемещён внутрь try; `registry[id]!.name` → `registry[id]?.name ?? id` (non-null assert fix)
  - `[medium]` `[patch]` Молчащий `.catch(() => {})` в text-fallback ветке active client — добавлен `log.warn({err, chatId}, 'bot.fallback.active.reply_failed')`
  - `[medium]` `[patch]` I/O matrix строка 8 (invalid_url + active client → generic error) не покрыта тестом — добавлен тест (7) в `bot-start-9-3.test.ts`
  - `[low]` `[patch]` `formatShortWelcome` не имеет юнит-тестов в `telegram-formatter.test.ts` — добавлено 5 тестов (имя, без имени, пустое, ≤3 строк, plain text)

## Design Notes

- **`start_client:{id}` vs `client:{id}`**: отдельный callback позволяет нажатию из `/start` идти напрямую к активации без показа client card (двухступенчатый flow `client:` → `client_use:` сохраняется для `menu:clients`).
- **vi.mock в отдельном файле**: vitest hoisting поднимает `vi.mock` на уровень модуля, а не describe — поэтому 9.3-специфичные тесты вынесены в `bot-start-9-3.test.ts`, чтобы не затронуть существующие 621 тест в `bot.test.ts`.
- **geonline НЕ в `/start` menu**: «клиенты из реестра» означает только формально зарегистрированных через onboarding; geonline-fallback остаётся только в `menu:clients` (без изменений).

## Verification

**Commands:**
- `npx tsc --noEmit` — expected: без ошибок
- `npm test` — expected: весь vitest зелёный (621 тест + новые 9.3)
- `npm run canary -- --no-claude` — expected: PASS; geonline-guardrail не тронут

## Auto Run Result

**Status:** done

**Summary:** Реализован стартовый flow действующего трекера: `/start` и `/help` загружают реестр и показывают короткое меню (3 строки) с кнопками клиентов прямо в приветствии. Нажатие `start_client:{id}` немедленно активирует клиента. `/report` без URL и свободный текст при активном клиенте возвращают контекстную подсказку с именем клиента.

**Files changed:**
- `src/utils/telegram-formatter.ts` — добавлена `formatShortWelcome(firstName?)`
- `src/bot.ts` — `buildMainMenuKeyboard` → `buildStartMenuKeyboard(clients)`; обновлены `/start`, `/help`; добавлен `start_client:{id}` callback; обновлена ветка missing_arg `/report`; обновлен text fallback
- `src/bot.test.ts` — обновлены AC#1/AC#2 Story 1.8, W1 Story 8.4 под новый short welcome
- `src/bot-start-9-3.test.ts` (новый) — 7 тестов с vi.hoisted module-level мок
- `src/utils/telegram-formatter.test.ts` — +5 тестов `formatShortWelcome`
- `_bmad-output/implementation-artifacts/deferred-work.md` — 4 deferred items

**Review findings:** patch 5 (medium ×4 — text fix, try-scope, non-null assert, silent catch, matrix coverage; low ×1 — formatShortWelcome unit tests), defer 4 (start_client integration test, /start+/help dedup, buildStartMenuKeyboard direct test, context hint UX polish), reject: прочие (шум, pre-existing).

**Verification:** tsc clean · 633 vitest passed (621 base + 7 new 9.3 + 5 new formatter) · canary PASS (geonline-guardrail intact)

**Residual risks:**
- `start_client:{id}` wiring not integration-tested at bot.test.ts level (deferred); all 7 9.3-specific tests cover the logic.
- `/start` and `/help` duplicate ~15 LOC each — drift risk if handlers diverge (deferred).
