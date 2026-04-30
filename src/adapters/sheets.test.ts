import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { batchGetMock } = vi.hoisted(() => ({ batchGetMock: vi.fn() }));

vi.mock('googleapis', () => {
  const sheetsClient = {
    spreadsheets: {
      values: {
        batchGet: batchGetMock,
      },
    },
  };
  class FakeGoogleAuth {}
  return {
    google: {
      auth: {
        GoogleAuth: FakeGoogleAuth,
      },
      sheets: vi.fn(() => sheetsClient),
    },
  };
});

vi.mock('../utils/google-auth.js', () => ({
  loadServiceAccountCredentials: vi.fn().mockResolvedValue({
    client_email: 'svc@example.com',
    private_key: 'KEY',
  }),
}));

vi.mock('../ops.js', () => ({
  alertOps: vi.fn(),
}));

import {
  readClientContext,
  __test_only_snakeToCamel,
  __test_only_parseSheetRange,
  _resetSheetsClientForTest,
} from './sheets.js';
import { SheetsAdapterError, TranscriptConfigError } from '../errors.js';
import { alertOps } from '../ops.js';
import { loadServiceAccountCredentials } from '../utils/google-auth.js';

const stakeholderRows = [
  ['full_name', 'speaker_name', 'department', 'role', 'bsc_category', 'responsibility_areas', 'interests', 'notes'],
  ['Самарханов Дамир', 'Самарханов', 'CEO', '', 'Команда', 'OKR-1, OKR-4, OKR-11', '', ''],
  ['Жүсіпбек Мерей', 'Жүсіпбек', 'CFO', '', 'Финансы', 'OKR-7', '', ''],
];

const okrRows = [
  ['kr_number', 'short_name', 'key_result', 'owner', 'owner_position', 'current_status', 'target', 'progress', 'deadline', 'okr_group', 'quarter'],
  ['1.1', '6 ключевых ролей', '6 ключевых ролей закрыты', 'Самарханов', 'CEO', '4 из 6', '6 из 6', '', 'май 2026', 'OKR-1', 'Q2 2026'],
];

const f5HeaderOnly = [
  ['department', 'metric_name', 'metric_type', 'unit', 'source', 'owner_speaker_name', 'ranges', 'update_frequency', 'risk_notes', 'notes'],
];

const f5WithData = [
  ...f5HeaderOnly,
  ['CEO', 'NPS', 'leading', '%', 'CRM', 'Самарханов', '["< 15%", "15-20%", "20-25%", "25%+"]', 'weekly', '', ''],
];

function mockBatchGetOk(values: unknown[][][]) {
  batchGetMock.mockResolvedValueOnce({
    data: {
      valueRanges: values.map((v) => ({ values: v })),
    },
  });
}

beforeEach(() => {
  batchGetMock.mockReset();
  vi.mocked(alertOps).mockReset();
  _resetSheetsClientForTest();
});

afterEach(() => {
  _resetSheetsClientForTest();
});

describe('snakeToCamel', () => {
  it('converts snake_case to camelCase', () => {
    expect(__test_only_snakeToCamel('owner_position')).toBe('ownerPosition');
    expect(__test_only_snakeToCamel('kr_number')).toBe('krNumber');
    expect(__test_only_snakeToCamel('foo_bar_baz')).toBe('fooBarBaz');
  });

  it('is identity on words without underscores', () => {
    expect(__test_only_snakeToCamel('foo')).toBe('foo');
    expect(__test_only_snakeToCamel('')).toBe('');
  });
});

describe('parseSheetRange', () => {
  it('parses snake_case headers into camelCase keyed records', () => {
    const rows = __test_only_parseSheetRange(
      [
        ['full_name', 'speaker_name'],
        ['Иван', 'Иванов'],
      ],
      '_test',
      ['full_name', 'speaker_name'],
    );
    expect(rows).toEqual([{ fullName: 'Иван', speakerName: 'Иванов' }]);
  });

  it('throws header_missing when expected header is absent', () => {
    expect(() =>
      __test_only_parseSheetRange(
        [['full_name', 'department']],
        '_stakeholder_map',
        ['full_name', 'speaker_name', 'department'],
      ),
    ).toThrow(SheetsAdapterError);
    try {
      __test_only_parseSheetRange(
        [['full_name', 'department']],
        '_stakeholder_map',
        ['full_name', 'speaker_name', 'department'],
      );
    } catch (e) {
      const err = e as SheetsAdapterError;
      expect(err.code).toBe('header_missing');
      expect((err.context.missingHeaders as string[])).toContain('speaker_name');
    }
  });

  it('treats trailing missing cells as empty strings', () => {
    const rows = __test_only_parseSheetRange(
      [
        ['full_name', 'speaker_name', 'notes'],
        ['Иван', 'Иванов'],
      ],
      '_test',
      ['full_name', 'speaker_name', 'notes'],
    );
    expect(rows[0]).toEqual({ fullName: 'Иван', speakerName: 'Иванов', notes: '' });
  });
});

describe('readClientContext — happy path', () => {
  it('returns ClientContext with stakeholders/okrs/f5Metrics', async () => {
    mockBatchGetOk([stakeholderRows, okrRows, f5WithData]);
    const ctx = await readClientContext({ clientId: 'geonline' });
    expect(ctx.clientId).toBe('geonline');
    expect(ctx.stakeholders).toHaveLength(2);
    expect(ctx.stakeholders[0]?.fullName).toBe('Самарханов Дамир');
    expect(ctx.okrs).toHaveLength(1);
    expect(ctx.okrs[0]?.krNumber).toBe('1.1');
    expect(ctx.okrs[0]?.ownerPosition).toBe('CEO');
    expect(ctx.f5Metrics).toHaveLength(1);
    expect(ctx.f5Metrics[0]?.ranges).toEqual(['< 15%', '15-20%', '20-25%', '25%+']);
    expect(ctx.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('accepts header-only _f5_metrics as empty array', async () => {
    mockBatchGetOk([stakeholderRows, okrRows, f5HeaderOnly]);
    const ctx = await readClientContext({ clientId: 'geonline' });
    expect(ctx.f5Metrics).toEqual([]);
  });
});

describe('readClientContext — F5 ranges parsing', () => {
  it('rejects invalid JSON in ranges with invalid_value', async () => {
    const f5Bad = [
      ...f5HeaderOnly,
      ['CEO', 'NPS', 'leading', '%', 'CRM', 'Самарханов', 'bad-json', 'weekly', '', ''],
    ];
    mockBatchGetOk([stakeholderRows, okrRows, f5Bad]);
    const err = await readClientContext({ clientId: 'geonline' }).catch((e) => e);
    expect(err).toBeInstanceOf(SheetsAdapterError);
    expect((err as SheetsAdapterError).code).toBe('invalid_value');
    expect((err as SheetsAdapterError).context.column).toBe('ranges');
  });

  it('rejects non-array JSON in ranges with invalid_value', async () => {
    const f5Obj = [
      ...f5HeaderOnly,
      ['CEO', 'NPS', 'leading', '%', 'CRM', 'Самарханов', '{"a":"b"}', 'weekly', '', ''],
    ];
    mockBatchGetOk([stakeholderRows, okrRows, f5Obj]);
    const err = await readClientContext({ clientId: 'geonline' }).catch((e) => e);
    expect(err).toBeInstanceOf(SheetsAdapterError);
    expect((err as SheetsAdapterError).code).toBe('invalid_value');
  });
});

describe('readClientContext — error mapping', () => {
  it('maps HTTP 401 to SheetsAdapterError(auth) and calls alertOps', async () => {
    batchGetMock.mockRejectedValueOnce({ response: { status: 401 } });
    const err = await readClientContext({ clientId: 'geonline' }).catch((e) => e);
    expect(err).toBeInstanceOf(SheetsAdapterError);
    expect((err as SheetsAdapterError).code).toBe('auth');
    expect(vi.mocked(alertOps)).toHaveBeenCalledTimes(1);
  });

  it('maps HTTP 403 to auth', async () => {
    batchGetMock.mockRejectedValueOnce({ response: { status: 403 } });
    const err = await readClientContext({ clientId: 'geonline' }).catch((e) => e);
    expect((err as SheetsAdapterError).code).toBe('auth');
  });

  it('maps HTTP 404 to sheet_not_found', async () => {
    batchGetMock.mockRejectedValueOnce({ response: { status: 404 } });
    const err = await readClientContext({ clientId: 'geonline' }).catch((e) => e);
    expect((err as SheetsAdapterError).code).toBe('sheet_not_found');
  });

  it('maps HTTP 5xx to network after retries exhausted', async () => {
    batchGetMock.mockRejectedValue({ response: { status: 503 } });
    const err = await readClientContext({ clientId: 'geonline' }).catch((e) => e);
    expect((err as SheetsAdapterError).code).toBe('network');
    expect(batchGetMock).toHaveBeenCalledTimes(4);
  }, 30000);

  it('rejects unknown clientId with auth error', async () => {
    const err = await readClientContext({ clientId: 'unknown-client' }).catch((e) => e);
    expect(err).toBeInstanceOf(SheetsAdapterError);
    expect((err as SheetsAdapterError).code).toBe('auth');
    expect((err as SheetsAdapterError).context.reason).toBe('unknown_clientId');
  });

  it('throws sheet_not_found when stakeholder range is empty', async () => {
    mockBatchGetOk([[], okrRows, f5HeaderOnly]);
    const err = await readClientContext({ clientId: 'geonline' }).catch((e) => e);
    expect((err as SheetsAdapterError).code).toBe('sheet_not_found');
  });

  it('throws header_missing when stakeholder header is incomplete', async () => {
    const badStakeholders = [
      ['full_name', 'department'],
      ['Иван', 'CEO'],
    ];
    mockBatchGetOk([badStakeholders, okrRows, f5HeaderOnly]);
    const err = await readClientContext({ clientId: 'geonline' }).catch((e) => e);
    expect((err as SheetsAdapterError).code).toBe('header_missing');
    expect(vi.mocked(alertOps)).toHaveBeenCalled();
  });
});

describe('readClientContext — pipeline attribution', () => {
  it('uses pipeline override in alertOps and child logger', async () => {
    batchGetMock.mockRejectedValueOnce({ response: { status: 401 } });
    const childCalls: Array<Record<string, unknown>> = [];
    const fakeLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn((bindings: Record<string, unknown>) => {
        childCalls.push(bindings);
        return {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: vi.fn(),
          child: vi.fn(),
        };
      }),
    };
    await readClientContext({
      clientId: 'geonline',
      pipeline: 'F4',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: fakeLogger as any,
    }).catch(() => undefined);

    expect(childCalls[0]?.pipeline).toBe('F4');
    expect(vi.mocked(alertOps)).toHaveBeenCalledWith(
      expect.objectContaining({ pipeline: 'F4' }),
    );
  });

  it('defaults to F1 when pipeline is not provided', async () => {
    batchGetMock.mockRejectedValueOnce({ response: { status: 401 } });
    await readClientContext({ clientId: 'geonline' }).catch(() => undefined);
    expect(vi.mocked(alertOps)).toHaveBeenCalledWith(
      expect.objectContaining({ pipeline: 'F1' }),
    );
  });
});

describe('readClientContext — config error handling', () => {
  it('re-throws TranscriptConfigError without wrapping it as network', async () => {
    const configErr = new TranscriptConfigError('missing_service_account', {
      path: '/missing.json',
    });
    vi.mocked(loadServiceAccountCredentials).mockRejectedValueOnce(configErr);

    const err = await readClientContext({ clientId: 'geonline' }).catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptConfigError);
    expect(err).not.toBeInstanceOf(SheetsAdapterError);
    expect((err as TranscriptConfigError).code).toBe('missing_service_account');
    expect(vi.mocked(alertOps)).toHaveBeenCalledWith(
      expect.objectContaining({
        error: configErr,
        context: expect.objectContaining({ code: 'missing_service_account' }),
      }),
    );
  });
});

describe('readClientContext — alert context completeness', () => {
  it('alertOps context.ranges is the actual array of A1 ranges, not a count', async () => {
    batchGetMock.mockRejectedValueOnce({ response: { status: 401 } });
    await readClientContext({ clientId: 'geonline' }).catch(() => undefined);

    const call = vi.mocked(alertOps).mock.calls[0]?.[0];
    expect(call?.context?.ranges).toEqual([
      '_stakeholder_map!A1:Z',
      '_okr!A1:Z',
      '_f5_metrics!A1:Z',
    ]);
  });
});

describe('readClientContext — retry behavior', () => {
  it('retries 5xx then succeeds on second attempt', async () => {
    batchGetMock
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({
        data: {
          valueRanges: [
            { values: stakeholderRows },
            { values: okrRows },
            { values: f5HeaderOnly },
          ],
        },
      });
    const ctx = await readClientContext({ clientId: 'geonline' });
    expect(ctx.stakeholders).toHaveLength(2);
    expect(batchGetMock).toHaveBeenCalledTimes(2);
  }, 15000);

  it('does not retry on 401', async () => {
    batchGetMock.mockRejectedValueOnce({ response: { status: 401 } });
    await readClientContext({ clientId: 'geonline' }).catch(() => undefined);
    expect(batchGetMock).toHaveBeenCalledTimes(1);
  });
});
