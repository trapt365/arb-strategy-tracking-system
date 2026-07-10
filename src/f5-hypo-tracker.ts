/**
 * Story 10.5: F5 Hypo Tracker pipeline.
 *
 * Reads _hypotheses sheet, compares with last week's snapshot, calls Claude
 * for conclusions, formats a report, and persists the new snapshot.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { logger as rootLogger, type Logger } from './logger.js';
import { loadPrompt } from './utils/prompt-loader.js';
import { callClaude, shouldRetryClaude } from './adapters/claude.js';
import { withRetry } from './utils/retry.js';
import { readHypothesesSheet, SheetsAdapterError } from './adapters/sheets.js';
import { slugifyClientId } from './utils/client-id.js';
import { getISOWeekAndYear } from './utils/weekly-report.js';
import {
  HypoSnapshotSchema,
  HypoTrackerConclusionsSchema,
  type HypoSnapshot,
  type HypoSnapshotItem,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Public interface
// ─────────────────────────────────────────────────────────────────────────────

export interface RunHypoTrackerInput {
  clientId: string;
  clientName?: string; // human-readable display name; defaults to clientId
  deps?: {
    logger?: Logger;
    now?: () => Date;
    rootDir?: string;
    callClaude?: typeof callClaude;
    loadPrompt?: typeof loadPrompt;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers — exported for unit tests
// ─────────────────────────────────────────────────────────────────────────────

export interface DeltaResult {
  changed: Array<{ statement: string; oldStatus: string; newStatus: string }>;
  added: Array<{ statement: string; status: string }>;
}

export function computeDelta(
  current: HypoSnapshotItem[],
  snapshot: HypoSnapshotItem[],
): DeltaResult {
  const snapshotMap = new Map(
    snapshot.map((h) => [h.statement.trim().toLowerCase(), h]),
  );

  const changed: DeltaResult['changed'] = [];
  const added: DeltaResult['added'] = [];

  for (const row of current) {
    const key = row.statement.trim().toLowerCase();
    const prev = snapshotMap.get(key);
    if (!prev) {
      added.push({ statement: row.statement, status: row.status });
    } else if (prev.status !== row.status) {
      changed.push({ statement: row.statement, oldStatus: prev.status, newStatus: row.status });
    }
  }

  return { changed, added };
}

export function formatHypoReport(opts: {
  clientName: string;
  week: number;
  year: number;
  rows: HypoSnapshotItem[];
  snapshot: HypoSnapshot | null;
  delta: DeltaResult | null;
  conclusions: string[] | null;
}): string {
  const { clientName, week, year, rows, snapshot, delta, conclusions } = opts;
  const lines: string[] = [`🧪 Трекер гипотез — ${clientName} — нед.${week}/${year}`];

  if (rows.length === 0) {
    return 'Гипотезы не найдены в листе _hypotheses.';
  }

  lines.push('');

  // First run (no snapshot) or delta provided
  if (snapshot === null || delta === null) {
    // First run: full list
    lines.push('Все гипотезы:');
    for (const h of rows) {
      lines.push(`• ${h.statement} [${h.status}]`);
    }
  } else {
    // Has snapshot — show changes
    if (delta.changed.length === 0 && delta.added.length === 0) {
      lines.push('Изменений за неделю нет.');
    } else {
      if (delta.changed.length > 0) {
        lines.push('Изменения:');
        for (const c of delta.changed) {
          lines.push(`• ${c.statement}: ${c.oldStatus} → ${c.newStatus}`);
        }
        lines.push('');
      }
      if (delta.added.length > 0) {
        lines.push('Новые:');
        for (const a of delta.added) {
          lines.push(`• ${a.statement} [${a.status}]`);
        }
        lines.push('');
      }
    }

    // Summary of all statuses
    const statusCounts = new Map<string, number>();
    for (const h of rows) {
      statusCounts.set(h.status, (statusCounts.get(h.status) ?? 0) + 1);
    }
    const summaryParts: string[] = [];
    for (const [s, n] of statusCounts) {
      summaryParts.push(`${s}: ${n}`);
    }
    lines.push(`Всего гипотез: ${rows.length} (${summaryParts.join(', ')})`);
    lines.push('');

    // Full list
    lines.push('Все гипотезы:');
    for (const h of rows) {
      lines.push(`• ${h.statement} [${h.status}]`);
    }
  }

  // Conclusions from Claude
  if (conclusions && conclusions.length > 0) {
    lines.push('');
    lines.push('Выводы:');
    for (const c of conclusions) {
      lines.push(`• ${c}`);
    }
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline
// ─────────────────────────────────────────────────────────────────────────────

function rowsToSnapshotItems(rows: Record<string, string>[]): HypoSnapshotItem[] {
  return rows
    .filter((r) => (r['statement'] ?? '').trim().length > 0)
    .map((r) => ({
      statement: r['statement']!.trim(),
      department: (r['department'] ?? '').trim() || null,
      okrLink: (r['okrLink'] ?? '').trim() || null,
      status: r['status'] ?? '',
    }));
}

export async function runHypoTracker(input: RunHypoTrackerInput): Promise<string> {
  const { clientId } = input;
  const clientName = input.clientName ?? clientId;
  const deps = input.deps ?? {};
  const log = (deps.logger ?? rootLogger).child({ pipeline: 'F5', clientId });
  const nowFn = deps.now ?? (() => new Date());
  const rootDir = deps.rootDir ?? 'data';
  const callClaudeFn = deps.callClaude ?? callClaude;
  const loadPromptFn = deps.loadPrompt ?? loadPrompt;

  // ── Step 1: Read _hypotheses sheet ─────────────────────────────────────────
  log.info({ step: 'F5.read_sheet' }, 'reading _hypotheses sheet');
  let rawRows: Record<string, string>[];
  try {
    rawRows = await readHypothesesSheet(clientId, log as Logger);
  } catch (err) {
    if (err instanceof SheetsAdapterError) {
      const code = err.code;
      if (code === 'auth' || code === 'sheet_not_found' || code === 'header_missing') {
        const msg = `hypotheses sheet unreadable — manual fix needed (${code})`;
        log.error({ step: 'F5.read_sheet.halt', code }, msg);
        throw new Error(msg);
      }
    }
    throw err;
  }

  // ── Step 2: Load snapshot ───────────────────────────────────────────────────
  const snapshotPath = join(rootDir, slugifyClientId(clientId), 'hypo-snapshot.json');
  log.info({ step: 'F5.load_snapshot', snapshotPath }, 'loading snapshot');
  let snapshot: HypoSnapshot | null = null;
  try {
    const raw = await fs.readFile(snapshotPath, 'utf8');
    const parsed = HypoSnapshotSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      snapshot = parsed.data;
    } else {
      log.warn({ step: 'F5.load_snapshot.invalid', issues: parsed.error.issues }, 'snapshot invalid — treating as first run');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn({ step: 'F5.load_snapshot.read_error', err }, 'snapshot read error — treating as first run');
    }
    // ENOENT → first run, snapshot = null
  }

  const now = nowFn();
  const todayStr = now.toISOString().slice(0, 10);
  const { week, year } = getISOWeekAndYear(todayStr);

  // ── Step 3: Delta ───────────────────────────────────────────────────────────
  const currentItems = rowsToSnapshotItems(rawRows);

  if (rawRows.length === 0) {
    log.info({ step: 'F5.empty_sheet' }, '_hypotheses sheet has no data rows');
    return 'Гипотезы не найдены в листе _hypotheses.';
  }

  let delta: DeltaResult | null = null;
  if (snapshot !== null) {
    delta = computeDelta(currentItems, snapshot.hypotheses);
    log.info(
      { step: 'F5.delta', changed: delta.changed.length, added: delta.added.length },
      'delta computed',
    );
  }

  // ── Step 4: Claude conclusions ──────────────────────────────────────────────
  let conclusions: string[] | null = null;
  if (snapshot !== null && delta !== null && (delta.changed.length > 0 || delta.added.length > 0)) {
    const changesText =
      delta.changed.length > 0
        ? delta.changed.map((c) => `${c.statement}: ${c.oldStatus} → ${c.newStatus}`).join('\n')
        : '(нет)';
    const newText =
      delta.added.length > 0
        ? delta.added.map((a) => `${a.statement} [${a.status}]`).join('\n')
        : '(нет)';

    const statusCounts = new Map<string, number>();
    for (const h of currentItems) {
      statusCounts.set(h.status, (statusCounts.get(h.status) ?? 0) + 1);
    }
    const summaryText = [...statusCounts.entries()]
      .map(([s, n]) => `${s}: ${n}`)
      .join(', ');

    try {
      log.info({ step: 'F5.claude_conclusions' }, 'calling Claude for conclusions');
      const prompt = await loadPromptFn('hypo-tracker', {
        clientName,
        weekNumber: String(week),
        changesText,
        newText,
        summaryText,
      });
      const result = await withRetry(
        () =>
          callClaudeFn(prompt, {
            stepName: 'hypo_tracker.conclusions',
            schema: HypoTrackerConclusionsSchema,
            logger: log,
          }),
        {
          maxRetries: 3,
          backoffMs: [1000, 3000, 9000],
          shouldRetry: shouldRetryClaude,
          logger: log,
        },
      );
      conclusions = result.parsed.conclusions;
      log.info({ step: 'F5.claude_conclusions.ok', count: conclusions.length }, 'conclusions received');
    } catch (err) {
      log.warn({ step: 'F5.claude_conclusions.failed', err }, 'Claude conclusions failed — continuing without');
    }
  }

  // ── Step 5: Format report ───────────────────────────────────────────────────
  const reportText = formatHypoReport({
    clientName,
    week,
    year,
    rows: currentItems,
    snapshot,
    delta,
    conclusions,
  });

  // ── Step 6: Persist snapshot ────────────────────────────────────────────────
  const newSnapshot: HypoSnapshot = {
    weekNumber: week,
    year,
    hypotheses: currentItems,
  };
  try {
    const dir = join(rootDir, slugifyClientId(clientId));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(snapshotPath, JSON.stringify(newSnapshot, null, 2), 'utf8');
    log.info({ step: 'F5.persist_snapshot', snapshotPath }, 'snapshot persisted');
  } catch (err) {
    log.warn({ step: 'F5.persist_snapshot.failed', err }, 'snapshot persist failed (non-blocking)');
  }

  return reportText;
}
