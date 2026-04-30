import { describe, it, expect, vi } from 'vitest';
import { withRetry, defaultShouldRetry, shouldRetryPreBodyOnly } from './retry.js';

describe('withRetry', () => {
  it('returns the result on first successful attempt without retry', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable errors and eventually succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { httpStatus: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { httpStatus: 503 }))
      .mockResolvedValueOnce('ok');

    const result = await withRetry(fn, { sleep, backoffMs: [1, 3, 9] });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 1);
    expect(sleep).toHaveBeenNthCalledWith(2, 3);
  });

  it('does not retry on auth errors (401/403)', async () => {
    const sleep = vi.fn();
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('unauthorized'), { httpStatus: 401 }));
    await expect(withRetry(fn, { sleep })).rejects.toThrow('unauthorized');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rethrows after exhausting retries', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const err = Object.assign(new Error('persistent'), { httpStatus: 500 });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetry(fn, { sleep, backoffMs: [1, 1, 1] })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('uses exponential backoff sequence {1000, 3000, 9000} by default', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('e'), { httpStatus: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error('e'), { httpStatus: 500 }))
      .mockRejectedValueOnce(Object.assign(new Error('e'), { httpStatus: 500 }))
      .mockResolvedValueOnce('ok');
    await withRetry(fn, { sleep });
    expect(sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(sleep).toHaveBeenNthCalledWith(2, 3000);
    expect(sleep).toHaveBeenNthCalledWith(3, 9000);
  });
});

describe('defaultShouldRetry', () => {
  it('retries on HTTP 5xx', () => {
    expect(defaultShouldRetry({ httpStatus: 500 })).toBe(true);
    expect(defaultShouldRetry({ httpStatus: 503 })).toBe(true);
  });

  it('retries on HTTP 429', () => {
    expect(defaultShouldRetry({ httpStatus: 429 })).toBe(true);
  });

  it('does not retry on HTTP 4xx (except 429)', () => {
    expect(defaultShouldRetry({ httpStatus: 400 })).toBe(false);
    expect(defaultShouldRetry({ httpStatus: 401 })).toBe(false);
    expect(defaultShouldRetry({ httpStatus: 403 })).toBe(false);
    expect(defaultShouldRetry({ httpStatus: 404 })).toBe(false);
  });

  it('retries on transient network errors', () => {
    const err = Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    expect(defaultShouldRetry(err)).toBe(true);
  });

  it('retries on AbortError / TimeoutError', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    expect(defaultShouldRetry(abort)).toBe(true);
    expect(defaultShouldRetry(timeout)).toBe(true);
  });
});

describe('shouldRetryPreBodyOnly (non-idempotent POST safety)', () => {
  it('retries on DNS errors before body sent (ENOTFOUND, EAI_AGAIN)', () => {
    expect(shouldRetryPreBodyOnly(Object.assign(new Error('dns fail'), { code: 'ENOTFOUND' }))).toBe(true);
    expect(shouldRetryPreBodyOnly(Object.assign(new Error('dns retry'), { code: 'EAI_AGAIN' }))).toBe(true);
  });

  it('retries on ECONNREFUSED (no connection established)', () => {
    expect(shouldRetryPreBodyOnly(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(true);
  });

  it('retries on TLS handshake failures', () => {
    expect(shouldRetryPreBodyOnly(Object.assign(new Error('tls bad'), { code: 'EPROTO' }))).toBe(true);
    expect(shouldRetryPreBodyOnly(Object.assign(new Error('cert expired'), { code: 'CERT_HAS_EXPIRED' }))).toBe(true);
  });

  it('does NOT retry on HTTP status errors (body already sent)', () => {
    expect(shouldRetryPreBodyOnly({ httpStatus: 500 })).toBe(false);
    expect(shouldRetryPreBodyOnly({ httpStatus: 503 })).toBe(false);
    expect(shouldRetryPreBodyOnly({ httpStatus: 429 })).toBe(false);
    expect(shouldRetryPreBodyOnly({ httpStatus: 401 })).toBe(false);
  });

  it('does NOT retry on ECONNRESET / ETIMEDOUT (may be mid-body)', () => {
    expect(shouldRetryPreBodyOnly(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(false);
    expect(shouldRetryPreBodyOnly(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }))).toBe(false);
  });

  it('does NOT retry on AbortError', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(shouldRetryPreBodyOnly(abort)).toBe(false);
  });
});
