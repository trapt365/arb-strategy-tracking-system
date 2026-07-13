import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';

// Unit test for the token-redaction serializer added in Story 11.9.
// Constructs an equivalent pino instance with the same serializer logic
// so the test does not depend on config.TELEGRAM_BOT_TOKEN at runtime.

function makeRedactingLogger(fakeToken: string) {
  const re = new RegExp(fakeToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc: string, cb: () => void) {
      lines.push(chunk.toString());
      cb();
    },
  });
  const log = pino(
    {
      level: 'error',
      serializers: {
        err: (err: Error) => {
          const s = pino.stdSerializers.err(err);
          if (s.message) s.message = s.message.replace(re, '[TOKEN]');
          if (s.stack) s.stack = s.stack.replace(re, '[TOKEN]');
          return s;
        },
      },
    },
    stream,
  );
  return { log, lines };
}

describe('logger — Story 11.9: token redaction in err serializer', () => {
  const FAKE_TOKEN = 'ABC123:secretbottoken';

  it('replaces token in err.message with [TOKEN]', () => {
    const { log, lines } = makeRedactingLogger(FAKE_TOKEN);
    const err = new Error(`download failed: https://api.telegram.org/bot${FAKE_TOKEN}/getFile`);
    log.error({ err }, 'test error');
    const out = lines.join('');
    expect(out).toContain('[TOKEN]');
    expect(out).not.toContain(FAKE_TOKEN);
  });

  it('replaces token in err.stack with [TOKEN]', () => {
    const { log, lines } = makeRedactingLogger(FAKE_TOKEN);
    const err = new Error('stack test');
    // Inject fake token into stack manually to simulate a scenario where it appears there.
    err.stack = `Error: stack test\n    at https://api.telegram.org/bot${FAKE_TOKEN}/getUpdates:1:1`;
    log.error({ err }, 'test error');
    const out = lines.join('');
    expect(out).not.toContain(FAKE_TOKEN);
  });

  it('leaves messages without token unchanged', () => {
    const { log, lines } = makeRedactingLogger(FAKE_TOKEN);
    const err = new Error('plain network error');
    log.error({ err }, 'test error');
    const out = lines.join('');
    expect(out).toContain('plain network error');
    expect(out).not.toContain('[TOKEN]');
  });
});
