import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      ANTHROPIC_MODEL: 'claude-sonnet-4-6',
      CLAUDE_MAX_TOKENS: '8192',
      CLAUDE_TIMEOUT_MS: '120000',
      TELEGRAM_BOT_TOKEN: 'test-bot-token',
      TELEGRAM_CHAT_WORK_ID: '1',
      TELEGRAM_CHAT_OPS_ID: '2',
      SONIOX_API_KEY: 'test-soniox-key',
      GOOGLE_OAUTH_CLIENT_ID: '',
      GOOGLE_OAUTH_CLIENT_SECRET: '',
      GOOGLE_OAUTH_REFRESH_TOKEN: '',
      GOOGLE_SERVICE_ACCOUNT_JSON: './data/google-service-account.json',
      GEONLINE_F0_SHEET_ID: 'test-sheet-id',
      F0_SHEETS_TEMPLATE_ID: 'test-template-id',
      F0_SHEETS_SHARE_EMAILS: 'tracker@example.com',
      TELEGRAM_TRACKER_CHAT_IDS: '7890',
    },
  },
});
