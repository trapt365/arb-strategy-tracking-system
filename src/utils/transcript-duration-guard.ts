import { TranscriptValidationError } from '../errors.js';
import type { Transcript } from '../types.js';

export const MIN_TRANSCRIPT_DURATION_SEC = 120;

export function assertTranscriptDuration(transcript: Transcript): void {
  const duration = transcript.metadata?.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < MIN_TRANSCRIPT_DURATION_SEC) {
    throw new TranscriptValidationError('too_short', {
      durationSec: duration,
      minSec: MIN_TRANSCRIPT_DURATION_SEC,
    });
  }
}
