import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRawFiles } from './raw-cleanup.js';

const DAY = 86_400_000;

async function makeFile(path: string, content: string, mtimeMs: number): Promise<void> {
  await fs.mkdir(join(path, '..'), { recursive: true });
  await fs.writeFile(path, content);
  const t = new Date(mtimeMs);
  await fs.utimes(path, t, t);
}

describe('cleanupRawFiles', () => {
  let root: string;
  const NOW = new Date('2026-05-23T03:00:00Z');
  const silentLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'raw-cleanup-'));
    silentLogger.info.mockReset();
    silentLogger.warn.mockReset();
    silentLogger.error.mockReset();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('deletes .raw.txt older than maxAgeDays', async () => {
    const old = join(root, 'geonline', '2026-05-01', 'f1-zhanel-abc.extraction.raw.txt');
    await makeFile(old, 'old', NOW.getTime() - 22 * DAY);
    const result = await cleanupRawFiles({
      rootDir: root, maxAgeDays: 14, now: NOW, logger: silentLogger,
    });
    expect(result.deleted).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
    await expect(fs.stat(old)).rejects.toThrow();
  });

  it('keeps .raw.txt within maxAgeDays', async () => {
    const recent = join(root, 'geonline', '2026-05-15', 'f1-alex-def.analysis.raw.txt');
    await makeFile(recent, 'fresh', NOW.getTime() - 8 * DAY);
    const result = await cleanupRawFiles({
      rootDir: root, maxAgeDays: 14, now: NOW, logger: silentLogger,
    });
    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe(1);
    await expect(fs.stat(recent)).resolves.toBeTruthy();
  });

  it('never deletes .json files even if old', async () => {
    const json = join(root, 'geonline', '2026-05-01', 'f1-zhanel-abc.extraction.json');
    await makeFile(json, '{}', NOW.getTime() - 100 * DAY);
    const result = await cleanupRawFiles({
      rootDir: root, maxAgeDays: 14, now: NOW, logger: silentLogger,
    });
    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe(0);
    await expect(fs.stat(json)).resolves.toBeTruthy();
  });

  it('mixed scenario: deletes only old .raw.txt; keeps recent, keeps json', async () => {
    const oldRaw = join(root, 'geonline', '2026-05-01', 'f1-z.extraction.raw.txt');
    const newRaw = join(root, 'geonline', '2026-05-15', 'f1-a.analysis.raw.txt');
    const veryNewRaw = join(root, 'geonline', '2026-05-22', 'f1-m.format.raw.txt');
    const oldJson = join(root, 'geonline', '2026-05-01', 'f1-z.extraction.json');
    await makeFile(oldRaw, 'x', NOW.getTime() - 22 * DAY);
    await makeFile(newRaw, 'x', NOW.getTime() - 8 * DAY);
    await makeFile(veryNewRaw, 'x', NOW.getTime() - 1 * DAY);
    await makeFile(oldJson, '{}', NOW.getTime() - 22 * DAY);

    const result = await cleanupRawFiles({
      rootDir: root, maxAgeDays: 14, now: NOW, logger: silentLogger,
    });

    expect(result).toEqual({ deleted: 1, skipped: 2, errors: 0 });
    await expect(fs.stat(oldRaw)).rejects.toThrow();
    await expect(fs.stat(newRaw)).resolves.toBeTruthy();
    await expect(fs.stat(veryNewRaw)).resolves.toBeTruthy();
    await expect(fs.stat(oldJson)).resolves.toBeTruthy();
  });

  it('ignores test-audio, golden, soniox-results, prompt-results, test-inputs', async () => {
    const dirs = ['test-audio', 'golden', 'soniox-results', 'prompt-results', 'test-inputs'];
    for (const d of dirs) {
      const f = join(root, d, '2026-05-01', 'fixture.raw.txt');
      await makeFile(f, 'x', NOW.getTime() - 500 * DAY);
    }
    const result = await cleanupRawFiles({
      rootDir: root, maxAgeDays: 14, now: NOW, logger: silentLogger,
    });
    expect(result.deleted).toBe(0);
    for (const d of dirs) {
      await expect(fs.stat(join(root, d, '2026-05-01', 'fixture.raw.txt'))).resolves.toBeTruthy();
    }
  });

  it('ignores week-* prefixed dirs', async () => {
    const f = join(root, 'week-2025-12-01', '2026-05-01', 'fixture.raw.txt');
    await makeFile(f, 'x', NOW.getTime() - 500 * DAY);
    const result = await cleanupRawFiles({
      rootDir: root, maxAgeDays: 14, now: NOW, logger: silentLogger,
    });
    expect(result.deleted).toBe(0);
    await expect(fs.stat(f)).resolves.toBeTruthy();
  });

  it('ignores top-level dot-prefixed dirs (.backups)', async () => {
    const f = join(root, '.backups', '2026-05-01', 'inside.raw.txt');
    await makeFile(f, 'x', NOW.getTime() - 500 * DAY);
    const result = await cleanupRawFiles({
      rootDir: root, maxAgeDays: 14, now: NOW, logger: silentLogger,
    });
    expect(result.deleted).toBe(0);
    await expect(fs.stat(f)).resolves.toBeTruthy();
  });

  it('skips date dirs not matching YYYY-MM-DD pattern', async () => {
    const bad = join(root, 'geonline', 'not-a-date', 'f1.raw.txt');
    await makeFile(bad, 'x', NOW.getTime() - 500 * DAY);
    const result = await cleanupRawFiles({
      rootDir: root, maxAgeDays: 14, now: NOW, logger: silentLogger,
    });
    expect(result.deleted).toBe(0);
    await expect(fs.stat(bad)).resolves.toBeTruthy();
  });

  it('returns 0/0/0 for empty rootDir', async () => {
    const result = await cleanupRawFiles({
      rootDir: root, maxAgeDays: 14, now: NOW, logger: silentLogger,
    });
    expect(result).toEqual({ deleted: 0, skipped: 0, errors: 0 });
  });

  it('returns 0/0/0 and warns if rootDir does not exist', async () => {
    const missing = join(root, 'does-not-exist');
    const result = await cleanupRawFiles({
      rootDir: missing, maxAgeDays: 14, now: NOW, logger: silentLogger,
    });
    expect(result).toEqual({ deleted: 0, skipped: 0, errors: 0 });
    expect(silentLogger.warn).toHaveBeenCalled();
  });

  it('counts errors when unlink fails (EACCES simulation)', async () => {
    const f = join(root, 'geonline', '2026-05-01', 'unwritable.raw.txt');
    await makeFile(f, 'x', NOW.getTime() - 22 * DAY);
    const spy = vi.spyOn(fs, 'unlink').mockRejectedValueOnce(
      Object.assign(new Error('EACCES'), { code: 'EACCES' }),
    );
    try {
      const result = await cleanupRawFiles({
        rootDir: root, maxAgeDays: 14, now: NOW, logger: silentLogger,
      });
      expect(result.errors).toBe(1);
      expect(result.deleted).toBe(0);
      expect(silentLogger.warn).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('continues to next file after one error', async () => {
    const f1 = join(root, 'geonline', '2026-05-01', 'one.raw.txt');
    const f2 = join(root, 'geonline', '2026-05-01', 'two.raw.txt');
    await makeFile(f1, 'x', NOW.getTime() - 22 * DAY);
    await makeFile(f2, 'x', NOW.getTime() - 22 * DAY);

    const realUnlink = fs.unlink.bind(fs);
    const spy = vi.spyOn(fs, 'unlink').mockImplementationOnce(
      async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    ).mockImplementationOnce(async (p) => realUnlink(p));
    try {
      const result = await cleanupRawFiles({
        rootDir: root, maxAgeDays: 14, now: NOW, logger: silentLogger,
      });
      expect(result.errors).toBe(1);
      expect(result.deleted).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
