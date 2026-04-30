import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import type { Logger } from '../logger.js';
import { withRetry, shouldRetryPreBodyOnly } from '../utils/retry.js';
import { TranscriptProviderError } from '../errors.js';

const DEFAULT_BASE_URL = 'https://api.soniox.com/v1';
const SONIOX_BASE_URL = config.SONIOX_API_URL ?? DEFAULT_BASE_URL;
const MODEL = 'stt-async-v4';
const FETCH_TIMEOUT_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120;
const LARGE_FILE_WARN_BYTES = 100 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

export const SonioxTokenSchema = z.object({
  text: z.string(),
  start_ms: z.number().nonnegative(),
  end_ms: z.number().nonnegative(),
  confidence: z.number().nullable().optional(),
  speaker: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  is_audio_event: z.boolean().nullable().optional(),
  translation_status: z.string().nullable().optional(),
});

export const SonioxTranscriptSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  tokens: z.array(SonioxTokenSchema),
});

export type SonioxToken = z.infer<typeof SonioxTokenSchema>;
export type SonioxTranscript = z.infer<typeof SonioxTranscriptSchema>;

const SonioxStatusSchema = z.object({
  id: z.string(),
  status: z.string(),
  error_message: z.string().nullable().optional(),
});

const SonioxFileSchema = z.object({
  id: z.string().min(1),
  filename: z.string().nullable().optional(),
});

const KNOWN_PENDING_STATUSES = new Set(['queued', 'processing']);

export interface SonioxClient {
  uploadFile(filePath: string): Promise<string>;
  createTranscription(fileId: string): Promise<string>;
  pollUntilCompleted(transcriptionId: string): Promise<void>;
  fetchTranscript(transcriptionId: string): Promise<SonioxTranscript>;
  deleteFile(fileId: string): Promise<void>;
}

interface SonioxClientOptions {
  logger: Logger;
  apiKey?: string;
  baseUrl?: string;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

class HttpError extends Error {
  public readonly httpStatus: number;
  public readonly bodySnippet: string;

  constructor(method: string, path: string, status: number, body: string) {
    super(`Soniox ${method} ${path} → ${status}: ${body.slice(0, 200)}`);
    this.name = 'HttpError';
    this.httpStatus = status;
    this.bodySnippet = body.slice(0, 500);
  }
}

function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createSonioxClient(options: SonioxClientOptions): SonioxClient {
  const apiKey = options.apiKey ?? config.SONIOX_API_KEY;
  const baseUrl = options.baseUrl ?? SONIOX_BASE_URL;
  const pollInterval = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const maxPollAttempts = options.maxPollAttempts ?? MAX_POLL_ATTEMPTS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.logger.child({ component: 'soniox' });

  async function request<T>(
    method: string,
    path: string,
    init: { body?: BodyInit; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      ...(init.headers ?? {}),
    };

    const response = await fetchImpl(url, {
      method,
      headers,
      body: init.body,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new HttpError(method, path, response.status, body);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async function uploadFile(filePath: string): Promise<string> {
    const start = Date.now();
    let fileId: string | undefined;
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_UPLOAD_BYTES) {
        throw new TranscriptProviderError('upload_failed', {
          reason: 'file_too_large',
          sizeBytes: fileStat.size,
          limitBytes: MAX_UPLOAD_BYTES,
          filePath,
        });
      }

      const filename = basename(filePath);
      if (fileStat.size >= LARGE_FILE_WARN_BYTES) {
        log.warn(
          { step: 'soniox.uploadFile', sizeBytes: fileStat.size, filePath: basename(filePath) },
          'large file load: будет занято > 100 MB RAM (ограничение 500 MB)',
        );
      }
      const buffer = await readFile(filePath);
      const fileBlob = new Blob([buffer]);

      const form = new FormData();
      form.append('file', fileBlob, filename);

      const result = await withRetry(
        () => request<unknown>('POST', '/files', { body: form }),
        { logger: log, shouldRetry: shouldRetryPreBodyOnly },
      );
      const parsed = SonioxFileSchema.safeParse(result);
      if (!parsed.success) {
        throw new TranscriptProviderError('invalid_response', {
          step: 'uploadFile',
          issues: parsed.error.issues,
        });
      }
      fileId = parsed.data.id;
      return fileId;
    } catch (err) {
      if (err instanceof HttpError && isAuthStatus(err.httpStatus)) {
        throw new TranscriptProviderError('auth', { step: 'uploadFile', httpStatus: err.httpStatus }, { cause: err });
      }
      if (err instanceof TranscriptProviderError) throw err;
      throw new TranscriptProviderError(
        'upload_failed',
        { step: 'uploadFile', message: err instanceof Error ? err.message : String(err) },
        { cause: err },
      );
    } finally {
      log.info({ step: 'soniox.uploadFile', durationMs: Date.now() - start, fileId }, 'soniox call');
    }
  }

  async function createTranscription(fileId: string): Promise<string> {
    const start = Date.now();
    let transcriptionId: string | undefined;
    try {
      const body: Record<string, unknown> = {
        file_id: fileId,
        model: MODEL,
        enable_speaker_diarization: true,
        enable_language_identification: true,
        language_hints: ['ru', 'kk'],
      };
      const result = await withRetry(
        () =>
          request<unknown>('POST', '/transcriptions', {
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' },
          }),
        { logger: log, shouldRetry: shouldRetryPreBodyOnly },
      );
      const parsed = SonioxStatusSchema.safeParse(result);
      if (!parsed.success) {
        throw new TranscriptProviderError('invalid_response', {
          step: 'createTranscription',
          issues: parsed.error.issues,
        });
      }
      transcriptionId = parsed.data.id;
      return transcriptionId;
    } catch (err) {
      if (err instanceof HttpError && isAuthStatus(err.httpStatus)) {
        throw new TranscriptProviderError('auth', { step: 'createTranscription', httpStatus: err.httpStatus }, { cause: err });
      }
      if (err instanceof TranscriptProviderError) throw err;
      throw new TranscriptProviderError(
        'transcription_failed',
        { step: 'createTranscription', fileId, message: err instanceof Error ? err.message : String(err) },
        { cause: err },
      );
    } finally {
      log.info(
        { step: 'soniox.createTranscription', durationMs: Date.now() - start, fileId, transcriptionId },
        'soniox call',
      );
    }
  }

  async function pollUntilCompleted(transcriptionId: string): Promise<void> {
    const start = Date.now();
    try {
      for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
        const status = await withRetry(
          () =>
            request<unknown>('GET', `/transcriptions/${transcriptionId}`, {
              headers: { Accept: 'application/json' },
            }),
          {
            logger: log,
            shouldRetry: (err) => {
              if (err instanceof HttpError) {
                if (isAuthStatus(err.httpStatus)) return false;
                return err.httpStatus === 429 || err.httpStatus >= 500;
              }
              return true;
            },
          },
        );

        const parsed = SonioxStatusSchema.safeParse(status);
        if (!parsed.success) {
          throw new TranscriptProviderError('invalid_response', {
            step: 'pollUntilCompleted',
            issues: parsed.error.issues,
          });
        }

        const value = parsed.data.status;
        if (value === 'completed') return;

        if (value === 'error') {
          throw new TranscriptProviderError('transcription_failed', {
            step: 'pollUntilCompleted',
            transcriptionId,
            errorMessage: parsed.data.error_message ?? 'unknown',
          });
        }

        if (!KNOWN_PENDING_STATUSES.has(value)) {
          throw new TranscriptProviderError('unknown_status', {
            step: 'pollUntilCompleted',
            transcriptionId,
            status: value,
          });
        }

        await sleep(pollInterval);
      }
      throw new TranscriptProviderError('timeout', {
        step: 'pollUntilCompleted',
        transcriptionId,
        attempts: maxPollAttempts,
      });
    } catch (err) {
      if (err instanceof HttpError && isAuthStatus(err.httpStatus)) {
        throw new TranscriptProviderError('auth', { step: 'pollUntilCompleted', httpStatus: err.httpStatus }, { cause: err });
      }
      if (err instanceof TranscriptProviderError) throw err;
      throw new TranscriptProviderError(
        'transcription_failed',
        { step: 'pollUntilCompleted', transcriptionId, message: err instanceof Error ? err.message : String(err) },
        { cause: err },
      );
    } finally {
      log.info(
        { step: 'soniox.pollUntilCompleted', durationMs: Date.now() - start, transcriptionId },
        'soniox call',
      );
    }
  }

  async function fetchTranscript(transcriptionId: string): Promise<SonioxTranscript> {
    const start = Date.now();
    try {
      const raw = await withRetry(
        () =>
          request<unknown>('GET', `/transcriptions/${transcriptionId}/transcript`, {
            headers: { Accept: 'application/json' },
          }),
        {
          logger: log,
          shouldRetry: (err) => {
            if (err instanceof HttpError) {
              if (isAuthStatus(err.httpStatus)) return false;
              return err.httpStatus === 429 || err.httpStatus >= 500;
            }
            return true;
          },
        },
      );
      const parsed = SonioxTranscriptSchema.safeParse(raw);
      if (!parsed.success) {
        throw new TranscriptProviderError('invalid_response', {
          step: 'fetchTranscript',
          transcriptionId,
          issues: parsed.error.issues,
        });
      }
      return parsed.data;
    } catch (err) {
      if (err instanceof HttpError && isAuthStatus(err.httpStatus)) {
        throw new TranscriptProviderError('auth', { step: 'fetchTranscript', httpStatus: err.httpStatus }, { cause: err });
      }
      if (err instanceof TranscriptProviderError) throw err;
      throw new TranscriptProviderError(
        'transcription_failed',
        { step: 'fetchTranscript', transcriptionId, message: err instanceof Error ? err.message : String(err) },
        { cause: err },
      );
    } finally {
      log.info(
        { step: 'soniox.fetchTranscript', durationMs: Date.now() - start, transcriptionId },
        'soniox call',
      );
    }
  }

  async function deleteFile(fileId: string): Promise<void> {
    const start = Date.now();
    try {
      await request<unknown>('DELETE', `/files/${fileId}`);
    } catch (err) {
      log.warn({ step: 'soniox.deleteFile', fileId, err }, 'soniox file cleanup failed');
    } finally {
      log.info({ step: 'soniox.deleteFile', durationMs: Date.now() - start, fileId }, 'soniox call');
    }
  }

  return { uploadFile, createTranscription, pollUntilCompleted, fetchTranscript, deleteFile };
}
