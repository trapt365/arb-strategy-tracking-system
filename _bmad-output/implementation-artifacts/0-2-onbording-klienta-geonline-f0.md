# Story 0.2: Онбординг клиента Geonline (F0)

Status: ready-for-dev

## Story

As a **аналитик практики (Тимур)**,
I want **заполнить стейкхолдерную карту и определить F5 метрики совместно с Дамиром (CEO Geonline)**,
So that **система имеет полный контекст клиента (F0) для генерации отчётов F1, повесток F4, сводки F3-lite и сбора метрик F5**.

## Acceptance Criteria

1. **Given** шаблон стейкхолдерной карты в Google Sheets подготовлен
   **When** Тимур проводит сессию с Дамиром (~30 мин)
   **Then** заполнены по каждому топ-менеджеру: ФИО, департамент, роль, контуры ответственности, интересы/мотивация
   **And** все участники имеют корректные `speaker name` для будущего маппинга в Story 1.2

2. **Given** методология F5 (2 метрики на департамент: leading + lagging)
   **When** Тимур и Дамир проходят по каждому департаменту Geonline
   **Then** для каждого департамента определены ровно 2 метрики: 1 leading + 1 lagging
   **And** для каждой метрики зафиксированы: `metric_name`, `metric_type`, единица измерения, источник данных, ответственный топ
   **And** диапазоны (ranges) для inline-кнопок Telegram бота определены и записаны в F0 config (НЕ хардкод в коде)

3. **Given** актуальные OKR/KR клиента Geonline на текущий квартал
   **When** Тимур получает их от Дамира
   **Then** OKR/KR внесены в Google Sheets в отдельный лист с колонками `objective`, `key_result`, `owner`, `target`, `current`, `quarter`
   **And** структура заголовков соответствует контракту Sheets adapter из Story 1.3 (snake_case header names)

4. **Given** F0 заполнена
   **When** Тимур запрашивает у Дамира источники данных для метрик F5
   **Then** для каждой leading/lagging метрики записан источник (CRM/таблица/ручной ввод) и предполагаемая частота обновления
   **And** зафиксирован риск: какие метрики топ-менеджеры могут не знать наизусть (для fallback стратегии в Epic 2)

5. **Given** сессия завершена
   **When** Тимур формирует сводку
   **Then** в `_bmad-output/implementation-artifacts/0-2-onboarding-results.md` сохранены: список участников, департаменты, метрики, OKR, ссылка на Google Sheets, открытые вопросы
   **And** Дамир подтверждает (любым асинхронным способом — чат/email) корректность заполненной карты

## Tasks / Subtasks

- [ ] Task 1: Подготовка шаблона стейкхолдерной карты (AC: #1)
  - [ ] 1.1 Создать Google Spreadsheet `Geonline — F0 Context` (или использовать существующий ARB шаблон, если есть)
  - [ ] 1.2 Лист `stakeholder_map` со столбцами: `full_name`, `speaker_name`, `department`, `role`, `responsibility_areas`, `interests`, `notes`
  - [ ] 1.3 Лист `f5_metrics` со столбцами: `department`, `metric_name`, `metric_type` (leading|lagging), `unit`, `source`, `owner_speaker_name`, `ranges`, `notes`
  - [ ] 1.4 Лист `okr` со столбцами: `objective`, `key_result`, `owner`, `target`, `current`, `quarter`
  - [ ] 1.5 Все заголовки — snake_case (контракт Sheets adapter, см. Story 1.3 / architecture.md строки 130, 339)
  - [ ] 1.6 Расшарить таблицу с Дамиром (edit) и сервис-аккаунтом ARB (read), если он уже создан

- [ ] Task 2: Подготовка к сессии с Дамиром (AC: #1, #2, #3)
  - [ ] 2.1 Согласовать слот ~45 мин с Дамиром (буфер к заявленным 30 мин на случай уточнений)
  - [ ] 2.2 Подготовить чек-лист вопросов: участники, роли, контуры, текущие OKR/KR, метрики по департаментам
  - [ ] 2.3 Подготовить примеры F5 метрик (см. PRD строка 438): продажи `[лиды + выручка]`, маркетинг `[лиды + CAC]`, HR `[eNPS + текучесть]`, финансы `[cash flow + маржинальность]`, продукт `[DAU + NPS]`
  - [ ] 2.4 Подготовить пояснение методологии leading vs lagging (1 слайд / 1 абзац) — Дамир может не знать терминологию

- [ ] Task 3: Сессия — заполнение стейкхолдерной карты (AC: #1)
  - [ ] 3.1 Зафиксировать всех топ-менеджеров Geonline, попадающих в трекинг
  - [ ] 3.2 Для каждого: ФИО, департамент, роль, контуры ответственности, интересы/мотивация
  - [ ] 3.3 Назначить уникальный `speaker_name` (используется для маппинга Soniox `Speaker N` → реальные имена в Story 1.2)
  - [ ] 3.4 Отметить мультиролевых топов (CEO/основатели часто покрывают 2+ контура — критично для Speaker sanity check, см. PRD строка 502)

- [ ] Task 4: Сессия — определение F5 метрик (AC: #2, #4)
  - [ ] 4.1 Для каждого департамента — выбрать 1 leading и 1 lagging метрику (ровно 2, не больше)
  - [ ] 4.2 Зафиксировать единицы измерения и источники данных (CRM / Sheets / ручной ввод)
  - [ ] 4.3 Назначить ответственного топа (`owner_speaker_name` из stakeholder_map)
  - [ ] 4.4 Согласовать диапазоны для inline-кнопок (например для % выполнения: `< 15%`, `15-20%`, `20-25%`, `25%+` + свободный ввод). Диапазоны — в столбце `ranges` как JSON-массив
  - [ ] 4.5 Отметить метрики, которые топ может не знать наизусть → пометка для fallback стратегии в Epic 2

- [ ] Task 5: Сессия — внесение OKR/KR (AC: #3)
  - [ ] 5.1 Получить актуальные OKR/KR на текущий квартал (попросить Дамира скинуть документ заранее, если возможно)
  - [ ] 5.2 Внести в лист `okr` с привязкой `owner` к `speaker_name` из stakeholder_map
  - [ ] 5.3 Зафиксировать, какие KR имеют целевые числа и каких нет (gradient зрелости данных — релевантно Epic 3, F4 повестка)

- [ ] Task 6: Подтверждение и документация (AC: #5)
  - [ ] 6.1 Создать сводку `_bmad-output/implementation-artifacts/0-2-onboarding-results.md`: участники, департаменты, метрики, OKR, ссылка на Sheets, открытые вопросы
  - [ ] 6.2 Отправить Дамиру summary для асинхронного подтверждения (чат / email)
  - [ ] 6.3 Получить ack от Дамира — приложить скриншот / цитату в результирующий файл
  - [ ] 6.4 Зафиксировать дату ревизии стейкхолдерной карты (живой документ, ревизия ежемесячно — PRD строка 224)

- [ ] Task 7: Передача артефактов в проект (AC: #1, #2, #3)
  - [ ] 7.1 ID Google Spreadsheet добавить в `.env.example` как `GEONLINE_F0_SHEET_ID` (placeholder, реальный ID — в `.env`, не коммитить)
  - [ ] 7.2 Зафиксировать в `0-2-onboarding-results.md` контракт колонок (header names) — будет input для Story 1.3 (Sheets adapter)
  - [ ] 7.3 Уведомить Aydar/Aziza о готовности F0 (gate для Epic 1)

## Dev Notes

### Контекст: что такое F0 и почему это критично

F0 — **не pipeline**, а статичный input/knowledge layer для всех остальных pipeline (F1, F3-lite, F4, F5). Без качественной F0:
- F1 генерирует generic отчёты без понимания ролей и интересов топов
- F4 не может построить релевантную повестку
- F5 не знает какие метрики собирать и в каких диапазонах
- Speaker mapping в Story 1.2 не сможет привязать `Speaker N` от Soniox к реальным людям

См. architecture.md строки 29 (F0 определение), 87 (Speaker mapping), 191 (Sheets adapter input).

### Это НЕ story реализации кода

Эта story — **сессия онбординга + ручное заполнение Google Sheets**. Кода в `src/` не пишется. Артефакты:
- Google Spreadsheet `Geonline — F0 Context` (внешний)
- `_bmad-output/implementation-artifacts/0-2-onboarding-results.md` (документация результатов)
- Возможно обновление `.env.example` с `GEONLINE_F0_SHEET_ID` placeholder

### Контракт Sheets для будущей Story 1.3

Story 1.3 (Sheets adapter) будет читать F0 через `googleapis` пакет батчем за один запрос. Поэтому критично:
- **snake_case header names** (граница snake→camelCase в adapter, см. architecture.md строки 556-558 в epics.md)
- **Header-based чтение**, не по индексам столбцов — порядок столбцов можно менять без поломки кода
- **Стабильные имена листов**: `stakeholder_map`, `f5_metrics`, `okr`

Не добавляй декоративные merged cells в шапку — `googleapis` плохо их обрабатывает (architecture.md строка 72: "Quirks: merged cells").

### F5 метрики — ranges из F0, не хардкод

Критично: диапазоны для inline-кнопок Telegram бота (Story 2.x) должны браться **из F0 config**, а не быть зашитыми в код. Это позволит подключить нового клиента с другими диапазонами без правки кода (architecture.md строки 269, 288; epics.md строка 230, 881-882).

Пример формата `ranges` в Sheets:
```json
["< 15%", "15-20%", "20-25%", "25%+"]
```
или для абсолютных чисел:
```json
["0-50", "50-100", "100-200", "200+"]
```

### Speaker name контракт

`speaker_name` в `stakeholder_map` — это **ключ**, который Story 1.2 использует для маппинга Soniox `Speaker 1/2/3` → реальное имя. Правила:
- Уникален в пределах клиента
- Совпадает с тем, как человек представляется на встречах (Дамир должен подтвердить)
- ASCII или кириллица — без эмодзи и спец-символов

### Mультиролевые топы и Speaker sanity check

PRD строка 502: если > 70% реплик speaker'а не соответствуют его ролям по стейкхолдерной карте — пометка `[speaker_check]`. Поэтому для CEO/founder, кто покрывает 2+ контура, важно явно перечислить ВСЕ его контуры в `responsibility_areas` (через запятую/JSON-массив), иначе будут ложные срабатывания.

### Риски

| Риск | Mitigation |
|------|------------|
| Дамир не знает leading/lagging терминологию | Подготовить 1-абзацное объяснение + примеры из PRD строка 438 |
| Топы не знают свои метрики наизусть | Зафиксировать как риск для Epic 2 (F5 fallback: ручной ввод Азизой / Google Form, см. epics.md строка 219) |
| OKR/KR на квартал ещё не готовы | Использовать прошлый квартал как baseline + договориться о повторной ревизии |
| Дамир недоступен на 30+ мин | Разбить сессию на 2 части: stakeholder map (15 мин) + метрики/OKR (20 мин) |
| Source данных метрик — "в голове CEO" | Явно зафиксировать в `source: manual` и заложить в Epic 2 fallback |

### Project Structure Notes

- НЕТ кода в `src/`
- Документация: `_bmad-output/implementation-artifacts/0-2-onboarding-results.md` (NEW)
- Возможный update: `.env.example` (добавить `GEONLINE_F0_SHEET_ID=`)
- Внешний артефакт: Google Spreadsheet (ссылка фиксируется в `0-2-onboarding-results.md`)

### Зависимости и downstream consumers

- **Блокирует:** Story 1.3 (Sheets adapter) — нужен реальный лист с реальными данными для тестирования. Story 1.4a (F1 extraction) — нужен контекст для промптов
- **Зависит от:** ничего технического (manual story). Зависит от доступности Дамира
- **Gate для:** Epic 1 не должен стартовать без заполненной F0 (PRD строка 210: "Подключение Geonline: F0 заполнена")

### References

- [Source: _bmad-output/planning-artifacts/epics.md#Story-0.2 — lines 399-411]
- [Source: _bmad-output/planning-artifacts/epics.md#Epic-0 — lines 362-371]
- [Source: _bmad-output/planning-artifacts/epics.md — Покрытие FR55-56 → Epic 0 F0, line 337]
- [Source: _bmad-output/planning-artifacts/prd.md — F0 описание, line 224]
- [Source: _bmad-output/planning-artifacts/prd.md — F5 методология, line 228]
- [Source: _bmad-output/planning-artifacts/prd.md — Подключение Geonline gate, line 210]
- [Source: _bmad-output/planning-artifacts/prd.md — F5 примеры метрик, line 438]
- [Source: _bmad-output/planning-artifacts/prd.md — Speaker sanity check, line 502]
- [Source: _bmad-output/planning-artifacts/prd.md — F5 schema, lines 629-632]
- [Source: _bmad-output/planning-artifacts/prd.md — FR20/FR21 stakeholder map, lines 898-899]
- [Source: _bmad-output/planning-artifacts/architecture.md — F0 как knowledge layer, line 29]
- [Source: _bmad-output/planning-artifacts/architecture.md — Sheets adapter, line 72, 191]
- [Source: _bmad-output/planning-artifacts/architecture.md — F5 ranges из F0, lines 269, 288]
- [Source: _bmad-output/planning-artifacts/architecture.md — Speaker mapping, line 87]
- [Source: _bmad-output/planning-artifacts/research/methodology-and-metrics-research-2026-03-27.md §2.2 — leading/lagging методология]

### Previous Story Intelligence (0.1)

Story 0.1 — валидационная (Soniox), её learnings ограниченно применимы к 0.2 (manual story без кода). Релевантное:
- **Подтверждено**: Soniox корректно выдаёт `speaker` поле в tokens → speaker_name контракт в F0 имеет смысл
- **Подтверждено**: code-switching рус↔каз работает → не нужно в F0 разделять русско- и казахско-говорящих
- **Открытый вопрос из 0.1**: Speaker over-segmentation в одном тесте (1554/1663). Если подтвердится — может потребоваться пост-обработка в Story 1.2, но это НЕ влияет на формат F0
- **Стиль работы**: создавать отдельный results-документ по итогам story (как `docs/soniox-validation-results.md` в 0.1) — повторить паттерн для `0-2-onboarding-results.md`

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
