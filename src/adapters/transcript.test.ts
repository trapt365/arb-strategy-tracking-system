import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSonioxTokens, parsePlainText, transcribeFromPlainText, transcribeFromUrl } from './transcript.js';
import {
  TranscriptValidationError,
  TranscriptConfigError,
  TranscriptDownloadError,
} from '../errors.js';
import { TranscriptSchema } from '../types.js';
import type { SonioxToken } from './soniox.js';
import * as ops from '../ops.js';

const ROOT = process.cwd();

const META = {
  clientId: 'test-client',
  meetingDate: '2026-04-22T10:00:00.000Z',
  meetingType: 'tracking_session',
};

describe('parseSonioxTokens', () => {
  it('groups consecutive same-speaker tokens into one segment', () => {
    const tokens: SonioxToken[] = [
      { text: 'Привет', start_ms: 1000, end_ms: 1500, speaker: '1', is_audio_event: false },
      { text: ' мир', start_ms: 1500, end_ms: 2000, speaker: '1', is_audio_event: false },
    ];
    const t = parseSonioxTokens(tokens, META);
    expect(t.speakers).toHaveLength(1);
    expect(t.speakers[0]!.segments).toEqual([
      { start: 1, end: 2, text: 'Привет мир' },
    ]);
  });

  it('starts a new segment on speaker change and groups by speaker', () => {
    const tokens: SonioxToken[] = [
      { text: 'A', start_ms: 0, end_ms: 100, speaker: '1', is_audio_event: false },
      { text: 'B', start_ms: 100, end_ms: 200, speaker: '2', is_audio_event: false },
      { text: 'C', start_ms: 200, end_ms: 300, speaker: '1', is_audio_event: false },
    ];
    const t = parseSonioxTokens(tokens, META);
    expect(t.speakers.map((s) => s.name)).toEqual(['Speaker 1', 'Speaker 2']);
    expect(t.speakers[0]!.segments).toHaveLength(2);
    expect(t.speakers[1]!.segments).toHaveLength(1);
  });

  it('skips tokens with is_audio_event=true', () => {
    const tokens: SonioxToken[] = [
      { text: 'hello', start_ms: 0, end_ms: 100, speaker: '1', is_audio_event: false },
      { text: '[noise]', start_ms: 100, end_ms: 200, speaker: '1', is_audio_event: true },
      { text: ' world', start_ms: 200, end_ms: 300, speaker: '1', is_audio_event: false },
    ];
    const t = parseSonioxTokens(tokens, META);
    expect(t.speakers[0]!.segments).toEqual([
      { start: 0, end: 0.3, text: 'hello world' },
    ]);
  });

  it('aggregates tokens without speaker into Speaker 0', () => {
    const tokens: SonioxToken[] = [
      { text: 'orphan', start_ms: 0, end_ms: 100, speaker: null, is_audio_event: false },
      { text: ' unknown', start_ms: 100, end_ms: 200, speaker: '', is_audio_event: false },
      { text: 'A', start_ms: 200, end_ms: 300, speaker: '1', is_audio_event: false },
    ];
    const t = parseSonioxTokens(tokens, META);
    expect(t.speakers.map((s) => s.name)).toEqual(['Speaker 0', 'Speaker 1']);
  });

  it('preserves leading-space convention from Soniox tokens', () => {
    const tokens: SonioxToken[] = [
      { text: ' Hello', start_ms: 0, end_ms: 100, speaker: '1', is_audio_event: false },
      { text: ' world', start_ms: 100, end_ms: 200, speaker: '1', is_audio_event: false },
    ];
    const t = parseSonioxTokens(tokens, META);
    expect(t.speakers[0]!.segments[0]!.text).toBe(' Hello world');
  });

  it('produces metadata.duration = lastTokenEndMs / 1000 (rounded to 2 decimals)', () => {
    const tokens: SonioxToken[] = [
      { text: 'a', start_ms: 100, end_ms: 234, speaker: '1', is_audio_event: false },
      { text: 'b', start_ms: 240, end_ms: 1567, speaker: '1', is_audio_event: false },
    ];
    const t = parseSonioxTokens(tokens, META);
    expect(t.metadata.duration).toBe(1.57);
  });

  it('returns empty speakers array when all tokens are audio events', () => {
    const tokens: SonioxToken[] = [
      { text: '[noise]', start_ms: 0, end_ms: 100, speaker: '1', is_audio_event: true },
      { text: '[music]', start_ms: 100, end_ms: 200, speaker: '2', is_audio_event: true },
    ];
    const t = parseSonioxTokens(tokens, META);
    expect(t.speakers).toHaveLength(0);
  });

  it('passes TranscriptSchema validation on real Soniox fixture (audio1663213769)', () => {
    const fixture = JSON.parse(
      readFileSync(join(ROOT, 'data/soniox-results/audio1663213769.m4a.json'), 'utf8'),
    );
    const meta = {
      clientId: 'geonline',
      meetingDate: '2026-03-15T10:00:00.000Z',
      meetingType: 'tracking_session',
    };
    const result = parseSonioxTokens(fixture.tokens, meta);
    expect(() => TranscriptSchema.parse(result)).not.toThrow();
    expect(result.speakers.length).toBeGreaterThanOrEqual(1);
  });

  it('produces speaker segments with monotonically increasing start times', () => {
    const fixture = JSON.parse(
      readFileSync(join(ROOT, 'data/soniox-results/audio1663213769.m4a.json'), 'utf8'),
    );
    const result = parseSonioxTokens(fixture.tokens, META);
    for (const speaker of result.speakers) {
      for (let i = 1; i < speaker.segments.length; i++) {
        expect(speaker.segments[i]!.start).toBeGreaterThanOrEqual(speaker.segments[i - 1]!.start);
      }
    }
  });

  it('produces segments where start <= end', () => {
    const fixture = JSON.parse(
      readFileSync(join(ROOT, 'data/soniox-results/audio1663213769.m4a.json'), 'utf8'),
    );
    const result = parseSonioxTokens(fixture.tokens, META);
    for (const speaker of result.speakers) {
      for (const seg of speaker.segments) {
        expect(seg.start).toBeLessThanOrEqual(seg.end);
      }
    }
  });
});

describe('parsePlainText', () => {
  it('extracts speaker turns from "Спикер N: ..." pattern', () => {
    const text = [
      'Спикер 1: Привет, как дела?',
      'Спикер 2: Хорошо, спасибо.',
      'Спикер 1: Отлично, поехали.',
    ].join('\n');
    const t = parsePlainText(text, META);
    expect(t.speakers.map((s) => s.name)).toEqual(['Speaker 1', 'Speaker 2']);
  });

  it('falls back to single Speaker 1 segment when no pattern detected', () => {
    const text = 'Просто текст без маркеров спикеров. И ещё немного.';
    const t = parsePlainText(text, META);
    expect(t.speakers).toHaveLength(1);
    expect(t.speakers[0]!.name).toBe('Speaker 1');
    expect(t.speakers[0]!.segments).toHaveLength(1);
  });

  it('produces start=end=0 for plain-text segments', () => {
    const t = parsePlainText('Спикер 1: один\nСпикер 2: два', META);
    for (const sp of t.speakers) {
      for (const seg of sp.segments) {
        expect(seg.start).toBe(0);
        expect(seg.end).toBe(0);
      }
    }
  });

  it('sets metadata.duration = 0 for plain-text', () => {
    const t = parsePlainText('Спикер 1: hello', META);
    expect(t.metadata.duration).toBe(0);
  });

  it('throws TranscriptValidationError("empty") when text is blank/whitespace-only', () => {
    let err: unknown;
    try {
      parsePlainText('   \n  \n', META);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(TranscriptValidationError);
    expect((err as TranscriptValidationError).code).toBe('empty');
  });
});

describe('transcribeFromPlainText', () => {
  it('throws too_short for text shorter than 200 chars', async () => {
    await expect(transcribeFromPlainText('Слишком коротко.', META)).rejects.toBeInstanceOf(
      TranscriptValidationError,
    );
  });

  it('returns a validated Transcript for sufficiently long text', async () => {
    const text =
      'Спикер 1: ' +
      'Это длинный фрагмент текста для теста plain-text fallback. '.repeat(10);
    const result = await transcribeFromPlainText(text, META);
    expect(result.speakers.length).toBeGreaterThanOrEqual(1);
    expect(result.metadata.duration).toBe(0);
  });
});

describe('transcribeFromUrl — error routing (config vs user-facing)', () => {
  let alertOpsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    alertOpsSpy = vi.spyOn(ops, 'alertOps').mockImplementation(() => {});
  });

  afterEach(() => {
    alertOpsSpy.mockRestore();
  });

  const stubSonioxClient = () => ({
    uploadFile: vi.fn().mockResolvedValue('file-id'),
    createTranscription: vi.fn().mockResolvedValue('tx-id'),
    pollUntilCompleted: vi.fn().mockResolvedValue(undefined),
    fetchTranscript: vi.fn().mockResolvedValue({ id: 'tx', text: '', tokens: [] }),
    deleteFile: vi.fn().mockResolvedValue(undefined),
  });

  it('calls alertOps on TranscriptConfigError (missing service account) and rethrows as-is', async () => {
    const downloadAudio = vi.fn().mockRejectedValue(
      new TranscriptConfigError('missing_service_account', { path: './missing.json' }),
    );
    await expect(
      transcribeFromUrl('https://drive.google.com/file/d/x/view', META, {
        downloadAudio,
        sonioxClient: stubSonioxClient(),
      }),
    ).rejects.toBeInstanceOf(TranscriptConfigError);
    expect(alertOpsSpy).toHaveBeenCalledTimes(1);
    const payload = alertOpsSpy.mock.calls[0]![0] as { pipeline: string; step: string; error: unknown };
    expect(payload.pipeline).toBe('F1');
    expect(payload.step).toBe('transcript');
    expect(payload.error).toBeInstanceOf(TranscriptConfigError);
  });

  it('does NOT call alertOps on TranscriptDownloadError (user-facing)', async () => {
    const downloadAudio = vi.fn().mockRejectedValue(
      new TranscriptDownloadError('not_found', {
        url: 'https://drive.google.com/file/d/x/view',
        clientId: 'test',
      }),
    );
    await expect(
      transcribeFromUrl('https://drive.google.com/file/d/x/view', META, {
        downloadAudio,
        sonioxClient: stubSonioxClient(),
      }),
    ).rejects.toBeInstanceOf(TranscriptDownloadError);
    expect(alertOpsSpy).not.toHaveBeenCalled();
  });

  it('does NOT call alertOps on TranscriptValidationError (too_short)', async () => {
    await transcribeFromPlainText('short', META).catch(() => undefined);
    expect(alertOpsSpy).not.toHaveBeenCalled();
  });

  it('throws TranscriptValidationError("empty") when all Soniox tokens are audio events, calls alertOps', async () => {
    const allAudioTokens: SonioxToken[] = [
      { text: '[noise]', start_ms: 0, end_ms: 100, speaker: '1', is_audio_event: true },
    ];
    const sonioxClient = {
      ...stubSonioxClient(),
      fetchTranscript: vi.fn().mockResolvedValue({ id: 'tx', text: '', tokens: allAudioTokens }),
    };
    const downloadAudioMock = vi.fn().mockResolvedValue({
      filePath: '/tmp/test.m4a',
      sizeBytes: 100,
      provider: 'gdrive' as const,
      mimeType: 'audio/mp4',
      cleanup: vi.fn().mockResolvedValue(undefined),
    });
    const err = await transcribeFromUrl('https://drive.google.com/file/d/x/view', META, {
      sonioxClient,
      downloadAudio: downloadAudioMock,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptValidationError);
    expect((err as TranscriptValidationError).code).toBe('empty');
    expect(alertOpsSpy).toHaveBeenCalledTimes(1);
  });
});

describe('TranscriptMetadataSchema — strict ISO-8601', () => {
  it('rejects metadata.date = "unknown"', () => {
    const bad = {
      speakers: [{ name: 'Speaker 1', segments: [{ start: 0, end: 1, text: 'x' }] }],
      metadata: { date: 'unknown', duration: 1, meeting_type: 'tracking_session' },
    };
    expect(() => TranscriptSchema.parse(bad)).toThrow();
  });

  it('rejects metadata.date as date-only (no time component)', () => {
    const bad = {
      speakers: [{ name: 'Speaker 1', segments: [{ start: 0, end: 1, text: 'x' }] }],
      metadata: { date: '2026-04-22', duration: 1, meeting_type: 'tracking_session' },
    };
    expect(() => TranscriptSchema.parse(bad)).toThrow();
  });

  it('accepts valid ISO-8601 with Z suffix', () => {
    const ok = {
      speakers: [{ name: 'Speaker 1', segments: [{ start: 0, end: 1, text: 'x' }] }],
      metadata: { date: '2026-04-22T10:00:00.000Z', duration: 1, meeting_type: 'tracking_session' },
    };
    expect(() => TranscriptSchema.parse(ok)).not.toThrow();
  });

  it('accepts valid ISO-8601 with timezone offset', () => {
    const ok = {
      speakers: [{ name: 'Speaker 1', segments: [{ start: 0, end: 1, text: 'x' }] }],
      metadata: { date: '2026-04-22T10:00:00+05:00', duration: 1, meeting_type: 'tracking_session' },
    };
    expect(() => TranscriptSchema.parse(ok)).not.toThrow();
  });
});
