import * as XLSX from 'xlsx';
import { F0OnboardingError } from './errors.js';
import type {
  F0FullExtraction,
  F0HypothesisDraft,
  F0KrDraft,
  F0ObjectiveDraft,
  F0ParticipantDraft,
} from './types.js';

// Story 8.5 (W11, FR102): импорт готовой стратегии из .xlsx — альтернативный продюсер
// F0FullExtraction без LLM-вызовов. Весь даунстрим (черновик-саммари, инварианты 1–3,
// диалог дозаполнения, /confirm → Sheets) переиспользуется без правок.
// Дизайн: _bmad-output/planning-artifacts/design-f0-import-vs-synthesis-2026-07-08.md.
//
// Два формата:
//  A — «наша» таблица (экспорт шаблона v2.0): машинный лист _okr со знакомыми
//      заголовками; маппинг обратный к mapOkrRows/mapStakeholderRows/mapHypothesisRows.
//  B — произвольная таблица клиента: лист с максимумом совпавших заголовков-синонимов
//      (порог ≥ 3 категорий, формулировка KR обязательна); заголовок ищется в первых
//      строках листа (в реальных файлах над таблицей живёт шапка — Geonline: строка 10).
// Инвариант 3 («не выдумывать»): пустая ячейка → null; незамапленные колонки и
// пропущенные листы → extraction.unrecognized.

export interface F0ImportResult {
  extraction: F0FullExtraction;
  format: 'template' | 'generic';
  /** Лист, из которого читали KR (для логов и сообщения об импорте). */
  sheetName: string;
  /** Распознанные колонки KR-листа (нормализованные заголовки). */
  mappedColumns: string[];
}

// Заголовок ищем в первых строках листа: выше таблицы обычно шапка/легенда.
const HEADER_SCAN_ROWS = 30;
// Категорий-синонимов должно совпасть не меньше порога, иначе лист не похож на KR-таблицу.
const GENERIC_MATCH_THRESHOLD = 3;
// Хвост пустых строк, после которого перестаём искать данные (дыры в таблице легальны).
const MAX_EMPTY_DATA_ROWS = 20;
const MAX_UNRECOGNIZED_ITEMS = 15;

type KrColumn = 'formulation' | 'base' | 'target' | 'owner' | 'deadline' | 'objective';

// Синонимы заголовков (нормализованные: lowercase, trim). Матч — точное совпадение
// или «начинается с» для составных шапок («цель (до)», «ответственный за KR»).
// Порядок категорий важен: objective проверяется раньше target, иначе «цель года»
// совпала бы с target по префиксу «цель».
const KR_COLUMN_SYNONYMS: ReadonlyArray<readonly [KrColumn, readonly string[]]> = [
  [
    'objective',
    ['направление', 'цель года', 'годовая цель', 'objective', 'блок', 'okr_group', 'okr группа'],
  ],
  [
    'formulation',
    [
      'kr',
      'ключевой результат',
      'key result',
      'key_result',
      'результат',
      'формулировка',
      'формулировка kr',
    ],
  ],
  [
    'base',
    ['база', 'базовое значение', 'текущее', 'текущее значение', 'current', 'current_status', 'старт', 'факт'],
  ],
  ['target', ['цель', 'целевое значение', 'target', 'план', 'до']],
  ['owner', ['ответственный', 'владелец', 'owner', 'кто', 'исполнитель']],
  ['deadline', ['срок', 'дедлайн', 'deadline', 'когда', 'дата', 'срок выполнения']],
] as const;

// Формат A: заголовки листа _okr (см. mapOkrRows) — точные машинные имена.
const TEMPLATE_KR_COLUMNS: Readonly<Record<string, KrColumn>> = {
  key_result: 'formulation',
  current_status: 'base',
  target: 'target',
  owner: 'owner',
  deadline: 'deadline',
  okr_group: 'objective',
};
const TEMPLATE_DETECT_HEADERS = ['kr_number', 'key_result'] as const;

function cellToString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'да' : '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

const nullable = (s: string): string | null => (s.length === 0 ? null : s);

const normalizeHeader = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Лист → матрица строк (строки как отдали, без пропуска пустых). */
function sheetRows(sheet: XLSX.WorkSheet): string[][] {
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    blankrows: true,
  });
  return raw.map((row) => row.map(cellToString));
}

function matchKrColumn(header: string): KrColumn | null {
  if (header.length === 0) return null;
  for (const [column, synonyms] of KR_COLUMN_SYNONYMS) {
    for (const syn of synonyms) {
      if (header === syn || header.startsWith(`${syn} `) || header.startsWith(`${syn}(`)) {
        return column;
      }
    }
  }
  return null;
}

interface HeaderMap {
  rowIndex: number;
  /** Индекс колонки по категории (первая совпавшая колонка выигрывает). */
  columns: Partial<Record<KrColumn, number>>;
  /** Нормализованные заголовки, не попавшие ни в одну категорию. */
  unmatched: string[];
  matchedCount: number;
}

/** Найти в первых строках листа строку заголовков с максимумом совпавших категорий. */
function findGenericHeader(rows: string[][]): HeaderMap | null {
  let best: HeaderMap | null = null;
  const scanLimit = Math.min(rows.length, HEADER_SCAN_ROWS);
  for (let r = 0; r < scanLimit; r++) {
    const columns: Partial<Record<KrColumn, number>> = {};
    const unmatched: string[] = [];
    rows[r]!.forEach((cell, c) => {
      const header = normalizeHeader(cell);
      if (header.length === 0) return;
      const column = matchKrColumn(header);
      if (column !== null && columns[column] === undefined) columns[column] = c;
      else unmatched.push(cell.trim());
    });
    const matchedCount = Object.keys(columns).length;
    if (matchedCount > (best?.matchedCount ?? 0)) {
      best = { rowIndex: r, columns, unmatched, matchedCount };
    }
  }
  return best;
}

interface ParsedKrRow {
  kr: F0KrDraft;
  objectiveTitle: string | null;
}

/** Строки данных под заголовком → KR (формулировка обязательна, пустое → null). */
function readKrRows(rows: string[][], header: HeaderMap): ParsedKrRow[] {
  const col = header.columns;
  const formulationCol = col.formulation;
  if (formulationCol === undefined) return [];
  const parsed: ParsedKrRow[] = [];
  let emptyStreak = 0;
  for (let r = header.rowIndex + 1; r < rows.length; r++) {
    const row = rows[r]!;
    const formulation = (row[formulationCol] ?? '').trim();
    if (formulation.length === 0) {
      emptyStreak += 1;
      if (emptyStreak > MAX_EMPTY_DATA_ROWS) break;
      continue;
    }
    emptyStreak = 0;
    const at = (c: number | undefined): string | null =>
      c === undefined ? null : nullable((row[c] ?? '').trim());
    parsed.push({
      kr: {
        formulation,
        // Детект milestone-вех из таблицы — выдумывание; metric строже максимум на
        // один лишний вопрос дозаполнения (/confirm не блокирует). См. записку §3.
        kr_type: 'metric',
        base: at(col.base),
        target: at(col.target),
        owner: at(col.owner),
        deadline: at(col.deadline),
      },
      objectiveTitle: at(col.objective),
    });
  }
  return parsed;
}

/** KR + колонка направления → objectives (группировка в порядке первого появления). */
function groupIntoObjectives(parsed: ParsedKrRow[], fallbackTitle: string): F0ObjectiveDraft[] {
  const byTitle = new Map<string, F0ObjectiveDraft>();
  for (const { kr, objectiveTitle } of parsed) {
    const title = objectiveTitle ?? fallbackTitle;
    let objective = byTitle.get(title);
    if (objective === undefined) {
      objective = { title, krs: [] };
      byTitle.set(title, objective);
    }
    objective.krs.push(kr);
  }
  return [...byTitle.values()];
}

/** Участники из колонки «ответственный»: уникальные имена, ничего не выдумываем. */
function participantsFromOwners(objectives: F0ObjectiveDraft[]): F0ParticipantDraft[] {
  const seen = new Set<string>();
  const participants: F0ParticipantDraft[] = [];
  for (const objective of objectives) {
    for (const kr of objective.krs) {
      const owner = kr.owner?.trim();
      if (owner === undefined || owner.length === 0) continue;
      const key = owner.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      participants.push({ name: owner, role: null, department: null, contact: null });
    }
  }
  return participants;
}

// ─── Формат A: «наша» таблица (_okr / _stakeholder_map / _hypotheses / _meta) ───

/** Лист с машинными заголовками → записи {header → значение} (заголовок в строке 1). */
function readTemplateRecords(sheet: XLSX.WorkSheet): Array<Record<string, string>> {
  const rows = sheetRows(sheet);
  if (rows.length === 0) return [];
  const headers = rows[0]!.map(normalizeHeader);
  const records: Array<Record<string, string>> = [];
  for (let r = 1; r < rows.length; r++) {
    const record: Record<string, string> = {};
    let hasValue = false;
    headers.forEach((h, c) => {
      if (h.length === 0) return;
      const value = (rows[r]![c] ?? '').trim();
      record[h] = value;
      if (value.length > 0) hasValue = true;
    });
    if (hasValue) records.push(record);
  }
  return records;
}

function isTemplateKrSheet(rows: string[][]): boolean {
  if (rows.length === 0) return false;
  const headers = new Set(rows[0]!.map(normalizeHeader));
  return TEMPLATE_DETECT_HEADERS.every((h) => headers.has(h));
}

function importTemplate(
  wb: XLSX.WorkBook,
  krSheetName: string,
  unrecognized: string[],
): Omit<F0ImportResult, 'format'> {
  const krRecords = readTemplateRecords(wb.Sheets[krSheetName]!);
  const parsed: ParsedKrRow[] = krRecords
    .filter((rec) => (rec.key_result ?? '').length > 0)
    .map((rec) => ({
      kr: {
        formulation: rec.key_result!,
        kr_type: 'metric',
        base: nullable(rec.current_status ?? ''),
        target: nullable(rec.target ?? ''),
        owner: nullable(rec.owner ?? ''),
        deadline: nullable(rec.deadline ?? ''),
      },
      objectiveTitle: nullable(rec.okr_group ?? ''),
    }));
  const objectives = groupIntoObjectives(parsed, krSheetName);

  // Участники: лист _stakeholder_map, иначе владельцы KR.
  let participants: F0ParticipantDraft[];
  const stakeholderSheet = wb.Sheets['_stakeholder_map'];
  if (stakeholderSheet !== undefined) {
    participants = readTemplateRecords(stakeholderSheet)
      .filter((rec) => (rec.full_name ?? '').length > 0)
      .map((rec) => ({
        name: rec.full_name!,
        role: nullable(rec.role ?? ''),
        department: nullable(rec.department ?? ''),
        contact: nullable(rec.telegram ?? ''),
      }));
  } else {
    participants = participantsFromOwners(objectives);
  }

  // Гипотезы: только если лист _hypotheses есть в файле — не выдумываем.
  const hypotheses: F0HypothesisDraft[] = [];
  const hypoSheet = wb.Sheets['_hypotheses'];
  if (hypoSheet !== undefined) {
    for (const rec of readTemplateRecords(hypoSheet)) {
      if ((rec.statement ?? '').length === 0) continue;
      hypotheses.push({
        statement: rec.statement!,
        ifThenBecause: nullable(rec.if_then_because ?? ''),
        metric: nullable(rec.metric ?? ''),
        department: nullable(rec.department ?? ''),
        synthesized: (rec.synthesized ?? '') === 'да',
      });
    }
  }

  // Компания из _meta (key/value), если лист есть.
  let company: string | null = null;
  const metaSheet = wb.Sheets['_meta'];
  if (metaSheet !== undefined) {
    for (const rec of readTemplateRecords(metaSheet)) {
      if ((rec.key ?? '') === 'company') company = nullable(rec.value ?? '');
    }
  }

  const knownSheets = new Set([krSheetName, '_stakeholder_map', '_hypotheses', '_meta']);
  for (const name of wb.SheetNames) {
    if (!knownSheets.has(name)) unrecognized.push(`лист «${name}» не импортирован`);
  }

  return {
    extraction: {
      document_type: 'strategy',
      company,
      objectives,
      hypotheses,
      participants,
      unrecognized: unrecognized.slice(0, MAX_UNRECOGNIZED_ITEMS),
    },
    sheetName: krSheetName,
    mappedColumns: Object.keys(TEMPLATE_KR_COLUMNS),
  };
}

// ─── Публичный вход ───

/**
 * Один .xlsx → F0FullExtraction (0 LLM-вызовов).
 * Битый файл → F0OnboardingError('document_parse_failed');
 * ни один лист не похож на KR-таблицу → F0OnboardingError('import_unmappable').
 */
export function importStrategyXlsx(buf: Buffer, sourceName: string): F0ImportResult {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  } catch (err) {
    throw new F0OnboardingError('document_parse_failed', { sourceName, kind: 'xlsx' }, { cause: err });
  }
  if (wb.SheetNames.length === 0) {
    throw new F0OnboardingError('empty_document', { sourceName, kind: 'xlsx' });
  }

  // Формат A: машинный лист _okr или лист со знакомыми машинными заголовками.
  const templateSheetName =
    wb.SheetNames.find((name) => name === '_okr') ??
    wb.SheetNames.find((name) => isTemplateKrSheet(sheetRows(wb.Sheets[name]!)));
  if (templateSheetName !== undefined) {
    const result = importTemplate(wb, templateSheetName, []);
    if (result.extraction.objectives.length > 0) {
      return { ...result, format: 'template' };
    }
    // Машинный лист есть, но данных нет — честный отказ, а не пустой черновик.
    throw new F0OnboardingError('import_unmappable', {
      sourceName,
      reason: 'template_sheet_empty',
      sheetName: templateSheetName,
    });
  }

  // Формат B: лист с максимумом совпавших заголовков-синонимов.
  let bestSheet: { name: string; rows: string[][]; header: HeaderMap } | null = null;
  for (const name of wb.SheetNames) {
    const rows = sheetRows(wb.Sheets[name]!);
    const header = findGenericHeader(rows);
    if (header === null || header.columns.formulation === undefined) continue;
    if (header.matchedCount > (bestSheet?.header.matchedCount ?? 0)) {
      bestSheet = { name, rows, header };
    }
  }
  if (bestSheet === null || bestSheet.header.matchedCount < GENERIC_MATCH_THRESHOLD) {
    throw new F0OnboardingError('import_unmappable', {
      sourceName,
      reason: 'no_kr_sheet',
      sheets: wb.SheetNames.slice(0, 10),
      bestMatch: bestSheet?.header.matchedCount ?? 0,
    });
  }

  const parsed = readKrRows(bestSheet.rows, bestSheet.header);
  if (parsed.length === 0) {
    throw new F0OnboardingError('import_unmappable', {
      sourceName,
      reason: 'no_kr_rows',
      sheetName: bestSheet.name,
    });
  }

  const objectives = groupIntoObjectives(parsed, bestSheet.name);
  const unrecognized: string[] = [];
  if (bestSheet.header.unmatched.length > 0) {
    unrecognized.push(
      `лист «${bestSheet.name}»: колонки ${bestSheet.header.unmatched
        .slice(0, 8)
        .map((h) => `«${h}»`)
        .join(', ')}`,
    );
  }
  for (const name of wb.SheetNames) {
    if (name !== bestSheet.name) unrecognized.push(`лист «${name}» не импортирован`);
  }

  return {
    extraction: {
      document_type: 'strategy',
      company: null,
      objectives,
      // Формат B: гипотез не выдумываем (записка §3) — честный счётчик 0 в черновике;
      // досинтез — кнопкой после импорта (ответ Тимура на вопрос 4).
      hypotheses: [],
      participants: participantsFromOwners(objectives),
      unrecognized: unrecognized.slice(0, MAX_UNRECOGNIZED_ITEMS),
    },
    format: 'generic',
    sheetName: bestSheet.name,
    mappedColumns: Object.keys(bestSheet.header.columns),
  };
}

/**
 * Текстификация xlsx для LLM-досинтеза гипотез («🧠 Досинтезировать гипотезы»):
 * листы → TSV с маркерами. Обрезка по бюджету — на вызывающей стороне
 * (sanitizeStrategyDocText в runF0FullDraft).
 */
export function xlsxToText(buf: Buffer, sourceName: string): string {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  } catch (err) {
    throw new F0OnboardingError('document_parse_failed', { sourceName, kind: 'xlsx' }, { cause: err });
  }
  const parts: string[] = [];
  for (const name of wb.SheetNames) {
    const rows = sheetRows(wb.Sheets[name]!)
      .map((row) => row.join('\t').replace(/\t+$/, ''))
      .filter((line) => line.trim().length > 0);
    if (rows.length === 0) continue;
    parts.push(`===== Лист: ${name} =====\n${rows.join('\n')}`);
  }
  return parts.join('\n\n');
}
