import { google, type sheets_v4 } from 'googleapis';
import { ZodError } from 'zod';
import { config } from '../config.js';
import { logger as rootLogger, type Logger } from '../logger.js';
import { withRetry } from '../utils/retry.js';
import { loadServiceAccountCredentials } from '../utils/google-auth.js';
import { alertOps } from '../ops.js';
import {
  ClientContextSchema,
  StakeholderSchema,
  OkrKrSchema,
  F5MetricSchema,
  type ClientContext,
} from '../types.js';
import { SheetsAdapterError, TranscriptConfigError } from '../errors.js';

export { SheetsAdapterError } from '../errors.js';
export type { SheetsAdapterCode } from '../errors.js';

const SHEETS_LATENCY_WARN_MS = 2000;

const SHEET_RANGES = [
  '_stakeholder_map!A1:Z',
  '_okr!A1:Z',
  '_f5_metrics!A1:Z',
] as const;

const EXPECTED_HEADERS = {
  stakeholderMap: [
    'full_name',
    'speaker_name',
    'department',
    'role',
    'bsc_category',
    'responsibility_areas',
    'interests',
    'notes',
  ],
  okr: [
    'kr_number',
    'short_name',
    'key_result',
    'owner',
    'owner_position',
    'current_status',
    'target',
    'progress',
    'deadline',
    'okr_group',
    'quarter',
  ],
  f5Metrics: [
    'department',
    'metric_name',
    'metric_type',
    'unit',
    'source',
    'owner_speaker_name',
    'ranges',
    'update_frequency',
    'risk_notes',
    'notes',
  ],
} as const;

type SheetsClientLogger = Pick<Logger, 'info' | 'warn' | 'error' | 'debug'> & {
  child: Logger['child'];
};

let cachedSheets: Promise<sheets_v4.Sheets> | null = null;

export async function getSheetsClient(): Promise<sheets_v4.Sheets> {
  if (cachedSheets) return cachedSheets;
  cachedSheets = (async () => {
    try {
      const credentials = await loadServiceAccountCredentials();
      const auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
      });
      return google.sheets({ version: 'v4', auth });
    } catch (err) {
      cachedSheets = null;
      throw err;
    }
  })();
  return cachedSheets;
}

export function _resetSheetsClientForTest(): void {
  cachedSheets = null;
}

function resolveSheetId(clientId: string): string {
  if (clientId !== 'geonline') {
    throw new SheetsAdapterError('auth', { reason: 'unknown_clientId', clientId });
  }
  return config.GEONLINE_F0_SHEET_ID;
}

const snakeToCamel = (s: string): string =>
  s.replace(/_([a-z0-9])/g, (_match, c: string) => c.toUpperCase());

export function __test_only_snakeToCamel(s: string): string {
  return snakeToCamel(s);
}

export function __test_only_parseSheetRange(
  values: string[][],
  sheetName: string,
  expected: readonly string[],
): Record<string, string>[] {
  return parseSheetRange(values, sheetName, expected);
}

function parseSheetRange(
  values: string[][],
  sheetName: string,
  expectedHeaders: readonly string[],
): Record<string, string>[] {
  if (values.length === 0) {
    throw new SheetsAdapterError('sheet_not_found', { sheet: sheetName });
  }
  const headerRow = values[0]!.map((h) => String(h ?? '').trim());
  const missingHeaders = expectedHeaders.filter((h) => !headerRow.includes(h));
  if (missingHeaders.length > 0) {
    throw new SheetsAdapterError('header_missing', {
      sheet: sheetName,
      missingHeaders,
      foundHeaders: headerRow,
    });
  }
  const camelHeaders = headerRow.map(snakeToCamel);
  return values.slice(1).map((row) =>
    Object.fromEntries(
      camelHeaders.map((h, i) => [h, String(row[i] ?? '').trim()]),
    ),
  );
}

function parseF5Ranges(rangesRaw: string): string[] {
  const trimmed = rangesRaw.trim();
  if (trimmed === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new SheetsAdapterError(
      'invalid_value',
      {
        sheet: '_f5_metrics',
        column: 'ranges',
        value: rangesRaw,
        parseError: (err as Error).message,
      },
      { cause: err },
    );
  }
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
    throw new SheetsAdapterError('invalid_value', {
      sheet: '_f5_metrics',
      column: 'ranges',
      value: rangesRaw,
      parseError: 'not a string[] array',
    });
  }
  return parsed;
}

function shouldRetrySheets(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as {
    code?: unknown;
    response?: { status?: number };
    name?: string;
  };
  const status =
    typeof e.response?.status === 'number'
      ? e.response.status
      : typeof e.code === 'number'
      ? e.code
      : typeof e.code === 'string' && /^\d+$/.test(e.code)
      ? Number(e.code)
      : undefined;
  if (typeof status === 'number') {
    if (status === 401 || status === 403 || status === 400 || status === 404) return false;
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }
  if (typeof e.code === 'string') {
    if (
      e.code === 'ETIMEDOUT' ||
      e.code === 'ECONNRESET' ||
      e.code === 'ENOTFOUND' ||
      e.code === 'EAI_AGAIN' ||
      e.code === 'ECONNREFUSED'
    ) {
      return true;
    }
  }
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  return false;
}

function mapGoogleApiError(err: unknown, sheetId: string): SheetsAdapterError {
  if (err instanceof SheetsAdapterError) return err;
  const e = err as {
    code?: unknown;
    response?: { status?: number };
    message?: string;
  };
  const status =
    typeof e.response?.status === 'number'
      ? e.response.status
      : typeof e.code === 'number'
      ? e.code
      : typeof e.code === 'string' && /^\d+$/.test(e.code)
      ? Number(e.code)
      : undefined;
  if (status === 401) {
    return new SheetsAdapterError(
      'auth',
      { httpStatus: 401, reason: 'unauthorized' },
      { cause: err },
    );
  }
  if (status === 403) {
    return new SheetsAdapterError(
      'auth',
      { httpStatus: 403, reason: 'forbidden_or_revoked' },
      { cause: err },
    );
  }
  if (status === 404) {
    return new SheetsAdapterError(
      'sheet_not_found',
      { spreadsheetId: sheetId, httpStatus: 404 },
      { cause: err },
    );
  }
  if (status === 429) {
    return new SheetsAdapterError(
      'rate_limited',
      { httpStatus: 429 },
      { cause: err },
    );
  }
  if (typeof status === 'number' && status >= 500 && status < 600) {
    return new SheetsAdapterError(
      'network',
      { httpStatus: status },
      { cause: err },
    );
  }
  const networkCode = typeof e.code === 'string' ? e.code : undefined;
  return new SheetsAdapterError(
    'network',
    { code: networkCode, message: e.message },
    { cause: err },
  );
}

export interface ReadClientContextOpts {
  clientId: string;
  logger?: SheetsClientLogger;
  pipeline?: string;
}

export async function readClientContext(opts: ReadClientContextOpts): Promise<ClientContext> {
  const baseLogger = (opts.logger ?? rootLogger) as SheetsClientLogger;
  const pipeline = opts.pipeline ?? 'F1';
  const log = baseLogger.child({
    pipeline,
    step: 'sheets.read',
    clientId: opts.clientId,
  });
  const sheetId = resolveSheetId(opts.clientId);

  const startMs = Date.now();
  let status: 'ok' | 'error' = 'error';
  let sheetCounts: { stakeholders: number; okrs: number; f5Metrics: number } | undefined;

  try {
    const sheets = await getSheetsClient();
    const response = await withRetry(
      () =>
        sheets.spreadsheets.values.batchGet({
          spreadsheetId: sheetId,
          ranges: [...SHEET_RANGES],
        }),
      {
        maxRetries: 3,
        backoffMs: [1000, 3000, 9000],
        shouldRetry: shouldRetrySheets,
        logger: log,
      },
    );

    const valueRanges = response.data.valueRanges ?? [];
    if (valueRanges.length !== SHEET_RANGES.length) {
      throw new SheetsAdapterError('network', {
        reason: 'unexpected_value_ranges_length',
        expected: SHEET_RANGES.length,
        actual: valueRanges.length,
      });
    }

    const stakeholders = parseStakeholders(valueRanges[0]?.values ?? []);
    const okrs = parseOkrs(valueRanges[1]?.values ?? []);
    const f5Metrics = parseF5Metrics(valueRanges[2]?.values ?? [], log);

    let context: ClientContext;
    try {
      context = ClientContextSchema.parse({
        clientId: opts.clientId,
        stakeholders,
        okrs,
        f5Metrics,
        readAt: new Date().toISOString(),
      });
    } catch (err) {
      if (err instanceof ZodError) {
        throw new SheetsAdapterError(
          'invalid_value',
          { validationErrors: err.issues },
          { cause: err },
        );
      }
      throw err;
    }

    sheetCounts = {
      stakeholders: context.stakeholders.length,
      okrs: context.okrs.length,
      f5Metrics: context.f5Metrics.length,
    };
    status = 'ok';
    return context;
  } catch (err) {
    if (err instanceof TranscriptConfigError) {
      alertOps({
        pipeline,
        step: 'sheets.read',
        clientId: opts.clientId,
        error: err,
        context: { sheetId, ranges: [...SHEET_RANGES], code: err.code },
      });
      throw err;
    }

    const adapterError =
      err instanceof SheetsAdapterError ? err : mapGoogleApiError(err, sheetId);

    if (
      adapterError.code === 'header_missing' ||
      adapterError.code === 'invalid_value' ||
      adapterError.code === 'auth' ||
      adapterError.code === 'sheet_not_found' ||
      adapterError.code === 'rate_limited' ||
      adapterError.code === 'network'
    ) {
      alertOps({
        pipeline,
        step: 'sheets.read',
        clientId: opts.clientId,
        error: adapterError,
        context: { sheetId, ranges: [...SHEET_RANGES], code: adapterError.code },
      });
    }
    throw adapterError;
  } finally {
    const durationMs = Date.now() - startMs;
    const logPayload = {
      step: 'sheets.batchGet',
      durationMs,
      sheetId,
      ranges: [...SHEET_RANGES],
      status,
      ...(sheetCounts ? { sheet_counts: sheetCounts } : {}),
    };
    if (durationMs > SHEETS_LATENCY_WARN_MS) {
      log.warn(logPayload, 'Sheets latency exceeded 2s threshold');
    } else {
      log.info(logPayload, 'sheets batchGet complete');
    }
  }
}

function parseStakeholders(values: string[][]): unknown[] {
  if (values.length === 0) {
    throw new SheetsAdapterError('sheet_not_found', { sheet: '_stakeholder_map' });
  }
  const rows = parseSheetRange(values, '_stakeholder_map', EXPECTED_HEADERS.stakeholderMap);
  try {
    return StakeholderSchema.array().parse(rows);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new SheetsAdapterError(
        'invalid_value',
        { sheet: '_stakeholder_map', validationErrors: err.issues },
        { cause: err },
      );
    }
    throw err;
  }
}

function parseOkrs(values: string[][]): unknown[] {
  if (values.length === 0) {
    throw new SheetsAdapterError('sheet_not_found', { sheet: '_okr' });
  }
  const rows = parseSheetRange(values, '_okr', EXPECTED_HEADERS.okr);
  try {
    return OkrKrSchema.array().parse(rows);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new SheetsAdapterError(
        'invalid_value',
        { sheet: '_okr', validationErrors: err.issues },
        { cause: err },
      );
    }
    throw err;
  }
}

function parseF5Metrics(
  values: string[][],
  log: Pick<Logger, 'warn'>,
): unknown[] {
  if (values.length === 0) {
    throw new SheetsAdapterError('sheet_not_found', { sheet: '_f5_metrics' });
  }
  const rows = parseSheetRange(values, '_f5_metrics', EXPECTED_HEADERS.f5Metrics);
  if (rows.length === 0) {
    log.warn(
      { step: 'sheets.batchGet', sheet: '_f5_metrics', empty: true },
      '_f5_metrics is empty (header-only)',
    );
    return [];
  }
  const enriched = rows.map((row) => {
    const ranges = parseF5Ranges(row.ranges ?? '');
    return { ...row, ranges };
  });
  try {
    return F5MetricSchema.array().parse(enriched);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new SheetsAdapterError(
        'invalid_value',
        { sheet: '_f5_metrics', validationErrors: err.issues },
        { cause: err },
      );
    }
    throw err;
  }
}
