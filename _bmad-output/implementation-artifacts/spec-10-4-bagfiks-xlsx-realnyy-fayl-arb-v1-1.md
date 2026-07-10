---
title: '[10.4] Багфикс xlsx — реальный файл ARB v1.1'
type: 'bugfix'
created: '2026-07-10'
status: 'done'
baseline_revision: 'bea41c735cfefe4f74e24c163aba2c4c28dd2b42'
final_revision: 'a593da16e421ddaf6f6127516f030757fb4acd49'
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** `ARB Solutions Стратегический трекер v1.1 (1).xlsx` отказывает с `import_unmappable`. Файл содержит лист `Vision&Strategy` с заголовком KR-таблицы в строке `['Тип', 'Objective / Key Result', '', '', 'Срок', 'Ответственный']`. Текущий `matchKrColumn` применяет prefix-match до exact-match: синоним `'objective'` (в категории `objective`) захватывает заголовок `'objective / key result'` через `startsWith('objective ')`. В результате `columns.formulation` остаётся `undefined`, лист пропускается, `bestSheet === null` → исключение `import_unmappable`.

**Approach:** Разбить `matchKrColumn` на два прохода — сначала exact-match по всем категориям, затем prefix-match. Добавить `'objective / key result'` как точный синоним `formulation` и `'тип'` как точный синоним `objective`. Написать фикстуру ARB v1.1 в тестах.

## Boundaries & Constraints

**Always:**
- Только `src/f0-import.ts` и `src/f0-import.test.ts` — другие файлы не трогать.
- Поведение existing-тестов не меняется: exact-first меняет порядок обхода, но не затрагивает случаи, где exact-match уже был первым (все текущие синонимы либо совпадают точно, либо срабатывают по prefix без конфликта с exact в другой категории).
- `formulation` по-прежнему обязателен для принятия листа; порог `GENERIC_MATCH_THRESHOLD = 3` не меняется.
- Canary + vitest + tsc зелёные после коммита.

**Block If:**
- При проверке тестов выясняется, что какой-либо existing test сломан two-pass рефактором и fix неочевиден — HALT с blocking condition `existing test broken by two-pass refactor, manual review needed`.

**Never:**
- Не снижать порог `GENERIC_MATCH_THRESHOLD`.
- Не трогать `xlsxToText`, `importTemplate`, `readKrRows`, `groupIntoObjectives`.
- Не добавлять новые синонимы кроме `'objective / key result'` (formulation) и `'тип'` (objective).
- Не менять fallback UX при `import_unmappable` — он уже показывает `f0StrategyKeyboard` (три пути), этого достаточно.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| ARB v1.1 happy path | Лист `Vision&Strategy`: строка 11 = `['Тип', 'Objective / Key Result', '', '', 'Срок', 'Ответственный']`; ≥1 строки данных | Import успешен; `matchedCount ≥ 3`; `columns.formulation` заполнен | — |
| `objective / key result` → formulation | Header = `'objective / key result'` | `matchKrColumn` возвращает `'formulation'` | — |
| `тип` → objective | Header = `'тип'` | `matchKrColumn` возвращает `'objective'` | — |
| Existing prefix-match не сломан | Header = `'ответственный за kr'` | Возвращает `'owner'` (prefix pass) | — |
| Existing exact-match не сломан | Header = `'цель'` | Возвращает `'target'` (exact pass) | — |
| Файл не содержит ни одного подходящего листа | Все листы без `formulation`-колонки | `import_unmappable`, бот показывает `f0StrategyKeyboard` | — |

</intent-contract>

## Code Map

- `src/f0-import.ts:169` — `matchKrColumn`: current single-pass logic (exact | prefix) — рефакторить на два прохода
- `src/f0-import.ts:54` — `KR_COLUMN_SYNONYMS`: словарь синонимов — добавить два новых synonym
- `src/f0-import.test.ts` — существующие generic format B тесты (lines 163–286); добавить ARB v1.1 fixture

## Tasks & Acceptance

**Execution:**

- `src/f0-import.ts` — в `KR_COLUMN_SYNONYMS` добавить в массив синонимов `'formulation'` строку `'objective / key result'` (после `'key_result'`); добавить в массив синонимов `'objective'` строку `'тип'` (после `'приоритет'`).

- `src/f0-import.ts` — рефакторить `matchKrColumn` (lines 169–179) на два прохода:
  ```
  function matchKrColumn(header: string): KrColumn | null {
    if (header.length === 0) return null;
    for (const [column, synonyms] of KR_COLUMN_SYNONYMS) {
      for (const syn of synonyms) {
        if (header === syn) return column;
      }
    }
    for (const [column, synonyms] of KR_COLUMN_SYNONYMS) {
      for (const syn of synonyms) {
        if (header.startsWith(`${syn} `) || header.startsWith(`${syn}(`)) {
          return column;
        }
      }
    }
    return null;
  }
  ```

- `src/f0-import.test.ts` — добавить `describe('Story 10.4: ARB v1.1 xlsx import', () => { ... })` с тремя тестами (все через `importStrategyXlsx` — `matchKrColumn` не экспортирован):

  **(a) ARB v1.1 full import:**
  Создать xlsx-буфер (`XLSX.utils.book_new()` / `XLSX.write`) с листом `'Vision&Strategy'`:
  - Строки 0–9: произвольная шапка (заголовок компании, финансовые цели, пустые строки)
  - Строка 10: `['🎯 СТРАТЕГИЧЕСКИЕ OKR', '', '', '', '', '']`
  - Строка 11: `['Тип', 'Objective / Key Result', '', '', 'Срок', 'Ответственный']`
  - Строка 12: `['Enablers', 'Построить команду', '', '', '', 'Айдар']`
  - Строка 13: `['', '└─ Нанять 3 специалистов', '', '', 'июнь 2026', 'Айдар']`

  Ожидание: вызов не бросает исключение; `result.format === 'generic'`; `result.extraction.objectives.length >= 1`; суммарно `krs.length >= 1`; `result.extraction.objectives[0]!.krs.some(k => k.owner === 'Айдар')`

  **(b) regression: prefix-match не сломан:**
  Создать лист с заголовком-строкой `['Ответственный за KR', 'Ключевой результат', 'Текущее значение', 'Целевое значение', 'Срок реализации']` + 2 строки данных.

  Ожидание: `importStrategyXlsx` успешен; `result.format === 'generic'`; `result.extraction.objectives.length >= 1`

  **(c) regression: existing exact-match не сломан:**
  Создать лист с заголовком-строкой `['Направление', 'KR', 'База', 'Цель', 'Срок', 'Ответственный']` + 2 строки данных (с непустой базой).

  Ожидание: `importStrategyXlsx` успешен; `result.extraction.objectives[0]!.krs[0]!.base !== null`

**Acceptance Criteria:**

- Given файл `ARB Solutions Стратегический трекер v1.1 (1).xlsx` (лист `Vision&Strategy`, заголовок в строке 11: `Тип | Objective / Key Result | | | Срок | Ответственный`), when бот получает этот файл через Telegram, then `importStrategyXlsx` возвращает `F0ImportResult` с `format: 'generic'`, ≥1 objectives, ≥1 KRs; исключение `import_unmappable` не бросается

- Given заголовок `'objective / key result'` в xlsx, when `matchKrColumn` вызван (через importStrategyXlsx), then колонка маппится как `formulation`, а не `objective`

- Given заголовок `'ответственный за kr'` (prefix-match case), when `matchKrColumn` вызван, then колонка маппится как `owner` (prefix pass работает)

- Given регресс Geonline canary, when 10.4 внедрён, then `npm run canary` зелёный; `npm test` зелёный; `tsc --noEmit` чистый

## Design Notes

**Почему two-pass, а не просто добавить синоним выше в списке.** Добавить `'objective / key result'` как синоним `formulation` в текущем однопроходном алгоритме недостаточно: `objective` категория проверяется первой, и её синоним `'objective'` захватывает `'objective / key result'` через prefix-match (`startsWith('objective ')`) ещё до того, как доходит до `formulation`. Two-pass делает exact-match глобально приоритетным над prefix-match, что соответствует ожидаемой семантике: точный синоним всегда сильнее "начинается с".

**`тип` → objective: зачем.** В ARB-файле колонка `Тип` содержит значения `'Enablers'`, `'Процессы'`, `'Клиенты'` и т.д. — это группировочная категория (objective). Без маппинга она игнорируется (`null`), а `currentObjective` берётся из переноса вниз значения из колонки `formulation` (тип-строки типа `'Построить команду'` становятся объектив-заголовком). С маппингом `тип` → `objective` группировка работает корректнее: `'Enablers'` становится `objectiveTitle` для всех KR этого блока.

**Семантический компромисс.** ARB-файл смешивает objective-строки (`Построить команду`) и KR-строки (`└─ Нанять 3 специалистов`) в одной колонке `Objective / Key Result`. Парсер создаст KR-записи и для тех и для других — это не идеально, но приемлемо: import succeeds, черновик появляется, дозаполнение через таблицу доступно. Инв. 3 («не выдумывать») соблюдён: пустые base/target в ARB-файле остаются null.

## Spec Change Log

## Review Triage Log

### 2026-07-10 — Review pass (iteration 1, 4 reviewers: Blind Hunter · Edge Case Hunter · Verification Gap · Intent Alignment)

- intent_gap: 0
- bad_spec: 0
- patch: 2: (medium 1, low 1)
- defer: 2: (low 2)
- reject: 7
- addressed_findings:
  - `[medium]` `[patch]` Тест (b) не содержал утверждения на owner — `'Ответственный за KR'` маппился через prefix-pass, но значение не проверялось. Добавлен `expect(result.extraction.objectives[0]!.krs[0]!.owner).toBe('Айгерим')`. Без этого тест проходил бы даже если prefix-match сломан.
  - `[low]` `[patch]` Тест (c): `expect(...base).not.toBeNull()` проходит при `base === undefined` (undefined !== null). Укреплён до `.toBe('10 млн')` — закрывает undefined/null gap.
- deferred_findings:
  - `[low]` `[defer]` Потенциальная prefix-коллизия `'тип'` → objective при заголовке `'тип операции'` — pre-existing риск паттерна, не введён этой историей. Синоним `'тип'` точный (exact-pass), но если добавят prefix `'тип'`-синоним в другой категории — конфликт. Мониторинг при расширении словаря.
  - `[low]` `[defer]` Нет бинарной фикстуры реального ARB-файла в тестах — fixture синтетическая. Реальный файл охвачен prod-логами (import_unmappable до фикса, ожидаемо успех после). Приемлемо.

## Verification

**Commands:**
- `npm test` -- expected: все тесты зелёные (включая 3 новых Story 10.4)
- `tsc --noEmit` -- expected: no type errors
- `npm run canary` -- expected: canary green или pre-existing failure идентична baseline

## Auto Run Result

Status: done

### Summary

Исправлен `import_unmappable` для `ARB Solutions Стратегический трекер v1.1 (1).xlsx`: добавлены синонимы `'objective / key result'` (formulation) и `'тип'` (objective); `matchKrColumn` переработан на два прохода — exact-first глобально, затем prefix — что устраняет захват `'objective / key result'` prefix-матчем `'objective'` из другой категории.

### Files changed

- `src/f0-import.ts` — `KR_COLUMN_SYNONYMS`: два новых синонима; `matchKrColumn`: two-pass рефактор
- `src/f0-import.test.ts` — три теста Story 10.4 (a/b/c) + патчи reviewer: owner assert в (b), `.toBe('10 млн')` в (c)
- `_bmad-output/implementation-artifacts/spec-10-4-bagfiks-xlsx-realnyy-fayl-arb-v1-1.md` — спек (этот файл)

### Review findings breakdown

- **Patches applied (2):** owner assertion в тесте (b) [medium]; base value assertion в тесте (c) [low]
- **Deferred (2):** prefix-коллизия риск `'тип'`-синонима [low]; нет бинарной фикстуры реального файла [low]
- **Rejected (7):** O(2n) performance concern; комментарии в коде; row-indexing path; slash-spacing вариант; академические undefined/null в KR-типе; тест на `import_unmappable` при пустом листе (уже покрыт существующим тестом); коллизия `тип` → objective в несуществующих кейсах

### Follow-up review recommendation

false — патчи тестовые, основная логика не затронута.

### Verification

- `tsc --noEmit` → чистый (exit 0)
- `npm test` → 700 тестов pass (35 файлов), +3 новых Story 10.4
- `npm run canary` → pre-existing failure (нет live Claude API key в среде); идентично baseline до изменений
