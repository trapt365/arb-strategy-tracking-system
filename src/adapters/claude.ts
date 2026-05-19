import Anthropic from '@anthropic-ai/sdk';
import type { ZodType } from 'zod';
import { config } from '../config.js';
import { logger as rootLogger, type Logger } from '../logger.js';
import { withRetry } from '../utils/retry.js';
import { F1PipelineError } from '../errors.js';

export { F1PipelineError } from '../errors.js';

export interface CallClaudeOpts<T> {
  stepName: string;
  schema: ZodType<T>;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
}

export interface CallClaudeResult<T> {
  raw: string;
  parsed: T;
  usage: { input_tokens: number; output_tokens: number };
}

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!cachedClient) {
    cachedClient = new Anthropic({
      apiKey: config.ANTHROPIC_API_KEY,
      timeout: config.CLAUDE_TIMEOUT_MS,
    });
  }
  return cachedClient;
}

export function _resetClaudeClientForTest(): void {
  cachedClient = null;
}

export function _setClaudeClientForTest(client: Anthropic): void {
  cachedClient = client;
}

export function getAnthropicClient(): Anthropic {
  return getClient();
}

export function isClaudeCircuitOpen(): boolean {
  // TODO(Story 1.9): реализовать circuit breaker (3 fail in 5 min → open).
  return false;
}

interface ClaudeErrorShape {
  status?: number;
  name?: string;
  code?: string;
  message?: string;
  error?: { type?: string };
  cause?: unknown;
}

const RETRYABLE_NETWORK_CODES = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'];

// Anthropic SDK wraps undici errors — the outer `.message` may be vague
// ("Connection error.") while the underlying `.cause.code` carries the real
// transient code. Walk the cause chain up to a small depth so we don't miss
// retryable failures.
function findCauseProperty<K extends 'code' | 'message'>(
  err: unknown,
  key: K,
  depth = 0,
): string | undefined {
  if (depth > 5 || !err || typeof err !== 'object') return undefined;
  const e = err as { code?: unknown; message?: unknown; cause?: unknown };
  const value = e[key];
  if (typeof value === 'string') return value;
  return findCauseProperty(e.cause, key, depth + 1);
}

export function shouldRetryClaude(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as ClaudeErrorShape;
  // AbortError reaching this predicate means caller-initiated abort was NOT
  // detected by withRetry's signal short-circuit (line 117/124) — i.e., it is
  // an SDK-internal fetch timeout. Retry such transient timeouts; caller-abort
  // is handled upstream and never reaches this point.
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  if (typeof e.status === 'number') {
    if (e.status === 400 || e.status === 401 || e.status === 403) return false;
    if (e.status === 429 || e.status === 529) return true;
    if (e.status >= 500 && e.status < 600) return true;
    return false;
  }
  const code = typeof e.code === 'string' ? e.code : findCauseProperty(error, 'code');
  if (code && RETRYABLE_NETWORK_CODES.includes(code)) return true;
  const message = typeof e.message === 'string' ? e.message : findCauseProperty(error, 'message');
  if (message && /fetch failed|network|socket/i.test(message)) return true;
  return false;
}

// Paired strip: only chop the trailing ``` when we also matched an opening fence.
// The previous form sliced trailing backticks unconditionally, corrupting JSON
// outputs that ended with `` ``` `` inside a citation string. Also: case-insensitive
// language tag (`` ```JSON ``, `` ```json5 ``) and tolerant of trailing whitespace.
const FENCE_RE = /^```(?:json5?|JSON5?)?\s*\n?([\s\S]*?)\n?\s*```$/;
function stripMarkdownFences(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(FENCE_RE);
  if (m) return m[1]!.trim();
  return trimmed;
}

// P7: preserve `usage` so the partial branch can attribute Claude billing on
// successful API call → parse failure. P9: full `raw` is retained on err.context
// (callers may need it for persistence) but consumers MUST NOT spread err.context
// into a logged error — use sanitizeClaudeErrorContext when wrapping.
function jsonParseOrThrow(raw: string, usage?: { input_tokens: number; output_tokens: number }): unknown {
  try {
    return JSON.parse(stripMarkdownFences(raw));
  } catch (err) {
    throw new F1PipelineError(
      'claude_response_invalid',
      {
        reason: 'json_parse_failed',
        raw,
        rawSnippet: raw.slice(0, 500),
        parseError: (err as Error).message,
        usage,
      },
      { cause: err },
    );
  }
}

/**
 * P9: strip raw transcript/PII from a claude_response_invalid context before
 * the error is wrapped and shipped to log sinks / alertOps. Use this whenever
 * an upstream `claude_response_invalid` is re-thrown as `extraction_validation`
 * / `analysis_validation`. Returns a new context object — original untouched.
 */
export function sanitizeClaudeErrorContext(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(context)) {
    if (k === 'raw') {
      const raw = typeof v === 'string' ? v : '';
      sanitized.rawSnippet = raw.slice(0, 500);
      sanitized.rawLength = raw.length;
      continue;
    }
    sanitized[k] = v;
  }
  return sanitized;
}

function parseClaudeJSON<T>(raw: string, schema: ZodType<T>, usage?: { input_tokens: number; output_tokens: number }): T {
  const json = jsonParseOrThrow(raw, usage);
  try {
    return schema.parse(json);
  } catch (err) {
    throw new F1PipelineError(
      'claude_response_invalid',
      {
        reason: 'zod_validation_failed',
        raw,
        validationErrors: (err as { issues?: unknown }).issues,
        usage,
      },
      { cause: err },
    );
  }
}

// P14 (D1): if Zod safeParse fails AND every issue path leads exclusively into
// `top_message_draft`, strip the field from the parsed json and retry. This
// keeps full reports alive when Claude returns a too-short optional draft.
function isTopMessageDraftOnlyIssue(issues: unknown): boolean {
  if (!Array.isArray(issues) || issues.length === 0) return false;
  return issues.every((iss) => {
    const path = (iss as { path?: unknown }).path;
    return Array.isArray(path) && path.length > 0 && path[0] === 'top_message_draft';
  });
}

function safeParseClaudeJSON<T>(
  raw: string,
  schema: ZodType<T>,
  usage?: { input_tokens: number; output_tokens: number },
): { parsed: T; validationErrors?: undefined; topMessageDraftStripped?: boolean } | { parsed: null; validationErrors: unknown } {
  const json = jsonParseOrThrow(raw, usage);
  const result = schema.safeParse(json);
  if (result.success) return { parsed: result.data };

  // P14: retry parse with top_message_draft stripped if only that field failed.
  if (
    isTopMessageDraftOnlyIssue(result.error.issues) &&
    json !== null &&
    typeof json === 'object'
  ) {
    const { top_message_draft: _stripped, ...rest } = json as Record<string, unknown>;
    const retry = schema.safeParse(rest);
    if (retry.success) {
      return { parsed: retry.data, topMessageDraftStripped: true };
    }
  }

  return { parsed: null, validationErrors: result.error.issues };
}

interface ExecuteClaudeCallResult {
  raw: string;
  usage: { input_tokens: number; output_tokens: number };
  durationMs: number;
}

async function executeClaudeCall(
  prompt: string,
  opts: { stepName: string; model?: string; maxTokens?: number; signal?: AbortSignal; logger?: Pick<Logger, 'info' | 'warn' | 'error'> },
): Promise<ExecuteClaudeCallResult> {
  const baseLogger = opts.logger ?? rootLogger;
  const log =
    typeof (baseLogger as Logger).child === 'function'
      ? (baseLogger as Logger).child({ step: `claude.${opts.stepName}` })
      : baseLogger;
  const model = opts.model ?? config.ANTHROPIC_MODEL;
  const maxTokens = opts.maxTokens ?? config.CLAUDE_MAX_TOKENS;
  const startMs = Date.now();

  let attemptCount = 0;
  let response: Awaited<ReturnType<Anthropic['messages']['create']>>;
  try {
    response = await withRetry(
      async () => {
        attemptCount++;
        const client = getClient();
        return client.messages.create(
          {
            model,
            max_tokens: maxTokens,
            messages: [{ role: 'user', content: prompt }],
          },
          opts.signal ? { signal: opts.signal } : undefined,
        );
      },
      {
        maxRetries: 3,
        backoffMs: [1000, 3000, 9000],
        shouldRetry: shouldRetryClaude,
        logger: log,
        signal: opts.signal,
      },
    );
  } catch (err) {
    if (err instanceof F1PipelineError) throw err;
    const e = err as ClaudeErrorShape;
    if (e?.name === 'AbortError') {
      log.warn({ step: `claude.${opts.stepName}`, reason: 'aborted_by_caller' });
      throw err;
    }
    throw new F1PipelineError(
      'claude_api',
      {
        stepName: opts.stepName,
        httpStatus: typeof e?.status === 'number' ? e.status : undefined,
        anthropicErrorType: e?.error?.type,
        attemptCount,
        message: (err as Error)?.message,
      },
      { cause: err },
    );
  }

  // Concatenate ALL text blocks, not just the first one. Claude can emit multiple
  // text blocks (rare but valid — e.g. when interleaved with tool_use). Picking
  // only the first would silently truncate JSON output split across two blocks.
  const textBlocks = response.content.filter((b) => b.type === 'text');
  if (textBlocks.length === 0) {
    throw new F1PipelineError('claude_response_invalid', {
      reason: 'no_text_block',
      stepName: opts.stepName,
      response_id: (response as { id?: string }).id,
    });
  }
  const raw = textBlocks.map((b) => (b as { text: string }).text).join('');
  // Defensive: SDK currently always returns `usage`, but future versions
  // (streaming, partial responses) may omit it. Don't crash the F1PipelineError
  // contract on a missing field.
  const usage = response.usage ?? { input_tokens: 0, output_tokens: 0 };
  const durationMs = Date.now() - startMs;

  log.info(
    {
      step: `claude.${opts.stepName}.complete`,
      durationMs,
      model,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
    },
    'claude call complete',
  );

  return {
    raw,
    usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens },
    durationMs,
  };
}

export async function callClaude<T>(
  prompt: string,
  opts: CallClaudeOpts<T>,
): Promise<CallClaudeResult<T>> {
  const { raw, usage } = await executeClaudeCall(prompt, opts);
  const parsed = parseClaudeJSON(raw, opts.schema, usage);
  return { raw, parsed, usage };
}

export interface CallClaudeSafeResult<T> {
  raw: string;
  parsed: T | null;
  validationErrors?: unknown;
  /** P14 (D1): set to true when only top_message_draft failed validation and was stripped. */
  topMessageDraftStripped?: boolean;
  usage: { input_tokens: number; output_tokens: number };
}

export async function callClaudeSafe<T>(
  prompt: string,
  opts: CallClaudeOpts<T>,
): Promise<CallClaudeSafeResult<T>> {
  const { raw, usage } = await executeClaudeCall(prompt, opts);
  const result = safeParseClaudeJSON(raw, opts.schema, usage);
  if (result.parsed !== null) {
    const out: CallClaudeSafeResult<T> = { raw, parsed: result.parsed, usage };
    if ('topMessageDraftStripped' in result && result.topMessageDraftStripped) {
      out.topMessageDraftStripped = true;
      const log = opts.logger ?? rootLogger;
      log.warn?.(
        { step: `f1.${opts.stepName}.top_message_draft_stripped` },
        'top_message_draft failed validation only; stripped and retried parse (P14)',
      );
    }
    return out;
  }
  return { raw, parsed: null, validationErrors: result.validationErrors, usage };
}
