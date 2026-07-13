---
title: 'Классификация ошибок Claude API — честное сообщение вместо «убери файлы»'
type: 'bugfix'
created: '2026-07-13'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '00081ac43f14ab0ff9e7ecaf0ba7a22892af32c9'
final_revision: '08d0677b5f0d6af8e04c1fbbc17ef4ffc7f07f5a'
context: []
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** При сборке черновика F0 любая нераспознанная ошибка (`else`-ветка в `buildF0Draft`) показывает «Если файлов много — убери лишние и собери снова: /draft». На живом прогоне 13 июля это сообщение появилось при нулевом балансе Anthropic API (HTTP 400 `"Your credit balance is too low"`) при единственном файле 116 КБ — пользователь получил ложный совет.

**Approach:** В `src/adapters/claude.ts` добавить функцию `classifyClaudeApiError(err: F1PipelineError): ClaudeApiErrorKind`, которая классифицирует ошибку по `httpStatus`/`anthropicErrorType`/`message` из `err.context`. В `src/bot.ts` в `buildF0Draft` добавить отдельную ветку для `F1PipelineError` с `code === 'claude_api'`, которая выбирает сообщение по классу ошибки и количеству файлов.

## Boundaries & Constraints

**Always:**
- Классификация живёт в `src/adapters/claude.ts` — там, где создаётся `F1PipelineError('claude_api', ...)`.
- `classifyClaudeApiError` принимает только `F1PipelineError` и работает исключительно с `err.context.httpStatus`, `err.context.anthropicErrorType`, `err.context.message`.
- Совет «убери лишние файлы» показывается только при `kind === 'too_large_context'` И `sourceNames.length > 1`.
- Для `kind === 'billing'` — сообщение про кредиты и администратора, без совета про файлы.
- Для `kind === 'rate_limit'` — совет повторить позже, без совета про файлы.
- Существующая `else`-ветка (`F0OnboardingError` уже отсечена) остаётся нетронутой: только нераспознанные не-F1PipelineError ошибки идут туда.
- `npm test` и `npm run typecheck` зелёные после изменений.

**Block If:** нет.

**Never:**
- Не трогать классификацию `shouldRetryClaude` — retry-логика ортогональна.
- Не менять `F1PipelineError`, `F1PipelineCode` и логику создания ошибки в `claude.ts`.
- Не менять маршрутизацию `F0OnboardingError` — только `else`-ветка обновляется.
- Не добавлять поле `kind` в `F1PipelineError.context` — классификация только снаружи.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Нулевой баланс (billing), 1 файл | `F1PipelineError('claude_api', {httpStatus: 400, message: '...credit balance is too low...'})`, `sourceNames.length === 1` | Сообщение содержит «закончились кредиты API» и «администратор»; НЕ содержит «убери лишние файлы» | — |
| Rate limit (429), любое число файлов | `F1PipelineError('claude_api', {httpStatus: 429})` | Сообщение содержит «повтори»; НЕ содержит «убери лишние файлы» | — |
| Overloaded (529), любое число файлов | `F1PipelineError('claude_api', {httpStatus: 529})` | Аналогично rate_limit | — |
| Context too long, 2+ файла | `F1PipelineError('claude_api', {httpStatus: 400, message: '...prompt is too long...'})`, `sourceNames.length === 2` | Сообщение содержит «убери лишние файлы» | — |
| Context too long, 1 файл | `F1PipelineError('claude_api', {httpStatus: 400, message: '...prompt is too long...'})`, `sourceNames.length === 1` | Сообщение НЕ содержит «убери лишние файлы»; содержит «слишком большой» или «повтори» | — |
| Неизвестная ошибка (500), 1 файл | `F1PipelineError('claude_api', {httpStatus: 500})` | Сообщение НЕ содержит «убери лишние файлы» | — |
| Не-F1PipelineError (регресс), 2 файла | `new Error('unexpected')`, `sourceNames.length === 2` | Старое сообщение «убери лишние» сохранено (else-ветка не тронута) | — |

</intent-contract>

## Code Map

- `src/adapters/claude.ts:272–289` — `executeClaudeCall`, catch-блок: создаёт `F1PipelineError('claude_api', {httpStatus, anthropicErrorType, message, ...})`; добавить `classifyClaudeApiError` ниже
- `src/adapters/claude.test.ts:1–10` — импорты; добавить импорт `classifyClaudeApiError`
- `src/bot.ts:112` — импорт `F0OnboardingError, F0SheetsError` из `./errors.js`; добавить `F1PipelineError`
- `src/bot.ts:2917–2939` — catch-блок `buildF0Draft`: добавить `else if (err instanceof F1PipelineError && err.code === 'claude_api')` перед существующей `else`
- `src/errors.ts:114–138` — определение `F1PipelineError` (только для чтения, не менять)

## Tasks & Acceptance

**Execution:**

- `src/adapters/claude.ts` — добавить после функции `shouldRetryClaude` (после строки 112): экспортируемый тип `export type ClaudeApiErrorKind = 'billing' | 'rate_limit' | 'too_large_context' | 'other';` и функцию `export function classifyClaudeApiError(err: F1PipelineError): ClaudeApiErrorKind`: читает `err.context` как `{ httpStatus?: number; anthropicErrorType?: string; message?: string }`; возвращает `'rate_limit'` если `httpStatus === 429 || httpStatus === 529 || anthropicErrorType === 'rate_limit_error' || anthropicErrorType === 'overloaded_error'`; возвращает `'billing'` если `httpStatus === 400` и `message?.toLowerCase()` содержит `'credit balance'`; возвращает `'too_large_context'` если `httpStatus === 400` и `message?.toLowerCase()` содержит `'prompt is too long'` или `'context_length'` или `'too long'`; иначе `'other'`. Импортировать `F1PipelineError` из `'../errors.js'` (уже импортируется через `export { F1PipelineError } from '../errors.js'` — использовать type-only import для параметра функции если нужно, или использовать существующий класс напрямую).

- `src/bot.ts` — добавить `F1PipelineError` к существующему импорту из `'./errors.js'` (строка 112): `import { F0OnboardingError, F0SheetsError, F1PipelineError } from './errors.js';`; добавить импорт `classifyClaudeApiError` из `'./adapters/claude.js'`; в catch-блоке `buildF0Draft` (строка ~2917) добавить ветку `} else if (err instanceof F1PipelineError && err.code === 'claude_api') {` перед существующей `else {`: внутри — вызов `f0Log.error({ err, step: 'f0.draft_failed', chatId }, 'f0 draft failed')`, `alertOps({ pipeline: 'F0', step: 'f0.draft_failed', error: err, context: { chatId, sessionId: session.id, files: sourceNames.length } })`, затем `const kind = classifyClaudeApiError(err)` и выбор `userMsg` по switch/if: `billing` → `'⚠️ Сервис временно недоступен — закончились кредиты API. Напиши администратору.'`; `rate_limit` → `'⚠️ AI временно перегружен, повтори запрос через несколько минут.'`; `too_large_context` и `sourceNames.length > 1` → `'⚠️ Не удалось собрать черновик. Убери лишние файлы и собери снова: /draft.'`; `too_large_context` и `sourceNames.length === 1` → `'⚠️ Не удалось собрать черновик — документ слишком большой. Попробуй уменьшить или разбить файл.'`; иначе → `'⚠️ Не удалось собрать черновик. Повтори позже или напиши администратору.'`; вызов `await finishProgress(userMsg)`.

- `src/adapters/claude.test.ts` — добавить `classifyClaudeApiError` к импортам из `'./claude.js'`; добавить импорт `F1PipelineError` из `'../errors.js'`; добавить `describe('classifyClaudeApiError', ...)` с тестами: (1) `billing` — `new F1PipelineError('claude_api', { httpStatus: 400, message: 'Your credit balance is too low to access the Claude API.' })` → `'billing'`; (2) `rate_limit` via 429 — `new F1PipelineError('claude_api', { httpStatus: 429 })` → `'rate_limit'`; (3) `rate_limit` via 529 — `new F1PipelineError('claude_api', { httpStatus: 529 })` → `'rate_limit'`; (4) `rate_limit` via `anthropicErrorType` — `new F1PipelineError('claude_api', { anthropicErrorType: 'overloaded_error' })` → `'rate_limit'`; (5) `too_large_context` — `new F1PipelineError('claude_api', { httpStatus: 400, message: 'prompt is too long' })` → `'too_large_context'`; (6) `other` via 500 — `new F1PipelineError('claude_api', { httpStatus: 500 })` → `'other'`; (7) `other` — пустой контекст `new F1PipelineError('claude_api', {})` → `'other'`.

**Acceptance Criteria:**

- Given `runF0FullDraft` бросает `F1PipelineError('claude_api', {httpStatus: 400, message: '...credit balance is too low...'})` при одном файле, when бот ловит ошибку в `buildF0Draft`, then пользователь получает сообщение, содержащее «закончились кредиты API», и НЕ содержащее «убери лишние файлы».

- Given `F1PipelineError('claude_api', {httpStatus: 429})` при любом количестве файлов, when бот ловит ошибку, then сообщение содержит слово «повтори» и НЕ содержит «убери лишние файлы».

- Given `F1PipelineError('claude_api', {httpStatus: 400, message: '...prompt is too long...'})` при двух файлах (`sourceNames.length === 2`), when бот ловит ошибку, then сообщение содержит «убери лишние файлы».

- Given `F1PipelineError('claude_api', {httpStatus: 400, message: '...prompt is too long...'})` при одном файле (`sourceNames.length === 1`), when бот ловит ошибку, then сообщение НЕ содержит «убери лишние файлы».

- Given `F1PipelineError('claude_api', {httpStatus: 500})` при одном файле, when бот ловит ошибку, then сообщение НЕ содержит «убери лишние файлы».

- Given не-`F1PipelineError` (например `new Error('crash')`) при двух файлах, when бот ловит ошибку в `buildF0Draft`, then старое сообщение с «убери лишние» остаётся (регресс: `else`-ветка не изменена).

- Given `classifyClaudeApiError` вызывается с различными `F1PipelineError`, when httpStatus = 429 → kind = `'rate_limit'`; httpStatus = 400 + "credit balance" → `'billing'`; httpStatus = 400 + "prompt is too long" → `'too_large_context'`; httpStatus = 500 → `'other'`; пустой контекст → `'other'`.

## Design Notes

`classifyClaudeApiError` проверяет сначала rate_limit (429/529 однозначны по коду) перед анализом сообщения. Биллинговый 400 и context-length 400 различаются только по `message`, так как оба имеют `anthropicErrorType === 'invalid_request_error'`. Проверка по подстроке в `message` устойчива к незначительным изменениям формулировки Anthropic API. Порядок проверок: rate_limit → billing → too_large_context → other.

Ветка `else if (err instanceof F1PipelineError && err.code === 'claude_api')` в `buildF0Draft` изолирована от `else` — регресс нераспознанных ошибок сохранён. Только `F0OnboardingError` и явный `claude_api` обрабатываются специально; всё остальное — старый `else`.

## Verification

**Commands:**
- `npm test` — expected: все vitest-тесты зелёные, включая новый `describe('classifyClaudeApiError', ...)`
- `npm run typecheck` — expected: нет ошибок TypeScript

## Spec Change Log

## Review Triage Log

### 2026-07-13 — Review pass 1

- intent_gap: 0
- bad_spec: 0
- patch: 3: (high 0, medium 0, low 3)
- defer: 4: (high 0, medium 0, low 4)
- reject: 18
- addressed_findings:
  - `[low]` `[patch]` тест `too_large_context + 1 файл` содержал только негативную проверку — добавлен `expect(msg).toContain('слишком большой')`
  - `[low]` `[patch]` отсутствовал тест для `context_length` подстроки в `classifyClaudeApiError` — добавлен `'too_large_context — message contains "context_length"'`
  - `[low]` `[patch]` отсутствовал тест для `HTTP 400` без `message` → `'other'` — добавлен `'other — HTTP 400 with no message field'`

## Auto Run Result

**Summary:** Исправлен P1-баг: при ошибке сборки черновика F0 ботовый обработчик `buildF0Draft` классифицирует ошибки Claude API по `httpStatus`/`anthropicErrorType`/`message` и показывает честное сообщение (кредиты, перегрузка, контекст/файлы) вместо единственного вводящего в заблуждение «убери лишние файлы». На живом прогоне 13 июля billing-ошибка (400 + credit balance) при одном файле 116 КБ показывала ложный совет — теперь показывает «закончились кредиты API, напиши администратору».

**Files changed:**
- `src/adapters/claude.ts` — экспортированный тип `ClaudeApiErrorKind` и функция `classifyClaudeApiError` после `shouldRetryClaude`
- `src/bot.ts` — добавлен `F1PipelineError` к imports из `./errors.js`; import `classifyClaudeApiError` из `./adapters/claude.js`; ветка `else if (err instanceof F1PipelineError && err.code === 'claude_api')` с 5 вариантами сообщений в `buildF0Draft`
- `src/adapters/claude.test.ts` — `describe('classifyClaudeApiError', ...)` с 10 тестами (billing, rate_limit 429/529/overloaded_error/rate_limit_error, too_large_context prompt/context_length, other 500/empty/400-no-message)
- `src/bot.test.ts` — `describe('bot — Story 11.4: claude_api error messages in buildF0Draft', ...)` с 6 bot-level тестами

**Review findings breakdown:**
- Patches applied: 3 (позитивная проверка в too_large_context+1-файл тесте; тест для context_length; тест для 400 без message)
- Items deferred: 4 ('too long' широкая подстрока; нет bot-теста для anthropicErrorType-пути; billing/rate_limit не различаются в alertOps; forward-compat billing)
- Items rejected: 18

**Verification:**
- `npm test` → EXIT:0, 760/760 тестов (было 744 на baseline)
- `npm run typecheck` → EXIT:0, нет ошибок TypeScript

**Residual risks:**
- `classifyClaudeApiError` использует substring-matching по `message` для billing и context-length; если Anthropic изменит формулировку ошибок, классификация может дать `other` (зафиксировано в deferred-work.md)
- Billing и overloaded-ошибки не различаются в `alertOps`-структуре — оператор видит одинаковый `step: f0.draft_failed` (зафиксировано в deferred-work.md)
