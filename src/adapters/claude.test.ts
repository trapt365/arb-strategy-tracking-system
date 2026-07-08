import { describe, it, expect, beforeEach, vi } from 'vitest';
import { z } from 'zod';
import {
  callClaude,
  callClaudeSafe,
  shouldRetryClaude,
  _resetClaudeClientForTest,
  _setClaudeClientForTest,
} from './claude.js';
import { F1PipelineError } from '../errors.js';

const TestSchema = z.object({
  decisions: z.array(z.string()),
  count: z.number(),
});

interface MockResponse {
  content: Array<{ type: 'text'; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
  id?: string;
}

interface MockClient {
  messages: { create: ReturnType<typeof vi.fn> };
}

function makeClient(create: ReturnType<typeof vi.fn>): MockClient {
  return { messages: { create } };
}

function ok(text: string, id = 'msg_1'): MockResponse {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 100, output_tokens: 50 },
    id,
  };
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message = `http ${status}`) {
    super(message);
    this.status = status;
  }
}

const NO_SLEEP = { sleep: () => Promise.resolve() };
// shouldRetryClaude is real; withRetry uses real backoff but we mock sleep via opts? Actually
// callClaude does not allow injecting sleep — so we keep tests fast by using small mocks
// where retries succeed immediately or fail fast. (Retries do go through real setTimeout, but
// we use NO_SLEEP only conceptually below — actual claude.ts wires withRetry without
// sleep override; tests below use limited retry counts.)

describe('shouldRetryClaude', () => {
  it('retries on 429, 500, 503, 529', () => {
    expect(shouldRetryClaude(new HttpError(429))).toBe(true);
    expect(shouldRetryClaude(new HttpError(500))).toBe(true);
    expect(shouldRetryClaude(new HttpError(503))).toBe(true);
    expect(shouldRetryClaude(new HttpError(529))).toBe(true);
  });

  it('does NOT retry on 400, 401, 403', () => {
    expect(shouldRetryClaude(new HttpError(400))).toBe(false);
    expect(shouldRetryClaude(new HttpError(401))).toBe(false);
    expect(shouldRetryClaude(new HttpError(403))).toBe(false);
  });

  it('DOES retry on AbortError (SDK-internal fetch timeout)', () => {
    // Caller-initiated aborts are short-circuited by withRetry's signal check
    // BEFORE shouldRetryClaude is consulted. An AbortError reaching this
    // predicate therefore must originate from the SDK's internal fetch timeout —
    // a transient failure that should be retried (Task 4.5 spec).
    const e = new Error('aborted');
    e.name = 'AbortError';
    expect(shouldRetryClaude(e)).toBe(true);
    const t = new Error('timeout');
    t.name = 'TimeoutError';
    expect(shouldRetryClaude(t)).toBe(true);
  });

  it('retries on network errors (ECONNRESET, ETIMEDOUT)', () => {
    const e = new Error('socket') as Error & { code: string };
    e.code = 'ECONNRESET';
    expect(shouldRetryClaude(e)).toBe(true);
    e.code = 'ETIMEDOUT';
    expect(shouldRetryClaude(e)).toBe(true);
  });

  it('DOES retry on SDK request timeout ("Request timed out.")', () => {
    // Anthropic SDK v0.90 throws APIConnectionTimeoutError with this message and
    // a name that is NOT AbortError/TimeoutError — прод-баг Ф2 (attemptCount:1,
    // без ретрая). Ловим по message.
    expect(shouldRetryClaude(new Error('Request timed out.'))).toBe(true);
  });
});

describe('callClaude', () => {
  beforeEach(() => {
    _resetClaudeClientForTest();
  });

  it('happy path: returns raw, parsed, usage', async () => {
    const create = vi.fn().mockResolvedValue(ok('{"decisions":["a","b"],"count":2}'));
    _setClaudeClientForTest(makeClient(create) as unknown as never);
    const result = await callClaude('hello', { stepName: 'extraction', schema: TestSchema });
    expect(result.parsed).toEqual({ decisions: ['a', 'b'], count: 2 });
    expect(result.raw).toBe('{"decisions":["a","b"],"count":2}');
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('strips ```json fences before parse', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(ok('```json\n{"decisions":[],"count":0}\n```'));
    _setClaudeClientForTest(makeClient(create) as unknown as never);
    const result = await callClaude('p', { stepName: 'analysis', schema: TestSchema });
    expect(result.parsed).toEqual({ decisions: [], count: 0 });
  });

  it('throws claude_response_invalid on JSON parse failure', async () => {
    const create = vi.fn().mockResolvedValue(ok('not-json-at-all'));
    _setClaudeClientForTest(makeClient(create) as unknown as never);
    await expect(
      callClaude('p', { stepName: 'extraction', schema: TestSchema }),
    ).rejects.toMatchObject({
      name: 'F1PipelineError',
      code: 'claude_response_invalid',
      context: { reason: 'json_parse_failed', raw: 'not-json-at-all' },
    });
  });

  it('throws claude_response_invalid on Zod validation failure (raw preserved)', async () => {
    const create = vi.fn().mockResolvedValue(ok('{"wrong":"shape"}'));
    _setClaudeClientForTest(makeClient(create) as unknown as never);
    let captured: F1PipelineError | undefined;
    try {
      await callClaude('p', { stepName: 'extraction', schema: TestSchema });
    } catch (err) {
      captured = err as F1PipelineError;
    }
    expect(captured?.code).toBe('claude_response_invalid');
    expect(captured?.context.reason).toBe('zod_validation_failed');
    expect(captured?.context.raw).toBe('{"wrong":"shape"}');
  });

  it('does NOT retry on 401 (immediate fail mapped to claude_api)', async () => {
    const create = vi.fn().mockRejectedValue(new HttpError(401, 'unauth'));
    _setClaudeClientForTest(makeClient(create) as unknown as never);
    let captured: F1PipelineError | undefined;
    try {
      await callClaude('p', { stepName: 'extraction', schema: TestSchema });
    } catch (err) {
      captured = err as F1PipelineError;
    }
    expect(captured?.code).toBe('claude_api');
    expect(captured?.context.httpStatus).toBe(401);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('throws no_text_block when response has no text content', async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'tool_use' }],
      usage: { input_tokens: 1, output_tokens: 1 },
      id: 'm1',
    });
    _setClaudeClientForTest(makeClient(create) as unknown as never);
    await expect(
      callClaude('p', { stepName: 'extraction', schema: TestSchema }),
    ).rejects.toMatchObject({
      name: 'F1PipelineError',
      code: 'claude_response_invalid',
      context: { reason: 'no_text_block' },
    });
  });

  it('passes signal to SDK when provided (AbortController cancel)', async () => {
    const create = vi.fn().mockImplementation((_args, opts) => {
      const sig = opts?.signal as AbortSignal | undefined;
      return new Promise((_resolve, reject) => {
        if (sig) {
          sig.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });
    _setClaudeClientForTest(makeClient(create) as unknown as never);
    const ctrl = new AbortController();
    const promise = callClaude('p', {
      stepName: 'extraction',
      schema: TestSchema,
      signal: ctrl.signal,
    });
    queueMicrotask(() => ctrl.abort());
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('passes per-call timeoutMs to SDK request options', async () => {
    const create = vi.fn().mockImplementation((_args, opts) => {
      expect((opts as { timeout?: number } | undefined)?.timeout).toBe(420_000);
      return Promise.resolve(ok('{"decisions":[],"count":0}'));
    });
    _setClaudeClientForTest(makeClient(create) as unknown as never);
    await callClaude('p', { stepName: 'extraction', schema: TestSchema, timeoutMs: 420_000 });
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('callClaudeSafe', () => {
  beforeEach(() => {
    _resetClaudeClientForTest();
  });

  it('happy path: returns parsed + raw + usage (no validationErrors)', async () => {
    const create = vi.fn().mockResolvedValue(ok('{"decisions":["a"],"count":1}'));
    _setClaudeClientForTest(makeClient(create) as unknown as never);
    const result = await callClaudeSafe('p', { stepName: 'format', schema: TestSchema });
    expect(result.parsed).toEqual({ decisions: ['a'], count: 1 });
    expect(result.raw).toBe('{"decisions":["a"],"count":1}');
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
    expect(result.validationErrors).toBeUndefined();
  });

  it('Zod fail returns parsed: null + validationErrors, does NOT throw', async () => {
    const create = vi.fn().mockResolvedValue(ok('{"wrong":"shape"}'));
    _setClaudeClientForTest(makeClient(create) as unknown as never);
    const result = await callClaudeSafe('p', { stepName: 'format', schema: TestSchema });
    expect(result.parsed).toBeNull();
    expect(result.validationErrors).toBeDefined();
    expect(Array.isArray(result.validationErrors)).toBe(true);
    expect(result.raw).toBe('{"wrong":"shape"}');
    expect(result.usage).toEqual({ input_tokens: 100, output_tokens: 50 });
  });

  it('JSON.parse fail still throws claude_response_invalid (safeParse касается только Zod)', async () => {
    const create = vi.fn().mockResolvedValue(ok('not-json'));
    _setClaudeClientForTest(makeClient(create) as unknown as never);
    await expect(
      callClaudeSafe('p', { stepName: 'format', schema: TestSchema }),
    ).rejects.toMatchObject({
      name: 'F1PipelineError',
      code: 'claude_response_invalid',
      context: { reason: 'json_parse_failed' },
    });
  });

  it('HTTP 401 → throws claude_api immediately (network error не маскируется под Zod fail)', async () => {
    // 401 не retryable (auth error) → 1 attempt, no backoff wait.
    const create = vi.fn().mockRejectedValue(new HttpError(401, 'unauth'));
    _setClaudeClientForTest(makeClient(create) as unknown as never);
    let captured: F1PipelineError | undefined;
    try {
      await callClaudeSafe('p', { stepName: 'format', schema: TestSchema });
    } catch (err) {
      captured = err as F1PipelineError;
    }
    expect(captured?.code).toBe('claude_api');
    expect(captured?.context.httpStatus).toBe(401);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('AbortSignal → throws AbortError (НЕ маскируется под parsed:null)', async () => {
    const create = vi.fn().mockImplementation((_args, opts) => {
      const sig = opts?.signal as AbortSignal | undefined;
      return new Promise((_resolve, reject) => {
        sig?.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    });
    _setClaudeClientForTest(makeClient(create) as unknown as never);
    const ctrl = new AbortController();
    const promise = callClaudeSafe('p', {
      stepName: 'format',
      schema: TestSchema,
      signal: ctrl.signal,
    });
    queueMicrotask(() => ctrl.abort());
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});
