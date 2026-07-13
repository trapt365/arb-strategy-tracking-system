---
title: 'Расшивка клиентских таблиц на сервис-аккаунт'
type: 'bugfix'
created: '2026-07-13'
status: 'done'
review_loop_iteration: 1
followup_review_recommended: false
final_revision: '198ae145b988b275f3b24e3db7986188e9fb710a'
baseline_revision: '60594c5bc0d17a5a046ee8d1111b8100a60385de'
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** Клиентские таблицы создаются через user-OAuth (`createDriveWriteClient` использует OAuth-пользователя, если `GOOGLE_OAUTH_REFRESH_TOKEN` задан). Файл принадлежит OAuth-пользователю — сервис-аккаунт `geonline-tracking-bot@geonline-report-bot.iam.gserviceaccount.com` не имеет к нему доступа (403). При запуске F1 (`readClientContext`: `_okr`, `_stakeholder_map`, `_f5_metrics`) и F5 (`readHypothesesSheet`: `_hypotheses`) под сервис-аккаунтом — 403. Воспроизведено на живом прогоне 13 июля.

**Approach:** В `createClientSpreadsheet` в блоке шаринга (шаг 6) добавить `drive.permissions.create` для сервис-аккаунта (`role: 'writer'`) перед передачей доступа трекерам. Email СА получается через `opts.saEmailFactory` (тест-инъекция); в production — `loadServiceAccountCredentials().client_email` при `isGoogleOAuthConfigured()`, иначе пропуск (СА сам создал файл — доступ есть).

## Boundaries & Constraints

**Always:**
- Шаринг с СА добавляется до цикла шаринга с трекерами (шаг 6 `createClientSpreadsheet`).
- В production: шаринг с СА выполняется только если `isGoogleOAuthConfigured()` === true; если false — пропускается (СА уже владелец файла).
- `opts.saEmailFactory?: () => Promise<string | null>` — тест-инъекция: если задан, использовать его результат вместо production-пути; `null` — пропустить шаринг.
- Роль СА: `role: 'writer'` (Drive API = «editor»), `type: 'user'`.
- Ошибка шаринга с СА — `share_failed` через `mapGoogleError` (аналогично трекерам).
- `result.shared` включает email СА (если шаринг выполнен) перед emails трекеров.
- `GEONLINE_F0_SHEET_ID` — pre-existing таблица, через `createClientSpreadsheet` не создаётся; этот код её не затрагивает.
- После реализации: `npm test` и `npm run typecheck` зелёные.

**Block If:** нет.

**Never:**
- Не шарить с СА, когда `isGoogleOAuthConfigured()` === false и `saEmailFactory` не задан.
- Не дедуплицировать emails (SA email и tracker emails — заведомо разные адреса).
- Не изменять `F0_SHEETS_SHARE_EMAILS` конфиг — добавление через опт-инъекцию, не через новую env-переменную.
- Не изменять логику read-пайплайнов (`readClientContext`, `readHypothesesSheet`) — фикс только на стороне записи (онбординг).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| OAuth активен, новый клиент | `isGoogleOAuthConfigured()` = true, `saEmailFactory` не задан | `drive.permissions.create` → СА editor; `result.shared[0]` = SA email | Ошибка → `share_failed` |
| `saEmailFactory` задан и возвращает email | `opts.saEmailFactory` = `async () => 'sa@...'` | `drive.permissions.create` → СА editor; SA email в `result.shared` | Ошибка → `share_failed` |
| `saEmailFactory` возвращает `null` | `opts.saEmailFactory` = `async () => null` | Шаринг с СА пропущен; `result.shared` = только трекеры | Нет |
| OAuth не активен, `saEmailFactory` не задан | `isGoogleOAuthConfigured()` = false | Шаринг с СА пропущен; поведение без изменений | Нет |
| СА шаринг успешен, трекер-шаринг падает | `drive.permissions.create` для трекера throws | Бросает `share_failed` (поведение идентично текущему) | `mapGoogleError(err, 'share_failed', sid)` |

</intent-contract>

## Code Map

- `src/f0-sheets.ts:208–225` — `CreateClientSpreadsheetOpts` — добавить `saEmailFactory?`
- `src/f0-sheets.ts:1–15` — импорты — добавить `isGoogleOAuthConfigured`, `loadServiceAccountCredentials` из `./utils/google-auth.js`
- `src/f0-sheets.ts:421–443` — шаг 6 шаринга (комментарий + трекеры) — вставить СА-шаринг перед трекерами
- `src/f0-sheets.test.ts:111–130` — `makeDrive` — готовая инфраструктура; не менять
- `src/f0-sheets.test.ts:341–379` — happy-path тест — не ломается (no `saEmailFactory` + no OAuth = no SA sharing)

## Tasks & Acceptance

**Execution:**

- `src/f0-sheets.ts` — импортировать `isGoogleOAuthConfigured` и `loadServiceAccountCredentials` из `./utils/google-auth.js` (добавить к существующим импортам); добавить поле `saEmailFactory?: () => Promise<string | null>` в интерфейс `CreateClientSpreadsheetOpts` (после `driveClientFactory`); в теле `createClientSpreadsheet` перед строкой 423 (`const shared: string[] = []`) добавить резолвинг `saEmail` и блок `drive.permissions.create` для него: если `opts.saEmailFactory` задан — использовать его результат; иначе если `isGoogleOAuthConfigured()` — `await loadServiceAccountCredentials()` и взять `client_email`; иначе `null`; если `saEmail !== null` — `await withRetry(() => drive.permissions.create({ fileId: sid, supportsAllDrives: true, sendNotificationEmail: false, requestBody: { type: 'user', role: 'writer', emailAddress: saEmail } }), { ...RETRY, logger: log })` (не использовать `saEmail!` — TypeScript уже сужает тип внутри `if (saEmail !== null)`), push `saEmail` в `shared`; ошибку пробрасывать через `mapGoogleError(err, 'share_failed', sid)`.

- `vitest.config.ts` — добавить в блок `env` явные пустые значения `GOOGLE_OAUTH_CLIENT_ID: ''`, `GOOGLE_OAUTH_CLIENT_SECRET: ''`, `GOOGLE_OAUTH_REFRESH_TOKEN: ''`, чтобы `isGoogleOAuthConfigured()` гарантированно возвращал `false` в тестовой среде (защита от утечки реального `.env` в тесты).

- `src/f0-sheets.test.ts` — добавить `describe('createClientSpreadsheet — story 11.3: SA sharing', ...)` с тремя `it`-тестами: (1) `saEmailFactory` возвращает email → `drive.calls.permissions[0]` имеет `{ emailAddress: saEmail, role: 'writer', type: 'user' }`, `result.shared[0] === saEmail`, `result.shared[1] === 'tracker@example.com'`, `result.shared.length === 2`; (2) `saEmailFactory` возвращает `null` → `drive.calls.permissions.length === 1`, `result.shared` равен `['tracker@example.com']`; (3) production-путь: через `vi.mock('./utils/google-auth.js', () => ({ isGoogleOAuthConfigured: vi.fn().mockReturnValue(true), loadServiceAccountCredentials: vi.fn().mockResolvedValue({ client_email: 'sa@test.gserviceaccount.com', private_key: '' }) }))` вызвать `createClientSpreadsheet` без `saEmailFactory`, проверить что `drive.calls.permissions[0].requestBody.emailAddress === 'sa@test.gserviceaccount.com'` и `result.shared[0] === 'sa@test.gserviceaccount.com'`; добавить `afterEach` с `vi.restoreAllMocks()` в этот describe-блок; импортировать `vi` из `vitest`; тесты (1) и (2) используют `makeSheets({ titles: allTitles, headers: allHeaders })` и `makeDrive()`.

**Acceptance Criteria:**

- Given `saEmailFactory` возвращает SA email, when `createClientSpreadsheet` вызывается, then `drive.permissions.create` вызывается с `{ emailAddress: saEmail, role: 'writer', type: 'user' }` первым среди permission-вызовов, и `result.shared[0] === saEmail`.
- Given `saEmailFactory` возвращает `null`, when `createClientSpreadsheet` вызывается, then `drive.permissions.create` не вызывается для SA email; `result.shared` содержит только трекер-emails.
- Given `saEmailFactory` не задан и `GOOGLE_OAUTH_REFRESH_TOKEN` пуст (тестовая среда), when `createClientSpreadsheet` вызывается, then поведение идентично текущему: `result.shared === ['tracker@example.com']`, `drive.calls.permissions` имеет длину 1.
- Given `isGoogleOAuthConfigured()` возвращает `true` и `saEmailFactory` не задан, when `createClientSpreadsheet` вызывается, then `drive.permissions.create` вызывается первым с `emailAddress` равным `client_email` из `loadServiceAccountCredentials()`, и этот email первым в `result.shared`.

## Spec Change Log

### 2026-07-13 — bad_spec loopback (pass 1)

- **Triggering finding:** Production branch `else if (isGoogleOAuthConfigured())` в `createClientSpreadsheet` не покрыт ни одним тестом. Ветка, которая в production выполняет шаринг с СА через `loadServiceAccountCredentials().client_email`, структурно недостижима в тестовой среде (все OAuth переменные пусты). Если эту ветку удалить или изменить, ни один тест не упадёт.
- **Что исправлено:** Добавлены задача и AC для production-пути: тест через `vi.mock('./utils/google-auth.js', ...)` с замоканными `isGoogleOAuthConfigured` (true) и `loadServiceAccountCredentials` (возвращает known `client_email`); добавлена задача для `vitest.config.ts` (явные пустые OAuth переменные); удалён `saEmail!` non-null assertion из task-описания (TypeScript сужает тип в `if (saEmail !== null)`).
- **Known-bad state:** Ветка `else if (isGoogleOAuthConfigured())` не покрыта — поломка production SA-шаринга не обнаруживается тестами.
- **KEEP:** Весь production-код `src/f0-sheets.ts` корректен: импорт, поле `saEmailFactory?`, SA-блок до трекеров, withRetry, mapGoogleError, role: writer. Тесты (1) и (2) в story 11.3 describe-блоке корректны. `vitest.config.ts` изменения с пустыми OAuth vars корректны.

## Review Triage Log

### 2026-07-13 — Review pass 2

- intent_gap: 0
- bad_spec: 0
- patch: 1: (high 0, medium 0, low 1)
- defer: 1: (high 0, medium 0, low 1)
- reject: 12
- addressed_findings:
  - `[low]` `[patch]` production-path тест (test 3) не ассертировал `result.shared.toHaveLength(2)` и `result.shared[1] === 'tracker@example.com'` — добавлены две строки assertions

### 2026-07-13 — Review pass 1

- intent_gap: 0
- bad_spec: 1: (high 0, medium 1, low 0)
- patch: 1: (high 0, medium 0, low 1)
- defer: 2: (high 0, medium 0, low 2)
- reject: 9
- addressed_findings:
  - `[medium]` `[bad_spec]` production-путь `else if (isGoogleOAuthConfigured())` не покрыт тестом — добавлен vi.mock-тест в Tasks, добавлен AC для production-пути
  - `[low]` `[patch]` `saEmail!` redundant non-null assertion устранён в spec task description (не нужен внутри `if (saEmail !== null)`)

## Design Notes

`saEmailFactory` следует паттерну `sheetsClientFactory`/`driveClientFactory` — тест-инъекция без изменений в сигнатуре prod-пути. В production при `isGoogleOAuthConfigured() === false` (SA-режим) файл принадлежит СА, шаринг не нужен — пропуск логически корректен. `loadServiceAccountCredentials` кэшируется (`cached: Promise<...>`) — повторный вызов в `createClientSpreadsheet` не создаёт I/O.

## Verification

**Commands:**
- `npm test` — expected: все vitest-тесты зелёные, включая два новых теста story 11.3
- `npm run typecheck` — expected: нет ошибок TypeScript

## Auto Run Result

**Summary:** Исправлен P1-блокер: при создании клиентской таблицы под user-OAuth сервис-аккаунт автоматически получает editor-доступ через `drive.permissions.create` перед передачей доступа трекерам. Импортированы `isGoogleOAuthConfigured` и `loadServiceAccountCredentials`; добавлено поле `saEmailFactory?` в `CreateClientSpreadsheetOpts`; SA-шаринг-блок вставлен в шаг 6 `createClientSpreadsheet`. Добавлен `vi.mock` для покрытия production-пути тестами.

**Files changed:**
- `src/f0-sheets.ts` — импорт из `utils/google-auth.js`; поле `saEmailFactory?` в opts; SA-шаринг блок перед трекерами в шаге 6
- `src/f0-sheets.test.ts` — импорт `vi`, `afterEach`; `vi.mock('./utils/google-auth.js', ...)` с дефолтом false; describe-блок с 3 тестами (factory email, factory null, production path)
- `vitest.config.ts` — явные пустые значения `GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN` для изоляции тестов

**Review findings breakdown:**
- Patches applied: 2 across 2 passes (redundant `saEmail!` устранён в task description; добавлены assertions в production-path тест)
- Items deferred: 3 (loadServiceAccountCredentials throws path; read-pipelines integration gap; SA permissions.create failure test)
- Items rejected: ~21 across 2 passes

**Verification:**
- `npm test` → EXIT:0, 744/744 тестов (было 741 на baseline)
- `npm run typecheck` → EXIT:0, нет ошибок TypeScript

**Residual risks:**
- `loadServiceAccountCredentials()` в production-пути может бросить `TranscriptConfigError` без обёртки в `share_failed`, если SA JSON файл исчез после старта бота (зафиксировано в deferred-work.md)
- Read-пайплайны F1/F5 не проверены интеграционно — live-test подтвердит полное устранение 403 (зафиксировано в deferred-work.md)
- Canary не запускался (нулевой баланс Anthropic API — pre-existing блокер эпика 11)
