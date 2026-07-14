// Story 11.7 + D7 (live-run 14.07): эвристический детект текстового транскрипта встречи.

const TIMESTAMP_RE = /\b\d{1,2}:\d{2}(:\d{2})?\b/g;
// Допускаем markdown-обёртку спикерной строки: «**Спикер 1:**», «> Speaker 2 -», отступы.
const SPEAKER_NUMBERED_RE = /^\s*[>*_-]*\s*(?:Спикер|Speaker)\s+\d+\s*[*_]*\s*[:\-—]/i;
// Именованный говорящий: «Дамир:», «**Тимур:**», «Мерей Финансист:» — 1-3 слова с заглавной буквы.
const SPEAKER_NAMED_RE =
  /^\s*[>*_-]*\s*([А-ЯЁA-Z][а-яёА-ЯЁa-zA-Z.\-]{1,24}(?:\s+[а-яёА-ЯЁa-zA-Z.\-]{1,24}){0,2})\s*[*_]*\s*:/;

/**
 * D12: дата встречи из YAML-frontmatter транскрипта (`created: 2026-04-13` / `date: …`).
 * Реальные расшифровки загружаются постфактум — без этой даты отчёт лёг бы в день загрузки
 * и попал бы не в ту неделю. Возвращает YYYY-MM-DD или undefined.
 */
export function parseTranscriptCreatedDate(text: string): string | undefined {
  const fm = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm?.[1]) return undefined;
  const line = /^(?:created|date):\s*['"]?(\d{4}-\d{2}-\d{2})/im.exec(fm[1]);
  return line?.[1];
}

/**
 * Returns true if the file extension or MIME type indicates a plain-text document
 * that could be a meeting transcript (md, txt, docx).
 */
export function isTranscriptCandidateType(fileName?: string, mimeType?: string): boolean {
  if (fileName) {
    const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
    if (['.md', '.markdown', '.txt', '.docx'].includes(ext)) return true;
  }
  if (mimeType) {
    if (
      mimeType === 'text/plain' ||
      mimeType === 'text/markdown' ||
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Returns true if the text looks like a meeting transcript based on conservative heuristics:
 * - ≥5 timestamp-like patterns (\d:\d{2})
 * - OR ≥5 numbered speaker lines ("Speaker N:" / "Спикер 1:" / "**Спикер 1:**")
 * - OR named-speaker dialogue: few distinct names ("Дамир:", "**Тимур:**") repeating across
 *   most lines — реальные расшифровки часто без таймкодов и с именами вместо номеров (D7).
 */
export function isTranscriptDocument(text: string): boolean {
  const timestampMatches = (text.match(TIMESTAMP_RE) ?? []).length;
  if (timestampMatches >= 5) return true;

  let numberedCount = 0;
  const namedCounts = new Map<string, number>();
  let nonEmptyLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    nonEmptyLines++;
    if (SPEAKER_NUMBERED_RE.test(line)) {
      numberedCount++;
      if (numberedCount >= 5) return true;
      continue;
    }
    const named = SPEAKER_NAMED_RE.exec(line);
    if (named?.[1] !== undefined) {
      const name = named[1].toLowerCase();
      namedCounts.set(name, (namedCounts.get(name) ?? 0) + 1);
    }
  }

  // Диалог = 2-12 говорящих, каждый из топ-2 повторяется ≥3 раз, и спикерные строки
  // доминируют в тексте (≥40% непустых строк) — отсекает стратегии с «Цель:» / «KR-A:».
  const repeated = [...namedCounts.values()].filter((n) => n >= 3);
  if (repeated.length >= 2 && namedCounts.size <= 12) {
    const namedLines = [...namedCounts.values()].reduce((a, b) => a + b, 0);
    if (namedLines >= 8 && nonEmptyLines > 0 && namedLines / nonEmptyLines >= 0.4) {
      return true;
    }
  }

  return false;
}
