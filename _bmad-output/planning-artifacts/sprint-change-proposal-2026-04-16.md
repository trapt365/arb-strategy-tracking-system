# Sprint Change Proposal — 2026-04-16

**Триггер:** Встреча Айдар—Азиза—Тимур 15 апреля 2026 (61 мин). Переприоритизация функций MVP.
**Scope:** Minor — прямая корректировка в рамках существующей эпик-структуры.
**Рекомендованный путь:** Direct Adjustment.

---

## 1. Резюме проблемы

Встреча 15 апреля выявила несоответствие между запланированным Phase 1 scope и реальными приоритетами стейкхолдеров:

- **F5 (сбор метрик через бота)** — не востребован на MVP. Азиза будет собирать метрики вручную на еженедельных созвонах и вносить в Google Sheets. Бот для F5 — Growth.
- **F3-lite (CEO-сводка)** — не срочно. Дамиру достаточно текущих еженедельных отчётов от Азизы. Отложен после F4.
- **F2 (QC трекера)** — подтверждён как Phase 2. Айдар уточнил: ему достаточно еженедельных отчётов с динамикой.
- **NPS-опросник** — новая задача, ранее отсутствовавшая в PRD. Раз в 1-2 месяца.
- **F5 метрики определены** — Азиза предложила конкретные метрики по департаментам Geonline (SuperApp: DAU/MAU + Revenue per DAU; Продажи: конверсия + выручка + ср. чек; Маркетинг: лиды + CAC).

**Ключевой вывод:** MVP фокусируется на F1 + F4. Scope уменьшается — MVP ускоряется.

---

## 2. Анализ влияния

### Влияние на эпики

| Эпик | Было | Стало | Изменение |
|------|------|-------|-----------|
| Epic 0 (Pre-MVP) | in-progress | in-progress | Story 0.2 дополняется F5 метриками. NPS как новая задача |
| Epic 1 (F1 отчёт) | Phase 1, после Epic 2 | **Phase 1, приоритет #1** | Фокус ближайших 2 недель |
| Epic 2 (F5 бот) | Phase 1, Milestone 2 | **Growth** | Ручной сбор через Азизу на MVP |
| Epic 3 (F4 повестка) | Phase 1, после Epic 2 | **Phase 1, приоритет #2** | Сразу после Epic 1. Не зависит от F5 бота |
| Epic 4 (F3-lite) | Phase 1, Milestone 2 | **Phase 1, отложен** | После стабилизации F1 + F4 |
| Epic 5 (F2 QC) | Phase 2 | Phase 2 | Без изменений |
| Epic 6 (Growth) | Growth | Growth | Epic 2 добавлен в scope |

### Новая последовательность Phase 1

```
Epic 0 (Pre-MVP) → Epic 1 (F1, ~2 нед) → Epic 3 (F4, ~2 нед) → Epic 4 (F3-lite, если время)
```

### Влияние на артефакты

| Артефакт | Секции с конфликтом | Критичность |
|----------|-------------------|-------------|
| PRD | Product Scope Phase 1, Project Classification, Deployment Milestones | Medium |
| Architecture | Functional Requirements, Deployment Milestones, Data Flow | Medium |
| UX Design | F5 UX-DR, F3-lite секции, приоритизация | Low |
| Epics | Epic 2 пометка, порядок | Medium |
| sprint-status.yaml | Порядок, статусы | Medium |

---

## 3. Рекомендованный подход

**Direct Adjustment** — модификация сторий и переупорядочивание эпиков.

**Обоснование:**
- Ни одна завершённая стория не требует переделки
- Scope уменьшается → MVP быстрее и проще
- Архитектура и технологии не меняются
- F4 повестка не теряет метрики — Sheets adapter читает данные, введённые Азизой вручную
- Effort: Low. Risk: Low. Timeline: ускоряется

---

## 4. Конкретные правки артефактов

### 4.1 PRD — Product Scope

**Файл:** `_bmad-output/planning-artifacts/prd.md`

**Правка 1 — Project Classification, строка 100:**

OLD:
```
| **MVP функции** | F1: Автоотчёт по топу, F2: QC-скоринг сессии, F3: Еженедельная агрегация, F4: Подготовка к встречам |
```

NEW:
```
| **MVP функции (Phase 1)** | F1: Автоотчёт по топу, F4: Подготовка к встречам. Отложены: F3-lite (после F4), F5 (ручной сбор на MVP, бот — Growth). Phase 2: F2 QC-скоринг |
```

Rationale: Приведение в соответствие с решением от 15 апреля.

---

**Правка 2 — Product Scope, Phase 1 (строки ~218-230):**

OLD:
```
### MVP Phase 1 (недели 1-4): «Трекер + Клиент»

> Week 1 = разгон (первые 3 отчёта тестовые). Полный режим с Week 2. Детальная стратегия запуска — см. «Стратегия Scoping и приоритизация».

| Функция | Описание | Ценность |
|---------|----------|----------|
| F0 | Стейкхолдерная карта + доменное знание — Google Sheets шаблон, заполняется при подключении (~30 мин). Живой документ, ревизия ежемесячно | Контекст для AI |
| F1 | Автоотчёт по топу — транскрипт + контекст → structured output с цитатами → Telegram. Азиза проверяет, отправляет клиенту. **Двойная функция**: отчёт для клиента + инструмент accountability (зафиксированные обязательства с цитатами создают «цифровой след» обещаний) | Экономия 2ч/встречу + accountability |
| F4 | Подготовка к встречам — повестка в понедельник (3 пункта max): какие KR проверить, незакрытые action items, слепые зоны. **Ключевая feature для постановки практики**: повестка направляет трекера к вопросам, формирующим навык у команды (например: «спроси Жанель — какую гипотезу она хочет проверить и как измерит результат») | Трекер приходит подготовленной + формирует навык |
| F3-lite | Сводное уведомление для CEO — 5 строк + 🟢🟡🔴 по OKR + 1 инсайт/вопрос. Азиза проверяет перед отправкой. Понедельник утром | Прозрачность для CEO |
| F5 | Метрики департаментов — еженедельный сбор 2 ключевых метрик (leading + lagging) по каждому департаменту через Telegram-бот. Топ-менеджер отвечает 2 числами в 1 сообщение (~30 сек). Данные используются в F4 (повестка с объективными данными), F1 (верификация заявлений топа vs метрики), F3-lite (объективные 🟢🟡🔴 статусы). **Ключевая ценность**: pipeline видит реальную картину, а не только слова топов на сессиях | Объективность + раннее обнаружение проблем |
```

NEW:
```
### MVP Phase 1 (недели 1-4): «Трекер + Клиент»

> Week 1 = разгон (первые 3 отчёта тестовые). Полный режим с Week 2. Детальная стратегия запуска — см. «Стратегия Scoping и приоритизация».
>
> **Переприоритизация (15.04.2026):** По результатам встречи со стейкхолдерами (Айдар, Азиза) фокус Phase 1 сужен до F1 + F4. F5 метрики собираются Азизой вручную на встречах и вносятся в Google Sheets. F3-lite отложен до стабилизации F1 + F4. F5 бот — Growth.

| Функция | Описание | Ценность | Статус Phase 1 |
|---------|----------|----------|---------------|
| F0 | Стейкхолдерная карта + доменное знание — Google Sheets шаблон, заполняется при подключении (~30 мин). Живой документ, ревизия ежемесячно. **Включает F5 метрики:** 2 метрики (leading + lagging) по каждому департаменту, определённые совместно с Азизой | Контекст для AI | **Приоритет #0** |
| F1 | Автоотчёт по топу — транскрипт + контекст → structured output с цитатами → Telegram. Азиза проверяет, отправляет клиенту. **Двойная функция**: отчёт для клиента + инструмент accountability (зафиксированные обязательства с цитатами создают «цифровой след» обещаний) | Экономия 2ч/встречу + accountability | **Приоритет #1** (~2 нед) |
| F4 | Подготовка к встречам — повестка в понедельник (3 пункта max): какие KR проверить, незакрытые action items, слепые зоны. Метрики из Sheets (ручной ввод Азизы). **Ключевая feature для постановки практики**: повестка направляет трекера к вопросам, формирующим навык у команды | Трекер приходит подготовленной + формирует навык | **Приоритет #2** (~2 нед) |
| F3-lite | Сводное уведомление для CEO — 5 строк + 🟢🟡🔴 по OKR + 1 инсайт/вопрос. Азиза проверяет перед отправкой. Понедельник утром | Прозрачность для CEO | **Отложен** (после F4) |
| F5 | Метрики департаментов — **MVP: ручной сбор** Азизой на еженедельных встречах, ввод в Google Sheets. Данные используются в F4 (повестка с объективными данными), F1 (верификация заявлений). **Growth: автоматический сбор через Telegram-бот** (Epic 2) | Объективность + раннее обнаружение проблем | **Ручной** (бот — Growth) |
```

Rationale: Отражает решение от 15 апреля. F5 данные сохраняются для pipeline через ручной ввод в Sheets.

---

### 4.2 Architecture — Deployment Milestones

**Файл:** `_bmad-output/planning-artifacts/architecture.md`

**Правка — Deployment Milestones (строки ~187-199):**

OLD:
```
### Deployment Milestones

**Milestone 1 — Core Pipeline (Day 1):**
- F1 pipeline (chain of 4 steps)
- Telegram bot (report, approve, reject + inline buttons)
- Sheets adapter (read OKR, stakeholder map)
- Transcript parser
- Ops logging (минимальный)
- Docker + health check + watchdog

**Milestone 2 — Full Pipeline (Week 2):**
- F4 (повестка) — включается после 2+ встреч
- F5 (метрики) — inline-кнопки с диапазонами
- F3-lite (CEO summary) — генерация для ручной отправки
- Edit command
- Canary test + golden dataset
- Scheduler + missed job detection
```

NEW:
```
### Deployment Milestones

> **Переприоритизация (15.04.2026):** F5 бот и F3-lite вынесены из Phase 1. F5 метрики вводятся Азизой вручную в Sheets.

**Milestone 1 — F1 Core Pipeline (~2 нед):**
- F1 pipeline (chain of 4 steps)
- Telegram bot (report, approve, reject + inline buttons)
- Sheets adapter (read OKR, stakeholder map, F5 metrics from manual entry)
- Transcript parser (Soniox + /upload fallback)
- Ops logging (минимальный)
- Docker + health check + watchdog
- Edit command
- Canary test + golden dataset

**Milestone 2 — F4 Повестка (~2 нед):**
- F4 (повестка) — включается после 2+ встреч
- Scheduler: node-cron для F4 (Пн 9:00) + missed job detection
- Bot Menu: [📋 Повестка] + кэширование

**Milestone 3 — F3-lite (после стабилизации F1+F4):**
- F3-lite (CEO summary) — генерация для ручной отправки
- Scheduler: добавить F3-lite cron

**Growth — F5 Bot (при масштабировании):**
- F5 (метрики) — inline-кнопки с диапазонами, авто-сбор через Telegram
```

Rationale: Milestones 1-2 теперь отражают реальный порядок (F1 → F4). F3-lite выделен в Milestone 3. F5 бот — Growth.

---

### 4.3 Epics — пометка Epic 2

**Файл:** `_bmad-output/planning-artifacts/epics.md`

**Правка — заголовок Epic 2 (строка ~835):**

OLD:
```
## Epic 2: Система собирает метрики от топ-менеджеров (F5)

**Цель:** Топы отвечают на запрос метрик в 1 тап → данные сохранены → доступны для F4, F1, F3-lite. Объективные данные для верификации.

**FRs:** FR50-FR54, FR74, FR89

**Порядок в Milestone 2:** Первый (создаёт scheduler, обогащает F4/F3-lite)
```

NEW:
```
## Epic 2: Система собирает метрики от топ-менеджеров (F5) — Growth

> **Перенесён в Growth (15.04.2026).** На MVP F5 метрики собираются Азизой вручную на встречах и вносятся в Google Sheets. Sheets adapter (Epic 1) читает эти данные для F4 и F1. Бот F5 реализуется при масштабировании на 3+ клиентов.

**Цель:** Топы отвечают на запрос метрик в 1 тап → данные сохранены → доступны для F4, F1, F3-lite. Объективные данные для верификации.

**FRs:** FR50-FR54, FR74, FR89

**Порядок:** Growth (триггер: 3+ клиентов или высокая нагрузка на Азизу по ручному сбору)
```

Rationale: Epic 2 сохраняется для будущей реализации, но явно помечен как Growth.

---

**Правка — заголовок Epic 3 (строка ~956):**

OLD:
```
**Порядок в Milestone 2:** Второй (после F5). 1-2 итерации промпта с Азизой заложены.
```

NEW:
```
**Порядок:** Milestone 2, сразу после Epic 1. Не зависит от F5 бота — метрики из Sheets (ручной ввод Азизы). 1-2 итерации промпта с Азизой заложены.
```

Rationale: F4 больше не зависит от F5 бота.

---

**Правка — Story 2.1 Scheduler:**

Scheduler (node-cron + watchdog) остаётся нужным, но переносится в Epic 3 как инфраструктурная зависимость для F4 (Пн 9:00). Предлагается выделить Story 2.1 из Epic 2 и включить в Epic 3 как Story 3.0.

OLD (Epic 2, Story 2.1):
```
### Story 2.1: Scheduler — shared component для batch pipeline
```

NEW (Epic 3, Story 3.0):
```
### Story 3.0: Scheduler — shared component для batch pipeline

(перенесён из Epic 2, Story 2.1)
```

Rationale: Scheduler нужен для F4 cron (Пн 9:00). Без F5 бота scheduler не нужен в Epic 2.

---

### 4.4 sprint-status.yaml

**Файл:** `_bmad-output/implementation-artifacts/sprint-status.yaml`

**Правка — Epic 2 и Epic 3 секции:**

OLD:
```yaml
  # Epic 2: Система собирает метрики от топ-менеджеров (F5)
  epic-2: backlog
  2-1-scheduler-shared-component-dlya-batch-pipeline: backlog
  2-2-f5-onboarding-pervoe-soobshchenie-topu: backlog
  2-3-f5-weekly-collection-sbor-metrik: backlog
  2-4-f5-storage-i-trendy: backlog
  2-5-f5-auto-deactivation-i-fallbacks: backlog
  epic-2-retrospective: optional

  # Epic 3: Трекер получает повестку к встречам (F4)
  epic-3: backlog
  3-1-konveyer-f4-generaciya-povestki: backlog
```

NEW:
```yaml
  # Epic 2: Система собирает метрики от топ-менеджеров (F5) — DEFERRED TO GROWTH (2026-04-15)
  # На MVP: F5 метрики вводятся Азизой вручную в Google Sheets
  # Story 2.1 (Scheduler) перенесён в Epic 3 как Story 3.0
  epic-2: deferred-growth
  2-1-scheduler-shared-component-dlya-batch-pipeline: moved-to-3-0
  2-2-f5-onboarding-pervoe-soobshchenie-topu: deferred-growth
  2-3-f5-weekly-collection-sbor-metrik: deferred-growth
  2-4-f5-storage-i-trendy: deferred-growth
  2-5-f5-auto-deactivation-i-fallbacks: deferred-growth
  epic-2-retrospective: optional

  # Epic 3: Трекер получает повестку к встречам (F4)
  epic-3: backlog
  3-0-scheduler-shared-component-dlya-batch-pipeline: backlog  # перенесён из Epic 2
  3-1-konveyer-f4-generaciya-povestki: backlog
```

Rationale: Отражает перенос Epic 2 в Growth и перемещение Scheduler в Epic 3.

---

## 5. План реализации правок

| # | Действие | Артефакт | Кто |
|---|---------|---------|-----|
| 1 | Обновить sprint-status.yaml | implementation-artifacts | Тимур (dev) |
| 2 | Обновить PRD — scope Phase 1 | planning-artifacts/prd.md | Тимур (dev) |
| 3 | Обновить Architecture — milestones | planning-artifacts/architecture.md | Тимур (dev) |
| 4 | Обновить Epics — пометки + перенос Scheduler | planning-artifacts/epics.md | Тимур (dev) |
| 5 | Дополнить Story 0.2 — F5 метрики + NPS | Отдельная задача | Тимур (SM/dev) |

**Scope classification:** Minor — прямая корректировка артефактов аналитиком.

**Критерии успеха:**
- sprint-status.yaml отражает новый порядок
- PRD Phase 1 scope обновлён
- Epics не содержат противоречий с решением от 15 апреля
- F4 промпт может использовать метрики из Sheets (ручной ввод) без изменений в архитектуре

---

## 6. Что НЕ меняется

- Стек технологий (TypeScript, grammY, Claude API, Sheets, Docker)
- Архитектурные решения (ADR-001 — ADR-004)
- Epic 1 (F1) — содержание сторий без изменений
- Epic 5 (F2 QC) — остаётся Phase 2
- Epic 6 (Growth) — без изменений
- UX patterns (inline buttons, approve flow, progress updates)
- Sheets adapter — уже спроектирован для чтения метрик из Sheets (адаптер не знает, кто ввёл данные)
