import { describe, expect, it } from 'vitest';
import type { sheets_v4, drive_v3 } from 'googleapis';
import {
  createClientSpreadsheet,
  mapOkrRows,
  mapStakeholderRows,
  mapHypothesisRows,
  alignRowsToHeader,
  colLetter,
} from './f0-sheets.js';
import { F0SheetsError } from './errors.js';
import type { F0FullExtraction } from './types.js';

const OKR_HEADER = [
  'kr_number', 'short_name', 'key_result', 'owner', 'owner_position',
  'current_status', 'target', 'progress', 'deadline', 'okr_group', 'quarter',
];
const STAKEHOLDER_HEADER = [
  'full_name', 'speaker_name', 'department', 'role',
  'bsc_category', 'responsibility_areas', 'interests', 'notes',
];
const HYPO_HEADER = ['statement', 'if_then_because', 'metric', 'department', 'synthesized'];

function extraction(overrides: Partial<F0FullExtraction> = {}): F0FullExtraction {
  return {
    document_type: 'strategy',
    company: 'GeOnline',
    objectives: [
      {
        title: 'Рост выручки',
        krs: [
          { formulation: 'Подписчики с 15 000 до 50 000', base: '15 000', target: '50 000', owner: 'Мақсат', deadline: '2026' },
          { formulation: 'EBITDA до 15%', base: '9%', target: '15%', owner: 'Дамир', deadline: 'Q4' },
        ],
      },
    ],
    hypotheses: [
      { statement: 'Лидмагниты повышают доходимость', ifThenBecause: 'ЕСЛИ…ТО…', metric: 'доходимость, %', department: 'Маркетинг', synthesized: false },
      { statement: 'B2G пилот', ifThenBecause: null, metric: 'кол-во сделок', department: 'Продажи', synthesized: true },
    ],
    participants: [
      { name: 'Дамир', role: 'CEO', department: 'Управление', contact: '@damir' },
      { name: 'Жанель', role: 'РОП', department: null, contact: null },
    ],
    unrecognized: [],
    ...overrides,
  };
}

// === Моки Google-клиентов ===

interface MockCalls {
  copy: unknown[];
  permissions: unknown[];
  getSheet: number;
  addSheet: unknown[];
  headerUpdate: unknown[];
  batchClear: unknown[];
  valuesBatchUpdate: sheets_v4.Schema$BatchUpdateValuesRequest[];
}

function makeSheets(opts: { titles: string[]; headers: Record<string, string[]>; failGet?: unknown }) {
  const calls: Pick<MockCalls, 'getSheet' | 'addSheet' | 'headerUpdate' | 'batchClear' | 'valuesBatchUpdate'> = {
    getSheet: 0, addSheet: [], headerUpdate: [], batchClear: [], valuesBatchUpdate: [],
  };
  const client = {
    spreadsheets: {
      get: async () => {
        calls.getSheet++;
        if (opts.failGet) throw opts.failGet;
        return { data: { sheets: opts.titles.map((t, i) => ({ properties: { title: t, sheetId: i } })) } };
      },
      batchUpdate: async (req: unknown) => { calls.addSheet.push(req); return {}; },
      values: {
        update: async (req: unknown) => { calls.headerUpdate.push(req); return {}; },
        batchGet: async (req: { ranges: string[] }) => {
          const valueRanges = req.ranges.map((r) => {
            const title = r.split('!')[0]!.replace(/'/g, '');
            const h = opts.headers[title];
            return h ? { values: [h] } : {};
          });
          return { data: { valueRanges } };
        },
        batchClear: async (req: unknown) => { calls.batchClear.push(req); return {}; },
        batchUpdate: async (req: { requestBody: sheets_v4.Schema$BatchUpdateValuesRequest }) => {
          calls.valuesBatchUpdate.push(req.requestBody);
          return {};
        },
      },
    },
  };
  return { client: client as unknown as sheets_v4.Sheets, calls };
}

function makeDrive(opts: { copyId?: string; failCopy?: unknown; failPerm?: unknown } = {}) {
  const calls = { copy: [] as unknown[], permissions: [] as unknown[] };
  const client = {
    files: {
      copy: async (req: unknown) => {
        calls.copy.push(req);
        if (opts.failCopy) throw opts.failCopy;
        return { data: { id: opts.copyId ?? 'new-sheet-id' } };
      },
    },
    permissions: {
      create: async (req: unknown) => {
        calls.permissions.push(req);
        if (opts.failPerm) throw opts.failPerm;
        return {};
      },
    },
  };
  return { client: client as unknown as drive_v3.Drive, calls };
}

const allTitles = ['Панель OKR', 'Банк гипотез', 'Лог встреч', '_okr', '_stakeholder_map', '_hypotheses', '_ops_logs'];
const allHeaders = { _okr: OKR_HEADER, _stakeholder_map: STAKEHOLDER_HEADER, _hypotheses: HYPO_HEADER };

function findRange(req: sheets_v4.Schema$BatchUpdateValuesRequest, prefix: string): string[][] | undefined {
  return req.data?.find((d) => d.range?.startsWith(prefix))?.values as string[][] | undefined;
}

// === Чистые мапперы ===

describe('mapOkrRows', () => {
  it('нумерует KR, база → current_status, цель → target, owner заполнен', () => {
    const rows = mapOkrRows(extraction());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kr_number: 'KR-1.1', key_result: 'Подписчики с 15 000 до 50 000',
      owner: 'Мақсат', current_status: '15 000', target: '50 000', okr_group: 'Рост выручки',
    });
    expect(rows[1]!.kr_number).toBe('KR-1.2');
    // owner непустой для всех KR (контракт чтения F1: owner min(1))
    expect(rows.every((r) => r.owner.length > 0)).toBe(true);
  });
});

describe('mapStakeholderRows', () => {
  it('department фолбэк на роль/дефис (F1 требует min(1)), контакт → notes', () => {
    const rows = mapStakeholderRows(extraction());
    expect(rows[0]).toMatchObject({ full_name: 'Дамир', speaker_name: 'Дамир', department: 'Управление', notes: 'контакт: @damir' });
    // department = null → фолбэк на роль
    expect(rows[1]!.department).toBe('РОП');
    expect(rows.every((r) => r.department.length > 0)).toBe(true);
  });
});

describe('mapHypothesisRows', () => {
  it('маппит гипотезы, synthesized → «да»/пусто', () => {
    const rows = mapHypothesisRows(extraction());
    expect(rows[0]).toMatchObject({ statement: 'Лидмагниты повышают доходимость', metric: 'доходимость, %', synthesized: '' });
    expect(rows[1]!.synthesized).toBe('да');
  });
});

describe('alignRowsToHeader', () => {
  it('раскладывает по фактическому порядку колонок, неизвестные → пусто', () => {
    const aligned = alignRowsToHeader(['b', 'a', 'z'], [{ a: '1', b: '2' }]);
    expect(aligned).toEqual([['2', '1', '']]);
  });
});

describe('colLetter', () => {
  it('1→A, 26→Z, 27→AA, 52→AZ, 53→BA', () => {
    expect(colLetter(1)).toBe('A');
    expect(colLetter(26)).toBe('Z');
    expect(colLetter(27)).toBe('AA');
    expect(colLetter(52)).toBe('AZ');
    expect(colLetter(53)).toBe('BA');
  });
});

// === Оркестратор ===

describe('createClientSpreadsheet — happy path (AC1/AC2)', () => {
  it('копирует шаблон, пишет данные, выдаёт доступ, возвращает url', async () => {
    const sheets = makeSheets({ titles: allTitles, headers: allHeaders });
    const drive = makeDrive();
    const result = await createClientSpreadsheet({
      extraction: extraction(),
      spreadsheetName: 'Стратегический трекинг v2.0 — GeOnline (2026-07-07)',
      sheetsClientFactory: async () => sheets.client,
      driveClientFactory: async () => drive.client,
    });

    expect(result.spreadsheetId).toBe('new-sheet-id');
    expect(result.spreadsheetUrl).toContain('new-sheet-id');
    expect(result.counts).toEqual({ okr: 2, stakeholders: 2, hypotheses: 2 });
    expect(result.shared).toEqual(['tracker@example.com']);

    // copy из шаблона с нужным именем
    expect(drive.calls.copy).toHaveLength(1);
    expect(drive.calls.copy[0]).toMatchObject({ fileId: 'test-template-id', requestBody: { name: expect.stringContaining('GeOnline') } });
    // доступ трекеру writer
    expect(drive.calls.permissions[0]).toMatchObject({ requestBody: { emailAddress: 'tracker@example.com', role: 'writer', type: 'user' } });
    // очистка перед записью (идемпотентность)
    expect(sheets.calls.batchClear).toHaveLength(1);

    // данные легли в правильные колонки
    const upd = sheets.calls.valuesBatchUpdate[0]!;
    const okr = findRange(upd, '_okr!A2')!;
    expect(okr[0]![0]).toBe('KR-1.1'); // колонка kr_number
    expect(okr[0]![3]).toBe('Мақсат'); // колонка owner
    const stake = findRange(upd, '_stakeholder_map!A2')!;
    expect(stake[1]![2]).toBe('РОП'); // department фолбэк
    const hypo = findRange(upd, '_hypotheses!A2')!;
    expect(hypo[1]![4]).toBe('да'); // synthesized
  });
});

describe('createClientSpreadsheet — идемпотентность (AC3)', () => {
  it('при existingSpreadsheetId не копирует заново (без дублей)', async () => {
    const sheets = makeSheets({ titles: allTitles, headers: allHeaders });
    const drive = makeDrive();
    const result = await createClientSpreadsheet({
      extraction: extraction(),
      spreadsheetName: 'retry',
      existingSpreadsheetId: 'existing-id',
      sheetsClientFactory: async () => sheets.client,
      driveClientFactory: async () => drive.client,
    });
    expect(drive.calls.copy).toHaveLength(0);
    expect(result.spreadsheetId).toBe('existing-id');
  });
});

describe('createClientSpreadsheet — создаёт _hypotheses если его нет в шаблоне', () => {
  it('addSheet + запись заголовка', async () => {
    const titles = allTitles.filter((t) => t !== '_hypotheses');
    const sheets = makeSheets({ titles, headers: allHeaders });
    const drive = makeDrive();
    await createClientSpreadsheet({
      extraction: extraction(),
      spreadsheetName: 'x',
      sheetsClientFactory: async () => sheets.client,
      driveClientFactory: async () => drive.client,
    });
    expect(sheets.calls.addSheet).toHaveLength(1);
    expect(sheets.calls.addSheet[0]).toMatchObject({ requestBody: { requests: [{ addSheet: { properties: { title: '_hypotheses' } } }] } });
    expect(sheets.calls.headerUpdate).toHaveLength(1);
  });
});

describe('createClientSpreadsheet — обработка сбоев (AC: повтор без дублей)', () => {
  it('сбой после копии → F0SheetsError несёт spreadsheetId для retry', async () => {
    // 400 — non-retryable, чтобы не ждать реальный backoff withRetry (13с > таймаут теста).
    const sheets = makeSheets({ titles: allTitles, headers: allHeaders, failGet: { code: 400 } });
    const drive = makeDrive();
    await expect(
      createClientSpreadsheet({
        extraction: extraction(),
        spreadsheetName: 'x',
        sheetsClientFactory: async () => sheets.client,
        driveClientFactory: async () => drive.client,
      }),
    ).rejects.toMatchObject({ name: 'F0SheetsError', code: 'populate_failed', spreadsheetId: 'new-sheet-id' });
  });

  it('сбой копии (таблица не создана) → copy_failed без spreadsheetId', async () => {
    const sheets = makeSheets({ titles: allTitles, headers: allHeaders });
    const drive = makeDrive({ failCopy: { code: 400 } });
    await expect(
      createClientSpreadsheet({
        extraction: extraction(),
        spreadsheetName: 'x',
        sheetsClientFactory: async () => sheets.client,
        driveClientFactory: async () => drive.client,
      }),
    ).rejects.toMatchObject({ name: 'F0SheetsError', code: 'copy_failed' });
  });

  it('нет ожидаемого листа _okr → sheet_missing', async () => {
    const titles = allTitles.filter((t) => t !== '_okr');
    const sheets = makeSheets({ titles, headers: allHeaders });
    const drive = makeDrive();
    await expect(
      createClientSpreadsheet({
        extraction: extraction(),
        spreadsheetName: 'x',
        sheetsClientFactory: async () => sheets.client,
        driveClientFactory: async () => drive.client,
      }),
    ).rejects.toMatchObject({ code: 'sheet_missing' });
  });

  it('нет обязательной колонки owner → header_missing', async () => {
    const badHeaders = { ...allHeaders, _okr: OKR_HEADER.filter((h) => h !== 'owner') };
    const sheets = makeSheets({ titles: allTitles, headers: badHeaders });
    const drive = makeDrive();
    await expect(
      createClientSpreadsheet({
        extraction: extraction(),
        spreadsheetName: 'x',
        sheetsClientFactory: async () => sheets.client,
        driveClientFactory: async () => drive.client,
      }),
    ).rejects.toMatchObject({ code: 'header_missing' });
  });

  it('сбой шаринга → share_failed со spreadsheetId', async () => {
    const sheets = makeSheets({ titles: allTitles, headers: allHeaders });
    const drive = makeDrive({ failPerm: { code: 403 } });
    await expect(
      createClientSpreadsheet({
        extraction: extraction(),
        spreadsheetName: 'x',
        sheetsClientFactory: async () => sheets.client,
        driveClientFactory: async () => drive.client,
      }),
    ).rejects.toMatchObject({ name: 'F0SheetsError', code: 'auth', spreadsheetId: 'new-sheet-id' });
  });
});

describe('F0SheetsError', () => {
  it('несёт код и spreadsheetId из контекста', () => {
    const err = new F0SheetsError('populate_failed', { spreadsheetId: 'abc' });
    expect(err.code).toBe('populate_failed');
    expect(err.spreadsheetId).toBe('abc');
  });
});
