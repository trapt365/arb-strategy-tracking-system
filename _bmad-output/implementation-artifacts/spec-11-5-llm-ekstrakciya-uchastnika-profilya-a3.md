---
title: 'LLM-экстракция участника профиля (A3.2) вместо строгого формат-ретрая'
type: 'feature'
created: '2026-07-13'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '0119495e8ea5e5f52f37ebb907e3e61a8aa4102e'
final_revision: '7188a97d45cef78f6b45d31e9737b2ba8a1e1c70'
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** Шаг A3.2 онбординга парсит участника через `parseTopAnswer` — жёсткое regex по формату «Имя — должность, полномочия, зона: …». При несовпадении бот отправляет одно предупреждение, затем сохраняет только имя (остальные поля null). Пользователь вынужден соблюдать формат или теряет структурированные данные.

**Approach:** Заменить `parseTopAnswer` + retry-логику в обработчике A3.2 (`bot.ts:1346–1384`) на единственный вызов `callClaudeSafe` с новым промптом `prompts/extract-top.md`. LLM извлекает `{name, title, authority, area}` из свободной фразы. При ошибке LLM-экстракции — fallback на `topFromRawAnswer` (имя = весь ответ). `parseTopAnswer` становится неиспользуемой — удалить.

## Boundaries & Constraints

**Always:**
- Инъекция `extractTopWithLlm?: (phrase: string) => Promise<ClientTop>` в `BotDeps` — продакшн-реализация в `bot.ts`, тесты подменяют.
- Fallback `topFromRawAnswer(phrase)` при `result.parsed === null` или броске LLM (try/catch).
- `profileRetryQIndex` очищается (`= undefined`) при сохранении топа, как сейчас (строчная совместимость: поле используется числовыми вопросами A2.x).
- `npm test` и `npm run typecheck` зелёные после изменений.

**Block If:** нет.

**Never:**
- Не добавлять промежуточные сообщения о прогрессе для LLM-вызова (он короткий, <5 с).
- Не менять `topFromRawAnswer`, `renderTopShort`, логику кнопок DM/tops (только retry-ветку заменить).
- Не обновлять question.text и example в `f0-profile.ts` (A3.2 — вне scope).
- Не трогать `profileRetryQIndex` для числовых вопросов (A2.x) — только A3.2 handler меняется.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Свободная фраза, LLM вернул все поля | `'Дамир, коммерческий директор, P&L продаж, выручка'` | `✅ Топ добавлен: Дамир (коммерческий директор)`, `profile.tops` += полный ClientTop | — |
| Старый формат (LLM справится) | `'Айгерим — CEO, все решения, зона: всё'` | `✅ Топ добавлен: Айгерим (CEO)` | — |
| LLM вернул null (parsed = null) | Любая фраза, `callClaudeSafe` → `parsed: null` | fallback: `topFromRawAnswer(phrase)`, `✅ Топ добавлен: <полная фраза>` | silent |
| LLM бросил ошибку (сеть/API) | `callClaudeSafe` throws | fallback: `topFromRawAnswer(phrase)`, `✅ Топ добавлен: <полная фраза>` | try/catch, silent |
| Первая свободная фраза — больше нет retry | `'Просто Дамир'` (первая попытка) | Топ сразу добавлен, **нет** сообщения «Не разобрал» | — |

</intent-contract>

## Code Map

- `src/bot.ts:88–89` — импорт `parseTopAnswer, topFromRawAnswer` из `f0-profile.js`; удалить `parseTopAnswer`
- `src/bot.ts:113` — `import { classifyClaudeApiError } from './adapters/claude.js'`; добавить `callClaudeSafe`
- `src/bot.ts:163–196` — `BotDeps`; добавить `extractTopWithLlm?`
- `src/bot.ts:227` — после `const f0Log = ...`; разместить default `extractTopWithLlm` реализацию
- `src/bot.ts:1109` — `const F0_PROFILE_TOP_FORMAT_HINT`; удалить константу (станет неиспользуемой)
- `src/bot.ts:1346–1384` — A3.2 retry-блок (`if (q.type === 'tops')`); полная замена
- `src/bot.ts:1420, 1430` — usage `F0_PROFILE_TOP_FORMAT_HINT`; заменить текст напрямую
- `src/bot.test.ts:265–283` — `BuildOpts`; добавить `extractTopWithLlm?`
- `src/bot.test.ts:285–321` — `buildBot`; добавить default mock `extractTopWithLlm`
- `src/bot.test.ts:2405–2422` — тест retry-поведения; переписать под новый flow
- `src/f0-profile.ts:218–247` — функция `parseTopAnswer`; удалить
- `src/f0-profile.test.ts:11` — импорт `parseTopAnswer`; удалить
- `src/f0-profile.test.ts:85–111` — `describe('parseTopAnswer (A3.2)', ...)`; удалить
- `prompts/extract-top.md` — новый файл промпта (создать)
- `src/types.ts:397–403` — `ClientTopSchema`, `ClientTop`; только чтение (не менять)

## Tasks & Acceptance

**Execution:**

- `prompts/extract-top.md` — создать промпт с одной переменной `{{phrase}}`; инструкция: извлечь `name` (обязательно), `title`, `authority`, `area` (null если не упомянуто); формат ответа — JSON; инвариант: не выдумывать значения.

- `src/bot.ts` — (1) добавить `callClaudeSafe` к import из `./adapters/claude.js`; добавить `import { ClientTopSchema } from './types.js'`; добавить `import { loadPrompt as defaultLoadPrompt } from './utils/prompt-loader.js'`; (2) добавить `extractTopWithLlm?: (phrase: string) => Promise<ClientTop>` в `BotDeps` (после `transcribeFromFilePath?`); (3) внутри `createBot` после `const f0Log = ...` определить `const extractTopWithLlm = deps.extractTopWithLlm ?? (async (phrase: string): Promise<ClientTop> => { try { const prompt = await defaultLoadPrompt('extract-top', { phrase }); const result = await callClaudeSafe(prompt, { stepName: 'f0.extract_top', schema: ClientTopSchema, maxTokens: 300, logger: f0Log }); if (result.parsed !== null) return result.parsed; } catch { /* silent */ } return topFromRawAnswer(phrase); })`; (4) удалить `parseTopAnswer` из импорта f0-profile.js (оставить `topFromRawAnswer`); (5) заменить весь блок `if (q.type === 'tops') { ... }` (lines 1346–1384) на: `if (q.type === 'tops') { const top = await extractTopWithLlm(text); profile.tops = [...(profile.tops ?? []), top]; session.profileRetryQIndex = undefined; await saveF0Session(chatId, session); f0Log.info({ step: 'f0.profile_top_added', chatId, sessionId: session.id, tops: profile.tops.length }, 'f0 profile top added'); await ctx.reply(\`✅ Топ добавлен: \${renderTopShort(top)} (всего: \${profile.tops.length}).\`, { reply_markup: f0ProfileTopsKeyboard }).catch(() => {}); return; }`; (6) удалить константу `F0_PROFILE_TOP_FORMAT_HINT` (строка 1109); обновить строку 1420: `'Пришли следующего участника свободной фразой.'`; обновить строку 1430: `'🔑 Нужен хотя бы один участник — напиши имя и должность.'`.

- `src/f0-profile.ts` — удалить JSDoc и функцию `parseTopAnswer` (lines 218–247).

- `src/f0-profile.test.ts` — удалить `parseTopAnswer` из импорта (line 11); удалить `describe('parseTopAnswer (A3.2)', ...)` block (lines 85–111).

- `src/bot.test.ts` — (1) добавить `extractTopWithLlm?: BotDeps['extractTopWithLlm']` в `BuildOpts` (line ~283); (2) добавить в `buildBot`: `extractTopWithLlm: opts.extractTopWithLlm ?? (async (phrase: string) => ({ name: phrase.trim(), title: null, authority: null, area: null }))` (default test mock — без LLM); (3) переписать тест на line 2405: название «топы A3.2: LLM экстракция вызвана, топ сразу добавляется без ретрая (Story 11.5)»; verify: `extractTopWithLlm` вызван с текстом, ответ содержит «Топ добавлен», НЕ содержит «Не разобрал»; (4) добавить в конец файла `describe('bot — Story 11.5: LLM-экстракция участника A3.2', ...)` с тестами: (a) LLM fallback: мок возвращает null-parsed → `topFromRawAnswer` в виде `{name: phrase, title: null, ...}` — топ добавлен; (b) LLM success: мок возвращает полный ClientTop — все поля в profile.tops; (c) регресс: тест из line 3042 (`'Айгерим — CEO, все решения, зона: всё'`) с default mock проходит (топ добавлен, `f0p_dm:0` работает).

**Acceptance Criteria:**

- Given A3.2 активен и пользователь отправляет `'Дамир, директор, отвечает за P&L'`, when `extractTopWithLlm` возвращает `{name:'Дамир', title:'директор', authority:'отвечает за P&L', area:null}`, then бот отвечает `✅ Топ добавлен: Дамир (директор)` без предшествующего «Не разобрал».

- Given A3.2 активен, when `extractTopWithLlm` возвращает `{parsed: null}` для любой фразы, then бот сохраняет `topFromRawAnswer(phrase)` и отвечает `✅ Топ добавлен: <фраза>`.

- Given A3.2 активен, when пользователь отправляет текст впервые (любой), then сообщение `🔁 Не разобрал ответ на поля` **не** отправляется.

- Given `buildBot` в тестах без `extractTopWithLlm`, when тест отправляет любой текст на A3.2, then default mock сохраняет топ с `name = text.trim()` — существующие тесты не ломаются.

## Design Notes

LLM-экстракция работает с `callClaudeSafe` (non-throwing): при невалидном JSON или zod-ошибке `result.parsed === null`, и fallback на `topFromRawAnswer` применяется автоматически. Оба пути дают валидный `ClientTop`, поэтому catch нужен только для сетевых/API-ошибок в `executeClaudeCall`.

`F0_PROFILE_TOP_FORMAT_HINT` удаляется полностью — после удаления retry-блока она используется только в двух inline-строках, замена прямая.

Default mock в `buildBot` (тесты) возвращает `topFromRawAnswer`-образный объект: сохраняет name = phrase, остальное null. Существующий тест на line 3042 проходит без изменений (DM выбирается по индексу 0, не по имени).

## Verification

**Commands:**
- `npm test` — expected: все vitest-тесты зелёные, включая новый `describe('bot — Story 11.5: ...')`
- `npm run typecheck` — expected: нет ошибок TypeScript

## Spec Change Log

## Review Triage Log

### 2026-07-13 — Review pass 1

- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 0, low 3)
- defer: 3: (high 0, medium 0, low 3)
- reject: 9
- addressed_findings:
  - `[low]` `[patch]` `import('./types.js').ClientTop` в BotDeps и closure signature заменён на статичный `ClientTop` (уже импортирован на line 78)
  - `[low]` `[patch]` `f0p_top_more` callback text не был покрыт тестом — добавлен тест `(e)`: callbackUpdate('f0p_top_more') проверяет «свободной фразой» и отсутствие старого формат-хинта
  - `[low]` `[patch]` `f0p_top_done` empty-guard text не был покрыт тестом — добавлен тест `(f)`: callbackUpdate('f0p_top_done') без топов проверяет «хотя бы один участник» и отсутствие старого хинта

## Auto Run Result

**Summary:** Реализован P1-фич: шаг A3.2 онбординга теперь принимает свободную фразу о топ-менеджере и извлекает поля `{name, title, authority, area}` через LLM (`callClaudeSafe` + `prompts/extract-top.md`). Жёсткий формат-ретрай (`«Имя — должность, полномочия, зона: …»` + один переспрос «Не разобрал») полностью удалён. При ошибке LLM — fallback на `topFromRawAnswer` (name = полная фраза). `parseTopAnswer` удалена как неиспользуемая.

**Files changed:**
- `prompts/extract-top.md` — новый промпт: извлечение 4 полей из свободной фразы, JSON-only, «не выдумывать»
- `src/bot.ts` — импорты `callClaudeSafe`, `ClientTopSchema`, `ClientTop`, `loadPrompt`; `extractTopWithLlm` в BotDeps; default-реализация; замена A3.2 retry-блока; обновлены UX-строки f0p_top_more и f0p_top_done; удалены `parseTopAnswer` импорт и `F0_PROFILE_TOP_FORMAT_HINT`
- `src/f0-profile.ts` — удалена функция `parseTopAnswer` (30 строк)
- `src/f0-profile.test.ts` — удалён import `parseTopAnswer` и `describe('parseTopAnswer (A3.2)', ...)` (3 теста)
- `src/bot.test.ts` — `extractTopWithLlm` в BuildOpts и buildBot default mock; переписан A3.2 retry-тест; добавлен `describe('bot — Story 11.5: ...')` с 6 тестами (a–f)
- `_bmad-output/implementation-artifacts/deferred-work.md` — добавлены 2 deferred items (silent fallback без лога, parsed=null path без unit-теста)

**Review findings breakdown:**
- Patches applied: 3 (import style consistency; тест f0p_top_more; тест f0p_top_done empty guard)
- Items deferred: 3 (silent parsed=null без лога; prompt_load failure без лога; no unit test for parsed=null path в default implementation)
- Items rejected: 9

**Verification:**
- `npm run typecheck` → EXIT:0, нет ошибок TypeScript
- `npm test` → EXIT:0, 763/763 тестов (было 760 на baseline; +3 нетто: 3 parseTopAnswer удалены, 6 Story 11.5 добавлены)

**Residual risks:**
- `extractTopWithLlm` default вызывает Claude API при каждом вводе участника A3.2 в продакшне — добавляет ~1-3с задержку и LLM-cost (зафиксировано как ожидаемое поведение)
- Подстрочный fallback при parsed=null не логируется — систематический сбой промпта (напр., депрекация модели) был бы невидим без дополнительных метрик (зафиксировано в deferred-work.md)
