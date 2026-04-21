# Deferred Work

## Deferred from: code review of story-0.1 (2026-04-09)

- Загруженные на Soniox файлы никогда не удаляются (`DELETE /files`) — накапливается storage в аккаунте. Приемлемо для one-shot валидационного скрипта; ручная очистка через console.soniox.com.
- Файл без расширения отвергается как "Неподдерживаемый формат:" — corner case без mime sniffing fallback.
- Нет signal-handler (SIGINT/SIGTERM) и атомарных записей (temp + rename) — для одноразового скрипта приемлемо.
- Hardcoded `language_hints: ["ru","kk"]` без конфигурации — фиксированный scope проекта (RU+KK), не нужно делать настраиваемым.
- `tsconfig` Node16 resolution + `type: module` без явных `.js` extensions в импортах — сейчас работает (нет relative imports), но сломается при future split на модули.

## Deferred from: code review of story-1.1 (2026-04-21)

- `/health` строгое матчинг URL — `/health?x=1`, `/health/`, `/HEALTH` дают 404. Docker internal probe работает на точном `/health`; внешние probe придут в Story 1.14 (Hostinger VPS deploy).
- `TZ` в Zod схеме — `z.string().default('Asia/Almaty')` без `.refine` через `Intl.DateTimeFormat` — Node молча падает на UTC при невалидной зоне. Hardening, не блокер.
- `GOOGLE_SERVICE_ACCOUNT_JSON` — относительный путь; Zod проверяет только непустую строку, не существование файла. Sheets adapter в Story 1.3 сам упадёт при отсутствии файла — FS-проверка переедет туда.
- `src/config.ts` вызывает `loadConfig()` + `process.exit(1)` на module top-level → любой импортёр не может быть unit-тестирован без реальных env. Тестовая инфраструктура появится в Story 1.11 (canary + golden dataset).
- `startTime = Date.now()` в `src/server.ts` захвачен на import, а не на `listen()`. Для singleton разница невидима.
- AC #5 не имеет явного теста, подтверждающего паттерн `logger.child({pipeline, step, clientId})` — тесты придут со Story 1.11.
