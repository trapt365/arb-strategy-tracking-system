import { config } from './config.js';
import { logger } from './logger.js';
import { createServer } from './server.js';
import { createBot } from './bot.js';

const log = logger.child({ step: 'bootstrap' });

log.info(
  { env: config.NODE_ENV, tz: config.TZ, port: config.PORT },
  'Starting strategy-tracking-system',
);

const server = createServer();

const onStartupError = (err: Error): void => {
  log.fatal({ err }, 'Server failed to start');
  process.exit(1);
};
server.once('error', onStartupError);
server.once('listening', () => {
  server.off('error', onStartupError);
});

server.listen(config.PORT);

const { start: startBot, stop: stopBot } = createBot();

startBot().catch((err: unknown) => {
  log.fatal({ err }, 'Telegram bot failed to start');
  process.exit(1);
});

let isShuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (isShuttingDown) {
    log.warn({ signal }, 'Shutdown already in progress, ignoring signal');
    return;
  }
  isShuttingDown = true;
  log.info({ signal }, 'Shutdown requested');

  Promise.allSettled([
    stopBot().catch((err) => log.error({ err }, 'Error during bot stop')),
    new Promise<void>((resolve) => {
      server.close((err) => {
        if (err) log.error({ err }, 'Error during server close');
        resolve();
      });
    }),
  ]).then(() => {
    log.info('Shutdown complete');
    process.exit(0);
  });

  setTimeout(() => {
    log.warn('Force exit after 10s');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.fatal({ reason }, 'Unhandled rejection');
  process.exit(1);
});
