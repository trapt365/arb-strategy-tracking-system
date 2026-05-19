// Allowed providers for `/report <url>` — Google Drive (file), Google Docs, Zoom recordings.
// Mirrors hosts handled by src/adapters/drive.ts; if a new provider is added there, update here too.
const ALLOWED_HOSTS_RE = /^(drive\.google\.com|docs\.google\.com|zoom\.us|[^.]+\.zoom\.us)$/i;

export type UrlParseFailure = 'missing_arg' | 'invalid_url' | 'unsupported_provider';

export type UrlParseResult =
  | { ok: true; url: string }
  | { ok: false; reason: UrlParseFailure };

export function parseReportUrl(text: string | undefined | null): UrlParseResult {
  const trimmed = (text ?? '').trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'missing_arg' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'invalid_url' };
  }
  if (parsed.hostname.length === 0) {
    return { ok: false, reason: 'invalid_url' };
  }
  if (!ALLOWED_HOSTS_RE.test(parsed.hostname)) {
    return { ok: false, reason: 'unsupported_provider' };
  }
  return { ok: true, url: parsed.toString() };
}
