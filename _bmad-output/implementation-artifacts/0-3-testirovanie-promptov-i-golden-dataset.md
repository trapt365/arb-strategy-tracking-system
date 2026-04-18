# Story 0.3: Тестирование промптов и создание golden dataset

Status: ready-for-dev

## Story (Пользовательская история)

Как **аналитик практики (Тимур)**,
Я хочу **протестировать промпты F1 и F4 на реальных транскриптах Geonline**,
Чтобы **промпты были стабилизированы, а golden dataset готов для canary-тестирования в Epic 1**.

## Критерии приёмки

1. **Сценарий: Тестирование F1-цепочки на нескольких транскриптах**
   ```
   Дано ≥ 5 реальных транскриптов Geonline разных типов
   Когда F1-цепочка из 4 промптов прогнана на каждом
   Тогда < 50% требуют существенных правок
     И golden dataset из ≥ 5 транскриптов + эталонных выходов сохранён
     И F4-промпт протестирован хотя бы на 2 транскриптах
   ```

2. **Сценарий: Режим сбоя — Обнаружение нестабильности промптов**
   ```
   Дано промпты нестабильны (> 50% правок)
   Когда итерации не помогают
   Тогда зафиксирован стоп-сигнал и пересмотр подхода
   ```

**Определение «существенная правка»:** Любое изменение, меняющее обязательства (кто/что/срок), OKR-ссылки или фактическую точность. Перефразирование, форматирование — НЕ считаются.

## Задачи / Подзадачи

- [x] Задача 1: Подготовка промптов и тестовой инфраструктуры (КП: #1)
  - [x] 1.1 Создать директорию `prompts/` и написать 4 промпта F1-цепочки:
    - `prompts/extraction.md` — извлечение фактов, решений, цитат с метками времени и привязкой к спикерам, обязательства [{кто, что, срок, цитата}]
    - `prompts/analysis.md` — OKR-покрытие, статус гипотез, [speaker_check]-маркеры
    - `prompts/format-tracker.md` — форматирование в сканируемый отчёт (макс. 3 секции)
    - `prompts/agenda.md` — F4 повестка: макс. 3 пункта (какие KR проверить, открытые задачи, слепые зоны)
  - [x] 1.2 Создать `prompts/examples/` с few-shot примерами:
    - `commitments-positive.md` — примеры правильно извлечённых обязательств
    - `commitments-negative.md` — примеры граничных случаев (размытые обещания, условные)
  - [x] 1.3 Инициализировать `prompts/CHANGELOG.md` (версионирование промптов)
  - [x] 1.4 Написать тестовый скрипт `scripts/prompt-test.ts`:
    - Загружает промпт из файла с подстановкой `{{vars}}` (прототип `loadPrompt()`)
    - Прогоняет F1-цепочку (4 шага последовательно) через Claude API
    - Сохраняет сырой + разобранный выход для каждого шага
    - Выводит diff-статистику (структурная разница между прогонами)

- [x] Задача 2: Подготовка входных данных (КП: #1)
  - [x] 2.1 Конвертировать ≥ 5 транскриптов из `data/soniox-results/*.json` в Transcript Interface Contract:
    ```typescript
    { speakers: [{name, segments: [{start, end, text}]}], metadata: {date, duration, meeting_type} }
    ```
    (Маппинг: Soniox tokens → группировка по спикеру → объединение последовательных сегментов)
  - [x] 2.2 Загрузить OKR-контекст и стейкхолдерную карту из Google Sheets (листы `_okr` и `_stakeholder_map`, snake_case заголовки)
  - [x] 2.3 Подготовить тестовые входы: транскрипт + okrContext + stakeholderMap для каждого из ≥ 5 транскриптов

- [ ] Задача 3: Прогон F1-цепочки и итерация (КП: #1)
  - [ ] 3.1 Прогнать F1-цепочку на каждом из ≥ 5 транскриптов
  - [ ] 3.2 Ручная экспертная оценка каждого выхода Тимуром:
    - Фактическая точность (цитаты соответствуют транскрипту?)
    - Извлечение обязательств (кто/что/срок/цитата верны?)
    - OKR-покрытие (обсуждённые KR опознаны?)
    - [speaker_check] маркеры (правильно ли определены роли?)
    - [approximate] маркеры (оправданы ли неточные цитаты?)
  - [ ] 3.3 Подсчитать долю правок: % транскриптов, требующих существенных правок
  - [ ] 3.4 Если доля правок > 50%: итерировать промпты (до 3 циклов), документировать изменения в CHANGELOG.md
  - [ ] 3.5 Если после 3 итераций доля правок > 50%: зафиксировать стоп-сигнал (КП: #2)

- [ ] Задача 4: Тест F4-промпта (КП: #1)
  - [ ] 4.1 Прогнать `prompts/agenda.md` на ≥ 2 транскриптах
  - [ ] 4.2 Оценить: релевантность 3 пунктов повестки, использование F5-метрик (если есть), корректность ссылок на обязательства из F1

- [ ] Задача 5: Формирование golden dataset (КП: #1)
  - [ ] 5.1 Выбрать финальные ≥ 5 транскриптов для golden set (разнообразие: 1:1, группа, code-switching, разные отделы)
  - [ ] 5.2 Сохранить в `data/golden/`:
    - `transcript-{N}.json` — нормализованный транскрипт (Transcript Interface Contract)
    - `f1-reference-{N}.json` — эталонный F1-выход (проверенный Тимуром)
    - `f4-reference-{N}.json` — эталонный F4-выход (для 2+ транскриптов)
  - [ ] 5.3 Создать `data/golden/manifest.json` — метаданные: тип встречи, длительность, языки, покрытие сценариев
  - [ ] 5.4 Определить семантические проверки для canary-тестов:
    - ЕСЛИ транскрипт содержит обязательства → `commitments[]` не пуст
    - ЕСЛИ OKR-контекст присутствует → `okr_references[]` не пуст

- [ ] Задача 6: Документация результатов (КП: #1, #2)
  - [ ] 6.1 Создать `docs/prompt-testing-results.md`:
    - Таблица: транскрипт × доля правок × проблемы × итерации
    - Финальная доля правок и Go/No-Go для промптов
    - Выводы для Epic 1
  - [ ] 6.2 Обновить `prompts/CHANGELOG.md` финальными версиями

## Заметки для разработчика

### Это Validation Story, НЕ Production Code

Как и Story 0.1 — код здесь одноразовый (тестовые скрипты). Production-реализация `loadPrompt()`, `f1-report.ts`, canary-тест — в Epic 1 (Stories 1.4a, 1.11).

Цель: **стабилизировать промпты** и **создать golden dataset**, не писать production-пайплайн.

### F1-цепочка из 4 промптов — Архитектурный контракт

Из architecture.md — цепочка промптов (НЕ один гигантский):

| Шаг | Файл промпта | Вход | Выход |
|-----|---------------|------|-------|
| 1. Извлечение | `extraction.md` | транскрипт + стейкхолдерная карта | факты, решения, цитаты с метками времени, обязательства [{кто, что, срок, цитата}] |
| 2. Анализ | `analysis.md` | выход извлечения + OKR-контекст | OKR-покрытие, статус гипотез, [speaker_check]-маркеры |
| 3. Форматирование | `format-tracker.md` | выход анализа | Сканируемый отчёт (макс. 3 секции) |
| 4. (Доставка) | — | форматированный отчёт | В Story 0.3 не нужен — доставка через Telegram = Epic 1 |

**SLA в production:** < 15 мин (4 × 2-3 мин). В тестовом скрипте SLA не критичен.

### Промпт-переменные — Контракт

Промпты используют `{{camelCase}}` переменные, подставляемые через `loadPrompt(name, vars)`:
- `{{transcript}}` — полный текст транскрипта
- `{{okrContext}}` — OKR/KR из Sheets
- `{{stakeholderMap}}` — маппинг спикера → роль/отдел/зона ответственности

**Правило:** Незаменённая `{{var}}` → throw Error (мгновенный отказ). Реализовать в тестовом скрипте.

### Входные данные — Уже есть

**Soniox-транскрипты (из Story 0.1):** 7 файлов в `data/soniox-results/`:
- `audio1100318212.m4a.json` — code-switching РУС↔КАЗ
- `audio1111482399.m4a.json`, `audio1554018312.m4a.json`, `audio1602529797.m4a.json`, `audio1663213769.m4a.json`, `audio1721976611.m4a.json`, `audio1951904349.m4a.json`

**Формат Soniox:** `{ id, text, tokens: [{ text, start_ms, end_ms, confidence, speaker, language }] }`

**Маппинг Soniox → Contract (из заметок Story 0.1):**
- Группировать tokens по `speaker`
- Объединять последовательные tokens одного спикера в сегменты
- `name` = `Speaker {N}` (маппинг на имена — через stakeholder_map)

**Данные из Sheets (из Story 0.2):**
- `_stakeholder_map`: `full_name`, `speaker_name`, `department`, `role`, `bsc_category`, `responsibility_areas`, `interests`, `notes`
- `_okr`: `kr_number`, `short_name`, `key_result`, `owner`, `owner_position`, `current_status`, `target`, `progress`, `deadline`, `okr_group`, `quarter`
- Доступ через `sheets/Code.js` (clasp-managed Apps Script) — или прямое чтение через Google Sheets API

### Claude API — Технические детали

- **SDK:** `@anthropic-ai/sdk` (НЕ langchain, НЕ openai)
- **Разбор выхода:** `parseClaudeJSON(raw, ZodSchema)` — убрать markdown fences → JSON.parse → Schema.parse
- **Повтор:** 3 попытки, экспоненциальная задержка (1с, 3с, 9с) — реализовать в тестовом скрипте
- **Структурированный выход:** Рассмотреть Claude tool use / structured output mode для Zod-валидации

### Zod-схемы — Контракт выхода

Из architecture.md (`src/types.ts`):
```typescript
// ExtractionOutput (Шаг 1)
{
  decisions: string[],
  commitments: [{ who: string, what: string, deadline: string, quote: string }],
  citations: [{ timestamp: number, speaker: string, text: string }],
  facts: string[]
}

// AnalysisOutput (Шаг 2)
{
  okr_coverage: [{ kr: string, status: "discussed" | "mentioned" | "blind_zone" }],
  hypothesis_status: [{ name: string, status: "idea" | "in_test" | "result" }],
  alerts: string[]
}
```

**Валидация:** Шаги 1-2: `.parse()` (жёсткий отказ). Шаги 3-4: `.safeParse()` + фолбэк (мягкая деградация). В тестовом скрипте: всегда `.parse()` — нужны чистые данные.

### Canary-тест — Что готовим для Story 1.11

Golden dataset из Story 0.3 используется в Story 1.11 (canary-тест):
- **Вход:** 5 фиксированных golden-транскриптов
- **Метрика:** % структурных изменений (JSON-структура, НЕ текст)
- **Пороги:** < 30% = ОК; 30-50% = ручная проверка; > 50% = откат
- **Семантические проверки:** обязательства не пусты, если есть во входе; okr_references не пусты, если есть OKR-контекст

Story 0.3 создаёт данные и определяет проверки. Story 1.11 автоматизирует прогон.

### Маркеры качества — Калибровка доверия

Из PRD и UX-спецификации:
- **[approximate]** — цитата без точного совпадения в транскрипте → помечается
- **[speaker_check]** — > 70% сегментов спикера не совпадают с ролями в стейкхолдерной карте → помечается
- **Первые 5 отчётов определяют всё** (UX-spec): «Первые отчёты должны быть идеальными, ценой скорости или полноты. Точность > полнота.»
- **AI отправляет только то, что может подкрепить данными.** Неуверенные фрагменты опускаются.

### Предыдущие Story — Уроки

**Story 0.1 (Валидация Soniox):**
- REST API v1 (`api.soniox.com/v1`), НЕ gRPC SDK — SDK `@soniox/soniox-node` устарел
- Модель: `stt-async-v4`, параметры: `enable_speaker_diarization`, `enable_language_identification`, `language_hints: ["ru", "kk"]`
- 7 из 8 файлов обработаны успешно; 1 mp4 отклонён (Invalid audio file)
- Цена: ~$0.11/час (~$0.0019/мин)
- **Нерешённые проблемы:** вебхук не реализован, риск нехватки памяти на больших файлах, package.json с несуществующими версиями TS

**Story 0.2 (Онбординг Geonline):**
- Данные F0 собраны без живой сессии — из существующих артефактов + валидация Азизой
- snake_case заголовки — контракт для всех downstream-адаптеров
- Apps Script (`sheets/Code.js`) генерирует скрытые листы с нормализованными данными

### Git-аналитика

Последние коммиты:
- `cce1c7a` — Репрайоритизация Phase 1: F1+F4 фокус, F5 бот отложен в Growth
- `311718f` — F0 Context Apps Script (clasp-managed адаптер)
- `3da02f2` — Soniox validation GO: WER подтверждён, code-switching ОК
- `2f5ddd8` — Тестовая среда для валидации Soniox API

**Паттерн коммитов:** `type(scope): описание` (conventional commits, русский/английский микс).

### Заметки по структуре проекта

```
prompts/                  # НОВОЕ — создаётся в этой story
├── CHANGELOG.md
├── extraction.md
├── analysis.md
├── format-tracker.md
├── agenda.md
└── examples/
    ├── commitments-positive.md
    └── commitments-negative.md

data/
├── soniox-results/       # СУЩЕСТВУЮЩЕЕ — 7 JSON-транскриптов (Story 0.1)
└── golden/               # НОВОЕ — golden dataset
    ├── manifest.json
    ├── transcript-1.json  # Нормализованный (Transcript Interface Contract)
    ├── f1-reference-1.json
    └── ...

scripts/
├── soniox-test.ts        # СУЩЕСТВУЮЩЕЕ (Story 0.1)
└── prompt-test.ts         # НОВОЕ — тестовый скрипт для промптов

docs/
├── soniox-validation-results.md  # СУЩЕСТВУЮЩЕЕ
└── prompt-testing-results.md     # НОВОЕ — результаты тестирования промптов
```

### Важные ограничения

1. **Не писать production-код** — `src/` не трогаем. Всё в `scripts/` и `prompts/`
2. **`loadPrompt()` в скрипте — прототип**, production-версия в Story 1.4a
3. **Claude API key** — в `.env` (`API_KEY_CLAUDE`), .env.example уже должен существовать
4. **Sheets API** — через googleapis или ручной экспорт CSV. Ключ сервисного аккаунта = `SHEETS_SERVICE_ACCOUNT` в .env
5. **Стоп-сигнал** — если доля правок > 50% после 3 итераций, документировать и ОСТАНОВИТЬСЯ. Не пытаться обойти.

### Ссылки на источники

- [Источник: _bmad-output/planning-artifacts/epics.md — Epic 0 Story 0.3, строки 413-429]
- [Источник: _bmad-output/planning-artifacts/architecture.md — Цепочка промптов, loadPrompt(), версионирование промптов]
- [Источник: _bmad-output/planning-artifacts/architecture.md — Методология canary-теста, спецификация golden dataset]
- [Источник: _bmad-output/planning-artifacts/architecture.md — Transcript Interface Contract, Zod-схемы]
- [Источник: _bmad-output/planning-artifacts/architecture.md — Структура файлов, соглашения об именовании]
- [Источник: _bmad-output/planning-artifacts/prd.md — Обоснование F1-цепочки, пороги качества, Go/No-Go ворота]
- [Источник: _bmad-output/planning-artifacts/prd.md — Риск R4 нестабильность промптов, порог отклонений]
- [Источник: _bmad-output/planning-artifacts/ux-design-specification.md — Качество первых 5 отчётов, маркеры [approximate]/[speaker_check]]
- [Источник: _bmad-output/implementation-artifacts/0-1-validaciya-provaydera-transkripcii-soniox.md — Детали Soniox API, маппинг Contract]
- [Источник: _bmad-output/implementation-artifacts/0-2-onbording-klienta-geonline-f0.md — Структура Sheets, контракт snake_case]

## Запись Dev-агента

### Использованная модель

### Ссылки на отладочные логи

### Список заметок о завершении

### Список файлов
