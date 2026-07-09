import { F0OnboardingError } from '../errors.js';

// Story 7.1: подготовка входного документа онбординга (md/txt из Telegram) к подаче в Claude.
// Эталонные артефакты стратегии содержат оглавления с vscode-remote ссылками по несколько
// сотен символов каждая — тысячи мусорных токенов, срезаем до подачи в модель.

// Текстовые форматы — декодируются здесь напрямую. docx/pdf обрабатывает f0-document.ts.
export const F0_TEXT_EXTENSIONS = ['.md', '.markdown', '.txt'] as const;
export const F0_BINARY_EXTENSIONS = ['.docx', '.pdf', '.pptx'] as const;
export const F0_SUPPORTED_EXTENSIONS = [
  ...F0_TEXT_EXTENSIONS,
  ...F0_BINARY_EXTENSIONS,
] as const;

const F0_SUPPORTED_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

// Telegram Bot API getFile отдаёт файлы до 20 MB.
export const F0_MAX_FILE_BYTES = 20 * 1024 * 1024;

// Guard на размер текста после очистки (~100k токенов кириллицы) — больше не влезет
// в один вызов извлечения; нарезка по секциям — scope Story 7.2 (несколько файлов).
export const F0_MAX_DOC_CHARS = 400_000;

// Markdown-ссылка с URL длиннее порога — мусор из оглавлений; оставляем только текст.
// Оба квантификатора ограничены СВЕРХУ ({0,500} и {120,8000}): это делает проход
// линейным. Без верхней границы `[^\]\n]*` на потоке `[[[[…` без `]` сканирует до
// конца строки в КАЖДОЙ стартовой позиции — O(n²), 400k символов ≈ минуты блокировки
// event loop (реальный DoS одним файлом). Текст TOC-ссылки короткий, служебный URL —
// сотни символов, поэтому верхние границы не режут легитимный контент.
const LONG_MD_LINK_RE = /\[([^\]\n]{0,200})\]\(([^)\s\n]{120,8000})\)/g;

/** Голые служебные URL (vscode-remote, file://) — контента не несут. */
const NOISE_URL_RE = /(?:vscode-remote|vscode|file):\/\/[^\s)\]]+/g;

// Story 8.5: .xlsx — отдельный путь (импорт готовой стратегии, f0-import.ts),
// не входит в F0_SUPPORTED_EXTENSIONS (те — про извлечение текста для синтеза).
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

export function isXlsxDocument(fileName?: string, mimeType?: string): boolean {
  const name = (fileName ?? '').toLowerCase();
  return name.endsWith('.xlsx') || mimeType === XLSX_MIME;
}

export function isSupportedF0Document(fileName?: string, mimeType?: string): boolean {
  const name = (fileName ?? '').toLowerCase();
  if (F0_SUPPORTED_EXTENSIONS.some((ext) => name.endsWith(ext))) return true;
  // Telegram нередко шлёт файл без расширения в имени — опираемся на mime.
  return mimeType !== undefined && F0_SUPPORTED_MIMES.has(mimeType);
}

/** Тип парсинга по имени/mime: 'text' декодируется напрямую, 'docx'/'pdf'/'pptx' — бинарные. */
export function f0DocumentKind(
  fileName?: string,
  mimeType?: string,
): 'text' | 'docx' | 'pdf' | 'pptx' | 'unsupported' {
  const name = (fileName ?? '').toLowerCase();
  if (name.endsWith('.docx') || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return 'docx';
  }
  if (name.endsWith('.pdf') || mimeType === 'application/pdf') return 'pdf';
  if (
    name.endsWith('.pptx') ||
    mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) {
    return 'pptx';
  }
  if (
    F0_TEXT_EXTENSIONS.some((ext) => name.endsWith(ext)) ||
    mimeType === 'text/plain' ||
    mimeType === 'text/markdown'
  ) {
    return 'text';
  }
  return 'unsupported';
}

/**
 * Буфер из Telegram → текст. Отвергает бинарные файлы (NUL-байты) и пустые документы.
 */
export function decodeDocumentBuffer(buf: Buffer, sourceName: string): string {
  // Byte-guard ДО материализации строки: 20 MB буфер → ~40 MB UTF-16, плюс копии в
  // sanitize. Отсекаем раньше toString, чтобы огромный файл не разворачивался в память.
  if (buf.length > F0_MAX_FILE_BYTES) {
    throw new F0OnboardingError('file_too_large', {
      sourceName,
      bytes: buf.length,
      maxBytes: F0_MAX_FILE_BYTES,
    });
  }
  if (buf.includes(0)) {
    throw new F0OnboardingError('binary_document', { sourceName, bytes: buf.length });
  }
  // BOM UTF-8 срезаем, иначе он попадает в первый заголовок markdown.
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim().length === 0) {
    throw new F0OnboardingError('empty_document', { sourceName, bytes: buf.length });
  }
  return text;
}

/**
 * Чистка текста стратегического документа перед подачей в Claude:
 * мусорные URL из оглавлений, NUL/управляющие символы, лишние пустые строки.
 * Содержимое (RU/KZ, эмодзи-статусы, таблицы) не трогаем — это данные.
 */
export function sanitizeStrategyDocText(text: string, sourceName: string): string {
  // Guard размера ДО regex-проходов: replace-цепочка гоняется по входу как есть,
  // так что сначала ограничиваем длину, потом чистим (иначе платим за обработку
  // мусора, который тут же отвергнем, и даём тяжёлый вход regex).
  if (text.length > F0_MAX_DOC_CHARS) {
    throw new F0OnboardingError('document_too_large', {
      sourceName,
      chars: text.length,
      maxChars: F0_MAX_DOC_CHARS,
    });
  }
  const cleaned = text
    .replace(/\r\n?/g, '\n')
    .replace(LONG_MD_LINK_RE, '$1')
    .replace(NOISE_URL_RE, '')
    // Управляющие символы кроме \t и \n (\r нормализован строкой выше).
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (cleaned.length === 0) {
    throw new F0OnboardingError('empty_document', { sourceName, originalChars: text.length });
  }
  return cleaned;
}
