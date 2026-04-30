export type TranscriptDownloadCode =
  | 'not_found'
  | 'access_denied'
  | 'unsupported_format'
  | 'file_too_large'
  | 'timeout'
  | 'zoom_auth_required'
  | 'rate_limited'
  | 'network';

export class TranscriptDownloadError extends Error {
  public readonly code: TranscriptDownloadCode;
  public readonly context: { url: string; clientId: string; httpStatus?: number };

  constructor(
    code: TranscriptDownloadCode,
    context: { url: string; clientId: string; httpStatus?: number },
    options?: { cause?: unknown },
  ) {
    super(`${code}: ${context.url}`, options as ErrorOptions);
    this.code = code;
    this.context = context;
    this.name = 'TranscriptDownloadError';
  }
}

export type TranscriptProviderCode =
  | 'upload_failed'
  | 'transcription_failed'
  | 'unknown_status'
  | 'timeout'
  | 'auth'
  | 'invalid_response';

export class TranscriptProviderError extends Error {
  public readonly code: TranscriptProviderCode;
  public readonly context: Record<string, unknown>;

  constructor(
    code: TranscriptProviderCode,
    context: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(`soniox:${code}`, options as ErrorOptions);
    this.code = code;
    this.context = context;
    this.name = 'TranscriptProviderError';
  }
}

export type TranscriptValidationCode = 'schema' | 'too_short' | 'empty';

export class TranscriptValidationError extends Error {
  public readonly code: TranscriptValidationCode;
  public readonly context: Record<string, unknown>;

  constructor(
    code: TranscriptValidationCode,
    context: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(`validation:${code}`, options as ErrorOptions);
    this.code = code;
    this.context = context;
    this.name = 'TranscriptValidationError';
  }
}

export type TranscriptConfigCode =
  | 'missing_service_account'
  | 'invalid_service_account_json'
  | 'invalid_service_account_shape';

export class TranscriptConfigError extends Error {
  public readonly code: TranscriptConfigCode;
  public readonly context: Record<string, unknown>;

  constructor(
    code: TranscriptConfigCode,
    context: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(`config:${code}`, options as ErrorOptions);
    this.code = code;
    this.context = context;
    this.name = 'TranscriptConfigError';
  }
}

export type SheetsAdapterCode =
  | 'auth'
  | 'sheet_not_found'
  | 'header_missing'
  | 'rate_limited'
  | 'network'
  | 'invalid_value';

export class SheetsAdapterError extends Error {
  public readonly code: SheetsAdapterCode;
  public readonly context: Record<string, unknown>;

  constructor(
    code: SheetsAdapterCode,
    context: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(`sheets:${code}`, options as ErrorOptions);
    this.code = code;
    this.context = context;
    this.name = 'SheetsAdapterError';
  }
}
