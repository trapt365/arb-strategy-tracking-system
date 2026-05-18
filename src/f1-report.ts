import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';
import { logger as rootLogger, type Logger } from './logger.js';
import { alertOps } from './ops.js';
import { loadPrompt } from './utils/prompt-loader.js';
import { callClaude, callClaudeSafe, sanitizeClaudeErrorContext } from './adapters/claude.js';
import {
  loadOpenCommitments,
  topNameSlug,
} from './utils/commitments-history.js';
import {
  ExtractionOutputSchema,
  AnalysisOutputSchema,
  FormatOutputSchema,
  DeliveryReadyReportSchema,
  type ExtractionOutput,
  type AnalysisOutput,
  type FormatOutput,
  type DeliveryReadyReport,
  type PartialReason,
  type Commitment,
  type CommitmentStatusUpdate,
  type Transcript,
  type ClientContext,
  type Stakeholder,
  type OkrKr,
  type F5Metric,
} from './types.js';
import { F1PipelineError } from './errors.js';

export { F1PipelineError } from './errors.js';
export type {
  ExtractionOutput,
  AnalysisOutput,
  FormatOutput,
  DeliveryReadyReport,
  Commitment,
} from './types.js';

const F1_TOTAL_LATENCY_WARN_MS = 15 * 60 * 1000;
const MEETING_DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}/;

// Filesystem-unsafe chars + path separators. Aligned with `topNameSlug` for symmetry;
// applied to clientId before path joining so callers can't traverse out of rootDir.
function slugifyClientId(clientId: string): string {
  return clientId.trim().toLowerCase().replace(/\s+/g, '-').replace(/[\\/<>:"|?*.]/g, '_');
}

// Reject slugs that collapse to empty after sanitization — they would produce
// double-dash filenames like `f1--{reportId}.report.json` that collide across
// distinct tops with all-special-char names.
function safeTopNameSlug(topName: string): string {
  const slug = topNameSlug(topName);
  if (!slug) {
    throw new F1PipelineError('delivery_prep', {
      reason: 'topName_slug_empty',
      topName,
    });
  }
  return slug;
}

export interface RunF1Steps12Input {
  transcript: Transcript;
  clientContext: ClientContext;
  meta: {
    clientId: string;
    topName: string;
    meetingDate: string;
    meetingType?: string;
  };
  deps?: {
    logger?: Logger;
    signal?: AbortSignal;
    rootDir?: string;
    now?: Date;
    callClaude?: typeof callClaude;
    loadOpenCommitments?: typeof loadOpenCommitments;
    loadPrompt?: typeof loadPrompt;
  };
}

export interface RunF1Steps12Result {
  extraction: ExtractionOutput;
  analysis: AnalysisOutput;
  rawResponses: { extraction: string; analysis: string };
  openCommitmentsBefore: Commitment[];
  /** Relative paths (clientId/date/file) of extraction.json files that contributed
   * to openCommitmentsBefore. Carried through to commitments-updates.json audit trail. */
  openCommitmentsSourceFiles: string[];
  reportId: string;
  durationsMs: { extraction: number; analysis: number; total: number };
  tokens: { input: number; output: number };
}

export function formatTranscriptForPrompt(transcript: Transcript): string {
  const all: { speaker: string; start: number; text: string }[] = [];
  for (const sp of transcript.speakers) {
    for (const seg of sp.segments) {
      all.push({ speaker: sp.name, start: seg.start, text: seg.text });
    }
  }
  all.sort((a, b) => a.start - b.start);
  return all.map((seg) => `[${formatTimestamp(seg.start)}] ${seg.speaker}: ${seg.text.trim()}`).join('\n');
}

function formatTimestamp(startSec: number): string {
  const s = Math.max(0, Math.floor(startSec));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  // Use HH:MM:SS for meetings >= 1 hour; downstream regex expecting MM:SS would
  // misinterpret values like "90:00" as 90 minutes and break on rollover.
  if (hh > 0) return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  return `${pad(mm)}:${pad(ss)}`;
}

export function formatStakeholderMapForPrompt(stakeholders: Stakeholder[]): string {
  return JSON.stringify(stakeholders, null, 2);
}

export function formatOkrContextForPrompt(
  okrs: OkrKr[],
  f5Metrics: F5Metric[],
): string {
  // AC #10: f5Metrics всегда присутствует в payload (как [] если пусто) — промпт
  // полагается на наличие поля для условной ветки "верификация заявлений топов".
  return JSON.stringify({ okrs, f5Metrics }, null, 2);
}

interface PersistInput {
  raw: string;
  parsed: unknown | null;
}

async function persistStep(
  meta: { clientId: string; topName: string; meetingDate: string },
  reportId: string,
  stepName: 'extraction' | 'analysis',
  data: PersistInput,
  rootDir: string,
  log: Pick<Logger, 'error' | 'warn'>,
): Promise<void> {
  try {
    const dateDir = meta.meetingDate.slice(0, 10);
    const dir = join(rootDir, slugifyClientId(meta.clientId), dateDir);
    await fs.mkdir(dir, { recursive: true });
    const slug = safeTopNameSlug(meta.topName);
    const baseName = `f1-${slug}-${reportId}`;
    await fs.writeFile(join(dir, `${baseName}.${stepName}.raw.txt`), data.raw, 'utf8');
    if (data.parsed !== null) {
      await fs.writeFile(
        join(dir, `${baseName}.${stepName}.json`),
        JSON.stringify(data.parsed, null, 2),
        'utf8',
      );
    }
  } catch (err) {
    log.error(
      { step: `f1.${stepName}.persist_failed`, err },
      'persist failed (warn-only)',
    );
    alertOps({
      pipeline: 'F1',
      step: `f1.${stepName}.persist`,
      clientId: meta.clientId,
      error: err,
    });
  }
}

interface MetaPayload {
  reportId: string;
  clientId: string;
  topName: string;
  meetingDate: string;
  meetingType?: string;
  model: string;
  durationsMs: RunF1Steps12Result['durationsMs'] & { format?: number };
  tokens: RunF1Steps12Result['tokens'];
  openCommitmentsBefore: Commitment[];
  status: 'ok' | 'error' | 'partial' | 'aborted';
  errorCode?: string;
  // 1.4b additions:
  partial?: boolean;
  partialReason?: PartialReason;
  formatTokens?: { input: number; output: number };
}

async function persistMeta(
  meta: { clientId: string; topName: string; meetingDate: string },
  reportId: string,
  payload: MetaPayload,
  rootDir: string,
  log: Pick<Logger, 'error' | 'warn'>,
): Promise<void> {
  try {
    const dateDir = meta.meetingDate.slice(0, 10);
    const dir = join(rootDir, slugifyClientId(meta.clientId), dateDir);
    await fs.mkdir(dir, { recursive: true });
    const slug = safeTopNameSlug(meta.topName);
    const baseName = `f1-${slug}-${reportId}`;
    await fs.writeFile(
      join(dir, `${baseName}.meta.json`),
      JSON.stringify(payload, null, 2),
      'utf8',
    );
  } catch (err) {
    log.warn({ step: 'f1.meta.persist_failed', err }, 'meta persist failed');
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' ||
      (err as Error & { code?: string }).code === 'ABORT_ERR')
  );
}

export async function runF1Steps12(
  input: RunF1Steps12Input,
): Promise<RunF1Steps12Result> {
  const deps = input.deps ?? {};
  const baseLogger = deps.logger ?? rootLogger;
  const log = baseLogger.child({
    pipeline: 'F1',
    step: 'f1.run',
    clientId: input.meta.clientId,
    topName: input.meta.topName,
  });
  const rootDir = deps.rootDir ?? 'data';
  const claudeFn = deps.callClaude ?? callClaude;
  const loadCommitsFn = deps.loadOpenCommitments ?? loadOpenCommitments;
  const promptFn = deps.loadPrompt ?? loadPrompt;
  const now = deps.now;

  // AC #11 — defensive empty client context guard. Throws extraction_validation
  // (reason: 'empty_client_context') per AC spec, so callers can treat it as a
  // pre-Claude validation failure within the same code path as schema failures.
  // Defensive: Array.isArray + optional-chain protects against test inputs that
  // bypass Zod with `as unknown as ClientContext` and pass `undefined` fields.
  const stakeholders = input.clientContext?.stakeholders;
  const okrs = input.clientContext?.okrs;
  if (
    !Array.isArray(stakeholders) ||
    stakeholders.length === 0 ||
    !Array.isArray(okrs) ||
    okrs.length === 0
  ) {
    throw new F1PipelineError('extraction_validation', {
      reason: 'empty_client_context',
      stepName: 'extraction',
      clientId: input.meta.clientId,
      topName: input.meta.topName,
      stakeholdersCount: Array.isArray(stakeholders) ? stakeholders.length : 0,
      okrsCount: Array.isArray(okrs) ? okrs.length : 0,
    });
  }

  // Validate meetingDate format up-front; `.slice(0, 10)` is used to build the
  // date directory, and a non-ISO date would create a malformed dir invisible
  // to `loadOpenCommitments` (which only scans /^\d{4}-\d{2}-\d{2}$/ dirs).
  if (!MEETING_DATE_PREFIX_RE.test(input.meta.meetingDate ?? '')) {
    throw new F1PipelineError('extraction_validation', {
      reason: 'invalid_meeting_date',
      stepName: 'extraction',
      meetingDate: input.meta.meetingDate,
    });
  }

  const reportId = randomUUID().slice(0, 8);
  const totalStart = Date.now();
  const durationsMs: RunF1Steps12Result['durationsMs'] = {
    extraction: 0,
    analysis: 0,
    total: 0,
  };
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let extraction: ExtractionOutput | undefined;
  let analysis: AnalysisOutput | undefined;
  let extractionRaw: string | undefined;
  let analysisRaw: string | undefined;
  let openCommitments: Commitment[] = [];
  let openCommitmentsSourceFiles: string[] = [];
  let finalStatus: 'ok' | 'error' | 'aborted' = 'error';
  let errorCode: string | undefined;

  const transcriptText = formatTranscriptForPrompt(input.transcript);
  const stakeholderText = formatStakeholderMapForPrompt(
    input.clientContext.stakeholders,
  );
  const okrText = formatOkrContextForPrompt(
    input.clientContext.okrs,
    input.clientContext.f5Metrics,
  );

  try {
    // === Step 1: extraction ===
    const extractionPrompt = await promptFn('extraction', {
      transcript: transcriptText,
      stakeholderMap: stakeholderText,
    });

    log.info(
      {
        step: 'f1.extraction.start',
        model: config.ANTHROPIC_MODEL,
        transcriptDurationSec: input.transcript.metadata.duration,
        transcriptCharCount: transcriptText.length,
        promptCharCount: extractionPrompt.length,
      },
      'extraction step starting',
    );

    const extractionStart = Date.now();
    try {
      const result = await claudeFn(extractionPrompt, {
        stepName: 'extraction',
        schema: ExtractionOutputSchema,
        signal: deps.signal,
        logger: log,
      });
      extractionRaw = result.raw;
      extraction = result.parsed;
      totalInputTokens += result.usage.input_tokens;
      totalOutputTokens += result.usage.output_tokens;
      await persistStep(
        input.meta,
        reportId,
        'extraction',
        { raw: result.raw, parsed: result.parsed },
        rootDir,
        log,
      );
    } catch (err) {
      durationsMs.extraction = Date.now() - extractionStart;
      if (err instanceof F1PipelineError && err.code === 'claude_response_invalid') {
        const raw = (err.context.raw as string | undefined) ?? extractionRaw;
        if (raw) {
          await persistStep(
            input.meta,
            reportId,
            'extraction',
            { raw, parsed: null },
            rootDir,
            log,
          );
        }
        // P9: drop full raw transcript from wrapped context (logged + alertOps);
        // raw stays available via inner err for persistence above this branch.
        const wrapped = new F1PipelineError(
          'extraction_validation',
          { ...sanitizeClaudeErrorContext(err.context), stepName: 'extraction' },
          { cause: err },
        );
        errorCode = wrapped.code;
        log.error(
          { step: 'f1.extraction.validation_failed', err: wrapped, validationErrors: err.context.validationErrors },
          'extraction validation failed',
        );
        alertOps({
          pipeline: 'F1',
          step: 'f1.extraction.validation',
          clientId: input.meta.clientId,
          error: wrapped,
          context: { validationErrors: err.context.validationErrors },
        });
        throw wrapped;
      }
      throw err;
    }
    durationsMs.extraction = Date.now() - extractionStart;

    log.info(
      {
        step: 'f1.extraction.complete',
        durationMs: durationsMs.extraction,
        commitmentsCount: extraction.commitments.length,
        citationsCount: extraction.citations.length,
        decisionsCount: extraction.decisions.length,
        factsCount: extraction.facts.length,
        speakerCheckCount: extraction.speaker_check?.length ?? 0,
      },
      'extraction step complete',
    );

    // Early-abort check between steps so we don't waste an API call when the
    // caller has already cancelled after extraction (AC #13 — prompt cancel).
    if (deps.signal?.aborted) {
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      throw abortErr;
    }

    // === Open commitments — between steps ===
    // Wrap FS lookup in its own catch: a bad filesystem state should not be
    // misreported as a Claude API failure by the outer catch handler.
    let commitsRes: Awaited<ReturnType<typeof loadCommitsFn>>;
    try {
      commitsRes = await loadCommitsFn(input.meta.clientId, input.meta.topName, {
        rootDir,
        now,
        logger: log,
      });
    } catch (err) {
      log.warn(
        { step: 'f1.openCommitments.load_failed', err },
        'open commitments lookup failed, proceeding with empty history',
      );
      commitsRes = { openCommitments: [], sourceFiles: [] };
    }
    openCommitments = commitsRes.openCommitments;
    openCommitmentsSourceFiles = commitsRes.sourceFiles;
    log.info(
      {
        step: 'f1.openCommitments.loaded',
        count: openCommitments.length,
        sourceFiles: commitsRes.sourceFiles.slice(0, 5),
      },
      'open commitments loaded',
    );

    // === Step 2: analysis ===
    const analysisPrompt = await promptFn('analysis', {
      okrContext: okrText,
      extractionOutput: JSON.stringify(extraction, null, 2),
      stakeholderMap: stakeholderText,
      openCommitments: JSON.stringify(openCommitments, null, 2),
    });

    log.info(
      {
        step: 'f1.analysis.start',
        extractionPayloadSize: analysisPrompt.length,
      },
      'analysis step starting',
    );

    const analysisStart = Date.now();
    try {
      const result = await claudeFn(analysisPrompt, {
        stepName: 'analysis',
        schema: AnalysisOutputSchema,
        signal: deps.signal,
        logger: log,
      });
      analysisRaw = result.raw;
      analysis = result.parsed;
      totalInputTokens += result.usage.input_tokens;
      totalOutputTokens += result.usage.output_tokens;
      await persistStep(
        input.meta,
        reportId,
        'analysis',
        { raw: result.raw, parsed: result.parsed },
        rootDir,
        log,
      );
    } catch (err) {
      durationsMs.analysis = Date.now() - analysisStart;
      if (err instanceof F1PipelineError && err.code === 'claude_response_invalid') {
        const raw = (err.context.raw as string | undefined) ?? analysisRaw;
        if (raw) {
          await persistStep(
            input.meta,
            reportId,
            'analysis',
            { raw, parsed: null },
            rootDir,
            log,
          );
        }
        // P9: drop full raw transcript from wrapped context (logged + alertOps).
        const wrapped = new F1PipelineError(
          'analysis_validation',
          { ...sanitizeClaudeErrorContext(err.context), stepName: 'analysis' },
          { cause: err },
        );
        errorCode = wrapped.code;
        log.error(
          { step: 'f1.analysis.validation_failed', err: wrapped, validationErrors: err.context.validationErrors },
          'analysis validation failed',
        );
        alertOps({
          pipeline: 'F1',
          step: 'f1.analysis.validation',
          clientId: input.meta.clientId,
          error: wrapped,
          context: { validationErrors: err.context.validationErrors },
        });
        throw wrapped;
      }
      throw err;
    }
    durationsMs.analysis = Date.now() - analysisStart;

    log.info(
      {
        step: 'f1.analysis.complete',
        durationMs: durationsMs.analysis,
        krCount: analysis.okr_coverage.length,
        alertsCount: analysis.alerts.length,
        statusUpdatesCount: analysis.commitments_status_updates?.length ?? 0,
      },
      'analysis step complete',
    );

    finalStatus = 'ok';
    durationsMs.total = Date.now() - totalStart;

    return {
      extraction,
      analysis,
      rawResponses: {
        extraction: extractionRaw ?? '',
        analysis: analysisRaw ?? '',
      },
      openCommitmentsBefore: openCommitments,
      openCommitmentsSourceFiles,
      reportId,
      durationsMs: {
        extraction: durationsMs.extraction,
        analysis: durationsMs.analysis,
        total: durationsMs.total,
      },
      tokens: { input: totalInputTokens, output: totalOutputTokens },
    };
  } catch (err) {
    // Already-typed pipeline errors propagate; wrap unknowns into claude_api.
    if (err instanceof F1PipelineError) {
      errorCode = err.code;
      throw err;
    }
    if (isAbortError(err)) {
      finalStatus = 'aborted';
      log.warn({ step: 'f1.run.aborted' }, 'pipeline aborted by caller');
      throw err;
    }
    const wrapped = new F1PipelineError(
      'claude_api',
      {
        stepName: 'f1.run',
        message: (err as Error)?.message,
      },
      { cause: err },
    );
    errorCode = wrapped.code;
    alertOps({
      pipeline: 'F1',
      step: 'f1.run',
      clientId: input.meta.clientId,
      error: wrapped,
    });
    log.error({ step: 'f1.run.failed', err: wrapped }, 'pipeline failed');
    throw wrapped;
  } finally {
    durationsMs.total = Date.now() - totalStart;
    // P6: emit `f1.steps12.total` (NOT `f1.run.total`) — the orchestrator owns
    // the canonical pipeline-total log to avoid duplicate emissions per run.
    log.info(
      {
        step: 'f1.steps12.total',
        totalDurationMs: durationsMs.total,
        status: finalStatus,
      },
      'F1 steps 1-2 complete',
    );
    if (durationsMs.total > F1_TOTAL_LATENCY_WARN_MS) {
      log.warn(
        {
          step: 'f1.steps12.total',
          totalDurationMs: durationsMs.total,
          status: finalStatus,
          slaExceeded: true,
        },
        'F1 steps 1-2 exceeded 15-minute SLA',
      );
    }

    await persistMeta(
      input.meta,
      reportId,
      {
        reportId,
        clientId: input.meta.clientId,
        topName: input.meta.topName,
        meetingDate: input.meta.meetingDate,
        meetingType: input.meta.meetingType,
        model: config.ANTHROPIC_MODEL,
        durationsMs,
        tokens: { input: totalInputTokens, output: totalOutputTokens },
        openCommitmentsBefore: openCommitments,
        status: finalStatus,
        errorCode,
      },
      rootDir,
      log,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Story 1.4b: F1 шаги 3-4 (formatting + delivery prep)
// ─────────────────────────────────────────────────────────────────────────────

export interface RunF1Steps34Input {
  extraction: ExtractionOutput;
  analysis: AnalysisOutput;
  openCommitmentsBefore: Commitment[];
  /** Optional audit-trail of extraction.json files that produced openCommitmentsBefore.
   * Default: [] (standalone runF1Steps34 callers don't need to provide this). */
  openCommitmentsSourceFiles?: string[];
  meta: {
    clientId: string;
    topName: string;
    department?: string;
    meetingDate: string;
    meetingType?: string;
    reportId?: string;
  };
  deps?: {
    logger?: Logger;
    signal?: AbortSignal;
    rootDir?: string;
    callClaudeSafe?: typeof callClaudeSafe;
    loadPrompt?: typeof loadPrompt;
  };
}

export interface RunF1Steps34Result {
  formattedReport: DeliveryReadyReport;
  partial: boolean;
  partialReason?: PartialReason;
  rawResponses: { format: string | null };
  durationsMs: { format: number };
  tokens: { input: number; output: number };
  reportId: string;
}

export interface RunF1Result extends Omit<RunF1Steps12Result, 'durationsMs' | 'tokens' | 'rawResponses'> {
  formattedReport: DeliveryReadyReport;
  partial: boolean;
  partialReason?: PartialReason;
  durationsMs: { extraction: number; analysis: number; format: number; total: number };
  tokens: { input: number; output: number };
  rawResponses: { extraction: string; analysis: string; format: string | null };
}

/**
 * ISO-8601 week number (Mon-Sun, week containing Jan 4 is week 1).
 * Throws on an unparseable date — a silent `'—'` would leak as `нед. —` into
 * the prompt header and degrade Claude output without surfacing the bug.
 */
export function getISOWeekNumber(isoDate: string): string {
  const d = new Date(isoDate);
  if (Number.isNaN(d.getTime())) {
    throw new F1PipelineError('delivery_prep', {
      reason: 'invalid_meeting_date',
      meetingDate: isoDate,
    });
  }
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const week1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const weekNum =
    1 +
    Math.round(
      ((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7,
    );
  return String(weekNum);
}

export function assembleFullDeliveryReport(args: {
  reportId: string;
  meta: RunF1Steps34Input['meta'];
  extraction: ExtractionOutput;
  analysis: AnalysisOutput;
  formatOutput: FormatOutput;
}): DeliveryReadyReport {
  return {
    partial: false,
    reportId: args.reportId,
    clientId: args.meta.clientId,
    topName: args.meta.topName,
    meetingDate: args.meta.meetingDate,
    summaryLine: args.formatOutput.summary_line,
    sections: args.formatOutput.report_sections,
    commitments: args.extraction.commitments,
    alerts: args.analysis.alerts,
    topMessageDraft: args.formatOutput.top_message_draft,
  };
}

const PARTIAL_SUMMARY_BY_REASON: Record<PartialReason, string> = {
  format_step_failed: 'Автоформатирование не удалось — сырые данные извлечения',
  format_validation_failed: 'Формат отчёта повреждён — сырые данные извлечения',
  format_retry_exhausted: 'Автоформатирование не удалось — сырые данные извлечения',
};

export function assemblePartialDeliveryReport(args: {
  reportId: string;
  meta: RunF1Steps34Input['meta'];
  extraction: ExtractionOutput;
  analysis: AnalysisOutput;
  partialReason: PartialReason;
}): DeliveryReadyReport {
  return {
    partial: true,
    partialReason: args.partialReason,
    reportId: args.reportId,
    clientId: args.meta.clientId,
    topName: args.meta.topName,
    meetingDate: args.meta.meetingDate,
    summaryLine: PARTIAL_SUMMARY_BY_REASON[args.partialReason],
    sections: [],
    commitments: args.extraction.commitments,
    alerts: args.analysis.alerts,
    extractionFallback: {
      commitments: args.extraction.commitments,
      citations: args.extraction.citations.slice(0, 10),
      decisions: args.extraction.decisions,
      facts: args.extraction.facts,
    },
  };
}

// Wrap DeliveryReadyReportSchema.parse() with consistent delivery_prep error
// (P10). All partial-branches AND happy-path validate through this helper to
// guarantee that an assembly bug throws F1PipelineError('delivery_prep'),
// never a bare ZodError.
function validateDeliveryReport(
  report: DeliveryReadyReport,
  reason: 'partial_assembly_invalid' | 'full_assembly_invalid',
): void {
  try {
    DeliveryReadyReportSchema.parse(report);
  } catch (err) {
    throw new F1PipelineError(
      'delivery_prep',
      {
        reason,
        validationErrors: (err as { issues?: unknown }).issues,
      },
      { cause: err },
    );
  }
}

async function persistFormatStep(
  meta: { clientId: string; topName: string; meetingDate: string },
  reportId: string,
  data: { raw: string | null; parsed: FormatOutput | null },
  rootDir: string,
  log: Pick<Logger, 'error' | 'warn'>,
): Promise<void> {
  try {
    const dateDir = meta.meetingDate.slice(0, 10);
    const dir = join(rootDir, slugifyClientId(meta.clientId), dateDir);
    await fs.mkdir(dir, { recursive: true });
    const slug = safeTopNameSlug(meta.topName);
    const baseName = `f1-${slug}-${reportId}`;
    if (data.raw !== null) {
      await fs.writeFile(join(dir, `${baseName}.format.raw.txt`), data.raw, 'utf8');
    }
    if (data.parsed !== null) {
      await fs.writeFile(
        join(dir, `${baseName}.format.json`),
        JSON.stringify(data.parsed, null, 2),
        'utf8',
      );
    }
  } catch (err) {
    log.error(
      { step: 'f1.format.persist_failed', err },
      'format persist failed (warn-only)',
    );
    alertOps({
      pipeline: 'F1',
      step: 'f1.format.persist',
      clientId: meta.clientId,
      error: err,
    });
  }
}

async function persistDeliveryReport(
  meta: { clientId: string; topName: string; meetingDate: string },
  reportId: string,
  report: DeliveryReadyReport,
  rootDir: string,
  log: Pick<Logger, 'error' | 'warn'>,
): Promise<void> {
  try {
    const dateDir = meta.meetingDate.slice(0, 10);
    const dir = join(rootDir, slugifyClientId(meta.clientId), dateDir);
    await fs.mkdir(dir, { recursive: true });
    const slug = safeTopNameSlug(meta.topName);
    const baseName = `f1-${slug}-${reportId}`;
    await fs.writeFile(
      join(dir, `${baseName}.report.json`),
      JSON.stringify(report, null, 2),
      'utf8',
    );
  } catch (err) {
    log.error(
      { step: 'f1.report.persist_failed', err },
      'delivery report persist failed (warn-only)',
    );
    alertOps({
      pipeline: 'F1',
      step: 'f1.report.persist',
      clientId: meta.clientId,
      error: err,
    });
  }
}

async function persistCommitmentsUpdates(
  meta: { clientId: string; topName: string; meetingDate: string },
  reportId: string,
  updates: CommitmentStatusUpdate[],
  sourceFiles: string[],
  rootDir: string,
  log: Pick<Logger, 'error' | 'warn' | 'info'>,
): Promise<void> {
  if (updates.length === 0) return;
  try {
    const dateDir = meta.meetingDate.slice(0, 10);
    const dir = join(rootDir, slugifyClientId(meta.clientId), dateDir);
    await fs.mkdir(dir, { recursive: true });
    const slug = safeTopNameSlug(meta.topName);
    const baseName = `f1-${slug}-${reportId}`;
    await fs.writeFile(
      join(dir, `${baseName}.commitments-updates.json`),
      JSON.stringify(
        { reportId, meetingDate: meta.meetingDate, updates, sourceFiles },
        null,
        2,
      ),
      'utf8',
    );
    log.info?.(
      { step: 'f1.commitments-updates.persisted', count: updates.length, sourceFileCount: sourceFiles.length },
      'commitments-updates overlay written',
    );
  } catch (err) {
    log.error(
      { step: 'f1.commitments-updates.persist_failed', err },
      'commitments-updates persist failed (warn-only)',
    );
    alertOps({
      pipeline: 'F1',
      step: 'f1.commitments-updates.persist',
      clientId: meta.clientId,
      error: err,
    });
  }
}

export async function runF1Steps34(
  input: RunF1Steps34Input,
): Promise<RunF1Steps34Result> {
  const deps = input.deps ?? {};
  const baseLogger = deps.logger ?? rootLogger;
  const log = baseLogger.child({
    pipeline: 'F1',
    step: 'f1.steps34',
    clientId: input.meta.clientId,
    topName: input.meta.topName,
  });
  const rootDir = deps.rootDir ?? 'data';
  const claudeSafeFn = deps.callClaudeSafe ?? callClaudeSafe;
  const promptFn = deps.loadPrompt ?? loadPrompt;

  const reportId = input.meta.reportId ?? randomUUID().slice(0, 8);
  const formatStart = Date.now();

  const extractionPayload = JSON.stringify(input.extraction, null, 2);
  const analysisPayload = JSON.stringify(input.analysis, null, 2);
  const commitmentsBeforePayload = JSON.stringify(input.openCommitmentsBefore, null, 2);
  const alertsPayload = JSON.stringify(input.analysis.alerts, null, 2);

  log.info(
    {
      step: 'f1.format.start',
      extractionPayloadSize: extractionPayload.length,
      analysisPayloadSize: analysisPayload.length,
      openCommitmentsCount: input.openCommitmentsBefore.length,
    },
    'format step starting',
  );

  let formatPrompt: string;
  try {
    formatPrompt = await promptFn('format-tracker', {
      extractionOutput: extractionPayload,
      analysisOutput: analysisPayload,
      commitmentsBefore: commitmentsBeforePayload,
      alerts: alertsPayload,
      topName: input.meta.topName,
      department: input.meta.department ?? '—',
      weekNumber: getISOWeekNumber(input.meta.meetingDate),
    });
  } catch (err) {
    // prompt_load fail = baгa в коде / отсутствие файла → не partial fallback, throw
    log.error({ step: 'f1.format.prompt_load_failed', err }, 'format prompt load failed');
    alertOps({
      pipeline: 'F1',
      step: 'f1.format.prompt_load',
      clientId: input.meta.clientId,
      error: err,
    });
    throw err;
  }

  let safeResult: Awaited<ReturnType<typeof callClaudeSafe<FormatOutput>>>;
  try {
    safeResult = await claudeSafeFn(formatPrompt, {
      stepName: 'format',
      schema: FormatOutputSchema,
      signal: deps.signal,
      logger: log,
    });
  } catch (err) {
    if (isAbortError(err)) {
      log.warn({ step: 'f1.format.aborted', reason: 'aborted_by_caller' });
      throw err;
    }
    if (err instanceof F1PipelineError && err.code === 'claude_api') {
      // Retry exhausted — partial fallback (AC #4).
      const formatDuration = Date.now() - formatStart;
      log.error(
        { step: 'f1.format.retry_exhausted', err },
        'format step retry exhausted',
      );
      alertOps({
        pipeline: 'F1',
        step: 'f1.format',
        clientId: input.meta.clientId,
        error: err,
      });
      const partial = assemblePartialDeliveryReport({
        reportId,
        meta: input.meta,
        extraction: input.extraction,
        analysis: input.analysis,
        partialReason: 'format_retry_exhausted',
      });
      validateDeliveryReport(partial, 'partial_assembly_invalid');
      await persistDeliveryReport(input.meta, reportId, partial, rootDir, log);
      await persistCommitmentsUpdates(
        input.meta,
        reportId,
        input.analysis.commitments_status_updates ?? [],
        input.openCommitmentsSourceFiles ?? [],
        rootDir,
        log,
      );
      log.warn(
        {
          step: 'f1.format.partial',
          partialReason: 'format_retry_exhausted',
          durationMs: formatDuration,
        },
        'format step produced partial result',
      );
      return {
        formattedReport: partial,
        partial: true,
        partialReason: 'format_retry_exhausted',
        rawResponses: { format: null },
        durationsMs: { format: formatDuration },
        tokens: { input: 0, output: 0 },
        reportId,
      };
    }
    // claude_response_invalid (no_text_block / json_parse_failed) — partial per D2.
    // See AC #14 (legitimized format_step_failed partialReason).
    if (err instanceof F1PipelineError && err.code === 'claude_response_invalid') {
      const formatDuration = Date.now() - formatStart;
      const raw = (err.context.raw as string | undefined) ?? null;
      // P7: Claude actually billed for this call; recover usage if SDK attached it
      // upstream (preserved on err.context.usage). Defensive — falls back to 0 if absent.
      const ctxUsage = err.context.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      const usageIn = typeof ctxUsage?.input_tokens === 'number' ? ctxUsage.input_tokens : 0;
      const usageOut = typeof ctxUsage?.output_tokens === 'number' ? ctxUsage.output_tokens : 0;
      // P9: log + alertOps with a sanitized error clone so raw transcript doesn't ship.
      const sanitizedErr = new F1PipelineError(
        'claude_response_invalid',
        sanitizeClaudeErrorContext(err.context),
        { cause: err.cause },
      );
      log.warn(
        { step: 'f1.format.response_invalid', reason: err.context.reason, err: sanitizedErr },
        'format step response invalid',
      );
      alertOps({
        pipeline: 'F1',
        step: 'f1.format.response_invalid',
        clientId: input.meta.clientId,
        error: sanitizedErr,
      });
      if (raw) {
        await persistFormatStep(input.meta, reportId, { raw, parsed: null }, rootDir, log);
      }
      const partial = assemblePartialDeliveryReport({
        reportId,
        meta: input.meta,
        extraction: input.extraction,
        analysis: input.analysis,
        partialReason: 'format_step_failed',
      });
      validateDeliveryReport(partial, 'partial_assembly_invalid');
      await persistDeliveryReport(input.meta, reportId, partial, rootDir, log);
      await persistCommitmentsUpdates(
        input.meta,
        reportId,
        input.analysis.commitments_status_updates ?? [],
        input.openCommitmentsSourceFiles ?? [],
        rootDir,
        log,
      );
      log.warn(
        {
          step: 'f1.format.partial',
          partialReason: 'format_step_failed',
          durationMs: formatDuration,
          inputTokens: usageIn,
          outputTokens: usageOut,
        },
        'format step produced partial result',
      );
      return {
        formattedReport: partial,
        partial: true,
        partialReason: 'format_step_failed',
        rawResponses: { format: raw },
        durationsMs: { format: formatDuration },
        tokens: { input: usageIn, output: usageOut },
        reportId,
      };
    }
    throw err;
  }

  const formatDuration = Date.now() - formatStart;

  if (safeResult.parsed === null) {
    // Zod safeParse fail (AC #5) — raw сохраняется, parsed=null.
    log.warn(
      {
        step: 'f1.format.validation_failed',
        validationErrors: safeResult.validationErrors,
      },
      'format step Zod safeParse failed',
    );
    alertOps({
      pipeline: 'F1',
      step: 'f1.format.validation',
      clientId: input.meta.clientId,
      error: new F1PipelineError('format_validation_failed', {
        stepName: 'format',
        validationErrors: safeResult.validationErrors,
      }),
      context: { validationErrors: safeResult.validationErrors },
    });
    await persistFormatStep(
      input.meta,
      reportId,
      { raw: safeResult.raw, parsed: null },
      rootDir,
      log,
    );
    const partial = assemblePartialDeliveryReport({
      reportId,
      meta: input.meta,
      extraction: input.extraction,
      analysis: input.analysis,
      partialReason: 'format_validation_failed',
    });
    validateDeliveryReport(partial, 'partial_assembly_invalid');
    await persistDeliveryReport(input.meta, reportId, partial, rootDir, log);
    await persistCommitmentsUpdates(
      input.meta,
      reportId,
      input.analysis.commitments_status_updates ?? [],
      input.openCommitmentsSourceFiles ?? [],
      rootDir,
      log,
    );
    log.warn(
      {
        step: 'f1.format.partial',
        partialReason: 'format_validation_failed',
        durationMs: formatDuration,
        inputTokens: safeResult.usage.input_tokens,
        outputTokens: safeResult.usage.output_tokens,
      },
      'format step produced partial result',
    );
    return {
      formattedReport: partial,
      partial: true,
      partialReason: 'format_validation_failed',
      rawResponses: { format: safeResult.raw },
      durationsMs: { format: formatDuration },
      tokens: {
        input: safeResult.usage.input_tokens,
        output: safeResult.usage.output_tokens,
      },
      reportId,
    };
  }

  // Happy path (AC #1). P8: assemble + validate BEFORE persisting .json so a
  // bug in our assembly code doesn't leave an orphan f1-*.format.json on disk
  // without a matching f1-*.report.json.
  const full = assembleFullDeliveryReport({
    reportId,
    meta: input.meta,
    extraction: input.extraction,
    analysis: input.analysis,
    formatOutput: safeResult.parsed,
  });
  try {
    validateDeliveryReport(full, 'full_assembly_invalid');
  } catch (err) {
    log.error(
      { step: 'f1.delivery.assembly_invalid', err },
      'full delivery report assembly failed Zod validation (bug in our code)',
    );
    // Persist raw.txt only (debugging) — skip .json/.report.json to avoid orphans.
    await persistFormatStep(input.meta, reportId, { raw: safeResult.raw, parsed: null }, rootDir, log);
    throw err;
  }
  await persistFormatStep(
    input.meta,
    reportId,
    { raw: safeResult.raw, parsed: safeResult.parsed },
    rootDir,
    log,
  );
  await persistDeliveryReport(input.meta, reportId, full, rootDir, log);
  await persistCommitmentsUpdates(
    input.meta,
    reportId,
    input.analysis.commitments_status_updates ?? [],
    input.openCommitmentsSourceFiles ?? [],
    rootDir,
    log,
  );

  log.info(
    {
      step: 'f1.format.complete',
      durationMs: formatDuration,
      inputTokens: safeResult.usage.input_tokens,
      outputTokens: safeResult.usage.output_tokens,
      sectionsCount: safeResult.parsed.report_sections.length,
      commitmentCount: safeResult.parsed.commitment_count,
      alertCount: safeResult.parsed.alert_count,
      topMessageDraftPresent: !!safeResult.parsed.top_message_draft,
    },
    'format step complete',
  );

  return {
    formattedReport: full,
    partial: false,
    rawResponses: { format: safeResult.raw },
    durationsMs: { format: formatDuration },
    tokens: {
      input: safeResult.usage.input_tokens,
      output: safeResult.usage.output_tokens,
    },
    reportId,
  };
}

export async function runF1(input: RunF1Steps12Input): Promise<RunF1Result> {
  const totalStart = Date.now();
  const baseLogger = input.deps?.logger ?? rootLogger;
  const log = baseLogger.child({
    pipeline: 'F1',
    step: 'f1.run',
    clientId: input.meta.clientId,
    topName: input.meta.topName,
  });
  const rootDir = input.deps?.rootDir ?? 'data';

  // P5: try/finally so f1.run.total is emitted regardless of step12/step34 outcome.
  // Captured state passed into finally via closure-mutable refs.
  let step12: RunF1Steps12Result | undefined;
  let step34: RunF1Steps34Result | undefined;
  let runStatus: 'ok' | 'partial' | 'error' | 'aborted' = 'error';
  let errorCode: string | undefined;

  try {
    step12 = await runF1Steps12(input);

    const department = input.clientContext.stakeholders.find(
      (s) => s.speakerName === input.meta.topName,
    )?.department;

    step34 = await runF1Steps34({
      extraction: step12.extraction,
      analysis: step12.analysis,
      openCommitmentsBefore: step12.openCommitmentsBefore,
      openCommitmentsSourceFiles: step12.openCommitmentsSourceFiles,
      meta: {
        ...input.meta,
        reportId: step12.reportId,
        department,
      },
      deps: input.deps,
    });

    runStatus = step34.partial ? 'partial' : 'ok';

    const totalDuration = Date.now() - totalStart;
    // P5: always emit canonical info log with status; warn is additive on SLA.
    log.info(
      {
        step: 'f1.run.total',
        totalDurationMs: totalDuration,
        status: runStatus,
        partial: step34.partial,
      },
      'F1 pipeline complete',
    );
    if (totalDuration > F1_TOTAL_LATENCY_WARN_MS) {
      log.warn(
        {
          step: 'f1.run.total',
          totalDurationMs: totalDuration,
          slaExceeded: true,
          partial: step34.partial,
        },
        'F1 pipeline exceeded 15-minute SLA',
      );
    }

    return {
      extraction: step12.extraction,
      analysis: step12.analysis,
      openCommitmentsBefore: step12.openCommitmentsBefore,
      openCommitmentsSourceFiles: step12.openCommitmentsSourceFiles,
      reportId: step12.reportId,
      formattedReport: step34.formattedReport,
      partial: step34.partial,
      partialReason: step34.partialReason,
      durationsMs: {
        extraction: step12.durationsMs.extraction,
        analysis: step12.durationsMs.analysis,
        format: step34.durationsMs.format,
        total: totalDuration,
      },
      tokens: {
        input: step12.tokens.input + step34.tokens.input,
        output: step12.tokens.output + step34.tokens.output,
      },
      rawResponses: {
        extraction: step12.rawResponses.extraction,
        analysis: step12.rawResponses.analysis,
        format: step34.rawResponses.format,
      },
    };
  } catch (err) {
    if (isAbortError(err)) {
      runStatus = 'aborted';
      errorCode = 'aborted';
    } else if (err instanceof F1PipelineError) {
      runStatus = 'error';
      errorCode = err.code;
    } else {
      runStatus = 'error';
      errorCode = 'unknown';
    }
    throw err;
  } finally {
    // P5: emit f1.run.total even on throw so observability tooling sees every run.
    if (runStatus !== 'ok' && runStatus !== 'partial') {
      const totalDuration = Date.now() - totalStart;
      log.info(
        {
          step: 'f1.run.total',
          totalDurationMs: totalDuration,
          status: runStatus,
          errorCode,
        },
        'F1 pipeline ended with error',
      );
      if (totalDuration > F1_TOTAL_LATENCY_WARN_MS) {
        log.warn(
          {
            step: 'f1.run.total',
            totalDurationMs: totalDuration,
            slaExceeded: true,
            status: runStatus,
          },
          'F1 pipeline exceeded 15-minute SLA before terminating',
        );
      }
    }

    // P3: persist meta.json AFTER step 3 outcome is known so partial/partialReason/
    // formatTokens land in the on-disk audit trail. Re-run on step12-only failures
    // is benign — fields are populated from step12 alone, step34 fields omitted.
    if (step12) {
      try {
        await persistMeta(
          input.meta,
          step12.reportId,
          {
            reportId: step12.reportId,
            clientId: input.meta.clientId,
            topName: input.meta.topName,
            meetingDate: input.meta.meetingDate,
            meetingType: input.meta.meetingType,
            model: config.ANTHROPIC_MODEL,
            durationsMs: {
              extraction: step12.durationsMs.extraction,
              analysis: step12.durationsMs.analysis,
              total: step12.durationsMs.total,
              ...(step34 ? { format: step34.durationsMs.format } : {}),
            },
            tokens: {
              input: step12.tokens.input + (step34?.tokens.input ?? 0),
              output: step12.tokens.output + (step34?.tokens.output ?? 0),
            },
            openCommitmentsBefore: step12.openCommitmentsBefore,
            status: runStatus,
            errorCode,
            partial: step34?.partial,
            partialReason: step34?.partialReason,
            formatTokens: step34
              ? { input: step34.tokens.input, output: step34.tokens.output }
              : undefined,
          },
          rootDir,
          log,
        );
      } catch (metaErr) {
        log.warn({ step: 'f1.meta.persist_failed', err: metaErr }, 'meta persist failed (finally)');
      }
    }
  }
}
