import { describe, expect, it } from 'vitest';
import {
  decodeDocumentBuffer,
  isSupportedF0Document,
  sanitizeStrategyDocText,
  F0_MAX_DOC_CHARS,
  F0_MAX_FILE_BYTES,
} from './f0-input.js';
import { F0OnboardingError } from '../errors.js';

describe('isSupportedF0Document', () => {
  it('accepts md/markdown/txt by extension (case-insensitive)', () => {
    expect(isSupportedF0Document('OKR Framework 2026.md')).toBe(true);
    expect(isSupportedF0Document('strategy.MARKDOWN')).toBe(true);
    expect(isSupportedF0Document('notes.TXT')).toBe(true);
  });

  it('accepts text/plain mime when name has no extension', () => {
    expect(isSupportedF0Document('document', 'text/plain')).toBe(true);
    expect(isSupportedF0Document(undefined, 'text/markdown')).toBe(true);
  });

  it('accepts docx/pdf (Story 7.2)', () => {
    expect(
      isSupportedF0Document(
        'strategy.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).toBe(true);
    expect(isSupportedF0Document('strategy.pdf', 'application/pdf')).toBe(true);
  });

  it('rejects unknown types', () => {
    expect(isSupportedF0Document('archive.zip', 'application/zip')).toBe(false);
    expect(isSupportedF0Document('image.png', 'image/png')).toBe(false);
  });
});

describe('decodeDocumentBuffer', () => {
  it('decodes utf8 and strips BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# OKR', 'utf8')]);
    expect(decodeDocumentBuffer(buf, 'a.md')).toBe('# OKR');
  });

  it('rejects binary content (NUL bytes)', () => {
    const buf = Buffer.from([0x50, 0x4b, 0x00, 0x01]);
    expect(() => decodeDocumentBuffer(buf, 'a.md')).toThrowError(F0OnboardingError);
    try {
      decodeDocumentBuffer(buf, 'a.md');
    } catch (err) {
      expect((err as F0OnboardingError).code).toBe('binary_document');
    }
  });

  it('rejects empty documents', () => {
    expect(() => decodeDocumentBuffer(Buffer.from('   \n', 'utf8'), 'a.md')).toThrowError(
      F0OnboardingError,
    );
  });

  it('rejects oversized buffer before materializing a string (byte-guard)', () => {
    const buf = Buffer.alloc(F0_MAX_FILE_BYTES + 1, 0x61); // 'a'
    try {
      decodeDocumentBuffer(buf, 'big.md');
      expect.unreachable('expected throw');
    } catch (err) {
      expect((err as F0OnboardingError).code).toBe('file_too_large');
    }
  });
});

describe('sanitizeStrategyDocText', () => {
  it('strips vscode-remote TOC links keeping link text', () => {
    const junkUrl = `vscode-remote://wsl%2Bubuntu/mnt/c/Users/Timur/${'x'.repeat(200)}#heading`;
    const text = `- [Раздел 2.1 Продукт](${junkUrl})\nСодержимое раздела`;
    const out = sanitizeStrategyDocText(text, 'doc.md');
    expect(out).toContain('Раздел 2.1 Продукт');
    expect(out).not.toContain('vscode-remote');
  });

  it('strips bare vscode/file URLs', () => {
    const out = sanitizeStrategyDocText('до vscode-remote://wsl/x/y после file://tmp/z конец', 'doc.md');
    expect(out).toBe('до  после  конец');
  });

  it('keeps RU/KZ content, emoji statuses and tables intact', () => {
    const text = '| KR | Статус |\n|---|---|\n| 50 000 лид алу (ЕБТ рекордтары) | 🔴 |';
    expect(sanitizeStrategyDocText(text, 'doc.md')).toBe(text);
  });

  it('normalizes CRLF and collapses 4+ newlines', () => {
    const out = sanitizeStrategyDocText('a\r\nb\n\n\n\n\nc', 'doc.md');
    expect(out).toBe('a\nb\n\n\nc');
  });

  it('throws document_too_large on raw length BEFORE running regex passes', () => {
    const big = 'а'.repeat(F0_MAX_DOC_CHARS + 1);
    try {
      sanitizeStrategyDocText(big, 'doc.md');
      expect.unreachable('expected throw');
    } catch (err) {
      expect((err as F0OnboardingError).code).toBe('document_too_large');
    }
  });

  it('does not hang on a flood of unmatched "[" (regex backtracking guard)', () => {
    // До фикса LONG_MD_LINK_RE был O(n^2): 160k символов ≈ 51 с; при 400k это ~5 минут
    // блокировки event loop — DoS одним файлом. Bounded-квантификаторы делают проход
    // линейным (~0.6 с на 400k локально). Порог 3 с с запасом на медленный CI —
    // решающая разница с минутами, доказывающая отсутствие катастрофы.
    const flood = '['.repeat(F0_MAX_DOC_CHARS - 1);
    const startedAt = process.hrtime.bigint();
    const out = sanitizeStrategyDocText(flood, 'doc.md');
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    expect(out.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(3000);
  });
});
