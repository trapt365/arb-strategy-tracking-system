---
title: 'Story 9.4: [CR-4а] Единый вход онбординга + презентации в «документах» + робастный xlsx'
type: 'feature'
created: '2026-07-09'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
final_revision: 'c6d48b40412b87760ec802191bc5034e9f568b8e'
baseline_revision: '0b2ccd4c7bfa4850b246b9107cc25a373acb5d44'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** После пилота 2026-07-09: (а) ARB xlsx отказал с `import_unmappable` — синонимы не покрывают «Стратегический трекер» формат; (б) презентации (.pptx) не принимаются; (в) после ошибки импорта нет конкретного следующего шага; (г) экран онбординга на 2 кнопки не отражает три реальных пути и не создаёт место для кнопки «Вопросник» (9.5).

**Approach:** Заменить `F0_START_TEXT` + `f0ModeKeyboard` (2 кнопки) экраном «Как заводим стратегию?» (3 кнопки: Excel / Вопросник / Документы); добавить .pptx к документальному пути через `jszip`; расширить словарь синонимов xlsx и при `import_unmappable` повторно показывать 3-кнопочный экран вместо тупика.

## Boundaries & Constraints

**Always:**
- `f0_mode_import` и `f0_mode_synthesis` callbacks не удалять — используются из кешированных сессий.
- geonline-fallback и `clientId === 'geonline'` не затрагивать.
- canary + vitest + tsc зелёные после изменений.
- Автодетект по расширению первого файла сохраняется: `.xlsx` → import, остальное → synthesis.

**Block If:**
- Нужно реализовать логику вопросника — это 9.5; в 9.4 только кнопка + stub-handler.
- Нужно декодировать PPTX структуру слайдов в OKR (кодовый маппинг слайд → KR) — это вне scope.

**Never:**
- Голос в вопроснике / профиле (9.5).
- Смешивание путей онбординга в одной сессии (правило 8.5 остаётся).
- `jszip` использовать для чего-либо кроме PPTX-распаковки.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Профиль 🔑 завершён | `phase='profile'`, минимум заполнен | `startStrategyCollection()` показывает «Как заводим стратегию?» с 3 кнопками | — |
| .pptx файл в collecting-фазе | `session.mode` = undefined / 'synthesis' | Текст извлечён, файл добавлен в `session.documents`; режим зафиксирован как 'synthesis' | `empty_document` если слайды без текста; `document_parse_failed` если zip повреждён |
| xlsx — `import_unmappable` | файл не распознан как KR-таблица | Сообщение об ошибке + f0StrategyKeyboard (3 кнопки) повторно | — |
| Кнопка «Вопросник» нажата | `f0_mode_questionnaire` callback | Stub-ответ «Вопросник — в следующем обновлении; выбери Документы или Excel» | — |
| Одиночный .pptx → /draft | `session.documents=[{pptx}]`, `session.documents.length===1` | `runF0FullDraft` вызван с `isPresentationOnly: true`; промпт содержит инструкцию «перенеси, не досочиняй» | — |

</intent-contract>

## Code Map

- `src/bot.ts:966-974` — `F0_START_TEXT` (заменить на `F0_STRATEGY_SCREEN_TEXT`)
- `src/bot.ts:1004-1007` — `f0ModeKeyboard` (2 кнопки → `f0StrategyKeyboard` с 3)
- `src/bot.ts:1125-1144` — `startStrategyCollection()` — использует новый текст/клавиатуру
- `src/bot.ts:1536-1537` — f0_mode_* callbacks (добавить `f0_mode_questionnaire` stub)
- `src/bot.ts:1895-1905` — `handleF0XlsxDocument` error path: при `import_unmappable` добавить `f0StrategyKeyboard`
- `src/bot.ts:2347,2427` — вызовы `runF0FullDraftFn` — передать `isPresentationOnly`
- `src/utils/f0-input.ts:8-74` — форматы (добавить .pptx в `F0_BINARY_EXTENSIONS`, MIME, `f0DocumentKind`)
- `src/utils/f0-document.ts:1-58` — `extractTextFromDocument` — добавить ветку 'pptx' + `extractPptxText()`
- `src/f0-import.ts:54-78` — `KR_COLUMN_SYNONYMS` — расширить
- `src/f0-onboarding.ts:95-106` — `RunF0DraftArgs` — добавить `isPresentationOnly?: boolean`
- `prompts/f0-full-extraction.md` — добавить `{{presentationHint}}` placeholder

## Tasks & Acceptance

**Execution:**
- `package.json` — добавить `"jszip": "^3.10.1"` в `dependencies`; запустить `npm install` (jszip v3 включает TypeScript types, `@types/jszip` не нужен)

- `src/utils/f0-input.ts` — добавить `.pptx` в `F0_BINARY_EXTENSIONS`; добавить MIME `'application/vnd.openxmlformats-officedocument.presentationml.presentation'` в `F0_SUPPORTED_MIMES`; в `f0DocumentKind` добавить ветку: `.pptx` или PPTX-MIME → `'pptx'`

- `src/utils/f0-document.ts` — добавить `async function extractPptxText(buf: Buffer): Promise<string>`: `JSZip.loadAsync(buf)` → собрать `ppt/slides/slide*.xml` по имени, отсортировать численно → из каждого XML извлечь текст регулярным выражением `/<a:t[^>]*>([^<]+)<\/a:t>/g` + декодировать `&amp; &lt; &gt; &apos; &quot;` → join('\n\n'); добавить `'pptx'` в `F0ExtractedDocument.kind`; в `extractTextFromDocument` добавить ветку `else if (kind === 'pptx') { text = await extractPptxText(buf); }` — те же `document_parse_failed` / `empty_document` guards

- `src/f0-onboarding.ts` — добавить `isPresentationOnly?: boolean` в `RunF0DraftArgs`; в `runF0FullDraft` передавать `presentationHint: args.isPresentationOnly ? '⚠️ Это готовая стратегия в виде презентации — переноси KR, цели и гипотезы точно, без досочинения.' : ''` в `loadPrompt`

- `prompts/f0-full-extraction.md` — в секцию «## Инструкции» после заголовка добавить: `{{presentationHint}}`

- `src/bot.ts` — заменить `F0_START_TEXT` + `f0ModeKeyboard` на:
  ```
  const F0_STRATEGY_SCREEN_TEXT = 'Как заводим стратегию?';
  const f0StrategyKeyboard = new InlineKeyboard()
    .text('📥 Готовая стратегия в Excel', 'f0_mode_import').row()
    .text('💬 Вопросник (с голосом)', 'f0_mode_questionnaire').row()
    .text('📄 Документы (протоколы, транскрипты, презентации)', 'f0_mode_synthesis');
  ```
  В `startStrategyCollection()` использовать `F0_STRATEGY_SCREEN_TEXT` + `f0StrategyKeyboard`.
  Добавить `bot.callbackQuery('f0_mode_questionnaire', async (ctx) => { await ctx.answerCallbackQuery().catch(()=>{}); await ctx.reply('💬 Вопросник появится в следующем обновлении — пока выбери 📄 Документы или 📥 Excel.').catch(()=>{}); })`.
  В `handleF0XlsxDocument` error path для `import_unmappable`: добавить `{ reply_markup: f0StrategyKeyboard }` к `ctx.reply(F0_REPLY_BY_CODE['import_unmappable'])`.
  В вызовах `runF0FullDraftFn` передавать `isPresentationOnly: session.documents.length === 1 && session.documents[0]?.sourceName.toLowerCase().endsWith('.pptx') === true`.

- `src/f0-import.ts:54-78` — расширить `KR_COLUMN_SYNONYMS`:
  - objective: добавить `'стратегическое направление'`, `'направление развития'`, `'приоритет'`
  - formulation: добавить `'задача'`, `'мероприятие'`, `'ключевая задача'`, `'показатель'`, `'kpi'`
  - target: добавить `'плановое значение'`, `'целевой показатель'`, `'ориентир'`
  - base: добавить `'текущий уровень'`, `'базовый показатель'`
  - deadline: добавить `'квартал'`, `'период'`, `'срок реализации'`

- `src/bot.ts:979` — обновить `F0_UNSUPPORTED_TEXT`: добавить `.pptx` в перечень поддерживаемых форматов («.md, .txt, .docx, .pdf, .pptx»)

- `src/utils/f0-document.test.ts` (новый файл или дополнение) — юнит-тест `extractPptxText`: создать минимальный in-memory ZIP с `ppt/slides/slide1.xml` содержащим `<a:t>Стратегия</a:t>` и `<a:t>&amp;OKR</a:t>` → ожидать текст содержащий 'Стратегия' и '&OKR' (entity decode); тест `extractTextFromDocument` с buf от этого же zip + filename='deck.pptx' → возвращает `{kind:'pptx', text: содержит 'Стратегия'}`. Обновить тесты `bot.test.ts:2201,2266` — заменить `includes('Два пути')` на `includes('Как заводим стратегию?')` и обновить кнопочные ожидания (3 кнопки вместо 2)

**Acceptance Criteria:**
- Given профиль клиента с заполненным 🔑-минимумом, when `startStrategyCollection()` вызывается после завершения профиля, then бот отправляет сообщение «Как заводим стратегию?» с клавиатурой из трёх кнопок: callback `f0_mode_import`, `f0_mode_questionnaire`, `f0_mode_synthesis`
- Given сессия в фазе `collecting`, when пользователь присылает .pptx файл с текстовым контентом слайдов, then бот отвечает сообщением «📎 Принят:» (нет ответа с `unsupported_file` / «Поддерживаются»)
- Given xlsx файл отклонён с `import_unmappable`, when бот отвечает сообщением об ошибке, then ответ содержит inline keyboard `f0StrategyKeyboard` (callback_data `f0_mode_questionnaire` присутствует в разметке)

## Spec Change Log

## Review Triage Log

### 2026-07-09 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 2, low 2)
- defer: 4: (high 0, medium 1, low 3)
- reject: N (noise, pre-existing, unreachable paths)
- addressed_findings:
  - `[medium]` `[patch]` `import_unmappable` второй строкой был перечень форматов — противоречие с 3-кнопочной клавиатурой → изменено на «💡 Выбери другой путь:»; тест обновлён
  - `[medium]` `[patch]` `presentationHint` не проверялась на уровне `runF0FullDraft`/`loadPrompt` — `isPresentationOnly: true` мокировало весь вызов → добавлено 2 unit-теста в `src/f0-onboarding.test.ts`
  - `[low]` `[patch]` `isPresentationOnly: false` в hypo-синтезе без объяснения → добавлен комментарий
  - `[low]` `[patch]` тест Row 3 разыменовывал `rejectedCall!` без предшествующего `.toBeDefined()` → добавлено

## Design Notes

- **PPTX XML текст**: `<a:t>` — единственный текстовый узел в DrawingML; вложенные `<a:r>` (runs) содержат `<a:t>` — регулярное выражение по `<a:t>` захватывает весь текст без парсинга полного XML-дерева. Порядок `slide*.xml` сортируется по числовому суффиксу — правильный порядок слайдов.
- **Stub для questionnaire**: 9.5 заменит handler `f0_mode_questionnaire`; в 9.4 stub достаточен. Кнопка появляется сейчас, чтобы 9.5 не нужно было менять `f0StrategyKeyboard`.
- **Синонимы без файла ARB**: файл `ARB_Solutions_Стратегический_трекер_v1_1_1.xlsx` в репозитории отсутствует; синонимы подобраны по общим паттернам русских трекеров. Если файл появится — добавить как test fixture в `src/__fixtures__/` и добавить снапшот-тест импорта.
- **`isPresentationOnly` только для .pptx**: PDF может быть протоколом, а не презентацией — tight-prompt применяется только к одиночному `.pptx`.

## Verification

**Commands:**
- `npm install` — expected: jszip установлен без конфликтов
- `npx tsc --noEmit` — expected: без ошибок (новые типы 'pptx', `isPresentationOnly`, `presentationHint` типизированы)
- `npm test` — expected: весь vitest зелёный (633 база + новые pptx-тесты)
- `npm run canary -- --no-claude` — expected: PASS; geonline-guardrail не тронут

## Auto Run Result

**Status:** done

**Summary:** Реализован единый вход онбординга (3 кнопки вместо 2), добавлена поддержка .pptx через jszip, расширен словарь синонимов xlsx, при ошибке импорта показывается 3-кнопочный экран. После рецензии: уточнён текст `import_unmappable`, добавлены тесты `presentationHint` в `runF0FullDraft`.

**Files changed:**
- `package.json` / `package-lock.json` — добавлена зависимость jszip v3.10.1
- `src/utils/f0-input.ts` — .pptx в F0_BINARY_EXTENSIONS, PPTX MIME, 'pptx' в f0DocumentKind
- `src/utils/f0-document.ts` — `extractPptxText()` via JSZip; 'pptx' в F0ExtractedDocument.kind; pptx-ветка в extractTextFromDocument
- `src/f0-onboarding.ts` — `isPresentationOnly?: boolean` в RunF0DraftArgs; `presentationHint` в loadPrompt
- `prompts/f0-full-extraction.md` — `{{presentationHint}}` placeholder в секции Инструкции
- `src/f0-import.ts` — KR_COLUMN_SYNONYMS расширен ~15 синонимами
- `src/bot.ts` — F0_START_TEXT → F0_STRATEGY_SCREEN_TEXT; f0ModeKeyboard (2 кнопки) → f0StrategyKeyboard (3); startStrategyCollection обновлён; добавлен `f0_mode_questionnaire` stub; `import_unmappable` error показывает клавиатуру; isPresentationOnly в вызовах runF0FullDraftFn; комментарий isPresentationOnly: false в hypo-пути; F0_UNSUPPORTED_TEXT + .pptx
- `src/utils/f0-document.test.ts` — 11 тестов extractPptxText и pptx-пути extractTextFromDocument
- `src/bot.test.ts` — 4 матрицных теста + обновлены 2 существующих assertions
- `src/f0-onboarding.test.ts` — 2 теста presentationHint в loadPrompt
- `_bmad-output/implementation-artifacts/deferred-work.md` — 4 deferred items

**Review findings:** patch 4 (medium ×2 — import_unmappable text, presentationHint test; low ×2 — hypo comment, test non-null), defer 4 (questionnaire phase guard, prompt blank line, NaN sort, synonym test coverage), reject: прочие

**Verification:** npm install clean · tsc clean · 649 vitest passed · canary PASS (geonline-guardrail intact)

**Residual risks:**
- Словарь синонимов ARB xlsx расширен по паттернам; реальный файл не тестировался — регресс-тест отложен до появления файла.
- `f0_mode_questionnaire` stub заменит 9.5; до этого — без session guard (deferred).
- PPTX-парсинг через regex `<a:t>`; многострочный текст в одном теге `<a:t>` не разбивается; adjacent runs без whitespace сливаются.
