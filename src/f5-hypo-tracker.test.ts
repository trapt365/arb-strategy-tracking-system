import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeDelta, formatHypoReport, runHypoTracker } from './f5-hypo-tracker.js';
import type { HypoSnapshotItem, HypoSnapshot } from './types.js';
import { SheetsAdapterError } from './errors.js';

// Mock the sheets adapter so pipeline tests don't need real credentials
vi.mock('./adapters/sheets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./adapters/sheets.js')>();
  return {
    ...actual,
    readHypothesesSheet: vi.fn(),
  };
});

import { readHypothesesSheet } from './adapters/sheets.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Delta — 2 changed + 1 new
// ─────────────────────────────────────────────────────────────────────────────

describe('computeDelta', () => {
  it('detects 2 changed statuses and 1 new hypothesis', () => {
    const snapshot: HypoSnapshotItem[] = [
      { statement: 'Гипотеза A', department: null, okrLink: null, status: 'идея' },
      { statement: 'Гипотеза B', department: null, okrLink: null, status: 'идея' },
    ];
    const current: HypoSnapshotItem[] = [
      { statement: 'Гипотеза A', department: null, okrLink: null, status: 'в тесте' },
      { statement: 'Гипотеза B', department: null, okrLink: null, status: 'завершена' },
      { statement: 'Гипотеза C (новая)', department: null, okrLink: null, status: 'идея' },
    ];

    const delta = computeDelta(current, snapshot);

    expect(delta.changed.length).toBe(2);
    expect(delta.added.length).toBe(1);
    expect(delta.changed[0]).toMatchObject({ statement: 'Гипотеза A', oldStatus: 'идея', newStatus: 'в тесте' });
    expect(delta.changed[1]).toMatchObject({ statement: 'Гипотеза B', oldStatus: 'идея', newStatus: 'завершена' });
    expect(delta.added[0]).toMatchObject({ statement: 'Гипотеза C (новая)', status: 'идея' });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Test 2: Delta — all match → empty delta
  // ─────────────────────────────────────────────────────────────────────────────

  it('returns empty delta when all statements and statuses match', () => {
    const items: HypoSnapshotItem[] = [
      { statement: 'Гипотеза X', department: null, okrLink: null, status: 'в тесте' },
      { statement: 'Гипотеза Y', department: 'Sales', okrLink: null, status: 'идея' },
    ];

    const delta = computeDelta(items, items);

    expect(delta.changed.length).toBe(0);
    expect(delta.added.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: First run format — no snapshot, no "Изменения" section
// ─────────────────────────────────────────────────────────────────────────────

describe('formatHypoReport', () => {
  it('first run: includes all statements, no "Изменения" section', () => {
    const rows: HypoSnapshotItem[] = [
      { statement: 'Гипотеза Альфа', department: null, okrLink: null, status: 'идея' },
      { statement: 'Гипотеза Бета', department: null, okrLink: null, status: 'в тесте' },
    ];

    const text = formatHypoReport({
      clientName: 'TestClient',
      week: 28,
      year: 2026,
      rows,
      snapshot: null,
      delta: null,
      conclusions: null,
    });

    expect(text).toContain('Гипотеза Альфа');
    expect(text).toContain('Гипотеза Бета');
    expect(text).not.toContain('Изменения');
    expect(text).toContain('нед.28/2026');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Empty sheet (rows = 0) → "Гипотезы не найдены", no snapshot update
// ─────────────────────────────────────────────────────────────────────────────

describe('runHypoTracker — empty sheet', () => {
  beforeEach(() => {
    vi.mocked(readHypothesesSheet).mockResolvedValue([]);
  });

  it('returns "Гипотезы не найдены" and does not write snapshot on first run', async () => {
    const rootDir = join(tmpdir(), `hypo-test-${Date.now()}`);

    const result = await runHypoTracker({
      clientId: 'geonline',
      deps: { now: () => new Date('2026-07-10T12:00:00Z'), rootDir },
    });

    expect(result).toBe('Гипотезы не найдены в листе _hypotheses.');

    // Snapshot should NOT have been written
    const snapshotPath = join(rootDir, 'geonline', 'hypo-snapshot.json');
    await expect(fs.access(snapshotPath)).rejects.toThrow();
  });

  it('does not overwrite an existing snapshot when sheet returns 0 rows', async () => {
    const rootDir = join(tmpdir(), `hypo-test-${Date.now()}`);
    const clientDir = join(rootDir, 'geonline');
    await fs.mkdir(clientDir, { recursive: true });

    const existingSnapshot: HypoSnapshot = {
      weekNumber: 27,
      year: 2026,
      hypotheses: [{ statement: 'Сохранить', department: null, okrLink: null, status: 'идея' }],
    };
    const snapshotPath = join(clientDir, 'hypo-snapshot.json');
    await fs.writeFile(snapshotPath, JSON.stringify(existingSnapshot), 'utf8');

    await runHypoTracker({
      clientId: 'geonline',
      deps: { now: () => new Date('2026-07-10T12:00:00Z'), rootDir },
    });

    // Existing snapshot must remain unchanged
    const content = JSON.parse(await fs.readFile(snapshotPath, 'utf8')) as HypoSnapshot;
    expect(content.weekNumber).toBe(27);
    expect(content.hypotheses).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: No-change path — snapshot exists and matches current sheet
// AC3: "Изменений за неделю нет", snapshot updated with new weekNumber
// ─────────────────────────────────────────────────────────────────────────────

describe('runHypoTracker — no changes', () => {
  it('returns "Изменений за неделю нет" and updates snapshot weekNumber', async () => {
    const rootDir = join(tmpdir(), `hypo-test-${Date.now()}`);
    const clientDir = join(rootDir, 'geonline');
    await fs.mkdir(clientDir, { recursive: true });

    const hypothesis = { statement: 'Гипотеза A', department: null, okrLink: null, status: 'идея' };

    // Write previous snapshot (week 27)
    const prevSnapshot: HypoSnapshot = { weekNumber: 27, year: 2026, hypotheses: [hypothesis] };
    const snapshotPath = join(clientDir, 'hypo-snapshot.json');
    await fs.writeFile(snapshotPath, JSON.stringify(prevSnapshot), 'utf8');

    // Current sheet has the same row
    vi.mocked(readHypothesesSheet).mockResolvedValue([
      { statement: 'Гипотеза A', department: '', status: 'идея', okrLink: '' },
    ]);

    const result = await runHypoTracker({
      clientId: 'geonline',
      clientName: 'Geonline',
      deps: { now: () => new Date('2026-07-10T12:00:00Z'), rootDir },
    });

    // Report should indicate no changes
    expect(result).toContain('Изменений за неделю нет');

    // Snapshot should be updated with new weekNumber (week 28 for 2026-07-10)
    const updated = JSON.parse(await fs.readFile(snapshotPath, 'utf8')) as HypoSnapshot;
    expect(updated.weekNumber).toBe(28);
    expect(updated.hypotheses).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: Claude failure → report without "Выводы" section (non-blocking)
// Matrix row: Claude упал
// ─────────────────────────────────────────────────────────────────────────────

describe('runHypoTracker — Claude failure (matrix row: Claude упал)', () => {
  it('returns report without "Выводы" when Claude throws after withRetry', async () => {
    const rootDir = join(tmpdir(), `hypo-test-${Date.now()}`);
    const clientDir = join(rootDir, 'geonline');
    await fs.mkdir(clientDir, { recursive: true });

    // Write a snapshot so we get into delta-mode and Claude is called
    const prevSnapshot: HypoSnapshot = {
      weekNumber: 27,
      year: 2026,
      hypotheses: [
        { statement: 'Гипотеза A', department: null, okrLink: null, status: 'идея' },
      ],
    };
    await fs.writeFile(join(clientDir, 'hypo-snapshot.json'), JSON.stringify(prevSnapshot), 'utf8');

    // Current sheet has a status change → delta is non-empty → Claude is invoked
    vi.mocked(readHypothesesSheet).mockResolvedValue([
      { statement: 'Гипотеза A', department: '', status: 'в тесте', okrLink: '' },
    ]);

    // Use status:400 so shouldRetryClaude returns false → immediate failure, no retry backoff
    const claudeErr = Object.assign(new Error('bad request'), { status: 400 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failingClaude = vi.fn().mockRejectedValue(claudeErr) as any;

    const result = await runHypoTracker({
      clientId: 'geonline',
      deps: {
        now: () => new Date('2026-07-10T12:00:00Z'),
        rootDir,
        callClaude: failingClaude,
      },
    });

    // Report should be returned without the "Выводы" section
    expect(result).toContain('Гипотеза A');
    expect(result).not.toContain('Выводы');
    expect(result).toContain('идея → в тесте');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: header_missing → HALT (throws error with blocking condition message)
// Matrix row: header_missing
// ─────────────────────────────────────────────────────────────────────────────

describe('runHypoTracker — header_missing', () => {
  it('throws with blocking condition message when sheet has missing headers', async () => {
    vi.mocked(readHypothesesSheet).mockRejectedValue(
      new SheetsAdapterError('header_missing', { sheet: '_hypotheses', missingHeaders: ['statement'] }),
    );

    await expect(
      runHypoTracker({
        clientId: 'geonline',
        deps: { now: () => new Date('2026-07-10T12:00:00Z'), rootDir: join(tmpdir(), 'hypo-halt-test') },
      }),
    ).rejects.toThrow('hypotheses sheet unreadable — manual fix needed');
  });
});
