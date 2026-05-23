import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BackupError,
  runDailyBackup,
  _internal,
  type ExecTarResult,
} from './data-backup.js';

const DAY = 86_400_000;
const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

beforeEach(() => {
  silentLogger.info.mockReset();
  silentLogger.warn.mockReset();
  silentLogger.error.mockReset();
});

describe('runDailyBackup', () => {
  let root: string;
  let archiveDir: string;
  const NOW = new Date('2026-05-23T04:00:00Z');

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'backup-root-'));
    archiveDir = join(root, '.backups');
    await fs.mkdir(join(root, 'geonline', '2026-05-22'), { recursive: true });
    await fs.writeFile(join(root, 'geonline', '2026-05-22', 'fake.json'), '{}');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('invokes tar with -czf, EXCLUDES, and -C rootDir .', async () => {
    let receivedArgs: string[] | null = null;
    const execTar = async (args: string[]): Promise<ExecTarResult> => {
      receivedArgs = args;
      // Simulate tar creating the archive file.
      await fs.writeFile(args[1]!, Buffer.from('fakegz'));
      return { code: 0, stderr: '' };
    };

    const result = await runDailyBackup({
      rootDir: root,
      archiveDir,
      retainDays: 7,
      now: NOW,
      logger: silentLogger,
      timeZone: 'Asia/Almaty',
      execTar,
    });

    expect(receivedArgs).not.toBeNull();
    expect(receivedArgs![0]).toBe('-czf');
    expect(receivedArgs![1]).toBe(join(archiveDir, 'data-backup-2026-05-23.tar.gz'));
    // Verify all EXCLUDES present.
    for (const e of _internal.EXCLUDES) {
      const idx = receivedArgs!.indexOf(e);
      expect(idx).toBeGreaterThan(0);
      expect(receivedArgs![idx - 1]).toBe('--exclude');
    }
    // Last two args: -C rootDir .
    expect(receivedArgs![receivedArgs!.length - 3]).toBe('-C');
    expect(receivedArgs![receivedArgs!.length - 2]).toBe(root);
    expect(receivedArgs![receivedArgs!.length - 1]).toBe('.');

    expect(result.archivePath).toBe(join(archiveDir, 'data-backup-2026-05-23.tar.gz'));
    expect(result.sizeBytes).toBe(6);
    expect(result.pruned).toEqual([]);
  });

  it('creates archiveDir if missing', async () => {
    await fs.rm(archiveDir, { recursive: true, force: true });
    const execTar = async (args: string[]): Promise<ExecTarResult> => {
      await fs.writeFile(args[1]!, 'gz');
      return { code: 0, stderr: '' };
    };
    await runDailyBackup({
      rootDir: root, archiveDir, retainDays: 7, now: NOW, logger: silentLogger, execTar,
    });
    await expect(fs.stat(archiveDir)).resolves.toBeTruthy();
  });

  it('throws BackupError(tar_exit_nonzero) on tar failure', async () => {
    const execTar = async (): Promise<ExecTarResult> => ({ code: 2, stderr: 'disk full' });
    await expect(
      runDailyBackup({
        rootDir: root, archiveDir, retainDays: 7, now: NOW, logger: silentLogger, execTar,
      }),
    ).rejects.toBeInstanceOf(BackupError);
    expect(silentLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'data.backup.tar_failed', code: 2 }),
      expect.any(String),
    );
  });

  it('does NOT prune when tar fails (prune runs only after successful create)', async () => {
    await fs.mkdir(archiveDir, { recursive: true });
    const oldBackup = join(archiveDir, 'data-backup-2020-01-01.tar.gz');
    await fs.writeFile(oldBackup, 'old');

    const execTar = async (): Promise<ExecTarResult> => ({ code: 1, stderr: 'tar err' });

    await expect(
      runDailyBackup({
        rootDir: root, archiveDir, retainDays: 7, now: NOW, logger: silentLogger, execTar,
      }),
    ).rejects.toBeInstanceOf(BackupError);

    await expect(fs.stat(oldBackup)).resolves.toBeTruthy();
  });

  it('prunes backups older than retainDays', async () => {
    await fs.mkdir(archiveDir, { recursive: true });
    // Create 13 backup files spanning 2026-05-10..2026-05-22.
    const days = Array.from({ length: 13 }, (_, i) => {
      const d = new Date('2026-05-10T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + i);
      return d.toISOString().slice(0, 10);
    });
    for (const day of days) {
      await fs.writeFile(join(archiveDir, `data-backup-${day}.tar.gz`), 'x');
    }

    const execTar = async (args: string[]): Promise<ExecTarResult> => {
      await fs.writeFile(args[1]!, 'today');
      return { code: 0, stderr: '' };
    };

    const result = await runDailyBackup({
      rootDir: root,
      archiveDir,
      retainDays: 7,
      now: NOW,
      logger: silentLogger,
      timeZone: 'Asia/Almaty',
      execTar,
    });

    const expectedPruned = [
      'data-backup-2026-05-10.tar.gz',
      'data-backup-2026-05-11.tar.gz',
      'data-backup-2026-05-12.tar.gz',
      'data-backup-2026-05-13.tar.gz',
      'data-backup-2026-05-14.tar.gz',
      'data-backup-2026-05-15.tar.gz',
    ];
    expect(result.pruned.sort()).toEqual(expectedPruned.sort());
    // 2026-05-16..2026-05-23 (retainDays + today) remain.
    const remaining = await fs.readdir(archiveDir);
    expect(remaining.sort()).toEqual([
      'data-backup-2026-05-16.tar.gz',
      'data-backup-2026-05-17.tar.gz',
      'data-backup-2026-05-18.tar.gz',
      'data-backup-2026-05-19.tar.gz',
      'data-backup-2026-05-20.tar.gz',
      'data-backup-2026-05-21.tar.gz',
      'data-backup-2026-05-22.tar.gz',
      'data-backup-2026-05-23.tar.gz',
    ]);
  });

  it('ignores non-matching files during prune (e.g. README)', async () => {
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(join(archiveDir, 'README.txt'), 'do not delete');
    const execTar = async (args: string[]): Promise<ExecTarResult> => {
      await fs.writeFile(args[1]!, 'x');
      return { code: 0, stderr: '' };
    };
    await runDailyBackup({
      rootDir: root, archiveDir, retainDays: 7, now: NOW, logger: silentLogger, execTar,
    });
    await expect(fs.stat(join(archiveDir, 'README.txt'))).resolves.toBeTruthy();
  });

  it('wraps spawn error in BackupError(tar_spawn_failed)', async () => {
    const execTar = async (): Promise<ExecTarResult> => {
      throw new Error('ENOENT: tar not found');
    };
    try {
      await runDailyBackup({
        rootDir: root, archiveDir, retainDays: 7, now: NOW, logger: silentLogger, execTar,
      });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(BackupError);
      expect((err as BackupError).reason).toBe('tar_spawn_failed');
    }
  });

  it('uses configured timezone date for archive naming', async () => {
    const execTar = async (args: string[]): Promise<ExecTarResult> => {
      await fs.writeFile(args[1]!, 'gz');
      return { code: 0, stderr: '' };
    };
    const result = await runDailyBackup({
      rootDir: root, archiveDir, retainDays: 7,
      now: new Date('2026-05-23T04:00:00+05:00'),
      logger: silentLogger, execTar, timeZone: 'Asia/Almaty',
    });
    expect(result.archivePath.endsWith('data-backup-2026-05-23.tar.gz')).toBe(true);
  });
});
