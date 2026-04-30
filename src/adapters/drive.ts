import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { unlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { google } from 'googleapis';
import mimeTypes from 'mime-types';
import type { Logger } from '../logger.js';
import { config } from '../config.js';
import {
  TranscriptDownloadError,
  TranscriptConfigError,
  type TranscriptDownloadCode,
} from '../errors.js';

export const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

const DRIVE_FILE_RE = /drive\.google\.com\/file\/d\/([^/?#]+)/i;
const DRIVE_UC_RE = /drive\.google\.com\/uc\?(?=[^#]*\bid=([^&]+))/i;
const ZOOM_RE = /^https?:\/\/[^/]*zoom\.us\/rec\/(download|share)\//i;

// Форматы, поддерживаемые Soniox stt-async-v4 (Story 0.1 валидация). Любой mime
// вне этого списка отвергается на границе download → user получает
// TranscriptDownloadError('unsupported_format') вместо opaque provider-ошибки.
const SUPPORTED_MIME_TYPES = new Set([
  'audio/aac',
  'audio/aiff',
  'audio/amr',
  'audio/x-amr',
  'audio/flac',
  'audio/x-flac',
  'audio/mpeg',
  'audio/mp3',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'audio/mp4',
  'audio/x-m4a',
  'audio/m4a',
  'video/mp4',
  'video/webm',
  'video/x-ms-asf',
  'application/ogg',
]);

const MIME_TO_EXT_OVERRIDES: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/webm': 'webm',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/aac': 'aac',
  'audio/aiff': 'aiff',
  'audio/ogg': 'ogg',
  'audio/amr': 'amr',
  'audio/x-amr': 'amr',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-ms-asf': 'asf',
  'application/ogg': 'ogg',
};

function normalizeMime(mime: string): string {
  return mime.toLowerCase().split(';')[0]!.trim();
}

function isSupportedMime(mime: string): boolean {
  return SUPPORTED_MIME_TYPES.has(normalizeMime(mime));
}

export interface DownloadResult {
  filePath: string;
  sizeBytes: number;
  provider: 'gdrive' | 'zoom';
  mimeType: string;
  cleanup: () => Promise<void>;
}

interface DownloadOptions {
  url: string;
  clientId: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  driveClientFactory?: typeof createDriveClient;
}

export async function downloadAudio(opts: DownloadOptions): Promise<DownloadResult> {
  const log = opts.logger.child({ component: 'drive' });
  const start = Date.now();
  const driveMatch = opts.url.match(DRIVE_FILE_RE) ?? opts.url.match(DRIVE_UC_RE);
  if (driveMatch) {
    const fileId = driveMatch[1]!;
    const result = await downloadFromGoogleDrive({ ...opts, fileId, logger: log });
    log.info(
      { step: 'drive.download', durationMs: Date.now() - start, sizeBytes: result.sizeBytes, provider: 'gdrive' },
      'download complete',
    );
    return result;
  }

  if (ZOOM_RE.test(opts.url)) {
    const result = await downloadFromZoom({ ...opts, logger: log });
    log.info(
      { step: 'drive.download', durationMs: Date.now() - start, sizeBytes: result.sizeBytes, provider: 'zoom' },
      'download complete',
    );
    return result;
  }

  throw new TranscriptDownloadError('not_found', { url: redactUrl(opts.url), clientId: opts.clientId });
}

interface DriveDownloadOpts extends DownloadOptions {
  fileId: string;
}

async function downloadFromGoogleDrive(opts: DriveDownloadOpts): Promise<DownloadResult> {
  const factory = opts.driveClientFactory ?? createDriveClient;
  const drive = factory();

  let mimeType: string;
  let sizeBytes: number;
  try {
    const meta = await drive.files.get({
      fileId: opts.fileId,
      fields: 'mimeType,size,name',
      supportsAllDrives: true,
    });
    mimeType = (meta.data.mimeType as string | undefined) ?? 'application/octet-stream';
    sizeBytes = Number(meta.data.size ?? 0);
  } catch (err) {
    throw mapDriveError(err, opts);
  }

  if (!isSupportedMime(mimeType)) {
    throw new TranscriptDownloadError('unsupported_format', {
      url: redactUrl(opts.url),
      clientId: opts.clientId,
    });
  }

  if (sizeBytes > MAX_DOWNLOAD_BYTES) {
    throw new TranscriptDownloadError('file_too_large', {
      url: redactUrl(opts.url),
      clientId: opts.clientId,
    });
  }

  const ext = pickExtension(mimeType, opts.url);
  const filePath = makeTempPath(ext);

  let downloaded = 0;
  try {
    const response = await drive.files.get(
      { fileId: opts.fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'stream' },
    );
    const stream = response.data as Readable;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), DOWNLOAD_TIMEOUT_MS);
    timer.unref?.();

    stream.on('data', (chunk: Buffer) => {
      downloaded += chunk.length;
      if (downloaded > MAX_DOWNLOAD_BYTES) {
        ac.abort();
      }
    });

    try {
      await pipeline(stream, createWriteStream(filePath), { signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }

    if (downloaded > MAX_DOWNLOAD_BYTES) {
      await safeUnlink(filePath);
      throw new TranscriptDownloadError('file_too_large', {
        url: redactUrl(opts.url),
        clientId: opts.clientId,
      });
    }
  } catch (err) {
    await safeUnlink(filePath);
    if (err instanceof TranscriptDownloadError) throw err;
    if (isAbortError(err)) {
      throw new TranscriptDownloadError(
        'timeout',
        { url: redactUrl(opts.url), clientId: opts.clientId },
        { cause: err },
      );
    }
    throw mapDriveError(err, opts);
  }

  return {
    filePath,
    sizeBytes: downloaded,
    provider: 'gdrive',
    mimeType,
    cleanup: () => safeUnlink(filePath),
  };
}

async function downloadFromZoom(opts: DownloadOptions): Promise<DownloadResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(opts.url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw new TranscriptDownloadError(
        'timeout',
        { url: redactUrl(opts.url), clientId: opts.clientId },
        { cause: err },
      );
    }
    throw new TranscriptDownloadError(
      'network',
      { url: redactUrl(opts.url), clientId: opts.clientId },
      { cause: err },
    );
  }

  if (!response.ok) {
    throw mapZoomHttpStatus(response.status, opts);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const normalized = normalizeMime(contentType);

  if (!isSupportedMime(contentType)) {
    // Zoom вернул HTML/JSON/login-page (не audio/*/video/*) → требуется auth.
    // Если content-type audio/*|video/* но не в allowlist (напр. audio/wma) → unsupported_format.
    if (!normalized.startsWith('audio/') && !normalized.startsWith('video/')) {
      throw new TranscriptDownloadError('zoom_auth_required', {
        url: redactUrl(opts.url),
        clientId: opts.clientId,
        httpStatus: response.status,
      });
    }
    throw new TranscriptDownloadError('unsupported_format', {
      url: redactUrl(opts.url),
      clientId: opts.clientId,
      httpStatus: response.status,
    });
  }

  const declaredSize = Number(response.headers.get('content-length') ?? 0);
  if (declaredSize > MAX_DOWNLOAD_BYTES) {
    throw new TranscriptDownloadError('file_too_large', {
      url: redactUrl(opts.url),
      clientId: opts.clientId,
    });
  }

  const ext = pickExtension(contentType, opts.url);
  const filePath = makeTempPath(ext);

  if (!response.body) {
    throw new TranscriptDownloadError('network', { url: redactUrl(opts.url), clientId: opts.clientId });
  }

  let downloaded = 0;
  const sink = createWriteStream(filePath);
  try {
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let nextProgressMark = 50 * 1024 * 1024;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      downloaded += value.length;
      if (downloaded > MAX_DOWNLOAD_BYTES) {
        sink.destroy();
        await safeUnlink(filePath);
        throw new TranscriptDownloadError('file_too_large', {
          url: redactUrl(opts.url),
          clientId: opts.clientId,
        });
      }
      if (downloaded >= nextProgressMark) {
        opts.logger.debug?.({ step: 'drive.zoom.progress', downloadedBytes: downloaded });
        nextProgressMark += 50 * 1024 * 1024;
      }
      if (!sink.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => sink.once('drain', resolve));
      }
    }
    await new Promise<void>((resolve, reject) => {
      sink.end(() => resolve());
      sink.once('error', reject);
    });
  } catch (err) {
    if (!sink.destroyed) sink.destroy();
    await safeUnlink(filePath);
    if (err instanceof TranscriptDownloadError) throw err;
    if (isAbortError(err)) {
      throw new TranscriptDownloadError(
        'timeout',
        { url: redactUrl(opts.url), clientId: opts.clientId },
        { cause: err },
      );
    }
    throw new TranscriptDownloadError(
      'network',
      { url: redactUrl(opts.url), clientId: opts.clientId },
      { cause: err },
    );
  }

  return {
    filePath,
    sizeBytes: downloaded,
    provider: 'zoom',
    mimeType: contentType,
    cleanup: () => safeUnlink(filePath),
  };
}

function makeTempPath(ext: string): string {
  const dotExt = ext.startsWith('.') ? ext : `.${ext}`;
  return join(tmpdir(), `strategy-tracking-${randomUUID()}${dotExt}`);
}

function pickExtension(mimeType: string, url: string): string {
  const lower = normalizeMime(mimeType);
  if (MIME_TO_EXT_OVERRIDES[lower]) return MIME_TO_EXT_OVERRIDES[lower]!;
  const fromLib = mimeTypes.extension(lower);
  if (fromLib) return fromLib;
  const urlExt = url.match(/\.([a-z0-9]{2,5})(?:\?|#|$)/i)?.[1];
  return urlExt?.toLowerCase() ?? 'bin';
}

function mapZoomHttpStatus(status: number, opts: DownloadOptions): TranscriptDownloadError {
  let code: TranscriptDownloadCode = 'network';
  if (status === 401 || status === 403) code = 'access_denied';
  else if (status === 404) code = 'not_found';
  else if (status === 429) code = 'rate_limited';
  return new TranscriptDownloadError(code, {
    url: redactUrl(opts.url),
    clientId: opts.clientId,
    httpStatus: status,
  });
}

function mapDriveError(err: unknown, opts: DownloadOptions): TranscriptDownloadError {
  const rawCode = (err as { code?: unknown; response?: { status?: number } })?.code
    ?? (err as { response?: { status?: number } })?.response?.status;
  const status =
    typeof rawCode === 'number' ? rawCode :
    typeof rawCode === 'string' ? Number(rawCode) :
    undefined;
  const httpStatus = typeof status === 'number' && !Number.isNaN(status) ? status : undefined;
  let code: TranscriptDownloadCode = 'network';
  if (httpStatus === 404) code = 'not_found';
  else if (httpStatus === 401 || httpStatus === 403) code = 'access_denied';
  return new TranscriptDownloadError(
    code,
    { url: redactUrl(opts.url), clientId: opts.clientId, httpStatus },
    { cause: err },
  );
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // ignore — temp file already removed or never created
  }
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.name === 'TimeoutError';
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return url.split('?')[0] ?? url;
  }
}

let cachedDrive: ReturnType<typeof google.drive> | null = null;

export function createDriveClient(): ReturnType<typeof google.drive> {
  if (cachedDrive) return cachedDrive;
  const path = config.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!existsSync(path)) {
    throw new TranscriptConfigError('missing_service_account', { path });
  }
  let parsed: { client_email?: unknown };
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new TranscriptConfigError(
      'invalid_service_account_json',
      { path, message: (err as Error).message },
      { cause: err },
    );
  }
  if (typeof parsed.client_email !== 'string' || parsed.client_email.length === 0) {
    throw new TranscriptConfigError('invalid_service_account_shape', {
      path,
      missingField: 'client_email',
    });
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: path,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });
  cachedDrive = google.drive({ version: 'v3', auth });
  return cachedDrive;
}

export function _resetDriveClientForTest(): void {
  cachedDrive = null;
}

export async function _readTempForTest(filePath: string): Promise<Buffer> {
  return readFile(filePath);
}
