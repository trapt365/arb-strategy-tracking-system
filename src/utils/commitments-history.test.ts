import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadOpenCommitments, topNameSlug } from './commitments-history.js';
import type { ExtractionOutput } from '../types.js';

let root: string;

const SAMPLE: ExtractionOutput = {
  decisions: [],
  commitments: [],
  citations: [],
  facts: [],
  speaker_check: [],
};

async function writeExtraction(
  clientId: string,
  date: string,
  topSlug: string,
  shortId: string,
  body: ExtractionOutput,
): Promise<string> {
  const dir = join(root, clientId, date);
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, `f1-${topSlug}-${shortId}.extraction.json`);
  await fs.writeFile(path, JSON.stringify(body, null, 2), 'utf8');
  return path;
}

describe('topNameSlug', () => {
  it('lowercases and dashifies', () => {
    expect(topNameSlug('Жанель Иванова')).toBe('жанель-иванова');
  });

  it('strips reserved filename chars', () => {
    expect(topNameSlug('a/b\\c?d:e')).toBe('a_b_c_d_e');
  });
});

describe('loadOpenCommitments', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'commits-test-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('returns empty when client dir does not exist', async () => {
    const res = await loadOpenCommitments('unknown', 'Жанель', { rootDir: root });
    expect(res.openCommitments).toEqual([]);
    expect(res.sourceFiles).toEqual([]);
  });

  it('returns commitments without status as open', async () => {
    await writeExtraction('geonline', '2026-04-15', 'жанель', 'aaaaaaaa', {
      ...SAMPLE,
      commitments: [
        { who: 'Жанель', what: 'подготовить отчёт', deadline: 'до пятницы', quote: '[01:23] ...' },
        { who: 'Жанель', what: 'выслать KPI', deadline: 'не указан', quote: '[02:00] ...' },
      ],
    });
    const res = await loadOpenCommitments('geonline', 'Жанель', {
      rootDir: root,
      now: new Date('2026-04-30T00:00:00Z'),
    });
    expect(res.openCommitments).toHaveLength(2);
    expect(res.sourceFiles).toHaveLength(1);
  });

  it('excludes commitments marked completed', async () => {
    await writeExtraction('geonline', '2026-04-20', 'жанель', 'bbbbbbbb', {
      ...SAMPLE,
      commitments: [
        {
          who: 'Жанель',
          what: 'done thing',
          deadline: 'до 20',
          quote: '[01:00]',
          status: 'completed',
        },
        { who: 'Жанель', what: 'open thing', deadline: 'до 25', quote: '[02:00]', status: 'open' },
      ],
    });
    const res = await loadOpenCommitments('geonline', 'Жанель', {
      rootDir: root,
      now: new Date('2026-04-30T00:00:00Z'),
    });
    expect(res.openCommitments).toHaveLength(1);
    expect(res.openCommitments[0]?.what).toBe('open thing');
  });

  it('skips dates older than maxAgeDays', async () => {
    await writeExtraction('geonline', '2025-01-01', 'жанель', 'cccccccc', {
      ...SAMPLE,
      commitments: [
        { who: 'Жанель', what: 'старое', deadline: 'давно', quote: '[01:00]' },
      ],
    });
    const res = await loadOpenCommitments('geonline', 'Жанель', {
      rootDir: root,
      maxAgeDays: 90,
      now: new Date('2026-04-30T00:00:00Z'),
    });
    expect(res.openCommitments).toHaveLength(0);
  });

  it('deduplicates by who+what+deadline keeping latest mtime', async () => {
    const oldPath = await writeExtraction('geonline', '2026-04-10', 'жанель', 'dddddddd', {
      ...SAMPLE,
      commitments: [{ who: 'Жанель', what: 'X', deadline: 'D', quote: '[01:00] old' }],
    });
    // Manually set old mtime
    const oldTime = new Date('2026-04-10T12:00:00Z');
    await fs.utimes(oldPath, oldTime, oldTime);

    const newPath = await writeExtraction('geonline', '2026-04-25', 'жанель', 'eeeeeeee', {
      ...SAMPLE,
      commitments: [{ who: 'Жанель', what: 'X', deadline: 'D', quote: '[02:00] new' }],
    });
    const newTime = new Date('2026-04-25T12:00:00Z');
    await fs.utimes(newPath, newTime, newTime);

    const res = await loadOpenCommitments('geonline', 'Жанель', {
      rootDir: root,
      now: new Date('2026-04-30T00:00:00Z'),
    });
    expect(res.openCommitments).toHaveLength(1);
    expect(res.openCommitments[0]?.quote).toContain('new');
  });

  it('does NOT resurrect a commitment closed in a newer file (latest mtime status wins)', async () => {
    // Older session opened the commitment; newer session marked it completed.
    const oldPath = await writeExtraction('geonline', '2026-04-10', 'жанель', 'aaaaaaaa', {
      ...SAMPLE,
      commitments: [
        { who: 'Жанель', what: 'X', deadline: 'D', quote: '[01:00] open earlier', status: 'open' },
      ],
    });
    const oldTime = new Date('2026-04-10T12:00:00Z');
    await fs.utimes(oldPath, oldTime, oldTime);

    const newPath = await writeExtraction('geonline', '2026-04-25', 'жанель', 'bbbbbbbb', {
      ...SAMPLE,
      commitments: [
        {
          who: 'Жанель',
          what: 'X',
          deadline: 'D',
          quote: '[02:00] later closed',
          status: 'completed',
        },
      ],
    });
    const newTime = new Date('2026-04-25T12:00:00Z');
    await fs.utimes(newPath, newTime, newTime);

    const res = await loadOpenCommitments('geonline', 'Жанель', {
      rootDir: root,
      now: new Date('2026-04-30T00:00:00Z'),
    });
    expect(res.openCommitments).toHaveLength(0);
  });

  it('skips schema-incompatible files with warning, does not throw', async () => {
    const dir = join(root, 'geonline', '2026-04-25');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'f1-жанель-ffffffff.extraction.json'),
      JSON.stringify({ legacy: true }),
      'utf8',
    );
    const log = { warn: vi.fn(), info: vi.fn() };
    const res = await loadOpenCommitments('geonline', 'Жанель', {
      rootDir: root,
      now: new Date('2026-04-30T00:00:00Z'),
      logger: log,
    });
    expect(res.openCommitments).toEqual([]);
    expect(log.warn).toHaveBeenCalled();
  });
});

// Story 1.10: commitments-updates.json overlay
async function writeOverlay(
  clientId: string,
  date: string,
  topSlug: string,
  shortId: string,
  updates: Array<{
    who: string;
    what: string;
    previous_quote: string;
    new_status: 'open' | 'completed' | 'overdue';
    evidence_quote?: string;
  }>,
): Promise<string> {
  const dir = join(root, clientId, date);
  await fs.mkdir(dir, { recursive: true });
  const path = join(dir, `f1-${topSlug}-${shortId}.commitments-updates.json`);
  await fs.writeFile(path, JSON.stringify({ reportId: shortId, meetingDate: date, updates, sourceFiles: [] }, null, 2), 'utf8');
  return path;
}

describe('loadOpenCommitments — overlay (Story 1.10)', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'overlay-test-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('applies overlay status=completed, excludes from open list', async () => {
    await writeExtraction('geonline', '2026-05-15', 'жанель', 'aaaaaaaa', {
      ...SAMPLE,
      commitments: [
        { who: 'Жанель', what: 'Запустить promo', deadline: '2026-05-22', quote: '[01:23] ...' },
      ],
    });
    await writeOverlay('geonline', '2026-05-22', 'жанель', 'bbbbbbbb', [
      {
        who: 'Жанель',
        what: 'Запустить promo',
        previous_quote: '[01:23] ...',
        new_status: 'completed',
      },
    ]);
    const res = await loadOpenCommitments('geonline', 'Жанель', {
      rootDir: root,
      now: new Date('2026-06-01T00:00:00Z'),
    });
    expect(res.openCommitments).toEqual([]);
  });

  it('overlay does NOT regress newer base with status=completed', async () => {
    // Newer extraction already closed it.
    const newerPath = await writeExtraction('geonline', '2026-05-22', 'жанель', 'cccccccc', {
      ...SAMPLE,
      commitments: [
        {
          who: 'Жанель',
          what: 'Запустить promo',
          deadline: '2026-05-22',
          status: 'completed',
          quote: '[01:23] ...',
        },
      ],
    });
    // Newer mtime on the extraction file.
    const future = new Date('2026-05-23T00:00:00Z');
    await fs.utimes(newerPath, future, future);
    // Older overlay (smaller mtime) attempts to mark it back as open.
    const overlayPath = await writeOverlay('geonline', '2026-05-15', 'жанель', 'dddddddd', [
      {
        who: 'Жанель',
        what: 'Запустить promo',
        previous_quote: '[01:23] ...',
        new_status: 'open',
      },
    ]);
    const older = new Date('2026-05-15T00:00:00Z');
    await fs.utimes(overlayPath, older, older);
    const res = await loadOpenCommitments('geonline', 'Жанель', {
      rootDir: root,
      now: new Date('2026-06-01T00:00:00Z'),
    });
    expect(res.openCommitments).toEqual([]);
  });

  it('skips overlay file missing updates[]', async () => {
    await writeExtraction('geonline', '2026-05-15', 'жанель', 'aaaaaaaa', {
      ...SAMPLE,
      commitments: [
        { who: 'Жанель', what: 'something', deadline: 'soon', quote: '[01:23] ...' },
      ],
    });
    const dir = join(root, 'geonline', '2026-05-22');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'f1-жанель-eeeeeeee.commitments-updates.json'),
      JSON.stringify({ foo: 'bar' }),
      'utf8',
    );
    const log = { warn: vi.fn(), info: vi.fn() };
    const res = await loadOpenCommitments('geonline', 'Жанель', {
      rootDir: root,
      now: new Date('2026-06-01T00:00:00Z'),
      logger: log,
    });
    expect(res.openCommitments).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'commitments_overlay.schema_skip' }),
      expect.any(String),
    );
  });

  it('overlay update for non-existent commitment is a no-op (does not throw)', async () => {
    await writeExtraction('geonline', '2026-05-15', 'жанель', 'aaaaaaaa', {
      ...SAMPLE,
      commitments: [
        { who: 'Жанель', what: 'X', deadline: 'soon', quote: '[01:23] ...' },
      ],
    });
    await writeOverlay('geonline', '2026-05-22', 'жанель', 'ffffffff', [
      {
        who: 'Жанель',
        what: 'unrelated commitment',
        previous_quote: '[09:99] ...',
        new_status: 'completed',
      },
    ]);
    const res = await loadOpenCommitments('geonline', 'Жанель', {
      rootDir: root,
      now: new Date('2026-06-01T00:00:00Z'),
    });
    expect(res.openCommitments).toHaveLength(1);
  });

  it('skips schema-invalid update entries but applies valid ones', async () => {
    await writeExtraction('geonline', '2026-05-15', 'жанель', 'aaaaaaaa', {
      ...SAMPLE,
      commitments: [
        { who: 'Жанель', what: 'A', deadline: 'd1', quote: '[01:23] ...' },
        { who: 'Жанель', what: 'B', deadline: 'd2', quote: '[02:00] ...' },
      ],
    });
    const dir = join(root, 'geonline', '2026-05-22');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'f1-жанель-99999999.commitments-updates.json'),
      JSON.stringify({
        updates: [
          { who: 'Жанель', what: 'A', previous_quote: '[01:23]', new_status: 'completed' },
          { who: 'invalid' }, // bad shape
        ],
      }),
      'utf8',
    );
    const log = { warn: vi.fn(), info: vi.fn() };
    const res = await loadOpenCommitments('geonline', 'Жанель', {
      rootDir: root,
      now: new Date('2026-06-01T00:00:00Z'),
      logger: log,
    });
    expect(res.openCommitments).toHaveLength(1);
    expect(res.openCommitments[0]!.what).toBe('B');
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ step: 'commitments_overlay.update_invalid' }),
      expect.any(String),
    );
  });

  it('without any overlay files, behavior is unchanged (regression)', async () => {
    await writeExtraction('geonline', '2026-05-15', 'жанель', 'aaaaaaaa', {
      ...SAMPLE,
      commitments: [
        { who: 'Жанель', what: 'still open', deadline: 'd', quote: '[01:23] ...' },
      ],
    });
    const res = await loadOpenCommitments('geonline', 'Жанель', {
      rootDir: root,
      now: new Date('2026-06-01T00:00:00Z'),
    });
    expect(res.openCommitments).toHaveLength(1);
  });
});
