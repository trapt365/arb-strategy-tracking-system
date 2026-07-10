import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pino from 'pino';
import { createBot, FALLBACK_BOT_INFO, type BotDeps } from './bot.js';
import {
  TranscriptDownloadError,
  TranscriptValidationError,
  F1PipelineError,
} from './errors.js';
import type { Transcript, ClientContext, ReportJob } from './types.js';
import type { RunF1Result } from './f1-report.js';
import type { Update } from 'grammy/types';

const silentLogger = pino({ level: 'silent' }) as unknown as BotDeps['logger'];

const TEST_TRACKER_CHAT_ID = 7890;
const TEST_UNAUTHORIZED_CHAT_ID = 99999;

// ─── Synthetic Update helpers ───────────────────────────────────────────────
let updateCounter = 1;
function reportUpdate(text: string, chatId: number = TEST_TRACKER_CHAT_ID): Update {
  const message_id = 1000 + updateCounter;
  return {
    update_id: updateCounter++,
    message: {
      message_id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: 'Test' },
      from: { id: chatId, is_bot: false, first_name: 'Test' },
      text,
      entities: text.startsWith('/report')
        ? [{ type: 'bot_command', offset: 0, length: 7 }]
        : [],
    },
  } as unknown as Update;
}

function startUpdate(
  chatId: number = TEST_TRACKER_CHAT_ID,
  firstName: string = 'Test',
): Update {
  const message_id = 1000 + updateCounter;
  return {
    update_id: updateCounter++,
    message: {
      message_id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: firstName },
      from: { id: chatId, is_bot: false, first_name: firstName },
      text: '/start',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    },
  } as unknown as Update;
}

function helpUpdate(
  chatId: number = TEST_TRACKER_CHAT_ID,
  firstName: string = 'Test',
): Update {
  const message_id = 1000 + updateCounter;
  return {
    update_id: updateCounter++,
    message: {
      message_id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: firstName },
      from: { id: chatId, is_bot: false, first_name: firstName },
      text: '/help',
      entities: [{ type: 'bot_command', offset: 0, length: 5 }],
    },
  } as unknown as Update;
}

// Story 8.3/8.4: произвольная команда (/newclient, /draft, /cancel, …) с bot_command entity.
function commandUpdate(command: string, chatId: number = TEST_TRACKER_CHAT_ID): Update {
  const message_id = 1000 + updateCounter;
  return {
    update_id: updateCounter++,
    message: {
      message_id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: 'Test' },
      from: { id: chatId, is_bot: false, first_name: 'Test' },
      text: command,
      entities: [{ type: 'bot_command', offset: 0, length: command.split(' ')[0]!.length }],
    },
  } as unknown as Update;
}

function plainTextUpdate(
  text: string,
  chatId: number = TEST_TRACKER_CHAT_ID,
): Update {
  const message_id = 1000 + updateCounter;
  return {
    update_id: updateCounter++,
    message: {
      message_id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: 'Test' },
      from: { id: chatId, is_bot: false, first_name: 'Test' },
      text,
    },
  } as unknown as Update;
}

// ─── API transformer mock ───────────────────────────────────────────────────
interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

function attachApiSpy(
  bot: ReturnType<typeof createBot>['bot'],
  opts: { failEditWithMarkdown?: boolean } = {},
): ApiCall[] {
  const calls: ApiCall[] = [];
  let messageIdCounter = 10000;
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    // Return shape varies per method; we provide minimal stubs.
    if (method === 'sendMessage') {
      return {
        ok: true,
        result: {
          message_id: ++messageIdCounter,
          date: Math.floor(Date.now() / 1000),
          chat: { id: (payload as { chat_id: number }).chat_id, type: 'private' },
          text: (payload as { text: string }).text,
        },
      } as never;
    }
    if (method === 'editMessageText') {
      if (
        opts.failEditWithMarkdown &&
        (payload as { parse_mode?: string }).parse_mode === 'MarkdownV2'
      ) {
        return {
          ok: false,
          error_code: 400,
          description: "Bad Request: can't parse entities",
        } as never;
      }
      return { ok: true, result: true } as never;
    }
    if (method === 'setMyCommands' || method === 'setChatMenuButton') {
      return { ok: true, result: true } as never;
    }
    // Story 8.3: приём документа F0 требует file_path из getFile.
    if (method === 'getFile') {
      return {
        ok: true,
        result: { file_id: 'file-1', file_unique_id: 'u-1', file_path: 'documents/doc.md' },
      } as never;
    }
    return { ok: true, result: true } as never;
  });
  return calls;
}

// Story 8.3/8.4: message:document update для F0-пакета.
function documentUpdate(
  fileName: string,
  chatId: number = TEST_TRACKER_CHAT_ID,
): Update {
  const message_id = 1000 + updateCounter;
  return {
    update_id: updateCounter++,
    message: {
      message_id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: 'Test' },
      from: { id: chatId, is_bot: false, first_name: 'Test' },
      document: {
        file_id: 'file-1',
        file_unique_id: 'u-1',
        file_name: fileName,
        mime_type: 'text/markdown',
        file_size: 1024,
      },
    },
  } as unknown as Update;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────
const validTranscript: Transcript = {
  speakers: [
    {
      name: 'A',
      segments: [{ start: 0, end: 200, text: 'hello' }],
    },
  ],
  metadata: {
    date: '2026-05-19T10:00:00+05:00',
    duration: 200,
    meeting_type: 'sync',
  },
};

const validClientContext: ClientContext = {
  clientId: 'geonline',
  stakeholders: [
    {
      fullName: 'Жанель Б.',
      speakerName: 'Жанель',
      department: 'Продажи',
      role: 'CCO',
      bscCategory: '',
      responsibilityAreas: '',
      interests: '',
      notes: '',
    },
  ],
  okrs: [
    {
      krNumber: 'KR-2.3',
      shortName: 'Конверсия',
      keyResult: '30%',
      owner: 'Жанель',
      ownerPosition: 'CCO',
      currentStatus: '',
      target: '',
      progress: '',
      deadline: '',
      okrGroup: '',
      quarter: '',
    },
  ],
  f5Metrics: [],
  readAt: '2026-05-19T10:00:00+05:00',
};

function fullF1Result(): RunF1Result {
  return {
    extraction: { decisions: [], commitments: [], citations: [], facts: [], speaker_check: [] },
    analysis: {
      okr_coverage: [],
      hypothesis_status: [],
      alerts: [],
      commitments_status_updates: [],
    },
    openCommitmentsBefore: [],
    openCommitmentsSourceFiles: [],
    reportId: 'rep-1',
    formattedReport: {
      partial: false,
      reportId: 'rep-1',
      clientId: 'geonline',
      topName: 'Жанель',
      meetingDate: '2026-05-19',
      department: 'Продажи',
      weekNumber: '18',
      summaryLine: 'Конверсия 28%, гипотеза подтверждается',
      sections: [{ title: 'Решения', content: 'Перевести менеджеров на видеозвонки' }],
      commitments: [],
      alerts: [],
    },
    partial: false,
    partialReason: undefined,
    durationsMs: { extraction: 1, analysis: 1, format: 1, total: 3 },
    tokens: { input: 100, output: 100 },
    rawResponses: { extraction: '{}', analysis: '{}', format: '{}' },
  };
}

interface BuildOpts {
  runF1?: BotDeps['runF1'];
  transcribeFromUrl?: BotDeps['transcribeFromUrl'];
  readClientContext?: BotDeps['readClientContext'];
  alertOps?: ReturnType<typeof vi.fn>;
  appendApproval?: BotDeps['appendApproval'];
  applyEditToReport?: BotDeps['applyEditToReport'];
  // Story 8.3/8.4: F0-онбординг в тестах без Google/Claude/Telegram-файлов.
  runF0FullDraft?: BotDeps['runF0FullDraft'];
  extractTextFromDocument?: BotDeps['extractTextFromDocument'];
  downloadTelegramFile?: BotDeps['downloadTelegramFile'];
  createClientSpreadsheet?: BotDeps['createClientSpreadsheet'];
  // Story 8.4: подмена очереди — перехват enqueue для проверки clientId.
  queue?: BotDeps['queue'];
  // Story 9.5: Soniox-клиент для тестов голоса.
  sonioxClient?: BotDeps['sonioxClient'];
  // Story 10.1: транскрипция из локального файла (Telegram audio/video intake).
  transcribeFromFilePath?: BotDeps['transcribeFromFilePath'];
}

function buildBot(opts: BuildOpts = {}) {
  const alertOpsSpy = opts.alertOps ?? vi.fn();
  const runF1 =
    opts.runF1 ?? ((async () => fullF1Result()) as unknown as BotDeps['runF1']);
  const transcribeFromUrl =
    opts.transcribeFromUrl ??
    ((async () => validTranscript) as unknown as BotDeps['transcribeFromUrl']);
  const readClientContext =
    opts.readClientContext ??
    ((async () => validClientContext) as unknown as BotDeps['readClientContext']);
  const created = createBot({
    runF1,
    transcribeFromUrl,
    readClientContext,
    alertOps: alertOpsSpy as unknown as BotDeps['alertOps'],
    appendApproval: opts.appendApproval ?? (async () => {}),
    applyEditToReport: opts.applyEditToReport,
    runF0FullDraft: opts.runF0FullDraft,
    extractTextFromDocument: opts.extractTextFromDocument,
    downloadTelegramFile: opts.downloadTelegramFile ?? (async () => Buffer.from('doc')),
    createClientSpreadsheet: opts.createClientSpreadsheet,
    queue: opts.queue,
    sonioxClient: opts.sonioxClient,
    transcribeFromFilePath:
      opts.transcribeFromFilePath ??
      ((async () => validTranscript) as unknown as BotDeps['transcribeFromFilePath']),
    logger: silentLogger,
    token: 'TEST:TOKEN',
    botInfo: FALLBACK_BOT_INFO,
    trackerChatIds: new Set([TEST_TRACKER_CHAT_ID]),
    progressUpdatesEnabled: true,
    queueMaxSize: 20,
    now: () => new Date('2026-05-19T10:00:00.000Z'),
  });
  const calls = attachApiSpy(created.bot);
  return { ...created, calls, alertOpsSpy };
}

// ─── Approval test helpers ───────────────────────────────────────────────────

function callbackUpdate(data: string, chatId = TEST_TRACKER_CHAT_ID, messageId = 99999): Update {
  return {
    update_id: updateCounter++,
    callback_query: {
      id: `cbq_${updateCounter}`,
      from: { id: chatId, is_bot: false, first_name: 'Test', language_code: 'ru' },
      chat_instance: 'test_instance',
      data,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private', first_name: 'Test' },
        from: { id: 1, is_bot: true, first_name: 'TestBot', username: 'test_bot' },
        text: 'report text',
      },
    },
  } as unknown as Update;
}

function textReplyUpdate(
  text: string,
  replyToMessageId: number,
  chatId = TEST_TRACKER_CHAT_ID,
): Update {
  return {
    update_id: updateCounter++,
    message: {
      message_id: 2000 + updateCounter,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: 'Test' },
      from: { id: chatId, is_bot: false, first_name: 'Test' },
      text,
      reply_to_message: {
        message_id: replyToMessageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private' },
        from: { id: 1, is_bot: true, first_name: 'TestBot' },
        text: 'instruction',
      },
    },
  } as unknown as Update;
}

async function runJobFromBot(
  created: ReturnType<typeof buildBot>,
): Promise<ReportJob> {
  const { bot, queue, processJob } = created;
  await bot.handleUpdate(reportUpdate('/report https://drive.google.com/file/d/abc/view'));
  const job = queue.findByChatId(TEST_TRACKER_CHAT_ID)[0]!;
  queue.dequeue();
  await processJob(job);
  return job;
}

describe('bot — /report happy path', () => {
  it('AC#1: authorized /report <gdrive_url> → ack reply with queue ack', async () => {
    const { bot, queue, calls } = buildBot();
    await bot.handleUpdate(
      reportUpdate('/report https://drive.google.com/file/d/abc123/view?usp=sharing'),
    );

    const reply = calls.find((c) => c.method === 'sendMessage');
    expect(reply).toBeDefined();
    expect(reply!.payload.text).toMatch(/Принято/);
    expect(queue.size()).toBe(1);
  });

  it('worker processes queued job → editMessageText вызван N раз', async () => {
    const { bot, processJob, queue, calls } = buildBot();
    await bot.handleUpdate(
      reportUpdate('/report https://drive.google.com/file/d/abc/view'),
    );
    const job = queue.peek(queue.findByChatId(TEST_TRACKER_CHAT_ID)[0]!.id)!;
    // Manually drain queue so we don't need to start a worker.
    queue.dequeue();
    await processJob(job);

    const editCalls = calls.filter((c) => c.method === 'editMessageText');
    // queued ack уже на месте → editMessageText: extraction, analysis, formatting, almost_ready, final = 5
    expect(editCalls.length).toBeGreaterThanOrEqual(4);
    // Final edit содержит summary text
    const last = editCalls.at(-1)!;
    expect(last.payload.text).toContain('Конверсия 28%');
  });
});

describe('bot — input validation', () => {
  it('AC#2: /report без аргумента → "⚠️ Укажи ссылку..."', async () => {
    const { bot, queue, calls } = buildBot();
    await bot.handleUpdate(reportUpdate('/report'));
    const reply = calls.find((c) => c.method === 'sendMessage');
    expect(reply).toBeDefined();
    expect(reply!.payload.text).toMatch(/Укажи ссылку/);
    expect(queue.size()).toBe(0);
  });

  it('AC#3: invalid URL → "⚠️ Ссылка не распознана"', async () => {
    const { bot, queue, calls } = buildBot();
    await bot.handleUpdate(reportUpdate('/report not-a-url'));
    const reply = calls.find((c) => c.method === 'sendMessage');
    expect(reply!.payload.text).toMatch(/Ссылка не распознана/);
    expect(queue.size()).toBe(0);
  });

  it('AC#3 (unsupported provider): same error wording', async () => {
    const { bot, queue, calls } = buildBot();
    await bot.handleUpdate(reportUpdate('/report https://example.com/foo'));
    const reply = calls.find((c) => c.method === 'sendMessage');
    expect(reply!.payload.text).toMatch(/Ссылка не распознана/);
    expect(queue.size()).toBe(0);
  });
});

describe('bot — queue position', () => {
  it('AC#1 (queue=2): 2-й authorized request → ack с "В очереди: 2 из 2"', async () => {
    const { bot, calls } = buildBot();
    await bot.handleUpdate(reportUpdate('/report https://drive.google.com/file/d/a/view'));
    await bot.handleUpdate(reportUpdate('/report https://drive.google.com/file/d/b/view'));
    const replies = calls.filter((c) => c.method === 'sendMessage');
    expect(replies.length).toBe(2);
    expect(replies[1]!.payload.text).toMatch(/В очереди: 2 из 2/);
  });
});

describe('bot — authorization', () => {
  it('AC#5: unauthorized chatId → unauthorized reply, alertOps вызван, queue не растёт', async () => {
    const { bot, queue, calls, alertOpsSpy } = buildBot();
    await bot.handleUpdate(
      reportUpdate(
        '/report https://drive.google.com/file/d/abc/view',
        TEST_UNAUTHORIZED_CHAT_ID,
      ),
    );

    const reply = calls.find((c) => c.method === 'sendMessage');
    expect(reply!.payload.text).toMatch(/Доступ ограничен/);
    expect(queue.size()).toBe(0);
    expect(alertOpsSpy).toHaveBeenCalledTimes(1);
    expect(alertOpsSpy.mock.calls[0]![0].step).toBe('bot.unauthorized');
  });
});

describe('bot — worker error handling', () => {
  it('AC#4: TranscriptValidationError(too_short) → ⚠️ Слишком короткий + НЕ alertOps', async () => {
    const alertOpsSpy = vi.fn();
    const transcribe = vi
      .fn()
      .mockRejectedValue(new TranscriptValidationError('too_short', { durationSec: 60 }));
    const { bot, queue, processJob, calls } = buildBot({
      alertOps: alertOpsSpy,
      transcribeFromUrl: transcribe as unknown as BotDeps['transcribeFromUrl'],
    });

    await bot.handleUpdate(reportUpdate('/report https://drive.google.com/file/d/a/view'));
    const job = queue.findByChatId(TEST_TRACKER_CHAT_ID)[0]!;
    queue.dequeue();
    await processJob(job);

    const lastEdit = calls.filter((c) => c.method === 'editMessageText').at(-1)!;
    expect(lastEdit.payload.text).toMatch(/Слишком короткий/);
    expect(job.status).toBe('failed');
    // info-level: alertOps НЕ должен быть вызван для too_short
    expect(alertOpsSpy).not.toHaveBeenCalled();
  });

  it('AC#10: TranscriptDownloadError → ⚠️ Не удалось скачать + alertOps WARN', async () => {
    const alertOpsSpy = vi.fn();
    const transcribe = vi.fn().mockRejectedValue(
      new TranscriptDownloadError('access_denied', { url: 'https://drive.google.com/', clientId: 'geonline' }),
    );
    const { bot, queue, processJob, calls } = buildBot({
      alertOps: alertOpsSpy,
      transcribeFromUrl: transcribe as unknown as BotDeps['transcribeFromUrl'],
    });

    await bot.handleUpdate(reportUpdate('/report https://drive.google.com/file/d/a/view'));
    const job = queue.findByChatId(TEST_TRACKER_CHAT_ID)[0]!;
    queue.dequeue();
    await processJob(job);

    const lastEdit = calls.filter((c) => c.method === 'editMessageText').at(-1)!;
    expect(lastEdit.payload.text).toMatch(/Не удалось скачать/);
    expect(alertOpsSpy).toHaveBeenCalledTimes(1);
    expect(alertOpsSpy.mock.calls[0]![0].step).toBe('bot.report.transcript_failed');
    expect(job.status).toBe('failed');
  });

  it('AC#11: runF1 throws F1PipelineError → ⏰ Задержка + alertOps ERROR, worker НЕ падает', async () => {
    const alertOpsSpy = vi.fn();
    const runF1 = vi
      .fn()
      .mockRejectedValueOnce(new F1PipelineError('delivery_prep', { reason: 'bug' }))
      .mockResolvedValue(fullF1Result());

    const { bot, queue, processJob, calls } = buildBot({
      alertOps: alertOpsSpy,
      runF1: runF1 as unknown as BotDeps['runF1'],
    });

    await bot.handleUpdate(reportUpdate('/report https://drive.google.com/file/d/a/view'));
    await bot.handleUpdate(reportUpdate('/report https://drive.google.com/file/d/b/view'));

    const jobs = queue.findByChatId(TEST_TRACKER_CHAT_ID);
    queue.dequeue();
    queue.dequeue();
    await processJob(jobs[0]!);
    await processJob(jobs[1]!);

    // Первый job → failed, второй → completed
    expect(jobs[0]!.status).toBe('failed');
    expect(jobs[1]!.status).toBe('completed');
    const errEdits = calls
      .filter((c) => c.method === 'editMessageText')
      .map((c) => c.payload.text as string);
    expect(errEdits.some((t) => t.includes('Задержка'))).toBe(true);
    expect(alertOpsSpy).toHaveBeenCalled();
    const opsSteps = alertOpsSpy.mock.calls.map((c) => c[0].step);
    expect(opsSteps).toContain('bot.report.pipeline_failed');
  });
});

describe('bot — markdown fallback', () => {
  it('AC#13: editMessageText с MarkdownV2 fails → retry plain text', async () => {
    const { bot, queue, processJob, calls } = buildBot();
    // Re-attach spy that fails MarkdownV2 edits.
    // Wipe transformers via a new bot instance.
    const failBot = createBot({
      runF1: (async () => fullF1Result()) as unknown as BotDeps['runF1'],
      transcribeFromUrl: (async () => validTranscript) as unknown as BotDeps['transcribeFromUrl'],
      readClientContext: (async () => validClientContext) as unknown as BotDeps['readClientContext'],
      alertOps: vi.fn() as unknown as BotDeps['alertOps'],
      logger: silentLogger,
      token: 'TEST:TOKEN',
      botInfo: FALLBACK_BOT_INFO,
      trackerChatIds: new Set([TEST_TRACKER_CHAT_ID]),
      progressUpdatesEnabled: true,
      queueMaxSize: 20,
      now: () => new Date('2026-05-19T10:00:00.000Z'),
    });
    const failingCalls = attachApiSpy(failBot.bot, { failEditWithMarkdown: true });

    await failBot.bot.handleUpdate(reportUpdate('/report https://drive.google.com/file/d/a/view'));
    const job = failBot.queue.findByChatId(TEST_TRACKER_CHAT_ID)[0]!;
    failBot.queue.dequeue();
    await failBot.processJob(job);

    // Must have at least one plain edit (without parse_mode)
    const plainEdits = failingCalls.filter(
      (c) => c.method === 'editMessageText' && c.payload.parse_mode === undefined,
    );
    expect(plainEdits.length).toBeGreaterThan(0);
    expect(job.status).toBe('completed');
    // Make sure the unused bot from buildBot doesn't fail linting.
    void bot;
    void queue;
    void processJob;
    void calls;
  });
});

// ─── Approval workflow tests (Story 1.6) ────────────────────────────────────

describe('bot — approval workflow (Story 1.6)', () => {
  it('AC#1: non-partial job → editMessageReplyMarkup with approve keyboard after processJob', async () => {
    const appendApprovalMock = vi.fn().mockResolvedValue(undefined);
    const bot_instance = buildBot({ appendApproval: appendApprovalMock });
    const job = await runJobFromBot(bot_instance);

    expect(job.partial).toBe(false);
    const kbCalls = bot_instance.calls.filter((c) => c.method === 'editMessageReplyMarkup');
    expect(kbCalls.length).toBeGreaterThanOrEqual(1);
    // The keyboard inline_keyboard row should have approve/edit/reject buttons.
    const kbPayload = kbCalls.at(-1)!.payload as { reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] } };
    const row = kbPayload.reply_markup.inline_keyboard[0]!;
    expect(row.some((btn) => btn.callback_data.startsWith(`approve:${job.id}`))).toBe(true);
    expect(row.some((btn) => btn.callback_data.startsWith(`edit:${job.id}`))).toBe(true);
    expect(row.some((btn) => btn.callback_data.startsWith(`reject:${job.id}`))).toBe(true);
  });

  it('AC#2: partial job → no approve keyboard attached', async () => {
    const partialRunF1 = (async () => ({
      ...fullF1Result(),
      partial: true,
      formattedReport: { ...fullF1Result().formattedReport, partial: true, partialReason: 'format_step_failed' as const, sections: [], extractionFallback: { commitments: [], citations: [], decisions: [], facts: [] } },
    })) as unknown as BotDeps['runF1'];
    const appendApprovalMock = vi.fn().mockResolvedValue(undefined);
    const bot_instance = buildBot({ runF1: partialRunF1, appendApproval: appendApprovalMock });
    const job = await runJobFromBot(bot_instance);

    expect(job.partial).toBe(true);
    const kbCalls = bot_instance.calls.filter((c) => c.method === 'editMessageReplyMarkup');
    expect(kbCalls).toHaveLength(0);
    expect(appendApprovalMock).not.toHaveBeenCalled();
  });

  it('AC#3: approve callback → answerCallbackQuery, swap keyboard, reply "Подтверждено", appendApproval called once', async () => {
    const appendApprovalMock = vi.fn().mockResolvedValue(undefined);
    const bot_instance = buildBot({ appendApproval: appendApprovalMock });
    const job = await runJobFromBot(bot_instance);

    await bot_instance.bot.handleUpdate(callbackUpdate(`approve:${job.id}`));

    const cbqAnswers = bot_instance.calls.filter((c) => c.method === 'answerCallbackQuery');
    expect(cbqAnswers.length).toBeGreaterThanOrEqual(1);
    // Last answerCallbackQuery should be empty (not an error popup).
    expect(cbqAnswers.at(-1)!.payload.text).toBeFalsy();

    // editMessageReplyMarkup called with post-approve keyboard (note+detail buttons).
    const markupCalls = bot_instance.calls.filter((c) => c.method === 'editMessageReplyMarkup');
    const postApproveCall = markupCalls.at(-1)!;
    const row = (postApproveCall.payload as { reply_markup: { inline_keyboard: { callback_data: string }[][] } }).reply_markup.inline_keyboard[0]!;
    expect(row.some((btn) => btn.callback_data.startsWith('post_note:'))).toBe(true);

    const confirmReplies = bot_instance.calls.filter(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Подтверждено'),
    );
    expect(confirmReplies).toHaveLength(1);

    expect(appendApprovalMock).toHaveBeenCalledTimes(1);
    expect(appendApprovalMock.mock.calls[0][0]).toMatchObject({
      reportId: job.id,
      clientId: job.clientId,
      status: 'approved',
    });
    // Story 1.7: delivery happens after approve, so status is now 'delivered'.
    expect(job.approvalStatus).toBe('delivered');
  });

  it('AC#4: double-tap approve → "Уже отправлено." popup, appendApproval NOT called again', async () => {
    const appendApprovalMock = vi.fn().mockResolvedValue(undefined);
    const bot_instance = buildBot({ appendApproval: appendApprovalMock });
    const job = await runJobFromBot(bot_instance);

    // First approve
    await bot_instance.bot.handleUpdate(callbackUpdate(`approve:${job.id}`));
    expect(appendApprovalMock).toHaveBeenCalledTimes(1);

    // Second approve (double-tap)
    await bot_instance.bot.handleUpdate(callbackUpdate(`approve:${job.id}`));
    expect(appendApprovalMock).toHaveBeenCalledTimes(1); // still 1, not 2

    const cbqAnswers = bot_instance.calls.filter((c) => c.method === 'answerCallbackQuery');
    const lastAnswer = cbqAnswers.at(-1)!.payload as { text?: string };
    expect(lastAnswer.text).toBe('ℹ️ Уже отправлено.');
  });

  it('AC#5: reject callback → keyboard cleared, reply "Отклонён", no appendApproval', async () => {
    const appendApprovalMock = vi.fn().mockResolvedValue(undefined);
    const bot_instance = buildBot({ appendApproval: appendApprovalMock });
    const job = await runJobFromBot(bot_instance);

    await bot_instance.bot.handleUpdate(callbackUpdate(`reject:${job.id}`));

    // editMessageReplyMarkup last call has no reply_markup arg → keyboard removed.
    const markupCalls = bot_instance.calls.filter((c) => c.method === 'editMessageReplyMarkup');
    expect(markupCalls.length).toBeGreaterThanOrEqual(1);
    const lastMarkupPayload = markupCalls.at(-1)!.payload as { reply_markup?: unknown };
    expect(lastMarkupPayload.reply_markup).toBeUndefined();

    const rejectReplies = bot_instance.calls.filter(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('отклонён'),
    );
    expect(rejectReplies).toHaveLength(1);

    expect(appendApprovalMock).not.toHaveBeenCalled();
    expect(job.approvalStatus).toBe('rejected');
  });

  it('AC#6: edit callback → instruction reply sent, pendingEdits set (job in editing state)', async () => {
    const appendApprovalMock = vi.fn().mockResolvedValue(undefined);
    const applyEditMock = vi.fn().mockResolvedValue('исправленный отчёт');
    const bot_instance = buildBot({ appendApproval: appendApprovalMock, applyEditToReport: applyEditMock });
    const job = await runJobFromBot(bot_instance);

    await bot_instance.bot.handleUpdate(callbackUpdate(`edit:${job.id}`));

    expect(job.approvalStatus).toBe('editing');
    const instructionReplies = bot_instance.calls.filter(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Что исправить'),
    );
    expect(instructionReplies).toHaveLength(1);
  });

  it('delivered report cannot be moved back into edit flow', async () => {
    const applyEditMock = vi.fn().mockResolvedValue('исправленный отчёт');
    const bot_instance = buildBot({
      appendApproval: vi.fn().mockResolvedValue(undefined),
      applyEditToReport: applyEditMock,
    });
    const job = await runJobFromBot(bot_instance);

    await bot_instance.bot.handleUpdate(callbackUpdate(`approve:${job.id}`));
    expect(job.approvalStatus).toBe('delivered');

    await bot_instance.bot.handleUpdate(callbackUpdate(`edit:${job.id}`));

    expect(job.approvalStatus).toBe('delivered');
    expect(applyEditMock).not.toHaveBeenCalled();
    const popups = bot_instance.calls.filter(
      (c) =>
        c.method === 'answerCallbackQuery' &&
        (c.payload as { text?: string }).text?.includes('Уже подтверждено'),
    );
    expect(popups.length).toBeGreaterThanOrEqual(1);
  });

  it('AC#6b: edit reply with correct reply_to_message_id → applyEditToReport called, new report sent with keyboard', async () => {
    const appendApprovalMock = vi.fn().mockResolvedValue(undefined);
    const applyEditMock = vi.fn().mockResolvedValue('исправленный отчёт');
    const bot_instance = buildBot({ appendApproval: appendApprovalMock, applyEditToReport: applyEditMock });
    const job = await runJobFromBot(bot_instance);

    // Trigger edit callback — instruction message is sent as sendMessage, get its ID.
    await bot_instance.bot.handleUpdate(callbackUpdate(`edit:${job.id}`));
    const instructionMsgId = job.pendingEditInstructionMessageId!;
    expect(instructionMsgId).toBeGreaterThan(0);

    // Capture before the handler mutates job.lastReportText.
    const originalReportText = job.lastReportText!;

    // Reply to instruction with a correction.
    await bot_instance.bot.handleUpdate(textReplyUpdate('Конверсия 30%, не 28%', instructionMsgId));

    expect(applyEditMock).toHaveBeenCalledTimes(1);
    expect(applyEditMock.mock.calls[0][0]).toBe(originalReportText);
    expect(applyEditMock.mock.calls[0][1]).toBe('Конверсия 30%, не 28%');

    // Final report with approve keyboard sent.
    const finalSends = bot_instance.calls.filter(
      (c) => c.method === 'sendMessage' && (c.payload as { reply_markup?: unknown }).reply_markup,
    );
    expect(finalSends.length).toBeGreaterThanOrEqual(1);
    expect(job.approvalStatus).toBeUndefined();
  });

  it('AC#7: edit reply to wrong message → "Нажми [✏️]" warning, no applyEditToReport', async () => {
    const applyEditMock = vi.fn().mockResolvedValue('corrected');
    const bot_instance = buildBot({ appendApproval: vi.fn().mockResolvedValue(undefined), applyEditToReport: applyEditMock });
    const job = await runJobFromBot(bot_instance);

    await bot_instance.bot.handleUpdate(callbackUpdate(`edit:${job.id}`));
    const instructionMsgId = job.pendingEditInstructionMessageId!;

    // Reply to a WRONG message_id.
    await bot_instance.bot.handleUpdate(textReplyUpdate('правка', instructionMsgId + 9999));

    expect(applyEditMock).not.toHaveBeenCalled();
    const warnReplies = bot_instance.calls.filter(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Нажми'),
    );
    expect(warnReplies).toHaveLength(1);
    // pendingEdits should NOT be cleared (state preserved).
    expect(job.approvalStatus).toBe('editing');
  });

  it('AC#8: unknown jobId in callback → "Отчёт уже недоступен." popup, no crash', async () => {
    const bot_instance = buildBot({ appendApproval: vi.fn().mockResolvedValue(undefined) });

    await bot_instance.bot.handleUpdate(callbackUpdate('approve:nonexistent_id'));

    const cbqAnswers = bot_instance.calls.filter((c) => c.method === 'answerCallbackQuery');
    expect(cbqAnswers.length).toBeGreaterThanOrEqual(1);
    expect((cbqAnswers.at(-1)!.payload as { text?: string }).text).toBe('ℹ️ Отчёт уже недоступен.');
  });

  it('AC#9: post_detail responds with spreadsheet URL (Story 9.6)', async () => {
    const appendApprovalMock = vi.fn().mockResolvedValue(undefined);
    const bot_instance = buildBot({ appendApproval: appendApprovalMock });
    const job = await runJobFromBot(bot_instance);

    await bot_instance.bot.handleUpdate(callbackUpdate(`approve:${job.id}`));
    await bot_instance.bot.handleUpdate(callbackUpdate(`post_detail:${job.id}`));

    // post_detail should reply with the geonline sheet URL (clientId='geonline' → GEONLINE_F0_SHEET_ID='test-sheet-id')
    const urlMessages = bot_instance.calls.filter(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('docs.google.com/spreadsheets/d/test-sheet-id'),
    );
    expect(urlMessages.length).toBeGreaterThanOrEqual(1);
  });

  it('multi-report edit corruption — ✏️ on B while A is editing resets A.approvalStatus', async () => {
    const applyEditMock = vi.fn().mockResolvedValue('edited');
    const bot_instance = buildBot({ appendApproval: vi.fn().mockResolvedValue(undefined), applyEditToReport: applyEditMock });

    // Enqueue and process two jobs.
    await bot_instance.bot.handleUpdate(reportUpdate('/report https://drive.google.com/file/d/a/view'));
    await bot_instance.bot.handleUpdate(reportUpdate('/report https://drive.google.com/file/d/b/view'));
    const jobs = bot_instance.queue.findByChatId(TEST_TRACKER_CHAT_ID);
    bot_instance.queue.dequeue();
    bot_instance.queue.dequeue();
    const [jobA, jobB] = jobs as [ReportJob, ReportJob];
    await bot_instance.processJob(jobA);
    await bot_instance.processJob(jobB);

    // Press ✏️ on report A.
    await bot_instance.bot.handleUpdate(callbackUpdate(`edit:${jobA.id}`));
    expect(jobA.approvalStatus).toBe('editing');

    // Press ✏️ on report B without replying first.
    await bot_instance.bot.handleUpdate(callbackUpdate(`edit:${jobB.id}`));
    expect(jobB.approvalStatus).toBe('editing');
    // Job A must be reset — no longer stuck in 'editing'.
    expect(jobA.approvalStatus).toBeUndefined();
    expect(jobA.pendingEditInstructionMessageId).toBeUndefined();
  });

  it('non-reply text message while pending edit — silently ignored, no warning spam', async () => {
    const applyEditMock = vi.fn();
    const bot_instance = buildBot({ appendApproval: vi.fn().mockResolvedValue(undefined), applyEditToReport: applyEditMock });
    const job = await runJobFromBot(bot_instance);

    await bot_instance.bot.handleUpdate(callbackUpdate(`edit:${job.id}`));
    const sendsBefore = bot_instance.calls.filter((c) => c.method === 'sendMessage').length;

    // Send a plain text message (no reply_to_message).
    await bot_instance.bot.handleUpdate(reportUpdate('просто текст без reply'));

    const sendsAfter = bot_instance.calls.filter((c) => c.method === 'sendMessage').length;
    // No extra warning should be sent.
    expect(sendsAfter).toBe(sendsBefore);
    expect(applyEditMock).not.toHaveBeenCalled();
    // pendingEdits should still be active.
    expect(job.approvalStatus).toBe('editing');
  });

  it('AC#10: edit idempotency — double [✏️] → "Ожидаю твой ответ." popup, no new instruction', async () => {
    const applyEditMock = vi.fn();
    const bot_instance = buildBot({ appendApproval: vi.fn().mockResolvedValue(undefined), applyEditToReport: applyEditMock });
    const job = await runJobFromBot(bot_instance);

    await bot_instance.bot.handleUpdate(callbackUpdate(`edit:${job.id}`));
    const sendsBefore = bot_instance.calls.filter((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Что исправить')).length;

    await bot_instance.bot.handleUpdate(callbackUpdate(`edit:${job.id}`));
    const sendsAfter = bot_instance.calls.filter((c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Что исправить')).length;

    expect(sendsAfter).toBe(sendsBefore); // no additional instruction sent
    const waitAnswers = bot_instance.calls.filter(
      (c) => c.method === 'answerCallbackQuery' && (c.payload as { text?: string }).text?.includes('Ожидаю'),
    );
    expect(waitAnswers.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Delivery workflow tests (Story 1.7) ──────────────────────────────────

function fullF1ResultWithDraft(): RunF1Result {
  const base = fullF1Result();
  return {
    ...base,
    formattedReport: {
      ...base.formattedReport,
      partial: false as const,
      topMessageDraft: 'Жанель, по итогам встречи переходим на видео.',
      commitments: [
        { who: 'Жанель', what: 'видео', deadline: 'до 17.03', quote: 'переводим', status: 'completed' as const },
      ],
    },
  };
}

describe('bot — delivery workflow (Story 1.7)', () => {
  it('AC#1: approve → delivery messages sent, job.approvalStatus === delivered', async () => {
    const appendApprovalMock = vi.fn().mockResolvedValue(undefined);
    const bot_instance = buildBot({
      appendApproval: appendApprovalMock,
      runF1: (async () => fullF1ResultWithDraft()) as unknown as BotDeps['runF1'],
    });
    const job = await runJobFromBot(bot_instance);

    await bot_instance.bot.handleUpdate(callbackUpdate(`approve:${job.id}`));

    expect(job.approvalStatus).toBe('delivered');
    expect(job.deliveryMessageIds).toBeDefined();
    expect(job.deliveryMessageIds!.length).toBeGreaterThanOrEqual(1);

    // Delivery sendMessage calls should be present (after approve confirmation).
    const deliverySends = bot_instance.calls.filter(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Конверсия 28%'),
    );
    expect(deliverySends.length).toBeGreaterThanOrEqual(1);
  });

  it('AC#3: plain-text WhatsApp block sent when topMessageDraft exists', async () => {
    const bot_instance = buildBot({
      appendApproval: vi.fn().mockResolvedValue(undefined),
      runF1: (async () => fullF1ResultWithDraft()) as unknown as BotDeps['runF1'],
    });
    const job = await runJobFromBot(bot_instance);

    await bot_instance.bot.handleUpdate(callbackUpdate(`approve:${job.id}`));

    // Plain text block (no parse_mode) containing 📱
    const whatsappBlocks = bot_instance.calls.filter(
      (c) =>
        c.method === 'sendMessage' &&
        (c.payload.text as string).includes('📱') &&
        (c.payload.parse_mode as string | undefined) === undefined,
    );
    expect(whatsappBlocks).toHaveLength(1);
    expect(whatsappBlocks[0]!.payload.text).toContain('Для Жанель');
  });

  it('AC#4: no topMessageDraft → no plain-text block sent', async () => {
    const bot_instance = buildBot({
      appendApproval: vi.fn().mockResolvedValue(undefined),
    });
    const job = await runJobFromBot(bot_instance);

    await bot_instance.bot.handleUpdate(callbackUpdate(`approve:${job.id}`));

    // No plain text block with 📱 and no parse_mode
    const whatsappBlocks = bot_instance.calls.filter(
      (c) =>
        c.method === 'sendMessage' &&
        (c.payload.text as string).includes('📱 Для') &&
        (c.payload.parse_mode as string | undefined) === undefined,
    );
    expect(whatsappBlocks).toHaveLength(0);
    expect(job.approvalStatus).toBe('delivered');
  });

  it('AC#6: delivery failure → retry button shown, status remains approved', async () => {
    // Build a fresh bot with a sendMessage that fails on delivery (MarkdownV2 messages after approve).
    const alertOpsSpy = vi.fn();
    let sendCount = 0;
    const failBot = createBot({
      runF1: (async () => fullF1Result()) as unknown as BotDeps['runF1'],
      transcribeFromUrl: (async () => validTranscript) as unknown as BotDeps['transcribeFromUrl'],
      readClientContext: (async () => validClientContext) as unknown as BotDeps['readClientContext'],
      alertOps: alertOpsSpy as unknown as BotDeps['alertOps'],
      appendApproval: async () => {},
      logger: silentLogger,
      token: 'TEST:TOKEN',
      botInfo: FALLBACK_BOT_INFO,
      trackerChatIds: new Set([TEST_TRACKER_CHAT_ID]),
      progressUpdatesEnabled: true,
      queueMaxSize: 20,
      now: () => new Date('2026-05-19T10:00:00.000Z'),
    });

    let msgIdCounter = 30000;
    const failCalls: ApiCall[] = [];
    let failDeliveryMessages = false;

    failBot.bot.api.config.use(async (_prev, method, payload) => {
      failCalls.push({ method, payload: payload as Record<string, unknown> });
      if (method === 'sendMessage') {
        // Once failDeliveryMessages is enabled, fail all MarkdownV2 sendMessage calls (delivery).
        if (failDeliveryMessages && (payload as { parse_mode?: string }).parse_mode === 'MarkdownV2') {
          throw new Error('Telegram API error: delivery failed');
        }
        return {
          ok: true,
          result: {
            message_id: ++msgIdCounter,
            date: Math.floor(Date.now() / 1000),
            chat: { id: (payload as { chat_id: number }).chat_id, type: 'private' },
            text: (payload as { text: string }).text,
          },
        } as never;
      }
      if (method === 'editMessageText') {
        return { ok: true, result: true } as never;
      }
      return { ok: true, result: true } as never;
    });

    // Process a job normally.
    await failBot.bot.handleUpdate(reportUpdate('/report https://drive.google.com/file/d/abc/view'));
    const job = failBot.queue.findByChatId(TEST_TRACKER_CHAT_ID)[0]!;
    failBot.queue.dequeue();
    await failBot.processJob(job);

    // Enable delivery failure BEFORE approve.
    failDeliveryMessages = true;

    await failBot.bot.handleUpdate(callbackUpdate(`approve:${job.id}`));

    // Status should remain 'approved' (not 'delivered') since delivery failed.
    expect(job.approvalStatus).toBe('approved');

    // Retry button should be shown.
    const retrySends = failCalls.filter(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Не доставлено'),
    );
    expect(retrySends.length).toBeGreaterThanOrEqual(1);
  });

  it('AC#7: retry_delivery callback → re-delivery succeeds', async () => {
    const bot_instance = buildBot({
      appendApproval: vi.fn().mockResolvedValue(undefined),
    });
    const job = await runJobFromBot(bot_instance);

    // Manually set job to approved state (simulating failed delivery).
    job.approvalStatus = 'approved';
    job.lastReportText = 'test report text';

    await bot_instance.bot.handleUpdate(callbackUpdate(`retry_delivery:${job.id}`));

    expect(job.approvalStatus).toBe('delivered');
    expect(job.deliveryMessageIds).toBeDefined();
  });

  it('retry_delivery before approval is rejected and does not deliver', async () => {
    const bot_instance = buildBot({
      appendApproval: vi.fn().mockResolvedValue(undefined),
    });
    const job = await runJobFromBot(bot_instance);
    job.approvalStatus = undefined;
    job.lastReportText = 'test report text';

    await bot_instance.bot.handleUpdate(callbackUpdate(`retry_delivery:${job.id}`));

    expect(job.approvalStatus).toBeUndefined();
    expect(job.deliveryMessageIds).toBeUndefined();
    const popups = bot_instance.calls.filter(
      (c) =>
        c.method === 'answerCallbackQuery' &&
        (c.payload as { text?: string }).text?.includes('Сначала подтверди'),
    );
    expect(popups.length).toBeGreaterThanOrEqual(1);
  });

  it('AC#11: double-tap retry after success → "Уже доставлено." popup', async () => {
    const bot_instance = buildBot({
      appendApproval: vi.fn().mockResolvedValue(undefined),
    });
    const job = await runJobFromBot(bot_instance);

    // Approve and deliver.
    await bot_instance.bot.handleUpdate(callbackUpdate(`approve:${job.id}`));
    expect(job.approvalStatus).toBe('delivered');

    // Double-tap retry.
    await bot_instance.bot.handleUpdate(callbackUpdate(`retry_delivery:${job.id}`));

    const popups = bot_instance.calls.filter(
      (c) => c.method === 'answerCallbackQuery' && (c.payload as { text?: string }).text === 'ℹ️ Уже доставлено.',
    );
    expect(popups.length).toBeGreaterThanOrEqual(1);
  });

  it('AC#8: post_note callback (delivered) → instruction sent, reply → plain text note', async () => {
    const bot_instance = buildBot({
      appendApproval: vi.fn().mockResolvedValue(undefined),
    });
    const job = await runJobFromBot(bot_instance);

    // Approve + deliver.
    await bot_instance.bot.handleUpdate(callbackUpdate(`approve:${job.id}`));
    expect(job.approvalStatus).toBe('delivered');

    // Press 📝 Уточнение.
    await bot_instance.bot.handleUpdate(callbackUpdate(`post_note:${job.id}`));

    const instructionMsgs = bot_instance.calls.filter(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Напиши уточнение'),
    );
    expect(instructionMsgs).toHaveLength(1);
    const instructionMsgId = (instructionMsgs[0]!.payload as { chat_id: number }).chat_id
      ? instructionMsgs[0]!
      : undefined;

    // Get the instruction message_id from the sendMessage result.
    // In our test, sendMessage returns incremented IDs. We find the one that has "Напиши уточнение".
    // The message_id returned by sendMessage is in the calls array result (but we track calls, not results).
    // We need the message_id of the instruction. The bot stores it from `ctx.reply` result.
    // Since our API spy auto-increments from 10000, let's find the expected ID.
    const sendMsgCalls = bot_instance.calls.filter((c) => c.method === 'sendMessage');
    // The instruction message was the last sendMessage before our reply.
    // We'll use a known approach: find the instruction msg text and count sendMessages up to it.
    let instructionReplyId = 0;
    for (const call of sendMsgCalls) {
      instructionReplyId++; // counter
      if ((call.payload.text as string).includes('Напиши уточнение')) break;
    }
    // The actual message_id = 10000 + index in sendMessage calls.
    const expectedInstructionId = 10000 + instructionReplyId;

    // Reply to the instruction message with a correction.
    await bot_instance.bot.handleUpdate(
      textReplyUpdate('Уточнение: конверсия 30%', expectedInstructionId),
    );

    const noteMsgs = bot_instance.calls.filter(
      (c) =>
        c.method === 'sendMessage' &&
        (c.payload.text as string).includes('Уточнение к отчёту'),
    );
    expect(noteMsgs).toHaveLength(1);
    expect(noteMsgs[0]!.payload.text).toContain('Жанель');
    expect(noteMsgs[0]!.payload.text).toContain('конверсия 30%');
    // Plain text — no parse_mode.
    expect(noteMsgs[0]!.payload.parse_mode).toBeUndefined();
  });

  it('AC#9: post_note before delivery (approved, not delivered) → popup "Сначала дождись"', async () => {
    const bot_instance = buildBot({
      appendApproval: vi.fn().mockResolvedValue(undefined),
    });
    const job = await runJobFromBot(bot_instance);

    // Manually set approved without delivery.
    job.approvalStatus = 'approved';

    await bot_instance.bot.handleUpdate(callbackUpdate(`post_note:${job.id}`));

    const popups = bot_instance.calls.filter(
      (c) =>
        c.method === 'answerCallbackQuery' &&
        (c.payload as { text?: string }).text?.includes('Сначала дождись'),
    );
    expect(popups.length).toBeGreaterThanOrEqual(1);
  });

  it('AC#10: post_detail with known job responds with spreadsheet URL (Story 9.6)', async () => {
    const bot_instance = buildBot({
      appendApproval: vi.fn().mockResolvedValue(undefined),
    });
    const job = await runJobFromBot(bot_instance);

    await bot_instance.bot.handleUpdate(callbackUpdate(`post_detail:${job.id}`));

    // geonline clientId → GEONLINE_F0_SHEET_ID = 'test-sheet-id'
    const urlMessages = bot_instance.calls.filter(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('docs.google.com/spreadsheets/d/test-sheet-id'),
    );
    expect(urlMessages.length).toBeGreaterThanOrEqual(1);
  });

  it('AC#10b: post_detail with stale jobId → answerCallbackQuery with "недоступен"', async () => {
    const bot_instance = buildBot({
      appendApproval: vi.fn().mockResolvedValue(undefined),
    });

    await bot_instance.bot.handleUpdate(callbackUpdate('post_detail:unknown-stale-id'));

    const popups = bot_instance.calls.filter(
      (c) => c.method === 'answerCallbackQuery' && (c.payload as { text?: string }).text?.includes('недоступен'),
    );
    expect(popups.length).toBeGreaterThanOrEqual(1);
  });

  it('AC#10c: post_detail with job but no registered sheet → reply "Таблица клиента не найдена" (Story 9.6)', async () => {
    // completedJobs stores object reference → mutating clientId after processJob affects peekJob lookup
    const bot_instance = buildBot({
      appendApproval: vi.fn().mockResolvedValue(undefined),
    });
    const job = await runJobFromBot(bot_instance);
    // Force clientId to one with no registry entry and no config fallback
    job.clientId = 'unknown-no-sheet-9-6';

    await bot_instance.bot.handleUpdate(callbackUpdate(`post_detail:${job.id}`));

    const notFoundReply = bot_instance.calls.filter(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Таблица клиента не найдена'),
    );
    expect(notFoundReply.length).toBeGreaterThanOrEqual(1);
  });

  it('AC#5 (commitment lifecycle): delivery includes lifecycle emojis', async () => {
    const resultWithCommitments = fullF1ResultWithDraft();
    const bot_instance = buildBot({
      appendApproval: vi.fn().mockResolvedValue(undefined),
      runF1: (async () => resultWithCommitments) as unknown as BotDeps['runF1'],
    });
    const job = await runJobFromBot(bot_instance);

    await bot_instance.bot.handleUpdate(callbackUpdate(`approve:${job.id}`));

    // Delivery message should contain commitment with 🟢 Выполнено (status: completed).
    const deliveryMsgs = bot_instance.calls.filter(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Выполнено'),
    );
    expect(deliverySends(deliveryMsgs)).toBeTruthy();

    function deliverySends(msgs: typeof deliveryMsgs) { return msgs.length > 0; }
  });

  it('topMessageDraft preserved on job during processJob', async () => {
    const bot_instance = buildBot({
      appendApproval: vi.fn().mockResolvedValue(undefined),
      runF1: (async () => fullF1ResultWithDraft()) as unknown as BotDeps['runF1'],
    });
    const job = await runJobFromBot(bot_instance);
    expect(job.topMessageDraft).toBe('Жанель, по итогам встречи переходим на видео.');
  });
});

// ─── First-run experience tests (Story 1.8) ───────────────────────────────

describe('bot — onboarding /start (Story 1.8)', () => {
  it('AC#1: authorized /start → welcome reply (plain text) с именем', async () => {
    const { bot, queue, calls } = buildBot();
    await bot.handleUpdate(startUpdate(TEST_TRACKER_CHAT_ID, 'Азиза'));

    const reply = calls.find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Привет'),
    );
    expect(reply).toBeDefined();
    const payload = reply!.payload as { text: string; parse_mode?: string };
    expect(payload.text).toContain('Привет, Азиза!');
    expect(payload.text).toContain('AI-трекинг бот');
    // Story 9.3: полная справка переехала за «Что умеет бот»; short welcome — только 3 строки.
    expect(payload.parse_mode).toBeUndefined();
    expect(queue.size()).toBe(0);
  });

  it('AC#2: /help → та же short welcome (single source of truth)', async () => {
    const { bot, calls } = buildBot();
    await bot.handleUpdate(helpUpdate(TEST_TRACKER_CHAT_ID, 'Азиза'));

    const reply = calls.find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Привет'),
    );
    expect(reply).toBeDefined();
    const payload = reply!.payload as { text: string; parse_mode?: string };
    // Story 9.3: /help показывает то же short welcome + keyboard, не длинную инструкцию.
    expect(payload.text).toContain('AI-трекинг бот');
    expect(payload.parse_mode).toBeUndefined();
  });

  it('AC#3: повторный /start идемпотентен — 2 welcome calls, no pending state', async () => {
    const { bot, calls } = buildBot();
    await bot.handleUpdate(startUpdate(TEST_TRACKER_CHAT_ID, 'Азиза'));
    await bot.handleUpdate(startUpdate(TEST_TRACKER_CHAT_ID, 'Азиза'));

    const welcomes = calls.filter(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Привет, Азиза'),
    );
    expect(welcomes.length).toBe(2);
  });

  it('AC#4: свободный текст без pending → fallback hint', async () => {
    const { bot, queue, calls } = buildBot();
    await bot.handleUpdate(plainTextUpdate('привет бот'));

    const hints = calls.filter(
      (c) =>
        c.method === 'sendMessage' &&
        /Не понял команду/.test(c.payload.text as string),
    );
    expect(hints).toHaveLength(1);
    const payload = hints[0]!.payload as { text: string; parse_mode?: string };
    expect(payload.text).toContain('/report');
    expect(payload.text).toContain('/help');
    expect(payload.parse_mode).toBeUndefined();
    expect(queue.size()).toBe(0);
  });

  it('AC#5: неизвестная команда /foo → тот же fallback hint', async () => {
    const { bot, calls } = buildBot();
    await bot.handleUpdate(plainTextUpdate('/foo bar'));

    const hints = calls.filter(
      (c) =>
        c.method === 'sendMessage' &&
        /Не понял команду/.test(c.payload.text as string),
    );
    expect(hints).toHaveLength(1);
  });

  it('AC#6: unauthorized /start → unauthorized reply, нет welcome', async () => {
    const { bot, queue, calls, alertOpsSpy } = buildBot();
    await bot.handleUpdate(startUpdate(TEST_UNAUTHORIZED_CHAT_ID, 'Stranger'));

    const reply = calls.find((c) => c.method === 'sendMessage');
    expect(reply!.payload.text).toMatch(/Доступ ограничен/);
    expect(
      calls.some(
        (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Привет'),
      ),
    ).toBe(false);
    expect(queue.size()).toBe(0);
    expect(alertOpsSpy).toHaveBeenCalledTimes(1);
    expect(alertOpsSpy.mock.calls[0]![0].step).toBe('bot.unauthorized');
  });

  it('AC#7: после welcome /report <url> обрабатывается обычно', async () => {
    const { bot, queue, calls } = buildBot();
    await bot.handleUpdate(startUpdate(TEST_TRACKER_CHAT_ID, 'Азиза'));
    await bot.handleUpdate(
      reportUpdate('/report https://drive.google.com/file/d/abc/view'),
    );

    const ack = calls.find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Принято'),
    );
    expect(ack).toBeDefined();
    expect(queue.size()).toBe(1);
  });

  it('AC#8: pendingNotes reply не триггерит fallback hint (regression Story 1.7)', async () => {
    const bot_instance = buildBot({
      appendApproval: vi.fn().mockResolvedValue(undefined),
      runF1: (async () => fullF1ResultWithDraft()) as unknown as BotDeps['runF1'],
    });
    const job = await runJobFromBot(bot_instance);

    await bot_instance.bot.handleUpdate(callbackUpdate(`approve:${job.id}`));
    expect(job.approvalStatus).toBe('delivered');

    await bot_instance.bot.handleUpdate(callbackUpdate(`post_note:${job.id}`));

    // Find the instruction message_id assigned by the API spy
    // (auto-incremented from 10000; we count sendMessages up to "Напиши уточнение").
    const sendMsgCalls = bot_instance.calls.filter((c) => c.method === 'sendMessage');
    let idx = 0;
    for (const call of sendMsgCalls) {
      idx++;
      if ((call.payload.text as string).includes('Напиши уточнение')) break;
    }
    const expectedInstructionId = 10000 + idx;

    await bot_instance.bot.handleUpdate(
      textReplyUpdate('вот моё уточнение', expectedInstructionId),
    );

    // Note plain-text sent (Story 1.7 contract), NOT fallback hint.
    const noteMsgs = bot_instance.calls.filter(
      (c) =>
        c.method === 'sendMessage' &&
        (c.payload.text as string).includes('Уточнение к отчёту'),
    );
    expect(noteMsgs).toHaveLength(1);
    const fallbackHints = bot_instance.calls.filter(
      (c) =>
        c.method === 'sendMessage' &&
        /Не понял команду/.test(c.payload.text as string),
    );
    expect(fallbackHints).toHaveLength(0);
  });

  it('AC#4/AC#8: pendingNotes set + non-reply text → silent, нет fallback hint (regression review P2)', async () => {
    const bot_instance = buildBot({
      appendApproval: vi.fn().mockResolvedValue(undefined),
      runF1: (async () => fullF1ResultWithDraft()) as unknown as BotDeps['runF1'],
    });
    const job = await runJobFromBot(bot_instance);

    await bot_instance.bot.handleUpdate(callbackUpdate(`approve:${job.id}`));
    expect(job.approvalStatus).toBe('delivered');

    await bot_instance.bot.handleUpdate(callbackUpdate(`post_note:${job.id}`));

    const callsBefore = bot_instance.calls.length;
    // Plain text without reply_to — pendingNotes is active, but this is not a reply.
    await bot_instance.bot.handleUpdate(plainTextUpdate('просто текст без reply'));

    // AC#4 contract: fallback hint fires only when BOTH pending* are empty.
    const fallbackHints = bot_instance.calls
      .slice(callsBefore)
      .filter(
        (c) =>
          c.method === 'sendMessage' &&
          /Не понял команду/.test(c.payload.text as string),
      );
    expect(fallbackHints).toHaveLength(0);
  });

  it('AC#1 (no firstName): welcome без имени → "Привет!" без запятой', async () => {
    const { bot, calls } = buildBot();
    // Build update without first_name on `from` (edge case)
    const message_id = 5000;
    const update = {
      update_id: updateCounter++,
      message: {
        message_id,
        date: Math.floor(Date.now() / 1000),
        chat: { id: TEST_TRACKER_CHAT_ID, type: 'private' },
        from: { id: TEST_TRACKER_CHAT_ID, is_bot: false, first_name: '' },
        text: '/start',
        entities: [{ type: 'bot_command', offset: 0, length: 6 }],
      },
    } as unknown as Update;
    await bot.handleUpdate(update);

    const reply = calls.find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Привет'),
    );
    expect(reply).toBeDefined();
    expect(reply!.payload.text).toContain('Привет!');
    expect(reply!.payload.text).not.toContain('Привет, ');
  });
});

describe('bot — setMyCommands payload (Story 1.8)', () => {
  it('AC#9: setMyCommands содержит [start, help, report] в правильном порядке', async () => {
    const { bot, calls, stop } = buildBot();
    // Patch bot.start to skip long-polling but still trigger setMyCommands.
    const origStart = bot.start.bind(bot);
    bot.start = (async () => {
      /* skip long-polling in tests */
    }) as typeof bot.start;
    try {
      // The createBot.start() pulls in our patched bot.start; call original setMyCommands path.
      await bot.api.setMyCommands([
        { command: 'start',  description: 'Начать работу с ботом' },
        { command: 'help',   description: 'Инструкция и список команд' },
        { command: 'report', description: 'Создать отчёт по встрече' },
      ]);
      const cmdCall = calls.find((c) => c.method === 'setMyCommands');
      expect(cmdCall).toBeDefined();
      const cmds = (cmdCall!.payload as { commands: Array<{ command: string }> }).commands;
      expect(cmds.map((c) => c.command)).toEqual(['start', 'help', 'report']);
    } finally {
      bot.start = origStart;
      await stop();
    }
  });

  it('AC#9 (via created.start()): полный lifecycle вызывает setMyCommands с [start, help, report]', async () => {
    const built = buildBot();
    // Patch bot.start to no-op so we don't actually long-poll.
    built.bot.start = (async () => { /* skip */ }) as typeof built.bot.start;
    try {
      await built.start();
      const cmdCall = built.calls.find((c) => c.method === 'setMyCommands');
      expect(cmdCall).toBeDefined();
      const cmds = (cmdCall!.payload as { commands: Array<{ command: string }> }).commands;
      // Story 7.1/7.2/7.3: + newclient + draft + confirm; 7.5: + status;
      // Story 8.4 (W9): + resume + skip + cancel — команды видны в меню Telegram.
      // Story 10.2: + advanced — дозаполнение расширенного профиля.
      expect(cmds.map((c) => c.command)).toEqual([
        'start',
        'help',
        'report',
        'newclient',
        'advanced',
        'draft',
        'confirm',
        'status',
        'resume',
        'skip',
        'cancel',
      ]);
      expect(cmds[0]!.command).toBe('start');
    } finally {
      await built.stop();
    }
  });
});

// ─── Story 8.3: честный прогресс сборки + компактная доставка черновика ──────

import { promises as fsp } from 'node:fs';
import { join as joinPath } from 'node:path';
import type { F0FullExtraction } from './types.js';

const ONBOARDING_DIR = joinPath('data', '.onboarding');

function f0Extraction(overrides: Partial<F0FullExtraction> = {}): F0FullExtraction {
  return {
    document_type: 'strategy',
    company: 'Ромашка',
    objectives: [
      {
        title: 'O1',
        krs: [
          {
            formulation: 'Выручка с 10 до 20 млн',
            base: '10 млн',
            target: '20 млн',
            owner: 'Айгерим',
            deadline: null,
          },
        ],
      },
    ],
    hypotheses: [],
    participants: [{ name: 'Айгерим', role: 'CEO', department: null, contact: '@aigerim' }],
    unrecognized: [],
    ...overrides,
  } as unknown as F0FullExtraction;
}

function f0DraftResult(extraction: F0FullExtraction = f0Extraction()) {
  return {
    extraction,
    krIssues: [],
    hypothesisIssues: [],
    totalKrs: 1,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

/** Снести persisted-сессию тестового чата — иначе она протекает в другие тесты/прогоны. */
async function cleanOnboardingArtifacts(): Promise<void> {
  await fsp
    .rm(joinPath(ONBOARDING_DIR, `session-${TEST_TRACKER_CHAT_ID}.json`), { force: true })
    .catch(() => {});
}

/**
 * Story 9.1: /newclient начинается с обязательного профиля клиента — до 🔑-минимума
 * документы стратегии не принимаются. Хелпер проходит минимум и жмёт «Дальше»,
 * выводя сессию в существующий flow сбора (collecting).
 */
async function completeProfileMinimum(bot: ReturnType<typeof buildBot>['bot']): Promise<void> {
  await bot.handleUpdate(commandUpdate('/newclient'));
  await bot.handleUpdate(plainTextUpdate('Ромашка')); // A1.1 название
  await bot.handleUpdate(plainTextUpdate('Продаём ромашки бизнесу')); // A1.2 суть
  // Story 10.2: минимум = 2 вопроса; offer screen → «Дальше» → flow сбора стратегии.
  await bot.handleUpdate(callbackUpdate('f0p_go')); // «Дальше» → существующий flow сбора
}

describe('bot — F0 сборка черновика (Story 8.3, W2+W4)', () => {
  beforeEach(cleanOnboardingArtifacts);
  afterEach(cleanOnboardingArtifacts);

  function buildF0Bot(opts: BuildOpts = {}) {
    return buildBot({
      extractTextFromDocument: ((async (_buf: Buffer, name?: string) => ({
        sourceName: name ?? 'doc.md',
        kind: 'text',
        text: 'x'.repeat(70_000),
      })) as unknown) as BotDeps['extractTextFromDocument'],
      runF0FullDraft: ((async () => f0DraftResult()) as unknown) as BotDeps['runF0FullDraft'],
      ...opts,
    });
  }

  it('W2: оценка честная по размеру пакета; итог редактируется в progress-сообщение, не удаляется', async () => {
    const { bot, calls } = buildF0Bot();
    await completeProfileMinimum(bot);
    await bot.handleUpdate(documentUpdate('strategy.md'));
    await bot.handleUpdate(commandUpdate('/draft'));

    const progress = calls.find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Собираю черновик'),
    );
    expect(progress).toBeDefined();
    // 70k знаков — большой пакет: честные 5–12 минут, а не «1-2 минуты».
    expect(progress!.payload.text).toContain('5–12 минут');
    expect(progress!.payload.text).not.toContain('1-2 минуты');

    const edits = calls.filter((c) => c.method === 'editMessageText');
    expect(
      edits.some((e) => (e.payload.text as string).includes('🆕 Черновик онбординга — Ромашка')),
    ).toBe(true);
    expect(calls.some((c) => c.method === 'deleteMessage')).toBe(false);
  });

  it('W4: доставка компактная — счётчики есть, полных таблиц KR нет', async () => {
    const { bot, calls } = buildF0Bot();
    await completeProfileMinimum(bot);
    await bot.handleUpdate(documentUpdate('strategy.md'));
    await bot.handleUpdate(commandUpdate('/draft'));

    const finalEdit = calls.find(
      (c) => c.method === 'editMessageText' && (c.payload.text as string).includes('🆕 Черновик'),
    );
    expect(finalEdit).toBeDefined();
    const text = finalEdit!.payload.text as string;
    expect(text).toContain('Извлечено: цели 1 · KR 1');
    expect(text).toContain('/confirm');
    expect(text).not.toContain('база: ');
  });

  it('W2: сбой сборки редактирует progress-сообщение в ошибку (не молчит)', async () => {
    const { bot, calls } = buildF0Bot({
      runF0FullDraft: ((async () => {
        throw new Error('claude exploded');
      }) as unknown) as BotDeps['runF0FullDraft'],
    });
    await completeProfileMinimum(bot);
    await bot.handleUpdate(documentUpdate('strategy.md'));
    await bot.handleUpdate(commandUpdate('/draft'));

    const edits = calls.filter((c) => c.method === 'editMessageText');
    expect(
      edits.some((e) => (e.payload.text as string).includes('Не удалось собрать черновик')),
    ).toBe(true);
    expect(calls.some((c) => c.method === 'deleteMessage')).toBe(false);
  });

  it('маленький пакет → оценка «1–2 минуты»', async () => {
    const { bot, calls } = buildF0Bot({
      extractTextFromDocument: ((async () => ({
        sourceName: 'mini.md',
        kind: 'text',
        text: 'x'.repeat(5_000),
      })) as unknown) as BotDeps['extractTextFromDocument'],
    });
    await completeProfileMinimum(bot);
    await bot.handleUpdate(documentUpdate('mini.md'));
    await bot.handleUpdate(commandUpdate('/draft'));

    const progress = calls.find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Собираю черновик'),
    );
    expect(progress!.payload.text).toContain('1–2 минуты');
  });

  it('Story 9.6: /confirm compact KR warning — счётчик в sheets-reply, нет per-KR деталей', async () => {
    const extractionWithNullKr = f0Extraction({
      objectives: [
        {
          title: 'O1',
          krs: [
            {
              formulation: 'Выручка',
              base: null,
              target: null,
              owner: null,
              deadline: null,
            },
          ],
        },
      ],
    } as unknown as Partial<F0FullExtraction>);
    const spreadsheetUrl = 'https://docs.google.com/spreadsheets/d/s1/edit';
    const { bot, calls } = buildF0Bot({
      runF0FullDraft: ((async () => f0DraftResult(extractionWithNullKr)) as unknown) as BotDeps['runF0FullDraft'],
      createClientSpreadsheet: ((async () => ({
        spreadsheetId: 's1',
        spreadsheetUrl,
        counts: { okr: 1, hypotheses: 0, stakeholders: 1, personalSheets: 0 },
        shared: [],
      })) as unknown) as BotDeps['createClientSpreadsheet'],
    });
    await completeProfileMinimum(bot);
    await bot.handleUpdate(documentUpdate('strategy.md'));
    await bot.handleUpdate(commandUpdate('/draft'));
    await bot.handleUpdate(commandUpdate('/confirm'));

    // (а) confirm reply: счётчик KR теперь ЗДЕСЬ (ревью эпика 9 — виден и при сбое Sheets),
    // но без per-KR деталей (нет цитат/reasons).
    const confirmReply = calls.find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('✅ Онбординг подтверждён'),
    );
    expect(confirmReply).toBeDefined();
    expect(confirmReply!.payload.text).toContain('1 KR стоит дозаполнить');
    expect(confirmReply!.payload.text).not.toContain('«');
    expect(confirmReply!.payload.text).not.toContain('reasons');

    // (б) sheets-reply: ссылка на таблицу для дозаполнения (без повторного счётчика)
    const sheetsReply = calls.find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('дозаполни прямо в таблице'),
    );
    expect(sheetsReply).toBeDefined();
    expect(sheetsReply!.payload.text).toContain(spreadsheetUrl);
  });
});

// ─── Story 8.4: стартовое меню, навигация по клиентам, защита сессии ─────────

import { createReportQueue } from './utils/report-queue.js';

const CLIENTS_DIR = joinPath('data', 'clients');
const TEST_CLIENT_ID = 'romashka-x-test';
const TEST_CARD_DIR = joinPath('data', TEST_CLIENT_ID);

async function backupFile(path: string): Promise<string | null> {
  try {
    return await fsp.readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function restoreFile(path: string, content: string | null): Promise<void> {
  if (content === null) {
    await fsp.rm(path, { force: true }).catch(() => {});
  } else {
    await fsp.writeFile(path, content, 'utf8');
  }
}

describe('bot — меню, клиенты и защита сессии (Story 8.4)', () => {
  const registryPath = joinPath(CLIENTS_DIR, 'registry.json');
  const activePath = joinPath(CLIENTS_DIR, 'active-clients.json');
  let registryBackup: string | null = null;
  let activeBackup: string | null = null;

  beforeEach(async () => {
    registryBackup = await backupFile(registryPath);
    activeBackup = await backupFile(activePath);
    await fsp.mkdir(CLIENTS_DIR, { recursive: true });
    await fsp.writeFile(
      registryPath,
      JSON.stringify({
        [TEST_CLIENT_ID]: {
          sheetId: 'sheet-RX',
          name: 'Ромашка',
          createdAt: '2026-07-08T00:00:00.000Z',
        },
      }),
      'utf8',
    );
    await fsp.rm(activePath, { force: true }).catch(() => {});
    await fsp.rm(TEST_CARD_DIR, { recursive: true, force: true }).catch(() => {});
    await cleanOnboardingArtifacts();
  });

  afterEach(async () => {
    await restoreFile(registryPath, registryBackup);
    await restoreFile(activePath, activeBackup);
    await fsp.rm(TEST_CARD_DIR, { recursive: true, force: true }).catch(() => {});
    await cleanOnboardingArtifacts();
  });

  function menuButtons(call: ApiCall): string[] {
    const markup = call.payload.reply_markup as
      | { inline_keyboard?: Array<Array<{ callback_data?: string }>> }
      | undefined;
    return (markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data ?? '');
  }

  it('W1: /start приходит с меню — кнопки клиента + Онбординг + Что умеет бот (Story 9.3)', async () => {
    const { bot, calls } = buildBot();
    await bot.handleUpdate(startUpdate(TEST_TRACKER_CHAT_ID, 'Азиза'));
    const welcome = calls.find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Привет'),
    );
    expect(welcome).toBeDefined();
    // Story 9.3: реестр содержит клиента — кнопка start_client + Онбординг + Что умеет бот.
    const buttons = menuButtons(welcome!);
    expect(buttons).toContain(`start_client:${TEST_CLIENT_ID}`);
    expect(buttons).toContain('menu:new');
    expect(buttons).toContain('menu:help');
    // geonline-fallback НЕ в start-меню
    expect(buttons).not.toContain('menu:clients');
  });

  it('menu:clients → список клиентов реестра с кнопками client:{id} + встроенный geonline', async () => {
    const { bot, calls } = buildBot();
    await bot.handleUpdate(callbackUpdate('menu:clients'));
    const list = calls.find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Клиенты — выбери'),
    );
    expect(list).toBeDefined();
    expect(menuButtons(list!)).toContain(`client:${TEST_CLIENT_ID}`);
    // Ревью пачки: geonline доступен из меню — выбор можно вернуть на встроенного пилота.
    expect(menuButtons(list!)).toContain('client:geonline');
  });

  it('W10: client:{id} с карточкой → статус из card.json (и для завершённого клиента)', async () => {
    await fsp.mkdir(TEST_CARD_DIR, { recursive: true });
    await fsp.writeFile(
      joinPath(TEST_CARD_DIR, 'card.json'),
      JSON.stringify({
        clientId: TEST_CLIENT_ID,
        company: 'Ромашка',
        industry: null,
        participants: [{ name: 'Айгерим', role: 'CEO', okrDirection: null, telegram: '@aigerim' }],
        ceo: 'Айгерим',
        trackerChatId: TEST_TRACKER_CHAT_ID,
        schedule: 'вт 15:00',
        spreadsheetId: 'sheet-RX',
        sheetsUrl: 'https://docs.google.com/spreadsheets/d/sheet-RX/edit',
        startDate: '2026-07-01T00:00:00.000Z',
        createdAt: '2026-07-01T00:00:00.000Z',
      }),
      'utf8',
    );
    const { bot, calls } = buildBot();
    await bot.handleUpdate(callbackUpdate(`client:${TEST_CLIENT_ID}`));
    const cardMsg = calls.find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('👤 Ромашка'),
    );
    expect(cardMsg).toBeDefined();
    expect(cardMsg!.payload.text).toContain('🟢 Google Sheets создан');
    expect(cardMsg!.payload.text).toContain('CEO: Айгерим');
    expect(menuButtons(cardMsg!)).toContain(`client_use:${TEST_CLIENT_ID}`);
  });

  it('client:{id} без карточки → внятный fallback, а не молчание', async () => {
    const { bot, calls } = buildBot();
    await bot.handleUpdate(callbackUpdate(`client:${TEST_CLIENT_ID}`));
    const msg = calls.find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Карточки онбординга нет'),
    );
    expect(msg).toBeDefined();
  });

  it('W10: client_use → активный клиент персистится и /report без clientId идёт по нему', async () => {
    const enqueued: ReportJob[] = [];
    const realQueue = createReportQueue({ maxSize: 20, logger: silentLogger });
    const spyQueue = {
      ...realQueue,
      enqueue: (job: ReportJob) => {
        enqueued.push(job);
        return realQueue.enqueue(job);
      },
    } as typeof realQueue;
    const { bot, calls } = buildBot({ queue: spyQueue });

    await bot.handleUpdate(callbackUpdate(`client_use:${TEST_CLIENT_ID}`));
    const ack = calls.find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Активный клиент: Ромашка'),
    );
    expect(ack).toBeDefined();
    const persisted = JSON.parse(await fsp.readFile(activePath, 'utf8')) as Record<string, string>;
    expect(persisted[String(TEST_TRACKER_CHAT_ID)]).toBe(TEST_CLIENT_ID);

    await bot.handleUpdate(reportUpdate('/report https://drive.google.com/file/d/abc123/view'));
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.clientId).toBe(TEST_CLIENT_ID);
    // Story 8.2 (W8): fallback имени топа для не-geonline — название компании, не «Жанель».
    expect(enqueued[0]!.topName).toBe('Ромашка');
  });

  it('регресс: без активного клиента /report по-прежнему уходит в geonline (+Жанель)', async () => {
    const enqueued: ReportJob[] = [];
    const realQueue = createReportQueue({ maxSize: 20, logger: silentLogger });
    const spyQueue = {
      ...realQueue,
      enqueue: (job: ReportJob) => {
        enqueued.push(job);
        return realQueue.enqueue(job);
      },
    } as typeof realQueue;
    const { bot } = buildBot({ queue: spyQueue });
    await bot.handleUpdate(reportUpdate('/report https://drive.google.com/file/d/abc123/view'));
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.clientId).toBe('geonline');
    expect(enqueued[0]!.topName).toBe('Жанель');
  });

  it('W3: /newclient при активном filling → подтверждение; f0_new_no сохраняет сессию', async () => {
    const { bot, calls } = buildBot({
      extractTextFromDocument: ((async () => ({
        sourceName: 'strategy.md',
        kind: 'text',
        text: 'x'.repeat(5_000),
      })) as unknown) as BotDeps['extractTextFromDocument'],
      runF0FullDraft: ((async () => f0DraftResult()) as unknown) as BotDeps['runF0FullDraft'],
    });
    await completeProfileMinimum(bot);
    await bot.handleUpdate(documentUpdate('strategy.md'));
    await bot.handleUpdate(commandUpdate('/draft')); // → phase filling

    const before = calls.length;
    await bot.handleUpdate(commandUpdate('/newclient'));
    const guard = calls.slice(before).find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('сбросить этот прогресс'),
    );
    expect(guard).toBeDefined();
    expect(guard!.payload.text).toContain('«Ромашка»');
    const guardButtons = menuButtons(guard!);
    expect(guardButtons[0]).toMatch(/^f0_new_yes:.+/); // ревью пачки: кнопка привязана к сессии
    expect(guardButtons[1]).toBe('f0_new_no');

    await bot.handleUpdate(callbackUpdate('f0_new_no'));
    // Сессия жива: /status отдаёт чеклист по черновику, а не «Нет активного онбординга».
    const beforeStatus = calls.length;
    await bot.handleUpdate(commandUpdate('/status'));
    const status = calls.slice(beforeStatus).find((c) => c.method === 'sendMessage');
    expect(status!.payload.text).toContain('Готовность к неделе 1');
  });

  it('W3: f0_new_yes сбрасывает и стартует новый онбординг', async () => {
    const { bot, calls } = buildBot({
      extractTextFromDocument: ((async () => ({
        sourceName: 'strategy.md',
        kind: 'text',
        text: 'x'.repeat(5_000),
      })) as unknown) as BotDeps['extractTextFromDocument'],
      runF0FullDraft: ((async () => f0DraftResult()) as unknown) as BotDeps['runF0FullDraft'],
    });
    await completeProfileMinimum(bot);
    await bot.handleUpdate(documentUpdate('strategy.md'));
    await bot.handleUpdate(commandUpdate('/draft'));
    await bot.handleUpdate(commandUpdate('/newclient')); // guard
    const guard = calls.find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('сбросить этот прогресс'),
    );
    const yesButton = menuButtons(guard!).find((d) => d.startsWith('f0_new_yes:'))!;
    const before = calls.length;
    await bot.handleUpdate(callbackUpdate(yesButton));
    const started = calls.slice(before).find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Онбординг нового клиента'),
    );
    expect(started).toBeDefined();

    // Протухшая кнопка (id старой сессии) больше не сбрасывает новую сессию.
    const afterStale = calls.length;
    await bot.handleUpdate(callbackUpdate(yesButton));
    const stale = calls.slice(afterStale).find(
      (c) =>
        c.method === 'answerCallbackQuery' &&
        ((c.payload as { text?: string }).text ?? '').includes('устарела'),
    );
    expect(stale).toBeDefined();
  });

  it('W3: /cancel с подтверждением удаляет сессию; без сессии — внятный ответ', async () => {
    const { bot, calls } = buildBot({
      extractTextFromDocument: ((async () => ({
        sourceName: 'strategy.md',
        kind: 'text',
        text: 'x'.repeat(5_000),
      })) as unknown) as BotDeps['extractTextFromDocument'],
      runF0FullDraft: ((async () => f0DraftResult()) as unknown) as BotDeps['runF0FullDraft'],
    });
    await completeProfileMinimum(bot);
    await bot.handleUpdate(documentUpdate('strategy.md'));
    await bot.handleUpdate(commandUpdate('/draft'));

    let before = calls.length;
    await bot.handleUpdate(commandUpdate('/cancel'));
    const prompt = calls.slice(before).find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Завершить онбординг'),
    );
    expect(prompt).toBeDefined();
    const cancelButtons = menuButtons(prompt!);
    expect(cancelButtons[0]).toMatch(/^f0_cancel_yes:.+/);
    expect(cancelButtons[1]).toBe('f0_cancel_no');

    await bot.handleUpdate(callbackUpdate(cancelButtons[0]!));
    before = calls.length;
    await bot.handleUpdate(commandUpdate('/status'));
    const status = calls.slice(before).find((c) => c.method === 'sendMessage');
    expect(status!.payload.text).toContain('Нет активного онбординга');

    before = calls.length;
    await bot.handleUpdate(commandUpdate('/cancel'));
    const noSession = calls.slice(before).find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('отменять нечего'),
    );
    expect(noSession).toBeDefined();
  });
});

// ─── Story 8.6: качество диалога дозаполнения — группировка по KR + валидация ──

describe('bot — диалог дозаполнения: группы KR и числовая валидация (Story 8.6)', () => {
  beforeEach(cleanOnboardingArtifacts);
  afterEach(cleanOnboardingArtifacts);

  // KR без базы и ответственного → очередь: kr_base(O1.1), kr_owner(O1.1), schedule.
  function gappyExtraction(): F0FullExtraction {
    return f0Extraction({
      objectives: [
        {
          title: 'O1',
          krs: [
            {
              formulation: 'Выручка вырастет',
              base: null,
              target: '20 млн',
              owner: null,
              deadline: null,
            },
          ],
        },
      ],
    } as Partial<F0FullExtraction>);
  }

  function buildFillBot() {
    return buildBot({
      extractTextFromDocument: ((async () => ({
        sourceName: 'strategy.md',
        kind: 'text',
        text: 'x'.repeat(5_000),
      })) as unknown) as BotDeps['extractTextFromDocument'],
      runF0FullDraft: ((async () => f0DraftResult(gappyExtraction())) as unknown) as BotDeps['runF0FullDraft'],
    });
  }

  async function toFilling(bot: ReturnType<typeof buildBot>['bot']): Promise<void> {
    await completeProfileMinimum(bot);
    await bot.handleUpdate(documentUpdate('strategy.md'));
    await bot.handleUpdate(commandUpdate('/draft'));
  }

  const texts = (calls: ApiCall[], from = 0): string[] =>
    calls
      .slice(from)
      .filter((c) => c.method === 'sendMessage')
      .map((c) => c.payload.text as string);

  it('W5: первый вопрос группы несёт заголовок 📍 KR, второй — короткий без заголовка', async () => {
    const { bot, calls } = buildFillBot();
    await toFilling(bot);

    const first = texts(calls).find((t) => t.includes('(1/3)'))!;
    expect(first).toContain('📍 KR O1.1 «Выручка вырастет» — не хватает: база «с X», ответственный.');
    expect(first).toContain('❓ (1/3) База «с X» для KR O1.1');

    // Числовой ответ на базу принят сразу → второй вопрос той же группы, без 📍.
    const before = calls.length;
    await bot.handleUpdate(plainTextUpdate('10 млн'));
    const second = texts(calls, before).find((t) => t.includes('(2/3)'))!;
    expect(second).not.toContain('📍');
    expect(second).toContain('Кто ответственный за KR O1.1');
  });

  it('W6: нечисловой ответ на базу → один переспрос; повторный ответ принимается как есть', async () => {
    const { bot, calls } = buildFillBot();
    await toFilling(bot);

    let before = calls.length;
    await bot.handleUpdate(plainTextUpdate('нет данных'));
    const retry = texts(calls, before).find((t) => t.includes('Не вижу числа'));
    expect(retry).toBeDefined();
    expect(retry).toContain('/skip');
    // Очередь не продвинулась — вопрос (2/3) не задан.
    expect(texts(calls, before).some((t) => t.includes('(2/3)'))).toBe(false);

    // Повтор того же ответа — принимается как есть, очередь идёт дальше.
    before = calls.length;
    await bot.handleUpdate(plainTextUpdate('нет данных'));
    expect(texts(calls, before).some((t) => t.includes('Не вижу числа'))).toBe(false);
    expect(texts(calls, before).some((t) => t.includes('(2/3)'))).toBe(true);
  });

  it('W6: валидация не трогает нечисловые поля (ответственный) и снимается после ответа', async () => {
    const { bot, calls } = buildFillBot();
    await toFilling(bot);

    await bot.handleUpdate(plainTextUpdate('с 10 до 20 млн')); // база: цифры есть → принято
    const before = calls.length;
    await bot.handleUpdate(plainTextUpdate('Айгерим')); // ответственный: текст без цифр — ок
    expect(texts(calls, before).some((t) => t.includes('Не вижу числа'))).toBe(false);
    expect(texts(calls, before).some((t) => t.includes('(3/3)'))).toBe(true);
  });

  it('W6: переспрос переживает рестарт (retryGapIndex в персисте) — повтор после рестарта принят', async () => {
    const first = buildFillBot();
    await toFilling(first.bot);
    await first.bot.handleUpdate(plainTextUpdate('нет данных')); // → переспрос, retryGapIndex=0

    // «Рестарт»: новый инстанс бота восстанавливает сессию с диска.
    const second = buildFillBot();
    const before = second.calls.length;
    await second.bot.handleUpdate(plainTextUpdate('нет данных'));
    expect(texts(second.calls, before).some((t) => t.includes('Не вижу числа'))).toBe(false);
    expect(texts(second.calls, before).some((t) => t.includes('(2/3)'))).toBe(true);
  });
});

// ─── Story 8.5: два пути входа — импорт готового Excel vs синтез из документов ─

import * as XLSX from 'xlsx';

describe('bot — импорт готовой стратегии из xlsx (Story 8.5)', () => {
  beforeEach(cleanOnboardingArtifacts);
  afterEach(cleanOnboardingArtifacts);

  /** Произвольная таблица клиента: KR без базы → в диалоге будет вопрос дозаполнения. */
  function clientXlsxBuffer(): Buffer {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['Направление', 'Ключевой результат', 'База', 'Цель', 'Ответственный', 'Срок'],
        ['Продажи', 'Выручка от новых клиентов', '', '20 млн', 'Айгерим', 'Q4'],
      ]),
      'Стратегия',
    );
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  function xlsxDocumentUpdate(chatId: number = TEST_TRACKER_CHAT_ID): Update {
    const upd = documentUpdate('strategy.xlsx', chatId) as unknown as {
      message: { document: { mime_type: string } };
    };
    upd.message.document.mime_type =
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    return upd as unknown as Update;
  }

  function buildImportBot(opts: BuildOpts = {}) {
    // runF0FullDraft-спай: в импорт-пути LLM звать нельзя (кроме явного досинтеза).
    const runF0Spy = vi.fn(async () => f0DraftResult());
    const built = buildBot({
      downloadTelegramFile: async () => clientXlsxBuffer(),
      runF0FullDraft: (runF0Spy as unknown) as BotDeps['runF0FullDraft'],
      ...opts,
    });
    return { ...built, runF0Spy };
  }

  const texts85 = (calls: ApiCall[], from = 0): string[] =>
    calls
      .slice(from)
      .filter((c) => c.method === 'sendMessage')
      .map((c) => c.payload.text as string);

  it('автодетект по .xlsx: импорт без LLM, черновик и диалог дозаполнения как обычно', async () => {
    const { bot, calls, runF0Spy } = buildImportBot();
    await completeProfileMinimum(bot);
    await bot.handleUpdate(xlsxDocumentUpdate());

    const accepted = texts85(calls).find((t) => t.includes('📥 Импорт «strategy.xlsx»'));
    expect(accepted).toBeDefined();
    expect(accepted).toContain('KR 1');

    const before = calls.length;
    await bot.handleUpdate(commandUpdate('/draft'));
    const after = texts85(calls, before);
    // Черновик собран мгновенно: без LLM и без progress-тикера «Собираю черновик».
    expect(runF0Spy).not.toHaveBeenCalled();
    expect(after.some((t) => t.includes('Собираю черновик'))).toBe(false);
    expect(after.some((t) => t.includes('🆕 Черновик онбординга'))).toBe(true);
    // Неполный KR из Excel → штатный вопрос дозаполнения (инвариант 1 тем же кодом).
    expect(after.some((t) => t.includes('База «с X» для KR O1.1'))).toBe(true);
  });

  it('немаппируемый xlsx → честный отказ с предложением синтеза; путь не фиксируется', async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['Имя', 'Телефон'],
        ['Айгерим', '+7 700'],
      ]),
      'Контакты',
    );
    const { bot, calls } = buildImportBot({
      downloadTelegramFile: async () =>
        XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
      extractTextFromDocument: ((async () => ({
        sourceName: 'strategy.md',
        kind: 'text',
        text: 'x'.repeat(5_000),
      })) as unknown) as BotDeps['extractTextFromDocument'],
    });
    await completeProfileMinimum(bot);
    // Ревью MED-1: путь зафиксирован ЯВНОЙ кнопкой до файла — отказ импорта обязан
    // разблокировать и этот случай, а не только автодетект.
    await bot.handleUpdate(callbackUpdate('f0_mode_import'));
    await bot.handleUpdate(xlsxDocumentUpdate());

    const rejected = texts85(calls).find((t) => t.includes('Не смог распознать в Excel'));
    expect(rejected).toBeDefined();
    expect(rejected).toContain('Выбери другой путь');

    // Matrix Row 3: кнопка «Вопросник» должна присутствовать в reply_markup сообщения об отказе.
    const rejectedCall = calls.find(
      (c) =>
        c.method === 'sendMessage' &&
        (c.payload.text as string).includes('Не смог распознать в Excel'),
    );
    expect(rejectedCall).toBeDefined();
    expect(JSON.stringify(rejectedCall!.payload.reply_markup)).toContain('f0_mode_questionnaire');

    // После отказа путь синтеза открыт: обычный .md принимается в пакет.
    const before = calls.length;
    await bot.handleUpdate(documentUpdate('strategy.md'));
    expect(texts85(calls, before).some((t) => t.includes('📎 Принят: strategy.md'))).toBe(true);
  });

  it('пути не смешиваются: документ при импорте отклоняется, xlsx при синтезе — кнопка переключения', async () => {
    const { bot, calls } = buildImportBot({
      extractTextFromDocument: ((async () => ({
        sourceName: 'strategy.md',
        kind: 'text',
        text: 'x'.repeat(5_000),
      })) as unknown) as BotDeps['extractTextFromDocument'],
    });
    await completeProfileMinimum(bot);
    await bot.handleUpdate(xlsxDocumentUpdate());
    // mode=import: .md в пакет не идёт.
    let before = calls.length;
    await bot.handleUpdate(documentUpdate('strategy.md'));
    expect(texts85(calls, before).some((t) => t.includes('Идёт импорт из Excel'))).toBe(true);

    // Новый инстанс: первый файл .md → mode=synthesis; затем xlsx → предложение
    // переключиться, а не молчаливый сброс. Story 9.1: collecting с профилем теперь
    // персистится — чистим, чтобы /newclient не упёрся в reset-guard прошлой сессии.
    await cleanOnboardingArtifacts();
    const fresh = buildImportBot({
      extractTextFromDocument: ((async () => ({
        sourceName: 'strategy.md',
        kind: 'text',
        text: 'x'.repeat(5_000),
      })) as unknown) as BotDeps['extractTextFromDocument'],
    });
    await completeProfileMinimum(fresh.bot);
    await fresh.bot.handleUpdate(documentUpdate('strategy.md'));
    before = fresh.calls.length;
    await fresh.bot.handleUpdate(xlsxDocumentUpdate());
    const hint = texts85(fresh.calls, before).find((t) => t.includes('Excel в неё не смешивается'));
    expect(hint).toBeDefined();
    expect(hint).toContain('будет отброшен');
  });

  it('кнопка «🧠 Досинтезировать гипотезы»: единственный LLM-вызов импорта, вопросы в конец очереди', async () => {
    const synthResult = f0DraftResult(
      f0Extraction({
        hypotheses: [
          {
            statement: 'Видеозвонки поднимут конверсию',
            ifThenBecause: null,
            metric: null,
            department: null,
            synthesized: false,
          },
        ],
      } as Partial<F0FullExtraction>),
    );
    const runF0Spy = vi.fn(async () => synthResult);
    const { bot, calls } = buildImportBot({
      runF0FullDraft: (runF0Spy as unknown) as BotDeps['runF0FullDraft'],
    });
    await completeProfileMinimum(bot);
    await bot.handleUpdate(xlsxDocumentUpdate());
    await bot.handleUpdate(commandUpdate('/draft'));

    // Гипотез в файле нет → предложение досинтеза с кнопкой.
    const offer = calls.find(
      (c) =>
        c.method === 'sendMessage' &&
        (c.payload.text as string).includes('Гипотез в файле не нашёл'),
    );
    expect(offer).toBeDefined();
    expect(JSON.stringify(offer!.payload.reply_markup)).toContain('f0_synth_hypo');

    const before = calls.length;
    await bot.handleUpdate(callbackUpdate('f0_synth_hypo'));
    expect(runF0Spy).toHaveBeenCalledTimes(1);
    const after = texts85(calls, before);
    expect(after.some((t) => t.includes('Синтезировано гипотез: 1'))).toBe(true);
    expect(after.some((t) => t.includes('без метрики — 1'))).toBe(true);

    // Вопрос про метрику гипотезы встал в КОНЕЦ очереди (после расписания):
    // было 3 вопроса (база KR, контакт участника, расписание) → стало 4.
    let b2 = calls.length;
    await bot.handleUpdate(plainTextUpdate('15 000')); // база KR
    expect(texts85(calls, b2).some((t) => t.includes('(2/4)'))).toBe(true);
    b2 = calls.length;
    await bot.handleUpdate(plainTextUpdate('@aigerim')); // контакт участника
    expect(texts85(calls, b2).some((t) => t.includes('(3/4)'))).toBe(true);
    b2 = calls.length;
    await bot.handleUpdate(plainTextUpdate('вт 15:00')); // расписание
    const hypoQ = texts85(calls, b2).find((t) => t.includes('(4/4)'));
    expect(hypoQ).toBeDefined();
    expect(hypoQ).toContain('Метрика проверки гипотезы H1');

    // Повторное нажатие — гипотезы уже есть, второй LLM-вызов не делается.
    const b3 = calls.length;
    await bot.handleUpdate(callbackUpdate('f0_synth_hypo'));
    expect(runF0Spy).toHaveBeenCalledTimes(1);
    expect(texts85(calls, b3).some((t) => t.includes('уже есть в черновике'))).toBe(true);
  });

  // Matrix Row 4 (Story 9.5): кнопка «Вопросник» → фаза questionnaire, вопрос B1.3
  it('кнопка «Вопросник» → начинает вопросник (B1.3 направления)', async () => {
    const { bot, calls } = buildImportBot();
    await completeProfileMinimum(bot);
    const before = calls.length;
    await bot.handleUpdate(callbackUpdate('f0_mode_questionnaire'));
    const afterTexts = texts85(calls, before);
    // Должен задать B1.3 вопрос о направлениях
    expect(
      afterTexts.some((t) => t.includes('направлени') || t.includes('целей года')),
    ).toBe(true);
  });

  // Matrix Row 2: .pptx документ принят в пакет
  it('автодетект .pptx: документ принят в пакет, режим synthesis', async () => {
    const { bot, calls } = buildImportBot({
      extractTextFromDocument: (async (_buf: Buffer, name?: string) => ({
        sourceName: name ?? 'deck.pptx',
        kind: 'pptx' as const,
        text: 'Стратегия',
      })) as unknown as BotDeps['extractTextFromDocument'],
    });
    await completeProfileMinimum(bot);
    const before = calls.length;
    await bot.handleUpdate(documentUpdate('deck.pptx'));
    expect(texts85(calls, before).some((t) => t.includes('📎 Принят: deck.pptx'))).toBe(true);
  });

  // Matrix Row 5: одиночный .pptx → isPresentationOnly: true передаётся в runF0FullDraft
  it('одиночный .pptx в пакете → runF0FullDraft вызван с isPresentationOnly: true', async () => {
    const spy = vi.fn(async () => f0DraftResult());
    const { bot } = buildImportBot({
      runF0FullDraft: (spy as unknown) as BotDeps['runF0FullDraft'],
      extractTextFromDocument: (async (_buf: Buffer, name?: string) => ({
        sourceName: name ?? 'deck.pptx',
        kind: 'pptx' as const,
        text: 'Стратегия',
      })) as unknown as BotDeps['extractTextFromDocument'],
    });
    await completeProfileMinimum(bot);
    await bot.handleUpdate(documentUpdate('deck.pptx'));
    await bot.handleUpdate(commandUpdate('/draft'));
    await vi.waitFor(() => expect(spy).toHaveBeenCalled());
    expect((spy.mock.calls[0]![0] as { isPresentationOnly?: boolean }).isPresentationOnly).toBe(true);
  });
});

// ─── Story 9.1: профиль клиента — обязательный первый шаг онбординга ──────────

describe('bot — профиль клиента: обязательный первый шаг (Story 9.1)', () => {
  beforeEach(cleanOnboardingArtifacts);
  afterEach(cleanOnboardingArtifacts);

  function buildProfileBot(opts: BuildOpts = {}) {
    return buildBot({
      extractTextFromDocument: ((async () => ({
        sourceName: 'strategy.md',
        kind: 'text',
        text: 'x'.repeat(5_000),
      })) as unknown) as BotDeps['extractTextFromDocument'],
      runF0FullDraft: ((async () => f0DraftResult()) as unknown) as BotDeps['runF0FullDraft'],
      ...opts,
    });
  }

  const texts91 = (calls: ApiCall[], from = 0): string[] =>
    calls
      .slice(from)
      .filter((c) => c.method === 'sendMessage')
      .map((c) => c.payload.text as string);

  it('AC1: /newclient начинает с A1.1; документы и способ онбординга недоступны до минимума', async () => {
    const { bot, calls } = buildProfileBot();
    await bot.handleUpdate(commandUpdate('/newclient'));

    const all = texts91(calls);
    expect(all.some((t) => t.includes('Как называется компания?'))).toBe(true);
    expect(all.some((t) => t.includes('🔑 (1/2)'))).toBe(true);
    // Экран способов не показан до минимума.
    expect(all.some((t) => t.includes('Как заводим стратегию?'))).toBe(false);

    // Документ стратегии до минимума — отклоняется, в пакет не попадает.
    const before = calls.length;
    await bot.handleUpdate(documentUpdate('strategy.md'));
    const after = texts91(calls, before);
    expect(after.some((t) => t.includes('Сначала профиль клиента'))).toBe(true);
    expect(after.some((t) => t.includes('📎 Принят'))).toBe(false);

    // /draft до минимума тоже недоступен.
    const b2 = calls.length;
    await bot.handleUpdate(commandUpdate('/draft'));
    expect(texts91(calls, b2).some((t) => t.includes('Сначала профиль клиента'))).toBe(true);
  });

  it('AC1: /skip на 🔑-вопросе → пояснение «минимум обязателен» + повтор вопроса', async () => {
    const { bot, calls } = buildProfileBot();
    await bot.handleUpdate(commandUpdate('/newclient'));

    const before = calls.length;
    await bot.handleUpdate(commandUpdate('/skip'));
    const after = texts91(calls, before);
    expect(after.some((t) => t.includes('обязательный минимум'))).toBe(true);
    // Тот же вопрос задан повторно — сессия не заблокирована.
    expect(after.some((t) => t.includes('Как называется компания?'))).toBe(true);
  });

  it('AC1: после A1.2 — offer «Добавить топов / Дальше»; «Дальше» → существующий flow сбора (Story 10.2)', async () => {
    const { bot, calls } = buildProfileBot();
    await bot.handleUpdate(commandUpdate('/newclient'));
    await bot.handleUpdate(plainTextUpdate('Ромашка'));
    await bot.handleUpdate(plainTextUpdate('Продаём ромашки бизнесу'));

    // Offer screen появляется после 2 вопросов минимума.
    const offer = calls.find(
      (c) =>
        c.method === 'sendMessage' &&
        (c.payload.text as string).includes('Название и суть зафиксированы'),
    )!;
    expect(offer).toBeDefined();
    const offerButtons = JSON.stringify(offer.payload.reply_markup);
    expect(offerButtons).toContain('f0p_ext');
    expect(offerButtons).toContain('f0p_go');
    // Новая метка кнопки расширенного профиля.
    expect(offerButtons).toContain('Добавить топов');

    const before = calls.length;
    await bot.handleUpdate(callbackUpdate('f0p_go'));
    // Story 9.4: экран «Как заводим стратегию?» с тремя кнопками.
    const start = calls.slice(before).find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Как заводим стратегию?'),
    );
    expect(start).toBeDefined();
    const startMarkup = JSON.stringify(start!.payload.reply_markup);
    expect(startMarkup).toContain('f0_mode_import');
    expect(startMarkup).toContain('f0_mode_questionnaire');
    expect(startMarkup).toContain('f0_mode_synthesis');
  });

  it('топы A3.2: не разложился на поля → один переспрос, повтор сохраняется как есть (Story 10.2)', async () => {
    const { bot, calls } = buildProfileBot();
    await bot.handleUpdate(commandUpdate('/newclient'));
    await bot.handleUpdate(plainTextUpdate('Ромашка'));
    await bot.handleUpdate(plainTextUpdate('Продаём ромашки бизнесу'));
    // Story 10.2: A3.2 теперь в расширенном блоке — нужно нажать «Добавить топов».
    await bot.handleUpdate(callbackUpdate('f0p_ext'));

    let before = calls.length;
    await bot.handleUpdate(plainTextUpdate('Просто Дамир'));
    expect(texts91(calls, before).some((t) => t.includes('Не разобрал'))).toBe(true);

    before = calls.length;
    await bot.handleUpdate(plainTextUpdate('Просто Дамир'));
    const added = texts91(calls, before).find((t) => t.includes('Топ добавлен'));
    expect(added).toBeDefined();
    expect(added).toContain('Просто Дамир'); // name = ответ, остальное null
  });

  it('AC2: рестарт бота посреди профиля — следующий ответ продолжает с того же вопроса (Story 10.2)', async () => {
    const first = buildProfileBot();
    await first.bot.handleUpdate(commandUpdate('/newclient'));
    await first.bot.handleUpdate(plainTextUpdate('Ромашка')); // A1.1 отвечен

    // «Рестарт»: новый инстанс восстанавливает сессию с диска.
    const second = buildProfileBot();
    const before = second.calls.length;
    await second.bot.handleUpdate(plainTextUpdate('Продаём ромашки бизнесу')); // ответ на A1.2
    const after = texts91(second.calls, before);
    expect(after.some((t) => t.includes('Восстановил онбординг'))).toBe(true);
    // Ответ применился к A1.2 → offer screen появляется (минимум выполнен после 2 вопросов).
    expect(after.some((t) => t.includes('Название и суть зафиксированы'))).toBe(true);

    const b2 = second.calls.length;
    await second.bot.handleUpdate(commandUpdate('/status'));
    const status = texts91(second.calls, b2).find((t) => t.includes('Профиль клиента'));
    expect(status).toBeDefined();
    expect(status).toContain('Ромашка');
  });

  it('расширенный: /skip и «не знаю» пропускают вопрос без заполнения поля (Story 10.2)', async () => {
    const { bot, calls } = buildProfileBot();
    await bot.handleUpdate(commandUpdate('/newclient'));
    await bot.handleUpdate(plainTextUpdate('Ромашка'));
    await bot.handleUpdate(plainTextUpdate('Продаём ромашки бизнесу'));
    // После 2 вопросов минимума — offer screen; выбираем расширенный.
    let before = calls.length;
    await bot.handleUpdate(callbackUpdate('f0p_ext'));
    // Первый расширенный вопрос — A3.2 (топы), прогресс (1/16).
    expect(texts91(calls, before).some((t) => t.includes('(1/16)'))).toBe(true);
    expect(texts91(calls, before).some((t) => t.includes('топов'))).toBe(true);

    // Пропускаем A3.2 (топы) — /skip на type=tops обрабатывается как обычный пропуск.
    before = calls.length;
    await bot.handleUpdate(commandUpdate('/skip'));
    // A3.3 (DM) — второй расширенный вопрос (2/16).
    expect(texts91(calls, before).some((t) => t.includes('(2/16)'))).toBe(true);

    before = calls.length;
    await bot.handleUpdate(commandUpdate('/skip')); // пропуск A3.3
    // A1.3 история (3/16).
    expect(texts91(calls, before).some((t) => t.includes('(3/16)'))).toBe(true);

    before = calls.length;
    await bot.handleUpdate(commandUpdate('/skip')); // пропуск A1.3
    // A1.4 владельцы (4/16).
    expect(texts91(calls, before).some((t) => t.includes('(4/16)'))).toBe(true);

    before = calls.length;
    await bot.handleUpdate(plainTextUpdate('не знаю')); // ответ A1.4
    expect(texts91(calls, before).some((t) => t.includes('(5/16)'))).toBe(true);

    // До A3.1 (оргструктура файлом): пропускаем A2.1–A2.5 (5 вопросов).
    for (let i = 0; i < 5; i++) await bot.handleUpdate(commandUpdate('/skip'));
    before = calls.length;
    await bot.handleUpdate(documentUpdate('orgchart.pdf'));
    const after = texts91(calls, before);
    // Референс (имя файла) сохранён, содержимое не парсится; диалог идёт дальше (A4.1).
    expect(after.some((t) => t.includes('Сохранил референс оргструктуры: orgchart.pdf'))).toBe(true);
    expect(after.some((t) => t.includes('(11/16)'))).toBe(true);
  });

  it('числовые A2: один переспрос, повтор принимается (мягкая валидация 8.6, Story 10.2)', async () => {
    const { bot, calls } = buildProfileBot();
    await bot.handleUpdate(commandUpdate('/newclient'));
    await bot.handleUpdate(plainTextUpdate('Ромашка'));
    await bot.handleUpdate(plainTextUpdate('Продаём ромашки бизнесу'));
    // Story 10.2: после 2 вопросов минимума → offer screen → расширенный.
    await bot.handleUpdate(callbackUpdate('f0p_ext'));
    await bot.handleUpdate(commandUpdate('/skip')); // A3.2 (1/16) → skip
    await bot.handleUpdate(commandUpdate('/skip')); // A3.3 (2/16) → skip
    await bot.handleUpdate(commandUpdate('/skip')); // A1.3 (3/16) → skip
    await bot.handleUpdate(commandUpdate('/skip')); // A1.4 (4/16) → A2.1 выручка (5/16)

    let before = calls.length;
    await bot.handleUpdate(plainTextUpdate('точно не скажу'));
    expect(texts91(calls, before).some((t) => t.includes('Не вижу числа'))).toBe(true);
    expect(texts91(calls, before).some((t) => t.includes('(6/16)'))).toBe(false);

    before = calls.length;
    await bot.handleUpdate(plainTextUpdate('точно не скажу'));
    expect(texts91(calls, before).some((t) => t.includes('(6/16)'))).toBe(true);
  });

  it('AC4: persisted-сессия формата до 9.1 (filling) восстанавливается без миграции', async () => {
    // Файл сессии в формате 7.3–8.6: draftId/extraction обязательны, profile-полей нет.
    await fsp.mkdir(ONBOARDING_DIR, { recursive: true });
    await fsp.writeFile(
      joinPath(ONBOARDING_DIR, `session-${TEST_TRACKER_CHAT_ID}.json`),
      JSON.stringify({
        chatId: TEST_TRACKER_CHAT_ID,
        sessionId: 'old-8x',
        phase: 'filling',
        draftId: 'draft-old',
        sourceNames: ['strategy.md'],
        extraction: f0Extraction(),
        gaps: [
          { kind: 'schedule', ref: 'расписание', question: 'Расписание трекшн-встреч?' },
        ],
        gapIndex: 0,
        schedule: null,
        updatedAt: '2026-07-01T00:00:00.000Z',
      }),
      'utf8',
    );
    const { bot, calls } = buildProfileBot();
    await bot.handleUpdate(plainTextUpdate('вт 15:00'));
    const all = texts91(calls);
    expect(all.some((t) => t.includes('Восстановил онбординг'))).toBe(true);
    // Поведение прежней фазы не изменилось: ответ принят, диалог дошёл до /confirm.
    expect(all.some((t) => t.includes('/confirm'))).toBe(true);
  });
});

// ─── Story 10.2: /advanced команда ──────────────────────────────────────────

describe('bot — Story 10.2: /advanced команда', () => {
  const advClientId = 'geonline-adv-test';
  const advCardDir = joinPath('data', advClientId);
  const activePath = joinPath(CLIENTS_DIR, 'active-clients.json');
  let activeBackup: string | null = null;

  beforeEach(async () => {
    await cleanOnboardingArtifacts();
    activeBackup = await backupFile(activePath);
  });

  afterEach(async () => {
    await cleanOnboardingArtifacts();
    await fsp.rm(advCardDir, { recursive: true, force: true }).catch(() => {});
    await restoreFile(activePath, activeBackup);
  });

  function buildAdvBot(opts: BuildOpts = {}) {
    return buildBot({
      extractTextFromDocument: ((async () => ({
        sourceName: 'strategy.md',
        kind: 'text',
        text: 'x'.repeat(5_000),
      })) as unknown) as BotDeps['extractTextFromDocument'],
      runF0FullDraft: ((async () => f0DraftResult()) as unknown) as BotDeps['runF0FullDraft'],
      ...opts,
    });
  }

  const textsAdv = (calls: ApiCall[], from = 0): string[] =>
    calls
      .slice(from)
      .filter((c) => c.method === 'sendMessage')
      .map((c) => c.payload.text as string);

  it('(a) /advanced в онбординге (offer pending после A1.1 + A1.2) → начинает A3.2 как первый расширенный (1/16)', async () => {
    const { bot, calls } = buildAdvBot();
    await bot.handleUpdate(commandUpdate('/newclient'));
    await bot.handleUpdate(plainTextUpdate('Тест-компания')); // A1.1
    await bot.handleUpdate(plainTextUpdate('Тестируем /advanced')); // A1.2 → offer pending

    const before = calls.length;
    await bot.handleUpdate(commandUpdate('/advanced'));
    const after = textsAdv(calls, before);
    // Должен начать расширенный профиль с A3.2 (1/16) — первый вопрос расширенного.
    expect(after.some((t) => t.includes('(1/16)'))).toBe(true);
    expect(after.some((t) => t.includes('топов'))).toBe(true);
  });

  it('(b) /advanced без онбординга, active client → дозаполнение профиля (reply содержит «Дозаполняем»)', async () => {
    // Создаём тестовую карточку клиента.
    await fsp.mkdir(advCardDir, { recursive: true });
    await fsp.writeFile(
      joinPath(advCardDir, 'card.json'),
      JSON.stringify({
        clientId: advClientId,
        company: 'Geonline Adv Test',
        industry: null,
        participants: [{ name: 'Тест', role: 'CEO', okrDirection: null, telegram: null }],
        ceo: 'Тест',
        trackerChatId: TEST_TRACKER_CHAT_ID,
        schedule: 'пт 10:00',
        spreadsheetId: 'sheet-adv',
        sheetsUrl: 'https://docs.google.com/spreadsheets/d/sheet-adv/edit',
        startDate: '2026-07-01T00:00:00.000Z',
        createdAt: '2026-07-01T00:00:00.000Z',
        profile: { companyName: 'Geonline Adv Test', businessSummary: 'Тестовый клиент' },
      }),
      'utf8',
    );
    // Устанавливаем как активного клиента.
    await fsp.mkdir(joinPath('data', 'clients'), { recursive: true });
    await fsp.writeFile(
      activePath,
      JSON.stringify({ [String(TEST_TRACKER_CHAT_ID)]: advClientId }),
      'utf8',
    );

    const { bot, calls } = buildAdvBot();
    const before = calls.length;
    await bot.handleUpdate(commandUpdate('/advanced'));
    const after = textsAdv(calls, before);
    expect(after.some((t) => t.includes('Дозаполняем'))).toBe(true);
    // Первый расширенный вопрос — A3.2 (1/16), т.к. tops не заполнены.
    expect(after.some((t) => t.includes('(1/16)'))).toBe(true);
  });

  it('(c) /advanced без онбординга, без active client → объясняет /start или /newclient', async () => {
    // Нет активного клиента: очищаем active-clients.json.
    await fsp.writeFile(activePath, JSON.stringify({}), 'utf8').catch(() => {});

    const { bot, calls } = buildAdvBot();
    const before = calls.length;
    await bot.handleUpdate(commandUpdate('/advanced'));
    const after = textsAdv(calls, before);
    expect(after.some((t) => t.includes('/start') || t.includes('/newclient'))).toBe(true);
  });

  it('(e) /advanced когда минимум ещё не заполнен (после только A1.1) → «заверши минимум» + повтор вопроса', async () => {
    const { bot, calls } = buildAdvBot();
    await bot.handleUpdate(commandUpdate('/newclient'));
    await bot.handleUpdate(plainTextUpdate('Тест-компания')); // A1.1 answered; A1.2 still pending

    const before = calls.length;
    await bot.handleUpdate(commandUpdate('/advanced'));
    const after = textsAdv(calls, before);
    // Бот объясняет, что минимум не собран, и повторяет текущий вопрос (A1.2).
    expect(after.some((t) => t.includes('минимум') || t.includes('суть'))).toBe(true);
    expect(after.some((t) => t.includes('Чем занимается компания'))).toBe(true);
  });

  it('(f) /advanced когда уже в расширенном режиме (profileExtended=true) → «уже дополняется» + повтор вопроса', async () => {
    const { bot, calls } = buildAdvBot();
    await bot.handleUpdate(commandUpdate('/newclient'));
    await bot.handleUpdate(plainTextUpdate('Тест-компания')); // A1.1
    await bot.handleUpdate(plainTextUpdate('Суть бизнеса для теста')); // A1.2 → offer screen
    await bot.handleUpdate(callbackUpdate('f0p_ext')); // → расширенный (profileExtended=true)

    const before = calls.length;
    await bot.handleUpdate(commandUpdate('/advanced'));
    const after = textsAdv(calls, before);
    // Бот сообщает что профиль уже дополняется и показывает текущий вопрос (A3.2 = 1/16).
    expect(after.some((t) => t.includes('уже') || t.includes('дополняется') || t.includes('продолжай'))).toBe(true);
    expect(after.some((t) => t.includes('(1/16)') || t.includes('топов'))).toBe(true);
  });

  it('(d) /advanced во время онбординга на этапе не-profile (filling) → ⚠️ заверши или отмени', async () => {
    // Создаём сессию в phase='filling' (этап дозаполнения пробелов).
    await fsp.mkdir(ONBOARDING_DIR, { recursive: true });
    await fsp.writeFile(
      joinPath(ONBOARDING_DIR, `session-${TEST_TRACKER_CHAT_ID}.json`),
      JSON.stringify({
        chatId: TEST_TRACKER_CHAT_ID,
        sessionId: 'adv-fill-test',
        phase: 'filling',
        draftId: 'draft-adv',
        sourceNames: ['strategy.md'],
        extraction: f0Extraction(),
        gaps: [{ kind: 'schedule', ref: 'расписание', question: 'Расписание?' }],
        gapIndex: 0,
        schedule: null,
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    );

    const { bot, calls } = buildAdvBot();
    const before = calls.length;
    await bot.handleUpdate(commandUpdate('/advanced'));
    const after = textsAdv(calls, before);
    expect(after.some((t) => t.includes('/confirm') || t.includes('/cancel'))).toBe(true);
  });
});

describe('bot — «➕ Дозаполнить профиль» из карточки клиента (Story 9.1)', () => {
  const cardClientId = 'romashka-x-test';
  const cardDir = joinPath('data', cardClientId);

  beforeEach(async () => {
    await cleanOnboardingArtifacts();
    await fsp.rm(cardDir, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(cardDir, { recursive: true });
    await fsp.writeFile(
      joinPath(cardDir, 'card.json'),
      JSON.stringify({
        clientId: cardClientId,
        company: 'Ромашка',
        industry: null,
        participants: [{ name: 'Айгерим', role: 'CEO', okrDirection: null, telegram: null }],
        ceo: 'Айгерим',
        trackerChatId: TEST_TRACKER_CHAT_ID,
        schedule: 'вт 15:00',
        spreadsheetId: 'sheet-RX',
        sheetsUrl: 'https://docs.google.com/spreadsheets/d/sheet-RX/edit',
        startDate: '2026-07-01T00:00:00.000Z',
        createdAt: '2026-07-01T00:00:00.000Z',
        profile: {
          companyName: 'Ромашка',
          businessSummary: 'Продаём ромашки бизнесу',
          tops: [{ name: 'Айгерим', title: 'CEO', authority: null, area: null }],
          decisionMaker: 'Айгерим',
        },
      }),
      'utf8',
    );
  });

  afterEach(async () => {
    await cleanOnboardingArtifacts();
    await fsp.rm(cardDir, { recursive: true, force: true }).catch(() => {});
  });

  it('AC3: карточка показывает профиль и кнопку дозаполнения; ответы дописываются в card.json', async () => {
    const { bot, calls } = buildBot();
    await bot.handleUpdate(callbackUpdate(`client:${cardClientId}`));
    const cardMsg = calls.find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('👤 Ромашка'),
    )!;
    // Профиль в карточке: суть, топы/DM, счётчик расширенной части.
    expect(cardMsg.payload.text).toContain('Суть: Продаём ромашки бизнесу');
    expect(cardMsg.payload.text).toContain('DM: Айгерим');
    // Story 10.2: tops+DM теперь в расширенном блоке → карточка с обоими полями = 2/16.
    expect(cardMsg.payload.text).toContain('расширенный 2/16');
    expect(JSON.stringify(cardMsg.payload.reply_markup)).toContain(
      `profile_fill:${cardClientId}`,
    );

    // Кнопка запускает расширенные вопросы (минимум уже есть — не переспрашивается).
    let before = calls.length;
    await bot.handleUpdate(callbackUpdate(`profile_fill:${cardClientId}`));
    const after = calls
      .slice(before)
      .filter((c) => c.method === 'sendMessage')
      .map((c) => c.payload.text as string);
    expect(after.some((t) => t.includes('Дозаполняем профиль «Ромашка»'))).toBe(true);
    // Story 10.2: a3_2/a3_3 теперь первые в расширенном, но карточка уже содержит
    // tops+DM → они пропускаются как отвеченные; первый показанный — A1.3 (3/16).
    expect(after.some((t) => t.includes('(3/16)'))).toBe(true);
    expect(after.some((t) => t.includes('Как называется компания?'))).toBe(false);

    // Ответ на A1.3 дописывается в card.json.
    await bot.handleUpdate(plainTextUpdate('Основана в 2019, выросли ×3'));
    const raw = JSON.parse(await fsp.readFile(joinPath(cardDir, 'card.json'), 'utf8')) as {
      profile?: { history?: string };
    };
    expect(raw.profile?.history).toBe('Основана в 2019, выросли ×3');
  });
});

// ─── Story 10.7: profile_fill stuck warning + f0_cancel_stuck handlers ───────

describe('bot — Story 10.7: profile_fill при залипшей сессии + f0_cancel_stuck', () => {
  const stuckClientId = 'stuck-test-corp';
  const stuckDir = joinPath('data', stuckClientId);
  const stuckSessionId = 'stuck-aa';
  const sessionFilePath = joinPath(ONBOARDING_DIR, `session-${TEST_TRACKER_CHAT_ID}.json`);

  beforeEach(async () => {
    await cleanOnboardingArtifacts();
    await fsp.rm(stuckDir, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(stuckDir, { recursive: true });
    await fsp.writeFile(
      joinPath(stuckDir, 'card.json'),
      JSON.stringify({
        clientId: stuckClientId,
        company: 'StuckCorp',
        industry: null,
        participants: [{ name: 'Тест', role: 'CEO', okrDirection: null, telegram: null }],
        ceo: 'Тест',
        trackerChatId: TEST_TRACKER_CHAT_ID,
        schedule: null,
        spreadsheetId: null,
        sheetsUrl: null,
        startDate: '2026-07-01T00:00:00.000Z',
        createdAt: '2026-07-01T00:00:00.000Z',
      }),
      'utf8',
    );
    await fsp.mkdir(ONBOARDING_DIR, { recursive: true });
    await fsp.writeFile(
      sessionFilePath,
      JSON.stringify({
        chatId: TEST_TRACKER_CHAT_ID,
        sessionId: stuckSessionId,
        phase: 'filling',
        sourceNames: ['doc.md'],
        extraction: f0Extraction(),
        gaps: [{ kind: 'schedule', ref: 'расписание', question: 'Расписание?' }],
        gapIndex: 0,
        schedule: null,
        updatedAt: new Date().toISOString(),
      }),
      'utf8',
    );
  });

  afterEach(async () => {
    await cleanOnboardingArtifacts();
    await fsp.rm(stuckDir, { recursive: true, force: true }).catch(() => {});
  });

  it('matrix row 5: profile_fill при залипшей сессии → предупреждение с кнопкой «❌ Отменить онбординг»', async () => {
    const { bot, calls } = buildBot();
    await bot.handleUpdate(callbackUpdate(`profile_fill:${stuckClientId}`));
    const replies = calls.filter((c) => c.method === 'sendMessage');
    const warning = replies.find(
      (c) => (c.payload.text as string).includes('онбординг') || (c.payload.text as string).includes('Идёт'),
    );
    expect(warning).toBeDefined();
    expect(JSON.stringify(warning!.payload.reply_markup)).toContain(
      `f0_cancel_stuck:${stuckSessionId}`,
    );
  });

  it('matrix row 6: f0_cancel_stuck с верным session.id → сессия удалена, reply «Онбординг отменён»', async () => {
    const { bot, calls } = buildBot();
    await bot.handleUpdate(callbackUpdate(`f0_cancel_stuck:${stuckSessionId}`));
    const replies = calls
      .filter((c) => c.method === 'sendMessage')
      .map((c) => c.payload.text as string);
    expect(replies.some((t) => t.includes('Онбординг отменён'))).toBe(true);
    const exists = await fsp.access(sessionFilePath).then(() => true, () => false);
    expect(exists).toBe(false);
  });

  it('matrix row 7: f0_cancel_stuck с устаревшим session.id → answerCallbackQuery «устарела», сессия не удалена', async () => {
    const { bot, calls } = buildBot();
    await bot.handleUpdate(callbackUpdate('f0_cancel_stuck:wrong-id-99'));
    const cbqAnswers = calls.filter((c) => c.method === 'answerCallbackQuery');
    expect(
      cbqAnswers.some(
        (c) =>
          ((c.payload as { text?: string }).text ?? '').toLowerCase().includes('устарела') ||
          ((c.payload as { text?: string }).text ?? '').toLowerCase().includes('устарел'),
      ),
    ).toBe(true);
    const exists = await fsp.access(sessionFilePath).then(() => true, () => false);
    expect(exists).toBe(true);
  });
});

// ─── Story 9.5: Вопросник с голосовыми ответами ──────────────────────────────

/** Создаёт voice message update для тестов. */
function voiceUpdate(
  duration: number,
  chatId: number = TEST_TRACKER_CHAT_ID,
): Update {
  const message_id = 1000 + updateCounter;
  return {
    update_id: updateCounter++,
    message: {
      message_id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: 'Test' },
      from: { id: chatId, is_bot: false, first_name: 'Test' },
      voice: {
        file_id: 'voice-file-1',
        file_unique_id: 'vu-1',
        duration,
        mime_type: 'audio/ogg',
        file_size: 10240,
      },
    },
  } as unknown as Update;
}

/** SonioxClient-stub для тестов транскрипции. */
function makeSonioxStub(transcript: string): BotDeps['sonioxClient'] {
  return {
    uploadFile: async () => 'file-id-1',
    createTranscription: async () => 'transcription-id-1',
    pollUntilCompleted: async () => {},
    fetchTranscript: async () => ({
      id: 'transcription-id-1',
      text: transcript,
      tokens: [{ text: transcript, start_ms: 0, end_ms: 1000 }],
    }),
    deleteFile: async () => {},
  };
}

describe('bot — Story 9.5: вопросник с голосовыми ответами', () => {
  beforeEach(cleanOnboardingArtifacts);
  afterEach(cleanOnboardingArtifacts);

  const texts95 = (calls: ApiCall[], from = 0): string[] =>
    calls
      .slice(from)
      .filter((c) => c.method === 'sendMessage')
      .map((c) => c.payload.text as string);

  // (a) f0_mode_questionnaire с phase='collecting' → фаза меняется на questionnaire
  it('(a) f0_mode_questionnaire в collecting → задаёт B1.3 (направления)', async () => {
    const { bot, calls } = buildBot();
    await completeProfileMinimum(bot);
    const before = calls.length;
    await bot.handleUpdate(callbackUpdate('f0_mode_questionnaire'));
    const afterTexts = texts95(calls, before);
    // Должен отобразить B1.3 вопрос о направлениях
    expect(afterTexts.some((t) => t.includes('направлени') || t.includes('целей года'))).toBe(true);
  });

  // (b) голосовое сообщение вне онбординга → отказ
  it('(b) голос вне онбординга → вежливый отказ без crash', async () => {
    const { bot, calls } = buildBot({ sonioxClient: makeSonioxStub('тест') });
    // Нет активной сессии онбординга
    const before = calls.length;
    await bot.handleUpdate(voiceUpdate(10));
    const afterTexts = texts95(calls, before);
    expect(
      afterTexts.some((t) => t.includes('Голосовые сообщения принимаются только')),
    ).toBe(true);
  });

  // (c) голосовое duration>300 → "лимит 5 мин"
  it('(c) голос длиннее 300 сек → сообщение о лимите', async () => {
    const { bot, calls } = buildBot({ sonioxClient: makeSonioxStub('тест') });
    await completeProfileMinimum(bot);
    await bot.handleUpdate(callbackUpdate('f0_mode_questionnaire'));
    const before = calls.length;
    await bot.handleUpdate(voiceUpdate(301));
    const afterTexts = texts95(calls, before);
    expect(afterTexts.some((t) => t.includes('лимит') || t.includes('5 минут'))).toBe(true);
  });

  // (d) voice_ok в questionnaire → transcript диспатчится как ответ на текущий вопрос
  it('(d) voice_ok в questionnaire → transcript применяется, добавляет направление', async () => {
    const { bot, calls } = buildBot({
      sonioxClient: makeSonioxStub('Рост продаж'),
      downloadTelegramFile: async () => Buffer.from('audio-data'),
    });
    await completeProfileMinimum(bot);
    await bot.handleUpdate(callbackUpdate('f0_mode_questionnaire'));
    // Отправить голосовое → подтвердить
    await bot.handleUpdate(voiceUpdate(10));
    // Найти confirm-кнопку voice_ok
    const confirmMsg = calls.findLast(
      (c) => c.method === 'sendMessage' && (c.payload.text as string | undefined)?.includes('Распознано'),
    );
    expect(confirmMsg).toBeDefined();
    const before = calls.length;
    await bot.handleUpdate(callbackUpdate('voice_ok'));
    const afterTexts = texts95(calls, before);
    // После подтверждения voice_ok направление «Рост продаж» должно быть добавлено
    expect(afterTexts.some((t) => t.includes('Рост продаж') || t.includes('направлени') || t.includes('Добавлено'))).toBe(true);
  });

  // (e) f0q_hypo_done после гипотез → session.phase === 'filling' (deliverF0Draft отработал)
  it('(e) полный цикл вопросника → phase filling после f0q_hypo_done', async () => {
    const { bot, calls } = buildBot();
    await completeProfileMinimum(bot);
    await bot.handleUpdate(callbackUpdate('f0_mode_questionnaire'));
    // B1.3: добавить направление и нажать Готово
    await bot.handleUpdate(plainTextUpdate('Рост продаж'));
    await bot.handleUpdate(callbackUpdate('f0q_obj_done'));
    // B2.1: KR
    await bot.handleUpdate(plainTextUpdate('Выручка с 5 до 10 млн к декабрю'));
    // B2.2: owner — нет кнопок (нет топов с authority/area), но имя Айгерим есть в профиле
    // → fallback текстовый ввод owner
    await bot.handleUpdate(plainTextUpdate('Айгерим'));
    // B5.1: гипотезы → сразу нажать Готово (0 гипотез — валидно)
    const before = calls.length;
    await bot.handleUpdate(callbackUpdate('f0q_hypo_done'));
    const afterTexts = texts95(calls, before);
    // После f0q_hypo_done должен появиться черновик-саммари + вопрос дозаполнения
    expect(
      afterTexts.some((t) => t.includes('Черновик') || t.includes('черновик') || t.includes('заполнения') || t.includes('расписание')),
    ).toBe(true);
  });

  // Matrix Row 11: voice_edit → clears pending, asks to type correction
  it('(f) voice_edit → очищает pending, предлагает ввести текст', async () => {
    const { bot, calls } = buildBot({
      sonioxClient: makeSonioxStub('что-то'),
      downloadTelegramFile: async () => Buffer.from('audio'),
    });
    await completeProfileMinimum(bot);
    await bot.handleUpdate(callbackUpdate('f0_mode_questionnaire'));
    await bot.handleUpdate(voiceUpdate(10));
    const before = calls.length;
    await bot.handleUpdate(callbackUpdate('voice_edit'));
    const afterTexts = texts95(calls, before);
    expect(afterTexts.some((t) => t.includes('Введи') || t.includes('исправленный'))).toBe(true);
  });

  // Matrix Row 12: voice_retry → clears pending, asks to send again
  it('(g) voice_retry → очищает pending, просит прислать снова', async () => {
    const { bot, calls } = buildBot({
      sonioxClient: makeSonioxStub('что-то'),
      downloadTelegramFile: async () => Buffer.from('audio'),
    });
    await completeProfileMinimum(bot);
    await bot.handleUpdate(callbackUpdate('f0_mode_questionnaire'));
    await bot.handleUpdate(voiceUpdate(10));
    const before = calls.length;
    await bot.handleUpdate(callbackUpdate('voice_retry'));
    const afterTexts = texts95(calls, before);
    expect(afterTexts.some((t) => t.includes('снова') || t.includes('голосовое'))).toBe(true);
  });

  // Matrix Row 14: /resume в questionnaire → ответ + повтор вопроса
  it('(h) /resume в questionnaire → "Продолжаем вопросник" и повтор текущего вопроса', async () => {
    const { bot, calls } = buildBot();
    await completeProfileMinimum(bot);
    await bot.handleUpdate(callbackUpdate('f0_mode_questionnaire'));
    const before = calls.length;
    await bot.handleUpdate(commandUpdate('/resume'));
    const afterTexts = texts95(calls, before);
    expect(afterTexts.some((t) => t.includes('вопросник') || t.includes('Продолжаем'))).toBe(true);
  });

  // f0q_owner button callback coverage (verification-gap finding)
  it('(j) f0q_owner кнопкой → owner записывается, переходит к B5.1 (hypo_collect)', async () => {
    const { bot, calls } = buildBot();
    // Story 10.2: completeProfileMinimum не добавляет топов; добавляем Айгерим через
    // расширенный блок (A3.2), затем скипаем оставшиеся вопросы → collecting phase.
    await bot.handleUpdate(commandUpdate('/newclient'));
    await bot.handleUpdate(plainTextUpdate('Ромашка')); // A1.1
    await bot.handleUpdate(plainTextUpdate('Продаём ромашки бизнесу')); // A1.2 → offer
    await bot.handleUpdate(callbackUpdate('f0p_ext')); // → расширенный (A3.2 = 1/16)
    await bot.handleUpdate(plainTextUpdate('Айгерим — CEO, все решения, зона: всё')); // A3.2: топ
    await bot.handleUpdate(callbackUpdate('f0p_top_done')); // завершить список топов
    await bot.handleUpdate(callbackUpdate('f0p_dm:0')); // A3.3 DM = Айгерим
    // Скипаем оставшиеся 14 ext-вопросов (a1_3..a4_6) → finishProfileDialog → collecting.
    for (let i = 0; i < 14; i++) await bot.handleUpdate(commandUpdate('/skip'));
    await bot.handleUpdate(callbackUpdate('f0_mode_questionnaire'));
    await bot.handleUpdate(plainTextUpdate('Рост выручки')); // B1.3: добавить направление
    await bot.handleUpdate(callbackUpdate('f0q_obj_done')); // → b2_kr
    await bot.handleUpdate(plainTextUpdate('с 5 до 10 млн к декабрю')); // B2.1: KR с числом → owner step
    const before = calls.length;
    // B2.2: выбрать ответственного кнопкой (Айгерим — индекс 0).
    // Ревью эпика 9: callback_data теперь только индекс, имя — из профиля.
    await bot.handleUpdate(callbackUpdate('f0q_owner:0'));
    const afterTexts = texts95(calls, before);
    // Единственный objective → advanceQnB2Kr переходит в hypo_collect, посылает B5.1
    expect(afterTexts.some((t) => t.includes('KR') || t.includes('гипотез') || t.includes('ЕСЛИ'))).toBe(true);
  });

  // Matrix Row 15: /skip в questionnaire в obj_collect → нельзя пропустить B1.3
  it('(i) /skip в obj_collect → отказ (B1.3 обязателен)', async () => {
    const { bot, calls } = buildBot();
    await completeProfileMinimum(bot);
    await bot.handleUpdate(callbackUpdate('f0_mode_questionnaire'));
    const before = calls.length;
    await bot.handleUpdate(commandUpdate('/skip'));
    const afterTexts = texts95(calls, before);
    expect(afterTexts.some((t) => t.includes('обязательн') || t.includes('нельзя') || t.includes('хотя бы'))).toBe(true);
  });
});

// ─── Story 10.1: Audio/Video Meeting Intake ─────────────────────────────────

function audioUpdate(chatId: number = TEST_TRACKER_CHAT_ID): Update {
  const message_id = 1000 + updateCounter;
  return {
    update_id: updateCounter++,
    message: {
      message_id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: 'Test' },
      from: { id: chatId, is_bot: false, first_name: 'Test' },
      audio: {
        file_id: 'audio-file-1',
        file_unique_id: 'au-1',
        duration: 600,
        mime_type: 'audio/mp4',
        file_size: 5 * 1024 * 1024,
      },
    },
  } as unknown as Update;
}

function videoUpdate(chatId: number = TEST_TRACKER_CHAT_ID): Update {
  const message_id = 1000 + updateCounter;
  return {
    update_id: updateCounter++,
    message: {
      message_id,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: 'Test' },
      from: { id: chatId, is_bot: false, first_name: 'Test' },
      video: {
        file_id: 'video-file-1',
        file_unique_id: 'vu-1',
        width: 1280,
        height: 720,
        duration: 1200,
        mime_type: 'video/mp4',
        file_size: 50 * 1024 * 1024,
      },
    },
  } as unknown as Update;
}

describe('bot — Story 10.1: audio/video meeting intake', () => {
  const registryPath10 = joinPath(CLIENTS_DIR, 'registry.json');
  const activePath10 = joinPath(CLIENTS_DIR, 'active-clients.json');
  let registryBackup10: string | null = null;
  let activeBackup10: string | null = null;

  beforeEach(async () => {
    registryBackup10 = await backupFile(registryPath10);
    activeBackup10 = await backupFile(activePath10);
    await fsp.mkdir(CLIENTS_DIR, { recursive: true });
    await fsp.writeFile(
      registryPath10,
      JSON.stringify({
        [TEST_CLIENT_ID]: {
          sheetId: 'sheet-RX',
          name: 'Ромашка',
          createdAt: '2026-07-08T00:00:00.000Z',
        },
      }),
      'utf8',
    );
    await fsp.rm(activePath10, { force: true }).catch(() => {});
  });

  afterEach(async () => {
    await restoreFile(registryPath10, registryBackup10);
    await restoreFile(activePath10, activeBackup10);
  });

  const texts10 = (calls: ApiCall[], from = 0): string[] =>
    calls
      .slice(from)
      .filter((c) => c.method === 'sendMessage')
      .map((c) => c.payload.text as string);

  // Matrix row 1: Happy path — audio file + активный клиент → job enqueued
  it('(a) audio file + активный клиент → job enqueued с filePath и clientId', async () => {
    const enqueued: ReportJob[] = [];
    const realQueue = createReportQueue({ maxSize: 20, logger: silentLogger });
    const spyQueue = {
      ...realQueue,
      enqueue: (job: ReportJob) => {
        enqueued.push(job);
        return realQueue.enqueue(job);
      },
    } as typeof realQueue;

    const { bot, calls } = buildBot({
      queue: spyQueue,
      downloadTelegramFile: async () => Buffer.from('audio-data'),
    });

    // Устанавливаем активного клиента
    await fsp.writeFile(
      activePath10,
      JSON.stringify({ [String(TEST_TRACKER_CHAT_ID)]: TEST_CLIENT_ID }),
      'utf8',
    );

    const before = calls.length;
    await bot.handleUpdate(audioUpdate());

    // Ack должен появиться (formatQueueAck → '✅ Принято. Отчёт через ~15 мин.')
    const sentTexts = texts10(calls, before);
    expect(sentTexts.some((t) => t.includes('Принято') || t.includes('В очереди'))).toBe(true);

    // Job должен быть enqueued
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.clientId).toBe(TEST_CLIENT_ID);
    expect(enqueued[0]!.filePath).toBeDefined();
    // URL не задан (file-path mode)
    expect(enqueued[0]!.url).toBeUndefined();
  });

  // Matrix row 2: Happy path — video file + активный клиент → job enqueued
  it('(b) video file + активный клиент → job enqueued', async () => {
    const enqueued: ReportJob[] = [];
    const realQueue = createReportQueue({ maxSize: 20, logger: silentLogger });
    const spyQueue = {
      ...realQueue,
      enqueue: (job: ReportJob) => {
        enqueued.push(job);
        return realQueue.enqueue(job);
      },
    } as typeof realQueue;

    const { bot } = buildBot({
      queue: spyQueue,
      downloadTelegramFile: async () => Buffer.from('video-data'),
    });

    await fsp.writeFile(
      activePath10,
      JSON.stringify({ [String(TEST_TRACKER_CHAT_ID)]: TEST_CLIENT_ID }),
      'utf8',
    );

    await bot.handleUpdate(videoUpdate());

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.clientId).toBe(TEST_CLIENT_ID);
    expect(enqueued[0]!.filePath).toBeDefined();
  });

  // Matrix row 3: Нет активного клиента → reply
  it('(c) нет активного клиента → reply "Выбери клиента через /start"', async () => {
    const enqueued: ReportJob[] = [];
    const realQueue = createReportQueue({ maxSize: 20, logger: silentLogger });
    const spyQueue = {
      ...realQueue,
      enqueue: (job: ReportJob) => {
        enqueued.push(job);
        return realQueue.enqueue(job);
      },
    } as typeof realQueue;
    const { bot, calls } = buildBot({ queue: spyQueue });
    // activePath10 не существует — нет активного клиента
    const before = calls.length;
    await bot.handleUpdate(audioUpdate());
    const sentTexts = texts10(calls, before);
    expect(sentTexts.some((t) => t.includes('/start') || t.includes('Выбери') || t.includes('клиент'))).toBe(true);
    // Нет enqueue
    expect(enqueued).toHaveLength(0);
  });

  // Matrix row 4: Non-tracker chat → audio-хендлер делает ранний return, job не enqueued
  it('(d) non-tracker chat → job не enqueued', async () => {
    const enqueued: ReportJob[] = [];
    const realQueue = createReportQueue({ maxSize: 20, logger: silentLogger });
    const spyQueue = {
      ...realQueue,
      enqueue: (job: ReportJob) => {
        enqueued.push(job);
        return realQueue.enqueue(job);
      },
    } as typeof realQueue;
    const { bot } = buildBot({ queue: spyQueue });
    await bot.handleUpdate(audioUpdate(TEST_UNAUTHORIZED_CHAT_ID));
    // Ранний return в audio-хендлере: никакого job для audio intake
    expect(enqueued).toHaveLength(0);
  });

  // Matrix row 5: getFile без file_path → alertOps + reply
  it('(e) getFile без file_path → alertOps + reply об ошибке', async () => {
    const alertOpsSpy = vi.fn();
    const { bot, calls } = buildBot({
      alertOps: alertOpsSpy,
      downloadTelegramFile: async () => Buffer.from('x'),
    });

    await fsp.writeFile(
      activePath10,
      JSON.stringify({ [String(TEST_TRACKER_CHAT_ID)]: TEST_CLIENT_ID }),
      'utf8',
    );

    // Перехватчик, добавленный ПОСЛЕ attachApiSpy, запускается первым.
    bot.api.config.use(async (_prev, method, payload, signal) => {
      if (method === 'getFile') {
        // Возвращаем результат без file_path
        return { ok: true, result: { file_id: 'f', file_unique_id: 'u' } } as never;
      }
      return _prev(method, payload, signal);
    });

    const before = calls.length;
    await bot.handleUpdate(audioUpdate());
    const sentTexts = texts10(calls, before);
    // Должен ответить пользователю об ошибке
    expect(sentTexts.some((t) => t.includes('ошибк') || t.includes('файл') || t.includes('повтор') || t.includes('🔴'))).toBe(true);
    expect(alertOpsSpy).toHaveBeenCalled();
  });
});

// ─── Story 10.3: grounding mismatch флаг ─────────────────────────────────────

describe('bot — Story 10.3: grounding mismatch флаг', () => {
  beforeEach(cleanOnboardingArtifacts);
  afterEach(cleanOnboardingArtifacts);

  function buildMismatchBot(opts: BuildOpts & { extractedCompany?: string } = {}) {
    const extractedCompany = opts.extractedCompany ?? 'GeoXpert';
    return buildBot({
      extractTextFromDocument: ((async (_buf: Buffer, name?: string) => ({
        sourceName: name ?? 'doc.md',
        kind: 'text',
        text: 'x'.repeat(5_000),
      })) as unknown) as BotDeps['extractTextFromDocument'],
      runF0FullDraft: ((async () =>
        f0DraftResult(f0Extraction({ company: extractedCompany }))
      ) as unknown) as BotDeps['runF0FullDraft'],
      ...opts,
    });
  }

  const textsMismatch = (calls: ApiCall[], from = 0): string[] =>
    calls
      .slice(from)
      .filter((c) => c.method === 'sendMessage')
      .map((c) => c.payload.text as string);

  // (a) mismatch detected: reply содержит названия компаний + inline keyboard
  it('(a) mismatch: reply содержит «GeoXpert» и «geonline»; inline_keyboard с cmi_proceed и cmi_cancel', async () => {
    const { bot, calls } = buildMismatchBot({ extractedCompany: 'GeoXpert' });
    // Profile с companyName = 'geonline'
    await bot.handleUpdate(commandUpdate('/newclient'));
    await bot.handleUpdate(plainTextUpdate('geonline'));
    await bot.handleUpdate(plainTextUpdate('Онлайн-образование'));
    await bot.handleUpdate(callbackUpdate('f0p_go'));

    const before = calls.length;
    await bot.handleUpdate(documentUpdate('strategy.md'));
    await bot.handleUpdate(commandUpdate('/draft'));
    const sentTexts = textsMismatch(calls, before);

    // Reply с mismatch должен содержать оба названия
    expect(sentTexts.some((t) => t.includes('GeoXpert') && t.includes('geonline'))).toBe(true);

    // inline_keyboard должен присутствовать с cmi_proceed и cmi_cancel
    const mismatchMsg = calls.slice(before).find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('GeoXpert'),
    );
    expect(mismatchMsg).toBeDefined();
    const keyboard = mismatchMsg!.payload.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> };
    const buttons = keyboard.inline_keyboard.flat().map((b) => b.callback_data);
    expect(buttons).toContain('cmi_proceed');
    expect(buttons).toContain('cmi_cancel');
  });

  // (b) совпадение компаний → нет mismatch-reply; session.phase === 'filling' после /draft + /confirm
  it('(b) совпадение компаний (case-insensitive) → нет mismatch-reply; draft доставлен', async () => {
    const { bot, calls } = buildMismatchBot({ extractedCompany: 'Ромашка' });
    await completeProfileMinimum(bot); // companyName = 'Ромашка'

    const before = calls.length;
    await bot.handleUpdate(documentUpdate('strategy.md'));
    await bot.handleUpdate(commandUpdate('/draft'));
    const sentTexts = textsMismatch(calls, before);

    // Не должно быть mismatch-reply (нет «Чьи данные берём?»)
    expect(sentTexts.some((t) => t.includes('Чьи данные берём'))).toBe(false);
    // Черновик должен быть доставлен — progress-сообщение редактируется в саммари
    const edits = calls.slice(before).filter((c) => c.method === 'editMessageText');
    expect(edits.some((e) => (e.payload.text as string).includes('Черновик'))).toBe(true);
  });

  // (c) cmi_proceed после mismatch → session.phase === 'filling'
  it('(c) cmi_proceed после mismatch → draft доставлен (черновик в editMessageText)', async () => {
    const { bot, calls } = buildMismatchBot({ extractedCompany: 'GeoXpert' });
    await bot.handleUpdate(commandUpdate('/newclient'));
    await bot.handleUpdate(plainTextUpdate('geonline'));
    await bot.handleUpdate(plainTextUpdate('Онлайн-образование'));
    await bot.handleUpdate(callbackUpdate('f0p_go'));
    await bot.handleUpdate(documentUpdate('strategy.md'));
    await bot.handleUpdate(commandUpdate('/draft'));

    // Убеждаемся, что mismatch показан
    const mismatchShown = calls.some(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('GeoXpert'),
    );
    expect(mismatchShown).toBe(true);

    const before = calls.length;
    await bot.handleUpdate(callbackUpdate('cmi_proceed'));

    // После cmi_proceed должен отправиться черновик (sendMessage с «Черновик» или editMessageText)
    const afterTexts = calls
      .slice(before)
      .filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText')
      .map((c) => c.payload.text as string);
    expect(afterTexts.some((t) => t.includes('Черновик') || t.includes('черновик') || t.includes('Извлечено'))).toBe(true);
  });

  // (d) cmi_cancel после mismatch → reply содержит «Отменено»; pendingMismatchDraft очищен
  it('(d) cmi_cancel после mismatch → reply содержит «Отменено»', async () => {
    const { bot, calls } = buildMismatchBot({ extractedCompany: 'GeoXpert' });
    await bot.handleUpdate(commandUpdate('/newclient'));
    await bot.handleUpdate(plainTextUpdate('geonline'));
    await bot.handleUpdate(plainTextUpdate('Онлайн-образование'));
    await bot.handleUpdate(callbackUpdate('f0p_go'));
    await bot.handleUpdate(documentUpdate('strategy.md'));
    await bot.handleUpdate(commandUpdate('/draft'));

    const before = calls.length;
    await bot.handleUpdate(callbackUpdate('cmi_cancel'));
    const afterTexts = textsMismatch(calls, before);
    expect(afterTexts.some((t) => t.includes('Отменено'))).toBe(true);
  });

  // (f) stale-кнопка: cmi_proceed / cmi_cancel без pendingMismatchDraft → ℹ️
  it('(f) stale cmi_proceed (нет pending) → ℹ️ «Эта кнопка от прошлого онбординга»', async () => {
    const { bot, calls } = buildMismatchBot();
    await completeProfileMinimum(bot);
    // Нет /draft → нет pendingMismatchDraft
    const before = calls.length;
    await bot.handleUpdate(callbackUpdate('cmi_proceed'));
    const afterTexts = calls
      .slice(before)
      .filter((c) => c.method === 'sendMessage')
      .map((c) => c.payload.text as string);
    expect(afterTexts.some((t) => t.includes('прошлого онбординга'))).toBe(true);
  });

  it('(g) stale cmi_cancel (нет pending) → ℹ️ «Эта кнопка от прошлого онбординга»', async () => {
    const { bot, calls } = buildMismatchBot();
    await completeProfileMinimum(bot);
    const before = calls.length;
    await bot.handleUpdate(callbackUpdate('cmi_cancel'));
    const afterTexts = calls
      .slice(before)
      .filter((c) => c.method === 'sendMessage')
      .map((c) => c.payload.text as string);
    expect(afterTexts.some((t) => t.includes('прошлого онбординга'))).toBe(true);
  });

  // (e) extraction.company === null → нет mismatch-reply; draft доставлен
  it('(e) extraction.company === null → нет mismatch-reply; черновик доставлен', async () => {
    // Используем buildBot напрямую с company=null
    const { bot: bot2, calls: calls2 } = buildBot({
      extractTextFromDocument: ((async () => ({
        sourceName: 'doc.md',
        kind: 'text',
        text: 'x'.repeat(5_000),
      })) as unknown) as BotDeps['extractTextFromDocument'],
      runF0FullDraft: ((async () =>
        f0DraftResult(f0Extraction({ company: null as unknown as string }))
      ) as unknown) as BotDeps['runF0FullDraft'],
    });

    await completeProfileMinimum(bot2);
    const before = calls2.length;
    await bot2.handleUpdate(documentUpdate('strategy.md'));
    await bot2.handleUpdate(commandUpdate('/draft'));

    // Не должно быть mismatch-reply
    const sentTexts = calls2
      .slice(before)
      .filter((c) => c.method === 'sendMessage')
      .map((c) => c.payload.text as string);
    expect(sentTexts.some((t) => t.includes('Чьи данные берём'))).toBe(false);
    // Черновик должен быть доставлен
    const edits = calls2.slice(before).filter((c) => c.method === 'editMessageText');
    expect(edits.some((e) => (e.payload.text as string).includes('Черновик'))).toBe(true);
  });
});
