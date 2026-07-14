import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { logger } from './logger.js';
import {
  formatOpsAlert,
  formatWatchdogRepeat,
} from './utils/telegram-formatter.js';

export interface AlertPayload {
  pipeline: string;
  step: string;
  clientId?: string;
  error: unknown;
  context?: Record<string, unknown>;
}

export type OpsLevel = 'error' | 'warn' | 'info';

export interface OpsLogRow {
  timestamp: string;
  pipeline: string;
  step: string;
  clientId: string;
  durationMs: number | '';
  status: 'ok' | 'error' | 'partial' | 'aborted' | 'alert' | '';
  level: OpsLevel;
  message: string;
  errorCode: string;
  contextJson: string;
}

export type OpsTelegramSender = (text: string) => Promise<void>;
export type OpsSheetsWriter = (row: OpsLogRow) => Promise<void>;

export interface OpsEventPayload {
  pipeline: string;
  step: string;
  clientId?: string;
  durationMs?: number;
  status?: OpsLogRow['status'];
  message?: string;
  context?: Record<string, unknown>;
}

export interface WatchdogState {
  lastSuccessAt: string;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  lastRepeatAlertAt: string | null;
  escalatedToAidarAt: string | null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Module-level state (wired once at createBot.start())
// ──────────────────────────────────────────────────────────────────────────────

let _opsTelegramSender: OpsTelegramSender | null = null;
let _opsSheetsWriter: OpsSheetsWriter | null = null;
let _watchdogState: WatchdogState | null = null;
let _watchdogStateFilePath = path.join('data', '.ops-state.json');
// Tracks the in-flight fire-and-forget save so tests can flush before assertions.
let _pendingSave: Promise<void> = Promise.resolve();
let _saveQueue: Promise<void> = Promise.resolve();
let _saveCounter = 0;

function trackSave(p: Promise<void>): void {
  const tracked = p.catch(() => {
    /* errors already logged inside _saveWatchdogState */
  });
  _pendingSave = tracked;
}

export function setOpsTelegramSender(fn: OpsTelegramSender | null): void {
  _opsTelegramSender = fn;
}

export function setOpsSheetsWriter(fn: OpsSheetsWriter | null): void {
  _opsSheetsWriter = fn;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

const TRUNCATE_SUFFIX = '...[truncated]';

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.max(0, max - TRUNCATE_SUFFIX.length);
  return s.slice(0, head) + TRUNCATE_SUFFIX;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function extractErrorCode(err: unknown): string {
  if (!err || !(err instanceof Error)) return '';
  const name = err.name || 'Error';
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && code.length > 0) return `${name}:${code}`;
  return name;
}

function errorMessageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err === undefined || err === null) return '';
  return String(err);
}

function toOpsLogRow(args: {
  payload: {
    pipeline: string;
    step: string;
    clientId?: string;
    context?: Record<string, unknown>;
    error?: unknown;
    message?: string;
  };
  level: OpsLevel;
  status: OpsLogRow['status'];
  durationMs: number | '';
}): OpsLogRow {
  const errorCode = extractErrorCode(args.payload.error);
  const rawMessage =
    args.payload.message !== undefined
      ? args.payload.message
      : errorMessageOf(args.payload.error);
  return {
    timestamp: new Date().toISOString(),
    pipeline: args.payload.pipeline,
    step: args.payload.step,
    clientId: args.payload.clientId ?? '',
    durationMs: args.durationMs,
    status: args.status,
    level: args.level,
    message: truncate(rawMessage, 500),
    errorCode,
    contextJson: truncate(safeStringify(args.payload.context ?? {}), 4096),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Watchdog state persistence (data/.ops-state.json, atomic tmp → rename)
// ──────────────────────────────────────────────────────────────────────────────

function initialWatchdogState(): WatchdogState {
  return {
    lastSuccessAt: new Date().toISOString(),
    lastFailureAt: null,
    lastFailureReason: null,
    lastRepeatAlertAt: null,
    escalatedToAidarAt: null,
  };
}

async function _loadWatchdogState(): Promise<WatchdogState> {
  try {
    const buf = await fs.readFile(_watchdogStateFilePath, 'utf8');
    const parsed = JSON.parse(buf) as Partial<WatchdogState>;
    if (
      typeof parsed.lastSuccessAt === 'string' &&
      Number.isFinite(Date.parse(parsed.lastSuccessAt))
    ) {
      return {
        lastSuccessAt: parsed.lastSuccessAt,
        lastFailureAt: typeof parsed.lastFailureAt === 'string' ? parsed.lastFailureAt : null,
        lastFailureReason:
          typeof parsed.lastFailureReason === 'string' ? parsed.lastFailureReason : null,
        lastRepeatAlertAt:
          typeof parsed.lastRepeatAlertAt === 'string' ? parsed.lastRepeatAlertAt : null,
        escalatedToAidarAt:
          typeof parsed.escalatedToAidarAt === 'string' ? parsed.escalatedToAidarAt : null,
      };
    }
    logger.warn(
      { step: 'ops.watchdog.state.invalid', file: _watchdogStateFilePath },
      'watchdog state file is malformed, falling back to initial state',
    );
    return initialWatchdogState();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return initialWatchdogState();
    }
    logger.warn(
      { step: 'ops.watchdog.state.load_failed', err },
      'watchdog state load failed, falling back to initial state',
    );
    return initialWatchdogState();
  }
}

async function _saveWatchdogState(state: WatchdogState): Promise<void> {
  const snapshot = { ...state };
  const seq = ++_saveCounter;
  const tmp = `${_watchdogStateFilePath}.tmp.${process.pid}.${seq}`;
  try {
    await fs.mkdir(path.dirname(_watchdogStateFilePath), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    await fs.rename(tmp, _watchdogStateFilePath);
  } catch (err) {
    logger.warn(
      { step: 'ops.watchdog.state.save_failed', err, file: _watchdogStateFilePath },
      'watchdog state save failed',
    );
  }
}

function _updateWatchdogState(patch: Partial<WatchdogState>): void {
  if (_watchdogState === null) return; // watchdog not initialized yet (early alertOps)
  const merged: WatchdogState = { ..._watchdogState, ...patch };
  if (patch.lastSuccessAt !== undefined) {
    merged.lastRepeatAlertAt = null;
    merged.escalatedToAidarAt = null;
  }
  _watchdogState = merged;
  _saveQueue = _saveQueue.then(() => _saveWatchdogState(merged));
  trackSave(_saveQueue);
}

function persistWatchdogState(state: WatchdogState): void {
  _saveQueue = _saveQueue.then(() => _saveWatchdogState(state));
  trackSave(_saveQueue);
}

// ──────────────────────────────────────────────────────────────────────────────
// Watchdog tick — pure function for table-driven tests
// ──────────────────────────────────────────────────────────────────────────────

const FOUR_HOURS_MS = 4 * 60 * 60_000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60_000;

export interface TickWatchdogResult {
  shouldRepeatAlert: boolean;
  shouldEscalateAidar: boolean;
  nextState: WatchdogState;
}

export function tickWatchdog(state: WatchdogState, nowMs: number): TickWatchdogResult {
  const lastSuccessMs = Date.parse(state.lastSuccessAt);
  if (!Number.isFinite(lastSuccessMs)) {
    return { shouldRepeatAlert: false, shouldEscalateAidar: false, nextState: state };
  }
  const lastRepeatMs = state.lastRepeatAlertAt ? Date.parse(state.lastRepeatAlertAt) : null;
  const downMs = nowMs - lastSuccessMs;
  const enough4h = downMs >= FOUR_HOURS_MS;
  const enough24h = downMs >= TWENTY_FOUR_HOURS_MS;
  const cooldownPassed =
    lastRepeatMs === null || !Number.isFinite(lastRepeatMs)
      ? true
      : nowMs - lastRepeatMs >= FOUR_HOURS_MS;
  // «Инцидент активен» = сбой случился ПОСЛЕ последнего успеха. Сбой старше успеха —
  // пайплайн восстановился; тихие ≥4ч без новых отчётов не считаются down (иначе
  // watchdog алертит каждые 4ч простоя и через 24ч ложно эскалирует Айдару).
  const lastFailureMs = state.lastFailureAt !== null ? Date.parse(state.lastFailureAt) : NaN;
  const hasFailure = Number.isFinite(lastFailureMs) && lastFailureMs > lastSuccessMs;
  const shouldRepeatAlert = enough4h && cooldownPassed && hasFailure;
  const shouldEscalateAidar =
    enough24h && state.escalatedToAidarAt === null && hasFailure;

  let nextState = state;
  if (shouldRepeatAlert) {
    nextState = { ...nextState, lastRepeatAlertAt: new Date(nowMs).toISOString() };
  }
  if (shouldEscalateAidar) {
    nextState = { ...nextState, escalatedToAidarAt: new Date(nowMs).toISOString() };
  }
  return { shouldRepeatAlert, shouldEscalateAidar, nextState };
}

// ──────────────────────────────────────────────────────────────────────────────
// startWatchdog — production setInterval driver
// ──────────────────────────────────────────────────────────────────────────────

export interface StartWatchdogOpts {
  intervalMs?: number;
  getNow?: () => number;
  aidarMention?: string;
}

export interface WatchdogHandle {
  stop: () => void;
}

export async function startWatchdog(opts: StartWatchdogOpts = {}): Promise<WatchdogHandle> {
  const intervalMs = opts.intervalMs ?? 5 * 60_000;
  const getNow = opts.getNow ?? ((): number => Date.now());
  const aidarMention = opts.aidarMention ?? '';

  if (_watchdogState === null) {
    _watchdogState = await _loadWatchdogState();
  }

  const timer = setInterval(() => {
    if (_watchdogState === null) return;
    const previousState = _watchdogState;
    const result = tickWatchdog(_watchdogState, getNow());

    if (!result.shouldRepeatAlert) return;

    const hoursDown = Math.floor(
      (getNow() - Date.parse(result.nextState.lastSuccessAt)) / 3_600_000,
    );
    const text = formatWatchdogRepeat({
      hoursDown,
      lastSuccessAt: result.nextState.lastSuccessAt,
      lastFailureAt: result.nextState.lastFailureAt,
      lastFailureReason: result.nextState.lastFailureReason ?? undefined,
      aidarMention,
      escalateAidar: result.shouldEscalateAidar,
    });

    const writer = _opsSheetsWriter;
    const row: OpsLogRow = {
      timestamp: new Date(getNow()).toISOString(),
      pipeline: 'OPS',
      step: 'watchdog.repeat_alert',
      clientId: '',
      durationMs: '',
      status: 'error',
      level: 'error',
      message: truncate(`Pipeline down > ${hoursDown}ч`, 500),
      errorCode: result.shouldEscalateAidar
        ? 'WatchdogError:aidar_escalation'
        : 'WatchdogError:repeat_alert',
      contextJson: truncate(
        safeStringify({
          hoursDown,
          lastSuccessAt: result.nextState.lastSuccessAt,
          lastFailureAt: result.nextState.lastFailureAt,
        }),
        4096,
      ),
    };

    const sender = _opsTelegramSender;
    const commitAlertState = (): void => {
      if (_watchdogState !== previousState) return;
      _watchdogState = result.nextState;
      persistWatchdogState(result.nextState);
      if (writer) {
        writer(row).catch((err) =>
          logger.warn(
            { err, step: 'ops.watchdog.sheets_failed' },
            'watchdog sheets append failed',
          ),
        );
      }
    };

    if (!sender) return;
    sender(text)
      .then(commitAlertState)
      .catch((err) =>
        logger.warn(
          { err, step: 'ops.watchdog.send_failed' },
          'watchdog telegram send failed',
        ),
      );
  }, intervalMs);

  if (typeof timer.unref === 'function') timer.unref();

  return { stop: (): void => clearInterval(timer) };
}

// ──────────────────────────────────────────────────────────────────────────────
// alertOps — pino synchronous + fire-and-forget Telegram + Sheets side-effects
// ──────────────────────────────────────────────────────────────────────────────

export function alertOps(payload: AlertPayload): void {
  // 1. Synchronous pino log (existing contract — never delete or skip).
  logger.error(
    {
      level: 'ops_alert',
      pipeline: payload.pipeline,
      step: payload.step,
      clientId: payload.clientId,
      err: payload.error,
      context: payload.context,
    },
    'ops alert raised',
  );

  const errorMessage = errorMessageOf(payload.error);
  const errorCode = extractErrorCode(payload.error);

  // 2. Telegram ops-channel send (fire-and-forget).
  const sender = _opsTelegramSender;
  if (sender) {
    const text = formatOpsAlert({
      pipeline: payload.pipeline,
      step: payload.step,
      clientId: payload.clientId,
      level: 'error',
      message: errorMessage,
      errorCode,
      context: payload.context,
    });
    sender(text).catch((err) =>
      logger.warn(
        { err, step: 'ops.telegram.send_failed', alertedStep: payload.step },
        'ops alert telegram send failed',
      ),
    );
  }

  // 3. Sheets _ops_logs append (fire-and-forget; independent of Telegram).
  const writer = _opsSheetsWriter;
  if (writer) {
    const row = toOpsLogRow({
      payload: {
        pipeline: payload.pipeline,
        step: payload.step,
        clientId: payload.clientId,
        context: payload.context,
        error: payload.error,
      },
      level: 'error',
      status: 'alert',
      durationMs: '',
    });
    writer(row).catch((err) =>
      logger.warn(
        { err, step: 'ops.sheets.append_failed', alertedStep: payload.step },
        'ops alert sheets append failed',
      ),
    );
  }

  // 4. Watchdog side-effect: record the failure (resets repeat-alert cooldown via tickWatchdog).
  _updateWatchdogState({
    lastFailureAt: new Date().toISOString(),
    lastFailureReason: payload.step,
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// recordOpsEvent — canonical info/warn event tracker (NO Telegram side-effect)
// ──────────────────────────────────────────────────────────────────────────────

export function recordOpsEvent(level: OpsLevel, p: OpsEventPayload): void {
  const message = p.message ?? p.step;
  const logFields = {
    pipeline: p.pipeline,
    step: p.step,
    clientId: p.clientId,
    durationMs: p.durationMs,
    status: p.status,
    context: p.context,
  };
  if (level === 'error') {
    logger.error(logFields, message);
  } else if (level === 'warn') {
    logger.warn(logFields, message);
  } else {
    logger.info(logFields, message);
  }

  const writer = _opsSheetsWriter;
  if (writer) {
    const row = toOpsLogRow({
      payload: {
        pipeline: p.pipeline,
        step: p.step,
        clientId: p.clientId,
        context: p.context,
        message,
      },
      level,
      status: p.status ?? 'ok',
      durationMs: p.durationMs ?? '',
    });
    writer(row).catch((err) =>
      logger.warn(
        { err, step: 'ops.sheets.append_failed', eventStep: p.step },
        'ops event sheets append failed',
      ),
    );
  }

  // Канонический успех пайплайна → сброс down-watchdog. Считаем и F1-доставку отчёта,
  // и успешную сборку F0-черновика: иначе в периоды без F1-отчётов (напр. онбординг
  // новых клиентов) watchdog ложно рапортует «Pipeline down» по протухшему lastSuccessAt.
  if (
    level === 'info' &&
    p.status === 'ok' &&
    (p.step === 'bot.report.completed' || p.step === 'f0.draft_delivered')
  ) {
    _updateWatchdogState({ lastSuccessAt: new Date().toISOString() });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Test-only helpers
// ──────────────────────────────────────────────────────────────────────────────

export function _resetWatchdogStateForTest(): void {
  _watchdogState = null;
  _saveQueue = Promise.resolve();
  _pendingSave = Promise.resolve();
  _saveCounter = 0;
}

export function _setWatchdogStateForTest(state: WatchdogState | null): void {
  _watchdogState = state;
}

export function _getWatchdogStateForTest(): WatchdogState | null {
  return _watchdogState;
}

export function _setWatchdogStatePathForTest(p: string): void {
  _watchdogStateFilePath = p;
}

export function _getWatchdogStatePathForTest(): string {
  return _watchdogStateFilePath;
}

/** Resolves once all in-flight `_saveWatchdogState` calls have completed (success or failure). */
export async function _flushPendingSavesForTest(): Promise<void> {
  await _pendingSave;
}
