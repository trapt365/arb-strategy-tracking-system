import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { extractPptxText, extractTextFromDocument } from './f0-document.js';
import { F0_MAX_FILE_BYTES } from './f0-input.js';
import { F0OnboardingError } from '../errors.js';

/** Создаёт минимальный PPTX-zip (Buffer) с одним слайдом slide1.xml. */
async function makePptxBuf(slideXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('ppt/slides/slide1.xml', slideXml);
  const ab = await zip.generateAsync({ type: 'arraybuffer' });
  return Buffer.from(ab);
}

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

describe('extractPptxText', () => {
  it('extracts text from <a:t> nodes', async () => {
    const xml = '<root><a:r><a:t>Стратегия</a:t></a:r><a:r><a:t>&amp;OKR</a:t></a:r></root>';
    const buf = await makePptxBuf(xml);
    const text = await extractPptxText(buf);
    expect(text).toContain('Стратегия');
    expect(text).toContain('&OKR');
  });

  it('sorts slides numerically', async () => {
    const zip = new JSZip();
    zip.file('ppt/slides/slide2.xml', '<root><a:t>Второй</a:t></root>');
    zip.file('ppt/slides/slide10.xml', '<root><a:t>Десятый</a:t></root>');
    zip.file('ppt/slides/slide1.xml', '<root><a:t>Первый</a:t></root>');
    const ab = await zip.generateAsync({ type: 'arraybuffer' });
    const buf = Buffer.from(ab);
    const text = await extractPptxText(buf);
    const idxFirst = text.indexOf('Первый');
    const idxSecond = text.indexOf('Второй');
    const idxTenth = text.indexOf('Десятый');
    expect(idxFirst).toBeLessThan(idxSecond);
    expect(idxSecond).toBeLessThan(idxTenth);
  });

  it('throws document_parse_failed for a corrupt zip', async () => {
    const buf = Buffer.from('not a zip', 'utf8');
    await expect(extractPptxText(buf)).rejects.toBeInstanceOf(Error);
  });

  it('returns empty string when slides have no <a:t> content', async () => {
    const buf = await makePptxBuf('<root><p:sp/></root>');
    const text = await extractPptxText(buf);
    expect(text).toBe('');
  });
});

describe('extractTextFromDocument — pptx path', () => {
  it('returns kind=pptx and extracts text for a .pptx file', async () => {
    const xml = '<root><a:t>Стратегия</a:t></root>';
    const buf = await makePptxBuf(xml);
    const out = await extractTextFromDocument(buf, 'deck.pptx', undefined);
    expect(out.kind).toBe('pptx');
    expect(out.text).toContain('Стратегия');
  });

  it('rejects a .pptx with no slide text as empty_document', async () => {
    const buf = await makePptxBuf('<root><p:sp/></root>');
    await expect(extractTextFromDocument(buf, 'empty.pptx', undefined)).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(F0OnboardingError);
        expect((err as F0OnboardingError).code).toBe('empty_document');
        return true;
      },
    );
  });

  it('rejects a corrupt .pptx as document_parse_failed', async () => {
    const buf = Buffer.from('not a zip', 'utf8');
    await expect(extractTextFromDocument(buf, 'corrupt.pptx', undefined)).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(F0OnboardingError);
        expect((err as F0OnboardingError).code).toBe('document_parse_failed');
        return true;
      },
    );
  });
});
