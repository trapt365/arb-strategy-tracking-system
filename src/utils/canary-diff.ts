/**
 * Story 1.11: canary regression test — pure helpers.
 *
 * Безопасно для unit-тестов: чистые функции без I/O, без Claude API, без файловой
 * системы. Орchestration живёт в `scripts/canary.ts`; здесь только diff,
 * semantic assertions, verdict-классификация и renderers.
 *
 * Контракт: НЕ сравнивает текстовые формулировки (architecture.md#Canary Test
 * MethodDescription, line 244) и НЕ сравнивает `analysis.commitments_status_updates`
 * (Story 1.4a добавила это поле — golden references его не содержат).
 */

// Соответствует подмножеству runF1Result, которое canary использует для diff —
// не импортируем `RunF1Result` из `f1-report.ts` напрямую, чтобы canary-diff
// оставался pure-модулем без транзитивных зависимостей на Claude/pino.
export interface ActualPipelineOutput {
  extraction: {
    commitments: unknown[];
    citations: unknown[];
    decisions: unknown[];
    facts: unknown[];
  };
  analysis: {
    okr_coverage: Array<{ status: 'discussed' | 'mentioned' | 'blind_zone' }>;
    alerts: unknown[];
  };
  formattedReport:
    | { partial: false; sections: unknown[] }
    | { partial: true };
}

// Шейп golden reference из `data/golden/f1-reference-N.json`.
export interface ReferencePipelineOutput {
  extraction: {
    commitments: unknown[];
    citations: unknown[];
    decisions: unknown[];
    facts: unknown[];
  };
  analysis: {
    okr_coverage: Array<{ status: 'discussed' | 'mentioned' | 'blind_zone' }>;
    alerts: unknown[];
  };
  format: {
    report_sections: unknown[];
  };
}

export interface StructuralDiff {
  commitmentsDiff: number;
  citationsDiff: number;
  decisionsDiff: number;
  factsDiff: number;
  alertsDiff: number;
  okrDiscussedDiff: number;
  okrMentionedDiff: number;
  sectionsDiff: number;
  /** Среднее по 8 dimensions × 100. Например, 12.5 = 12.5%. */
  diffPercent: number;
  /** True если `actual.formattedReport.partial === true` (graceful degradation). */
  partialReport: boolean;
}

export type AssertionName =
  | 'commitments_not_empty_if_present'
  | 'okr_references_not_empty_if_context'
  | 'f1_format_three_sections';

export interface AssertionResult {
  name: AssertionName;
  pass: boolean;
  detail: string;
}

export type Verdict = 'pass' | 'review' | 'rollback' | 'error';

export interface ItemVerdictInput {
  diffPercent: number;
  assertions: AssertionResult[];
  error?: { code: string; message: string };
}

export interface ManifestItemStats {
  commitments: number;
  decisions?: number;
  facts?: number;
  citations?: number;
  okr_discussed?: number;
  okr_mentioned?: number;
  alerts?: number;
}

export interface ManifestItem {
  n: number;
  scenario?: string;
  stats: ManifestItemStats;
}

export interface ClientContextLike {
  okrs: unknown[];
}

// Пороги verdict — AC #4: 30% inclusive review, 50% exclusive rollback (50.0 → review, 50.1 → rollback).
export const THRESHOLD_REVIEW_MIN = 30;
export const THRESHOLD_ROLLBACK_MIN = 50;

// 8 dimensions для усреднения. Документация фиксирует порядок (используется в renderMarkdownReport).
export const DIFF_DIMENSIONS = [
  'commitmentsDiff',
  'citationsDiff',
  'decisionsDiff',
  'factsDiff',
  'alertsDiff',
  'okrDiscussedDiff',
  'okrMentionedDiff',
  'sectionsDiff',
] as const;

function ratioDiff(actual: number, reference: number): number {
  // max(1, ref) защищает от деления на ноль: при ref=0 actual=N считаем как ratio = N.
  return Math.abs(actual - reference) / Math.max(1, reference);
}

function countOkr(
  coverage: Array<{ status: 'discussed' | 'mentioned' | 'blind_zone' }>,
  status: 'discussed' | 'mentioned',
): number {
  let n = 0;
  for (const item of coverage) if (item.status === status) n++;
  return n;
}

export function computeStructuralDiff(
  actual: ActualPipelineOutput,
  reference: ReferencePipelineOutput,
): StructuralDiff {
  const partialReport = actual.formattedReport.partial === true;

  const aOkrDiscussed = countOkr(actual.analysis.okr_coverage, 'discussed');
  const aOkrMentioned = countOkr(actual.analysis.okr_coverage, 'mentioned');
  const rOkrDiscussed = countOkr(reference.analysis.okr_coverage, 'discussed');
  const rOkrMentioned = countOkr(reference.analysis.okr_coverage, 'mentioned');

  // Если actual.partial — секций физически нет; sectionsDiff фиксируем как 1.0 (полное
  // расхождение), независимо от того, сколько секций было в reference.
  const aSections = partialReport
    ? 0
    : (actual.formattedReport as { partial: false; sections: unknown[] }).sections.length;
  const rSections = reference.format.report_sections.length;
  const sectionsDiff = partialReport ? 1 : ratioDiff(aSections, rSections);

  const diff: StructuralDiff = {
    commitmentsDiff: ratioDiff(
      actual.extraction.commitments.length,
      reference.extraction.commitments.length,
    ),
    citationsDiff: ratioDiff(
      actual.extraction.citations.length,
      reference.extraction.citations.length,
    ),
    decisionsDiff: ratioDiff(
      actual.extraction.decisions.length,
      reference.extraction.decisions.length,
    ),
    factsDiff: ratioDiff(actual.extraction.facts.length, reference.extraction.facts.length),
    alertsDiff: ratioDiff(actual.analysis.alerts.length, reference.analysis.alerts.length),
    okrDiscussedDiff: ratioDiff(aOkrDiscussed, rOkrDiscussed),
    okrMentionedDiff: ratioDiff(aOkrMentioned, rOkrMentioned),
    sectionsDiff,
    diffPercent: 0,
    partialReport,
  };

  let sum = 0;
  for (const key of DIFF_DIMENSIONS) sum += diff[key];
  diff.diffPercent = (sum / DIFF_DIMENSIONS.length) * 100;
  return diff;
}

export function runSemanticAssertions(
  actual: ActualPipelineOutput,
  manifestItem: ManifestItem | undefined,
  clientContext: ClientContextLike,
): AssertionResult[] {
  const results: AssertionResult[] = [];

  const goldenCommitments = manifestItem?.stats.commitments ?? 0;
  const actualCommitments = actual.extraction.commitments.length;
  if (goldenCommitments === 0) {
    results.push({
      name: 'commitments_not_empty_if_present',
      pass: true,
      detail: 'no commitments expected in golden — auto-pass',
    });
  } else {
    const pass = actualCommitments > 0;
    results.push({
      name: 'commitments_not_empty_if_present',
      pass,
      detail: pass
        ? `${actualCommitments} commitments extracted (golden has ${goldenCommitments})`
        : `expected non-empty (${goldenCommitments} in golden), got 0`,
    });
  }

  if (clientContext.okrs.length === 0) {
    results.push({
      name: 'okr_references_not_empty_if_context',
      pass: true,
      detail: 'no OKR context — auto-pass',
    });
  } else {
    const referencedCount = actual.analysis.okr_coverage.filter(
      (s) => s.status === 'discussed' || s.status === 'mentioned',
    ).length;
    const pass = referencedCount > 0;
    results.push({
      name: 'okr_references_not_empty_if_context',
      pass,
      detail: pass
        ? `${referencedCount} OKR references (discussed+mentioned)`
        : 'OKR context loaded but no discussed/mentioned KRs in analysis',
    });
  }

  if (actual.formattedReport.partial === true) {
    results.push({
      name: 'f1_format_three_sections',
      pass: false,
      detail: 'partial mode: format step failed (no sections produced)',
    });
  } else {
    const sectionsCount = actual.formattedReport.sections.length;
    const pass = sectionsCount === 3;
    results.push({
      name: 'f1_format_three_sections',
      pass,
      detail: pass
        ? '3 sections rendered as expected'
        : `expected exactly 3 sections, got ${sectionsCount}`,
    });
  }

  return results;
}

export function classifyVerdict(input: ItemVerdictInput): Verdict {
  if (input.error) return 'error';
  const fails = input.assertions.filter((a) => !a.pass).length;
  if (fails >= 2 || input.diffPercent > THRESHOLD_ROLLBACK_MIN) return 'rollback';
  if (fails >= 1 || input.diffPercent >= THRESHOLD_REVIEW_MIN) return 'review';
  return 'pass';
}

export function aggregateRunVerdict(items: Verdict[]): Verdict {
  if (items.length === 0) return 'error';
  if (items.some((v) => v === 'rollback')) return 'rollback';
  if (items.some((v) => v === 'review')) return 'review';
  if (items.some((v) => v === 'pass')) return 'pass';
  // Все items error → run='error'. Aggregate worst-of-all не считает error как rollback:
  // canary infrastructure broken ≠ prompt regression.
  return 'error';
}

const PROMPT_VERSION_RE = /^## (v\d+\.\d+\.\d+)\b/m;

export function extractCurrentPromptVersion(
  changelogContent: string,
): string | 'unknown' {
  if (typeof changelogContent !== 'string' || changelogContent.length === 0) {
    return 'unknown';
  }
  const m = changelogContent.match(PROMPT_VERSION_RE);
  return m ? m[1]! : 'unknown';
}

// ─────────────────────────────────────────────────────────────────────────────
// Report rendering
// ─────────────────────────────────────────────────────────────────────────────

export interface CanaryItemResult {
  n: number;
  scenario: string;
  verdict: Verdict;
  diff?: StructuralDiff;
  assertions?: AssertionResult[];
  tokens?: { input: number; output: number };
  estimatedCostUsd?: number;
  durationsMs?: { total: number };
  error?: { code: string; message: string };
  artifactsDir?: string;
}

export interface CanaryRunMeta {
  timestamp: string;
  model: string;
  promptsVersion: string | 'unknown';
  itemsRequested: number[];
  outDir: string;
  totalTokens: { input: number; output: number };
  estimatedCostUsd: number;
  totalDurationMs: number;
  // Per-token pricing snapshot (USD per token) — фиксированно в момент запуска для
  // воспроизводимости отчёта; обновлять вручную при изменении Anthropic pricing.
  pricing: { inputPerToken: number; outputPerToken: number };
  noClaude: boolean;
  semanticChecksSource?: 'manifest' | 'built-in-defaults';
}

export interface CanaryRunResult {
  items: CanaryItemResult[];
  verdict: Verdict;
  meta: CanaryRunMeta;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  pass: '🟢 **PASS**',
  review: '🟡 **REVIEW**',
  rollback: '🔴 **ROLLBACK**',
  error: '⚪ **ERROR**',
};

const VERDICT_EMOJI: Record<Verdict, string> = {
  pass: '🟢',
  review: '🟡',
  rollback: '🔴',
  error: '⚪',
};

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${s}s`;
}

function fmtTokens(t: { input: number; output: number } | undefined): string {
  if (!t) return '—';
  const k = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `${k(t.input)}/${k(t.output)}`;
}

function fmtPercent(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}%`;
}

function fmtCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '~$0.00';
  if (usd < 0.01) return `~$${usd.toFixed(4)}`;
  return `~$${usd.toFixed(2)}`;
}

function summariseAssertions(assertions: AssertionResult[] | undefined): string {
  if (!assertions || assertions.length === 0) return '—';
  const pass = assertions.filter((a) => a.pass).length;
  return `${pass}/${assertions.length} ${pass === assertions.length ? '✓' : '✗'}`;
}

function renderHeader(meta: CanaryRunMeta, itemsRun: number): string {
  const lines = [
    '## Header',
    `- Run timestamp: ${meta.timestamp}`,
    `- Model: ${meta.model}`,
    `- Prompts version: ${meta.promptsVersion}`,
    `- Items run: ${itemsRun} (${meta.itemsRequested.join(', ')})`,
    `- Total Claude tokens: ${meta.totalTokens.input} in / ${meta.totalTokens.output} out`,
    `- Estimated cost: ${fmtCost(meta.estimatedCostUsd)}`,
    `- Total duration: ${fmtDuration(meta.totalDurationMs)}`,
    `- Mode: ${meta.noClaude ? 'dry-run (--no-claude)' : 'full Claude run'}`,
    `- Semantic checks: ${
      meta.semanticChecksSource === 'built-in-defaults'
        ? 'built-in defaults (manifest semantic_checks missing)'
        : 'manifest'
    }`,
    `- Output dir: \`${meta.outDir}\``,
  ];
  return lines.join('\n');
}

function renderVerdictBlock(verdict: Verdict): string {
  return [`## Verdict`, '', VERDICT_LABEL[verdict]].join('\n');
}

function renderItemsTable(items: CanaryItemResult[]): string {
  const header = [
    '## Items Summary',
    '',
    '| # | scenario | diff% | assertions | verdict | tokens |',
    '|---|----------|------:|------------|---------|-------:|',
  ];
  const rows = items.map((it) => {
    const diffStr = it.diff ? fmtPercent(it.diff.diffPercent) : '—';
    const verdictStr = `${VERDICT_EMOJI[it.verdict]} ${it.verdict}`;
    return `| ${it.n} | ${it.scenario || '—'} | ${diffStr} | ${summariseAssertions(it.assertions)} | ${verdictStr} | ${fmtTokens(it.tokens)} |`;
  });
  return [...header, ...rows].join('\n');
}

function renderPerItemDetails(items: CanaryItemResult[]): string {
  const parts: string[] = ['## Per-item Details'];
  for (const it of items) {
    parts.push('');
    parts.push(`### Item ${it.n} — verdict ${VERDICT_EMOJI[it.verdict]} ${it.verdict}`);
    if (it.scenario) parts.push(`- Scenario: ${it.scenario}`);
    if (it.error) {
      parts.push(`- Error code: \`${it.error.code}\``);
      parts.push(`- Error message: ${it.error.message}`);
    }
    if (it.diff) {
      const dimEntries: string[] = [];
      for (const dim of DIFF_DIMENSIONS) {
        dimEntries.push(`${dim}=${fmtPercent(it.diff[dim] * 100)}`);
      }
      parts.push(`- Diff dimensions: ${dimEntries.join(', ')}`);
      if (it.diff.partialReport) {
        parts.push('- ⚠️ Partial report (format step degraded)');
      }
    }
    if (it.assertions) {
      for (const a of it.assertions) {
        parts.push(`- ${a.pass ? '✓' : '✗'} ${a.name} — ${a.detail}`);
      }
    }
    if (it.tokens) {
      parts.push(`- Pipeline tokens: in=${it.tokens.input}, out=${it.tokens.output}`);
    }
    if (it.durationsMs) {
      parts.push(`- Duration: ${fmtDuration(it.durationsMs.total)}`);
    }
    if (it.artifactsDir) {
      parts.push(`- Artifacts: \`${it.artifactsDir}\``);
    }
  }
  return parts.join('\n');
}

const ROLLBACK_PROCEDURE = [
  '## Rollback Procedure',
  '',
  'Verdict требует вмешательства. Шаги:',
  '',
  '1. `git log -- prompts/` — найти предыдущий стабильный commit prompts.',
  '2. `git diff HEAD~1 -- prompts/` — что изменилось.',
  '3. `git checkout <prev-commit> -- prompts/` — rollback.',
  '4. `git commit -m "chore(prompts): rollback after canary <verdict>"`.',
  '5. Запись в `prompts/CHANGELOG.md`: «## Rollback YYYY-MM-DD — canary <verdict>, diff X%, реверт к vN.M.P».',
  '6. Перезапустить `npm run canary` — verdict должен стать pass.',
].join('\n');

const F4_NOTE = [
  '## F4 Canary',
  '',
  'Skipped — F4 pipeline ещё не реализован (Epic 3, Story 3.1).',
  'F4 reference outputs существуют в `data/golden/f4-reference-*.json` и ждут `runF4()`.',
].join('\n');

export function renderMarkdownReport(run: CanaryRunResult): string {
  const blocks: string[] = [];
  blocks.push(`# Canary Run — ${run.verdict.toUpperCase()}`);
  blocks.push('');
  blocks.push(renderHeader(run.meta, run.items.length));
  blocks.push('');
  blocks.push(renderVerdictBlock(run.verdict));
  blocks.push('');
  blocks.push(renderItemsTable(run.items));
  blocks.push('');
  blocks.push(renderPerItemDetails(run.items));
  if (run.verdict !== 'pass') {
    blocks.push('');
    blocks.push(ROLLBACK_PROCEDURE);
  }
  blocks.push('');
  blocks.push(F4_NOTE);
  blocks.push('');
  return blocks.join('\n');
}

export interface CanaryJsonReport {
  meta: CanaryRunMeta;
  aggregate: {
    verdict: Verdict;
    totalTokens: { input: number; output: number };
    estimatedCostUsd: number;
    totalDurationMs: number;
  };
  items: Array<{
    n: number;
    scenario: string;
    verdict: Verdict;
    diff?: StructuralDiff;
    assertions?: AssertionResult[];
    tokens?: { input: number; output: number };
    estimatedCostUsd?: number;
    durationsMs?: { total: number };
    error?: { code: string; message: string };
    artifactsDir?: string;
  }>;
}

export function renderJsonReport(run: CanaryRunResult): CanaryJsonReport {
  return {
    meta: run.meta,
    aggregate: {
      verdict: run.verdict,
      totalTokens: run.meta.totalTokens,
      estimatedCostUsd: run.meta.estimatedCostUsd,
      totalDurationMs: run.meta.totalDurationMs,
    },
    items: run.items.map((it) => ({
      n: it.n,
      scenario: it.scenario,
      verdict: it.verdict,
      ...(it.diff ? { diff: it.diff } : {}),
      ...(it.assertions ? { assertions: it.assertions } : {}),
      ...(it.tokens ? { tokens: it.tokens } : {}),
      ...(typeof it.estimatedCostUsd === 'number'
        ? { estimatedCostUsd: it.estimatedCostUsd }
        : {}),
      ...(it.durationsMs ? { durationsMs: it.durationsMs } : {}),
      ...(it.error ? { error: it.error } : {}),
      ...(it.artifactsDir ? { artifactsDir: it.artifactsDir } : {}),
    })),
  };
}
