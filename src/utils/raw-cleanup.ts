import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { logger as rootLogger, type Logger } from '../logger.js';

export interface CleanupRawFilesOpts {
  rootDir: string;
  maxAgeDays: number;
  now?: Date;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export interface CleanupRawFilesResult {
  deleted: number;
  skipped: number;
  errors: number;
}

const IGNORE_TOP_DIRS = new Set([
  'test-audio',
  'golden',
  'soniox-results',
  'prompt-results',
  'test-inputs',
  '.backups',
  // Story 7.1: черновики онбординга data/.onboarding/*.json — не клиентские данные
  // и не *.raw.txt, cleanup их и так не тронет; в ignore для явности и без лишнего readdir.
  '.onboarding',
  // Story 1.11: canary runs may persist *.raw.txt under each item-N subdir;
  // those artifacts are the source of truth for post-mortem and must not be
  // pruned by the daily cleanup scheduler.
  'canary-results',
]);
const IGNORE_PREFIXES = ['week-'];
const RAW_SUFFIX = '.raw.txt';
const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Recursively scans `{rootDir}/{client}/{YYYY-MM-DD}/` and removes files matching
 * `*.raw.txt` older than `maxAgeDays`. Never touches `.json`, `approvals.jsonl`,
 * or infrastructure state files; skips ignore-listed top dirs entirely.
 */
export async function cleanupRawFiles(
  opts: CleanupRawFilesOpts,
): Promise<CleanupRawFilesResult> {
  const log = opts.logger ?? rootLogger;
  const now = opts.now ?? new Date();
  const cutoffMs = now.getTime() - opts.maxAgeDays * 86_400_000;
  const result: CleanupRawFilesResult = { deleted: 0, skipped: 0, errors: 0 };

  let topEntries: import('node:fs').Dirent[];
  try {
    topEntries = await fs.readdir(opts.rootDir, { withFileTypes: true });
  } catch (err) {
    log.warn(
      { err, step: 'data.raw_cleanup.readdir_failed', rootDir: opts.rootDir },
      'cleanup readdir failed',
    );
    return result;
  }

  for (const top of topEntries) {
    if (!top.isDirectory()) continue;
    if (top.name.startsWith('.')) continue;
    if (IGNORE_TOP_DIRS.has(top.name)) continue;
    if (IGNORE_PREFIXES.some((p) => top.name.startsWith(p))) continue;
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
    log.warn(
      { err, step: 'data.raw_cleanup.client_readdir_failed', clientDir },
      'client dir readdir failed',
    );
    return;
  }
  for (const date of dateEntries) {
    if (!date.isDirectory()) continue;
    if (!DATE_DIR_RE.test(date.name)) continue;
    const dateDir = join(clientDir, date.name);
    let files: string[];
    try {
      files = await fs.readdir(dateDir);
    } catch (err) {
      log.warn(
        { err, step: 'data.raw_cleanup.date_readdir_failed', dateDir },
        'date dir readdir failed',
      );
      continue;
    }
    for (const fname of files) {
      if (!fname.endsWith(RAW_SUFFIX)) continue;
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
        log.warn(
          { err, step: 'data.raw_cleanup.file_failed', fpath },
          'cleanup file failed',
        );
      }
    }
  }
}
