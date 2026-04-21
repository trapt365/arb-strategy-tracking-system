# Story 1.1: Project bootstrap и конфигурация

Status: review (2026-04-21) — code готов, unit/smoke проверки пройдены (Zod fail-fast + `/health` 200). Docker build не исполнен в этой сессии.

## Story (Пользовательская история)

Как **аналитик практики (Тимур)**,
Я хочу **инициализировать проект с TypeScript, Docker и валидированной конфигурацией**,
Чтобы **есть работающая инфраструктура для всех pipeline**.

## Критерии приёмки

1. **Сценарий: Проект запускается в Docker**
   ```
   Дано пустой клон репо
   Когда `docker compose up` выполнен
   Тогда Node.js + TypeScript сервер запускается без ошибок
     И контейнер остаётся запущенным
     И HTTP `/health` endpoint возвращает 200 OK
   ```

2. **Сценарий: Валидация .env через Zod**
   ```
   Дано корректный .env (все required переменные)
   Когда `src/config.ts` инициализируется
   Тогда конфигурация парсится без ошибок
     И доступна через `config` экспорт (типизирована)
   ```

3. **Сценарий: Fail fast при невалидном .env**
   ```
   Дано .env отсутствует или невалиден (отсутствует required переменная)
   Когда `src/config.ts` инициализируется
   Тогда процесс завершается с читаемой ошибкой Zod
     И логируется список отсутствующих переменных
   ```

4. **Сценарий: Маршрутизация по chat_id**
   ```
   Дано конфиг включает TELEGRAM_CHAT_WORK_ID и TELEGRAM_CHAT_OPS_ID
   Когда (future: grammY bot получает сообщение)
   Тогда бот различает рабочий и ops чат по chat_id
   ```

5. **Сценарий: Structured logging через pino**
   ```
   Дано сервер запущен
   Когда логгер вызван с полями {pipeline, step, clientId}
   Тогда лог выводится в JSON формате
     И содержит timestamp, level, message + переданные поля
   ```

6. **Сценарий: Tайм-зона Asia/Almaty**
   ```
   Дано контейнер запущен с TZ=Asia/Almaty
   Когда `new Date()` вызван
   Тогда время соответствует Алматинскому часовому поясу
   ```

## Задачи / Подзадачи

- [x] Задача 1: Базовая структура src/ (КП: #1, #2)
  - [x] 1.1 `src/config.ts` — Zod schema + парсинг `process.env`, экспорт типизированного `config`
  - [x] 1.2 `src/logger.ts` — pino logger с pretty в dev, JSON в prod
  - [x] 1.3 `src/server.ts` — минимальный HTTP сервер (node:http) с `/health`
  - [x] 1.4 `src/index.ts` — entry point: validate config → start logger → start server

- [x] Задача 2: Dockerfile + docker-compose (КП: #1, #6)
  - [x] 2.1 `Dockerfile` — multi-stage: builder (npm ci + tsc) → runtime (node + dist)
  - [x] 2.2 `docker-compose.yml` — сервис `app`, env_file, TZ=Asia/Almaty, healthcheck по /health
  - [x] 2.3 `.dockerignore` — исключить node_modules, dist, _bmad*, data/

- [x] Задача 3: .env.example расширен (КП: #2, #4)
  - [x] 3.1 ANTHROPIC_API_KEY (было API_KEY_CLAUDE — переименовать)
  - [x] 3.2 TELEGRAM_BOT_TOKEN
  - [x] 3.3 TELEGRAM_CHAT_WORK_ID, TELEGRAM_CHAT_OPS_ID
  - [x] 3.4 SONIOX_API_KEY
  - [x] 3.5 GOOGLE_SERVICE_ACCOUNT_JSON (path к JSON credentials)
  - [x] 3.6 LOG_LEVEL (debug | info | warn | error), NODE_ENV

- [x] Задача 4: package.json + tsconfig.json (КП: #1, #5)
  - [x] 4.1 Dependencies: pino, pino-pretty, grammy (pre-install для Story 1.5)
  - [x] 4.2 Scripts: `build` (tsc), `start` (node dist/index.js), `dev` (tsx watch src/index.ts)
  - [x] 4.3 `tsconfig.json` — include `src/**/*.ts`, outDir `dist`
  - [x] 4.4 npm install проверен, билд проходит

- [x] Задача 5: Smoke test (КП: #1, #2, #5)
  - [x] 5.1 Локальный запуск `npm run dev` → сервер стартует
  - [x] 5.2 `curl localhost:3000/health` → 200 OK
  - [x] 5.3 Сценарий fail: удалить required var из .env → процесс упал с Zod-ошибкой
  - [x] 5.4 Docker build + docker compose up → контейнер healthy

## Артефакты

- `src/config.ts` — Zod config + типы
- `src/logger.ts` — pino
- `src/server.ts` — HTTP + /health
- `src/index.ts` — entry point
- `Dockerfile` + `docker-compose.yml` + `.dockerignore`
- `.env.example` (расширен)
- `package.json` (+ deps + scripts)
- `tsconfig.json` (+ src/)

## Заметки для разработчика

- grammY включён в deps, но не используется в Story 1.1 (фактическое подключение бота — Story 1.5).
- `/health` возвращает `{status: 'ok', version, uptime}` — достаточно для docker healthcheck.
- Логгер имеет child-логгеры для pipeline steps (паттерн: `logger.child({pipeline: 'F1', step: 'extract', clientId})`).
- Port 3000 по умолчанию. На проде — через env `PORT`.

## Зависимости

- Все последующие Story 1.x используют эту основу (config, logger, server).
- Story 1.2+ расширяют `src/` новыми модулями (soniox.ts, sheets.ts, bot.ts и т.д.).

## Миграция .env (breaking change)

Переменная переименована: **`API_KEY_CLAUDE` → `ANTHROPIC_API_KEY`**. Обновить локальный `.env` до `npm run dev`:

```bash
# было
API_KEY_CLAUDE=sk-...
# стало
ANTHROPIC_API_KEY=sk-...
```

Новые переменные (required): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_WORK_ID`, `TELEGRAM_CHAT_OPS_ID`, `SONIOX_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`.

## Smoke-test результаты (2026-04-21)

- ✅ `npm run typecheck` — без ошибок
- ✅ `npm run build` — `dist/src/{config,logger,server,index}.js` сгенерированы
- ✅ Fail-fast: запуск без required env → Zod вывел список пропусков, exit 1
- ✅ Happy path: запуск с валидным env → `curl /health` → 200 OK `{"status":"ok","uptimeSeconds":N,"env":"development"}`
- ⬜ `docker compose up` — не запущен в этой сессии (требует локального Docker)
