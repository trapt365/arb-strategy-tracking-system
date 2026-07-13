---
title: 'Устойчивый парсер отчёта — пустой owner не роняет весь пайплайн'
type: 'bugfix'
created: '2026-07-13'
status: 'done'
review_loop_iteration: 3
followup_review_recommended: false
final_revision: '7814a039490501a3fb357f9a0619394724cfb57d'
baseline_revision: '8fdfadb642833ce30519cecff6604b7fb7e8aa34'
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** Когда F0-онбординг создаёт KR без владельца (`kr.owner === null`), `mapOkrRows` в `f0-sheets.ts` записывает пустую строку `''` в колонку `owner` листа `_okr`. При следующем вызове F1 `parseOkrs` скармливает эти строки `OkrKrSchema.array().parse()`, а `owner: z.string().min(1)` бросает `ZodError` — пайплайн отчёта целиком роняется (воспроизведено на живом прогоне 13 июля).

**Approach:** (1) `parseOkrs` в `sheets.ts` получает параметр `log` (по образцу `parseF5Metrics`) и перед валидацией заменяет пустой `owner` строк на заглушку «—», логируя `warn` с `krNumber`. (2) `mapOkrRows` в `f0-sheets.ts` пишет «—» вместо `''` для `kr.owner ?? null` — предотвращает появление пустого значения в новых таблицах.

## Boundaries & Constraints

**Always:**
- `parseOkrs` заменяет `owner === ''` → `'—'` и логирует warn с `krNumber` на каждую такую строку. Остальная валидация (`krNumber`, `keyResult`, `z.string().min(1)`) остаётся без изменений — они по-прежнему бросают `SheetsAdapterError('invalid_value')`.
- Вызов `parseOkrs` в `readClientContext` (line 351) передаёт `log` — сигнатура функции согласована с `parseF5Metrics`.
- `mapOkrRows` в `f0-sheets.ts` использует `kr.owner ?? '—'` (было `?? ''`).
- После реализации: canary + golden + весь vitest + tsc зелёные; боевая таблица Geonline не затрагивается.

**Block If:** Нет.

**Never:**
- Не изменять `OkrKrSchema` в `types.ts` — схема остаётся как есть.
- Не заменять значение «—» в строках, где `owner` уже непустой.
- Не добавлять аналогичную замену для `krNumber` или `keyResult` — они обязательные.
- Не изменять логику `parseF5Metrics`, `parseStakeholders`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| `owner` пустой | `_okr` строка с `owner: ''` | `parseOkrs` возвращает строку с `owner: '—'`; `log.warn` вызван с `{ krNumber, field: 'owner' }` | Нет — штатный возврат |
| `owner` заполнен | `_okr` строка с `owner: 'Самарханов'` | Без изменений — `'Самарханов'` сохраняется, warn не вызывается | Нет |
| `krNumber` пустой | `_okr` строка с `krNumber: ''` | `ZodError` → `SheetsAdapterError('invalid_value')` — поведение без изменений | Бросает `invalid_value` |
| Онбординг, `kr.owner === null` | F0 пишет KR строку без владельца | `_okr.owner` = `'—'` в Google Sheets (было `''`) | Нет |

</intent-contract>

## Code Map

- `src/adapters/sheets.ts:351` — вызов `parseOkrs(valueRanges[1]?.values ?? [])` — добавить `log` вторым аргументом
- `src/adapters/sheets.ts:613–630` — функция `parseOkrs(values)` — добавить `log` параметр + предобработку owner
- `src/f0-sheets.ts:66` — `owner: kr.owner ?? ''` — изменить на `'—'`
- `src/f0-grounding.ts:64` — `if (owner.length === 0) return row;` — расширить до `if (owner.length === 0 || owner === '—') return row;`
- `src/f0-sheets.ts:480` — `uniqueOwners` фильтр — добавить `&& o !== '—'` чтобы сентинел не создавал персональный лист `👤 —`
- `src/adapters/sheets.test.ts` — тесты `parseOkrs` — добавить тест на пустой owner
- `src/f0-sheets.test.ts` — тесты `mapOkrRows` и `uniqueOwners` — добавить тест null owner, null owner + tops, и `uniqueOwners` с `'—'`
- `src/f0-import.ts:287` — `participantsFromOwners` guard — расширить до `|| owner === '—'` чтобы сентинел не создавал фантомного участника при реимпорте формата A

## Tasks & Acceptance

**Execution:**

- `src/adapters/sheets.ts` — добавить `log: Pick<Logger, 'warn'>` в сигнатуру `parseOkrs` (строка 613); добавить маппинг строк между `parseSheetRange` и `OkrKrSchema.array().parse`: для каждой строки, если `row.owner === ''`, вызвать `log.warn({ step: 'sheets.parseOkrs', sheet: '_okr', field: 'owner', krNumber: row.krNumber }, 'OKR row has empty owner — defaulting to «—»')` и установить `row.owner = '—'`; обновить вызов функции на строке 351 — передать `log` вторым аргументом.

- `src/f0-sheets.ts` — в `mapOkrRows` изменить строку 66: `owner: kr.owner ?? ''` → `owner: kr.owner ?? '—'`.

- `src/f0-grounding.ts` — в `groundedOkrRows` (строка 64) расширить guard: `if (owner.length === 0) return row;` → `if (owner.length === 0 || owner === '—') return row;`. Это гарантирует, что плейсхолдер `'—'` не оборачивается в `'🔴 —'` при наличии tops.

- `src/f0-sheets.ts` — в `uniqueOwners` (строка 480) добавить условие фильтра `&& o !== '—'`: итого `o.length > 0 && !o.startsWith('🔴 ') && o !== '—'`. Это предотвращает создание персонального листа `👤 —` при null-owner KR.

- `src/adapters/sheets.test.ts` — добавить тест: `_okr` строки с `owner: ''` → `readClientContext` возвращает контекст с `okrs[0].owner === '—'`; `mockBatchGetOk` используется аналогично существующему happy-path тесту с заменой пустого owner.

- `src/f0-sheets.test.ts` — добавить тест: `kr.owner === null` с пустым `tops` → `rows[0].owner === '—'`; добавить тест: `kr.owner === null` с непустым `tops` → `rows[0].owner === '—'` (не `'🔴 —'`); добавить тест: `uniqueOwners([{ owner: '—' }])` → `[]` (сентинел не попадает в список).

- `src/f0-import.ts` — в `participantsFromOwners` (строка 287) расширить guard: `if (owner === undefined || owner.length === 0) continue;` → `if (owner === undefined || owner.length === 0 || owner === '—') continue;`. Это предотвращает создание фантомного участника `{ name: '—', ... }` при реимпорте формата A с null-owner KR (которые теперь хранят `'—'` в `_okr.owner`).

- `src/f0-import.test.ts` — добавить describe-блок `'story 11.2: sentinel «—» не создаёт фантомного участника'` с тестом: формат-A лист `_okr` с `owner: '—'` и без `_stakeholder_map` → `participants === []`.

**Acceptance Criteria:**

- Given `_okr` содержит хотя бы одну строку с пустым `owner`, when `readClientContext` вызывается для этого клиента, then функция возвращает `ClientContext` с `okrs[n].owner === '—'` — не бросает ошибки.
- Given `_okr` содержит строки с непустыми `owner`, when `readClientContext` вызывается, then поведение полностью совпадает с текущим — значения не изменяются.
- Given `_okr` содержит строку с пустым `krNumber`, when `readClientContext` вызывается, then по-прежнему бросается `SheetsAdapterError` с кодом `'invalid_value'`.
- Given F0-онбординг создаёт KR без владельца (`kr.owner === null`), when `mapOkrRows` маппирует строки (без tops), then в Google Sheets записывается `'—'` вместо `''`.
- Given F0-онбординг создаёт KR без владельца (`kr.owner === null`) и передаёт непустой `tops`, when `mapOkrRows` маппирует строки, then в Google Sheets записывается `'—'` — не `'🔴 —'`.
- Given список OKR строк содержит строку с `owner === '—'`, when `uniqueOwners` вызывается, then `'—'` не включается в результат — персональный лист не создаётся.
- Given формат-A лист `_okr` содержит строку с `owner: '—'` и `_stakeholder_map` отсутствует, when `importStrategyXlsx` вызывается, then `extraction.participants` не содержит `{ name: '—', ... }` — фантомный участник не создаётся.

## Spec Change Log

### 2026-07-13 — bad_spec loopback (pass 3)

- **Triggering finding:** `participantsFromOwners` в `f0-import.ts:287` имеет guard `owner === undefined || owner.length === 0`, но не фильтрует сентинел `'—'` (длина 1). После изменения write-пути (`kr.owner ?? '—'`), при реимпорте формата-A без `_stakeholder_map`, `participantsFromOwners` создаёт фантомного участника `{ name: '—', role: null, department: null, contact: null }`.
- **Что исправлено:** Добавлена задача для `src/f0-import.ts:287` — расширить guard до `|| owner === '—'`; добавлена задача для `src/f0-import.test.ts`; добавлен новый AC.
- **Known-bad state:** фантомный участник `{ name: '—', ... }` появляется в `extraction.participants` при реимпорте формата-A с null-owner KR — засоряет список стейкхолдеров.
- **KEEP:** все изменения `sheets.ts`, `sheets.test.ts`, `f0-sheets.ts` (строки 66 и 480), `f0-grounding.ts:64`, `f0-sheets.test.ts` — корректны.

### 2026-07-13 — bad_spec loopback (pass 2)

- **Triggering finding:** `uniqueOwners` в `f0-sheets.ts:480` фильтрует пустые строки (`o.length > 0`) и `'🔴 '`-префиксы, но не сентинел `'—'`. После изменения `mapOkrRows` (`'—'` вместо `''`) null-owner KR теперь попадает в `uniqueOwners` → `ensurePersonalSheets` создаёт лист `👤 —`.
- **Что исправлено:** Добавлена задача для `src/f0-sheets.ts:480` — добавить `&& o !== '—'` в фильтр `uniqueOwners`; добавлен тест `uniqueOwners([{ owner: '—' }]) → []`; добавлен новый AC.
- **Known-bad state:** лист `👤 —` создаётся в Google Sheets при любом KR без владельца — засоряет таблицу клиента фантомной вкладкой.
- **KEEP:** все изменения `sheets.ts`, `sheets.test.ts`, `f0-sheets.ts:66`, `f0-grounding.ts:64`, `f0-sheets.test.ts` (null owner с/без tops) — корректны.

### 2026-07-13 — bad_spec loopback (pass 1)

- **Triggering finding:** `groundedOkrRows` в `f0-grounding.ts:64` пропускает пустой owner (`owner.length === 0`) но не пропускает сентинел `'—'`. После изменения `mapOkrRows` (`'—'` вместо `''`) — при наличии `tops` — `groundedOkrRows` видит непустой `'—'`, не находит совпадения в профиле и оборачивает в `'🔴 —'`, что записывается в лист вместо плейсхолдера.
- **Что исправлено:** Добавлена задача для `src/f0-grounding.ts:64` — расширить guard на `|| owner === '—'`; добавлены тесты для tops-сценария в `f0-sheets.test.ts`; добавлен новый AC для tops-сценария.
- **Known-bad state:** написание `'🔴 —'` в колонку `owner` листа `_okr` при null owner и непустом tops — не является ошибкой валидации, но засоряет данные красным маркером.
- **KEEP:** все изменения `src/adapters/sheets.ts` (parseOkrs + log + '' → '—') — корректны; все изменения `src/adapters/sheets.test.ts` — корректны; изменение `src/f0-sheets.ts:66` — корректно; тест null-owner без tops — корректен.

## Review Triage Log

### 2026-07-13 — Review pass 4

- intent_gap: 0
- bad_spec: 0
- patch: 0
- defer: 0
- reject: 18
- addressed_findings:
  - none

### 2026-07-13 — Review pass 3

- intent_gap: 0
- bad_spec: 1: (high 0, medium 1, low 0)
- patch: 0
- defer: 0
- reject: 15
- addressed_findings:
  - `[medium]` `[bad_spec]` `participantsFromOwners` не фильтрует `'—'` → фантомный участник при реимпорте без `_stakeholder_map` — добавлена задача для `f0-import.ts:287`, `f0-import.test.ts`, AC

### 2026-07-13 — Review pass 2

- intent_gap: 0
- bad_spec: 1: (high 0, medium 1, low 0)
- patch: 0
- defer: 2: (high 0, medium 0, low 2)
- reject: 14
- addressed_findings:
  - `[medium]` `[bad_spec]` `uniqueOwners` не фильтрует `'—'` → phantom `👤 —` лист — добавлена задача для `f0-sheets.ts:480`, AC и тест

### 2026-07-13 — Review pass 1

- intent_gap: 0
- bad_spec: 1: (high 0, medium 1, low 0)
- patch: 0
- defer: 1: (high 0, medium 0, low 1)
- reject: 17
- addressed_findings:
  - `[medium]` `[bad_spec]` `groundedOkrRows` оборачивает `'—'` в `'🔴 —'` при наличии tops — добавлена задача для `f0-grounding.ts:64`, AC и тест

## Design Notes

`parseSheetRange` уже применяет `.trim()` к каждой ячейке (строка 177), поэтому проверка `row.owner === ''` достаточна для покрытия как пустых, так и пробельных ячеек. Паттерн `log` параметра скопирован с `parseF5Metrics` (строка 632) — обе функции становятся симметричны. `OkrKrSchema` не меняется: «—» имеет длину 1 и проходит `min(1)` без исключений.

`groundedOkrRows` (f0-grounding.ts:64) пропускает строки с `owner.length === 0`, но не пропускает `'—'` (сентинел). После добавления `|| owner === '—'` функция корректно пропускает плейсхолдер без попытки grounding.

`participantsFromOwners` (f0-import.ts:287) пропускает `undefined` и пустые строки, но не сентинел `'—'`. После добавления `|| owner === '—'` реимпорт формата-A без `_stakeholder_map` не создаёт фантомного участника `{ name: '—', ... }`.

## Verification

**Commands:**
- `npm test` — expected: все vitest-тесты зелёные, включая новый тест на пустой owner
- `npm run typecheck` — expected: нет ошибок TypeScript
- `npm run canary` — expected: exit 0 или exit 1 REVIEW с pre-existing причиной (нулевой баланс Anthropic API, не связано с этой story)

## Auto Run Result

**Summary:** Исправлен P0-баг: пустой `owner` в листе `_okr` больше не роняет F1-пайплайн отчёта. `parseOkrs` получает параметр `log` и заменяет пустой owner на сентинел `'—'` перед Zod-валидацией. `mapOkrRows` пишет `'—'` вместо `''` для KR без владельца. Три downstream-потребителя сентинела обновлены: `groundedOkrRows` пропускает `'—'` при grounding, `uniqueOwners` исключает `'—'` из персональных листов, `participantsFromOwners` исключает `'—'` при реимпорте.

**Files changed:**
- `src/adapters/sheets.ts` — добавлен параметр `log: Pick<Logger, 'warn'>` в `parseOkrs`; предобработка owner (`'' → '—'` с warn) перед Zod-валидацией; вызов на line 351 обновлён
- `src/f0-sheets.ts` — `mapOkrRows` line 66: `kr.owner ?? ''` → `kr.owner ?? '—'`; `uniqueOwners` line 480: добавлен фильтр `&& o !== '—'`
- `src/f0-grounding.ts` — `groundedOkrRows` line 64: guard расширен до `|| owner === '—'`
- `src/f0-import.ts` — `participantsFromOwners` line 287: guard расширен до `|| owner === '—'`
- `src/adapters/sheets.test.ts` — 3 новых теста: пустой owner → `'—'`, непустой owner без изменений, пустой krNumber → `invalid_value`
- `src/f0-sheets.test.ts` — 3 новых теста: null owner без tops, null owner с tops (не `'🔴 —'`), `uniqueOwners` с `'—'` → `[]`
- `src/f0-import.test.ts` — 1 новый тест: owner `'—'` без `_stakeholder_map` → `participants === []`

**Review findings breakdown:**
- Patches applied: 0
- Items deferred: 2 (low — `parseStakeholders` logger asymmetry; magic string `'—'` в 4+ местах без константы)
- Items rejected: ~47 across 4 passes

**Verification:**
- `npm test` → EXIT:0, 741/741 тестов (было 734 на baseline)
- `npm run typecheck` → EXIT:0, нет ошибок TypeScript

**Residual risks:**
- Сентинел `'—'` (U+2014) дублируется в 5 файлах без именованной константы — отслеживается в `deferred-work.md`
- Canary не запускался (нулевой баланс Anthropic API — pre-existing блокер, зафиксирован в epic 11)
