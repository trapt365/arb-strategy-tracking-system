import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import { decodeDocumentBuffer, f0DocumentKind, F0_MAX_FILE_BYTES } from './f0-input.js';
import { F0OnboardingError } from '../errors.js';

// Story 7.2: любой поддерживаемый формат (md/txt/docx/pdf) → сырой текст.
// Санитизация (мусорные URL, размер) остаётся в sanitizeStrategyDocText — здесь
// только извлечение текста из бинарных форматов. Byte-guard дублируется тут, чтобы
// огромный docx/pdf не разворачивался парсером в память до проверки.

export interface F0ExtractedDocument {
  sourceName: string;
  kind: 'text' | 'docx' | 'pdf';
  text: string;
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
