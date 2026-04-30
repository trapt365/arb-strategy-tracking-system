import { stat, readFile } from 'node:fs/promises';
import { config } from '../config.js';
import { TranscriptConfigError } from '../errors.js';

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
}

let cached: Promise<ServiceAccountCredentials> | null = null;

export async function loadServiceAccountCredentials(): Promise<ServiceAccountCredentials> {
  if (cached) return cached;
  cached = loadCredentialsFromDisk();
  try {
    return await cached;
  } catch (err) {
    cached = null;
    throw err;
  }
}

async function loadCredentialsFromDisk(): Promise<ServiceAccountCredentials> {
  const path = config.GOOGLE_SERVICE_ACCOUNT_JSON;

  try {
    await stat(path);
  } catch (err) {
    throw new TranscriptConfigError(
      'missing_service_account',
      { path, message: (err as Error).message },
      { cause: err },
    );
  }

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new TranscriptConfigError(
      'missing_service_account',
      { path, message: (err as Error).message },
      { cause: err },
    );
  }

  let parsed: { client_email?: unknown; private_key?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new TranscriptConfigError(
      'invalid_service_account_json',
      { path, message: (err as Error).message },
      { cause: err },
    );
  }

  const missingFields: string[] = [];
  if (typeof parsed.client_email !== 'string' || parsed.client_email.length === 0) {
    missingFields.push('client_email');
  }
  if (typeof parsed.private_key !== 'string' || parsed.private_key.length === 0) {
    missingFields.push('private_key');
  }
  if (missingFields.length > 0) {
    throw new TranscriptConfigError('invalid_service_account_shape', {
      path,
      missingFields,
    });
  }

  return {
    client_email: parsed.client_email as string,
    private_key: parsed.private_key as string,
  };
}

export function _resetCredentialsCacheForTest(): void {
  cached = null;
}
