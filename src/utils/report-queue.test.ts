import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { createReportQueue, QueueOverflowError, type ReportQueue } from './report-queue.js';
import type { ReportJob } from '../types.js';

const silentLogger = pino({ level: 'silent' }) as unknown as Parameters<
  typeof createReportQueue
>[0]['logger'];

function makeJob(id: string, chatId = 100): ReportJob {
  return {
    id,
    chatId,
    url: `https://drive.google.com/file/d/${id}/view`,
    clientId: 'geonline',
    topName: 'Жанель',
    meetingDate: '2026-05-19',
    status: 'queued',
    queuedAt: '2026-05-19T10:00:00+05:00',
    retryCount: 0,
  };
}

describe('report-queue', () => {
  let queue: ReportQueue;

  beforeEach(() => {
    queue = createReportQueue({ maxSize: 20, logger: silentLogger });
  });

  describe('enqueue/dequeue/peek', () => {
    it('enqueue 3 → size = 3, FIFO order', () => {
      queue.enqueue(makeJob('a'));
      queue.enqueue(makeJob('b'));
      queue.enqueue(makeJob('c'));
      expect(queue.size()).toBe(3);
      expect(queue.dequeue()?.id).toBe('a');
      expect(queue.dequeue()?.id).toBe('b');
      expect(queue.dequeue()?.id).toBe('c');
      expect(queue.dequeue()).toBeUndefined();
    });

    it('enqueue возвращает позицию + queueSize', () => {
      const r1 = queue.enqueue(makeJob('a'));
      expect(r1).toEqual({ position: 1, queueSize: 1 });
      const r2 = queue.enqueue(makeJob('b'));
      expect(r2).toEqual({ position: 2, queueSize: 2 });
    });

    it('peek по jobId находит queued job', () => {
      const job = makeJob('xyz');
      queue.enqueue(job);
      expect(queue.peek('xyz')?.id).toBe('xyz');
      expect(queue.peek('unknown')).toBeUndefined();
    });

    it('findByChatId фильтрует по chatId', () => {
      queue.enqueue(makeJob('a', 100));
      queue.enqueue(makeJob('b', 200));
      queue.enqueue(makeJob('c', 100));
      expect(queue.findByChatId(100).map((j) => j.id)).toEqual(['a', 'c']);
      expect(queue.findByChatId(200).map((j) => j.id)).toEqual(['b']);
      expect(queue.findByChatId(999)).toEqual([]);
    });
  });

  describe('overflow', () => {
    it('enqueue 21-й при maxSize=20 throws QueueOverflowError', () => {
      const smallQueue = createReportQueue({ maxSize: 2, logger: silentLogger });
      smallQueue.enqueue(makeJob('a'));
      smallQueue.enqueue(makeJob('b'));
      let err: unknown;
      try {
        smallQueue.enqueue(makeJob('c'));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(QueueOverflowError);
      expect(smallQueue.size()).toBe(2);
    });
  });

  describe('startWorker', () => {
    it('worker обрабатывает enqueued jobs по FIFO', async () => {
      const processed: string[] = [];
      const stop = queue.startWorker(async (job) => {
        processed.push(job.id);
      });

      queue.enqueue(makeJob('a'));
      queue.enqueue(makeJob('b'));
      queue.enqueue(makeJob('c'));

      // Дать event-loop провернуть обработку.
      await new Promise((res) => setTimeout(res, 20));
      await stop();

      expect(processed).toEqual(['a', 'b', 'c']);
    });

    it('worker НЕ падает на throw из handler — обрабатывает следующий job', async () => {
      const processed: string[] = [];
      const stop = queue.startWorker(async (job) => {
        if (job.id === 'b') throw new Error('boom');
        processed.push(job.id);
      });

      queue.enqueue(makeJob('a'));
      queue.enqueue(makeJob('b'));
      queue.enqueue(makeJob('c'));

      await new Promise((res) => setTimeout(res, 20));
      await stop();

      expect(processed).toEqual(['a', 'c']);
    });

    it('enqueue после старта worker (когда очередь пуста) — handler вызывается', async () => {
      const processed: string[] = [];
      const stop = queue.startWorker(async (job) => {
        processed.push(job.id);
      });

      // Дать worker'у припарковаться.
      await new Promise((res) => setTimeout(res, 5));
      queue.enqueue(makeJob('late'));
      await new Promise((res) => setTimeout(res, 20));
      await stop();

      expect(processed).toEqual(['late']);
    });

    it('stop() ждёт пока running job завершится', async () => {
      const processed: string[] = [];
      let resolveJob: (() => void) | null = null;
      const stop = queue.startWorker(async (job) => {
        await new Promise<void>((res) => {
          resolveJob = res;
        });
        processed.push(job.id);
      });

      queue.enqueue(makeJob('slow'));
      // Wait for handler to start.
      await new Promise((res) => setTimeout(res, 10));

      const stopPromise = stop();
      // Резолвим handler — stop должен вернуться.
      resolveJob!();
      await stopPromise;

      expect(processed).toEqual(['slow']);
    });

    it('повторный startWorker → throws', () => {
      const stop = queue.startWorker(async () => {});
      expect(() => queue.startWorker(async () => {})).toThrow(/already started/);
      void stop();
    });
  });
});
