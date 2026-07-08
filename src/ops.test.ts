import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { logger } from './logger.js';
import {
  alertOps,
  recordOpsEvent,
  setOpsTelegramSender,
  setOpsSheetsWriter,
  startWatchdog,
  tickWatchdog,
  _resetWatchdogStateForTest,
  _setWatchdogStateForTest,
  _getWatchdogStateForTest,
  _setWatchdogStatePathForTest,
  _flushPendingSavesForTest,
  type OpsTelegramSender,
  type OpsSheetsWriter,
  type WatchdogState,
  type OpsLogRow,
} from './ops.js';

// Silence pino during tests, capture warn/error/info calls via spies.
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

let tmpStateDir: string;

beforeEach(async () => {
  warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
  errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
  infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
  setOpsTelegramSender(null);
  setOpsSheetsWriter(null);
  _resetWatchdogStateForTest();
  tmpStateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ops-state-'));
  _setWatchdogStatePathForTest(path.join(tmpStateDir, '.ops-state.json'));
});

afterEach(async () => {
  // Drain any in-flight state-save promises before rm to avoid ENOTEMPTY races.
  await _flushPendingSavesForTest();
  vi.restoreAllMocks();
  setOpsTelegramSender(null);
  setOpsSheetsWriter(null);
  _resetWatchdogStateForTest();
  await fs.rm(tmpStateDir, { recursive: true, force: true }).catch(() => {
    // Best-effort: ignore lingering races; tests use unique tmp dirs.
  });
});

const samplePayload = {
  pipeline: 'F1',
  step: 'bot.report.pipeline_failed',
  clientId: 'geonline',
  error: new Error('Claude API timeout'),
  context: { jobId: 'abc12345', urlPath: '/file/d/xyz' },
};

describe('alertOps (Story 1.9)', () => {
  it('без sender/writer → pino-лог происходит, никаких side-effects', () => {
    alertOps(samplePayload);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [logArg, msgArg] = errorSpy.mock.calls[0]!;
    expect((logArg as Record<string, unknown>).level).toBe('ops_alert');
    expect((logArg as Record<string, unknown>).step).toBe('bot.report.pipeline_failed');
    expect(msgArg).toBe('ops alert raised');
  });

  it('с sender → sender вызван 1 раз с текстом содержащим 🚨 + step + clientId + message', async () => {
    const sender: OpsTelegramSender = vi.fn().mockResolvedValue(undefined);
    setOpsTelegramSender(sender);

    alertOps(samplePayload);
    // Wait for the fire-and-forget microtask to run.
    await new Promise((r) => setImmediate(r));

    expect(sender).toHaveBeenCalledTimes(1);
    const text = (sender as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(text).toContain('🚨');
    expect(text).toContain('[F1/bot.report.pipeline_failed]');
    expect(text).toContain('geonline');
    expect(text).toContain('Claude API timeout');
    expect(text).toContain('error_code: Error');
  });

  it('с writer → writer вызван 1 раз с OpsLogRow {status=alert, level=error, ISO timestamp}', async () => {
    const writer: OpsSheetsWriter = vi.fn().mockResolvedValue(undefined);
    setOpsSheetsWriter(writer);

    alertOps(samplePayload);
    await new Promise((r) => setImmediate(r));

    expect(writer).toHaveBeenCalledTimes(1);
    const row = (writer as ReturnType<typeof vi.fn>).mock.calls[0]![0] as OpsLogRow;
    expect(row.status).toBe('alert');
    expect(row.level).toBe('error');
    expect(row.pipeline).toBe('F1');
    expect(row.step).toBe('bot.report.pipeline_failed');
    expect(row.clientId).toBe('geonline');
    expect(row.errorCode).toBe('Error');
    expect(row.message).toBe('Claude API timeout');
    expect(row.contextJson).toContain('jobId');
    expect(row.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('writer rejects → log.warn "ops alert sheets append failed", sender НЕ блокируется', async () => {
    const writer: OpsSheetsWriter = vi.fn().mockRejectedValue(new Error('sheets 500'));
    const sender: OpsTelegramSender = vi.fn().mockResolvedValue(undefined);
    setOpsSheetsWriter(writer);
    setOpsTelegramSender(sender);

    alertOps(samplePayload);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(sender).toHaveBeenCalledTimes(1);
    const warned = warnSpy.mock.calls.some(
      (call) =>
        typeof call[1] === 'string' && call[1] === 'ops alert sheets append failed',
    );
    expect(warned).toBe(true);
  });

  it('sender rejects → log.warn "ops alert telegram send failed", writer независим', async () => {
    const writer: OpsSheetsWriter = vi.fn().mockResolvedValue(undefined);
    const sender: OpsTelegramSender = vi.fn().mockRejectedValue(new Error('telegram down'));
    setOpsSheetsWriter(writer);
    setOpsTelegramSender(sender);

    alertOps(samplePayload);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(writer).toHaveBeenCalledTimes(1);
    const warned = warnSpy.mock.calls.some(
      (call) =>
        typeof call[1] === 'string' && call[1] === 'ops alert telegram send failed',
    );
    expect(warned).toBe(true);
  });

  it('обновляет watchdog state.lastFailureAt + lastFailureReason', () => {
    const before: WatchdogState = {
      lastSuccessAt: '2026-05-21T08:00:00.000Z',
      lastFailureAt: null,
      lastFailureReason: null,
      lastRepeatAlertAt: null,
      escalatedToAidarAt: null,
    };
    _setWatchdogStateForTest(before);
    alertOps(samplePayload);
    const after = _getWatchdogStateForTest()!;
    expect(after.lastFailureAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(after.lastFailureReason).toBe('bot.report.pipeline_failed');
    // lastSuccessAt is preserved (no reset on failure).
    expect(after.lastSuccessAt).toBe('2026-05-21T08:00:00.000Z');
  });

  it('errorCode извлекается из Error subclass с .code', async () => {
    const writer: OpsSheetsWriter = vi.fn().mockResolvedValue(undefined);
    setOpsSheetsWriter(writer);

    class MyError extends Error {
      readonly code = 'rate_limited';
      constructor() {
        super('throttled');
        this.name = 'SheetsAdapterError';
      }
    }
    alertOps({
      pipeline: 'F1',
      step: 'sheets.read',
      clientId: 'geonline',
      error: new MyError(),
    });
    await new Promise((r) => setImmediate(r));
    const row = (writer as ReturnType<typeof vi.fn>).mock.calls[0]![0] as OpsLogRow;
    expect(row.errorCode).toBe('SheetsAdapterError:rate_limited');
  });
});

describe('recordOpsEvent (Story 1.9)', () => {
  it("info: bot.report.completed status='ok' → pino + writer + watchdog.lastSuccessAt update", async () => {
    const sender: OpsTelegramSender = vi.fn();
    const writer: OpsSheetsWriter = vi.fn().mockResolvedValue(undefined);
    setOpsTelegramSender(sender);
    setOpsSheetsWriter(writer);
    _setWatchdogStateForTest({
      lastSuccessAt: '2026-05-21T08:00:00.000Z',
      lastFailureAt: '2026-05-21T10:00:00.000Z',
      lastFailureReason: 'F1/extraction',
      lastRepeatAlertAt: '2026-05-21T11:00:00.000Z',
      escalatedToAidarAt: '2026-05-21T11:00:00.000Z',
    });

    recordOpsEvent('info', {
      pipeline: 'F1',
      step: 'bot.report.completed',
      clientId: 'geonline',
      durationMs: 12345,
      status: 'ok',
      context: { jobId: 'abc' },
    });
    await new Promise((r) => setImmediate(r));

    expect(infoSpy).toHaveBeenCalled();
    expect(sender).not.toHaveBeenCalled();
    expect(writer).toHaveBeenCalledTimes(1);
    const row = (writer as ReturnType<typeof vi.fn>).mock.calls[0]![0] as OpsLogRow;
    expect(row.level).toBe('info');
    expect(row.status).toBe('ok');
    expect(row.durationMs).toBe(12345);

    const after = _getWatchdogStateForTest()!;
    expect(after.lastSuccessAt).not.toBe('2026-05-21T08:00:00.000Z');
    expect(after.lastRepeatAlertAt).toBeNull();
    expect(after.escalatedToAidarAt).toBeNull();
  });

  it("info: f0.draft_delivered status='ok' → watchdog.lastSuccessAt update (F0 тоже успех)", async () => {
    setOpsSheetsWriter(vi.fn().mockResolvedValue(undefined));
    _setWatchdogStateForTest({
      lastSuccessAt: '2026-05-21T08:00:00.000Z',
      lastFailureAt: '2026-05-21T10:00:00.000Z',
      lastFailureReason: 'F0/f0.draft_failed',
      lastRepeatAlertAt: '2026-05-21T11:00:00.000Z',
      escalatedToAidarAt: '2026-05-21T11:00:00.000Z',
    });

    recordOpsEvent('info', {
      pipeline: 'F0',
      step: 'f0.draft_delivered',
      status: 'ok',
      context: { chatId: 1, sessionId: 'x', draftId: 'd', files: 4 },
    });
    await new Promise((r) => setImmediate(r));

    const after = _getWatchdogStateForTest()!;
    expect(after.lastSuccessAt).not.toBe('2026-05-21T08:00:00.000Z');
    expect(after.lastRepeatAlertAt).toBeNull();
  });

  it('warn level НЕ обновляет watchdog state', async () => {
    _setWatchdogStateForTest({
      lastSuccessAt: '2026-05-21T08:00:00.000Z',
      lastFailureAt: null,
      lastFailureReason: null,
      lastRepeatAlertAt: null,
      escalatedToAidarAt: null,
    });
    recordOpsEvent('warn', {
      pipeline: 'F1',
      step: 'bot.queue_overflow',
      message: 'queue full',
    });
    const after = _getWatchdogStateForTest()!;
    expect(after.lastSuccessAt).toBe('2026-05-21T08:00:00.000Z');
  });

  it('без writer не падает', () => {
    expect(() =>
      recordOpsEvent('info', {
        pipeline: 'F1',
        step: 'bot.report.queued',
        status: 'ok',
      }),
    ).not.toThrow();
  });

  it('writer rejects → log.warn "ops event sheets append failed"', async () => {
    const writer: OpsSheetsWriter = vi.fn().mockRejectedValue(new Error('sheets 500'));
    setOpsSheetsWriter(writer);
    recordOpsEvent('info', {
      pipeline: 'F1',
      step: 'bot.report.queued',
      status: 'ok',
    });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const warned = warnSpy.mock.calls.some(
      (call) =>
        typeof call[1] === 'string' && call[1] === 'ops event sheets append failed',
    );
    expect(warned).toBe(true);
  });
});

describe('tickWatchdog (Story 1.9) — table-driven', () => {
  const HOUR = 60 * 60_000;
  const baseTime = Date.parse('2026-05-21T14:00:00.000Z');
  const minus = (hours: number): string => new Date(baseTime - hours * HOUR).toISOString();

  it.each([
    {
      label: 'T-3h, no repeat, has failure → no alert (порог 4ч не достигнут)',
      successHoursAgo: 3,
      lastRepeatAlertAt: null,
      escalatedToAidarAt: null,
      hasFailure: true,
      expectedRepeat: false,
      expectedEscalate: false,
    },
    {
      label: 'T-4h exact, no repeat, has failure → repeat (>= boundary)',
      successHoursAgo: 4,
      lastRepeatAlertAt: null,
      escalatedToAidarAt: null,
      hasFailure: true,
      expectedRepeat: true,
      expectedEscalate: false,
    },
    {
      label: 'T-4h, no failure recorded → no alert (нет инцидента)',
      successHoursAgo: 4,
      lastRepeatAlertAt: null,
      escalatedToAidarAt: null,
      hasFailure: false,
      expectedRepeat: false,
      expectedEscalate: false,
    },
    {
      label: 'T-5h, repeat 1h ago → debounce, no alert',
      successHoursAgo: 5,
      lastRepeatAlertAt: 1,
      escalatedToAidarAt: null,
      hasFailure: true,
      expectedRepeat: false,
      expectedEscalate: false,
    },
    {
      label: 'T-5h, repeat 5h ago (cooldown passed) → repeat',
      successHoursAgo: 5,
      lastRepeatAlertAt: 5,
      escalatedToAidarAt: null,
      hasFailure: true,
      expectedRepeat: true,
      expectedEscalate: false,
    },
    {
      label: 'T-24h, never escalated → repeat + escalate',
      successHoursAgo: 24,
      lastRepeatAlertAt: null,
      escalatedToAidarAt: null,
      hasFailure: true,
      expectedRepeat: true,
      expectedEscalate: true,
    },
    {
      label: 'T-25h, repeat 1h ago, escalated 1h ago → debounce repeat, no re-escalate',
      successHoursAgo: 25,
      lastRepeatAlertAt: 1,
      escalatedToAidarAt: 1,
      hasFailure: true,
      expectedRepeat: false,
      expectedEscalate: false,
    },
    {
      label: 'T-25h, repeat 5h ago (cooldown passed), never escalated → repeat + escalate',
      successHoursAgo: 25,
      lastRepeatAlertAt: 5,
      escalatedToAidarAt: null,
      hasFailure: true,
      expectedRepeat: true,
      expectedEscalate: true,
    },
  ])(
    '$label',
    ({
      successHoursAgo,
      lastRepeatAlertAt,
      escalatedToAidarAt,
      hasFailure,
      expectedRepeat,
      expectedEscalate,
    }) => {
      const state: WatchdogState = {
        lastSuccessAt: minus(successHoursAgo),
        lastFailureAt: hasFailure ? minus(0.5) : null,
        lastFailureReason: hasFailure ? 'F1/extraction' : null,
        lastRepeatAlertAt: lastRepeatAlertAt !== null ? minus(lastRepeatAlertAt) : null,
        escalatedToAidarAt: escalatedToAidarAt !== null ? minus(escalatedToAidarAt) : null,
      };
      const result = tickWatchdog(state, baseTime);
      expect(result.shouldRepeatAlert).toBe(expectedRepeat);
      expect(result.shouldEscalateAidar).toBe(expectedEscalate);
      if (expectedRepeat) {
        expect(result.nextState.lastRepeatAlertAt).toBe(new Date(baseTime).toISOString());
      } else {
        expect(result.nextState.lastRepeatAlertAt).toBe(state.lastRepeatAlertAt);
      }
      if (expectedEscalate) {
        expect(result.nextState.escalatedToAidarAt).toBe(new Date(baseTime).toISOString());
      } else {
        expect(result.nextState.escalatedToAidarAt).toBe(state.escalatedToAidarAt);
      }
    },
  );

  it('boundary: ровно 4h - 1ms → НЕ повторяет, ровно 4h → повторяет', () => {
    const state: WatchdogState = {
      lastSuccessAt: new Date(baseTime - 4 * HOUR).toISOString(),
      lastFailureAt: new Date(baseTime - 30 * 60_000).toISOString(),
      lastFailureReason: 'F1/extraction',
      lastRepeatAlertAt: null,
      escalatedToAidarAt: null,
    };
    // T - 1ms — должен НЕ повторить
    expect(tickWatchdog(state, baseTime - 1).shouldRepeatAlert).toBe(false);
    // T — должен повторить (>=)
    expect(tickWatchdog(state, baseTime).shouldRepeatAlert).toBe(true);
  });

  it('invalid lastSuccessAt (NaN) → не повторяет, defensive', () => {
    const state: WatchdogState = {
      lastSuccessAt: 'not-a-date',
      lastFailureAt: minus(0.5),
      lastFailureReason: 'X',
      lastRepeatAlertAt: null,
      escalatedToAidarAt: null,
    };
    const result = tickWatchdog(state, baseTime);
    expect(result.shouldRepeatAlert).toBe(false);
    expect(result.shouldEscalateAidar).toBe(false);
  });
});

describe('_loadWatchdogState / _saveWatchdogState (Story 1.9)', () => {
  it('ENOENT (first start) → initial state с lastSuccessAt=now, all nulls', async () => {
    // Trigger load through startWatchdog which calls _loadWatchdogState lazily.
    const handle = await startWatchdog({ intervalMs: 60_000, getNow: () => Date.now() });
    handle.stop();
    const state = _getWatchdogStateForTest()!;
    expect(state.lastFailureAt).toBeNull();
    expect(state.lastRepeatAlertAt).toBeNull();
    expect(state.escalatedToAidarAt).toBeNull();
    expect(Number.isFinite(Date.parse(state.lastSuccessAt))).toBe(true);
  });

  it('valid JSON → state восстановлен', async () => {
    const stored: WatchdogState = {
      lastSuccessAt: '2026-05-21T08:00:00.000Z',
      lastFailureAt: '2026-05-21T10:00:00.000Z',
      lastFailureReason: 'F1/x',
      lastRepeatAlertAt: '2026-05-21T11:00:00.000Z',
      escalatedToAidarAt: null,
    };
    await fs.writeFile(path.join(tmpStateDir, '.ops-state.json'), JSON.stringify(stored), 'utf8');
    const handle = await startWatchdog({ intervalMs: 60_000, getNow: () => Date.now() });
    handle.stop();
    const state = _getWatchdogStateForTest()!;
    expect(state).toEqual(stored);
  });

  it('invalid JSON → log.warn + fallback на initial state', async () => {
    await fs.writeFile(path.join(tmpStateDir, '.ops-state.json'), '{ not json }', 'utf8');
    const handle = await startWatchdog({ intervalMs: 60_000, getNow: () => Date.now() });
    handle.stop();
    const state = _getWatchdogStateForTest()!;
    expect(state.lastFailureAt).toBeNull();
    // either invalid-state-file warning or load-failed warning is acceptable
    const warned = warnSpy.mock.calls.some(
      (call) =>
        typeof call[1] === 'string' &&
        /watchdog state (file is malformed|load failed)/.test(call[1]),
    );
    expect(warned).toBe(true);
  });

  it('shape с lastSuccessAt отсутствующим → fallback на initial', async () => {
    await fs.writeFile(
      path.join(tmpStateDir, '.ops-state.json'),
      JSON.stringify({ foo: 'bar' }),
      'utf8',
    );
    const handle = await startWatchdog({ intervalMs: 60_000, getNow: () => Date.now() });
    handle.stop();
    const state = _getWatchdogStateForTest()!;
    expect(Number.isFinite(Date.parse(state.lastSuccessAt))).toBe(true);
  });

  it('saveWatchdogState атомарность: tmp файл → rename → final file существует', async () => {
    _setWatchdogStateForTest({
      lastSuccessAt: '2026-05-21T08:00:00.000Z',
      lastFailureAt: null,
      lastFailureReason: null,
      lastRepeatAlertAt: null,
      escalatedToAidarAt: null,
    });
    // Trigger save via alertOps (it calls _updateWatchdogState → void _saveWatchdogState).
    alertOps({
      pipeline: 'F1',
      step: 'test.step',
      error: new Error('x'),
    });
    await _flushPendingSavesForTest();
    const content = await fs.readFile(path.join(tmpStateDir, '.ops-state.json'), 'utf8');
    const parsed = JSON.parse(content);
    expect(parsed.lastFailureReason).toBe('test.step');
  });
});

describe('startWatchdog (Story 1.9)', () => {
  it('returns stop handle that clears interval', async () => {
    const handle = await startWatchdog({ intervalMs: 60_000 });
    expect(typeof handle.stop).toBe('function');
    handle.stop();
  });

  it('intervalMs tick → если down >= 4h, sender вызван с "Pipeline down" текстом', async () => {
    const sender: OpsTelegramSender = vi.fn().mockResolvedValue(undefined);
    const writer: OpsSheetsWriter = vi.fn().mockResolvedValue(undefined);
    setOpsTelegramSender(sender);
    setOpsSheetsWriter(writer);

    const baseTime = Date.parse('2026-05-21T14:00:00.000Z');
    // Pre-load state: 5h down with failure.
    _setWatchdogStateForTest({
      lastSuccessAt: new Date(baseTime - 5 * 3_600_000).toISOString(),
      lastFailureAt: new Date(baseTime - 30 * 60_000).toISOString(),
      lastFailureReason: 'F1/extraction',
      lastRepeatAlertAt: null,
      escalatedToAidarAt: null,
    });

    vi.useFakeTimers();
    try {
      const handle = await startWatchdog({
        intervalMs: 1000,
        getNow: () => baseTime,
        aidarMention: '@aidar',
      });
      vi.advanceTimersByTime(1100);
      // Drain microtasks for fire-and-forget sender/writer calls.
      await Promise.resolve();
      await Promise.resolve();
      handle.stop();

      expect(sender).toHaveBeenCalledTimes(1);
      const text = (sender as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(text).toContain('Pipeline down >');
      expect(text).toContain('⚠️'); // not yet escalated (5h < 24h)
      expect(writer).toHaveBeenCalledTimes(1);
      const row = (writer as ReturnType<typeof vi.fn>).mock.calls[0]![0] as OpsLogRow;
      expect(row.step).toBe('watchdog.repeat_alert');
      expect(row.pipeline).toBe('OPS');
      expect(row.errorCode).toBe('WatchdogError:repeat_alert');
    } finally {
      vi.useRealTimers();
    }
  });

  it('25h down, never escalated → escalation: 🚨 + @aidar mention, errorCode=aidar_escalation', async () => {
    const sender: OpsTelegramSender = vi.fn().mockResolvedValue(undefined);
    const writer: OpsSheetsWriter = vi.fn().mockResolvedValue(undefined);
    setOpsTelegramSender(sender);
    setOpsSheetsWriter(writer);

    const baseTime = Date.parse('2026-05-21T14:00:00.000Z');
    _setWatchdogStateForTest({
      lastSuccessAt: new Date(baseTime - 25 * 3_600_000).toISOString(),
      lastFailureAt: new Date(baseTime - 1 * 3_600_000).toISOString(),
      lastFailureReason: 'F1/extraction',
      lastRepeatAlertAt: null,
      escalatedToAidarAt: null,
    });

    vi.useFakeTimers();
    try {
      const handle = await startWatchdog({
        intervalMs: 1000,
        getNow: () => baseTime,
        aidarMention: '@aidar_geonline',
      });
      vi.advanceTimersByTime(1100);
      await Promise.resolve();
      await Promise.resolve();
      handle.stop();

      const text = (sender as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
      expect(text).toContain('🚨');
      expect(text).toContain('@aidar_geonline');
      const row = (writer as ReturnType<typeof vi.fn>).mock.calls[0]![0] as OpsLogRow;
      expect(row.errorCode).toBe('WatchdogError:aidar_escalation');

      // escalatedToAidarAt persisted
      const state = _getWatchdogStateForTest()!;
      expect(state.escalatedToAidarAt).toBe(new Date(baseTime).toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it('shouldRepeatAlert=false → ни sender, ни writer не вызывались', async () => {
    const sender: OpsTelegramSender = vi.fn();
    setOpsTelegramSender(sender);

    const baseTime = Date.parse('2026-05-21T14:00:00.000Z');
    _setWatchdogStateForTest({
      lastSuccessAt: new Date(baseTime - 1 * 3_600_000).toISOString(), // только 1h down
      lastFailureAt: new Date(baseTime - 30 * 60_000).toISOString(),
      lastFailureReason: 'F1/x',
      lastRepeatAlertAt: null,
      escalatedToAidarAt: null,
    });

    vi.useFakeTimers();
    try {
      const handle = await startWatchdog({
        intervalMs: 1000,
        getNow: () => baseTime,
      });
      vi.advanceTimersByTime(1100);
      await Promise.resolve();
      handle.stop();
      expect(sender).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sender throws → watchdog не фиксирует repeat/escalation как доставленные', async () => {
    const sender: OpsTelegramSender = vi.fn().mockRejectedValue(new Error('telegram down'));
    const writer: OpsSheetsWriter = vi.fn().mockResolvedValue(undefined);
    setOpsTelegramSender(sender);
    setOpsSheetsWriter(writer);

    const baseTime = Date.parse('2026-05-21T14:00:00.000Z');
    _setWatchdogStateForTest({
      lastSuccessAt: new Date(baseTime - 5 * 3_600_000).toISOString(),
      lastFailureAt: new Date(baseTime - 30 * 60_000).toISOString(),
      lastFailureReason: 'F1/x',
      lastRepeatAlertAt: null,
      escalatedToAidarAt: null,
    });

    vi.useFakeTimers();
    try {
      const handle = await startWatchdog({ intervalMs: 1000, getNow: () => baseTime });
      vi.advanceTimersByTime(1100);
      await Promise.resolve();
      await Promise.resolve();
      handle.stop();
      expect(writer).not.toHaveBeenCalled();
      const state = _getWatchdogStateForTest()!;
      expect(state.lastRepeatAlertAt).toBeNull();
      expect(state.escalatedToAidarAt).toBeNull();
      const warned = warnSpy.mock.calls.some(
        (call) =>
          typeof call[1] === 'string' && call[1] === 'watchdog telegram send failed',
      );
      expect(warned).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('recordOpsEvent("bot.report.completed", "ok") reset escalatedToAidarAt + lastRepeatAlertAt', () => {
    _setWatchdogStateForTest({
      lastSuccessAt: '2026-05-21T08:00:00.000Z',
      lastFailureAt: '2026-05-21T10:00:00.000Z',
      lastFailureReason: 'F1/x',
      lastRepeatAlertAt: '2026-05-21T11:00:00.000Z',
      escalatedToAidarAt: '2026-05-21T11:00:00.000Z',
    });

    recordOpsEvent('info', {
      pipeline: 'F1',
      step: 'bot.report.completed',
      clientId: 'geonline',
      durationMs: 100,
      status: 'ok',
    });

    const state = _getWatchdogStateForTest()!;
    expect(state.lastRepeatAlertAt).toBeNull();
    expect(state.escalatedToAidarAt).toBeNull();
  });
});

// Suppress lint warning if errorSpy never asserted directly.
void errorSpy;
