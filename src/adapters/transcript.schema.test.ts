import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TranscriptSchema } from '../types.js';

const ROOT = process.cwd();

const GOLDEN_FILES = [
  'transcript-1.json',
  'transcript-2.json',
  'transcript-3.json',
  'transcript-4.json',
  'transcript-5.json',
  'transcript-6.json',
  'transcript-7.json',
];

// Golden transcripts были сгенерированы в Story 0.3 как F1/F4 prompt-фикстуры
// и используют placeholder `"unknown"` для metadata.date / meeting_type
// (реальные timestamps клиента ещё не присваивались). В Story 1.2 контракт
// требует ISO-8601 для metadata.date; orchestrator подставляет meta.meetingDate
// извне. Здесь подменяем metadata валидной заглушкой и валидируем shape.
const STUB_METADATA = {
  date: '2026-04-22T10:00:00.000Z',
  meeting_type: 'tracking_session',
};

describe('TranscriptSchema acceptance — golden dataset', () => {
  for (const file of GOLDEN_FILES) {
    it(`accepts ${file} (with normalized metadata) without errors`, () => {
      const data = JSON.parse(readFileSync(join(ROOT, 'data/golden', file), 'utf8'));
      const normalized = {
        speakers: data.speakers,
        metadata: { ...data.metadata, ...STUB_METADATA },
      };
      expect(() => TranscriptSchema.parse(normalized)).not.toThrow();
    });
  }
});
