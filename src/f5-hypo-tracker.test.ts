import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeDelta,
  formatHypoReportFlat,
  formatHypoReportStructured,
  runHypoTracker,
} from './f5-hypo-tracker.js';
import type { HypoSnapshotItem, HypoSnapshot, HypoStructuredInsights } from './types.js';
import { SheetsAdapterError } from './errors.js';

// Mock the sheets adapter so pipeline tests don't need real credentials
vi.mock('./adapters/sheets.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./adapters/sheets.js')>();
  return {
    ...actual,
    readHypothesesSheet: vi.fn(),
    readClientContext: vi.fn(),
  };
});

import { readHypothesesSheet, readClientContext } from './adapters/sheets.js';

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

describe('formatHypoReportFlat', () => {
  it('first run: includes all statements, no "Изменения" section', () => {
    const rows: HypoSnapshotItem[] = [
      { statement: 'Гипотеза Альфа', department: null, okrLink: null, status: 'идея' },
      { statement: 'Гипотеза Бета', department: null, okrLink: null, status: 'в тесте' },
    ];

    const text = formatHypoReportFlat({
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
    vi.mocked(readClientContext).mockRejectedValue(new Error('no context'));
  });

  it('returns "Гипотезы не найдены" and does not write snapshot on first run', async () => {
    const rootDir = join(tmpdir(), `hypo-test-${Date.now()}`);

    const result = await runHypoTracker({
      clientId: 'geonline',
      deps: { now: () => new Date('2026-07-10T12:00:00Z'), rootDir },
    });

    expect(result.compact).toBe('Гипотезы не найдены в листе _hypotheses.');
    expect(result.full).toBe('');

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
  it('returns compact with snapshot updated weekNumber', async () => {
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
    vi.mocked(readClientContext).mockRejectedValue(new Error('no context'));

    const result = await runHypoTracker({
      clientId: 'geonline',
      clientName: 'Geonline',
      deps: { now: () => new Date('2026-07-10T12:00:00Z'), rootDir },
    });

    // compact should mention the client name
    expect(result.compact).toContain('Geonline');
    // full should be non-empty with structural output
    expect(result.full).not.toBe('');
    expect(result.full).toContain('Обновления статусов');

    // Snapshot should be updated with new weekNumber (week 28 for 2026-07-10)
    const updated = JSON.parse(await fs.readFile(snapshotPath, 'utf8')) as HypoSnapshot;
    expect(updated.weekNumber).toBe(28);
    expect(updated.hypotheses).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: Claude failure → report without insights (non-blocking)
// Matrix row: Claude упал
// ─────────────────────────────────────────────────────────────────────────────

describe('runHypoTracker — Claude failure (matrix row: Claude упал)', () => {
  it('returns result with full containing structure when Claude throws after withRetry', async () => {
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
    vi.mocked(readClientContext).mockRejectedValue(new Error('no context'));

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

    // compact should mention the client + matrix; full should have structure
    expect(result.compact).toContain('geonline');
    expect(result.full).toContain('Обновления статусов');
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

// ─────────────────────────────────────────────────────────────────────────────
// Test A: formatHypoReportStructured — full structure with ≥2 departments
// ─────────────────────────────────────────────────────────────────────────────

describe('formatHypoReportStructured', () => {
  const baseItems: HypoSnapshotItem[] = [
    { id: 'М-1', statement: 'Гипотеза Маркетинг 1', department: 'Маркетинг', okrLink: null, status: 'в тесте' },
    { id: 'М-2', statement: 'Гипотеза Маркетинг 2', department: 'Маркетинг', okrLink: null, status: 'работает' },
    { id: 'П-1', statement: 'Гипотеза Продажи 1', department: 'Продажи', okrLink: null, status: 'идея' },
    { id: 'П-2', statement: 'Гипотеза Продажи 2', department: 'Продажи', okrLink: null, status: 'не работает' },
  ];

  const baseSnapshot: HypoSnapshot = {
    weekNumber: 27,
    year: 2026,
    hypotheses: [
      { statement: 'Гипотеза Маркетинг 1', department: 'Маркетинг', okrLink: null, status: 'идея' },
      { statement: 'Гипотеза Маркетинг 2', department: 'Маркетинг', okrLink: null, status: 'идея' },
      { statement: 'Гипотеза Продажи 1', department: 'Продажи', okrLink: null, status: 'идея' },
      // Гипотеза Продажи 2 is new
    ],
  };

  const baseDelta = computeDelta(baseItems, baseSnapshot.hypotheses);

  const baseInsights: HypoStructuredInsights = {
    hypoInsights: [
      { statement: 'Гипотеза Маркетинг 1', comment: '↑ перешла в тест — хороший сигнал' },
      { statement: 'Гипотеза Маркетинг 2', comment: '🟢 подтверждена' },
      { statement: 'Гипотеза Продажи 1', comment: '' },
      {
        statement: 'Гипотеза Продажи 2',
        comment: 'Новая',
        launch: 'Следующая неделя',
        result: 'Рост на 10%',
        nextStep: 'Назначить ответственного',
      },
    ],
    topInsights: [
      'Маркетинг ускоряется — 2 гипотезы сдвинулись',
      'Продажи добавили новую гипотезу без метрик',
      'Общий портфель растёт',
    ],
  };

  it('Test A: full contains header, legend, ≥2 dept sections, both tables, matrix, insights', () => {
    const { full } = formatHypoReportStructured({
      clientName: 'Geonline',
      ceoName: 'Иванов И.И.',
      week: 28,
      year: 2026,
      items: baseItems,
      snapshot: baseSnapshot,
      delta: baseDelta,
      insights: baseInsights,
      meetingDates: ['2026-07-07', '2026-07-09'],
    });

    // Header table with Период
    expect(full).toContain('Период');
    // Legend with 🟢 Работает
    expect(full).toContain('🟢 Работает');
    // At least 2 department sections
    expect(full).toContain('## 1.');
    expect(full).toContain('## 2.');
    // Both tables in each section
    expect(full).toContain('Обновления статусов');
    expect(full).toContain('Новые гипотезы');
    // Correct column headers for updates table
    expect(full).toContain('Статус нед.');
    expect(full).toContain('Комментарий');
    // Correct column headers for new table
    expect(full).toContain('Запуск');
    expect(full).toContain('Результат / Метрика');
    expect(full).toContain('Следующий шаг');
    // Summary matrix
    expect(full).toContain('Сводная матрица статусов');
    expect(full).toContain('Департамент | 🟢');
    // Key insights section
    expect(full).toContain('Ключевые выводы');
    expect(full).toContain('Маркетинг ускоряется');

    // Order: header before legend before sections before matrix before insights
    expect(full.indexOf('Период')).toBeLessThan(full.indexOf('🟢 Работает'));
    expect(full.indexOf('🟢 Работает')).toBeLessThan(full.indexOf('## 1.'));
    expect(full.indexOf('## 2.')).toBeLessThan(full.indexOf('Сводная матрица'));
    expect(full.indexOf('Сводная матрица')).toBeLessThan(full.indexOf('Ключевые выводы'));
  });

  it('Test B: hypotheses without department appear in "Прочие" section', () => {
    const itemsWithNull: HypoSnapshotItem[] = [
      { statement: 'Гипотеза Маркетинг 1', department: 'Маркетинг', okrLink: null, status: 'в тесте' },
      { statement: 'Без департамента', department: null, okrLink: null, status: 'идея' },
    ];

    const { full } = formatHypoReportStructured({
      clientName: 'Geonline',
      ceoName: 'Руководство',
      week: 28,
      year: 2026,
      items: itemsWithNull,
      snapshot: null,
      delta: null,
      insights: null,
      meetingDates: [],
    });

    expect(full).toContain('Прочие');
    expect(full).toContain('Без департамента');
  });

  it('Test C: insights = null → structure without comments, tables still present', () => {
    const { full } = formatHypoReportStructured({
      clientName: 'Geonline',
      ceoName: 'Руководство',
      week: 28,
      year: 2026,
      items: baseItems,
      snapshot: baseSnapshot,
      delta: baseDelta,
      insights: null,
      meetingDates: [],
    });

    // Structure present
    expect(full).toContain('Обновления статусов');
    expect(full).toContain('Новые гипотезы');
    expect(full).toContain('Сводная матрица');
    // Комментарий column present but cells empty for changed items
    expect(full).toContain('Комментарий');
    // Ключевые выводы section absent when insights = null
    expect(full).not.toContain('Ключевые выводы');
  });

  it('Test D: compact contains each dept name and "📎 Полный трекер — во вложении"', () => {
    const { compact } = formatHypoReportStructured({
      clientName: 'Geonline',
      ceoName: 'Иванов И.И.',
      week: 28,
      year: 2026,
      items: baseItems,
      snapshot: baseSnapshot,
      delta: baseDelta,
      insights: baseInsights,
      meetingDates: [],
    });

    expect(compact).toContain('Маркетинг');
    expect(compact).toContain('Продажи');
    expect(compact).toContain('📎 Полный трекер — во вложении');
  });
});
