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

### Review Findings (2026-04-21, code review)

**Блокеры приёмки (должны быть исправлены до `done`):**

- [ ] [Review][Patch] Dockerfile CMD ссылается на `dist/index.js`, но `tsc` с `rootDir: "."` эмитит `dist/src/index.js` — контейнер упадёт MODULE_NOT_FOUND при старте [Dockerfile:23 + tsconfig.json:9 + package.json:6]. Самый чистый фикс: `rootDir: "./src"` + исключить `scripts/**` из `include` (scripts используют tsx напрямую и не требуют компиляции) → `outDir/index.js` унифицирован; обновить `package.json` start → `node dist/index.js`.
- [ ] [Review][Patch] Rename `API_KEY_CLAUDE → ANTHROPIC_API_KEY` не доведён: [scripts/prompt-test.ts:12,32,34,533] всё ещё читает `process.env.API_KEY_CLAUDE`. `npm run prompt:test` с новым `.env` упадёт.
- [ ] [Review][Patch] EADDRINUSE не роняет процесс — `server.on('error')` только логирует, `server.listen()` в index.ts не завершает процесс при фатальной ошибке биндинга [src/index.ts:11-12 + src/server.ts:25-27]. Docker будет бесконечно рестартить healthy-но-неработающий контейнер.
- [ ] [Review][Patch] `TELEGRAM_CHAT_WORK_ID=`/`_OPS_ID=` (пустая строка в .env) коэрсится в `0` и проходит Zod [src/config.ts:12-13]. Fail-fast не срабатывает — Telegram API упадёт только в рантайме. Добавить `.refine(n => n !== 0)` или использовать `z.string().min(1).transform(Number)`.

**Средней важности:**

- [ ] [Review][Patch] SIGINT двойным Ctrl+C заново входит в `shutdown()` — `server.close()` на уже закрывающемся сервере вернёт `ERR_SERVER_NOT_RUNNING` → `process.exit(1)` вместо чистого `0` [src/index.ts:14-27]. Нужен guard-флаг.
- [ ] [Review][Patch] `HEAD /health` возвращает 404 — многие L4/L7 балансировщики используют HEAD по умолчанию [src/server.ts:9]. Разрешить HEAD наравне с GET.
- [ ] [Review][Patch] Docker-compose healthcheck и Dockerfile HEALTHCHECK хардкодят `localhost:3000`, но контейнер читает `config.PORT` из env — при `PORT=8080` healthcheck вечно failed [docker-compose.yml:15-16 + Dockerfile:20-21]. Либо зафиксировать порт внутри контейнера (app всегда 3000, маппинг через compose), либо параметризовать оба места.
- [ ] [Review][Patch] `PORT` принимает значения >65535 [src/config.ts:5] — добавить `.max(65535)`.

**Отложено (не блокирует `done`, но фиксируется в deferred-work):**

- [x] [Review][Defer] `/health?x=1`, `/health/`, `/HEALTH` → 404 [src/server.ts:9] — Docker внутренний probe работает точным путём; внешние probe придут в Epic 1.14 (deploy) — отложено.
- [x] [Review][Defer] `TZ=Foo/Bar` валидный для Zod, но Node молча падает на UTC [src/config.ts:6] — hardening, можно добавить `.refine` с `Intl.DateTimeFormat` позже.
- [x] [Review][Defer] `GOOGLE_SERVICE_ACCOUNT_JSON` — относительный путь, Zod не проверяет существование файла [.env.example:18] — проверка появится в Story 1.3 (sheets adapter) при инициализации клиента.
- [x] [Review][Defer] `config.ts` вызывает `loadConfig()` + `process.exit(1)` на top-level — блокирует unit-тестирование любого импортёра [src/config.ts:33]. Тестовая инфраструктура ещё не развёрнута — вернёмся при Story 1.11 (golden dataset).
- [x] [Review][Defer] `startTime` в server.ts захвачен на import, а не на listen [src/server.ts:4] — для единственного singleton-сервера разница невидима.
- [x] [Review][Defer] AC #5: нет теста подтверждающего паттерн `logger.child({pipeline, step, clientId})` — тесты придут со Story 1.11.

**Не проверено (требует живого Docker):**

- 🟡 AC #1: `docker compose up` → контейнер healthy + `/health` 200 — после фикса CMD path исполнить реальный прогон.
- 🟡 AC #6: `TZ=Asia/Almaty` внутри контейнера даёт Алматинское время — проверяется тем же прогоном (`docker exec tracking-app date`).

**Dismissed (false positives / out of scope):**

- wget в node:22-alpine — подтверждено доступен через BusyBox.
- pino-pretty отсутствует в prod-образе если оператор ставит `NODE_ENV=development` — это явное misuse, не баг.
- scripts/ в tsconfig include но не copy в Docker → после фикса #1 (исключить scripts из include) вопрос исчезает.
