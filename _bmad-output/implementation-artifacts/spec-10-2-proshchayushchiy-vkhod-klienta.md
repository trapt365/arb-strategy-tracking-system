---
title: '[10.2] Прощающий вход клиента; тяжёлый профиль → /advanced'
type: 'feature'
created: '2026-07-10'
status: 'in-review'
baseline_revision: '5e18b65'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** Онбординг нового клиента требует 4 обязательных вопроса (название, суть, топы A3.2, decision-maker A3.3) — пилот показал, что топы/DM отпугивают: «неудобно, убрать decision-maker». Из-за этого онбординг воспринимается как допрос, а не как «пришли, что есть».

**Approach:** Сузить 🔑-минимум до 2 вопросов — только A1.1 (название) и A1.2 (суть); перенести A3.2 (топы) и A3.3 (DM) в начало расширенного блока. Добавить команду `/advanced`, которая запускает расширенный профиль: из онбординга — немедленно, вне онбординга — как дозаполнение карточки активного клиента.

## Boundaries & Constraints

**Always:**
- `PROFILE_MIN_COUNT` и `PROFILE_EXT_COUNT` — производные (`PROFILE_MIN_QUESTIONS.length`), не трогать вычисление; обновятся автоматически.
- A3.2 в `PROFILE_EXT_QUESTIONS` ВСЕГДА перед A3.3: `profileDmKeyboard` строит список из `session.profile.tops`, которые заполняются только в A3.2.
- `/advanced` — только в `trackerChatIds`; иначе ранний return (паттерн всех handlers).
- `f0p_ext` callback и `profile_fill:{clientId}` callback остаются без изменений — `/advanced` использует ту же логику, но не обязан вызывать те же обработчики напрямую.
- Все поля `ClientProfileSchema` уже optional — схема не меняется.
- canary + vitest + tsc зелёные после коммита.

**Block If:**
- В `PROFILE_EXT_QUESTIONS` обнаружится жёсткая ссылка на индекс (не на `q.id`) для A3.2 или A3.3 — смещение индекса сломает логику; HALT и уточнить.

**Never:**
- Не удалять код диалога профиля 9.1 (функции, вопросы, callbacks).
- Не трогать `ClientProfileSchema`, `ClientCardSchema`, `ClientCard`.
- Не менять `getProfileSessionForCallback` — ищет по `q.id`, не по индексу.
- Не менять `profile_fill:{clientId}` callback.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Happy path: новый клиент | `/newclient` → A1.1 → A1.2 → `f0p_go` | После 2 вопросов — offer screen «Название и суть зафиксированы»; «Дальше» → экран «Как заводим стратегию?» | — |
| С расширением через предложение | `/newclient` → A1.1 → A1.2 → `f0p_ext` | Offer → «➕ Добавить топов» → A3.2 (1/16) → A3.3 (2/16) → … | — |
| `/advanced` в онбординге (offer pending) | `/newclient` → A1.1 → A1.2 → `/advanced` | Начинает расширенный профиль (A3.2, 1/16); эквивалент `f0p_ext` | — |
| `/advanced` без онбординга, active client | Нет сессии, `getActiveClient` → clientId | Дозаполнение карточки активного клиента: A3.2 первым (≡ `profile_fill`) | Карточка не найдена → ℹ️ + /newclient |
| `/advanced` без онбординга, нет клиента | Нет сессии, нет active client | ℹ️ «Выбери клиента через /start или начни через /newclient» | — |
| `/advanced` во время другого этапа | Сессия в phase `filling`/`collecting`/etc. | ⚠️ «Заверши онбординг (/confirm) или отмени (/cancel)» | — |
| Старая сессия с полным профилем | Карточка с tops/DM уже заполнена | Совместима без миграции; grounding работает без изменений | — |
| `/skip` на A1.1 или A1.2 | key=true, qIndex<2 | «Обязательный минимум» + повтор вопроса (поведение не меняется) | — |

</intent-contract>

## Code Map

- `src/f0-profile.ts:34` — `PROFILE_MIN_QUESTIONS`: удалить a3_2 и a3_3 (минимум → [a1_1, a1_2])
- `src/f0-profile.ts:70` — `PROFILE_EXT_QUESTIONS`: вставить a3_2 и a3_3 на позиции [0],[1] перед a1_3; `PROFILE_EXT_COUNT` авто→16
- `src/bot.ts:1094` — `f0ProfileOfferKeyboard`: метка "➕ Расширенный профиль" → "➕ Добавить топов"
- `src/bot.ts:1138` — `sendProfileOffer`: обновить текст (новый минимум = 2 вопроса)
- `src/bot.ts:3144` — `/resume` handler: добавить `/advanced` после него (~3168)
- `src/bot.ts:4372` — `setMyCommands`: добавить `{ command: 'advanced', description: 'Добавить топов и расширенный профиль клиента' }`
- `src/bot.test.ts:2316` — `describe('bot — профиль клиента ... Story 9.1')`: обновить 5 тестов + добавить describe для /advanced (3 теста)

## Tasks & Acceptance

**Execution:**

- `src/f0-profile.ts` — удалить a3_2 и a3_3 из `PROFILE_MIN_QUESTIONS`; вставить те же объекты (без изменения полей) в начало `PROFILE_EXT_QUESTIONS` (позиции [0] и [1], перед a1_3); обновить комментарий к `PROFILE_MIN_QUESTIONS` на «🔑-минимум: только название + суть; топы/DM — в начале расширенного»

- `src/bot.ts` — в `f0ProfileOfferKeyboard` изменить метку первой кнопки с `'➕ Расширенный профиль'` на `'➕ Добавить топов'`; в `sendProfileOffer` изменить текст на `'✅ Название и суть зафиксированы. Добавить топов и детали сейчас — или сразу к стратегии?'` (callback-data кнопок `f0p_ext` / `f0p_go` не меняются)

- `src/bot.ts` — добавить `bot.command('advanced', async (ctx) => { ... })` после `/resume` handler (~line 3168): (1) guard `trackerChatIds`; (2) если есть активная F0-сессия: если phase `'profile'` — если `profileOfferPending(session)` → перейти к extended (set `session.profileExtended = true`, save, `askNextProfileQuestion`); если уже extended — `ctx.reply('Профиль уже дополняется...')` + `askNextProfileQuestion`; иначе → `ctx.reply('Сначала заверши минимум...')` + `askNextProfileQuestion`; если другой phase → ⚠️ guard-сообщение и return; (3) если нет сессии: `getActiveClient(chatId)` → если есть clientId → дозаполнение как `profile_fill:{clientId}` (load card, create session с `profileQIndex: PROFILE_MIN_COUNT, profileExtended: true, profileCardClientId: clientId`, save, reply, `askNextProfileQuestion`); иначе → ℹ️ explain + return

- `src/bot.ts` — в `setMyCommands` добавить `{ command: 'advanced', description: 'Добавить топов и расширенный профиль клиента' }` (после `'newclient'`)

- `src/bot.test.ts` — обновить `describe('bot — профиль клиента: обязательный первый шаг (Story 9.1)')`: (a) тест AC1 `/newclient начинает с A1.1`: `(1/4)` → `(1/2)`; (b) тест «после A3.3 — offer screen»: переписать — A3.3 теперь в расширенном; offer появляется после A1.2 (вместо A3.3); после `f0p_go` → стратегия — тест-сценарий сокращается до 2 text-ответов; (c) тест AC2 restart: `(3/4)` → проверить offer-screen после A1.2; (d) тест «расширенный /skip»: setup упрощается — A1.1 + A1.2 + f0p_ext → первый ext вопрос A3.2 (1/16); прогрессия меняется; (e) тест «числовые A2»: аналогично — обновить setup и прогрессию (skip через a3_2, a3_3 перед числами)

- `src/bot.test.ts` — добавить `describe('bot — Story 10.2: /advanced команда', ...)` (после describe 9.1) с 3 тестами: (a) `/advanced` в онбординге (после A1.1 + A1.2, offer pending) → начинает A3.2 как первый расширенный вопрос (1/16); (b) `/advanced` без онбординга, active client = 'geonline' → дозаполнение профиля карточки (reply содержит «Дозаполняем»); (c) `/advanced` без онбординга, без active client → reply содержит «/start» или «/newclient»

**Acceptance Criteria:**

- Given `/newclient` запущен и трекер ввёл название + суть, when оба ответа получены, then бот показывает offer-screen с кнопками «Добавить топов» (f0p_ext) и «Дальше» (f0p_go); «Дальше» ведёт к «Как заводим стратегию?»; `npm test` зелёный

- Given трекер хочет расширенный профиль, when `/advanced` или кнопка «Добавить топов», then первый вопрос расширенного блока = A3.2 (топы) с прогрессом (1/16); A3.3 (DM) идёт следующим (2/16)

- Given активный клиент geonline, нет открытого онбординга, when `/advanced`, then бот начинает дозаполнение карточки geonline с A3.2 (прогресс 1/16); данные пишутся в card.json как при `profile_fill`

- Given существующие карточки с полным профилем (tops + DM заполнены) и регресс-тест Geonline, when 10.2 внедрён, then `npm test` + `tsc --noEmit` + `npm run canary` зелёные; старые карточки загружаются без изменений

## Spec Change Log

## Review Triage Log

### 2026-07-10 — Review pass (iteration 0, 4 reviewers: Blind Hunter · Edge Case Hunter · Verification Gap · Intent Alignment)

- intent_gap: 0
- bad_spec: 0
- patch: 1: (medium 1)
- defer: 3: (low 3)
- reject: 10
- addressed_findings:
  - `[medium]` `[patch]` Two branches of `/advanced` in `phase='profile'` had no tests: (ii) `profileExtended===true` → "уже дополняется" branch, and (iii) minimum not yet complete → "заверши минимум" branch. Added tests (e) and (f) to `describe('bot — Story 10.2: /advanced команда')`. 683/683 tests pass after.

## Design Notes

**Порядок a3_2 и a3_3 в PROFILE_EXT_QUESTIONS — критичен.** `profileDmKeyboard` строит список кнопок из `session.profile.tops`. Если a3_3 встречается раньше a3_2, `tops` ещё пуст → клавиатура DM не показывается, пользователь вынужден вводить DM текстом без выбора. Порядок [a3_2, a3_3] обязателен.

**`/advanced` без абстракции-дубля.** Логика дозаполнения карточки в `/advanced` (нет сессии, active client) — то же, что в `profile_fill:{clientId}` callback. Не нужно выносить в хелпер — достаточно inline-повторения той же последовательности (~10 строк). Когда появится третий вызывающий — тогда рефакторить.

**Тесты: счёт расширенных вопросов.** До 10.2 расширенный блок = 14 вопросов (`PROFILE_EXT_COUNT=14`). После: 16 (a3_2 + a3_3 добавляются в ext). Тесты с `(1/14)`, `(2/14)` и т.д. нужно обновить на `(1/16)`, `(2/16)`. Счётчик skip-шагов в тестах числовых вопросов меняется: A2.1 теперь на позиции ext[4] (после a3_2, a3_3, a1_3, a1_4) → при пропуске a3_2 + a3_3 нужны 2 дополнительных /skip перед A1.3/A1.4.

## Verification

**Commands:**
- `npm test` -- expected: все тесты зелёные (включая обновлённые Story 9.1 + новые 10.2)
- `tsc --noEmit` -- expected: no type errors
- `npm run canary` -- expected: canary green (Geonline F1 не затронут)
