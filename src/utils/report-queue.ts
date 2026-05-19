import type { Logger } from '../logger.js';
import type { ReportJob } from '../types.js';

export class QueueOverflowError extends Error {
  public readonly maxSize: number;
  public readonly currentSize: number;

  constructor(maxSize: number, currentSize: number) {
    super(`queue overflow: ${currentSize} >= ${maxSize}`);
    this.name = 'QueueOverflowError';
    this.maxSize = maxSize;
    this.currentSize = currentSize;
  }
}

export interface ReportQueue {
  enqueue(job: ReportJob): { position: number; queueSize: number };
  dequeue(): ReportJob | undefined;
  peek(jobId: string): ReportJob | undefined;
  size(): number;
  findByChatId(chatId: number): ReportJob[];
  startWorker(
    handler: (job: ReportJob) => Promise<void>,
    opts?: { logger?: Logger },
  ): () => Promise<void>;
}

export function createReportQueue(opts: {
  maxSize: number;
  logger: Logger;
}): ReportQueue {
  const log = opts.logger.child({ pipeline: 'F1', step: 'bot.queue' });
  const jobs: ReportJob[] = [];
  const index = new Map<string, ReportJob>();
  let waiter: { promise: Promise<void>; resolve: () => void } | null = null;
  let workerRunning = false;
  let workerStopRequested = false;
  let runningJob: ReportJob | null = null;

  function createWaiter(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  function wakeWaiter(): void {
    if (waiter !== null) {
      const w = waiter;
      waiter = null;
      w.resolve();
    }
  }

  return {
    enqueue(job: ReportJob): { position: number; queueSize: number } {
      const inFlight = jobs.length + (runningJob !== null ? 1 : 0);
      if (inFlight >= opts.maxSize) {
        throw new QueueOverflowError(opts.maxSize, inFlight);
      }
      jobs.push(job);
      index.set(job.id, job);
      wakeWaiter();
      return { position: jobs.length, queueSize: jobs.length };
    },

    dequeue(): ReportJob | undefined {
      const job = jobs.shift();
      if (job !== undefined) {
        index.delete(job.id);
      }
      return job;
    },

    peek(jobId: string): ReportJob | undefined {
      const fromIndex = index.get(jobId);
      if (fromIndex !== undefined) return fromIndex;
      if (runningJob !== null && runningJob.id === jobId) return runningJob;
      return undefined;
    },

    size(): number {
      return jobs.length;
    },

    findByChatId(chatId: number): ReportJob[] {
      const queued = jobs.filter((j) => j.chatId === chatId);
      if (runningJob !== null && runningJob.chatId === chatId) {
        return [runningJob, ...queued];
      }
      return queued;
    },

    startWorker(
      handler: (job: ReportJob) => Promise<void>,
      workerOpts?: { logger?: Logger },
    ): () => Promise<void> {
      if (workerRunning) {
        throw new Error('report-queue worker already started');
      }
      workerRunning = true;
      workerStopRequested = false;
      const workerLog = (workerOpts?.logger ?? log).child({ step: 'bot.queue.worker' });

      const loop = async (): Promise<void> => {
        while (!workerStopRequested) {
          const job = jobs.shift();
          if (job === undefined) {
            // No jobs — park until enqueue wakes us or stop is requested.
            waiter = createWaiter();
            await waiter.promise;
            continue;
          }
          index.delete(job.id);
          runningJob = job;
          try {
            await handler(job);
          } catch (err) {
            // Worker MUST NOT crash on handler throw — log and continue (resilience anchor).
            workerLog.error(
              { err, jobId: job.id, chatId: job.chatId },
              'worker handler threw — continuing with next job',
            );
          } finally {
            runningJob = null;
          }
        }
      };

      const loopPromise = loop();
      loopPromise.catch((err) => {
        // Should never reach here (loop body wraps handler in try/catch).
        workerLog.error({ err }, 'worker loop crashed unexpectedly');
      });

      return async (): Promise<void> => {
        workerStopRequested = true;
        wakeWaiter();
        // Wait for current loop iteration to finish (running handler completes, or idle wake).
        try {
          await loopPromise;
        } catch {
          // already logged
        }
        workerRunning = false;
        workerLog.info({ remaining: jobs.length }, 'worker stopped');
      };
    },
  };
}
