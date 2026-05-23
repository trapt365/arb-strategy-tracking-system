# Story 1.11: Canary test и golden dataset

Status: done

## Пользовательская история

Как **аналитик практики (Тимур)**,
Я хочу **прогнать production F1-pipeline на зафиксированном golden dataset (7 транскриптов Geonline, Story 0.3) и получить структурный diff + semantic-assertion verdict (PASS / REVIEW / ROLLBACK)**,
Чтобы **любое обновление модели Claude или правка `prompts/*.md` не сломала output тихо: structural diff > 30% или провал semantic-assertion → алерт и rollback на предыдущую версию промптов**.

## Контекст и границы scope

**Story 1.11** реализует FR36 + FR83 (canary test + golden dataset) и закрывает четыре отложенные карточки из `deferred-work.md`:

1. **Test infrastructure для config.ts/logger** — `deferred-work.md` lines 80, 82 («Тестовая инфраструктура появится в Story 1.11 (canary + golden dataset)»). Closed by канарей как первой регрессионной testing harness против реального Claude API.
2. **Regression test против `data/golden/transcript-N.json` + `f1-reference-N.json`** — `deferred-work.md` line 86 («Task 10.10 — pure 1.4a тесты используют тип-фикстуры. Триггер: Story 1.11»). Closed.
3. **Canary test (synthetic golden meeting)** — `deferred-work.md` line 115. Closed.
4. **Story 1.4b deferred items с trigger Story 1.11/1.12** — line 121. Не закрывается напрямую этой story, но canary становится регулярным safety net для последующих prompt-итераций.

Дополнительно: золотой набор уже создан в Story 0.3 (`data/golden/manifest.json` + `transcript-N.json` × 7 + `f1-reference-N.json` × 7, Тимур GO без правок 2026-04-20). `prompts/CHANGELOG.md` уже существует с записями v0.1.0 → v1.0.0 → v1.1.0 → v1.2.0. Story 1.11 НЕ создаёт golden dataset и НЕ создаёт CHANGELOG — она **потребляет** их.

### Что входит в Story 1.11 (production-код в `src/` + CLI tool в `scripts/`):

1. **`src/utils/canary-diff.ts`** (НОВЫЙ, ~180 LOC) — pure-функции, без I/O:
   - `computeStructuralDiff(actual, reference): StructuralDiff` — считает 8 счётчиков (см. ниже).
   - `runSemanticAssertions(actual, manifestItem): AssertionResult[]` — три семантические проверки из `manifest.json.semantic_checks` (исключая `f4_three_items` — F4 pipeline не реализован, Epic 3).
   - `classifyVerdict({diffPercent, assertions, error}): 'pass' | 'review' | 'rollback' | 'error'` — пороги 30% / 50% + assertion failures.
   - `aggregateRunVerdict(itemVerdicts[]): 'pass' | 'review' | 'rollback' | 'error'` — worst-of-all (если хоть один rollback → run rollback; хоть один review → run review; иначе pass; error если ВСЕ items в error).
   - `renderMarkdownReport(runResult, meta): string` — генерирует читаемый отчёт для Тимура (см. AC #5 формат).
   - `renderJsonReport(runResult, meta): object` — машиночитаемая версия для CI/диффинга между запусками.

2. **`src/utils/canary-diff.test.ts`** (НОВЫЙ, ~250 LOC) — vitest:
   - `computeStructuralDiff` — fixtures: identical → 0%, +1 commitment → ~12.5%, dropped section → ~12.5%, all dimensions changed → 100%.
   - `runSemanticAssertions` — pass/fail per assertion type, boundary (commitments.length === 0 при manifest.stats.commitments > 0 = fail).
   - `classifyVerdict` — granica 29.9%/30%/50%/50.1%, assertion-fail доминирует над diff.
   - `aggregateRunVerdict` — таблично-driven (pass+pass=pass, pass+review=review, review+rollback=rollback, error+pass=pass).
   - `renderMarkdownReport` — snapshot-test на fixture-run; проверка required-секций (header, table, verdict, rollback-instructions если verdict !== 'pass').
   - `renderJsonReport` — JSON schema-валидация структуры.

3. **`scripts/canary.ts`** (НОВЫЙ CLI, ~280 LOC) — orchestration:
   - CLI: `npx tsx scripts/canary.ts [--items 1,2,3] [--no-claude (dry-run на static reference)] [--out-dir data/canary-results/{ts}] [--client-id geonline]`.
   - Default: все 7 items, full Claude run, `data/canary-results/{YYYY-MM-DDTHH-mm-ss}/`.
   - **Pipeline:** для каждого выбранного item:
     1. Load `data/golden/transcript-N.json` → parse через `TranscriptSchema`.
     2. Load `data/stakeholder-map.json` + `data/okr-context.json` → собрать `ClientContext` через `ClientContextSchema.parse`.
     3. Найти `topName` из `data/golden/canary-items.json` (НОВЫЙ файл, ~7 строк JSON) по item.n. Каждая запись `{n, topName, meetingDate}`.
     4. Вызвать `runF1({transcript, clientContext, meta: {clientId, topName, meetingDate, meetingType}, deps: {rootDir: outDir, logger: childLogger}})`.
     5. Загрузить `data/golden/f1-reference-N.json` как reference.
     6. `computeStructuralDiff(runF1Result, reference)` + `runSemanticAssertions(runF1Result, manifestItem)` + `classifyVerdict`.
     7. На любой `F1PipelineError` / `AbortError` → item verdict = 'error', payload в run.errors[].
   - **Per-item timeout:** 5 мин (`AbortSignal.timeout(5 * 60_000)`). Превышение → 'error' verdict, не валит остальные items.
   - **Cost estimate:** print до старта: «7 items × ~$1.00 = ~$7 в одном full run; используй --items для subset». MVP-уровень бюджет protection — нет hard-cap, но Тимур видит cost upfront.
   - **Output:**
     - `{outDir}/report.md` — Markdown report.
     - `{outDir}/report.json` — JSON.
     - `{outDir}/item-{n}/runF1-result.json` — actual F1 output per item (для post-mortem).
     - `{outDir}/item-{n}/diff.json` — структурный diff per item.
     - stdout: финальный verdict + path к report.md.
   - **Exit code:**
     - 0 — verdict = 'pass' (всё OK).
     - 1 — verdict = 'review' (Тимур должен проверить промпты).
     - 2 — verdict = 'rollback' (нужен откат к предыдущей версии промптов).
     - 3 — все items 'error' (canary infrastructure broken, не promo issue).

4. **`data/golden/canary-items.json`** (НОВЫЙ data file, ~50 LOC JSON) — конфигурация per-item для canary:
   ```json
   {
     "_purpose": "Story 1.11 canary: topName + meetingDate per golden item. Source-of-truth для runF1 input.",
     "items": [
       { "n": 1, "topName": "Жүсіпбек", "meetingDate": "2026-04-20", "department": "Продажи + CPO" },
       { "n": 2, "topName": "Койгельдина", "meetingDate": "2026-04-20", "department": "Продажи" },
       { "n": 3, "topName": "Жүсіпбек", "meetingDate": "2026-04-20", "department": "Маркетинг + Продажи" },
       { "n": 4, "topName": "Тоқтағазинов", "meetingDate": "2026-04-20", "department": "Академия" },
       { "n": 5, "topName": "Самарханов", "meetingDate": "2026-04-20", "department": "CEO + Продажи" },
       { "n": 6, "topName": "Жүсіпбек", "meetingDate": "2026-04-20", "department": "CFO" },
       { "n": 7, "topName": "Самарханов", "meetingDate": "2026-04-20", "department": "HR + CEO" }
     ]
   }
   ```
   topName выбран из `data/stakeholder-map.json` так, чтобы он действительно встречался в commitments/citations transcript-N (см. `f1-reference-N.json.extraction.commitments[].who`). meetingDate — фиксированная исходная дата golden (Story 0.3 validation день).

5. **`package.json`** — `"canary": "tsx scripts/canary.ts"`.

6. **`.gitignore`** — добавить `data/canary-results/` (runtime, не в git).

7. **`docs/timur-ops-runbook.md`** — секция «Canary test» (≈20 строк):
   - Когда запускать (3 trigger: после prompt-правки, после обновления Claude model, ad-hoc раз в неделю на Milestone 2).
   - Команда: `npm run canary` (full) или `npm run canary -- --items 1,5` (subset для $$$ economy).
   - Интерпретация verdict + rollback procedure: `git log -- prompts/ && git checkout <prev-commit> -- prompts/` + `git commit -m "chore(prompts): rollback after canary"`. Описать ритуал записи в `prompts/CHANGELOG.md` (новая запись «Rollback YYYY-MM-DD: canary diff X% > 30%, reverted to vN»).

8. **`_bmad-output/implementation-artifacts/deferred-work.md`** — пометить **CLOSED 2026-05-2X (Story 1.11):** lines 80, 82, 86, 115.

### Что НЕ входит в Story 1.11 (явно deferred):

- **Weekly cron scheduler для canary** — Milestone 2 / Story 3.0 (Scheduler shared component) + новая интеграция. Story 1.11 MVP = manual run Тимуром по triggers (см. AC #6).
- **F4 canary** — F4 pipeline (Epic 3) ещё не реализован; `data/golden/f4-reference-N.json` существуют, но `runF4` нет в `src/`. Когда Epic 3 будет завершён, отдельная story «F4 canary» переиспользует `canary-diff.ts` через добавление branches.
- **Auto-rollback git операции** — canary НЕ выполняет `git revert` автоматически. Только print rollback procedure в stdout + runbook. Manual safety; рассмотрим автоматизацию в Phase 2 после стабилизации MVP.
- **Текстовый diff `format.report_sections[].content`** — architecture.md#Canary Test MethodDescription line 244: «Текстовые формулировки НЕ входят в diff». Только структурные счётчики.
- **Diff по `analysis.commitments_status_updates`** — Story 1.4a добавила это поле в analysis output (prompts v1.1.0), но golden references его НЕ содержат (Zod default `[]`). Canary НЕ сравнивает это поле (избегаем ложного positive). `prompts/CHANGELOG.md` v1.1.0 line 17 явно фиксирует ожидание.
- **Cost cap / budget protection (hard $5 limit per run)** — MVP-доверительная модель: Тимур видит estimate, решает сам. Защита от ANTHROPIC_API_KEY abuse — Growth.
- **Streaming Claude response** — Growth.
- **Canary historical trend (week-over-week diff)** — Phase 2; на MVP сравниваем только текущий run vs golden, не последовательные canary-runs.
- **Telegram-нотификация Тимуру при verdict=review/rollback** — `alertOps` в pipeline уже есть (Story 1.9), но canary CLI работает offline — Тимур видит exit code + report.md. Если нужно — Тимур делает manual `/upload` алерта.
- **Performance benchmarking (latency drift)** — `runF1Result.durationsMs.total` фиксируется в `report.json`, но `classifyVerdict` НЕ использует latency для verdict. Latency-tracking — Phase 2.
- **CI integration (canary as PR gate)** — нет CI/CD на MVP (architecture.md ADR-trigger «2-й разработчик»). Story 1.11 даёт `npm run canary` как foundation; CI wiring — Growth.
- **Prompt versioning by file hash** — `prompts/CHANGELOG.md` human-readable + `git log -- prompts/` достаточны на MVP. Auto-hash в metadata — Growth.

### Контракт с предыдущими и будущими stories

```typescript
// Story 0.3 устанавливает (НЕ ломаем):
// - data/golden/manifest.json структура и semantic_checks ключи — canary читает as-is.
// - data/golden/transcript-N.json через TranscriptSchema.parse — формат стабилен.
// - data/golden/f1-reference-N.json shape {extraction, analysis, format} — reference comparison.
// - prompts/*.md + CHANGELOG.md — version source-of-truth.

// Story 1.4a/1.4b устанавливают:
// - runF1 пятого aргумента (input.deps?.rootDir) для опциональной изоляции artifacts.
//   Canary использует rootDir = data/canary-results/{ts}/item-{n}/ для каждого item
//   → НЕ загрязняет data/{clientId}/ продакшеновскими prefixes.
// - analysis.commitments_status_updates default [] (Zod) — golden references compatible.
// - FormatOutput.top_message_draft optional — golden не блокируется.

// Story 1.10 устанавливает:
// - data/{slug}/ layout — canary НЕ пишет в data/geonline/ (использует canary-results/).
// - data/.scheduler-state.json + data/.backups/ — НЕ влияют на canary.
// - assertClientId — canary вызывает runF1 с 'geonline'; defense-in-depth уже встроен в F1.
// - cleanupRawFiles ignore-paths: 'canary-results' добавить В `IGNORE_TOP_DIRS` для безопасности
//   (опц., но defensive — иначе раз в день *.raw.txt в canary-results очищались бы, что НЕ нужно
//   потому что artifacts там — точка истины для post-mortem).

// Story 1.11 контракт для будущего:
// - canary-diff.ts — pure, переиспользуем для F4 (Epic 3 canary) + F3-lite (Epic 4).
// - canary-items.json shape — extension для F4 items когда Epic 3 закроется.
// - report.md формат — Тимур ожидает same layout каждый run (читаемость).
// - Story 3.0 (Scheduler) — может wire canary в cron еженедельно. canary.ts должен быть idempotent
//   и safe в repeated runs (артефакты не конфликтуют через timestamp в outDir).
// - Story 1.12 (Ops-status для Айдара) — может показать last canary verdict в [📊 Статус]
//   через чтение data/canary-results/latest/report.json. Story 1.11 НЕ создаёт `latest` symlink;
//   1.12 решит, как surface'ить (последний по timestamp).
```

## Критерии приёмки

1. **Сценарий: CLI запуск canary, full mode на 7 items** [Source: epics.md#Story 1.11 AC, architecture.md#Canary Test MethodDescription lines 234-244]
   ```
   Дано data/golden/manifest.json содержит 7 items, transcript-{1..7}.json + f1-reference-{1..7}.json существуют
   И ANTHROPIC_API_KEY валиден в .env
   И data/stakeholder-map.json + data/okr-context.json существуют
   И data/golden/canary-items.json содержит 7 записей с topName + meetingDate
   Когда `npx tsx scripts/canary.ts` выполнен (без флагов)
   Тогда stdout печатает: "Starting canary: 7 items, model=claude-sonnet-4-6, prompts=v1.2.0, estimated cost ~$7"
   И для каждого item N (1..7):
     - Load transcript-N.json + canary-items.json[N-1].topName
     - runF1({transcript, clientContext, meta:{clientId:'geonline', topName, meetingDate}, deps:{rootDir:outDir/item-N}}) выполнен
     - F1 result сохранён в {outDir}/item-N/runF1-result.json
     - computeStructuralDiff(actual, f1-reference-N.json) → diff.json
     - semantic assertions evaluated
     - verdict classified
   И финальный verdict aggregated через aggregateRunVerdict
   И {outDir}/report.md + report.json созданы
   И stdout печатает: "Verdict: <PASS|REVIEW|ROLLBACK>. Report: {outDir}/report.md"
   И exit code 0/1/2 соответствует verdict
   И НИКАКИЕ файлы НЕ создаются в data/geonline/ (изоляция через rootDir)

   Дано флаг --items 1,3,5
   Когда canary запущен
   Тогда обрабатываются ТОЛЬКО items 1, 3, 5 (не 2, 4, 6, 7)
   И stdout: "Starting canary: 3 items, estimated cost ~$3"

   Дано флаг --no-claude
   Когда canary запущен
   Тогда Claude API НЕ вызывается, runF1 пропускается
   И вместо actual используется reference как actual (diff = 0%, sanity-check ПО pipeline кода)
   И stdout: "Dry-run mode: comparing reference vs itself, expect verdict=pass"
   ```

2. **Сценарий: структурный diff по 8 счётчикам** [Source: architecture.md#Canary Test MethodDescription line 244 «Сравнение JSON-структуры: наличие/отсутствие секций, количество commitments, количество citations», epics.md#Story 1.11 AC «structural diff: наличие секций, кол-во commitments, кол-во citations»]
   ```
   Дано actual = {extraction:{commitments:[5 items], citations:[5], decisions:[5], facts:[12], speaker_check:[]},
                  analysis:{okr_coverage:[5 discussed, 4 mentioned, 38 blind_zone], alerts:[5]},
                  formattedReport:{sections:[3 items]}}
   И reference (f1-reference-1.json) = {extraction:{commitments:[5], citations:[5], decisions:[5], facts:[12]},
                                         analysis:{okr_coverage:[5 discussed, 4 mentioned, 38 blind_zone], alerts:[5]},
                                         format:{report_sections:[3]}}
   Когда computeStructuralDiff(actual, reference) выполнен
   Тогда возвращается { commitmentsDiff: 0, citationsDiff: 0, decisionsDiff: 0, factsDiff: 0,
                        alertsDiff: 0, okrDiscussedDiff: 0, okrMentionedDiff: 0, sectionsDiff: 0,
                        diffPercent: 0 }

   Дано actual.extraction.commitments = [6 items] (reference has 5)
   Когда compute
   Тогда commitmentsDiff = |6-5|/max(1,5) = 0.2 (20%)
   И diffPercent = mean of all 8 dims = 20% / 8 = 2.5% (≈ 2.5)

   Дано actual.formattedReport.partial === true (формат сломан)
   Когда compute
   Тогда sectionsDiff = 1.0 (100% — 0 actual vs N reference)
   И diffPercent учитывает sectionsDiff=1.0 → aggregate > 12%
   И отдельный флаг in diff.partialReport = true
   ```

3. **Сценарий: semantic assertions per item** [Source: data/golden/manifest.json.semantic_checks, epics.md#Story 1.11 AC «semantic assertions: commitments не пустой если есть обязательства, okr_references не пустой если есть OKR»]
   ```
   Дано manifestItem.stats.commitments = 5 (golden говорит «есть обязательства»)
   И actual.extraction.commitments.length = 4
   Когда runSemanticAssertions(actual, manifestItem)
   Тогда возвращается [{name:'commitments_not_empty_if_present', pass:true, detail:'4 commitments'}, ...]

   Дано manifestItem.stats.commitments = 5
   И actual.extraction.commitments.length = 0
   Когда run
   Тогда [{name:'commitments_not_empty_if_present', pass:false, detail:'expected non-empty (5 in golden), got 0'}]

   Дано clientContext.okrs.length > 0 (OKR-контекст присутствует)
   И actual.analysis.okr_coverage.filter(s=>s.status==='discussed'||s.status==='mentioned').length = 0
   Когда run
   Тогда [{name:'okr_references_not_empty_if_context', pass:false}]

   Дано actual.formattedReport.partial === false
   И actual.formattedReport.sections.length = 3
   Когда run
   Тогда [{name:'f1_format_three_sections', pass:true}]

   Дано actual.formattedReport.partial === true (graceful degradation Story 1.4b)
   Когда run
   Тогда [{name:'f1_format_three_sections', pass:false, detail:'partial mode: format step failed'}]

   И assertion 'f4_three_items' из manifest.json НЕ запускается (F4 не реализован — Epic 3)
   И report.md явно отмечает «F4 canary skipped (Epic 3 not yet implemented)»
   ```

4. **Сценарий: пороги verdict-классификации** [Source: epics.md#Story 1.11 AC «< 30% diff = OK, 30-50% = review, > 50% = rollback», architecture.md#Canary Test line 240]
   ```
   Дано diffPercent = 25, ноль assertion-failures, нет error
   Когда classifyVerdict
   Тогда verdict = 'pass'

   Дано diffPercent = 29.9
   Когда classify
   Тогда verdict = 'pass'

   Дано diffPercent = 30.0
   Когда classify
   Тогда verdict = 'review' (boundary inclusive)

   Дано diffPercent = 35, 0 assertions fail
   Когда classify
   Тогда verdict = 'review'

   Дано diffPercent = 50.1
   Когда classify
   Тогда verdict = 'rollback'

   Дано diffPercent = 15 (low), но ≥ 1 semantic assertion failed
   Когда classify
   Тогда verdict = 'review' (assertion-fail доминирует над низким diff)

   Дано ≥ 2 semantic assertions failed
   Когда classify
   Тогда verdict = 'rollback' (множественные failures = high confidence breakage)

   Дано runF1 throws F1PipelineError (e.g. extraction_validation, analysis_failed)
   Когда canary ловит error per-item
   Тогда verdict = 'error' для этого item; aggregate worst-of-all НЕ считает error как rollback,
     но если ВСЕ items 'error' → run verdict = 'error', exit code 3

   Aggregate worst-of-all: items=[pass, review, pass, pass, pass, pass, pass] → run='review'
   Aggregate: items=[pass, pass, rollback, pass, pass, pass, pass] → run='rollback'
   Aggregate: items=[error, pass, pass, pass, pass, pass, pass] → run='pass' (один error не валит)
   Aggregate: items=[error, error, error, error, error, error, error] → run='error', exit 3
   ```

5. **Сценарий: формат Markdown отчёта `report.md` для Тимура** [Source: epics.md#Story 1.11 AC, PRD#Operations line 661-664, UX-DR4 scannable]
   ```
   Дано canary run завершился, runResult и meta готовы
   Когда renderMarkdownReport вызван
   Тогда отчёт содержит секции в ТАКОМ порядке:

   ## Header
   - Run timestamp: 2026-05-2X HH:mm:ss Asia/Almaty
   - Model: claude-sonnet-4-6
   - Prompts version: v1.2.0 (из первой ## строки prompts/CHANGELOG.md)
   - Items run: 7 (1-7) или подмножество
   - Total Claude tokens: <input> in / <output> out
   - Estimated cost: ~$X.XX (approx via tokens × price-per-token из const)
   - Total duration: NNm NNs

   ## Verdict
   Большой эмодзи + label:
   - 🟢 **PASS** — все items < 30% diff и semantic assertions OK
   - 🟡 **REVIEW** — minimum один item 30-50% diff ИЛИ ≥1 assertion fail
   - 🔴 **ROLLBACK** — minimum один item > 50% diff ИЛИ ≥2 assertions fail
   - ⚪ **ERROR** — ВСЕ items в error state

   ## Items Summary (table)
   | # | scenario | diff% | assertions | verdict | tokens |
   |---|----------|------:|------------|---------|-------:|
   | 1 | 1:1 двух спикеров, code-switching РУС↔КАЗ | 5.2% | 3/3 ✓ | 🟢 pass | 12k/3k |
   | 2 | Группа, реструктуризация лидов | 33.5% | 3/3 ✓ | 🟡 review | 18k/4k |
   | ...

   ## Per-item Details
   ### Item 1 — verdict 🟢 pass
   - Diff dimensions: {commitments: 0%, citations: 0%, decisions: +20%, ...}
   - Assertions: ✓ commitments_not_empty_if_present, ✓ okr_references_not_empty_if_context, ✓ f1_format_three_sections
   - Pipeline tokens: in=12345, out=3456
   - Duration: 28s
   - Artifacts: data/canary-results/{ts}/item-1/

   ### Item 2 — verdict 🟡 review
   - Diff dimensions: {commitments: +50% (7 → 14), citations: +20%, ...}
   - Top 3 surprising diffs (sorted by abs change):
     1. commitments: +7 (reference 7 → actual 14) — возможно, prompt раскрутил больше микро-обязательств
     2. ...

   ## Rollback Procedure (если verdict ∈ {review, rollback})
   1. `git log -- prompts/` — найти предыдущий стабильный commit prompts.
   2. `git diff HEAD~1 -- prompts/` — что изменилось.
   3. `git checkout <prev-commit> -- prompts/` — rollback.
   4. `git commit -m "chore(prompts): rollback after canary {verdict} {ts}"`.
   5. Записать в `prompts/CHANGELOG.md` запись «Rollback YYYY-MM-DD: canary {verdict}, diff X%, отказ к vN».
   6. Перезапустить canary — verdict должен стать pass.

   ## F4 Canary
   - Skipped — F4 pipeline not yet implemented (Epic 3, Story 3.1).
   - F4 reference outputs существуют в data/golden/f4-reference-*.json, ожидают runF4().

   И отчёт читается в Telegram preview (Markdown rendering OK), max 4096 chars per section preferred но не enforced
   ```

6. **Сценарий: triggers + manual workflow (MVP)** [Source: architecture.md#Canary Test line 241-242 «(1) После обновления модели Claude (2) После изменения промптов (3) Еженедельно — Milestone 2», PRD line 682 «Canary test review: 15 мин/нед»]
   ```
   Сценарий A (после prompt-правки):
   Дано Тимур правит prompts/extraction.md, коммитит, перед PR-merge запускает `npm run canary`
   Когда canary выполнен с verdict='pass'
   Тогда Тимур мержит prompt-правку
   И отдельно фиксирует запись в prompts/CHANGELOG.md с описанием изменения

   Сценарий B (verdict=review после правки):
   Дано canary verdict='review' с diff=42%
   Когда Тимур видит report.md
   Тогда Тимур анализирует item-level diffs, корректирует промпт, перезапускает canary
   ИЛИ принимает «accept new baseline»: перегенерирует data/golden/f1-reference-N.json
   через `npx tsx scripts/build-golden-dataset.ts` (Story 0.3) после ручной валидации output'ов

   Сценарий C (verdict=rollback):
   Дано canary verdict='rollback' (diff=65%)
   Когда Тимур видит report.md
   Тогда выполняет Rollback Procedure из report.md (5 шагов)
   И перезапускает canary — verdict должен стать pass на предыдущей версии промптов

   Сценарий D (Claude API outage):
   Дано Claude возвращает 5xx на 5 из 7 items
   Когда canary завершается
   Тогда report.md verdict='pass' (2 pass + 5 error; ни одного rollback/review)
   И report показывает «5 items in error state — Claude API instability, re-run when API stable»
   И exit code 0 (НЕ exit 3, потому что ≥ 1 item успешный)
   И Тимур видит warning в stdout: «5 items in error — likely API issue, re-run»

   Сценарий E (weekly Milestone 2 — за пределами Story 1.11 scope):
   Manual run в Понедельник 9:00 Asia/Almaty (через cron на Story 3.0 future)
   Story 1.11 НЕ внедряет cron; Тимур ручной запускает раз в неделю если хочется
   ```

7. **Сценарий: rootDir изоляция artifacts (НЕ загрязнять data/geonline/)** [Source: Story 1.10 path layout invariant, deferred-work.md line 80 «config.ts любой импортёр не может быть unit-тестирован»]
   ```
   Дано canary запущен с outDir = data/canary-results/2026-05-2X-T-14-30-00/
   Когда runF1 вызван с deps.rootDir = outDir/item-N
   Тогда персистенс-функции (persistStep, persistMeta, persistDeliveryReport, persistCommitmentsUpdates)
     пишут в outDir/item-N/geonline/{meetingDate}/ (не в production data/geonline/)
   И data/geonline/ остаётся нетронутым после canary run (если ранее не существовал — НЕ создаётся)
   И cleanupRawFiles из Story 1.10 НЕ затрагивает outDir (он либо НЕ в data/ root либо .gitignore'd)

   Дано Тимур запускает canary 3 раза подряд за день
   Тогда создаются 3 разных outDir (timestamp в имени)
   И ничего НЕ перезаписывается между прогонами
   И старые outDir НЕ автоматически удаляются (Тимур ручной prune через rm; auto-prune — future)

   Дано flag --out-dir /tmp/canary-test
   Тогда outDir = /tmp/canary-test (override default data/canary-results/{ts})
   И .gitignore рекомендация работает для default; custom paths — ответственность caller'а
   ```

8. **Сценарий: prompts versioning + CHANGELOG.md захвачен в report** [Source: epics.md#Story 1.11 AC «промпты версионируются в git + prompts/CHANGELOG.md», prompts/CHANGELOG.md existing structure]
   ```
   Дано prompts/CHANGELOG.md содержит:
     "# Prompt Changelog\n\n## v1.2.0 — 2026-04-30 (Story 1.4b)\n..."
   Когда canary запускается
   Тогда extractCurrentPromptVersion(prompts/CHANGELOG.md) парсит первую `## v` строку
   И возвращает 'v1.2.0'
   И report.md.header содержит «Prompts version: v1.2.0»
   И report.json.meta.promptsVersion === 'v1.2.0'

   Дано prompts/CHANGELOG.md отсутствует или пуст
   Когда parse падает
   Тогда canary НЕ падает — version='unknown', log.warn 'canary.prompts_version_unknown'

   Дано Тимур делает git tag v1.3.0 после prompt-правки
   Когда canary запускается
   Тогда report.md.header показывает 'v1.3.0' (из CHANGELOG, не git tag)
   И opportunity: Тимур видит, что CHANGELOG может рассинхронизироваться с git tag
     (мы НЕ enforce'им синхронизацию на MVP)
   ```

9. **Сценарий: graceful handling missing/corrupted golden files** [Source: defensive coding, deferred-work.md line 80 testing infrastructure]
   ```
   Дано data/golden/transcript-3.json повреждён (невалидный JSON)
   Когда canary процессит item 3
   Тогда `TranscriptSchema.parse` throws, canary ловит → item verdict = 'error'
   И stdout: "Item 3 — error: invalid transcript JSON (data/golden/transcript-3.json)"
   И продолжает items 4-7

   Дано data/golden/f1-reference-3.json отсутствует
   Когда canary читает reference
   Тогда `fs.readFile` ENOENT → item verdict = 'error'
   И stdout: "Item 3 — error: reference not found"
   И report.md: «Item 3 — error (ENOENT data/golden/f1-reference-3.json) — golden dataset incomplete?»

   Дано data/golden/canary-items.json отсутствует
   Когда canary стартует
   Тогда canary FAIL-FAST до запуска runF1 на ЛЮБОМ item: «canary-items.json required, run Story 1.11 setup»
   И exit code 1 (config error, не runtime)

   Дано data/golden/manifest.json semantic_checks отсутствует
   Когда canary стартует
   Тогда warn «using built-in defaults for semantic_checks» + продолжает с встроенными 3 правилами
   И report.md помечает: «semantic_checks из manifest НЕ использовались; built-in defaults»
   ```

10. **Сценарий: idempotency + repeated runs** [Source: defensive coding, Story 1.10 scheduler-state pattern]
    ```
    Дано canary запущен дважды подряд за минуту (2 разных outDir)
    Тогда оба run-а независимы; ни один не блокирует другой
    И НЕ модифицируется data/golden/ (read-only consumption)
    И НЕ модифицируется prompts/CHANGELOG.md (read-only consumption)

    Дано canary прерван Ctrl+C посреди item 4
    Когда повторный запуск
    Тогда новый outDir, начинает с item 1; нет partial-state pickup
    (re-run полностью — на 7 items это ~5 мин, приемлемо для canary)

    Дано ANTHROPIC_API_KEY отсутствует или невалиден
    Когда canary стартует
    Тогда fail-fast при первом runF1: error message включает «check ANTHROPIC_API_KEY», exit 3
    ```

11. **Сценарий: cost transparency + token tracking** [Source: PRD#Cost line 700 «Weekly canary ~$2/мес»]
    ```
    Дано canary run завершился
    Когда report.json генерируется
    Тогда report.json.meta содержит:
      - totalTokens: { input: N, output: M }
      - estimatedCostUsd: (N × 0.000003 + M × 0.000015)  // Sonnet 4.6 pricing per architecture/research
      - perItem: [{n, tokens, cost}]

    Дано MVP-pricing зашит как const в canary.ts
    Когда Anthropic меняет pricing (вне нашего контроля)
    Тогда const обновляется в коде; estimated cost становится stale но НЕ ломает canary

    Дано Тимур запускает full canary 4 раза в месяц
    Когда суммирует cost
    Тогда ~$28/мес (~$7 × 4) при full pricing — но PRD line 700 ожидает ~$2/мес
    И MVP-уровень: Тимур запускает canary ad-hoc (после prompt-правки), а не weekly automated
    И report.md явно показывает cost для transparency и pricing reality check
    ```

12. **Сценарий: backward-compat — все 388+ существующих тестов зелёные + новые ~25 тестов** [regression, Story 1.10 baseline]
    ```
    Дано Story 1.1–1.10 тесты используют:
      - runF1 как high-level pipeline
      - data/golden/* как fixtures для transcript schema tests (transcript.schema.test.ts)
      - prompts/CHANGELOG.md как human-readable, не код
    Когда Story 1.11 добавления:
      - НОВЫЙ src/utils/canary-diff.ts (pure functions)
      - НОВЫЙ src/utils/canary-diff.test.ts (~25 тестов)
      - НОВЫЙ scripts/canary.ts (CLI, не импортируется production code)
      - НОВЫЙ data/golden/canary-items.json (data)
      - НОВЫЕ .gitignore + runbook + package.json entries
    Тогда:
      - npx vitest run → 388+ passed (+ ~25 canary-diff tests = ~413)
      - npx tsc --noEmit → exit 0
      - existing transcript.schema.test.ts (читает data/golden/transcript-N.json) НЕ ломается
      - НЕТ изменений в src/f1-report.ts, src/types.ts, src/adapters/*, src/bot.ts (canary НЕ модифицирует production pipeline)
    И scripts/canary.ts НЕ запускается в CI/test runner (ANTHROPIC_API_KEY required, ручной)
    И canary-diff.ts покрыт pure unit tests без I/O
    ```

## Задачи / Подзадачи

- [x] **Задача 1: `src/utils/canary-diff.ts` (НОВЫЙ) — pure diff + assertions + classifier** (АК: #2, #3, #4)
  - [x] 1.1 Создать `src/utils/canary-diff.ts` с публичным API:
    ```typescript
    export interface StructuralDiff {
      commitmentsDiff: number;     // 0..1+ (|a-r|/max(1,r))
      citationsDiff: number;
      decisionsDiff: number;
      factsDiff: number;
      alertsDiff: number;
      okrDiscussedDiff: number;
      okrMentionedDiff: number;
      sectionsDiff: number;
      diffPercent: number;          // mean × 100
      partialReport: boolean;
    }
    export interface AssertionResult {
      name: 'commitments_not_empty_if_present' | 'okr_references_not_empty_if_context' | 'f1_format_three_sections';
      pass: boolean;
      detail: string;
    }
    export type Verdict = 'pass' | 'review' | 'rollback' | 'error';
    export interface ItemVerdictInput {
      diffPercent: number;
      assertions: AssertionResult[];
      error?: { code: string; message: string };
    }
    export function computeStructuralDiff(actual, reference): StructuralDiff;
    export function runSemanticAssertions(actual, manifestItem, clientContext): AssertionResult[];
    export function classifyVerdict(input: ItemVerdictInput): Verdict;
    export function aggregateRunVerdict(items: Verdict[]): Verdict;
    export function extractCurrentPromptVersion(changelogContent: string): string | 'unknown';
    export function renderMarkdownReport(runResult: CanaryRunResult): string;
    export function renderJsonReport(runResult: CanaryRunResult): object;
    ```
  - [x] 1.2 Реализовать `computeStructuralDiff` — 8 dimensions, mean → `diffPercent`. Если `actual.formattedReport.partial === true` → `sectionsDiff = 1.0`, `partialReport = true`.
  - [x] 1.3 Реализовать `runSemanticAssertions`:
    - `commitments_not_empty_if_present`: pass если `actual.extraction.commitments.length > 0` ИЛИ `manifestItem.stats.commitments === 0`.
    - `okr_references_not_empty_if_context`: pass если `clientContext.okrs.length === 0` ИЛИ хотя бы один `okr_coverage[s].status ∈ {discussed, mentioned}`.
    - `f1_format_three_sections`: pass если `actual.formattedReport.partial === false && actual.formattedReport.sections.length === 3`.
    - `f4_three_items` НЕ запускается на MVP (note в `report.md`).
  - [x] 1.4 Реализовать `classifyVerdict`:
    ```typescript
    if (input.error) return 'error';
    const fails = input.assertions.filter(a => !a.pass).length;
    if (fails >= 2 || input.diffPercent > 50) return 'rollback';
    if (fails >= 1 || input.diffPercent >= 30) return 'review';
    return 'pass';
    ```
    NB: 30% boundary — inclusive review, 50% — exclusive (50.0% review, 50.1% rollback).
  - [x] 1.5 Реализовать `aggregateRunVerdict`:
    - Если ≥ 1 item 'rollback' → 'rollback'.
    - Иначе если ≥ 1 item 'review' → 'review'.
    - Иначе если ≥ 1 item 'pass' (даже при error в других) → 'pass'.
    - Иначе если ВСЕ items 'error' → 'error'.
  - [x] 1.6 Реализовать `extractCurrentPromptVersion(changelogContent)`:
    - regex `/^## (v\d+\.\d+\.\d+)\b/m` — первое совпадение.
    - На fail → 'unknown'.
  - [x] 1.7 Реализовать `renderMarkdownReport` + `renderJsonReport` — детерминированные (snapshot-friendly).
    - Markdown: см. AC #5 формат.
    - JSON: `{ meta: {timestamp, model, promptsVersion, ...}, items: [{n, diff, assertions, verdict, tokens, durationsMs}], aggregate: {verdict, totalTokens, estimatedCostUsd, totalDurationMs} }`.

- [x] **Задача 2: `src/utils/canary-diff.test.ts` (НОВЫЙ) — vitest** (АК: #2, #3, #4)
  - [x] 2.1 `computeStructuralDiff` тесты:
    - identical → 0%.
    - actual +1 commitment vs ref 5 → 20% / 8 dim = 2.5%.
    - actual partial=true → sectionsDiff=1.0, diffPercent ≥ 12.5%, partialReport=true.
    - actual всё пусто vs ref всё заполнено → 100%.
    - division-by-zero protection: ref=0, actual=0 → 0%; ref=0, actual=3 → 3.0 ratio (capped via max(1, ref)).
  - [x] 2.2 `runSemanticAssertions`:
    - 6+ tests: каждый assertion pass/fail + boundary cases (ref.commitments=0 → pass auto).
  - [x] 2.3 `classifyVerdict`:
    - 29.9%/30%/49.9%/50%/50.1% → pass/review/review/review/rollback.
    - 0 assertions failed + diff=10 → pass; 1 fail + diff=10 → review; 2 fail + diff=10 → rollback.
    - error в input → 'error' independent от diff.
  - [x] 2.4 `aggregateRunVerdict` — table-driven 8 случаев.
  - [x] 2.5 `extractCurrentPromptVersion`:
    - fixture с v1.2.0 → 'v1.2.0'.
    - empty file → 'unknown'.
    - malformed (no ## v line) → 'unknown'.
  - [x] 2.6 `renderMarkdownReport` — snapshot-test с fixture run; assert наличие секций Header/Verdict/Items Summary/Per-item Details/Rollback Procedure/F4 Canary.
  - [x] 2.7 `renderJsonReport` — schema-validate (опц. Zod schema локально в test).

- [x] **Задача 3: `data/golden/canary-items.json` (НОВЫЙ data file)** (АК: #1)
  - [x] 3.1 Создать `data/golden/canary-items.json`:
    ```json
    {
      "_purpose": "Story 1.11 canary: topName + meetingDate per golden item.",
      "_source": "Stakeholder + commitments.who из f1-reference-N.json analysis (Story 0.3).",
      "items": [
        { "n": 1, "topName": "Жүсіпбек", "meetingDate": "2026-04-20", "department": "CFO" },
        { "n": 2, "topName": "Койгельдина", "meetingDate": "2026-04-20", "department": "Продажи" },
        { "n": 3, "topName": "Жүсіпбек", "meetingDate": "2026-04-20", "department": "CFO" },
        { "n": 4, "topName": "Тоқтағазинов", "meetingDate": "2026-04-20", "department": "CPO" },
        { "n": 5, "topName": "Самарханов", "meetingDate": "2026-04-20", "department": "CEO" },
        { "n": 6, "topName": "Жүсіпбек", "meetingDate": "2026-04-20", "department": "CFO" },
        { "n": 7, "topName": "Самарханов", "meetingDate": "2026-04-20", "department": "CEO" }
      ]
    }
    ```
    **Note:** `topName` — `speaker_name` из `data/stakeholder-map.json`. Проверить, что `topName` действительно встречается в `f1-reference-N.json.extraction.commitments[].who` (хотя бы 1 commitment), иначе `loadOpenCommitments` не найдёт relevant history (на canary это не критично — pipeline всё равно отработает, но diff может быть выше).
  - [x] 3.2 Опциональная Zod-схема для canary-items.json (для fail-fast на пустые/некорректные записи):
    ```typescript
    const CanaryItemSchema = z.object({ n: z.number().int().positive(), topName: z.string().min(1), meetingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), department: z.string().optional() });
    const CanaryConfigSchema = z.object({ items: z.array(CanaryItemSchema).min(1) });
    ```
    Локальная схема в `scripts/canary.ts` — НЕ в `src/types.ts` (canary НЕ production type).

- [x] **Задача 4: `scripts/canary.ts` (НОВЫЙ CLI)** (АК: #1, #6, #7, #8, #9, #10, #11)
  - [x] 4.1 Каркас CLI:
    ```typescript
    interface CanaryArgs { items?: number[]; outDir?: string; noClaude?: boolean; clientId?: string; }
    function parseArgs(argv: string[]): CanaryArgs { ... }
    ```
    Парсить `--items 1,3,5`, `--out-dir path`, `--no-claude`, `--client-id`, `--help`.
  - [x] 4.2 Pre-flight checks:
    - Загрузить `data/golden/manifest.json` через `JSON.parse` (fail-fast если отсутствует).
    - Загрузить `data/golden/canary-items.json` через `CanaryConfigSchema.parse` (fail-fast если отсутствует или невалиден).
    - Загрузить `prompts/CHANGELOG.md` (warn-only если отсутствует — promptsVersion='unknown').
    - Если `!args.noClaude` → проверить `process.env.ANTHROPIC_API_KEY` (fail-fast если empty).
    - Создать outDir (`fs.mkdir(outDir, {recursive:true})`).
  - [x] 4.3 Стартовый stdout summary:
    ```
    🐤 Canary test starting
    - Model: claude-sonnet-4-6
    - Prompts: v1.2.0 (from prompts/CHANGELOG.md)
    - Items: 1,2,3,4,5,6,7 (7 total)
    - Output: data/canary-results/2026-05-2X-T-14-30-00
    - Estimated cost: ~$7 (7 × ~$1/item)
    ```
  - [x] 4.4 Per-item processing loop:
    ```typescript
    for (const n of selectedItems) {
      try {
        const transcript = TranscriptSchema.parse(JSON.parse(await fs.readFile(`data/golden/transcript-${n}.json`, 'utf8')));
        // metadata.date может быть строкой 'unknown' (Story 0.3 stub) — override on canary-item.meetingDate
        if (transcript.metadata.date === 'unknown' || !transcript.metadata.date) {
          transcript.metadata.date = `${item.meetingDate}T08:00:00+05:00`;
        }
        const clientContext = buildClientContext(args.clientId); // из stakeholder-map + okr-context
        const reference = JSON.parse(await fs.readFile(`data/golden/f1-reference-${n}.json`, 'utf8'));
        let actual: RunF1Result;
        if (args.noClaude) {
          actual = referenceAsRunF1Result(reference, item.topName, item.meetingDate);
        } else {
          actual = await runF1({
            transcript, clientContext,
            meta: { clientId: args.clientId, topName: item.topName, meetingDate: item.meetingDate, meetingType: 'tracking_session' },
            deps: { rootDir: join(outDir, `item-${n}`), logger: childLogger, signal: AbortSignal.timeout(5*60_000) },
          });
        }
        await fs.writeFile(join(outDir, `item-${n}`, 'runF1-result.json'), JSON.stringify(actual, null, 2));
        const diff = computeStructuralDiff(actual, reference);
        const assertions = runSemanticAssertions(actual, manifest.items.find(i=>i.n===n), clientContext);
        const verdict = classifyVerdict({ diffPercent: diff.diffPercent, assertions });
        await fs.writeFile(join(outDir, `item-${n}`, 'diff.json'), JSON.stringify({diff, assertions, verdict}, null, 2));
        runItems.push({n, scenario: manifestItem.scenario, diff, assertions, verdict, tokens: actual.tokens, durationsMs: actual.durationsMs});
      } catch (err) {
        runItems.push({n, scenario, verdict: 'error', error: {code: err instanceof F1PipelineError ? err.code : 'unknown', message: String(err?.message ?? err)}});
        log.warn({err, step:'canary.item_failed', n}, 'canary item failed');
      }
    }
    ```
  - [x] 4.5 Aggregate verdict + render reports:
    ```typescript
    const runVerdict = aggregateRunVerdict(runItems.map(i=>i.verdict));
    const reportMd = renderMarkdownReport({items: runItems, verdict: runVerdict, meta: {...}});
    const reportJson = renderJsonReport({items: runItems, verdict: runVerdict, meta: {...}});
    await fs.writeFile(join(outDir, 'report.md'), reportMd);
    await fs.writeFile(join(outDir, 'report.json'), JSON.stringify(reportJson, null, 2));
    console.log(`Verdict: ${runVerdict.toUpperCase()}. Report: ${join(outDir, 'report.md')}`);
    process.exit({pass:0, review:1, rollback:2, error:3}[runVerdict]);
    ```
  - [x] 4.6 `buildClientContext(clientId)`:
    - Прочитать `data/stakeholder-map.json` + `data/okr-context.json`.
    - Конвертация snake_case → camelCase (`kr_number` → `krNumber`).
    - `ClientContextSchema.parse({clientId, stakeholders, okrs, f5Metrics: [], readAt: new Date().toISOString()})`.
    - Аналогично `scripts/f1-smoke.ts:60-77`.
  - [x] 4.7 `referenceAsRunF1Result(reference, topName, meetingDate)`:
    - Сборка `RunF1Result`-shape объекта из golden reference (для `--no-claude` dry-run).
    - `formattedReport: { partial: false, sections: reference.format.report_sections, summaryLine: reference.format.summary_line, commitments: reference.extraction.commitments, alerts: reference.analysis.alerts, ... }`.
    - Used для CI sanity-check без Claude (diff sample test).
  - [x] 4.8 Логирование через `logger.child({pipeline:'CANARY', step:'canary.<step>'})` — fail / item-start / item-done / run-done.

- [x] **Задача 5: `package.json` + `.gitignore` + smoke** (АК: #1, #12)
  - [x] 5.1 Добавить в `package.json` scripts:
    ```json
    "canary": "tsx scripts/canary.ts"
    ```
  - [x] 5.2 Добавить в `.gitignore`:
    ```
    # Story 1.11: canary run outputs
    data/canary-results/
    ```
  - [x] 5.3 Smoke-проверка (manual, не в CI):
    - `npm run canary -- --no-claude --items 1` — должен пройти за < 5 сек, verdict=pass, exit 0. **Проверено: `--no-claude --items 1,2` за <1с, verdict=PASS, exit 0.**
    - `npm run canary -- --items 1` — реальный Claude, ~$1, ~30 сек, verdict=pass. **Skipped — требует $ + API ключ; будет выполнен Тимуром при первом use.**
  - [x] 5.4 (Опц.) Добавить `data/canary-results/` в `IGNORE_TOP_DIRS` в `src/utils/raw-cleanup.ts` (Story 1.10). **Сделано: `canary-results` добавлен в IGNORE_TOP_DIRS.**

- [x] **Задача 6: `docs/timur-ops-runbook.md` обновление** (АК: #6)
  - [x] 6.1 Добавить секцию «Canary test» (≈25 строк):
    ```
    ## Canary test

    Цель: убедиться, что промпты + модель Claude не деградировали структурно после изменений.

    **Когда запускать:**
    1. После любой правки `prompts/*.md` (перед PR-merge).
    2. После уведомления Anthropic об обновлении модели (например, Claude 4.6 → 4.7).
    3. Ad-hoc раз в неделю на Milestone 2 (Story 3.0 автоматизирует через cron).

    **Команды:**
    - Full run (7 items, ~$7, ~5 мин): `npm run canary`
    - Subset (быстрее, дешевле): `npm run canary -- --items 1,3,5`
    - Dry-run без Claude (sanity-check кода): `npm run canary -- --no-claude`

    **Интерпретация verdict:**
    - 🟢 PASS (exit 0) — мерж/деплой OK.
    - 🟡 REVIEW (exit 1) — проверить report.md, item-level diffs, решить:
      (а) откатить промпт; (b) принять новый baseline через regen `npx tsx scripts/build-golden-dataset.ts`.
    - 🔴 ROLLBACK (exit 2) — выполнить Rollback Procedure из report.md (5 шагов).
    - ⚪ ERROR (exit 3) — Claude API down или canary infrastructure broken; re-run после восстановления.

    **Rollback Procedure (если verdict ∈ {review, rollback}):**
    1. `git log -- prompts/` — найти предыдущий стабильный commit.
    2. `git diff HEAD~1 -- prompts/` — что изменилось.
    3. `git checkout <prev-commit> -- prompts/` — rollback.
    4. `git commit -m "chore(prompts): rollback after canary <verdict>"`.
    5. Запись в `prompts/CHANGELOG.md`: «## Rollback YYYY-MM-DD — canary <verdict>, diff X%, реверт к vN.M.P».

    **Cost protection:**
    - PRD estimate $2/мес weekly canary — это при manual ad-hoc запусках.
    - Если запускать full раз в день — будет ~$210/мес (вне бюджета). Использовать `--items` для subset.

    **F4 canary:** ещё НЕ работает — F4 pipeline появится в Epic 3.
    ```
  - [x] 6.2 Cross-link на `prompts/CHANGELOG.md` + `data/golden/manifest.json`. **В разделе «Источники данных».**

- [x] **Задача 7: `_bmad-output/implementation-artifacts/deferred-work.md` обновление**
  - [x] 7.1 Пометить **CLOSED 2026-05-23 (Story 1.11):**
    - Line 80: «`src/config.ts` ... Тестовая инфраструктура появится в Story 1.11 (canary + golden dataset)» — **partial-closed** (canary даёт integration tests против реального Claude API; pure config.test остаётся для Story 6.x при необходимости).
    - Line 82: «AC #5 не имеет явного теста, подтверждающего паттерн `logger.child({pipeline, step, clientId})` — тесты придут со Story 1.11» — **closed** через canary CLI childLogger.
    - Line 86: «Task 10.10 — regression test против `data/golden/transcript-N.json` + `f1-reference-N.json`» — **closed**.
    - Line 115: «Canary test (synthetic golden meeting) — Story 1.11» — **closed**.
  - [x] 7.2 Остаётся deferred (НЕ закрывается этой story):
    - Line 121: «Story 1.4b deferred items с trigger Story 1.11/1.12» — большинство items зависят от Story 1.12 (ops-status для Айдара) ИЛИ Epic 3. Не в scope 1.11.
    - F4 canary (Epic 3 / Story 3.1+).
    - Weekly cron scheduling (Story 3.0).
    - Auto-rollback git ops (Phase 2).

- [x] **Задача 8: Тесты + регрессия + Sprint Status** (АК: #12)
  - [x] 8.1 `npm test` (vitest) → **427 passed (22 test files)**: 389 baseline + 38 новых canary-diff тестов. Никаких регрессий.
  - [x] 8.2 `npx tsc --noEmit` → **exit 0, clean**. Type-narrowing через `formattedReport.partial === true ? ... : ...` корректно работает.
  - [x] 8.3 Регрессионная проверка test files (НЕ должны быть затронуты): подтверждено в полном прогоне — `src/adapters/transcript.schema.test.ts`, `src/f1-report.test.ts`, `src/bot.test.ts`, `src/adapters/sheets.test.ts`, `src/utils/commitments-history.test.ts` все зелёные без модификаций.
  - [x] 8.4 Manual smoke в local env:
    - `npm run canary -- --no-claude --items 1,2 --out-dir /tmp/canary-smoke` → **exit 0, verdict=PASS, report.md/json и item-N/diff.json + runF1-result.json созданы корректно.**
    - Реальный Claude run отложен — Тимур может выполнить при первом use (требует $ + ANTHROPIC_API_KEY).
  - [x] 8.5 Обновить `sprint-status.yaml`: ready-for-dev → in-progress → review (после Task 8 завершения).
  - [x] 8.6 Заполнить Dev Agent Record (Agent Model, Debug Log, Completion Notes, File List) — см. ниже.

## Dev Notes

### Соответствие архитектуре

- **Canary Test MethodDescription (architecture.md lines 234-244):** Story 1.11 точно реализует таблицу: Вход (5 транскриптов, фактически 7 в нашем golden), Выход (structural diff per pipeline), Порог (30% / 50%), Когда запускать (3 trigger из таблицы), Кто запускает (Тимур manual), Semantic assertions (3 из 4 — F4 skipped). Структурный diff = «наличие/отсутствие секций, количество commitments, количество citations» + дополнительные счётчики (decisions, facts, alerts, okr_coverage) для робастности.
- **Pre-mortem #1 (architecture.md line 226):** «Промпты сломались тихо (модель обновилась) — Semantic assertions в canary: ‹если есть обязательства — commitments не пустой›» — точно реализуется в `runSemanticAssertions`.
- **Prompts pattern (architecture.md lines 207-209, 450-456):** Промпты в `prompts/*.md` + CHANGELOG.md + `loadPrompt()` единственный способ. Canary НЕ переопределяет loadPrompt — она запускает production `runF1` → существующий promprt-load работает.
- **Pipeline boundary (architecture.md#Architectural Boundaries):** Canary — НЕ pipeline. Это CLI-tool в `scripts/` (как `offboard-client.ts` из Story 1.10). Cross-cutting tooling, не часть бизнес-flow.
- **Adapter boundary (architecture.md#Cross-Component Dependencies):** Canary НЕ создаёт нового adapter. Использует существующие через `runF1`: `claude.ts`, `prompt-loader.ts`, `commitments-history.ts`, `client-id.ts`.
- **Cost rationale (architecture.md NFR45 + PRD line 700):** Weekly canary ~$2/мес — это при ручном запуске 1 раз/нед на 5 items. Story 1.11 не вводит автоматический cron (тот появится со Story 3.0). Cost transparency в report.md решает PRD expectation.
- **Naming (architecture.md#Naming Patterns):** kebab-case file (`canary-diff.ts`); camelCase functions; PascalCase types (`StructuralDiff`, `AssertionResult`, `Verdict`); UPPER_SNAKE constants (`THRESHOLD_REVIEW_MIN = 30`, `THRESHOLD_ROLLBACK_MIN = 50`, `PER_ITEM_TIMEOUT_MS = 5 * 60_000`).
- **Logging (architecture.md#Format Patterns line 444):** `logger.child({pipeline:'CANARY', step:'canary.<step>', clientId})`. Шаги: `canary.start`, `canary.item_start`, `canary.item_done`, `canary.item_failed`, `canary.aggregate`, `canary.report_written`.
- **«Один файл на pipeline» (architecture.md#Structure Patterns):** Canary — НЕ pipeline. ~280 LOC CLI + ~180 LOC pure helpers — приемлемо для tooling.
- **«Code review at 2-й клиент» (architecture.md#Cross-Cutting Concerns line 84):** Canary даёт первый automated проверочный механизм; code review для client isolation остаётся manual в Epic 6.

### Source tree (изменения)

| Файл | Действие | ~LOC |
|------|----------|------|
| `src/utils/canary-diff.ts` | НОВЫЙ — pure diff + assertions + classifier + renderer | +180 |
| `src/utils/canary-diff.test.ts` | НОВЫЙ — 25+ тестов | +250 |
| `scripts/canary.ts` | НОВЫЙ — CLI orchestration | +280 |
| `data/golden/canary-items.json` | НОВЫЙ data file — topName + meetingDate per item | +50 |
| `package.json` | "canary" script | +1 |
| `.gitignore` | `data/canary-results/` | +2 |
| `docs/timur-ops-runbook.md` | +Canary test section | +25 |
| `src/utils/raw-cleanup.ts` | (опц.) добавить 'canary-results' в IGNORE_TOP_DIRS | +1 |
| `_bmad-output/implementation-artifacts/deferred-work.md` | пометить 4 CLOSED карточки | ~-15 / +15 |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | lifecycle 1-11 | ~2 |

Всего ~750 LOC изменений (production tooling ~460, tests ~250, data/docs ~75). Эта story меньше Story 1.10 потому что **не модифицирует production pipeline** — она оборачивает существующий `runF1` для регрессии.

### Testing Standards

- **Vitest (existing).** Тесты `canary-diff.ts` — pure-functions, без I/O, deterministic. Snapshot для Markdown renderer (assert на наличие секций, не на точный wording).
- **НЕ запускать `scripts/canary.ts` в CI** — требует `ANTHROPIC_API_KEY` + платный Claude API. Smoke вручную через `npm run canary -- --no-claude` (dry-run) или ad-hoc local.
- **Schema-validation для canary-items.json** — локальная Zod в `scripts/canary.ts`, НЕ в `src/types.ts` (canary не часть production schemas).
- **Test data:** существующий `data/golden/` — read-only. Не создаём новых golden fixtures (это работа Story 0.3).
- **Coverage target:** все 12 AC покрыты тестами для `canary-diff.ts`. CLI `scripts/canary.ts` тестируется manual smoke + сценарий E2E с `--no-claude`.
- **Boundary cases (критично):**
  - 29.9% vs 30% — должен быть pass vs review.
  - Pure mathematics для `diffPercent` — не относительная, а аддитивная mean.
  - Division by zero: `max(1, ref)` защищает; тест ref=0 actual=3 → ratio = 3.0 (НЕ Infinity).
- **Snapshot Markdown:** обернуть в helper, чтобы snapshot не падал на каждой правке wording. Альтернатива — assert через regex на required strings («## Verdict», «## Items Summary», «## Rollback Procedure»).

### Контракты с другими stories

- **Story 0.3 (golden dataset):** Story 1.11 потребляет `data/golden/manifest.json`, `transcript-N.json`, `f1-reference-N.json`. НЕ модифицирует. Schema стабильны.
- **Story 1.1 (config):** `config.CLAUDE_MODEL` используется в `runF1` через `callClaude`. Canary не трогает config.
- **Story 1.2 (transcript adapter):** Canary использует `TranscriptSchema.parse` — никаких изменений в adapter.
- **Story 1.3 (sheets adapter):** Canary НЕ читает Sheets — она использует static fixtures `data/stakeholder-map.json` + `data/okr-context.json`. Это intentional — изоляция от production Sheets (быстрее + воспроизводимо).
- **Story 1.4a/1.4b (F1 pipeline):** Canary вызывает `runF1` без модификаций. `formattedReport: DeliveryReadyReport` shape стабилен.
- **Story 1.5/1.6/1.7 (bot/approval/delivery):** Canary НЕ запускает bot — только pipeline. Telegram side-effects не активируются.
- **Story 1.8 (first-run):** не пересекается.
- **Story 1.9 (ops):** Canary использует `pino logger.child` (как watchdog). НЕ публикует `recordOpsEvent` (это reserved для production ops, не для CI/testing).
- **Story 1.10 (data persistence):** Canary использует `runF1(deps.rootDir)` override на `data/canary-results/` — НЕ загрязняет production `data/geonline/`. `cleanupRawFiles` ignore-paths: добавить 'canary-results' (опц., defensive).
- **Story 1.12 (ops-status для Айдара):** future — может surface last canary verdict через чтение `data/canary-results/<latest>/report.json`. Story 1.11 НЕ создаёт `latest` symlink; 1.12 решит UX surface.
- **Story 1.13 (поиск отчётов):** не пересекается.
- **Story 1.14 (VPS deploy):** future — `data/canary-results/` НЕ нужен в Docker volume (developer machine artifact). Если автоматизация canary в VPS — 1.14 настроит volume.
- **Story 3.0 (Scheduler):** future — может wire weekly canary через cron. Story 1.11 даёт `npm run canary` как foundation. Scheduler shape совместим (canary — `scripts/`, scheduler триггерит как child process или импортирует `runCanary()` функцию из refactored `scripts/canary.ts`).
- **Epic 2 (F5):** не пересекается.
- **Epic 3 (F4 pipeline):** future — F4 canary переиспользует `canary-diff.ts` через добавление branches (computeF4Diff + F4 assertions).
- **Epic 4 (F3-lite):** future — аналогично F4.
- **Epic 6 (multi-client):** future — canary получит `--client-id clientB` параметр; нужна загрузка multi-client Sheets через wired adapter (вместо static fixtures).

### LLM-Dev-Agent Guardrails

- **НЕ модифицировать `src/f1-report.ts`, `src/types.ts`, `src/adapters/*`** — canary только обёртка над production `runF1`. Любая правка production кода = новый scope (не 1.11).
- **НЕ публиковать canary в production ops-channel** — `alertOps`/`recordOpsEvent` зарезервированы для production pipeline. Canary использует local stdout + report.md.
- **НЕ делать `runF1` mocked** — canary запускает РЕАЛЬНЫЙ Claude API через production pipeline. Иначе теряется смысл canary (мы НЕ проверим реальный prompt + модель behavior). Mocking — только в `canary-diff.test.ts` для pure functions.
- **НЕ перегенерировать `data/golden/f1-reference-N.json`** автоматически — golden остаётся фиксированным. Регенерация — manual через `scripts/build-golden-dataset.ts` (Story 0.3) после ручной валидации.
- **НЕ сравнивать `actual.analysis.commitments_status_updates` с golden** — Story 1.4a добавила это поле; golden не содержит. Сравнение даст ложное positive. Это поле НЕ входит в 8 dimensions.
- **НЕ сравнивать текстовое содержимое sections.content** — architecture.md line 244 явно: «Текстовые формулировки не входят в diff». Только counts и presence.
- **НЕ блокировать на одном item** — `try/catch` per item; одна failure не валит run. Aggregate verdict обрабатывает mixed results.
- **НЕ запускать canary в CI/CD автоматически** — стоимость + ANTHROPIC_API_KEY exposure риск. Manual only.
- **НЕ хранить раскрытые промпты или transcript в report.md** — `report.md` содержит ТОЛЬКО diff summary + counts. Полные responses в `item-N/runF1-result.json` (для local debug, не в git).
- **НЕ забыть defensive `clientContext.okrs.length === 0` ветку** в `okr_references_not_empty_if_context` — на static fixtures `okr-context.json` всегда есть OKR, но на hypothetical empty fixture assertion должна автоматически pass.
- **НЕ путать `metadata.date` в transcript** (string ISO datetime) и `meetingDate` в meta (string YYYY-MM-DD). Если `transcript.metadata.date === 'unknown'` (Story 0.3 golden stub) — override через canary-items.json.
- **НЕ полагаться на process working directory** — использовать `process.cwd()` или `import.meta.url`-relative paths defensively. Тестировать `npm run canary` из repo root и из subdirectory.
- **НЕ забыть `AbortSignal.timeout(5*60_000)` per item** — длинные F1 runs (90+ мин transcripts из Story 1.4a deferred) могут зависнуть; timeout даёт стабильное canary поведение.
- **НЕ удалять `data/canary-results/` автоматически** — это developer artifact для post-mortem. Manual cleanup. Опционально включить в `cleanupRawFiles` ignore-paths.
- **НЕ менять exit code semantics** — 0/1/2/3 значит pass/review/rollback/error. Это контракт для future CI/cron wiring (Story 3.0). Не переиначивать.
- **НЕ использовать `console.log` для structured output** — `pino logger` для logs, `console.log` ТОЛЬКО для CLI user-facing (start summary, final verdict, report path).
- **НЕ доверять `prompts/CHANGELOG.md` parsing — fallback 'unknown'** на любом regex fail. Не throw.

### Previous Story Intelligence (Stories 0.3, 1.4a/1.4b/1.9/1.10)

**Ключевые паттерны для переиспользования:**
- `loadPrompt()` единственный способ загрузки промптов (Story 1.4a) — canary НЕ обходит, использует через `runF1`.
- Pure-function pattern для testability (Story 1.10 `client-id.ts`, `commitments-history.ts` overlay-merge) — `canary-diff.ts` следует тому же подходу: pure logic без I/O.
- Temp-dir tests для FS-зависимых scenarios (Story 1.9, 1.10) — НЕ нужны для canary-diff (он pure); CLI smoke вручную.
- `JSON.parse(JSON.stringify(...))` pattern для deep clone test fixtures (Story 1.4b) — может пригодиться при manipulation reference data в тестах.
- `logger.child({pipeline, step, clientId})` (Story 1.9, 1.10) — canary использует pipeline='CANARY'.
- Schema-validation на boundary через Zod `.parse()` для fail-fast (Story 1.4a Zod strategy) — `canary-items.json` парсится через local Zod schema.
- `process.exit(N)` exit codes для CLI tools (Story 1.10 `offboard-client.ts` exit 0/1) — canary расширяет до 0/1/2/3 для verdict mapping.

**Review findings relevant для 1.11:**
- Story 0.3 `prompts/CHANGELOG.md` line 17: «старые F1 reference outputs в `data/golden/` НЕ содержат `commitments_status_updates`. Canary diff (Story 1.11) ожидаемо покажет небольшие изменения в analysis output из-за нового блока» — точно та проблема, которую решает scope exclusion в Story 1.11 (НЕ сравниваем это поле).
- Story 1.4a deferred: «Smart transcript trimming для context_length_exceeded» — на длинных транскриптах (> 90 мин) Claude может вернуть error. Canary timeout 5 мин per item защищает от hang; verdict='error' для такого item, не блокирует остальных.
- Story 1.4b deferred line 88: «`prompt_load AbortError` эмитит ложный alertOps» — Story 1.11 НЕ затрагивает alertOps (canary использует stdout). На future cron-wiring (Story 3.0) проблема прояснится.
- Story 1.6 review: «`isAlreadyApproved` failures должны быть log.warn, не fatal» — canary использует похожий defensive pattern: ENOENT в reference → item verdict='error', не fatal.
- Story 1.9 review: «watchdog state commit AFTER successful Telegram send» — analogous для canary: report-write ПОСЛЕ всех items processed, не во время (atomicity).
- Story 1.10 review: «scheduler runs only at exact local hours» — canary НЕ имеет timing concerns (manual trigger).

### Project Structure Notes

- 2 НОВЫХ файла в `src/utils/`: `canary-diff.ts` + `canary-diff.test.ts`. Соответствует pattern из Story 1.10 (`client-id.ts`, `raw-cleanup.ts`, `data-backup.ts`).
- 1 НОВЫЙ script: `scripts/canary.ts`. Соответствует pattern из Story 1.10 (`offboard-client.ts`) + Story 0.3 (`build-golden-dataset.ts`).
- 1 НОВЫЙ data file: `data/golden/canary-items.json`. Сосуществует с `manifest.json` (созданным в Story 0.3). НЕ модифицирует существующий manifest.
- НЕТ изменений в `src/types.ts` — canary использует local Zod schema (CanaryItemSchema) в `scripts/canary.ts`.
- НЕТ изменений в `src/config.ts` — canary читает `process.env.ANTHROPIC_API_KEY` напрямую (через `runF1` → claude.ts), не вводит новых env vars.
- `data/canary-results/` runtime, в `.gitignore`. По умолчанию timestamp-folder (UTC ISO без двоеточий — `2026-05-2X-T-14-30-00`).

### References

- [Source: _bmad-output/planning-artifacts/epics.md, Story 1.11 — lines 766-782]
- [Source: _bmad-output/planning-artifacts/epics.md, FR36 (canary test) — line 63, lines 327-330]
- [Source: _bmad-output/planning-artifacts/epics.md, FR83 (weekly canary с golden dataset) — line 110, lines 352-353]
- [Source: _bmad-output/planning-artifacts/epics.md, NFR15 (canary weekly с 5 golden) — line 135]
- [Source: _bmad-output/planning-artifacts/epics.md, NFR45/NFR46 (weekly canary ~$2/мес, 15 мин/нед) — lines 165-166]
- [Source: _bmad-output/planning-artifacts/epics.md, Story 0.3 (golden dataset creation) — lines 413-429]
- [Source: _bmad-output/planning-artifacts/prd.md, FR36 (canary test) — line 922]
- [Source: _bmad-output/planning-artifacts/prd.md, Weekly Canary Test — lines 659-665]
- [Source: _bmad-output/planning-artifacts/prd.md, Prompt Versioning — lines 667-670]
- [Source: _bmad-output/planning-artifacts/prd.md, Ops-бюджет Тимура (canary 15 мин/нед) — lines 680-687]
- [Source: _bmad-output/planning-artifacts/prd.md, Cost (canary $0.50/нед, $2/мес) — lines 693-700]
- [Source: _bmad-output/planning-artifacts/architecture.md, Canary Test MethodDescription — lines 234-244]
- [Source: _bmad-output/planning-artifacts/architecture.md, Pre-mortem #1 (semantic assertions) — line 226]
- [Source: _bmad-output/planning-artifacts/architecture.md, Quality (weekly canary) — line 59]
- [Source: _bmad-output/planning-artifacts/architecture.md, «Prompt versioning & regression» principle — line 86]
- [Source: _bmad-output/planning-artifacts/architecture.md, prompts/CHANGELOG.md location — line 705]
- [Source: _bmad-output/planning-artifacts/architecture.md, Implementation Patterns (loadPrompt enforcement) — lines 207-209, 450-456]
- [Source: data/golden/manifest.json — semantic_checks block + items[] schema]
- [Source: data/golden/f1-reference-{1..7}.json — reference outputs для structural diff]
- [Source: data/golden/transcript-{1..7}.json — input transcripts через TranscriptSchema]
- [Source: data/stakeholder-map.json — speaker_name → department mapping для topName]
- [Source: data/okr-context.json — 57 KR для OKR-coverage assertion]
- [Source: prompts/CHANGELOG.md — version capture для report.md header]
- [Source: src/f1-report.ts:1272-1410 — runF1 entry point + RunF1Result shape]
- [Source: src/types.ts:118-176 — ExtractionOutput / AnalysisOutput / FormatOutput / DeliveryReadyReport schemas]
- [Source: src/types.ts:88-95 — ClientContextSchema для buildClientContext]
- [Source: scripts/f1-smoke.ts:60-77 — pattern для buildClientContext из static fixtures]
- [Source: scripts/build-golden-dataset.ts — pattern для golden manifest consumption (Story 0.3)]
- [Source: scripts/offboard-client.ts (Story 1.10) — pattern для CLI argparsing + exit codes]
- [Source: _bmad-output/implementation-artifacts/deferred-work.md, lines 80, 82, 86, 115 — closed by Story 1.11]
- [Source: _bmad-output/implementation-artifacts/1-10-data-persistence-i-client-isolation.md — predecessor story для path layout invariants]
- [Source: _bmad-output/implementation-artifacts/1-4a-f1-izvlechenie-i-analiz.md — F1 steps 1-2 contract]
- [Source: _bmad-output/implementation-artifacts/1-4b-f1-formatirovanie-i-podgotovka-k-dostavke.md — F1 steps 3-4 + DeliveryReadyReport shape]
- [Source: docs/timur-ops-runbook.md (Story 1.9/1.10) — to extend with Canary section]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (1M context) via bmad-dev-story workflow.

### Debug Log References

- Smoke run `npm run canary -- --no-claude --items 1,2 --out-dir /tmp/canary-smoke`: PASS, exit 0, report.md + report.json + item-N/diff.json + runF1-result.json артефакты корректны. Markdown report содержит все required секции (Header / Verdict / Items Summary / Per-item Details / F4 Canary; Rollback Procedure отсутствует для PASS verdict, что соответствует спеке).
- Vitest full suite: 22 файла / 427 тестов passed. До Story 1.11 было 389 тестов; добавлено 38 новых.
- TypeScript strict: `tsc --noEmit` exit 0.
- Изначально CLI использовал `process.exit(N)` после write — pino-pretty транспорт не успевал flush в dev-режиме (`_flushSync took too long`). Переход на `process.exitCode = N` решил без потери exit-code semantics (0/1/2/3).

### Completion Notes List

- **AC #1 (CLI run на 7 items + subset + dry-run):** реализовано через `scripts/canary.ts` (~570 LOC). Flags: `--items`, `--no-claude`, `--out-dir`, `--client-id`, `--help`. Default — все items из manifest. Start-summary stdout + финальный verdict + exit-code 0/1/2/3.
- **AC #2 (structural diff по 8 счётчикам):** `computeStructuralDiff` в `src/utils/canary-diff.ts`. Каждая dimension = `|a-r|/max(1,r)` (защита от div-by-zero); `diffPercent` = mean × 100. `partialReport=true` фиксирует `sectionsDiff=1.0`.
- **AC #3 (semantic assertions):** `runSemanticAssertions` запускает три assertion из `manifest.json.semantic_checks` (`commitments_not_empty_if_present`, `okr_references_not_empty_if_context`, `f1_format_three_sections`); `f4_three_items` НЕ запускается (Epic 3), report.md явно отмечает skip.
- **AC #4 (verdict thresholds 30/50%):** `classifyVerdict` с inclusive review boundary (30.0% → review, 50.0% → review, 50.1% → rollback). `aggregateRunVerdict` — worst-of-all с error-permissive семантикой (error не валит run если есть хоть один pass).
- **AC #5 (Markdown report формат):** `renderMarkdownReport` с фиксированным порядком секций. Тестируется через 4 теста (содержание секций, отсутствие Rollback при PASS, ERROR verdict, per-item dimensions).
- **AC #6 (triggers + manual workflow):** runbook `docs/timur-ops-runbook.md` секция «Canary test» (≈70 строк) описывает 3 trigger + 4 verdict + Rollback Procedure + cost protection + источники данных + F4 deferred note.
- **AC #7 (rootDir изоляция):** CLI передаёт `deps.rootDir = outDir/item-N` в каждый `runF1` вызов; production `data/geonline/` нетронут. `data/canary-results/` в `.gitignore` + добавлен в `IGNORE_TOP_DIRS` `src/utils/raw-cleanup.ts` (defensive).
- **AC #8 (prompts version):** `extractCurrentPromptVersion` парсит первую `## v…` строку CHANGELOG; на fail → 'unknown' (без throw). Версия попадает в Markdown header и JSON meta.
- **AC #9 (graceful handling):** missing transcript/reference → item verdict='error' (F1PipelineError с reason); canary продолжает остальные items. Missing `canary-items.json` → fail-fast exit 1. Missing manifest.json — fail-fast.
- **AC #10 (idempotency):** outDir создаётся с timestamp в имени; параллельные runs не конфликтуют. Read-only consumption `data/golden/` и `prompts/CHANGELOG.md`.
- **AC #11 (cost transparency):** start-summary показывает estimated cost (`~$1/item × N`); report.md/JSON отражают actual токены и `estimatedCostUsd` через PRICING-snapshot (`$3/$15 per 1M`).
- **AC #12 (regression):** 427/427 vitest pass (+38 новых canary-diff тестов), tsc clean. Никаких изменений в production pipeline (src/f1-report.ts, src/types.ts, src/adapters/*, src/bot.ts).

**Не-обязательное расширение vs spec:**

- `referenceAsRunF1Result` упрощён до `ActualPipelineOutput`-совместимого shape (вместо полного `RunF1Result`) — pure-helpers диффа этого достаточно, типизация чище.
- CLI отвергает unknown args (`--foo` → exit 1 с usage) — defensive UX выходит за рамки spec, но дешёво.

**Несоответствие с примером task 3.1 (canary-items.json):**

- Task 3.1 предлагал topName для item 4 = `Тоқтағазинов`, но `f1-reference-4.json.extraction.commitments[].who` содержит **только** `Тұрар` (Академия). Выбран `Тұрар` чтобы `loadOpenCommitments` потенциально находил relevant history. Аналогично item 3 (Маркетинг + Продажи) — выбран `Фархатов` (Маркетинг) вместо `Жүсіпбек` (CFO) по той же логике. Items с commitments под `Speaker 1/2` (2, 5, 7) выровнены по dept-headline (CEO/Продажи/CEO).

**Deferred (out-of-scope, явно зафиксировано в story):**

- Weekly cron scheduler — Story 3.0.
- F4 canary — Epic 3 / Story 3.1+.
- Auto-rollback git ops — Phase 2.
- Cost hard-cap / budget guard — Growth.
- CI integration (canary as PR gate) — Growth.
- Telegram-нотификация Тимуру при review/rollback — Тимур видит exit code локально.

### File List

**Новые файлы:**

- `src/utils/canary-diff.ts` (~390 LOC) — pure helpers: `computeStructuralDiff`, `runSemanticAssertions`, `classifyVerdict`, `aggregateRunVerdict`, `extractCurrentPromptVersion`, `renderMarkdownReport`, `renderJsonReport` + типы.
- `src/utils/canary-diff.test.ts` (~430 LOC) — 38 vitest тестов (6 группа: diff / assertions / verdict / aggregate / version / markdown / json).
- `scripts/canary.ts` (~570 LOC) — CLI orchestration: argparse, pre-flight, per-item loop, aggregate, exit codes 0/1/2/3.
- `data/golden/canary-items.json` (12 строк JSON) — topName + meetingDate per item (1-7).

**Изменённые файлы:**

- `package.json` — добавлен script `"canary": "tsx scripts/canary.ts"`.
- `.gitignore` — `data/canary-results/` (runtime developer artifact).
- `src/utils/raw-cleanup.ts` — `'canary-results'` добавлен в `IGNORE_TOP_DIRS` (defensive).
- `docs/timur-ops-runbook.md` — новая секция «Canary test (Story 1.11)» (~70 строк).
- `_bmad-output/implementation-artifacts/deferred-work.md` — пометки CLOSED на 4 карточках (lines 80 partial / 82 / 86 / 115).
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — `1-11-canary-test-i-golden-dataset: in-progress → review`.
- `_bmad-output/implementation-artifacts/1-11-canary-test-i-golden-dataset.md` — обновлённый Status, чекбоксы задач/подзадач, Dev Agent Record, Change Log.

**Production код НЕ изменён:** `src/f1-report.ts`, `src/types.ts`, `src/adapters/*`, `src/bot.ts`, `src/config.ts`, `src/logger.ts`, `src/scheduler.ts`. Canary — pure обёртка над существующим `runF1`.

## Change Log

| Date | Author | Change |
|------|--------|--------|
| 2026-05-23 | bmad-create-story | Initial story creation (12 АК, 8 задач) |
| 2026-05-23 | bmad-dev-story (claude-opus-4-7) | Implementation complete: canary-diff.ts + tests (38), canary.ts CLI, canary-items.json, runbook section, raw-cleanup ignore, deferred-work CLOSED markers. 427/427 vitest pass; tsc clean; smoke `--no-claude` PASS. Story → review. |
