import { ZodError } from 'zod';
import {
  TranscriptSchema,
  type Transcript,
  type TranscriptMeta,
  type TranscriptSegment,
} from '../types.js';
import {
  TranscriptDownloadError,
  TranscriptProviderError,
  TranscriptValidationError,
  TranscriptConfigError,
} from '../errors.js';
import { logger as rootLogger } from '../logger.js';
import { alertOps } from '../ops.js';
import { createSonioxClient, type SonioxClient, type SonioxToken } from './soniox.js';
import { downloadAudio, type DownloadResult } from './drive.js';

const PLAIN_TEXT_MIN_LENGTH = 200;
const SPEAKER_LINE_RE = /^\s*(?:Спикер|Speaker)\s*(\d+)\s*[:\-—]\s*(.+)$/i;
const NAME_LINE_RE = /^\s*([A-ZА-ЯЁӨҮҚҒҢҺӘІ][\p{L}\d_.\- ]{0,40})\s*[:\-—]\s+(.+)$/u;

export {
  TranscriptDownloadError,
  TranscriptProviderError,
  TranscriptValidationError,
  TranscriptConfigError,
} from '../errors.js';
export type { Transcript, TranscriptMeta } from '../types.js';

export interface TranscribeFromUrlDeps {
  sonioxClient?: SonioxClient;
  downloadAudio?: typeof downloadAudio;
  logger?: typeof rootLogger;
}

export async function transcribeFromUrl(
  url: string,
  meta: TranscriptMeta,
  deps: TranscribeFromUrlDeps = {},
): Promise<Transcript> {
  const baseLogger = deps.logger ?? rootLogger;
  const log = baseLogger.child({ pipeline: 'F1', step: 'transcript', clientId: meta.clientId });
  const sonioxClient = deps.sonioxClient ?? createSonioxClient({ logger: log });
  const doDownload = deps.downloadAudio ?? downloadAudio;

  const totalStart = Date.now();
  let downloadMs = 0;
  let transcribeMs = 0;
  let parseMs = 0;
  let download: DownloadResult | null = null;
  let fileId: string | undefined;

  try {
    const downloadStart = Date.now();
    download = await doDownload({ url, clientId: meta.clientId, logger: log });
    downloadMs = Date.now() - downloadStart;

    const transcribeStart = Date.now();
    fileId = await sonioxClient.uploadFile(download.filePath);
    const transcriptionId = await sonioxClient.createTranscription(fileId);
    await sonioxClient.pollUntilCompleted(transcriptionId);
    const sonioxTranscript = await sonioxClient.fetchTranscript(transcriptionId);
    transcribeMs = Date.now() - transcribeStart;

    const parseStart = Date.now();
    const parsedTranscript = parseSonioxTokens(sonioxTranscript.tokens, meta, log);
    if (parsedTranscript.speakers.length === 0) {
      const emptyErr = new TranscriptValidationError('empty', { reason: 'all_tokens_filtered', url });
      alertOps({ pipeline: 'F1', step: 'transcript', clientId: meta.clientId, error: emptyErr, context: { url } });
      log.error({ pipeline: 'F1', step: 'transcript', clientId: meta.clientId }, 'transcript empty after filtering audio events');
      throw emptyErr;
    }
    let validated: Transcript;
    try {
      validated = TranscriptSchema.parse(parsedTranscript);
    } catch (err) {
      if (err instanceof ZodError) {
        alertOps({
          pipeline: 'F1',
          step: 'transcript',
          clientId: meta.clientId,
          error: err,
          context: { issues: err.issues, url },
        });
        log.error({ pipeline: 'F1', step: 'transcript', clientId: meta.clientId, validationErrors: err.issues });
        throw new TranscriptValidationError(
          'schema',
          { issues: err.issues, url },
          { cause: err },
        );
      }
      throw err;
    }
    parseMs = Date.now() - parseStart;

    return validated;
  } catch (err) {
    if (err instanceof TranscriptDownloadError) {
      log.warn(
        { step: 'transcript', clientId: meta.clientId, downloadErrorCode: err.code, httpStatus: err.context.httpStatus },
        'transcript download failed',
      );
    } else if (!(err instanceof TranscriptValidationError)) {
      alertOps({
        pipeline: 'F1',
        step: 'transcript',
        clientId: meta.clientId,
        error: err,
        context: { url, errorName: err instanceof Error ? err.name : undefined },
      });
    }
    throw err;
  } finally {
    const cleanupErrors: unknown[] = [];
    if (download) {
      await download.cleanup().catch((err: unknown) => cleanupErrors.push(err));
    }
    if (fileId) {
      await sonioxClient.deleteFile(fileId).catch((err: unknown) => cleanupErrors.push(err));
    }
    if (cleanupErrors.length > 0) {
      log.warn({ cleanupErrors }, 'cleanup errors after transcribeFromUrl');
    }
    log.info(
      {
        step: 'transcript.total',
        durationMs: Date.now() - totalStart,
        downloadMs,
        transcribeMs,
        parseMs,
      },
      'transcribeFromUrl complete',
    );
  }
}

export async function transcribeFromPlainText(
  text: string,
  meta: TranscriptMeta,
  deps: { logger?: typeof rootLogger } = {},
): Promise<Transcript> {
  const baseLogger = deps.logger ?? rootLogger;
  const log = baseLogger.child({ pipeline: 'F1', step: 'transcript', clientId: meta.clientId });
  const totalStart = Date.now();
  try {
    if (text.trim().length < PLAIN_TEXT_MIN_LENGTH) {
      throw new TranscriptValidationError('too_short', { length: text.length });
    }
    const parsed = parsePlainText(text, meta);
    try {
      return TranscriptSchema.parse(parsed);
    } catch (err) {
      if (err instanceof ZodError) {
        alertOps({
          pipeline: 'F1',
          step: 'transcript',
          clientId: meta.clientId,
          error: err,
          context: { issues: err.issues, source: 'plain_text' },
        });
        throw new TranscriptValidationError('schema', { issues: err.issues }, { cause: err });
      }
      throw err;
    }
  } finally {
    log.info(
      { step: 'transcript.total', durationMs: Date.now() - totalStart, source: 'plain_text' },
      'transcribeFromPlainText complete',
    );
  }
}

interface SegmentInProgress {
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
}

const UNKNOWN_SPEAKER = '0';

export function parseSonioxTokens(tokens: SonioxToken[], meta: TranscriptMeta, logger?: Pick<typeof rootLogger, 'warn'>): Transcript {
  let unknownCount = 0;
  let nonAudioCount = 0;
  let lastTokenEndMs = 0;
  const orderedSegments: SegmentInProgress[] = [];
  let current: SegmentInProgress | null = null;

  for (const token of tokens) {
    if (token.is_audio_event === true) continue;
    nonAudioCount++;
    const speakerRaw = token.speaker;
    const speaker = speakerRaw && speakerRaw.length > 0 ? speakerRaw : UNKNOWN_SPEAKER;
    if (!speakerRaw || speakerRaw.length === 0) unknownCount++;
    if (token.end_ms > lastTokenEndMs) lastTokenEndMs = token.end_ms;

    if (!current || current.speaker !== speaker) {
      if (current && current.text.trim().length > 0) orderedSegments.push(current);
      current = { speaker, startMs: token.start_ms, endMs: token.end_ms, text: token.text };
    } else {
      current.endMs = token.end_ms;
      current.text += token.text;
    }
  }
  if (current && current.text.trim().length > 0) orderedSegments.push(current);

  if (nonAudioCount > 0 && unknownCount / nonAudioCount > 0.1) {
    (logger ?? rootLogger).warn(
      { pipeline: 'F1', step: 'transcript.parse', unknownCount, nonAudioCount, ratio: unknownCount / nonAudioCount },
      'high ratio of tokens without speaker — possible diarization degradation',
    );
  }

  const grouped = new Map<string, TranscriptSegment[]>();
  const speakerOrder: string[] = [];
  for (const seg of orderedSegments) {
    const segOut: TranscriptSegment = {
      start: round2(seg.startMs / 1000),
      end: round2(seg.endMs / 1000),
      text: seg.text,
    };
    if (!grouped.has(seg.speaker)) {
      grouped.set(seg.speaker, []);
      speakerOrder.push(seg.speaker);
    }
    grouped.get(seg.speaker)!.push(segOut);
  }

  const speakers = speakerOrder
    .filter((id) => (grouped.get(id) ?? []).length > 0)
    .map((id) => ({
      name: `Speaker ${id}`,
      segments: grouped.get(id)!,
    }));

  return {
    speakers,
    metadata: {
      date: meta.meetingDate,
      duration: round2(lastTokenEndMs / 1000),
      meeting_type: meta.meetingType ?? 'tracking_session',
    },
  };
}

export function parsePlainText(text: string, meta: TranscriptMeta): Transcript {
  const lines = text.split(/\r?\n/);
  const buckets = new Map<string, string[]>();
  const order: string[] = [];
  let currentSpeaker: string | null = null;

  const append = (speaker: string, fragment: string): void => {
    if (!buckets.has(speaker)) {
      buckets.set(speaker, []);
      order.push(speaker);
    }
    buckets.get(speaker)!.push(fragment);
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let match = line.match(SPEAKER_LINE_RE);
    if (match) {
      currentSpeaker = `Speaker ${match[1]}`;
      append(currentSpeaker, match[2]!);
      continue;
    }
    match = line.match(NAME_LINE_RE);
    if (match) {
      currentSpeaker = match[1]!.trim();
      append(currentSpeaker, match[2]!);
      continue;
    }
    if (currentSpeaker) {
      append(currentSpeaker, line);
    } else {
      append('Speaker 1', line);
      currentSpeaker = 'Speaker 1';
    }
  }

  if (order.length === 0) {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new TranscriptValidationError('empty', { reason: 'blank_text' });
    }
    order.push('Speaker 1');
    buckets.set('Speaker 1', [trimmed]);
  }

  const speakers = order.map((name) => ({
    name,
    segments: [
      {
        start: 0,
        end: 0,
        text: buckets.get(name)!.join(' ').trim(),
      },
    ],
  }));

  return {
    speakers,
    metadata: {
      date: meta.meetingDate,
      duration: 0,
      meeting_type: meta.meetingType ?? 'tracking_session',
    },
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
