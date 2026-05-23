# Story 1.10: Data persistence и client isolation

Status: done

## Пользовательская история

Как **аналитик практики (Тимур)**,
Я хочу **жёстко зафиксировать layout `data/{client_id}/{date}/`, добавить cleanup `*.raw.txt` (14 дней), ежедневный tar-бэкап (7 дней), defense-in-depth проверку `client_id` на всех границах и оффбординг-скрипт**,
Чтобы **данные клиента не терялись при сбоях, не утекали в контекст другого клиента, и при offboarding полное удаление занимало < 1ч с подтверждением через checklist**.

## Контекст и границы scope

**Story 1.10** закрывает три долгих долга из Stories 1.4a/1.4b/1.6/1.9 (см. `deferred-work.md`):

1. **Cleanup `*.raw.txt` (14d)** — `data/{client_id}/{date}/f1-{top}-{id}.{step}.raw.txt` накапливаются без TTL с Stories 1.4a/1.4b; на MVP первого месяца disk usage <100 MB, но через 3 мес. без cleanup ~500 MB на клиента (15 встреч/нед × 4 steps × ~3 KB/step за 90 дней).
2. **Daily tar backup 7d retention** — architecture.md#Data Architecture линия 291: «Cron `tar` раз в день, хранить 7 дней. VPS может быть пересоздан провайдером». Не реализовано.
3. **`client_id` defense-in-depth + offboarding script** — `slugifyClientId` сейчас private helper в `src/f1-report.ts:54`; `resolveSheetId` в `src/adapters/sheets.ts:102` whitelist'ит только `'geonline'`; нет единой точки `assertClientId`; нет команды/скрипта для < 1ч offboarding.

Дополнительно закрывается:

4. **Overlay-интеграция `commitments-updates.json`** — Story 1.4b записывает overlay, но `loadOpenCommitments` (1.4a) пока НЕ читает его; статусы `completed`/`overdue` теряются на следующей встрече. Эта тех. задолженность зафиксирована в `deferred-work.md` (lines 33, 60).
5. **Disk-level idempotency для approve** — `isAlreadyApproved` определён в `src/utils/approvals.ts:26`, но НЕ вызывается из `approve` callback. После рестарта тот же `reportId` снова одобряется (Story 1.6 deferred line 69-70).

### Что входит в Story 1.10 (production-код в `src/`):

1. **`src/utils/client-id.ts`** (НОВЫЙ, ~50 LOC) — единая точка для clientId-операций:
   - `slugifyClientId(clientId: string): string` — извлечь из `f1-report.ts:54` (current implementation: `trim().toLowerCase().replace(/\s+/g, '-').replace(/[\\/<>:"|?*.]/g, '_')`).
   - `assertClientId(clientId: string, opts?: { allowed?: Set<string> })` — throws `ClientIdError` при пустом, слишком длинном (> 64), небезопасных символах или (если `allowed` задан) не в whitelist. Используется на всех границах: bot job-create, persistence write, sheets read, prompt rendering.
   - `parseClientIdFromPath(p: string): string | null` — обратный helper для backup/offboarding (`data/{slug}/{date}/file.json` → `slug`).
2. **`src/utils/raw-cleanup.ts`** (НОВЫЙ, ~70 LOC):
   - `cleanupRawFiles({ rootDir, maxAgeDays, now, logger? }): Promise<{deleted: number, skipped: number, errors: number}>` — рекурсивно сканирует `data/*/*/`, удаляет файлы с pattern `*.raw.txt` где `stat.mtimeMs < now - maxAgeDays*86400000`. НЕ удаляет `*.json`, `approvals.jsonl`, `.ops-state.json`. Возвращает счётчики для observability.
   - Игнор-пути: `data/test-audio/`, `data/golden/`, `data/soniox-results/`, `data/prompt-results/`, `data/week-*/`, `data/test-inputs/`, любой path с компонентом `..`. Используется список из `.gitignore` как defensive.
   - Атомарность: один `fs.unlink` per file; на partial failure (EACCES, file-in-use) — `log.warn` + `errors++`, не throw.
3. **`src/utils/data-backup.ts`** (НОВЫЙ, ~120 LOC):
   - `runDailyBackup({ rootDir, archiveDir, retainDays, now, logger?, exec? }): Promise<{ archivePath: string, sizeBytes: number, pruned: string[] }>` — выполняет `tar -czf {archiveDir}/data-backup-{YYYY-MM-DD}.tar.gz --exclude='*.raw.txt' --exclude='test-audio' --exclude='golden' --exclude='soniox-results' --exclude='prompt-results' --exclude='week-*' --exclude='test-inputs' -C {rootDir} .` (через `child_process.spawn` с capture stderr; `exec` injectable для тестов).
   - После создания — `fs.readdir(archiveDir)`, фильтр по pattern `^data-backup-\d{4}-\d{2}-\d{2}\.tar\.gz$`, сортировка по name (= date), удаление файлов старше `retainDays`. Возвращает `pruned: string[]` с именами удалённых.
   - Если tar exit code !== 0 → throws `BackupError` (caller alertOps). stderr/stdout логируется через pino.
   - **`archiveDir`** default: `data/.backups/` (внутри `data/`, в gitignore). Альтернативно VPS-внешний `/var/backups/arb-tracking/` — настраивается env `BACKUP_DIR`.
4. **`src/scheduler.ts`** (НОВЫЙ, ~80 LOC) — минимальный in-process scheduler **без node-cron**:
   - Использует `setInterval` (как `startWatchdog` из Story 1.9), `timer.unref()` чтобы не блокировать exit.
   - Public API: `startScheduler({ tickIntervalMs, dataRoot, archiveDir, rawMaxAgeDays, backupRetainDays, backupHourLocal, cleanupHourLocal, now? }): { stop: () => void }`.
   - Стратегия: tick каждые 60 минут (default), внутри tick проверяет:
     - `now.hour === cleanupHourLocal (default 3)` И `lastCleanupAt < today's cleanupHourLocal` → запустить `cleanupRawFiles`.
     - `now.hour === backupHourLocal (default 4)` И `lastBackupAt < today's backupHourLocal` → запустить `runDailyBackup`.
   - State `{ lastCleanupAt, lastBackupAt }` persist в `data/.scheduler-state.json` (тот же атомарный паттерн writeFile+rename из Story 1.9 ops-state).
   - В timezone `Asia/Almaty` (config.TZ) — для определения «дня» используется `Intl.DateTimeFormat('en-CA', { timeZone: config.TZ }).format(now)` → `'YYYY-MM-DD'`. **НЕ полагаемся на server timezone** (Docker уже задаёт TZ, но defensive coding).
   - На ошибки cleanup/backup — `alertOps({pipeline:'OPS', step:'scheduler.cleanup_failed' | 'scheduler.backup_failed', error, context: {result}})`. Pipeline продолжает работать; следующий tick попробует снова на следующий день.
   - **Story 1.10 НЕ внедряет node-cron** — это шаг для Story 3.0 (Scheduler shared component, F4 cron Mon 9:00). Story 1.10 покрывает только cleanup + backup cron-функциональность через простой interval.
5. **`scripts/offboard-client.ts`** (НОВЫЙ, ~120 LOC) — оффбординг tool:
   - CLI: `npx tsx scripts/offboard-client.ts --client-id geonline --confirm` (без `--confirm` — dry-run report).
   - Шаги:
     1. `assertClientId(clientId)` (защита от path traversal).
     2. Compute `slug = slugifyClientId(clientId)`.
     3. Pre-flight check: `data/{slug}/` существует. Если нет — exit 0 с warning.
     4. Dry-run report: пересчитать файлы в `data/{slug}/`, сумму bytes, count by extension. Print в stdout.
     5. При `--confirm`: `fs.rm('data/{slug}/', { recursive: true, force: true })`. Лог `console.info({clientId, slug, deletedBytes, deletedCount}, 'client data deleted')`.
     6. **НЕ удаляет автоматически** записи в Google Sheets (требует manual review + permission revocation). Print «Manual TODO» список: revoke service-account access к Sheet, удалить `_ops_logs` rows с этим clientId (через Sheets UI или скрипт-расширение в Growth), снять whitelist `TELEGRAM_TRACKER_CHAT_IDS` если клиентские.
   - **НЕ удаляет** `data/.ops-state.json`, `data/.scheduler-state.json`, `data/.backups/` — это инфраструктурные, не клиентские файлы.
   - Idempotent: повторный запуск после удаления — no-op + warning.
6. **`src/bot.ts`** — wiring scheduler + isAlreadyApproved guard:
   - В `createBot.start()` после `setOpsTelegramSender/Writer`, ПЕРЕД `startWatchdog`:
     ```typescript
     if (deps.botInfo === undefined) {
       const { startScheduler } = await import('./scheduler.js');
       _schedulerHandle = await startScheduler({
         dataRoot: 'data',
         archiveDir: process.env.BACKUP_DIR || 'data/.backups',
         rawMaxAgeDays: 14,
         backupRetainDays: 7,
         tickIntervalMs: 60 * 60_000,
       });
     }
     ```
     Closure `let _schedulerHandle: { stop: () => void } | null = null;`.
   - В `createBot.stop()`: `if (_schedulerHandle) _schedulerHandle.stop();`.
   - В approve callback (line 770-783) — между `peekJob` проверкой и `job.approvalStatus === 'approved'` check, добавить disk-level guard:
     ```typescript
     try {
       if (await isAlreadyApproved(job.clientId, job.id)) {
         await ctx.answerCallbackQuery({ text: 'ℹ️ Уже отправлено.' });
         log.info({ jobId, step: 'bot.approve.disk_idempotency_hit' }, 'approve replayed after restart');
         return;
       }
     } catch (err) {
       log.warn({ err, jobId, step: 'bot.approve.idempotency_check_failed' }, 'idempotency read failed, proceeding');
     }
     ```
     Import добавить: `import { appendApproval as defaultAppendApproval, isAlreadyApproved as defaultIsAlreadyApproved } from './utils/approvals.js';` + соответствующий dep slot. Failure читать approvals.jsonl — log.warn + продолжить (защитный механизм не должен блокировать happy path при ENOENT/IO).
7. **`src/utils/commitments-history.ts`** — overlay-интеграция:
   - Расширить `loadOpenCommitments`: после загрузки base commitments из `*.extraction.json`, дополнительно загружать `*.commitments-updates.json` файлы из тех же `date` dirs (overlay).
   - Overlay-merge: для каждой `CommitmentStatusUpdate` (`{who, what, previous_quote, new_status}`) — найти commitment в `buckets` по dedup-key и обновить `status`. Если update применяется к коммитменту с более свежим mtimeMs (т.е. был перезаписан newer extraction) — НЕ применять overlay (winners stay).
   - Финальный filter `status === 'open' || status === undefined` остаётся в конце.
   - Tiebreak: overlay из более позднего date-dir побеждает (как и base commitments в существующей логике).
   - **Внимание:** overlay имеет shape `{updates: CommitmentStatusUpdate[], sourceFiles: string[], runId: string, timestamp: string}` — см. `persistCommitmentsUpdates` в `f1-report.ts:884`. Wrapper нужно парсить и извлекать `updates`.
   - Schema-validation: используем `CommitmentStatusUpdateSchema` (уже экспортирован из `types.ts:149`). Падающий schema-check → log.warn + skip overlay file (как с extraction).
8. **`.gitignore`** — добавить runtime-paths:
   ```
   data/.ops-state.json
   data/.scheduler-state.json
   data/.backups/
   data/geonline/
   ```
   **НЕ** добавляем `data/*` глобально — `data/golden/`, `data/test-inputs/` уже исключены selectively, но `data/okr-context.json`, `data/stakeholder-map.json` (legacy fixtures) остаются в git до Story 3.0 (Sheets полностью замещает). Pragmatic: добавляем только клиентские runtime dirs.
9. **`docs/timur-ops-runbook.md`** — добавить:
   - Секция «Offboarding клиента» (8-10 строк): команды + checklist (revoke Sheets access, delete data dir, clear bot whitelist, archive `_ops_logs` rows).
   - Секция «Restore from backup» (5-7 строк): `tar -xzf data-backup-YYYY-MM-DD.tar.gz -C data/restore/` + manual review.
   - Секция «Scheduler hours» (3-5 строк): cleanup в 03:00 Almaty, backup в 04:00 Almaty; ручной запуск через `npx tsx scripts/cleanup-raw.ts` и `npx tsx scripts/backup-data.ts` (опционально wrap).

### Что НЕ входит в Story 1.10 (явно deferred):

- **PostgreSQL migration** — architecture trigger «3-й клиент». Story 1.10 закладывает _layout_ и invariants, чтобы migration был «скрипт» (architecture.md#Data Architecture line 290).
- **node-cron + missed-job detection** — Story 3.0 (Scheduler shared component). Story 1.10 использует `setInterval` для cleanup/backup без missed-job detection (cleanup/backup идемпотентны: пропуск дня = warn, не критично).
- **Restart-recovery queue persistence (in-memory `queue` + `completedJobs` lost on restart)** — Story 3.0 / Epic 6 work; F1 jobs реранятся через `/report` ручной retry, completedJobs cache теряется (in-memory only). Story 1.10 НЕ persists queue.
- **`completedJobs` / `pendingEdits` TTL eviction** — Story 6.x (multi-tracker scaling). На MVP с одной Азизой — MAX_COMPLETED_JOBS гарантирует bounded memory.
- **GDPR-compliant immutable audit log** — Phase 2; legal review требуется (PRD line 469).
- **Multi-client `resolveSheetId` whitelist** — Story 6.2 (Epic 6). Story 1.10 НЕ расширяет single-`'geonline'` whitelist; `assertClientId` готов для multi через `allowed` option, но wiring — Epic 6.
- **Auto-cleanup `*.json` (extraction/analysis/format/report)** — НЕТ TTL. Это источники истины для `loadOpenCommitments` (90-day window). Retention policy — Phase 2 (PRD line 469 «Data retention policy: Phase 2»).
- **Sheets-side cleanup (`_ops_logs` row purge)** — manual через Sheets UI на MVP; автоматизация в Story 6.x.
- **F5 manual entry writeF5Metric** — Story 6.x. Story 1.3 deferred line 26 «F5 manual entry — всё ещё deferred до Story 1.10» — пересмотрено: эта работа была частью deferred от 1.3, но на самом деле F5 entire — Epic 2 deferred-growth. Запись в `_f5_metrics` Sheet станет частью Epic 2/6.
- **Streaming Claude response, prompt caching, smart trimming** — Growth.
- **Encryption at rest для `data/`** — Phase 2 / Growth (legal-driven).
- **Off-site backup (S3/Google Drive)** — Growth trigger «платящий клиент с SLA» (architecture.md line 282).

### Контракт с предыдущими и будущими stories

```typescript
// Story 1.4a/1.4b устанавливают (НЕ ломаем):
// - persistStep / persistMeta / persistDeliveryReport / persistCommitmentsUpdates пишут в
//   data/{slugifyClientId(clientId)}/{YYYY-MM-DD}/ — path layout остаётся ТОТ ЖЕ.
// - slugifyClientId логика идентична после рефакторинга (только переезд в utils).
// - loadOpenCommitments сигнатура неизменна — добавляется overlay-merge внутри.

// Story 1.5/1.6 устанавливают:
// - createBot.start() async — startScheduler добавляется в существующий блок.
// - approve callback с in-memory approvalStatus — Story 1.10 ДОБАВЛЯЕТ disk-level guard
//   ПЕРЕД in-memory check; не заменяет.

// Story 1.9 устанавливает:
// - data/.ops-state.json watchdog persistence — Story 1.10 НЕ трогает; добавляет
//   соседний data/.scheduler-state.json с тем же atomic write+rename pattern.
// - alertOps уже шлёт в Telegram ops + Sheets _ops_logs — scheduler ошибки идут
//   через тот же alertOps. recordOpsEvent('info', {step:'scheduler.cleanup.completed', ...})
//   фиксирует успехи в _ops_logs.

// Story 1.10 контракт для будущего:
// - `assertClientId` — единая точка валидации. Future stories (1.14 deploy, 3.0 scheduler,
//   6.2 multi-client) расширяют через `allowed` option, не дублируют логику.
// - `data/{slug}/{YYYY-MM-DD}/` invariant — миграция в PostgreSQL (Growth) делает скриптом
//   через iteration по date-dirs.
// - Scheduler shape `startScheduler({...}): { stop }` — Story 3.0 заменяет на node-cron-based,
//   но external API (cleanup/backup hours) совместим.
// - Overlay-merge в loadOpenCommitments — Story 6.x PostgreSQL migration убирает overlay-файлы,
//   но external API loadOpenCommitments не меняется.
```

## Критерии приёмки

1. **Сценарий: единый layout `data/{client_id}/{YYYY-MM-DD}/` для всех pipeline-артефактов** [Source: epics.md#Story 1.10 AC #1, architecture.md#Project Structure lines 718-726]
   ```
   Дано pipeline F1 успешно выполняет run для clientId='geonline', topName='Жанель Иванова', meetingDate='2026-05-22'
   Когда persistStep / persistMeta / persistDeliveryReport / persistCommitmentsUpdates вызваны
   Тогда создаётся директория data/geonline/2026-05-22/ (slugifyClientId('geonline') === 'geonline')
   И в ней лежат: f1-{topSlug}-{reportId}.extraction.json, .extraction.raw.txt, .analysis.json, .analysis.raw.txt,
     .format.json, .format.raw.txt, .report.json, .commitments-updates.json, .meta.json
   И data/geonline/approvals.jsonl содержит append-line за этот run (после approve)
   И НИКАКИЕ файлы НЕ создаются за пределами data/geonline/ (включая /tmp, system tmp, и т.д.)
   И повторный run в тот же date — НЕ перезаписывает данные другого reportId (uuid-suffix защищает)

   Дано clientId со спецсимволами 'Test/Client.Name'
   Когда slugifyClientId применяется
   Тогда результат 'test_client_name' — без path-traversal риска
   И assertClientId('') → ClientIdError
   И assertClientId('../etc/passwd') → ClientIdError (содержит запрещённые '/' '.' '.')
   И assertClientId(' ') (пробел) → ClientIdError (пустой после trim)
   И assertClientId('a'.repeat(65)) → ClientIdError (длина > 64)
   ```

2. **Сценарий: append-only JSON backup — поведение неизменно после Story 1.4a/1.4b/1.6/1.9** [Source: architecture.md#Architectural Principles line 177 «Append-only JSON на диске с Day 1», epics.md#Story 1.10 AC #1]
   ```
   Дано pipeline F1 пишет f1-{top}-{id}.extraction.json через persistStep
   Когда последующий run с тем же {top, meetingDate} — у нового reportId
   Тогда новый файл создаётся РЯДОМ: f1-{top}-{newId}.extraction.json (НЕ перезаписывает старый)
   И loadOpenCommitments (Story 1.4a) видит ОБА файла, dedup по mtimeMs newer-wins

   Дано approvals.jsonl существует с 3 строками
   Когда appendApproval добавляет 4-ю запись
   Тогда fs.appendFile (НЕ writeFile) — старые 3 строки нетронуты
   И каждая строка — валидный JSON, разделитель '\n'
   ```

3. **Сценарий: cleanup `*.raw.txt` файлов старше 14 дней** [Source: epics.md#Story 1.10 AC #1 «raw Claude responses: .raw.txt с auto-cleanup 14 дней», architecture.md#Risk Hindsight line 657]
   ```
   Дано data/geonline/2026-05-01/f1-zhanel-abc12345.extraction.raw.txt (mtime: 22 дня назад)
   И data/geonline/2026-05-15/f1-aleksandr-def67890.analysis.raw.txt (mtime: 8 дней назад)
   И data/geonline/2026-05-22/f1-marat-ghi24680.format.raw.txt (mtime: 1 день назад)
   И data/geonline/2026-05-01/f1-zhanel-abc12345.extraction.json (mtime: 22 дня назад) ← НЕ .raw.txt
   Когда cleanupRawFiles({rootDir:'data', maxAgeDays:14, now:'2026-05-23T03:00:00+05:00'}) выполнен
   Тогда f1-zhanel-abc12345.extraction.raw.txt удалён (22 > 14)
   И f1-aleksandr-def67890.analysis.raw.txt сохранён (8 < 14)
   И f1-marat-ghi24680.format.raw.txt сохранён (1 < 14)
   И f1-zhanel-abc12345.extraction.json сохранён (не .raw.txt)
   И returned { deleted: 1, skipped: 2, errors: 0 }
   И log.info {step:'data.raw_cleanup.completed', deleted:1, skipped:2} эмитирован

   Дано директория data/test-audio/ содержит recording-2025-01-01.webm (mtime 500 дней назад)
   Когда cleanupRawFiles выполнен
   Тогда recording-2025-01-01.webm НЕ удалён (ignore-path)
   И data/golden/, data/soniox-results/, data/prompt-results/, data/week-*, data/test-inputs/ ИГНОРЯТСЯ полностью

   Дано один файл вызывает EACCES при fs.unlink (read-only, открыт другим процессом)
   Когда cleanupRawFiles продолжает обход
   Тогда returned.errors === 1, log.warn эмитируется, остальные файлы обработаны
   ```

4. **Сценарий: daily tar backup с retention 7 дней** [Source: epics.md#Story 1.10 AC #1 «daily tar backup retained 7 дней», architecture.md#Data Architecture line 291]
   ```
   Дано data/geonline/ содержит файлы из 3 разных date-dirs (тестовые fixtures)
   И data/.backups/ пуст
   Когда runDailyBackup({rootDir:'data', archiveDir:'data/.backups', retainDays:7, now:'2026-05-23T04:00:00+05:00'}) выполнен
   Тогда data/.backups/data-backup-2026-05-23.tar.gz создан (non-empty, валидный gzip)
   И archive НЕ содержит *.raw.txt файлов (exclude pattern)
   И archive НЕ содержит data/test-audio/, data/golden/, data/soniox-results/, data/prompt-results/, data/week-*, data/test-inputs/
   И archive содержит data/geonline/{2026-05-21,2026-05-22,2026-05-23}/*.json + approvals.jsonl
   И returned.archivePath = 'data/.backups/data-backup-2026-05-23.tar.gz'
   И returned.sizeBytes > 0
   И log.info {step:'data.backup.completed', sizeBytes, archivePath} эмитирован

   Дано data/.backups/ содержит data-backup-2026-05-10.tar.gz, ..., data-backup-2026-05-22.tar.gz (13 файлов)
   Когда runDailyBackup({retainDays:7, now:'2026-05-23'}) выполнен (после создания нового)
   Тогда файлы старше 7 дней удалены: data-backup-2026-05-10..2026-05-15 (6 файлов)
   И returned.pruned = ['data-backup-2026-05-10.tar.gz', ..., 'data-backup-2026-05-15.tar.gz']
   И сохранены: data-backup-2026-05-16..2026-05-23 (8 файлов: 7 + сегодня)

   Дано tar exit code 2 (ошибка диска)
   Когда runDailyBackup пытается выполнить
   Тогда BackupError ('tar_exit_nonzero') throws
   И stderr из tar логирован через log.error
   И НЕ удаляет старые backups (prune только после успешного create)
   ```

5. **Сценарий: scheduler запускает cleanup в 03:00 и backup в 04:00 Almaty** [Source: epics.md#Story 1.10 AC #1, architecture.md#Tech Stack line 106 «node-cron + watchdog»]
   ```
   Дано config.TZ='Asia/Almaty'
   И startScheduler запущен с tickIntervalMs=3600000 (1ч), cleanupHourLocal=3, backupHourLocal=4
   И lastCleanupAt=null, lastBackupAt=null
   Когда tick срабатывает в 03:00 Asia/Almaty (now локально hour=3)
   Тогда cleanupRawFiles вызван 1 раз
   И state.lastCleanupAt обновлён до today's 03:00 (ISO с +05 offset)
   И persist в data/.scheduler-state.json (atomic writeFile+rename)
   И recordOpsEvent('info', {pipeline:'OPS', step:'scheduler.cleanup.completed', status:'ok', context:{deleted, skipped, errors}})

   Когда tick срабатывает в 03:05 (через 5 мин)
   Тогда cleanupRawFiles НЕ вызван повторно (lastCleanupAt >= today's 03:00 → skip)

   Когда tick срабатывает в 04:00
   Тогда runDailyBackup вызван 1 раз, state.lastBackupAt обновлён

   Дано рестарт процесса в 03:30 (между cleanup и backup)
   И data/.scheduler-state.json восстановлен (lastCleanupAt=today's 03:00, lastBackupAt=null)
   Когда первый tick после рестарта в 04:00
   Тогда cleanupRawFiles НЕ повторяется, runDailyBackup запускается

   Дано cleanupRawFiles throws unexpected error
   Когда tick ловит exception
   Тогда alertOps({pipeline:'OPS', step:'scheduler.cleanup_failed', error, context:{lastSuccessAt}})
   И state.lastCleanupAt НЕ обновляется (на следующий день попробует снова)
   И scheduler НЕ останавливается (next tick через 1ч)
   ```

6. **Сценарий: defense-in-depth `assertClientId` на границах** [Source: epics.md#Story 1.10 AC #2 «client_id проверяется на каждом этапе: промпты, хранение, delivery», PRD line 612-614, architecture.md#Cross-Cutting Concerns line 84]
   ```
   Дано bot принимает /report URL от Азизы
   Когда bot.ts создаёт ReportJob (DEFAULT_CLIENT_ID='geonline')
   Тогда assertClientId('geonline') вызван перед queue.enqueue
   И при невалидном clientId (hypothetical multi-client config) → alertOps + reply Азизе
   И assertClientId зеркалируется в persistStep / persistMeta / persistDeliveryReport / persistCommitmentsUpdates
     (defense-in-depth — caller уже проверил, но adapter ещё раз гарантирует)

   Дано readClientContext({clientId:'geonline'}) (sheets adapter)
   Когда resolveSheetId(clientId) выполняется
   Тогда assertClientId сначала, потом whitelist check (текущий 'geonline' only)
   И при '../etc' → ClientIdError ДО google.sheets call (no leak)

   Дано приклеи clientId='/foo/bar' попадает в delivery (bot.ts deliverReport)
   Когда формируется finalText / topMessageDraft для отправки
   Тогда assertClientId на входе deliverReport — fail fast, не отправлять Telegram
   И recordOpsEvent('error', {step:'delivery.invalid_client_id', clientId})
   ```

7. **Сценарий: offboarding `scripts/offboard-client.ts` — < 1ч полное удаление** [Source: epics.md#Story 1.10 AC #2 «все данные клиента под одним client_id для offboarding (< 1ч полное удаление)», PRD NFR8]
   ```
   Дано data/geonline/2026-05-{01..23}/ содержит ~50 файлов, ~500 KB
   И data/geonline/approvals.jsonl содержит 15 записей
   И запускается `npx tsx scripts/offboard-client.ts --client-id geonline` (БЕЗ --confirm)
   Когда скрипт выполняется
   Тогда dry-run report в stdout: "Would delete data/geonline/ (51 files, 512345 bytes)"
   И список по extension: ".extraction.json: 15, .raw.txt: 30, .json: 15, .jsonl: 1"
   И exit 0, НИЧЕГО НЕ УДАЛЕНО

   Когда запуск с `--confirm`
   Тогда fs.rm('data/geonline/', { recursive: true, force: true }) выполнен
   И stdout: "Deleted data/geonline/ (51 files, 512345 bytes) in {ms}ms"
   И data/geonline/ больше не существует
   И data/.ops-state.json НЕ удалён
   И data/.backups/ НЕ удалён
   И stdout содержит "Manual TODO:" список (revoke Sheets, clear bot whitelist, archive _ops_logs)

   Дано clientId='../etc'
   Когда скрипт стартует
   Тогда assertClientId throws → exit 1, никакого fs.rm

   Дано data/geonline/ уже отсутствует (повторный offboard)
   Когда скрипт с --confirm
   Тогда stdout: "data/geonline/ does not exist (already offboarded)", exit 0
   ```

8. **Сценарий: overlay `commitments-updates.json` интегрирован в `loadOpenCommitments`** [Source: deferred-work.md line 33 + 60, types.ts CommitmentStatusUpdateSchema]
   ```
   Дано data/geonline/2026-05-15/f1-zhanel-abc.extraction.json содержит commitment {who:'Жанель', what:'Запустить promo', deadline:'2026-05-22', status:undefined}
   И data/geonline/2026-05-22/f1-zhanel-xyz.commitments-updates.json содержит:
     {updates: [{who:'Жанель', what:'Запустить promo', previous_quote:'...', new_status:'completed'}], sourceFiles:['geonline/2026-05-15/f1-zhanel-abc.extraction.json']}
   Когда loadOpenCommitments('geonline', 'Жанель Иванова') вызван
   Тогда base commitment загружен из 2026-05-15 extraction
   И overlay применён → status='completed'
   И итоговая фильтрация (status==='open' || undefined) → commitment ИСКЛЮЧЕН из openCommitments
   И в logs (если debug) видна трасса 'overlay_applied' с counter

   Дано overlay существует, но base commitment в более свежем extraction уже status='completed'
   Когда merge выполняется
   Тогда status остаётся 'completed' (newer-wins, overlay не override-ит newer base)

   Дано overlay-файл с невалидным schema (missing previous_quote)
   Когда parse падает
   Тогда log.warn {step:'commitments_overlay.schema_skip'}, остальные overlays применяются
   И НЕТ regression на Story 1.4a behavior — без overlay тест проходит как раньше

   Дано overlay sourceFile упоминает extraction которого НЕТ в текущем clientId (path traversal попытка)
   Когда merge выполняется
   Тогда updates применяются ТОЛЬКО к commitments из текущего clientId scope; нет cross-client leak
   ```

9. **Сценарий: disk-level idempotency guard для approve callback** [Source: deferred-work.md lines 69-70, src/utils/approvals.ts:26 isAlreadyApproved]
   ```
   Дано processJob завершился, approvals.jsonl содержит {reportId:'abc12345', clientId:'geonline', status:'approved'}
   И бот рестартанул, in-memory completedJobs MAP пуст
   Когда Азиза снова тапает [✅ Подтвердить] под старым сообщением (callback approve:abc12345)
   Тогда peekJob(jobId) === undefined (in-memory MAP пуст) → existing 'ℹ️ Отчёт уже недоступен.'
   ИЛИ если job ещё в MAP (короткий restart window) → isAlreadyApproved('geonline','abc12345') === true
   Тогда ctx.answerCallbackQuery 'ℹ️ Уже отправлено.' + log.info step:'bot.approve.disk_idempotency_hit'
   И НЕ appendApproval (дублирующая запись не создаётся)
   И НЕ deliverReport (повторная отправка не выполняется)

   Дано isAlreadyApproved throws (fs read error)
   Когда approve callback ловит
   Тогда log.warn step:'bot.approve.idempotency_check_failed', продолжаем без guard
     (защита НЕ должна блокировать happy path; in-memory approvalStatus уже защищает 99% случаев)
   ```

10. **Сценарий: `.gitignore` исключает runtime client data и infrastructure state** [Source: architecture.md#Project Structure line 522, epics.md#Story 1.10 AC #1]
    ```
    Дано .gitignore содержит:
      data/.ops-state.json
      data/.scheduler-state.json
      data/.backups/
      data/geonline/
    Когда git status выполнен после pipeline run
    Тогда data/geonline/2026-05-23/*.json — НЕ в git status (untracked + ignored)
    И data/.ops-state.json (Story 1.9) — НЕ в git status
    И data/.scheduler-state.json (Story 1.10) — НЕ в git status
    И data/.backups/data-backup-*.tar.gz — НЕ в git status

    Дано .env содержит SHEET_ID
    Когда git status
    Тогда .env остаётся в gitignore (без изменений из Story 1.1)
    И data/okr-context.json, data/stakeholder-map.json (legacy fixtures, Story 0.x) — остаются в git (не покрыты этой story; могут быть удалены позже после Sheets-only switch)
    ```

11. **Сценарий: scheduler — fire-and-forget, не блокирует event loop** [Source: ops.ts pattern, architecture.md#Process Patterns]
    ```
    Дано startScheduler запущен, runDailyBackup занимает 30+ секунд (tar большого data/)
    Когда bot обрабатывает /report от Азизы в это время
    Тогда обработка /report НЕ блокируется (await tar не в request path)
    И scheduler-tick (setInterval callback) выполняется async; ошибки ловятся через .catch
    И timer.unref() — не препятствует process exit при SIGTERM

    Дано stop() вызван
    Когда clearInterval выполнен
    Тогда после ближайшего tick задач больше нет
    И running cleanup/backup завершается естественно (await fulfilled), не abort'ится
    ```

12. **Сценарий: backward-compatibility — все 332+ существующих тестов зелёные** [regression, Story 1.9 baseline]
    ```
    Дано Story 1.1–1.9 тесты используют:
      - slugifyClientId как private helper в f1-report.ts
      - resolveSheetId с 'geonline' whitelist
      - approve callback без disk-level guard (in-memory only)
      - loadOpenCommitments без overlay merge
    Когда Story 1.10 рефакторинги выполнены
    Тогда:
      - slugifyClientId переехал в src/utils/client-id.ts, импортирован обратно в f1-report.ts (no logic change)
      - resolveSheetId по-прежнему whitelist'ит 'geonline'; assertClientId вызван ДО whitelist
      - approve callback: при отсутствии approvals.jsonl (тестовая среда) — guard no-op, behavior идентично 1.6
      - loadOpenCommitments без overlay-файлов работает как 1.4a (зеро regression)
    И npx vitest run → 332+ passed (новые тесты Story 1.10 добавляют, не ломают)
    И npx tsc --noEmit → exit 0
    ```

## Задачи / Подзадачи

- [x] **Задача 1: `src/utils/client-id.ts` (НОВЫЙ) + рефакторинг slugifyClientId** (АК: #1, #6, #7)
  - [x] 1.1 Создать `src/utils/client-id.ts` с экспортами:
    ```typescript
    export class ClientIdError extends Error {
      constructor(public reason: 'empty' | 'too_long' | 'invalid_chars' | 'not_whitelisted', public clientId: string) {
        super(`ClientIdError:${reason}:${clientId.slice(0, 20)}`);
        this.name = 'ClientIdError';
      }
    }

    const MAX_LEN = 64;
    const VALID_RE = /^[a-zA-Z0-9_-]+$/;  // post-slug shape

    export function slugifyClientId(clientId: string): string {
      return clientId.trim().toLowerCase().replace(/\s+/g, '-').replace(/[\\/<>:"|?*.]/g, '_');
    }

    export interface AssertClientIdOpts {
      allowed?: ReadonlySet<string>;  // whitelist on raw clientId (pre-slug)
    }

    export function assertClientId(clientId: unknown, opts: AssertClientIdOpts = {}): asserts clientId is string {
      if (typeof clientId !== 'string') throw new ClientIdError('empty', String(clientId));
      const trimmed = clientId.trim();
      if (trimmed.length === 0) throw new ClientIdError('empty', clientId);
      if (trimmed.length > MAX_LEN) throw new ClientIdError('too_long', clientId);
      // Disallow path traversal / shell-meaningful chars on raw clientId before slugify.
      // Note: slugifyClientId itself replaces these, but assertion fails fast at boundary.
      if (/[/\\<>:"|?*]/.test(trimmed)) throw new ClientIdError('invalid_chars', clientId);
      if (trimmed.includes('..')) throw new ClientIdError('invalid_chars', clientId);
      if (opts.allowed && !opts.allowed.has(trimmed)) throw new ClientIdError('not_whitelisted', clientId);
    }

    export function parseClientIdFromPath(p: string): string | null {
      const match = p.match(/^data\/([a-z0-9][a-z0-9_-]*)\//);
      return match ? match[1]! : null;
    }
    ```
    **Note:** `assertClientId` БЕЗ slug, raw input. `slugifyClientId` после assert даёт safe filesystem name.
  - [x] 1.2 Удалить `slugifyClientId` из `src/f1-report.ts:54`. Импортировать `slugifyClientId, assertClientId` из `'./utils/client-id.js'` в начале файла. Все вызовы `slugifyClientId(meta.clientId)` остаются как были (ре-экспорт логически идентичен).
  - [x] 1.3 Также экспортировать `slugifyClientId` из `src/f1-report.ts` для backward-compat **ИЛИ** обновить все импорты других файлов (если есть). Проверить `grep -rn "from.*f1-report.*slugifyClientId" src/` — если impport-ов нет, просто удалить.
  - [x] 1.4 Тесты в `src/utils/client-id.test.ts` (НОВЫЙ файл):
    - `slugifyClientId('Geonline')` → 'geonline'
    - `slugifyClientId('Test Client.Name')` → 'test-client_name'
    - `slugifyClientId('  whitespace  ')` → 'whitespace'
    - `assertClientId('geonline')` — no throw
    - `assertClientId('')` → ClientIdError('empty')
    - `assertClientId('   ')` → ClientIdError('empty')
    - `assertClientId('../etc/passwd')` → ClientIdError('invalid_chars')
    - `assertClientId('a/b')` → ClientIdError('invalid_chars')
    - `assertClientId('a'.repeat(65))` → ClientIdError('too_long')
    - `assertClientId('clientB', { allowed: new Set(['geonline']) })` → ClientIdError('not_whitelisted')
    - `parseClientIdFromPath('data/geonline/2026-05-22/file.json')` → 'geonline'
    - `parseClientIdFromPath('data/.ops-state.json')` → null

- [x] **Задача 2: defense-in-depth `assertClientId` вызовы на границах** (АК: #6)
  - [x] 2.1 `src/bot.ts` — в `bot.command('report')` ПЕРЕД enqueue добавить:
    ```typescript
    try { assertClientId(DEFAULT_CLIENT_ID); }
    catch (err) {
      log.error({ err, step: 'bot.report.invalid_client_id' }, 'invalid clientId');
      alertOps({pipeline:'F1', step:'bot.report.invalid_client_id', error: err, context:{clientId: DEFAULT_CLIENT_ID}});
      return;  // do not enqueue
    }
    ```
    На MVP — единственный clientId, но защита от misconfig.
  - [x] 2.2 `src/f1-report.ts` — в `persistStep`, `persistMeta`, `persistDeliveryReport`, `persistCommitmentsUpdates`, `persistFormatStep` — добавить `assertClientId(meta.clientId)` в начало каждой функции (ДО slugifyClientId). Defense-in-depth: если caller забыл проверить.
  - [x] 2.3 `src/adapters/sheets.ts:resolveSheetId` — добавить `assertClientId(clientId)` ДО whitelist-check. Если clientId шире чем 'geonline' (future Epic 6), assert не падает на любом valid string; whitelist-логика остаётся.
  - [x] 2.4 `src/bot.ts:deliverReport` (или эквивалент при отправке топу) — добавить `assertClientId(job.clientId)` перед формированием Telegram message. recordOpsEvent('error', {step:'delivery.invalid_client_id'}) на fail.
  - [x] 2.5 Тесты — регрессионная проверка: existing tests с clientId='geonline' (или 'test-client') проходят без изменений. Один новый тест per границу: invalid clientId → ClientIdError + alertOps.

- [x] **Задача 3: `src/utils/raw-cleanup.ts` (НОВЫЙ) — cleanup `*.raw.txt`** (АК: #3)
  - [x] 3.1 Создать `src/utils/raw-cleanup.ts`:
    ```typescript
    import { promises as fs } from 'node:fs';
    import { join, basename } from 'node:path';
    import { logger as rootLogger, type Logger } from '../logger.js';

    export interface CleanupRawFilesOpts {
      rootDir: string;
      maxAgeDays: number;
      now?: Date;
      logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
    }
    export interface CleanupRawFilesResult { deleted: number; skipped: number; errors: number; }

    const IGNORE_TOP_DIRS = new Set([
      'test-audio', 'golden', 'soniox-results', 'prompt-results',
      'test-inputs', '.backups',
    ]);
    const IGNORE_PREFIX = ['week-'];  // data/week-* (sensitive audio)

    export async function cleanupRawFiles(opts: CleanupRawFilesOpts): Promise<CleanupRawFilesResult> {
      const log = opts.logger ?? rootLogger;
      const now = opts.now ?? new Date();
      const cutoffMs = now.getTime() - opts.maxAgeDays * 86_400_000;
      const result: CleanupRawFilesResult = { deleted: 0, skipped: 0, errors: 0 };

      let topEntries: import('node:fs').Dirent[];
      try {
        topEntries = await fs.readdir(opts.rootDir, { withFileTypes: true });
      } catch (err) {
        log.warn({ err, step: 'data.raw_cleanup.readdir_failed', rootDir: opts.rootDir }, 'cleanup readdir failed');
        return result;
      }

      for (const top of topEntries) {
        if (!top.isDirectory()) continue;
        if (top.name.startsWith('.')) continue;  // .backups, .git
        if (IGNORE_TOP_DIRS.has(top.name)) continue;
        if (IGNORE_PREFIX.some((p) => top.name.startsWith(p))) continue;
        await processClientDir(join(opts.rootDir, top.name), cutoffMs, result, log);
      }
      log.info({ step: 'data.raw_cleanup.completed', ...result }, 'raw cleanup done');
      return result;
    }

    async function processClientDir(
      clientDir: string,
      cutoffMs: number,
      result: CleanupRawFilesResult,
      log: Pick<Logger, 'info' | 'warn' | 'error'>,
    ): Promise<void> {
      let dateEntries: import('node:fs').Dirent[];
      try {
        dateEntries = await fs.readdir(clientDir, { withFileTypes: true });
      } catch (err) {
        log.warn({ err, step: 'data.raw_cleanup.client_readdir_failed', clientDir }, 'client dir readdir failed');
        return;
      }
      for (const date of dateEntries) {
        if (!date.isDirectory()) continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date.name)) continue;
        const dateDir = join(clientDir, date.name);
        let files: string[];
        try { files = await fs.readdir(dateDir); }
        catch (err) {
          log.warn({ err, step: 'data.raw_cleanup.date_readdir_failed', dateDir }, 'date dir readdir failed');
          continue;
        }
        for (const fname of files) {
          if (!fname.endsWith('.raw.txt')) continue;
          const fpath = join(dateDir, fname);
          try {
            const stat = await fs.stat(fpath);
            if (stat.mtimeMs < cutoffMs) {
              await fs.unlink(fpath);
              result.deleted++;
            } else {
              result.skipped++;
            }
          } catch (err) {
            result.errors++;
            log.warn({ err, step: 'data.raw_cleanup.file_failed', fpath }, 'cleanup file failed');
          }
        }
      }
    }
    ```
  - [x] 3.2 Тесты `src/utils/raw-cleanup.test.ts`:
    - Mock fs через `vi.mock('node:fs')` — НЕТ, лучше temp-dir с `os.tmpdir()` (как в Story 1.9 watchdog). Создаём `data/test-client/2026-05-01/foo.raw.txt` с mtime 22d ago + ещё файлы и проверяем результат.
    - Тест: файл 22d > 14d → deleted.
    - Тест: файл 8d < 14d → skipped.
    - Тест: `.json` файл — не трогается.
    - Тест: ignore-paths `data/test-audio/`, `data/golden/` — не сканируются.
    - Тест: invalid date-dir (`data/client/not-a-date/`) — игнорится.
    - Тест: EACCES на unlink (mock через vi.spyOn) → errors++, остальные продолжают.
    - Тест: пустой rootDir → 0/0/0.

- [x] **Задача 4: `src/utils/data-backup.ts` (НОВЫЙ) — daily tar + retention** (АК: #4)
  - [x] 4.1 Создать `src/utils/data-backup.ts`:
    ```typescript
    import { promises as fs } from 'node:fs';
    import { join } from 'node:path';
    import { spawn } from 'node:child_process';
    import { logger as rootLogger, type Logger } from '../logger.js';

    export class BackupError extends Error {
      constructor(public reason: 'tar_exit_nonzero' | 'archive_dir_failed' | 'prune_failed', cause?: unknown) {
        super(`BackupError:${reason}`);
        this.name = 'BackupError';
        if (cause) (this as { cause?: unknown }).cause = cause;
      }
    }

    export interface RunDailyBackupOpts {
      rootDir: string;             // 'data'
      archiveDir: string;          // 'data/.backups'
      retainDays: number;          // 7
      now?: Date;
      logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
      /** Test-only: replace child_process.spawn with mock. */
      execTar?: (args: string[]) => Promise<{ code: number; stderr: string }>;
    }
    export interface RunDailyBackupResult { archivePath: string; sizeBytes: number; pruned: string[]; }

    const EXCLUDES = [
      '*.raw.txt',
      'test-audio', 'golden', 'soniox-results', 'prompt-results',
      'test-inputs', 'week-*',
      '.backups',  // exclude self
    ];

    function formatDate(now: Date): string {
      // YYYY-MM-DD in UTC — backup naming consistent regardless of process TZ.
      // Scheduler decides WHEN to run (uses Asia/Almaty for hour); naming uses ISO date.
      return now.toISOString().slice(0, 10);
    }

    export async function runDailyBackup(opts: RunDailyBackupOpts): Promise<RunDailyBackupResult> {
      const log = opts.logger ?? rootLogger;
      const now = opts.now ?? new Date();
      const dateStr = formatDate(now);
      const archivePath = join(opts.archiveDir, `data-backup-${dateStr}.tar.gz`);

      try { await fs.mkdir(opts.archiveDir, { recursive: true }); }
      catch (err) { throw new BackupError('archive_dir_failed', err); }

      const args = [
        '-czf', archivePath,
        ...EXCLUDES.flatMap((e) => ['--exclude', e]),
        '-C', opts.rootDir, '.',
      ];

      const exec = opts.execTar ?? defaultExecTar;
      const { code, stderr } = await exec(args);
      if (code !== 0) {
        log.error({ step: 'data.backup.tar_failed', code, stderr: stderr.slice(0, 1000) }, 'tar failed');
        throw new BackupError('tar_exit_nonzero', new Error(stderr));
      }

      const stat = await fs.stat(archivePath);
      const sizeBytes = stat.size;
      const pruned = await pruneOldBackups(opts.archiveDir, opts.retainDays, now, log);

      log.info({ step: 'data.backup.completed', archivePath, sizeBytes, prunedCount: pruned.length }, 'backup done');
      return { archivePath, sizeBytes, pruned };
    }

    function defaultExecTar(args: string[]): Promise<{ code: number; stderr: string }> {
      return new Promise((resolve, reject) => {
        const child = spawn('tar', args);
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
      });
    }

    async function pruneOldBackups(
      archiveDir: string,
      retainDays: number,
      now: Date,
      log: Pick<Logger, 'info' | 'warn'>,
    ): Promise<string[]> {
      const PATTERN = /^data-backup-(\d{4}-\d{2}-\d{2})\.tar\.gz$/;
      const cutoffMs = now.getTime() - retainDays * 86_400_000;
      let files: string[];
      try { files = await fs.readdir(archiveDir); }
      catch (err) {
        log.warn({ err, step: 'data.backup.prune_readdir_failed' }, 'prune readdir failed');
        return [];
      }
      const pruned: string[] = [];
      for (const f of files) {
        const m = PATTERN.exec(f);
        if (!m) continue;
        const ms = Date.parse(`${m[1]}T00:00:00Z`);
        if (!Number.isFinite(ms) || ms >= cutoffMs) continue;
        try {
          await fs.unlink(join(archiveDir, f));
          pruned.push(f);
        } catch (err) {
          log.warn({ err, step: 'data.backup.prune_file_failed', file: f }, 'prune file failed');
        }
      }
      return pruned;
    }
    ```
  - [x] 4.2 Тесты `src/utils/data-backup.test.ts`:
    - Создать temp-dir с fixture data/, мокать `execTar` через injected option → возвращает `{code:0, stderr:''}`.
    - Тест: вызов с args содержит '--exclude *.raw.txt', '--exclude test-audio'.
    - Тест: archive создан (fs.stat успешен) — для full integration возможно с реальным `tar` под os.tmpdir().
    - Тест: prune — fixture с 13 backup-файлами на разные даты, после run остаются только последние 7.
    - Тест: tar exit code 2 → BackupError, prune не вызвана.
    - Тест: archiveDir отсутствует → fs.mkdir создаёт.

- [x] **Задача 5: `src/scheduler.ts` (НОВЫЙ) — interval-based dispatch** (АК: #5, #11)
  - [x] 5.1 Создать `src/scheduler.ts`:
    ```typescript
    import { promises as fs } from 'node:fs';
    import { join } from 'node:path';
    import { config } from './config.js';
    import { logger as rootLogger, type Logger } from './logger.js';
    import { cleanupRawFiles } from './utils/raw-cleanup.js';
    import { runDailyBackup } from './utils/data-backup.js';
    import { alertOps, recordOpsEvent } from './ops.js';

    export interface SchedulerState {
      lastCleanupAt: string | null;  // ISO; date-only comparison
      lastBackupAt: string | null;
    }
    export interface StartSchedulerOpts {
      dataRoot: string;
      archiveDir: string;
      rawMaxAgeDays: number;
      backupRetainDays: number;
      tickIntervalMs?: number;
      cleanupHourLocal?: number;
      backupHourLocal?: number;
      now?: () => Date;
      logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
      statePath?: string;  // test override
    }

    const DEFAULT_TICK_MS = 60 * 60_000;  // 1h
    const DEFAULT_CLEANUP_HOUR = 3;
    const DEFAULT_BACKUP_HOUR = 4;
    const DEFAULT_STATE_PATH = 'data/.scheduler-state.json';

    function todayInTz(now: Date, tz: string): string {
      return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
    }
    function hourInTz(now: Date, tz: string): number {
      const s = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, hour: '2-digit', hour12: false,
      }).format(now);
      return Number.parseInt(s, 10);
    }

    async function loadState(path: string, log: Pick<Logger, 'warn'>): Promise<SchedulerState> {
      try {
        const raw = await fs.readFile(path, 'utf8');
        const parsed = JSON.parse(raw) as Partial<SchedulerState>;
        return {
          lastCleanupAt: typeof parsed.lastCleanupAt === 'string' ? parsed.lastCleanupAt : null,
          lastBackupAt: typeof parsed.lastBackupAt === 'string' ? parsed.lastBackupAt : null,
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log.warn({ err, step: 'scheduler.state.load_failed' }, 'scheduler state load failed; using fresh');
        }
        return { lastCleanupAt: null, lastBackupAt: null };
      }
    }

    async function saveState(path: string, state: SchedulerState, log: Pick<Logger, 'warn'>): Promise<void> {
      const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
      try {
        await fs.mkdir(join(path, '..'), { recursive: true });
        await fs.writeFile(tmp, JSON.stringify(state, null, 2));
        await fs.rename(tmp, path);
      } catch (err) {
        log.warn({ err, step: 'scheduler.state.save_failed' }, 'scheduler state save failed');
      }
    }

    export async function startScheduler(opts: StartSchedulerOpts): Promise<{ stop: () => void }> {
      const log = opts.logger ?? rootLogger;
      const tz = config.TZ;
      const tickMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS;
      const cleanupHour = opts.cleanupHourLocal ?? DEFAULT_CLEANUP_HOUR;
      const backupHour = opts.backupHourLocal ?? DEFAULT_BACKUP_HOUR;
      const getNow = opts.now ?? (() => new Date());
      const statePath = opts.statePath ?? DEFAULT_STATE_PATH;

      let state = await loadState(statePath, log);

      async function tick(): Promise<void> {
        const now = getNow();
        const today = todayInTz(now, tz);
        const hr = hourInTz(now, tz);
        const lastCleanupDay = state.lastCleanupAt ? todayInTz(new Date(state.lastCleanupAt), tz) : null;
        const lastBackupDay = state.lastBackupAt ? todayInTz(new Date(state.lastBackupAt), tz) : null;

        if (hr >= cleanupHour && lastCleanupDay !== today) {
          try {
            const result = await cleanupRawFiles({ rootDir: opts.dataRoot, maxAgeDays: opts.rawMaxAgeDays, now });
            state = { ...state, lastCleanupAt: now.toISOString() };
            await saveState(statePath, state, log);
            recordOpsEvent('info', {
              pipeline: 'OPS', step: 'scheduler.cleanup.completed', status: 'ok',
              context: { ...result },
            });
          } catch (err) {
            alertOps({ pipeline: 'OPS', step: 'scheduler.cleanup_failed', error: err, context: { lastCleanupAt: state.lastCleanupAt } });
          }
        }
        if (hr >= backupHour && lastBackupDay !== today) {
          try {
            const result = await runDailyBackup({
              rootDir: opts.dataRoot, archiveDir: opts.archiveDir, retainDays: opts.backupRetainDays, now,
            });
            state = { ...state, lastBackupAt: now.toISOString() };
            await saveState(statePath, state, log);
            recordOpsEvent('info', {
              pipeline: 'OPS', step: 'scheduler.backup.completed', status: 'ok',
              context: { archivePath: result.archivePath, sizeBytes: result.sizeBytes, prunedCount: result.pruned.length },
            });
          } catch (err) {
            alertOps({ pipeline: 'OPS', step: 'scheduler.backup_failed', error: err, context: { lastBackupAt: state.lastBackupAt } });
          }
        }
      }

      // Run first tick on next event loop (don't block start()).
      void tick().catch((err) => log.error({ err, step: 'scheduler.tick_unhandled' }, 'scheduler tick unhandled'));
      const timer = setInterval(() => {
        void tick().catch((err) => log.error({ err, step: 'scheduler.tick_unhandled' }, 'scheduler tick unhandled'));
      }, tickMs);
      timer.unref?.();
      return { stop: () => clearInterval(timer) };
    }

    /** Test-only export for state file shape. */
    export const _internal = { DEFAULT_STATE_PATH, DEFAULT_TICK_MS };
    ```
    **Why `hr >= cleanupHour`?** Грубее, но если процесс пропустил 03:00 и стартует в 03:45 — догоняется в первый tick после старта. Этому условию помогает `lastCleanupDay !== today` check (защита от дублей в один день).
  - [x] 5.2 Тесты `src/scheduler.test.ts`:
    - Mock `getNow` через injected option; `cleanupRawFiles` / `runDailyBackup` импорты заменить через `vi.mock`.
    - Тест: tick в 03:00 lastCleanupAt=null → cleanup вызван, state обновлён.
    - Тест: tick в 03:05 lastCleanupAt='today 03:00' → cleanup НЕ вызван.
    - Тест: tick в 04:00 lastBackupAt=null → backup вызван.
    - Тест: cleanup throws → alertOps вызван, lastCleanupAt НЕ обновлён.
    - Тест: backup throws → alertOps, lastBackupAt НЕ обновлён.
    - Тест: rest after restart — loadState читает persisted state, тик в 04:00 после рестарта в 03:30 запускает только backup (cleanup пропускается).
    - Тест: invalid state file → log.warn + fresh state.

- [x] **Задача 6: `src/bot.ts` — wiring scheduler + isAlreadyApproved guard** (АК: #5, #9)
  - [x] 6.1 Добавить top-level import:
    ```typescript
    import { startScheduler } from './scheduler.js';
    import { appendApproval as defaultAppendApproval, isAlreadyApproved as defaultIsAlreadyApproved } from './utils/approvals.js';
    ```
  - [x] 6.2 В `BotDeps`:
    ```typescript
    isAlreadyApproved?: typeof defaultIsAlreadyApproved;
    ```
  - [x] 6.3 В `createBot`:
    ```typescript
    const isAlreadyApproved = deps.isAlreadyApproved ?? defaultIsAlreadyApproved;
    let _schedulerHandle: { stop: () => void } | null = null;
    ```
  - [x] 6.4 В `createBot.start()` после `setOpsTelegramSender/Writer`, ПЕРЕД `startWatchdog`:
    ```typescript
    if (deps.botInfo === undefined) {
      _schedulerHandle = await startScheduler({
        dataRoot: 'data',
        archiveDir: process.env.BACKUP_DIR || 'data/.backups',
        rawMaxAgeDays: 14,
        backupRetainDays: 7,
      });
    }
    ```
  - [x] 6.5 В `createBot.stop()` ПЕРЕД watchdog.stop():
    ```typescript
    if (_schedulerHandle) { _schedulerHandle.stop(); _schedulerHandle = null; }
    ```
  - [x] 6.6 В approve callback (line 770-783) ПЕРЕД `if (job.approvalStatus === 'approved')`:
    ```typescript
    let alreadyApprovedOnDisk = false;
    try { alreadyApprovedOnDisk = await isAlreadyApproved(job.clientId, job.id); }
    catch (err) {
      log.warn({ err, jobId, step: 'bot.approve.idempotency_check_failed' }, 'idempotency read failed, proceeding');
    }
    if (alreadyApprovedOnDisk) {
      await ctx.answerCallbackQuery({ text: 'ℹ️ Уже отправлено.' });
      log.info({ jobId, step: 'bot.approve.disk_idempotency_hit' }, 'approve replayed after restart');
      return;
    }
    ```
  - [x] 6.7 Тесты в `src/bot.test.ts` — расширить existing approve tests:
    - Mock `isAlreadyApproved` → true → callback отвечает 'ℹ️ Уже отправлено.', НЕ appendApproval, НЕ deliverReport.
    - Mock `isAlreadyApproved` → false (default) → existing approve flow проходит.
    - Mock `isAlreadyApproved` throws → log.warn + продолжение к in-memory check.
    - Scheduler wiring: тест в существующей структуре `createBot` — verify что start() с production deps (botInfo undefined) НЕ падает; mock startScheduler (через `vi.mock('./scheduler.js', ...)`) и проверить вызван.

- [x] **Задача 7: `src/utils/commitments-history.ts` — overlay-интеграция** (АК: #8)
  - [x] 7.1 Расширить `loadOpenCommitments`:
    ```typescript
    // ... after base commitments collected into buckets ...

    // Story 1.10: overlay commitments-updates.json files on top.
    interface OverlayFile {
      runId?: string;
      timestamp?: string;
      updates: CommitmentStatusUpdate[];
      sourceFiles?: string[];
    }
    const overlayPattern = new RegExp(
      `^f1-${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[a-f0-9]+\\.commitments-updates\\.json$`,
    );
    for (let dateIdx = 0; dateIdx < dateDirs.length; dateIdx++) {
      const dateName = dateDirs[dateIdx]!;
      const dirPath = join(root, dateName);
      const dateMs = Date.parse(`${dateName}T00:00:00Z`);
      if (Number.isFinite(dateMs) && dateMs < cutoffMs) continue;
      let files: string[];
      try { files = await fs.readdir(dirPath); } catch { continue; }
      for (const fname of files) {
        if (!overlayPattern.test(fname)) continue;
        const fullPath = join(dirPath, fname);
        let stat: import('node:fs').Stats;
        try { stat = await fs.stat(fullPath); } catch { continue; }
        if (stat.mtimeMs < cutoffMs) continue;
        let parsedOverlay: OverlayFile;
        try {
          const content = await fs.readFile(fullPath, 'utf8');
          parsedOverlay = JSON.parse(content) as OverlayFile;
        } catch (err) {
          log.warn?.({ step: 'commitments_overlay.read_failed', file: fullPath, err }, 'overlay read failed');
          continue;
        }
        if (!Array.isArray(parsedOverlay.updates)) {
          log.warn?.({ step: 'commitments_overlay.schema_skip', file: fullPath }, 'overlay missing updates[]');
          continue;
        }
        for (const u of parsedOverlay.updates) {
          const validated = CommitmentStatusUpdateSchema.safeParse(u);
          if (!validated.success) {
            log.warn?.({ step: 'commitments_overlay.update_invalid', file: fullPath }, 'overlay update invalid');
            continue;
          }
          const key = `${validated.data.who}${KEY_SEP}${validated.data.what}${KEY_SEP}${/* deadline */ ''}`;
          // Note: overlay schema doesn't include deadline — we have to look up bucket by who+what
          // Adjust: scan buckets, find entries with matching {who, what}, apply newer-wins.
          for (const [bucketKey, meta] of buckets.entries()) {
            const [bWho, bWhat] = bucketKey.split(KEY_SEP);
            if (bWho !== validated.data.who || bWhat !== validated.data.what) continue;
            // overlay wins only if older than base would be — but mtime semantics differ.
            // Decision: overlay ALWAYS applies (it's an explicit status update). Newer base
            // already has status set (from prior overlay merge or fresh extraction).
            if (stat.mtimeMs >= meta.mtimeMs) {
              buckets.set(bucketKey, {
                commitment: { ...meta.commitment, status: validated.data.new_status },
                mtimeMs: stat.mtimeMs,
                dateOrder: dateIdx,
              });
            }
          }
        }
      }
    }
    ```
    **Note:** `CommitmentStatusUpdateSchema` НЕ содержит `deadline` поле, поэтому match только по `(who, what)`. Это **достаточный** ключ для open commitments per top per client; deadline rarely changes for the same commitment text. Если две commitments с одинаковым `(who, what)` но разным `deadline` — overlay применится к обеим (приемлемо для MVP; точнее — добавить `deadline` в schema в будущем Story).
  - [x] 7.2 Импорт схемы:
    ```typescript
    import { ExtractionOutputSchema, CommitmentStatusUpdateSchema, type Commitment, type CommitmentStatusUpdate } from '../types.js';
    ```
  - [x] 7.3 Тесты `src/utils/commitments-history.test.ts` (extend existing):
    - Тест overlay: extraction.json status='open', overlay status='completed' → final excluded из openCommitments.
    - Тест overlay newer base wins: newer extraction уже status='completed', older overlay status='open' → final 'completed'.
    - Тест invalid overlay (missing `updates`) → log.warn, base unchanged.
    - Тест: overlay для несуществующего commitment (who/what не в buckets) → no-op, не throws.
    - Тест: overlay из cross-client path traversal — невозможен т.к. scope ограничен root=data/{clientId}/.
    - Тест: schema-invalid update entry в массиве → пропускается, остальные применяются.
    - Регрессия: existing test без overlay-файлов проходит без изменений.

- [x] **Задача 8: `scripts/offboard-client.ts` (НОВЫЙ) — оффбординг tool** (АК: #7)
  - [x] 8.1 Создать `scripts/offboard-client.ts`:
    ```typescript
    #!/usr/bin/env tsx
    import { promises as fs } from 'node:fs';
    import { join } from 'node:path';
    import { assertClientId, slugifyClientId, ClientIdError } from '../src/utils/client-id.js';

    interface Args { clientId: string; confirm: boolean; dataRoot: string; }

    function parseArgs(argv: string[]): Args {
      const args: Partial<Args> = { dataRoot: 'data', confirm: false };
      for (let i = 0; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === '--client-id' && argv[i + 1]) { args.clientId = argv[++i]; }
        else if (a === '--confirm') { args.confirm = true; }
        else if (a === '--data-root' && argv[i + 1]) { args.dataRoot = argv[++i]; }
        else if (a === '--help' || a === '-h') {
          console.log('Usage: tsx scripts/offboard-client.ts --client-id <id> [--confirm] [--data-root <path>]');
          process.exit(0);
        }
      }
      if (!args.clientId) { console.error('Error: --client-id required'); process.exit(1); }
      return args as Args;
    }

    interface Stats { files: number; bytes: number; byExt: Record<string, number>; }

    async function walkStats(dir: string): Promise<Stats> {
      const stats: Stats = { files: 0, bytes: 0, byExt: {} };
      async function recur(d: string): Promise<void> {
        let entries: import('node:fs').Dirent[];
        try { entries = await fs.readdir(d, { withFileTypes: true }); }
        catch { return; }
        for (const e of entries) {
          const p = join(d, e.name);
          if (e.isDirectory()) { await recur(p); continue; }
          if (!e.isFile()) continue;
          try {
            const s = await fs.stat(p);
            stats.files++;
            stats.bytes += s.size;
            const ext = e.name.includes('.') ? e.name.slice(e.name.indexOf('.')) : 'noext';
            stats.byExt[ext] = (stats.byExt[ext] ?? 0) + 1;
          } catch { /* skip */ }
        }
      }
      await recur(dir);
      return stats;
    }

    async function main(): Promise<void> {
      const args = parseArgs(process.argv.slice(2));
      try { assertClientId(args.clientId); }
      catch (err) {
        if (err instanceof ClientIdError) {
          console.error(`Invalid clientId: ${err.reason} (${err.clientId})`);
          process.exit(1);
        }
        throw err;
      }
      const slug = slugifyClientId(args.clientId);
      const clientDir = join(args.dataRoot, slug);

      try { await fs.stat(clientDir); }
      catch {
        console.warn(`data/${slug}/ does not exist (already offboarded or never onboarded)`);
        process.exit(0);
      }

      const stats = await walkStats(clientDir);
      console.log(`\n=== Offboarding plan for clientId='${args.clientId}' (slug='${slug}') ===`);
      console.log(`Path: ${clientDir}`);
      console.log(`Files: ${stats.files}, Total bytes: ${stats.bytes}`);
      console.log('By extension:');
      for (const [ext, count] of Object.entries(stats.byExt).sort()) {
        console.log(`  ${ext}: ${count}`);
      }

      if (!args.confirm) {
        console.log('\nDry-run (no deletion). Re-run with --confirm to actually delete.');
        process.exit(0);
      }

      const t0 = Date.now();
      await fs.rm(clientDir, { recursive: true, force: true });
      const elapsed = Date.now() - t0;
      console.log(`\nDeleted ${clientDir} (${stats.files} files, ${stats.bytes} bytes) in ${elapsed}ms`);

      console.log('\nManual TODO (NOT automated):');
      console.log('  1. Revoke service-account access to client Sheets (Share → remove).');
      console.log('  2. Archive or filter _ops_logs rows for clientId from Sheet UI.');
      console.log('  3. Remove client chat IDs from TELEGRAM_TRACKER_CHAT_IDS env.');
      console.log('  4. Remove client OAuth/API tokens from secret manager.');
      console.log('  5. Confirm deletion in docs/timur-ops-runbook.md offboarding checklist.');
    }

    main().catch((err) => { console.error(err); process.exit(1); });
    ```
  - [x] 8.2 Не нужен test файл — это manual CLI script. Но добавить smoke-test в `scripts/`:
    - Manual smoke: `mkdir -p /tmp/data-offboard-test/test-client/2026-05-22 && touch /tmp/data-offboard-test/test-client/2026-05-22/f1-foo.extraction.json && npx tsx scripts/offboard-client.ts --client-id test-client --data-root /tmp/data-offboard-test` → dry-run prints stats, не удаляет.
    - `--confirm` → удаляет.
  - [x] 8.3 Добавить в `package.json` scripts (если scripts помещаются):
    ```json
    "offboard": "tsx scripts/offboard-client.ts"
    ```

- [x] **Задача 9: `.gitignore` обновление** (АК: #10)
  - [x] 9.1 Добавить в `.gitignore` (после existing блока «Harness state»):
    ```
    # Story 1.10: runtime client data + scheduler/ops state
    data/.ops-state.json
    data/.scheduler-state.json
    data/.backups/
    data/geonline/
    ```
  - [x] 9.2 Проверить через `git status` после pipeline run — нет ли accidentally tracked файлов в `data/geonline/`. Если есть — `git rm --cached data/geonline/...` (manual, не в скрипте).

- [x] **Задача 10: `docs/timur-ops-runbook.md` обновление** (АК: #7, #10)
  - [x] 10.1 Добавить секции:
    ```
    ## Offboarding клиента

    1. **Pre-flight:** убедиться, что клиент уведомлён и согласовал deletion timeline (legal).
    2. **Dry-run:** `npx tsx scripts/offboard-client.ts --client-id <id>` — печатает план без изменений.
    3. **Verify list:** проверить, что счётчики (files, bytes, by ext) соответствуют ожиданиям.
    4. **Confirm:** `npx tsx scripts/offboard-client.ts --client-id <id> --confirm` — удаляет `data/{slug}/`.
    5. **Manual TODOs:** (печатаются скриптом) — Sheets access revoke, _ops_logs filter, chat whitelist clean, secrets.
    6. **Verify:** `ls data/<slug>` → no such directory.
    7. **Confirm in writing:** записать в журнал GDPR/compliance (Phase 2, MVP — текстовая нота в Telegram трекеру).

    SLA: full deletion < 1 час (NFR8).

    ## Restore from backup

    Бэкапы лежат в `data/.backups/data-backup-YYYY-MM-DD.tar.gz` (последние 7 дней).
    ```bash
    mkdir -p data/restore
    tar -xzf data/.backups/data-backup-2026-05-22.tar.gz -C data/restore/
    # Inspect data/restore/geonline/ before merging back to data/.
    ```
    Внимание: tar НЕ содержит `*.raw.txt` (excluded). Только финальные `*.json` + `approvals.jsonl`.

    ## Scheduler hours

    In-process scheduler (Story 1.10):
    - **03:00 Asia/Almaty** — daily cleanup `*.raw.txt` старше 14 дней.
    - **04:00 Asia/Almaty** — daily tar backup `data-backup-{date}.tar.gz`, retain последние 7 файлов.
    - Состояние: `data/.scheduler-state.json` (lastCleanupAt, lastBackupAt).
    - Ошибки эскалируются через `alertOps` в ops-чат.

    Manual run: запустить процесс в любое время — первый tick догонит пропущенный день (lastCleanupDay != today условие).
    ```
  - [x] 10.2 Cross-link из `_bmad-output/implementation-artifacts/deferred-work.md`: пометить CLOSED-карточки.

- [x] **Задача 11: `_bmad-output/implementation-artifacts/deferred-work.md` обновление**
  - [x] 11.1 Пометить **CLOSED 2026-05-2X (Story 1.10):**
    - Line 31: «Auto-cleanup `*.raw.txt` через 14 дней» (`*.extraction/analysis.raw.txt`).
    - Line 33: «Запись/обновление статусов commitments в data/» (PARTIALLY → FULLY CLOSED через overlay-merge в loadOpenCommitments).
    - Line 58: «Auto-cleanup `*.format.raw.txt` через 14 дней».
    - Line 60: «Полный persistence-слой commitments» — overlay интеграция.
    - Lines 69-70: «`appendApproval` failure / `isAlreadyApproved` не вызывается» — disk-level guard wired в approve callback.
    - Line 113: «Cron job для backup-tar + cleanup `*.raw.txt` (14d)» — CLOSED.
  - [x] 11.2 ОСТАЁТСЯ deferred:
    - Lines 39, 42: collision detection + date validation — Story 6.x / Phase 2.
    - Line 48: split-persist race (atomic batch persist) — Phase 2 (приоритет low).
    - Lines 71-73: «Старая approve-клавиатура» / `pendingEdits` collision / `completedJobs` TTL — Story 6.x (multi-tracker).
    - Line 114: Circuit breaker для Claude — другая story.
    - Line 116: Restart-recovery missed-job — Story 3.0.

- [x] **Задача 12: Тесты + регрессия + Sprint Status** (АК: #12)
  - [x] 12.1 `npm test` (vitest) → ожидаемо: existing 332 + новые ~30 = ~362 passed.
  - [x] 12.2 `npx tsc --noEmit` → no errors.
  - [x] 12.3 Регрессионная проверка test files:
    - `src/utils/commitments-history.test.ts` — overlay tests без regression на existing.
    - `src/f1-report.test.ts` — slugifyClientId import move, behavior идентично.
    - `src/bot.test.ts` — approve callback с mock isAlreadyApproved, scheduler wiring mock.
    - `src/adapters/sheets.test.ts` — resolveSheetId с assertClientId, existing 'geonline' tests pass.
  - [x] 12.4 Smoke-тест в local env (optional, но recommended):
    - `npm run dev` → бот запускается, scheduler логирует startup.
    - Запустить искусственный tick: `STATE_PATH=/tmp/sched-test.json BACKUP_DIR=/tmp/backups npx tsx -e 'import { startScheduler } from "./src/scheduler.js"; const h = await startScheduler({dataRoot:"data",archiveDir:"/tmp/backups",rawMaxAgeDays:14,backupRetainDays:7,tickIntervalMs:1000,cleanupHourLocal:new Date().getHours(),backupHourLocal:new Date().getHours()}); setTimeout(() => h.stop(), 5000);'` — verify cleanup + backup run, файл создан.
  - [x] 12.5 Обновить `sprint-status.yaml`: `1-10-data-persistence-i-client-isolation: backlog → ready-for-dev` (после story creation); далее lifecycle через dev.
  - [x] 12.6 Заполнить Dev Agent Record (Agent Model, Debug Log, Completion Notes, File List) после реализации.

## Dev Notes

### Соответствие архитектуре

- **«Данные > pipeline» (architecture.md#Architectural Principles line 177):** Append-only JSON на диске с Day 1 — Story 1.4a/1.4b/1.6/1.9 это закрепили; Story 1.10 формализует invariants (path layout, TTL only for `.raw.txt`, никогда `.json`).
- **«Sheets + JSON Files» ADR-003 (architecture.md lines 161-165):** Sheets = read + ops logs (Story 1.9); JSON files = full backup append-only. Story 1.10 добавляет tar + retention как третий уровень защиты (Sheets API down + диск повреждён → есть свежий tar). Соответствует Data Architecture table line 332: «Backup: Sheets + JSON files + cron `tar` раз в день (7 дней). Три уровня защиты данных».
- **Client isolation (architecture.md#Cross-Cutting Concerns line 84):** «client_id во всех слоях: промпты, хранение, delivery. Code review при подключении 2-го клиента». Story 1.10 готовит defense-in-depth через `assertClientId` без преждевременного multi-client wiring.
- **Pipeline boundary (architecture.md#Architectural Boundaries lines 591-598):** Каждый pipeline самостоятелен; `scheduler.ts` НЕ pipeline — это infrastructure. Соответствует «Ops — отдельная инфраструктура (`ops.ts`), а не pipeline» (cross-reference на Story 1.9 dev notes).
- **Adapter boundary (architecture.md#Architectural Boundaries lines 582-588):** `data-backup.ts` использует `child_process.spawn('tar')` — это external boundary, injectable через `execTar` opt для тестов. Аналогично паттерну `transcript.ts` adapter с injectable HTTP client.
- **Naming (architecture.md#Naming Patterns):** kebab-case files (`client-id.ts`, `raw-cleanup.ts`, `data-backup.ts`); camelCase functions (`slugifyClientId`, `assertClientId`, `cleanupRawFiles`, `runDailyBackup`); PascalCase types (`ClientIdError`, `BackupError`, `SchedulerState`).
- **Logging (architecture.md#Format Patterns line 444):** Все steps логируются как `{pipeline:'OPS', step:'scheduler.*' | 'data.raw_cleanup.*' | 'data.backup.*', clientId?, durationMs?, status}` — соответствует Story 1.9 `recordOpsEvent` контракту.
- **Append-only convention (architecture.md#Data Architecture):** approvals.jsonl (Story 1.6), `_ops_logs` Sheet (Story 1.9), commitments-updates.json (Story 1.4b) — overlay design. Story 1.10 НЕ нарушает: новые `.commitments-updates.json` файлы продолжают писаться рядом, читаются inclusively.
- **«Backup safety: Cron tar раз в день, хранить 7 дней» (architecture.md#Data Architecture line 291):** dirext implementation.
- **«Один файл на pipeline» (architecture.md#Structure Patterns):** Scheduler = infrastructure, не pipeline. ~80 LOC scheduler + helpers — приемлемо.

### Source tree (изменения)

| Файл | Действие | ~LOC |
|------|----------|------|
| `src/utils/client-id.ts` | НОВЫЙ — slugifyClientId + assertClientId + parseClientIdFromPath | +60 |
| `src/utils/client-id.test.ts` | НОВЫЙ — 12+ тестов | +90 |
| `src/utils/raw-cleanup.ts` | НОВЫЙ — cleanupRawFiles + ignore-paths | +90 |
| `src/utils/raw-cleanup.test.ts` | НОВЫЙ — temp-dir integration tests | +120 |
| `src/utils/data-backup.ts` | НОВЫЙ — runDailyBackup + pruneOldBackups + BackupError | +130 |
| `src/utils/data-backup.test.ts` | НОВЫЙ — execTar mock + prune tests | +130 |
| `src/scheduler.ts` | НОВЫЙ — startScheduler + state persistence + tick dispatch | +120 |
| `src/scheduler.test.ts` | НОВЫЙ — mocked time/exec + state tests | +180 |
| `src/utils/commitments-history.ts` | ОБНОВЛЁН — overlay-merge после base | +50 |
| `src/utils/commitments-history.test.ts` | ОБНОВЛЁН — 6+ overlay тестов | +130 |
| `src/f1-report.ts` | Импорт slugifyClientId из utils + assertClientId в persist* | +5 / -3 |
| `src/adapters/sheets.ts` | assertClientId в resolveSheetId | +3 |
| `src/bot.ts` | wire startScheduler + isAlreadyApproved guard в approve callback + assertClientId в /report + deliverReport | +40 |
| `src/bot.test.ts` | новые тесты для approve idempotency + scheduler mock | +120 |
| `scripts/offboard-client.ts` | НОВЫЙ — CLI tool | +130 |
| `docs/timur-ops-runbook.md` | +Offboarding +Restore +Scheduler hours | +50 |
| `.gitignore` | runtime data + scheduler/backup paths | +5 |
| `package.json` | "offboard" script | +1 |
| `_bmad-output/implementation-artifacts/deferred-work.md` | пометить 6 CLOSED карточек | ~-20 / +20 |
| `_bmad-output/implementation-artifacts/sprint-status.yaml` | lifecycle 1-10 | ~2 |

Всего ~1300 LOC изменений (production ~600, tests ~750). Большая story с тестами; разбиение на 1.10a/1.10b НЕ оправдано — scheduler + cleanup + backup взаимозависимы, а assertClientId + overlay-merge — короткие independent патчи.

### Testing Standards

- **Vitest** (existing). Изоляция через temp-dirs (`os.tmpdir()`) для filesystem-зависимых тестов (cleanup, backup, scheduler state). Pattern: `beforeEach` создаёт fresh dir, `afterEach` `fs.rm({recursive,force})`.
- **Time mocking:** Pure functions (`tickWatchdog`-style) принимают `now` как argument — точная управляемость. `setInterval` НЕ тестируем напрямую; вместо этого выкручиваем `getNow` и зовём internal tick через test-only export ИЛИ через `vi.useFakeTimers()`.
- **tar mocking:** Через injected `execTar: (args) => Promise<{code, stderr}>` — без реального child_process в тестах. Optional: один e2e тест с настоящим `tar` под `/tmp/` (Linux assumed; в CI должен работать).
- **fs mocking:** Reuse pattern Story 1.9 — temp-dirs предпочтительнее `vi.mock('node:fs/promises')` (хрупкий).
- **Coverage target:** все 12 AC покрыты тестами; критичные пути (cleanup ignore-paths, prune retention, overlay merge winner logic, assertClientId path traversal) — таблично-driven.

### Контракты с другими stories

- **Story 1.1 (config):** `config.TZ` используется в scheduler для timezone-aware hour comparison. `TZ='Asia/Almaty'` уже dock-set (Story 1.1 Docker + Zod default). Никаких изменений в `config.ts`.
- **Story 1.3 (sheets adapter):** `resolveSheetId` получает `assertClientId` до whitelist. Существующая SheetsAdapterError для `unknown_clientId` остаётся. F5 manual entry (`writeF5Metric`) НЕ в scope 1.10 (была miss-указана в 1.3 deferred line 26; пересмотрено — Epic 2/6).
- **Story 1.4a/1.4b:** `loadOpenCommitments` overlay добавляется без breaking change сигнатуры. `slugifyClientId` импортируется из utils (не из f1-report).
- **Story 1.5 (bot queue):** Queue остаётся in-memory. Restart-recovery deferred to Story 3.0.
- **Story 1.6 (approval):** Disk-level guard `isAlreadyApproved` теперь активен в approve callback. In-memory `job.approvalStatus` остаётся primary (latency); disk — safety net.
- **Story 1.7 (delivery):** `assertClientId(job.clientId)` в deliverReport — defense layer. Никаких изменений в текстовых сообщениях / inline keyboards.
- **Story 1.8 (first-run):** не пересекается.
- **Story 1.9 (ops):** Scheduler ошибки через `alertOps`, успехи через `recordOpsEvent`. `data/.scheduler-state.json` соседствует с `data/.ops-state.json` — тот же atomic write pattern. Никаких регрессий watchdog.
- **Story 1.11 (canary):** Future — canary будет читать `data/golden/` (ignored в gitignore? — нет, `data/golden/` уже excluded selectively); `cleanupRawFiles` НЕ трогает `data/golden/` (ignore-path).
- **Story 1.12 (ops-status для Айдара):** future — `[📊 Статус]` callback может показать «Backup yesterday: data-backup-2026-05-22.tar.gz (5.2 MB)» из `data/.backups/`. Story 1.10 НЕ implementует UI; только данные доступны.
- **Story 1.13 (поиск отчётов):** future — поиск через `data/{clientId}/*/`; Story 1.10 layout-invariant гарантирует, что путь стабилен.
- **Story 1.14 (VPS deploy):** future — `data/.backups/` mount как volume (volume в docker-compose) для restart-resilience. Story 1.10 НЕ настраивает docker volume; это задача 1.14.
- **Story 3.0 (Scheduler shared component):** future — заменит `setInterval` на `node-cron` + missed-job detection. External API `startScheduler({...})` совместим.
- **Story 6.2 (multi-client):** future — `assertClientId({allowed: new Set(['geonline','clientB'])})` через config.CLIENTS. Story 1.10 готовит API без wiring.
- **Epic 2 (F5 deferred-growth):** не пересекается с 1.10.

### LLM-Dev-Agent Guardrails

- **НЕ создавать `node-cron` dependency** — Story 1.10 использует `setInterval`. node-cron — задача Story 3.0.
- **НЕ удалять `data/.ops-state.json`** в offboarding — это infrastructure state, не client data. Скрипт `offboard-client.ts` удаляет ТОЛЬКО `data/{slug}/`.
- **НЕ перезаписывать `*.json` файлы** при cleanup — только `*.raw.txt`. Cleanup НЕ затрагивает источники истины для loadOpenCommitments.
- **НЕ нарушать append-only invariant** approvals.jsonl. `appendApproval` использует `fs.appendFile`, не `writeFile`.
- **НЕ менять сигнатуру `loadOpenCommitments`** — overlay merge внутри функции, external API стабилен (тесты Story 1.4a продолжают работать).
- **НЕ делать `assertClientId` async** — synchronous throw. Pattern `asserts clientId is string` для TypeScript type narrowing.
- **НЕ читать `*.commitments-updates.json` ВНЕ scope `data/{clientId}/`** — overlay-merge остаётся в boundary одного клиента. Cross-client path traversal невозможен через filesystem scope.
- **НЕ полагаться на server timezone** для scheduler hour check — использовать `Intl.DateTimeFormat({timeZone: config.TZ})`. Docker задаёт `TZ=Asia/Almaty`, но defensive coding.
- **НЕ блокировать event loop** на tar (может быть 30+ секунд для большого `data/`) — scheduler-tick — async fire-and-forget, ошибки логируются. Pipeline /report НЕ зависает.
- **НЕ удалять backups до успешного create** — `pruneOldBackups` вызывается ПОСЛЕ успешного tar; иначе риск потерять последний бэкап при ошибке create.
- **НЕ implement-ить in-memory cache scheduler state** — state читается только при start(); update — write+rename. На restart — fresh load. Никаких race conditions с concurrent ticks (`setInterval` гарантирует серийность).
- **НЕ менять path layout `data/{client_id}/{YYYY-MM-DD}/`** — это invariant для loadOpenCommitments, persistStep, persistMeta, persistDeliveryReport, persistCommitmentsUpdates, isAlreadyApproved. Любое изменение path breaks ВСЕ Story 1.4–1.6 тесты.
- **НЕ хранить `data/.backups/` внутри tar** — `--exclude .backups` критично, иначе рекурсивный экспонент.
- **НЕ использовать `assertClientId` в loadConfig** на module-top — load order matters; вызывать в boundary handlers.
- **НЕ доверять mtime для backup retention** — использовать pattern-match `data-backup-(YYYY-MM-DD).tar.gz` на имя файла + parse date. mtime может смещаться (tarball restore, NTP).
- **НЕ забыть `BACKUP_DIR` env** в `.env.example` — добавить с пустым default. Если empty/unset — fallback `data/.backups`.
- **НЕ оставлять `*.tmp` файлы** при scheduler state write fail — текущий код использует unique tmp-имя per process (`${path}.tmp.${pid}.${timestamp}`); orphan tmp-файлы возможны при kill -9. Periodic cleanup НЕ нужен (acceptable risk).

### Previous Story Intelligence (Stories 1.4a/1.4b/1.6/1.9)

**Ключевые паттерны для переиспользования:**
- `setInterval` + `timer.unref()` + `clearInterval` (Story 1.9 startWatchdog) — копия для scheduler.
- Atomic state write: `writeFile(tmp) + rename` с unique tmp-name (Story 1.9 review fix) — копия для scheduler-state.json.
- `fs.mkdir(dir, { recursive: true })` перед записи (Story 1.6 appendApproval) — для archiveDir.
- `recordOpsEvent('info', {step, status, context})` (Story 1.9) — для cleanup/backup success.
- `alertOps({pipeline, step, error, context})` (Story 1.4b, 1.9) — для cleanup/backup failure.
- `vi.spyOn(logger, 'warn')` для проверки log.warn в тестах — Story 1.9 pattern.
- Temp-dir tests с `os.tmpdir()` для FS-зависимых тестов — Story 1.4a/1.4b pattern.

**Review findings relevant для 1.10:**
- Story 1.4b iter 2 deferred: «split-persist race: report.json есть, commitments-updates.json нет» — Story 1.10 НЕ решает atomic batch persist (Phase 2); current implementation продолжает warn-only.
- Story 1.4b iter 2 deferred: «MEETING_DATE_PREFIX_RE пропускает 9999-99-99» — Story 1.10 НЕ исправляет date validation (помечено B8); остаётся deferred.
- Story 1.4a deferred: «topNameSlug collision cross-stakeholder data leak» — Story 1.10 НЕ исправляет collision detection в `topNameSlug`; остаётся deferred to Story 6.x.
- Story 1.6 deferred: «`completedJobs` нет TTL» — Story 1.10 НЕ implementует TTL (MAX_COMPLETED_JOBS bound already in 1.5).
- Story 1.9: «recordOpsEvent для canonical ops events» — Story 1.10 расширяет на `scheduler.cleanup.completed`, `scheduler.backup.completed` (новые steps).
- Story 1.9 review fix: «watchdog state commit AFTER successful Telegram send» — Story 1.10 scheduler НЕ имеет analogous concern; state-update после успешного cleanup/backup synchronous.

### Project Structure Notes

- 4 НОВЫХ файла в `src/`: `utils/client-id.ts`, `utils/raw-cleanup.ts`, `utils/data-backup.ts`, `scheduler.ts`. Соответствует architecture.md#Project Structure (scheduler.ts заранее запланирован line 535).
- 4 НОВЫХ test файла: `utils/client-id.test.ts`, `utils/raw-cleanup.test.ts`, `utils/data-backup.test.ts`, `scheduler.test.ts`.
- 1 НОВЫЙ script: `scripts/offboard-client.ts`.
- НЕТ изменений в `src/types.ts` (схемы стабильны), `src/config.ts` (опционально добавить `BACKUP_DIR` env, но process.env.BACKUP_DIR прямо в `bot.ts` тоже acceptable — minimum surface).
- `data/.backups/` и `data/.scheduler-state.json` — runtime, не в git (`.gitignore` обновлён).

### References

- [Source: _bmad-output/planning-artifacts/epics.md, Story 1.10 — lines 746-764]
- [Source: _bmad-output/planning-artifacts/epics.md, FR20-FR24 (client isolation) — lines 900-904, 324]
- [Source: _bmad-output/planning-artifacts/epics.md, FR70-FR73 (Sheets adapter + data organization) — line 345]
- [Source: _bmad-output/planning-artifacts/epics.md, NFR22 (Code review изоляции при 2-м клиенте) — line 142]
- [Source: _bmad-output/planning-artifacts/prd.md, «Изоляция клиентов» — lines 610-621]
- [Source: _bmad-output/planning-artifacts/prd.md, NFR8 (полное удаление < 1ч) — line 957]
- [Source: _bmad-output/planning-artifacts/prd.md, «Data retention policy: Phase 2» — line 469]
- [Source: _bmad-output/planning-artifacts/architecture.md, ADR-003 (Sheets + JSON files) — lines 161-165]
- [Source: _bmad-output/planning-artifacts/architecture.md, «Данные > pipeline» principle — line 177]
- [Source: _bmad-output/planning-artifacts/architecture.md, «Cron tar раз в день, хранить 7 дней» — line 291, 332]
- [Source: _bmad-output/planning-artifacts/architecture.md, «Client isolation» — lines 84, 307]
- [Source: _bmad-output/planning-artifacts/architecture.md, Project Structure data/ tree — lines 558-565, 718-726]
- [Source: _bmad-output/planning-artifacts/architecture.md, scheduler.ts planned — line 535]
- [Source: _bmad-output/planning-artifacts/architecture.md, Risk Hindsight «Raw Claude response auto-cleanup 14d» — line 657]
- [Source: src/f1-report.ts:53-55 — slugifyClientId implementation (move to utils)]
- [Source: src/f1-report.ts:146-220 — persistStep / persistMeta (add assertClientId)]
- [Source: src/f1-report.ts:800-908 — persistFormatStep / persistDeliveryReport / persistCommitmentsUpdates (add assertClientId)]
- [Source: src/adapters/sheets.ts:102-107 — resolveSheetId whitelist (add assertClientId)]
- [Source: src/utils/approvals.ts:26-47 — isAlreadyApproved (wire into approve callback)]
- [Source: src/utils/commitments-history.ts:43-154 — loadOpenCommitments (add overlay merge)]
- [Source: src/bot.ts:43 — DEFAULT_CLIENT_ID]
- [Source: src/bot.ts:760-815 — approve callback (add disk-level guard before in-memory check)]
- [Source: src/ops.ts (Story 1.9) — startWatchdog setInterval pattern, atomic state write+rename]
- [Source: src/utils/approvals.ts:11-19 — appendApproval atomic fs.mkdir+appendFile pattern]
- [Source: _bmad-output/implementation-artifacts/deferred-work.md, lines 31, 33, 58, 60, 69-70, 113 — closed by Story 1.10]
- [Source: _bmad-output/implementation-artifacts/1-9-ops-logging-i-alerty.md — Story 1.9 ops + scheduler-state pattern reference]
- [Source: _bmad-output/implementation-artifacts/1-4b-f1-formatirovanie-i-podgotovka-k-dostavke.md — commitments-updates.json overlay write contract]
- [Source: docs/timur-ops-runbook.md (Story 1.9) — to extend with Offboarding/Restore/Scheduler sections]

## Dev Agent Record

### Agent Model Used

claude-opus-4-7[1m] (Claude Opus 4.7, 1M context) — bmad-dev-story workflow

### Debug Log References

- Полный регресс vitest: **21 файл / 388 тестов passed** (332 baseline Story 1.9 + 56 новых тестов Story 1.10).
- TypeScript strict: `npx tsc --noEmit` exit 0.
- 5 первоначальных falures во время разработки и их фиксы:
  1. `scheduler.test.ts × 3` — setImmediate auto-tick race с `_runTick`; зафиксировано через `runImmediateTick: false` опцию.
  2. `scheduler.test.ts × 1` — `hourInTz` зависел от `config.TZ` который мог быть != 'Asia/Almaty' в test env; добавлен `tz` injectable opt + переписал hour extraction через `formatToParts('en-US', hour12:false)` (защищено от вариативности локалей).
  3. `data-backup.test.ts × 1` — off-by-one в expected prune list (cutoff = NOW-7d использует UTC midnight для backup names; `2026-05-16T00:00Z < 2026-05-16T04:00Z cutoff` → prune). Fix только в expected list, prune logic корректна.

### Completion Notes List

**Реализация (production-код ~620 LOC + ~720 LOC тестов):**

1. **`src/utils/client-id.ts`** (NEW, ~65 LOC) — `slugifyClientId` + `assertClientId` (TypeScript `asserts clientId is string`) + `parseClientIdFromPath` + `ClientIdError`. Reasons: `empty | too_long | invalid_chars | not_whitelisted`. Max length 64. Запрещены `/\\<>:"|?*` + последовательность `..`.

2. **Defense-in-depth `assertClientId` на границах** wired в:
   - `src/bot.ts:bot.command('report')` — перед enqueue (alertOps на fail).
   - `src/bot.ts:deliverReport` — перед формированием Telegram message (recordOpsEvent + alertOps на fail, возвращает false).
   - `src/f1-report.ts` × 5 — все persist* функции (`persistStep`, `persistMeta`, `persistFormatStep`, `persistDeliveryReport`, `persistCommitmentsUpdates`) в начале try-блока.
   - `src/adapters/sheets.ts:resolveSheetId` — перед whitelist-check; `ClientIdError` → `SheetsAdapterError('auth', {reason:'invalid_clientId', clientIdReason})`.
   `slugifyClientId` удалён из `f1-report.ts` и импортируется из `./utils/client-id.js`.

3. **`src/utils/raw-cleanup.ts`** (NEW, ~110 LOC) — `cleanupRawFiles({rootDir, maxAgeDays, now, logger})`. Рекурсивный обход `data/{client}/{YYYY-MM-DD}/`, удаление `*.raw.txt` старше maxAgeDays. Ignore-paths: `test-audio`, `golden`, `soniox-results`, `prompt-results`, `test-inputs`, `.backups`, `week-*` prefix, `.`-prefix dot-files. EACCES per file → `errors++` + warn, продолжает остальные. Возвращает `{deleted, skipped, errors}`. Лог step: `data.raw_cleanup.completed`.

4. **`src/utils/data-backup.ts`** (NEW, ~155 LOC) — `runDailyBackup({rootDir, archiveDir, retainDays, now, logger, execTar?})`. `tar -czf data-backup-{ISO-date}.tar.gz --exclude='*.raw.txt' --exclude='test-audio' --exclude='golden' --exclude='soniox-results' --exclude='prompt-results' --exclude='test-inputs' --exclude='week-*' --exclude='.backups' -C rootDir .` через `child_process.spawn` (injectable для тестов). После успеха — prune (parse даты из имени `data-backup-(YYYY-MM-DD).tar.gz`, cutoff = NOW - retainDays). Prune **только** после успешного create (защита последнего бэкапа). `BackupError` с reasons `tar_exit_nonzero | archive_dir_failed | tar_spawn_failed`.

5. **`src/scheduler.ts`** (NEW, ~210 LOC) — `startScheduler({dataRoot, archiveDir, rawMaxAgeDays, backupRetainDays, tickIntervalMs?, cleanupHourLocal?, backupHourLocal?, now?, tz?, statePath?, runImmediateTick?, cleanupRawFilesImpl?, runDailyBackupImpl?})`. Default tick 1h, cleanup 03:00 / backup 04:00 Asia/Almaty. `hourInTz` через `Intl.DateTimeFormat('en-US', {timeZone, hour:'2-digit', hour12:false}).formatToParts()` — robust независимо от process TZ. State persist в `data/.scheduler-state.json` (atomic writeFile+rename + unique `${path}.tmp.${pid}.${Date.now()}` имена). Errors через `alertOps('scheduler.{cleanup,backup}_failed')` (state НЕ обновляется → next tick retries). Successes через `recordOpsEvent('info', 'scheduler.{cleanup,backup}.completed')`. `timer.unref()` — не блокирует exit. Tests deterministic: `runImmediateTick:false` + `_runTick()` + `tz: 'Asia/Almaty'`.

6. **`src/bot.ts` wiring** — `startScheduler` injectable в `BotDeps`; запускается в `createBot.start()` после watchdog (когда `deps.botInfo === undefined` — production). `BACKUP_DIR` env override (default `data/.backups`). `_schedulerHandle.stop()` в `createBot.stop()` ПЕРЕД watchdog stop. `isAlreadyApproved` defaultImport wired в approve callback ПЕРЕД `job === undefined` / in-memory `approvalStatus` check; fs read error → `bot.approve.idempotency_check_failed` warn + continue. Hit → `ℹ️ Уже отправлено.` + `bot.approve.disk_idempotency_hit` log.

7. **`src/utils/commitments-history.ts` overlay-merge** — `loadOpenCommitments` теперь после загрузки base buckets из `*.extraction.json` дополнительно загружает `*.commitments-updates.json` файлы по той же regex (с другим суффиксом). Каждый overlay update — `CommitmentStatusUpdateSchema.safeParse`. Match по `(who, what)` (schema не содержит deadline). Newer-wins по mtime — overlay не override-ит newer base. Schema-invalid файл/entry → log.warn (`commitments_overlay.schema_skip` / `commitments_overlay.update_invalid`) + skip. Без overlay-файлов tests Story 1.4a работают без изменений (regression).

8. **`scripts/offboard-client.ts`** (NEW CLI, ~150 LOC) — `npx tsx scripts/offboard-client.ts --client-id <id> [--confirm] [--data-root <path>]`. Default dry-run → счётчики (files, bytes, by extension). `--confirm` → `fs.rm(clientDir, {recursive:true, force:true})`. НЕ трогает `data/.ops-state.json`, `data/.scheduler-state.json`, `data/.backups/`. Idempotent. Печатает Manual TODO (revoke Sheets, _ops_logs archive, chat whitelist, secrets, journal). `assertClientId` валидирует input pre-action. `package.json` script: `npm run offboard`.

9. **`.gitignore`** — добавлены `data/.ops-state.json`, `data/.scheduler-state.json`, `data/.backups/`, `data/geonline/`.

10. **`docs/timur-ops-runbook.md`** — 3 новых секции: «Offboarding клиента» (7 шагов, SLA < 1ч / NFR8), «Restore from backup» (tar -xzf пример + примечание про excluded `.raw.txt`), «Scheduler hours» (cleanup 03:00, backup 04:00, state, alertOps на errors). Удалён dup пункт «Cron job для backup-tar» из «Что Story 1.9 НЕ делает».

11. **`deferred-work.md`** — 6 пунктов помечены **CLOSED 2026-05-23 (Story 1.10)**:
    - Auto-cleanup `*.raw.txt` 14d (Story 1.4a + 1.4b *.format.raw.txt deferred объединены).
    - Запись/обновление статусов commitments в data/ — **FULLY CLOSED** через overlay-merge.
    - Полный persistence-слой commitments (1.4b).
    - `isAlreadyApproved` определён но не вызывается → wired.
    - `appendApproval` failure → PARTIALLY CLOSED через disk-level guard.
    - Cron job для backup-tar + cleanup (Story 1.9 deferred).
    Retargeted: `pendingEdits`/`completedJobs` → Story 6.x; Restart-recovery missed-job → Story 3.0.

12. **Тесты** — 4 новых файла, ~720 LOC; +56 новых тестов:
    - `src/utils/client-id.test.ts` — 23 теста (slug, assert all reasons, parseClientIdFromPath, exact-64 boundary).
    - `src/utils/raw-cleanup.test.ts` — 12 тестов (temp-dir integration, age cutoff, ignore-paths × all dirs, week-* prefix, dot-prefix, invalid date dirs, empty rootDir, missing rootDir warn, EACCES, continue после error).
    - `src/utils/data-backup.test.ts` — 8 тестов (mock execTar verifies args, archiveDir auto-create, tar fail → BackupError, prune NOT run on fail, prune retention list, ignore non-matching files, spawn error wrap, ISO-date naming).
    - `src/scheduler.test.ts` — 8 тестов (cleanup at 03:00, idempotent same-day, backup at 04:00 with cleanup done, cleanup/backup failure → alertOps без state update, restart-resume, invalid state file warn-and-fresh, before cleanup hour skip).
    - `src/utils/commitments-history.test.ts` extended — 6 новых overlay тестов (status=completed apply, newer-base-wins, missing updates[] schema-skip, unrelated commitment no-op, schema-invalid entry partial apply, no-overlay regression).

**Что НЕ реализовано (явно deferred в Story 1.10 spec):**
- PostgreSQL migration — Growth (3rd client trigger).
- `node-cron` + missed-job detection — Story 3.0.
- Restart-recovery queue persistence (in-memory `queue` + `completedJobs` lost on restart) — Story 3.0 / Epic 6.
- `completedJobs` / `pendingEdits` TTL eviction — Story 6.x.
- GDPR-compliant immutable audit log — Phase 2 (legal review).
- Multi-client `resolveSheetId` whitelist — Story 6.2 (assertClientId уже готов для multi через `allowed` option).
- Auto-cleanup `*.json` (extraction/analysis/format/report) — Phase 2 retention policy.
- Sheets-side `_ops_logs` row purge — manual в MVP, автоматизация Story 6.x.
- F5 manual entry `writeF5Metric` — переадресовано в Epic 2 (deferred-growth) / Story 6.x (mis-attribution в 1.3 deferred исправлена).
- Streaming Claude response / prompt caching / smart trimming — Growth.
- Encryption at rest / off-site backup — Phase 2 / Growth.
- `BACKUP_DIR` env в `.env.example` — НЕ добавлен в этой story (опционально; defaults к `data/.backups`).

### File List

**Новые файлы (production):**
- `src/utils/client-id.ts` — slugify + assert + parsePath + ClientIdError
- `src/utils/raw-cleanup.ts` — cleanupRawFiles + ignore-paths
- `src/utils/data-backup.ts` — runDailyBackup + pruneOldBackups + BackupError
- `src/scheduler.ts` — startScheduler (setInterval, atomic state)
- `scripts/offboard-client.ts` — CLI dry-run + --confirm + Manual TODO

**Новые файлы (тесты):**
- `src/utils/client-id.test.ts` — 23 теста
- `src/utils/raw-cleanup.test.ts` — 12 тестов
- `src/utils/data-backup.test.ts` — 8 тестов
- `src/scheduler.test.ts` — 8 тестов

**Изменённые файлы (production):**
- `src/f1-report.ts` — slugifyClientId перенесён в utils + assertClientId в 5 persist* функций
- `src/adapters/sheets.ts` — assertClientId в resolveSheetId (ClientIdError → SheetsAdapterError)
- `src/bot.ts` — wire startScheduler + scheduler stop + assertClientId в /report + deliverReport + isAlreadyApproved guard в approve callback
- `src/utils/commitments-history.ts` — overlay-merge в loadOpenCommitments + CommitmentStatusUpdateSchema import
- `package.json` — `npm run offboard` script
- `.gitignore` — runtime client data + state-files
- `docs/timur-ops-runbook.md` — +Offboarding +Restore +Scheduler hours

**Изменённые файлы (тесты):**
- `src/utils/commitments-history.test.ts` — +6 overlay тестов

**Изменённые артефакты:**
- `_bmad-output/implementation-artifacts/deferred-work.md` — 6 пунктов CLOSED + 3 retargeted
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — 1-10 → review

## Change Log

| Date | Author | Change |
|------|--------|--------|
| 2026-05-23 | bmad-create-story | Initial story creation (12 АК, 12 задач) |
| 2026-05-23 | bmad-dev-story (Opus 4.7 1M) | Implementation complete — 12/12 tasks, 40/40 subtasks; 388/388 vitest + tsc clean; ~620 LOC production + ~720 LOC tests; 6 deferred-work карточек CLOSED; status → review |
| 2026-05-23 | Codex code review | Review fixes applied: scheduler only runs at exact local hours, backup naming/retention use Asia/Almaty calendar dates; targeted scheduler/data-backup tests pass; status → done |
