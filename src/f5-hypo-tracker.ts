/**
 * Story 10.5 / 10.8: F5 Hypo Tracker pipeline.
 *
 * Reads _hypotheses sheet, compares with last week's snapshot, calls Claude
 * for structured insights, formats a rich structured report, and persists
 * the new snapshot.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { logger as rootLogger, type Logger } from './logger.js';
import { loadPrompt } from './utils/prompt-loader.js';
import { callClaude, shouldRetryClaude } from './adapters/claude.js';
import { withRetry } from './utils/retry.js';
import { readHypothesesSheet, readClientContext, SheetsAdapterError } from './adapters/sheets.js';
import { slugifyClientId } from './utils/client-id.js';
import { getISOWeekAndYear, loadWeekReports } from './utils/weekly-report.js';
import {
  HypoSnapshotSchema,
  HypoStructuredInsightsSchema,
  type HypoSnapshot,
  type HypoSnapshotItem,
  type HypoStructuredInsights,
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
    readClientContext?: typeof readClientContext;
    loadWeekReports?: typeof loadWeekReports;
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

// Legacy flat-format function (formerly `formatHypoReport`). Kept for backward compat.
export function formatHypoReportFlat(opts: {
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
// Emoji status mapping
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_EMOJI: Record<string, string> = {
  'работает': '🟢',
  'done': '🟢',
  'в тесте': '🟡',
  'testing': '🟡',
  'не работает': '🔴',
  'failed': '🔴',
  'запланирована': '⏳',
  'planned': '⏳',
  'идея': '⏳',
  'остановлена': '⛔',
  'stopped': '⛔',
  'новая': '🆕',
};

function statusEmoji(status: string): string {
  const norm = status.toLowerCase().trim();
  return STATUS_EMOJI[norm] ?? '⬜';
}

function deptInitial(dept: string): string {
  // Take first character, uppercase
  return dept.charAt(0).toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Structured format (Story 10.8)
// ─────────────────────────────────────────────────────────────────────────────

export function formatHypoReportStructured(opts: {
  clientName: string;
  ceoName: string;
  week: number;
  year: number;
  items: HypoSnapshotItem[];
  snapshot: HypoSnapshot | null;
  delta: DeltaResult | null;
  insights: HypoStructuredInsights | null;
  meetingDates: string[];
}): { compact: string; full: string } {
  const { clientName, ceoName, week, year, items, snapshot, delta, insights, meetingDates } = opts;

  if (items.length === 0) {
    return {
      compact: 'Гипотезы не найдены в листе _hypotheses.',
      full: '',
    };
  }

  // ── Group items by department ───────────────────────────────────────────────
  const deptMap = new Map<string, HypoSnapshotItem[]>();
  for (const item of items) {
    const dept = item.department ?? 'Прочие';
    if (!deptMap.has(dept)) deptMap.set(dept, []);
    deptMap.get(dept)!.push(item);
  }

  // Keep named departments first, then Прочие
  const depts = [...deptMap.keys()].filter((d) => d !== 'Прочие');
  if (deptMap.has('Прочие')) depts.push('Прочие');

  // ── Build insight lookup ────────────────────────────────────────────────────
  const insightMap = new Map<string, HypoStructuredInsights['hypoInsights'][number]>();
  if (insights) {
    for (const hi of insights.hypoInsights) {
      insightMap.set(hi.statement.trim().toLowerCase(), hi);
    }
  }

  // ── Build changed/added sets ────────────────────────────────────────────────
  const changedSet = new Map<string, { oldStatus: string; newStatus: string }>();
  const addedSet = new Set<string>();
  if (delta) {
    for (const c of delta.changed) changedSet.set(c.statement.trim().toLowerCase(), c);
    for (const a of delta.added) addedSet.add(a.statement.trim().toLowerCase());
  }

  // ── Full Markdown ───────────────────────────────────────────────────────────
  const lines: string[] = [];

  const periodStr = meetingDates.length > 0
    ? meetingDates.join(', ')
    : `нед.${week}/${year}`;

  // Header table
  lines.push(`# 🧪 Трекер гипотез — ${clientName} — нед.${week}/${year}`);
  lines.push('');
  lines.push('| Параметр | Значение |');
  lines.push('|---|---|');
  lines.push(`| Период | ${periodStr} |`);
  lines.push(`| Клиент | ${clientName} |`);
  lines.push(`| Руководитель | ${ceoName} |`);
  lines.push(`| Всего гипотез | ${items.length} |`);
  lines.push('');

  // Legend
  lines.push('## Легенда');
  lines.push('');
  lines.push('| Статус | Описание |');
  lines.push('|---|---|');
  lines.push('| 🟢 Работает | Гипотеза подтверждена, эффект зафиксирован |');
  lines.push('| 🟡 В тесте | Тест запущен, результаты ожидаются |');
  lines.push('| ⏳ Запланирована | Гипотеза запланирована к тестированию |');
  lines.push('| 🔴 Не работает | Гипотеза опровергнута |');
  lines.push('| ⛔ Остановлена | Тест приостановлен |');
  lines.push('| 🆕 Новая | Добавлена на этой неделе |');
  lines.push('');

  // Per-department sections
  let sectionIndex = 1;
  for (const dept of depts) {
    const deptItems = deptMap.get(dept)!;
    const init = dept !== 'Прочие' ? deptInitial(dept) : 'Пр';

    lines.push(`## ${sectionIndex}. ${dept}`);
    lines.push('');

    // Table 1: Status updates (changed items)
    const changedItems = snapshot !== null && delta !== null
      ? deptItems.filter((item) => changedSet.has(item.statement.trim().toLowerCase()))
      : [];

    lines.push('### Обновления статусов');
    lines.push('');
    const prevWeek = snapshot?.weekNumber ?? (week > 1 ? week - 1 : 52);
    lines.push(`| # | Гипотеза | Статус нед.${prevWeek} | Статус нед.${week} | Комментарий |`);
    lines.push('|---|---|---|---|---|');

    if (changedItems.length === 0) {
      lines.push('| — | Изменений нет | — | — | — |');
    } else {
      for (let i = 0; i < changedItems.length; i++) {
        const item = changedItems[i]!;
        const key = item.statement.trim().toLowerCase();
        const ch = changedSet.get(key)!;
        const hi = insightMap.get(key);
        const id = item.id ?? `${init}-${i + 1}`;
        const comment = hi?.comment ?? '';
        lines.push(`| ${id} | ${item.statement} | ${statusEmoji(ch.oldStatus)} ${ch.oldStatus} | ${statusEmoji(ch.newStatus)} ${ch.newStatus} | ${comment} |`);
      }
    }
    lines.push('');

    // Table 2: New hypotheses
    const newItems = snapshot === null
      ? deptItems  // first run: all are new
      : deptItems.filter((item) => addedSet.has(item.statement.trim().toLowerCase()));

    lines.push('### Новые гипотезы');
    lines.push('');
    lines.push('| # | Гипотеза | Статус | Запуск | Результат / Метрика | Следующий шаг |');
    lines.push('|---|---|---|---|---|---|');

    if (newItems.length === 0) {
      lines.push('| — | Новых нет | — | — | — | — |');
    } else {
      for (let i = 0; i < newItems.length; i++) {
        const item = newItems[i]!;
        const key = item.statement.trim().toLowerCase();
        const hi = insightMap.get(key);
        const idxBase = changedItems.length + i;
        const id = item.id ?? `${init}-${idxBase + 1}`;
        const launch = hi?.launch ?? '';
        const result = hi?.result ?? '';
        const nextStep = hi?.nextStep ?? '';
        lines.push(`| ${id} | ${item.statement} | ${statusEmoji(item.status)} ${item.status} | ${launch} | ${result} | ${nextStep} |`);
      }
    }
    lines.push('');

    sectionIndex++;
  }

  // ── Summary matrix ──────────────────────────────────────────────────────────
  lines.push('## Сводная матрица статусов');
  lines.push('');
  lines.push('| Департамент | 🟢 | 🟡 | ⏳ | 🔴 | ⛔ | 🆕 | Всего | Δ |');
  lines.push('|---|---|---|---|---|---|---|---|---|');

  const matrixRows: string[] = [];
  for (const dept of depts) {
    const deptItems = deptMap.get(dept)!;
    const counts: Record<string, number> = {};
    for (const item of deptItems) {
      const em = statusEmoji(item.status);
      counts[em] = (counts[em] ?? 0) + 1;
    }

    // Compute Δ (added - removed for this dept)
    const addedCount = deptItems.filter((item) => addedSet.has(item.statement.trim().toLowerCase())).length;
    const deltaStr = snapshot === null ? '' : (addedCount > 0 ? `+${addedCount}` : '0');

    const row = `| ${dept} | ${counts['🟢'] ?? 0} | ${counts['🟡'] ?? 0} | ${counts['⏳'] ?? 0} | ${counts['🔴'] ?? 0} | ${counts['⛔'] ?? 0} | ${counts['🆕'] ?? 0} | ${deptItems.length} | ${deltaStr} |`;
    matrixRows.push(row);
    lines.push(row);
  }
  lines.push('');

  // ── Key insights ────────────────────────────────────────────────────────────
  if (insights && insights.topInsights.length > 0) {
    lines.push('## Ключевые выводы');
    lines.push('');
    for (const insight of insights.topInsights) {
      lines.push(`• ${insight}`);
    }
    lines.push('');
  }

  // ── Footer ──────────────────────────────────────────────────────────────────
  lines.push(`---`);
  lines.push(`*Сгенерировано автоматически — стратегический трекер гипотез нед.${week}/${year}*`);

  const full = lines.join('\n');

  // ── Compact summary ─────────────────────────────────────────────────────────
  const compactLines: string[] = [];
  compactLines.push(`🧪 Трекер гипотез — ${clientName} — нед.${week}/${year}`);
  compactLines.push('');
  compactLines.push('Сводка по департаментам:');
  for (const row of matrixRows) {
    compactLines.push(row);
  }
  compactLines.push('');

  if (insights && insights.topInsights.length > 0) {
    const top3 = insights.topInsights.slice(0, 3);
    compactLines.push('Топ-сигналы:');
    for (const s of top3) {
      compactLines.push(`• ${s}`);
    }
    compactLines.push('');
  }

  compactLines.push('📎 Полный трекер — во вложении');

  const compact = compactLines.join('\n');

  return { compact, full };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline
// ─────────────────────────────────────────────────────────────────────────────

function rowsToSnapshotItems(rows: Record<string, string>[]): HypoSnapshotItem[] {
  return rows
    .filter((r) => (r['statement'] ?? '').trim().length > 0)
    .map((r) => ({
      id: (r['id'] ?? '').trim() || undefined,
      statement: r['statement']!.trim(),
      department: (r['department'] ?? '').trim() || null,
      okrLink: (r['okrLink'] ?? '').trim() || null,
      status: r['status'] ?? '',
    }));
}

export async function runHypoTracker(input: RunHypoTrackerInput): Promise<{ compact: string; full: string }> {
  const { clientId } = input;
  const clientName = input.clientName ?? clientId;
  const deps = input.deps ?? {};
  const log = (deps.logger ?? rootLogger).child({ pipeline: 'F5', clientId });
  const nowFn = deps.now ?? (() => new Date());
  const rootDir = deps.rootDir ?? 'data';
  const callClaudeFn = deps.callClaude ?? callClaude;
  const loadPromptFn = deps.loadPrompt ?? loadPrompt;
  const readClientContextFn = deps.readClientContext ?? readClientContext;
  const loadWeekReportsFn = deps.loadWeekReports ?? loadWeekReports;

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
    return { compact: 'Гипотезы не найдены в листе _hypotheses.', full: '' };
  }

  let delta: DeltaResult | null = null;
  if (snapshot !== null) {
    delta = computeDelta(currentItems, snapshot.hypotheses);
    log.info(
      { step: 'F5.delta', changed: delta.changed.length, added: delta.added.length },
      'delta computed',
    );
  }

  // ── Step 4: Load ClientContext ──────────────────────────────────────────────
  let ceoName = 'Руководство';
  try {
    log.info({ step: 'F5.client_context' }, 'loading ClientContext');
    const ctx = await readClientContextFn({ clientId, logger: log as Logger, pipeline: 'F5' });
    const ceoStakeholder = ctx.stakeholders.find(
      (s) => s.role.toLowerCase().includes('ceo') || s.role.toLowerCase().includes('генеральный'),
    );
    if (ceoStakeholder) {
      ceoName = ceoStakeholder.fullName;
    }
    log.info({ step: 'F5.client_context.ok', ceoName }, 'ClientContext loaded');
  } catch (err) {
    log.warn({ step: 'F5.client_context.failed', err }, 'ClientContext failed — using fallback');
  }

  // ── Step 5: Load F1 reports for the week ───────────────────────────────────
  let f1ReportsText = '';
  let meetingDates: string[] = [];
  try {
    log.info({ step: 'F5.load_week_reports' }, 'loading F1 week reports');
    const weekReports = await loadWeekReportsFn(clientId, { now, rootDir });
    meetingDates = weekReports.map((r) => r.meetingDate);
    f1ReportsText = weekReports
      .flatMap((r) => ('sections' in r ? r.sections : []))
      .map((s) => s.content)
      .join('\n\n');
    log.info({ step: 'F5.load_week_reports.ok', count: weekReports.length }, 'F1 reports loaded');
  } catch (err) {
    log.warn({ step: 'F5.load_week_reports.failed', err }, 'F1 reports load failed — continuing without');
  }

  // ── Step 6: Claude structured insights ─────────────────────────────────────
  let insights: HypoStructuredInsights | null = null;
  if (f1ReportsText.length > 0) {
    // Build dept groups for prompt
    const deptMap = new Map<string, HypoSnapshotItem[]>();
    for (const item of currentItems) {
      const dept = item.department ?? 'Прочие';
      if (!deptMap.has(dept)) deptMap.set(dept, []);
      deptMap.get(dept)!.push(item);
    }

    const changedSet = new Map<string, { oldStatus: string; newStatus: string }>();
    const addedSet = new Set<string>();
    if (delta) {
      for (const c of delta.changed) changedSet.set(c.statement.trim().toLowerCase(), c);
      for (const a of delta.added) addedSet.add(a.statement.trim().toLowerCase());
    }

    const deptGroups = [...deptMap.entries()].map(([dept, hypos]) => ({
      dept,
      hypotheses: hypos.map((h) => {
        const key = h.statement.trim().toLowerCase();
        const ch = changedSet.get(key);
        return {
          statement: h.statement,
          oldStatus: ch?.oldStatus ?? h.status,
          newStatus: ch?.newStatus ?? h.status,
          isNew: snapshot === null || addedSet.has(key),
        };
      }),
    }));

    try {
      log.info({ step: 'F5.claude_insights' }, 'calling Claude for structured insights');
      const prompt = await loadPromptFn('hypo-tracker-structured', {
        clientName,
        weekNumber: String(week),
        deptGroupsJson: JSON.stringify(deptGroups),
        f1ReportsText,
      });
      const result = await withRetry(
        () =>
          callClaudeFn(prompt, {
            stepName: 'hypo_tracker.structured_insights',
            schema: HypoStructuredInsightsSchema,
            logger: log,
          }),
        {
          maxRetries: 3,
          backoffMs: [1000, 3000, 9000],
          shouldRetry: shouldRetryClaude,
          logger: log,
        },
      );
      insights = result.parsed;
      log.info({ step: 'F5.claude_insights.ok', count: insights.hypoInsights.length }, 'insights received');
    } catch (err) {
      log.warn({ step: 'F5.claude_insights.failed', err }, 'Claude insights failed — continuing without');
    }
  }

  // ── Step 7: Format structured report ───────────────────────────────────────
  const { compact, full } = formatHypoReportStructured({
    clientName,
    ceoName,
    week,
    year,
    items: currentItems,
    snapshot,
    delta,
    insights,
    meetingDates,
  });

  // ── Step 8: Persist snapshot ────────────────────────────────────────────────
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

  return { compact, full };
}
