---
stepsCompleted: [1, 2, 3, 4]
lastStep: 4
status: 'complete'
completedAt: '2026-03-30'
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/architecture.md
  - _bmad-output/planning-artifacts/ux-design-specification.md
workflowType: 'epics-and-stories'
project_name: 'ARB AI-Tracking System'
user_name: 'Тимур'
date: '2026-03-30'
---

# ARB AI-Tracking System - Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for ARB AI-Tracking System, decomposing the requirements from the PRD, UX Design, and Architecture into implementable stories.

## Requirements Inventory

### Functional Requirements

FR1: Трекер может отправить ссылку на запись встречи и получить структурированный отчёт
FR2: Система извлекает из транскрипта факты, решения, цитаты с timestamps и привязкой к speakers
FR3: Система извлекает обязательства (commitments) участников: кто, что, к какому сроку, цитата-источник
FR4: Система определяет статус обсуждённых гипотез (идея / в тесте / результат)
FR5: Система определяет покрытие OKR: какие KR обсуждены, какие пропущены
FR6: Система обозначает в отчёте элементы, требующие проверки трекером ([approximate], [speaker_check])
FR7: Система принимает транскрипт от разных провайдеров и конвертирует в единый формат
FR8: Система генерирует повестку F4 для трекера на каждого топа к понедельнику утром
FR9: Повестка содержит приоритизированные пункты по каждому топу на основе прогресса OKR, commitments и покрытия контуров
FR10: Повестка содержит направляющие вопросы для формирования навыка у команды
FR11: Система использует стейкхолдерную карту как контекст для генерации повестки
FR9b: Повестка содержит расхождения метрик vs заявлений
FR12: Система генерирует компактное сводное уведомление CEO с оценкой статуса каждого OKR и ключевым инсайтом
FR12a: Сводное уведомление: 5 строк + 🟢🟡🔴 по каждому OKR + 1 инсайт/вопрос
FR13: Сводное уведомление отправляется только после одобрения трекером
FR14: Сводное уведомление не содержит прямых цитат топов — только агрегированные наблюдения
FR15: Система оценивает качество сессии по метрикам (talk ratio, распределение ролей, покрытие OKR) — Phase 2
FR16: Система формирует фидбэк трекеру по методологии за неделю — Phase 2
FR17: Руководитель видит QC-сводку по всем трекерам и клиентам — Phase 2
FR18: Руководитель получает алерт при отклонении трекера от методологии — Phase 2
FR19: QC-метрики показываются с оговоркой «AI-оценка»
FR20: Трекер заполняет стейкхолдерную карту клиента при подключении
FR21: Система использует стейкхолдерную карту как контекст при генерации отчётов и повесток
FR22: Система хранит OKR/KR клиента и использует при анализе
FR23: Система хранит commitments и включает незакрытые в повестку F4
FR24: Данные каждого клиента полностью изолированы по client_id
FR25: Система сопоставляет commitment с результатом из последующего транскрипта и обновляет статус
FR26: Система хранит QC-метрики как append-only лог для трендов
FR27: Трекер запускает генерацию отчёта одной командой `/report <url>`
FR28: Трекер обрабатывает отчёт: одобрить, отредактировать или отклонить
FR29: Трекер видит статус текущей обработки
FR30: Трекер получает partial result (extraction data) при сбое этапов 3-4
FR31: Система уведомляет трекера если отчёт не готов в течение SLA
FR32: Система доставляет отчёт от имени трекера (pipeline невидим для клиента)
FR33: Трекер отмечает затронутые контуры после встречи (автоклассификация — Phase 2)
FR34: Система логирует каждый этап, повторяет при сбое API, уведомляет ops при неустранимой ошибке
FR35: Система валидирует входные данные на каждом этапе
FR36: Система выполняет canary test, сравнивает с эталоном и сообщает о regression
FR37: Система генерирует еженедельный executive summary F3-full — Phase 2
FR38: Руководитель видит тренды QC-метрик по клиенту за период — Phase 2
FR39: CEO видит таблицу гипотез с текущими статусами — Phase 2
FR40: Руководитель сравнивает QC-метрики двух трекеров — Growth
FR41: CEO видит агрегированный прогресс по commitments каждого топа — Growth
FR42: Система отслеживает стоимость API calls за период по клиентам — Growth
FR43: Система адаптируется под терминологию нового клиента без переписывания pipeline — Growth
FR44: Все output'ы на русском, казахскоязычные цитаты в оригинале с пометкой
FR45: Устное согласие на первой встрече от каждого участника на запись, транскрибацию и AI-обработку
FR46: Азиза информирует на первой встрече с фиксацией в транскрипте
FR47: Если топ не согласен — встреча без записи, pipeline пропускает
FR48: Трекер не передаёт CEO конфиденциальные высказывания; F3-lite без прямых цитат
FR49: Трекер при проверке оценивает чувствительность контента и удаляет конфиденциальное
FR50: Система собирает еженедельно 2 метрики (leading + lagging) по каждому департаменту через Telegram
FR51: Топ отвечает 2 числами в 1 сообщение (~30 сек)
FR52: F5 данные используются в F4, F1 (верификация) и F3-lite (статусы)
FR53: Система генерирует тренды по департаментам и алерты на аномалии
FR54: Если топ не ответил до 9:00 — используются прошлонедельные данные
FR55: Трекер заполняет Google Sheets шаблон стейкхолдерной карты при подключении
FR56: Стейкхолдерная карта — живой документ, ревизия ежемесячно
FR57: Pipeline нормализует транскрипты разных провайдеров в единый JSON schema
FR58: Pipeline валидирует: speakers mapped, нет пустых сегментов, timestamps монотонны
FR59: При validation failure — уведомление Тимуру, pipeline останавливается
FR60: Pipeline помечает [speaker_check] если >70% реплик не соответствуют ролям
FR61: Промпт требует точный timestamp для каждой цитаты; иначе [approximate]
FR62: При сбое step 3-4 после 3 retries — partial result Азизе
FR63: Команда `/report <url>` для запуска генерации
FR64: Inline-кнопка approve переводит отчёт в статус `approved` и готовит его к ручной пересылке трекером
FR65: Edit-via-reply: бот отправляет текст, трекер редактирует через inline-flow
FR66: Inline-кнопка reject отклоняет отчёт и запускает перегенерацию/ручной режим
FR67: Статус очереди доступен через Bot Menu `[📊 Статус]`
FR68: Бот разбивает отчёты > 4096 символов на 2-3 сообщения
FR69: Reject > 50% за неделю → пересмотр промптов
FR70: Pipeline читает/пишет через data access adapter, не напрямую Sheets API
FR71: Автоматическое обновление API tokens для Sheets
FR72: Промежуточные данные chain в папках по client_id
FR73: Все данные клиента под одним client_id для offboarding
FR74: Отдельная таблица для метрик: client_id, department, metric_name, type, value, week, source
FR75: Append-only QC-метрики в отдельном Sheet для трендов за 3-6 месяцев
FR76: Логи step chain в append-only Sheet
FR77: Критические события дублируются в Telegram ops-канал
FR78: Уведомление Азизе если отчёт не готов за 30 мин: «Переключайся на ручной режим»
FR79: Уведомление Тимуру при любой ошибке pipeline
FR80: Повторное уведомление Тимуру если pipeline down > 4ч
FR81: Уведомление Айдару если pipeline down > 24ч
FR82: Если CEO-уведомление не отправлено в понедельник — ручной fallback
FR83: Еженедельный canary test с golden dataset
FR84: Diff > 30% или пропуск ≥ 2 фактов → уведомление Тимуру
FR85: Промпты в git и версионируются
FR86: Трекер переключается на ручной режим если отчёт не пришёл за 30 мин
FR87: Fallback Email emergency mode при проблемах с Telegram
FR88: При отсутствии трекера pipeline останавливается
FR89: Если F5 бот не работает — Google Form fallback
FR90: При истечении API tokens — уведомление ops без каскадного отказа

### NonFunctional Requirements

NFR1: F1 генерация < 15 мин, уведомление при > 30 мин
NFR2: F4 batch готова к 9:00 при запуске cron в 7:00
NFR3: F3-lite готова к 9:00
NFR4: Telegram bot acknowledge < 3 сек
NFR5: F2 QC-скоринг в течение 1 часа после всех встреч за неделю
NFR6: F5 сбор завершён до генерации F4 (до 9:00)
NFR7: F5 метрики собраны до 9:00; повторный запрос до 12:00
NFR8: ≤ 2 неустранимых сбоя за 3 недели
NFR9: Временные сбои API не приводят к потере данных
NFR10: При сбое analysis/formatting — partial results трекеру
NFR11: Сбой Sheets не теряет логи и алерты
NFR12: Истечение tokens не вызывает простой без уведомления
NFR13: Go/No-Go #1: ≥ 22 из 24 встреч обработаны, ≤ 2 падения за 3 недели
NFR14: Go/No-Go #1: ≥ 19 из 24 отчётов отправлены клиенту
NFR15: Canary test еженедельно с 5 golden transcripts
NFR16: Telegram бот uptime > 99%
NFR17: Поддержка 1 клиент, 1 трекер, ~5 встреч/нед
NFR18: Поддержка 5-10 клиентов без изменения архитектуры — Growth
NFR19: Approve workflow < 3ч/нед при 3+ клиентах
NFR20: VPS 24/7 (serverless несовместим с SLA)
NFR21: Данные клиента A не попадают в контекст клиента B
NFR22: Code review изоляции при 2-м клиенте
NFR23: Данные не используются для обучения AI
NFR24: Полное удаление данных < 1 час
NFR25: Data retention: срок договора + 12 мес
NFR26: Доступ по ролям: Тимур полный, трекер — свои клиенты, Айдар — QC, CEO — уведомления
NFR27: Разделение доступа: MVP логическое, 2+ трекеров — отдельные чаты, 5+ клиентов — техническое
NFR28: F1 structured output с цитатами-источниками
NFR29: F3-lite без прямых цитат топов
NFR30: WER < 15% на наихудший сценарий
NFR31: Day 1: тест Soniox на шумной записи и code-switching
NFR32: Speaker validation: > 70% несоответствий → [speaker_check]
NFR33: Смена провайдера = только новый парсер
NFR34: Замена хранилища без изменений бизнес-логики
NFR35: Data access adapter ~50 строк, заменяемый
NFR36: Transcript Interface Contract — JSON schema
NFR37: Парсер Soniox и plain-text fallback — отдельные модули
NFR38: API costs < $100/мес
NFR39: Ops-время ≤ 2ч/нед (Week 1: до 5ч)
NFR40: Claude API ~$20-25/мес
NFR41: Soniox/fallback provider $0-30/мес
NFR42: VPS $5-10/мес
NFR43: Google Sheets API $0
NFR44: Telegram Bot API $0
NFR45: Weekly canary ~$2/мес
NFR46: Ops-бюджет: canary 15 мин + notifications 15 мин + ad-hoc 30 мин = ~1ч/нед
NFR47: Talk ratio нормы: 30-45% норма, 45-55% жёлтый, >55% красный — Phase 2
NFR48: Монолог трекера ≤ 2 мин — Phase 2
NFR49: Распределение 4 шляп: коуч 35-45%, эксперт 15-25%, трекер 20-30%, фасилитатор 10-20% — Phase 2
NFR50: Fallback на 3 шляпы при inter-rater agreement < 70% — Phase 2
NFR51: Покрытие OKR: ≥ 2 реплики = обсуждено, 1 = упомянуто, 0 за 2+ нед = слепая зона — Phase 2
NFR52: Целевое покрытие OKR: 100% KR за 2 недели — Phase 2
NFR53: AI-оценки с оговоркой «AI-оценка» — Phase 2
NFR54: Инструкция трекера 2-3 стр. к Phase 1
NFR55: Ops dashboard (Sheet с логами) с Day 1
NFR56: Процесс документирован для предотвращения SPOF
NFR57: Reject > 50% → пересмотр промптов
NFR58: Regression threshold: diff > 30% или пропуск ≥ 2 фактов
NFR59: Стоп-сигнал: Азиза тратит больше на правку, чем на ручное написание
NFR60: Стоп-сигнал: Дамир не открывает уведомления 3+ недели
NFR61: ≥ 19/24 отчётов полезны для отправки за 3 недели
NFR62: Азиза < 2ч/нед на рутину (было 4ч)
NFR63: F4 полезность ≥ 4/5 от Азизы
NFR64: CEO открывает уведомление ≥ 2/3 недель
NFR65: CEO реагирует ≥ 1/3 недель
NFR66: Retention: 0 уходов по качеству к 12 мес
NFR67: API-провайдер с программным доступом — критерий остановки
NFR68: Day 1: тест транскрибации Soniox worst case
NFR69: Проверка Soniox API; fallback `/upload` и ручной экспорт
NFR70: При отсутствии API — fallback ручной экспорт + загрузка в бот
NFR71: Русский output, казахские цитаты в оригинале
NFR72: Формальный документ согласия от юриста
NFR73: Устное согласие Week 1, формальное — Week 3-4
NFR74: Data retention policy к Phase 2
NFR75: Раздел в договоре (запись, AI, хранение, конфиденциальность)
NFR76: Поиск юриста по персональным данным РК — Week -2

### Additional Requirements

- Custom project setup: TypeScript + Node.js, AI Automation Pipeline (backend-only, no UI)
- Package stack: grammY, @anthropic-ai/sdk, googleapis, Zod, pino, node-cron
- Docker deployment на Hostinger VPS с `restart: unless-stopped` и health check
- Chain of 4 prompts: extraction → analysis → formatting → delivery (не один промпт)
- Transcript Interface Contract: JSON schema `{speakers: [{name, segments: [{start, end, text}]}], metadata: {date, duration, meeting_type}}`
- Поддержка Soniox (primary): async file transcription API + webhook. Поток: нативная запись Google Meet/Zoom → аудиофайл в Google Drive/Zoom Cloud → бот скачивает → Soniox API → Transcript Interface Contract. Fallback: `/upload` для plain text
- Claude API напрямую (не langchain), circuit breaker (3 failures/5 min), exponential backoff (1s, 3s, 9s)
- Промпты в `prompts/*.md`, версионированные в git, не inline в коде
- Template variables `{{camelCase}}`, few-shot examples в `prompts/examples/`
- Промпт CHANGELOG в `prompts/CHANGELOG.md`
- Zod validation: `.parse()` для steps 1-2 (fail-fast), `.safeParse()` для steps 3-4 (graceful)
- Data storage MVP: Sheets (read/human) + JSON files (append-only backup в `data/{client_id}/{date}/`)
- Data storage Growth: PostgreSQL при 3-м клиенте (жёсткий trigger)
- Append-only backup: daily tar 7 дней, raw Claude responses `.raw.txt` cleanup 14 дней
- Client isolation: client_id во всех слоях (промпты, хранение, delivery)
- Chat ID whitelist auth: `{tracker: [chatId], tops: [{chatId, name, dept}], ops: [chatId]}`
- Docker: docker-compose.yml single service, deploy.sh (ssh → git pull → docker compose up -d --build)
- Health check: HTTP `/health` + cron curl каждую минуту + auto-restart + alert
- .env с API keys, chat IDs, client config; Zod validation в `src/config.ts`
- Timezone: `TZ=Asia/Almaty` в config + Docker
- Scheduling: node-cron для F5 (Пн 8:00), F4 (Пн 9:00), F3-lite (Пн), missed job detection
- Logging: pino structured JSON с `{pipeline, step, clientId}`
- Approval workflow: status field `generating│ready│approved│delivered`, append-only `approvals.jsonl`
- Approval mode config: `full` → `review_after` → `exceptions_only` (MVP = full)
- Naming: kebab-case files, camelCase vars, PascalCase Zod, UPPER_SNAKE constants
- Case conversion boundary: adapter converts snake_case (Sheets) ↔ camelCase (internal)
- Patterns: loadPrompt(), parseClaudeJSON(), withRetry() для API calls
- Anti-patterns: no inline prompts, no JSON.parse(), no column-indexed Sheets, no `any`, no console.log, no silent catches
- ~12 source files, ~2000-2500 строк total
- F3-lite delivery: manual copy by tracker (ADR-004)
- F5 ranges из F0 config (не hardcoded)
- Delivery tests: 3-5 critical path тестов (правильный получатель)
- Batch read Sheets at pipeline start, pass context
- Ops documentation: docs/ops/ checklists

### UX Design Requirements

UX-DR1: Мгновенный acknowledge в течение 2 сек после `/report`: "✅ Принято. Отчёт через ~15 мин."
UX-DR2: Auto-timeout 20 мин: "⏰ Задержка. Тимур уведомлён. Пиши отчёт вручную"
UX-DR3: Progress updates через editMessageText: 4 состояния (Читаю → Формирую → Почти готово → отчёт)
UX-DR4: F1 Report формат: emoji-type + трёхуровневый header + main finding + max 3 секции + inline buttons
UX-DR5: Двухшаговый approve: preview → [✅ Подтвердить → {recipient_name}] с именем получателя
UX-DR6: Inline keyboard: [✅ Подтвердить → Name] [✏️ Исправить] [❌ Отклонить]; после approve: [📝 Уточнение] [🔗 Подробнее]
UX-DR7: Edit-via-reply: при [✏️] — инструкция с примером "Конверсия 30%, не 28%"
UX-DR8: F3-lite формат: delta-only, 🟢🟡🔴, один пример поведения (💡), вопрос (❓) только при 🟡/🔴
UX-DR9: Queue messaging: "✅ Принято. В очереди: 3 из 5."
UX-DR10: F4 Agenda: header + flat list топов с кнопками [📋 Name] + [📋 Все]
UX-DR11: F4 senior mode: 💡 disclaimer + ❓ вопросы + 📊 контекст + ⚠️ расхождения + 🔄 повторы
UX-DR12: F4 junior mode: 📋 пошаговый гайд с 📊 данными
UX-DR13: F5 onboarding: 👋 приветствие с именем трекера + объяснение + inline кнопки диапазонов + [Ввести точно]
UX-DR14: F5 последующие запросы: "📊 Name, metric за неделю?" + inline keyboard, Пн 8:00
UX-DR15: F5 keyboard layout: max 3 кнопки в ряд
UX-DR16: Трёхуровневый header для всех сообщений: emoji + bold topic + pipe + period
UX-DR17: Commitment lifecycle маркеры: 🔵 New, 🟡 In progress, 🟢 Completed, 🔴 Overdue
UX-DR18: Bot Menu: [🔍 Найти] [📋 Повестка] [📊 Статус]
UX-DR19: Copy-optimized F3-lite: plain text "📱 Текст для Дамира (скопируй):" для WhatsApp
UX-DR20: Data discrepancy alert: ⚠️ + comparison + тон любопытства
UX-DR21: Batch-queue message: "✅ В очереди: 2 из 5." после каждого approve
UX-DR22: Maturity gradient F4: Week 1 onboarding, Week 2-3 transition с disclaimer, Week 4+ full + coaching
UX-DR23: Graceful degradation fallbacks: F1 timeout → manual, F4 no-data → OKR-based, F5 silence → manual_tracker
UX-DR24: Error messages: icon + description + instruction
UX-DR25: Message splitting > 4096 символов: headers + buttons под последним
UX-DR26: Long-form reference: [🔗 Подробнее] → Google Doc
UX-DR27: F5 acknowledgment: "✅ Записано." + "Вторая метрика?"
UX-DR28: Post-approval correction: [📝 Уточнение] для follow-up
UX-DR29: Recipient name в approve button обязателен
UX-DR30: F1 "📱 Для Name" секция: 3-5 строк plain text для WhatsApp
UX-DR31: Emoji system: Status (🟢🟡🔴), Commitment (🔵🟡🟢🔴), Pipeline (📋❓📊📢), Actions (✅✏️❌📝), System (⏰⚠️🔄), Trends (↑↓→), Content (📌💡📱)
UX-DR32: Trust-calibration markers Week 1-2: [approximate], [speaker_check]; drop uncertain content
UX-DR33: Status message после action: "✅ [Описание]. [Контекст]"
UX-DR34: Tone-of-voice: Confirmation (кратко), Progress (дружелюбно), Agenda (предлагающе), QC (союзник), Error (спокойно + инструкция)
UX-DR35: Formatting: **bold** имена + метрики, *italic* цитаты, `code` числа, max 3 секции, пустые строки
UX-DR36: Bot Menu вместо slash-команд; только `/report` остаётся
UX-DR37: Inline-keyboard-first: все действия кроме `/report` и reply — кнопки, max 3 в ряд
UX-DR38: F4 agenda caching: Bot Menu → мгновенный ответ с кэшированным контентом
UX-DR39: Never-silent principle: любой сбой → сообщение с инструкцией в течение 2 мин
UX-DR40: F5 anomaly detection: "📊 Сильно отличается. Подтвердить?" при аномальном значении
UX-DR41: F5 auto-deactivation: 3+ недели тишины → manual_tracker mode + уведомление трекеру
UX-DR42: F4 carry-forward: 🔄 для необсуждённых пунктов прошлой недели
UX-DR43: Week 1 onboarding: "узнай" формат, не accountability
UX-DR44: F5 micro-feedback trend (Phase 2): "📊 Продажи: 2.1М → 2.3М → 2.5М ↑"
UX-DR45: F3-lite delta-only: изменения + direction (🟢→🟢, 🔴→🟢)
UX-DR46: F3-lite action trigger: ❓ только при 🟡/🔴
UX-DR47: F3-lite concrete-behavioral insight: минимум 1 пример поведения (💡)
UX-DR48: F4-to-F1 lifecycle: вопросы F4 → проверяемы в F1
UX-DR49: Unsure-content deletion: неподтверждённое без доказательства удаляется, а проверочные риски Week 1-2 маркируются тегами
UX-DR50: Commitment extraction с quote snippet (*italics*) + deadline, JSON storage
UX-DR51: Accessibility: emoji+text always ("🟢 В норме" не "🟢")
UX-DR52: Mobile-first: < 1 screen, иначе split или [🔗 Подробнее]
UX-DR53: F5 manual-entry: "Введи число:" + validation "⚠️ Введи число или нажми кнопку"
UX-DR54: Ops-metrics tracking: time_to_approve, batch_size, f5_response_rate, bot_menu_usage
UX-DR55: Delivery confirmation: "✅ Отчёт отправлен [Name]."
UX-DR56: Watchdog alert: F4 cron не выполнился → alert Тимуру к 9:30
UX-DR57: Incomplete F3-lite: "⚠️ Нет отчёта по [names]. Отправить как есть?" [Да] [Подождать]
UX-DR58: F5 invalid input: "⚠️ Введи число или нажми кнопку" → return to keyboard
UX-DR59: QC feedback tone: "попробуй на следующей неделе...", не "ты сделала неправильно"
UX-DR60: Commitment accountability loop: F1 extraction → F4 reference → next F1 check
UX-DR61: F4 data-context pairing: каждый ❓ + 📊 data
UX-DR62: F4 senior reflection: "💡 Начни со слушания. Эти вопросы — подсказка, не скрипт."
UX-DR63: F1 split при > 4096: нумерованные parts, buttons под последним
UX-DR64: CEO notification opt-out (Phase 2): auto-reduce при 2+ неоткрытых
UX-DR65: Invalid URL: "⚠️ Ссылка не распознана. Проверь формат." в течение 5 сек
UX-DR66: Transcript too short: "⚠️ Слишком короткий. Отчёт требует ≥ 2 мин."
UX-DR67: Wrong-report edit prevention: "⚠️ Нажми [✏️] под нужным отчётом."
UX-DR68: Double-tap prevention: "ℹ️ Уже отправлено."
UX-DR69: Delivery failure recovery: "⚠️ Не доставлено. [🔄 Повторить]"
UX-DR70: Preview-then-approve: rendered preview перед кнопкой [✅]
UX-DR71: Speaker-name validation: [speaker_check] + "⚠️ Проверь имена."
UX-DR72: F5 onboarding personalization: имя трекера + context "почему"
UX-DR73: Max 3 buttons per row для mobile
UX-DR74: Report split continuation header: "📋 Name (продолжение)"
UX-DR75: Batch acknowledge sequencing: позиция в очереди
UX-DR76: F4 navigation state: back/home после drill-down в топа
UX-DR77: F3-lite consistency: еженедельно по расписанию, даже без ответа CEO
UX-DR78: Low-data F4 marker: "📎 Мало данных — повестка станет точнее через 2-3 недели"
UX-DR79: F1 word-economy: каждое предложение factual или actionable, 4-8 sentences max
UX-DR80: Edit-flow instruction clarity: конкретный пример формата ввода

### FR Coverage Map

FR1-FR7: Epic 1 — Transcript processing + F1 pipeline
FR8-FR11, FR9b: Epic 3 — F4 повестка
FR12, FR12a, FR13, FR14: Epic 4 — F3-lite CEO сводка
FR15-FR19: Epic 5 — F2 QC (Phase 2)
FR20-FR24: Epic 1 — Data context (stakeholder map, OKR, client isolation)
FR25: Epic 3 — Commitment status update в F4
FR26: Epic 5 — QC append-only log (Phase 2)
FR27-FR32: Epic 1 — Tracker workflow (`/report`, inline actions, approve, delivery)
FR33: Epic 3 — Контуры после встречи
FR34-FR35: Epic 1 — Logging + validation (базовый)
FR36: Epic 1 — Canary test (Week 1 hardening)
FR37-FR39: Epic 5 — F2 features (Phase 2)
FR40-FR43: Epic 6 — Growth features
FR44: Epic 1 — Русский output + казахские цитаты
FR45-FR47: Epic 0 — Согласие на запись
FR48-FR49: Epic 4 — Конфиденциальность в F3-lite + Epic 1 (трекер фильтрует)
FR50-FR54: Epic 2 — F5 metrics collection
FR55-FR56: Epic 0 — F0 стейкхолдерная карта
FR57-FR58: Epic 1 — Transcript Interface Contract + validation
FR59: Epic 1 — Validation failure → alert Тимуру
FR60-FR61: Epic 1 — Speaker/citation markers
FR62: Epic 1 — Partial results при сбое (Week 1 hardening)
FR63-FR67: Epic 1 — Telegram bot commands
FR68: Epic 1 — Message splitting > 4096
FR69: Epic 1 — Reject threshold signal
FR70-FR73: Epic 1 — Sheets adapter + data organization
FR74: Epic 2 — F5 metrics storage
FR75: Epic 6 — QC append-only (Growth)
FR76-FR77: Epic 1 — Ops logging + alerts (базовый)
FR78: Epic 1 — Timeout notification Азизе
FR79-FR81: Epic 1 — Escalation chain (Тимур → Айдар)
FR82: Epic 4 — F3-lite fallback manual
FR83-FR84: Epic 1 — Canary test (Week 1 hardening)
FR85: Epic 1 — Prompt versioning in git
FR86-FR88: Epic 1 — Fallback protocols
FR89: Epic 2 — F5 Google Form fallback
FR90: Epic 1 — Token expiry handling

**Покрытие: 90/90 FR → 7 эпиков. Пропущенных: 0.**

## Epic List

## Epic 0: Pre-MVP — Валидация и подготовка

**Цель:** Все технические риски сняты, клиент Geonline онбордён, Азиза готова к Day 1. Gate перед разработкой.

**FRs:** FR7 (частично), FR20, FR45-FR47, FR55-FR56

**Go/No-Go gates:**
- Soniox WER < 15% на worst case И fallback `/upload` flow < 2 мин friction
- Юридическое согласие подписано
- Golden dataset из ≥ 5 транскриптов готов

### Story 0.1: Валидация провайдера транскрипции (Soniox)

As a **аналитик практики (Тимур)**,
I want **протестировать Soniox на worst-case записях и оценить стабильность API**,
So that **я могу принять Go/No-Go решение по провайдеру до начала разработки**.

**Acceptance Criteria:**

**Given** 5+ записей разных типов (1:1, групповая, code-switching каз-рус, шум, короткая < 15 мин)
**When** каждая обработана через Soniox async file transcription API
**Then** WER < 15% на наихудший сценарий
**And** code-switching русский↔казахский распознаётся корректно (проверка на ≥ 3 записях с казахскими вставками)
**And** формат API ответа задокументирован (JSON: speakers, segments, timestamps)
**And** rate limits, uptime за 3 месяца, стабильность формата проверены

**Given** поток нативной записи Google Meet
**When** Азиза записывает тестовую сессию → файл в Google Drive → ссылка передана вручную
**Then** аудиофайл скачивается по Google Drive API / share link
**And** формат файла совместим с Soniox API (проверка: webm/mp4/m4a от Google Meet)
**And** полный поток (запись → скачивание → транскрипция → JSON) завершается < 5 мин для 30-мин записи

**Given** Soniox не проходит порог
**When** результаты оценены
**Then** `/upload` raw copy-paste валидирован как primary path с friction < 2 мин
**And** Plan C (собственная запись → Whisper/AssemblyAI) оценён по feasibility

### Story 0.2: Онбординг клиента Geonline (F0)

As a **аналитик практики (Тимур)**,
I want **заполнить стейкхолдерную карту и определить F5 метрики с Дамиром**,
So that **система имеет полный контекст клиента для генерации отчётов и повесток**.

**Acceptance Criteria:**

**Given** шаблон стейкхолдерной карты в Google Sheets
**When** Тимур проводит сессию с Дамиром (~30 мин)
**Then** заполнены: участники, роли, контуры, интересы по каждому топу
**And** определены 2 метрики (leading + lagging) по каждому департаменту
**And** OKR/KR клиента внесены в Sheets

### Story 0.3: Тестирование промптов и создание golden dataset

As a **аналитик практики (Тимур)**,
I want **протестировать промпты F1 и F4 на реальных транскриптах Geonline**,
So that **промпты стабилизированы, а golden dataset готов для canary-тестирования в Epic 1**.

**Acceptance Criteria:**

**Given** ≥ 5 реальных транскриптов Geonline разных типов
**When** F1 chain of 4 prompts прогнан на каждом
**Then** < 50% требуют существенных правок
**And** golden dataset из ≥ 5 транскриптов + эталонных output'ов сохранён
**And** F4 промпт протестирован хотя бы на 2 транскриптах

**Given** промпты нестабильны (> 50% правок)
**When** итерации не помогают
**Then** зафиксирован стоп-сигнал и пересмотр подхода

### Story 0.4: Получение согласия на запись и AI-обработку

As a **коуч практики (Азиза)**,
I want **получить информированное согласие от каждого топа на запись и AI-обработку**,
So that **проект юридически защищён и топы понимают что делает система**.

**Acceptance Criteria:**

**Given** первая встреча с каждым топом
**When** Азиза информирует: «Встречи записываются, AI обрабатывает транскрипт»
**Then** момент согласия зафиксирован в транскрипте
**And** демо AI-отчёта показано топу для понимания масштаба анализа

**Given** топ не согласен
**When** отказ получен
**Then** встреча проводится без записи, pipeline пропускает эту встречу

**Given** юрист РК привлечён
**When** документ согласия подготовлен
**Then** формальное подписание завершено до Day 1 **(Go/No-Go)**

### Story 0.5: Инструкция трекера

As a **коуч практики (Азиза)**,
I want **получить чеклист и инструкцию по работе с ботом**,
So that **я знаю workflow и могу работать автономно с Day 1**.

**Acceptance Criteria:**

**Given** инструкция 2-3 страницы
**When** Азиза прочитала
**Then** описаны: `/report`, Bot Menu, approve/edit/reject flow, fallback при сбоях
**And** контрольный чеклист подключения клиента
**And** правило чувствительности контента (что удалять перед отправкой)

### Story 0.6: Runbook для Айдара

As a **контроллер качества (Айдар)**,
I want **иметь runbook для экстренных ситуаций**,
So that **если Тимур недоступен, я могу перезапустить систему и проверить статус**.

**Acceptance Criteria:**

**Given** runbook 1 страница
**When** Айдар получает алерт о сбое
**Then** описаны: как проверить статус Docker, как перезапустить, как проверить логи
**And** Айдар имеет доступ к VPS dashboard
**And** действия при недоступности Telegram: ручной режим через Google Sheets, оповещение по email

---

## Epic 1: Трекер получает и отправляет автоотчёт по встрече (F1 + Workflow)

**Цель:** Азиза отправляет ссылку → получает структурированный отчёт → одобряет/редактирует → отчёт доставлен клиенту. Полный цикл.

**FRs:** FR1-FR6, FR21-FR24, FR27-FR32, FR34-FR35, FR44, FR57-FR68, FR70-FR73, FR76-FR81, FR83-FR88, FR90

**Milestones:** Day 1-3 (core: stories 1.1-1.8), Week 1 (hardening: stories 1.9-1.12)

**Бюджет времени Тимура:** Week 1-2 = 15-20ч, Week 3 = 5-10ч, Week 4+ = цель 2ч

**Gate перед Milestone 2:**
- ≥ 5 отчётов отправлены клиенту **без существенных правок**
- Reject rate < 50%
- Азиза подтвердила workflow
- Если Week 3 ops-время > 5ч → пересмотр scope Milestone 2

### Story 1.1: Project bootstrap и конфигурация

As a **аналитик практики (Тимур)**,
I want **инициализировать проект с TypeScript, Docker и валидированной конфигурацией**,
So that **есть работающая инфраструктура для всех pipeline**.

**Acceptance Criteria:**

**Given** пустой проект
**When** `docker compose up` выполнен
**Then** Node.js + TypeScript сервер запускается без ошибок
**And** .env файл валидируется через Zod в `src/config.ts`
**And** конфигурация включает chat_id рабочего чата и ops-канала (один бот, маршрутизация по chat_id)
**And** `TZ=Asia/Almaty` установлен в Docker
**And** pino structured logging работает с полями `{pipeline, step, clientId}`
**And** HTTP `/health` endpoint возвращает 200

### Story 1.2: Transcript Interface Contract, audio download и Soniox parser

As a **аналитик практики (Тимур)**,
I want **скачать аудиозапись из Google Drive/Zoom Cloud, транскрибировать через Soniox API и преобразовать результат в единый JSON формат**,
So that **pipeline работает с любым провайдером через единый контракт, а Азизе достаточно отправить ссылку на запись**.

**Acceptance Criteria:**

**Given** Азиза отправляет боту ссылку на аудиофайл (Google Drive share link или Zoom Cloud recording link)
**When** бот получает ссылку
**Then** аудиофайл скачивается (Google Drive API для GDrive ссылок, Zoom download URL для Zoom)
**And** файл отправляется в Soniox async file transcription API с параметрами: diarization=on, languages=auto (code-switching русский↔казахский)
**And** Soniox webhook возвращает результат транскрипции

**Given** JSON schema: `{speakers: [{name, segments: [{start, end, text}]}], metadata: {date, duration, meeting_type}}`
**When** транскрипт от Soniox получен через webhook
**Then** Soniox parser конвертирует в Transcript Interface Contract
**And** Zod schema валидирует: speakers mapped, нет пустых сегментов, timestamps монотонны

**Given** `/upload` команда с raw текстом
**When** трекер отправляет plain text copy-paste
**Then** plain text parser конвертирует в тот же contract (без timestamps, с [approximate] маркерами)

**Given** validation failure
**When** данные не проходят schema
**Then** уведомление Тимуру в ops-канал, pipeline останавливается

**Given** ссылка недоступна или формат не поддерживается
**When** скачивание не удалось
**Then** бот отвечает: «Не удалось скачать файл. Проверь доступ по ссылке или используй /upload»

### Story 1.3: Sheets adapter — чтение контекста клиента

As a **аналитик практики (Тимур)**,
I want **читать OKR, стейкхолдерную карту и контекст клиента из Google Sheets**,
So that **промпты F1 получают полный контекст для генерации отчётов**.

**Acceptance Criteria:**

**Given** data access adapter (~50 строк, extensible design)
**When** pipeline запускается
**Then** batch read: OKR/KR, стейкхолдерная карта, F0 контекст за один запрос
**And** чтение по header names (не column indices)
**And** snake_case (Sheets) → camelCase (internal) конвертация на границе adapter
**And** OAuth2 token refresh работает автоматически
**And** при Sheets API failure → alert в ops-канал, pipeline не падает молча

### Story 1.4a: F1 извлечение и анализ (шаги 1-2)

As a **коуч практики (Азиза)**,
I want **получить структурированный отчёт с фактами, цитатами и commitments по встрече**,
So that **я могу отправить клиенту качественную сводку без ручного написания**.

**Acceptance Criteria:**

**Given** валидный транскрипт в Transcript Interface Contract + контекст из Sheets
**When** F1 pipeline запущен (шаги 1-2)
**Then** extraction: факты, решения, цитаты с timestamps, speakers
**And** analysis: commitments `[{who, what, deadline, quote}]`, покрытие OKR, статус гипотез
**And** промпты из `prompts/*.md` через `loadPrompt()`
**And** Claude API через `@anthropic-ai/sdk` с `withRetry()` (1s, 3s, 9s)
**And** Zod `.parse()` для fail-fast валидации
**And** speaker mapping через стейкхолдерную карту; > 70% несоответствий → [speaker_check]
**And** каждая цитата содержит timestamp; без точного совпадения → [approximate]
**And** raw Claude responses сохранены как `.raw.txt`

**Given** есть незакрытые обязательства из предыдущих встреч с этим топом
**When** новый транскрипт обработан (шаг 2, анализ)
**Then** система проверяет незакрытые обязательства и обновляет статус (выполнено / просрочено / в работе)
**And** обновлённые статусы сохранены для F4

### Story 1.4b: F1 форматирование и подготовка к доставке (шаги 3-4)

As a **коуч практики (Азиза)**,
I want **получить отформатированный отчёт, готовый к отправке через Telegram**,
So that **я могу быстро проверить и одобрить отчёт**.

**Acceptance Criteria:**

**Given** данные extraction и analysis из Story 1.4a готовы
**When** F1 pipeline выполняет шаги 3-4
**Then** formatting: структурированный отчёт (max 3 секции, scannable)
**And** delivery prep: формат для Telegram
**And** Zod `.safeParse()` для graceful degradation
**And** output на русском, казахские цитаты в оригинале с пометкой
**And** fallback на 2-step chain если 4-step нестабилен

**Given** шаги 1-2 (извлечение + анализ) завершились успешно, а шаги 3-4 упали после 3 попыток
**When** восстановление невозможно
**Then** Азизе отправлены сырые данные извлечения: «⚠️ Автоформатирование не удалось. Сырые данные:»
**And** Тимуру отправлен алерт с деталями сбоя

### Story 1.5: Telegram bot — команда /report и progress

As a **коуч практики (Азиза)**,
I want **отправить `/report <url>` и видеть прогресс генерации**,
So that **я знаю что отчёт обрабатывается и когда будет готов**.

**Acceptance Criteria:**

**Given** Азиза отправляет `/report <url>` в Telegram
**When** команда получена ботом (grammY)
**Then** мгновенный acknowledge < 2 сек: «✅ Принято. Отчёт через ~15 мин.»
**And** progress updates через editMessageText: «🔄 Читаю транскрипт...» → «🔄 Формирую отчёт...» → «🔄 Почти готово...» → preview отчёта

**Given** несколько `/report` подряд
**When** очередь > 1
**Then** сообщение: «✅ Принято. В очереди: N из M.»

**Given** невалидный URL
**When** URL не распознан
**Then** ответ < 5 сек: «⚠️ Ссылка не распознана. Проверь формат.»

**Given** транскрипт < 2 мин
**When** длительность проверена
**Then** «⚠️ Слишком короткий. Отчёт требует ≥ 2 мин.»

**And** Chat ID whitelist: только авторизованные трекеры
**And** Bot Menu: [🔍 Найти] [📋 Повестка] [📊 Статус]

### Story 1.6: Approval workflow — approve/edit/reject

As a **коуч практики (Азиза)**,
I want **просмотреть отчёт и одобрить, отредактировать или отклонить одним тапом**,
So that **я контролирую что отправляется клиенту**.

**Acceptance Criteria:**

**Given** отчёт сгенерирован и preview показан
**When** Азиза видит отчёт
**Then** inline buttons: [✅ Подтвердить → {Name}] [✏️ Исправить] [❌ Отклонить]
**And** имя получателя обязательно в кнопке approve

**Given** Азиза нажимает [✅ Подтвердить → {Name}]
**When** approve получен
**Then** статус: `ready → approved`
**And** confirmation: «✅ Подтверждено. Готово к пересылке {Name}.»
**And** запись в `approvals.jsonl` (append-only)
**And** post-approve buttons: [📝 Уточнение] [🔗 Подробнее]

**Given** Азиза нажимает [✏️ Исправить]
**When** edit flow запущен
**Then** инструкция: «✏️ Что исправить? Ответь: "Конверсия 30%, не 28%"»
**And** после reply — обновлённый preview → повторный approve

**Given** Азиза нажимает [❌ Отклонить]
**When** reject получен
**Then** статус: `ready → rejected`, перегенерация или ручной режим

**Given** double-tap на approve
**When** повторное нажатие
**Then** «ℹ️ Уже отправлено.» — без дублирования

**Given** edit reply к неправильному отчёту
**When** reply не к текущему pending
**Then** «⚠️ Нажми [✏️] под нужным отчётом.»

### Story 1.7: Delivery — доставка отчёта клиенту

As a **коуч практики (Азиза)**,
I want **чтобы одобренный отчёт доставлялся топу от моего имени**,
So that **pipeline невидим для клиента, топ получает отчёт от трекера**.

**Acceptance Criteria:**

**Given** отчёт в статусе `approved`
**When** delivery triggered
**Then** бот отправляет готовый текст Азизе для пересылки (pipeline невидим для клиента, ADR-004)
**And** формат: emoji-type + трёхуровневый header (📋 Name │ Topic │ Week) + max 3 секции
**And** секция «📱 Для {Name}»: 3-5 строк plain text для WhatsApp copy-paste
**And** commitments с lifecycle: 🔵 New, 🟡 In progress, 🟢 Completed, 🔴 Overdue
**And** emoji всегда с текстовой меткой (🟢 В норме, не просто 🟢)
**And** **bold** имена + метрики, *italic* цитаты, `code` числа
**And** Азиза пересылает текст топу самостоятельно
**And** статус: `approved → delivered`

**Given** отчёт > 4096 символов
**When** content exceeds Telegram limit
**Then** split на 2+ сообщений с нумерацией (часть 1/2) и header «📋 Name (продолжение)»
**And** buttons только под последним сообщением

**Given** delivery failure
**When** Telegram API error
**Then** «⚠️ Не доставлено. [🔄 Повторить]»

### Story 1.8: First run experience — онбординг Азизы в бот

As a **коуч практики (Азиза)**,
I want **при первом запуске бота получить приветствие и инструкцию**,
So that **я понимаю как работать с ботом без внешней помощи**.

**Acceptance Criteria:**

**Given** Азиза впервые пишет боту
**When** первое сообщение получено
**Then** приветствие с кратким описанием возможностей
**And** объяснение основной команды `/report <url>`
**And** показ Bot Menu: [🔍 Найти] [📋 Повестка] [📊 Статус]
**And** предложение попробовать: «Отправь ссылку на запись, и я сделаю отчёт»

### Story 1.9: Ops logging и алерты

As a **аналитик практики (Тимур)**,
I want **видеть логи каждого этапа pipeline и получать алерты при сбоях**,
So that **я могу быстро диагностировать проблемы и не пропускать ошибки**.

**Acceptance Criteria:**

**Given** pipeline выполняется
**When** каждый step завершён
**Then** pino log с `{pipeline, step, clientId, duration, status}`
**And** логи записываются в append-only Sheet (отдельный от данных клиента)

**Given** ошибка pipeline
**When** unrecoverable failure
**Then** уведомление Тимуру в Telegram ops-канал с деталями
**And** повторное уведомление если pipeline down > 4ч
**And** уведомление Айдару если down > 24ч

**Given** отчёт не готов за 30 мин
**When** auto-timeout
**Then** Азизе: «⏰ Задержка. Тимур уведомлён. Пиши отчёт вручную.»
**And** Тимуру: alert с деталями

**And** два Telegram чата: рабочий (отчёты + approve) и ops (алерты Тимуру)

**Given** данные об одобрениях и использовании доступны
**When** неделя завершена
**Then** агрегированные метрики: time_to_approve (среднее), f5_response_rate, bot_menu_usage
**And** данные доступны для продуктовых решений (не показываются пользователям)

### Story 1.10: Data persistence и client isolation

As a **аналитик практики (Тимур)**,
I want **хранить все данные pipeline с изоляцией по клиентам**,
So that **данные не теряются, и данные клиента A не попадают в контекст клиента B**.

**Acceptance Criteria:**

**Given** pipeline выполняется
**When** данные сохраняются
**Then** промежуточные данные в `data/{client_id}/{date}/`
**And** append-only JSON backup на диске
**And** raw Claude responses: `.raw.txt` с auto-cleanup 14 дней
**And** daily tar backup retained 7 дней

**Given** client_id
**When** любой запрос к данным
**Then** client_id проверяется на каждом этапе: промпты, хранение, delivery
**And** все данные клиента под одним client_id для offboarding (< 1ч полное удаление)

### Story 1.11: Canary test и golden dataset

As a **аналитик практики (Тимур)**,
I want **автоматически проверять что промпты не деградировали**,
So that **обновление модели или правка промптов не ломает output тихо**.

**Acceptance Criteria:**

**Given** golden dataset из Epic 0 (≥ 5 транскриптов + эталонные outputs)
**When** canary test запущен (вручную на MVP, еженедельно к Milestone 2)
**Then** F1 pipeline прогоняется на golden dataset
**And** structural diff: наличие секций, кол-во commitments, кол-во citations
**And** semantic assertions: commitments не пустой если есть обязательства, okr_references не пустой если есть OKR
**And** < 30% diff = OK
**And** 30-50% = review промптов (alert Тимуру)
**And** > 50% = rollback на предыдущую версию
**And** промпты версионируются в git + `prompts/CHANGELOG.md`

### Story 1.12: Ops-статус pipeline для Айдара

As a **контроллер качества (Айдар)**,
I want **видеть статус pipeline: работает ли бот, сколько отчётов обработано, есть ли сбои**,
So that **я контролирую систему без необходимости спрашивать Тимура**.

**Acceptance Criteria:**

**Given** Айдар нажимает [📊 Статус]
**When** запрос получен
**Then** сводка: кол-во отчётов за неделю (обработано / одобрено / отклонено), средний процент правок, статус бота, задержки (отчёты > 30 мин), последний сбой (если был)

**Given** доля отклонённых отчётов > 50% за неделю
**When** порог превышен
**Then** алерт Тимуру: «⚠️ Доля отклонений > 50%. Пересмотри промпты.»
**And** формат scannable: emoji + однострочные статусы

### Story 1.13: Поиск прошлых отчётов

As a **коуч практики (Азиза)**,
I want **найти отчёт за прошлую неделю по конкретному топу**,
So that **я могу подготовиться к встрече, просмотрев предыдущий отчёт**.

**Acceptance Criteria:**

**Given** Азиза нажимает [🔍 Найти] в меню бота
**When** запрос получен
**Then** список последних отчётов по топам (имя + дата + статус)
**And** выбор конкретного отчёта по кнопке → полный текст

**Given** поиск по имени топа
**When** Азиза вводит имя
**Then** список отчётов по этому топу за последние 4 недели

### Story 1.14: Развёртывание на Hostinger VPS

As a **аналитик практики (Тимур)**,
I want **развернуть систему на VPS с автоматическим перезапуском**,
So that **бот работает круглосуточно и переживает перезагрузки сервера**.

**Acceptance Criteria:**

**Given** docker-compose.yml и deploy.sh готовы
**When** развёртывание выполнено (ssh → git pull → docker compose up -d --build)
**Then** бот доступен 24/7
**And** `restart: unless-stopped` обеспечивает перезапуск при сбоях
**And** проверка здоровья (curl /health каждую минуту) работает
**And** при падении — автоперезапуск + уведомление в канал сопровождения

---

## Epic 2: Система собирает метрики от топ-менеджеров (F5) — Growth

> **Перенесён в Growth (15.04.2026).** На MVP F5 метрики собираются Азизой вручную на встречах и вносятся в Google Sheets. Sheets adapter (Epic 1) читает эти данные для F4 и F1. Бот F5 реализуется при масштабировании на 3+ клиентов.

**Цель:** Топы отвечают на запрос метрик в 1 тап → данные сохранены → доступны для F4, F1, F3-lite. Объективные данные для верификации.

**FRs:** FR50-FR54, FR74, FR89

**Порядок:** Growth (триггер: 3+ клиентов или высокая нагрузка на Азизу по ручному сбору)

### Story 2.1: Scheduler — shared component для batch pipeline

As a **аналитик практики (Тимур)**,
I want **надёжный scheduler с missed job detection**,
So that **F5, F4 и F3-lite запускаются по расписанию и не пропускают задания после рестарта**.

**Acceptance Criteria:**

**Given** node-cron настроен
**When** конвейер регистрирует задание (имя, расписание, обработчик)
**Then** задание выполняется по расписанию
**And** TZ=Asia/Almaty используется
**And** первое зарегистрированное задание: F5 Пн 8:00 (остальные добавляются в Epic 3/4)

**Given** Docker restart произошёл
**When** сервер перезапущен
**Then** watchdog проверяет пропущенные задания и выполняет их
**And** логирование пропущенных заданий в ops-канал

**Given** cron задача не выполнилась
**When** прошло 30 мин после ожидаемого времени
**Then** alert Тимуру: «⚠️ {job_name} не выполнен. Проверь.»

### Story 2.2: F5 onboarding — первое сообщение топу

As a **топ-менеджер**,
I want **получить понятное первое сообщение от бота с объяснением зачем нужны метрики**,
So that **я понимаю контекст и готов отвечать каждую неделю**.

**Acceptance Criteria:**

**Given** первый F5 запрос топу
**When** onboarding message отправлен
**Then** 👋 приветствие с именем трекера: «Азиза попросила каждый понедельник...»
**And** объяснение purpose: зачем собираем метрики
**And** inline keyboard: 4 pre-defined ranges + [Ввести точно]
**And** max 3 кнопки в ряд для mobile

**Given** ranges из F0 config
**When** метрики определены при онбординге
**Then** диапазоны автоматически из стейкхолдерной карты (не hardcoded)

### Story 2.3: F5 weekly collection — сбор метрик

As a **коуч практики (Азиза)**,
I want **чтобы система автоматически запрашивала метрики у топов каждый понедельник**,
So that **я имею объективные данные для повестки и отчётов**.

**Acceptance Criteria:**

**Given** Пн 8:00 (cron из Story 2.1)
**When** F5 collection запущен
**Then** каждому топу отправлен запрос: «📊 {Name}, {metric} за неделю?»
**And** inline keyboard с диапазонами + [Ввести точно]

**Given** топ нажимает range button
**When** ответ получен
**Then** «✅ Записано.» + «Вторая метрика?» (chain для 2 метрик)

**Given** топ нажимает [Ввести точно]
**When** prompt «Введи число:»
**Then** принимает число, при non-numeric: «⚠️ Введи число или нажми кнопку»

**Given** значение аномальное (сильно отличается от baseline)
**When** anomaly detected
**Then** «📊 Сильно отличается. Подтвердить?» с [Да] [Перевести]

**Given** топ не ответил до 9:00
**When** deadline прошёл
**Then** повторный запрос до 12:00
**And** если не ответил — используются прошлонедельные данные

**Given** топ исправил ответ
**When** повторный ответ до дедлайна
**Then** последний ответ побеждает

### Story 2.4: F5 storage и тренды

As a **аналитик практики (Тимур)**,
I want **хранить F5 метрики и генерировать тренды**,
So that **данные доступны для F4, F1, F3-lite и видны алерты при аномалиях**.

**Acceptance Criteria:**

**Given** метрика получена
**When** запись сохраняется
**Then** Sheets storage: `{client_id, department, metric_name, metric_type, value, week, source, reported_by}`
**And** Sheets adapter расширен (extensible design из Story 1.3)

**Given** ≥ 3 недели данных
**When** тренд рассчитан
**Then** direction indicator (↑↓→) доступен для F4/F3-lite
**And** алерт при значительном отклонении от тренда

### Story 2.5: F5 auto-deactivation и fallbacks

As a **коуч практики (Азиза)**,
I want **чтобы система адаптировалась если топ перестал отвечать**,
So that **бот не спамит молчащих топов и я могу вводить метрики вручную**.

**Acceptance Criteria:**

**Given** топ не отвечает 3+ недели подряд
**When** auto-deactivation triggered
**Then** режим manual_tracker: трекер вводит метрики за топа
**And** уведомление Азизе: «ℹ️ Переключаю {Name} на ручной ввод»

**Given** F5 бот не работает
**When** сбой Telegram
**Then** Google Form fallback ссылка доступна

---

## Epic 3: Трекер получает повестку к встречам (F4)

**Цель:** Азиза каждый понедельник получает повестку на каждого топа: приоритизированные вопросы, расхождения метрик, незакрытые обязательства. Подготовка за 2 мин.

**FRs:** FR8-FR11, FR9b, FR23, FR25, FR33, FR52

**Порядок:** Milestone 2, сразу после Epic 1. Не зависит от F5 бота — метрики из Sheets (ручной ввод Азизы). 1-2 итерации промпта с Азизой заложены.

> **Заметка (Фаза 2):** Полное замыкание цикла F4→F1 (проверка: задал ли трекер вопрос из повестки, привёл ли вопрос к обсуждению) реализуется в Фазе 2 через F2 QC. В MVP замыкание обеспечивается carry-forward (🔄) необсуждённых пунктов.

### Story 3.1: Конвейер F4 — генерация повестки

As a **коуч практики (Азиза)**,
I want **получить повестку на каждого топа с приоритизированными вопросами к понедельнику**,
So that **я подготовлена к встречам за 2 минуты вместо 30**.

**Acceptance Criteria:**

**Given** Пн 9:00 (планировщик из Story 2.1)
**When** конвейер F4 запущен
**Then** агрегация: все F1 за неделю + OKR + обязательства + (опционально) F5 метрики
**And** один промпт с опциональной секцией F5 (активируется если данные есть)
**And** результат: повестка по каждому топу, максимум 3 пункта
**And** каждый ❓ вопрос сопровождается 📊 контекстом

**Given** данные F5 доступны
**When** метрики расходятся с заявлениями на встрече
**Then** ⚠️ маркер: «Жанель сказала "конверсия растёт", но F5: 22% ↓ (было 28%)»
**And** тон любопытства: «Уточни: что изменилось?»

**Given** незакрытые обязательства из предыдущих F1
**When** обязательство не обсуждено или не выполнено
**Then** включено в повестку с дедлайном и статусом

**Given** пункт из прошлой F4 не был обсуждён
**When** нет упоминания в F1 за прошлую неделю
**Then** 🔄 маркер: «🔄 Повторно: {тема}»

### Story 3.2: Градиент зрелости данных в F4

As a **коуч практики (Азиза)**,
I want **чтобы повестка адаптировалась к количеству накопленных данных**,
So that **первые недели повестка полезна даже без истории, а потом становится глубже**.

**Acceptance Criteria:**

**Given** неделя 1 (новый клиент или новый топ)
**When** < 1 F1 в истории
**Then** формат знакомства: «узнай как видит KR, что считает вызовом»
**And** фокус: шляпа трекера (факты, статусы, знакомство)

**Given** неделя 2-3
**When** 1-2 F1 в истории
**Then** пометка: «📎 Мало данных — повестка станет точнее через 2-3 недели»
**And** фокус: трекер + элементы эксперта

**Given** неделя 4+
**When** ≥ 3 F1 в истории
**Then** полный формат: обязательства, слепые зоны, паттерны поведения
**And** фокус: коуч (формирующие вопросы) + фасилитатор (кросс-связи)

### Story 3.3: Режимы повестки — опытный и начинающий трекер

As a **контроллер качества (Айдар)**,
I want **переключать режим повестки между опытным и начинающим трекером**,
So that **опытный получает подсказки, а новичок — пошаговый гайд**.

**Acceptance Criteria:**

**Given** режим «опытный» (по умолчанию для Азизы)
**When** повестка сгенерирована
**Then** 💡 пометка: «Начни со слушания. Эти вопросы — подсказка, не скрипт.»
**And** ❓ вопросы + 📊 контекст + ⚠️ расхождения

**Given** режим «начинающий»
**When** переключено в настройках (F0)
**Then** 📋 пошаговый гайд: «1. Спроси про... 2. Уточни... 3. Зафиксируй...»
**And** 📊 данные для каждого шага

**Given** Айдар хочет сменить режим
**When** настройка изменена
**Then** следующая повестка использует новый режим

### Story 3.4: Навигация и кэширование повестки в Telegram

As a **коуч практики (Азиза)**,
I want **быстро найти повестку на конкретного топа в любой момент**,
So that **перед каждой встречей я готова за 1 тап**.

**Acceptance Criteria:**

**Given** понедельничная рассылка
**When** F4 отправлена в рабочий чат
**Then** заголовок: ❓ Повестка │ Нед. N │ K топов
**And** плоский список с кнопками [📋 Имя] по каждому топу + [📋 Все]

**Given** Азиза нажимает [📋 Имя]
**When** переход к конкретному топу
**Then** полная повестка для этого топа
**And** возможность вернуться к общему списку

**Given** меню бота [📋 Повестка]
**When** Азиза нажимает в любой момент
**Then** мгновенный ответ с сохранённой повесткой (без перегенерации)

### Story 3.5: Отменённые встречи и нестандартные ситуации

As a **коуч практики (Азиза)**,
I want **чтобы повестка корректно обрабатывала отмены и пропуски**,
So that **система не ломается при нестандартных ситуациях**.

**Acceptance Criteria:**

**Given** встреча с топом отменена (нет F1)
**When** повестка генерируется
**Then** пометка: «⏰ Перенесено: {тема} к {дата} — не проверено»

**Given** новый клиент (первичный онбординг)
**When** повестка для нового клиента
**Then** формат знакомства из F0: «узнай как видит KR, что считает вызовом»

### Story 3.6: Напоминание о ревизии стейкхолдерной карты

As a **коуч практики (Азиза)**,
I want **получать ежемесячное напоминание о ревизии стейкхолдерной карты**,
So that **данные о ролях и контурах не устаревают**.

**Acceptance Criteria:**

**Given** прошёл 1 месяц с последнего обновления стейкхолдерной карты
**When** срок ревизии наступил
**Then** бот отправляет Азизе: «📋 Пора обновить стейкхолдерную карту {клиент}. Последнее обновление: {дата}»
**And** ссылка на Google Sheets с картой

---

## Epic 4: CEO получает еженедельную сводку (F3-lite)

**Цель:** Дамир видит прогресс команды: 🟢🟡🔴 статусы, конкретный пример поведения, вопрос при отклонении. Спокойная уверенность что инвестиция работает.

**FRs:** FR12, FR12a, FR13, FR14, FR48, FR52, FR82

**Порядок в Milestone 2:** Третий (после F4). Первую сводку Азиза + Тимур калибруют под Дамира.

### Story 4.1: Конвейер F3-lite — генерация CEO-сводки

As a **коуч практики (Азиза)**,
I want **получить компактную сводку для Дамира с ключевыми изменениями за неделю**,
So that **CEO видит прогресс команды и продолжает платить за трекинг**.

**Acceptance Criteria:**

**Given** понедельник, конвейер F3-lite запущен (планировщик из Story 2.1)
**When** агрегация F1 за неделю + (опционально) F5 метрики
**Then** сводка: 5 строк + 🟢🟡🔴 по каждому OKR + 1 инсайт/вопрос
**And** формат «только изменения»: показывать только отличия от прошлой недели
**And** направление: 🟢→🟢 стабильно, 🔴→🟢 улучшение, 🟢→🔴 ухудшение

**Given** v1 (без F5)
**When** данных метрик нет
**Then** сводка строится на F1 + отслеживание обязательств (что обещали → что сделали)

**Given** v2 (с F5)
**When** метрики доступны
**Then** 🟢🟡🔴 подкреплены объективными цифрами из F5

**And** никаких прямых цитат топов — только агрегированные наблюдения
**And** минимум 1 конкретный пример поведения: 💡 «Жанель впервые сама предложила гипотезу»
**And** ❓ вопрос-триггер только при 🟡 или 🔴 статусе

### Story 4.2: Формат сводки для копирования в WhatsApp

As a **коуч практики (Азиза)**,
I want **получить текст сводки в формате, готовом для копирования в WhatsApp**,
So that **я могу отправить Дамиру за 10 секунд без переформатирования**.

**Acceptance Criteria:**

**Given** сводка сгенерирована
**When** бот отправляет результат Азизе
**Then** отдельная секция: «📱 Текст для Дамира (скопируй):»
**And** чистый текст без разметки Telegram (без markdown)
**And** 3-5 строк максимум
**And** одобрение трекером обязательно перед отправкой (как в Story 1.6)

### Story 4.3: Неполные данные и ручной режим

As a **коуч практики (Азиза)**,
I want **чтобы система корректно работала когда не все отчёты готовы**,
So that **сводка отправляется вовремя даже при неполных данных**.

**Acceptance Criteria:**

**Given** не все топы имеют F1 за неделю
**When** сводка генерируется
**Then** запрос: «⚠️ Нет отчёта по {имена}. Отправить как есть?» [Да] [Подождать]

**Given** Азиза нажимает [Да]
**When** подтверждение получено
**Then** сводка отправляется с имеющимися данными

**Given** сводка не отправлена в понедельник (сбой или reject)
**When** дедлайн пропущен
**Then** напоминание Азизе: «⚠️ Сводка для Дамира не отправлена. Напиши вручную или подтверди.»

**Given** сводка не отправлена Дамиру к 18:00 понедельника
**When** дедлайн пропущен
**Then** уведомление Тимуру: «⚠️ Сводка CEO не отправлена. Проверь с Азизой.»

### Story 4.4: Еженедельная ритмичность и предсказуемость

As a **заказчик постановки практики (Дамир)**,
I want **получать сводку в предсказуемый день и время каждую неделю**,
So that **у меня формируется привычка проверять прогресс команды**.

**Acceptance Criteria:**

**Given** еженедельное расписание
**When** каждый понедельник
**Then** сводка генерируется по расписанию, даже если CEO не ответил на предыдущую
**And** ритмичность доставки не зависит от активности CEO

**Given** CEO не открывает уведомления 2+ недели подряд (Фаза 2)
**When** сигнал неактивности
**Then** формат автоматически сокращается до 1 предложения + 1 вопрос

---

## Epic 5: Контроль качества трекера (F2) — Фаза 2

**Цель:** Айдар видит QC-сводку по трекерам: баланс говорения, распределение 4 шляп, покрытие OKR. Азиза получает обратную связь по методологии. Оценка = информация, не приговор.

**FRs:** FR15-FR19, FR26, FR37-FR39

**Триггер:** Кодификация методологии утверждена Айдаром.

### Story 5.0: Кодификация методологии трекинга

As a **контроллер качества (Айдар)**,
I want **формализовать правила оценки качества сессий совместно с Тимуром**,
So that **промпты F2 строятся на утверждённой кодификации, а не на допущениях**.

**Acceptance Criteria:**

**Given** методология 4 шляп + баланс говорения + покрытие OKR
**When** Айдар и Тимур проводят сессию кодификации
**Then** документ: правила классификации реплик по шляпам (с примерами)
**And** пороги баланса говорения утверждены
**And** определение «обсуждено» / «упомянуто» / «слепая зона» зафиксировано
**And** документ утверждён Айдаром как основа для промптов F2

### Story 5.1: Анализ баланса говорения и монологов

As a **контроллер качества (Айдар)**,
I want **видеть соотношение говорения трекера и клиента на каждой встрече**,
So that **я могу выявить трекеров, которые слишком много говорят вместо того чтобы слушать**.

**Acceptance Criteria:**

**Given** транскрипт обработан (F1 данные доступны)
**When** F2 анализ запущен
**Then** вычислен процент говорения трекера: норма 30-45%, жёлтый 45-55%, красный > 55%
**And** выявлены монологи трекера > 2 мин
**And** результат помечен «AI-оценка» (не абсолютная истина)

### Story 5.2: Распределение 4 шляп трекера

As a **контроллер качества (Айдар)**,
I want **видеть в какой роли трекер провёл встречу**,
So that **я могу корректировать методологический фокус трекера**.

**Acceptance Criteria:**

**Given** транскрипт обработан
**When** F2 анализ запущен
**Then** распределение: коуч (35-45%), эксперт (15-25%), трекер (20-30%), фасилитатор (10-20%)
**And** при согласованности < 70% — откат на 3 шляпы (фасилитатор + трекер объединены)
**And** результат помечен «AI-оценка»

### Story 5.3: Покрытие OKR на встречах

As a **контроллер качества (Айдар)**,
I want **видеть какие KR обсуждены, какие упомянуты, какие пропущены**,
So that **я контролирую что трекер не оставляет слепые зоны**.

**Acceptance Criteria:**

**Given** транскрипт + OKR из Sheets
**When** F2 анализ запущен
**Then** ≥ 2 содержательных реплики = «обсуждено», 1 = «упомянуто», 0 за 2+ нед = «слепая зона»
**And** целевое покрытие: 100% KR за 2 недели
**And** слепые зоны выделены в отчёте

### Story 5.4: Еженедельная обратная связь трекеру

As a **коуч практики (Азиза)**,
I want **получить обратную связь по методологии за неделю**,
So that **я улучшаю качество коучинга на основе данных, а не интуиции**.

**Acceptance Criteria:**

**Given** все встречи за неделю обработаны F2
**When** фидбэк сформирован
**Then** формат: что хорошо + что усилить + конкретная рекомендация
**And** тон: «попробуй на следующей неделе...», не «ты сделала неправильно»
**And** пометка «AI-оценка»

### Story 5.5: QC-сводка для руководителя

As a **контроллер качества (Айдар)**,
I want **видеть агрегированную сводку по всем трекерам и клиентам**,
So that **я контролирую качество на одном экране, не слушая записи**.

**Acceptance Criteria:**

**Given** все F2 за неделю обработаны
**When** Айдар запрашивает сводку
**Then** таблица: трекер × клиент × баланс говорения × шляпы × покрытие OKR × светофор
**And** алерт при отклонении трекера от методологии

**Given** ≥ 4 недели данных
**When** тренды доступны
**Then** отображение трендов QC-метрик по клиенту за период

### Story 5.6: Хранение QC-данных для трендов

As a **аналитик практики (Тимур)**,
I want **хранить QC-метрики в хронологическом журнале**,
So that **данные за 3-6 месяцев доступны для анализа трендов**.

**Acceptance Criteria:**

**Given** F2 результат сформирован
**When** данные сохраняются
**Then** запись только на добавление в отдельный лист Sheets
**And** структура: client_id, трекер, неделя, баланс говорения, шляпы, покрытие OKR

---

## Epic 6: Масштабирование и рост

**Цель:** Система поддерживает 5-10 клиентов, 2-3 трекеров. Изоляция данных на техническом уровне, отслеживание расходов, деградация одобрения.

**FRs:** FR40-FR43, FR75

**Триггеры:** PostgreSQL при 3-м клиенте, деградация одобрения при > 95% без правок.

### Story 6.1: Миграция на PostgreSQL

As a **аналитик практики (Тимур)**,
I want **перевести хранение данных с Sheets + JSON на PostgreSQL**,
So that **система выдерживает нагрузку 5-10 клиентов без деградации**.

**Acceptance Criteria:**

**Given** подключён 3-й клиент (жёсткий триггер)
**When** миграция выполнена
**Then** все данные перенесены из Sheets/JSON в PostgreSQL
**And** абстракция хранения (из Story 1.3) заменена без изменений бизнес-логики
**And** Sheets остаётся как интерфейс чтения для людей (синхронизация)

### Story 6.2: Адаптация под нового клиента

As a **аналитик практики (Тимур)**,
I want **подключить клиента из другой отрасли без переписывания конвейеров**,
So that **масштабирование не требует инженерной работы на каждого клиента**.

**Acceptance Criteria:**

**Given** новый клиент из другой отрасли
**When** подключение начато
**Then** адаптация через конфигурацию: терминология, роли, структура OKR
**And** промпты параметризованы через F0 контекст (не жёстко закодированы)
**And** 1-2 недели на перенастройку промптов учтены в графике

### Story 6.3: Деградация режима одобрения

As a **коуч практики (Азиза)**,
I want **чтобы система ослабляла контроль одобрения когда я стабильно одобряю без правок**,
So that **я не тратила время на подтверждение очевидно хороших отчётов**.

**Acceptance Criteria:**

**Given** Азиза одобряет > 95% отчётов без правок, 4+ недели подряд
**When** порог достигнут
**Then** предложение перехода: `полный контроль` → `просмотр после отправки` → `только исключения`
**And** переключение только с подтверждения трекера (не автоматическое)

### Story 6.4: Сравнение трекеров и отслеживание расходов

As a **контроллер качества (Айдар)**,
I want **сравнить QC-метрики двух трекеров и видеть расходы на API**,
So that **я принимаю решения о найме и бюджете на основе данных**.

**Acceptance Criteria:**

**Given** ≥ 2 трекеров в системе
**When** Айдар запрашивает сравнение
**Then** таблица: трекер × период × баланс говорения × шляпы × покрытие OKR

**Given** несколько клиентов
**When** отчёт по расходам запрошен
**Then** стоимость API за период по клиентам: вызовы Claude, вызовы Soniox, итого

### Story 6.5: Техническая изоляция при нескольких трекерах

As a **аналитик практики (Тимур)**,
I want **обеспечить жёсткую изоляцию данных при 2+ трекерах**,
So that **трекер видит только своих клиентов, а данные не пересекаются**.

**Acceptance Criteria:**

**Given** 2+ трекеров в системе
**When** трекер обращается к боту
**Then** отдельные чаты или потоковая изоляция по трекерам
**And** ревью кода изоляции при подключении 2-го трекера

**Given** 5+ клиентов
**When** масштаб достигнут
**Then** жёсткое техническое разделение доступа (не логическое)

## Epic 7: Онбординг клиента через бота (F0) + минимальная мультиклиентность

> Добавлен 2026-07-07 (WP-39 Ф2, см. sprint-change-proposal-2026-07-07-wp39-f2.md). Автоматизирует ручной онбординг Story 0.2. Формат stories — лёгкий (solo MVP): 3 AC, ~5 задач, 1 проход ревью.

**Цель:** Трекер онбордит нового клиента без Тимура: артефакты стратегии → одна сессия вопросов → рабочая среда (Google Sheets по шаблону v2.0, банк гипотез, карточка клиента, чеклист недели 1). Несколько клиентов у одного трекера, F1 работает per-client, регресс Geonline не сломан.

**FRs (новые):**
- FR91 [MVP]: Трекер запускает онбординг нового клиента командой в Telegram
- FR92 [MVP]: Бот принимает файлы артефактов стратегии (md/docx/pdf) и извлекает OKR/KR, гипотезы, участников
- FR93 [MVP]: KR без числовой базы «с X до Y» или без ответственного помечается 🔴 и блокирует завершение онбординга
- FR94 [MVP]: Каждая гипотеза в банке имеет метрику проверки; синтезированные из решений гипотезы помечены «требует подтверждения»
- FR95 [MVP]: Бот не выдумывает: нераспознанное показывается списком, вопросы задаются только про отсутствующее в артефактах
- FR96 [MVP]: Бот создаёт Google Sheets «Стратегический трекинг» по шаблону v2.0 (Панель OKR, Банк гипотез, Лог встреч + машиночитаемые листы)
- FR97 [MVP]: Карточка клиента в боте (участники/роли/контакты/расписание/ссылка на Sheets/дата старта); несколько клиентов у одного трекера; F1 резолвит клиента и встречу

**Инварианты (блокирующие, из WP-39):** см. sprint-change-proposal-2026-07-07-wp39-f2.md §1.

**Вне scope:** QC-скоринг, демо-режим, биллинг, веб-дашборд, онбординг «с нуля» без артефактов (fallback — короткая ручная форма).

### Story 7.1: Вертикальный срез — OKR-документ → черновик панели OKR

As a **коуч практики (Азиза)**,
I want **отправить боту OKR-документ клиента и получить черновик панели OKR**,
So that **черновик рабочей среды появляется за ≤ 15 минут без участия архитектора**.

**Acceptance Criteria:**

**Given** трекер запустил «новый клиент» и приложил md-файл OKR-документа (эталон: GeOnline OKR Framework 2026)
**When** пайплайн извлечения отработал
**Then** в чат приходит черновик панели OKR (objective → KR: формулировка / база / цель / ответственный / срок) за ≤ 15 мин

**Given** в документе KR без числовой базы «с X до Y» или без ответственного
**When** черновик формируется
**Then** такой KR помечен 🔴 с причиной и попадает в блок «требует дозаполнения» (инвариант 1)

**Given** фрагменты документа, которые не удалось надёжно извлечь
**When** черновик формируется
**Then** они перечислены в блоке «Не распознано» без выдуманных значений (инвариант 3), а не-OKR-файл даёт понятную ошибку

### Story 7.2: Полный вход — docx/pdf, несколько файлов, гипотезы и участники

As a **коуч практики (Азиза)**,
I want **загрузить полный пакет артефактов (протокол сессии, OKR-документ, нарратив) в md/docx/pdf**,
So that **бот извлекает банк гипотез и участников из любых форматов реальных стратегических документов**.

**Acceptance Criteria:**

**Given** пакет из нескольких файлов md/docx/pdf
**When** извлечение отработало
**Then** черновик содержит панель OKR + банк гипотез (ЕСЛИ-ТО-ПОТОМУ ЧТО, метрика проверки — инвариант 2) + участников с ролями

**Given** артефакт без явных гипотез (эталон: протокол SAM)
**When** извлечение отработало
**Then** кандидаты в гипотезы синтезированы из решений/инициатив и помечены «требует подтверждения трекером»

**Given** документ с мусорными URL, RU/KZ code-switching и разноформатными датами
**When** извлечение отработало
**Then** мусор отсечён до подачи в Claude, имена и даты нормализованы, эмодзи-статусы сохранены как данные

### Story 7.3: Диалог дозаполнения — вопросы только про отсутствующее

As a **коуч практики (Азиза)**,
I want **ответить на вопросы бота только о том, чего нет в артефактах (базы KR, ответственные, контакты, слоты встреч)**,
So that **онбординг завершается за одну сессию без повторного ввода уже известного**.

**Acceptance Criteria:**

**Given** черновик с 🔴-пометками и нераспознанным
**When** трекер продолжает онбординг
**Then** бот задаёт вопросы ТОЛЬКО про отсутствующее (базы KR, ответственные, telegram-контакты, слоты расписания) — по одному блоку, с возможностью пропустить и вернуться

**Given** все блокирующие пробелы закрыты
**When** трекер подтверждает финальный черновик
**Then** онбординг помечается готовым к выпуску; при незакрытых 🔴 по KR выпуск заблокирован (инвариант 1)

**Given** сессия прервана (рестарт бота, пауза трекера)
**When** трекер возвращается
**Then** состояние онбординга восстановлено с места остановки (персист на диск)

### Story 7.4: Создание Google Sheets по шаблону «Стратегический трекинг v2.0»

As a **коуч практики (Азиза)**,
I want **чтобы бот сам создал Google Sheets клиента по шаблону Geonline v2.0**,
So that **рабочая среда готова к первой трекшн-встрече без ручного копирования таблиц**.

**Acceptance Criteria:**

**Given** подтверждённый черновик онбординга
**When** бот создаёт таблицу
**Then** создан spreadsheet с листами «Панель OKR», «Банк гипотез», «Лог встреч» (+ машиночитаемые _stakeholder_map/_okr/_f5_metrics/_ops_logs), заполненными данными онбординга, доступ выдан трекеру

**Given** статусная модель шаблона
**When** листы заполняются
**Then** структура колонок соответствует эталону v2.0 (эмодзи-статусы 🟢🟡🔴 / 🟢🟡🔴⏳⛔🆕), формат гипотез — как в «трекер гипотез 10 неделя»

**Given** сбой Sheets/Drive API на любом шаге
**When** создание прервано
**Then** трекер получает понятную ошибку с возможностью повторить без дублирования таблиц

### Story 7.5: Карточка клиента и чеклист готовности к неделе 1

As a **коуч практики (Азиза)**,
I want **карточку клиента в боте и чеклист готовности**,
So that **видно, что клиент готов к первой трекшн-встрече, а бот знает участников и расписание**.

**Acceptance Criteria:**

**Given** завершённый онбординг
**When** карточка сохранена
**Then** в data/{client_id}/ лежит карточка: компания, отрасль, участники (имя/роль/OKR-направление/telegram), CEO, трекер, расписание встреч, ссылка на Sheets, дата старта

**Given** карточка и таблица созданы
**When** трекер запрашивает статус
**Then** бот показывает чеклист готовности к неделе 1 (данные загружены, KR считаемы, участники и слоты заполнены, Sheets доступен) с 🟢/🔴 по пунктам

**Given** незавершённые пункты чеклиста
**When** статус показан
**Then** по каждому 🔴 понятно действие для закрытия (инвариант 1 не обойти)

### Story 7.6: Минимальная мультиклиентность и регресс Geonline

As a **аналитик практики (Тимур)**,
I want **реестр клиентов вместо хардкода Geonline**,
So that **F1 работает для 2+ клиентов одного трекера, а Geonline продолжает работать как раньше**.

**Acceptance Criteria:**

**Given** 2 клиента в реестре (Geonline + пилот)
**When** трекер запускает /report
**Then** клиент и топ-менеджер резолвятся из карточки/выбора (не из DEFAULT_CLIENT_ID='geonline'), resolveSheetId работает по реестру clientId→sheetId, appendOpsLog пишет в таблицу своего клиента

**Given** существующий пилот Geonline
**When** мультиклиентность включена
**Then** регресс не сломан: полный F1-цикл Geonline проходит как раньше (canary + golden dataset зелёные), client isolation review пройден (NFR6)

**Given** конфигурация клиентов
**When** новый клиент добавлен онбордингом
**Then** без правок кода и env-переменных вида GEONLINE_*: реестр пополняется данными онбординга

## Epic 8: Прод-фидбэк онбординга (WP-39 Ф2)

> Добавлен 2026-07-08 (correct-course по прод-демо Ф2). **v2 2026-07-08:** после UX-walkthrough в роли трекера stories 8.2/8.3/8.4 расширены, добавлена 8.6; карта трения W1–W12 — sprint-change-proposal-2026-07-08-epic8-onboarding-feedback.md §6. Формат stories — лёгкий (solo MVP): 3 AC, ~5 задач, 1 проход ревью. **Порядок выполнения: 8.1 → 8.2 → 8.3 → 8.4 → 8.6 → 8.5.**

**Цель:** Закрыть блокеры приёмки Ф2, вскрытые живым прогоном онбординга AIPLUS: чистый шаблон таблицы (клиент не видит данные Geonline), нейтральный бренд бота, читаемая доставка и честный прогресс, навигация по клиентам с защитой сессии, комфортный диалог дозаполнения, импорт готовой стратегии. Якорь: Азиза самостоятельно онбордит 2 пилотных клиентов через бота.

**FRs (новые):**
- FR98 [MVP]: Созданная онбордингом таблица содержит ТОЛЬКО данные онбордингового клиента — никаких данных/имён других клиентов из шаблона
- FR99 [MVP]: Бренд бота нейтрален к клиентам («Geonline» — клиент, не продукт); тексты бота актуальны и непротиворечивы; техническая обратная совместимость clientId='geonline' сохранена
- FR100 [MVP]: Длинные табличные выдачи в Telegram заменяются ссылкой на документ (созданный Sheet) + 1–2 предложения саммари; во время долгих операций трекер видит честный живой прогресс
- FR101 [MVP]: Стартовое меню бота: что умеет / онбординг нового клиента / клиенты из реестра со статусом и выбором активного; активная сессия онбординга защищена от случайного сброса
- FR102 [MVP]: Два алгоритма входа онбординга: импорт готовой стратегии (Excel/текст, минимум LLM, маппинг колонок) и синтез из сырых документов (текущий LLM-путь); развилка в начале онбординга
- FR103 [MVP]: Диалог дозаполнения группирует вопросы по сущности (KR целиком, а не по типу пробела) и мягко валидирует числовые ответы

**Инварианты Epic 7 (1–4) действуют без изменений.** Регресс-guardrail всего эпика: `clientId === 'geonline'` fallback, `GEONLINE_F0_SHEET_ID` и полный F1-цикл Geonline (canary + golden dataset) остаются зелёными после каждой story.

**Вне scope:** формульная переработка ВСЕХ панелей шаблона (только ключевые), онбординг «с нуля» без артефактов, QC-скоринг, биллинг, веб-дашборд.

### Story 8.1: [P0] Чистый шаблон v2.0 — таблица клиента без данных Geonline

> Дизайн шаблона и механики создания: design-f0-template-v2-clean-2026-07-08.md (шаблон-как-код через `scripts/f0-build-template.ts` + формульные панели + duplicateSheet персональных листов топов; Apps Script отклонён — обоснование в §1 дизайна).

As a **коуч практики (Азиза)**,
I want **чтобы созданная ботом таблица нового клиента содержала только его данные**,
So that **пилот с реальным клиентом возможен и данные Geonline не утекают третьим лицам**.

**Acceptance Criteria:**

**Given** чистый бланк-шаблон v2.0, сгенерированный `scripts/f0-build-template.ts` (без данных и имён Geonline, вкл. legacy-листы), и `F0_SHEETS_TEMPLATE_ID`, указывающий на него
**When** онбординг создаёт таблицу клиента
**Then** ни один лист созданной таблицы не содержит данных/имён Geonline; машинные листы `_meta`/`_okr`/`_stakeholder_map`/`_hypotheses` заполнены данными клиента (Fix A; схемы расширены по §3 дизайна)

**Given** формульные панели шаблона («📊 Все OKR», «🧪 Банк гипотез», эталон «👤 Шаблон топа») и запись F0 в машинные листы
**When** таблица создана
**Then** панели отображают данные онбордингового клиента без участия кода (Fix B), а персональные листы «👤 {Имя}» созданы duplicateSheet-ом по каждому владельцу KR (идемпотентно — повторный /confirm не плодит листы)

**Given** orphan-таблица AIPLUS (`1JwqnA0T1GXD0_LvmrvYcf93z70C7Mkk8r089DHwwkjA`) и переключённый шаблон
**When** чистка и пере-онбординг AIPLUS выполнены
**Then** orphan удалена, новая таблица AIPLUS корректна, а боевая таблица Geonline и `GEONLINE_F0_SHEET_ID` не затронуты (регресс-guardrail зелёный)

### Story 8.2: Ребрендинг и аудит текстов — «Geonline» это клиент, не продукт

As a **коуч практики (Азиза)**,
I want **бота с нейтральным именем и актуальными, непротиворечивыми текстами**,
So that **второй и последующие клиенты не видят в продукте имя и людей чужой компании, а подсказки бота не врут**.

**Acceptance Criteria:**

**Given** аудит `src/bot.ts`, `prompts/`, `src/config.ts`, `src/f0-fill.ts` (+ название шаблона таблицы)
**When** переименование и актуализация применены
**Then** (а) пользовательские тексты, дефолты и системные промпты не упоминают «Geonline» как продукт/бренд и не используют имена людей Geonline в примерах (пример расписания «Жанель — вт 15:00», `f0-fill.ts:102` — W8); (б) welcome не числит реализованные функции в «Скоро» (W1); (в) тексты инварианта 1 синхронизированы с ослабленным поведением /confirm — «предупреждает, не блокирует» везде: черновик, /status, /confirm (W7)

**Given** техническая обратная совместимость
**When** полный регресс прогнан
**Then** `clientId === 'geonline'` fallback и `GEONLINE_F0_SHEET_ID` работают как раньше: canary + golden + весь vitest зелёные

**Given** профиль бота в BotFather
**When** ручные шаги Тимура выполнены по чеклисту из story
**Then** имя/описание/about бота нейтральны; чеклист зафиксирован в story-файле как Manual TODO

### Story 8.3: Читаемая доставка — ссылка на Sheet вместо простыней + честный прогресс

As a **коуч практики (Азиза)**,
I want **получать ссылку на документ и короткое саммари вместо длинных таблиц, а во время сборки видеть живой прогресс**,
So that **черновик и отчёты читаются с телефона за минуту, а долгая сборка не выглядит как зависание**.

**Acceptance Criteria:**

**Given** доставка F0-черновика (`src/bot.ts` draft-delivery, сейчас — plain-text простыня на несколько сообщений по 4000 симв. — W4)
**When** черновик готов
**Then** сообщение компактно: 1–2 предложения саммари + счётчики (OKR/гипотезы/участники) + блок 🔴 и «Не распознано»; полные таблицы не инлайнятся, а после создания Sheets даётся ссылка на таблицу (URL из `f0-sheets.ts`)

**Given** сборка черновика из большого пакета (реально ~8–10 мин при таймауте 12 мин, при обещании «1-2 минуты» — W2)
**When** трекер ждёт результат
**Then** оценка времени честная (зависит от размера пакета), progress-сообщение живёт до результата и обновляется (editMessage), по завершении редактируется в итог/ошибку — не удаляется молча

**Given** доставка F1-отчёта с длинными секциями и существующий approve/edit/reject
**When** отчёт отправляется
**Then** длинные табличные блоки заменены ссылкой на документ + саммари, лимит 4096 не ломается; короткие отчёты и workflow одобрения работают как раньше (vitest зелёный)

### Story 8.4: Стартовое меню, навигация по клиентам и защита сессии

As a **коуч практики (Азиза)**,
I want **интерактивное меню при входе в бота и защиту от случайной потери онбординга**,
So that **можно выбрать клиента или начать онбординг без запоминания команд и не потерять введённые ответы**.

**Acceptance Criteria:**

**Given** команда `/start` (сейчас — статический `formatWelcomeMessage`, не упоминающий онбординг — W1)
**When** трекер открывает бота
**Then** приходит меню с inline-кнопками: «Что умеет бот», «Онбординг нового клиента», «Клиенты»

**Given** пункт «Клиенты»
**When** трекер выбирает его
**Then** показан список клиентов из реестра (`src/client-registry.ts`); клик по клиенту → статус из `data/{clientId}/card.json` (карточка + чеклист готовности — работает и для завершённых клиентов, не только активной сессии — W10) и действие «работать с этим клиентом» (выбор хранится в сессии, используется `/report` без явного clientId)

**Given** активная сессия онбординга (фаза filling с введёнными ответами)
**When** трекер жмёт «Онбординг нового клиента» или шлёт `/newclient` (сейчас — молчаливый сброс всего прогресса — W3)
**Then** бот просит подтверждение перед сбросом; появилась команда `/cancel` (завершить сессию с подтверждением); `/skip`, `/resume`, `/cancel` зарегистрированы в setMyCommands (W9); прежние команды работают, регресс зелёный

### Story 8.5: Два алгоритма входа онбординга — импорт готовой стратегии vs синтез

As a **коуч практики (Азиза)**,
I want **загрузить готовую согласованную стратегию (Excel/текст) и получить прямой импорт в структуру**,
So that **онбординг клиента с готовой стратегией не зависит от качества LLM-синтеза и проходит быстрее**.

**Acceptance Criteria:**

**Given** дизайн-записка развилки (критерии выбора пути, маппинг колонок Excel → `_okr`/`_stakeholder_map`/`_hypotheses`, обработка нераспознанных колонок)
**When** записка утверждена Тимуром ДО начала кодирования
**Then** решение зафиксировано в story-файле; кодирование начинается только после утверждения

**Given** готовая стратегия в `.xlsx` (пакет `xlsx` уже в deps) или структурированном тексте
**When** трекер выбирает «импорт готовой стратегии» в начале онбординга
**Then** данные маппятся в машинные листы с минимумом LLM; инварианты 1–2 применяются (несчитаемые KR → 🔴, гипотезы без метрики → дозаполнение); немаппируемое показано списком (инвариант 3)

**Given** сырые документы без готовой стратегии
**When** трекер выбирает «синтез из документов» (или импорт невозможен)
**Then** работает текущий LLM-путь Epic 7 без деградации: smoke SAM + GeOnline и весь регресс зелёные

### Story 8.6: Качество диалога дозаполнения — вопросы по KR и валидация ответов

> Выполняется ПЕРЕД 8.5 (см. порядок в шапке эпика): дешёвая полировка core-loop до большой дизайн-развилки.

As a **коуч практики (Азиза)**,
I want **отвечать на вопросы про один KR подряд и получать переспрос при опечатке в числе**,
So that **дозаполнение из 20+ вопросов проходит без переключения контекста и мусора в таблице**.

**Acceptance Criteria:**

**Given** черновик с несколькими неполными KR (сейчас очередь `computeF0Gaps` сгруппирована по ТИПУ пробела: все базы → все цели → все ответственные — W5)
**When** идёт диалог дозаполнения
**Then** вопросы сгруппированы по сущности: база → цель → ответственный одного KR подряд (или одним составным вопросом), затем следующий KR; прогресс `(i/N)` и порядок «KR → гипотезы → контакты → расписание» сохранены

**Given** вопрос про числовое поле (база «с X» / цель «до Y»)
**When** трекер отвечает нечисловым текстом (сейчас принимается любой непустой текст — W6)
**Then** мягкая валидация: переспрос с подсказкой формата; повторный тот же ответ принимается как есть (не блокирует — данные бывают «70% → 90%», «нет данных»)

**Given** механика 7.3 (persist/restore, `/skip`, `/confirm`, `/resume`)
**When** группировка и валидация внедрены
**Then** persist-схема сессии совместима или мигрирует безопасно; рестарт восстанавливает позицию; регресс 7.3 и весь vitest зелёные

## Epic 9: Фидбэк пилота v2 (WP-39 Ф2)

> Добавлен 2026-07-09 (correct-course по аудио-фидбэку пилота после живого прогона; sprint-change-proposal-2026-07-09-pilot-feedback-v2.md — там же evidence-лог прогона и инвентаризация CR-5). Формат stories — лёгкий (solo MVP): 3 AC, ~5 задач, ~80 строк story doc, 1 проход ревью. **Порядок выполнения: 9.1 → 9.2 → 9.3 → 9.7 → 9.4 → 9.5 → 9.6** (9.7 — недельный отчёт, добавлен решением Тимура 2026-07-09 «более ценно, чем пер-встречный /report»; выполняется до онбординг-путей — ценность для уже живого цикла Geonline, от записки не зависит). Дизайн-записка design-onboarding-unified-entry-2026-07-09.md **УТВЕРЖДЕНА Тимуром 2026-07-09** (4 ответа в шапке записки: вопросник из материалов Vault → docs/onboarding-questionnaire-v1.0.md; голос и в профиле + подсказка про голос/документы; презентации — в путь «документы», без «маски импорта»; лимит 5 мин + подтверждение — ок).

**Цель:** Онбординг и ежедневный вход трекера доведены до самостоятельной работы Азизы с реальными клиентами: обязательный профиль клиента как единственный источник имён/названий для всех артефактов, очевидный стартовый flow действующего трекера, три способа завести стратегию (импорт Excel, вопросник с голосом, документы — включая презентации) со сходимостью к одному артефакту, недельный отчёт по всем встречам клиента, ссылки вместо остаточных полотен. Якорь: Азиза самостоятельно онбордит 2 пилотных клиентов через бота.

**FRs (новые):**
- FR104 [MVP]: Онбординг нового клиента начинается с обязательного шага «Профиль клиента» — критический минимум 🔑 (название компании, суть бизнеса, топы-участники: должность/полномочия/зона ответственности, decision maker), без которого таблица трекинга не создаётся; расширенный профиль (история/партнёры, финансовая Точка А вкл. выручку/прибыльность/численность, оргструктура файлом, запрос и желаемые показатели) — опционально, предлагается после минимума и доступен позже; онбординг стратегии — только после 🔑-минимума
- FR105 [MVP]: Профиль клиента — единственный источник имён и названий для ВСЕХ генерируемых артефактов (Sheets, черновики, отчёты): название компании в заголовках, персональные листы по реальным топам профиля, распределение KR по заявленным зонам ответственности; LLM-обработка сырых документов grounded профилем, атрибуция реплик неразмеченных транскриптов — по списку участников
- FR106 [MVP]: Стартовый flow действующего трекера: из `/start` сразу видны клиенты, выбор клиента ведёт к явным действиям продолжения работы; `/help` показывает меню
- FR107 [MVP]: Единая точка входа «выбери способ» с тремя путями: импорт Excel (без LLM), вопросник, документы; путь «документы» принимает презентации (PPTX/PDF) в дополнение к текущим форматам; xlsx-маппинг устойчив к реальным файлам практики
- FR108 [MVP]: Вопросник — третий способ онбординга: бот собирает стратегию из ответов на вопросы (направления → KR «с X до Y» → ответственный из топов профиля → гипотезы по принципу «вопрос → верифицируемая гипотеза»); формулировки — по вопроснику docs/onboarding-questionnaire-v1.0.md
- FR109 [MVP]: Бот принимает голосовые сообщения Telegram как ответы в онбординге (вопросник, профиль, дозаполнение): распознавание через существующую транскрипцию проекта, подтверждение текста трекером, тот же конвейер, что печатный ответ; в диалогах — подсказка, что можно отвечать голосом и загружать документы
- FR110 [MVP]: Остаточные длинные выдачи заменены компактными сообщениями со ссылкой на артефакт (предупреждения `/confirm`, кнопка «Подробнее»)
- FR111 [MVP]: Недельный отчёт трекера по клиенту: агрегат по ВСЕМ обработанным встречам компании за неделю (прогресс KR, коммитменты, паттерны) — не замена пер-встречного /report, а надстройка над его результатами; доставка компактно со ссылкой (паттерн 8.3)

**Инварианты Epic 7 (1–4) действуют без изменений.** Регресс-guardrail всего эпика: `clientId === 'geonline'` fallback, `GEONLINE_F0_SHEET_ID` и полный F1-цикл Geonline (canary + golden dataset + весь vitest + tsc) остаются зелёными после каждой story; боевая таблица Geonline не затрагивается.

**Вне scope:** голос в F1-трекинг-цикле (есть `/report`), кодовый парсер структуры PPTX-слайдов, перенос оформления презентаций, диаризация голосовых ответов трекера, QC-скоринг, веб-дашборд.

### Story 9.1: [CR-3] Профиль клиента — обязательный первый шаг онбординга

As a **коуч практики (Азиза)**,
I want **чтобы онбординг нового клиента начинался со сбора базовой информации о клиенте**,
So that **субъекты трекинга и фактура компании зафиксированы до работы со стратегией и не выдумываются потом**.

**Acceptance Criteria:**

**Given** команда `/newclient` (сейчас онбординг стартует сразу с выбора способа/документов)
**When** трекер начинает онбординг
**Then** первым идёт обязательный диалог «Профиль клиента» по Части A вопросника docs/onboarding-questionnaire-v1.0.md в два уровня: критический минимум 🔑 (A1.1 название, A1.2 суть бизнеса, A3.2 топы: имя/должность/полномочия/зона, A3.3 decision maker) — обязателен, без него способ онбординга стратегии не предлагается; расширенный профиль (история/партнёры A1.3–A1.4, цифры Точки А A2, оргструктура файлом A3.1, запрос и ожидания A4) — опционально после минимума, доступен и позже из карточки клиента

**Given** собранный профиль
**When** профиль завершён
**Then** данные сохранены в расширенной `ClientCard` (`src/f0-client-card.ts` + схема в `src/types.ts`: financials start/target, request, headcount, orgStructure, tops с должностью/полномочиями/зоной) и в персисте сессии (новая фаза `profile`); `/status` и карточка клиента показывают профиль; рестарт бота восстанавливает диалог профиля с текущего вопроса

**Given** активные и старые сессии онбординга (в т.ч. прод-сессии до 9.1)
**When** схема сессии расширена
**Then** новые поля optional в zod (паттерн 8.5/8.6) — существующие сессии восстанавливаются без миграции; весь vitest + tsc + canary зелёные, geonline-guardrail не тронут

### Story 9.2: [CR-3+CR-4в] Grounding — профиль клиента как единственный источник имён и названий

As a **коуч практики (Азиза)**,
I want **чтобы все генерируемые артефакты использовали имена и названия из профиля клиента**,
So that **клиент видит в таблице и отчётах СВОИ имена и название компании, а не ASR-искажения, шаблонные заглушки или выдумки LLM**.

**Acceptance Criteria:**

**Given** профиль клиента (9.1) и создание Google Sheets по `/confirm`
**When** таблица стратегии формируется
**Then** название компании из профиля — в заголовках таблицы; персональные листы «👤 {Имя}» создаются по реальным топам ИЗ ПРОФИЛЯ (не из ASR-распознавания и не из шаблона); распределение KR по владельцам сверяется с заявленными зонами ответственности (несовпадение → 🔴/вопрос дозаполнения, не молчаливая замена)

**Given** LLM-синтез из сырых документов (путь Epic 7) и профиль клиента
**When** документы, особенно транскрипты, обрабатываются
**Then** промпт экстракции получает grounding-контекст профиля (имена/фамилии участников, название компании, должности); транскрипт без разметки говорящих атрибутируется по списку участников профиля; в черновике и артефактах — правильные имена из профиля, а не искажённые ASR-варианты и не выдуманные

**Given** существующий путь без профиля (прод-сессии, начатые до 9.1) и регресс Geonline
**When** grounding внедрён
**Then** сессии без профиля работают как раньше (grounding опционален в коде, обязателен для новых онбордингов); canary + golden + весь vitest зелёные

### Story 9.3: [CR-2] Стартовый flow действующего трекера

As a **трекер, уже работающий с ботом (Азиза)**,
I want **из `/start` сразу видеть своих клиентов и продолжать работу по выбранному**,
So that **ежедневный вход не требует помнить команды и искать функции за кнопками**.

**Acceptance Criteria:**

**Given** `/start` трекера, у которого есть клиенты в реестре (сейчас клиенты — за кнопкой «Клиенты», а welcome — ~22 строки текста; evidence-лог прогона 2026-07-09 — proposal §6)
**When** трекер открывает бота
**Then** welcome короткий (3–5 строк), и клиенты из реестра видны сразу — кнопками в стартовом сообщении (не за промежуточным кликом); «Онбординг нового клиента» и «Что умеет бот» сохранены; при пустом реестре — текущее поведение

**Given** выбор клиента (карточка + «работать с этим клиентом»)
**When** трекер выбрал активного клиента
**Then** бот показывает явные следующие действия по клиенту (отчёт по встрече / статус / таблица — кнопками), а `/report` без URL отвечает подсказкой в контексте активного клиента, а не общим `missing_arg`; произвольный текст после выбора клиента ведёт к контекстной подсказке, не к общему fallback

**Given** `/help` (сейчас отдаёт welcome-текст БЕЗ кнопок меню — bot.ts:885)
**When** трекер зовёт справку
**Then** `/help` показывает то же меню, что `/start`; полная справка команд — за кнопкой «Что умеет бот»; регресс (vitest + tsc + canary) зелёный

### Story 9.4: [CR-4а] Единая точка входа + презентации в пути «документы» + робастный xlsx

> Дизайн-записка утверждена 2026-07-09; решение §7.3 — презентации идут в путь «документы» (честное имя, без «маски импорта»).

As a **коуч практики (Азиза)**,
I want **выбрать один из трёх способов завести стратегию, включая презентацию как документ**,
So that **онбординг работает с теми артефактами, которые реально есть у клиента**.

**Acceptance Criteria:**

**Given** завершённый профиль клиента (9.1)
**When** трекер переходит к стратегии
**Then** показан ОДИН экран «Как заводим стратегию?» с тремя кнопками: импорт готового Excel, вопросник, документы (протоколы/транскрипты/презентации); автодетект по первому файлу сохранён (8.5: `.xlsx` → импорт, остальное → документы); `F0_START_TEXT`-полотно заменено этим экраном; все пути сходятся к одному черновику и общему даунстриму (`deliverF0Draft` → дозаполнение → `/confirm` → Sheets)

**Given** презентация PPTX или PDF в пакете документов
**When** трекер присылает её в пути «документы»
**Then** текст извлечён кодом (pdf-parse / распаковка pptx) и уходит в существующий LLM-синтез с grounding профиля (9.2); для пакета из одной презентации готовой стратегии промпт ужесточён («перенеси, не досочиняй»); результат проходит инварианты 1–2 (🔴 и дозаполнение); нераспознанное показано списком (инвариант 3)

**Given** реальный файл практики `ARB_Solutions_Стратегический_трекер_v1_1_1.xlsx` (отказ `import_unmappable` в прогоне 2026-07-09)
**When** xlsx-импорт доработан
**Then** файл ARB Solutions маппится (словарь синонимов пополнен, файл — в тестах); при отказе импорта бот предлагает конкретный запасной путь; путь синтеза не деградировал (smoke + весь регресс зелёные)

### Story 9.5: [CR-4б+CR-6] Вопросник с голосовыми ответами

> Дизайн-записка утверждена 2026-07-09. Проектируется как одно целое: голос — способ ответа на вопросник. Контент вопросов — docs/onboarding-questionnaire-v1.0.md (создан из материалов Vault практики).

As a **коуч практики (Азиза)**,
I want **собрать стратегию, отвечая на вопросы бота — голосом или текстом**,
So that **клиента без готовых документов можно онбордить с телефона, наговаривая ответы**.

**Acceptance Criteria:**

**Given** выбор «Вопросник» на экране способов (9.4)
**When** трекер проходит вопросник
**Then** бот спрашивает только про стратегию (профиль уже собран): направления → KR «с X до Y к сроку» (валидация чисел 8.6) → ответственный кнопками из топов профиля → гипотезы по принципу «вопрос → верифицируемая гипотеза»; формулировки вопросов — из docs/onboarding-questionnaire-v1.0.md; ответы наполняют тот же черновик, недосказанное штатно уходит в 🔴; механика 7.3 (persist, `/skip`, `/resume`) переиспользована — вопросник переживает рестарт

**Given** голосовое сообщение Telegram как ответ (в вопроснике, в профиле клиента 9.1 и в диалоге дозаполнения)
**When** трекер наговаривает ответ
**Then** аудио распознаётся СУЩЕСТВУЮЩИМ Soniox-адаптером (`src/adapters/soniox.ts`, новая транскрипция не строится); бот показывает распознанный текст на подтверждение («✅ Ок / ✏️ Править / 🎤 Заново») — в артефакты попадает только подтверждённый текст; лимит длительности (5 мин) с понятным сообщением; русский + казахские термины (Soniox валидирован в 0.1); в подсказках этих диалогов явно сказано, что ответить можно голосом 🎤 или документом 📎

**Given** пути импорта и документов (9.4) и весь существующий онбординг
**When** вопросник и голос внедрены
**Then** остальные пути не деградировали; голос вне онбординга (например, в F1-чате) получает вежливый отказ с подсказкой, а не молчание; весь регресс зелёный

### Story 9.6: [CR-5] Ссылки вместо полотен — остаток инвентаризации

> Инвентаризация полная — proposal §7. Welcome закрывает 9.3, `F0_START_TEXT` закрывает 9.4 — здесь только остаток (анти-дубль).

As a **коуч практики (Азиза)**,
I want **вместо оставшихся длинных перечислений получать короткое саммари и ссылку на артефакт**,
So that **любое сообщение бота читается с телефона без прокрутки**.

**Acceptance Criteria:**

**Given** `/confirm` при неполных KR (сейчас — до 10 строк перечисления, bot.ts:2159–2172)
**When** трекер подтверждает онбординг
**Then** вместо перечисления — счётчик «⚠️ N KR стоит дозаполнить» + ссылка на панель таблицы, где полнота видна

**Given** кнопка «🔗 Подробнее» после доставки F1-отчёта (сейчас — заглушка «Скоро доступно», bot.ts:2593)
**When** трекер жмёт кнопку
**Then** открывается ссылка на таблицу клиента/артефакт отчёта — архитектурно готовое место под ссылку задействовано

**Given** инвентаризация proposal §7 и новые тексты Epic 9 (профиль, экран способов, вопросник)
**When** story завершается
**Then** контрольная сверка: ни одна пользовательская выдача не превышает ~15 строк без ссылки на артефакт; чанкер `splitForTelegram` остаётся страховкой, а не нормой; весь регресс зелёный

### Story 9.7: [CR-7] Недельный отчёт трекера по клиенту

> Добавлена 2026-07-09 (запрос Тимура в сессии correct-course): «/report обрабатывает одну встречу, но для целей трекинга Азизе очень важно собирать недельный отчёт по всем встречам по компании за неделю. Это более ценно». Выполняется после 9.3 (см. порядок в шапке). НЕ путать с Epic 4 (F3-lite — сводка ДЛЯ CEO): 9.7 — внутренний инструмент трекера; F3-lite позже сможет строиться на его агрегате.

As a **коуч практики (Азиза)**,
I want **получать недельный отчёт по всем встречам компании за неделю**,
So that **я вижу картину клиента целиком — прогресс KR, коммитменты и паттерны недели, а не отдельные встречи**.

**Acceptance Criteria:**

**Given** обработанные за календарную неделю встречи клиента (персистированные результаты F1: отчёты, коммитменты, обновления KR)
**When** трекер запрашивает недельный отчёт (команда/кнопка в меню клиента из 9.3) с явным указанием недели или «текущая»
**Then** бот собирает агрегат по ВСЕМ встречам недели: сколько встреч и с кем, движение KR за неделю, новые/закрытые/просроченные коммитменты, сквозные паттерны; имена и названия — из профиля клиента (grounding 9.2); пер-встречный `/report` работает как раньше

**Given** доставка недельного отчёта
**When** отчёт готов
**Then** доставка компактная (паттерн 8.3): саммари + счётчики + ссылка на полный артефакт; недели без встреч — честное «встреч не обработано», без выдумывания

**Given** мультиклиентность (несколько клиентов в реестре) и регресс Geonline
**When** недельный отчёт внедрён
**Then** отчёт строится по выбранному/активному клиенту и не смешивает клиентов; canary + golden + весь vitest + tsc зелёные; боевая таблица Geonline не затрагивается

## Epic 10: Разворот к ядру — три отчёта, прощающий онбординг (WP-39 Ф2)

> Добавлен 2026-07-10 (correct-course по двум видео-прохождениям пилота после Эпика 9; sprint-change-proposal-2026-07-10-core-reframe.md — там 24 дефекта D1–D24 с таймкодами, шаблоны отчётов из geonline). Формат stories — лёгкий (solo MVP): 3 AC, ~5 задач, 1 проход ревью. **Порядок: 10.1 → 10.2 → 10.3 → 10.4 → 10.5 → 10.6 → 10.7.** Утверждён Тимуром 2026-07-10 (топы/decision-maker → `/advanced`, код НЕ удаляется). Первоисточник контекста — DS-strategy/inbox/wp-39/ (core-reframe, defects, report-templates).

**Дрифт (признан):** построена система управления клиентами (тяжёлый онбординг), а ядро трекера — **три отчёта** — не работает целиком. Ядро сейчас: (1) отчёт после встречи, (2) **недельный отчёт — ГЛАВНЫЙ результат**, (3) трекер гипотез. 9.7 (недельный) построен, но не питается (аудио встречи не принимается); трекер гипотез не существует. Разворот: прощающий вход + чинить спину отчётов.

**Цель:** трекер даёт три работающих отчёта на реальном клиенте: аудио встречи → недельный отчёт наполняется; новый клиент заводится прощающим входом без обязательного профиля топов; трекер гипотез по шаблону geonline; качество отчётов проверено golden-eval на geonline нед.8/12. Якорь: рабочая версия, которую не стыдно показать (условие оплаты Айдара).

**FRs (новые):**
- FR112 [MVP]: приём записи встречи (аудио/видео/файл/ссылка) для активного клиента → Soniox → существующий F1-конвейер → персист → питает недельный отчёт (9.7); бот определяет входящий файл как встречу и клиента.
- FR113 [MVP]: прощающий онбординг — 🔑-минимум сужен до названия + сути бизнеса; топы/decision-maker/расширенный профиль (9.1) → команда `/advanced` (код сохранён, из основного потока убран); недостающее — в таблице, не допрос в чате.
- FR114 [MVP]: grounding (9.2) флагует смешение (имя профиля ≠ сущности документов → 🔴/вопрос, не молчаливая сборка по документу).
- FR115 [MVP]: xlsx-импорт (9.4) принимает реальный файл «ARB Solutions Стратегический трекер v1.1 (1).xlsx» (синонимы пополнены, файл в тесты); при отказе — конкретный запасной путь.
- FR116 [MVP]: трекер гипотез — третий тип отчёта (гипотезы по департаментам/OKR, обновления статусов прошлая→эта неделя + новые + сводка + выводы, шаблон geonline нед.12); строится как «прошлая неделя + дельта» (снимок гипотез + номер недели в персисте клиента).
- FR117 [MVP]: golden-eval — недельный отчёт (9.7) и трекер гипотез (FR116) прогоняются на входах geonline нед.8/12 и сравниваются с эталонами практики (критерий приёмки качества структуры/полноты).
- FR118 [MVP]: косметика — маркер активного клиента; приветствие/название; сокращение имён листов Sheets; устранение `/start`-дублей, залипшего стейта, повторяющегося футера, противоречивых маркеров, «Скоро» в help.

**Инварианты Epic 7 (1–4) без изменений.** Регресс-guardrail всего эпика: `clientId === 'geonline'` fallback, `GEONLINE_F0_SHEET_ID`, полный F1-цикл Geonline (canary + golden + весь vitest + tsc) зелёные после каждой story; боевая таблица Geonline не затрагивается. **Отчёты (10.5/10.6) — под присмотром: golden-eval, не «зелёный по тестам».**

### Story 10.1: [D20/D21/D22] Приём аудио встречи существующего клиента → недельный отчёт

As a **коуч практики (Азиза)**,
I want **прислать боту запись встречи по выбранному клиенту и получить её в отчётах**,
So that **недельный отчёт наполняется встречами, а не остаётся пустым «встреч не обработано»**.

**Acceptance Criteria:**

**Given** выбран активный клиент и трекер присылает запись встречи (аудио `.m4a`/`.ogg`, видео, файл-транскрипт или ссылку) — сейчас файл встречи игнорируется/зависает, «Недельный отчёт» → «Встреч за неделю не обработано»
**When** файл поступает в чат клиента
**Then** бот распознаёт вход как встречу активного клиента, транскрибирует существующим Soniox-адаптером (`src/adapters/soniox.ts`), прогоняет существующий F1-конвейер и персистит результат (отчёт/коммитменты/обновления KR) под этим клиентом; клиенты не смешиваются

**Given** обработанная встреча
**When** трекер запрашивает недельный отчёт (9.7)
**Then** встреча учтена в агрегате недели; неделя без встреч по-прежнему даёт честное «встреч не обработано» (9.7 не изменяется по сути, только получает вход)

**Given** мультиклиентность и регресс Geonline
**When** intake встречи внедрён
**Then** пер-встречный `/report` работает как раньше; canary + golden + весь vitest + tsc зелёные; боевая таблица Geonline не затрагивается

### Story 10.2: [реверс 9.1] Прощающий вход клиента; тяжёлый профиль → `/advanced`

As a **коуч практики (Азиза)**,
I want **заводить клиента быстро — прислать что есть, без обязательного допроса про топов**,
So that **онбординг не отпугивает и клиент видит результат за минуты**.

**Acceptance Criteria:**

**Given** `/newclient` (сейчас обязателен профиль: название, суть, топы, decision maker — story 9.1)
**When** трекер начинает онбординг
**Then** 🔑-минимум сужен до названия компании + сути бизнеса; сразу предлагается завести стратегию («пришли, что есть»); топы/decision-maker/расширенный профиль НЕ обязательны

**Given** трекер хочет заполнить топов/полный профиль
**When** вызывает команду/кнопку `/advanced` (в онбординге или позже из карточки клиента)
**Then** запускается сохранённый диалог профиля 9.1 (код не удалён, вынесен); данные пишутся в ту же `ClientCard`

**Given** прод-сессии с уже собранным полным профилем и регресс
**When** вход сделан прощающим
**Then** старые сессии совместимы (поля профиля остаются optional в zod); grounding (9.2) работает и с минимумом, и с полным профилем; весь регресс зелёный

### Story 10.3: [D2] Багфикс grounding — флаг смешения клиентов

As a **коуч практики (Азиза)**,
I want **чтобы бот не собирал OKR не того клиента**,
So that **таблица клиента содержит его стратегию, а не данные из чужих загруженных документов**.

**Acceptance Criteria:**

**Given** имя компании из профиля (например «Рога и копыта») и загруженные документы другой компании (например транскрипты ARB) — сейчас OKR молча собираются по документу
**When** идёт LLM-синтез стратегии
**Then** при расхождении имени профиля с названием/сущностями документов бот показывает 🔴/вопрос трекеру («документы про X, клиент Y — чьи данные берём?»), а не молчаливо собирает по документу

**Given** grounding (9.2) и совпадение имени профиля с документами
**When** расхождения нет
**Then** поведение как раньше (без лишних вопросов)

**Given** регресс Geonline и golden
**When** флаг смешения внедрён
**Then** canary + golden + весь vitest + tsc зелёные

### Story 10.4: [D1] Багфикс xlsx — реальный файл ARB v1.1

As a **коуч практики (Азиза)**,
I want **чтобы импорт принимал реальный трекер клиента в Excel**,
So that **клиент со своим файлом не упирался на первом шаге**.

**Acceptance Criteria:**

**Given** реальный файл «ARB Solutions Стратегический трекер v1.1 (1).xlsx» (отказ `import_unmappable` в прогоне 2026-07-10)
**When** трекер импортирует его
**Then** файл маппится (словарь синонимов заголовков пополнен по реальному файлу; файл добавлен в тесты)

**Given** файл, который всё же не маппится
**When** импорт отказывает
**Then** бот предлагает конкретный запасной путь (документы/вопросник), а не тупик

**Given** путь синтеза и регресс
**When** xlsx доработан
**Then** LLM-путь не деградировал; smoke + весь регресс зелёные

### Story 10.5: [НОВОЕ] Трекер гипотез — третий тип отчёта

As a **коуч практики (Азиза)**,
I want **отчёт-трекер гипотез клиента по департаментам**,
So that **видно состояние всех гипотез: что работает, что в тесте, что новое за неделю**.

**Acceptance Criteria:**

**Given** обработанные встречи клиента и снимок гипотез прошлой недели
**When** трекер запрашивает трекер гипотез (команда/кнопка в меню клиента)
**Then** бот собирает отчёт по шаблону geonline нед.12: гипотезы по департаментам/OKR, таблица обновлений статусов (прошлая→эта неделя) + новые гипотезы (статус/запуск/результат/следующий шаг) + сводная таблица по статусам + ключевые выводы; имена/названия — из профиля (grounding 9.2)

**Given** «прошлая неделя + дельта»
**When** отчёт строится
**Then** бот хранит недельный снимок гипотез и номер недели в персисте клиента; первая неделя без базы — полный список без дельты

**Given** мультиклиентность и регресс
**When** трекер гипотез внедрён
**Then** отчёт по выбранному клиенту, клиенты не смешиваются; доставка компактно со ссылкой (8.3); весь регресс зелёный

### Story 10.6: [качество] Golden-eval отчётов

As a **владелец продукта (Тимур)**,
I want **проверять недельный отчёт и трекер гипотез на эталонных входах geonline**,
So that **качество отчёта судится по эталону практики, а не «зелёными тестами»**.

**Acceptance Criteria:**

**Given** входы geonline нед.8/12 (транскрипты встреч + снимок Excel-трекинга) и эталонные отчёты (`Geonline отчет о трекшн неделе 8.md`, `трекер гипотез неделя 12.md`)
**When** запускается golden-eval
**Then** бот генерирует недельный отчёт (9.7) и трекер гипотез (10.5) из этих входов; результат сравнивается с эталоном по структуре/полноте (все секции шаблона присутствуют, ключевые сущности покрыты); отчёт о расхождениях

**Given** eval как критерий приёмки 10.5 и регресс 9.7
**When** eval встроен
**Then** eval-скрипт воспроизводим (`scripts/`), входы — в фикстуры; не трогает боевую таблицу Geonline

**Given** качество ниже порога
**When** eval падает
**Then** понятный отчёт «чего не хватает» для доработки промпта/логики (тесты не судят читаемость — это делает eval)

### Story 10.7: [косметика] Маркер клиента, приветствие, длины, мелочи

As a **коуч практики (Азиза)**,
I want **видеть с кем работаю, чистое приветствие и короткие тексты**,
So that **бот выглядит готовым продуктом**.

**Acceptance Criteria:**

**Given** дефекты D23 (нет маркера активного клиента), D8/D9 (приветствие/название), D14/D24 (длинные имена листов Sheets)
**When** косметика применена
**Then** активный клиент виден постоянно; приветствие и название бота обновлены; имена персональных листов сокращены до имени топа

**Given** мелочи D15–D19 (`/start`-дубли, залипший онбординг-стейт, повторяющийся футер, противоречивые маркеры готовности, «Скоро»-пункты в help)
**When** мелочи закрыты
**Then** повторный `/start` не плодит дубли приветствия; залипший стейт прошлого прогона очищается/предлагается сброс явно; футер не повторяется; маркеры готовности непротиворечивы; «Скоро»-пункты убраны из help клиента

**Given** регресс
**When** косметика завершена
**Then** ни одна пользовательская выдача не длиннее ~15 строк без ссылки; весь регресс зелёный
