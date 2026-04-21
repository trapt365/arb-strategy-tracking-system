import { z } from 'zod';
import 'dotenv/config';

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: z.coerce.number().int().positive().default(3000),
  TZ: z.string().default('Asia/Almaty'),

  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),

  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_CHAT_WORK_ID: z.coerce.number().int(),
  TELEGRAM_CHAT_OPS_ID: z.coerce.number().int(),

  SONIOX_API_KEY: z.string().min(1, 'SONIOX_API_KEY is required'),

  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().min(1, 'Path to Google service account JSON'),
});

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
