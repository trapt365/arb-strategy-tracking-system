import type { sheets_v4 } from 'googleapis';
import { createSheetsWriteClient } from './adapters/sheets.js';
import { config } from './config.js';
import { logger as rootLogger, type Logger } from './logger.js';

// Захват обратной связи из группы: #баг / #фича / #хочу → строка в Google-таблицу.
// Статус исполнения ведётся прямо в таблице (колонка «Статус», выпадающий список).

export type FeedbackType = 'баг' | 'фича' | 'хочу';

/**
 * Первый тег #баг/#фича/#хочу в тексте (или подписи к скрину). Регистронезависимо.
 * Граница — негативный lookahead на кириллицу (\b в JS по ASCII, после кириллицы не срабатывает):
 * «#баг» ловится, «#багаж» — нет.
 */
export const FEEDBACK_TAG_RE = /#(баг|фича|хочу)(?![а-яё])/iu;

export const FEEDBACK_STATUSES = ['новое', 'в работе', 'сделано', 'отклонено'] as const;

/** Заголовок листа обратной связи (порядок = порядок колонок при append). */
export const FEEDBACK_HEADER = [
  'Дата',
  'Автор',
  'Тип',
  'Текст',
  'Статус',
  'Комментарий',
  'Ссылка',
] as const;

export const FEEDBACK_SHEET_TITLE = 'Обратная связь';
export const FEEDBACK_RANGE = `${FEEDBACK_SHEET_TITLE}!A:G`;

export interface ParsedFeedback {
  type: FeedbackType;
  /** Текст сообщения без самого тега. */
  body: string;
}

/**
 * Ищет тег обратной связи. Возвращает тип и текст без тега, либо null.
 * Пустой body («просто #баг») допустим — вызывающий подставит заглушку.
 */
export function parseFeedbackTag(text: string | undefined | null): ParsedFeedback | null {
  if (!text) return null;
  const m = FEEDBACK_TAG_RE.exec(text);
  if (m === null) return null;
  const type = m[1]!.toLowerCase() as FeedbackType;
  const body = text.replace(FEEDBACK_TAG_RE, ' ').replace(/\s+/gu, ' ').trim();
  return { type, body };
}

export interface FeedbackEntry {
  /** Уже отформатированная дата (модуль не берёт время сам — передаёт вызывающий). */
  date: string;
  author: string;
  type: FeedbackType;
  body: string;
  link: string;
}

export interface AppendFeedbackDeps {
  sheetsClient?: sheets_v4.Sheets;
  spreadsheetId?: string;
  logger?: Logger;
}

/** Добавляет строку обратной связи в таблицу. Статус = «новое». */
export async function appendFeedbackRow(
  entry: FeedbackEntry,
  deps: AppendFeedbackDeps = {},
): Promise<void> {
  const spreadsheetId = deps.spreadsheetId ?? config.FEEDBACK_SHEET_ID;
  if (!spreadsheetId) {
    throw new Error('FEEDBACK_SHEET_ID не задан — таблица обратной связи не настроена');
  }
  const log = deps.logger ?? rootLogger;
  const sheets = deps.sheetsClient ?? (await createSheetsWriteClient());
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: FEEDBACK_RANGE,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [[entry.date, entry.author, entry.type, entry.body, 'новое', '', entry.link]],
    },
  });
  log.info({ type: entry.type, spreadsheetId }, 'feedback row appended');
}
