import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startScheduler } from './scheduler.js';
import * as ops from './ops.js';

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

let cleanupSpy: ReturnType<typeof vi.fn>;
let backupSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  silentLogger.info.mockReset();
  silentLogger.warn.mockReset();
  silentLogger.error.mockReset();
  cleanupSpy = vi.fn(async () => ({ deleted: 0, skipped: 0, errors: 0 }));
  backupSpy = vi.fn(async () => ({
    archivePath: '/tmp/x.tar.gz',
    sizeBytes: 100,
    pruned: [],
  }));
});

function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

async function tmpStatePath(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'sched-state-'));
  return join(dir, '.scheduler-state.json');
}

describe('startScheduler', () => {
  let statePath: string;

  beforeEach(async () => {
    statePath = await tmpStatePath();
  });

  afterEach(async () => {
    await fs.rm(join(statePath, '..'), { recursive: true, force: true });
  });

  it('runs cleanup at cleanupHour when never run before', async () => {
    const handle = await startScheduler({
      dataRoot: 'data',
      archiveDir: 'data/.backups',
      rawMaxAgeDays: 14,
      backupRetainDays: 7,
      tickIntervalMs: 10_000_000, // never auto-fire
      cleanupHourLocal: 3,
      backupHourLocal: 4,
      now: fixedNow('2026-05-23T03:00:00+05:00'), // 03:00 Almaty (= -02:00 UTC offset is +05)
      logger: silentLogger,
      statePath,
      cleanupRawFilesImpl: cleanupSpy,
      runDailyBackupImpl: backupSpy,
      runImmediateTick: false,
      tz: 'Asia/Almaty',
    });
    try {
      await handle._runTick();
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
      expect(backupSpy).not.toHaveBeenCalled();
      const persisted = JSON.parse(await fs.readFile(statePath, 'utf8')) as {
        lastCleanupAt: string | null;
      };
      expect(persisted.lastCleanupAt).not.toBeNull();
    } finally {
      handle.stop();
    }
  });

  it('does NOT re-run cleanup within the same day', async () => {
    const handle = await startScheduler({
      dataRoot: 'data',
      archiveDir: 'data/.backups',
      rawMaxAgeDays: 14,
      backupRetainDays: 7,
      tickIntervalMs: 10_000_000,
      cleanupHourLocal: 3,
      backupHourLocal: 4,
      now: fixedNow('2026-05-23T03:00:00+05:00'),
      logger: silentLogger,
      statePath,
      cleanupRawFilesImpl: cleanupSpy,
      runDailyBackupImpl: backupSpy,
      runImmediateTick: false,
      tz: 'Asia/Almaty',
    });
    try {
      await handle._runTick();
      await handle._runTick();
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
    } finally {
      handle.stop();
    }
  });

  it('runs backup at backupHour but skips cleanup if already done today', async () => {
    // Seed state as if cleanup already ran today.
    await fs.mkdir(join(statePath, '..'), { recursive: true });
    await fs.writeFile(
      statePath,
      JSON.stringify({ lastCleanupAt: '2026-05-23T03:00:00+05:00', lastBackupAt: null }),
    );
    const handle = await startScheduler({
      dataRoot: 'data',
      archiveDir: 'data/.backups',
      rawMaxAgeDays: 14,
      backupRetainDays: 7,
      tickIntervalMs: 10_000_000,
      cleanupHourLocal: 3,
      backupHourLocal: 4,
      now: fixedNow('2026-05-23T04:00:00+05:00'),
      logger: silentLogger,
      statePath,
      cleanupRawFilesImpl: cleanupSpy,
      runDailyBackupImpl: backupSpy,
      runImmediateTick: false,
      tz: 'Asia/Almaty',
    });
    try {
      await handle._runTick();
      expect(cleanupSpy).not.toHaveBeenCalled();
      expect(backupSpy).toHaveBeenCalledTimes(1);
    } finally {
      handle.stop();
    }
  });

  it('cleanup failure → alertOps, state NOT updated', async () => {
    cleanupSpy = vi.fn(async () => {
      throw new Error('disk full');
    });
    const alertSpy = vi.spyOn(ops, 'alertOps').mockImplementation(() => {});
    try {
      const handle = await startScheduler({
        dataRoot: 'data',
        archiveDir: 'data/.backups',
        rawMaxAgeDays: 14,
        backupRetainDays: 7,
        tickIntervalMs: 10_000_000,
        cleanupHourLocal: 3,
        backupHourLocal: 4,
        now: fixedNow('2026-05-23T03:00:00+05:00'),
        logger: silentLogger,
        statePath,
        cleanupRawFilesImpl: cleanupSpy,
        runDailyBackupImpl: backupSpy,
        runImmediateTick: false,
        tz: 'Asia/Almaty',
      });
      try {
        await handle._runTick();
        expect(alertSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            pipeline: 'OPS',
            step: 'scheduler.cleanup_failed',
          }),
        );
        // state file should NOT exist (saveState only runs on success).
        await expect(fs.stat(statePath)).rejects.toThrow();
      } finally {
        handle.stop();
      }
    } finally {
      alertSpy.mockRestore();
    }
  });

  it('backup failure → alertOps, state NOT updated', async () => {
    backupSpy = vi.fn(async () => {
      throw new Error('tar broken');
    });
    const alertSpy = vi.spyOn(ops, 'alertOps').mockImplementation(() => {});
    try {
      const handle = await startScheduler({
        dataRoot: 'data',
        archiveDir: 'data/.backups',
        rawMaxAgeDays: 14,
        backupRetainDays: 7,
        tickIntervalMs: 10_000_000,
        cleanupHourLocal: 3,
        backupHourLocal: 4,
        now: fixedNow('2026-05-23T04:00:00+05:00'),
        logger: silentLogger,
        statePath,
        cleanupRawFilesImpl: cleanupSpy,
        runDailyBackupImpl: backupSpy,
        runImmediateTick: false,
        tz: 'Asia/Almaty',
      });
      try {
        await handle._runTick();
        expect(alertSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            pipeline: 'OPS',
            step: 'scheduler.backup_failed',
          }),
        );
      } finally {
        handle.stop();
      }
    } finally {
      alertSpy.mockRestore();
    }
  });

  it('after restart, skips already-done cleanup but runs pending backup', async () => {
    // Phase 1: cleanup runs at 03:00.
    const handle1 = await startScheduler({
      dataRoot: 'data',
      archiveDir: 'data/.backups',
      rawMaxAgeDays: 14,
      backupRetainDays: 7,
      tickIntervalMs: 10_000_000,
      cleanupHourLocal: 3,
      backupHourLocal: 4,
      now: fixedNow('2026-05-23T03:00:00+05:00'),
      logger: silentLogger,
      statePath,
      cleanupRawFilesImpl: cleanupSpy,
      runDailyBackupImpl: backupSpy,
      runImmediateTick: false,
      tz: 'Asia/Almaty',
    });
    await handle1._runTick();
    handle1.stop();
    expect(cleanupSpy).toHaveBeenCalledTimes(1);

    // Phase 2: process restarted at 04:00 — fresh scheduler reads persisted state.
    const handle2 = await startScheduler({
      dataRoot: 'data',
      archiveDir: 'data/.backups',
      rawMaxAgeDays: 14,
      backupRetainDays: 7,
      tickIntervalMs: 10_000_000,
      cleanupHourLocal: 3,
      backupHourLocal: 4,
      now: fixedNow('2026-05-23T04:00:00+05:00'),
      logger: silentLogger,
      statePath,
      cleanupRawFilesImpl: cleanupSpy,
      runDailyBackupImpl: backupSpy,
      runImmediateTick: false,
      tz: 'Asia/Almaty',
    });
    try {
      await handle2._runTick();
      expect(cleanupSpy).toHaveBeenCalledTimes(1); // unchanged
      expect(backupSpy).toHaveBeenCalledTimes(1);
    } finally {
      handle2.stop();
    }
  });

  it('invalid state file → warns and starts fresh', async () => {
    await fs.mkdir(join(statePath, '..'), { recursive: true });
    await fs.writeFile(statePath, '{ not json');
    const handle = await startScheduler({
      dataRoot: 'data',
      archiveDir: 'data/.backups',
      rawMaxAgeDays: 14,
      backupRetainDays: 7,
      tickIntervalMs: 10_000_000,
      cleanupHourLocal: 3,
      backupHourLocal: 4,
      now: fixedNow('2026-05-23T03:00:00+05:00'),
      logger: silentLogger,
      statePath,
      cleanupRawFilesImpl: cleanupSpy,
      runDailyBackupImpl: backupSpy,
      runImmediateTick: false,
      tz: 'Asia/Almaty',
    });
    try {
      expect(silentLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ step: 'scheduler.state.load_failed' }),
        expect.any(String),
      );
      await handle._runTick();
      expect(cleanupSpy).toHaveBeenCalledTimes(1);
    } finally {
      handle.stop();
    }
  });

  it('before cleanup hour: nothing runs', async () => {
    const handle = await startScheduler({
      dataRoot: 'data',
      archiveDir: 'data/.backups',
      rawMaxAgeDays: 14,
      backupRetainDays: 7,
      tickIntervalMs: 10_000_000,
      cleanupHourLocal: 3,
      backupHourLocal: 4,
      now: fixedNow('2026-05-23T02:30:00+05:00'),
      logger: silentLogger,
      statePath,
      cleanupRawFilesImpl: cleanupSpy,
      runDailyBackupImpl: backupSpy,
      runImmediateTick: false,
      tz: 'Asia/Almaty',
    });
    try {
      await handle._runTick();
      expect(cleanupSpy).not.toHaveBeenCalled();
      expect(backupSpy).not.toHaveBeenCalled();
    } finally {
      handle.stop();
    }
  });

  it('after configured hours without prior state: does not run missed jobs', async () => {
    const handle = await startScheduler({
      dataRoot: 'data',
      archiveDir: 'data/.backups',
      rawMaxAgeDays: 14,
      backupRetainDays: 7,
      tickIntervalMs: 10_000_000,
      cleanupHourLocal: 3,
      backupHourLocal: 4,
      now: fixedNow('2026-05-23T10:00:00+05:00'),
      logger: silentLogger,
      statePath,
      cleanupRawFilesImpl: cleanupSpy,
      runDailyBackupImpl: backupSpy,
      runImmediateTick: false,
      tz: 'Asia/Almaty',
    });
    try {
      await handle._runTick();
      expect(cleanupSpy).not.toHaveBeenCalled();
      expect(backupSpy).not.toHaveBeenCalled();
    } finally {
      handle.stop();
    }
  });
});
