import type { Logger } from '../logger.js';

export interface WithRetryOptions {
  maxRetries?: number;
  backoffMs?: number[];
  shouldRetry?: (error: unknown) => boolean;
  logger?: Pick<Logger, 'warn'>;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BACKOFF_MS = [1000, 3000, 9000];

export function isRetryableHttpStatus(status: number): boolean {
  if (status === 429) return true;
  return status >= 500 && status < 600;
}

export interface HttpStatusError {
  httpStatus: number;
}

function hasHttpStatus(value: unknown): value is HttpStatusError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'httpStatus' in value &&
    typeof (value as { httpStatus: unknown }).httpStatus === 'number'
  );
}

const RETRYABLE_NETWORK_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
]);

export function defaultShouldRetry(error: unknown): boolean {
  if (hasHttpStatus(error)) {
    const status = (error as HttpStatusError).httpStatus;
    if (status === 401 || status === 403) return false;
    return isRetryableHttpStatus(status);
  }
  if (error instanceof Error) {
    const code = (error as Error & { code?: string }).code;
    if (code && RETRYABLE_NETWORK_CODES.has(code)) return true;
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
    if (/fetch failed|network|socket|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(error.message)) return true;
  }
  return false;
}

// Только DNS/TLS/connection-refused ошибки ДО отправки тела запроса. Безопасно
// ретраить non-idempotent POST'ы (POST /files, POST /transcriptions), так как
// сервер ещё не получил тело — дублей не будет. Всё остальное (5xx/429/timeout/
// ECONNRESET посреди передачи тела) → fail fast, чтобы не создать дубли на
// стороне Soniox.
const PRE_BODY_NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EPROTO',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

export function shouldRetryPreBodyOnly(error: unknown): boolean {
  if (hasHttpStatus(error)) return false;
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  if (code && PRE_BODY_NETWORK_CODES.has(code)) return true;
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|\bTLS\b|certificate/i.test(error.message)) return true;
  return false;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: WithRetryOptions = {},
): Promise<T> {
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const maxRetries = opts.maxRetries ?? backoffMs.length;
  const shouldRetry = opts.shouldRetry ?? defaultShouldRetry;
  const sleep = opts.sleep ?? defaultSleep;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isLast = attempt >= maxRetries;
      if (isLast || !shouldRetry(err)) {
        throw err;
      }
      const delayMs = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 0;
      opts.logger?.warn(
        { attempt: attempt + 1, maxRetries, delayMs, err },
        'retry attempt failed, backing off',
      );
      if (delayMs > 0) await sleep(delayMs);
    }
  }
  throw lastError;
}
