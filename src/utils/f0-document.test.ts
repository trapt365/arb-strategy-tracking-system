import { describe, expect, it } from 'vitest';
import { extractTextFromDocument } from './f0-document.js';
import { F0_MAX_FILE_BYTES } from './f0-input.js';
import { F0OnboardingError } from '../errors.js';

describe('extractTextFromDocument', () => {
  it('decodes text (md/txt) via the text path', async () => {
    const buf = Buffer.from('# OKR\n\nСодержимое', 'utf8');
    const out = await extractTextFromDocument(buf, 'okr.md', 'text/markdown');
    expect(out.kind).toBe('text');
    expect(out.text).toContain('Содержимое');
  });

  it('rejects unsupported formats', async () => {
    const buf = Buffer.from('data');
    await expect(extractTextFromDocument(buf, 'archive.zip', 'application/zip')).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(F0OnboardingError);
        expect((err as F0OnboardingError).code).toBe('unsupported_file');
        return true;
      },
    );
  });

  it('rejects oversized files before parsing', async () => {
    const buf = Buffer.alloc(F0_MAX_FILE_BYTES + 1, 0x61);
    await expect(extractTextFromDocument(buf, 'big.pdf', 'application/pdf')).rejects.toSatisfy(
      (err: unknown) => {
        expect((err as F0OnboardingError).code).toBe('file_too_large');
        return true;
      },
    );
  });

  it('wraps a corrupt docx as document_parse_failed', async () => {
    // Не-zip буфер с .docx именем — mammoth бросит, оборачиваем в F0OnboardingError.
    const buf = Buffer.from('not a real docx', 'utf8');
    await expect(
      extractTextFromDocument(
        buf,
        'broken.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(F0OnboardingError);
      expect((err as F0OnboardingError).code).toBe('document_parse_failed');
      return true;
    });
  });
});
