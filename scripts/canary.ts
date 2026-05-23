#!/usr/bin/env tsx
/**
 * Story 1.11: canary regression test CLI.
 *
 * Запускает production `runF1` на зафиксированном golden dataset (Story 0.3),
 * сравнивает structural diff против `data/golden/f1-reference-N.json`,
 * прогоняет 3 semantic assertions и классифицирует verdict (pass/review/rollback/error).
 *
 * Usage:
 *   npm run canary                                # все 7 items, full Claude
 *   npm run canary -- --items 1,3,5               # subset (~$3, ~3 мин)
 *   npm run canary -- --no-claude                 # dry-run (без Claude API)
 *   npm run canary -- --out-dir /tmp/canary-test  # override output dir
 *
 * Exit codes: 0=pass, 1=review, 2=rollback, 3=all-items-errored.
 *
 * НЕ запускается в CI (требует ANTHROPIC_API_KEY + платный API).
 */

import { promises as fs } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';

import {
  TranscriptSchema,
  ClientContextSchema,
  type Stakeholder,
  type OkrKr,
  type Transcript,
} from '../src/types.js';
import type { runF1 as runF1Fn, RunF1Result } from '../src/f1-report.js';
import { F1PipelineError } from '../src/errors.js';
import type { Config } from '../src/config.js';
import type { logger as RootLogger } from '../src/logger.js';
import {
  computeStructuralDiff,
  runSemanticAssertions,
  classifyVerdict,
  aggregateRunVerdict,
  extractCurrentPromptVersion,
  renderMarkdownReport,
  renderJsonReport,
  type CanaryItemResult,
  type CanaryRunResult,
  type CanaryRunMeta,
  type ActualPipelineOutput,
  type ReferencePipelineOutput,
  type Verdict,
  type ManifestItem,
} from '../src/utils/canary-diff.js';

// ─────────────────────────────────────────────────────────────────────────────
// Pricing snapshot (claude-sonnet-4-6) — обновлять вручную при изменении
// Anthropic prices. Источник: PRD line 700 + architecture cost-table.
// ─────────────────────────────────────────────────────────────────────────────
const PRICING = {
  inputPerToken: 0.000003, // $3 / 1M input tokens
  outputPerToken: 0.000015, // $15 / 1M output tokens
};
const APPROX_COST_PER_ITEM_USD = 1.0;
const PER_ITEM_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-6';

type CanaryLogger = Pick<typeof RootLogger, 'child' | 'info' | 'warn'>;
type RuntimeDeps = {
  model: string;
  log: CanaryLogger;
  runF1?: typeof runF1Fn;
};

const silentLogger: CanaryLogger = {
  child: () => silentLogger,
  info: () => undefined,
  warn: () => undefined,
};

// ─────────────────────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────────────────────

interface CanaryArgs {
  items?: number[];
  outDir?: string;
  noClaude: boolean;
  clientId: string;
}

function printUsage(): void {
  console.log(
    `Usage: tsx scripts/canary.ts [options]
Options:
  --items 1,3,5       Restrict to given item numbers (default: all from manifest)
  --out-dir <path>    Override output dir (default: data/canary-results/<timestamp>)
  --no-claude         Dry-run; reuse reference as actual, no Claude API calls
  --client-id <id>    ClientId for runF1 meta (default: geonline)
  --help, -h          This help`,
  );
}

function parseArgs(argv: string[]): CanaryArgs {
  let items: number[] | undefined;
  let outDir: string | undefined;
  let noClaude = false;
  let clientId = 'geonline';

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--items' && argv[i + 1] !== undefined) {
      const raw = argv[++i]!;
      items = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => {
          const n = Number(s);
          if (!Number.isInteger(n) || n < 1) {
            console.error(`Error: --items value '${s}' is not a positive integer`);
            process.exit(1);
          }
          return n;
        });
      if (items.length === 0) {
        console.error('Error: --items must contain at least one item');
        process.exit(1);
      }
    } else if (a === '--out-dir' && argv[i + 1] !== undefined) {
      outDir = argv[++i]!;
    } else if (a === '--no-claude') {
      noClaude = true;
    } else if (a === '--client-id' && argv[i + 1] !== undefined) {
      clientId = argv[++i]!;
    } else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    } else {
      console.error(`Error: unknown argument '${a}'`);
      printUsage();
      process.exit(1);
    }
  }

  return { items, outDir, noClaude, clientId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Data loading
// ─────────────────────────────────────────────────────────────────────────────

const CanaryItemSchema = z.object({
  n: z.number().int().positive(),
  topName: z.string().min(1),
  meetingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  department: z.string().optional(),
});

const CanaryConfigSchema = z.object({
  items: z.array(CanaryItemSchema).min(1),
});

type CanaryItemConfig = z.infer<typeof CanaryItemSchema>;

const ManifestItemSchema = z.object({
  n: z.number().int().positive(),
  scenario: z.string().optional(),
  stats: z.object({
    commitments: z.number().int().nonnegative().default(0),
    decisions: z.number().int().nonnegative().optional(),
    facts: z.number().int().nonnegative().optional(),
    citations: z.number().int().nonnegative().optional(),
    okr_discussed: z.number().int().nonnegative().optional(),
    okr_mentioned: z.number().int().nonnegative().optional(),
    alerts: z.number().int().nonnegative().optional(),
  }),
});

const ManifestSchema = z.object({
  items: z.array(ManifestItemSchema).min(1),
  semantic_checks: z.record(z.string(), z.string()).optional(),
});

const snakeToCamel = (s: string): string =>
  s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

function rekeyCamel<T>(obj: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[snakeToCamel(k)] = v;
  return out as T;
}

function nowIsoWithOffset(): string {
  return new Date().toISOString().replace(/Z$/, '+00:00');
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await fs.readFile(path, 'utf8')) as T;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadClientContext(clientId: string) {
  const stakeholdersRaw = (await readJson<Record<string, unknown>[]>(
    'data/stakeholder-map.json',
  )).map((r) => rekeyCamel<Stakeholder>(r));
  const okrRaw = await readJson<{ krs: Record<string, unknown>[] }>(
    'data/okr-context.json',
  );
  const okrs = okrRaw.krs.map((r) => rekeyCamel<OkrKr>(r));
  return ClientContextSchema.parse({
    clientId,
    stakeholders: stakeholdersRaw,
    okrs,
    f5Metrics: [],
    readAt: nowIsoWithOffset(),
  });
}

/**
 * Собирает RunF1Result-shape объект из golden reference — для `--no-claude` dry-run.
 * НЕ покрывает полные runF1 поля (openCommitmentsBefore, rawResponses); только то,
 * что используется в computeStructuralDiff и runSemanticAssertions.
 */
function referenceAsRunF1Result(
  reference: ReferencePipelineOutput,
  topName: string,
  meetingDate: string,
  clientId: string,
): ActualPipelineOutput & {
  tokens: { input: number; output: number };
  durationsMs: { extraction: number; analysis: number; format: number; total: number };
} {
  return {
    extraction: reference.extraction,
    analysis: { ...reference.analysis },
    formattedReport: {
      partial: false,
      sections: reference.format.report_sections,
    },
    tokens: { input: 0, output: 0 },
    durationsMs: { extraction: 0, analysis: 0, format: 0, total: 0 },
  } as ActualPipelineOutput & {
    tokens: { input: number; output: number };
    durationsMs: { extraction: number; analysis: number; format: number; total: number };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Output dir helpers
// ─────────────────────────────────────────────────────────────────────────────

function timestampSlug(now: Date): string {
  // 2026-05-23T05-12-34 (avoid ':' for Windows compat)
  const pad = (n: number): string => String(n).padStart(2, '0');
  const y = now.getUTCFullYear();
  const mo = pad(now.getUTCMonth() + 1);
  const d = pad(now.getUTCDate());
  const h = pad(now.getUTCHours());
  const mi = pad(now.getUTCMinutes());
  const s = pad(now.getUTCSeconds());
  return `${y}-${mo}-${d}T${h}-${mi}-${s}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

interface RunContext {
  args: CanaryArgs;
  outDir: string;
  selectedItems: number[];
  manifestByN: Map<number, ManifestItem>;
  configByN: Map<number, CanaryItemConfig>;
  promptsVersion: string | 'unknown';
  semanticChecksSource: 'manifest' | 'built-in-defaults';
  runtime: RuntimeDeps;
}

async function preflight(): Promise<RunContext> {
  const args = parseArgs(process.argv.slice(2));
  const runtime = await loadRuntime(args);

  // Manifest
  const manifestRaw = await readJson<unknown>('data/golden/manifest.json');
  const manifest = ManifestSchema.parse(manifestRaw);
  const manifestByN = new Map<number, ManifestItem>(
    manifest.items.map((it) => [it.n, it as ManifestItem]),
  );
  const semanticChecksSource = manifest.semantic_checks
    ? 'manifest'
    : 'built-in-defaults';
  if (semanticChecksSource === 'built-in-defaults') {
    console.warn(
      'Warning: data/golden/manifest.json has no semantic_checks; using built-in defaults.',
    );
    runtime.log.warn(
      { step: 'canary.semantic_checks_defaults' },
      'manifest semantic_checks missing; using built-in defaults',
    );
  }

  // Canary config
  let canaryConfigRaw: unknown;
  try {
    canaryConfigRaw = await readJson('data/golden/canary-items.json');
  } catch (err) {
    console.error(
      `Error: data/golden/canary-items.json is missing or unreadable — required for canary (Story 1.11 setup).`,
    );
    console.error(String((err as { message?: unknown }).message ?? err));
    process.exit(1);
  }
  let canaryConfig;
  try {
    canaryConfig = CanaryConfigSchema.parse(canaryConfigRaw);
  } catch (err) {
    console.error('Error: data/golden/canary-items.json failed schema validation.');
    console.error(String(err));
    process.exit(1);
  }
  const configByN = new Map<number, CanaryItemConfig>(
    canaryConfig.items.map((it) => [it.n, it]),
  );

  // Prompts changelog (warn-only)
  let promptsVersion: string | 'unknown' = 'unknown';
  try {
    const changelog = await fs.readFile('prompts/CHANGELOG.md', 'utf8');
    promptsVersion = extractCurrentPromptVersion(changelog);
  } catch {
    runtime.log
      .child({ step: 'canary.prompts_version_unknown' })
      .warn('prompts/CHANGELOG.md not found — promptsVersion=unknown');
  }

  // Compute selected items: intersection of CLI --items (if set) and manifest
  let selectedItems: number[];
  const manifestNs = manifest.items.map((it) => it.n).sort((a, b) => a - b);
  if (args.items) {
    selectedItems = args.items.filter((n) => manifestByN.has(n));
    const missing = args.items.filter((n) => !manifestByN.has(n));
    if (missing.length > 0) {
      console.error(
        `Warning: --items contains numbers not in manifest: ${missing.join(', ')} (skipped)`,
      );
    }
    if (selectedItems.length === 0) {
      console.error('Error: no selected --items are present in manifest');
      process.exit(1);
    }
  } else {
    selectedItems = manifestNs;
  }

  // Output dir
  const ts = timestampSlug(new Date());
  const defaultOut = join('data', 'canary-results', ts);
  const outDir = args.outDir
    ? isAbsolute(args.outDir)
      ? args.outDir
      : join(process.cwd(), args.outDir)
    : join(process.cwd(), defaultOut);
  await fs.mkdir(outDir, { recursive: true });

  return {
    args,
    outDir,
    selectedItems,
    manifestByN,
    configByN,
    promptsVersion,
    semanticChecksSource,
    runtime,
  };
}

async function loadRuntime(args: CanaryArgs): Promise<RuntimeDeps> {
  if (args.noClaude) {
    return {
      model: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
      log: silentLogger,
    };
  }

  const [{ config }, { logger: rootLogger }, { runF1 }] = await Promise.all([
    import('../src/config.js') as Promise<{ config: Config }>,
    import('../src/logger.js') as Promise<{ logger: typeof RootLogger }>,
    import('../src/f1-report.js') as Promise<{ runF1: typeof runF1Fn }>,
  ]);

  if (!config.ANTHROPIC_API_KEY || config.ANTHROPIC_API_KEY.length === 0) {
    console.error(
      'Error: ANTHROPIC_API_KEY is required for canary (omit with --no-claude for dry-run).',
    );
    process.exit(3);
  }

  return {
    model: config.ANTHROPIC_MODEL,
    log: rootLogger.child({
      pipeline: 'CANARY',
      step: 'canary.run',
      clientId: args.clientId,
    }),
    runF1,
  };
}

function printStartSummary(ctx: RunContext): void {
  const estimatedCost = ctx.args.noClaude
    ? 0
    : ctx.selectedItems.length * APPROX_COST_PER_ITEM_USD;
  console.log('🐤 Canary test starting');
  console.log(`- Model: ${ctx.runtime.model}`);
  console.log(`- Prompts: ${ctx.promptsVersion} (from prompts/CHANGELOG.md)`);
  console.log(`- Semantic checks: ${ctx.semanticChecksSource}`);
  console.log(
    `- Items: ${ctx.selectedItems.join(',')} (${ctx.selectedItems.length} total)`,
  );
  console.log(`- Output: ${ctx.outDir}`);
  console.log(
    `- Estimated cost: ${
      ctx.args.noClaude
        ? '$0 (dry-run, --no-claude)'
        : `~$${estimatedCost.toFixed(0)} (${ctx.selectedItems.length} × ~$${APPROX_COST_PER_ITEM_USD.toFixed(0)}/item)`
    }`,
  );
}

interface ProcessedItem {
  result: CanaryItemResult;
  tokens: { input: number; output: number };
  durationMs: number;
}

async function processItem(
  ctx: RunContext,
  n: number,
): Promise<ProcessedItem> {
  const itemDir = join(ctx.outDir, `item-${n}`);
  await fs.mkdir(itemDir, { recursive: true });

  const itemLog = ctx.runtime.log.child({ step: 'canary.item', itemN: n });
  itemLog.info({ step: 'canary.item_start' }, 'canary item starting');

  const itemConfig = ctx.configByN.get(n);
  if (!itemConfig) {
    const msg = `canary-items.json missing entry for item ${n}`;
    itemLog.warn({ step: 'canary.item_failed', reason: 'missing_canary_item' }, msg);
    return {
      result: {
        n,
        scenario: ctx.manifestByN.get(n)?.scenario ?? '',
        verdict: 'error',
        error: { code: 'missing_canary_item', message: msg },
        artifactsDir: itemDir,
      },
      tokens: { input: 0, output: 0 },
      durationMs: 0,
    };
  }

  const manifestItem = ctx.manifestByN.get(n);
  const scenario = manifestItem?.scenario ?? '';
  const startMs = Date.now();

  try {
    // Load transcript and reference
    const transcriptPath = `data/golden/transcript-${n}.json`;
    const referencePath = `data/golden/f1-reference-${n}.json`;

    if (!(await fileExists(transcriptPath))) {
      throw new F1PipelineError('persist', {
        reason: 'transcript_missing',
        path: transcriptPath,
      });
    }
    if (!(await fileExists(referencePath))) {
      throw new F1PipelineError('persist', {
        reason: 'reference_missing',
        path: referencePath,
      });
    }

    const transcriptRaw = await readJson<{
      speakers: unknown;
      metadata?: { date?: string; duration?: number; meeting_type?: string };
    }>(transcriptPath);

    if (!transcriptRaw.metadata) {
      transcriptRaw.metadata = {
        date: `${itemConfig.meetingDate}T08:00:00+05:00`,
        duration: 600,
        meeting_type: 'tracking_session',
      };
    } else {
      // Story 0.3 stub guard: метаданные могли быть записаны без offset.
      if (!transcriptRaw.metadata.date || transcriptRaw.metadata.date === 'unknown') {
        transcriptRaw.metadata.date = `${itemConfig.meetingDate}T08:00:00+05:00`;
      }
      transcriptRaw.metadata.duration ??= 600;
      transcriptRaw.metadata.meeting_type ??= 'tracking_session';
    }

    const transcript: Transcript = TranscriptSchema.parse(transcriptRaw);
    const reference = (await readJson<ReferencePipelineOutput>(referencePath));

    const clientContext = await loadClientContext(ctx.args.clientId);

    let actual: ActualPipelineOutput & {
      tokens: { input: number; output: number };
      durationsMs: { total: number };
    };

    if (ctx.args.noClaude) {
      actual = referenceAsRunF1Result(
        reference,
        itemConfig.topName,
        itemConfig.meetingDate,
        ctx.args.clientId,
      );
      await fs.writeFile(
        join(itemDir, 'runF1-result.json'),
        JSON.stringify(
          { _note: 'dry-run --no-claude: reference reused as actual', ...actual },
          null,
          2,
        ),
      );
    } else {
      if (!ctx.runtime.runF1) {
        throw new F1PipelineError('persist', {
          reason: 'runtime_missing_runF1',
        });
      }
      const f1Result: RunF1Result = await ctx.runtime.runF1({
        transcript,
        clientContext,
        meta: {
          clientId: ctx.args.clientId,
          topName: itemConfig.topName,
          meetingDate: itemConfig.meetingDate,
          meetingType: transcript.metadata.meeting_type,
        },
        deps: {
          rootDir: itemDir,
          logger: itemLog,
          signal: AbortSignal.timeout(PER_ITEM_TIMEOUT_MS),
        },
      });
      await fs.writeFile(
        join(itemDir, 'runF1-result.json'),
        JSON.stringify(f1Result, null, 2),
      );
      actual = {
        extraction: {
          commitments: f1Result.extraction.commitments,
          citations: f1Result.extraction.citations,
          decisions: f1Result.extraction.decisions,
          facts: f1Result.extraction.facts,
        },
        analysis: {
          okr_coverage: f1Result.analysis.okr_coverage,
          alerts: f1Result.analysis.alerts,
        },
        formattedReport: f1Result.formattedReport.partial
          ? { partial: true }
          : {
              partial: false,
              sections: f1Result.formattedReport.sections,
            },
        tokens: f1Result.tokens,
        durationsMs: { total: f1Result.durationsMs.total },
      };
    }

    const diff = computeStructuralDiff(actual, reference);
    const assertions = runSemanticAssertions(actual, manifestItem, clientContext);
    const verdict = classifyVerdict({
      diffPercent: diff.diffPercent,
      assertions,
    });

    await fs.writeFile(
      join(itemDir, 'diff.json'),
      JSON.stringify({ diff, assertions, verdict }, null, 2),
    );

    const durationMs = actual.durationsMs.total || Date.now() - startMs;
    itemLog.info(
      {
        step: 'canary.item_done',
        verdict,
        diffPercent: diff.diffPercent,
        tokens: actual.tokens,
        durationMs,
      },
      'canary item complete',
    );

    return {
      result: {
        n,
        scenario,
        verdict,
        diff,
        assertions,
        tokens: actual.tokens,
        estimatedCostUsd: estimateCostUsd(actual.tokens),
        durationsMs: { total: durationMs },
        artifactsDir: itemDir,
      },
      tokens: actual.tokens,
      durationMs,
    };
  } catch (err) {
    const code =
      err instanceof F1PipelineError
        ? err.code
        : err instanceof Error && err.name === 'AbortError'
          ? 'timeout'
          : err instanceof Error
            ? err.name || 'unknown'
            : 'unknown';
    const message =
      err instanceof Error ? err.message : String(err ?? 'unknown error');
    itemLog.warn(
      { step: 'canary.item_failed', code, err: message },
      'canary item failed',
    );
    return {
      result: {
        n,
        scenario,
        verdict: 'error',
        error: { code, message },
        estimatedCostUsd: 0,
        artifactsDir: itemDir,
      },
      tokens: { input: 0, output: 0 },
      durationMs: Date.now() - startMs,
    };
  }
}

function estimateCostUsd(tokens: { input: number; output: number }): number {
  return tokens.input * PRICING.inputPerToken + tokens.output * PRICING.outputPerToken;
}

function exitCodeForVerdict(verdict: Verdict): number {
  switch (verdict) {
    case 'pass':
      return 0;
    case 'review':
      return 1;
    case 'rollback':
      return 2;
    case 'error':
      return 3;
  }
}

async function main(): Promise<void> {
  const ctx = await preflight();
  printStartSummary(ctx);

  const runStart = Date.now();
  const processed: ProcessedItem[] = [];
  for (const n of ctx.selectedItems) {
    processed.push(await processItem(ctx, n));
  }
  const totalDurationMs = Date.now() - runStart;

  const items = processed.map((p) => p.result);
  const verdict = aggregateRunVerdict(items.map((i) => i.verdict));

  // Aggregate tokens + cost
  let totalIn = 0;
  let totalOut = 0;
  for (const p of processed) {
    totalIn += p.tokens.input;
    totalOut += p.tokens.output;
  }
  const estimatedCostUsd =
    estimateCostUsd({ input: totalIn, output: totalOut });

  const meta: CanaryRunMeta = {
    timestamp: new Date().toISOString(),
    model: ctx.runtime.model,
    promptsVersion: ctx.promptsVersion,
    itemsRequested: ctx.selectedItems,
    outDir: ctx.outDir,
    totalTokens: { input: totalIn, output: totalOut },
    estimatedCostUsd,
    totalDurationMs,
    pricing: { ...PRICING },
    noClaude: ctx.args.noClaude,
    semanticChecksSource: ctx.semanticChecksSource,
  };

  const run: CanaryRunResult = { items, verdict, meta };

  const reportMd = renderMarkdownReport(run);
  const reportJson = renderJsonReport(run);
  await fs.writeFile(join(ctx.outDir, 'report.md'), reportMd);
  await fs.writeFile(
    join(ctx.outDir, 'report.json'),
    JSON.stringify(reportJson, null, 2),
  );

  ctx.runtime.log.info(
    {
      step: 'canary.report_written',
      verdict,
      reportPath: join(ctx.outDir, 'report.md'),
      totalDurationMs,
    },
    'canary report written',
  );

  // User-facing summary
  console.log('');
  console.log(`Verdict: ${verdict.toUpperCase()}. Report: ${join(ctx.outDir, 'report.md')}`);

  // Surface API instability warning (cf. Сценарий D)
  const errorItems = items.filter((i) => i.verdict === 'error');
  if (errorItems.length > 0 && verdict !== 'error') {
    console.log(
      `Warning: ${errorItems.length}/${items.length} items in error state — likely Claude API instability; consider re-run`,
    );
  }

  // Set exitCode instead of calling process.exit() to let pino transports flush
  // cleanly (pino-pretty worker thread requires natural process termination in dev).
  process.exitCode = exitCodeForVerdict(verdict);
}

main().catch((err) => {
  console.error('Canary CLI fatal:', err);
  process.exitCode = 3;
});
