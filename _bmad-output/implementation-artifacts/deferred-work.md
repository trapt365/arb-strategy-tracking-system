# Deferred Work

## Deferred from: code review of story-0.1 (2026-04-09)

- Загруженные на Soniox файлы никогда не удаляются (`DELETE /files`) — накапливается storage в аккаунте. Приемлемо для one-shot валидационного скрипта; ручная очистка через console.soniox.com.
- Файл без расширения отвергается как "Неподдерживаемый формат:" — corner case без mime sniffing fallback.
- Нет signal-handler (SIGINT/SIGTERM) и атомарных записей (temp + rename) — для одноразового скрипта приемлемо.
- Hardcoded `language_hints: ["ru","kk"]` без конфигурации — фиксированный scope проекта (RU+KK), не нужно делать настраиваемым.
- `tsconfig` Node16 resolution + `type: module` без явных `.js` extensions в импортах — сейчас работает (нет relative imports), но сломается при future split на модули.

## Deferred from: code review of story-1.2 (2026-04-23)

- `transcriptionId` не удаляется на Soniox при failure после `createTranscription` — нет `DELETE /v1/transcriptions/{id}` API в Soniox (только `DELETE /files`); transcription истекает самостоятельно. Story 1.9 добавит ops-alert при аномальных накоплениях.
- `GOOGLE_SERVICE_ACCOUNT_JSON` lazy validation в `createDriveClient` вместо config-time — intentional deviation, обеспечивает offline/CI-friendly smoke-тесты; Story 1.3 подтвердит поведение при реальном использовании.
- Нет общего 10-мин тайм-аута на весь цикл `pollUntilCompleted` — MVP approximation: 120 × 5s ≈ 10 min; добавить внешний AbortController если polling в продакшне превышает 12 мин (Story 1.9). **Уточнение 2026-04-30:** анализ кода показал worst-case 120 × (5 + 4×9) ≈ 80 мин при долгих 5xx-сериях (каждый poll-attempt в своём `withRetry` с {1,3,9}с backoff). Расхождение с Task 3.6 («10 мин») зафиксировано. Решение: внешний `AbortController` со `startTime`-check ИЛИ счётчик total elapsed → fail на превышении 10 мин. Триггер: Story 1.9.x.

## Deferred from: code review of story-1.2 (2026-04-30, IWE sanity-pass)

- **Soniox streaming upload (OOM-риск на > 218 MB)** — `src/adapters/soniox.ts:148-150` использует `readFile() + new Blob([buffer])` ≈ 2× RAM. На 500 MB файле это ~1 GB в RAM. Story 0.1 review #1 уже фиксировал паттерн; в Story 1.2 принят hard-limit 500 MB + warn > 100 MB как MVP-подход. Триггер: Story 1.9.x ИЛИ материализация OOM в проде на видеофайле > 218 MB. Решение: streaming через `Readable.toWeb()` + Blob-like wrapper или undici fetch с stream-телом.

## Deferred from: code review of story-1.1 (2026-04-21)

- `/health` строгое матчинг URL — `/health?x=1`, `/health/`, `/HEALTH` дают 404. Docker internal probe работает на точном `/health`; внешние probe придут в Story 1.14 (Hostinger VPS deploy).
- `TZ` в Zod схеме — `z.string().default('Asia/Almaty')` без `.refine` через `Intl.DateTimeFormat` — Node молча падает на UTC при невалидной зоне. Hardening, не блокер.
- `GOOGLE_SERVICE_ACCOUNT_JSON` — относительный путь; Zod проверяет только непустую строку, не существование файла. Sheets adapter в Story 1.3 сам упадёт при отсутствии файла — FS-проверка переедет туда.
- `src/config.ts` вызывает `loadConfig()` + `process.exit(1)` на module top-level → любой импортёр не может быть unit-тестирован без реальных env. Тестовая инфраструктура появится в Story 1.11 (canary + golden dataset).
- `startTime = Date.now()` в `src/server.ts` захвачен на import, а не на `listen()`. Для singleton разница невидима.
- AC #5 не имеет явного теста, подтверждающего паттерн `logger.child({pipeline, step, clientId})` — тесты придут со Story 1.11.
