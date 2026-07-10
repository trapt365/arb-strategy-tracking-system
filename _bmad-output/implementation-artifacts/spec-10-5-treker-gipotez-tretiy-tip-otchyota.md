---
title: '[10.5] Трекер гипотез — третий тип отчёта'
type: 'feature'
created: '2026-07-10'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '4cb3844491baf576abb8913cbb5cb9a34c941f5c'
final_revision: '17962197ebabb24844b386cb641431624e8e0134'
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** Трекер гипотез (третий тип отчёта) отсутствует. Динамика гипотез по неделям недоступна — только сырой список в листе `_hypotheses` без сравнения «было → стало».

**Approach:** Новый pipeline `src/f5-hypo-tracker.ts`: читает лист `_hypotheses`, сравнивает со снимком прошлой недели (JSON в `data/{clientId}/hypo-snapshot.json`), вызывает Claude для ключевых выводов, форматирует отчёт, сохраняет новый снимок. Доставка: кнопка `🧪 Трекер гипотез` в меню клиента (рядом с «Недельный отчёт»).

## Boundaries & Constraints

**Always:**
- Клиентская изоляция: только активный/выбранный клиент. `clientId === 'geonline'` fallback не ломать.
- Enforcement rules: `loadPrompt()`, `parseClaudeJSON(raw, Schema)`, `withRetry()`, pino-логгер с `{pipeline: 'F5', step, clientId}`.
- Первый запуск (снимок отсутствует): полный список без delta-секций; снимок сохранить.
- Снимок обновляется после каждого успешного прочтения листа с ≥1 строками данных.
- Claude failure для conclusions: форматировать без секции «Выводы» (не блокировать, не partial).
- Compact delivery: если текст > 4000 символов — truncate через `splitForTelegram`.

**Block If:**
- Лист `_hypotheses` недоступен (SheetsAdapterError с кодом `auth`/`sheet_not_found`/`header_missing`): HALT с blocking condition `hypotheses sheet unreadable — manual fix needed`.

**Never:**
- Не читать другие листы (`_okr`, `_stakeholder_map`) в этом pipeline.
- Не трогать F1-pipeline, weekly report, grounding-модуль.
- Не обновлять снимок если лист вернул 0 строк данных (не перетирать предыдущий снимок нулём).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Первый запуск | currentRows ≥ 1, snapshot = null | Полный список без delta-секций; снимок сохранён | — |
| Есть изменения | snapshot existed, ≥1 rows с другим status | Секция «Изменения» + «Новые» + сводка + выводы | — |
| Нет изменений | snapshot match полный | «Изменений за неделю нет» вместо пустых секций | — |
| Пустой лист | rows = 0 после заголовка | «Гипотезы не найдены в листе _hypotheses.» | — |
| Claude упал | withRetry exhausted | Отчёт без секции «Выводы»; warn-лог | — |
| header_missing | лист без колонки `statement` | HALT blocking condition | — |

</intent-contract>

## Code Map

- `src/types.ts:140` — после `HypothesisItemSchema`; добавить `HypoSnapshotItemSchema`, `HypoSnapshotSchema`, `HypoTrackerConclusionsSchema`
- `src/adapters/sheets.ts` — после `readClientContext`; добавить `readHypothesesSheet(clientId, logger?)` (batchGet `_hypotheses!A1:Z`, required headers `['statement', 'status']`)
- `src/f5-hypo-tracker.ts` — новый pipeline-модуль (step 1: read sheet → step 2: load snapshot → step 3: delta → step 4: Claude conclusions → step 5: format → step 6: persist snapshot)
- `prompts/hypo-tracker.md` — Claude prompt для conclusions
- `src/f5-hypo-tracker.test.ts` — тесты delta-логики и форматтера
- `src/bot.ts` — в обработчике, содержащем `kb.row().text('📅 Недельный отчёт', ...)` (около строки 2164): добавить следующей строкой `kb.row().text('🧪 Трекер гипотез', \`hypo_tracker:${clientId}\`)`; добавить отдельный callback-обработчик `/^hypo_tracker:(.+)$/` рядом с `weekly:` handler (lines 2175–2201)
- `data/{clientId}/hypo-snapshot.json` — файл снимка (схема `HypoSnapshotSchema`); создаётся при первом запуске

## Tasks & Acceptance

**Execution:**

- `src/types.ts` — после строки 140 добавить три схемы:
  ```ts
  export const HypoSnapshotItemSchema = z.object({
    statement: z.string().min(1),
    department: z.string().nullable(),
    okrLink: z.string().nullable(),
    status: z.string(),
  });
  export type HypoSnapshotItem = z.infer<typeof HypoSnapshotItemSchema>;

  export const HypoSnapshotSchema = z.object({
    weekNumber: z.number().int().positive(),
    year: z.number().int().positive(),
    hypotheses: z.array(HypoSnapshotItemSchema),
  });
  export type HypoSnapshot = z.infer<typeof HypoSnapshotSchema>;

  export const HypoTrackerConclusionsSchema = z.object({
    conclusions: z.array(z.string()).min(1).max(7),
  });
  ```

- `src/adapters/sheets.ts` — добавить экспортируемую функцию `readHypothesesSheet(clientId: string, logger?: Logger): Promise<Record<string, string>[]>`. Использовать `resolveSheetId`, `withRetry`, `getSheetsClient`, `parseSheetRange` с required `['statement', 'status']`. Выбрасывать `SheetsAdapterError` как в `readClientContext`.

- `prompts/hypo-tracker.md` — создать: промпт принимает `{{clientName}}`, `{{weekNumber}}`, `{{changesText}}` (строки `statement: oldStatus → newStatus`), `{{newText}}` (новые), `{{summaryText}}` (сводка статусов). Просит Claude: 3–5 ключевых вывода о динамике (без повтора статистики). Формат ответа: `{"conclusions":["..."]}`. Без markdown fences в ответе.

- `src/f5-hypo-tracker.ts` — создать:
  - `export interface RunHypoTrackerInput { clientId: string; deps?: { logger?, now?, rootDir?, callClaude?, loadPrompt? } }`
  - `export async function runHypoTracker(input): Promise<string>` — полный pipeline. Delta: сопоставление по `statement.trim().toLowerCase()`. Snapshot-файл: `join(input.deps?.rootDir ?? 'data', slugifyClientId(clientId), 'hypo-snapshot.json')` (паттерн F1: `deps.rootDir ?? 'data'`). Если snapshotPath не существует → firstRun mode. Conclusions: вызов Claude с `withRetry`; при ошибке — warn и продолжить без секции. Возвращает готовый текст отчёта (≤ 4000 символов или полный — обрезку делает bot.ts через `splitForTelegram`).

- `src/f5-hypo-tracker.test.ts` — создать 4 теста через чистые функции (`computeDelta`, `formatHypoReport`) или через mock-зависимости:
  1. Delta: 2 изменённых статуса + 1 новая гипотеза → правильный `changed.length === 2`, `added.length === 1`
  2. Delta: все совпадают → `changed.length === 0`, `added.length === 0`
  3. Формат первого запуска: snapshot null → текст содержит все statement, без секции «Изменения»
  4. Пустой лист (rows = 0) → возвращает «Гипотезы не найдены в листе _hypotheses.»

- `src/bot.ts` — (a) в обработчике около строки 2164 добавить кнопку после `kb.row().text('📅 Недельный отчёт', ...)`: `kb.row().text('🧪 Трекер гипотез', \`hypo_tracker:${clientId}\`)`; (b) добавить `bot.callbackQuery(/^hypo_tracker:(.+)$/, async (ctx) => {...})` рядом с `weekly:(.+)` handler по тому же образцу (lines 2175–2201): `answerCallbackQuery`, `getClientName`, `getClientSheetId`, `getISOWeekAndYear`, вызов `runHypoTracker`, `splitForTelegram`, лог с `{step: 'bot.hypo_tracker.sent', clientId}`.

**Acceptance Criteria:**

- Given клиент с листом `_hypotheses` (≥1 строка данных) и без предыдущего снимка, when трекер нажимает «🧪 Трекер гипотез», then бот отвечает текстовым сообщением с заголовком `🧪 Трекер гипотез — {clientName} — нед.{N}`, полным списком гипотез, без секций «Изменения» и «Новые», и файл `data/{clientId}/hypo-snapshot.json` создаётся с `weekNumber` текущей недели

- Given snapshot из недели N, текущий лист где statement «X» сменил status с «идея» на «в тесте» и появилась строка «Y» (новая), when запуск, then ответ содержит секцию «Изменения» с «X: идея → в тесте» и секцию «Новые» с «Y»

- Given snapshot существует, все statement и status совпадают с текущим листом, when запуск, then ответ содержит «Изменений за неделю нет» (или аналог), снимок обновлён с новым weekNumber

- Given лист `_hypotheses` возвращает 0 строк данных, when запуск, then ответ «Гипотезы не найдены в листе _hypotheses.», snapshot не обновляется

- Given `npm test && tsc --noEmit && npm run canary` после слияния 10.5, then все зелёные (canary pre-existing failure идентична baseline)

## Design Notes

**Delta по statement, не по позиции.** Строки в листе могут менять порядок — сопоставление по `statement.trim().toLowerCase()` единственно корректно.

**Snapshot path — корень clientId, не date-директория.** Снимок один на клиента (не история). При каждом запуске перезаписывается. Если нужна история — отдельная story.

**Claude failure не блокирует.** Выводы Claude — добавленная ценность, не MVP-функция. При ошибке (после withRetry) логируем warn и отдаём отчёт без секции «Выводы».

**Расположение кнопки.** Добавить `kb.row().text('🧪 Трекер гипотез', \`hypo_tracker:${clientId}\`)` ПОСЛЕ строки недельного отчёта — чтобы порядок был: Недельный отчёт → Трекер гипотез.

## Spec Change Log

## Review Triage Log

### 2026-07-10 — Review pass (iteration 0, 4 reviewers: Blind Hunter · Edge Case Hunter · Verification Gap · Intent Alignment)

- intent_gap: 0
- bad_spec: 0
- patch: 10: (medium 4, low 6)
- defer: 5: (low 5)
- reject: 3
- addressed_findings:
  - `[medium]` `[patch]` `clientName` всегда равен `clientId` — добавлен `clientName?: string` в `RunHypoTrackerInput`; bot.ts передаёт `name` из `getClientName`; pipeline использует `clientName` в заголовке отчёта и в Claude-промпте
  - `[medium]` `[patch]` Пустые строки `statement` из листа вызывали потенциальный `min(1)` разрыв снимка при следующей загрузке — добавлен filter пустых `statement` и приведение пустых `department`/`okrLink` к `null` в `rowsToSnapshotItems`
  - `[medium]` `[patch]` `getClientSheetId` в bot handler не в try/catch — добавлен `.catch(() => undefined)`, ошибка реестра не крашит callback
  - `[medium]` `[patch]` Нет bot-level теста для `hypo_tracker:clientId` callback — добавлены 2 теста в `bot-weekly-9-7.test.ts` (happy path + error fallback); добавлен `vi.mock('./f5-hypo-tracker.js')`
  - `[low]` `[patch]` `year` не использовался в заголовке отчёта — исправлен на `нед.${week}/${year}`
  - `[low]` `[patch]` Дублированный import из `./adapters/sheets.js` — объединён в одну строку
  - `[low]` `[patch]` Отсутствовал `export type HypoTrackerConclusions` — добавлен в `types.ts`
  - `[low]` `[patch]` Test 4 не проверял сохранность существующего снимка при 0 строках — добавлен отдельный тест с pre-written snapshot
  - `[low]` `[patch]` `hypo_tracker:qubiq` не проверялась в keyboard-тесте — добавлен `expect(cbDatas).toContain('hypo_tracker:qubiq')` в test (3)
  - `[low]` `[patch]` No-change integration test (AC3) отсутствовал — добавлен тест `runHypoTracker — no changes` с проверкой weekNumber и текста «Изменений за неделю нет»

## Verification

**Commands:**
- `npm test` -- expected: все тесты зелёные (включая новые в `src/f5-hypo-tracker.test.ts` и `src/bot-weekly-9-7.test.ts`)
- `tsc --noEmit` -- expected: no type errors
- `npm run canary` -- expected: зелёный или pre-existing failure идентична baseline

## Auto Run Result

Status: done

### Summary

Реализован трекер гипотез (Story 10.5) — третий тип отчёта. Новый F5-pipeline читает лист `_hypotheses`, сравнивает с недельным снимком (delta-логика), вызывает Claude для ключевых выводов при наличии изменений, форматирует отчёт и обновляет снимок. Доставка — кнопка «🧪 Трекер гипотез» в меню клиента.

### Files changed

- `src/types.ts` — добавлены `HypoSnapshotItemSchema`, `HypoSnapshotSchema`, `HypoTrackerConclusionsSchema` и соответствующие типы
- `src/adapters/sheets.ts` — добавлена `readHypothesesSheet(clientId, logger?)` для чтения листа `_hypotheses`
- `prompts/hypo-tracker.md` — Claude-промпт для генерации ключевых выводов
- `src/f5-hypo-tracker.ts` — новый pipeline-модуль (delta, Claude, format, persist)
- `src/f5-hypo-tracker.test.ts` — 8 тестов (delta, format, first-run, no-change, empty-sheet x2, Claude failure, header_missing)
- `src/bot.ts` — кнопка и callback `hypo_tracker:{clientId}`, передача `clientName`
- `src/bot-weekly-9-7.test.ts` — 2 новых bot-level теста + расширен keyboard-тест

### Review findings breakdown

- **Patches applied (10):** clientName в pipeline [medium]; blank statement filter [medium]; getClientSheetId try/catch [medium]; bot-level tests [medium]; year в заголовке [low]; merge import [low]; type export [low]; test 4 enhancement [low]; keyboard assertion [low]; no-change integration test [low]
- **Deferred (5):** removed hypotheses not tracked; same-week overwrite; alertOps not called in HALT; now not injected; keyboard on every chunk
- **Rejected (3):** Z-column cap (pre-existing pattern); conclusions min(1) graceful degradation correct; test expansion beyond spec not a problem

### Verification

- `npm test` → 710 тестов pass (36 файлов)
- `tsc --noEmit` → чистый (exit 0)
- `npm run canary` → pre-existing failure (нет live Claude API key); идентично baseline
