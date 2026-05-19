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
      GOOGLE_SERVICE_ACCOUNT_JSON: './data/google-service-account.json',
      GEONLINE_F0_SHEET_ID: 'test-sheet-id',
      TELEGRAM_TRACKER_CHAT_IDS: '7890',
    },
  },
});
