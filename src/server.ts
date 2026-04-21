import http from 'node:http';
import { config } from './config.js';
import { logger } from './logger.js';

const startTime = Date.now();

export function createServer(): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const body = JSON.stringify({
        status: 'ok',
        uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
        env: config.NODE_ENV,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  server.on('listening', () => {
    logger.info({ port: config.PORT }, 'HTTP server listening');
  });

  server.on('error', (err) => {
    logger.error({ err }, 'HTTP server error');
  });

  return server;
}
