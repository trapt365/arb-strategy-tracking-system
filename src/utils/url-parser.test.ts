import { describe, it, expect } from 'vitest';
import { parseReportUrl } from './url-parser.js';

describe('parseReportUrl', () => {
  describe('missing_arg', () => {
    it('пустая строка → missing_arg', () => {
      expect(parseReportUrl('')).toEqual({ ok: false, reason: 'missing_arg' });
    });

    it('строка с пробелами → missing_arg', () => {
      expect(parseReportUrl('   ')).toEqual({ ok: false, reason: 'missing_arg' });
    });

    it('undefined → missing_arg', () => {
      expect(parseReportUrl(undefined)).toEqual({ ok: false, reason: 'missing_arg' });
    });

    it('null → missing_arg', () => {
      expect(parseReportUrl(null)).toEqual({ ok: false, reason: 'missing_arg' });
    });
  });

  describe('invalid_url', () => {
    it('not-a-url → invalid_url', () => {
      expect(parseReportUrl('not-a-url')).toEqual({ ok: false, reason: 'invalid_url' });
    });

    it('http:// без хоста → invalid_url', () => {
      const res = parseReportUrl('http://');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toBe('invalid_url');
    });

    it('javascript: схема → invalid_url', () => {
      expect(parseReportUrl('javascript:alert(1)')).toEqual({ ok: false, reason: 'invalid_url' });
    });

    it('file:///etc/passwd → invalid_url', () => {
      expect(parseReportUrl('file:///etc/passwd')).toEqual({ ok: false, reason: 'invalid_url' });
    });
  });

  describe('unsupported_provider', () => {
    it('https://example.com/foo → unsupported_provider', () => {
      expect(parseReportUrl('https://example.com/foo')).toEqual({
        ok: false,
        reason: 'unsupported_provider',
      });
    });

    it('https://yandex.ru/disk → unsupported_provider', () => {
      expect(parseReportUrl('https://yandex.ru/disk')).toEqual({
        ok: false,
        reason: 'unsupported_provider',
      });
    });

    it('https://google.com → unsupported_provider (drive не google)', () => {
      expect(parseReportUrl('https://google.com/foo')).toEqual({
        ok: false,
        reason: 'unsupported_provider',
      });
    });
  });

  describe('ok', () => {
    it('drive.google.com → ok', () => {
      const res = parseReportUrl('https://drive.google.com/file/d/abc123/view?usp=sharing');
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.url).toContain('drive.google.com');
    });

    it('docs.google.com → ok', () => {
      const res = parseReportUrl('https://docs.google.com/document/d/xyz/edit');
      expect(res.ok).toBe(true);
    });

    it('us02web.zoom.us → ok (wildcard)', () => {
      const res = parseReportUrl('https://us02web.zoom.us/rec/share/abc');
      expect(res.ok).toBe(true);
    });

    it('zoom.us без поддомена → ok', () => {
      const res = parseReportUrl('https://zoom.us/rec/share/abc');
      expect(res.ok).toBe(true);
    });

    it('URL с пробелами → trim → ok', () => {
      const res = parseReportUrl('  https://drive.google.com/file/d/abc/view  ');
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.url.startsWith(' ')).toBe(false);
    });

    it('http (не https) → ok если хост в whitelist', () => {
      const res = parseReportUrl('http://drive.google.com/file/d/abc');
      expect(res.ok).toBe(true);
    });
  });
});
