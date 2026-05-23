import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { logger as rootLogger, type Logger } from './logger.js';
import { cleanupRawFiles } from './utils/raw-cleanup.js';
import { runDailyBackup } from './utils/data-backup.js';
import { alertOps, recordOpsEvent } from './ops.js';

export interface SchedulerState {
  lastCleanupAt: string | null;
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
  statePath?: string;
  /** Test override: replace cleanupRawFiles. */
  cleanupRawFilesImpl?: typeof cleanupRawFiles;
  /** Test override: replace runDailyBackup. */
  runDailyBackupImpl?: typeof runDailyBackup;
  /** Run an immediate tick on start (production: true). Tests usually disable. */
  runImmediateTick?: boolean;
  /** Override timezone (defaults to config.TZ — Asia/Almaty in production). */
  tz?: string;
}

export interface SchedulerHandle {
  stop: () => void;
  /** Test-only: trigger a single tick synchronously (await for completion). */
  _runTick: () => Promise<void>;
}

const DEFAULT_TICK_MS = 60 * 60_000;
const DEFAULT_CLEANUP_HOUR = 3;
const DEFAULT_BACKUP_HOUR = 4;
const DEFAULT_STATE_PATH = 'data/.scheduler-state.json';

function todayInTz(now: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
}

function hourInTz(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '0';
  // hour12:false on en-US can produce '24' for midnight; clamp to 0..23.
  const n = Number.parseInt(hour, 10);
  if (!Number.isFinite(n)) return 0;
  return n === 24 ? 0 : n;
}

async function loadState(
  path: string,
  log: Pick<Logger, 'warn'>,
): Promise<SchedulerState> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SchedulerState>;
    return {
      lastCleanupAt: typeof parsed.lastCleanupAt === 'string' ? parsed.lastCleanupAt : null,
      lastBackupAt: typeof parsed.lastBackupAt === 'string' ? parsed.lastBackupAt : null,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.warn(
        { err, step: 'scheduler.state.load_failed' },
        'scheduler state load failed; using fresh',
      );
    }
    return { lastCleanupAt: null, lastBackupAt: null };
  }
}

async function saveState(
  path: string,
  state: SchedulerState,
  log: Pick<Logger, 'warn'>,
): Promise<void> {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, path);
  } catch (err) {
    log.warn({ err, step: 'scheduler.state.save_failed' }, 'scheduler state save failed');
    try {
      await fs.unlink(tmp);
    } catch {
      // best-effort tmp cleanup
    }
  }
}

/**
 * Story 1.10: in-process scheduler for daily cleanup + tar backup.
 *
 * Uses setInterval (NOT node-cron — that's Story 3.0). Each tick checks whether
 * the local hour (in `config.TZ`) is at or past the trigger hour AND today's run
 * hasn't yet completed. State persists across restarts via atomic write+rename
 * in `data/.scheduler-state.json`.
 *
 * Errors from cleanup/backup escalate via alertOps; the scheduler itself never
 * stops on failure — next tick retries.
 */
export async function startScheduler(
  opts: StartSchedulerOpts,
): Promise<SchedulerHandle> {
  const log = opts.logger ?? rootLogger;
  const tz = opts.tz ?? config.TZ;
  const tickMs = opts.tickIntervalMs ?? DEFAULT_TICK_MS;
  const cleanupHour = opts.cleanupHourLocal ?? DEFAULT_CLEANUP_HOUR;
  const backupHour = opts.backupHourLocal ?? DEFAULT_BACKUP_HOUR;
  const getNow = opts.now ?? ((): Date => new Date());
  const statePath = opts.statePath ?? DEFAULT_STATE_PATH;
  const cleanupImpl = opts.cleanupRawFilesImpl ?? cleanupRawFiles;
  const backupImpl = opts.runDailyBackupImpl ?? runDailyBackup;

  let state = await loadState(statePath, log);

  async function tick(): Promise<void> {
    const now = getNow();
    const today = todayInTz(now, tz);
    const hr = hourInTz(now, tz);
    const lastCleanupDay = state.lastCleanupAt
      ? todayInTz(new Date(state.lastCleanupAt), tz)
      : null;
    const lastBackupDay = state.lastBackupAt
      ? todayInTz(new Date(state.lastBackupAt), tz)
      : null;

    if (hr === cleanupHour && lastCleanupDay !== today) {
      try {
        const result = await cleanupImpl({
          rootDir: opts.dataRoot,
          maxAgeDays: opts.rawMaxAgeDays,
          now,
          logger: log,
        });
        state = { ...state, lastCleanupAt: now.toISOString() };
        await saveState(statePath, state, log);
        recordOpsEvent('info', {
          pipeline: 'OPS',
          step: 'scheduler.cleanup.completed',
          status: 'ok',
          context: {
            deleted: result.deleted,
            skipped: result.skipped,
            errors: result.errors,
          },
        });
      } catch (err) {
        alertOps({
          pipeline: 'OPS',
          step: 'scheduler.cleanup_failed',
          error: err,
          context: { lastCleanupAt: state.lastCleanupAt },
        });
      }
    }

    if (hr === backupHour && lastBackupDay !== today) {
      try {
        const result = await backupImpl({
          rootDir: opts.dataRoot,
          archiveDir: opts.archiveDir,
          retainDays: opts.backupRetainDays,
          now,
          logger: log,
          timeZone: tz,
        });
        state = { ...state, lastBackupAt: now.toISOString() };
        await saveState(statePath, state, log);
        recordOpsEvent('info', {
          pipeline: 'OPS',
          step: 'scheduler.backup.completed',
          status: 'ok',
          context: {
            archivePath: result.archivePath,
            sizeBytes: result.sizeBytes,
            prunedCount: result.pruned.length,
          },
        });
      } catch (err) {
        alertOps({
          pipeline: 'OPS',
          step: 'scheduler.backup_failed',
          error: err,
          context: { lastBackupAt: state.lastBackupAt },
        });
      }
    }
  }

  // First tick on next event loop iteration (don't block startScheduler caller).
  // Tests typically disable this to drive `_runTick` deterministically.
  if (opts.runImmediateTick !== false) {
    setImmediate(() => {
      void tick().catch((err) =>
        log.error({ err, step: 'scheduler.tick_unhandled' }, 'scheduler tick unhandled'),
      );
    });
  }

  const timer = setInterval(() => {
    void tick().catch((err) =>
      log.error({ err, step: 'scheduler.tick_unhandled' }, 'scheduler tick unhandled'),
    );
  }, tickMs);
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
    _runTick: tick,
  };
}

/** Test-only exports. */
export const _internal = {
  DEFAULT_STATE_PATH,
  DEFAULT_TICK_MS,
  DEFAULT_CLEANUP_HOUR,
  DEFAULT_BACKUP_HOUR,
};
