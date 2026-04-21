import { config } from './config.js';
import { logger } from './logger.js';
import { createServer } from './server.js';

const log = logger.child({ step: 'bootstrap' });

log.info(
  { env: config.NODE_ENV, tz: config.TZ, port: config.PORT },
  'Starting strategy-tracking-system',
);

const server = createServer();
server.listen(config.PORT);

function shutdown(signal: NodeJS.Signals): void {
  log.info({ signal }, 'Shutdown requested');
  server.close((err) => {
    if (err) {
      log.error({ err }, 'Error during server close');
      process.exit(1);
    }
    log.info('Server closed cleanly');
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
