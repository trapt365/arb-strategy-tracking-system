---
title: 'Story 9.7: [CR-7] Недельный отчёт трекера по клиенту'
type: 'feature'
created: '2026-07-09'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '4674ece8ad396211c1e665568aa18a01856d37e4'
final_revision: '5974d14bd6a999916f60cb70212f24e43fec8388'
context:
  - '{project-root}/_bmad-output/implementation-artifacts/epic-9-context.md'
warnings: []
---

<intent-contract>

## Intent

**Problem:** Трекер не видит общей картины по клиенту за неделю — per-meeting `/report` изолированы, агрегата нет.

**Approach:** Новый callback `weekly:{clientId}` + кнопка «📅 Недельный отчёт» в меню `start_client:{id}`. Новая утилита `loadWeekReports` сканирует `data/{clientId}/` за текущую ISO-неделю и читает `.report.json`; агрегат форматируется без LLM-вызова; неделя без встреч → «встреч не обработано».

## Boundaries & Constraints

**Always:**
- Читать только уже персистированные `.report.json` (F1 уже обработан). Никакого нового LLM-вызова.
- «Текущая неделя» = ISO-неделя (пн–вс), определённая по дате директории `YYYY-MM-DD`; сравнивать {weekNumber, year}, чтобы избежать W1/W53 путаницы через год.
- Имена и названия — через `getClientName` (grounding 9.2).
- canary + vitest + tsc зелёные; `clientId === 'geonline'` fallback и `GEONLINE_F0_SHEET_ID` не трогать.

**Block If:**
- Не применимо — нет развилок с неоднозначным решением.

**Never:**
- Не менять per-meeting `/report` (ни логику, ни тесты).
- Не добавлять новые npm-зависимости.
- Не выдавать данные Geonline через `weekly:geonline` вне штатного flow (guardrail не меняется).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Встречи за неделю есть | clientId='qubiq', 2 `.report.json` за текущую ISO-неделю | «📅 Нед. {N}/{YYYY} — {name}\n\nВстреч: 2\n{date} — {topName}: {summaryLine}\n...\n\nОбязательства (K):\n...\n\nАлерты (M):\n...» + кнопка «📁 Таблица» | — |
| Нет встреч за неделю | clientId='qubiq', нет `.report.json` за текущую ISO-неделю | «📅 Нед. {N}/{YYYY} — {name}\n\nВстреч за неделю не обработано.» | — |
| Ошибка чтения fs | `data/{clientId}/` недоступна | `log.warn({err, clientId}, 'weekly.load_failed')` + «Не удалось загрузить данные за неделю.» | catch → reply (plain text) |
| `start_client:{id}` нажата | clientId='qubiq' | Клавиатура содержит callback `weekly:qubiq` | — |

</intent-contract>

## Code Map

- `src/utils/commitments-history.ts:52–56` — шаблон `rootDir / clientId` + `DATE_DIR_RE` для сканирования date-dirs
- `src/types.ts:192–234` — `DeliveryReadyReportSchema`, `DeliveryReadyReport` (поля: partial, reportId, clientId, topName, meetingDate, summaryLine, commitments[], alerts[])
- `src/bot.ts:1700–1723` — `start_client:{id}` callback: добавить строку кнопки `weekly:{clientId}`
- `src/client-registry.ts` — `getClientName`, `getClientSheetId`
- `src/utils/telegram-formatter.ts` — `splitForTelegram` (разбивка > 4096 символов)

## Tasks & Acceptance

**Execution:**
- `src/utils/weekly-report.ts` (новый файл) — экспортировать:
  - `getISOWeekAndYear(dateStr: string): {week: number; year: number}` — ISO 8601 week numbering с корректной обработкой границы года (deferred [C11]): найти ближайший четверг (`getUTCDay()`: Mon=1…Sun=7, shift to Thu=+4-day), взять его год, посчитать разницу в неделях от первого четверга этого года.
  - `loadWeekReports(clientId: string, opts?: {rootDir?: string; now?: Date}): Promise<DeliveryReadyReport[]>` — как `loadOpenCommitments` в `commitments-history.ts`: `rootDir = opts?.rootDir ?? 'data'`; `fs.readdir(join(rootDir, clientId))` → filter `DATE_DIR_RE` → фильтр: `getISOWeekAndYear(dir)` совпадает с `getISOWeekAndYear(today)`; для каждой dir — list `.report.json` → `JSON.parse` + `DeliveryReadyReportSchema.safeParse`; invalid/unreadable → `log.warn + skip`; вернуть sorted по `meetingDate` asc; если `data/{clientId}/` не существует → `fs.readdir` throws → catch, вернуть `[]`.
  - `formatWeeklyReport(reports: DeliveryReadyReport[], clientName: string, week: number, year: number): string` — заголовок `📅 Нед. ${week}/${year} — ${clientName}`; если `reports.length === 0` → «\n\nВстреч за неделю не обработано.»; иначе: «\n\nВстреч: {N}» + список `${r.meetingDate} — ${r.topName}: ${r.summaryLine}` + все `r.commitments` из всех reports (без фильтра по status — показываем что было на встречах) + все `r.alerts`.
- `src/bot.ts:1709–1714` — в callback `start_client:{id}` добавить `.row().text('📅 Недельный отчёт', \`weekly:${clientId}\`)` в конец InlineKeyboard (после существующих кнопок Таблица и профиля).
- `src/bot.ts` (после `start_client` handler, ~line 1724) — добавить `bot.callbackQuery(/^weekly:(.+)$/, async (ctx) => { await ctx.answerCallbackQuery().catch(()=>{}); const clientId = ctx.match[1]!; const name = (await getClientName(clientId)) ?? clientId; const sheetId = await getClientSheetId(clientId); const reports = await loadWeekReports(clientId).catch(err => { log.warn({err, clientId}, 'weekly.load_failed'); return null; }); const {week, year} = getISOWeekAndYear(new Date().toISOString().slice(0,10)); const text = reports !== null ? formatWeeklyReport(reports, name, week, year) : 'Не удалось загрузить данные за неделю.'; const kb = new InlineKeyboard(); if (sheetId !== undefined) kb.url('📁 Таблица', \`https://docs.google.com/spreadsheets/d/${sheetId}\`); for (const msg of splitForTelegram(text)) { await ctx.reply(msg, {reply_markup: kb}).catch(()=>{}); } log.info({step:'bot.weekly.sent', clientId, count: reports?.length ?? 0}, 'weekly report sent'); })`.
- `src/bot-weekly-9-7.test.ts` (новый файл) — `vi.mock('./client-registry.js', ...)` + `vi.mock('./utils/weekly-report.js', async (importOriginal) => { const actual = await importOriginal(); return {...actual, loadWeekReports: vi.fn()}; })` (partial mock: `loadWeekReports` — мок, `formatWeeklyReport` и `getISOWeekAndYear` — реальные); также `vi.mock('./f0-client-card.js', ...)` для `loadClientCard`; тесты: (1) callback `weekly:qubiq` с `vi.mocked(loadWeekReports).mockResolvedValue([report1, report2])` → ctx.reply вызван с текстом, содержащим `report1.summaryLine` и `report2.summaryLine`; (2) callback `weekly:qubiq` с `mockResolvedValue([])` → ctx.reply содержит «не обработано»; (3) callback `start_client:qubiq` → `vi.mocked(getClientSheetId).mockResolvedValue('sheet1')` + `vi.mocked(loadClientCard).mockResolvedValue(null)` → ctx.reply вызван с `reply_markup.inline_keyboard` содержащим callback_data `weekly:qubiq`.

**Acceptance Criteria:**
- Given клиент 'qubiq' (name='Qubiq') и 2 `.report.json` за текущую ISO-неделю, when callback `weekly:qubiq`, then ответ содержит «Нед.» и summaryLine обеих встреч.
- Given клиент 'qubiq' без обработанных встреч за текущую ISO-неделю, when callback `weekly:qubiq`, then ответ содержит «не обработано».
- Given реестр содержит клиента 'qubiq', when callback `start_client:qubiq`, then клавиатура ответа содержит кнопку с callback_data `weekly:qubiq`.

## Auto Run Result

**Status:** done

**Summary:** Реализован недельный отчёт трекера по клиенту: кнопка «📅 Недельный отчёт» добавлена в меню `start_client:{id}`; callback `weekly:{clientId}` сканирует `data/{clientId}/` за текущую ISO-неделю, читает `.report.json`, форматирует агрегат (встречи + обязательства + алерты) без нового LLM-вызова. Неделя без встреч → честное «не обработано».

**Files changed:**
- `src/utils/weekly-report.ts` (new) — `getISOWeekAndYear`, `loadWeekReports`, `formatWeeklyReport`; ISO 8601 week с year-boundary fix (deferred [C11])
- `src/bot.ts` — импорт трёх новых экспортов; кнопка `weekly:{clientId}` в `start_client` handler; callback `weekly:(.+)` (~30 строк)
- `src/bot-weekly-9-7.test.ts` (new) — 4 теста (2-отчёта, 0-отчётов, EACCES-throw, start_client keyboard)
- `_bmad-output/implementation-artifacts/spec-9-7-nedelnyy-otchyot-trekera-po-klientu.md` — спека
- `_bmad-output/implementation-artifacts/deferred-work.md` — 5 defer items

**Review findings:** patch 2 (medium ×1 — `now()` dep bypass + midnight race; low ×1 — inner readdir catch без логирования), defer 5 (unit tests для loadWeekReports, kb на всех split-частях, path traversal pre-existing, getClientName/.catch pre-existing, commitment context), reject: прочие (noise, pre-existing, production-unreachable)

**Verification:** tsc clean · 637 vitest passed (633 base + 4 new 9.7) · canary PASS (geonline-guardrail intact)

**Residual risks:**
- `loadWeekReports` file-reading logic не покрыта прямыми unit-тестами (deferred).
- `getClientName`/`getClientSheetId` без `.catch()` в weekly callback — registry I/O error оставит callback без ответа (deferred, same as start_client).

## Spec Change Log

## Review Triage Log

### 2026-07-09 — Review pass
- intent_gap: 0
- bad_spec: 0
- patch: 2: (high 0, medium 1, low 1)
- defer: 5: (high 0, medium 0, low 5)
- reject: N (NaN cascade нереален в production, splitForTelegram empty недостижим, undefined в formatWeeklyReport уже отсекается safeParse, Math.round vs floor — точные кратные, auth check pre-existing pattern, answerCallbackQuery swallow pre-existing, commitment context — design choice)
- addressed_findings:
  - `[medium]` `[patch]` `bot.ts` weekly handler использовал `new Date()` напрямую вместо `now()` dep из BotDeps — полночный рейс week-label vs loaded data + нет testability; исправлено: `const nowDate = now()` + `getISOWeekAndYear(nowDate.toISOString()...)` + `loadWeekReports(clientId, { now: nowDate })`
  - `[low]` `[patch]` Inner `fs.readdir(dirPath)` catch в `loadWeekReports` молча `continue` без логирования; добавлен `log.warn({ err, dir: dirPath, clientId }, 'weekly.readdir_failed')`

## Design Notes

- **Нет LLM-вызова:** агрегат строится из уже персистированных полей `summaryLine` и `commitments[]` каждого `.report.json`. Синтеза «поверх» нет — это ключевое архитектурное решение (скорость + надёжность + MVP).
- **ISO неделя vs rolling 7 дней:** ISO-неделя (пн–вс) выбрана, т.к. поле `weekNumber` в reports уже использует ISO. Сравнение по {week+year} решает проблему W1 2026 vs W53 2025 (deferred [C11]).
- **Все commitments недели, без статус-фильтра:** `loadOpenCommitments` (Story 1.10) — исторический трекер со статус-overlay. Недельный отчёт другое — snapshot того, что было на встречах этой недели. Commitments берутся прямо из `.report.json` без `*.commitments-updates.json` overlay.

## Verification

**Commands:**
- `npx tsc --noEmit` — expected: без ошибок
- `npm test` — expected: весь vitest зелёный (633 тест + новые 9.7)
- `npm run canary -- --no-claude` — expected: PASS; geonline-guardrail не тронут
