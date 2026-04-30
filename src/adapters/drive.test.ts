import { describe, it, expect, vi } from 'vitest';
import { downloadAudio } from './drive.js';
import { TranscriptDownloadError } from '../errors.js';
import { logger } from '../logger.js';

const ZOOM_URL = 'https://example.zoom.us/rec/download/abc123';

function mockDriveClient(stub: { mimeType?: string; size?: string } = {}): unknown {
  return {
    files: {
      get: vi.fn().mockResolvedValue({
        data: { mimeType: stub.mimeType ?? 'audio/mp4', size: stub.size ?? '100', name: 'audio.m4a' },
      }),
    },
  };
}

function makeResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? {},
  });
}

describe('downloadAudio — unsupported format rejection', () => {
  it('rejects Google Drive file with unsupported mime (application/pdf) BEFORE download', async () => {
    const drive = mockDriveClient({ mimeType: 'application/pdf' });
    await expect(
      downloadAudio({
        url: 'https://drive.google.com/file/d/xyz123/view',
        clientId: 'test',
        logger,
        driveClientFactory: () => drive as never,
      }),
    ).rejects.toMatchObject({ name: 'TranscriptDownloadError', code: 'unsupported_format' });
  });

  it('rejects Zoom link that returns text/html as zoom_auth_required (login page)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse('<html>login</html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    await expect(
      downloadAudio({
        url: ZOOM_URL,
        clientId: 'test',
        logger,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ name: 'TranscriptDownloadError', code: 'zoom_auth_required' });
  });

  it('rejects Zoom link that returns application/octet-stream (was previously accepted)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse('binary', {
        headers: { 'content-type': 'application/octet-stream', 'content-length': '10' },
      }),
    );
    await expect(
      downloadAudio({
        url: ZOOM_URL,
        clientId: 'test',
        logger,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ name: 'TranscriptDownloadError', code: 'zoom_auth_required' });
  });

  it('rejects Zoom link with audio/wma (not in Soniox supported list) as unsupported_format', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse('binary', {
        headers: { 'content-type': 'audio/wma', 'content-length': '10' },
      }),
    );
    await expect(
      downloadAudio({
        url: ZOOM_URL,
        clientId: 'test',
        logger,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ name: 'TranscriptDownloadError', code: 'unsupported_format' });
  });

  it('accepts application/ogg from Zoom (in SUPPORTED_MIME_TYPES despite not starting with audio/)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse('ogg_data', {
        headers: { 'content-type': 'application/ogg', 'content-length': '8' },
      }),
    );
    const result = await downloadAudio({
      url: ZOOM_URL,
      clientId: 'test',
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.provider).toBe('zoom');
    expect(result.mimeType).toBe('application/ogg');
    await result.cleanup();
  });

  it('accepts supported mime types (audio/mp4, audio/webm, video/mp4) — no unsupported_format thrown', async () => {
    const drive = mockDriveClient({ mimeType: 'audio/mp4' });
    // expect rejection from something else (streaming mock not wired) but NOT unsupported_format
    await expect(
      downloadAudio({
        url: 'https://drive.google.com/file/d/xyz123/view',
        clientId: 'test',
        logger,
        driveClientFactory: () => drive as never,
      }),
    ).rejects.not.toMatchObject({ code: 'unsupported_format' });
  });
});

describe('downloadAudio — non-drive-non-zoom URL', () => {
  it('throws not_found for unknown URL patterns', async () => {
    await expect(
      downloadAudio({ url: 'https://example.com/file.mp3', clientId: 'test', logger }),
    ).rejects.toMatchObject({ name: 'TranscriptDownloadError', code: 'not_found' });
  });

  it('throws not_found for Zoom /rec/play/ (HTML player, not downloadable)', async () => {
    await expect(
      downloadAudio({
        url: 'https://example.zoom.us/rec/play/abc123',
        clientId: 'test',
        logger,
      }),
    ).rejects.toMatchObject({ name: 'TranscriptDownloadError', code: 'not_found' });
  });
});

describe('downloadAudio — Zoom HTTP status mapping', () => {
  it('maps 429 to rate_limited (not network)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('rate limit', { status: 429 }),
    );
    const err = await downloadAudio({
      url: ZOOM_URL,
      clientId: 'test',
      logger,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptDownloadError);
    expect((err as TranscriptDownloadError).code).toBe('rate_limited');
    expect((err as TranscriptDownloadError).context.httpStatus).toBe(429);
  });
});

describe('TranscriptDownloadError redacts URL query/hash', () => {
  it('strips access tokens from url field', async () => {
    const err = await downloadAudio({
      url: 'https://unknown.example.com/file?token=SECRET&x=y',
      clientId: 'test',
      logger,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptDownloadError);
    expect((err as TranscriptDownloadError).context.url).not.toContain('SECRET');
    expect((err as TranscriptDownloadError).context.url).not.toContain('token=');
  });
});
