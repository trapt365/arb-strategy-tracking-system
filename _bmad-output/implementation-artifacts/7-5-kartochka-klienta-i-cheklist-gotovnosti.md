# Story 7.5: Карточка клиента и чеклист готовности к неделе 1

Status: done  # 2026-07-08: код + юнит-тесты + code-review-фиксы; часть Epic 7, live-verified через смоук 7.4 (карточка/чеклист собираются в success-пути). 502/502 vitest, tsc чист.

> Epic 7 (WP-39 Ф2), лёгкий формат. Продолжает 7.4: после создания таблицы бот собирает карточку клиента и показывает готовность.

## Пользовательская история

Как **коуч практики (Азиза)**,
я хочу **карточку клиента в боте и чеклист готовности**,
чтобы **видеть, что клиент готов к первой трекшн-встрече, а бот знал участников и расписание**.

## Контекст и границы scope

После `createSheetForSession` (7.4) бот собирает карточку из данных онбординга и кладёт в `data/{clientId}/card.json`, затем показывает чеклист готовности (🟢/🔴 + действие по каждому 🔴). Команда `/status` показывает чеклист в любой момент.

**В scope:**
- Модуль `src/f0-client-card.ts`: `clientIdFromCompany` (транслит кириллицы → slug), `buildClientCard` (company, участники [имя/роль/OKR-направление/telegram], CEO по роли, трекер=chatId, расписание, ссылка Sheets, дата старта), `persistClientCard`/`loadClientCard` (atomic `data/{clientId}/card.json`), `computeReadinessChecklist` + `renderReadinessMessage`.
- Типы `ClientCardSchema`/`ClientCardParticipantSchema` (types.ts).
- Бот: `finalizeClientCard` после создания таблицы (собрать+сохранить+показать чеклист); команда `/status`; регистрация команды.
- OKR-направление участника — best-effort матч имени участника к owner KR → title objective.

**Вне scope:** отрасль (в F0 не собирается — `industry: null`, инвариант 3, не выдумываем); структурирование расписания в слоты (хранится свободным текстом); реестр мультиклиентности (7.6, но `finalizeClientCard` его наполняет).

## Acceptance Criteria

1. **Given** завершённый онбординг, **when** карточка сохранена, **then** в `data/{clientId}/card.json` лежит карточка: компания, участники (имя/роль/OKR-направление/telegram), CEO, трекер (chatId), расписание, ссылка на Sheets, дата старта.
2. **Given** карточка и таблица созданы, **when** трекер запрашивает `/status`, **then** бот показывает чеклист готовности к неделе 1 (данные загружены, KR считаемы, участники и слоты заполнены, Sheets доступен) с 🟢/🔴 по пунктам.
3. **Given** незавершённые пункты, **when** статус показан, **then** по каждому 🔴 понятно действие (инвариант 1 по KR не обойти — 🔴 указывает на /resume).

## Задачи

1. Типы `ClientCard*` (types.ts).
2. Модуль `src/f0-client-card.ts` (чистые ф-ии + persist/load + чеклист) — юнит-тесты.
3. Бот: `finalizeClientCard` в success-пути 7.4; `/status`; setMyCommands.
4. Тесты: slug (транслит/edge), buildClientCard (CEO/OKR-направление/telegram/industry=null), persist/load roundtrip, чеклист (все 🟢; 🔴 при blocking KR / нет расписания / нет Sheets), рендер.

## Definition of Done

- 3 AC юнитами; tsc чист; весь vitest зелёный; регресс 7.1–7.4 не сломан.
- Логи `{pipeline:'F0', step:'f0.client_registered'}`.
