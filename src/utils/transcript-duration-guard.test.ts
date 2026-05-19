import { describe, it, expect } from 'vitest';
import {
  assertTranscriptDuration,
  MIN_TRANSCRIPT_DURATION_SEC,
} from './transcript-duration-guard.js';
import { TranscriptValidationError } from '../errors.js';
import type { Transcript } from '../types.js';

function makeTranscript(duration: number | undefined): Transcript {
  return {
    speakers: [
      {
        name: 'A',
        segments: [{ start: 0, end: 1, text: 'hi' }],
      },
    ],
    metadata: {
      date: '2026-05-19T10:00:00+05:00',
      duration: duration as number,
      meeting_type: 'sync',
    },
  } as Transcript;
}

describe('assertTranscriptDuration', () => {
  it('duration < 120 → throws TranscriptValidationError(too_short)', () => {
    expect(() => assertTranscriptDuration(makeTranscript(90))).toThrow(TranscriptValidationError);
    try {
      assertTranscriptDuration(makeTranscript(90));
    } catch (err) {
      const e = err as TranscriptValidationError;
      expect(e.code).toBe('too_short');
      expect(e.context.durationSec).toBe(90);
      expect(e.context.minSec).toBe(MIN_TRANSCRIPT_DURATION_SEC);
    }
  });

  it('duration = 120 → ok', () => {
    expect(() => assertTranscriptDuration(makeTranscript(120))).not.toThrow();
  });

  it('duration = 121 → ok', () => {
    expect(() => assertTranscriptDuration(makeTranscript(121))).not.toThrow();
  });

  it('duration = 0 → throws', () => {
    expect(() => assertTranscriptDuration(makeTranscript(0))).toThrow(TranscriptValidationError);
  });

  it('duration = undefined → throws (defensive)', () => {
    expect(() => assertTranscriptDuration(makeTranscript(undefined))).toThrow(
      TranscriptValidationError,
    );
  });

  it('duration = NaN → throws', () => {
    expect(() => assertTranscriptDuration(makeTranscript(Number.NaN))).toThrow(
      TranscriptValidationError,
    );
  });
});
