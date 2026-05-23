import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { logger as rootLogger, type Logger } from '../logger.js';

export type BackupErrorReason =
  | 'tar_exit_nonzero'
  | 'archive_dir_failed'
  | 'tar_spawn_failed';

export class BackupError extends Error {
  public readonly reason: BackupErrorReason;

  constructor(reason: BackupErrorReason, cause?: unknown) {
    super(`BackupError:${reason}`);
    this.name = 'BackupError';
    this.reason = reason;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export interface ExecTarResult {
  code: number;
  stderr: string;
}

export interface RunDailyBackupOpts {
  rootDir: string;
  archiveDir: string;
  retainDays: number;
  now?: Date;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Timezone for archive naming and calendar-day retention. Defaults to config.TZ. */
  timeZone?: string;
  /** Test override: replace child_process.spawn('tar', args). */
  execTar?: (args: string[]) => Promise<ExecTarResult>;
}

export interface RunDailyBackupResult {
  archivePath: string;
  sizeBytes: number;
  pruned: string[];
}

const EXCLUDES = [
  '*.raw.txt',
  'test-audio',
  'golden',
  'soniox-results',
  'prompt-results',
  'test-inputs',
  'week-*',
  '.backups',
];

const PRUNE_PATTERN = /^data-backup-(\d{4}-\d{2}-\d{2})\.tar\.gz$/;
const DEFAULT_TIME_ZONE = 'Asia/Almaty';

function formatDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);
}

function subtractCalendarDays(dateStr: string, days: number): string {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(year!, month! - 1, day!));
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Build `data-backup-{date}.tar.gz` from `rootDir`, then prune backups older than
 * `retainDays`. Throws BackupError on tar failure; prune runs only after a
 * successful archive so the most-recent backup is never the one removed.
 */
export async function runDailyBackup(
  opts: RunDailyBackupOpts,
): Promise<RunDailyBackupResult> {
  const log = opts.logger ?? rootLogger;
  const now = opts.now ?? new Date();
  const timeZone = opts.timeZone ?? DEFAULT_TIME_ZONE;
  const dateStr = formatDate(now, timeZone);
  const archivePath = join(opts.archiveDir, `data-backup-${dateStr}.tar.gz`);

  try {
    await fs.mkdir(opts.archiveDir, { recursive: true });
  } catch (err) {
    throw new BackupError('archive_dir_failed', err);
  }

  const args = [
    '-czf', archivePath,
    ...EXCLUDES.flatMap((e) => ['--exclude', e]),
    '-C', opts.rootDir, '.',
  ];

  const exec = opts.execTar ?? defaultExecTar;
  let result: ExecTarResult;
  try {
    result = await exec(args);
  } catch (err) {
    throw new BackupError('tar_spawn_failed', err);
  }
  if (result.code !== 0) {
    log.error(
      { step: 'data.backup.tar_failed', code: result.code, stderr: result.stderr.slice(0, 1000) },
      'tar failed',
    );
    throw new BackupError('tar_exit_nonzero', new Error(result.stderr));
  }

  const stat = await fs.stat(archivePath);
  const sizeBytes = stat.size;
  const pruned = await pruneOldBackups(opts.archiveDir, opts.retainDays, dateStr, log);

  log.info(
    {
      step: 'data.backup.completed',
      archivePath,
      sizeBytes,
      prunedCount: pruned.length,
    },
    'backup done',
  );
  return { archivePath, sizeBytes, pruned };
}

function defaultExecTar(args: string[]): Promise<ExecTarResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

async function pruneOldBackups(
  archiveDir: string,
  retainDays: number,
  today: string,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<string[]> {
  const cutoffDate = subtractCalendarDays(today, retainDays);
  let files: string[];
  try {
    files = await fs.readdir(archiveDir);
  } catch (err) {
    log.warn({ err, step: 'data.backup.prune_readdir_failed' }, 'prune readdir failed');
    return [];
  }
  const pruned: string[] = [];
  for (const fname of files) {
    const m = PRUNE_PATTERN.exec(fname);
    if (!m) continue;
    if (m[1]! >= cutoffDate) continue;
    try {
      await fs.unlink(join(archiveDir, fname));
      pruned.push(fname);
    } catch (err) {
      log.warn(
        { err, step: 'data.backup.prune_file_failed', file: fname },
        'prune file failed',
      );
    }
  }
  return pruned;
}

/** Test-only access to internal constants. */
export const _internal = { EXCLUDES, PRUNE_PATTERN, DEFAULT_TIME_ZONE, formatDate, subtractCalendarDays };
