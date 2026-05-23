import { describe, it, expect } from 'vitest';
import {
  assertClientId,
  ClientIdError,
  parseClientIdFromPath,
  slugifyClientId,
} from './client-id.js';

describe('slugifyClientId', () => {
  it('lowercases', () => {
    expect(slugifyClientId('Geonline')).toBe('geonline');
  });

  it('replaces whitespace with dashes', () => {
    expect(slugifyClientId('Test Client')).toBe('test-client');
  });

  it('trims and lowercases', () => {
    expect(slugifyClientId('  Whitespace  ')).toBe('whitespace');
  });

  it('replaces unsafe filesystem chars with underscore', () => {
    expect(slugifyClientId('Test/Client.Name')).toBe('test_client_name');
  });

  it('handles backslash and pipe', () => {
    expect(slugifyClientId('a\\b|c')).toBe('a_b_c');
  });

  it('replaces sequences of spaces with single dash, then lowercases', () => {
    expect(slugifyClientId('Test   Multiple   Spaces')).toBe('test-multiple-spaces');
  });
});

describe('assertClientId', () => {
  it('accepts valid clientId', () => {
    expect(() => assertClientId('geonline')).not.toThrow();
  });

  it('accepts whitelisted clientId', () => {
    expect(() =>
      assertClientId('geonline', { allowed: new Set(['geonline']) }),
    ).not.toThrow();
  });

  it('throws on non-string', () => {
    expect(() => assertClientId(undefined)).toThrow(ClientIdError);
    expect(() => assertClientId(null)).toThrow(ClientIdError);
    expect(() => assertClientId(42)).toThrow(ClientIdError);
  });

  it('throws on empty string', () => {
    try {
      assertClientId('');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ClientIdError);
      expect((err as ClientIdError).reason).toBe('empty');
    }
  });

  it('throws on whitespace-only string', () => {
    try {
      assertClientId('   ');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ClientIdError);
      expect((err as ClientIdError).reason).toBe('empty');
    }
  });

  it('throws on path-traversal attempt', () => {
    try {
      assertClientId('../etc/passwd');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ClientIdError);
      expect((err as ClientIdError).reason).toBe('invalid_chars');
    }
  });

  it('throws on slash', () => {
    try {
      assertClientId('a/b');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ClientIdError);
      expect((err as ClientIdError).reason).toBe('invalid_chars');
    }
  });

  it('throws on backslash', () => {
    try {
      assertClientId('a\\b');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ClientIdError);
      expect((err as ClientIdError).reason).toBe('invalid_chars');
    }
  });

  it('throws on too-long input', () => {
    try {
      assertClientId('a'.repeat(65));
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ClientIdError);
      expect((err as ClientIdError).reason).toBe('too_long');
    }
  });

  it('throws on .. without slashes', () => {
    try {
      assertClientId('client..name');
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ClientIdError);
      expect((err as ClientIdError).reason).toBe('invalid_chars');
    }
  });

  it('throws when not in whitelist', () => {
    try {
      assertClientId('clientB', { allowed: new Set(['geonline']) });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ClientIdError);
      expect((err as ClientIdError).reason).toBe('not_whitelisted');
    }
  });

  it('accepts exactly 64 chars', () => {
    expect(() => assertClientId('a'.repeat(64))).not.toThrow();
  });
});

describe('parseClientIdFromPath', () => {
  it('extracts client slug from canonical path', () => {
    expect(parseClientIdFromPath('data/geonline/2026-05-22/file.json')).toBe('geonline');
  });

  it('returns null for state file paths', () => {
    expect(parseClientIdFromPath('data/.ops-state.json')).toBeNull();
    expect(parseClientIdFromPath('data/.scheduler-state.json')).toBeNull();
  });

  it('returns null for backup paths', () => {
    expect(parseClientIdFromPath('data/.backups/data-backup-2026-05-22.tar.gz')).toBeNull();
  });

  it('returns null for paths without client component', () => {
    expect(parseClientIdFromPath('data/')).toBeNull();
    expect(parseClientIdFromPath('foo/bar')).toBeNull();
  });
});
