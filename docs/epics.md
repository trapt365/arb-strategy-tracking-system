# Эпики: AI Strategy Tracking Pipeline

> Дата: 2026-03-30
> Источники: PRD, Architecture, UX Specification, Methodology Research
> Структура: Pre-MVP → Phase 1 (Milestone 1, 2) → Phase 2 → Growth

---

## Epic 0: Pre-MVP — Подготовка и валидация

**Цель:** Убедиться, что техническая база работает, и подготовить всё для Day 1.
**Критерий готовности:** Все checkpoints пройдены, Азиза получила инструкцию.

| # | Задача | Описание | Результат |
|---|--------|----------|-----------|
| 0.1 | Тест tldv транскрипции | Worst case: шум, быстрая речь, казахско-русский code-switching | Go/No-Go: WER < 15% |
| 0.2 | Проверка tldv API | Программный доступ к полному транскрипту | Go/No-Go: стабильный API или fallback |
| 0.3 | F0: Онбординг Geonline | Стейкхолдерная карта + OKR/KR в Sheets + определение 2 метрик (leading+lagging) на департамент с Дамиром | Sheets заполнены |
| 0.4 | Тест промптов на исторических транскриптах | F1 + F4 промпты на 3–5 реальных транскриптах Geonline | Промпты стабилизированы (< 50% правок) |
| 0.5 | Инструкция трекера | Контрольный чеклист для Азизы (2–3 стр.) | Документ готов |
| 0.6 | Юридическое согласие | Consent на запись и обработку AI | Подписано |
| 0.7 | Инфраструктура | VPS (Hostinger), Docker, deploy.sh, .env | Сервер готов, бот отвечает на /health |

---

## Epic 1: Core Pipeline (Phase 1, Milestone 1) — «Первый отчёт»

**Цель:** Азиза отправляет ссылку на транскрипт → получает готовый отчёт в Telegram → утверждает → отчёт доставлен топу.
**Критерий готовности:** Азиза получила и утвердила первый тестовый отчёт.
**Срок:** Day 0–1

| # | Задача | Файл(ы) | Описание |
|---|--------|---------|----------|
| 1.1 | Zod-схемы | `types.ts` | TranscriptInput, ExtractionOutput, AnalysisOutput, FormattedReport, CommitmentSchema |
| 1.2 | Config | `config.ts` | Zod-валидация env vars, TZ=Asia/Almaty, whitelist chat_id |
| 1.3 | Sheets adapter | `adapters/sheets.ts` | read(camelCase), write(snake_case), batch read, latency logging |
| 1.4 | Transcript adapter | `adapters/transcript.ts` | tldv API parser → TranscriptInput (provider-agnostic) |
| 1.5 | Claude adapter | `adapters/claude.ts` | withRetry, parseClaudeJSON, circuit breaker, {raw, parsed} return |
| 1.6 | F1 pipeline | `f1-report.ts` | 4 chain steps: extraction → analysis → format-tracker → delivery. Batch Sheets read. Raw response saved |
| 1.7 | Промпты F1 | `prompts/extraction.md`, `analysis.md`, `format-tracker.md` | + `prompts/examples/` (few-shot), `CHANGELOG.md` |
| 1.8 | Telegram бот | `bot.ts` | /report URL, inline buttons (Approve/Edit/Reject), editMessageText progress, two-step approve с именем получателя |
| 1.9 | Ops | `ops.ts` | pino logger, Telegram ops-канал (алерты), /health endpoint |
| 1.10 | Entry point | `index.ts` | bot + health check |
| 1.11 | Docker + Deploy | `Dockerfile`, `docker-compose.yml`, `deploy.sh` | restart: unless-stopped, health check |
| 1.12 | JSON backup | `data/` structure | Append-only, approval log (approvals.jsonl) |

---

## Epic 2: Full Pipeline (Phase 1, Milestone 2) — «Полный недельный цикл»

**Цель:** Полный цикл: Пн утро (метрики + повестка + CEO summary) → Вт–Чт (отчёты после встреч).
**Критерий готовности:** Один полный недельный цикл пройден с Азизой.
**Срок:** Week 2

| # | Задача | Файл(ы) | Описание |
|---|--------|---------|----------|
| 2.1 | F5: сбор метрик | `f5-metrics.ts` + `bot.ts` | Пн 8:00: бот → топы → inline buttons с диапазонами (из F0 config) + свободный ввод → Sheets |
| 2.2 | F5: онбординг топов | `bot.ts` | Первое сообщение: объяснение + пример + промокод |
| 2.3 | F4: повестка | `f4-agenda.ts` + `prompts/agenda.md` | Пн 9:00: агрегация F1[] + F5 + OKR → повестка (3 пункта × топ). Senior/Junior режимы. Bot Menu навигация |
| 2.4 | F3-lite: CEO summary | `f3-lite.ts` + `prompts/format-ceo.md` | Delta-only: 5 строк + 🟢🟡🔴 + 1 инсайт/вопрос. Трекер копирует → отправляет вручную |
| 2.5 | Scheduler | `scheduler.ts` | node-cron: F5 (Пн 8:00), F4 (Пн 9:00), F3-lite reminder (Пт 18:00). Missed job detection + watchdog |
| 2.6 | Edit flow | `bot.ts` | Reply на отчёт с правкой → AI применяет → новый preview |
| 2.7 | Bot Menu | `bot.ts` | [Find] [Agenda] [Status] — pull-доступ к данным |
| 2.8 | Canary test | `tests/` | 5 golden transcripts, semantic assertions, diff < 30%. Описание MethodDescription |
| 2.9 | Delivery tests | `tests/delivery.test.ts` | 3–5 critical path: отчёт → правильный получатель |

---

## Epic 3: Phase 1 Стабилизация — «4 недели на пилоте»

**Цель:** 4 недели работы с Geonline. Go/No-Go по результатам.
**Критерий готовности:** ≥19/24 отчётов отправлены. Азиза: «would miss it».

| # | Задача | Описание |
|---|--------|----------|
| 3.1 | Итерация промптов | Еженедельный review с Азизой: что правила, что не так, что добавить |
| 3.2 | F5 adoption | Мониторинг response rate топов. Если < 60% → fallback: Азиза вводит после встречи |
| 3.3 | F4 adoption | Мониторинг: Азиза читает перед встречей? ≥ 1 вопрос из повестки задан? |
| 3.4 | F3-lite adoption | Мониторинг: Дамир открывает ≥ 2/3 недель? |
| 3.5 | Ops мониторинг | time_to_approve, batch_size, bot crashes, API costs |
| 3.6 | Go/No-Go решение | По критериям PRD (§ Go/No-Go Gates Phase 1) |

---

## Epic 4: Phase 2 — «Качество коучинга» (QC)

**Цель:** Айдар видит объективные данные по качеству работы трекера.
**Зависимость:** Кодификация методологии утверждена Айдаром.
**Критерий готовности:** Айдар находит QC summary полезным.

| # | Задача | Описание |
|---|--------|----------|
| 4.1 | F2: Talk ratio | Автоматический расчёт % говорения трекера. Норма 30–45%, жёлтый 45–55%, красный > 55% |
| 4.2 | F2: 4-шляпная классификация | AI классифицирует реплики трекера: Coach/Expert/Tracker/Facilitator. Fallback на 3 шляпы если inter-rater < 70% |
| 4.3 | F2: Покрытие OKR | ≥ 2 содержательные реплики = «обсуждено». Пропущено 2+ недели = «слепая зона» |
| 4.4 | F3-full | Executive summary + таблица гипотез + методологическая обратная связь трекеру |
| 4.5 | QC dashboard (Sheets) | Сводка по трекеру: тренды talk ratio, шляпы, покрытие OKR |
| 4.6 | Commitment lifecycle | 🔵 → 🟡 → 🟢/🔴 визуализация в F1 и F4 |

---

## Epic 5: Growth — Масштабирование

**Цель:** От 1 клиента к 3–5. От 1 трекера к 2–3.
**Trigger:** Решение о подключении 2-го клиента.

| # | Задача | Trigger | Описание |
|---|--------|---------|----------|
| 5.1 | PostgreSQL миграция | 3-й клиент | JSON → PostgreSQL. Скрипт миграции |
| 5.2 | CI/CD | 2-й разработчик | GitHub Actions → auto deploy on push to main |
| 5.3 | F3-lite auto-delivery | 5+ клиентов | Бот отправляет CEO напрямую (с approve трекера) |
| 5.4 | F5 API-интеграция | Клиент с CRM API | Автосбор метрик из Bitrix24/CRM |
| 5.5 | Web dashboard | Запрос от клиента | Tailwind + Shadcn/Radix |
| 5.6 | Ops документация | Knowledge SPOF | `docs/ops/`: add-client, change-prompt, restart-client |
| 5.7 | Approval mode degradation | 95% approve без правок, 4+ нед | full → review_after → exceptions_only |
| 5.8 | Онбординг нового трекера | 2-й трекер | Инструкция + F4 как компенсатор опыта + QC калибровка |

---

## Зависимости между эпиками

```
Epic 0 (Pre-MVP)
    │
    ▼
Epic 1 (Core Pipeline)
    │
    ▼
Epic 2 (Full Pipeline)
    │
    ▼
Epic 3 (Стабилизация, 4 недели)
    │         │
    ▼         ▼
Epic 4    Epic 5
(QC)      (Growth)
```

- Epic 4 зависит от: кодификация методологии (утверждение Айдаром)
- Epic 5 зависит от: успешный Go/No-Go Phase 1

---

## Таймлайн (оценочный)

| Период | Эпик | Ключевое событие |
|--------|------|-----------------|
| Апрель, нед. 1 | Epic 0 | Pre-MVP: тесты, онбординг, промпты |
| Апрель, нед. 2 | Epic 1 | Day 1: первый отчёт Азизе |
| Апрель, нед. 3 | Epic 2 | Полный цикл: F1 + F4 + F5 + F3-lite |
| Апрель нед. 4 – Май нед. 2 | Epic 3 | 4 недели стабилизации |
| Май, нед. 3 | Go/No-Go | Решение о Phase 2 |
| Май–Июнь | Epic 4 | QC-скоринг (если методология утверждена) |
| Июнь+ | Epic 5 | Масштабирование (по trigger'ам) |
