// Story 11.7: эвристический детект текстового транскрипта встречи.

const TIMESTAMP_RE = /\b\d{1,2}:\d{2}(:\d{2})?\b/g;
const SPEAKER_NUMBERED_RE = /^\s*(?:Спикер|Speaker)\s+\d+\s*[:\-—]/im;

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
 * - ≥5 timestamp-like patterns (\d:\d{2}) — primary signal
 * - OR ≥5 numbered speaker lines ("Speaker N:" / "Спикер N:") — secondary signal
 */
export function isTranscriptDocument(text: string): boolean {
  const timestampMatches = (text.match(TIMESTAMP_RE) ?? []).length;
  if (timestampMatches >= 5) return true;

  let speakerCount = 0;
  for (const line of text.split(/\r?\n/)) {
    if (SPEAKER_NUMBERED_RE.test(line)) speakerCount++;
    if (speakerCount >= 5) return true;
  }

  return false;
}
