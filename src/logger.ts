import pino from 'pino';
import { config } from './config.js';

const isDev = config.NODE_ENV === 'development';

// Compiled once at startup; token never changes at runtime.
const TOKEN_RE = config.TELEGRAM_BOT_TOKEN
  ? new RegExp(config.TELEGRAM_BOT_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
  : null;

export const logger = pino({
  level: config.LOG_LEVEL,
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }
    : {}),
  base: {
    service: 'strategy-tracking-system',
    env: config.NODE_ENV,
  },
  serializers: {
    err: (err: Error) => {
      const s = pino.stdSerializers.err(err);
      if (TOKEN_RE) {
        if (s.message) s.message = s.message.replace(TOKEN_RE, '[TOKEN]');
        if (s.stack) s.stack = s.stack.replace(TOKEN_RE, '[TOKEN]');
      }
      return s;
    },
  },
});

export type Logger = typeof logger;
