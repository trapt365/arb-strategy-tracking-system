/**
 * Story 1.10: client-id defense-in-depth.
 *
 * Единая точка для всех clientId-операций. Каждая граница (bot, persist, sheets,
 * delivery) вызывает assertClientId перед использованием — fail-fast при path
 * traversal или невалидном вводе. slugifyClientId производит filesystem-safe имя
 * для path-join.
 */

export type ClientIdReason = 'empty' | 'too_long' | 'invalid_chars' | 'not_whitelisted';

export class ClientIdError extends Error {
  public readonly reason: ClientIdReason;
  public readonly clientId: string;

  constructor(reason: ClientIdReason, clientId: string) {
    super(`ClientIdError:${reason}:${clientId.slice(0, 20)}`);
    this.name = 'ClientIdError';
    this.reason = reason;
    this.clientId = clientId;
  }
}

const MAX_LEN = 64;
const INVALID_RAW_RE = /[/\\<>:"|?*]/;

export interface AssertClientIdOpts {
  allowed?: ReadonlySet<string>;
}

export function assertClientId(
  clientId: unknown,
  opts: AssertClientIdOpts = {},
): asserts clientId is string {
  if (typeof clientId !== 'string') {
    throw new ClientIdError('empty', String(clientId));
  }
  const trimmed = clientId.trim();
  if (trimmed.length === 0) {
    throw new ClientIdError('empty', clientId);
  }
  if (trimmed.length > MAX_LEN) {
    throw new ClientIdError('too_long', clientId);
  }
  if (INVALID_RAW_RE.test(trimmed)) {
    throw new ClientIdError('invalid_chars', clientId);
  }
  if (trimmed.includes('..')) {
    throw new ClientIdError('invalid_chars', clientId);
  }
  if (opts.allowed && !opts.allowed.has(trimmed)) {
    throw new ClientIdError('not_whitelisted', clientId);
  }
}

export function slugifyClientId(clientId: string): string {
  return clientId.trim().toLowerCase().replace(/\s+/g, '-').replace(/[\\/<>:"|?*.]/g, '_');
}

const PATH_RE = /^data\/([a-z0-9][a-z0-9_-]*)\//;

export function parseClientIdFromPath(p: string): string | null {
  const match = PATH_RE.exec(p);
  return match ? match[1]! : null;
}
