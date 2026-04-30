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
      TELEGRAM_BOT_TOKEN: 'test-bot-token',
      TELEGRAM_CHAT_WORK_ID: '1',
      TELEGRAM_CHAT_OPS_ID: '2',
      SONIOX_API_KEY: 'test-soniox-key',
      GOOGLE_SERVICE_ACCOUNT_JSON: './data/google-service-account.json',
    },
  },
});
