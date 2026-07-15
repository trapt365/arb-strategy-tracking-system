import { Bot, BotError, GrammyError, InlineKeyboard, InputFile, type Context } from 'grammy';
import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import type { UserFromGetMe } from 'grammy/types';
import { config, parseTrackerChatIds } from './config.js';
import { parseFeedbackTag, appendFeedbackRow, FEEDBACK_TAG_RE } from './feedback.js';
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
import {
  transcribeFromUrl as defaultTranscribeFromUrl,
  transcribeFromFilePath as defaultTranscribeFromFilePath,
  transcribeFromPlainText as defaultTranscribeFromPlainText,
} from './adapters/transcript.js';
import {
  isTranscriptDocument as defaultIsTranscriptDocument,
  isTranscriptCandidateType,
  parseTranscriptCreatedDate,
} from './utils/transcript-detect.js';
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
import { profileTopsContext, detectCompanyMismatch } from './f0-grounding.js';
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
import type { ClientProfile, ClientTop, F0FullExtraction } from './types.js';
import { ClientTopSchema, ClientTopArraySchema } from './types.js';
import {
  PROFILE_MIN_COUNT,
  PROFILE_EXT_COUNT,
  PROFILE_TOTAL_COUNT,
  PROFILE_PRIORITY_OPTIONS,
  PROFILE_PRIORITY_PICKS,
  nextProfileQuestion,
  applyProfileAnswer,
  isQuestionAnswered,
  topFromRawAnswer,
  renderProfileQuestion,
  renderProfileStatusMessage,
  renderTopShort,
  countExtendedFilled,
  type ProfileQuestion,
} from './f0-profile.js';
import { extractTextFromDocument as defaultExtractTextFromDocument } from './utils/f0-document.js';
import { createSonioxClient, type SonioxClient } from './adapters/soniox.js';
import {
  QN_B1_3_TEXT,
  QN_B5_1_TEXT,
  QN_B5_2_TEXT,
  qnB2_1Text,
  qnB2_2Text,
  buildQnDraft,
} from './f0-questionnaire.js';
import {
  isSupportedF0Document,
  isXlsxDocument,
  F0_MAX_FILE_BYTES,
  F0_MAX_DOC_CHARS,
} from './utils/f0-input.js';
import { F0OnboardingError, F0SheetsError, F1PipelineError } from './errors.js';
import { classifyClaudeApiError, callClaudeSafe, callClaudeWithImage } from './adapters/claude.js';
import { assertTranscriptDuration } from './utils/transcript-duration-guard.js';
import { createReportQueue, QueueOverflowError, type ReportQueue } from './utils/report-queue.js';
import {
  getISOWeekAndYear,
  loadWeekReports,
  loadAllReports,
  groupReportsByWeek,
  formatWeeklyReport,
  formatWeeklyCompact,
} from './utils/weekly-report.js';
import { saveHypoReport, listHypoReports, loadHypoReport } from './utils/hypo-history.js';
import { loadExternalReports } from './utils/external-reports.js';
import { runHypoTracker } from './f5-hypo-tracker.js';
import { withRetry } from './utils/retry.js';
import {
  escapeMarkdownV2,
  formatDeliveryReportCompact,
  formatTopMessagePlainText,
  formatErrorMessage,
  formatHelpHint,
  formatProgressStep,
  formatQueueAck,
  formatShortWelcome,
  formatWelcomeMessage,
  splitForTelegram,
  TELEGRAM_SAFE_MARGIN,
  truncateEllipsis,
  type ProgressStep,
} from './utils/telegram-formatter.js';
import type { ReportJob } from './types.js';
import { loadPrompt as defaultLoadPrompt } from './utils/prompt-loader.js';

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
  /** Story 9.5: Soniox-клиент для транскрипции голосовых ответов. */
  sonioxClient?: SonioxClient;
  /** Story 10.1: транскрипция Telegram-файла встречи (тесты подменяют). */
  transcribeFromFilePath?: typeof defaultTranscribeFromFilePath;
  /** Story 11.5: LLM-экстракция участника профиля A3.2 (тесты подменяют). */
  extractTopWithLlm?: (phrase: string) => Promise<ClientTop>;
  /** Story 11.7: text transcript processing (тесты подменяют). */
  transcribeFromPlainText?: typeof defaultTranscribeFromPlainText;
  /** Story 11.7: testable detection of transcript vs onboarding document. */
  isTranscriptDocument?: (text: string) => boolean;
  /** Story 11.8: batch extraction from text for A3.2 team list (тесты подменяют). */
  extractAllTopsWithLlm?: (text: string) => Promise<ClientTop[]>;
  /** Story 11.8: batch extraction from image for A3.2 (тесты подменяют). */
  extractAllTopsWithLlmFromImage?: (buf: Buffer, mimeType: string) => Promise<ClientTop[]>;
}

export interface CreatedBot {
  bot: Bot;
  queue: ReportQueue;
  processJob: (job: ReportJob) => Promise<void>;
  stop: () => Promise<void>;
  start: () => Promise<void>;
}

function sanitizeUrlForLog(rawUrl: string | undefined): string {
  if (rawUrl === undefined) return '[telegram-file]';
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

/**
 * Групповой режим: тег клиента в шапке отчётов (MarkdownV2) — отчёты уходят через
 * bot.api.sendMessage, мимо reply-middleware, поэтому badge добавляется здесь.
 * Falls back на clientId, если имя не резолвится (не бросает).
 */
async function clientBadgeMd(clientId: string): Promise<string> {
  const name = (await getClientName(clientId).catch(() => undefined)) ?? clientId;
  return `👤 ${escapeMarkdownV2(`Клиент: ${name}`)}\n`;
}

export function createBot(deps: BotDeps = {}): CreatedBot {
  const baseLogger = deps.logger ?? rootLogger;
  const log = baseLogger.child({ pipeline: 'F1', step: 'bot.report' });
  // Story 7.3: отдельный child для F0-онбординга — иначе inline {pipeline:'F0'} даёт
  // дубль ключа pipeline поверх привязанного 'F1' в NDJSON.
  const f0Log = baseLogger.child({ pipeline: 'F0' });

  const extractTopWithLlm =
    deps.extractTopWithLlm ??
    (async (phrase: string): Promise<ClientTop> => {
      try {
        const prompt = await defaultLoadPrompt('extract-top', { phrase });
        const result = await callClaudeSafe(prompt, {
          stepName: 'f0.extract_top',
          schema: ClientTopSchema,
          maxTokens: 300,
          logger: f0Log,
        });
        if (result.parsed !== null) return result.parsed;
      } catch {
        /* silent — fallback below */
      }
      return topFromRawAnswer(phrase);
    });

  // Story 11.8: batch extraction from text document for A3.2 participant list.
  const extractAllTopsWithLlm =
    deps.extractAllTopsWithLlm ??
    (async (text: string): Promise<ClientTop[]> => {
      try {
        const prompt = await defaultLoadPrompt('extract-all-tops', { text });
        const result = await callClaudeSafe(prompt, {
          stepName: 'f0.extract_all_tops',
          schema: ClientTopArraySchema,
          maxTokens: 800,
          logger: f0Log,
        });
        return result.parsed ?? [];
      } catch {
        return [];
      }
    });

  // Story 11.8: batch extraction from image for A3.2 participant list.
  const extractAllTopsWithLlmFromImage =
    deps.extractAllTopsWithLlmFromImage ??
    (async (buf: Buffer, mimeType: string): Promise<ClientTop[]> => {
      const imagePrompt =
        'Extract ALL people from this image as a JSON array. Fields: name (string, required), title (string or null), authority (string or null), area (string or null). Return only the JSON array, no extra text.';
      try {
        const result = await callClaudeWithImage(
          buf,
          mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
          imagePrompt,
          {
            stepName: 'f0.extract_all_tops_image',
            schema: ClientTopArraySchema,
            maxTokens: 800,
            logger: f0Log,
          },
        );
        return result.parsed ?? [];
      } catch {
        return [];
      }
    });

  const token = deps.token ?? config.TELEGRAM_BOT_TOKEN;
  const trackerChatIds =
    deps.trackerChatIds ?? parseTrackerChatIds(config.TELEGRAM_TRACKER_CHAT_IDS);
  const progressUpdatesEnabled =
    deps.progressUpdatesEnabled ?? config.F1_PROGRESS_UPDATES_ENABLED;
  const queueMaxSize = deps.queueMaxSize ?? config.F1_QUEUE_MAX_SIZE;

  const runF1 = deps.runF1 ?? defaultRunF1;
  const transcribeFromUrl = deps.transcribeFromUrl ?? defaultTranscribeFromUrl;
  const transcribeFromFilePath = deps.transcribeFromFilePath ?? defaultTranscribeFromFilePath;
  const transcribeFromPlainText = deps.transcribeFromPlainText ?? defaultTranscribeFromPlainText;
  const isTranscriptDocument = deps.isTranscriptDocument ?? defaultIsTranscriptDocument;
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
  // Story 9.5: Soniox-клиент для транскрипции голосовых ответов (lazy — не нужен в тестах).
  const sonioxClientResolved: SonioxClient =
    deps.sonioxClient ??
    createSonioxClient({ logger: baseLogger });

  // In tests, pass deps.botInfo explicitly to skip getMe(). In production, omit so grammY
  // calls getMe() on start — required for /cmd@username matching in group chats.
  const bot = new Bot(token, deps.botInfo !== undefined ? { botInfo: deps.botInfo } : undefined);

  // Story 11.1: глобальный обработчик ошибок — перехватывает любое необработанное
  // исключение из хендлеров, предотвращая unhandledRejection → process.exit(1).
  bot.catch((err: BotError) => {
    log.error({ err: err.error, step: 'bot.catch', updateId: err.ctx.update.update_id }, 'unhandled handler error');
    alertOps({
      pipeline: 'bot',
      step: 'bot.catch',
      error: err.error,
      context: { updateId: err.ctx.update.update_id },
    });
    err.ctx.reply('⚠️ Что-то пошло не так. Попробуй снова — если ошибка повторится, напиши администратору.').catch(() => {});
  });

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
    // Story 9.1: profile — обязательный диалог «Профиль клиента» (Часть A) ДО сбора
    // документов; collecting — приём файлов; filling — диалог дозаполнения;
    // ready — онбординг завершён.
    // Story 9.5: questionnaire — диалог вопросника (B1.3/B2.1/B2.2/B5.1/B5.2).
    phase: 'profile' | 'collecting' | 'filling' | 'ready' | 'questionnaire';
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
    // Story 9.1: профиль клиента (Часть A) + позиция диалога профиля.
    profile?: ClientProfile;
    profileQIndex?: number;
    // Переспрос по текущему вопросу уже был (числовой формат / формат топа) —
    // следующий непустой ответ принимается как есть (максимум 1 переспрос, 8.6).
    profileRetryQIndex?: number;
    // Трекер выбрал «➕ Расширенный профиль» (иначе после минимума — экран выбора).
    profileExtended?: boolean;
    // Дозаполнение профиля из карточки готового клиента — ответы дописываются в card.json.
    profileCardClientId?: string;
    // Story 9.5: вопросник-фаза — этапы, индексы, накопленные данные.
    qnStage?: 'obj_collect' | 'b2_kr' | 'hypo_collect';
    qnObjIdx?: number;
    qnKrStep?: 'text' | 'owner';
    qnHypoStep?: 'statement' | 'metric';
    qnObjectives?: string[];
    qnKrData?: Array<{ formulation: string; owner: string | null }>;
    qnHypotheses?: Array<{ statement: string; metric: string | null }>;
    qnRetryKrIdx?: number;
    // Story 9.5: голосовые ответы — pending transcript, ждём подтверждения трекером.
    voicePending?: { transcript: string };
    // Story 10.3: in-memory флаг смешения клиентов. Не персистируется.
    pendingMismatchDraft?: F0FullDraftResult;
    companyMismatchPending?: boolean;
    // Story 11.8: pending batch-review список участников (только in-memory).
    topsBatchPending?: ClientTop[];
  }
  const f0Sessions = new Map<number, F0Session>();

  // Story 7.3: снимок сессии на диск (warn-only) — переживает рестарт бота.
  async function saveF0Session(chatId: number, s: F0Session): Promise<void> {
    // Story 9.1: профиль персистится после каждого ответа (механика 7.3) — до черновика.
    // Без черновика и без профиля (старый collecting) персистить по-прежнему нечего.
    // Story 9.5: вопросник — профиль всегда есть (9.1 обязателен), страховка на будущее.
    if (s.draft === undefined && s.profile === undefined && s.phase !== 'questionnaire') return;
    await persistF0Session({
      chatId,
      sessionId: s.id,
      phase: s.phase,
      sourceNames: s.draft?.sourceNames ?? [],
      ...(s.draft !== undefined
        ? { draftId: s.draft.draftId, extraction: s.draft.extraction }
        : {}),
      gaps: s.gaps,
      gapIndex: s.gapIndex,
      schedule: s.schedule,
      ...(s.spreadsheetId !== undefined ? { spreadsheetId: s.spreadsheetId } : {}),
      ...(s.retryGapIndex !== undefined ? { retryGapIndex: s.retryGapIndex } : {}),
      ...(s.mode !== undefined ? { mode: s.mode } : {}),
      ...(s.importSourceText !== undefined ? { importSourceText: s.importSourceText } : {}),
      // Ревью эпика 9: пакет и принятый импорт — в персист (иначе restore теряет файлы).
      ...(s.documents.length > 0
        ? { documents: s.documents, documentsChars: s.documentsChars }
        : {}),
      ...(s.importResult !== undefined ? { importResult: s.importResult } : {}),
      ...(s.profile !== undefined ? { profile: s.profile } : {}),
      ...(s.profileQIndex !== undefined ? { profileQIndex: s.profileQIndex } : {}),
      ...(s.profileRetryQIndex !== undefined ? { profileRetryQIndex: s.profileRetryQIndex } : {}),
      ...(s.profileExtended !== undefined ? { profileExtended: s.profileExtended } : {}),
      ...(s.profileCardClientId !== undefined
        ? { profileCardClientId: s.profileCardClientId }
        : {}),
      // Story 9.5: вопросник-поля.
      ...(s.qnStage !== undefined ? { qnStage: s.qnStage } : {}),
      ...(s.qnObjIdx !== undefined ? { qnObjIdx: s.qnObjIdx } : {}),
      ...(s.qnKrStep !== undefined ? { qnKrStep: s.qnKrStep } : {}),
      ...(s.qnHypoStep !== undefined ? { qnHypoStep: s.qnHypoStep } : {}),
      ...(s.qnObjectives !== undefined ? { qnObjectives: s.qnObjectives } : {}),
      ...(s.qnKrData !== undefined ? { qnKrData: s.qnKrData } : {}),
      ...(s.qnHypotheses !== undefined ? { qnHypotheses: s.qnHypotheses } : {}),
      ...(s.qnRetryKrIdx !== undefined ? { qnRetryKrIdx: s.qnRetryKrIdx } : {}),
      ...(s.voicePending !== undefined ? { voicePending: s.voicePending } : {}),
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
      // Ревью эпика 9: пакет/импорт восстанавливаются из персиста, не обнуляются.
      documents: persisted.documents ?? [],
      documentsChars: persisted.documentsChars ?? 0,
      importResult: persisted.importResult,
      // Story 9.1: у сессии фазы profile/collecting черновика ещё нет.
      draft:
        persisted.draftId !== undefined && persisted.extraction !== undefined
          ? {
              draftId: persisted.draftId,
              sourceNames: persisted.sourceNames,
              extraction: persisted.extraction,
            }
          : undefined,
      gaps: persisted.gaps,
      gapIndex: persisted.gapIndex,
      schedule: persisted.schedule,
      spreadsheetId: persisted.spreadsheetId,
      retryGapIndex: persisted.retryGapIndex,
      mode: persisted.mode,
      importSourceText: persisted.importSourceText,
      profile: persisted.profile,
      profileQIndex: persisted.profileQIndex,
      profileRetryQIndex: persisted.profileRetryQIndex,
      profileExtended: persisted.profileExtended,
      profileCardClientId: persisted.profileCardClientId,
      // Story 9.5: вопросник-поля.
      qnStage: persisted.qnStage,
      qnObjIdx: persisted.qnObjIdx,
      qnKrStep: persisted.qnKrStep,
      qnHypoStep: persisted.qnHypoStep,
      qnObjectives: persisted.qnObjectives,
      qnKrData: persisted.qnKrData,
      qnHypotheses: persisted.qnHypotheses,
      qnRetryKrIdx: persisted.qnRetryKrIdx,
      voicePending: persisted.voicePending,
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
    const parts = splitForTelegram(
      (await clientBadgeMd(job.clientId)) + (job.lastReportText ?? ''),
      TELEGRAM_SAFE_MARGIN,
      continuation,
    );

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
    const parts = splitForTelegram(
      (await clientBadgeMd(job.clientId)) + reportText,
      TELEGRAM_SAFE_MARGIN,
      continuation,
    );

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
        if (job.transcriptText !== undefined) {
          // Story 11.7: plain-text transcript — no audio file needed.
          transcript = await transcribeFromPlainText(job.transcriptText, {
            clientId: job.clientId,
            meetingDate: job.meetingDate,
            meetingType: job.meetingType,
          }, { logger: baseLogger });
        } else if (job.filePath) {
          transcript = await transcribeFromFilePath(job.filePath, {
            clientId: job.clientId,
            meetingDate: job.meetingDate,
            meetingType: job.meetingType,
          }, { sonioxClient: sonioxClientResolved, logger: baseLogger });
        } else {
          transcript = await transcribeFromUrl(job.url!, {
            clientId: job.clientId,
            meetingDate: job.meetingDate,
            meetingType: job.meetingType,
          });
        }
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
      // Story 11.7: пропускаем для plain-text job (duration = 0 — это норма для parsePlainText).
      if (job.transcriptText === undefined) {
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
      if (job.filePath) {
        await unlink(job.filePath).catch(() => {});
      }
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
      // bot.unauthorized = чужой/неразрешённый чат пишет боту. Это про доступ, НЕ про
      // здоровье пайплайна. Логируем тихо, БЕЗ alertOps → не роняем watchdog и не будим
      // Айдара ложным «Pipeline down». Реальные сбои обработки звонков/отчётов остаются
      // под watchdog. (WP-39, 2026-07-15)
      log.warn({ chatId, command }, 'bot.unauthorized');
      try {
        await ctx.reply(formatErrorMessage('unauthorized'));
      } catch (err) {
        log.warn({ err }, 'failed to send unauthorized reply');
      }
      return;
    }
    await next();
  });

  // Групповой режим: тег клиента в каждом интерактивном ответе (Story 10.7 расширена на все
  // сообщения). Бейдж считается один раз до next() → wrapper синхронный, не ломает fire-and-forget
  // тайминг. Не дублируется, если сообщение уже начинается с «👤 Клиент:» (Story 10.7 и т.п.).
  // Отчёты идут через bot.api.sendMessage — там бейдж добавляет clientBadgeMd.
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    let clientLabel: string | undefined;
    try {
      const activeId = chatId !== undefined ? await getActiveClient(chatId) : undefined;
      clientLabel = activeId
        ? (await getClientName(activeId).catch(() => undefined)) ?? activeId
        : undefined;
    } catch {
      clientLabel = undefined;
    }
    const badge = `👤 Клиент: ${clientLabel ?? 'не выбран'}`;

    const origReply = ctx.reply.bind(ctx);
    ctx.reply = ((
      text: string,
      other?: Parameters<typeof origReply>[1],
      signal?: Parameters<typeof origReply>[2],
    ) => {
      if (typeof text === 'string' && text.startsWith('👤 Клиент:')) {
        return origReply(text, other, signal);
      }
      const mode = (other as { parse_mode?: string } | undefined)?.parse_mode;
      const prefix =
        mode === 'MarkdownV2'
          ? `${escapeMarkdownV2(badge)}\n\n`
          : mode === 'HTML'
            ? `${badge.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n\n`
            : `${badge}\n\n`;
      return origReply(prefix + text, other, signal);
    }) as typeof ctx.reply;
    await next();
  });

  // ───────── Захват обратной связи: #баг / #фича / #хочу ─────────
  // Регистрируется ДО штатных хендлеров (message:text/photo). Совпадение по тегу →
  // строка в таблицу обратной связи + подтверждение, без прохода в основную функцию.
  // Всё без тега идёт дальше штатно (grammy: не вызываем next() только при совпадении).
  async function captureFeedback(ctx: Context): Promise<void> {
    const text = ctx.msg?.text ?? ctx.msg?.caption ?? '';
    const parsed = parseFeedbackTag(text);
    if (parsed === null) return;

    const from = ctx.from;
    const name = [from?.first_name, from?.last_name].filter(Boolean).join(' ').trim();
    const author =
      (name.length > 0 ? name : 'неизвестно') + (from?.username ? ` (@${from.username})` : '');
    const date = new Date().toLocaleString('ru-RU', {
      timeZone: config.TZ,
      dateStyle: 'short',
      timeStyle: 'short',
    });
    const feedbackUrl = config.FEEDBACK_SHEET_ID
      ? `https://docs.google.com/spreadsheets/d/${config.FEEDBACK_SHEET_ID}/edit`
      : '';

    try {
      await appendFeedbackRow({
        date,
        author,
        type: parsed.type,
        body: parsed.body.length > 0 ? parsed.body : '(без текста)',
        link: '',
      });
      log.info({ type: parsed.type, author }, 'feedback.captured');
      await ctx
        .reply(
          `✅ Записал #${parsed.type} в таблицу обратной связи.` +
            (feedbackUrl ? `\nСтатус ведём тут: ${feedbackUrl}` : ''),
        )
        .catch(() => {});
    } catch (err) {
      log.warn({ err, type: parsed.type }, 'feedback.append_failed');
      await ctx
        .reply('⚠️ Не смог записать в таблицу обратной связи — зафиксировал в логах, гляну вручную.')
        .catch(() => {});
    }
  }

  bot.hears(FEEDBACK_TAG_RE, async (ctx) => {
    await captureFeedback(ctx);
  });

  // ───────── /start and /help (Story 1.8; меню — Story 8.4) ─────────

  // Story 8.4 (W1): стартовое меню — онбординг и клиенты доступны без запоминания команд.
  // Story 9.3: если есть зарегистрированные клиенты — кнопки для каждого + «Онбординг» + «Что умеет бот».
  //            Пустой реестр → прежние 3 кнопки (Что умеет бот / Онбординг / Клиенты).
  function buildStartMenuKeyboard(clients: { id: string; name: string }[]): InlineKeyboard {
    if (clients.length > 0) {
      const kb = new InlineKeyboard();
      for (const client of clients) {
        kb.text(client.name, `start_client:${client.id}`).row();
      }
      kb.text('🆕 Онбординг нового клиента', 'menu:new').row().text('ℹ️ Что умеет бот', 'menu:help');
      return kb;
    }
    return new InlineKeyboard()
      .text('ℹ️ Что умеет бот', 'menu:help')
      .row()
      .text('🆕 Онбординг нового клиента', 'menu:new')
      .row()
      .text('👥 Клиенты', 'menu:clients');
  }

  bot.command('start', async (ctx) => {
    const firstName = ctx.from?.first_name?.trim() || undefined;
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    try {
      const registry = await loadRegistry();
      const clients = Object.keys(registry).map((id) => ({ id, name: registry[id]?.name ?? id }));
      const activeId = await getActiveClient(chatId).catch(() => undefined);
      const activeName =
        activeId !== undefined
          ? ((await getClientName(activeId).catch(() => undefined)) ?? activeId)
          : undefined;
      const welcomeText = formatShortWelcome(firstName, activeName);
      await ctx.reply(welcomeText, { reply_markup: buildStartMenuKeyboard(clients) });
    } catch (err) {
      log.warn({ err, chatId }, 'bot.start.reply_failed');
      return;
    }
    log.info(
      { step: 'bot.start.welcomed', chatId, firstName },
      'welcome sent',
    );
  });

  bot.command('help', async (ctx) => {
    const firstName = ctx.from?.first_name?.trim() || undefined;
    await ctx.reply(formatWelcomeMessage(firstName)).catch((err) => {
      log.warn({ err, chatId: ctx.chat.id }, 'bot.help.reply_failed');
      return;
    });
    log.info({ step: 'bot.help.requested', chatId: ctx.chat.id }, 'help sent');
  });

  // ───────── /newclient — F0 onboarding (Story 7.1 + 7.2) ─────────

  // Story 8.5: два пути входа — импорт готового Excel (без LLM) или синтез из документов.
  // Кнопки не обязательны: путь фиксируется и автоматически по расширению первого файла.
  const F0_STRATEGY_SCREEN_TEXT = 'Как заводим стратегию?';
  const F0_BUSY_TEXT = '⏳ Уже обрабатываю пакет — дождись черновика.';
  const F0_NO_SESSION_TEXT =
    'Чтобы начать онбординг нового клиента, отправь /newclient — затем пришли документы.';
  const F0_UNSUPPORTED_TEXT =
    '⚠️ Поддерживаются .md, .txt, .docx, .pdf, .pptx. Пришли документ в одном из этих форматов.';
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
      '💡 Выбери другой путь:',
  };

  const f0BuildKeyboard = new InlineKeyboard().text('✅ Собрать черновик', 'f0_build');
  // Story 9.4: три пути онбординга (кнопки опциональны — есть автодетект по файлу).
  const f0StrategyKeyboard = new InlineKeyboard()
    .text('📥 Готовая стратегия в Excel', 'f0_mode_import').row()
    .text('💬 Вопросник (с голосом)', 'f0_mode_questionnaire').row()
    .text('📄 Документы (протоколы, транскрипты, презентации)', 'f0_mode_synthesis');

  // ───────── Story 9.1: диалог «Профиль клиента» (Часть A) — первый шаг ─────────

  const F0_PROFILE_INTRO = [
    '🆕 Онбординг нового клиента. Первый шаг — профиль клиента:',
    '🔑-минимум из 2 вопросов (название и суть бизнеса).',
    'Способ загрузки стратегии и расширенный профиль предложу после минимума.',
  ].join('\n');
  const F0_PROFILE_KEY_REQUIRED_TEXT =
    '🔑 Этот вопрос — обязательный минимум профиля: без него онбординг стратегии не начнётся, пропустить нельзя.';
  const F0_PROFILE_FIRST_TEXT =
    'ℹ️ Сначала профиль клиента — документы стратегии приму после 🔑-минимума. Продолжить вопросы — /resume.';
  const F0_PROFILE_STALE_TEXT =
    'ℹ️ Эта кнопка от прошлого диалога профиля. Актуальное состояние — /status, продолжить — /resume.';

  const f0ProfileTopsKeyboard = new InlineKeyboard()
    .text('➕ Добавить ещё', 'f0p_top_more')
    .text('✅ Готово', 'f0p_top_done');
  const f0ProfileOfferKeyboard = new InlineKeyboard()
    .text('➕ Добавить участников', 'f0p_ext')
    .text('Дальше', 'f0p_go');

  function currentProfileQuestion(session: F0Session): ProfileQuestion | undefined {
    return nextProfileQuestion(session.profileQIndex ?? 0);
  }

  /** Минимум собран, но выбор «расширенный / дальше» ещё не сделан. */
  function profileOfferPending(session: F0Session): boolean {
    return (
      (session.profileQIndex ?? 0) >= PROFILE_MIN_COUNT &&
      session.profileExtended !== true &&
      session.profileCardClientId === undefined
    );
  }

  /** Кнопки приоритетов A4.6 — ещё не выбранные варианты. */
  function profilePrioKeyboard(session: F0Session): InlineKeyboard | undefined {
    const picked = session.profile?.request?.priorities ?? [];
    const kb = new InlineKeyboard();
    let any = false;
    PROFILE_PRIORITY_OPTIONS.forEach((opt, i) => {
      if (picked.includes(opt)) return;
      kb.text(opt, `f0p_prio:${i}`).row();
      any = true;
    });
    return any ? kb : undefined;
  }

  /** Экран после 🔑-минимума: расширенный профиль или сразу к стратегии. */
  async function sendProfileOffer(ctx: Context, _session: F0Session): Promise<void> {
    await ctx
      .reply(
        '✅ Название и суть зафиксированы. Добавить участников и детали сейчас — или сразу к стратегии?',
        { reply_markup: f0ProfileOfferKeyboard },
      )
      .catch(() => {});
  }

  /** Дозаполнение из карточки: ответы дописываются в card.json (warn-only). */
  async function writeProfileToCard(session: F0Session): Promise<void> {
    const clientId = session.profileCardClientId;
    if (clientId === undefined || session.profile === undefined) return;
    const card = await loadClientCard(clientId);
    if (card === null) {
      f0Log.warn(
        { step: 'f0.profile_card_missing', clientId },
        'client card disappeared during profile fill — answers kept in session only',
      );
      return;
    }
    await persistClientCard({ ...card, profile: session.profile });
  }

  /** Профиль завершён: дозаполнение → карточка; онбординг → существующий flow сбора. */
  async function finishProfileDialog(ctx: Context, session: F0Session): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (session.profileCardClientId !== undefined) {
      await writeProfileToCard(session);
      const ext = countExtendedFilled(session.profile ?? {});
      f0Sessions.delete(chatId);
      await deleteF0Session(chatId);
      f0Log.info(
        {
          step: 'f0.profile_card_filled',
          chatId,
          clientId: session.profileCardClientId,
          extendedFilled: ext.filled,
        },
        'client profile filled from card',
      );
      await ctx
        .reply(
          `✅ Профиль дозаполнен (расширенная часть: ${ext.filled}/${ext.total}) — записал в карточку клиента.`,
        )
        .catch(() => {});
      return;
    }
    await startStrategyCollection(ctx, session);
  }

  /**
   * Переход из профиля в flow сбора стратегии (Story 9.4: экран «Как заводим стратегию?»
   * с тремя кнопками — f0StrategyKeyboard).
   */
  async function startStrategyCollection(ctx: Context, session: F0Session): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    session.phase = 'collecting';
    session.profileRetryQIndex = undefined;
    await saveF0Session(chatId, session);
    f0Log.info(
      {
        step: 'f0.profile_completed',
        chatId,
        sessionId: session.id,
        extended: session.profileExtended === true,
        tops: session.profile?.tops?.length ?? 0,
      },
      'f0 client profile completed — strategy collection started',
    );
    await ctx.reply(F0_STRATEGY_SCREEN_TEXT, { reply_markup: f0StrategyKeyboard }).catch((err) => {
      log.warn({ err, chatId }, 'f0.start.reply_failed');
    });
  }

  /** Задать текущий вопрос профиля (или экран выбора / финал). */
  async function askNextProfileQuestion(ctx: Context, session: F0Session): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const profile = session.profile ?? {};
    // Дозаполнение из карточки: уже отвеченные вопросы не переспрашиваем.
    if (session.profileCardClientId !== undefined) {
      let qi = session.profileQIndex ?? 0;
      while (qi < PROFILE_TOTAL_COUNT && isQuestionAnswered(profile, nextProfileQuestion(qi)!)) {
        qi += 1;
      }
      if (qi !== session.profileQIndex) {
        session.profileQIndex = qi;
        await saveF0Session(chatId, session);
      }
    }
    if (profileOfferPending(session)) {
      await sendProfileOffer(ctx, session);
      return;
    }
    const qIndex = session.profileQIndex ?? 0;
    const q = nextProfileQuestion(qIndex);
    if (q === undefined) {
      await finishProfileDialog(ctx, session);
      return;
    }
    const inExt = qIndex >= PROFILE_MIN_COUNT;
    const index = inExt ? qIndex - PROFILE_MIN_COUNT + 1 : qIndex + 1;
    const total = inExt ? PROFILE_EXT_COUNT : PROFILE_MIN_COUNT;
    const prev = qIndex > 0 ? nextProfileQuestion(qIndex - 1) : undefined;
    const withHeader = prev === undefined || prev.block !== q.block || qIndex === PROFILE_MIN_COUNT;
    let text = renderProfileQuestion(q, { index, total, withHeader });
    let keyboard: InlineKeyboard | undefined;
    if (q.id === 'a4_6') keyboard = profilePrioKeyboard(session);
    else if (q.id === 'a3_2' && (profile.tops ?? []).length > 0) keyboard = f0ProfileTopsKeyboard;
    // Story 11.8: front-load batch hint at A3.2 when no tops yet.
    // Note: a3_2 is always in extended questions (inExt=true), so we omit the !inExt guard
    // from the spec to make the hint actually appear per the AC.
    if (q.id === 'a3_2' && (profile.tops ?? []).length === 0) {
      text +=
        '\n\n💡 Можешь прислать список разом — фото 📸, документ 📎 (PDF/DOCX/TXT) или голос 🎤 (добавляю по одному). Или вводи текстом по одному.';
    }
    await ctx
      .reply(text, keyboard !== undefined ? { reply_markup: keyboard } : undefined)
      .catch(() => {});
  }

  /** Продвинуть очередь профиля на следующий вопрос (persist после каждого шага). */
  async function advanceProfileQuestion(
    ctx: Context,
    session: F0Session,
    q: ProfileQuestion,
    outcome: 'answered' | 'skipped',
  ): Promise<void> {
    const chatId = ctx.chat!.id;
    session.profileRetryQIndex = undefined;
    session.profileQIndex = (session.profileQIndex ?? 0) + 1;
    await saveF0Session(chatId, session);
    if (session.profileCardClientId !== undefined) await writeProfileToCard(session);
    f0Log.info(
      { step: `f0.profile_${outcome}`, chatId, sessionId: session.id, questionId: q.id },
      `f0 profile question ${outcome}`,
    );
    await askNextProfileQuestion(ctx, session);
  }

  /** Текстовый ответ трекера на вопрос профиля. */
  async function handleF0ProfileAnswer(
    ctx: Context,
    session: F0Session,
    rawText: string,
  ): Promise<void> {
    const chatId = ctx.chat!.id;
    session.profile ??= {};
    const profile = session.profile;
    if (profileOfferPending(session)) {
      await sendProfileOffer(ctx, session); // выбор — кнопкой, текст не интерпретируем
      return;
    }
    const qIndex = session.profileQIndex ?? 0;
    const q = nextProfileQuestion(qIndex);
    if (q === undefined) {
      await finishProfileDialog(ctx, session);
      return;
    }
    const text = rawText.trim();
    if (text.length === 0) {
      await ctx.reply('Пустой ответ. Впиши значение или пропусти: /skip.').catch(() => {});
      return;
    }
    // «не знаю» на расширенном вопросе = /skip (матрица I/O): поле не заполняется,
    // незнание — тоже данные. На 🔑 принимается как обычный ответ не может — 🔑 без
    // содержимого бессмыслен, но и не блокируем: трекер отвечает за формулировку.
    if (!q.key && /^не\s+знаю\W*$/iu.test(text)) {
      await advanceProfileQuestion(ctx, session, q, 'skipped');
      return;
    }
    // Мягкая числовая валидация 8.6 (A2.1, A2.2, A2.5): один переспрос, повтор принимается.
    if (
      q.type === 'number' &&
      !looksNumericAnswer(text) &&
      session.profileRetryQIndex !== qIndex
    ) {
      session.profileRetryQIndex = qIndex;
      await saveF0Session(chatId, session);
      f0Log.info(
        { step: 'f0.profile_retry', chatId, sessionId: session.id, questionId: q.id },
        'f0 profile numeric retry',
      );
      await ctx
        .reply(
          '🔁 Не вижу числа в ответе, а тут нужно значение (например «120 млн» или «12%»).\n' +
            'Если так и надо — отправь ответ ещё раз, приму как есть. Или пропусти: /skip.',
        )
        .catch(() => {});
      return;
    }
    // Топы A3.2: LLM-экстракция участника из свободной фразы (Story 11.5).
    // При ошибке LLM — fallback на topFromRawAnswer (name = фраза целиком).
    if (q.type === 'tops') {
      let top: ClientTop;
      try {
        top = await extractTopWithLlm(text);
      } catch {
        top = topFromRawAnswer(text);
      }
      profile.tops = [...(profile.tops ?? []), top];
      session.profileRetryQIndex = undefined;
      await saveF0Session(chatId, session);
      f0Log.info(
        { step: 'f0.profile_top_added', chatId, sessionId: session.id, tops: profile.tops.length },
        'f0 profile top added',
      );
      await ctx
        .reply(`✅ Участник добавлен: ${renderTopShort(top)} (всего: ${profile.tops.length}).`, {
          reply_markup: f0ProfileTopsKeyboard,
        })
        .catch(() => {});
      return; // очередь стоит — ждём следующего топа или «✅ Готово»
    }
    const written = applyProfileAnswer(profile, q, text);
    if (!written) {
      await ctx.reply('Пустой ответ. Впиши значение или пропусти: /skip.').catch(() => {});
      return;
    }
    await advanceProfileQuestion(ctx, session, q, 'answered');
  }

  /** Общая валидация callback-кнопок профиля: сессия в фазе profile + нужный вопрос. */
  async function getProfileSessionForCallback(
    ctx: Context,
    expectQuestionId?: string,
  ): Promise<F0Session | undefined> {
    await ctx.answerCallbackQuery().catch(() => {});
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return undefined;
    const session = await getOrRestoreF0Session(chatId);
    if (session === undefined || session.phase !== 'profile') {
      await ctx.reply(F0_PROFILE_STALE_TEXT).catch(() => {});
      return undefined;
    }
    if (expectQuestionId !== undefined) {
      const q = currentProfileQuestion(session);
      if (q?.id !== expectQuestionId || profileOfferPending(session)) {
        await ctx.reply(F0_PROFILE_STALE_TEXT).catch(() => {});
        return undefined;
      }
    }
    return session;
  }

  bot.callbackQuery('f0p_top_more', async (ctx) => {
    const session = await getProfileSessionForCallback(ctx, 'a3_2');
    if (session === undefined) return;
    await ctx
      .reply('Пришли следующего участника свободной фразой.')
      .catch(() => {});
  });

  bot.callbackQuery('f0p_top_done', async (ctx) => {
    const session = await getProfileSessionForCallback(ctx, 'a3_2');
    if (session === undefined) return;
    const q = currentProfileQuestion(session)!;
    if ((session.profile?.tops ?? []).length === 0) {
      await ctx
        .reply('🔑 Нужен хотя бы один участник — напиши имя и должность.')
        .catch(() => {});
      return;
    }
    await advanceProfileQuestion(ctx, session, q, 'answered');
  });

  // Story 11.8: batch review — ✅ Принять: merge pending tops and advance to next question.
  bot.callbackQuery('f0p_batch_ok', async (ctx) => {
    const session = await getProfileSessionForCallback(ctx, 'a3_2');
    if (session === undefined) return;
    const pending = session.topsBatchPending;
    if (!pending || pending.length === 0) {
      await ctx.reply(F0_PROFILE_STALE_TEXT).catch(() => {});
      return;
    }
    const q = currentProfileQuestion(session)!;
    session.profile ??= {};
    session.profile.tops = [...(session.profile.tops ?? []), ...pending];
    session.topsBatchPending = undefined;
    const total = session.profile.tops.length;
    await ctx.reply(`✅ Добавлено ${pending.length} участников (всего: ${total}).`).catch(() => {});
    await advanceProfileQuestion(ctx, session, q, 'answered');
  });

  // Story 11.8: batch review — ✏️ Добавить ещё: merge pending tops and stay at A3.2.
  bot.callbackQuery('f0p_batch_more', async (ctx) => {
    const session = await getProfileSessionForCallback(ctx, 'a3_2');
    if (session === undefined) return;
    const pending = session.topsBatchPending;
    if (!pending || pending.length === 0) {
      await ctx.reply(F0_PROFILE_STALE_TEXT).catch(() => {});
      return;
    }
    const chatId = ctx.chat!.id;
    session.profile ??= {};
    session.profile.tops = [...(session.profile.tops ?? []), ...pending];
    session.topsBatchPending = undefined;
    await saveF0Session(chatId, session);
    await ctx
      .reply(`✅ Добавлено ${pending.length}. Пришли следующего участника свободной фразой.`, {
        reply_markup: f0ProfileTopsKeyboard,
      })
      .catch(() => {});
  });

  bot.callbackQuery(/^f0p_prio:(\d+)$/, async (ctx) => {
    const session = await getProfileSessionForCallback(ctx, 'a4_6');
    if (session === undefined) return;
    const q = currentProfileQuestion(session)!;
    const option = PROFILE_PRIORITY_OPTIONS[Number(ctx.match[1])];
    if (option === undefined) return;
    session.profile ??= {};
    const request = { ...(session.profile.request ?? {}) };
    const picked = [...(request.priorities ?? [])];
    if (picked.includes(option)) return; // повторный тап — молча игнорируем
    picked.push(option);
    request.priorities = picked;
    session.profile.request = request;
    await saveF0Session(ctx.chat!.id, session);
    if (picked.length >= PROFILE_PRIORITY_PICKS) {
      await ctx
        .reply(`✅ Приоритеты: ${picked.map((p, i) => `${i + 1}. ${p}`).join(' · ')}.`)
        .catch(() => {});
      await advanceProfileQuestion(ctx, session, q, 'answered');
      return;
    }
    const kb = profilePrioKeyboard(session);
    await ctx
      .reply(
        `Выбрано: ${picked.map((p, i) => `${i + 1}. ${p}`).join(' · ')}. Выбери ещё ${PROFILE_PRIORITY_PICKS - picked.length}.`,
        kb !== undefined ? { reply_markup: kb } : undefined,
      )
      .catch(() => {});
  });

  // Экран выбора после 🔑-минимума: расширенный профиль или сразу к стратегии.
  bot.callbackQuery('f0p_ext', async (ctx) => {
    const session = await getProfileSessionForCallback(ctx);
    if (session === undefined) return;
    if (!profileOfferPending(session)) {
      await ctx.reply(F0_PROFILE_STALE_TEXT).catch(() => {});
      return;
    }
    session.profileExtended = true;
    await saveF0Session(ctx.chat!.id, session);
    f0Log.info(
      { step: 'f0.profile_extended_started', chatId: ctx.chat!.id, sessionId: session.id },
      'f0 extended profile started',
    );
    await askNextProfileQuestion(ctx, session);
  });

  bot.callbackQuery('f0p_go', async (ctx) => {
    const session = await getProfileSessionForCallback(ctx);
    if (session === undefined) return;
    if (!profileOfferPending(session)) {
      await ctx.reply(F0_PROFILE_STALE_TEXT).catch(() => {});
      return;
    }
    await startStrategyCollection(ctx, session);
  });

  // Story 9.1: «➕ Дозаполнить профиль» на карточке готового клиента — расширенные
  // вопросы тем же механизмом персиста; ответы дописываются в card.json.
  bot.callbackQuery(/^profile_fill:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const clientId = ctx.match[1]!;
    const existing = await getOrRestoreF0Session(chatId);
    if (existing?.phase === 'profile' || f0SessionAtRisk(existing)) {
      await ctx
        .reply('⚠️ Идёт другой онбординг/диалог. Отмени его или продолжи:', {
          reply_markup: new InlineKeyboard()
            .text('❌ Отменить онбординг', `f0_cancel_stuck:${existing.id}`)
            .text('↩️ Продолжить', 'f0_cancel_stuck_no'),
        })
        .catch(() => {});
      return;
    }
    const card = await loadClientCard(clientId);
    if (card === null) {
      await ctx.reply(`ℹ️ Карточка клиента «${clientId}» не найдена.`).catch(() => {});
      return;
    }
    const session: F0Session = {
      id: randomUUID().slice(0, 8),
      processing: false,
      phase: 'profile',
      documents: [],
      documentsChars: 0,
      gaps: [],
      gapIndex: 0,
      schedule: null,
      profile: { ...(card.profile ?? {}) },
      profileQIndex: PROFILE_MIN_COUNT, // только расширенные вопросы
      profileExtended: true,
      profileCardClientId: clientId,
    };
    f0Sessions.set(chatId, session);
    await saveF0Session(chatId, session);
    f0Log.info(
      { step: 'f0.profile_card_fill_started', chatId, sessionId: session.id, clientId },
      'f0 profile fill from client card started',
    );
    await ctx
      .reply(`➕ Дозаполняем профиль «${card.company}» — расширенные вопросы. Ответы пишутся в карточку.`)
      .catch(() => {});
    await askNextProfileQuestion(ctx, session);
  });

  async function startF0Session(ctx: Context, trigger: string): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (f0Sessions.get(chatId)?.processing) {
      await ctx.reply(F0_BUSY_TEXT).catch(() => {});
      return;
    }
    // Story 9.1: онбординг начинается с обязательного профиля клиента (Часть A),
    // экран выбора пути (f0StrategyKeyboard, 3 кнопки) — после 🔑-минимума (Story 9.4).
    const session: F0Session = {
      id: randomUUID().slice(0, 8),
      processing: false,
      phase: 'profile',
      documents: [],
      documentsChars: 0,
      gaps: [],
      gapIndex: 0,
      schedule: null,
      profile: {},
      profileQIndex: 0,
    };
    f0Sessions.set(chatId, session);
    await deleteF0Session(chatId); // сбрасываем персист прошлого онбординга этого чата
    await saveF0Session(chatId, session); // профиль переживает рестарт с первого вопроса
    f0Log.info(
      { step: 'f0.session_started', chatId, sessionId: session.id, trigger },
      'f0 onboarding session started',
    );
    await ctx.reply(F0_PROFILE_INTRO).catch((err) => {
      log.warn({ err, chatId }, 'f0.start.reply_failed');
    });
    await askNextProfileQuestion(ctx, session);
  }

  // Story 8.5: явный выбор пути кнопкой. Работает только в collecting до первого файла —
  // после автодетекта путь уже зафиксирован, молча переключать накопленное нельзя.
  async function chooseF0Mode(ctx: Context, mode: 'import' | 'synthesis'): Promise<void> {
    await ctx.answerCallbackQuery().catch(() => {});
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const session = await getOrRestoreF0Session(chatId);
    // Story 9.1: до 🔑-минимума профиля способ онбординга не выбирается.
    if (session?.phase === 'profile') {
      await ctx
        .reply('ℹ️ Сначала 🔑-минимум профиля клиента — способ загрузки стратегии предложу после. Продолжить — /resume.')
        .catch(() => {});
      return;
    }
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
  // Story 9.5: вопросник — обработчик кнопки «💬 Вопросник (с голосом)».
  bot.callbackQuery('f0_mode_questionnaire', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const session = await getOrRestoreF0Session(chatId);
    // Как у chooseF0Mode: работает только в collecting (после профиля).
    if (session?.phase === 'profile') {
      await ctx
        .reply('ℹ️ Сначала 🔑-минимум профиля клиента — способ загрузки стратегии предложу после. Продолжить — /resume.')
        .catch(() => {});
      return;
    }
    if (session === undefined || session.phase !== 'collecting') {
      await ctx.reply(F0_NO_SESSION_TEXT).catch(() => {});
      return;
    }
    // Ревью эпика 9: как chooseF0Mode — не бросать молча уже накопленный путь
    // (принятый xlsx / загруженные документы). Иначе вопросник затирает стратегию.
    if (session.mode !== undefined || session.documents.length > 0 || session.importResult !== undefined) {
      const what =
        session.importResult !== undefined || session.mode === 'import'
          ? 'импорт Excel'
          : 'сборка из документов';
      await ctx
        .reply(`ℹ️ Путь уже определён: ${what}. Вопросник — только с чистого листа: /newclient.`)
        .catch(() => {});
      return;
    }
    session.phase = 'questionnaire';
    session.qnStage = 'obj_collect';
    session.qnObjectives = [];
    session.qnKrData = [];
    session.qnHypotheses = [];
    await saveF0Session(chatId, session);
    f0Log.info(
      { step: 'f0.questionnaire_started', chatId, sessionId: session.id },
      'f0 questionnaire started',
    );
    await ctx
      .reply(QN_B1_3_TEXT, {
        reply_markup: new InlineKeyboard().text('✅ Готово', 'f0q_obj_done'),
      })
      .catch(() => {});
  });

  // Story 8.4 (W3): сессия с несохранённым прогрессом — черновик с ответами (filling)
  // или собранный, но не отработанный пакет файлов (collecting). Ready не в счёт:
  // онбординг завершён, данные в таблице/карточке.
  function f0SessionAtRisk(session: F0Session | undefined): session is F0Session {
    if (session === undefined) return false;
    if (session.phase === 'filling') return true;
    // Story 9.1: начатый профиль (есть хотя бы один ответ) — прогресс, не сбрасываем молча.
    if (session.phase === 'profile') return (session.profileQIndex ?? 0) > 0;
    // Story 9.5: активный вопросник — тоже прогресс.
    if (session.phase === 'questionnaire') return true;
    // Story 8.5: принятый, но не отработанный xlsx — тоже несохранённый прогресс.
    // Story 9.1: собранный профиль в collecting (до черновика) — тоже прогресс.
    return (
      session.phase === 'collecting' &&
      (session.documents.length > 0 ||
        session.importResult !== undefined ||
        session.profile !== undefined)
    );
  }

  // ─── Story 9.5: вопросник — вспомогательные функции ─────────────────────────

  /**
   * Клавиатура выбора ответственного из топов профиля.
   * Ревью эпика 9: callback_data = только индекс (не имя) — кириллическое имя в
   * data превышало лимит Telegram 64 байта → BUTTON_DATA_INVALID → вопросник
   * замерзал. Имя читается в handler из session.profile.tops[idx]. По кнопке в
   * строке (.row()) — иначе >8 топов ломают раскладку.
   */
  function buildQnOwnerKeyboard(tops: { name: string }[]): InlineKeyboard {
    const kb = new InlineKeyboard();
    tops.forEach((top, i) => {
      kb.text(top.name, `f0q_owner:${i}`).row();
    });
    return kb;
  }

  /** Повтор текущего вопроса вопросника (для /resume). */
  async function replayCurrentQnQuestion(ctx: Context, session: F0Session): Promise<void> {
    const stage = session.qnStage ?? 'obj_collect';
    const objectives = session.qnObjectives ?? [];
    if (stage === 'obj_collect') {
      await ctx
        .reply(QN_B1_3_TEXT, {
          reply_markup: new InlineKeyboard().text('✅ Готово', 'f0q_obj_done'),
        })
        .catch(() => {});
    } else if (stage === 'b2_kr') {
      const objIdx = session.qnObjIdx ?? 0;
      const objTitle = objectives[objIdx] ?? `Направление ${objIdx + 1}`;
      const krStep = session.qnKrStep ?? 'text';
      if (krStep === 'text') {
        await ctx.reply(qnB2_1Text(objTitle)).catch(() => {});
      } else {
        // owner
        const tops = session.profile?.tops ?? [];
        if (tops.length === 0) {
          await ctx.reply(`Кто отвечает за результат по направлению «${objTitle}»? Введи имя текстом.`).catch(() => {});
        } else {
          await ctx
            .reply(qnB2_2Text(objTitle), { reply_markup: buildQnOwnerKeyboard(tops) })
            .catch(() => {});
        }
      }
    } else {
      // hypo_collect
      const hypoStep = session.qnHypoStep ?? 'statement';
      const hypoIdx = session.qnHypotheses?.length ?? 0;
      if (hypoStep === 'statement') {
        await ctx
          .reply(QN_B5_1_TEXT, {
            reply_markup: new InlineKeyboard().text('✅ Готово', 'f0q_hypo_done'),
          })
          .catch(() => {});
      } else {
        const stmt = (session.qnHypotheses ?? [])[hypoIdx - 1]?.statement ?? `Гипотеза ${hypoIdx}`;
        await ctx
          .reply(`Гипотеза: «${truncateEllipsis(stmt, 60)}»\n${QN_B5_2_TEXT}`)
          .catch(() => {});
      }
    }
  }

  /** Основной state machine вопросника — обрабатывает текстовый (или voice→text) ответ. */
  async function handleQnAnswer(ctx: Context, session: F0Session, text: string): Promise<void> {
    const chatId = ctx.chat!.id;
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      await ctx.reply('Пустой ответ. Впиши значение или пропусти: /skip.').catch(() => {});
      return;
    }
    const stage = session.qnStage ?? 'obj_collect';

    if (stage === 'obj_collect') {
      const objectives = session.qnObjectives ?? [];
      objectives.push(trimmed);
      session.qnObjectives = objectives;
      await saveF0Session(chatId, session);
      f0Log.info(
        { step: 'f0.qn.obj_added', chatId, sessionId: session.id, count: objectives.length },
        'f0 qn objective added',
      );
      if (objectives.length >= 5) {
        // Автопереход при 5 направлениях
        await ctx.reply(`✅ Добавлено: «${trimmed}». Максимум 5 направлений собран.`).catch(() => {});
        await startQnB2Kr(ctx, session);
      } else {
        await ctx
          .reply(`✅ Добавлено: «${trimmed}» (${objectives.length}). Добавь ещё или нажми ✅ Готово.`, {
            reply_markup: new InlineKeyboard().text('✅ Готово', 'f0q_obj_done'),
          })
          .catch(() => {});
      }
      return;
    }

    if (stage === 'b2_kr') {
      const krStep = session.qnKrStep ?? 'text';
      const objectives = session.qnObjectives ?? [];
      const objIdx = session.qnObjIdx ?? 0;
      const objTitle = objectives[objIdx] ?? `Направление ${objIdx + 1}`;

      if (krStep === 'text') {
        // B2.1: формулировка KR — мягкая числовая валидация (W6).
        if (!looksNumericAnswer(trimmed) && session.qnRetryKrIdx !== objIdx) {
          session.qnRetryKrIdx = objIdx;
          await saveF0Session(chatId, session);
          await ctx
            .reply(
              '🔁 Не вижу числа в ответе, а KR «с X до Y» нужна цифра (например «Выручка с 5 до 10 млн к 31.12»).\n' +
                'Если так и надо — отправь ещё раз, приму как есть. Или пропусти: /skip.',
            )
            .catch(() => {});
          return;
        }
        // Принять формулировку KR, перейти к B2.2 (owner).
        const krData = session.qnKrData ?? [];
        krData[objIdx] = { formulation: trimmed, owner: null };
        session.qnKrData = krData;
        session.qnKrStep = 'owner';
        session.qnRetryKrIdx = undefined;
        await saveF0Session(chatId, session);
        f0Log.info(
          { step: 'f0.qn.kr_text', chatId, sessionId: session.id, objIdx },
          'f0 qn kr formulation saved',
        );
        // Предложить выбор ответственного
        const tops = session.profile?.tops ?? [];
        if (tops.length === 0) {
          await ctx.reply(`Кто отвечает за результат по направлению «${objTitle}»? Введи имя текстом.`).catch(() => {});
        } else {
          await ctx
            .reply(qnB2_2Text(objTitle), { reply_markup: buildQnOwnerKeyboard(tops) })
            .catch(() => {});
        }
        return;
      }

      if (krStep === 'owner') {
        // Fallback текстового ввода ответственного (если топов нет).
        const krData = session.qnKrData ?? [];
        const existing = krData[objIdx] ?? { formulation: '', owner: null };
        existing.owner = trimmed;
        krData[objIdx] = existing;
        session.qnKrData = krData;
        await saveF0Session(chatId, session);
        await advanceQnB2Kr(ctx, session);
        return;
      }
    }

    if (stage === 'hypo_collect') {
      const hypoStep = session.qnHypoStep ?? 'statement';
      const hypotheses = session.qnHypotheses ?? [];

      if (hypoStep === 'statement') {
        hypotheses.push({ statement: trimmed, metric: null });
        session.qnHypotheses = hypotheses;
        session.qnHypoStep = 'metric';
        await saveF0Session(chatId, session);
        f0Log.info(
          { step: 'f0.qn.hypo_stmt', chatId, sessionId: session.id, count: hypotheses.length },
          'f0 qn hypothesis statement saved',
        );
        await ctx
          .reply(`Гипотеза: «${truncateEllipsis(trimmed, 60)}»\n${QN_B5_2_TEXT}`)
          .catch(() => {});
        return;
      }

      if (hypoStep === 'metric') {
        const lastHypo = hypotheses[hypotheses.length - 1];
        if (lastHypo !== undefined) {
          lastHypo.metric = trimmed;
        }
        session.qnHypotheses = hypotheses;
        session.qnHypoStep = 'statement';
        await saveF0Session(chatId, session);
        f0Log.info(
          { step: 'f0.qn.hypo_metric', chatId, sessionId: session.id, count: hypotheses.length },
          'f0 qn hypothesis metric saved',
        );
        await ctx
          .reply(`✅ Гипотеза ${hypotheses.length} сохранена. Добавь ещё или нажми ✅ Готово.`, {
            reply_markup: new InlineKeyboard().text('✅ Готово', 'f0q_hypo_done'),
          })
          .catch(() => {});
        return;
      }
    }
  }

  /** Переход от сбора направлений к B2.1 первого направления. */
  async function startQnB2Kr(ctx: Context, session: F0Session): Promise<void> {
    const chatId = ctx.chat!.id;
    const objectives = session.qnObjectives ?? [];
    session.qnStage = 'b2_kr';
    session.qnObjIdx = 0;
    session.qnKrStep = 'text';
    session.qnRetryKrIdx = undefined;
    await saveF0Session(chatId, session);
    const objTitle = objectives[0] ?? 'Направление 1';
    await ctx.reply(qnB2_1Text(objTitle)).catch(() => {});
  }

  /** Продвинуться к следующему objective или перейти к hypo_collect. */
  async function advanceQnB2Kr(ctx: Context, session: F0Session): Promise<void> {
    const chatId = ctx.chat!.id;
    const objectives = session.qnObjectives ?? [];
    const nextIdx = (session.qnObjIdx ?? 0) + 1;
    if (nextIdx < objectives.length) {
      session.qnObjIdx = nextIdx;
      session.qnKrStep = 'text';
      await saveF0Session(chatId, session);
      const objTitle = objectives[nextIdx] ?? `Направление ${nextIdx + 1}`;
      await ctx.reply(qnB2_1Text(objTitle)).catch(() => {});
    } else {
      // Все KR собраны — переходим к гипотезам.
      session.qnStage = 'hypo_collect';
      session.qnHypoStep = 'statement';
      await saveF0Session(chatId, session);
      await ctx
        .reply(`📋 KR по всем направлениям собраны.\n\n${QN_B5_1_TEXT}`, {
          reply_markup: new InlineKeyboard().text('✅ Готово', 'f0q_hypo_done'),
        })
        .catch(() => {});
    }
  }

  // ─── Callbacks вопросника ─────────────────────────────────────────────────

  /** f0q_obj_done: трекер нажал «✅ Готово» после сбора направлений. */
  bot.callbackQuery('f0q_obj_done', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const session = await getOrRestoreF0Session(chatId);
    if (session?.phase !== 'questionnaire' || session.qnStage !== 'obj_collect') {
      // Ревью эпика 9: query уже отвечен выше — второй answerCallbackQuery молча
      // падает; протухшую кнопку показываем сообщением в чате.
      await ctx.reply(F0_STALE_BUTTON_TEXT).catch(() => {});
      return;
    }
    const objectives = session.qnObjectives ?? [];
    if (objectives.length === 0) {
      await ctx
        .reply('ℹ️ Нужно хотя бы одно направление. Назови первое направление — добавлю.')
        .catch(() => {});
      return;
    }
    await startQnB2Kr(ctx, session);
  });

  /** f0q_owner:{idx}: трекер выбрал ответственного кнопкой из топов (имя — из профиля). */
  bot.callbackQuery(/^f0q_owner:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const session = await getOrRestoreF0Session(chatId);
    if (session?.phase !== 'questionnaire' || session.qnStage !== 'b2_kr' || session.qnKrStep !== 'owner') {
      // Ревью эпика 9: протухшая кнопка → видимый ответ, а не молчание.
      await ctx.reply(F0_STALE_BUTTON_TEXT).catch(() => {});
      return;
    }
    // Ревью эпика 9: имя из профиля по индексу (в callback_data имени больше нет).
    const ownerIdx = Number(ctx.match[1]);
    const ownerName = session.profile?.tops?.[ownerIdx]?.name;
    if (ownerName === undefined) {
      await ctx.reply(F0_STALE_BUTTON_TEXT).catch(() => {});
      return;
    }
    const objIdx = session.qnObjIdx ?? 0;
    const krData = session.qnKrData ?? [];
    const existing = krData[objIdx] ?? { formulation: '', owner: null };
    existing.owner = ownerName;
    krData[objIdx] = existing;
    session.qnKrData = krData;
    await advanceQnB2Kr(ctx, session);
  });

  /** f0q_hypo_done: трекер нажал «✅ Готово» после сбора гипотез → buildQnDraft → deliverF0Draft. */
  bot.callbackQuery('f0q_hypo_done', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const session = await getOrRestoreF0Session(chatId);
    if (session?.phase !== 'questionnaire' || session.qnStage !== 'hypo_collect') {
      // Ревью эпика 9: query уже отвечен выше — протухшую кнопку показываем в чате.
      await ctx.reply(F0_STALE_BUTTON_TEXT).catch(() => {});
      return;
    }
    // Если metric-шаг активен и гипотез > 0, сохраняем metric=null (как /skip).
    if (session.qnHypoStep === 'metric') {
      // metric остаётся null — гипотеза уйдёт в 🔴
      session.qnHypoStep = 'statement';
    }
    const result = buildQnDraft(session);
    const sourceNames = ['вопросник'];
    session.mode = 'synthesis'; // для логики deliverF0Draft
    await deliverF0Draft({
      ctx,
      chatId,
      session,
      result,
      sourceNames,
      sendFirst: async (text) => {
        try {
          await ctx.reply(text);
          return true;
        } catch {
          return false;
        }
      },
    });
  });

  /** Запуск онбординга с защитой от молчаливого сброса активной сессии (W3). */
  async function startF0SessionGuarded(ctx: Context, trigger: string): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const session = await getOrRestoreF0Session(chatId);
    if (f0SessionAtRisk(session)) {
      const company = session.draft?.extraction.company ?? session.profile?.companyName;
      const progress =
        session.phase === 'profile'
          ? `профиль: отвечено ${session.profileQIndex ?? 0} вопр.` // Story 9.1
          : session.phase === 'filling'
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

  // Story 10.7: «❌ Отменить онбординг» из предупреждения при залипшей сессии.
  bot.callbackQuery(/^f0_cancel_stuck:(.+)$/, async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const session = await getOrRestoreF0Session(chatId);
    if (session?.id === ctx.match[1]!) {
      await ctx.answerCallbackQuery().catch(() => {});
      f0Sessions.delete(chatId);
      await deleteF0Session(chatId).catch((err: unknown) => {
        log.warn({ err, chatId }, 'f0_cancel_stuck: deleteF0Session failed');
      });
      await ctx
        .reply('✅ Онбординг отменён. Новый — /newclient или меню /start.')
        .catch(() => {});
    } else {
      await ctx
        .answerCallbackQuery({ text: 'Эта кнопка устарела — онбординг уже изменился.' })
        .catch(() => {});
    }
  });

  bot.callbackQuery('f0_cancel_stuck_no', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
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

  // Story 9.3: прямая активация клиента из /start меню без показа client card.
  bot.callbackQuery(/^start_client:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const clientId = ctx.match[1]!;
    // Ревью эпика 9: дождаться записи и НЕ подтверждать при сбое — иначе следующий
    // /report без аргумента молча уйдёт в geonline-fallback (чужая таблица).
    const activeSaved = await setActiveClient(chatId, clientId);
    if (!activeSaved) {
      await ctx
        .reply('⚠️ Не удалось сохранить выбор клиента — нажми кнопку ещё раз.')
        .catch(() => {});
      return;
    }
    const name = (await getClientName(clientId)) ?? clientId;
    const sheetId = await getClientSheetId(clientId);
    const card = await loadClientCard(clientId);
    // D13: трекер сразу видит, какая сейчас неделя и сколько встреч по ней обработано.
    const nowDate = now();
    const { week: currentWeek } = getISOWeekAndYear(nowDate.toISOString().slice(0, 10));
    const currentWeekCount = await loadWeekReports(clientId, { now: nowDate })
      .then((r) => r.length)
      .catch(() => null);
    const weekLine =
      currentWeekCount === null
        ? ''
        : `\n📆 Сейчас неделя ${currentWeek} · встреч обработано за неделю: ${currentWeekCount}`;
    const kb = new InlineKeyboard();
    if (sheetId !== undefined) {
      kb.url('📁 Таблица', `https://docs.google.com/spreadsheets/d/${sheetId}`);
    }
    if (card !== null) {
      kb.row().text('➕ Дозаполнить профиль', `profile_fill:${clientId}`);
    }
    kb.row().text('📅 Недельные отчёты', `weekly:${clientId}`);
    kb.row().text('🧪 Трекер гипотез', `hypo_tracker:${clientId}`);
    await ctx
      .reply(
        `👤 Клиент: ${name}.${weekLine}\n📊 /report <ссылка> — отчёт по встрече\n📋 /status — готовность к неделе`,
        { reply_markup: kb },
      )
      .catch(() => {});
    log.info({ step: 'bot.start_client.selected', chatId, clientId }, 'start_client selected');
  });

  // Story 9.7 + D12: недельные отчёты — сначала меню доступных недель, затем отчёт за выбранную.
  async function sendWeeklyMenu(ctx: Context, clientId: string): Promise<void> {
    const name = (await getClientName(clientId)) ?? clientId;
    const nowDate = now();
    const current = getISOWeekAndYear(nowDate.toISOString().slice(0, 10));
    const all = await loadAllReports(clientId).catch((err: unknown) => {
      log.warn({ err, clientId }, 'weekly.load_failed');
      return null;
    });
    if (all === null) {
      await ctx.reply('Не удалось загрузить данные по встречам.').catch(() => {});
      return;
    }
    const groups = groupReportsByWeek(all);
    const external = await loadExternalReports(clientId);
    const currentCount =
      groups.find((g) => g.week === current.week && g.year === current.year)?.reports.length ?? 0;
    const lines = [
      `📅 Недельные отчёты — ${name}`,
      `Сейчас неделя ${current.week} · встреч обработано за неделю: ${currentCount}`,
    ];
    const kb = new InlineKeyboard();
    // D12b: недели бота (callback) + внешние готовые отчёты (url) — единый список по убыванию.
    const entries = [
      ...groups.map((g) => ({ week: g.week, year: g.year, group: g, ext: undefined as undefined | { url: string; title?: string } })),
      ...external.weekly.map((e) => ({ week: e.week, year: e.year, group: undefined, ext: e })),
    ].sort((a, b) => b.year - a.year || b.week - a.week);
    if (entries.length === 0) {
      lines.push('', 'Обработанных встреч пока нет — пришли запись или транскрипт встречи.');
    } else {
      lines.push('', 'Выбери неделю:');
      for (const e of entries.slice(0, 12)) {
        if (e.group !== undefined) {
          kb.text(
            `Неделя ${e.week} · встреч: ${e.group.reports.length}`,
            `weekly_wk:${clientId}:${e.year}:${e.week}`,
          ).row();
        } else if (e.ext !== undefined) {
          kb.url(e.ext.title ?? `Неделя ${e.week} · отчёт трекера ↗`, e.ext.url).row();
        }
      }
    }
    await ctx.reply(lines.join('\n'), { reply_markup: kb }).catch(() => {});
    log.info(
      { step: 'bot.weekly.menu', clientId, weeks: groups.length, external: external.weekly.length, currentCount },
      'weekly menu sent',
    );
  }

  bot.callbackQuery(/^weekly:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await sendWeeklyMenu(ctx, ctx.match[1]!);
  });

  bot.callbackQuery(/^weekly_wk:([^:]+):(\d{4}):(\d{1,2})$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const clientId = ctx.match[1]!;
    const year = Number(ctx.match[2]!);
    const week = Number(ctx.match[3]!);
    const name = (await getClientName(clientId)) ?? clientId;
    const sheetId = await getClientSheetId(clientId);
    const all = await loadAllReports(clientId).catch((err: unknown) => {
      log.warn({ err, clientId }, 'weekly.load_failed');
      return null;
    });
    if (all === null) {
      await ctx.reply('Не удалось загрузить данные за неделю.').catch(() => {});
      return;
    }
    const reports =
      groupReportsByWeek(all).find((g) => g.week === week && g.year === year)?.reports ?? [];
    const kb = new InlineKeyboard();
    if (sheetId !== undefined) {
      kb.url('📁 Таблица', `https://docs.google.com/spreadsheets/d/${sheetId}`);
    }
    // D14: полный отчёт (обязательства + алерты всех встреч) — вложением; в чат — сводка.
    if (reports.length > 0) {
      const full = formatWeeklyReport(reports, name, week, year);
      await ctx
        .replyWithDocument(
          new InputFile(Buffer.from(full, 'utf8'), `weekly-${clientId}-w${week}-${year}.md`),
          { caption: `Полный недельный отчёт · нед. ${week}/${year}` },
        )
        .catch(() => {});
    }
    for (const msg of splitForTelegram(formatWeeklyCompact(reports, name, week, year))) {
      await ctx.reply(msg, { reply_markup: kb }).catch(() => {});
    }
    log.info(
      { step: 'bot.weekly.sent', clientId, week, year, count: reports.length },
      'weekly report sent',
    );
  });

  // D8: слэш-команда — паритет с кнопкой «Недельные отчёты».
  bot.command('weekly', async (ctx) => {
    const chatId = ctx.chat.id;
    if (!trackerChatIds.has(chatId)) return;
    const clientId = await getActiveClient(chatId);
    if (clientId === undefined) {
      await ctx.reply('ℹ️ Сначала выбери клиента: /start.').catch(() => {});
      return;
    }
    await sendWeeklyMenu(ctx, clientId);
  });

  // Story 10.5 / 10.8: трекер гипотез — третий тип отчёта.
  // D9: защита от повторного запуска (вызов Claude ~70 с) + мгновенная квитанция прогресса.
  // D12: кнопка открывает меню — сохранённые отчёты по неделям + «собрать новый».
  const hypoTrackerInFlight = new Set<string>();

  bot.callbackQuery(/^hypo_tracker:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const clientId = ctx.match[1]!;
    const name = (await getClientName(clientId)) ?? clientId;
    const saved = await listHypoReports(clientId).catch((err: unknown) => {
      log.warn({ err, clientId }, 'hypo_history.list_failed');
      return [];
    });
    const external = await loadExternalReports(clientId);
    const lines = [`🧪 Трекер гипотез — ${name}`];
    const kb = new InlineKeyboard();
    if (saved.length === 0 && external.hypo.length === 0) {
      lines.push('Сохранённых отчётов пока нет.');
    } else {
      lines.push('Сохранённые отчёты:');
      for (const item of saved.slice(0, 8)) {
        const d = item.generatedAt.slice(0, 10).split('-').reverse().slice(0, 2).join('.');
        kb.text(`Неделя ${item.week} · от ${d}`, `hypo_view:${clientId}:${item.id}`).row();
      }
      // D12b: готовые трекеры гипотез (внешние Google Docs) — url-кнопками, свежие сверху.
      for (const e of [...external.hypo].sort((a, b) => b.year - a.year || b.week - a.week).slice(0, 8)) {
        kb.url(e.title ?? `Неделя ${e.week} · трекер ↗`, e.url).row();
      }
    }
    kb.text('➕ Собрать новый (1-2 мин)', `hypo_run:${clientId}`).row();
    await ctx.reply(lines.join('\n'), { reply_markup: kb }).catch(() => {});
    log.info(
      { step: 'bot.hypo_tracker.menu', clientId, saved: saved.length, external: external.hypo.length },
      'hypo menu sent',
    );
  });

  bot.callbackQuery(/^hypo_view:([^:]+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const clientId = ctx.match[1]!;
    const id = ctx.match[2]!;
    const entry = await loadHypoReport(clientId, id);
    if (entry === null) {
      await ctx.reply('ℹ️ Этот отчёт не найден (возможно, удалён).').catch(() => {});
      return;
    }
    if (entry.full) {
      await ctx
        .replyWithDocument(
          new InputFile(Buffer.from(entry.full, 'utf8'), `hypo-tracker-${clientId}-w${entry.week}.md`),
          { caption: `Полный трекер гипотез · неделя ${entry.week} · ${entry.generatedAt.slice(0, 10)}` },
        )
        .catch(() => {});
    }
    for (const msg of splitForTelegram(entry.compact)) {
      await ctx.reply(msg).catch(() => {});
    }
    log.info({ step: 'bot.hypo_tracker.view', clientId, id }, 'saved hypo report sent');
  });

  bot.callbackQuery(/^hypo_run:(.+)$/, async (ctx) => {
    const clientId = ctx.match[1]!;
    if (hypoTrackerInFlight.has(clientId)) {
      await ctx
        .answerCallbackQuery({ text: 'Трекер уже собирается, подожди…' })
        .catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    hypoTrackerInFlight.add(clientId);
    const name = (await getClientName(clientId)) ?? clientId;
    const sheetId = await getClientSheetId(clientId).catch(() => undefined);
    const runDate = now();
    const { week, year } = getISOWeekAndYear(runDate.toISOString().slice(0, 10));
    await ctx.reply('⏳ Собираю трекер гипотез — это займёт 1-2 минуты…').catch(() => {});
    await ctx.replyWithChatAction('typing').catch(() => {});
    let result: { compact: string; full: string } | null = null;
    try {
      result = await runHypoTracker({ clientId, clientName: name });
    } catch (err) {
      log.warn({ step: 'bot.hypo_tracker.error', clientId, err }, 'hypo_tracker failed');
    } finally {
      hypoTrackerInFlight.delete(clientId);
    }
    if (result === null) {
      await ctx.reply('Не удалось загрузить трекер гипотез.').catch(() => {});
      return;
    }
    // D12: сохраняем прогон — он появится в меню трекера как отчёт этой недели.
    await saveHypoReport(clientId, {
      week,
      year,
      generatedAt: runDate.toISOString(),
      compact: result.compact,
      full: result.full,
    }).catch((err: unknown) => {
      log.warn({ err, clientId }, 'hypo_history.save_failed');
    });
    const kb = new InlineKeyboard();
    if (sheetId !== undefined) {
      kb.url('📁 Таблица', `https://docs.google.com/spreadsheets/d/${sheetId}`);
    }
    if (result.full) {
      await ctx
        .replyWithDocument(
          new InputFile(Buffer.from(result.full, 'utf8'), `hypo-tracker-${clientId}-w${week}.md`),
          { caption: 'Полный трекер гипотез' },
        )
        .catch(() => {});
    }
    for (const msg of splitForTelegram(result.compact)) {
      await ctx.reply(msg, { reply_markup: kb }).catch(() => {});
    }
    log.info({ step: 'bot.hypo_tracker.sent', clientId, clientName: name, week }, 'hypo_tracker report sent');
  });

  // W10: статус любого клиента из карточки — не только активной сессии.
  bot.callbackQuery(/^client:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const clientId = ctx.match[1]!;
    const card = await loadClientCard(clientId);
    const kb = new InlineKeyboard().text('✅ Работать с этим клиентом', `client_use:${clientId}`);
    // Story 9.1: расширенный профиль доступен и позже — из карточки клиента.
    if (card !== null) kb.row().text('➕ Дозаполнить профиль', `profile_fill:${clientId}`);
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
    const activeSaved = await setActiveClient(chatId, clientId);
    if (!activeSaved) {
      await ctx
        .reply('⚠️ Не удалось сохранить выбор клиента — нажми кнопку ещё раз.')
        .catch(() => {});
      return;
    }
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
        // Story 9.4: при import_unmappable повторно показываем 3-кнопочный экран.
        await ctx
          .reply(
            F0_REPLY_BY_CODE[err.code],
            err.code === 'import_unmappable' ? { reply_markup: f0StrategyKeyboard } : undefined,
          )
          .catch(() => {});
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

    // D7: вход файла всегда виден в логах — тихий сбой был неотличим от «файл не дошёл».
    log.info(
      {
        step: 'bot.document.received',
        chatId,
        fileName: ctx.message.document.file_name,
        mimeType: ctx.message.document.mime_type,
        fileSize: ctx.message.document.file_size,
      },
      'document received',
    );

    // Story 11.7 + D7: text transcript → F1 routing (before F0 session check).
    if (trackerChatIds.has(chatId) && isTranscriptCandidateType(ctx.message.document.file_name, ctx.message.document.mime_type)) {
      const transcriptClientId = await getActiveClient(chatId);
      if (transcriptClientId !== undefined && !(ctx.message.document.file_size !== undefined && ctx.message.document.file_size > F0_MAX_FILE_BYTES)) {
        try {
          const transcriptFile = await ctx.getFile();
          if (transcriptFile.file_path !== undefined) {
            const transcriptBuf = await downloadTelegramFile(transcriptFile.file_path);
            const transcriptExtracted = await extractTextFromDocument(transcriptBuf, ctx.message.document.file_name, ctx.message.document.mime_type);
            let routeAsTranscript = isTranscriptDocument(transcriptExtracted.text);
            let routedBy = 'detector';
            if (!routeAsTranscript) {
              // D7 fallback: если онбординг файлы сейчас не ждёт (нет сессии либо фаза не приёма
              // документов), текстовый файл при активном клиенте почти наверняка = транскрипт
              // встречи. Раньше он падал в тупик «Черновик уже собран…».
              const f0Probe = await getOrRestoreF0Session(chatId);
              const f0AcceptsDocs =
                f0Probe !== undefined && (f0Probe.phase === 'collecting' || f0Probe.phase === 'profile');
              if (!f0AcceptsDocs) {
                routeAsTranscript = true;
                routedBy = 'fallback_no_f0';
              }
            }
            if (routeAsTranscript) {
              log.info(
                { step: 'bot.document.transcript_route', chatId, clientId: transcriptClientId, routedBy },
                'document routed to F1 as transcript',
              );
              await handleMeetingTextTranscript(ctx, chatId, transcriptClientId, transcriptExtracted.text, transcriptExtracted.sourceName);
              return;
            }
          }
        } catch (err) {
          log.warn(
            { step: 'bot.document.transcript_probe_failed', chatId, err },
            'transcript probe failed — falling through to F0 flow',
          );
        }
      }
    }

    const session = await getOrRestoreF0Session(chatId);
    if (session === undefined) {
      await ctx.reply(F0_NO_SESSION_TEXT).catch(() => {});
      return;
    }
    if (session.processing) {
      await ctx.reply(F0_BUSY_TEXT).catch(() => {});
      return;
    }
    // Story 9.1: в фазе профиля документы стратегии не принимаются (AC1). Исключение —
    // A3.1 «оргструктура файлом»: сохраняем референс (имя файла), содержимое не парсим.
    // Story 11.8: A3.2 batch document intake — document at a3_2 extracts full team list.
    if (session.phase === 'profile') {
      const q = currentProfileQuestion(session);
      if (q?.id === 'a3_2' && !profileOfferPending(session)) {
        await handleProfileA3BatchDocument(ctx, chatId, session);
        return;
      }
      if (q?.id === 'a3_1' && !profileOfferPending(session)) {
        const fileName = ctx.message.document.file_name ?? 'document';
        session.profile ??= {};
        session.profile.orgStructure = `📎 ${fileName}`;
        await ctx
          .reply(`📎 Сохранил референс оргструктуры: ${fileName} (содержимое файла не разбираю).`)
          .catch(() => {});
        await advanceProfileQuestion(ctx, session, q, 'answered');
        return;
      }
      await ctx.reply(F0_PROFILE_FIRST_TEXT).catch(() => {});
      return;
    }
    // Story 9.5: в фазе вопросника файлы не принимаются — направляем к голосу/тексту.
    if (session.phase === 'questionnaire') {
      await ctx
        .reply('ℹ️ Идёт вопросник — отвечай текстом или голосом 🎤.')
        .catch(() => {});
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
    // Story 9.1: до завершения 🔑-минимума профиля черновик не собирается.
    if (session.phase === 'profile') {
      await ctx
        .reply('ℹ️ Сначала профиль клиента — продолжить вопросы: /resume.')
        .catch(() => {});
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
        profileParticipants: session.profile?.tops?.length
          ? profileTopsContext(session.profile.tops)
          : '',
        isPresentationOnly:
          session.documents.length === 1 &&
          session.documents[0]?.sourceName.toLowerCase().endsWith('.pptx') === true,
      });

      // Story 10.3: перед deliverF0Draft — проверка смешения клиентов (synthesis path only).
      const mismatch = detectCompanyMismatch(result.extraction.company, session.profile?.companyName);
      if (mismatch !== null) {
        await finishProgress('🧠 Черновик собран.');
        session.pendingMismatchDraft = result;
        session.companyMismatchPending = true;
        await ctx.reply(
          `🔴 Документы про «${mismatch.extracted}», клиент — «${mismatch.profile}». Чьи данные берём?`,
          { reply_markup: { inline_keyboard: [[
              { text: '✅ Это правильные документы', callback_data: 'cmi_proceed' },
              { text: '🔄 Загружу другие', callback_data: 'cmi_cancel' },
          ]] } }
        ).catch(() => {});
        return;
      }

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
      } else if (err instanceof F1PipelineError && err.code === 'claude_api') {
        f0Log.error({ err, step: 'f0.draft_failed', chatId }, 'f0 draft failed');
        alertOps({
          pipeline: 'F0',
          step: 'f0.draft_failed',
          error: err,
          context: { chatId, sessionId: session.id, files: sourceNames.length },
        });
        const kind = classifyClaudeApiError(err);
        let userMsg: string;
        if (kind === 'billing') {
          userMsg = '⚠️ Сервис временно недоступен — закончились кредиты API. Напиши администратору.';
        } else if (kind === 'rate_limit') {
          userMsg = '⚠️ AI временно перегружен, повтори запрос через несколько минут.';
        } else if (kind === 'too_large_context' && sourceNames.length > 1) {
          userMsg = '⚠️ Не удалось собрать черновик. Убери лишние файлы и собери снова: /draft.';
        } else if (kind === 'too_large_context' && sourceNames.length === 1) {
          userMsg = '⚠️ Не удалось собрать черновик — документ слишком большой. Попробуй уменьшить или разбить файл.';
        } else {
          userMsg = '⚠️ Не удалось собрать черновик. Повтори позже или напиши администратору.';
        }
        await finishProgress(userMsg);
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

  // Story 10.3: трекер подтверждает, что документы правильные — доставляем сохранённый черновик.
  bot.callbackQuery('cmi_proceed', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const session = await getOrRestoreF0Session(chatId);
    if (session === undefined || !session.companyMismatchPending || session.pendingMismatchDraft === undefined) {
      await ctx.reply('ℹ️ Эта кнопка от прошлого онбординга. Актуальное состояние: /status.').catch(() => {});
      return;
    }
    const result = session.pendingMismatchDraft;
    const sourceNames = session.documents.map((d) => d.sourceName);
    session.companyMismatchPending = false;
    session.pendingMismatchDraft = undefined;
    try {
      await deliverF0Draft({
        ctx,
        chatId,
        session,
        result,
        sourceNames,
        sendFirst: async (text) => { await ctx.reply(text).catch(() => {}); return true; },
      });
    } catch (err) {
      f0Log.error({ err, step: 'cmi_proceed.deliver_failed', chatId }, 'cmi_proceed draft delivery failed');
      await ctx.reply('⚠️ Не удалось доставить черновик. Попробуй /draft заново.').catch(() => {});
    }
  });

  // Story 10.3: трекер хочет загрузить другие документы — отменяем ожидание.
  bot.callbackQuery('cmi_cancel', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const session = await getOrRestoreF0Session(chatId);
    if (session === undefined || !session.companyMismatchPending) {
      await ctx.reply('ℹ️ Эта кнопка от прошлого онбординга.').catch(() => {});
      return;
    }
    session.companyMismatchPending = false;
    session.pendingMismatchDraft = undefined;
    await ctx.reply('↩️ Отменено. Пакет документов цел — загрузи нужные файлы и собери снова: /draft.').catch(() => {});
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
        profileParticipants: session.profile?.tops?.length
          ? profileTopsContext(session.profile.tops)
          : '',
        isPresentationOnly: false, // гипотезы синтезируются из текста Excel, не из презентации
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
    // Story 9.1: /skip в диалоге профиля — 🔑 нельзя пропустить (пояснение + повтор),
    // расширенный вопрос пропускается без заполнения поля.
    if (session?.phase === 'profile') {
      if (profileOfferPending(session)) {
        await sendProfileOffer(ctx, session);
        return;
      }
      const q = currentProfileQuestion(session);
      if (q === undefined) {
        await finishProfileDialog(ctx, session);
        return;
      }
      if (q.key) {
        const topsHint =
          q.id === 'a3_2' && (session.profile?.tops ?? []).length > 0
            ? ' Закончить с участниками — кнопка «✅ Готово».'
            : '';
        await ctx.reply(`${F0_PROFILE_KEY_REQUIRED_TEXT}${topsHint}`).catch(() => {});
        await askNextProfileQuestion(ctx, session); // повтор того же вопроса
        return;
      }
      await advanceProfileQuestion(ctx, session, q, 'skipped');
      return;
    }
    // Story 9.5: /skip в диалоге вопросника.
    if (session?.phase === 'questionnaire') {
      const stage = session.qnStage ?? 'obj_collect';
      if (stage === 'obj_collect') {
        await ctx.reply('ℹ️ Направления (B1.3) — обязательный минимум, пропустить нельзя. Назови хотя бы одно.').catch(() => {});
        return;
      }
      if (stage === 'b2_kr') {
        const krStep = session.qnKrStep ?? 'text';
        const objIdx = session.qnObjIdx ?? 0;
        const chatId = ctx.chat.id;
        if (krStep === 'text') {
          // Ревью эпика 9: пропуск KR = направление БЕЗ KR, а не KR с текстом «/skip».
          // krData[objIdx] не заполняем — buildQnDraft для пустого индекса даёт krs: [].
          const krData = session.qnKrData ?? [];
          delete krData[objIdx];
          session.qnKrData = krData;
          session.qnRetryKrIdx = undefined;
          await saveF0Session(chatId, session);
          await advanceQnB2Kr(ctx, session);
        } else {
          // Пропуск owner
          const krData = session.qnKrData ?? [];
          const existing = krData[objIdx] ?? { formulation: '', owner: null };
          existing.owner = null;
          krData[objIdx] = existing;
          session.qnKrData = krData;
          await saveF0Session(chatId, session);
          await advanceQnB2Kr(ctx, session);
        }
        return;
      }
      if (stage === 'hypo_collect') {
        const chatId = ctx.chat.id;
        const hypoStep = session.qnHypoStep ?? 'statement';
        if (hypoStep === 'metric') {
          // Пропуск метрики: metric = null → 🔴
          const hypotheses = session.qnHypotheses ?? [];
          const lastHypo = hypotheses[hypotheses.length - 1];
          if (lastHypo !== undefined) lastHypo.metric = null;
          session.qnHypotheses = hypotheses;
          session.qnHypoStep = 'statement';
          await saveF0Session(chatId, session);
          await ctx
            .reply('⚠️ Метрика пропущена — гипотеза уйдёт в 🔴. Добавь ещё или нажми ✅ Готово.', {
              reply_markup: new InlineKeyboard().text('✅ Готово', 'f0q_hypo_done'),
            })
            .catch(() => {});
        } else {
          await ctx
            .reply('ℹ️ Гипотез нет или ты на шаге формулировки. Нажми ✅ Готово чтобы завершить.', {
              reply_markup: new InlineKeyboard().text('✅ Готово', 'f0q_hypo_done'),
            })
            .catch(() => {});
        }
        return;
      }
      return;
    }
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
    if (session.phase === 'profile') {
      // Story 9.1: возобновление диалога профиля с текущего вопроса (AC2).
      await ctx.reply('↩️ Продолжаем профиль клиента с места остановки.').catch(() => {});
      await askNextProfileQuestion(ctx, session);
    } else if (session.phase === 'questionnaire') {
      // Story 9.5: возобновление вопросника.
      await ctx.reply('↩️ Продолжаем вопросник.').catch(() => {});
      await replayCurrentQnQuestion(ctx, session);
    } else if (session.phase === 'filling') {
      await ctx.reply('↩️ Продолжаем онбординг с места остановки.').catch(() => {});
      await askNextF0Gap(ctx, session);
    } else if (session.phase === 'ready') {
      await ctx.reply('✅ Онбординг этого клиента уже завершён.').catch(() => {});
    } else {
      await ctx.reply('Онбординг на этапе сбора файлов — пришли документы или собери черновик: /draft.').catch(() => {});
    }
  });

  // Story 10.2: /advanced — запуск расширенного профиля.
  bot.command('advanced', async (ctx) => {
    const chatId = ctx.chat.id;
    if (!trackerChatIds.has(chatId)) return;
    const session = await getOrRestoreF0Session(chatId);

    if (session !== undefined) {
      if (session.phase === 'profile') {
        if (profileOfferPending(session)) {
          // Offer pending — начать расширенный профиль немедленно (≡ f0p_ext).
          session.profileExtended = true;
          await saveF0Session(chatId, session);
          await askNextProfileQuestion(ctx, session);
        } else if (session.profileExtended === true) {
          await ctx.reply('ℹ️ Профиль уже дополняется — продолжай отвечать на вопросы.').catch(() => {});
          await askNextProfileQuestion(ctx, session);
        } else {
          await ctx.reply('ℹ️ Сначала заверши минимум (название и суть), потом добавим участников.').catch(() => {});
          await askNextProfileQuestion(ctx, session);
        }
      } else {
        await ctx
          .reply('⚠️ Идёт онбординг на другом этапе. Заверши его (/confirm) или отмени (/cancel).')
          .catch(() => {});
      }
      return;
    }

    // Нет сессии — дозаполнение карточки активного клиента.
    const clientId = await getActiveClient(chatId);
    if (clientId === undefined) {
      await ctx
        .reply('ℹ️ Нет активного клиента. Выбери через /start или начни через /newclient.')
        .catch(() => {});
      return;
    }
    const card = await loadClientCard(clientId);
    if (card === null) {
      await ctx.reply(`ℹ️ Карточка клиента «${clientId}» не найдена. Начни онбординг: /newclient.`).catch(() => {});
      return;
    }
    const advSession: F0Session = {
      id: randomUUID().slice(0, 8),
      processing: false,
      phase: 'profile',
      documents: [],
      documentsChars: 0,
      gaps: [],
      gapIndex: 0,
      schedule: null,
      profile: { ...(card.profile ?? {}) },
      profileQIndex: PROFILE_MIN_COUNT, // только расширенные вопросы
      profileExtended: true,
      profileCardClientId: clientId,
    };
    f0Sessions.set(chatId, advSession);
    await saveF0Session(chatId, advSession);
    f0Log.info(
      { step: 'f0.profile_advanced_started', chatId, sessionId: advSession.id, clientId },
      'f0 /advanced profile fill started',
    );
    await ctx
      .reply(`➕ Дозаполняем профиль «${card.company}» — расширенные вопросы. Ответы пишутся в карточку.`)
      .catch(() => {});
    await askNextProfileQuestion(ctx, advSession);
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
      // Story 9.1: профиль клиента переносится в карточку.
      ...(session.profile !== undefined ? { profile: session.profile } : {}),
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
    krWarnings: number = 0,
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
        // Story 9.2: профиль → grounding имён в Sheets (tops → owner-сверка + личные листы).
        profile: session.profile,
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
          (result.counts.personalSheets > 0 ? ` · личные листы участников: ${result.counts.personalSheets}` : ''),
        // Story 7.6: слаг клиента нужен для /report <url> <clientId> — показываем явно.
        `ID клиента: ${clientId}  (для /report <ссылка> ${clientId})`,
      ];
      if (krWarnings > 0) {
        // Счётчик уже показан в /confirm (ревью эпика 9) — здесь только куда дозаполнять.
        lines.push(`📝 Незаполненные KR дозаполни прямо в таблице: ${result.spreadsheetUrl}`);
      }
      if (result.shared.length > 0) {
        lines.push(`Доступ выдан: ${result.shared.join(', ')}`);
      }
      // D11 (временное решение): таблица создаётся под OAuth администратора, автошаринг
      // на личные Google-аккаунты трекеров пока не настроен — просим написать администратору.
      lines.push(
        '🔑 Чтобы открыть таблицу под своим Google-аккаунтом — напиши Тимуру, он выдаст доступ вручную (временное решение).',
      );
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
    if (session.schedule !== null && session.schedule.length > 0) {
      readyLines.push(`🗓 Расписание встреч: ${session.schedule}`);
    }
    // Ревью эпика 9: предупреждение о недозаполненных KR — в самом /confirm-ответе,
    // а не только в success-ветке Sheets; иначе при сбое/отсутствии шаблона теряется.
    if (warnings.length > 0) {
      readyLines.push(`⚠️ ${warnings.length} KR стоит дозаполнить (база/цель/владелец).`);
    }
    await ctx.reply(readyLines.join('\n')).catch(() => {});

    // Story 7.4: создаём Google Sheets клиента по шаблону v2.0.
    await createSheetForSession(ctx, chatId, session, warnings.length);
  });

  // ───────── /status — чеклист готовности клиента к неделе 1 (Story 7.5) ─────────
  bot.command('status', async (ctx) => {
    const chatId = ctx.chat.id;
    const session = await getOrRestoreF0Session(chatId);
    // Story 9.1: в онбординге до черновика /status показывает собранный профиль.
    if (
      session !== undefined &&
      (session.phase === 'profile' ||
        (session.draft === undefined && session.profile !== undefined))
    ) {
      await ctx.reply(renderProfileStatusMessage(session.profile ?? {})).catch(() => {});
      return;
    }
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
        ...(session.profile !== undefined ? { profile: session.profile } : {}),
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
      log.info({ chatId: ctx.chat.id, reason }, 'bot.report.invalid_input');
      // Story 9.3: для missing_arg при активном клиенте — контекстная подсказка с именем.
      if (reason === 'missing_arg') {
        const active = await getActiveClient(ctx.chat.id);
        if (active !== undefined) {
          const activeName = (await getClientName(active)) ?? active;
          await ctx
            .reply(`Активный клиент: ${activeName}. /report https:// — отчёт по встрече · /help для меню.`)
            .catch(() => {});
          return;
        }
      }
      const text = formatErrorMessage(reason);
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

  // Story 9.6: post_detail — реальная ссылка на таблицу клиента.
  bot.callbackQuery(/^post_detail:(.+)$/, async (ctx) => {
    const jobId = ctx.match[1]!;
    const job = peekJob(jobId);
    if (!job) {
      await ctx.answerCallbackQuery({ text: 'ℹ️ Отчёт уже недоступен.' });
      return;
    }
    const sheetId = await getClientSheetId(job.clientId).catch(() => undefined);
    if (!sheetId || sheetId.length === 0) {
      await ctx.answerCallbackQuery();
      await ctx.reply('ℹ️ Таблица клиента не найдена.').catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(`🔗 Таблица клиента:\nhttps://docs.google.com/spreadsheets/d/${sheetId}/edit`).catch(() => {});
    log.info({ step: 'bot.post_detail.sent', jobId, clientId: job.clientId }, 'post_detail URL sent');
  });

  // ─── Story 9.5: голосовые сообщения ──────────────────────────────────────────

  /**
   * Скачать buf → записать tmp .oga → Soniox → транскрипт → удалить tmp.
   * Используется только в handler голоса; в тестах подменяется через transcribeVoiceBufferFn.
   */
  async function transcribeVoiceBuffer(buf: Buffer, chatId: number): Promise<string> {
    const tmpPath = pathJoin(tmpdir(), `voice-${Date.now()}-${chatId}.oga`);
    let uploadedFileId: string | undefined;
    try {
      await writeFile(tmpPath, buf);
      uploadedFileId = await sonioxClientResolved.uploadFile(tmpPath);
      const transcriptionId = await sonioxClientResolved.createTranscription(uploadedFileId);
      await sonioxClientResolved.pollUntilCompleted(transcriptionId);
      const transcript = await sonioxClientResolved.fetchTranscript(transcriptionId);
      return transcript.tokens.map((t) => t.text).join('');
    } finally {
      await unlink(tmpPath).catch(() => {});
      if (uploadedFileId !== undefined) {
        await sonioxClientResolved.deleteFile(uploadedFileId).catch(() => {});
      }
    }
  }

  /** Voice-confirm inline keyboard (3 кнопки подтверждения). */
  function buildVoiceConfirmKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text('✅ Ок', 'voice_ok')
      .text('✏️ Править', 'voice_edit')
      .text('🎤 Заново', 'voice_retry');
  }

  /** Принятые фазы для голоса в онбординге. */
  const VOICE_ONBOARDING_PHASES = new Set(['profile', 'questionnaire', 'filling']);

  bot.on('message:voice', async (ctx) => {
    const chatId = ctx.chat.id;
    if (!trackerChatIds.has(chatId)) return; // не трекер — игнорируем
    const session = await getOrRestoreF0Session(chatId);
    if (session === undefined || !VOICE_ONBOARDING_PHASES.has(session.phase)) {
      await ctx
        .reply('🎤 Голосовые сообщения принимаются только в диалоге онбординга.')
        .catch(() => {});
      return;
    }
    const voice = ctx.message.voice;
    if (voice.duration > 300) {
      await ctx.reply('⚠️ Голосовое сообщение слишком длинное — лимит 5 минут (300 сек).').catch(() => {});
      return;
    }
    if (session.processing) {
      await ctx.reply('⏳ Идёт обработка — подожди немного.').catch(() => {});
      return;
    }
    session.processing = true;
    let processingMsg: number | undefined;
    try {
      const sent = await ctx.reply('🎤 Распознаю…').catch(() => undefined);
      processingMsg = sent?.message_id;
      const file = await ctx.getFile();
      if (file.file_path === undefined) throw new Error('no file_path for voice');
      const buf = await downloadTelegramFile(file.file_path);
      const transcript = await transcribeVoiceBuffer(buf, chatId);
      session.voicePending = { transcript };
      await saveF0Session(chatId, session);
      f0Log.info(
        { step: 'f0.voice_transcribed', chatId, sessionId: session.id, phase: session.phase, len: transcript.length },
        'voice transcribed',
      );
      // Ревью эпика 9: длинный транскрипт (голос до 5 мин) > 4096 симв. ронял reply
      // (MESSAGE_TOO_LONG проглатывался) → кнопки подтверждения не приходили.
      // Режем на части, клавиатуру вешаем на последнюю.
      const confirmText = `🎤 Распознано:\n«${transcript}»\n\nПодтвердить?`;
      const parts = splitForTelegram(confirmText, TELEGRAM_SAFE_MARGIN, '🎤 Распознано (продолжение)');
      for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        await ctx
          .reply(parts[i]!, isLast ? { reply_markup: buildVoiceConfirmKeyboard() } : {})
          .catch(() => {});
      }
    } catch (err) {
      f0Log.error({ step: 'f0.voice_error', chatId, err }, 'voice transcription failed');
      // Ревью эпика 9: сбои голоса — в ops-канал (как все прочие транскрипции).
      alertOps({
        pipeline: 'F1',
        step: 'f0.voice_error',
        clientId: 'onboarding',
        error: err,
        context: { chatId, phase: session.phase },
      });
      await ctx.reply('🔴 Не удалось распознать голосовое сообщение. Попробуй ещё раз или введи текстом.').catch(() => {});
    } finally {
      session.processing = false;
      void processingMsg;
    }
  });

  // ───────── Story 11.8: batch photo intake at A3.2 ─────────

  bot.on('message:photo', async (ctx) => {
    const chatId = ctx.chat.id;
    if (!trackerChatIds.has(chatId)) return;
    const session = await getOrRestoreF0Session(chatId);
    if (session === undefined || session.phase !== 'profile') return; // не в онбординге
    const q = currentProfileQuestion(session);
    if (q?.id !== 'a3_2' || profileOfferPending(session)) {
      await ctx.reply(F0_PROFILE_FIRST_TEXT).catch(() => {});
      return;
    }
    await handleProfileA3BatchPhoto(ctx, chatId, session);
  });

  // ───────── Story 10.1: обработчик аудио/видео встречи существующего клиента ─────────

  async function handleMeetingFileIntake(ctx: Context, chatId: number): Promise<void> {
    if (!trackerChatIds.has(chatId)) return;

    // Pre-check overflow
    if (queue.size() >= queueMaxSize) {
      log.warn(
        { chatId, queueSize: queue.size(), maxSize: queueMaxSize },
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

    const clientId = await getActiveClient(chatId);
    if (clientId === undefined) {
      await ctx
        .reply('Выбери клиента через /start, прежде чем отправлять запись встречи.')
        .catch(() => {});
      return;
    }

    const topName =
      (await getClientTopName(clientId)) ??
      (await getClientName(clientId)) ??
      'Клиент';

    try {
      assertClientId(clientId);
    } catch (err) {
      log.error(
        { err, step: 'bot.audio.invalid_client_id', clientId },
        'invalid clientId — refusing to enqueue audio job',
      );
      alertOps({
        pipeline: 'F1',
        step: 'bot.audio.invalid_client_id',
        error: err,
        context: { clientId },
      });
      await ctx.reply(formatErrorMessage('pipeline_failed')).catch(() => {});
      return;
    }

    // Story 11.1: проверка размера файла до вызова ctx.getFile() — Telegram не отдаёт файлы >20 МБ.
    const MEETING_TOO_LARGE_TEXT =
      '⚠️ Запись больше 20 МБ — Telegram не отдаёт такие боту. Сожми запись или разбей на части.';
    const fileSize = (ctx.message?.audio ?? ctx.message?.video)?.file_size;
    if (fileSize !== undefined && fileSize > F0_MAX_FILE_BYTES) {
      await ctx.reply(MEETING_TOO_LARGE_TEXT).catch(() => {});
      return;
    }

    const file = await ctx.getFile();
    if (file.file_path === undefined) {
      alertOps({
        pipeline: 'F1',
        step: 'bot.audio.no_file_path',
        clientId,
        error: new Error('telegram getFile returned no file_path'),
        context: { chatId },
      });
      await ctx.reply('🔴 Не удалось получить файл от Telegram. Попробуй ещё раз.').catch(() => {});
      return;
    }

    let buf: Buffer;
    try {
      buf = await downloadTelegramFile(file.file_path);
    } catch (err) {
      log.error(
        { err, step: 'bot.audio.download_failed', clientId, chatId },
        'downloadTelegramFile failed',
      );
      alertOps({
        pipeline: 'F1',
        step: 'bot.audio.download_failed',
        clientId,
        error: err,
        context: { chatId },
      });
      await ctx.reply('🔴 Не удалось скачать файл. Попробуй ещё раз.').catch(() => {});
      return;
    }

    const tmpPath = pathJoin(tmpdir(), `meeting-${randomUUID()}`);
    try {
      await writeFile(tmpPath, buf);
    } catch (err) {
      log.error(
        { err, step: 'bot.audio.write_failed', clientId, chatId },
        'writeFile to tmp failed',
      );
      alertOps({
        pipeline: 'F1',
        step: 'bot.audio.write_failed',
        clientId,
        error: err,
        context: { chatId, tmpPath },
      });
      await ctx.reply('🔴 Не удалось сохранить файл. Попробуй ещё раз.').catch(() => {});
      return;
    }

    const job: ReportJob = {
      id: randomUUID().slice(0, 8),
      chatId,
      url: undefined,
      filePath: tmpPath,
      clientId,
      topName,
      meetingDate: now().toISOString(),
      status: 'queued',
      queuedAt: now().toISOString(),
      retryCount: 0,
    };

    const estimatedPosition = queue.size() + 1;
    let ackMessageId: number | undefined;
    try {
      const ack = await ctx.reply(formatQueueAck(estimatedPosition, estimatedPosition));
      ackMessageId = ack.message_id;
    } catch (err) {
      log.error({ err }, 'ack reply failed for audio job');
    }
    job.progressMessageId = ackMessageId;

    let placement: { position: number; queueSize: number };
    try {
      placement = queue.enqueue(job);
    } catch (err) {
      if (err instanceof QueueOverflowError) {
        log.warn({ chatId }, 'bot.queue_overflow.race (audio)');
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
        await unlink(tmpPath).catch(() => {});
        return;
      }
      throw err;
    }

    scheduleTimeout(job.id);

    log.info(
      {
        step: 'bot.audio.queued',
        jobId: job.id,
        chatId,
        position: placement.position,
        queueSize: placement.queueSize,
      },
      'audio/video meeting job enqueued',
    );
  }

  // Story 11.7: обработчик текстового транскрипта встречи → F1-конвейер.
  async function handleMeetingTextTranscript(
    ctx: Context,
    chatId: number,
    clientId: string,
    text: string,
    sourceName: string,
  ): Promise<void> {
    // Pre-check overflow
    if (queue.size() >= queueMaxSize) {
      log.warn(
        { chatId, queueSize: queue.size(), maxSize: queueMaxSize },
        'bot.queue_overflow (document_transcript)',
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

    const topName =
      (await getClientTopName(clientId)) ??
      (await getClientName(clientId)) ??
      'Клиент';

    try {
      assertClientId(clientId);
    } catch (err) {
      log.error(
        { err, step: 'bot.document_transcript.invalid_client_id', clientId },
        'invalid clientId — refusing to enqueue document transcript job',
      );
      alertOps({
        pipeline: 'F1',
        step: 'bot.document_transcript.invalid_client_id',
        error: err,
        context: { clientId },
      });
      await ctx.reply(formatErrorMessage('pipeline_failed')).catch(() => {});
      return;
    }

    // D12: расшифровки загружаются постфактум — дата встречи из frontmatter файла
    // (created: YYYY-MM-DD), иначе отчёт лёг бы в день загрузки и попал не в ту неделю.
    const createdDate = parseTranscriptCreatedDate(text);
    const meetingDate =
      createdDate !== undefined ? `${createdDate}T12:00:00.000Z` : now().toISOString();
    if (createdDate !== undefined) {
      log.info(
        { step: 'bot.document_transcript.meeting_date_from_frontmatter', chatId, clientId, createdDate },
        'meeting date taken from transcript frontmatter',
      );
    }

    const job: ReportJob = {
      id: randomUUID().slice(0, 8),
      chatId,
      url: undefined,
      filePath: undefined,
      transcriptText: text,
      clientId,
      topName,
      meetingDate,
      status: 'queued',
      queuedAt: now().toISOString(),
      retryCount: 0,
    };

    const estimatedPosition = queue.size() + 1;
    let ackMessageId: number | undefined;
    try {
      const ack = await ctx.reply(formatQueueAck(estimatedPosition, estimatedPosition));
      ackMessageId = ack.message_id;
    } catch (err) {
      log.error({ err }, 'ack reply failed for document transcript job');
    }
    job.progressMessageId = ackMessageId;

    let placement: { position: number; queueSize: number };
    try {
      placement = queue.enqueue(job);
    } catch (err) {
      if (err instanceof QueueOverflowError) {
        log.warn({ chatId }, 'bot.queue_overflow.race (document_transcript)');
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
        step: 'bot.document_transcript.queued',
        jobId: job.id,
        chatId,
        sourceName,
        position: placement.position,
        queueSize: placement.queueSize,
      },
      'document transcript job enqueued',
    );
  }

  bot.on('message:audio', async (ctx) => {
    await handleMeetingFileIntake(ctx, ctx.chat.id);
  });

  bot.on('message:video', async (ctx) => {
    await handleMeetingFileIntake(ctx, ctx.chat.id);
  });

  // ───────── Story 11.8: batch participant intake helpers ─────────

  /** Deliver batch review screen with inline Accept / Add-More buttons. */
  async function deliverTopsBatchReview(
    ctx: Context,
    chatId: number,
    session: F0Session,
    tops: ClientTop[],
    sourceName: string,
  ): Promise<void> {
    session.topsBatchPending = tops;
    await saveF0Session(chatId, session);
    const listLines = tops
      .map((t, i) => {
        const title = t.title ? `, ${t.title}` : '';
        return `  ${i + 1}. ${t.name}${title}`;
      })
      .join('\n');
    const reviewText = `👥 Извлёк ${tops.length} участников (из: ${sourceName}):\n${listLines}`;
    const keyboard = new InlineKeyboard()
      .text('✅ Принять', 'f0p_batch_ok')
      .text('✏️ Добавить ещё', 'f0p_batch_more');
    await ctx.reply(reviewText, { reply_markup: keyboard }).catch(() => {});
  }

  /** Handle document upload at profile/A3.2 — extract team list via LLM. */
  async function handleProfileA3BatchDocument(
    ctx: Context,
    chatId: number,
    session: F0Session,
  ): Promise<void> {
    const doc = ctx.message?.document;
    if (doc === undefined) return;
    if (!isSupportedF0Document(doc.file_name, doc.mime_type)) {
      await ctx.reply(F0_UNSUPPORTED_TEXT).catch(() => {});
      return;
    }
    if (doc.file_size !== undefined && doc.file_size > F0_MAX_FILE_BYTES) {
      await ctx.reply(F0_TOO_LARGE_TEXT).catch(() => {});
      return;
    }
    if (session.processing) {
      await ctx.reply(F0_BUSY_TEXT).catch(() => {});
      return;
    }
    session.processing = true;
    try {
      await ctx.reply('📄 Разбираю…').catch(() => {});
      const file = await ctx.getFile();
      if (file.file_path === undefined) throw new Error('no file_path for document');
      const buf = await downloadTelegramFile(file.file_path);
      const extracted = await extractTextFromDocument(buf, doc.file_name, doc.mime_type);
      const tops = await extractAllTopsWithLlm(extracted.text);
      if (tops.length === 0) {
        f0Log.warn({ step: 'f0.batch_doc.empty', chatId, sessionId: session.id }, 'batch document: no tops extracted');
        await ctx
          .reply('⚠️ Не нашёл участников в документе — добавь вручную.')
          .catch(() => {});
        return;
      }
      await deliverTopsBatchReview(ctx, chatId, session, tops, extracted.sourceName);
    } catch (err) {
      f0Log.error({ step: 'f0.batch_doc.error', chatId, err }, 'batch document extraction failed');
      await ctx.reply('🔴 Не удалось разобрать документ. Попробуй ещё раз или добавь участников вручную.').catch(() => {});
    } finally {
      session.processing = false;
    }
  }

  /** Handle photo upload at profile/A3.2 — extract team list via Claude Vision. */
  async function handleProfileA3BatchPhoto(
    ctx: Context,
    chatId: number,
    session: F0Session,
  ): Promise<void> {
    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) return;
    // Take the largest variant (last element per Telegram spec).
    const photo = photos[photos.length - 1]!;
    if (photo.file_size !== undefined && photo.file_size > F0_MAX_FILE_BYTES) {
      await ctx.reply(F0_TOO_LARGE_TEXT).catch(() => {});
      return;
    }
    if (session.processing) {
      await ctx.reply(F0_BUSY_TEXT).catch(() => {});
      return;
    }
    session.processing = true;
    try {
      await ctx.reply('🔍 Анализирую фото…').catch(() => {});
      const file = await ctx.getFile();
      if (file.file_path === undefined) throw new Error('no file_path for photo');
      const buf = await downloadTelegramFile(file.file_path);
      const tops = await extractAllTopsWithLlmFromImage(buf, 'image/jpeg');
      if (tops.length === 0) {
        f0Log.warn({ step: 'f0.batch_photo.empty', chatId, sessionId: session.id }, 'batch photo: no tops extracted');
        await ctx
          .reply('⚠️ Не удалось извлечь участников из фото — добавь вручную.')
          .catch(() => {});
        return;
      }
      await deliverTopsBatchReview(ctx, chatId, session, tops, 'фото');
    } catch (err) {
      f0Log.error({ step: 'f0.batch_photo.error', chatId, err }, 'batch photo extraction failed');
      await ctx.reply('🔴 Не удалось разобрать фото. Попробуй ещё раз или добавь участников вручную.').catch(() => {});
    } finally {
      session.processing = false;
    }
  }

  /** Dispatch transcript в нужный обработчик по текущей фазе. */
  async function dispatchVoiceTranscript(ctx: Context, session: F0Session, transcript: string): Promise<void> {
    if (session.phase === 'profile') {
      await handleF0ProfileAnswer(ctx, session, transcript);
    } else if (session.phase === 'questionnaire') {
      await handleQnAnswer(ctx, session, transcript);
    } else if (session.phase === 'filling') {
      await handleF0FillAnswer(ctx, session, transcript);
    }
  }

  bot.callbackQuery('voice_ok', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const session = await getOrRestoreF0Session(chatId);
    if (session === undefined || session.voicePending === undefined) {
      await ctx.reply('ℹ️ Нет ожидающего голосового ответа.').catch(() => {});
      return;
    }
    const { transcript } = session.voicePending;
    session.voicePending = undefined;
    await saveF0Session(chatId, session);
    f0Log.info(
      { step: 'f0.voice_ok', chatId, phase: session.phase },
      'voice transcript confirmed',
    );
    await dispatchVoiceTranscript(ctx, session, transcript);
  });

  bot.callbackQuery('voice_edit', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const session = await getOrRestoreF0Session(chatId);
    if (session !== undefined) {
      session.voicePending = undefined;
      await saveF0Session(chatId, session);
    }
    await ctx.reply('✏️ Введи исправленный текст:').catch(() => {});
  });

  bot.callbackQuery('voice_retry', async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    const session = await getOrRestoreF0Session(chatId);
    if (session !== undefined) {
      session.voicePending = undefined;
      await saveF0Session(chatId, session);
    }
    await ctx.reply('🎤 Пришли голосовое сообщение снова.').catch(() => {});
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
    // активного диалога дозаполнения, профиля (9.1) или вопросника (9.5) — иначе ответ,
    // дословно равный «новый клиент», случайно сбросил бы сессию.
    // Явный перезапуск — команда /newclient.
    const f0InMemory = f0Sessions.get(chatId);
    if (
      f0InMemory?.phase !== 'filling' &&
      f0InMemory?.phase !== 'profile' &&
      f0InMemory?.phase !== 'questionnaire' &&
      /^новый клиент$/iu.test(ctx.message.text.trim())
    ) {
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
      // Story 9.1: ответы диалога профиля клиента (рестарт восстанавливает с диска — AC2).
      if (f0?.phase === 'profile') {
        if (f0InMemory === undefined) {
          await ctx.reply('↩️ Восстановил онбординг после перерыва.').catch(() => {});
        }
        await handleF0ProfileAnswer(ctx, f0, ctx.message.text);
        return;
      }
      // Story 9.5: ответы диалога вопросника (рестарт восстанавливает с диска).
      if (f0?.phase === 'questionnaire') {
        if (f0InMemory === undefined) {
          await ctx.reply('↩️ Восстановил вопросник после перерыва.').catch(() => {});
        }
        await handleQnAnswer(ctx, f0, ctx.message.text);
        return;
      }
      // Story 1.8: fallback hint вместо молчания (UX-DR3 «Тишина — враг»).
      // Story 9.3: при активном клиенте — контекстная подсказка с именем.
      // Сюда падают: свободный текст без reply и неизвестные команды
      // (Telegram доставляет их как обычный message:text без bot_command match).
      {
        const activeClientId = await getActiveClient(chatId);
        if (activeClientId !== undefined) {
          const activeName = (await getClientName(activeClientId)) ?? activeClientId;
          await ctx
            .reply(`Активный клиент: ${activeName}. /report <ссылка> для отчёта · /help для меню.`)
            .catch((err: unknown) => {
              log.warn({ err, chatId }, 'bot.fallback.active.reply_failed');
            });
        } else {
          try {
            await ctx.reply(formatHelpHint());
          } catch (err) {
            log.warn({ err, chatId }, 'bot.fallback.reply_failed');
          }
        }
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
      const parts = splitForTelegram(
        (await clientBadgeMd(job.clientId)) + updatedText,
        TELEGRAM_SAFE_MARGIN,
        continuation,
      );
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
        { command: 'weekly', description: 'Недельные отчёты клиента' },
        { command: 'newclient', description: 'Онбординг нового клиента' },
        { command: 'advanced', description: 'Добавить участников и расширенный профиль клиента' },
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
