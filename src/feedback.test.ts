import { describe, it, expect, vi } from 'vitest';
import type { sheets_v4 } from 'googleapis';
import { parseFeedbackTag, appendFeedbackRow, FEEDBACK_TAG_RE } from './feedback.js';

describe('parseFeedbackTag', () => {
  it('распознаёт #баг и вычищает тег из текста', () => {
    expect(parseFeedbackTag('#баг бот не отвечает на аудио')).toEqual({
      type: 'баг',
      body: 'бот не отвечает на аудио',
    });
  });

  it('распознаёт #фича и #хочу', () => {
    expect(parseFeedbackTag('#фича добавь экспорт')?.type).toBe('фича');
    expect(parseFeedbackTag('#хочу кнопку отмены')?.type).toBe('хочу');
  });

  it('регистронезависим и ловит тег в середине', () => {
    expect(parseFeedbackTag('Кстати #БАГ падает при файле >20 МБ')).toEqual({
      type: 'баг',
      body: 'Кстати падает при файле >20 МБ',
    });
  });

  it('тег без текста → пустой body', () => {
    expect(parseFeedbackTag('#хочу')).toEqual({ type: 'хочу', body: '' });
  });

  it('нет тега / пусто → null', () => {
    expect(parseFeedbackTag('просто сообщение в группе')).toBeNull();
    expect(parseFeedbackTag('')).toBeNull();
    expect(parseFeedbackTag(undefined)).toBeNull();
    expect(parseFeedbackTag(null)).toBeNull();
  });

  it('не ловит слово без решётки и не путает с #багаж', () => {
    expect(parseFeedbackTag('это баг конечно')).toBeNull();
    expect(parseFeedbackTag('#багаж потеряли')).toBeNull();
  });

  it('регэксп экспортируется для bot.hears', () => {
    expect(FEEDBACK_TAG_RE.test('#фича')).toBe(true);
    expect(FEEDBACK_TAG_RE.test('обычный текст')).toBe(false);
  });
});

describe('appendFeedbackRow', () => {
  function mockSheets(): { client: sheets_v4.Sheets; append: ReturnType<typeof vi.fn> } {
    const append = vi.fn().mockResolvedValue({});
    const client = { spreadsheets: { values: { append } } } as unknown as sheets_v4.Sheets;
    return { client, append };
  }

  it('пишет строку с корректными колонками и статусом «новое»', async () => {
    const { client, append } = mockSheets();
    await appendFeedbackRow(
      { date: '15.07.26, 14:30', author: 'Азиза (@aziza)', type: 'баг', body: 'падает', link: '' },
      { sheetsClient: client, spreadsheetId: 'SHEET1' },
    );
    expect(append).toHaveBeenCalledTimes(1);
    const arg = append.mock.calls[0]![0] as {
      spreadsheetId: string;
      range: string;
      requestBody: { values: string[][] };
    };
    expect(arg.spreadsheetId).toBe('SHEET1');
    expect(arg.range).toMatch(/Обратная связь/);
    expect(arg.requestBody.values[0]).toEqual([
      '15.07.26, 14:30',
      'Азиза (@aziza)',
      'баг',
      'падает',
      'новое',
      '',
      '',
    ]);
  });

  it('без spreadsheetId бросает понятную ошибку', async () => {
    const { client } = mockSheets();
    await expect(
      appendFeedbackRow(
        { date: 'd', author: 'a', type: 'хочу', body: 'b', link: '' },
        { sheetsClient: client, spreadsheetId: '' },
      ),
    ).rejects.toThrow(/FEEDBACK_SHEET_ID/);
  });
});
