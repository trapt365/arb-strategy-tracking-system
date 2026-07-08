# Story 7.4: Создание Google Sheets по шаблону «Стратегический трекинг v2.0»

Status: done  # 2026-07-08: LIVE смоук PASS (scripts/f0-sheets-smoke.ts — реальная копия шаблона + запись _okr/_stakeholder_map/_hypotheses + шаринг). Фикс квоты SA (403 storage quota — SA не владеет Drive-файлами) → OAuth-креды пользователя (createDriveWriteClient + createSheetsWriteClient, scripts/google-oauth-setup.ts). В шаблон добавлены машинные вкладки. Code-review 2× + фиксы. 502/502 vitest, tsc чист.

> Epic 7 (WP-39 Ф2), лёгкий формат. Продолжает 7.3: после подтверждения черновика бот создаёт рабочую Google Sheets клиента.

## Пользовательская история

Как **коуч практики (Азиза)**,
я хочу **чтобы бот сам создал Google Sheets клиента по шаблону Geonline v2.0**,
чтобы **рабочая среда была готова к первой трекшн-встрече без ручного копирования таблиц**.

## Контекст и границы scope

После `/confirm` (7.3, фаза `ready`) бот копирует эталонный spreadsheet «Стратегический трекинг v2.0» (Drive `files.copy`), пишет данные онбординга в машиночитаемые листы и выдаёт трекеру доступ. Человекочитаемые панели («Панель OKR», «Банк гипотез», «Лог встреч») приходят из шаблона с форматированием и эмодзи-статусами; они наполняются формулами шаблона поверх машиночитаемых листов — это зона структуры Тимура, не логика бота.

**Ключевое архитектурное решение:** бот пишет ровно тот же машиночитаемый контракт, который читает F1 (`readClientContext`): листы `_okr`, `_stakeholder_map` (+ `_hypotheses` как источник банка гипотез). Симметрия чтения/записи — залог того, что созданная онбордингом таблица сразу пригодна для F1 (нужно для 7.6). Запись — header-driven: фактический порядок колонок читается из копии, данные раскладываются по именам заголовков (толерантно к перестановке колонок в шаблоне).

**В scope:**
- Config: `F0_SHEETS_TEMPLATE_ID` (fileId шаблона v2.0), `F0_SHEETS_SHARE_EMAILS` (кому writer-доступ), `F0_SHEETS_FOLDER_ID` (необязательная папка). Пусто = фича выключена (бот сообщает, данные сохранены).
- Write-scoped Drive-клиент `createDriveWriteClient()` (scope `drive`) — отдельно от readonly-пути скачивания аудио.
- Модуль `src/f0-sheets.ts`: чистые мапперы (`mapOkrRows`/`mapStakeholderRows`/`mapHypothesisRows`, `alignRowsToHeader`) + оркестратор `createClientSpreadsheet` (copy → get листов → ensure `_hypotheses` → header-driven запись через `values.batchUpdate` с предварительным `batchClear` → `permissions.create` трекеру). Ошибки → `F0SheetsError` с кодами и `spreadsheetId` для retry.
- Бот: на `/confirm`-ready вызывает `createSheetForSession` — прогресс-сообщение, ссылка + счётчики при успехе, понятная ошибка при сбое. `spreadsheetId` хранится на сессии и в персисте (`F0PersistedSessionSchema.spreadsheetId`) — retry не создаёт дубль.

**Вне scope:** карточка клиента и чеклист готовности (7.5); мультиклиентность/реестр (7.6 — таблица создаётся в Drive сервис-аккаунта, resolveSheetId по реестру там); авто-разметка эмодзи-статусов/условного форматирования кодом (приходит из шаблона); формулы человекочитаемых панелей (структура шаблона, зона Тимура).

## Acceptance Criteria

1. **Given** подтверждённый черновик (`ready`), **when** бот создаёт таблицу, **then** создан spreadsheet-копия шаблона v2.0 с листами «Панель OKR»/«Банк гипотез»/«Лог встреч» (+ машиночитаемые `_okr`/`_stakeholder_map`/`_hypotheses`/`_ops_logs`), машиночитаемые заполнены данными онбординга, доступ writer выдан трекеру.
2. **Given** статусная модель шаблона, **when** листы заполняются, **then** структура/форматирование/эмодзи-статусы соответствуют эталону v2.0 (наследуются копией шаблона), данные раскладываются по фактическим колонкам по именам заголовков (owner непустой — контракт F1; department с фолбэком на роль).
3. **Given** сбой Sheets/Drive API на любом шаге, **when** создание прервано, **then** трекер получает понятную ошибку с кодом; если таблица уже создана — `spreadsheetId` сохранён на сессии, и повтор (`/confirm`) дозаполняет её без дублирования (copy пропускается, данные `batchClear`+перезапись).

## Задачи

1. **Config + write-scope**: 3 env-переменные (`config.ts` + `.env.example`); `createDriveWriteClient()` в `adapters/drive.ts` (scope `drive`), не трогая readonly download-путь.
2. **`F0SheetsError`** (`errors.ts`): коды `template_not_configured|copy_failed|sheet_missing|header_missing|populate_failed|share_failed|auth|rate_limited|network`; поле `spreadsheetId` для retry.
3. **`src/f0-sheets.ts`**: чистые мапперы + `alignRowsToHeader` (юнит-тесты); `createClientSpreadsheet` с `withRetry`, ensure-`_hypotheses`, идемпотентным `existingSpreadsheetId`.
4. **Бот**: `createSheetForSession` на `/confirm`-ready; `spreadsheetId` на сессии + в персисте (`types.ts`); понятные тексты по кодам; deps-инъекция `createClientSpreadsheet` для тестов.
5. **Тесты**: мапперы, alignment, happy-path (copy/populate/share/counts), идемпотентность (existingId → без copy), ensure-`_hypotheses`, сбои (copy_failed без id; сбой после копии несёт id; sheet_missing; header_missing; auth). tsc + весь vitest зелёные.
6. **Смоук (Тимур)**: `scripts/f0-sheets-smoke.ts` — реальная копия из шаблона по данным SAM/GeOnline, проверка листов и доступа.

## Definition of Done

- AC1/AC2 юнитами (моки Google-клиентов): copy из шаблона, header-driven запись в правильные колонки, owner непустой, доступ трекеру; AC3 — идемпотентность и перенос `spreadsheetId` в ошибке.
- Регресс 7.1–7.3 не сломан; логи `{pipeline:'F0', step}`; enforcement соблюдён.
- **Осталось для «done» (вход Тимура):** загрузить шаблон v2.0 (`Geonline  Стратегический трекинг v2.0 (14).xlsx`) в Drive как Google Sheet и указать его fileId в `F0_SHEETS_TEMPLATE_ID`; заполнить `F0_SHEETS_SHARE_EMAILS`; убедиться, что SA имеет read-доступ к шаблону и storage-квоту в личном Drive; прогнать `scripts/f0-sheets-smoke.ts` вживую; сверить раскладку колонок человекочитаемых панелей с реальным шаблоном (формулы поверх `_okr`/`_hypotheses`).
