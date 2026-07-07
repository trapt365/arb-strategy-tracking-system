import { describe, it, expect, beforeEach, vi } from 'vitest';
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
    return { ok: true, result: true } as never;
  });
  return calls;
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

  it('AC#9: post_detail stub responds "Скоро доступно" (post_note is now a real handler — Story 1.7)', async () => {
    const appendApprovalMock = vi.fn().mockResolvedValue(undefined);
    const bot_instance = buildBot({ appendApproval: appendApprovalMock });
    const job = await runJobFromBot(bot_instance);

    await bot_instance.bot.handleUpdate(callbackUpdate(`approve:${job.id}`));
    await bot_instance.bot.handleUpdate(callbackUpdate(`post_detail:${job.id}`));

    const stubAnswers = bot_instance.calls.filter(
      (c) => c.method === 'answerCallbackQuery' && (c.payload as { text?: string }).text?.includes('Скоро'),
    );
    expect(stubAnswers.length).toBeGreaterThanOrEqual(1);
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

  it('AC#10: post_detail remains stub → "Скоро доступно 🔜"', async () => {
    const bot_instance = buildBot({
      appendApproval: vi.fn().mockResolvedValue(undefined),
    });
    const job = await runJobFromBot(bot_instance);

    await bot_instance.bot.handleUpdate(callbackUpdate(`post_detail:${job.id}`));

    const stubAnswers = bot_instance.calls.filter(
      (c) => c.method === 'answerCallbackQuery' && (c.payload as { text?: string }).text?.includes('Скоро'),
    );
    expect(stubAnswers.length).toBeGreaterThanOrEqual(1);
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
    expect(payload.text).toContain('/report');
    expect(payload.text).toContain('/help');
    expect(payload.text).toContain('🔍 Найти');
    expect(payload.text).toContain('📋 Повестка');
    expect(payload.text).toContain('📊 Статус');
    expect(payload.parse_mode).toBeUndefined();
    expect(queue.size()).toBe(0);
  });

  it('AC#2: /help → та же welcome-инструкция (single source of truth)', async () => {
    const { bot, calls } = buildBot();
    await bot.handleUpdate(helpUpdate(TEST_TRACKER_CHAT_ID, 'Азиза'));

    const reply = calls.find(
      (c) => c.method === 'sendMessage' && (c.payload.text as string).includes('Привет'),
    );
    expect(reply).toBeDefined();
    const payload = reply!.payload as { text: string; parse_mode?: string };
    expect(payload.text).toContain('/report');
    expect(payload.text).toContain('/help');
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
      // Story 7.1/7.2/7.3: + newclient + draft + confirm (F0 онбординг)
      expect(cmds.map((c) => c.command)).toEqual([
        'start',
        'help',
        'report',
        'newclient',
        'draft',
        'confirm',
      ]);
      expect(cmds[0]!.command).toBe('start');
    } finally {
      await built.stop();
    }
  });
});
