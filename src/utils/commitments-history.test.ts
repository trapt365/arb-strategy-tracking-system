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
