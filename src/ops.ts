import { logger } from './logger.js';

export interface AlertPayload {
  pipeline: string;
  step: string;
  clientId?: string;
  error: unknown;
  context?: Record<string, unknown>;
}

// TODO(Story 1.9): дополнительно слать алерт в Telegram ops-канал (TELEGRAM_CHAT_OPS_ID).
export function alertOps(payload: AlertPayload): void {
  logger.error(
    {
      level: 'ops_alert',
      pipeline: payload.pipeline,
      step: payload.step,
      clientId: payload.clientId,
      err: payload.error,
      context: payload.context,
    },
    'ops alert raised',
  );
}
