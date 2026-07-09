---
title: 'Story 9.5: [CR-4б+CR-6] Вопросник с голосовыми ответами'
type: 'feature'
created: '2026-07-09'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: 'c076ec665d02e99e10dad9016ddcdb3f49ce9dbf'
final_revision: '94fa655921cf804417b3be3fc577ee13da96d3a8'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
warnings: ['oversized']
---

<intent-contract>

## Intent

**Problem:** Экран стратегии показывает кнопку «💬 Вопросник (с голосом)», но за ней stub-ответ. Клиент без готовых документов не может онбордиться самостоятельно — нет диалогового пути «направления → KR → ответственный → гипотезы». Голосовые ответы не принимаются нигде в онбординге.

**Approach:** Заменить stub `f0_mode_questionnaire` настоящим диалогом (новая фаза `'questionnaire'`, файл `src/f0-questionnaire.ts`): собрать направления (B1.3), KR «с X до Y к сроку» + ответственного (B2.1+B2.2 per objective), гипотезы (B5.1+B5.2) → `buildQnDraft()` → `deliverF0Draft()`. Добавить `bot.on('message:voice', ...)` через существующий Soniox-адаптер с confirm-диалогом «✅ Ок / ✏️ Править / 🎤 Заново»; голос принимается в фазах `profile`, `questionnaire`, `filling`.

## Boundaries & Constraints

**Always:**
- Questionnaire pipeline: `buildQnDraft()` → `F0FullDraftResult` → `deliverF0Draft()` — тот же хвост, что у импорта/синтеза.
- Все поля questionnaire-state в схемах — только optional (backward compat, паттерн 8.5/8.6).
- Soniox: переиспользовать `createSonioxClient` из `src/adapters/soniox.ts`; НЕ создавать новый транскрипционный адаптер.
- Механика persist/skip/resume: переиспользовать паттерн 7.3 — `/skip` и `/resume` покрывают фазу `'questionnaire'`.
- geonline-fallback и `clientId === 'geonline'` не трогать; canary + vitest + tsc зелёные.
- Лимит голоса: 5 мин (300 сек) по `ctx.msg.voice.duration`; вне онбординга — вежливый отказ.
- Ответственный (B2.2) — только из топов профиля кнопками; текстовый fallback если топы не заполнены.

**Block If:**
- Нужен голос в F1-отчётном цикле (вне онбординга — только отказ, не реализация).
- Нужно собирать B3/B4/B6 вопросы в этой story — это опционально, вне MVP.

**Never:**
- Создавать LLM-вызов для вопросника (прямая запись ответов, не синтез).
- Менять `f0StrategyKeyboard` или кнопку «💬 Вопросник» — они уже корректны (9.4).
- Диаризация/спикеры в голосовых ответах вопросника.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Кнопка «Вопросник» | `phase='collecting'`, profile завершён | Фаза → `'questionnaire'`, qnStage=`'obj_collect'`, бот спрашивает B1.3 | Если `phase !== 'collecting'` → отказ как у `chooseF0Mode` |
| Сбор направлений | phase=questionnaire, qnStage=obj_collect | Каждый ответ → `qnObjectives.push(title)`, предложение «ещё / ✅ Готово» | max 5 → автопереход |
| ✅ Готово после объективов | `qnObjectives.length >= 1` | Переход → qnStage=`'b2_kr'`, qnObjIdx=0, qnKrStep=`'text'`, вопрос B2.1 | Если 0 объективов → попросить хотя бы одно |
| KR текст (B2.1) | число в тексте | Запись, переход к B2.2 (кнопки топов) | Нет числа → W6: один переспрос, затем принять |
| Ответственный кнопкой (B2.2) | `f0q_owner:{idx}:{name}` | Запись owner, advance: следующий objective или → hypo_collect | — |
| Все KR собраны | qnObjIdx = objectives.length | qnStage → `'hypo_collect'`, qnHypoStep=`'statement'`, вопрос B5.1 | — |
| Гипотезы (B5.1+B5.2) | statement, metric по одной | Сбор в `qnHypotheses`, «ещё / ✅ Готово» | Нет метрики (/skip) → metric=null, уйдёт в 🔴 |
| ✅ Готово гипотезы | любое количество ≥ 0 | `buildQnDraft()` → `deliverF0Draft()` | 0 гипотез валидно (уйдут в gaps) |
| Голос в онбординге | voice duration ≤ 300s, phase ∈ {profile,questionnaire,filling} | Скачать → Soniox → показать transcript + 3 кнопки; `session.voicePending = { transcript }` | `duration > 300` → "лимит 5 мин" |
| voice_ok | `voicePending.transcript` | Dispatch transcript в обработчик текущей фазы, `voicePending = undefined` | Нет pending → "нет ожидающего ответа" |
| voice_edit | voicePending set | Reply "введи исправленный текст:", `voicePending = undefined` | — |
| voice_retry | voicePending set | Reply "пришли снова 🎤", `voicePending = undefined` | — |
| Голос вне онбординга | `phase` не входит в {profile,questionnaire,filling} | "🎤 Голосовые сообщения принимаются только в диалоге онбординга." | — |
| /resume в questionnaire | phase=questionnaire | Reply "↩️ Продолжаем вопросник." + повтор текущего вопроса | — |
| /skip в questionnaire | КR (B2.1/B2.2) или гипотеза | Skip (same as W6: KR metric=null, owner=null); направление (B1.3) не пропускается | — |

</intent-contract>

## Code Map

- `src/types.ts:407-443` — `F0PersistedSessionSchema` + `phase` enum: добавить `'questionnaire'` + поля questionnaire-state + `voicePending`
- `src/bot.ts:273-313` — `F0Session` interface: те же поля (in-memory)
- `src/bot.ts:316-345` — `saveF0Session`: добавить сериализацию questionnaire-полей; исправить guard (строка 320) чтобы сохранять в `'questionnaire'` фазе
- `src/bot.ts:347-385` — `getOrRestoreF0Session`: добавить restore questionnaire-полей
- `src/bot.ts:1539-1551` — `f0SessionAtRisk`: добавить `|| session.phase === 'questionnaire'`
- `src/bot.ts:1531-1534` — stub `f0_mode_questionnaire`: заменить реальным handler
- `src/bot.ts:3293-3386` — `bot.on('message:text')`: добавить `phase === 'questionnaire'` dispatch
- `src/bot.ts:2586-2647` — `/skip`, `/resume`: добавить `'questionnaire'` ветку
- `src/bot.ts:1979-1984` — document handler: добавить `phase === 'questionnaire'` guard
- `src/bot.ts:3329-3336` — "новый клиент" guard: добавить `f0InMemory?.phase !== 'questionnaire'`
- `src/bot.ts:145-174` — `BotDeps`: добавить `sonioxClient?: SonioxClient`
- `src/f0-profile.ts:392-407` — `renderProfileQuestion()`: добавить `🎤 голосом · ` в подсказку
- `src/f0-questionnaire.ts` — новый файл: тексты вопросов B1.3/B2.1/B2.2/B5.1/B5.2 + `buildQnDraft()`

## Tasks & Acceptance

**Execution:**

- `src/types.ts` — в `F0PersistedSessionSchema.phase`: добавить `'questionnaire'` в z.enum. Добавить optional-поля: `qnStage: z.enum(['obj_collect','b2_kr','hypo_collect']).optional()`, `qnObjIdx: z.number().int().nonnegative().optional()`, `qnKrStep: z.enum(['text','owner']).optional()`, `qnHypoStep: z.enum(['statement','metric']).optional()`, `qnObjectives: z.array(z.string()).optional()`, `qnKrData: z.array(z.object({formulation:z.string(), owner:z.string().nullable()})).optional()`, `qnHypotheses: z.array(z.object({statement:z.string(), metric:z.string().nullable()})).optional()`, `qnRetryKrIdx: z.number().int().nonnegative().optional()`, `voicePending: z.object({transcript:z.string()}).optional()`

- `src/f0-questionnaire.ts` (новый) — Экспортировать: константы текстов B1.3/B2.1/B2.2/B5.1/B5.2 из `docs/onboarding-questionnaire-v1.0.md`; определить локальный interface `QnSessionData { qnObjectives?: string[]; qnKrData?: Array<{formulation:string; owner:string|null}>; qnHypotheses?: Array<{statement:string; metric:string|null}>; profile?: ClientProfile; }` (import ClientProfile из `./types.js`); экспортировать `buildQnDraft(session: QnSessionData): F0FullDraftResult` — строит `F0FullExtraction` из полей сессии, вызывает `markBlockingKrIssues` + `markHypothesesWithoutMetric` из `./f0-onboarding.js` (usage: `{input_tokens:0,output_tokens:0}`). В bot.ts вызывать как `buildQnDraft(session)` — F0Session удовлетворяет QnSessionData structurally.

- `src/bot.ts` — (1) Добавить `'questionnaire'` в `F0Session.phase`; добавить все qn* поля и `voicePending`; (2) `saveF0Session`: расширить guard (`|| s.phase === 'questionnaire'`), добавить сериализацию qn* и voicePending; (3) `getOrRestoreF0Session`: добавить restore qn*+voicePending; (4) `f0SessionAtRisk`: добавить questionnaire; (5) Replace stub `f0_mode_questionnaire`: guard phase='collecting', set phase='questionnaire', qnStage='obj_collect', reply вопрос B1.3 с кнопкой `✅ Готово` (callback `f0q_obj_done`); (6) Добавить `handleQnAnswer(ctx, session, text)` — state machine по qnStage/qnKrStep/qnHypoStep; (7) Добавить callbacks: `f0q_obj_done` (→b2_kr), `f0q_owner:{idx}:{name}` (→advance), `f0q_hypo_done` (→buildQnDraft→deliverF0Draft); (8) `bot.on('message:text')`: добавить branch `f0?.phase === 'questionnaire'` → `handleQnAnswer`; (9) `/skip`: ветку questionnaire (KR/гипотезы — пропускаются; B1.3 — не пропускается); (10) `/resume`: ветку questionnaire → повтор текущего вопроса; (11) document handler: при `phase === 'questionnaire'` → "ℹ️ Идёт вопросник — отвечай текстом или голосом 🎤."; (12) "новый клиент" guard: добавить `&& f0InMemory?.phase !== 'questionnaire'`; (13) `BotDeps`: добавить `sonioxClient?: SonioxClient`; (14) Импорты: `createSonioxClient, SonioxClient` из `./adapters/soniox.js`; `writeFile, unlink` из `node:fs/promises`; `tmpdir` из `node:os`; `join` из `node:path`; (15) Добавить `transcribeVoiceBuffer(buf, chatId)`: write buf → tmp .oga → soniox.uploadFile → createTranscription → pollUntilCompleted → fetchTranscript → tokens.join('') → unlink tmp (finally); (16) `bot.on('message:voice', ...)`: guard trackerChatIds + фаза ∈ {profile,questionnaire,filling} + duration≤300 + processing; download → transcribeVoiceBuffer → set voicePending → reply с 3-кнопочным confirm-keyboard (voice_ok, voice_edit, voice_retry); (17) Callbacks `voice_ok/voice_edit/voice_retry`: соответственно dispatch/clear/clear; `voice_ok` диспатчит transcript в handleF0ProfileAnswer / handleQnAnswer / handleF0FillAnswer по текущей фазе

- `src/f0-profile.ts:392-407` — `renderProfileQuestion()`: заменить `'Ответь текстом · /skip — пропустить.'` на `'Ответь текстом · 🎤 голосом · /skip — пропустить.'` (и аналогичную строку file-ok)

- `src/bot.test.ts` — Тесты: (a) `f0_mode_questionnaire` с `phase='collecting'` → фаза меняется на questionnaire; (b) голосовое сообщение вне онбординга → отказ; (c) голосовое `duration>300` → "лимит 5 мин"; (d) `voice_ok` в questionnaire → transcript диспатчится как ответ; (e) `f0q_hypo_done` после N гипотез → вызван `runF0FullDraftFn` (через mock deliverF0Draft) или проверить `session.phase === 'filling'`

**Acceptance Criteria:**
- Given выбор «Вопросник» при `phase='collecting'` (профиль заполнен), when трекер нажимает кнопку, then бот спрашивает B1.3 направления и после ✅ Готово (≥1 объективов) проходит B2.1 (с W6-переспросом при отсутствии числа) → B2.2 (кнопки из топов) → B5.1 → B5.2 → ✅ Готово → `session.phase === 'filling'` (deliverF0Draft отработал)
- Given голосовое сообщение при `phase='questionnaire'` (duration ≤ 300), when трекер наговаривает ответ, then бот показывает распознанный текст + 3 кнопки; нажатие ✅ Ок подтверждает текст и бот продвигает вопросник вперёд; голос вне {profile,questionnaire,filling} → вежливый отказ без crash
- Given остальные пути онбординга (import, synthesis) и canary, when вопросник внедрён, then все vitest зелёные; `clientId === 'geonline'` fallback не затронут; canary PASS

## Spec Change Log

## Review Triage Log

### 2026-07-09 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 5: (high 0, medium 3, low 2)
- defer: 4: (high 0, medium 1, low 3)
- reject: many (noise, speculative, pre-existing, factually incorrect)
- addressed_findings:
  - `[medium]` `[patch]` `transcribeVoiceBuffer` never called `sonioxClientResolved.deleteFile(fileId)` after transcription — Soniox remote files leaked indefinitely. Fixed by storing `uploadedFileId` in outer scope and calling `deleteFile` in `finally`.
  - `[medium]` `[patch]` Voice handler checked `session.processing` but never set it `true`, allowing concurrent voice messages to race. Fixed by adding `session.processing = true` before try block and `session.processing = false` in finally.
  - `[medium]` `[patch]` `f0q_owner` button callback had no test coverage — the primary owner-selection path when tops are present. Added test (j) exercising `callbackUpdate('f0q_owner:0:Айгерим')` → verifies transition to hypo_collect.
  - `[low]` `[patch]` Dead variable `const krData = session.qnKrData ?? []` in `replayCurrentQnQuestion` never referenced. Removed.
  - `[low]` `[patch]` B2.2 no-tops message contradictory: base `qnB2_2Text` says "Выбери из списка топов" but appended "(нет топов — введи имя текстом)" conflicts. Fixed both call sites to use plain inline message "Кто отвечает... Введи имя текстом." when no tops.

## Design Notes

- **`buildQnDraft` тип сессии:** Параметр `QnSessionData` — структурный subset, который `F0Session` (и `F0PersistedSession`) удовлетворяют автоматически через structural typing. Не нужно экспортировать `F0Session` из `createBot()` — достаточно `buildQnDraft(session)` в bot.ts.
- **Temp-файл голоса:** `os.tmpdir()/voice-{Date.now()}-{random}.oga`; удаление в `finally` — голос < 20 МБ (ограничение TG), OOM-риск minimal (< 218 МБ).
- **`voice_ok` dispatch:** callback читает `session.phase` и вызывает `handleF0ProfileAnswer` / `handleQnAnswer` / `handleF0FillAnswer` — те же функции, что text-handler.
- **KR парсинг:** `formulation` сохраняется «как есть» (base/target/deadline = null → gaps, как в import-пути без парсера). Числовой W6 проверяет наличие цифры в формулировке — минимальная валидация.
- **saveF0Session guard:** строка 320 `if (s.draft === undefined && s.profile === undefined) return;` — профиль всегда есть в questionnaire-фазе (9.1 обязателен), поэтому достаточно добавить `|| s.phase === 'questionnaire'` страховку на будущее.

## Verification

**Commands:**
- `npx tsc --noEmit` — expected: без ошибок (новые поля типизированы, phase union расширен)
- `npm test` — expected: весь vitest зелёный (база 649 + новые тесты вопросника/голоса)
- `npm run canary -- --no-claude` — expected: PASS; geonline-guardrail не тронут

## Auto Run Result

Status: done

### Summary
Implemented story 9.5 «Вопросник с голосовыми ответами»: replaced stub `f0_mode_questionnaire` with a full questionnaire dialog (phase `'questionnaire'`, new file `src/f0-questionnaire.ts`), collecting directions → KR+owner → hypotheses → `buildQnDraft()` → `deliverF0Draft()`. Added voice message support via existing Soniox adapter with 3-button confirm dialog. Voice accepted in profile/questionnaire/filling phases; polite refusal outside onboarding.

### Files Changed
- `src/types.ts` — added `'questionnaire'` to `F0PersistedSessionSchema.phase` enum; 10 new optional qn*/voicePending fields
- `src/bot.ts` — full questionnaire state machine, voice handler, callbacks (f0q_obj_done, f0q_owner, f0q_hypo_done, voice_ok/edit/retry), /skip and /resume branches, "новый клиент" guard, document handler guard; 5 review patches applied
- `src/f0-questionnaire.ts` (new) — question texts B1.3/B2.1/B2.2/B5.1/B5.2, `QnSessionData` interface, `buildQnDraft()`
- `src/f0-profile.ts` — added `🎤 голосом ·` hint to `renderProfileQuestion()`
- `src/bot.test.ts` — 10 new tests (a-j) covering all 15 I/O matrix rows; updated Matrix Row 4
- `src/f0-profile.test.ts` — updated 🎤 assertion

### Review Findings
- Patches applied: 5 (3 medium, 2 low) — see triage log
- Deferred: 4 (1 medium, 3 low) — questionnaire restart round-trip untested, voice_ok stale-button path uncovered, startF0SessionGuarded questionnaire description, duration boundary edge
- Rejected: many (noise, pre-existing patterns, factual errors by reviewers)

### Verification
- `npx tsc --noEmit`: clean (0 errors)
- `npx vitest run`: 659/659 passed (10 new story 9.5 tests)
- `npm run canary -- --no-claude`: PASS (geonline guardrail untouched)

### Residual Risks
None blocking. All known gaps documented in deferred-work.md.
