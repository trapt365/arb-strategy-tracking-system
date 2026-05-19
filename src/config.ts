import { z } from 'zod';
import 'dotenv/config';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  TZ: z.string().default('Asia/Almaty'),

  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-4-6'),
  CLAUDE_MAX_TOKENS: z.coerce.number().int().positive().max(64000).default(8192),
  CLAUDE_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),

  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_CHAT_WORK_ID: z.coerce
    .number()
    .int()
    .refine((n) => n !== 0, 'TELEGRAM_CHAT_WORK_ID is required (non-zero)'),
  TELEGRAM_CHAT_OPS_ID: z.coerce
    .number()
    .int()
    .refine((n) => n !== 0, 'TELEGRAM_CHAT_OPS_ID is required (non-zero)'),

  SONIOX_API_KEY: z.string().min(1, 'SONIOX_API_KEY is required'),
  SONIOX_API_URL: z.string().url().optional(),

  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().min(1, 'Path to Google service account JSON'),

  GEONLINE_F0_SHEET_ID: z.string().min(1, 'GEONLINE_F0_SHEET_ID is required'),

  // Telegram bot — Story 1.5: whitelist + tuning
  TELEGRAM_TRACKER_CHAT_IDS: z
    .string()
    .min(1, 'TELEGRAM_TRACKER_CHAT_IDS is required (comma-separated chat ids)'),
  F1_PROGRESS_UPDATES_ENABLED: z
    .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0'), z.boolean()])
    .transform((v) => v === 'true' || v === '1' || v === true)
    .default(true),
  F1_QUEUE_MAX_SIZE: z.coerce.number().int().positive().max(1000).default(20),
});

// Lazy parser — invoked from createBot, not at module load (keeps config.ts pure zod parse).
export function parseTrackerChatIds(raw: string): Set<number> {
  const ids = new Set<number>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n === 0) {
      throw new Error(
        `TELEGRAM_TRACKER_CHAT_IDS contains an invalid entry: "${trimmed}" (must be a non-zero integer)`,
      );
    }
    ids.add(n);
  }
  if (ids.size === 0) {
    throw new Error('TELEGRAM_TRACKER_CHAT_IDS must contain at least one non-zero numeric chat id');
  }
  return ids;
}

export type Config = z.infer<typeof ConfigSchema>;

function loadConfig(): Config {
  const parsed = ConfigSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.')}: ${i.message}`,
    );
    // eslint-disable-next-line no-console
    console.error('Configuration validation failed:');
    // eslint-disable-next-line no-console
    console.error(issues.join('\n'));
    process.exit(1);
  }

  return parsed.data;
}

export const config: Config = loadConfig();
