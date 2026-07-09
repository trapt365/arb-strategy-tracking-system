---
title: 'Story 9.2: [CR-3+CR-4в] Grounding — профиль клиента как единственный источник имён и названий'
type: 'feature'
created: '2026-07-09'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '5844802ad36cb5c5c818c61c42a56623dd56f250'
final_revision: '6439686df45ea3221df9bf8009c6d56db4a00079'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** F0-извлечение использует имена из LLM-экстракции для вкладок Sheets, владельцев KR и промптов — имена искажаются ASR/OCR или выдумываются LLM, хотя данные профиля (9.1) уже содержат подтверждённый трекером список топов.

**Approach:** Когда в сессии есть `profile.tops` (новый онбординг): (1) `mapOkrRows`/`mapStakeholderRows` получают опциональный список топов — owner KR сверяется с профилем, несовпадение → `🔴 <имя>`; строки стейкхолдеров засеваются из профиля первыми; персональные листы «👤» создаются по профильным именам. (2) Промпт F0-извлечения получает `{{profileParticipants}}` — список топов как якорь имён для LLM. Сессии без профиля работают как прежде.

## Boundaries & Constraints

**Always:**
- Если `session.profile?.tops` отсутствует → поведение mapOkrRows/mapStakeholderRows/ensurePersonalSheets идентично текущему (grounding conditional).
- Вся логика сверки — в новом `src/f0-grounding.ts` (чистые функции, без I/O).
- Несовпадение KR owner → `'🔴 ' + extracted` в поле `owner`; тихая замена запрещена.
- Промпт-лоадер требует все плейсхолдеры — `profileParticipants` всегда передаётся (пустая строка, когда профиля нет).
- `clientId === 'geonline'` fallback и `GEONLINE_F0_SHEET_ID` не трогать.

**Block If:**
- Для F1 (атрибуция реплик в транскрипте) потребуется отдельная история — не блокирует 9.2; grounding Sheets в 9.2 автоматически улучшает `_stakeholder_map`, которую F1 уже читает.

**Never:**
- LLM-основанное сопоставление имён (только case-insensitive + trim).
- Изменения f1-report.ts, промптов extraction.md / analysis.md — вне scope.
- Изменения F0PersistedSessionSchema или ClientCardSchema — новых полей нет.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| KR owner совпадает с топом | `kr.owner="дамир сайлов"`, tops=[{name:"Дамир Сайлов"}] | owner = "Дамир Сайлов" (из профиля), вкладка «👤 Дамир Сайлов» | — |
| KR owner не найден в профиле | `kr.owner="Д. Сайлов"`, tops=[{name:"Дамир Сайлов"}] | owner = "🔴 Д. Сайлов"; вкладки Дамира всё равно создаются (из профиля) | warn-лог |
| Нет профиля (старая сессия) | `session.profile === undefined` | mapOkrRows/mapStakeholderRows без изменений | — |
| Профиль есть, extraction.participants=[] | tops=[2 топа] | stakeholder_map = 2 строки из профиля | — |
| F0 с профилем | tops присутствуют | промпт содержит блок "Участники профиля" с именами | — |

</intent-contract>

## Code Map

- `src/f0-grounding.ts` (новый) — `groundOwnerName()`, `groundedOkrRows()`, `groundedStakeholderRows()`, `profileTopsContext()`, `profileTopNames()`
- `src/f0-sheets.ts:53–92` — `mapOkrRows(extraction, tops?)`, `mapStakeholderRows(extraction, tops?)`; `CreateClientSpreadsheetOpts` — добавить `profile?: ClientProfile`; `ensurePersonalSheets` — добавить `extraOwners?: string[]`, мёрж с profileTopNames
- `src/f0-onboarding.ts:95–148` — `RunF0DraftArgs` — добавить `profileParticipants?: string`; loadPrompt — добавить переменную
- `prompts/f0-full-extraction.md` — добавить секцию `{{profileParticipants}}` перед Инструкциями
- `src/bot.ts:2623–2680,2270,2347` — `createSheetForSession` → profile в opts; runF0FullDraftFn call sites → profileParticipants
- `src/f0-grounding.test.ts` (новый) — юнит-тесты сверки

## Tasks & Acceptance

**Execution:**
- `src/f0-grounding.ts` (новый) — реализовать: `groundOwnerName(extracted, tops)` → `{name, matched}` (case-insensitive trim; первый совпавший), `groundedOkrRows(rows, tops?)` → если tops — применить groundOwnerName к каждому `owner`, несовпадение → `'🔴 ' + extracted`; `groundedStakeholderRows(extraction, tops?)` → если tops — строки из профиля сначала, потом extraction.participants не из профиля (дедупл. по имени); `profileTopsContext(tops)` → многострочный список `- {name} ({title ?? '—'}, зона: {area ?? '—'})` для промпта; `profileTopNames(tops)` → `tops.map(t => t.name)` — ядро grounding
- `src/f0-sheets.ts` — добавить `profile?: ClientProfile` в `CreateClientSpreadsheetOpts`; изменить сигнатуры `mapOkrRows(extraction, tops?: ClientTop[])` и `mapStakeholderRows(extraction, tops?: ClientTop[])` — делегировать grounding в f0-grounding.ts; в `createClientSpreadsheet` (строки 343–344): передать `opts.profile?.tops`; обновить `uniqueOwners`: добавить `.filter(o => !o.startsWith('🔴 '))` — чтобы несовпавшие KR owner не порождали вкладки; добавить `extraOwners?: string[]` в `ensurePersonalSheets` и мёржить `[...uniqueOwners(okrRows), ...extraOwners.filter(o => !seen)]`; вызов: `ensurePersonalSheets(…, okrRows, profileTopNames(opts.profile?.tops ?? []), log)`
- `prompts/f0-full-extraction.md` + `src/f0-onboarding.ts` — в промпте перед `## Инструкции` добавить секцию: `## Контекст профиля (приоритет имён)\n\nЕсли список ниже не пустой — используй эти имена как приоритетные при заполнении participants[] и атрибуции реплик. Не выдумывай имён сверх перечисленных.\n\n{{profileParticipants}}`; в `RunF0DraftArgs` добавить `profileParticipants?: string`; loadPrompt вызов: `{ documentText, profileParticipants: args.profileParticipants ?? '' }`
- `src/bot.ts` — в `createSheetForSession`: передать `profile: session.profile` в `createClientSpreadsheetFn` (opts); в обоих вызовах `runF0FullDraftFn` (~строки 2270 и 2347): добавить `profileParticipants: session.profile?.tops?.length ? profileTopsContext(session.profile.tops) : ''` (импортировать `profileTopsContext` из `./f0-grounding.js`)
- `src/f0-grounding.test.ts` (новый) + `src/f0-sheets.test.ts` — f0-grounding.test.ts: точное совпадение, case-insensitive, нет совпадения → 🔴, пустой tops → passthrough; `groundedStakeholderRows`: профильные первыми, дедупликация; `profileTopsContext`: форматирование строк. f0-sheets.test.ts: расширить тест `uniqueOwners` — добавить кейс «🔴 Имя» фильтруется; добавить тест `mapOkrRows` с tops (совпадение + несовпадение); добавить тест `mapStakeholderRows` с tops — профильные первыми

**Acceptance Criteria:**
- Given `/confirm` с `profile.tops=[{name:"Азиза Асланова",title:"Трекер"}]` и `kr.owner="А. Асланова"` (нет точного совпадения), when создаётся Sheets, then: owner-колонка = `"🔴 А. Асланова"`, вкладка «👤 Азиза Асланова» создана (из профиля), вкладки «👤 А. Асланова» нет
- Given сессия с `profile.tops` при сборке F0 черновика, when вызывается LLM для извлечения, then промпт содержит секцию «Контекст профиля» со списком топов (проверяется в тесте f0-onboarding через mock loadPrompt)
- Given persisted сессия без `profile` (до 9.1), when `/confirm` создаёт Sheets, then поведение идентично текущему — `mapOkrRows`/`mapStakeholderRows` без grounding; весь vitest + tsc + canary зелёные

## Spec Change Log

## Review Triage Log

### 2026-07-09 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 1, low 0)
- defer: 2: (high 0, medium 1, low 1)
- reject: N (noise, pre-existing, already-handled findings)
- addressed_findings:
  - `[medium]` `[patch]` Missing test for AC1 path "profile top with no KR assignment gets a personal sheet, 🔴-owner does not" — added `createClientSpreadsheet — story 9.2 grounding (AC1)` test in `f0-sheets.test.ts` verifying `ensurePersonalSheets` extraOwners path; 621 tests pass

## Design Notes

- **Строгое совпадение имён**: case-insensitive + trim, без fuzzy-match. Намеренно: лучше увидеть 🔴 и исправить в Sheets, чем молчаливо разрешить неоднозначное совпадение.
- **ensurePersonalSheets с extraOwners**: профильные топы без KR тоже получают вкладки. `uniqueOwners` обновляется: фильтрует `🔴 ...` имена — их вкладки не создаются. Profile tops из extraOwners добавляются напрямую (дедупликация через Set).
- **Пустой profileParticipants**: промпт-лоадер требует все плейсхолдеры. При пустой строке LLM видит пустую секцию — инструкция нейтральна, не влияет на поведение.

## Verification

**Commands:**
- `npx tsc --noEmit` — expected: без ошибок
- `npm test` — expected: весь vitest зелёный (базовая линия 594 теста + новые)
- `npm run canary -- --no-claude` — expected: PASS; geonline-guardrail не тронут

## Auto Run Result

**Status:** done

**Summary:** Реализован grounding профиля клиента как единственного источника имён для всех артефактов F0: вкладки Sheets, владельцы KR, стейкхолдеры и промпт F0-извлечения теперь используют подтверждённый список топов из профиля (Story 9.1) вместо LLM-извлечённых имён.

**Files changed:**
- `src/f0-grounding.ts` (новый) — 5 чистых функций reconciliation без I/O
- `src/f0-sheets.ts` — mapOkrRows/mapStakeholderRows с опц. tops; uniqueOwners фильтрует 🔴; ensurePersonalSheets с extraOwners
- `src/f0-onboarding.ts` — profileParticipants в RunF0DraftArgs + loadPrompt
- `prompts/f0-full-extraction.md` — секция контекста профиля для LLM
- `src/bot.ts` — wire profile → createClientSpreadsheetFn; profileParticipants → оба runF0FullDraftFn
- `src/f0-grounding.test.ts` (новый) — 25 юнит-тестов
- `src/f0-onboarding.test.ts` — +1 тест profileParticipants wiring
- `src/f0-sheets.test.ts` — +10 тестов (grounding mappers + createClientSpreadsheet AC1)
- `_bmad-output/implementation-artifacts/deferred-work.md` — 2 deferred items

**Review findings:** patch 1 (medium — тест ensurePersonalSheets extraOwners через createClientSpreadsheet), defer 2 (bot wiring integration test, duplicate ternary), reject: прочие (шум, уже обработаны, pre-existing).

**Verification:** tsc clean · 621 vitest passed · canary PASS (geonline-guardrail intact)

**Residual risks:**
- Bot-level wiring of profileParticipants not integration-tested (deferred); pure function + onboarding unit tests cover the logic.
- ensurePersonalSheets counts returned include profile-extra tops (may differ from caller expectations counting KR-owners only) — documented behavior.
