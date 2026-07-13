import { describe, it, expect } from 'vitest';
import { isTranscriptDocument, isTranscriptCandidateType } from './transcript-detect.js';

describe('isTranscriptDocument', () => {
  it('returns true for text with ≥5 timestamp patterns', () => {
    const text = `
Обсуждение продаж
0:00 Добро пожаловать
1:15 Итоги квартала
5:30 Обсуждение рисков
10:00 Гипотезы
15:45 Итоги встречи
    `.trim();
    expect(isTranscriptDocument(text)).toBe(true);
  });

  it('returns true for text with ≥5 numbered Speaker lines', () => {
    const text = `
Спикер 1: Начнём встречу.
Спикер 2: Согласен.
Спикер 1: Перейдём к итогам.
Speaker 3: У меня есть вопрос.
Спикер 2: Конечно.
Спикер 1: Завершаем.
    `.trim();
    expect(isTranscriptDocument(text)).toBe(true);
  });

  it('returns false for strategic document with OKR sections but no timestamps or speaker lines', () => {
    const text = `
# Стратегия Ромашка 2026

## Цель: Увеличить конверсию
KR-A: Конверсия ≥30%
KR-B: Объём лидов ≥200/мес

## Цель: Расширить команду
KR-C: Нанять 5 менеджеров
KR-D: Onboarding <2 недель

## Гипотезы
H-A: Видеозвонки увеличивают конверсию.
H-B: Скрипт продаж сокращает цикл.
    `.trim();
    // No timestamps (\d:\d{2} pattern) and no numbered Speaker lines
    expect(isTranscriptDocument(text)).toBe(false);
  });

  it('returns false for strategic doc without timestamps/speakers (4 timestamps, 4 speaker lines)', () => {
    const text = `
# Стратегия

Цель: Рост продаж
KR-A: Увеличить выручку
KR-B: Снизить отток

Спикер 1: Первый пункт.
Спикер 2: Второй пункт.
Speaker 3: Третий.
Спикер 4: Четвёртый.

9:15 утро
14:30 встреча
18:00 итог
22:45 вечер
    `.trim();
    // 4 timestamps + 4 speaker lines → false
    expect(isTranscriptDocument(text)).toBe(false);
  });

  it('returns false for text with exactly 4 timestamps and 4 speaker lines', () => {
    const text = [
      'Спикер 1: Привет.',
      'Спикер 2: Привет.',
      'Speaker 3: Вопрос.',
      'Спикер 4: Ответ.',
      'Время: 9:00',
      'Перерыв: 10:30',
      'Продолжение: 11:15',
      'Конец: 12:45',
    ].join('\n');
    expect(isTranscriptDocument(text)).toBe(false);
  });
});

describe('isTranscriptCandidateType', () => {
  it('returns true for .md extension', () => {
    expect(isTranscriptCandidateType('meeting.md')).toBe(true);
  });

  it('returns true for .txt extension', () => {
    expect(isTranscriptCandidateType('notes.txt')).toBe(true);
  });

  it('returns true for .docx extension', () => {
    expect(isTranscriptCandidateType('transcript.docx')).toBe(true);
  });

  it('returns false for .pdf extension', () => {
    expect(isTranscriptCandidateType('report.pdf')).toBe(false);
  });

  it('returns false for .xlsx extension', () => {
    expect(isTranscriptCandidateType('data.xlsx')).toBe(false);
  });

  it('returns true for text/plain MIME type', () => {
    expect(isTranscriptCandidateType(undefined, 'text/plain')).toBe(true);
  });

  it('returns true for text/markdown MIME type', () => {
    expect(isTranscriptCandidateType(undefined, 'text/markdown')).toBe(true);
  });

  it('returns true for docx MIME type', () => {
    expect(
      isTranscriptCandidateType(
        undefined,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe(true);
  });

  it('returns false for application/pdf MIME type', () => {
    expect(isTranscriptCandidateType(undefined, 'application/pdf')).toBe(false);
  });

  it('returns false when both fileName and mimeType are undefined', () => {
    expect(isTranscriptCandidateType(undefined, undefined)).toBe(false);
  });

  it('returns true for .markdown extension', () => {
    expect(isTranscriptCandidateType('notes.markdown')).toBe(true);
  });
});
