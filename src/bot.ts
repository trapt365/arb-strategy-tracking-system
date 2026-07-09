import { Bot, GrammyError, InlineKeyboard, type Context } from 'grammy';
import { randomUUID } from 'node:crypto';
import type { UserFromGetMe } from 'grammy/types';
import { config, parseTrackerChatIds } from './config.js';
import { logger as rootLogger, type Logger } from './logger.js';
import {
  alertOps as defaultAlertOps,
  recordOpsEvent,
  setOpsTelegramSender,
  setOpsSheetsWriter,
  startWatchdog,
  type AlertPayload,
  type WatchdogHandle,
} from './ops.js';
import { transcribeFromUrl as defaultTranscribeFromUrl } from './adapters/transcript.js';
import { readClientContext as defaultReadClientContext, appendOpsLog } from './adapters/sheets.js';
import { runF1 as defaultRunF1, applyEditToReport as defaultApplyEditToReport } from './f1-report.js';
import {
  appendApproval as defaultAppendApproval,
  isAlreadyApproved as defaultIsAlreadyApproved,
} from './utils/approvals.js';
import { assertClientId, ClientIdError } from './utils/client-id.js';
import { startScheduler as defaultStartScheduler } from './scheduler.js';
import type { ApprovalRecord } from './types.js';
import {
  TranscriptDownloadError,
  TranscriptProviderError,
  TranscriptValidationError,
} from './errors.js';
import { parseReportUrl, type UrlParseFailure } from './utils/url-parser.js';
import {
  runF0FullDraft as defaultRunF0FullDraft,
  renderF0DraftSummaryMessage,
  persistF0FullDraft,
  persistF0Session,
  loadF0Session,
  deleteF0Session,
  markBlockingKrIssues,
  markHypothesesWithoutMetric,
  type F0FullDraftResult,
} from './f0-onboarding.js';
import { importStrategyXlsx, xlsxToText, type F0ImportResult } from './f0-import.js';
import {
  computeF0Gaps,
  computeHypoMetricGaps,
  applyF0Answer,
  needsNumericAnswer,
  looksNumericAnswer,
  type F0Gap,
} from './f0-fill.js';
import { createClientSpreadsheet as defaultCreateClientSpreadsheet } from './f0-sheets.js';
import {
  buildClientCard,
  persistClientCard,
  loadClientCard,
  clientIdFromCompany,
  computeReadinessChecklist,
  renderReadinessMessage,
  renderClientCardMessage,
} from './f0-client-card.js';
import {
  upsertClient,
  getClientTopName,
  getClientName,
  listClientIds,
  getClientSheetId,
  loadRegistry,
  getActiveClient,
  setActiveClient,
} from './client-registry.js';
import type { F0FullExtraction } from './types.js';
import { extractTextFromDocument as defaultExtractTextFromDocument } from './utils/f0-document.js';
import {
  isSupportedF0Document,
  isXlsxDocument,
  F0_MAX_FILE_BYTES,
  F0_MAX_DOC_CHARS,
} from './utils/f0-input.js';
import { F0OnboardingError, F0SheetsError } from './errors.js';
import { assertTranscriptDuration } from './utils/transcript-duration-guard.js';
import { createReportQueue, QueueOverflowError, type ReportQueue } from './utils/report-queue.js';
import { withRetry } from './utils/retry.js';
import {
  escapeMarkdownV2,
  formatDeliveryReportCompact,
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
// Story 8.2 (W8): имя топа Geonline — только для его же fallback-пути (пилот без записи
// в реестре). Для остальных клиентов дефолт нейтральный: имя компании из реестра.
const GEONLINE_DEFAULT_TOP_NAME = 'Жанель';
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
  isAlreadyApproved?: typeof defaultIsAlreadyApproved;
  startScheduler?: typeof defaultStartScheduler;
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
  // Story 7.1/7.2: F0 onboarding deps (tests).
  runF0FullDraft?: typeof defaultRunF0FullDraft;
  // Story 7.4: создание Google Sheets клиента (тесты подменяют, чтобы не ходить в Google API).
  createClientSpreadsheet?: typeof defaultCreateClientSpreadsheet;
  extractTextFromDocument?: typeof defaultExtractTextFromDocument;
  /** Скачивание файла Telegram по file_path (тесты подменяют, чтобы не ходить в Bot API). */
  downloadTelegramFile?: (filePath: string) => Promise<Buffer>;
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
  // Story 7.3: отдельный child для F0-онбординга — иначе inline {pipeline:'F0'} даёт
  // дубль ключа pipeline поверх привязанного 'F1' в NDJSON.
  const f0Log = baseLogger.child({ pipeline: 'F0' });

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
  const isAlreadyApproved = deps.isAlreadyApproved ?? defaultIsAlreadyApproved;
  const startScheduler = deps.startScheduler ?? defaultStartScheduler;
  const runF0FullDraftFn = deps.runF0FullDraft ?? defaultRunF0FullDraft;
  const createClientSpreadsheetFn = deps.createClientSpreadsheet ?? defaultCreateClientSpreadsheet;
  const extractTextFromDocument = deps.extractTextFromDocument ?? defaultExtractTextFromDocument;
  const downloadTelegramFile =
    deps.downloadTelegramFile ??
    (async (filePath: string): Promise<Buffer> =>
      withRetry(
        async () => {
          const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
          if (!res.ok) {
            // httpStatus → defaultShouldRetry ретраит 429/5xx, но не 4xx (истёкший file_path).
            const err = Object.assign(new Error(`telegram file download failed: HTTP ${res.status}`), {
              httpStatus: res.status,
            });
            throw err;
          }
          return Buffer.from(await res.arrayBuffer());
        },
        { logger: log },
      ));
  const now = deps.now ?? ((): Date => new Date());
  const queue = deps.queue ?? createReportQueue({ maxSize: queueMaxSize, logger: log });

  // In tests, pass deps.botInfo explicitly to skip getMe(). In production, omit so grammY
  // calls getMe() on start — required for /cmd@username matching in group chats.
  const bot = new Bot(token, deps.botInfo !== undefined ? { botInfo: deps.botInfo } : undefined);

  // Story 1.9: ops-channel watchdog (separate from per-job timeouts below).
  // Lifecycle: started in createBot.start() (production only), stopped in createBot.stop().
  let _watchdogHandle: WatchdogHandle | null = null;

  // Story 1.10: in-process scheduler for daily cleanup + tar backup.
  let _schedulerHandle: { stop: () => void } | null = null;

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
  // Story 7.1: F0 onboarding session per chat (in-memory; восстановление после
  // рестарта — Story 7.3). Пока значима одна бита: `processing` — идёт ли обработка
  // документа (тогда новый документ отклоняем). Богатую машину состояний вводит 7.3,
  // когда появится диалог дозаполнения.
  interface F0AccumulatedDoc { sourceName: string; text: string }
  interface F0Session {
    id: string;
    processing: boolean;
    // collecting — приём файлов; filling — диалог дозаполнения; ready — онбординг завершён.
    phase: 'collecting' | 'filling' | 'ready';
    // Story 7.2: файлы пакета аккумулируются, черновик собирается по кнопке/команде.
    documents: F0AccumulatedDoc[];
    // Бегущая сумма символов пакета — ранний отказ до превышения бюджета извлечения.
    documentsChars: number;
    // Story 7.3: собранный черновик + очередь пробелов диалога дозаполнения.
    draft?: { draftId: string; sourceNames: string[]; extraction: F0FullExtraction };
    gaps: F0Gap[];
    gapIndex: number;
    schedule: string | null;
    // Story 7.4: id созданной Google Sheets (если уже создана) — retry без дублей.
    spreadsheetId?: string;
    // Story 8.6 (W6): по этому пробелу уже был переспрос числового формата —
    // следующий непустой ответ принимается как есть (не блокируем, максимум 1 переспрос).
    retryGapIndex?: number;
    // Story 8.5: путь онбординга. undefined до первого файла/кнопки; фиксируется
    // автодетектом по расширению или явной кнопкой; пути в одной сессии не смешиваются.
    mode?: 'import' | 'synthesis';
    // Story 8.5: распознанный xlsx (collecting, in-memory) — buildF0Draft берёт его
    // вместо LLM-вызова. Не персистится: collecting и так живёт только в памяти.
    importResult?: F0ImportResult & { sourceName: string };
    // Story 8.5: текстифицированный xlsx для «🧠 Досинтезировать гипотезы» —
    // персистится с черновиком, кнопка работает и после рестарта.
    importSourceText?: string;
  }
  const f0Sessions = new Map<number, F0Session>();

  // Story 7.3: снимок сессии на диск (warn-only) — переживает рестарт бота.
  async function saveF0Session(chatId: number, s: F0Session): Promise<void> {
    if (s.draft === undefined) return; // до сборки черновика персистить нечего
    await persistF0Session({
      chatId,
      sessionId: s.id,
      phase: s.phase,
      draftId: s.draft.draftId,
      sourceNames: s.draft.sourceNames,
      extraction: s.draft.extraction,
      gaps: s.gaps,
      gapIndex: s.gapIndex,
      schedule: s.schedule,
      ...(s.spreadsheetId !== undefined ? { spreadsheetId: s.spreadsheetId } : {}),
      ...(s.retryGapIndex !== undefined ? { retryGapIndex: s.retryGapIndex } : {}),
      ...(s.mode !== undefined ? { mode: s.mode } : {}),
      ...(s.importSourceText !== undefined ? { importSourceText: s.importSourceText } : {}),
      updatedAt: now().toISOString(),
    });
  }

  /** Вернуть in-memory сессию или восстановить из персиста (AC3 Story 7.3). */
  async function getOrRestoreF0Session(chatId: number): Promise<F0Session | undefined> {
    const inMemory = f0Sessions.get(chatId);
    if (inMemory !== undefined) return inMemory;
    const persisted = await loadF0Session(chatId);
    if (persisted === null) return undefined;
    const restored: F0Session = {
      id: persisted.sessionId,
      processing: false,
      phase: persisted.phase,
      documents: [],
      documentsChars: 0,
      draft: {
        draftId: persisted.draftId,
        sourceNames: persisted.sourceNames,
        extraction: persisted.extraction,
      },
      gaps: persisted.gaps,
      gapIndex: persisted.gapIndex,
      schedule: persisted.schedule,
      spreadsheetId: persisted.spreadsheetId,
      retryGapIndex: persisted.retryGapIndex,
      mode: persisted.mode,
      importSourceText: persisted.importSourceText,
    };
    f0Sessions.set(chatId, restored);
    f0Log.info(
      { step: 'f0.session_restored', chatId, sessionId: restored.id, phase: restored.phase },
      'f0 session restored from disk',
    );
    return restored;
  }

  /** Look up a job by id in both live queue and completed-jobs store. */
  function peekJob(jobId: string): ReportJob | undefined {
    return queue.peek(jobId) ?? completedJobs.get(jobId);
  }

  /**
   * Send delivery-ready messages after approval.
   * Returns true if delivery succeeded, false otherwise.
   */
  async function deliverReport(job: ReportJob): Promise<boolean> {
    try {
      assertClientId(job.clientId);
    } catch (err) {
      log.error(
        { err, jobId: job.id, clientId: job.clientId, step: 'delivery.invalid_client_id' },
        'deliverReport blocked: invalid clientId',
      );
      recordOpsEvent('error', {
        pipeline: 'F1',
        step: 'delivery.invalid_client_id',
        clientId: job.clientId,
        context: { jobId: job.id },
      });
      alertOps({
        pipeline: 'F1',
        step: 'delivery.invalid_client_id',
        clientId: job.clientId,
        error: err,
        context: { jobId: job.id },
      });
      return false;
    }
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

      // Story 8.3 (W4): длинные отчёты — компактно + ссылка на таблицу клиента;
      // короткие проходят без изменений (formatDeliveryReportCompact сам решает).
      const sheetId = await getClientSheetId(job.clientId).catch(() => undefined);
      const sheetsUrl =
        sheetId !== undefined && sheetId.length > 0
          ? `https://docs.google.com/spreadsheets/d/${sheetId}/edit`
          : undefined;
      const text = formatDeliveryReportCompact(result.formattedReport, sheetsUrl);
      const deliveryStart = Date.now();
      const lastMessageId = await renderFinalReport(job, text);
      recordOpsEvent('info', {
        pipeline: 'F1',
        step: 'bot.report.delivery',
        clientId: job.clientId,
        durationMs: Date.now() - deliveryStart,
        status: result.formattedReport.partial ? 'partial' : 'ok',
        context: {
          jobId: job.id,
          partial: result.formattedReport.partial,
          lastMessageId,
        },
      });
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

      // Story 1.9: canonical success event → resets watchdog state, appends to _ops_logs.
      // durationMs = end-to-end (queuedAt → completedAt), не только processJob.
      const queuedMs = Date.parse(job.queuedAt);
      const completedMs = Date.parse(job.completedAt);
      const totalMs =
        Number.isFinite(queuedMs) && Number.isFinite(completedMs)
          ? completedMs - queuedMs
          : Date.now() - start;
      recordOpsEvent('info', {
        pipeline: 'F1',
        step: 'bot.report.completed',
        clientId: job.clientId,
        durationMs: totalMs,
        status: 'ok',
        context: { jobId: job.id, partial: result.formattedReport.partial },
      });
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

  // ───────── /start and /help (Story 1.8; меню — Story 8.4) ─────────

  // Story 8.4 (W1): стартовое меню — онбординг и клиенты доступны без запоминания команд.
  function buildMainMenuKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text('ℹ️ Что умеет бот', 'menu:help')
      .row()
      .text('🆕 Онбординг нового клиента', 'menu:new')
      .row()
      .text('👥 Клиенты', 'menu:clients');
  }

  bot.command('start', async (ctx) => {
    const firstName = ctx.from?.first_name?.trim() || undefined;
    const welcomeText = formatWelcomeMessage(firstName);
    try {
      await ctx.reply(welcomeText, { reply_markup: buildMainMenuKeyboard() });
    } catch (err) {
      log.warn({ err, chatId: ctx.chat.id }, 'bot.start.reply_failed');
      return;
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
      return;
    }
    log.info({ step: 'bot.help.requested', chatId: ctx.chat.id }, 'help sent');
  });

  // ───────── /newclient — F0 onboarding (Story 7.1 + 7.2) ─────────

  // Story 8.5: два пути входа — импорт готового Excel (без LLM) или синтез из документов.
  // Кнопки не обязательны: путь фиксируется и автоматически по расширению первого файла.
  const F0_START_TEXT = [
    '🆕 Онбординг нового клиента. Два пути:',
    '',
    '📥 Есть готовая стратегия в Excel — пришли один .xlsx, импортирую напрямую (без ИИ-пересборки).',
    '🧠 Есть документы (.md / .txt / .docx / .pdf): протокол сессии, OKR-документ, нарратив — пришли файлы, соберу стратегию из них. Можно несколько подряд; когда всё прислал — «Собрать черновик» или /draft.',
    '',
    'Путь можно выбрать кнопкой или просто прислать первый файл — пойму по формату.',
    'Соберу панель OKR, банк гипотез и участников. KR без числовой базы «с X до Y»/ответственного и гипотезы без метрики помечу 🔴.',
  ].join('\n');
  const F0_BUSY_TEXT = '⏳ Уже обрабатываю пакет — дождись черновика.';
  const F0_NO_SESSION_TEXT =
    'Чтобы начать онбординг нового клиента, отправь /newclient — затем пришли документы.';
  const F0_UNSUPPORTED_TEXT =
    '⚠️ Поддерживаются .md, .txt, .docx, .pdf. Пришли документ в одном из этих форматов.';
  const F0_TOO_LARGE_TEXT = '⚠️ Файл больше 20 МБ — Telegram не отдаёт такие боту. Сократи документ.';
  const F0_NO_DOCS_TEXT = 'ℹ️ Пакет пуст — сначала пришли хотя бы один файл артефакта.';
  const F0_MAX_PACKAGE_FILES = 20;
  const F0_PACKAGE_FULL_TEXT =
    `⚠️ В пакете уже ${F0_MAX_PACKAGE_FILES} файлов — достаточно. Собери черновик: /draft.`;

  // Exhaustive по F0OnboardingCode: компилятор потребует запись при новом коде ошибки.
  const F0_REPLY_BY_CODE: Record<F0OnboardingError['code'], string> = {
    not_okr_document:
      '⚠️ Не распознал материал как стратегию/OKR. Проверь, те ли файлы, или пришли другой артефакт.',
    binary_document: '⚠️ Файл выглядит бинарным/битым. Пришли корректный .md, .txt, .docx или .pdf.',
    empty_document: '⚠️ В файле нет извлекаемого текста (возможно, это скан-картинка без текстового слоя).',
    document_too_large:
      '⚠️ Пакет слишком большой для одного захода. Убери лишние файлы или пришли основной раздел.',
    document_parse_failed: '⚠️ Не смог разобрать файл. Проверь, что .docx/.pdf/.xlsx не повреждён.',
    file_too_large: F0_TOO_LARGE_TEXT,
    unsupported_file: F0_UNSUPPORTED_TEXT,
    import_unmappable:
      '⚠️ Не смог распознать в Excel таблицу стратегии: нужен лист с колонками KR — результат, база, цель, ответственный (минимум 3 из них).\n' +
      '🧠 Могу собрать стратегию из документов — пришли .md / .txt / .docx / .pdf.',
  };

  const f0BuildKeyboard = new InlineKeyboard().text('✅ Собрать черновик', 'f0_build');
  // Story 8.5: развилка путей на старте (кнопки опциональны — есть автодетект по файлу).
  const f0ModeKeyboard = new InlineKeyboard()
    .text('📥 Есть готовая стратегия (Excel)', 'f0_mode_import')
    .row()
    .text('🧠 Собрать из документов', 'f0_mode_synthesis');

  async function startF0Session(ctx: Context, trigger: string): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (f0Sessions.get(chatId)?.processing) {
      await ctx.reply(F0_BUSY_TEXT).catch(() => {});
      return;
    }
    const session: F0Session = {
      id: randomUUID().slice(0, 8),
      processing: false,
      phase: 'collecting',
      documents: [],
      documentsChars: 0,
      gaps: [],
      gapIndex: 0,
      schedule: null,
    };
    f0Sessions.set(chatId, session);
    await deleteF0Session(chatId); // сбрасываем персист прошлого онбординга этого чата
    f0Log.info(
      { step: 'f0.session_started', chatId, sessionId: session.id, trigger },
      'f0 onboarding session started',
    );
    await ctx.reply(F0_START_TEXT, { reply_markup: f0ModeKeyboard }).catch((err) => {
      log.warn({ err, chatId }, 'f0.start.reply_failed');
    });
  }

  // Story 8.5: явный выбор пути кнопкой. Работает только в collecting до первого файла —
  // после автодетекта путь уже зафиксирован, молча переключать накопленное нельзя.
  async function chooseF0Mode(ctx: Context, mode: 'import' | 'synthesis'): Promise<void> {
    await ctx.answerCallbackQuery().catch(() => {});
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const session = await getOrRestoreF0Session(chatId);
    if (session === undefined || session.phase !== 'collecting') {
      await ctx.reply(F0_NO_SESSION_TEXT).catch(() => {});
      return;
    }
    if (session.mode !== undefined && session.mode !== mode) {
      const fixed =
        session.mode === 'import'
          ? 'Путь уже определён: импорт Excel. Другой путь — начни заново: /newclient.'
          : 'Путь уже определён: сборка из документов. Другой путь — начни заново: /newclient.';
      await ctx.reply(`ℹ️ ${fixed}`).catch(() => {});
      return;
    }
    session.mode = mode;
    f0Log.info({ step: 'f0.mode_chosen', chatId, sessionId: session.id, mode }, 'f0 mode chosen');
    await ctx
      .reply(
        mode === 'import'
          ? '📥 Импорт готовой стратегии: пришли один .xlsx-файл.'
          : '🧠 Сборка из документов: пришли .md / .txt / .docx / .pdf (можно несколько).',
      )
      .catch(() => {});
  }

  bot.callbackQuery('f0_mode_import', async (ctx) => chooseF0Mode(ctx, 'import'));
  bot.callbackQuery('f0_mode_synthesis', async (ctx) => chooseF0Mode(ctx, 'synthesis'));

  // Story 8.4 (W3): сессия с несохранённым прогрессом — черновик с ответами (filling)
  // или собранный, но не отработанный пакет файлов (collecting). Ready не в счёт:
  // онбординг завершён, данные в таблице/карточке.
  function f0SessionAtRisk(session: F0Session | undefined): session is F0Session {
    if (session === undefined) return false;
    if (session.phase === 'filling') return true;
    // Story 8.5: принятый, но не отработанный xlsx — тоже несохранённый прогресс.
    return (
      session.phase === 'collecting' &&
      (session.documents.length > 0 || session.importResult !== undefined)
    );
  }

  /** Запуск онбординга с защитой от молчаливого сброса активной сессии (W3). */
  async function startF0SessionGuarded(ctx: Context, trigger: string): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const session = await getOrRestoreF0Session(chatId);
    if (f0SessionAtRisk(session)) {
      const company = session.draft?.extraction.company;
      const progress =
        session.phase === 'filling'
          ? `отвечено ${session.gapIndex} из ${session.gaps.length} вопросов`
          : session.importResult !== undefined
            ? 'принят Excel для импорта' // Story 8.5 (ревью LOW-1): не «файлов: 0»
            : `файлов в пакете: ${session.documents.length}`;
      await ctx
        .reply(
          `⚠️ Идёт онбординг${company !== undefined && company !== null ? ` «${company}»` : ''} (${progress}).\n` +
            'Начать нового клиента и сбросить этот прогресс?',
          {
            // session.id в callback_data: протухшая кнопка от ПРОШЛОЙ сессии не должна
            // молча сбросить текущую (W3 — ровно тот сценарий, от которого защищаемся).
            reply_markup: new InlineKeyboard()
              .text('🗑 Да, сбросить', `f0_new_yes:${session.id}`)
              .text('↩️ Продолжить текущий', 'f0_new_no'),
          },
        )
        .catch(() => {});
      f0Log.info(
        { step: 'f0.reset_guard', chatId, sessionId: session.id, phase: session.phase, trigger },
        'f0 new-client reset guarded — confirmation requested',
      );
      return;
    }
    await startF0Session(ctx, trigger);
  }

  bot.command('newclient', async (ctx) => {
    await startF0SessionGuarded(ctx, 'command');
  });

  const F0_STALE_BUTTON_TEXT = '⌛ Кнопка устарела — она от другой сессии онбординга.';

  bot.callbackQuery(/^f0_new_yes:(.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const current = await getOrRestoreF0Session(chatId);
    if (current === undefined || current.id !== ctx.match[1]!) {
      await ctx.answerCallbackQuery({ text: F0_STALE_BUTTON_TEXT }).catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    await startF0Session(ctx, 'reset_confirmed');
  });

  bot.callbackQuery('f0_new_no', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx
      .reply('↩️ Продолжаем текущий онбординг. Вернуться к вопросам — /resume.')
      .catch(() => {});
  });

  // Story 8.4 (W3): /cancel — завершить сессию онбординга с подтверждением.
  bot.command('cancel', async (ctx) => {
    const session = await getOrRestoreF0Session(ctx.chat.id);
    if (session === undefined) {
      await ctx.reply('ℹ️ Нет активного онбординга — отменять нечего.').catch(() => {});
      return;
    }
    if (session.processing) {
      await ctx.reply(F0_BUSY_TEXT).catch(() => {});
      return;
    }
    const company = session.draft?.extraction.company;
    await ctx
      .reply(
        `Завершить онбординг${company !== undefined && company !== null ? ` «${company}»` : ''}? Несохранённый прогресс будет удалён.`,
        {
          reply_markup: new InlineKeyboard()
            .text('🗑 Да, завершить', `f0_cancel_yes:${session.id}`)
            .text('↩️ Нет, продолжить', 'f0_cancel_no'),
        },
      )
      .catch(() => {});
  });

  bot.callbackQuery(/^f0_cancel_yes:(.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    // getOrRestore: id сессии переживает рестарт в персисте — «да» после рестарта работает.
    const session = await getOrRestoreF0Session(chatId);
    if (session === undefined || session.id !== ctx.match[1]!) {
      await ctx.answerCallbackQuery({ text: F0_STALE_BUTTON_TEXT }).catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    f0Sessions.delete(chatId);
    await deleteF0Session(chatId);
    f0Log.info(
      { step: 'f0.session_cancelled', chatId, sessionId: session.id },
      'f0 onboarding cancelled by tracker',
    );
    await ctx.reply('✅ Онбординг отменён. Новый — /newclient или меню /start.').catch(() => {});
  });

  bot.callbackQuery('f0_cancel_no', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx
      .reply('↩️ Онбординг продолжается. Вернуться к вопросам — /resume.')
      .catch(() => {});
  });

  // ───────── Story 8.4: меню и навигация по клиентам (W1, W10) ─────────

  bot.callbackQuery('menu:help', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const firstName = ctx.from?.first_name?.trim() || undefined;
    await ctx.reply(formatWelcomeMessage(firstName)).catch(() => {});
  });

  bot.callbackQuery('menu:new', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await startF0SessionGuarded(ctx, 'menu');
  });

  bot.callbackQuery('menu:clients', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const registry = await loadRegistry();
    const ids = Object.keys(registry);
    const kb = new InlineKeyboard();
    for (const id of ids) {
      // Лимит Telegram: callback_data ≤ 64 байта. Слаги из онбординга капятся (≤32),
      // но реестр могли править руками — одна длинная запись не должна ронять весь список.
      if (Buffer.byteLength(`client_use:${id}`, 'utf8') > 64) {
        log.warn({ step: 'bot.clients_menu.id_too_long', clientId: id }, 'client id skipped in menu');
        continue;
      }
      kb.text(`${registry[id]!.name} (${id})`, `client:${id}`).row();
    }
    // Встроенный пилот доступен из меню наравне с реестром — в т.ч. чтобы вернуть
    // активный выбор на geonline без запоминания «/report <url> geonline».
    if (registry['geonline'] === undefined) {
      kb.text('Geonline (встроенный пилот)', 'client:geonline').row();
    }
    await ctx.reply('👥 Клиенты — выбери:', { reply_markup: kb }).catch(() => {});
  });

  // W10: статус любого клиента из карточки — не только активной сессии.
  bot.callbackQuery(/^client:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const clientId = ctx.match[1]!;
    const card = await loadClientCard(clientId);
    const kb = new InlineKeyboard().text('✅ Работать с этим клиентом', `client_use:${clientId}`);
    if (card === null) {
      const name =
        (await getClientName(clientId)) ?? (clientId === DEFAULT_CLIENT_ID ? 'Geonline' : clientId);
      await ctx
        .reply(`👤 ${name} (${clientId})\nКарточки онбординга нет (клиент заведён до карточек). /report доступен.`, {
          reply_markup: kb,
        })
        .catch(() => {});
      return;
    }
    await ctx.reply(renderClientCardMessage(card), { reply_markup: kb }).catch(() => {});
  });

  bot.callbackQuery(/^client_use:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const clientId = ctx.match[1]!;
    const known = await listClientIds();
    if (!known.includes(clientId)) {
      await ctx.reply(`ℹ️ Клиент «${clientId}» не найден в реестре.`).catch(() => {});
      return;
    }
    await setActiveClient(chatId, clientId);
    const name = (await getClientName(clientId)) ?? clientId;
    f0Log.info({ step: 'bot.active_client_set', chatId, clientId }, 'active client selected');
    await ctx
      .reply(
        `✅ Активный клиент: ${name} (${clientId}).\n` +
          `/report <ссылка> теперь идёт по нему; явный clientId в команде имеет приоритет.`,
      )
      .catch(() => {});
  });

  // Приём файла в пакет: скачать → извлечь текст → аккумулировать. Черновик НЕ собирается здесь.
  // ───────── Story 8.5: приём .xlsx — импорт готовой стратегии ─────────

  /**
   * Один .xlsx → распознавание таблицы стратегии (0 LLM). Успех фиксирует mode=import
   * и кладёт результат в сессию; черновик собирает buildF0Draft (кнопка/‌/draft) —
   * та же точка входа, что у синтеза.
   */
  async function handleF0XlsxDocument(
    ctx: Context,
    session: F0Session,
    doc: { file_name?: string; mime_type?: string; file_size?: number },
  ): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const sourceName = doc.file_name ?? 'strategy.xlsx';

    // Явно выбранный синтез (или уже накопленные документы) — не переключаем молча (W3).
    if (session.mode === 'synthesis') {
      const dropNote =
        session.documents.length > 0
          ? ` Собранный пакет (${session.documents.length} файл(ов)) при переключении будет отброшен.`
          : '';
      await ctx
        .reply(
          `ℹ️ Идёт сборка из документов — Excel в неё не смешивается.${dropNote}\n` +
            'Переключиться на импорт готовой стратегии?',
          {
            reply_markup: new InlineKeyboard().text(
              '📥 Переключиться на импорт',
              `f0_switch_import:${session.id}`,
            ),
          },
        )
        .catch(() => {});
      return;
    }
    if (session.importResult !== undefined) {
      await ctx
        .reply('ℹ️ Excel уже принят — собери черновик (/draft) или начни заново: /newclient.')
        .catch(() => {});
      return;
    }
    if (doc.file_size !== undefined && doc.file_size > F0_MAX_FILE_BYTES) {
      await ctx.reply(F0_TOO_LARGE_TEXT).catch(() => {});
      return;
    }

    session.processing = true;
    try {
      const file = await ctx.getFile();
      if (file.file_path === undefined) {
        throw new Error('telegram getFile returned no file_path');
      }
      const buf = await downloadTelegramFile(file.file_path);
      if (buf.length > F0_MAX_FILE_BYTES) {
        await ctx.reply(F0_TOO_LARGE_TEXT).catch(() => {});
        return;
      }
      const result = importStrategyXlsx(buf, sourceName);
      // Текстификация — для кнопки «🧠 Досинтезировать гипотезы» (LLM по этому же файлу).
      // Бюджет как у пакета документов: больше не влезет и в промпт досинтеза.
      const sourceText = xlsxToText(buf, sourceName);
      session.mode = 'import';
      session.importResult = { ...result, sourceName };
      session.importSourceText = sourceText.length <= F0_MAX_DOC_CHARS ? sourceText : undefined;
      const totalKrs = result.extraction.objectives.reduce((sum, o) => sum + o.krs.length, 0);
      f0Log.info(
        {
          step: 'f0.import_accepted',
          chatId,
          sessionId: session.id,
          sourceName,
          format: result.format,
          sheetName: result.sheetName,
          mappedColumns: result.mappedColumns,
          objectives: result.extraction.objectives.length,
          totalKrs,
          participants: result.extraction.participants.length,
          hypotheses: result.extraction.hypotheses.length,
        },
        'f0 xlsx import accepted',
      );
      await ctx
        .reply(
          `📥 Импорт «${sourceName}»: лист «${result.sheetName}» — ` +
            `целей ${result.extraction.objectives.length}, KR ${totalKrs}, ` +
            `участников ${result.extraction.participants.length}, гипотез ${result.extraction.hypotheses.length}.\n` +
            'Собери черновик — дальше обычный онбординг (проверки, дозаполнение, /confirm).',
          { reply_markup: f0BuildKeyboard },
        )
        .catch(() => {});
    } catch (err) {
      if (err instanceof F0OnboardingError) {
        f0Log.info(
          { step: 'f0.import_rejected', chatId, code: err.code, sourceName },
          'f0 xlsx import rejected',
        );
        // Отказ импорта не запирает путь (ревью MED-1): mode мог быть зафиксирован
        // явной кнопкой ДО файла — сбрасываем, чтобы предложенный синтез-путь работал.
        if (session.importResult === undefined && session.documents.length === 0) {
          session.mode = undefined;
        }
        await ctx.reply(F0_REPLY_BY_CODE[err.code]).catch(() => {});
      } else {
        f0Log.error({ err, step: 'f0.import_failed', chatId, sourceName }, 'f0 xlsx import failed');
        alertOps({
          pipeline: 'F0',
          step: 'f0.import_failed',
          error: err,
          context: { chatId, sourceName, sessionId: session.id },
        });
        await ctx.reply('⚠️ Не удалось принять Excel — техническая ошибка. Попробуй ещё раз.').catch(() => {});
      }
    } finally {
      session.processing = false;
    }
  }

  // Подтверждённое переключение синтез → импорт: пакет отбрасывается, Excel просим заново
  // (файл не хранится — Telegram-документ нельзя перечитать без нового сообщения).
  bot.callbackQuery(/^f0_switch_import:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const session = await getOrRestoreF0Session(chatId);
    if (session === undefined || session.phase !== 'collecting' || session.id !== ctx.match[1]) {
      await ctx.reply('ℹ️ Эта кнопка от прошлой сессии. Актуальное состояние: /status.').catch(() => {});
      return;
    }
    if (session.processing) {
      await ctx.reply(F0_BUSY_TEXT).catch(() => {});
      return;
    }
    session.mode = 'import';
    session.documents = [];
    session.documentsChars = 0;
    f0Log.info(
      { step: 'f0.mode_switched_to_import', chatId, sessionId: session.id },
      'f0 switched to import mode',
    );
    await ctx
      .reply('📥 Переключил на импорт: пакет документов отброшен. Пришли .xlsx ещё раз.')
      .catch(() => {});
  });

  bot.on('message:document', async (ctx) => {
    const chatId = ctx.chat.id;
    const session = await getOrRestoreF0Session(chatId);
    if (session === undefined) {
      await ctx.reply(F0_NO_SESSION_TEXT).catch(() => {});
      return;
    }
    if (session.processing) {
      await ctx.reply(F0_BUSY_TEXT).catch(() => {});
      return;
    }
    // Файлы принимаем только на этапе сбора. После сборки черновика (filling/ready)
    // новый документ не должен затирать черновик и ответы дозаполнения (перезапуск — /newclient).
    if (session.phase !== 'collecting') {
      await ctx
        .reply('ℹ️ Черновик уже собран, идёт дозаполнение. Новый пакет — /newclient; продолжить — /resume.')
        .catch(() => {});
      return;
    }

    const doc = ctx.message.document;
    const sourceName = doc.file_name ?? 'document';

    // Story 8.5: .xlsx — путь импорта готовой стратегии (отдельная ветка, без LLM).
    if (isXlsxDocument(doc.file_name, doc.mime_type)) {
      await handleF0XlsxDocument(ctx, session, doc);
      return;
    }
    // Путь импорта уже зафиксирован — обычные документы в него не смешиваем (записка §2).
    if (session.mode === 'import') {
      await ctx
        .reply(
          'ℹ️ Идёт импорт из Excel — документы в этот путь не добавляются. ' +
            'Пакет документов — начни заново: /newclient → «🧠 Собрать из документов».',
        )
        .catch(() => {});
      return;
    }
    if (!isSupportedF0Document(doc.file_name, doc.mime_type)) {
      f0Log.info(
        { step: 'f0.unsupported_file', chatId, sourceName, mime: doc.mime_type },
        'unsupported onboarding document',
      );
      await ctx.reply(F0_UNSUPPORTED_TEXT).catch(() => {});
      return;
    }
    if (doc.file_size !== undefined && doc.file_size > F0_MAX_FILE_BYTES) {
      await ctx.reply(F0_TOO_LARGE_TEXT).catch(() => {});
      return;
    }
    if (session.documents.length >= F0_MAX_PACKAGE_FILES) {
      await ctx.reply(F0_PACKAGE_FULL_TEXT).catch(() => {});
      return;
    }

    // Держим processing на время скачивания/извлечения: без этого параллельный документ
    // или сборка черновика видят полупустой пакет (файл ещё качается), а /newclient
    // подменяет сессию, теряя in-flight файл. Reset — в finally.
    session.processing = true;
    try {
      const file = await ctx.getFile();
      if (file.file_path === undefined) {
        throw new Error('telegram getFile returned no file_path');
      }
      const buf = await downloadTelegramFile(file.file_path);
      const extracted = await extractTextFromDocument(buf, doc.file_name, doc.mime_type);

      const projectedChars = session.documentsChars + extracted.text.length;
      if (projectedChars > F0_MAX_DOC_CHARS) {
        // Отклоняем раньше, чем пакет вырастет до неизвлекаемого размера, — не тратим
        // ещё файлы и не доводим до отказа на финальной сборке.
        f0Log.info(
          { step: 'f0.package_too_large', chatId, sourceName, projectedChars },
          'f0 package would exceed char budget',
        );
        await ctx.reply(F0_REPLY_BY_CODE.document_too_large).catch(() => {});
        return;
      }

      session.documents.push({ sourceName: extracted.sourceName, text: extracted.text });
      session.documentsChars = projectedChars;
      // Story 8.5: автодетект пути по первому файлу — документ → синтез.
      session.mode ??= 'synthesis';
      f0Log.info(
        {
          step: 'f0.document_accepted',
          chatId,
          sessionId: session.id,
          sourceName,
          kind: extracted.kind,
          packageSize: session.documents.length,
          packageChars: session.documentsChars,
        },
        'f0 document accepted into package',
      );
      await ctx
        .reply(
          `📎 Принят: ${sourceName} (в пакете: ${session.documents.length}). ` +
            'Пришли ещё или собери черновик.',
          { reply_markup: f0BuildKeyboard },
        )
        .catch(() => {});
    } catch (err) {
      if (err instanceof F0OnboardingError) {
        f0Log.info(
          { step: 'f0.document_rejected', chatId, code: err.code, sourceName },
          'f0 document rejected',
        );
        await ctx.reply(`${F0_REPLY_BY_CODE[err.code]}\nПакет цел — пришли другой файл.`).catch(() => {});
      } else {
        f0Log.error({ err, step: 'f0.document_failed', chatId, sourceName }, 'f0 document failed');
        alertOps({
          pipeline: 'F0',
          step: 'f0.document_failed',
          error: err,
          context: { chatId, sourceName, sessionId: session.id },
        });
        await ctx.reply('⚠️ Не удалось принять файл — техническая ошибка. Попробуй ещё раз.').catch(() => {});
      }
    } finally {
      session.processing = false;
    }
  });

  // Story 8.3 (W2): честная оценка времени сборки — зависит от размера пакета
  // (реально до ~10 мин на большой пакет при таймауте 12 мин; см. F0_FULL_TIMEOUT_MS).
  function f0DraftProgressText(files: number, chars: number, elapsedMs?: number): string {
    const kChars = Math.max(1, Math.round(chars / 1000));
    const estimate =
      chars > 60_000
        ? 'большой пакет — обычно 5–12 минут'
        : chars > 20_000
          ? 'обычно 2–5 минут'
          : 'обычно 1–2 минуты';
    const head = `🧠 Собираю черновик из пакета (файлов: ${files}, ~${kChars} тыс. знаков) — ${estimate}.`;
    if (elapsedMs === undefined) return head;
    const min = Math.floor(elapsedMs / 60_000);
    const sec = Math.round((elapsedMs % 60_000) / 1000);
    return `${head}\n⏳ Прошло ${min} мин ${sec} с — работаю (потолок 12 минут).`;
  }

  /** Редактирование plain-text сообщения (F0-тексты без parse_mode). */
  async function editPlainMessage(chatId: number, messageId: number, text: string): Promise<boolean> {
    try {
      await bot.api.editMessageText(chatId, messageId, text);
      return true;
    } catch (err) {
      if (err instanceof GrammyError && err.description?.includes('message is not modified')) {
        return true;
      }
      log.warn({ err, chatId, messageId }, 'f0.progress.edit_failed');
      return false;
    }
  }

  /**
   * Общий хвост сборки черновика (синтез и импорт, Story 8.5): персист, саммари,
   * переход в filling, первый вопрос дозаполнения. sendFirst доставляет первую часть
   * саммари (LLM-путь редактирует своё progress-сообщение, импорт шлёт новое).
   */
  async function deliverF0Draft(opts: {
    ctx: Context;
    chatId: number;
    session: F0Session;
    result: F0FullDraftResult;
    sourceNames: string[];
    sendFirst: (text: string) => Promise<boolean>;
  }): Promise<void> {
    const { ctx, chatId, session, result, sourceNames, sendFirst } = opts;

    // Сессию могли отменить (/cancel) или заменить (сброс) за время долгой сборки —
    // тогда результат не сохраняем, иначе отменённая сессия воскресла бы через persist.
    if (f0Sessions.get(chatId) !== session) {
      f0Log.info(
        { step: 'f0.draft_discarded', chatId, sessionId: session.id },
        'f0 draft discarded — session cancelled/replaced during build',
      );
      await sendFirst('ℹ️ Онбординг был отменён во время сборки — черновик не сохранён. Новый: /newclient.');
      return;
    }

    const draftId = randomUUID().slice(0, 8);
    await persistF0FullDraft({ draftId, chatId, sourceNames, createdAt: now().toISOString(), result });

    // Story 8.3 (W4): компактное саммари вместо полной простыни — полные таблицы
    // появятся в Google Sheets после /confirm (ссылку пришлёт createSheetForSession).
    const message = renderF0DraftSummaryMessage({
      extraction: result.extraction,
      krIssues: result.krIssues,
      hypothesisIssues: result.hypothesisIssues,
      sourceName: sourceNames.join(', '),
      draftId,
    });
    const parts = splitForTelegram(message, TELEGRAM_SAFE_MARGIN, '🆕 Черновик онбординга (продолжение)');
    let sentAll = await sendFirst(parts[0]!);
    for (const part of parts.slice(1)) {
      try {
        await ctx.reply(part);
      } catch (sendErr) {
        sentAll = false;
        log.error({ err: sendErr, chatId, draftId }, 'f0.draft.send_failed');
      }
    }
    if (!sentAll) {
      // Часть сообщений не ушла — черновик показан фрагментарно; не выдаём за успех.
      await ctx
        .reply('⚠️ Черновик доставлен не полностью (сбой Telegram). Собери снова: /draft.')
        .catch(() => {});
    }
    // Пакет использован — очищаем, чтобы новые файлы не липли к отработанному черновику.
    session.documents = [];
    session.documentsChars = 0;
    session.importResult = undefined; // Story 8.5: xlsx отработан
    // Story 7.3: переходим в диалог дозаполнения по пробелам черновика.
    session.phase = 'filling';
    session.draft = { draftId, sourceNames, extraction: result.extraction };
    session.gaps = computeF0Gaps(result.extraction);
    session.gapIndex = 0;
    session.schedule = null;
    session.retryGapIndex = undefined; // W6: новая очередь — старое ожидание повтора не властно
    await saveF0Session(chatId, session);
    f0Log.info(
      {
        step: 'f0.draft_sent',
        chatId,
        sessionId: session.id,
        draftId,
        mode: session.mode,
        files: sourceNames.length,
        delivered: sentAll,
        blockingKrs: result.krIssues.length,
        hypothesesWithoutMetric: result.hypothesisIssues.length,
        totalKrs: result.totalKrs,
        gaps: session.gaps.length,
      },
      'f0 draft delivered',
    );
    // Story 1.9 fix: успешная сборка F0-черновика — канонический успех пайплайна,
    // сбрасывает down-watchdog (иначе ложный «Pipeline down», т.к. считался лишь F1).
    if (sentAll) {
      recordOpsEvent('info', {
        pipeline: 'F0',
        step: 'f0.draft_delivered',
        status: 'ok',
        context: { chatId, sessionId: session.id, draftId, files: sourceNames.length },
      });
    }
    // Story 8.5 (ответ Тимура на в.4 записки): импорт без гипотез — предлагаем досинтез
    // LLM-ом из этого же файла; новые вопросы встанут в конец диалога.
    if (
      session.mode === 'import' &&
      result.extraction.hypotheses.length === 0 &&
      session.importSourceText !== undefined
    ) {
      await ctx
        .reply(
          '🧪 Гипотез в файле не нашёл. Могу синтезировать их из этого же Excel (ИИ, обычно 1–2 минуты) — вопросы по ним добавятся в конец диалога.',
          { reply_markup: new InlineKeyboard().text('🧠 Досинтезировать гипотезы', 'f0_synth_hypo') },
        )
        .catch(() => {});
    }
    await askNextF0Gap(ctx, session);
  }

  // Story 8.5: сборка черновика из принятого xlsx — extraction уже распознан при приёме,
  // LLM и progress-тикер не нужны (импорт мгновенный).
  async function buildF0DraftFromImport(ctx: Context, chatId: number, session: F0Session): Promise<void> {
    const imported = session.importResult;
    if (imported === undefined) return;
    session.processing = true;
    try {
      const extraction = imported.extraction;
      const result: F0FullDraftResult = {
        extraction,
        krIssues: markBlockingKrIssues(extraction),
        hypothesisIssues: markHypothesesWithoutMetric(extraction),
        totalKrs: extraction.objectives.reduce((sum, o) => sum + o.krs.length, 0),
        usage: { input_tokens: 0, output_tokens: 0 }, // импорт без LLM
      };
      await deliverF0Draft({
        ctx,
        chatId,
        session,
        result,
        sourceNames: [imported.sourceName],
        sendFirst: async (text) => {
          try {
            await ctx.reply(text);
            return true;
          } catch (err) {
            log.error({ err, chatId }, 'f0.import_draft.send_failed');
            return false;
          }
        },
      });
    } finally {
      session.processing = false;
    }
  }

  // Сборка черновика из пакета: конкатенация файлов → полное извлечение (OKR + гипотезы + участники).
  async function buildF0Draft(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const session = f0Sessions.get(chatId);
    if (session === undefined) {
      await ctx.reply(F0_NO_SESSION_TEXT).catch(() => {});
      return;
    }
    if (session.processing) {
      await ctx.reply(F0_BUSY_TEXT).catch(() => {});
      return;
    }
    // Story 8.5: путь импорта — черновик из принятого xlsx, без LLM.
    if (session.mode === 'import') {
      if (session.importResult === undefined) {
        await ctx.reply('ℹ️ Excel ещё не принят — пришли .xlsx-файл готовой стратегии.').catch(() => {});
        return;
      }
      await buildF0DraftFromImport(ctx, chatId, session);
      return;
    }
    if (session.documents.length === 0) {
      await ctx.reply(F0_NO_DOCS_TEXT).catch(() => {});
      return;
    }

    session.processing = true;
    const sourceNames = session.documents.map((d) => d.sourceName);
    const packageChars = session.documentsChars;
    // Разделяем файлы явными маркерами — модель понимает границы документов пакета.
    const documentText = session.documents
      .map((d) => `===== Файл: ${d.sourceName} =====\n\n${d.text}`)
      .join('\n\n');

    // Story 8.3 (W2): progress-сообщение живёт до результата — обновляется тикером и в конце
    // редактируется в итог/ошибку, а не удаляется молча («бот завис» → повторный /newclient).
    let progressMessageId: number | undefined;
    try {
      const progress = await ctx.reply(f0DraftProgressText(sourceNames.length, packageChars));
      progressMessageId = progress.message_id;
    } catch { /* прогресс не критичен */ }

    const startedAt = Date.now();
    // finished выставляется ДО финального edit: иначе тик (или его in-flight edit),
    // сработавший между итогом и clearInterval в finally, затёр бы доставленное саммари
    // обратно на «Собираю черновик…» — невосстановимо, пакет уже очищен.
    let finished = false;
    const progressTimer = setInterval(() => {
      if (finished || progressMessageId === undefined) return;
      void editPlainMessage(
        chatId,
        progressMessageId,
        f0DraftProgressText(sourceNames.length, packageChars, Date.now() - startedAt),
      );
    }, 45_000);
    progressTimer.unref?.();

    // Итог/ошибка: сначала пробуем отредактировать progress-сообщение, иначе шлём новое.
    const finishProgress = async (text: string): Promise<boolean> => {
      finished = true;
      clearInterval(progressTimer);
      if (progressMessageId !== undefined && (await editPlainMessage(chatId, progressMessageId, text))) {
        return true;
      }
      try {
        await ctx.reply(text);
        return true;
      } catch (err) {
        log.error({ err, chatId }, 'f0.draft.finish_send_failed');
        return false;
      }
    };

    try {
      const result = await runF0FullDraftFn({
        documentText,
        sourceName: sourceNames.join(', '),
      });

      // Общий хвост (персист, саммари, filling) вынесен в deliverF0Draft — Story 8.5
      // использует его и для импорта. finished/clearInterval гасит sendFirst-обёртка.
      await deliverF0Draft({ ctx, chatId, session, result, sourceNames, sendFirst: finishProgress });
    } catch (err) {
      if (err instanceof F0OnboardingError) {
        f0Log.info(
          { step: 'f0.draft_rejected', chatId, code: err.code, files: sourceNames.length },
          'f0 draft rejected',
        );
        await finishProgress(
          `${F0_REPLY_BY_CODE[err.code]}\nПакет цел — поправь файлы и собери снова: /draft.`,
        );
      } else {
        // Не-F0 ошибка (напр. обрезка JSON по лимиту токенов, сбой Claude) — подсказываем
        // действие: пакет большой → убрать файлы. Пакет сохраняем для повторной попытки.
        f0Log.error({ err, step: 'f0.draft_failed', chatId }, 'f0 draft failed');
        alertOps({
          pipeline: 'F0',
          step: 'f0.draft_failed',
          error: err,
          context: { chatId, sessionId: session.id, files: sourceNames.length },
        });
        await finishProgress(
          '⚠️ Не удалось собрать черновик. Если файлов много — убери лишние и собери снова: /draft.',
        );
      }
    } finally {
      clearInterval(progressTimer);
      session.processing = false;
    }
  }

  bot.command('draft', async (ctx) => {
    await buildF0Draft(ctx);
  });

  bot.callbackQuery('f0_build', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await buildF0Draft(ctx);
  });

  // Story 8.5 (ответ Тимура на в.4 записки): досинтез гипотез LLM-ом из того же xlsx.
  // Единственный LLM-вызов импорт-пути, и только по явной кнопке. Новые вопросы
  // (метрики гипотез) встают в конец очереди — текущий прогресс диалога не трогаем.
  bot.callbackQuery('f0_synth_hypo', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const session = await getOrRestoreF0Session(chatId);
    if (session === undefined || session.phase !== 'filling' || session.draft === undefined) {
      await ctx.reply('ℹ️ Эта кнопка от прошлого онбординга. Актуальное состояние: /status.').catch(() => {});
      return;
    }
    if (session.processing) {
      await ctx.reply(F0_BUSY_TEXT).catch(() => {});
      return;
    }
    if (session.draft.extraction.hypotheses.length > 0) {
      await ctx.reply('ℹ️ Гипотезы уже есть в черновике — повторный досинтез не нужен.').catch(() => {});
      return;
    }
    const sourceText = session.importSourceText;
    if (sourceText === undefined) {
      await ctx
        .reply('ℹ️ Текст Excel не сохранился — добавь гипотезы в лист таблицы после /confirm.')
        .catch(() => {});
      return;
    }

    session.processing = true;
    try {
      await ctx.reply('🧠 Синтезирую гипотезы из Excel — обычно 1–2 минуты…').catch(() => {});
      const result = await runF0FullDraftFn({
        documentText: sourceText,
        sourceName: session.draft.sourceNames.join(', '),
      });
      // Сессию могли отменить/заменить за время LLM-вызова — результат не примешиваем.
      if (f0Sessions.get(chatId) !== session || session.draft === undefined) {
        f0Log.info(
          { step: 'f0.synth_hypo_discarded', chatId, sessionId: session.id },
          'f0 hypothesis synthesis discarded — session replaced',
        );
        return;
      }
      // Прошли через LLM → требуют подтверждения трекером (⚠️), как synthesized в синтезе.
      const hypotheses = result.extraction.hypotheses.map((h) => ({ ...h, synthesized: true }));
      if (hypotheses.length === 0) {
        await ctx
          .reply('🧪 Гипотез из файла извлечь не удалось — добавь их в лист таблицы после /confirm.')
          .catch(() => {});
        return;
      }
      session.draft.extraction.hypotheses = hypotheses;
      const oldGapCount = session.gaps.length;
      const dialogWasDone = session.gapIndex >= oldGapCount;
      const newGaps = computeHypoMetricGaps(session.draft.extraction);
      session.gaps.push(...newGaps);
      await saveF0Session(chatId, session);
      f0Log.info(
        {
          step: 'f0.synth_hypo_done',
          chatId,
          sessionId: session.id,
          hypotheses: hypotheses.length,
          withoutMetric: newGaps.length,
        },
        'f0 hypotheses synthesized after import',
      );
      const metricNote =
        newGaps.length > 0 ? `, без метрики — ${newGaps.length} (спрошу в диалоге)` : '';
      await ctx
        .reply(
          `🧪 Синтезировано гипотез: ${hypotheses.length}${metricNote}. ` +
            'Они помечены ⚠️ — подтверди формулировки с клиентом.',
        )
        .catch(() => {});
      // Диалог уже дошёл до конца — задаём первый из добавленных вопросов сразу.
      if (dialogWasDone && newGaps.length > 0) {
        await askNextF0Gap(ctx, session);
      }
    } catch (err) {
      if (err instanceof F0OnboardingError) {
        f0Log.info(
          { step: 'f0.synth_hypo_rejected', chatId, code: err.code },
          'f0 hypothesis synthesis rejected',
        );
      } else {
        f0Log.error({ err, step: 'f0.synth_hypo_failed', chatId }, 'f0 hypothesis synthesis failed');
        alertOps({
          pipeline: 'F0',
          step: 'f0.synth_hypo_failed',
          error: err,
          context: { chatId, sessionId: session.id },
        });
      }
      await ctx
        .reply(
          '⚠️ Не удалось синтезировать гипотезы из этого файла. Онбординг не пострадал — ' +
            'гипотезы можно добавить в лист таблицы после /confirm.',
        )
        .catch(() => {});
    } finally {
      session.processing = false;
    }
  });

  // ───────── Story 7.3: диалог дозаполнения ─────────

  const F0_FILL_HINT = 'Ответь текстом · /skip — пропустить · /confirm — завершить онбординг.';

  /** Задать следующий вопрос из очереди пробелов, либо предложить /confirm. */
  async function askNextF0Gap(ctx: Context, session: F0Session): Promise<void> {
    if (session.gapIndex < session.gaps.length) {
      const gap = session.gaps[session.gapIndex]!;
      const pos = `(${session.gapIndex + 1}/${session.gaps.length})`;
      // Story 8.6 (W5): заголовок сущности перед первым вопросом группы (KR целиком).
      const header = gap.header !== undefined ? `${gap.header}\n` : '';
      await ctx.reply(`${header}❓ ${pos} ${gap.question}\n${F0_FILL_HINT}`).catch(() => {});
    } else {
      await ctx
        .reply('Все вопросы пройдены. Проверь черновик и заверши онбординг: /confirm.')
        .catch(() => {});
    }
  }

  /** Применить ответ трекера к текущему пробелу и перейти к следующему. */
  async function handleF0FillAnswer(ctx: Context, session: F0Session, text: string): Promise<void> {
    const chatId = ctx.chat!.id;
    if (session.gapIndex >= session.gaps.length) {
      await ctx.reply('Вопросы закончились — заверши онбординг: /confirm.').catch(() => {});
      return;
    }
    const gap = session.gaps[session.gapIndex]!;
    // Story 8.6 (W6): мягкая валидация числовых полей (база/цель KR) — один переспрос
    // с подсказкой формата; повторный ответ принимается как есть (данные бывают «нет данных»).
    if (
      needsNumericAnswer(gap) &&
      text.trim().length > 0 &&
      !looksNumericAnswer(text) &&
      session.retryGapIndex !== session.gapIndex
    ) {
      session.retryGapIndex = session.gapIndex;
      await saveF0Session(chatId, session);
      f0Log.info(
        { step: 'f0.gap_retry', chatId, sessionId: session.id, kind: gap.kind, ref: gap.ref },
        'f0 gap numeric retry',
      );
      await ctx
        .reply(
          '🔁 Не вижу числа в ответе, а тут нужно значение метрики (например «15 000» или «9%»).\n' +
            'Если так и надо (например «нет данных») — отправь ответ ещё раз, приму как есть. Или пропусти: /skip.',
        )
        .catch(() => {});
      return; // очередь не продвигаем — ждём повтор или новый ответ
    }
    if (gap.kind === 'schedule') {
      const value = text.trim();
      if (value.length === 0) {
        await ctx.reply('Пустой ответ. Впиши расписание или пропусти: /skip.').catch(() => {});
        return; // не продвигаем очередь — вопрос остаётся
      }
      session.schedule = value;
    } else {
      // applyF0Answer возвращает false на пустой ответ — тогда НЕ продвигаем очередь,
      // иначе пробел молча «съедается» и всплывёт только блоком на /confirm.
      const written = session.draft !== undefined && applyF0Answer(session.draft.extraction, gap, text);
      if (!written) {
        await ctx.reply('Пустой ответ. Впиши значение или пропусти: /skip.').catch(() => {});
        return;
      }
    }
    session.retryGapIndex = undefined;
    session.gapIndex += 1;
    await saveF0Session(chatId, session);
    f0Log.info(
      { step: 'f0.gap_answered', chatId, sessionId: session.id, kind: gap.kind, ref: gap.ref },
      'f0 gap answered',
    );
    await askNextF0Gap(ctx, session);
  }

  bot.command('skip', async (ctx) => {
    const session = await getOrRestoreF0Session(ctx.chat.id);
    if (session === undefined || session.phase !== 'filling') {
      await ctx.reply('ℹ️ Сейчас нечего пропускать — активного диалога онбординга нет.').catch(() => {});
      return;
    }
    if (session.gapIndex < session.gaps.length) {
      const gap = session.gaps[session.gapIndex]!;
      session.retryGapIndex = undefined; // W6: пропуск снимает ожидание повтора
      session.gapIndex += 1;
      await saveF0Session(ctx.chat.id, session);
      f0Log.info(
        { step: 'f0.gap_skipped', chatId: ctx.chat.id, kind: gap.kind, ref: gap.ref },
        'f0 gap skipped',
      );
    }
    await askNextF0Gap(ctx, session);
  });

  bot.command('resume', async (ctx) => {
    const session = await getOrRestoreF0Session(ctx.chat.id);
    if (session === undefined) {
      await ctx.reply('ℹ️ Нет активного онбординга. Начни новый: /newclient.').catch(() => {});
      return;
    }
    if (session.phase === 'filling') {
      await ctx.reply('↩️ Продолжаем онбординг с места остановки.').catch(() => {});
      await askNextF0Gap(ctx, session);
    } else if (session.phase === 'ready') {
      await ctx.reply('✅ Онбординг этого клиента уже завершён.').catch(() => {});
    } else {
      await ctx.reply('Онбординг на этапе сбора файлов — пришли документы или собери черновик: /draft.').catch(() => {});
    }
  });

  // Story 7.4: понятные сообщения по кодам сбоя создания таблицы.
  function f0SheetsErrorText(err: F0SheetsError): string {
    switch (err.code) {
      case 'template_not_configured':
        return 'ℹ️ Автосоздание Google Sheets ещё не настроено (нет шаблона). Данные онбординга сохранены — таблицу можно создать позже.';
      case 'auth':
        return '🔴 Нет доступа к Google (проверь права сервис-аккаунта к шаблону и папке). Данные сохранены — повтори позже: /confirm.';
      case 'sheet_missing':
      case 'header_missing':
        return '🔴 Шаблон не соответствует структуре v2.0 (не найден лист/колонка). Данные сохранены — проверь шаблон и повтори: /confirm.';
      case 'rate_limited':
      case 'network':
        return '⚠️ Google временно недоступен. Данные сохранены — повтори через минуту: /confirm (без дублей таблиц).';
      default:
        return `⚠️ Не удалось создать таблицу (${err.code}). Данные сохранены — повтори: /confirm (без дублей таблиц).`;
    }
  }

  /**
   * Story 7.5/7.6: собрать карточку клиента, зарегистрировать в реестре мультиклиентности,
   * показать чеклист готовности. Вызывается после успешного создания таблицы.
   */
  async function finalizeClientCard(
    ctx: { reply: (t: string) => Promise<unknown> },
    chatId: number,
    session: F0Session,
    spreadsheetId: string,
    spreadsheetUrl: string,
  ): Promise<void> {
    if (session.draft === undefined) return;
    const extraction = session.draft.extraction;
    const company = extraction.company ?? 'Клиент';
    const clientId = clientIdFromCompany(company);
    const card = buildClientCard({
      extraction,
      schedule: session.schedule,
      trackerChatId: chatId,
      spreadsheetId,
      spreadsheetUrl,
      startDate: now().toISOString(),
      clientId,
      now,
    });
    await persistClientCard(card);
    await upsertClient(clientId, {
      sheetId: spreadsheetId,
      name: company,
      ...(card.ceo ? { topName: card.ceo } : {}),
    });
    f0Log.info(
      { step: 'f0.client_registered', chatId, clientId, spreadsheetId },
      'client card persisted + registered in client registry',
    );
    const items = computeReadinessChecklist(card, extraction);
    await ctx.reply(renderReadinessMessage(card, items)).catch(() => {});
  }

  /**
   * Story 7.4: создать/дозаполнить Google Sheets клиента для готовой сессии.
   * Идемпотентно: id созданной таблицы хранится на сессии, поэтому повторный вызов
   * (/confirm после сбоя) не создаёт дубль, а перезаписывает данные и доступ.
   */
  async function createSheetForSession(
    ctx: { reply: (t: string) => Promise<unknown> },
    chatId: number,
    session: F0Session,
  ): Promise<void> {
    if (session.draft === undefined) return;
    const company = session.draft.extraction.company ?? 'Клиент';
    const clientId = clientIdFromCompany(company);

    // Story 7.6 (fix): переиспользуем таблицу уже зарегистрированного клиента, чтобы
    // повторный онбординг той же компании не плодил дубли в Drive. Сессия важнее реестра
    // (её id — от незавершённого retry). 'geonline' не трогаем — его fallback ведёт на
    // боевую config-таблицу, перезаписывать её онбордингом нельзя.
    let existingSpreadsheetId = session.spreadsheetId;
    if (existingSpreadsheetId === undefined && clientId !== 'geonline') {
      const registered = await getClientSheetId(clientId);
      if (registered !== undefined) {
        existingSpreadsheetId = registered;
        f0Log.info(
          { step: 'f0.sheet_reuse', chatId, clientId, spreadsheetId: registered },
          'reusing registered client spreadsheet (avoid duplicate table)',
        );
      }
    }

    if (config.F0_SHEETS_TEMPLATE_ID.trim() === '' && existingSpreadsheetId === undefined) {
      await ctx
        .reply('ℹ️ Данные готовы. Автосоздание Google Sheets не настроено — таблицу можно создать позже.')
        .catch(() => {});
      return;
    }
    const dateStr = now().toISOString().slice(0, 10);
    const spreadsheetName = `Стратегический трекинг v2.0 — ${company} (${dateStr})`;
    // Известное ограничение MVP (story 8.1, design §6): повторная запись в существующую
    // таблицу затирает ручные правки трекера в машинных листах — предупреждаем явно.
    if (existingSpreadsheetId !== undefined) {
      await ctx
        .reply(
          '♻️ Использую существующую таблицу клиента: данные ⚙️-листов (_okr, _stakeholder_map, _hypotheses) будут перезаписаны данными онбординга — ручные правки в них не сохранятся.',
        )
        .catch(() => {});
    }
    await ctx.reply('📊 Создаю Google Sheets по шаблону v2.0…').catch(() => {});
    try {
      const result = await createClientSpreadsheetFn({
        extraction: session.draft.extraction,
        spreadsheetName,
        existingSpreadsheetId,
        meta: { onboardingDate: dateStr },
        logger: f0Log,
      });
      session.spreadsheetId = result.spreadsheetId;
      await saveF0Session(chatId, session);
      f0Log.info(
        { step: 'f0.sheet_created', chatId, spreadsheetId: result.spreadsheetId, counts: result.counts },
        'f0 client spreadsheet created',
      );
      const lines = [
        '✅ Таблица клиента создана:',
        result.spreadsheetUrl,
        `Панель OKR: ${result.counts.okr} · гипотезы: ${result.counts.hypotheses} · участники: ${result.counts.stakeholders}` +
          (result.counts.personalSheets > 0 ? ` · личные листы топов: ${result.counts.personalSheets}` : ''),
        // Story 7.6: слаг клиента нужен для /report <url> <clientId> — показываем явно.
        `ID клиента: ${clientId}  (для /report <ссылка> ${clientId})`,
      ];
      if (result.shared.length > 0) {
        lines.push(`Доступ выдан: ${result.shared.join(', ')}`);
      }
      await ctx.reply(lines.join('\n')).catch(() => {});

      // Story 7.5/7.6: карточка клиента + регистрация в реестре мультиклиентности.
      await finalizeClientCard(ctx, chatId, session, result.spreadsheetId, result.spreadsheetUrl);
    } catch (err) {
      if (err instanceof F0SheetsError) {
        // Таблица уже создана — сохраняем id, чтобы повтор не создал дубль.
        if (err.spreadsheetId !== undefined && session.spreadsheetId === undefined) {
          session.spreadsheetId = err.spreadsheetId;
          await saveF0Session(chatId, session);
        }
        f0Log.warn(
          { step: 'f0.sheet_create_failed', chatId, code: err.code, spreadsheetId: err.spreadsheetId },
          'f0 client spreadsheet creation failed',
        );
        await ctx.reply(f0SheetsErrorText(err)).catch(() => {});
        return;
      }
      f0Log.error({ step: 'f0.sheet_create_failed', chatId, err }, 'f0 sheet creation unexpected error');
      await ctx
        .reply('⚠️ Непредвиденная ошибка при создании таблицы. Данные сохранены — повтори: /confirm.')
        .catch(() => {});
    }
  }

  bot.command('confirm', async (ctx) => {
    const chatId = ctx.chat.id;
    const session = await getOrRestoreF0Session(chatId);
    if (session === undefined || session.draft === undefined) {
      await ctx.reply('ℹ️ Нет черновика для подтверждения. Начни онбординг: /newclient.').catch(() => {});
      return;
    }
    // Инвариант 1 (ослаблен, WP-39.x): неполные KR больше НЕ блокируют завершение —
    // показываем ⚠️ предупреждение и продолжаем; трекер дозаполнит базу/цель/овнера прямо
    // в таблице (или /resume). milestone-KR base/target не требуют (см. markBlockingKrIssues).
    const warnings = markBlockingKrIssues(session.draft.extraction);
    session.phase = 'ready';
    await saveF0Session(chatId, session);
    f0Log.info(
      {
        step: 'f0.confirmed',
        chatId,
        sessionId: session.id,
        draftId: session.draft.draftId,
        krWarnings: warnings.length,
      },
      'f0 onboarding confirmed ready',
    );
    const readyLines = ['✅ Онбординг подтверждён — данные готовы.'];
    if (warnings.length > 0) {
      readyLines.push(
        `⚠️ ${warnings.length} KR стоит дозаполнить (база/цель/ответственный) — можно позже в таблице или через /resume:`,
      );
      for (const issue of warnings.slice(0, 10)) {
        readyLines.push(`  – ${issue.ref} «${issue.formulation.slice(0, 50)}»: ${issue.reasons.join(', ')}`);
      }
      if (warnings.length > 10) readyLines.push(`  … и ещё ${warnings.length - 10}`);
    }
    if (session.schedule !== null && session.schedule.length > 0) {
      readyLines.push(`🗓 Расписание встреч: ${session.schedule}`);
    }
    await ctx.reply(readyLines.join('\n')).catch(() => {});

    // Story 7.4: создаём Google Sheets клиента по шаблону v2.0.
    await createSheetForSession(ctx, chatId, session);
  });

  // ───────── /status — чеклист готовности клиента к неделе 1 (Story 7.5) ─────────
  bot.command('status', async (ctx) => {
    const chatId = ctx.chat.id;
    const session = await getOrRestoreF0Session(chatId);
    if (session === undefined || session.draft === undefined) {
      // Story 8.4 (W10): онбординга нет, но клиент выбран в меню → статус из карточки.
      const active = await getActiveClient(chatId);
      if (active !== undefined) {
        const card = await loadClientCard(active);
        if (card !== null) {
          await ctx.reply(renderClientCardMessage(card)).catch(() => {});
          return;
        }
      }
      await ctx
        .reply('ℹ️ Нет активного онбординга. Начни: /newclient — или выбери клиента: /start → «Клиенты».')
        .catch(() => {});
      return;
    }
    const extraction = session.draft.extraction;
    const company = extraction.company ?? 'Клиент';
    const clientId = clientIdFromCompany(company);
    // Карточка с диска (если создана), иначе — снимок из текущей сессии.
    const card =
      (await loadClientCard(clientId)) ??
      buildClientCard({
        extraction,
        schedule: session.schedule,
        trackerChatId: chatId,
        spreadsheetId: session.spreadsheetId ?? null,
        spreadsheetUrl: session.spreadsheetId
          ? `https://docs.google.com/spreadsheets/d/${session.spreadsheetId}/edit`
          : null,
        startDate: now().toISOString(),
        clientId,
        now,
      });
    const items = computeReadinessChecklist(card, extraction);
    await ctx.reply(renderReadinessMessage(card, items)).catch(() => {});
  });

  // ───────── /report command ─────────
  bot.command('report', async (ctx) => {
    const arg = ctx.match ?? '';
    // Story 7.6: /report <url> [clientId] — второй токен выбирает клиента (URL без пробелов).
    const tokens = arg.trim().split(/\s+/).filter((t) => t.length > 0);
    const urlArg = tokens[0] ?? '';
    const clientIdArg = tokens[1];
    const parsed = parseReportUrl(urlArg);
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

    // Story 7.6: резолв клиента из аргумента; Story 8.4 (W10): иначе — активный клиент
    // чата из меню «Клиенты»; и только потом DEFAULT_CLIENT_ID (обратная совместимость).
    let clientId = DEFAULT_CLIENT_ID;
    if (clientIdArg !== undefined) {
      const known = await listClientIds();
      if (!known.includes(clientIdArg)) {
        await ctx
          .reply(`ℹ️ Неизвестный клиент «${clientIdArg}». Известные: ${known.join(', ')}.`)
          .catch(() => {});
        return;
      }
      clientId = clientIdArg;
    } else {
      const active = await getActiveClient(ctx.chat.id);
      if (active !== undefined) {
        const known = await listClientIds();
        if (known.includes(active)) {
          clientId = active;
        } else {
          log.warn(
            { step: 'bot.report.active_client_stale', chatId: ctx.chat.id, active },
            'active client no longer in registry — falling back to default',
          );
        }
      }
    }
    const topName =
      (await getClientTopName(clientId)) ??
      (clientId === DEFAULT_CLIENT_ID
        ? GEONLINE_DEFAULT_TOP_NAME
        : (await getClientName(clientId)) ?? 'Клиент');

    try {
      assertClientId(clientId);
    } catch (err) {
      log.error(
        { err, step: 'bot.report.invalid_client_id', clientId },
        'invalid clientId — refusing to enqueue',
      );
      alertOps({
        pipeline: 'F1',
        step: 'bot.report.invalid_client_id',
        error: err,
        context: { clientId },
      });
      await ctx
        .reply(formatErrorMessage('pipeline_failed'))
        .catch(() => {});
      return;
    }

    const job: ReportJob = {
      id: randomUUID().slice(0, 8),
      chatId: ctx.chat.id,
      url: parsed.url,
      clientId,
      topName,
      meetingDate: now().toISOString(),
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
    // Story 1.10: disk-level idempotency guard for restart-replay scenarios.
    // In-memory approvalStatus catches ~99% of double-tap cases; the disk read is
    // the safety net when completedJobs is reseeded by a fresh process after restart.
    let alreadyApprovedOnDisk = false;
    try {
      alreadyApprovedOnDisk = await isAlreadyApproved(job.clientId, job.id);
    } catch (err) {
      log.warn(
        { err, jobId, step: 'bot.approve.idempotency_check_failed' },
        'idempotency read failed, proceeding',
      );
    }
    if (alreadyApprovedOnDisk) {
      await ctx.answerCallbackQuery({ text: 'ℹ️ Уже отправлено.' });
      log.info(
        { jobId, step: 'bot.approve.disk_idempotency_hit' },
        'approve replayed after restart',
      );
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
      // Story 1.8 fix: while a note is pending, non-reply text is silently
      // ignored (parallel to pendingEdits non-reply semantics). AC#4 fires the
      // fallback hint only when BOTH pending* are absent.
      return;
    }

    // Story 7.1: текстовый триггер онбординга «новый клиент». Не срабатывает во время
    // активного диалога дозаполнения — иначе ответ, дословно равный «новый клиент»,
    // случайно сбросил бы сессию. Явный перезапуск во время filling — команда /newclient.
    const f0InMemory = f0Sessions.get(chatId);
    if (f0InMemory?.phase !== 'filling' && /^новый клиент$/iu.test(ctx.message.text.trim())) {
      // Story 8.4 (W3): guarded — пакет collecting с файлами тоже не сбрасываем молча.
      await startF0SessionGuarded(ctx, 'text');
      return;
    }

    const pending = pendingEdits.get(chatId);
    if (pending === undefined) {
      // Story 7.3: диалог дозаполнения. Проверяем ПОСЛЕ pendingEdits, чтобы F1-правка
      // (reply на инструкцию) не перехватывалась онбордингом. Восстанавливаем сессию
      // с диска, если её нет в памяти после рестарта (AC3).
      const f0 = f0InMemory ?? (await getOrRestoreF0Session(chatId));
      if (f0?.phase === 'filling') {
        if (f0InMemory === undefined) {
          await ctx.reply('↩️ Восстановил онбординг после перерыва.').catch(() => {});
        }
        await handleF0FillAnswer(ctx, f0, ctx.message.text);
        return;
      }
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
    if (_schedulerHandle !== null) {
      _schedulerHandle.stop();
      _schedulerHandle = null;
    }
    if (_watchdogHandle !== null) {
      _watchdogHandle.stop();
      _watchdogHandle = null;
    }
    // Story 1.9: clear module-level ops setters so subsequent bot lifecycles start clean.
    setOpsTelegramSender(null);
    setOpsSheetsWriter(null);
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
      // Story 8.4 (W9): resume/skip/cancel зарегистрированы — видны в меню команд.
      await bot.api.setMyCommands([
        { command: 'start',  description: 'Меню: онбординг, клиенты, инструкция' },
        { command: 'help',   description: 'Инструкция и список команд' },
        { command: 'report', description: 'Создать отчёт по встрече' },
        { command: 'newclient', description: 'Онбординг нового клиента' },
        { command: 'draft', description: 'Собрать черновик онбординга из пакета' },
        { command: 'confirm', description: 'Завершить онбординг клиента' },
        { command: 'status', description: 'Готовность клиента к неделе 1' },
        { command: 'resume', description: 'Продолжить дозаполнение онбординга' },
        { command: 'skip', description: 'Пропустить текущий вопрос онбординга' },
        { command: 'cancel', description: 'Отменить онбординг (с подтверждением)' },
      ]);
    } catch (err) {
      log.warn({ err }, 'failed to set bot commands — continuing');
    }
    try {
      await bot.api.setChatMenuButton({ menu_button: { type: 'commands' } });
    } catch (err) {
      log.warn({ err }, 'failed to set chat menu button — continuing');
    }

    // Story 1.9: wire ops channels. Skip in tests (deps.botInfo !== undefined).
    // Reason: production needs Telegram sendMessage + Sheets append for ops-channel
    // observability; tests inject mocks via deps and don't run the watchdog loop.
    if (deps.botInfo === undefined) {
      const opsChatId = config.TELEGRAM_CHAT_OPS_ID;
      setOpsTelegramSender(async (text: string) => {
        await bot.api.sendMessage(opsChatId, text);
      });
      setOpsSheetsWriter(async (row) => {
        // Story 7.6: ops-лог пишется в таблицу своего клиента (реестр), fallback geonline.
        await appendOpsLog(row, row.clientId || 'geonline');
      });
      _watchdogHandle = await startWatchdog({ aidarMention: config.OPS_AIDAR_MENTION });
      // Story 1.10: cleanup + tar backup scheduler (in-process setInterval; no node-cron).
      _schedulerHandle = await startScheduler({
        dataRoot: 'data',
        archiveDir: process.env.BACKUP_DIR && process.env.BACKUP_DIR.length > 0
          ? process.env.BACKUP_DIR
          : 'data/.backups',
        rawMaxAgeDays: 14,
        backupRetainDays: 7,
      });
    }

    started = true;
    await bot.start({ drop_pending_updates: true });
  };

  return { bot, queue, processJob, stop, start };
}
