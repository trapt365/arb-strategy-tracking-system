import { google, type sheets_v4, type drive_v3 } from 'googleapis';
import { config } from './config.js';
import { logger as rootLogger, type Logger } from './logger.js';
import { withRetry } from './utils/retry.js';
import { createSheetsWriteClient } from './adapters/sheets.js';
import { createDriveWriteClient } from './adapters/drive.js';
import { F0SheetsError } from './errors.js';
import type { F0FullExtraction } from './types.js';

export { F0SheetsError } from './errors.js';

// Story 7.4 (WP-39 Ф2): подтверждённый черновик онбординга → Google Sheets клиента.
// Копируем эталонный шаблон «Стратегический трекинг v2.0» (Drive files.copy), пишем
// данные онбординга в машиночитаемые листы (_okr, _stakeholder_map, _hypotheses — тот же
// контракт, что читает F1), выдаём доступ трекеру. Человекочитаемые панели («Панель OKR»,
// «Банк гипотез», «Лог встреч») приходят из шаблона с форматированием/эмодзи-статусами и
// наполняются формулами шаблона поверх машиночитаемых листов (структура — зона Тимура).

// Целевые машиночитаемые листы. Заголовки должны существовать в шаблоне v2.0.
const OKR_SHEET = '_okr';
const STAKEHOLDER_SHEET = '_stakeholder_map';
const HYPOTHESES_SHEET = '_hypotheses';

// Обязательные колонки, без которых запись бессмысленна (защита «пишем не туда»).
const OKR_REQUIRED = ['kr_number', 'key_result', 'owner'] as const;
const STAKEHOLDER_REQUIRED = ['full_name', 'speaker_name', 'department'] as const;

// Заголовок для листа _hypotheses (создаётся, если шаблон его не содержит).
const HYPOTHESES_HEADER = [
  'statement',
  'if_then_because',
  'metric',
  'department',
  'synthesized',
] as const;

type SheetsLogger = Pick<Logger, 'info' | 'warn' | 'error' | 'debug'> & { child: Logger['child'] };
type Row = Record<string, string>;

// === Чистые мапперы: F0FullExtraction → строки машиночитаемых листов ===

export function mapOkrRows(extraction: F0FullExtraction): Row[] {
  const rows: Row[] = [];
  extraction.objectives.forEach((objective, o) => {
    objective.krs.forEach((kr, k) => {
      rows.push({
        kr_number: `KR-${o + 1}.${k + 1}`,
        short_name: '',
        key_result: kr.formulation,
        owner: kr.owner ?? '',
        owner_position: '',
        // На неделе 0 текущее значение = стартовая база «с X».
        current_status: kr.base ?? '',
        target: kr.target ?? '',
        progress: '',
        deadline: kr.deadline ?? '',
        okr_group: objective.title,
        quarter: '',
      });
    });
  });
  return rows;
}

export function mapStakeholderRows(extraction: F0FullExtraction): Row[] {
  return extraction.participants.map((p) => ({
    full_name: p.name,
    // Метка спикера в транскрипте на онбординге неизвестна — засеваем именем (F1 уточнит).
    speaker_name: p.name,
    // department обязателен для чтения F1 (min(1)) — фолбэк на роль/дефис.
    department: p.department ?? p.role ?? '—',
    role: p.role ?? '',
    bsc_category: '',
    responsibility_areas: '',
    interests: '',
    notes: p.contact ? `контакт: ${p.contact}` : '',
  }));
}

export function mapHypothesisRows(extraction: F0FullExtraction): Row[] {
  return extraction.hypotheses.map((h) => ({
    statement: h.statement,
    if_then_because: h.ifThenBecause ?? '',
    metric: h.metric ?? '',
    department: h.department ?? '',
    synthesized: h.synthesized ? 'да' : '',
  }));
}

/**
 * Разложить записи по фактическому порядку колонок листа: для каждого заголовка берём
 * record[header] или '' (толерантно к неизвестным колонкам шаблона и их перестановке).
 */
export function alignRowsToHeader(headerRow: string[], records: Row[]): string[][] {
  const headers = headerRow.map((h) => String(h ?? '').trim());
  return records.map((rec) => headers.map((h) => rec[h] ?? ''));
}

/** Номер колонки (1-based) → буквенное имя A1-нотации: 1→A, 26→Z, 27→AA. */
export function colLetter(n: number): string {
  let s = '';
  let x = Math.max(1, Math.floor(n));
  while (x > 0) {
    const rem = (x - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

// === Google API helpers ===

function statusOf(err: unknown): number | undefined {
  const e = err as { code?: unknown; response?: { status?: number } };
  if (typeof e?.response?.status === 'number') return e.response.status;
  if (typeof e?.code === 'number') return e.code;
  if (typeof e?.code === 'string' && /^\d+$/.test(e.code)) return Number(e.code);
  return undefined;
}

function shouldRetryGoogle(err: unknown): boolean {
  const status = statusOf(err);
  if (typeof status === 'number') {
    if (status === 429) return true;
    return status >= 500 && status < 600;
  }
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string') {
    return ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code);
  }
  const name = (err as { name?: string })?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function mapGoogleError(
  err: unknown,
  fallbackCode: 'copy_failed' | 'populate_failed' | 'share_failed',
  spreadsheetId?: string,
): F0SheetsError {
  if (err instanceof F0SheetsError) return err;
  const status = statusOf(err);
  const message = (err as { message?: string })?.message;
  const ctx = { spreadsheetId, httpStatus: status, message };
  if (status === 401 || status === 403) {
    return new F0SheetsError('auth', ctx, { cause: err });
  }
  if (status === 429) {
    return new F0SheetsError('rate_limited', ctx, { cause: err });
  }
  if (typeof status === 'number' && status >= 500 && status < 600) {
    return new F0SheetsError('network', ctx, { cause: err });
  }
  if (status === undefined && shouldRetryGoogle(err)) {
    return new F0SheetsError('network', ctx, { cause: err });
  }
  return new F0SheetsError(fallbackCode, ctx, { cause: err });
}

const RETRY = {
  maxRetries: 3,
  backoffMs: [1000, 3000, 9000],
  shouldRetry: shouldRetryGoogle,
};

// === Оркестратор ===

export interface CreateClientSpreadsheetOpts {
  extraction: F0FullExtraction;
  /** Имя создаваемой таблицы (бот формирует из компании + даты). */
  spreadsheetName: string;
  /**
   * spreadsheetId ранее созданной копии — при retry после сбоя на записи/шаринге.
   * Если задан, копирование пропускается (защита от дублей таблиц, AC3).
   */
  existingSpreadsheetId?: string;
  logger?: SheetsLogger;
  // Инъекции для тестов.
  sheetsClientFactory?: () => Promise<sheets_v4.Sheets>;
  driveClientFactory?: () => Promise<drive_v3.Drive>;
}

export interface CreateClientSpreadsheetResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
  shared: string[];
  counts: { okr: number; stakeholders: number; hypotheses: number };
}

export async function createClientSpreadsheet(
  opts: CreateClientSpreadsheetOpts,
): Promise<CreateClientSpreadsheetResult> {
  const log = (opts.logger ?? rootLogger).child({ pipeline: 'F0', step: 'f0.sheets.create' });
  const templateId = config.F0_SHEETS_TEMPLATE_ID.trim();
  if (templateId === '' && opts.existingSpreadsheetId === undefined) {
    throw new F0SheetsError('template_not_configured', {});
  }

  const sheets = await (opts.sheetsClientFactory ?? createSheetsWriteClient)();
  const drive = await (opts.driveClientFactory ?? createDriveWriteClient)();
  const startMs = Date.now();

  // 1. Копия шаблона (только если ещё не создана). Ошибка здесь безопасна для retry —
  // таблицы ещё нет, дублей не будет.
  let spreadsheetId = opts.existingSpreadsheetId;
  if (spreadsheetId === undefined) {
    const folderId = config.F0_SHEETS_FOLDER_ID.trim();
    try {
      const copied = await withRetry(
        () =>
          drive.files.copy({
            fileId: templateId,
            supportsAllDrives: true,
            requestBody: {
              name: opts.spreadsheetName,
              ...(folderId !== '' ? { parents: [folderId] } : {}),
            },
            fields: 'id',
          }),
        { ...RETRY, logger: log },
      );
      spreadsheetId = copied.data.id ?? undefined;
    } catch (err) {
      throw mapGoogleError(err, 'copy_failed');
    }
    if (spreadsheetId === undefined) {
      throw new F0SheetsError('copy_failed', { reason: 'no_id_in_copy_response' });
    }
    log.info({ spreadsheetId, templateId }, 'f0 sheets: template copied');
  }

  const sid = spreadsheetId;
  const counts = { okr: 0, stakeholders: 0, hypotheses: 0 };
  try {
    // 2. Карта листов копии (title → sheetId).
    const meta = await withRetry(
      () =>
        sheets.spreadsheets.get({
          spreadsheetId: sid,
          fields: 'sheets.properties(sheetId,title)',
        }),
      { ...RETRY, logger: log },
    );
    const titleToId = new Map<string, number>();
    for (const s of meta.data.sheets ?? []) {
      const p = s.properties;
      if (p?.title != null && typeof p.sheetId === 'number') titleToId.set(p.title, p.sheetId);
    }
    if (!titleToId.has(OKR_SHEET)) {
      throw new F0SheetsError('sheet_missing', { spreadsheetId: sid, sheet: OKR_SHEET });
    }
    if (!titleToId.has(STAKEHOLDER_SHEET)) {
      throw new F0SheetsError('sheet_missing', { spreadsheetId: sid, sheet: STAKEHOLDER_SHEET });
    }

    // 3. Лист _hypotheses создаём, если шаблон его не содержит.
    if (!titleToId.has(HYPOTHESES_SHEET)) {
      await withRetry(
        () =>
          sheets.spreadsheets.batchUpdate({
            spreadsheetId: sid,
            requestBody: {
              requests: [{ addSheet: { properties: { title: HYPOTHESES_SHEET } } }],
            },
          }),
        { ...RETRY, logger: log },
      );
      await withRetry(
        () =>
          sheets.spreadsheets.values.update({
            spreadsheetId: sid,
            range: `${HYPOTHESES_SHEET}!A1`,
            valueInputOption: 'RAW',
            requestBody: { values: [[...HYPOTHESES_HEADER]] },
          }),
        { ...RETRY, logger: log },
      );
    }

    // 4. Читаем фактические заголовки целевых листов (толерантность к порядку колонок).
    const headerResp = await withRetry(
      () =>
        sheets.spreadsheets.values.batchGet({
          spreadsheetId: sid,
          ranges: [`${OKR_SHEET}!1:1`, `${STAKEHOLDER_SHEET}!1:1`, `${HYPOTHESES_SHEET}!1:1`],
        }),
      { ...RETRY, logger: log },
    );
    const okrHeader = (headerResp.data.valueRanges?.[0]?.values?.[0] ?? []).map(String);
    const stakeholderHeader = (headerResp.data.valueRanges?.[1]?.values?.[0] ?? []).map(String);
    const hypoHeader = (headerResp.data.valueRanges?.[2]?.values?.[0] ?? []).map(String);

    assertHeaders(sid, OKR_SHEET, okrHeader, OKR_REQUIRED);
    assertHeaders(sid, STAKEHOLDER_SHEET, stakeholderHeader, STAKEHOLDER_REQUIRED);

    const okrRows = mapOkrRows(opts.extraction);
    const stakeholderRows = mapStakeholderRows(opts.extraction);
    const hypoRows = mapHypothesisRows(opts.extraction);
    counts.okr = okrRows.length;
    counts.stakeholders = stakeholderRows.length;
    counts.hypotheses = hypoRows.length;

    // 5. Очищаем прежние строки данных (идемпотентность retry — без дублей строк) и пишем.
    // Границу колонки берём по фактической ширине заголовка (мин. Z): если лист шаблона
    // шире 26 колонок, устаревшие данные правее Z тоже вычищаются.
    const clearCol = (header: string[]): string => colLetter(Math.max(header.length, 26));
    await withRetry(
      () =>
        sheets.spreadsheets.values.batchClear({
          spreadsheetId: sid,
          requestBody: {
            ranges: [
              `${OKR_SHEET}!A2:${clearCol(okrHeader)}`,
              `${STAKEHOLDER_SHEET}!A2:${clearCol(stakeholderHeader)}`,
              `${HYPOTHESES_SHEET}!A2:${clearCol(hypoHeader.length > 0 ? hypoHeader : [...HYPOTHESES_HEADER])}`,
            ],
          },
        }),
      { ...RETRY, logger: log },
    );

    const data: sheets_v4.Schema$ValueRange[] = [];
    if (okrRows.length > 0) {
      data.push({ range: `${OKR_SHEET}!A2`, values: alignRowsToHeader(okrHeader, okrRows) });
    }
    if (stakeholderRows.length > 0) {
      data.push({
        range: `${STAKEHOLDER_SHEET}!A2`,
        values: alignRowsToHeader(stakeholderHeader, stakeholderRows),
      });
    }
    if (hypoRows.length > 0) {
      const header = hypoHeader.length > 0 ? hypoHeader : [...HYPOTHESES_HEADER];
      data.push({ range: `${HYPOTHESES_SHEET}!A2`, values: alignRowsToHeader(header, hypoRows) });
    }
    if (data.length > 0) {
      await withRetry(
        () =>
          sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sid,
            requestBody: { valueInputOption: 'USER_ENTERED', data },
          }),
        { ...RETRY, logger: log },
      );
    }
  } catch (err) {
    throw mapGoogleError(err, 'populate_failed', sid);
  }

  // 6. Доступ трекеру (writer). Сбой здесь оставляет таблицу заполненной — retry с
  // existingSpreadsheetId только перепройдёт шаринг.
  const shared: string[] = [];
  const emails = config.F0_SHEETS_SHARE_EMAILS.split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  for (const email of emails) {
    try {
      await withRetry(
        () =>
          drive.permissions.create({
            fileId: sid,
            supportsAllDrives: true,
            sendNotificationEmail: false,
            requestBody: { type: 'user', role: 'writer', emailAddress: email },
          }),
        { ...RETRY, logger: log },
      );
      shared.push(email);
    } catch (err) {
      throw mapGoogleError(err, 'share_failed', sid);
    }
  }

  const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${sid}/edit`;
  log.info(
    { spreadsheetId: sid, durationMs: Date.now() - startMs, counts, shared: shared.length },
    'f0 sheets: client spreadsheet ready',
  );
  return { spreadsheetId: sid, spreadsheetUrl, shared, counts };
}

function assertHeaders(
  spreadsheetId: string,
  sheet: string,
  headerRow: string[],
  required: readonly string[],
): void {
  const present = new Set(headerRow.map((h) => h.trim()));
  const missing = required.filter((h) => !present.has(h));
  if (missing.length > 0) {
    throw new F0SheetsError('header_missing', { spreadsheetId, sheet, missing, found: headerRow });
  }
}
