import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import JSZip from 'jszip';
import { decodeDocumentBuffer, f0DocumentKind, F0_MAX_FILE_BYTES } from './f0-input.js';
import { F0OnboardingError } from '../errors.js';

// Story 7.2: любой поддерживаемый формат (md/txt/docx/pdf) → сырой текст.
// Санитизация (мусорные URL, размер) остаётся в sanitizeStrategyDocText — здесь
// только извлечение текста из бинарных форматов. Byte-guard дублируется тут, чтобы
// огромный docx/pdf не разворачивался парсером в память до проверки.

export interface F0ExtractedDocument {
  sourceName: string;
  kind: 'text' | 'docx' | 'pdf' | 'pptx';
  text: string;
}

const PPTX_A_T_RE = /<a:t[^>]*>([^<]+)<\/a:t>/g;

function decodePptxEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

/**
 * Извлекает текст из PPTX-файла: распаковывает ZIP, читает ppt/slides/slide*.xml,
 * вытаскивает содержимое <a:t> узлов и декодирует XML-сущности.
 */
export async function extractPptxText(buf: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const slideEntries = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => {
      const numA = parseInt(a.replace(/\D/g, ''), 10);
      const numB = parseInt(b.replace(/\D/g, ''), 10);
      return numA - numB;
    });

  const slideTexts: string[] = [];
  for (const name of slideEntries) {
    const xml = await zip.files[name].async('string');
    const texts: string[] = [];
    let m: RegExpExecArray | null;
    PPTX_A_T_RE.lastIndex = 0;
    while ((m = PPTX_A_T_RE.exec(xml)) !== null) {
      texts.push(decodePptxEntities(m[1]));
    }
    if (texts.length > 0) {
      slideTexts.push(texts.join(' '));
    }
  }

  return slideTexts.join('\n\n');
}

export async function extractTextFromDocument(
  buf: Buffer,
  fileName: string | undefined,
  mimeType: string | undefined,
): Promise<F0ExtractedDocument> {
  const sourceName = fileName ?? 'document';
  const kind = f0DocumentKind(fileName, mimeType);
  if (kind === 'unsupported') {
    throw new F0OnboardingError('unsupported_file', { sourceName, mimeType });
  }
  if (buf.length > F0_MAX_FILE_BYTES) {
    throw new F0OnboardingError('file_too_large', {
      sourceName,
      bytes: buf.length,
      maxBytes: F0_MAX_FILE_BYTES,
    });
  }

  if (kind === 'text') {
    // decodeDocumentBuffer уже проверяет NUL/пустоту/размер и режет BOM.
    return { sourceName, kind, text: decodeDocumentBuffer(buf, sourceName) };
  }

  let text: string;
  try {
    if (kind === 'docx') {
      const result = await mammoth.extractRawText({ buffer: buf });
      text = result.value;
    } else if (kind === 'pptx') {
      text = await extractPptxText(buf);
    } else {
      const result = await pdfParse(buf);
      text = result.text;
    }
  } catch (err) {
    throw new F0OnboardingError('document_parse_failed', { sourceName, kind }, { cause: err });
  }

  if (text.trim().length === 0) {
    // Битый файл или скан без текстового слоя (pdf-картинка) — извлечь нечего.
    throw new F0OnboardingError('empty_document', { sourceName, kind, reason: 'no_text_layer' });
  }
  return { sourceName, kind, text };
}
