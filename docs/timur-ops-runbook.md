# Ops Runbook — Тимур (admin)

**Для:** Тимур (developer / ops owner)
**Аудитория:** не для трекера; задачи разработчика и админа инфраструктуры.

---

## Story 1.9: настройка ops-логирования и алертов

### 1. Service account — Editor доступ к Google Sheets

Story 1.9 расширила OAuth scope c `spreadsheets.readonly` до `spreadsheets` (read + write).
Чтобы `appendOpsLog` мог писать в `_ops_logs`, service account должен иметь **Editor**
доступ в Google Sheet UI (это настройка прав в Sheets, не код).

Шаги:

1. Открой Google Sheet клиента (URL из `GEONLINE_F0_SHEET_ID`).
2. Меню `Share` (`Настройки доступа`).
3. Добавь email service account (см. `client_email` в `data/google-service-account.json`).
4. Уровень доступа: **Editor**.
5. Сохрани. (`Notify people` можно отключить — служебный аккаунт.)

Проверка: запустить бот в dev и спровоцировать любой `alertOps` (например, отправить
`/report invalid-url` чтобы поймать unauthorized или invalid_url path). После этого
открыть Google Sheet → worksheet `_ops_logs` → должна появиться новая строка.

### 2. Создать worksheet `_ops_logs` с правильными заголовками

Story 1.9 пишет append-only в worksheet `_ops_logs`. Если worksheet отсутствует —
`appendOpsLog` всегда падает (log.warn `ops alert sheets append failed` каждый раз).

Шаги:

1. В том же Google Sheet создай новый worksheet с именем **`_ops_logs`** (snake_case, точно так).
2. Первая строка (header) — ровно 10 колонок, в этом порядке:

   ```
   timestamp | pipeline | step | client_id | duration_ms | status | level | message | error_code | context_json
   ```

   Header обязателен и должен быть в первой строке (worksheet `A1:J1`).
3. Можно зафиксировать строку (`View → Freeze → 1 row`) — удобно для просмотра.
4. Опционально: фильтры по `status` / `level` / `pipeline` — для быстрого триажа.

Никаких validations / data formatting рук не нужно — adapter пишет `valueInputOption: 'RAW'`,
строки строковые, timestamp в ISO8601.

### 3. Конфигурация `OPS_AIDAR_MENTION` (опционально)

`.env`:

```
OPS_AIDAR_MENTION=
```

- Пустая строка (default) — watchdog после 24ч down шлёт repeat alert БЕЗ ping (Айдар не
  получит персонального уведомления, только общий ops-канал увидит сообщение).
- `@aidar_geonline` — после 24ч непрерывного down добавляется одноразовый ping
  (`@aidar_geonline — Тимур может быть недоступен.`). Эскалация одноразовая за инцидент.

Айдар должен быть участником ops-чата `TELEGRAM_CHAT_OPS_ID` чтобы получить упоминание.

### 4. Проверка WORK ≠ OPS на старте

Story 1.9 добавила cross-field validation: `TELEGRAM_CHAT_WORK_ID` и
`TELEGRAM_CHAT_OPS_ID` обязаны различаться. Если они равны — бот падает с понятной
ошибкой при запуске (см. `src/config.ts`, `loadConfig`).

Это защищает Азизу от случайной утечки stack traces из ops-канала в её рабочий чат.

### 5. Watchdog state — `data/.ops-state.json`

Файл создаётся автоматически при первом старте бота:

```json
{
  "lastSuccessAt": "...",
  "lastFailureAt": null,
  "lastFailureReason": null,
  "lastRepeatAlertAt": null,
  "escalatedToAidarAt": null
}
```

- `data/.ops-state.json` — runtime файл, под `.gitignore` (через `data/`).
- На invalid JSON / отсутствие — fallback на initial state (`lastSuccessAt = now`), warn в лог.
- Atomic write: tmp → rename, защищает от partial write при crash.

Сброс watchdog state (например, после ручного восстановления pipeline):

```bash
rm data/.ops-state.json
# при следующем старте — initial state с lastSuccessAt = now
```

Или дождись успешного `bot.report.completed` — он сбрасывает `lastRepeatAlertAt` и
`escalatedToAidarAt` через `recordOpsEvent`.

---

## Что Story 1.9 НЕ делает (см. story file для подробностей)

- Weekly aggregated metrics (`time_to_approve` avg, `f5_response_rate`) — Story 1.12.
- Circuit breaker для Claude — отдельная карточка, Story 1.12.
- Canary test — Story 1.11.
- Email emergency mode — Growth (deferred).
- F4 watchdog (повестка к 9:30) — Epic 3.

См. `_bmad-output/implementation-artifacts/deferred-work.md` для текущего списка.

---

## Offboarding клиента (Story 1.10, NFR8: < 1ч)

Полное удаление данных клиента из `data/{slug}/`. Sheets / Telegram side требуют
manual review — скрипт печатает чеклист.

1. **Pre-flight:** убедиться, что клиент уведомлён и согласовал deletion (legal/GDPR).
2. **Dry-run:** `npx tsx scripts/offboard-client.ts --client-id <id>` — печатает план
   (файлы, bytes, by extension) без изменений.
3. **Verify:** счётчики соответствуют ожиданиям (нет аномального переразмера).
4. **Confirm:** `npx tsx scripts/offboard-client.ts --client-id <id> --confirm` —
   удаляет `data/{slug}/`. Не трогает `data/.ops-state.json`,
   `data/.scheduler-state.json`, `data/.backups/`.
5. **Manual TODO** (печатается скриптом):
   1. Revoke service-account access к Sheets (Share → remove).
   2. Archive / filter `_ops_logs` rows for clientId через Sheet UI.
   3. Remove client chat IDs из `TELEGRAM_TRACKER_CHAT_IDS`.
   4. Удалить OAuth/API tokens из secret manager.
   5. Запись deletion в журнал (compliance).
6. **Verify:** `ls data/<slug>` → no such directory.

SLA: full deletion < 1 час (NFR8).

---

## Restore from backup (Story 1.10)

Бэкапы в `data/.backups/data-backup-YYYY-MM-DD.tar.gz` (последние 7 дней).

```bash
mkdir -p data/restore
tar -xzf data/.backups/data-backup-2026-05-22.tar.gz -C data/restore/
# Inspect data/restore/geonline/ before merging back to data/.
```

Внимание: tar НЕ содержит `*.raw.txt` (excluded). Только финальные `*.json` и
`approvals.jsonl`.

---

## Scheduler hours (Story 1.10)

In-process scheduler (setInterval, без `node-cron` — заменится в Story 3.0):

- **03:00 Asia/Almaty** — daily cleanup `*.raw.txt` старше 14 дней.
- **04:00 Asia/Almaty** — daily tar backup `data-backup-{date}.tar.gz`,
  retain последние 7 файлов.
- Состояние: `data/.scheduler-state.json` (`lastCleanupAt`, `lastBackupAt`,
  atomic writeFile + rename).
- Ошибки эскалируются через `alertOps` в ops-чат (`scheduler.cleanup_failed` /
  `scheduler.backup_failed`); scheduler НЕ останавливается, следующий tick
  ретраит на следующий день.

Manual run (тест/debug): можно временно установить env `BACKUP_DIR` для
изоляции, и запустить bot/процесс — scheduler сам выполнит pending cleanup /
backup при следующем tick (intervalMs=1ч по умолчанию).
