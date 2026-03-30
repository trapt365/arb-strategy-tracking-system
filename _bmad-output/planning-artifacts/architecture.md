---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
lastStep: 8
status: 'complete'
completedAt: '2026-03-27'
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - docs/tracking-process-as-is.md
  - docs/tracking-process-to-be.md
  - _bmad-output/planning-artifacts/research/methodology-and-metrics-research-2026-03-27.md
workflowType: 'architecture'
project_name: 'workspace'
user_name: 'Тимур'
date: '2026-03-27'
---

# Architecture Decision Document

_This document builds collaboratively through step-by-step discovery. Sections are appended as we work through each architectural decision together._

## Project Context Analysis

### Requirements Overview

**Functional Requirements:**

5 pipeline-функций (F1–F5) + 1 контекст (F0):

- **F0 (Контекст клиента):** стейкхолдерная карта + определение F5 метрик по департаментам — статичный input, заполняется при подключении клиента. **Не pipeline** — потребляется другими pipeline как knowledge
- **F1 Pipeline (real-time):** транскрипт → chain of 4 prompts → автоотчёт с цитатами и commitments. SLA < 15 мин. Верифицирует заявления топов через F5 метрики
- **F5 Pipeline (batch, Пн 8:00):** Telegram-бот → сбор 2 метрик (leading + lagging) по каждому департаменту от топов → запись в Sheets → тренды + алерты. Consumers: F4, F1, F3-lite
- **F4 Pipeline (batch, Пн 9:00):** агрегация всех F1 за неделю + F5 метрики → повестка по каждому топу (3 пункта max) + расхождения метрик vs заявлений
- **F3 Pipeline (batch, Пн):** агрегация → сводное уведомление CEO (5 строк + 🟢🟡🔴 подкреплённые F5 метриками). Gate: approve трекера
- **F2 (Phase 2):** QC-скоринг — talk ratio (30-45%), 4 шляпы (коуч/эксперт/трекер/фасилитатор), покрытие OKR (≥ 2 реплики = обсуждено)

**Глоссарий функций (метод / конструктор / продукт):**

| Код | Метод (что делает) | Конструктор (как реализован) | Продукт (результат) |
|-----|-------------------|----------------------------|---------------------|
| F0 | Определение контекста клиента | Ручное заполнение при онбординге | Стейкхолдерная карта + F5 метрики (knowledge, не pipeline) |
| F1 | Формирование отчёта по встрече | `f1-report.ts` pipeline (chain of 4 prompts) | Структурированный отчёт с цитатами и commitments |
| F2 | QC-скоринг сессии | `f2-qc.ts` pipeline (Phase 2) | Talk ratio + шляпы + покрытие OKR |
| F3 | Формирование CEO-сводки | `f3-lite.ts` pipeline | Сводное уведомление (5 строк + 🟢🟡🔴) |
| F4 | Подготовка повестки встречи | `f4-agenda.ts` pipeline | Повестка (agenda): 3 пункта × топ + расхождения метрик |
| F5 | Сбор метрик от топов | `f5-metrics.ts` pipeline | Метрики (leading + lagging) + тренды + алерты |

**Non-Functional Requirements:**

| Категория | Требование | Порог |
|-----------|-----------|-------|
| Reliability | Падения бота | ≤ 2 за 3 недели |
| Latency | F1 response | < 15 мин (4 steps × 2-3 мин) |
| Cost | API costs | < $100/мес |
| Ops | Время Тимура | < 2ч/нед |
| Security | Изоляция данных | По client_id, логическое (MVP) |
| Privacy | Контроль трекера | Все output'ы через approve |
| Resilience | Graceful degradation | Partial results при сбое step 3-4 |
| Observability | Logging + alerting | Sheet + Telegram ops-канал |
| Quality | Weekly canary test | 5 golden transcripts, diff < 30% (см. Canary Test MethodDescription ниже) |

**Scale & Complexity:**

- Primary domain: AI Automation Pipeline (push-first с persistence layer)
- Complexity level: High (без регуляторного бремени)
- Estimated architectural components: ~11 файлов (см. Starter Template Evaluation)

### Technical Constraints & Dependencies

1. **Transcript provider** — tldv (primary) или Soniox (fallback). Решение по результатам Day 1. Архитектурно: провайдер-агностичный Transcript Interface Contract (JSON schema)
2. **Chain of Prompts** — 4 шага, не один промпт. ADR: дебагируемость по частям, верификация каждого этапа
3. **Claude API** — основной LLM. Риск: обновление модели меняет поведение промптов
4. **Google Sheets API** — OKR-трекер, стейкхолдерная карта, F5 метрики, ops logs. Data access adapter (~50 строк). Quirks: merged cells, rate limits 100 req/100sec, token expiry
5. **Telegram Bot API** — command interface (5 команд трекера + F5 сбор метрик от топов). Лимит сообщения 4096 символов
6. **Контроль трекера** — архитектурное требование: полная автоматизация отправки запрещена на MVP
7. **Язык** — русский output, казахские цитаты в оригинале с пометкой
8. **VPS** — 24/7 (serverless cold start несовместим с SLA < 15 мин)
9. **Language/framework** — **TypeScript** (Node.js). Решено: ADR-001

### Cross-Cutting Concerns Identified

1. **Citation & verification** — structured output с цитатами-источниками (timestamp). Метки [approximate] и [speaker_check]
2. **Commitments engine** — extraction `[{who, what, deadline, quote}]` пронизывает F1, F4, accountability
3. **Metrics verification (F5)** — сравнение заявлений топов на сессиях с объективными метриками. Пронизывает F1 (верификация), F4 (повестка), F3-lite (статусы)
4. **Client isolation** — client_id во всех слоях: промпты, хранение, delivery. Code review при подключении 2-го клиента
5. **Fallback protocol** — каждый pipeline имеет ручной fallback. Трекер не зависает при сбое
6. **Prompt versioning & regression** — git, canary test, threshold 30% structural diff
7. **Speaker mapping** — стейкхолдерная карта → спикеры → роли → отчёт
8. **Approval workflow** — approve/edit/reject для каждого output перед доставкой клиенту
9. **QC methodology** — 4 шляпы трекера + talk ratio + покрытие OKR — единая модель оценки качества сессии (Phase 2)

## Starter Template Evaluation

### Primary Technology Domain

**AI Automation Pipeline** (backend-only, no UI). Telegram = интерфейс, Google Sheets = persistence layer. Нет стандартного starter template — custom project setup.

### Technology Stack (ADR-001)

| Компонент | Решение | Обоснование |
|-----------|---------|-------------|
| **Runtime** | Node.js + TypeScript | Event loop идеален для bot + API orchestration. Проект уже на Node.js |
| **Telegram Bot** | grammY | TypeScript-first, лучший middleware pattern, inline keyboards нативно. Score 5.0/5.0 |
| **LLM** | `@anthropic-ai/sdk` | Claude API напрямую, без langchain overhead |
| **Sheets** | `googleapis` | Официальный, полный API |
| **Validation** | Zod | Runtime validation + type inference для structured output от Claude |
| **Scheduler** | node-cron + watchdog | Missed job detection после restart. Score 4.0/5.0 |
| **Logging** | pino | Structured JSON logs |
| **DB (MVP)** | Google Sheets + JSON files | Sheets = read/human interface. JSON files = append-only backup. Score 4.1/5.0 |
| **DB (Growth)** | PostgreSQL | Trigger: 3-й клиент. Жёсткий, не «когда-нибудь» |
| **Deploy** | Docker → Hostinger VPS | `restart: unless-stopped` + health check |

**Init command:**
```bash
npm init -y && npx tsc --init
npm i grammy @anthropic-ai/sdk googleapis pino node-cron zod
npm i -D typescript @types/node tsx
```

### Project Structure (после Occam's Razor)

```
src/
├── bot.ts              # grammY: все команды + inline buttons + F5 collection (~200 строк)
├── f1-report.ts        # F1 pipeline: transcript → report, весь flow (~150 строк)
├── f4-agenda.ts        # F4 pipeline: weekly agenda (~100 строк)
├── f5-metrics.ts       # F5 pipeline: collect + store (~50 строк)
├── f3-lite.ts          # F3-lite pipeline: CEO summary (~80 строк)
├── adapters/
│   ├── sheets.ts       # Google Sheets read/write (~80 строк)
│   ├── transcript.ts   # tldv/Soniox parser, provider-agnostic (~60 строк)
│   └── claude.ts       # Claude API wrapper (~60 строк)
├── ops.ts              # logging + alerting + health check (~100 строк)
├── scheduler.ts        # node-cron + missed job detection (~50 строк)
├── types.ts            # Zod schemas (~80 строк)
└── index.ts            # Entry point (~30 строк)
prompts/                # Prompt templates (versioned in git, не в коде)
├── extraction.md
├── analysis.md
├── format-tracker.md
├── format-ceo.md
└── agenda.md
data/                   # Append-only JSON backup (runtime, не в git)
```

**~1000 строк** кода + промпты в `.md` файлах. 11 файлов. Каждый pipeline — один файл.

### Architecture Decision Records (Elicitation)

#### ADR-001: TypeScript (Node.js)

**Rationale:** Event loop нативно подходит для bot + cron + API calls в одном процессе. grammY — лучшая Telegram bot библиотека. Type safety через Zod для structured output от Claude. Проект уже на Node.js.

**Риск:** Если понадобится ML/NLP (Phase 2 QC) — Python лучше. Митигация: промпты в `.md` файлах, chain logic отделена от runtime. Python микросервис для QC — без переписывания.

#### ADR-002: Modular Monolith (упрощённый)

**Решение:** Один процесс, каждый pipeline — один файл. Без pipeline registry, без абстракций сверх необходимого.

**Rationale:** 5-7 встреч/нед, 3 batch jobs, один разработчик. Registry = абстракция ради абстракции. Если понадобится — 30 мин рефакторинга.

#### ADR-003: Sheets + JSON Files (Data Storage)

**Решение:** Sheets = read layer + human interface. JSON files на диске = append-only backup. PostgreSQL = Growth (trigger: 3-й клиент).

**Rationale:** Score 4.1/5.0 в матрице. Sheets-only рискует потерей данных. PostgreSQL на MVP = overkill. JSON files = 1 строка кода (`fs.writeFileSync`), zero cost, легко мигрировать.

#### ADR-004: F3-lite Delivery — ручная отправка

**Решение:** Бот генерирует текст F3-lite → Азиза копирует → отправляет Дамиру в WhatsApp/Telegram лично.

**Rationale:** Pipeline невидим для клиента. Zero dependencies на Дамира. 2-3 мин/нед. Автоматизация (Вариант C) — Growth при 5+ клиентах.

### Architectural Principles (First Principles Analysis)

**Архитектурные принципы** (формируют все решения):

1. **Данные > pipeline.** Append-only JSON на диске с Day 1. Pipeline можно переписать, данные — нет
2. **Changeability > Elegance.** Промпты в .md файлах. Pipeline = один файл. Минимум абстракций. Если функция в 1 месте — inline

**Проектные ограничения** (заданы извне):

3. **Вход = текст, откуда — неважно.** Transcript Interface Contract. Parser — отдельный модуль. Пересмотр audio-native через 6 мес
4. **Output = одно действие.** Formatting prompt оптимизирован для действия, не для полноты. Scannable > readable
5. **Контроль трекера определяет approval.** Организационное правило: трекер утверждает все output'ы перед доставкой клиенту. Архитектурная реализация: `approval_mode` как конфигурация: `full` → `review_after` → `exceptions_only`. MVP = `full` only

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

### Telegram UX Decisions

| Решение | Детали |
|---------|--------|
| **Inline-кнопки** | `[✅ Approve] [✏️ Edit] [❌ Reject]` под каждым отчётом. Один тап, не команда |
| **Заголовки** | `📋 Жанель │ Нед. 3 │ OKR-2 Продажи` — навигация без scroll |
| **F5 input** | Диапазоны: `[< 15%] [15-20%] [20-25%] [25%+]` + свободный ввод. Один тап > точное число |
| **Два чата** | Рабочий (отчёты + approve) и ops (алерты Тимуру). Не мешать потоки |
| **Формат отчёта** | Scannable: топ-3 решения + commitments list. Детали по запросу, не по умолчанию |

### Pre-mortem: Превентивные меры

| # | Сценарий провала | Мера | Когда | Сложность |
|---|-----------------|------|-------|-----------|
| 1 | Промпты сломались тихо (модель обновилась) | Semantic assertions в canary: «если есть обязательства — commitments не пустой» | Day 1 | Low |
| 2 | Топы не заполняют F5 | Inline-кнопки (1 тап) + fallback: Азиза вводит после встречи | Week 2 | Low |
| 3 | Sheets API rate limit при 3+ клиентах | `await sleep(100)` между calls (MVP). Rate limiter + queue (Growth) | Day 1 / Growth | Low / Medium |
| 4 | Process crash убивает всё | Docker `restart: unless-stopped` + health check + process isolation (try-catch) | Day 1 | Low |
| 5 | Тимур = SPOF на ops | Runbook (1 стр.) + auto-recovery + Айдар доступ к VPS dashboard | Pre-MVP | Low |
| 6 | Отчёт approved дважды | Status field: `generating│ready│approved│delivered`. If not ready → ignore. 5 строк | Day 1 | Low |
| 7 | F5 топ исправил ответ | Последний ответ до дедлайна (9:00) побеждает | Week 2 | Low |

### Canary Test — MethodDescription

| Параметр | Описание |
|----------|----------|
| **Вход** | 5 транскриптов (golden set) — фиксированный набор, не меняется между запусками |
| **Выход** | Diff report: % структурных изменений в output каждого pipeline (F1, F4, F3-lite) |
| **Порог** | < 30% = OK · 30-50% = review промптов (ручной анализ изменений) · > 50% = rollback на предыдущую версию промптов/модели |
| **Когда запускать** | (1) После обновления модели Claude (2) После изменения промптов (3) Еженедельно по расписанию (Milestone 2) |
| **Кто запускает** | Тимур (вручную на MVP, автоматизация — Growth) |
| **Semantic assertions** | Если транскрипт содержит обязательства → `commitments` не пустой. Если есть OKR-контекст → `okr_references` не пустой |
| **Определение structural diff** | Сравнение JSON-структуры output: наличие/отсутствие секций, количество commitments, количество citations. Текстовые формулировки не входят в diff |

### Решения отложенные до Phase 2 / Growth

| Решение | Когда | Trigger |
|---------|-------|---------|
| 4 шляпы трекера + talk ratio + покрытие OKR | Phase 2 | Кодификация утверждена Айдаром |
| Approval mode degradation (full → review_after) | Growth | Азиза approve > 95% без правок, 4+ недели |
| Rate limiter + request queue для Sheets | Growth | 3-й клиент |
| Local cache для OKR/stakeholder data | Growth | Sheets latency > 2 сек |
| Pipeline Registry | Growth | 6+ pipeline'ов |
| PostgreSQL миграция | Growth | 3-й клиент (жёсткий trigger) |
| F3-lite auto-delivery (Вариант C) | Growth | 5+ клиентов |
| F5 автоматический сбор через API (Bitrix24, CRM) | Growth | Клиент имеет CRM с API |
| Audio-native AI (без транскрипции) | Пересмотр через 6 мес | Качество audio-native достигло structured extraction |

## Core Architectural Decisions

### Decision Priority Analysis

**Critical (блокируют реализацию):**
- Language: TypeScript (Node.js) — ADR-001
- Bot library: grammY — Score 5.0/5.0
- Data storage: Sheets + JSON files — Score 4.1/5.0
- Deployment: Docker → Hostinger VPS
- Transcript Interface Contract: JSON schema

**Important (формируют архитектуру):**
- Pipeline pattern: modular monolith (один файл на pipeline)
- Scheduling: node-cron + watchdog + missed job detection — Score 4.0/5.0
- Telegram UX: inline buttons, editMessageText progress, two chats
- Auth: whitelist chat_id
- Delivery F3-lite: manual copy by tracker
- F5 ranges: from F0 config (stakeholder map), not hardcoded

**Deferred (post-MVP):**
- PostgreSQL (trigger: 3-й клиент)
- CI/CD pipeline (trigger: 2-й разработчик)
- Offsite backup (trigger: платящий клиент с SLA)
- QC scoring F2 (trigger: кодификация утверждена Айдаром)

### Data Architecture

| Решение | Выбор | Rationale |
|---------|-------|-----------|
| **Primary storage** | Google Sheets | Human-readable, уже используется клиентом |
| **Backup storage** | JSON files (`data/{client_id}/{date}/`) | Append-only, zero cost, миграция в PostgreSQL = скрипт |
| **Backup safety** | Cron `tar` раз в день, хранить 7 дней | VPS может быть пересоздан провайдером |
| **Validation** | Zod schemas на границе Claude → pipeline | Runtime type safety для structured output |
| **Transcript contract** | `{speakers: [{name, segments: [{start, end, text}]}], metadata: {date, duration, meeting_type}}` | Provider-agnostic |
| **Report schema** | Zod: `{decisions: [], commitments: [{who, what, deadline, quote}], okr_coverage: [], alerts: []}` | Определяется окончательно при разработке промптов |
| **F5 metrics** | Sheet: `client_id, department, metric_name, metric_type, value, week` | Минимальная schema |
| **F5 ranges** | Из F0 стейкхолдерной карты (config), не хардкод | Новый клиент = новые диапазоны без изменения кода |
| **Migration trigger** | PostgreSQL при 3-м клиенте | Жёсткий trigger |

### Authentication & Security

| Решение | Выбор | Rationale |
|---------|-------|-----------|
| **Bot auth** | Whitelist `chat_id` в config | Фиксированный набор пользователей |
| **Role-based access** | Config: `{tracker: [chatId], tops: [{chatId, name, dept}], ops: [chatId]}` | Логическое разделение |
| **Google Sheets** | Service account + auto-refresh OAuth2 | Token refresh в cron |
| **Claude API** | API key в `.env` | Стандартный подход |
| **Client isolation** | `client_id` в путях и промптах | Логическое, MVP |
| **Конфиденциальность** | F3-lite: без прямых цитат топов (промпт-level) | Privacy by design |
| **Delivery tests** | 3-5 critical path тестов: отчёт отправлен правильному топу | Предотвращение утечки данных между топами |

### API & Communication Patterns

| Решение | Выбор | Rationale |
|---------|-------|-----------|
| **Internal API** | Нет. Прямые вызовы между модулями | Монолит, один процесс |
| **External APIs** | Adapters: `sheets.ts`, `transcript.ts`, `claude.ts` | Замена провайдера = замена файла |
| **Error handling** | try-catch на уровне pipeline step. Partial results при сбое step 3-4 | Graceful degradation |
| **Retry** | 3 попытки, exponential backoff (1s, 3s, 9s) для Claude API | Transient errors |
| **Circuit breaker** | 3 неудачи за 5 мин → fallback mode. State в памяти, reset при restart | Pre-mortem: Claude API down |
| **Idempotency** | F5: последний ответ до 9:00. F1: unique per transcript URL | Предотвращение дублей |
| **Progress updates** | `editMessageText` — одно сообщение обновляется 4 раза при генерации F1 | UX: Азиза видит прогресс, не нервничает |

### Infrastructure & Deployment

| Решение | Выбор | Rationale |
|---------|-------|-----------|
| **Hosting** | Hostinger VPS, Docker | `restart: unless-stopped` |
| **Deploy (MVP)** | `deploy.sh`: ssh → git pull → `docker compose up -d --build` | Zero-downtime: без `down`, новый контейнер заменяет старый |
| **Deploy (Growth)** | GitHub Actions → auto deploy on push to main | Trigger: 2-й разработчик |
| **Health check** | HTTP `/health`. Cron на VPS: `curl` каждую минуту | Restart + alert если down |
| **Monitoring** | pino JSON logs + Telegram ops канал | Файл (debug) + Telegram (alerts) |
| **Backup** | Sheets + JSON files + cron `tar` раз в день (7 дней) | Три уровня защиты данных |
| **Environment** | `.env`: API keys, chat IDs, client config | Один файл |
| **Docker** | `Dockerfile` + `docker-compose.yml`. Один сервис | Devcontainer → prod = тот же image |
| **Tests** | `tests/delivery.test.ts`: 3-5 critical path тестов | Конфиденциальность delivery |

### Updated Project Structure (post-Party Mode)

```
src/
├── bot.ts              # grammY: commands + inline buttons + F5 + progress updates (~250 строк)
├── f1-report.ts        # F1: transcript → report, весь flow (~200-250 строк)
├── f4-agenda.ts        # F4: weekly agenda (~100 строк)
├── f5-metrics.ts       # F5: collect + store (~50 строк)
├── f3-lite.ts          # F3-lite: CEO summary (~80 строк)
├── adapters/
│   ├── sheets.ts       # Google Sheets read/write (~80 строк)
│   ├── transcript.ts   # tldv/Soniox parser (~60 строк)
│   └── claude.ts       # Claude API + circuit breaker (~80 строк)
├── ops.ts              # logging + alerting + health check (~100 строк)
├── scheduler.ts        # node-cron + missed job detection (~50 строк)
├── types.ts            # Zod schemas (~100 строк)
└── index.ts            # Entry point (~30 строк)
tests/
└── delivery.test.ts    # 3-5 critical path tests (~50 строк)
prompts/                # Versioned in git
├── extraction.md
├── analysis.md
├── format-tracker.md
├── format-ceo.md
└── agenda.md
data/                   # Append-only JSON (runtime, не в git)
deploy.sh               # ssh → git pull → docker compose up -d --build
```

**~1200-1500 строк** кода + промпты + тесты. 12 source файлов.

### Implementation Sequence

```
Day 0:  types.ts → adapters/ (sheets, transcript, claude) — foundation
Day 1:  bot.ts → f1-report.ts → ops.ts → deploy → Hostinger — Milestone 1
        Азиза получает первый тестовый отчёт
Week 1: 3 тестовых отчёта с Азизой. Итерация промптов
Week 2: scheduler.ts → f4-agenda.ts → f5-metrics.ts → f3-lite.ts — Milestone 2
        Полный недельный цикл запущен
```

### Cross-Component Dependencies

```
transcript.ts ──→ f1-report.ts ──→ bot.ts (delivery + progress)
                       │
sheets.ts ────→ f4-agenda.ts ──→ bot.ts (delivery)
    │                  ↑
    └──→ f5-metrics.ts─┘
                       │
              f3-lite.ts ──→ bot.ts (preview for tracker)

ops.ts ← всё (logging + alerting)
claude.ts ← f1, f4, f3-lite (LLM calls + circuit breaker)
types.ts ← всё (Zod schemas)
```

## Implementation Patterns & Consistency Rules

### Naming Patterns

| Контекст | Convention | Пример |
|----------|-----------|--------|
| **Файлы** | `kebab-case` | `f1-report.ts`, `format-tracker.md` |
| **Переменные, функции** | `camelCase` | `generateReport()`, `stakeholderMap` |
| **Zod schemas, типы** | `PascalCase` | `TranscriptSchema`, `ReportOutput` |
| **Константы** | `UPPER_SNAKE_CASE` | `MAX_RETRIES`, `CIRCUIT_BREAKER_THRESHOLD` |
| **Sheets колонки** | `snake_case` | `client_id`, `metric_name` |
| **JSON fields (backup, internal)** | `camelCase` | `{clientId, meetingDate}` |
| **Промпт файлы** | `kebab-case` по назначению | `extraction.md`, `format-tracker.md` |
| **Промпт переменные** | `{{camelCase}}` | `{{transcript}}`, `{{okrContext}}` |
| **Telegram callback data** | `action:id` | `approve:42`, `reject:42` |

**Case conversion rule:** Adapter = граница конвертации. Внутри кода всегда `camelCase`. Sheets adapter конвертирует `snake_case` ↔ `camelCase` при read/write.

### Structure Patterns

| Что | Где | Почему |
|-----|-----|--------|
| **Тесты** | `tests/` отдельная директория | 12 source файлов — отдельная папка проще |
| **Промпты** | `prompts/` отдельная директория | Versioned в git, не в коде |
| **Data backup** | `data/` runtime | В `.gitignore` |
| **Config** | `.env` + `src/config.ts` | Zod валидация env vars |
| **Pipeline flow** | Один файл на pipeline | Бизнес-flow = оркестрация в одном файле |
| **Helpers** | adapters/ + utility functions | Переиспользуемая инфраструктура: `loadPrompt`, `withRetry`, `parseClaudeJSON`, `formatHeader` |

**Уточнение:** «Один файл на pipeline» = бизнес-flow (какие steps, в каком порядке, с какими данными). Helpers — инфраструктура в отдельных файлах, как `fs.readFileSync`.

### Format Patterns

**Chain Step Contracts (Zod schemas в `types.ts`):**

Каждый chain step имеет typed input и output. Schema = source of truth. Добавить поле = обновить schema + все downstream steps.

```typescript
ExtractionOutput → AnalysisInput → AnalysisOutput → FormattingInput → FormattedReport
```

**Telegram Messages:**
- Заголовки: `formatHeader(type, meta)` — единая функция, никогда inline
- Секции: разделены `───────────`
- Inline buttons: callback data = `{action}:{reportId}`
- Progress: `editMessageText` — одно сообщение обновляется 4 раза

**Logging (pino):**
```
logger.info({ pipeline, step, clientId, duration }, 'message')
```
Всегда: `pipeline`, `step`, `clientId`. Levels: info (done), warn (retry/partial), error (failure), fatal (crash).

### Process Patterns

**Prompt Loading:**
```typescript
loadPrompt(name, vars) → читает prompts/{name}.md → заменяет {{vars}} → throws если unreplaced vars
```
- `loadPrompt()` — единственный способ получить промпт
- Grep enforcement: `claude.messages.create` без `loadPrompt` = баг
- Unreplaced `{{var}}` → throw Error (fail fast, не silent corruption)

**Claude Output Parsing:**
```typescript
parseClaudeJSON(raw, ZodSchema) → strip markdown fences → JSON.parse → Schema.parse
```
- Никогда `JSON.parse()` напрямую на Claude output
- Единая точка обработки edge cases (code fences, trailing commas)
- Рассмотреть Claude tool use / structured output mode для MVP

**Zod Validation Strategy (дифференцированная):**
- Steps 1-2 (extraction, analysis): `parse()` — fail fast. Без данных pipeline бесполезен
- Steps 3-4 (formatting, delivery): `safeParse()` + partial fallback — graceful degradation

**Retry:**
```typescript
withRetry(fn, maxRetries=3) → exponential backoff: 1s, 3s, 9s
```

**Circuit Breaker:**
```typescript
3 failures in 5 min → fallback mode → auto-recover after 15 min
State in memory, reset on restart. Check: if(isCircuitOpen()) → fallback, else → withRetry()
```

**Error Handling per step:**
```typescript
try { result = await step(); log.info() }
catch { log.error(); alertOps(); return partialOrThrow }
```

**Sheets Access:**
- Read by header name, never by column index
- `readSheet()` returns `Record<string, string>[]` with camelCase keys
- Column reorder in Sheets = no code change

### Enforcement Guidelines

**All AI agents MUST:**
1. `loadPrompt()` для промптов — никогда inline template literals
2. `parseClaudeJSON(raw, Schema)` для Claude output — никогда `JSON.parse()` напрямую
3. Zod schema per chain step в `types.ts` — validate на выходе каждого step
4. `formatHeader()` для Telegram заголовков — никогда inline форматирование
5. `readSheet()` by header name — никогда по column index
6. Логировать с `{pipeline, step, clientId}` — никогда `console.log`
7. Промпты в `prompts/*.md` — никогда в `.ts` файлах
8. `withRetry()` для Claude API calls — никогда bare await
9. JSON backup `fs.writeFileSync` после каждого успешного pipeline run

**Anti-patterns (запрещено):**
- ❌ `const prompt = \`...\`` — промпт inline в коде
- ❌ `JSON.parse(claudeResponse)` — без parseClaudeJSON
- ❌ `row[0]`, `row[3]` — Sheets by column index
- ❌ `any` type для Claude response
- ❌ `console.log` — всегда pino logger
- ❌ Silent catch — каждый catch логирует + алертит
- ❌ Добавление поля в chain step без обновления Zod schema

## Project Structure & Boundaries

### Complete Project Directory Structure

```
arb-tracking-pipeline/
├── .env                        # API keys, chat IDs, client config
├── .env.example                # Template без secrets
├── .gitignore                  # node_modules, .env*, data/, *.log
├── package.json
├── tsconfig.json
├── Dockerfile
├── docker-compose.yml          # Один сервис, restart: unless-stopped
├── deploy.sh                   # ssh → git pull → docker compose up -d --build
│
├── src/
│   ├── index.ts                # Entry: bot + scheduler + health check (~30)
│   ├── config.ts               # Zod-validated env vars (~40)
│   ├── types.ts                # All Zod schemas (~100)
│   │
│   ├── bot.ts                  # grammY: commands, inline buttons, F5, progress (~250)
│   ├── scheduler.ts            # node-cron + missed job detection (~50)
│   ├── ops.ts                  # pino logger + alerting + /health (~100)
│   │
│   ├── f1-report.ts            # F1: transcript → 4 chain steps → report (~200-250)
│   ├── f4-agenda.ts            # F4: aggregate F1s + F5 → agenda (~100)
│   ├── f5-metrics.ts           # F5: collect from tops + store (~50)
│   ├── f3-lite.ts              # F3-lite: aggregate → CEO summary (~80)
│   │
│   └── adapters/
│       ├── sheets.ts           # Sheets: read(camelCase), write(snake_case) (~80)
│       ├── transcript.ts       # tldv/Soniox → Transcript Interface Contract (~60)
│       └── claude.ts           # Claude: withRetry, parseClaudeJSON, circuit breaker (~80)
│
├── prompts/                    # Versioned in git
│   ├── extraction.md           # Step 1: facts, decisions, commitments
│   ├── analysis.md             # Step 2: OKR coverage, hypothesis status
│   ├── format-tracker.md       # Step 3: scannable report for tracker
│   ├── format-ceo.md           # Step 3: 5 lines + 🟢🟡🔴 for CEO
│   └── agenda.md               # F4: weekly agenda with directed questions
│
├── tests/
│   └── delivery.test.ts        # 3-5 critical path tests (~50)
│
└── data/                       # Runtime, .gitignore. Append-only JSON backup
    └── {client_id}/
        └── {YYYY-MM-DD}/
            ├── f1-{top_name}-{id}.json
            ├── f4-agenda-{id}.json
            ├── f5-metrics-{id}.json
            └── f3-lite-{id}.json
```

### Requirements → File Mapping

| PRD Function | Primary File | Supporting Files |
|-------------|-------------|-----------------|
| **F0** Стейкхолдерная карта | `adapters/sheets.ts` (read) | `types.ts` (StakeholderSchema) |
| **F1** Автоотчёт | `f1-report.ts` | `claude.ts`, `transcript.ts`, `prompts/extraction.md`, `analysis.md`, `format-tracker.md` |
| **F4** Повестка | `f4-agenda.ts` | `claude.ts`, `sheets.ts`, `prompts/agenda.md` |
| **F5** Метрики | `f5-metrics.ts` + `bot.ts` | `sheets.ts` |
| **F3-lite** CEO | `f3-lite.ts` | `claude.ts`, `prompts/format-ceo.md` |
| **Telegram Bot** | `bot.ts` | All pipelines (delivery) |
| **Ops** | `ops.ts` | `scheduler.ts`, `index.ts` |
| **Auth** | `config.ts` (whitelist) + `bot.ts` (check) | — |

### Architectural Boundaries

**Adapter Boundary (external → internal):**

| External | Adapter | Internal Output |
|----------|---------|----------------|
| tldv/Soniox API | `transcript.ts` | `TranscriptInput` (camelCase, typed) |
| Google Sheets API | `sheets.ts` | `Record<string, string>[]` (camelCase) |
| Claude API | `claude.ts` | Zod-validated typed output |
| Telegram Bot API | `bot.ts` (grammY) | Commands, callbacks, messages |

**Pipeline Boundary (self-contained per file):**

| Pipeline | Input | Steps | Output |
|----------|-------|-------|--------|
| `f1-report.ts` | TranscriptInput | extraction → analysis → formatting → delivery | Report |
| `f4-agenda.ts` | F1Results[] + F5Metrics + OKR | aggregate → format | Agenda |
| `f5-metrics.ts` | TelegramCallbacks | collect → validate → store | Metrics |
| `f3-lite.ts` | F1Results[] + F5Metrics | aggregate → format | CeoSummary |

**Data Boundary:**

| Layer | Storage | Purpose |
|-------|---------|---------|
| Read | Google Sheets | OKR, stakeholder map, F5 metrics |
| Write | Sheets + JSON files | F5 metrics (Sheets) + all outputs (JSON) |
| Human | Sheets + Telegram | Human-readable interface + delivery |
| Backup | `data/{client_id}/{date}/*.json` | Append-only, tar daily |

### Data Flow

```
                    ┌─────────────────────────────────────────┐
                    │              Пн 8:00                     │
                    │  F5: бот → топы → inline buttons → Sheets│
                    └──────────────────┬──────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────────┐
                    │              Пн 9:00                     │
                    │  F4: F1[] + F5 + OKR → Claude → повестка │
                    │  F3-lite: F1[] + F5 → Claude → CEO       │
                    └──────────────────┬──────────────────────┘
                                       │
    ┌──────────────────────────────────▼───────────────────────┐
    │                    Пн–Чт (real-time)                      │
    │  Азиза: /report URL → F1 pipeline → progress → report    │
    │  [✅ Approve] [✏️ Edit] [❌ Reject]                       │
    └──────────────────────────────────────────────────────────┘
```

## Architecture Validation Results

### Coherence Validation ✅

All decisions verified compatible. No contradictions found. 3 potential inconsistencies identified and resolved through Self-Consistency Validation (camelCase/snake_case boundary, pipeline file scope, Zod parse/safeParse strategy).

### Requirements Coverage ✅

All 17 PRD requirements mapped to architectural components. No gaps. F2 (QC-скоринг) deferred to Phase 2 as expected.

### Implementation Readiness ✅

- 12 source files defined with line estimates
- All patterns have code examples
- 9 enforcement rules + 7 anti-patterns documented
- Deployment pipeline defined (deploy.sh → Docker → Hostinger)

### Validation Findings (Elicitation)

#### Hindsight Reflection (from September 2026)

| # | Blind Spot | Fix | When |
|---|-----------|-----|------|
| 1 | Промпт changelog не human-readable | `prompts/CHANGELOG.md` | Day 1 |
| 2 | Timezone сервера ≠ клиента | `TZ=Asia/Almaty` в config + Docker + cron | Day 1 |
| 3 | Redundant Sheets reads per pipeline | Batch read в начале run, передать context в steps | Day 1 |
| 4 | Message overload (20-30 msg/нед) | Weekly digest mode + auto-approve | Growth |
| 5 | Raw Claude response не сохраняется | `{raw, parsed}` return + `.raw.txt` auto-cleanup 14d | Day 1 |

#### Critical Challenge

| # | Challenge | Fix | When |
|---|----------|-----|------|
| 1 | Размер кода ~2000-2500, не 1200 | Скорректировать оценку | Now |
| 2 | Few-shot examples для промптов | `prompts/examples/` directory | Day 1 |
| 3 | Sheets latency monitoring | Log API latency, alert > 2s | Day 1 |
| 4 | Knowledge SPOF (Тимур) | `docs/ops/` checklists | Growth |
| 5 | Telegram msg throttling | Message queue при 5+ клиентах | Growth |

#### What If Scenarios

| # | Scenario | Fix | When |
|---|----------|-----|------|
| 1 | tldv закрылся | `/upload` command + plain text parser | Week 2 |
| 2 | Клиент приостановил | `docs/ops/restart-client.md` | Growth |
| 3 | 10 клиентов | Triggers в Roadmap, архитектура ready до 3-5 | Growth |
| 4 | Смена трекера | Approval log `approvals.jsonl` | Day 1 |
| 5 | Claude 3x дороже | Adapter ready, промпты нужна адаптация | If happens |

### Updated Project Structure (post-validation)

```
arb-tracking-pipeline/
├── .env / .env.example
├── package.json / tsconfig.json
├── Dockerfile / docker-compose.yml
├── deploy.sh
│
├── src/
│   ├── index.ts                # Entry point (~30)
│   ├── config.ts               # Zod env + TZ + client config (~80)
│   ├── types.ts                # All Zod schemas (~150)
│   ├── bot.ts                  # grammY: commands, buttons, F5, /upload (~300)
│   ├── scheduler.ts            # node-cron + missed job detection (~50)
│   ├── ops.ts                  # pino + alerting + /health + Sheets latency log (~120)
│   ├── f1-report.ts            # F1: batch read → 4 chain steps → {raw,parsed} → report (~350)
│   ├── f4-agenda.ts            # F4: aggregate + F5 → agenda (~100)
│   ├── f5-metrics.ts           # F5: collect + store (~50)
│   ├── f3-lite.ts              # F3-lite: aggregate → CEO summary (~80)
│   └── adapters/
│       ├── sheets.ts           # Sheets + camelCase↔snake_case conversion (~100)
│       ├── transcript.ts       # tldv API + plain text/SRT parser (~80)
│       └── claude.ts           # Claude + withRetry + parseClaudeJSON + circuit breaker + {raw,parsed} (~120)
│
├── prompts/
│   ├── CHANGELOG.md            # Human-readable prompt version history
│   ├── extraction.md
│   ├── analysis.md
│   ├── format-tracker.md
│   ├── format-ceo.md
│   ├── agenda.md
│   └── examples/               # Few-shot examples for extraction
│       ├── commitments-positive.md
│       └── commitments-negative.md
│
├── tests/
│   └── delivery.test.ts        # 3-5 critical path tests (~50)
│
├── data/                       # Runtime, .gitignore
│   └── {client_id}/
│       ├── {YYYY-MM-DD}/
│       │   ├── f1-{top}-{id}.json      # Parsed result
│       │   ├── f1-{top}-{id}.raw.txt   # Raw Claude response (auto-delete >14d)
│       │   ├── f4-agenda-{id}.json
│       │   ├── f5-metrics-{id}.json
│       │   └── f3-lite-{id}.json
│       └── approvals.jsonl             # Append-only approval log
│
└── docs/ops/                   # Growth: operational checklists
    ├── add-top-manager.md
    ├── change-prompt.md
    ├── add-client.md
    └── restart-client.md
```

**Corrected estimate: ~2000-2500 строк** кода + промпты + examples + tests.

### Architecture Completeness Checklist

**✅ Requirements Analysis**
- [x] Project context analyzed (PRD, as-is, to-be, research)
- [x] Scale and complexity assessed (High, без регуляторного бремени)
- [x] Technical constraints identified (9 constraints)
- [x] Cross-cutting concerns mapped (9 concerns)

**✅ Architectural Decisions**
- [x] ADR-001: TypeScript (Node.js)
- [x] ADR-002: Modular monolith (simplified)
- [x] ADR-003: Sheets + JSON files (data storage)
- [x] ADR-004: F3-lite manual delivery
- [x] Technology stack fully specified
- [x] 5 architectural principles (First Principles)
- [x] Comparative matrices (3 decisions scored)

**✅ Implementation Patterns**
- [x] Naming conventions (9 contexts)
- [x] 9 enforcement rules + 7 anti-patterns
- [x] 6 failure modes analyzed with code-level fixes
- [x] 3 self-consistency contradictions resolved
- [x] Process patterns (retry, circuit breaker, Zod strategy)

**✅ Project Structure**
- [x] Complete directory structure (post-validation, with examples/ and ops/)
- [x] Component boundaries (adapter, pipeline, data)
- [x] Requirements → file mapping (8 PRD functions)
- [x] Data flow diagram

**✅ Risk & Validation**
- [x] Pre-mortem: 7 preventive measures
- [x] Hindsight: 5 blind spots found and fixed
- [x] Critical challenge: 5 weaknesses addressed
- [x] What-if: 5 scenarios verified
- [x] Scalability validated to 3-5 clients

### Architecture Readiness Assessment

**Overall Status: READY FOR IMPLEMENTATION**

**Confidence: High**

**Strengths:**
- ~2000-2500 строк, 12 files — compact yet comprehensive
- 5 architectural principles prevent over-engineering
- 12 preventive measures from pre-mortem + hindsight + critical challenge
- 6 failure modes hardened at code level
- Every decision traced to rationale (ADR, matrix, or elicitation)
- Scalability path clear: triggers defined for each Growth decision
- Fallback for every external dependency

**Day 1 Fixes (from validation):**
1. `TZ=Asia/Almaty` in config + Docker
2. Batch Sheets reads per pipeline run
3. `prompts/CHANGELOG.md`
4. `prompts/examples/` for few-shot
5. Raw Claude response saved as `.raw.txt`
6. Approval log `approvals.jsonl`
7. Sheets latency monitoring in ops

**First Implementation Priority:**
```bash
npm init -y && npx tsc --init
npm i grammy @anthropic-ai/sdk googleapis pino node-cron zod
npm i -D typescript @types/node tsx
```
Then: `types.ts` → `adapters/` → `bot.ts` → `f1-report.ts` → `ops.ts` → deploy
