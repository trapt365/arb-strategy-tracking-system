---
title: '[10.3] Багфикс grounding — флаг смешения клиентов'
type: 'bugfix'
created: '2026-07-10'
status: 'done'
baseline_revision: '0d93ba0'
final_revision: '351721f'
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** При LLM-синтезе (synthesis path) бот получает от Claude название компании из документов (`extraction.company`). Если оно расходится с `profile.companyName`, бот молча собирает OKR по чужим данным — трекер не знает о смешении клиентов.

**Approach:** После `runF0FullDraftFn` сравнить `extraction.company` с `session.profile?.companyName`. При расхождении — прервать поток, показать 🔴-сообщение с кнопками «Продолжить» / «Загружу другие». При совпадении или отсутствии данных для сравнения — поведение без изменений.

## Boundaries & Constraints

**Always:**
- Проверка только в synthesis path (после `runF0FullDraftFn` в `buildF0Draft`). Import path (`importStrategyXlsx`) и questionnaire path (`f0q_hypo_done` / `buildQnDraft`) не проверяются — нет LLM-извлечённого `company`.
- Сравнение case-insensitive + trim. «Geonline» совпадает с «geonline» → проверка прозрачна.
- Если `extraction.company === null` или `profile.companyName` пусто/undefined → пропустить проверку, продолжить штатно.
- `pendingMismatchDraft` и `companyMismatchPending` — in-memory only, не персистируются. При рестарте бота пользователь повторяет `/draft`.
- `finally { session.processing = false }` в `buildF0Draft` выполняется и в mismatch-пути — поведение без изменений.
- `deliverF0Draft` вызывается из `cmi_proceed` с `sendFirst: async (text) => { await ctx.reply(text); return true; }`.
- canary + vitest + tsc зелёные после коммита.

**Block If:**
- `deliverF0Draft` принимает `sendFirst` иначе чем `(text: string) => Promise<boolean>` — тогда тип callback нужно уточнить перед написанием кода.

**Never:**
- Не добавлять `company_mismatch` в phase enum (`F0PersistedSession`/`F0Session`) — достаточно in-memory флага.
- Не трогать import path, questionnaire path, grounding имён топов (9.2).
- Не блокировать флагом дозаполнение `/advanced` — там нет документов, mismatch не возникает.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|---|---|---|---|
| Happy path: имена совпадают | `extraction.company = 'geonline'`, `profile.companyName = 'Geonline'` | `deliverF0Draft` вызван сразу, mismatch-сообщения нет | — |
| Mismatch detected | `extraction.company = 'GeoXpert'`, `profile.companyName = 'geonline'` | Reply содержит «GeoXpert» и «geonline»; inline keyboard с `cmi_proceed` и `cmi_cancel` | — |
| `cmi_proceed` после mismatch | `session.pendingMismatchDraft` установлен | `deliverF0Draft` вызван, `session.phase === 'filling'` после | Нет сессии / нет `pendingMismatchDraft` → ℹ️ «Эта кнопка от прошлого онбординга» |
| `cmi_cancel` после mismatch | `session.pendingMismatchDraft` установлен | Reply содержит «Отменено», `session.phase === 'collecting'`, `pendingMismatchDraft` очищен | Нет сессии / нет pending → ℹ️ |
| `extraction.company === null` | LLM не извлёк компанию | `deliverF0Draft` вызван без проверки | — |
| Нет `profile.companyName` | Минимум без A1.1 | `deliverF0Draft` вызван без проверки | — |
| Stale кнопка (рестарт бота) | `cmi_proceed` / `cmi_cancel`, сессия отсутствует в памяти | ℹ️ сообщение (нет сессии → нет `pendingMismatchDraft`) | — |

</intent-contract>

## Code Map

- `src/f0-grounding.ts` — добавить `detectCompanyMismatch` (чистая функция, без I/O)
- `src/bot.ts:299` — `F0Session` interface: добавить `pendingMismatchDraft?: F0FullDraftResult; companyMismatchPending?: boolean`
- `src/bot.ts:49` — import block из `./f0-grounding.js`: добавить `detectCompanyMismatch`
- `src/bot.ts:2806` — `buildF0Draft`: после `runF0FullDraftFn` перед `deliverF0Draft` — intercept mismatch
- `src/bot.ts:~2860` — добавить handlers `cmi_proceed` и `cmi_cancel` (рядом с `f0_build`/`f0_synth_hypo`)
- `src/f0-grounding.test.ts` — добавить `describe('detectCompanyMismatch', ...)` (7 юнит-тестов)
- `src/bot.test.ts` — добавить `describe('bot — Story 10.3: grounding mismatch флаг', ...)` (5 интеграционных тестов)

## Tasks & Acceptance

**Execution:**

- `src/f0-grounding.ts` — экспортировать интерфейс `CompanyMismatch { extracted: string; profile: string }` и функцию `detectCompanyMismatch(extractedCompany: string | null, profileCompanyName: string | undefined): CompanyMismatch | null`: возвращает null если любой из аргументов null/undefined/пустая строка после trim; нормализует оба через `.trim().toLowerCase()`; возвращает null если нормализованные совпадают; иначе возвращает `{ extracted: extractedCompany, profile: profileCompanyName }` (оригинальные значения, не нормализованные — для UX-текста)

- `src/bot.ts` — в `F0Session` interface добавить два поля: `pendingMismatchDraft?: F0FullDraftResult` и `companyMismatchPending?: boolean`; в import из `./f0-grounding.js` добавить `detectCompanyMismatch`

- `src/bot.ts` — в `buildF0Draft` (synthesis path), в блоке `try`, сразу после получения `result` от `runF0FullDraftFn` (до вызова `deliverF0Draft`):
  ```
  const mismatch = detectCompanyMismatch(result.extraction.company, session.profile?.companyName);
  if (mismatch !== null) {
    await finishProgress('🧠 Черновик собран.');
    session.pendingMismatchDraft = result;
    session.companyMismatchPending = true;
    await ctx.reply(
      `🔴 Документы про «${mismatch.extracted}», клиент — «${mismatch.profile}». Чьи данные берём?`,
      { reply_markup: { inline_keyboard: [[
          { text: '✅ Это правильные документы', callback_data: 'cmi_proceed' },
          { text: '🔄 Загружу другие', callback_data: 'cmi_cancel' },
      ]] } }
    ).catch(() => {});
    return;
  }
  ```

- `src/bot.ts` — добавить `bot.callbackQuery('cmi_proceed', ...)`: answerCallbackQuery; получить сессию; если нет сессии или `!session.companyMismatchPending` или `!session.pendingMismatchDraft` → ℹ️ «Эта кнопка от прошлого онбординга. Актуальное состояние: /status.»; иначе: взять `result = session.pendingMismatchDraft`, обнулить `session.companyMismatchPending = false; session.pendingMismatchDraft = undefined`, вызвать `deliverF0Draft({ ctx, chatId, session, result, sourceNames: session.documents.map(d => d.sourceName), sendFirst: async (text) => { await ctx.reply(text).catch(() => {}); return true; } })`

- `src/bot.ts` — добавить `bot.callbackQuery('cmi_cancel', ...)`: answerCallbackQuery; получить сессию; если нет сессии или `!session.companyMismatchPending` → ℹ️ «Эта кнопка от прошлого онбординга.»; иначе: `session.companyMismatchPending = false; session.pendingMismatchDraft = undefined`; reply «↩️ Отменено. Пакет документов цел — загрузи нужные файлы и собери снова: /draft.»

- `src/f0-grounding.test.ts` — добавить `describe('detectCompanyMismatch', () => { ... })` с 7 тестами: (a) `null` компания → null; (b) `undefined` профиль → null; (c) совпадение point-exact → null; (d) совпадение case-insensitive → null; (e) расхождение → `CompanyMismatch` с `extracted` и `profile`; (f) пустая строка `extractedCompany` → null; (g) пустая строка `profileCompanyName` → null

- `src/bot.test.ts` — добавить `describe('bot — Story 10.3: grounding mismatch флаг', () => { ... })` с 5 тестами (в секции F0 онбординга, после Story 10.2):
  (a) `extraction.company = 'GeoXpert'` + `profile.companyName = 'geonline'` → reply содержит «GeoXpert» и «geonline»; `inline_keyboard` присутствует с `cmi_proceed` и `cmi_cancel`
  (b) совпадение компаний → нет reply с «GeoXpert»/«geonline»; `session.phase === 'filling'` после `/draft` + `/confirm`
  (c) `cmi_proceed` после mismatch → `session.phase === 'filling'`
  (d) `cmi_cancel` после mismatch → reply содержит «Отменено»; `session.phase === 'collecting'`
  (e) `extraction.company === null` → нет mismatch-reply; `session.phase === 'filling'` после `/confirm`

**Acceptance Criteria:**

- Given synthesis path, `extraction.company = 'GeoXpert'`, `profile.companyName = 'geonline'`, when `/draft` завершён, then бот отправляет reply с «GeoXpert» и «geonline» и inline keyboard с `cmi_proceed` / `cmi_cancel`; `deliverF0Draft` НЕ вызывается до ответа трекера

- Given mismatch-сообщение показано, when трекер нажимает `cmi_proceed`, then `deliverF0Draft` вызывается с сохранённым `pendingMismatchDraft`; `session.phase === 'filling'`; `pendingMismatchDraft` очищен

- Given mismatch-сообщение показано, when трекер нажимает `cmi_cancel`, then reply содержит «Отменено»; `session.phase === 'collecting'`; `pendingMismatchDraft === undefined`

- Given `extraction.company === null` или `profile.companyName` отсутствует, when `/draft` завершён, then mismatch-сообщение не отправляется; `deliverF0Draft` вызван без задержки

- Given регресс-тест Geonline (canary), when 10.3 внедрён, then `npm run canary` зелёный; `npm test` зелёный; `tsc --noEmit` чистый

## Design Notes

**`pendingMismatchDraft` только в памяти — осознанно.** Интервал между mismatch-предупреждением и кликом кнопки — секунды. Персистирование потребовало бы добавить в `F0PersistedSessionSchema` поле с типом `F0FullDraftResult`, что создаёт circular import (`types.ts` ← `f0-onboarding.ts`). Альтернатива — хранить только `F0FullExtraction` (уже есть в схеме), но тогда нужно пересчитывать `krIssues`/`hypothesisIssues` в `cmi_proceed`, что дублирует логику. Решение: in-memory, при рестарте — `/draft` заново.

**`finishProgress` перед reply с кнопками.** В mismatch-пути вызываем `finishProgress('🧠 Черновик собран.')` (закрываем progress-сообщение), затем `ctx.reply(...)` с inline_keyboard отдельным сообщением. Это сохраняет UX-паттерн: progress-сообщение всегда получает финальный текст.

**Компания из `extraction.company` — лучшее что есть.** F0 full extraction уже содержит `company: string | null`. Переиспользуем без нового LLM-вызова. Для проверки достаточно case-insensitive trim — вариации «ООО Гемора» vs «гемора» пропустят mismatch, это приемлемо: лучше один ложный пропуск, чем тревога на каждой сессии.

## Spec Change Log

## Review Triage Log

### 2026-07-10 — Review pass (iteration 0, 4 reviewers: Blind Hunter · Edge Case Hunter · Verification Gap · Intent Alignment)

- intent_gap: 0
- bad_spec: 0
- patch: 3: (medium 1, low 2)
- defer: 3: (low 3)
- reject: 9
- addressed_findings:
  - `[medium]` `[patch]` `cmi_proceed` не оборачивал `deliverF0Draft` в try/catch — при сбое доставки пользователь не получал ни ошибки, ни recovery. Добавлен try/catch с `f0Log.error` и reply `⚠️ Не удалось доставить черновик. Попробуй /draft заново.`
  - `[low]` `[patch]` Мёртвая переменная `const { bot, calls } = buildMismatchBot(...)` в тесте (e) — удалена.
  - `[low]` `[patch]` Отсутствовал тест для stale `cmi_cancel` — добавлен тест (g).

## Verification

**Commands:**
- `npm test` -- expected: все тесты зелёные (включая новые 10.3)
- `tsc --noEmit` -- expected: no type errors
- `npm run canary` -- expected: canary green (Geonline F1 не затронут)

## Auto Run Result

Status: done

### Summary

Добавлен grounding mismatch-флаг для synthesis path: `detectCompanyMismatch` в `f0-grounding.ts`, перехват в `buildF0Draft` перед `deliverF0Draft`, два callback-хендлера `cmi_proceed`/`cmi_cancel`. Мисматч показывает трекеру 🔴-предупреждение с inline-кнопками вместо молчаливой доставки чужих данных.

### Files changed

- `src/f0-grounding.ts` — добавлены `CompanyMismatch` interface и `detectCompanyMismatch` (чистая функция)
- `src/bot.ts` — F0Session interface + mismatch intercept + два callback-хендлера (cmi_proceed/cmi_cancel с try/catch)
- `src/f0-grounding.test.ts` — 7 unit-тестов `detectCompanyMismatch`
- `src/bot.test.ts` — 7 integration-тестов Story 10.3 (a–g)
- `_bmad-output/implementation-artifacts/spec-10-3-bagfiks-grounding-flag-smesheniya-klientov.md` — спек (этот файл)
- `_bmad-output/implementation-artifacts/deferred-work.md` — 3 новых defer-записи

### Review findings breakdown

- **Patches applied (3):** try/catch вокруг `deliverF0Draft` в `cmi_proceed` [medium]; удалена мёртвая переменная в тесте (e) [low]; добавлен тест для stale `cmi_cancel` [low]
- **Deferred (3):** повторный `/draft` перезаписывает pending молча; нет pino-логирования mismatch; import-path не проверяется (по дизайну), нет assertive теста на это
- **Rejected (9):** косметика UX-текста, избыточность флагов, теоретические race conditions, null-guard over-protection

### Follow-up review recommendation

false — патчи локальные, низкосерьёзные, поведение основного пути не изменено.

### Verification

- `tsc --noEmit` → чистый
- `npm test` → 697 тестов pass (35 файлов), +12 новых
- `npm run canary` → pre-existing failure (нет live Claude API key в среде); идентично baseline до изменений

### Residual artifacts

- `data/romashka/` — тестовый артефакт (создан тестом (b) completeProfileMinimum), не закоммичен, не удалён (per workflow)
