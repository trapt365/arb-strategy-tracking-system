---
title: '[10.8] Трекер гипотез: структура уровня geonline'
type: 'feature'
created: '2026-07-10'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '477c928a5871dfdb2700da357cb682b679263309'
final_revision: '0e3e9ff875d97762c20d9aa05dcf306bd63deac1'
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** F5-трекер гипотез (10.5) выдаёт плоский отчёт — список с пулями, без группировки по департаментам. Сравнение с эталоном geonline («Трекер гипотез неделя 12») показало структурный разрыв: эталон = богатый Markdown-документ с шапкой, легендой, двумя таблицами на департамент, сводной матрицей и LLM-комментариями.

**Approach:** Добавить `formatHypoReportStructured` и изменить pipeline: (1) группировка по департаментам, (2) LLM-синтез комментариев на основе F1-отчётов недели, (3) доставка полного трекера файлом + компактная сводка в чат. `runHypoTracker` возвращает `{compact, full}`. Старый `formatHypoReport` переименовать в `formatHypoReportFlat`.

## Boundaries & Constraints

**Always:**
- Клиентская изоляция: только активный клиент; `clientId === 'geonline'` fallback и `GEONLINE_F0_SHEET_ID` не ломать.
- Enforcement rules: `loadPrompt`, `callClaude`, `withRetry`, `pino` с `{pipeline: 'F5', step, clientId}`.
- Обратная совместимость снимка: `HypoSnapshotItemSchema.id` — `z.string().optional()`, старый снимок без `id` продолжает работать.
- LLM-failure → строим структуру без комментариев, warn-лог, не блокируем.
- ClientContext failure (Sheets error) → fallback: responsible = department, metrics = '', CEO name = 'Руководство'; не блокируем.
- Пустой лист (0 строк) → возвращать `{compact: 'Гипотезы не найдены…', full: ''}`, не обновлять снимок.

**Block If:**
- Лист `_hypotheses` недоступен (`auth`/`sheet_not_found`/`header_missing`): HALT с blocking condition `hypotheses sheet unreadable — manual fix needed`.

**Never:**
- Не вызывать Google Docs API, не создавать Google Document.
- Не использовать `splitForTelegram` для полного трекера — отправлять файлом.
- Не удалять `formatHypoReportFlat` (бывший `formatHypoReport`).
- Не трогать F1-pipeline, grounding-модуль, `GEONLINE_F0_SHEET_ID`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Полный happy path | ≥2 департамента, снимок есть, ≥1 F1-отчёт | `full` = структурный Markdown с шапкой/легендой/секциями/матрицей; `compact` = сводка + топ-3; файл отправлен | — |
| Первый запуск | снимка нет | полный список без таблицы обновлений; строки «Новые» включают все гипотезы | — |
| Нет F1-отчётов за неделю | `loadWeekReports` → `[]` | структура строится, комментарии пустые | — |
| Claude failure | `withRetry` exhausted | структура без комментариев (колонки `Комментарий`, `Запуск`, `Результат`, `Следующий шаг` — пустые), warn-лог | — |
| ClientContext failure | Sheets error | fallback: responsible=dept, metrics='', CEO='Руководство' | warn-лог, продолжить |
| Гипотезы без dept | `department === null` | группа `## Прочие` | — |
| Пустой лист | 0 строк | `{compact: 'Гипотезы не найдены в листе _hypotheses.', full: ''}` | — |
| Нет `id` в листе | колонки `id` нет | генерировать: первая заглавная буква dept (latin transliteration skip → берём оригинал) + `-` + индекс (`М-1`, `М-2`…) | — |

</intent-contract>

## Code Map

- `src/types.ts:164` — после `HypoTrackerConclusions`; добавить `HypoStructuredInsightsSchema` + тип
- `src/f5-hypo-tracker.ts:73` — `formatHypoReport` → `formatHypoReportFlat` (переименование + export)
- `src/f5-hypo-tracker.ts` — добавить `formatHypoReportStructured(...)` pure-функция; изменить `runHypoTracker` return type → `{compact: string, full: string}`; добавить шаги: load ClientContext, load F1 reports, call structured Claude
- `prompts/hypo-tracker-structured.md` — новый промпт
- `src/f5-hypo-tracker.test.ts` — переименовать `formatHypoReport` → `formatHypoReportFlat`; добавить новые тесты структуры; обновить `runHypoTracker` тесты под `{compact, full}` return type
- `src/bot.ts:2211-2226` — обновить `hypo_tracker:` handler: `sendDocument` для `full` + `ctx.reply` для `compact`

## Tasks & Acceptance

**Execution:**

- `src/types.ts` — после строки 164 добавить:
  ```ts
  export const HypoStructuredInsightsSchema = z.object({
    hypoInsights: z.array(z.object({
      statement: z.string(),
      comment: z.string().optional(),
      launch: z.string().optional(),
      result: z.string().optional(),
      nextStep: z.string().optional(),
    })),
    topInsights: z.array(z.string()).min(1).max(5),
  });
  export type HypoStructuredInsights = z.infer<typeof HypoStructuredInsightsSchema>;
  ```
  Также в `HypoSnapshotItemSchema` добавить поле `id: z.string().optional()`.

- `prompts/hypo-tracker-structured.md` — создать промпт. Плейсхолдеры: `{{clientName}}`, `{{weekNumber}}`, `{{deptGroupsJson}}` (JSON массив `[{dept, hypotheses: [{statement, oldStatus, newStatus?, isNew}]}]`), `{{f1ReportsText}}` (текст F1-отчётов недели, пустая строка если нет). Просит Claude вернуть JSON по `HypoStructuredInsightsSchema`: per-hypothesis объект с `comment` (стрелка динамики + прямая речь/факт из f1), `launch`/`result`/`nextStep` (для новых), топ-инсайты (3–5 буллетов). Без markdown fences в ответе.

- `src/f5-hypo-tracker.ts` — следующие изменения:
  1. Переименовать `formatHypoReport` → `formatHypoReportFlat` (и в тесте).
  2. Добавить экспортируемую pure-функцию `formatHypoReportStructured(opts: {clientName: string; ceoName: string; week: number; year: number; items: HypoSnapshotItem[]; snapshot: HypoSnapshot | null; delta: DeltaResult | null; insights: HypoStructuredInsights | null; meetingDates: string[]})`: возвращает `{compact: string, full: string}`.
     - `full`: Markdown структуры согласно «Целевой структуре» в исходном spec (шапка 2-кол. таблица; легенда; per-dept секции с двумя таблицами; сводная матрица; ключевые выводы; сноска).
     - Группировка по `department`; гипотезы без dept → секция `## Прочие`.
     - ID: брать из `item.id` если есть, иначе `{firstCharUppercase(dept)}-{index}`.
     - `compact`: заголовок + сводная матрица одной строкой на департамент + топ-3 сигнала (из `insights.topInsights`) + `📎 Полный трекер — во вложении`.
  3. Обновить `rowsToSnapshotItems`: добавить маппинг `id: (r['id'] ?? '').trim() || undefined` (optional, без валидации min).
  4. В `runHypoTracker`: изменить return type на `Promise<{compact: string, full: string}>`. Добавить новые зависимости в `deps`: `readClientContext?: typeof readClientContext`, `loadWeekReports?: typeof loadWeekReports`.
     - Step 4 (новый, до Claude): load ClientContext через `readClientContext({clientId, logger, pipeline: 'F5'})`; при ошибке warn + fallback-объект (`ceoName = 'Руководство'`, пустые responsible/metrics).
     - Step 5 (новый): load F1 reports через `loadWeekReports(clientId, {now, rootDir})`; при ошибке warn + `[]`. Сформировать `f1ReportsText` = join section contents через `\n\n`.
     - Step 6 (Claude): вызов нового промпта `hypo-tracker-structured`, схема `HypoStructuredInsightsSchema`; failure → `insights = null`, warn-лог.
     - Step 7 (Format): `formatHypoReportStructured({...})` → `{compact, full}`.
     - Пустой лист (0 строк) → `return {compact: 'Гипотезы не найдены в листе _hypotheses.', full: ''}`.

- `src/bot.ts` — в `hypo_tracker:` handler (строки 2211–2226):
  - Заменить `let text: string` → `let result: {compact: string, full: string}`.
  - При ошибке: `result = {compact: 'Не удалось загрузить трекер гипотез.', full: ''}`.
  - Если `result.full` не пустой: `await ctx.replyWithDocument(new InputFile(Buffer.from(result.full, 'utf8'), \`hypo-tracker-${clientId}-w${week}.md\`), {caption: 'Полный трекер гипотез'}).catch(() => {})`.
  - Затем: `await ctx.reply(result.compact, {reply_markup: kb}).catch(() => {})`.
  - Импортировать `InputFile` из `'grammy'`; получить `week` через `getISOWeekAndYear(new Date().toISOString().slice(0,10))`.

- `src/f5-hypo-tracker.test.ts` — обновить:
  1. Переименовать все `formatHypoReport` → `formatHypoReportFlat` в импортах и вызовах.
  2. Обновить тесты 4–6 (`runHypoTracker`): `result.compact` вместо `result` для строковых проверок.
  3. Добавить тесты структуры `formatHypoReportStructured`:
     - Тест A: ≥2 департамента, snapshot ≠ null, delta с изменениями → `full` содержит: шапку (таблицу с «Период»), легенду (строку «🟢 Работает»), ≥2 секций `## N.`, в каждой — «Обновления статусов» И «Новые гипотезы», сводную матрицу («Департамент | 🟢»), секцию выводов (если `insights` ≠ null). Порядок проверяется через индексы indexOf.
     - Тест B: группировка — гипотезы без `department` → секция «Прочие» в `full`.
     - Тест C: `insights = null` → структура без комментариев, колонки «Комментарий» пустые, но таблицы присутствуют.
     - Тест D: `compact` содержит название каждого dept + «📎 Полный трекер — во вложении».

**Acceptance Criteria:**

- Given тестовый вход (≥2 департамента, снимок с изменениями, ≥1 F1-отчёт), when `runHypoTracker`, then `full` содержит: шапку, легенду, ≥2 секции департаментов с обеими таблицами и точными колонками (`# | Гипотеза | Статус нед.N-1 | Статус нед.N | Комментарий`; `# | Гипотеза | Статус | Запуск | Результат / Метрика | Следующий шаг`), сводную матрицу, выводы, сноску. `compact` содержит матрицу + топ-сигналы + «во вложении».

- Given handler `hypo_tracker:clientId` в bot.ts, when `result.full` непустой, then бот отправляет `.md`-файл через `replyWithDocument` и compact сводку через `ctx.reply`. Полный трекер НЕ проходит через `splitForTelegram`.

- Given старый снимок без поля `id`, when `runHypoTracker`, then pipeline не падает (backward compat).

- Given Claude failure после `withRetry`, when `runHypoTracker`, then `full` содержит структуру (шапка, секции, матрица) с пустыми ячейками комментариев.

- Given `npm test && tsc --noEmit && npm run canary`, then зелёный (canary pre-existing failure идентична baseline).

## Spec Change Log

## Review Triage Log

### 2026-07-10 — Review pass (iteration 0, 4 reviewers: Blind Hunter · Edge Case Hunter · Verification Gap · Intent Alignment)

- intent_gap: 0
- bad_spec: 0
- patch: 6: (medium 3, low 3)
- defer: 4: (low 4)
- reject: 3
- addressed_findings:
  - `[medium]` `[patch]` Нет теста для `replyWithDocument`/`sendDocument` — AC не верифицирован; добавлен `expect(docCalls.length).toBe(1)` и `expect(payload.caption).toBe('Полный трекер гипотез')` в bot-weekly-9-7.test.ts test (1)
  - `[medium]` `[patch]` `compact` отправлялся без `splitForTelegram` — при >4096 символов Telegram вернул бы 400; bot.ts: `ctx.reply(compact)` → цикл `splitForTelegram(result.compact)`
  - `[medium]` `[patch]` Заголовок колонки обновлений: `(snapshot?.weekNumber ?? week) - 1 > 0 ? ...` давал неверный номер (для snap.wk=27 → "нед.26-1"); исправлен на `const prevWeek = snapshot?.weekNumber ?? week - 1`
  - `[low]` `[patch]` `HypoStructuredInsightsSchema.statement` без `.min(1)` — Claude мог вернуть пустую строку, ломая lookup; добавлено `.min(1)`
  - `[low]` `[patch]` `beforeEach` в bot-weekly-9-7.test.ts возвращал `string` вместо `{compact, full}` — latent trap; исправлен на `{ compact: '...', full: '' }`
  - `[low]` `[patch]` `result.full === ''` не проверялся в Test 4 (пустой лист) — добавлен `expect(result.full).toBe('')`

### 2026-07-10 — Review pass (iteration 0 follow-up, 4 reviewers: Blind Hunter · Edge Case Hunter · Verification Gap · Intent Alignment)

- intent_gap: 0
- bad_spec: 0
- patch: 5: (medium 1, low 4)
- defer: 3: (low 3)
- reject: 10
- addressed_findings:
  - `[medium]` `[patch]` Claude вызывался при `currentItems.length > 0` независимо от наличия F1-отчётов — противоречие с Design Note «LLM-блок не вызывается когда f1ReportsText пустой»; исправлено: `if (f1ReportsText.length > 0 || currentItems.length > 0)` → `if (f1ReportsText.length > 0)` в `src/f5-hypo-tracker.ts`
  - `[low]` `[patch]` `prevWeek = snapshot?.weekNumber ?? week - 1` при `snapshot=null && week=1` давало нед.0; исправлено на `week > 1 ? week - 1 : 52`
  - `[low]` `[patch]` `init = 'П'` для секции «Прочие» коллидировал с департаментами на «П» (Продажи, Поддержка…); исправлено на `'Пр'`
  - `[low]` `[patch]` Test 5 «no changes» содержал слабое утверждение `result.compact.toContain('Geonline')`; добавлены `expect(result.full).not.toBe('')` и `expect(result.full).toContain('Обновления статусов')`
  - `[low]` `[patch]` Guard `if (result.full)` в bot handler не был покрыт тестом — его удаление прошло бы незаметно; добавлен test (3) в `bot-weekly-9-7.test.ts` проверяющий `sendDocument.length === 0` при `full === ''`

## Design Notes

- Детерминированный скелет строится всегда; LLM-ячейки вставляются где доступны. Не инвертировать: структура ≠ функция LLM.
- `formatHypoReportStructured` — чистая функция (нет async, нет IO), тестируется синтетическими фикстурами без geonline данных.
- CEO-name источник: `ClientContext.stakeholders` first stakeholder with role containing «CEO» или «Генеральный»; иначе `'Руководство'`.
- `f1ReportsText` = конкатенация `sections[*].content` из F1-отчётов текущей недели; если массив пуст → пустая строка (LLM-блок не вызывается, структура без комментариев).
- Delta по department: `computeDelta` остаётся по `statement` (не меняем). Группировка delta.changed/added по `department` делается внутри `formatHypoReportStructured`.
- Матрица статусов — используем emoji-маппинг: `🟢=работает/done`, `🟡=в тесте/testing`, `🔴=не работает/failed`, `⏳=запланирована/planned`, `⛔=остановлена/stopped`, `🆕=новая`; «Всего» = count per dept; «Δ» = +added -removed (вычислить из delta per dept).

## Verification

**Commands:**
- `npm test` -- expected: все тесты зелёные (включая новые A–D в `f5-hypo-tracker.test.ts`)
- `tsc --noEmit` -- expected: no type errors
- `npm run canary` -- expected: зелёный или pre-existing failure идентична baseline

## Auto Run Result

Status: done

### Summary

Реализован обогащённый F5-трекер гипотез (Story 10.8): плоский отчёт заменён структурным Markdown-документом с шапкой, легендой, двумя таблицами на департамент, сводной матрицей, LLM-инсайтами и сноской. `runHypoTracker` теперь возвращает `{compact, full}`. Доставка — полный трекер файлом (`.md`) + компактная сводка в чат.

### Files changed

- `src/types.ts` — добавлены `id: z.string().optional()` в `HypoSnapshotItemSchema`; `HypoStructuredInsightsSchema` + `HypoStructuredInsights` тип
- `prompts/hypo-tracker-structured.md` — новый Claude-промпт для структурированных инсайтов
- `src/f5-hypo-tracker.ts` — `formatHypoReport` → `formatHypoReportFlat`; добавлены `formatHypoReportStructured`, `STATUS_EMOJI`, `statusEmoji`, `deptInitial`; `runHypoTracker` return type → `{compact, full}`, шаги 4–8; `rowsToSnapshotItems` маппит `id`
- `src/f5-hypo-tracker.test.ts` — тесты 4–6 обновлены под новый return type; добавлены Tests A–D для `formatHypoReportStructured`; добавлен `result.full === ''` в Test 4
- `src/bot.ts` — добавлен `InputFile` import; `hypo_tracker:` handler: `replyWithDocument(full)` + `splitForTelegram(compact)` loop
- `src/bot-weekly-9-7.test.ts` — тип mock исправлен на `{compact, full}`; `beforeEach` исправлен; добавлен `sendDocument` assertion в test (1)

### Review findings breakdown

- **Patches applied (6):** sendDocument test assertion [medium]; splitForTelegram для compact [medium]; column header week arithmetic [medium]; statement.min(1) в schema [low]; beforeEach mock fix [low]; result.full assertion [low]
- **Deferred (4):** removed hypotheses tracking; responsible/metrics per-dept rows; unknown status silent ⬜; auth/sheet_not_found HALT tests
- **Rejected (3):** formatHypoReportFlat kept per spec mandate; replyWithDocument errors suppressed (паттерн бота); clientId filename safety (internal data)

**Follow-up review pass (2026-07-10):**
- **Patches applied (5):** Claude trigger condition fixed [medium]; prevWeek=0 при week=1 [low]; init='Пр' для «Прочие» [low]; Test 5 усилен [low]; bot test (3) для full='' [low]
- **Deferred (3):** f1ReportsText silent degradation; HypoTrackerConclusionsSchema dead code; first-run pipeline integration test gap
- **Rejected (10):** topInsights .min(1) graceful fallback; comment optional vs template; ID counter (нет фактической коллизии); replyWithDocument silence; compact pipe format; dept='' handled; loadWeekReports now pattern; header fields already deferred; prompt language; getISOWeekAndYear cannot throw

### Verification

- `npm test` → 715 тестов pass (36 файлов)
- `tsc --noEmit` → чистый (exit 0)
- `npm run canary` → pre-existing failure (нет live Claude API key); идентично baseline

### Residual risks

- Δ в сводной матрице считает только `addedCount` (новые), не учитывает удалённые гипотезы (deferred)
- `HypoTrackerConclusionsSchema` / `HypoTrackerConclusions` — мёртвый код в types.ts (deferred)
- Нет интеграционного теста `runHypoTracker` для первого запуска с непустым листом (deferred)
