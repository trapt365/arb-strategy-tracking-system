import { describe, expect, it, vi, afterEach } from 'vitest';
import type { sheets_v4, drive_v3 } from 'googleapis';
import {
  createClientSpreadsheet,
  mapOkrRows,
  mapStakeholderRows,
  mapHypothesisRows,
  mapMetaRows,
  uniqueOwners,
  alignRowsToHeader,
  colLetter,
} from './f0-sheets.js';
import { F0SheetsError } from './errors.js';
import type { F0FullExtraction, ClientTop } from './types.js';

const OKR_HEADER = [
  'kr_number', 'short_name', 'key_result', 'owner', 'owner_position',
  'current_status', 'target', 'progress', 'deadline', 'okr_group', 'quarter',
];
const STAKEHOLDER_HEADER = [
  'full_name', 'speaker_name', 'department', 'role',
  'bsc_category', 'responsibility_areas', 'interests', 'telegram', 'notes',
];
const HYPO_HEADER = [
  'statement', 'if_then_because', 'metric', 'department', 'synthesized',
  'okr_link', 'owner', 'deadline', 'status',
];
const META_HEADER = ['key', 'value'];

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
      // Story 8.1: duplicateSheet возвращает свойства созданного листа (нужно для показа).
      batchUpdate: async (req: { requestBody?: sheets_v4.Schema$BatchUpdateSpreadsheetRequest }) => {
        calls.addSheet.push(req);
        const requests = req.requestBody?.requests ?? [];
        const replies = requests.map((r, i) =>
          r.duplicateSheet
            ? { duplicateSheet: { properties: { sheetId: 100 + i, title: r.duplicateSheet.newSheetName } } }
            : {},
        );
        return { data: { replies } };
      },
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

// Шаблон v2.0 (story 8.1): формульные панели + скрытый эталон топа + ⚙️-данные с _meta.
const allTitles = [
  '📊 Все OKR', '🧪 Банк гипотез', '📅 Лог встреч', '👤 Шаблон топа',
  '_meta', '_okr', '_stakeholder_map', '_hypotheses', '_f5_metrics', '_ops_logs',
];
const allHeaders = {
  _okr: OKR_HEADER, _stakeholder_map: STAKEHOLDER_HEADER, _hypotheses: HYPO_HEADER, _meta: META_HEADER,
};
// Legacy-шаблон 7.4 (до story 8.1): без _meta, без эталона топа, узкие схемы.
const legacyTitles = ['Панель OKR', 'Банк гипотез', 'Лог встреч', '_okr', '_stakeholder_map', '_hypotheses', '_ops_logs'];
const legacyHeaders = {
  _okr: OKR_HEADER,
  _stakeholder_map: STAKEHOLDER_HEADER.filter((h) => h !== 'telegram'),
  _hypotheses: HYPO_HEADER.slice(0, 5),
};

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
  it('department фолбэк на роль/дефис (F1 требует min(1)), контакт → telegram + notes', () => {
    const rows = mapStakeholderRows(extraction());
    expect(rows[0]).toMatchObject({
      full_name: 'Дамир', speaker_name: 'Дамир', department: 'Управление',
      telegram: '@damir', notes: 'контакт: @damir',
    });
    // department = null → фолбэк на роль; контакта нет → telegram пуст
    expect(rows[1]).toMatchObject({ department: 'РОП', telegram: '', notes: '' });
    expect(rows.every((r) => r.department.length > 0)).toBe(true);
  });
});

describe('mapHypothesisRows', () => {
  it('маппит гипотезы, synthesized → «да»/пусто; новые колонки 8.1 пустые (инвариант 3)', () => {
    const rows = mapHypothesisRows(extraction());
    expect(rows[0]).toMatchObject({ statement: 'Лидмагниты повышают доходимость', metric: 'доходимость, %', synthesized: '' });
    expect(rows[1]!.synthesized).toBe('да');
    // F0 не извлекает связь с OKR/ответственного/срок/статус — пишет пусто, трекер дозаполняет
    expect(rows[0]).toMatchObject({ okr_link: '', owner: '', deadline: '', status: '' });
  });
});

describe('mapMetaRows (story 8.1)', () => {
  it('key/value: company из extraction, остальное из meta-опций', () => {
    const rows = mapMetaRows(extraction(), { onboardingDate: '2026-07-08', tracker: 'Азиза' });
    expect(rows).toEqual([
      { key: 'company', value: 'GeOnline' },
      { key: 'period', value: '' },
      { key: 'onboarding_date', value: '2026-07-08' },
      { key: 'tracker', value: 'Азиза' },
    ]);
  });

  it('company null → пусто, meta не передан → все значения пустые', () => {
    const rows = mapMetaRows(extraction({ company: null }));
    expect(rows.every((r) => r.value === '')).toBe(true);
  });
});

describe('uniqueOwners (story 8.1)', () => {
  it('уникальные владельцы KR в порядке появления, пустые отбрасываются', () => {
    const owners = uniqueOwners([
      { owner: 'Дамир' }, { owner: 'Мақсат' }, { owner: 'Дамир' }, { owner: '  ' }, { owner: '' },
    ]);
    expect(owners).toEqual(['Дамир', 'Мақсат']);
  });

  it('story 9.2: «🔴 Имя» фильтруется — несовпавшие не получают вкладку', () => {
    const owners = uniqueOwners([
      { owner: 'Дамир Сайлов' },
      { owner: '🔴 Д. Сайлов' },
      { owner: 'Азиза Асланова' },
      { owner: '🔴 Неизвестный' },
    ]);
    expect(owners).toEqual(['Дамир Сайлов', 'Азиза Асланова']);
  });
});

// === story 11.2: null owner sentinel ===

describe('mapOkrRows (story 11.2: null owner)', () => {
  it('null owner без tops → owner === «—»', () => {
    const ext = extraction({
      objectives: [{
        title: 'Рост',
        krs: [{ formulation: 'KR1', base: '0', target: '100', owner: null, deadline: null }],
      }],
    });
    const rows = mapOkrRows(ext);
    expect(rows[0]!.owner).toBe('—');
  });

  it('null owner с непустым tops → owner === «—» (не «🔴 —»)', () => {
    const ext = extraction({
      objectives: [{
        title: 'Рост',
        krs: [{ formulation: 'KR1', base: '0', target: '100', owner: null, deadline: null }],
      }],
    });
    const tops: ClientTop[] = [
      { name: 'Дамир Сайлов', title: 'CEO', authority: null, area: 'Финансы' },
    ];
    const rows = mapOkrRows(ext, tops);
    expect(rows[0]!.owner).toBe('—');
  });
});

describe('uniqueOwners (story 11.2: sentinel «—»)', () => {
  it('«—» фильтруется — персональный лист не создаётся', () => {
    const owners = uniqueOwners([{ owner: '—' }]);
    expect(owners).toEqual([]);
  });
});

// === story 9.2: grounding через tops ===

const profileTops: ClientTop[] = [
  { name: 'Дамир Сайлов', title: 'CEO', authority: null, area: 'Финансы' },
  { name: 'Азиза Асланова', title: 'Трекер', authority: null, area: 'Стратегия' },
];

describe('mapOkrRows (story 9.2: grounding с tops)', () => {
  it('совпадение → канонический из профиля; несовпадение → «🔴 <extracted>»', () => {
    const ext = extraction({
      objectives: [{
        title: 'Рост',
        krs: [
          { formulation: 'KR1', base: '0', target: '100', owner: 'дамир сайлов', deadline: null },
          { formulation: 'KR2', base: '0', target: '50', owner: 'Д. Сайлов', deadline: null },
        ],
      }],
    });
    const rows = mapOkrRows(ext, profileTops);
    expect(rows[0]!.owner).toBe('Дамир Сайлов');
    expect(rows[1]!.owner).toBe('🔴 Д. Сайлов');
  });

  it('без tops → owner без изменений (старые сессии)', () => {
    const rows = mapOkrRows(extraction());
    expect(rows[0]!.owner).toBe('Мақсат');
    expect(rows[1]!.owner).toBe('Дамир');
  });
});

describe('mapStakeholderRows (story 9.2: grounding с tops)', () => {
  it('профильные топы первыми; extraction-участников без совпадения — после', () => {
    const rows = mapStakeholderRows(extraction(), profileTops);
    const names = rows.map((r) => r.full_name);
    // Профильные топы первыми
    expect(names[0]).toBe('Дамир Сайлов');
    expect(names[1]).toBe('Азиза Асланова');
    // «Жанель» из extraction не в профиле — добавляется после
    expect(names).toContain('Жанель');
  });

  it('fuzzy-merge (ревью эпика 9): «Дамир» ⊂ «Дамир Сайлов» → одна строка, контакт сохранён', () => {
    // extraction().participants: Дамир (contact @damir), Жанель; профиль: Дамир Сайлов, Азиза Асланова.
    // Fuzzy: «Дамир» подмножество «Дамир Сайлов» → сливаются; контакт из extraction переживает merge.
    const rows = mapStakeholderRows(extraction(), profileTops);
    const names = rows.map((r) => r.full_name);
    expect(names).toContain('Дамир Сайлов');
    expect(names).not.toContain('Дамир'); // слился в профильного топа, не задваивается
    const damir = rows.find((r) => r.full_name === 'Дамир Сайлов');
    expect(damir?.telegram).toBe('@damir'); // #6: собранный контакт не затёрт
  });

  it('без tops → participants без изменений (старые сессии)', () => {
    const rows = mapStakeholderRows(extraction());
    expect(rows).toHaveLength(2);
    expect(rows[0]!.full_name).toBe('Дамир');
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
    expect(result.counts).toEqual({ okr: 2, stakeholders: 2, hypotheses: 2, personalSheets: 2 });
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
    expect(stake[0]![7]).toBe('@damir'); // telegram (story 8.1)
    const hypo = findRange(upd, '_hypotheses!A2')!;
    expect(hypo[1]![4]).toBe('да'); // synthesized
    // _meta заполнен шапкой клиента (story 8.1)
    const meta = findRange(upd, '_meta!A2')!;
    expect(meta[0]).toEqual(['company', 'GeOnline']);
  });
});

describe('createClientSpreadsheet — персональные листы топов (story 8.1, Fix B)', () => {
  it('duplicateSheet по уникальным владельцам KR, показ листа, $B$1 = имя', async () => {
    const sheets = makeSheets({ titles: allTitles, headers: allHeaders });
    const drive = makeDrive();
    const result = await createClientSpreadsheet({
      extraction: extraction(),
      spreadsheetName: 'x',
      sheetsClientFactory: async () => sheets.client,
      driveClientFactory: async () => drive.client,
    });
    expect(result.counts.personalSheets).toBe(2);

    // 1-й batchUpdate — duplicateSheet эталона (sheetId эталона = 3 в allTitles)
    const dupReq = sheets.calls.addSheet[0] as { requestBody: sheets_v4.Schema$BatchUpdateSpreadsheetRequest };
    expect(dupReq.requestBody.requests).toEqual([
      { duplicateSheet: { sourceSheetId: 3, newSheetName: '👤 Мақсат' } },
      { duplicateSheet: { sourceSheetId: 3, newSheetName: '👤 Дамир' } },
    ]);
    // 2-й batchUpdate — снятие hidden с созданных листов (копия скрытого эталона скрыта)
    const showReq = sheets.calls.addSheet[1] as { requestBody: sheets_v4.Schema$BatchUpdateSpreadsheetRequest };
    expect(showReq.requestBody.requests).toEqual([
      { updateSheetProperties: { properties: { sheetId: 100, hidden: false }, fields: 'hidden' } },
      { updateSheetProperties: { properties: { sheetId: 101, hidden: false }, fields: 'hidden' } },
    ]);
    // B1 = имя топа — параметр FILTER-формул
    const b1 = sheets.calls.valuesBatchUpdate[1]!;
    expect(b1.data).toEqual([
      { range: "'👤 Мақсат'!B1", values: [['Мақсат']] },
      { range: "'👤 Дамир'!B1", values: [['Дамир']] },
    ]);
  });

  it('идемпотентность: существующий лист «👤 {Имя}» не дублируется при retry', async () => {
    const sheets = makeSheets({ titles: [...allTitles, '👤 Дамир'], headers: allHeaders });
    const drive = makeDrive();
    const result = await createClientSpreadsheet({
      extraction: extraction(),
      spreadsheetName: 'x',
      existingSpreadsheetId: 'existing-id',
      sheetsClientFactory: async () => sheets.client,
      driveClientFactory: async () => drive.client,
    });
    expect(result.counts.personalSheets).toBe(2);
    const dupReq = sheets.calls.addSheet[0] as { requestBody: sheets_v4.Schema$BatchUpdateSpreadsheetRequest };
    expect(dupReq.requestBody.requests).toEqual([
      { duplicateSheet: { sourceSheetId: 3, newSheetName: '👤 Мақсат' } },
    ]);
  });

  it('legacy-шаблон без эталона: личные листы тихо пропускаются (обратная совместимость 7.4)', async () => {
    const sheets = makeSheets({ titles: legacyTitles, headers: legacyHeaders });
    const drive = makeDrive();
    const result = await createClientSpreadsheet({
      extraction: extraction(),
      spreadsheetName: 'x',
      sheetsClientFactory: async () => sheets.client,
      driveClientFactory: async () => drive.client,
    });
    expect(result.counts.personalSheets).toBe(0);
    // единственный batchUpdate — ensure _meta (в legacy-шаблоне его нет); duplicateSheet нет
    const dupRequests = sheets.calls.addSheet
      .flatMap((r) => (r as { requestBody?: sheets_v4.Schema$BatchUpdateSpreadsheetRequest }).requestBody?.requests ?? [])
      .filter((r) => r.duplicateSheet);
    expect(dupRequests).toHaveLength(0);
    expect(sheets.calls.addSheet[0]).toMatchObject({
      requestBody: { requests: [{ addSheet: { properties: { title: '_meta' } } }] },
    });
    // узкая legacy-схема: telegram-колонки нет → alignRowsToHeader её отбрасывает, контакт в notes
    const upd = sheets.calls.valuesBatchUpdate[0]!;
    const stake = findRange(upd, '_stakeholder_map!A2')!;
    expect(stake[0]).toHaveLength(8);
    expect(stake[0]![7]).toBe('контакт: @damir');
  });
});

describe('createClientSpreadsheet — story 9.2 grounding (AC1)', () => {
  it('profile-топ без KR получает личный лист; 🔴-owner не получает', async () => {
    // extraction: владелец KR «А. Асланова» не совпадает с профилем
    const ext = extraction({
      objectives: [{
        title: 'Рост',
        krs: [{ formulation: 'KR1', base: '0', target: '100', owner: 'А. Асланова', deadline: null }],
      }],
    });
    const azizaTops = [{ name: 'Азиза Асланова', title: 'Трекер', authority: null, area: 'HR' }];
    const sheets = makeSheets({ titles: allTitles, headers: allHeaders });
    const drive = makeDrive();

    const result = await createClientSpreadsheet({
      extraction: ext,
      spreadsheetName: 'x',
      profile: { tops: azizaTops },
      sheetsClientFactory: async () => sheets.client,
      driveClientFactory: async () => drive.client,
    });

    // Личный лист создан для первого слова канонического имени из профиля, не для '🔴 А. Асланова'
    expect(result.counts.personalSheets).toBe(1);
    const dupReq = sheets.calls.addSheet[0] as { requestBody: sheets_v4.Schema$BatchUpdateSpreadsheetRequest };
    const newNames = (dupReq.requestBody.requests ?? [])
      .map((r) => r.duplicateSheet?.newSheetName)
      .filter(Boolean);
    // Story 10.7: лист называется по первому слову имени
    expect(newNames).toContain('👤 Азиза');
    expect(newNames).not.toContain('👤 Азиза Асланова');
    expect(newNames.some((n) => n?.startsWith('👤 🔴'))).toBe(false);
  });
});

describe('createClientSpreadsheet — Story 10.7: имена листов сокращаются до первого слова', () => {
  it('owner «Иван Петров» → лист называется «👤 Иван»', async () => {
    const ext = extraction({
      objectives: [{
        title: 'Рост',
        krs: [{ formulation: 'KR1', base: '0', target: '100', owner: 'Иван Петров', deadline: null }],
      }],
    });
    const sheets = makeSheets({ titles: allTitles, headers: allHeaders });
    const drive = makeDrive();
    const result = await createClientSpreadsheet({
      extraction: ext,
      spreadsheetName: 'x',
      sheetsClientFactory: async () => sheets.client,
      driveClientFactory: async () => drive.client,
    });
    expect(result.counts.personalSheets).toBe(1);
    const dupReq = sheets.calls.addSheet[0] as { requestBody: sheets_v4.Schema$BatchUpdateSpreadsheetRequest };
    const newNames = (dupReq.requestBody.requests ?? [])
      .map((r) => r.duplicateSheet?.newSheetName)
      .filter(Boolean);
    expect(newNames).toContain('👤 Иван');
    expect(newNames).not.toContain('👤 Иван Петров');
  });

  it('однословный owner «Иван» → лист называется «👤 Иван» (без изменений)', async () => {
    const ext = extraction({
      objectives: [{
        title: 'Рост',
        krs: [{ formulation: 'KR1', base: '0', target: '100', owner: 'Иван', deadline: null }],
      }],
    });
    const sheets = makeSheets({ titles: allTitles, headers: allHeaders });
    const drive = makeDrive();
    await createClientSpreadsheet({
      extraction: ext,
      spreadsheetName: 'x',
      sheetsClientFactory: async () => sheets.client,
      driveClientFactory: async () => drive.client,
    });
    const dupReq = sheets.calls.addSheet[0] as { requestBody: sheets_v4.Schema$BatchUpdateSpreadsheetRequest };
    const newNames = (dupReq.requestBody.requests ?? [])
      .map((r) => r.duplicateSheet?.newSheetName)
      .filter(Boolean);
    expect(newNames).toContain('👤 Иван');
  });

  it('идемпотентность: «👤 Иван» уже существует → owner «Иван Петров» не создаёт дубль', async () => {
    const ext = extraction({
      objectives: [{
        title: 'Рост',
        krs: [{ formulation: 'KR1', base: '0', target: '100', owner: 'Иван Петров', deadline: null }],
      }],
    });
    // Лист «👤 Иван» уже создан при предыдущем прогоне
    const sheets = makeSheets({ titles: [...allTitles, '👤 Иван'], headers: allHeaders });
    const drive = makeDrive();
    const result = await createClientSpreadsheet({
      extraction: ext,
      spreadsheetName: 'x',
      existingSpreadsheetId: 'existing-id',
      sheetsClientFactory: async () => sheets.client,
      driveClientFactory: async () => drive.client,
    });
    // ensurePersonalSheets returns owners.length (1 owner handled), no new sheet created
    expect(result.counts.personalSheets).toBe(1);
    // Никаких duplicateSheet-запросов не должно быть
    const dupReq = sheets.calls.addSheet[0] as { requestBody: sheets_v4.Schema$BatchUpdateSpreadsheetRequest } | undefined;
    const newNames = (dupReq?.requestBody.requests ?? [])
      .map((r) => r.duplicateSheet?.newSheetName)
      .filter(Boolean);
    expect(newNames).not.toContain('👤 Иван');
    expect(newNames).not.toContain('👤 Иван Петров');
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
  it('addSheet + запись заголовка (расширенного, story 8.1)', async () => {
    const titles = allTitles.filter((t) => t !== '_hypotheses');
    const sheets = makeSheets({ titles, headers: allHeaders });
    const drive = makeDrive();
    await createClientSpreadsheet({
      extraction: extraction(),
      spreadsheetName: 'x',
      sheetsClientFactory: async () => sheets.client,
      driveClientFactory: async () => drive.client,
    });
    expect(sheets.calls.addSheet[0]).toMatchObject({ requestBody: { requests: [{ addSheet: { properties: { title: '_hypotheses' } } }] } });
    expect(sheets.calls.headerUpdate).toHaveLength(1);
    expect(sheets.calls.headerUpdate[0]).toMatchObject({ requestBody: { values: [HYPO_HEADER] } });
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

// === story 11.3: SA sharing ===

vi.mock('./utils/google-auth.js', () => ({
  isGoogleOAuthConfigured: vi.fn().mockReturnValue(false),
  loadServiceAccountCredentials: vi.fn().mockResolvedValue({ client_email: '', private_key: '' }),
}));

describe('createClientSpreadsheet — story 11.3: SA sharing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('saEmailFactory возвращает email → permissions[0] — СА writer, shared[0] — SA email', async () => {
    const saEmail = 'sa@test.gserviceaccount.com';
    const sheets = makeSheets({ titles: allTitles, headers: allHeaders });
    const drive = makeDrive();
    const result = await createClientSpreadsheet({
      extraction: extraction(),
      spreadsheetName: 'x',
      sheetsClientFactory: async () => sheets.client,
      driveClientFactory: async () => drive.client,
      saEmailFactory: async () => saEmail,
    });
    expect(drive.calls.permissions).toHaveLength(2);
    expect(drive.calls.permissions[0]).toMatchObject({
      requestBody: { emailAddress: saEmail, role: 'writer', type: 'user' },
    });
    expect(result.shared[0]).toBe(saEmail);
    expect(result.shared[1]).toBe('tracker@example.com');
    expect(result.shared).toHaveLength(2);
  });

  it('saEmailFactory возвращает null → шаринг с СА пропущен, shared — только трекеры', async () => {
    const sheets = makeSheets({ titles: allTitles, headers: allHeaders });
    const drive = makeDrive();
    const result = await createClientSpreadsheet({
      extraction: extraction(),
      spreadsheetName: 'x',
      sheetsClientFactory: async () => sheets.client,
      driveClientFactory: async () => drive.client,
      saEmailFactory: async () => null,
    });
    expect(drive.calls.permissions).toHaveLength(1);
    expect(result.shared).toEqual(['tracker@example.com']);
  });

  it('production-путь: isGoogleOAuthConfigured() = true, saEmailFactory не задан → permissions[0] — client_email из loadServiceAccountCredentials', async () => {
    const { isGoogleOAuthConfigured, loadServiceAccountCredentials } = await import('./utils/google-auth.js');
    vi.mocked(isGoogleOAuthConfigured).mockReturnValue(true);
    vi.mocked(loadServiceAccountCredentials).mockResolvedValue({
      client_email: 'sa@test.gserviceaccount.com',
      private_key: '',
    });

    const sheets = makeSheets({ titles: allTitles, headers: allHeaders });
    const drive = makeDrive();
    const result = await createClientSpreadsheet({
      extraction: extraction(),
      spreadsheetName: 'x',
      sheetsClientFactory: async () => sheets.client,
      driveClientFactory: async () => drive.client,
    });

    expect(drive.calls.permissions[0]).toMatchObject({
      requestBody: { emailAddress: 'sa@test.gserviceaccount.com' },
    });
    expect(result.shared[0]).toBe('sa@test.gserviceaccount.com');
    expect(result.shared[1]).toBe('tracker@example.com');
    expect(result.shared).toHaveLength(2);
  });
});
