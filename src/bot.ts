import { Bot, GrammyError, InlineKeyboard, type Context } from 'grammy';
import { randomUUID } from 'node:crypto';
import type { UserFromGetMe } from 'grammy/types';
import { config, parseTrackerChatIds } from './config.js';
import { logger as rootLogger, type Logger } from './logger.js';
import { alertOps as defaultAlertOps, type AlertPayload } from './ops.js';
import { transcribeFromUrl as defaultTranscribeFromUrl } from './adapters/transcript.js';
import { readClientContext as defaultReadClientContext } from './adapters/sheets.js';
import { runF1 as defaultRunF1, applyEditToReport as defaultApplyEditToReport } from './f1-report.js';
import { appendApproval as defaultAppendApproval } from './utils/approvals.js';
import type { ApprovalRecord } from './types.js';
import {
  TranscriptDownloadError,
  TranscriptProviderError,
  TranscriptValidationError,
} from './errors.js';
import { parseReportUrl, type UrlParseFailure } from './utils/url-parser.js';
import { assertTranscriptDuration } from './utils/transcript-duration-guard.js';
import { createReportQueue, QueueOverflowError, type ReportQueue } from './utils/report-queue.js';
import {
  escapeMarkdownV2,
  formatDeliveryReport,
  formatTopMessagePlainText,
  formatErrorMessage,
  formatHelpHint,
  formatProgressStep,
  formatQueueAck,
  formatWelcomeMessage,
  splitForTelegram,
  TELEGRAM_SAFE_MARGIN,
  type ProgressStep,
} from './utils/telegram-formatter.js';
import type { ReportJob } from './types.js';

const DEFAULT_CLIENT_ID = 'geonline';
const DEFAULT_TOP_NAME = 'Жанель';
const JOB_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_COMPLETED_JOBS = 100;

// Synthetic botInfo for tests (matches `getMe` shape). Export so tests can pass it explicitly.
export const FALLBACK_BOT_INFO: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: 'TestBot',
  username: 'test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  can_manage_bots: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
};

export interface BotDeps {
  runF1?: typeof defaultRunF1;
  transcribeFromUrl?: typeof defaultTranscribeFromUrl;
  readClientContext?: typeof defaultReadClientContext;
  alertOps?: typeof defaultAlertOps;
  applyEditToReport?: typeof defaultApplyEditToReport;
  appendApproval?: typeof defaultAppendApproval;
  logger?: Logger;
  queue?: ReportQueue;
  now?: () => Date;
  /** Bypass getMe in tests. */
  botInfo?: UserFromGetMe;
  /** Override env-loaded chat ids whitelist. */
  trackerChatIds?: Set<number>;
  /** Override env-loaded token (tests). */
  token?: string;
  /** Override progress-edit feature flag (tests). */
  progressUpdatesEnabled?: boolean;
  /** Override env-loaded queue max size (tests). */
  queueMaxSize?: number;
}

export interface CreatedBot {
  bot: Bot;
  queue: ReportQueue;
  processJob: (job: ReportJob) => Promise<void>;
  stop: () => Promise<void>;
  start: () => Promise<void>;
}

function sanitizeUrlForLog(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '[unparseable-url]';
  }
}

function isAbortError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { name?: unknown; code?: unknown };
  return e.name === 'AbortError' || e.code === 'ABORT_ERR';
}

export function createBot(deps: BotDeps = {}): CreatedBot {
  const baseLogger = deps.logger ?? rootLogger;
  const log = baseLogger.child({ pipeline: 'F1', step: 'bot.report' });

  const token = deps.token ?? config.TELEGRAM_BOT_TOKEN;
  const trackerChatIds =
    deps.trackerChatIds ?? parseTrackerChatIds(config.TELEGRAM_TRACKER_CHAT_IDS);
  const progressUpdatesEnabled =
    deps.progressUpdatesEnabled ?? config.F1_PROGRESS_UPDATES_ENABLED;
  const queueMaxSize = deps.queueMaxSize ?? config.F1_QUEUE_MAX_SIZE;

  const runF1 = deps.runF1 ?? defaultRunF1;
  const transcribeFromUrl = deps.transcribeFromUrl ?? defaultTranscribeFromUrl;
  const readClientContext = deps.readClientContext ?? defaultReadClientContext;
  const alertOps = deps.alertOps ?? defaultAlertOps;
  const applyEditToReport = deps.applyEditToReport ?? defaultApplyEditToReport;
  const appendApproval = deps.appendApproval ?? defaultAppendApproval;
  const now = deps.now ?? ((): Date => new Date());
  const queue = deps.queue ?? createReportQueue({ maxSize: queueMaxSize, logger: log });

  // In tests, pass deps.botInfo explicitly to skip getMe(). In production, omit so grammY
  // calls getMe() on start — required for /cmd@username matching in group chats.
  const bot = new Bot(token, deps.botInfo !== undefined ? { botInfo: deps.botInfo } : undefined);

  // Track watchdog timers per job so we can clear on completion.
  const jobTimers = new Map<string, NodeJS.Timeout>();
  // Track jobs that hit timeout so the worker handler can short-circuit final render.
  const timedOutJobs = new Set<string>();
  // Keep completed jobs in memory so approval callbacks can find them after processJob returns.
  // Story 1.10 will add full disk persistence; MVP = in-memory only.
  const completedJobs = new Map<string, ReportJob>();
  // pendingEdits: chatId → { jobId, instructionMessageId } for edit reply flow.
  interface PendingEdit { jobId: string; instructionMessageId: number }
  const pendingEdits = new Map<number, PendingEdit>();
  // Story 1.7: pendingNotes for post-delivery correction flow.
  interface PendingNote { jobId: string; instructionMessageId: number }
  const pendingNotes = new Map<number, PendingNote>();

  /** Look up a job by id in both live queue and completed-jobs store. */
  function peekJob(jobId: string): ReportJob | undefined {
    return queue.peek(jobId) ?? completedJobs.get(jobId);
  }

  /**
   * Send delivery-ready messages after approval.
   * Returns true if delivery succeeded, false otherwise.
   */
  async function deliverReport(job: ReportJob): Promise<boolean> {
    const messageIds: number[] = [];
    const continuation = `📋 ${escapeMarkdownV2(job.topName)} \\(продолжение\\)`;
    const parts = splitForTelegram(job.lastReportText ?? '', TELEGRAM_SAFE_MARGIN, continuation);

    for (let i = 0; i < parts.length; i++) {
      const sent = await bot.api.sendMessage(job.chatId, parts[i]!, {
        parse_mode: 'MarkdownV2',
      });
      messageIds.push(sent.message_id);
    }

    // Plain-text WhatsApp block (if topMessageDraft exists).
    if (job.topMessageDraft && job.topMessageDraft.trim().length > 0) {
      const plainText = formatTopMessagePlainText(job.topName, job.topMessageDraft);
      const sent = await bot.api.sendMessage(job.chatId, plainText);
      messageIds.push(sent.message_id);
    }

    job.deliveryMessageIds = messageIds;
    job.approvalStatus = 'delivered';
    return true;
  }

  function buildApproveKeyboard(topName: string, jobId: string): InlineKeyboard {
    return new InlineKeyboard()
      .text(`✅ Подтвердить → ${topName}`, `approve:${jobId}`)
      .text('✏️ Исправить', `edit:${jobId}`)
      .text('❌ Отклонить', `reject:${jobId}`);
  }

  function buildPostApproveKeyboard(jobId: string): InlineKeyboard {
    return new InlineKeyboard()
      .text('📝 Уточнение', `post_note:${jobId}`)
      .text('🔗 Подробнее', `post_detail:${jobId}`);
  }

  async function safeReply(ctx: Context, text: string, replyId?: number): Promise<number | undefined> {
    try {
      const sent = await ctx.reply(text, {
        parse_mode: 'MarkdownV2',
        reply_parameters: replyId ? { message_id: replyId } : undefined,
      });
      return sent.message_id;
    } catch (err) {
      // MarkdownV2 parse error fallback → plain text.
      if (err instanceof GrammyError && err.error_code === 400) {
        log.warn({ err: err.description, text: text.slice(0, 80) }, 'bot.markdown.fallback');
        try {
          const sent = await ctx.reply(text);
          return sent.message_id;
        } catch (err2) {
          log.error({ err: err2 }, 'plain text reply also failed');
          return undefined;
        }
      }
      log.error({ err }, 'safeReply failed');
      return undefined;
    }
  }

  async function safeEditMessage(
    chatId: number,
    messageId: number,
    text: string,
  ): Promise<boolean> {
    try {
      await bot.api.editMessageText(chatId, messageId, text, {
        parse_mode: 'MarkdownV2',
      });
      return true;
    } catch (err) {
      if (err instanceof GrammyError) {
        // 429 rate-limit or "message is not modified" — log & continue (UX-DR3).
        if (err.error_code === 429) {
          log.warn({ retryAfter: err.parameters?.retry_after }, 'bot.editMessage.rate_limited');
          return false;
        }
        if (err.description?.includes('message is not modified')) {
          return true;
        }
        if (err.error_code === 400) {
          log.warn(
            { err: err.description, text: text.slice(0, 80) },
            'bot.markdown.fallback (edit)',
          );
          try {
            await bot.api.editMessageText(chatId, messageId, text);
            return true;
          } catch (err2) {
            log.error({ err: err2 }, 'plain edit also failed');
            return false;
          }
        }
      }
      log.error({ err }, 'safeEditMessage failed');
      return false;
    }
  }

  async function emitProgress(job: ReportJob, step: ProgressStep): Promise<void> {
    if (!progressUpdatesEnabled) return;
    if (job.progressMessageId === undefined) return;
    await safeEditMessage(job.chatId, job.progressMessageId, formatProgressStep(step));
  }

  function scheduleTimeout(jobId: string): void {
    const timer = setTimeout(() => {
      void onJobTimeout(jobId);
    }, JOB_TIMEOUT_MS);
    // Unref so a stuck timer doesn't hold the process open during shutdown.
    timer.unref?.();
    jobTimers.set(jobId, timer);
  }

  function clearJobTimer(jobId: string): void {
    const timer = jobTimers.get(jobId);
    if (timer !== undefined) {
      clearTimeout(timer);
      jobTimers.delete(jobId);
    }
  }

  async function onJobTimeout(jobId: string): Promise<void> {
    const job = queue.peek(jobId);
    if (job === undefined) return;
    if (job.status === 'completed' || job.status === 'failed') return;

    timedOutJobs.add(jobId);
    job.status = 'failed';
    job.completedAt = now().toISOString();

    log.error(
      { jobId, chatId: job.chatId, elapsedMs: JOB_TIMEOUT_MS },
      'bot.report.timeout',
    );
    alertOps({
      pipeline: 'F1',
      step: 'bot.report.timeout',
      clientId: job.clientId,
      error: new Error('job timeout'),
      context: { jobId, elapsedMs: JOB_TIMEOUT_MS, urlPath: sanitizeUrlForLog(job.url) },
    } satisfies AlertPayload);

    if (job.progressMessageId !== undefined) {
      await safeEditMessage(job.chatId, job.progressMessageId, escapeMarkdownV2(formatErrorMessage('timeout')));
    }
  }

  function failureMessageForTranscriptError(err: unknown): {
    text: string;
    severity: 'info' | 'warn' | 'error';
    code: string;
  } {
    if (err instanceof TranscriptValidationError) {
      if (err.code === 'too_short') {
        return {
          text: formatErrorMessage('transcript_too_short'),
          severity: 'info',
          code: `validation.${err.code}`,
        };
      }
      if (err.code === 'empty') {
        // Empty transcript likely signals a Soniox failure, not a short recording — alert ops.
        return {
          text: formatErrorMessage('transcript_too_short'),
          severity: 'warn',
          code: `validation.${err.code}`,
        };
      }
      return {
        text: formatErrorMessage('pipeline_failed'),
        severity: 'error',
        code: `validation.${err.code}`,
      };
    }
    if (err instanceof TranscriptDownloadError) {
      return {
        text: formatErrorMessage('transcript_download_failed'),
        severity: 'warn',
        code: `download.${err.code}`,
      };
    }
    if (err instanceof TranscriptProviderError) {
      return {
        text: formatErrorMessage('pipeline_failed'),
        severity: 'warn',
        code: `provider.${err.code}`,
      };
    }
    return {
      text: formatErrorMessage('pipeline_failed'),
      severity: 'error',
      code: 'unknown',
    };
  }

  async function renderFinalReport(job: ReportJob, reportText: string): Promise<number | undefined> {
    const continuation = `📋 ${escapeMarkdownV2(job.topName)} \\(продолжение\\)`;
    const parts = splitForTelegram(reportText, TELEGRAM_SAFE_MARGIN, continuation);

    if (parts.length === 0) return undefined;

    let lastMessageId: number | undefined;
    let firstPartSent = false;
    if (job.progressMessageId !== undefined) {
      firstPartSent = await safeEditMessage(job.chatId, job.progressMessageId, parts[0]!);
      if (firstPartSent) {
        lastMessageId = job.progressMessageId;
      }
    }
    if (!firstPartSent) {
      try {
        const sent = await bot.api.sendMessage(job.chatId, parts[0]!, { parse_mode: 'MarkdownV2' });
        lastMessageId = sent.message_id;
      } catch (err) {
        log.error({ err }, 'sendMessage initial failed');
      }
    }

    for (let i = 1; i < parts.length; i++) {
      try {
        const sent = await bot.api.sendMessage(job.chatId, parts[i]!, { parse_mode: 'MarkdownV2' });
        lastMessageId = sent.message_id;
      } catch (err) {
        if (err instanceof GrammyError && err.error_code === 400) {
          log.warn({ err: err.description }, 'bot.markdown.fallback (continuation)');
          try {
            const sent = await bot.api.sendMessage(job.chatId, parts[i]!);
            lastMessageId = sent.message_id;
          } catch (err2) {
            log.error({ err: err2 }, 'plain continuation failed');
          }
        } else {
          log.error({ err }, 'continuation send failed');
        }
      }
    }

    return lastMessageId;
  }

  async function processJob(job: ReportJob): Promise<void> {
    const jobLog = log.child({ jobId: job.id, chatId: job.chatId, clientId: job.clientId });
    const start = Date.now();
    job.status = 'running';
    job.startedAt = now().toISOString();

    try {
      await emitProgress(job, 'running_extraction');

      let transcript;
      try {
        transcript = await transcribeFromUrl(job.url, {
          clientId: job.clientId,
          meetingDate: job.meetingDate,
          meetingType: job.meetingType,
        });
      } catch (err) {
        if (timedOutJobs.has(job.id)) {
          jobLog.info('job already timed out; discarding transcript error');
          return;
        }
        const failure = failureMessageForTranscriptError(err);
        if (job.progressMessageId !== undefined) {
          await safeEditMessage(job.chatId, job.progressMessageId, escapeMarkdownV2(failure.text));
        }
        jobLog.warn(
          { err, errorCode: failure.code },
          'bot.report.transcript_failed',
        );
        if (failure.severity !== 'info') {
          alertOps({
            pipeline: 'F1',
            step: 'bot.report.transcript_failed',
            clientId: job.clientId,
            error: err,
            context: {
              jobId: job.id,
              errorCode: failure.code,
              urlPath: sanitizeUrlForLog(job.url),
            },
          });
        }
        job.status = 'failed';
        job.completedAt = now().toISOString();
        return;
      }

      // Defensive guard на коротких записях (FR / UX-DR66).
      try {
        assertTranscriptDuration(transcript);
      } catch (err) {
        if (job.progressMessageId !== undefined) {
          await safeEditMessage(
            job.chatId,
            job.progressMessageId,
            escapeMarkdownV2(formatErrorMessage('transcript_too_short')),
          );
        }
        jobLog.info(
          {
            durationSec: (err as TranscriptValidationError).context?.durationSec,
          },
          'bot.report.too_short',
        );
        // info-level — без alertOps (UX-DR66).
        job.status = 'failed';
        job.completedAt = now().toISOString();
        return;
      }

      await emitProgress(job, 'running_analysis');
      const clientContext = await readClientContext({ clientId: job.clientId });

      await emitProgress(job, 'running_formatting');

      if (timedOutJobs.has(job.id)) {
        jobLog.info('job timed out before runF1; discarding');
        return;
      }

      const result = await runF1({
        transcript,
        clientContext,
        meta: {
          clientId: job.clientId,
          topName: job.topName,
          meetingDate: job.meetingDate,
          meetingType: job.meetingType,
        },
      });

      if (timedOutJobs.has(job.id)) {
        jobLog.info('job timed out during pipeline; discarding result');
        return;
      }

      await emitProgress(job, 'almost_ready');

      // Mutable fields on job for downstream consumers (Story 1.6 approvals).
      job.partial = result.formattedReport.partial;
      if (result.formattedReport.partial) {
        job.partialReason = result.formattedReport.partialReason;
        alertOps({
          pipeline: 'F1',
          step: 'bot.report.partial_result',
          clientId: job.clientId,
          error: new Error('partial result delivered'),
          context: {
            jobId: job.id,
            partialReason: result.formattedReport.partialReason,
          },
        });
      }

      const text = formatDeliveryReport(result.formattedReport);
      const lastMessageId = await renderFinalReport(job, text);
      job.lastReportText = text;

      // Preserve topMessageDraft for delivery step (Story 1.7).
      if (!result.formattedReport.partial && result.formattedReport.topMessageDraft) {
        job.topMessageDraft = result.formattedReport.topMessageDraft;
      }

      // Attach approve keyboard to the last message (non-partial reports only).
      if (!result.formattedReport.partial && lastMessageId !== undefined) {
        try {
          await bot.api.editMessageReplyMarkup(job.chatId, lastMessageId, {
            reply_markup: buildApproveKeyboard(job.topName, job.id),
          });
        } catch (err) {
          log.warn({ err, jobId: job.id }, 'bot.approve.keyboard_attach_failed');
        }
      }

      job.status = 'completed';
      job.completedAt = now().toISOString();

      jobLog.info(
        {
          step: 'bot.report.completed',
          partial: result.formattedReport.partial,
          partialReason: result.partialReason,
          durationMs: Date.now() - start,
        },
        'F1 report delivered to Telegram',
      );
    } catch (err) {
      if (timedOutJobs.has(job.id)) {
        jobLog.info('job timed out; suppressing post-timeout error');
        return;
      }
      if (isAbortError(err)) {
        jobLog.info({ jobId: job.id }, 'job aborted');
        job.status = 'failed';
        job.completedAt = now().toISOString();
        return;
      }
      // Catch-all (NFR9, architecture#Error Handling). Worker MUST NOT crash.
      if (job.progressMessageId !== undefined) {
        await safeEditMessage(
          job.chatId,
          job.progressMessageId,
          escapeMarkdownV2(formatErrorMessage('pipeline_failed')),
        );
      }
      const errorName = err instanceof Error ? err.name : 'Unknown';
      const errorCode = (err as { code?: string })?.code;
      jobLog.error({ err, errorName, errorCode }, 'bot.report.failed');
      alertOps({
        pipeline: 'F1',
        step: 'bot.report.pipeline_failed',
        clientId: job.clientId,
        error: err,
        context: { jobId: job.id, errorName, errorCode },
      });
      job.status = 'failed';
      job.completedAt = now().toISOString();
    } finally {
      clearJobTimer(job.id);
      timedOutJobs.delete(job.id);
      completedJobs.set(job.id, job);
      if (completedJobs.size > MAX_COMPLETED_JOBS) {
        const oldestKey = completedJobs.keys().next().value;
        if (oldestKey !== undefined) completedJobs.delete(oldestKey);
      }
    }
  }

  // ───────── Middleware: whitelist auth ─────────
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined || !trackerChatIds.has(chatId)) {
      const command = ctx.message?.text?.slice(0, 80);
      log.warn({ chatId, command }, 'bot.unauthorized');
      alertOps({
        pipeline: 'F1',
        step: 'bot.unauthorized',
        error: new Error('unauthorized chat'),
        context: { chatId, command },
      });
      try {
        await ctx.reply(formatErrorMessage('unauthorized'));
      } catch (err) {
        log.warn({ err }, 'failed to send unauthorized reply');
      }
      return;
    }
    await next();
  });

  // ───────── /start and /help (Story 1.8) ─────────
  bot.command('start', async (ctx) => {
    const firstName = ctx.from?.first_name?.trim() || undefined;
    const welcomeText = formatWelcomeMessage(firstName);
    try {
      await ctx.reply(welcomeText);
    } catch (err) {
      log.warn({ err, chatId: ctx.chat.id }, 'bot.start.reply_failed');
    }
    log.info(
      { step: 'bot.start.welcomed', chatId: ctx.chat.id, firstName },
      'welcome sent',
    );
  });

  bot.command('help', async (ctx) => {
    const firstName = ctx.from?.first_name?.trim() || undefined;
    const welcomeText = formatWelcomeMessage(firstName);
    try {
      await ctx.reply(welcomeText);
    } catch (err) {
      log.warn({ err, chatId: ctx.chat.id }, 'bot.help.reply_failed');
    }
    log.info({ step: 'bot.help.requested', chatId: ctx.chat.id }, 'help sent');
  });

  // ───────── /report command ─────────
  bot.command('report', async (ctx) => {
    const arg = ctx.match ?? '';
    const parsed = parseReportUrl(arg);
    if (!parsed.ok) {
      const reason: UrlParseFailure = parsed.reason;
      const text = formatErrorMessage(reason);
      log.info({ chatId: ctx.chat.id, reason }, 'bot.report.invalid_input');
      await ctx.reply(text).catch(() => {});
      return;
    }

    // Pre-check overflow before sending ack so we never send an ack for a job that won't run.
    if (queue.size() >= queueMaxSize) {
      log.warn(
        { chatId: ctx.chat.id, queueSize: queue.size(), maxSize: queueMaxSize },
        'bot.queue_overflow',
      );
      alertOps({
        pipeline: 'F1',
        step: 'bot.queue_overflow',
        error: new QueueOverflowError(queueMaxSize, queue.size()),
        context: { queueSize: queue.size(), maxSize: queueMaxSize },
      });
      await ctx.reply(formatErrorMessage('queue_overflow')).catch(() => {});
      return;
    }

    const job: ReportJob = {
      id: randomUUID().slice(0, 8),
      chatId: ctx.chat.id,
      url: parsed.url,
      clientId: DEFAULT_CLIENT_ID,
      topName: DEFAULT_TOP_NAME,
      meetingDate: now().toISOString().slice(0, 10),
      status: 'queued',
      queuedAt: now().toISOString(),
      retryCount: 0,
    };

    // Send ack BEFORE enqueue so progressMessageId is set when the worker first reads the job.
    const estimatedPosition = queue.size() + 1;
    let ackMessageId: number | undefined;
    try {
      const ack = await ctx.reply(formatQueueAck(estimatedPosition, estimatedPosition));
      ackMessageId = ack.message_id;
    } catch (err) {
      log.error({ err }, 'ack reply failed');
    }
    job.progressMessageId = ackMessageId;

    // Enqueue after progressMessageId is set; worker wakes only after this line.
    let placement: { position: number; queueSize: number };
    try {
      placement = queue.enqueue(job);
    } catch (err) {
      if (err instanceof QueueOverflowError) {
        // Tight race: another job slipped in between the pre-check above and here.
        log.warn({ chatId: ctx.chat.id }, 'bot.queue_overflow.race');
        alertOps({
          pipeline: 'F1',
          step: 'bot.queue_overflow',
          error: err,
          context: { queueSize: err.currentSize, maxSize: err.maxSize },
        });
        if (ackMessageId !== undefined) {
          await bot.api
            .editMessageText(job.chatId, ackMessageId, formatErrorMessage('queue_overflow'))
            .catch(() => {});
        }
        return;
      }
      throw err;
    }

    scheduleTimeout(job.id);

    log.info(
      {
        step: 'bot.report.queued',
        jobId: job.id,
        chatId: ctx.chat.id,
        position: placement.position,
        queueSize: placement.queueSize,
      },
      'job enqueued',
    );
  });

  // ───────── Approval callback handlers ─────────

  bot.callbackQuery(/^approve:(.+)$/, async (ctx) => {
    const jobId = ctx.match[1]!;
    const job = peekJob(jobId);

    if (job === undefined) {
      await ctx.answerCallbackQuery({ text: 'ℹ️ Отчёт уже недоступен.' });
      log.warn({ jobId }, 'bot.approve.job_not_found');
      return;
    }
    if (job.approvalStatus === 'approved' || job.approvalStatus === 'delivered') {
      await ctx.answerCallbackQuery({ text: 'ℹ️ Уже отправлено.' });
      return;
    }
    if (job.approvalStatus === 'editing') {
      await ctx.answerCallbackQuery({ text: '✏️ Редактирование в процессе.' });
      return;
    }
    if (job.approvalStatus === 'rejected') {
      await ctx.answerCallbackQuery({ text: 'ℹ️ Уже отклонён.' });
      return;
    }

    job.approvalStatus = 'approved';
    await ctx.answerCallbackQuery();

    try {
      await ctx.editMessageReplyMarkup({ reply_markup: buildPostApproveKeyboard(jobId) });
    } catch (err) {
      log.warn({ err, jobId }, 'bot.approve.keyboard_replace_failed');
    }

    await ctx.reply(`✅ Подтверждено. Готово к пересылке ${job.topName}.`);

    const record: ApprovalRecord = {
      reportId: job.id,
      clientId: job.clientId,
      topName: job.topName,
      chatId: job.chatId,
      approvedAt: now().toISOString(),
      status: 'approved',
    };
    try {
      await appendApproval(record);
    } catch (err) {
      log.error({ err, jobId }, 'bot.approve.persist_failed');
      alertOps({
        pipeline: 'F1',
        step: 'bot.approve.persist_failed',
        clientId: job.clientId,
        error: err,
        context: { jobId },
      });
    }

    log.info({ step: 'bot.approve.completed', jobId, topName: job.topName }, 'report approved');

    // Story 1.7: Deliver report to Aziza for forwarding.
    try {
      await deliverReport(job);
      log.info({ step: 'bot.delivery.completed', jobId, topName: job.topName }, 'delivery sent');
    } catch (err) {
      log.warn({ err, jobId }, 'bot.delivery.failed');
      await ctx.reply('⚠️ Не доставлено. Попробуй ещё раз.', {
        reply_markup: new InlineKeyboard().text('🔄 Повторить', `retry_delivery:${jobId}`),
      });
    }
  });

  bot.callbackQuery(/^edit:(.+)$/, async (ctx) => {
    const jobId = ctx.match[1]!;
    const job = peekJob(jobId);

    if (job === undefined) {
      await ctx.answerCallbackQuery({ text: 'ℹ️ Отчёт уже недоступен.' });
      log.warn({ jobId }, 'bot.edit.job_not_found');
      return;
    }
    if (job.approvalStatus === 'approved' || job.approvalStatus === 'delivered') {
      await ctx.answerCallbackQuery({ text: 'ℹ️ Уже подтверждено.' });
      return;
    }
    if (job.approvalStatus === 'editing') {
      await ctx.answerCallbackQuery({ text: '✏️ Ожидаю твой ответ.' });
      return;
    }

    // If another job for this chat is in editing state, reset it before taking over.
    const priorPending = pendingEdits.get(job.chatId);
    if (priorPending !== undefined && priorPending.jobId !== jobId) {
      const priorJob = peekJob(priorPending.jobId);
      if (priorJob?.approvalStatus === 'editing') {
        priorJob.approvalStatus = undefined;
        priorJob.pendingEditInstructionMessageId = undefined;
      }
    }

    job.approvalStatus = 'editing';
    await ctx.answerCallbackQuery();

    let instructionMessageId: number | undefined;
    try {
      const sent = await ctx.reply(
        '✏️ Что исправить\\? *Ответь* на это сообщение с правкой\\.\nПример: «Конверсия 30%, не 28%»',
        { parse_mode: 'MarkdownV2' },
      );
      instructionMessageId = sent.message_id;
      job.pendingEditInstructionMessageId = instructionMessageId;
    } catch (err) {
      log.error({ err, jobId }, 'bot.edit.instruction_failed');
      job.approvalStatus = undefined;
      return;
    }

    pendingEdits.set(job.chatId, { jobId, instructionMessageId: instructionMessageId! });
    log.info({ step: 'bot.edit.started', jobId }, 'edit flow started');
  });

  bot.callbackQuery(/^reject:(.+)$/, async (ctx) => {
    const jobId = ctx.match[1]!;
    const job = peekJob(jobId);

    if (job === undefined) {
      await ctx.answerCallbackQuery({ text: 'ℹ️ Отчёт уже недоступен.' });
      log.warn({ jobId }, 'bot.reject.job_not_found');
      return;
    }
    if (job.approvalStatus !== undefined) {
      await ctx.answerCallbackQuery({ text: 'ℹ️ Уже обработано.' });
      return;
    }

    job.approvalStatus = 'rejected';
    pendingEdits.delete(job.chatId);
    await ctx.answerCallbackQuery();

    try {
      await ctx.editMessageReplyMarkup();
    } catch (err) {
      log.warn({ err, jobId }, 'bot.reject.keyboard_remove_failed');
    }

    await ctx.reply('❌ Отчёт отклонён. Отправь исправленную ссылку командой /report.');
    log.info({ step: 'bot.reject.completed', jobId }, 'report rejected');
  });

  // Story 1.7: retry delivery handler
  bot.callbackQuery(/^retry_delivery:(.+)$/, async (ctx) => {
    const jobId = ctx.match[1]!;
    const job = peekJob(jobId);

    if (job === undefined) {
      await ctx.answerCallbackQuery({ text: 'ℹ️ Отчёт уже недоступен.' });
      return;
    }
    if (job.approvalStatus === 'delivered') {
      await ctx.answerCallbackQuery({ text: 'ℹ️ Уже доставлено.' });
      return;
    }
    if (job.approvalStatus !== 'approved') {
      await ctx.answerCallbackQuery({ text: 'ℹ️ Сначала подтверди отчёт.' });
      return;
    }

    await ctx.answerCallbackQuery();

    try {
      await deliverReport(job);
      log.info({ step: 'bot.delivery.retry.completed', jobId }, 'delivery retry succeeded');
    } catch (err) {
      log.warn({ err, jobId }, 'bot.delivery.retry.failed');
      await ctx.reply('⚠️ Не доставлено. Попробуй ещё раз.', {
        reply_markup: new InlineKeyboard().text('🔄 Повторить', `retry_delivery:${jobId}`),
      });
      alertOps({
        pipeline: 'F1',
        step: 'bot.delivery.retry.failed',
        clientId: job.clientId,
        error: err,
        context: { jobId },
      });
    }
  });

  // Story 1.7: post_note handler — follow-up correction after delivery
  bot.callbackQuery(/^post_note:(.+)$/, async (ctx) => {
    const jobId = ctx.match[1]!;
    const job = peekJob(jobId);

    if (job === undefined) {
      await ctx.answerCallbackQuery({ text: 'ℹ️ Отчёт уже недоступен.' });
      return;
    }
    // Уточнение доступно только после delivery.
    if (job.approvalStatus !== 'delivered') {
      await ctx.answerCallbackQuery({ text: 'ℹ️ Сначала дождись доставки отчёта.' });
      return;
    }

    await ctx.answerCallbackQuery();

    const sent = await ctx.reply(
      `📝 Напиши уточнение для ${job.topName}. Ответь на это сообщение.`,
    );
    pendingNotes.set(job.chatId, { jobId, instructionMessageId: sent.message_id });
    log.info({ step: 'bot.post_note.started', jobId }, 'note flow started');
  });

  // Story 1.7: post_detail stub (separate from post_note)
  bot.callbackQuery(/^post_detail:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Скоро доступно 🔜' });
    log.info({ step: 'bot.post_approve.stub', action: ctx.callbackQuery.data }, 'stub handler');
  });

  // ───────── Edit reply handler ─────────

  bot.on('message:text', async (ctx) => {
    const chatId = ctx.chat.id;

    // Story 1.7: Check pendingNotes first (post-delivery corrections).
    const note = pendingNotes.get(chatId);
    if (note !== undefined) {
      const noteReplyToId = ctx.message.reply_to_message?.message_id;
      if (noteReplyToId === note.instructionMessageId) {
        const job = peekJob(note.jobId);
        if (job === undefined) {
          pendingNotes.delete(chatId);
          await ctx.reply('ℹ️ Отчёт уже недоступен.');
          return;
        }
        const correction = ctx.message.text.trim();
        if (!correction) return;

        pendingNotes.delete(chatId);
        const noteText = `📝 Уточнение к отчёту ${job.topName}:\n${correction}`;
        await ctx.reply(noteText); // plain text, для WhatsApp forwarding.
        log.info(
          { step: 'bot.post_note.sent', jobId: note.jobId, len: correction.length },
          'note sent',
        );
        return;
      }
      // Reply not on note instruction — fallthrough to pendingEdits.
    }

    const pending = pendingEdits.get(chatId);
    if (pending === undefined) {
      // Story 1.8: fallback hint вместо молчания (UX-DR3 «Тишина — враг»).
      // Сюда падают: свободный текст без reply и неизвестные команды
      // (Telegram доставляет их как обычный message:text без bot_command match).
      try {
        await ctx.reply(formatHelpHint());
      } catch (err) {
        log.warn({ err, chatId }, 'bot.fallback.reply_failed');
      }
      log.info(
        { step: 'bot.fallback.hint', chatId, textLen: ctx.message.text.length },
        'fallback hint sent',
      );
      return;
    }

    const replyToId = ctx.message.reply_to_message?.message_id;
    if (replyToId === undefined) return;
    if (replyToId !== pending.instructionMessageId) {
      await ctx.reply('⚠️ Нажми [✏️] под нужным отчётом.');
      return;
    }

    const job = peekJob(pending.jobId);
    if (job === undefined) {
      pendingEdits.delete(chatId);
      await ctx.reply('ℹ️ Отчёт уже недоступен.');
      return;
    }

    const correction = ctx.message.text.trim();
    if (!correction) {
      await ctx.reply('⚠️ Напиши что именно исправить.');
      return;
    }

    pendingEdits.delete(chatId);
    job.approvalStatus = undefined;
    job.pendingEditInstructionMessageId = undefined;

    let ackMsgId: number | undefined;
    try {
      const ack = await ctx.reply('⏳ Применяю правку…');
      ackMsgId = ack.message_id;
    } catch { /* swallow ack failure */ }

    try {
      const updatedText = await applyEditToReport(job.lastReportText ?? '', correction);
      job.lastReportText = updatedText;

      if (ackMsgId !== undefined) {
        await bot.api.deleteMessage(chatId, ackMsgId).catch(() => {});
      }

      const continuation = `📋 ${escapeMarkdownV2(job.topName)} \\(продолжение\\)`;
      const parts = splitForTelegram(updatedText, TELEGRAM_SAFE_MARGIN, continuation);
      for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        try {
          await bot.api.sendMessage(job.chatId, parts[i]!, {
            parse_mode: 'MarkdownV2',
            reply_markup: isLast ? buildApproveKeyboard(job.topName, job.id) : undefined,
          });
        } catch (err) {
          if (err instanceof GrammyError && err.error_code === 400) {
            log.warn({ err: err.description, jobId: job.id, partIndex: i }, 'bot.edit.markdown.fallback');
            try {
              await bot.api.sendMessage(job.chatId, parts[i]!, {
                reply_markup: isLast ? buildApproveKeyboard(job.topName, job.id) : undefined,
              });
            } catch (err2) {
              log.error({ err: err2, jobId: job.id, partIndex: i }, 'bot.edit.send_updated_failed');
            }
          } else {
            log.error({ err, jobId: job.id, partIndex: i }, 'bot.edit.send_updated_failed');
          }
        }
      }

      log.info(
        { step: 'bot.edit.applied', jobId: job.id, correctionLen: correction.length },
        'edit correction applied',
      );
    } catch (err) {
      if (ackMsgId !== undefined) {
        await bot.api.deleteMessage(chatId, ackMsgId).catch(() => {});
      }
      job.approvalStatus = undefined;
      await ctx.reply('⚠️ Не удалось применить правку. Попробуй снова или нажми ✏️ ещё раз.');
      alertOps({
        pipeline: 'F1',
        step: 'bot.edit.failed',
        clientId: job.clientId,
        error: err,
        context: { jobId: job.id },
      });
      log.warn({ err, jobId: job.id }, 'bot.edit.apply_failed');
    }
  });

  // ───────── Worker lifecycle ─────────
  let stopWorker: (() => Promise<void>) | null = null;
  let started = false;

  const stop = async (): Promise<void> => {
    if (stopWorker !== null) {
      await stopWorker();
      stopWorker = null;
    }
    if (started) {
      try {
        await bot.stop();
      } catch (err) {
        log.warn({ err }, 'bot.stop threw');
      }
    }
    for (const timer of jobTimers.values()) clearTimeout(timer);
    jobTimers.clear();
  };

  const start = async (): Promise<void> => {
    stopWorker = queue.startWorker((job) => processJob(job), { logger: log });

    try {
      await bot.api.setMyCommands([
        { command: 'start',  description: 'Начать работу с ботом' },
        { command: 'help',   description: 'Инструкция и список команд' },
        { command: 'report', description: 'Создать отчёт по встрече' },
      ]);
    } catch (err) {
      log.warn({ err }, 'failed to set bot commands — continuing');
    }
    try {
      await bot.api.setChatMenuButton({ menu_button: { type: 'commands' } });
    } catch (err) {
      log.warn({ err }, 'failed to set chat menu button — continuing');
    }

    started = true;
    await bot.start({ drop_pending_updates: true });
  };

  return { bot, queue, processJob, stop, start };
}
