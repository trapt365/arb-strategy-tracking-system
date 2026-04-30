import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs/promises', async () => {
  const stat = vi.fn();
  const readFile = vi.fn();
  return { stat, readFile };
});

import { stat, readFile } from 'node:fs/promises';
import {
  loadServiceAccountCredentials,
  _resetCredentialsCacheForTest,
} from './google-auth.js';
import { TranscriptConfigError } from '../errors.js';

const mockedStat = vi.mocked(stat);
const mockedReadFile = vi.mocked(readFile);

describe('loadServiceAccountCredentials', () => {
  beforeEach(() => {
    _resetCredentialsCacheForTest();
    mockedStat.mockReset();
    mockedReadFile.mockReset();
  });

  afterEach(() => {
    _resetCredentialsCacheForTest();
  });

  it('returns credentials on happy path', async () => {
    mockedStat.mockResolvedValueOnce({} as never);
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({
        client_email: 'svc@example.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----\n',
      }),
    );
    const creds = await loadServiceAccountCredentials();
    expect(creds.client_email).toBe('svc@example.iam.gserviceaccount.com');
    expect(creds.private_key).toContain('BEGIN PRIVATE KEY');
  });

  it('throws TranscriptConfigError(missing_service_account) when file is missing', async () => {
    mockedStat.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const err = await loadServiceAccountCredentials().catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptConfigError);
    expect((err as TranscriptConfigError).code).toBe('missing_service_account');
  });

  it('throws TranscriptConfigError(invalid_service_account_json) on bad JSON', async () => {
    mockedStat.mockResolvedValueOnce({} as never);
    mockedReadFile.mockResolvedValueOnce('not-json');
    const err = await loadServiceAccountCredentials().catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptConfigError);
    expect((err as TranscriptConfigError).code).toBe('invalid_service_account_json');
  });

  it('throws TranscriptConfigError(invalid_service_account_shape) when client_email is missing', async () => {
    mockedStat.mockResolvedValueOnce({} as never);
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({ private_key: 'KEY' }),
    );
    const err = await loadServiceAccountCredentials().catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptConfigError);
    expect((err as TranscriptConfigError).code).toBe('invalid_service_account_shape');
    expect((err as TranscriptConfigError).context.missingFields).toEqual(['client_email']);
  });

  it('throws TranscriptConfigError(invalid_service_account_shape) when both fields are missing', async () => {
    mockedStat.mockResolvedValueOnce({} as never);
    mockedReadFile.mockResolvedValueOnce(JSON.stringify({}));
    const err = await loadServiceAccountCredentials().catch((e) => e);
    expect(err).toBeInstanceOf(TranscriptConfigError);
    expect((err as TranscriptConfigError).code).toBe('invalid_service_account_shape');
    expect((err as TranscriptConfigError).context.missingFields).toEqual([
      'client_email',
      'private_key',
    ]);
  });

  it('memoizes successful load — second call does not perform I/O', async () => {
    mockedStat.mockResolvedValueOnce({} as never);
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({ client_email: 'svc@example.com', private_key: 'KEY' }),
    );
    await loadServiceAccountCredentials();
    await loadServiceAccountCredentials();
    expect(mockedStat).toHaveBeenCalledTimes(1);
    expect(mockedReadFile).toHaveBeenCalledTimes(1);
  });

  it('does not cache failed result — second call retries', async () => {
    mockedStat
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      .mockResolvedValueOnce({} as never);
    mockedReadFile.mockResolvedValueOnce(
      JSON.stringify({ client_email: 'svc@example.com', private_key: 'KEY' }),
    );
    await expect(loadServiceAccountCredentials()).rejects.toBeInstanceOf(TranscriptConfigError);
    const creds = await loadServiceAccountCredentials();
    expect(creds.client_email).toBe('svc@example.com');
    expect(mockedStat).toHaveBeenCalledTimes(2);
  });
});
