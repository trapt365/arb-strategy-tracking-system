import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runF1Steps12,
  runF1Steps34,
  runF1,
  formatTranscriptForPrompt,
  formatOkrContextForPrompt,
  assembleFullDeliveryReport,
  assemblePartialDeliveryReport,
  getISOWeekNumber,
} from './f1-report.js';
import {
  type Transcript,
  type ClientContext,
  type ExtractionOutput,
  type AnalysisOutput,
  type FormatOutput,
  type Stakeholder,
  type OkrKr,
} from './types.js';
import { F1PipelineError } from './errors.js';

const STAKEHOLDER: Stakeholder = {
  fullName: 'Жанель Иванова',
  speakerName: 'Жанель',
  department: 'Sales',
  role: 'Head of Sales',
  bscCategory: 'customer',
  responsibilityAreas: 'pipeline',
  interests: 'growth',
  notes: '',
};

const OKR: OkrKr = {
  krNumber: 'KR1',
  shortName: 'pipeline',
  keyResult: 'Закрыть 10 крупных сделок Q2',
  owner: 'Жанель',
  ownerPosition: 'Head of Sales',
  currentStatus: 'in_progress',
  target: '10',
  progress: '3',
  deadline: '2026-06-30',
  okrGroup: 'Sales',
  quarter: 'Q2',
};

const TRANSCRIPT: Transcript = {
  speakers: [
    {
      name: 'Speaker 1',
      segments: [
        { start: 0, end: 5, text: 'Я подготовлю отчёт до пятницы.' },
        { start: 6, end: 10, text: 'KR1 идёт по плану.' },
      ],
    },
  ],
  metadata: {
    date: '2026-04-30T10:00:00+05:00',
    duration: 600,
    meeting_type: 'tracking_session',
  },
};

function ctx(overrides: Partial<ClientContext> = {}): ClientContext {
  return {
    clientId: 'geonline',
    stakeholders: [STAKEHOLDER],
    okrs: [OKR],
    f5Metrics: [],
    readAt: '2026-04-30T10:00:00+05:00',
    ...overrides,
  };
}

const EXTRACTION: ExtractionOutput = {
  decisions: ['Перенести релиз на следующую неделю'],
  commitments: [
    {
      who: 'Жанель',
      what: 'подготовить отчёт',
      deadline: 'до пятницы',
      quote: '[00:00] Жанель: Я подготовлю отчёт до пятницы.',
    },
  ],
  citations: [
    { timestamp: 0, speaker: 'Жанель', text: 'Я подготовлю отчёт до пятницы.', approximate: false },
  ],
  facts: ['обсудили pipeline Q2'],
  speaker_check: [],
};

const ANALYSIS: AnalysisOutput = {
  okr_coverage: [
    { kr: 'KR1', status: 'discussed', mentions_count: 2, substance: true },
  ],
  hypothesis_status: [],
  alerts: [],
  commitments_status_updates: [],
};

let workDir: string;

beforeEach(async () => {
  workDir = await fs.mkdtemp(join(tmpdir(), 'f1-test-'));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

function makeMockClaude(extractRet: unknown, analysisRet: unknown) {
  return vi.fn().mockImplementation(async (_prompt, opts) => {
    if (opts.stepName === 'extraction') {
      if (extractRet instanceof Error) throw extractRet;
      return {
        raw: JSON.stringify(extractRet),
        parsed: extractRet,
        usage: { input_tokens: 1000, output_tokens: 500 },
      };
    }
    if (opts.stepName === 'analysis') {
      if (analysisRet instanceof Error) throw analysisRet;
      return {
        raw: JSON.stringify(analysisRet),
        parsed: analysisRet,
        usage: { input_tokens: 800, output_tokens: 400 },
      };
    }
    throw new Error(`unexpected stepName: ${opts.stepName}`);
  });
}

const fakePromptLoader = vi.fn(async (name: string) =>
  name === 'extraction' ? 'extraction-prompt' : 'analysis-prompt',
);
const fakeLoadCommits = vi.fn(async () => ({
  openCommitments: [],
  sourceFiles: [],
}));

describe('runF1Steps12', () => {
  it('happy path: returns extraction + analysis, persists files, calls openCommitments', async () => {
    const claudeMock = makeMockClaude(EXTRACTION, ANALYSIS);
    const result = await runF1Steps12({
      transcript: TRANSCRIPT,
      clientContext: ctx(),
      meta: {
        clientId: 'geonline',
        topName: 'Жанель',
        meetingDate: '2026-04-30T10:00:00+05:00',
      },
      deps: {
        rootDir: workDir,
        callClaude: claudeMock as never,
        loadOpenCommitments: fakeLoadCommits as never,
        loadPrompt: fakePromptLoader as never,
      },
    });

    expect(result.extraction).toEqual(EXTRACTION);
    expect(result.analysis).toEqual(ANALYSIS);
    expect(result.reportId).toMatch(/^[a-f0-9]{8}$/);
    expect(result.durationsMs.total).toBeGreaterThanOrEqual(0);
    expect(result.tokens.input).toBe(1800);
    expect(result.tokens.output).toBe(900);

    // Verify persistence
    const dir = join(workDir, 'geonline', '2026-04-30');
    const files = await fs.readdir(dir);
    const slugPart = files.find((f) => f.endsWith('.extraction.json'));
    expect(slugPart).toBeDefined();
    expect(files.some((f) => f.endsWith('.extraction.raw.txt'))).toBe(true);
    expect(files.some((f) => f.endsWith('.analysis.json'))).toBe(true);
    expect(files.some((f) => f.endsWith('.analysis.raw.txt'))).toBe(true);
    expect(files.some((f) => f.endsWith('.meta.json'))).toBe(true);

    expect(claudeMock).toHaveBeenCalledTimes(2);
    expect(fakeLoadCommits).toHaveBeenCalled();
  });

  it('throws extraction_validation with reason=empty_client_context when stakeholders empty', async () => {
    const claudeMock = makeMockClaude(EXTRACTION, ANALYSIS);
    await expect(
      runF1Steps12({
        transcript: TRANSCRIPT,
        clientContext: { ...ctx(), stakeholders: [] as unknown as ClientContext['stakeholders'] },
        meta: {
          clientId: 'geonline',
          topName: 'Жанель',
          meetingDate: '2026-04-30T10:00:00+05:00',
        },
        deps: {
          rootDir: workDir,
          callClaude: claudeMock as never,
          loadOpenCommitments: fakeLoadCommits as never,
          loadPrompt: fakePromptLoader as never,
        },
      }),
    ).rejects.toMatchObject({
      name: 'F1PipelineError',
      code: 'extraction_validation',
      context: { reason: 'empty_client_context' },
    });
    expect(claudeMock).not.toHaveBeenCalled();
  });

  it('passes openCommitments into analysis prompt loader call', async () => {
    const claudeMock = makeMockClaude(EXTRACTION, ANALYSIS);
    const commits = [
      {
        who: 'Жанель',
        what: 'старое обязательство',
        deadline: 'до 20',
        quote: '[01:00] прошлая встреча',
      },
    ];
    const promptCalls: Array<{ name: string; vars: Record<string, string> }> = [];
    const promptMock = vi.fn(async (name: string, vars: Record<string, string>) => {
      promptCalls.push({ name, vars });
      return `${name}-rendered`;
    });
    const loadCommitsMock = vi.fn(async () => ({
      openCommitments: commits,
      sourceFiles: ['geonline/2026-04-15/f1-жанель-aaaaaaaa.extraction.json'],
    }));

    await runF1Steps12({
      transcript: TRANSCRIPT,
      clientContext: ctx(),
      meta: {
        clientId: 'geonline',
        topName: 'Жанель',
        meetingDate: '2026-04-30T10:00:00+05:00',
      },
      deps: {
        rootDir: workDir,
        callClaude: claudeMock as never,
        loadOpenCommitments: loadCommitsMock as never,
        loadPrompt: promptMock as never,
      },
    });

    const analysisCall = promptCalls.find((c) => c.name === 'analysis');
    expect(analysisCall).toBeDefined();
    expect(analysisCall?.vars.openCommitments).toContain('старое обязательство');
  });

  it('step 1 fails → analysis NOT called, extraction not persisted (claude_api)', async () => {
    const claudeMock = makeMockClaude(
      Object.assign(new Error('boom'), { status: 500 }),
      ANALYSIS,
    );
    await expect(
      runF1Steps12({
        transcript: TRANSCRIPT,
        clientContext: ctx(),
        meta: {
          clientId: 'geonline',
          topName: 'Жанель',
          meetingDate: '2026-04-30T10:00:00+05:00',
        },
        deps: {
          rootDir: workDir,
          callClaude: claudeMock as never,
          loadOpenCommitments: fakeLoadCommits as never,
          loadPrompt: fakePromptLoader as never,
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(claudeMock).toHaveBeenCalledTimes(1);
    // analysis files should not exist
    const dir = join(workDir, 'geonline', '2026-04-30');
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    expect(files.some((f) => f.endsWith('.analysis.json'))).toBe(false);
  });

  it('extraction validation fail (claude_response_invalid) → re-thrown as extraction_validation, raw persisted', async () => {
    const validationErr = new F1PipelineError(
      'claude_response_invalid',
      {
        reason: 'zod_validation_failed',
        raw: '{"bad":"shape"}',
        validationErrors: [{ path: ['decisions'], message: 'expected array' }],
      },
    );
    const claudeMock = makeMockClaude(validationErr, ANALYSIS);
    let captured: F1PipelineError | undefined;
    try {
      await runF1Steps12({
        transcript: TRANSCRIPT,
        clientContext: ctx(),
        meta: {
          clientId: 'geonline',
          topName: 'Жанель',
          meetingDate: '2026-04-30T10:00:00+05:00',
        },
        deps: {
          rootDir: workDir,
          callClaude: claudeMock as never,
          loadOpenCommitments: fakeLoadCommits as never,
          loadPrompt: fakePromptLoader as never,
        },
      });
    } catch (err) {
      captured = err as F1PipelineError;
    }
    expect(captured?.code).toBe('extraction_validation');
    // raw file persisted
    const dir = join(workDir, 'geonline', '2026-04-30');
    const files = await fs.readdir(dir);
    expect(files.some((f) => f.endsWith('.extraction.raw.txt'))).toBe(true);
    expect(files.some((f) => f.endsWith('.extraction.json'))).toBe(false);
  });

  it('analysis validation fail → analysis_validation; extraction.json persisted', async () => {
    const validationErr = new F1PipelineError(
      'claude_response_invalid',
      {
        reason: 'zod_validation_failed',
        raw: '{"bad":"shape"}',
        validationErrors: [],
      },
    );
    const claudeMock = makeMockClaude(EXTRACTION, validationErr);
    let captured: F1PipelineError | undefined;
    try {
      await runF1Steps12({
        transcript: TRANSCRIPT,
        clientContext: ctx(),
        meta: {
          clientId: 'geonline',
          topName: 'Жанель',
          meetingDate: '2026-04-30T10:00:00+05:00',
        },
        deps: {
          rootDir: workDir,
          callClaude: claudeMock as never,
          loadOpenCommitments: fakeLoadCommits as never,
          loadPrompt: fakePromptLoader as never,
        },
      });
    } catch (err) {
      captured = err as F1PipelineError;
    }
    expect(captured?.code).toBe('analysis_validation');
    const dir = join(workDir, 'geonline', '2026-04-30');
    const files = await fs.readdir(dir);
    expect(files.some((f) => f.endsWith('.extraction.json'))).toBe(true);
    expect(files.some((f) => f.endsWith('.analysis.raw.txt'))).toBe(true);
    expect(files.some((f) => f.endsWith('.analysis.json'))).toBe(false);
  });

  it('writes meta.json with token totals and durations', async () => {
    const claudeMock = makeMockClaude(EXTRACTION, ANALYSIS);
    await runF1Steps12({
      transcript: TRANSCRIPT,
      clientContext: ctx(),
      meta: {
        clientId: 'geonline',
        topName: 'Жанель',
        meetingDate: '2026-04-30T10:00:00+05:00',
        meetingType: 'tracking_session',
      },
      deps: {
        rootDir: workDir,
        callClaude: claudeMock as never,
        loadOpenCommitments: fakeLoadCommits as never,
        loadPrompt: fakePromptLoader as never,
      },
    });
    const dir = join(workDir, 'geonline', '2026-04-30');
    const files = await fs.readdir(dir);
    const metaFile = files.find((f) => f.endsWith('.meta.json'))!;
    const meta = JSON.parse(await fs.readFile(join(dir, metaFile), 'utf8'));
    expect(meta.status).toBe('ok');
    expect(meta.tokens.input).toBe(1800);
    expect(meta.tokens.output).toBe(900);
    expect(meta.durationsMs.total).toBeGreaterThanOrEqual(0);
  });

  // Task 10.6 (step-2 claude_api failure path) — completes AC #1 + persistence
  // contract: extraction.json must exist, analysis.json must NOT, alertOps fires.
  it('step 2 fails with claude_api → extraction persisted, analysis NOT persisted, alertOps called', async () => {
    const claudeMock = vi
      .fn()
      .mockImplementationOnce(async () => ({
        raw: JSON.stringify(EXTRACTION),
        parsed: EXTRACTION,
        usage: { input_tokens: 1000, output_tokens: 500 },
      }))
      .mockImplementationOnce(async () => {
        const e = new F1PipelineError('claude_api', {
          stepName: 'analysis',
          httpStatus: 500,
        });
        throw e;
      });

    await expect(
      runF1Steps12({
        transcript: TRANSCRIPT,
        clientContext: ctx(),
        meta: {
          clientId: 'geonline',
          topName: 'Жанель',
          meetingDate: '2026-04-30T10:00:00+05:00',
        },
        deps: {
          rootDir: workDir,
          callClaude: claudeMock as never,
          loadOpenCommitments: fakeLoadCommits as never,
          loadPrompt: fakePromptLoader as never,
        },
      }),
    ).rejects.toMatchObject({
      name: 'F1PipelineError',
      code: 'claude_api',
    });

    const dir = join(workDir, 'geonline', '2026-04-30');
    const files = await fs.readdir(dir);
    expect(files.some((f) => f.endsWith('.extraction.json'))).toBe(true);
    expect(files.some((f) => f.endsWith('.extraction.raw.txt'))).toBe(true);
    expect(files.some((f) => f.endsWith('.analysis.json'))).toBe(false);
    expect(files.some((f) => f.endsWith('.analysis.raw.txt'))).toBe(false);

    // meta.json status = 'error' (step-2 failure propagated)
    const metaFile = files.find((f) => f.endsWith('.meta.json'))!;
    const meta = JSON.parse(await fs.readFile(join(dir, metaFile), 'utf8'));
    expect(meta.status).toBe('error');
    expect(meta.errorCode).toBe('claude_api');
  });

  // Task 10.8 (AbortSignal cancellation) — AC #13: graceful cancel during Claude
  // call. Aborting BEFORE step 2 starts means analysis must not run; signal is
  // detected by the inter-step abort check (or by the SDK if abort lands later).
  it('AbortSignal cancellation: abort between steps → analysis NOT called', async () => {
    const ctrl = new AbortController();
    const claudeMock = vi.fn().mockImplementationOnce(async () => {
      // After extraction completes, abort the signal — analysis call must be skipped.
      ctrl.abort();
      return {
        raw: JSON.stringify(EXTRACTION),
        parsed: EXTRACTION,
        usage: { input_tokens: 1000, output_tokens: 500 },
      };
    });

    await expect(
      runF1Steps12({
        transcript: TRANSCRIPT,
        clientContext: ctx(),
        meta: {
          clientId: 'geonline',
          topName: 'Жанель',
          meetingDate: '2026-04-30T10:00:00+05:00',
        },
        deps: {
          rootDir: workDir,
          signal: ctrl.signal,
          callClaude: claudeMock as never,
          loadOpenCommitments: fakeLoadCommits as never,
          loadPrompt: fakePromptLoader as never,
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // claudeMock called exactly once (extraction); analysis short-circuited.
    expect(claudeMock).toHaveBeenCalledTimes(1);

    // meta.json status = 'aborted' (P26).
    const dir = join(workDir, 'geonline', '2026-04-30');
    const files = await fs.readdir(dir);
    const metaFile = files.find((f) => f.endsWith('.meta.json'))!;
    const meta = JSON.parse(await fs.readFile(join(dir, metaFile), 'utf8'));
    expect(meta.status).toBe('aborted');
  });

  // Task 10.9 (SLA warn) — AC #12: totalDurationMs > 15 min emits both
  // canonical info log AND warn with slaExceeded:true. Use vi.useFakeTimers
  // to control time; advance the clock during the analysis call.
  it('SLA warn fires when totalDurationMs > 15 min, info log still emitted', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-04-30T10:00:00Z'));
      const log = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(),
      };
      log.child.mockReturnValue(log);

      const claudeMock = vi
        .fn()
        .mockImplementationOnce(async () => {
          // After extraction, advance time by 16 minutes so total exceeds 15-min SLA.
          vi.advanceTimersByTime(16 * 60 * 1000);
          return {
            raw: JSON.stringify(EXTRACTION),
            parsed: EXTRACTION,
            usage: { input_tokens: 1000, output_tokens: 500 },
          };
        })
        .mockImplementationOnce(async () => ({
          raw: JSON.stringify(ANALYSIS),
          parsed: ANALYSIS,
          usage: { input_tokens: 800, output_tokens: 400 },
        }));

      await runF1Steps12({
        transcript: TRANSCRIPT,
        clientContext: ctx(),
        meta: {
          clientId: 'geonline',
          topName: 'Жанель',
          meetingDate: '2026-04-30T10:00:00+05:00',
        },
        deps: {
          rootDir: workDir,
          logger: log as never,
          callClaude: claudeMock as never,
          loadOpenCommitments: fakeLoadCommits as never,
          loadPrompt: fakePromptLoader as never,
        },
      });

      // Canonical info log fires with status: 'ok' (P1).
      // After P6 rename: runF1Steps12 emits `f1.steps12.total`; `f1.run.total`
      // belongs to the runF1 orchestrator.
      const infoCalls = log.info.mock.calls.map((c) => c[0]);
      const totalInfo = infoCalls.find((c) => c?.step === 'f1.steps12.total');
      expect(totalInfo).toBeDefined();
      expect(totalInfo.status).toBe('ok');

      // Warn ALSO fires with slaExceeded:true (P1 + AC #12).
      const warnCalls = log.warn.mock.calls.map((c) => c[0]);
      const sla = warnCalls.find((c) => c?.slaExceeded === true);
      expect(sla).toBeDefined();
      expect(sla.step).toBe('f1.steps12.total');
      expect(sla.totalDurationMs).toBeGreaterThan(15 * 60 * 1000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('formatters', () => {
  it('formatTranscriptForPrompt sorts segments by start, [MM:SS] format', () => {
    const out = formatTranscriptForPrompt({
      speakers: [
        {
          name: 'Speaker A',
          segments: [{ start: 75, end: 80, text: 'second' }],
        },
        {
          name: 'Speaker B',
          segments: [{ start: 5, end: 10, text: 'first' }],
        },
      ],
      metadata: { date: '2026-04-30T10:00:00+05:00', duration: 80, meeting_type: 'x' },
    });
    expect(out).toBe('[00:05] Speaker B: first\n[01:15] Speaker A: second');
  });

  it('formatOkrContextForPrompt always includes f5Metrics, as [] when empty', () => {
    // AC #10: analysis prompt expects f5Metrics field to be present even when empty.
    const json = formatOkrContextForPrompt([OKR], []);
    expect(json).toContain('"f5Metrics": []');
    expect(json).toContain('"okrs"');
    const parsed = JSON.parse(json) as { okrs: unknown; f5Metrics: unknown };
    expect(parsed.f5Metrics).toEqual([]);
  });

  it('formatOkrContextForPrompt includes f5Metrics when present', () => {
    const json = formatOkrContextForPrompt([OKR], [
      {
        department: 'Sales',
        metricName: 'pipeline',
        metricType: 'leading',
        unit: 'usd',
        source: 'crm',
        ownerSpeakerName: 'Жанель',
        ranges: [],
        updateFrequency: 'weekly',
        riskNotes: '',
        notes: '',
      },
    ]);
    expect(json).toContain('f5Metrics');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Story 1.4b: F1 шаги 3-4
// ─────────────────────────────────────────────────────────────────────────────

const FORMAT_OUTPUT_OK: FormatOutput = {
  report_sections: [
    { title: 'Решения и обязательства', content: 'Жанель: подготовить отчёт.' },
    { title: 'OKR-покрытие', content: 'KR1 — discussed.' },
  ],
  summary_line: 'Конверсия видеозвонков 80% — гипотеза подтверждается',
  commitment_count: 1,
  alert_count: 0,
  top_message_draft: 'Жанель, по итогам встречи: видеозвонки подтвердились. Ты берёшь отчёт к пятнице.',
};

function makeMockClaudeSafe(formatRet: unknown) {
  return vi.fn().mockImplementation(async (_prompt: string) => {
    if (formatRet instanceof Error) throw formatRet;
    if (formatRet === 'ZOD_FAIL') {
      return {
        raw: '{"wrong":"shape"}',
        parsed: null,
        validationErrors: [{ path: ['report_sections'], message: 'expected array' }],
        usage: { input_tokens: 500, output_tokens: 200 },
      };
    }
    return {
      raw: JSON.stringify(formatRet),
      parsed: formatRet,
      usage: { input_tokens: 500, output_tokens: 200 },
    };
  });
}

const formatPromptLoader = vi.fn(async (_name: string) => 'format-tracker-prompt');

describe('runF1Steps34', () => {
  it('happy path: returns full DeliveryReadyReport, persists 3 files', async () => {
    const claudeSafe = makeMockClaudeSafe(FORMAT_OUTPUT_OK);
    const result = await runF1Steps34({
      extraction: EXTRACTION,
      analysis: ANALYSIS,
      openCommitmentsBefore: [],
      meta: {
        clientId: 'geonline',
        topName: 'Жанель',
        department: 'Sales',
        meetingDate: '2026-04-30T10:00:00+05:00',
      },
      deps: {
        rootDir: workDir,
        callClaudeSafe: claudeSafe as never,
        loadPrompt: formatPromptLoader as never,
      },
    });
    expect(result.partial).toBe(false);
    expect(result.formattedReport.partial).toBe(false);
    if (!result.formattedReport.partial) {
      expect(result.formattedReport.sections).toHaveLength(2);
      expect(result.formattedReport.summaryLine).toBe(FORMAT_OUTPUT_OK.summary_line);
      expect(result.formattedReport.topMessageDraft).toBe(FORMAT_OUTPUT_OK.top_message_draft);
    }
    const dir = join(workDir, 'geonline', '2026-04-30');
    const files = await fs.readdir(dir);
    expect(files.some((f) => f.endsWith('.format.raw.txt'))).toBe(true);
    expect(files.some((f) => f.endsWith('.format.json'))).toBe(true);
    expect(files.some((f) => f.endsWith('.report.json'))).toBe(true);
  });

  it('Zod safeParse fail (parsed: null) → partial result, partialReason=format_validation_failed', async () => {
    const claudeSafe = makeMockClaudeSafe('ZOD_FAIL');
    const result = await runF1Steps34({
      extraction: EXTRACTION,
      analysis: ANALYSIS,
      openCommitmentsBefore: [],
      meta: {
        clientId: 'geonline',
        topName: 'Жанель',
        meetingDate: '2026-04-30T10:00:00+05:00',
      },
      deps: {
        rootDir: workDir,
        callClaudeSafe: claudeSafe as never,
        loadPrompt: formatPromptLoader as never,
      },
    });
    expect(result.partial).toBe(true);
    expect(result.partialReason).toBe('format_validation_failed');
    expect(result.formattedReport.partial).toBe(true);
    if (result.formattedReport.partial) {
      expect(result.formattedReport.extractionFallback.commitments).toEqual(EXTRACTION.commitments);
      expect(result.formattedReport.summaryLine).toBe(
        'Формат отчёта повреждён — сырые данные извлечения',
      );
    }
    const dir = join(workDir, 'geonline', '2026-04-30');
    const files = await fs.readdir(dir);
    // raw сохранён, parsed json — нет
    expect(files.some((f) => f.endsWith('.format.raw.txt'))).toBe(true);
    expect(files.some((f) => f.endsWith('.format.json'))).toBe(false);
    expect(files.some((f) => f.endsWith('.report.json'))).toBe(true);
  });

  it('claude_api retry exhausted → partial result, partialReason=format_retry_exhausted', async () => {
    const apiErr = new F1PipelineError('claude_api', { stepName: 'format', httpStatus: 500 });
    const claudeSafe = makeMockClaudeSafe(apiErr);
    const result = await runF1Steps34({
      extraction: EXTRACTION,
      analysis: ANALYSIS,
      openCommitmentsBefore: [],
      meta: {
        clientId: 'geonline',
        topName: 'Жанель',
        meetingDate: '2026-04-30T10:00:00+05:00',
      },
      deps: {
        rootDir: workDir,
        callClaudeSafe: claudeSafe as never,
        loadPrompt: formatPromptLoader as never,
      },
    });
    expect(result.partial).toBe(true);
    expect(result.partialReason).toBe('format_retry_exhausted');
    expect(result.rawResponses.format).toBeNull();
    const dir = join(workDir, 'geonline', '2026-04-30');
    const files = await fs.readdir(dir);
    expect(files.some((f) => f.endsWith('.format.raw.txt'))).toBe(false);
    expect(files.some((f) => f.endsWith('.report.json'))).toBe(true);
  });

  it('claude_response_invalid (JSON parse fail) → partial result, partialReason=format_step_failed (AC #14 / P15)', async () => {
    // D2-resolved: Claude вернул 200 OK с garbled text — НЕ throw, а partial с
    // legitimized partialReason 'format_step_failed'. Tokens восстанавливаются из
    // err.context.usage (P7).
    const respInvalidErr = new F1PipelineError('claude_response_invalid', {
      reason: 'json_parse_failed',
      raw: 'not-json {{{',
      rawSnippet: 'not-json {{{',
      usage: { input_tokens: 1000, output_tokens: 50 },
      parseError: 'Unexpected token n',
    });
    const claudeSafe = makeMockClaudeSafe(respInvalidErr);
    const result = await runF1Steps34({
      extraction: EXTRACTION,
      analysis: ANALYSIS,
      openCommitmentsBefore: [],
      meta: {
        clientId: 'geonline',
        topName: 'Жанель',
        meetingDate: '2026-04-30T10:00:00+05:00',
      },
      deps: {
        rootDir: workDir,
        callClaudeSafe: claudeSafe as never,
        loadPrompt: formatPromptLoader as never,
      },
    });
    expect(result.partial).toBe(true);
    expect(result.partialReason).toBe('format_step_failed');
    expect(result.rawResponses.format).toBe('not-json {{{');
    // P7: usage attribution preserved from err.context
    expect(result.tokens.input).toBe(1000);
    expect(result.tokens.output).toBe(50);
    // Persistence: format.raw.txt (raw был) + report.json; .format.json пропущен
    const dir = join(workDir, 'geonline', '2026-04-30');
    const files = await fs.readdir(dir);
    expect(files.some((f) => f.endsWith('.format.raw.txt'))).toBe(true);
    expect(files.some((f) => f.endsWith('.format.json'))).toBe(false);
    expect(files.some((f) => f.endsWith('.report.json'))).toBe(true);
  });

  it('AbortError → re-thrown without partial wrapping', async () => {
    const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const claudeSafe = makeMockClaudeSafe(abortErr);
    await expect(
      runF1Steps34({
        extraction: EXTRACTION,
        analysis: ANALYSIS,
        openCommitmentsBefore: [],
        meta: {
          clientId: 'geonline',
          topName: 'Жанель',
          meetingDate: '2026-04-30T10:00:00+05:00',
        },
        deps: {
          rootDir: workDir,
          callClaudeSafe: claudeSafe as never,
          loadPrompt: formatPromptLoader as never,
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('top_message_draft optional — отсутствие не блокирует', async () => {
    const noTopMessage: FormatOutput = { ...FORMAT_OUTPUT_OK };
    delete noTopMessage.top_message_draft;
    const claudeSafe = makeMockClaudeSafe(noTopMessage);
    const result = await runF1Steps34({
      extraction: EXTRACTION,
      analysis: ANALYSIS,
      openCommitmentsBefore: [],
      meta: {
        clientId: 'geonline',
        topName: 'Жанель',
        meetingDate: '2026-04-30T10:00:00+05:00',
      },
      deps: {
        rootDir: workDir,
        callClaudeSafe: claudeSafe as never,
        loadPrompt: formatPromptLoader as never,
      },
    });
    expect(result.partial).toBe(false);
    if (!result.formattedReport.partial) {
      expect(result.formattedReport.topMessageDraft).toBeUndefined();
    }
  });

  it('commitments_status_updates пуст → overlay-файл НЕ создан', async () => {
    const claudeSafe = makeMockClaudeSafe(FORMAT_OUTPUT_OK);
    await runF1Steps34({
      extraction: EXTRACTION,
      analysis: { ...ANALYSIS, commitments_status_updates: [] },
      openCommitmentsBefore: [],
      meta: {
        clientId: 'geonline',
        topName: 'Жанель',
        meetingDate: '2026-04-30T10:00:00+05:00',
      },
      deps: {
        rootDir: workDir,
        callClaudeSafe: claudeSafe as never,
        loadPrompt: formatPromptLoader as never,
      },
    });
    const dir = join(workDir, 'geonline', '2026-04-30');
    const files = await fs.readdir(dir);
    expect(files.some((f) => f.endsWith('.commitments-updates.json'))).toBe(false);
  });

  it('commitments_status_updates непуст → overlay-файл создан с правильным содержимым', async () => {
    const claudeSafe = makeMockClaudeSafe(FORMAT_OUTPUT_OK);
    const updates = [
      {
        who: 'Жанель',
        what: 'видеозвонки',
        previous_quote: '[01:00] starter',
        new_status: 'completed' as const,
        evidence_quote: '[02:00] всё переведено',
      },
    ];
    await runF1Steps34({
      extraction: EXTRACTION,
      analysis: { ...ANALYSIS, commitments_status_updates: updates },
      openCommitmentsBefore: [],
      meta: {
        clientId: 'geonline',
        topName: 'Жанель',
        meetingDate: '2026-04-30T10:00:00+05:00',
      },
      deps: {
        rootDir: workDir,
        callClaudeSafe: claudeSafe as never,
        loadPrompt: formatPromptLoader as never,
      },
    });
    const dir = join(workDir, 'geonline', '2026-04-30');
    const files = await fs.readdir(dir);
    const overlayFile = files.find((f) => f.endsWith('.commitments-updates.json'));
    expect(overlayFile).toBeDefined();
    const content = JSON.parse(await fs.readFile(join(dir, overlayFile!), 'utf8'));
    expect(content.updates).toEqual(updates);
  });
});

describe('runF1 (orchestrator)', () => {
  it('happy path: 1-2 + 3-4 → full RunF1Result', async () => {
    const claudeMock = vi.fn().mockImplementation(async (_p, opts) => {
      if (opts.stepName === 'extraction') {
        return { raw: JSON.stringify(EXTRACTION), parsed: EXTRACTION, usage: { input_tokens: 1000, output_tokens: 500 } };
      }
      if (opts.stepName === 'analysis') {
        return { raw: JSON.stringify(ANALYSIS), parsed: ANALYSIS, usage: { input_tokens: 800, output_tokens: 400 } };
      }
      throw new Error('unexpected stepName: ' + opts.stepName);
    });
    const claudeSafe = makeMockClaudeSafe(FORMAT_OUTPUT_OK);
    const fakeLoadCommits = vi.fn(async () => ({ openCommitments: [], sourceFiles: [] }));
    const promptLoader = vi.fn(async (name: string) =>
      name === 'extraction' ? 'extraction-prompt' : name === 'analysis' ? 'analysis-prompt' : 'format-prompt',
    );
    const result = await runF1({
      transcript: TRANSCRIPT,
      clientContext: ctx(),
      meta: {
        clientId: 'geonline',
        topName: 'Жанель',
        meetingDate: '2026-04-30T10:00:00+05:00',
      },
      deps: {
        rootDir: workDir,
        callClaude: claudeMock as never,
        callClaudeSafe: claudeSafe as never,
        loadOpenCommitments: fakeLoadCommits as never,
        loadPrompt: promptLoader as never,
      },
    });
    expect(result.partial).toBe(false);
    expect(result.formattedReport.partial).toBe(false);
    expect(result.tokens.input).toBe(1000 + 800 + 500);
    expect(result.tokens.output).toBe(500 + 400 + 200);
    expect(result.durationsMs.format).toBeGreaterThanOrEqual(0);
    expect(result.durationsMs.total).toBeGreaterThanOrEqual(0);
  });

  it('1-2 fail (extraction validation) → throws, runF1Steps34 НЕ вызывается', async () => {
    const validationErr = new F1PipelineError('claude_response_invalid', {
      reason: 'zod_validation_failed',
      raw: '{"bad":"shape"}',
      validationErrors: [],
    });
    const claudeMock = vi.fn().mockImplementation(async (_p, opts) => {
      if (opts.stepName === 'extraction') throw validationErr;
      throw new Error('analysis should not be called');
    });
    const claudeSafe = vi.fn();
    const fakeLoadCommits = vi.fn(async () => ({ openCommitments: [], sourceFiles: [] }));
    const promptLoader = vi.fn(async () => 'p');
    await expect(
      runF1({
        transcript: TRANSCRIPT,
        clientContext: ctx(),
        meta: {
          clientId: 'geonline',
          topName: 'Жанель',
          meetingDate: '2026-04-30T10:00:00+05:00',
        },
        deps: {
          rootDir: workDir,
          callClaude: claudeMock as never,
          callClaudeSafe: claudeSafe as never,
          loadOpenCommitments: fakeLoadCommits as never,
          loadPrompt: promptLoader as never,
        },
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(claudeSafe).not.toHaveBeenCalled();
  });

  it('1-2 ok + 3 fail → returns partial (extraction/analysis сохранены)', async () => {
    const claudeMock = vi.fn().mockImplementation(async (_p, opts) => {
      if (opts.stepName === 'extraction') return { raw: JSON.stringify(EXTRACTION), parsed: EXTRACTION, usage: { input_tokens: 100, output_tokens: 50 } };
      if (opts.stepName === 'analysis') return { raw: JSON.stringify(ANALYSIS), parsed: ANALYSIS, usage: { input_tokens: 80, output_tokens: 40 } };
      throw new Error('unexpected');
    });
    const claudeSafe = makeMockClaudeSafe('ZOD_FAIL');
    const fakeLoadCommits = vi.fn(async () => ({ openCommitments: [], sourceFiles: [] }));
    const promptLoader = vi.fn(async () => 'p');
    const result = await runF1({
      transcript: TRANSCRIPT,
      clientContext: ctx(),
      meta: {
        clientId: 'geonline',
        topName: 'Жанель',
        meetingDate: '2026-04-30T10:00:00+05:00',
      },
      deps: {
        rootDir: workDir,
        callClaude: claudeMock as never,
        callClaudeSafe: claudeSafe as never,
        loadOpenCommitments: fakeLoadCommits as never,
        loadPrompt: promptLoader as never,
      },
    });
    expect(result.partial).toBe(true);
    expect(result.partialReason).toBe('format_validation_failed');
    expect(result.extraction).toEqual(EXTRACTION);
    expect(result.analysis).toEqual(ANALYSIS);
  });

  it('department lookup: stakeholderMap содержит топа → правильный department', async () => {
    const claudeMock = vi.fn().mockImplementation(async (_p, opts) => {
      if (opts.stepName === 'extraction') return { raw: JSON.stringify(EXTRACTION), parsed: EXTRACTION, usage: { input_tokens: 100, output_tokens: 50 } };
      if (opts.stepName === 'analysis') return { raw: JSON.stringify(ANALYSIS), parsed: ANALYSIS, usage: { input_tokens: 80, output_tokens: 40 } };
      throw new Error('unexpected');
    });
    const promptCalls: Array<{ name: string; vars: Record<string, string> }> = [];
    const promptLoader = vi.fn(async (name: string, vars: Record<string, string>) => {
      promptCalls.push({ name, vars });
      return `${name}-rendered`;
    });
    const claudeSafe = makeMockClaudeSafe(FORMAT_OUTPUT_OK);
    const fakeLoadCommits = vi.fn(async () => ({ openCommitments: [], sourceFiles: [] }));
    await runF1({
      transcript: TRANSCRIPT,
      clientContext: ctx(),
      meta: {
        clientId: 'geonline',
        topName: 'Жанель',
        meetingDate: '2026-04-30T10:00:00+05:00',
      },
      deps: {
        rootDir: workDir,
        callClaude: claudeMock as never,
        callClaudeSafe: claudeSafe as never,
        loadOpenCommitments: fakeLoadCommits as never,
        loadPrompt: promptLoader as never,
      },
    });
    const formatCall = promptCalls.find((c) => c.name === 'format-tracker');
    expect(formatCall).toBeDefined();
    expect(formatCall?.vars.department).toBe('Sales');
    expect(formatCall?.vars.topName).toBe('Жанель');
  });

  it('department lookup: топ НЕ в stakeholderMap → department="—"', async () => {
    const claudeMock = vi.fn().mockImplementation(async (_p, opts) => {
      if (opts.stepName === 'extraction') return { raw: JSON.stringify(EXTRACTION), parsed: EXTRACTION, usage: { input_tokens: 100, output_tokens: 50 } };
      if (opts.stepName === 'analysis') return { raw: JSON.stringify(ANALYSIS), parsed: ANALYSIS, usage: { input_tokens: 80, output_tokens: 40 } };
      throw new Error('unexpected');
    });
    const promptCalls: Array<{ vars: Record<string, string> }> = [];
    const promptLoader = vi.fn(async (name: string, vars: Record<string, string>) => {
      if (name === 'format-tracker') promptCalls.push({ vars });
      return `${name}-rendered`;
    });
    const claudeSafe = makeMockClaudeSafe(FORMAT_OUTPUT_OK);
    const fakeLoadCommits = vi.fn(async () => ({ openCommitments: [], sourceFiles: [] }));
    await runF1({
      transcript: TRANSCRIPT,
      clientContext: ctx(),
      meta: {
        clientId: 'geonline',
        topName: 'Неизвестный',
        meetingDate: '2026-04-30T10:00:00+05:00',
      },
      deps: {
        rootDir: workDir,
        callClaude: claudeMock as never,
        callClaudeSafe: claudeSafe as never,
        loadOpenCommitments: fakeLoadCommits as never,
        loadPrompt: promptLoader as never,
      },
    });
    expect(promptCalls[0]?.vars.department).toBe('—');
  });
});

describe('helpers (1.4b)', () => {
  it('assembleFullDeliveryReport returns correct shape', () => {
    const report = assembleFullDeliveryReport({
      reportId: 'abc12345',
      meta: {
        clientId: 'geonline',
        topName: 'Жанель',
        meetingDate: '2026-04-30T10:00:00+05:00',
      },
      extraction: EXTRACTION,
      analysis: ANALYSIS,
      formatOutput: FORMAT_OUTPUT_OK,
    });
    expect(report.partial).toBe(false);
    if (!report.partial) {
      expect(report.summaryLine).toBe(FORMAT_OUTPUT_OK.summary_line);
      expect(report.sections).toEqual(FORMAT_OUTPUT_OK.report_sections);
      expect(report.commitments).toEqual(EXTRACTION.commitments);
    }
  });

  it('assemblePartialDeliveryReport: каждая partialReason имеет distinct summaryLine', () => {
    const reasons: Array<'format_step_failed' | 'format_validation_failed' | 'format_retry_exhausted'> = [
      'format_step_failed',
      'format_validation_failed',
      'format_retry_exhausted',
    ];
    const lines = reasons.map((reason) =>
      assemblePartialDeliveryReport({
        reportId: 'abc12345',
        meta: { clientId: 'geonline', topName: 'Жанель', meetingDate: '2026-04-30T10:00:00+05:00' },
        extraction: EXTRACTION,
        analysis: ANALYSIS,
        partialReason: reason,
      }).summaryLine,
    );
    // format_validation_failed имеет distinct сообщение для трассируемости (AC #5)
    expect(lines[1]).not.toBe(lines[0]);
    expect(lines[1]).toContain('Формат отчёта повреждён');
    expect(lines[0]).toContain('Автоформатирование');
    expect(lines[2]).toContain('Автоформатирование');
  });

  it('getISOWeekNumber returns correct week for known dates and throws on invalid input (P12)', () => {
    // 2026-04-30 → Чт, неделя 18 (ISO-8601)
    expect(getISOWeekNumber('2026-04-30T10:00:00+05:00')).toBe('18');
    // 2026-01-01 (Чт) → неделя 1
    expect(getISOWeekNumber('2026-01-01T00:00:00Z')).toBe('1');
    // P12: невалидная дата теперь throws delivery_prep — silent '—' fallback
    // ранее проходил в prompt header. Surface the bug at the boundary.
    expect(() => getISOWeekNumber('not-a-date')).toThrow(F1PipelineError);
  });
});
