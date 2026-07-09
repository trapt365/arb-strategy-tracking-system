---
title: 'Story 9.6: [CR-5] Ссылки вместо полотен — остаток инвентаризации'
type: 'feature'
created: '2026-07-09'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: false
baseline_revision: 'e853c03d6f4890e3c314b56e5d49406183f6d6ce'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** `/confirm`-предупреждения о неполных KR отображают подробный список (до 10 строк per-KR с формулировкой и причинами) — полотно. Кнопка «🔗 Подробнее» после F1-отчёта ведёт к заглушке «Скоро доступно 🔜» вместо реальной ссылки на таблицу клиента.

**Approach:** В `/confirm` убрать per-KR список — показать счётчик `⚠️ N KR стоит дозаполнить` и ссылку на таблицу в том же сообщении, которое уже содержит URL (после успешного создания Sheets). Заменить `post_detail` stub реальным хендлером: взять `clientId` из job, получить sheetId через реестр, ответить ссылкой. Провести финальный аудит `splitForTelegram` (no code changes).

## Boundaries & Constraints

**Always:**
- Geonline-fallback (`clientId === 'geonline'`) и `GEONLINE_F0_SHEET_ID` не трогать.
- Canary + vitest + tsc зелёные.
- URL KR-предупреждения выдаётся только ПОСЛЕ успешного создания таблицы — в `createSheetForSession`, не раньше.
- `splitForTelegram` остаётся во всех текущих точках (строки 474, 670, 2123, 2543, 4019 bot.ts) — страховки, не удалять.

**Block If:**
- Требуется компактизация F1/F0-доставки — это уже покрыто 8.3, вне scope 9.6.

**Never:**
- Оставлять per-KR список (`for (const issue of warnings...) readyLines.push(...)`) в `/confirm`.
- Добавлять новые полотна или дублировать URL без нужды.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| /confirm, N>0 предупреждений | draft с KR без base/target, createClientSpreadsheet → URL | confirm reply: `✅ Онбординг подтверждён` без per-KR строк; в sheets-reply: `⚠️ N KR стоит дозаполнить — дозаполни в таблице: {url}` | — |
| /confirm, 0 предупреждений | draft с полными KR | confirm reply: `✅ Онбординг подтверждён`; sheets-reply без строки KR | — |
| post_detail, job есть, sheet есть | job в completedJobs, getClientSheetId → sheetId | answerCallbackQuery() + reply с URL `docs.google.com/spreadsheets/d/{sheetId}/edit` | — |
| post_detail, job есть, sheet не найден | getClientSheetId → '' или undefined | answerCallbackQuery() + reply 'ℹ️ Таблица клиента не найдена.' | — |
| post_detail, job устарел | jobId не в queue/completedJobs | answerCallbackQuery({ text: 'ℹ️ Отчёт уже недоступен.' }) | — |

</intent-contract>

## Code Map

- `src/bot.ts:3252-3292` — `/confirm` handler: вычисляет `warnings`, формирует `readyLines`, вызывает `createSheetForSession`
- `src/bot.ts:3157-3250` — `createSheetForSession(ctx, chatId, session)`: создаёт Sheets, отправляет URL в lines-массиве
- `src/bot.ts:3216-3227` — success-блок `createSheetForSession`: собирает `lines[]` и отправляет одним `ctx.reply`
- `src/bot.ts:3729-3733` — `post_detail` stub callback (заменить)
- `src/bot.ts:70,74` — импорт `getClientSheetId` из `./client-registry.js` — доступен для `post_detail`
- `src/bot.ts:441-443` — `peekJob(jobId)` — поиск job в queue+completedJobs
- `src/bot.test.ts:785-797` — AC#9: тест post_detail-stub (обновить)
- `src/bot.test.ts:1136-1148` — AC#10: тест post_detail-stub (обновить)
- `src/bot.test.ts:1464-1472` — `f0DraftResult()`: хелпер черновика (расширить для KR с null полями)

## Tasks & Acceptance

**Execution:**

- `src/bot.ts` (createSheetForSession, строка 3157) — Добавить 4-й параметр `krWarnings: number = 0`; в success-блоке после `lines.push(\`ID клиента: ...\`)` и перед `if (result.shared.length > 0)`: если `krWarnings > 0`, вставить `lines.push(\`⚠️ \${krWarnings} KR стоит дозаполнить — дозаполни в таблице: \${result.spreadsheetUrl}\`)`

- `src/bot.ts` (/confirm handler, строки 3276-3283) — Удалить блок `if (warnings.length > 0) { readyLines.push(...); for (const issue of warnings...) ...; if (warnings.length > 10) ... }` целиком; изменить вызов `createSheetForSession(ctx, chatId, session)` → `createSheetForSession(ctx, chatId, session, warnings.length)`; строка `✅ Онбординг подтверждён — данные готовы.` и блок расписания остаются без изменений

- `src/bot.ts` (post_detail callback, строки 3729-3733) — Заменить stub тело: получить `jobId = ctx.match[1]!`; получить `job = peekJob(jobId)`; если нет job → `answerCallbackQuery({ text: 'ℹ️ Отчёт уже недоступен.' }); return`; получить `sheetId = await getClientSheetId(job.clientId).catch(() => undefined)`; если нет sheetId или `sheetId.length === 0` → `answerCallbackQuery(); reply('ℹ️ Таблица клиента не найдена.'); return`; иначе → `answerCallbackQuery(); reply(\`🔗 Таблица клиента:\nhttps://docs.google.com/spreadsheets/d/\${sheetId}/edit\`); log.info({ step: 'bot.post_detail.sent', jobId, clientId: job.clientId }, 'post_detail URL sent')`

- `src/bot.test.ts` (AC#9, строка 785) — Переименовать тест (убрать упоминание «stub»); заменить проверку `answerCallbackQuery.text.includes('Скоро')` на: найти `sendMessage` после `post_detail:`, убедиться что `text` содержит `docs.google.com/spreadsheets/d/test-sheet-id` (vitest.config задаёт `GEONLINE_F0_SHEET_ID: 'test-sheet-id'`, clientId job = 'geonline', fallback → config)

- `src/bot.test.ts` (AC#10, строка 1136) — Аналогично AC#9: переименовать, обновить assertion; добавить тест для стейл-job (`post_detail:unknown-id` → `answerCallbackQuery.text.includes('недоступен')`)

- `src/bot.test.ts` — Добавить тест «/confirm compact KR warning» в describe «Story 8.3» или отдельный describe: создать `f0Extraction` с KR `{ formulation: 'Выручка', base: null, target: null, owner: null, deadline: null }`; `buildF0Bot` с `createClientSpreadsheet` mock → `{ spreadsheetId: 's1', spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/s1/edit', counts: { okr:1, hypotheses:0, stakeholders:1, personalSheets:0 }, shared: [] }`; пройти `completeProfileMinimum` → `/draft` → `/confirm`; проверить (а) в confirm reply нет `«` и нет `reasons`; (б) в sendMessage с `⚠️` есть `1 KR стоит дозаполнить` и URL `s1`

**Acceptance Criteria:**
- Given `/confirm` c черновиком, содержащим KR без base/target/owner, when трекер отправляет `/confirm`, then ответ `/confirm` содержит `✅ Онбординг подтверждён` и НЕ содержит per-KR детали (`«`, `no_base`, `– O`); AND в сообщении создания таблицы содержится `⚠️ 1 KR стоит дозаполнить` и spreadsheetUrl
- Given F1-отчёт доставлен (geonline clientId), when трекер нажимает «🔗 Подробнее», then bot отвечает `sendMessage` с URL `docs.google.com/spreadsheets/d/test-sheet-id`
- Given `post_detail:{staleId}` где staleId не в памяти, when трекер нажимает кнопку, then `answerCallbackQuery` содержит «недоступен»
- Given vitest run, then все тесты (659+) зелёные, tsc чистый

## Design Notes

- **Дублирование URL**: в sheets-reply URL появляется дважды (строка `result.spreadsheetUrl` + строка KR-предупреждения). Intentional: трекер видит действие и ссылку рядом.
- **Аудит splitForTelegram**: все 5 вызовов — страховки (F1 delivery, F1 pre-delivery, weekly report, F0 draft, applyEdit). Epic 8.3 сделал F1/F0 compact. Кодовых изменений не требуется; результат аудита «чисто».
- **post_detail sheetId lookup**: `getClientSheetId` уже импортирован в bot.ts (строка 70); fallback на `config.GEONLINE_F0_SHEET_ID` для 'geonline' — поведение для тестовой среды (`GEONLINE_F0_SHEET_ID: 'test-sheet-id'` в vitest.config.ts).

## Verification

**Commands:**
- `npx tsc --noEmit` — expected: без ошибок (4-й параметр `krWarnings` optional с default 0)
- `npm test` — expected: всё зелёное (659 базовых + новый тест confirm-KR)
- `npm run canary -- --no-claude` — expected: PASS; geonline guardrail не тронут

## Review Triage Log — Pass 1 (2026-07-09)

**Reviewers:** blind-hunter, edge-case-hunter, verification-gap, intent-alignment
**Result:** 1 patch applied; all others rejected or deferred.

| # | Reviewer | Finding | Classification | Action |
|---|---------|---------|---------------|--------|
| 1 | edge-case-hunter, verification-gap | `.toContain('s1')` в тесте 9.6 — слабое совпадение, не различает false positive | **patch** | Applied: заменено на `.toContain(spreadsheetUrl)` (переменная определена выше) |
| 2 | blind-hunter | Нет delivery-state guard в post_detail (повторная попытка после complete) | **defer** | Pre-existing pattern; все callback-handlers без такой защиты. В scope 9.6 не значилось. |
| 3 | blind-hunter | `ctx.reply` без явного `chatId` — отвечает в текущий чат | **reject** | Pre-existing pattern (сотни вызовов так же); callback-context уже в правильном чате. |
| 4 | blind-hunter | URL дублируется дважды в sheets-reply | **reject** | Intentional по Design Notes spec; трекер видит действие и ссылку рядом. |
| 5 | blind-hunter | KR-предупреждение теряется если `createSheetForSession` бросает до success-блока | **reject** | По spec AС#1 — предупреждение выдаётся ТОЛЬКО после успешного создания. Error path корректен. |
| 6 | blind-hunter | AC#10c: мутация `job.clientId` — хрупкая зависимость от внутренней структуры | **defer** | Обоснована исследованием: completedJobs хранит ссылки; альтернатив без рефакторинга нет. Задокументировано в коде-комментарии. |
| 7 | edge-case-hunter | `.catch(() => {})` на `ctx.answerCallbackQuery()` отсутствует | **reject** | Pre-existing pattern в других callback-handlers (напр. строки 3710, 3720 bot.ts). |
| 8 | intent-alignment | splitForTelegram-аудит без артефакта | **reject** | Design Notes подтверждает «кодовых изменений не требуется»; аудит in-spec достаточен. |
| 9 | intent-alignment | post_detail не работает после перезапуска бота (in-memory jobs) | **defer** | Pre-existing limitation всей job-queue архитектуры; вне scope 9.6. |
| 10 | blind-hunter | `krWarnings` может быть NaN если `warnings` не-массив | **reject** | `warnings` — результат `markBlockingKrIssues()` → всегда массив; `.length` типобезопасен. |

**Post-patch verification:** 662/662 тесты зелёные, tsc чист.
