/**
 * Story 9.3: /start flow tests — отдельный файл, чтобы vi.mock hoisting не влиял
 * на существующие 621 тест в bot.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { Update } from 'grammy/types';
import { createBot, FALLBACK_BOT_INFO, type BotDeps } from './bot.js';
import type { ClientRegistry } from './types.js';

// ── vi.mock на уровне модуля (hoisting) ──────────────────────────────────────

const {
  mockLoadRegistry,
  mockGetActiveClient,
  mockSetActiveClient,
  mockGetClientName,
  mockGetClientSheetId,
  mockListClientIds,
  mockGetClientTopName,
  mockUpsertClient,
  mockLoadClientCard,
} = vi.hoisted(() => ({
  mockLoadRegistry: vi.fn<[], Promise<ClientRegistry>>(),
  mockGetActiveClient: vi.fn<[number], Promise<string | undefined>>(),
  mockSetActiveClient: vi.fn<[number, string], Promise<void>>(),
  mockGetClientName: vi.fn<[string], Promise<string | undefined>>(),
  mockGetClientSheetId: vi.fn<[string], Promise<string | undefined>>(),
  mockListClientIds: vi.fn<[], Promise<string[]>>(),
  mockGetClientTopName: vi.fn<[string], Promise<string | undefined>>(),
  mockUpsertClient: vi.fn<[string, { sheetId: string; name: string; topName?: string }], Promise<void>>(),
  mockLoadClientCard: vi.fn<[string], Promise<null>>(),
}));

vi.mock('./client-registry.js', () => ({
  loadRegistry: mockLoadRegistry,
  getActiveClient: mockGetActiveClient,
  setActiveClient: mockSetActiveClient,
  getClientName: mockGetClientName,
  getClientSheetId: mockGetClientSheetId,
  listClientIds: mockListClientIds,
  getClientTopName: mockGetClientTopName,
  upsertClient: mockUpsertClient,
}));

vi.mock('./f0-client-card.js', () => ({
  loadClientCard: mockLoadClientCard,
  buildClientCard: vi.fn(),
  persistClientCard: vi.fn(),
  clientIdFromCompany: vi.fn(),
  computeReadinessChecklist: vi.fn().mockReturnValue([]),
  renderReadinessMessage: vi.fn().mockReturnValue(''),
  renderClientCardMessage: vi.fn().mockReturnValue('client card'),
}));

// ── Test helpers ──────────────────────────────────────────────────────────────

const silentLogger = pino({ level: 'silent' }) as unknown as BotDeps['logger'];
const TEST_CHAT_ID = 7890;

let updateCounter = 1;

function startUpdate(firstName = 'Test', chatId = TEST_CHAT_ID): Update {
  return {
    update_id: updateCounter++,
    message: {
      message_id: 1000 + updateCounter,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: firstName },
      from: { id: chatId, is_bot: false, first_name: firstName },
      text: '/start',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    },
  } as unknown as Update;
}

function helpUpdate(firstName = 'Test', chatId = TEST_CHAT_ID): Update {
  return {
    update_id: updateCounter++,
    message: {
      message_id: 1000 + updateCounter,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: firstName },
      from: { id: chatId, is_bot: false, first_name: firstName },
      text: '/help',
      entities: [{ type: 'bot_command', offset: 0, length: 5 }],
    },
  } as unknown as Update;
}

function callbackUpdate(data: string, chatId = TEST_CHAT_ID): Update {
  return {
    update_id: updateCounter++,
    callback_query: {
      id: `cbq_${updateCounter}`,
      from: { id: chatId, is_bot: false, first_name: 'Test', language_code: 'ru' },
      chat_instance: 'test_instance',
      data,
      message: {
        message_id: 99999,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private', first_name: 'Test' },
        from: { id: 1, is_bot: true, first_name: 'TestBot', username: 'test_bot' },
        text: 'menu',
      },
    },
  } as unknown as Update;
}

function plainTextUpdate(text: string, chatId = TEST_CHAT_ID): Update {
  return {
    update_id: updateCounter++,
    message: {
      message_id: 1000 + updateCounter,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: 'Test' },
      from: { id: chatId, is_bot: false, first_name: 'Test' },
      text,
    },
  } as unknown as Update;
}

function reportUpdate(text: string, chatId = TEST_CHAT_ID): Update {
  return {
    update_id: updateCounter++,
    message: {
      message_id: 1000 + updateCounter,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private', first_name: 'Test' },
      from: { id: chatId, is_bot: false, first_name: 'Test' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: 7 }],
    },
  } as unknown as Update;
}

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

function buildBot() {
  const created = createBot({
    alertOps: vi.fn() as unknown as BotDeps['alertOps'],
    appendApproval: async () => {},
    downloadTelegramFile: async () => Buffer.from('doc'),
    logger: silentLogger,
    token: 'TEST:TOKEN',
    botInfo: FALLBACK_BOT_INFO,
    trackerChatIds: new Set([TEST_CHAT_ID]),
    progressUpdatesEnabled: false,
    queueMaxSize: 20,
    now: () => new Date('2026-05-19T10:00:00.000Z'),
  });

  const calls: ApiCall[] = [];
  created.bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    if (method === 'sendMessage') {
      return {
        ok: true,
        result: {
          message_id: 10000 + updateCounter,
          date: Math.floor(Date.now() / 1000),
          chat: { id: (payload as { chat_id: number }).chat_id, type: 'private' },
          text: (payload as { text: string }).text,
        },
      } as never;
    }
    if (method === 'answerCallbackQuery') return { ok: true, result: true } as never;
    if (method === 'getFile') {
      return {
        ok: true,
        result: { file_id: 'file-1', file_unique_id: 'u-1', file_path: 'documents/doc.md' },
      } as never;
    }
    return { ok: true, result: true } as never;
  });

  return { ...created, calls };
}

// ── beforeEach: reset mocks to safe defaults ──────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: empty registry, no active client
  mockLoadRegistry.mockResolvedValue({});
  mockGetActiveClient.mockResolvedValue(undefined);
  mockSetActiveClient.mockResolvedValue(undefined);
  mockGetClientName.mockResolvedValue(undefined);
  mockGetClientSheetId.mockResolvedValue(undefined);
  mockListClientIds.mockResolvedValue(['geonline']);
  mockGetClientTopName.mockResolvedValue(undefined);
  mockUpsertClient.mockResolvedValue(undefined);
  mockLoadClientCard.mockResolvedValue(null);
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Story 9.3 — /start с клиентами в реестре', () => {
  it('(1) /start с {qubiq} → текст ≤5 строк + кнопка start_client:qubiq + menu:new + menu:help', async () => {
    mockLoadRegistry.mockResolvedValue({
      qubiq: { sheetId: 'abc123', name: 'Qubiq', topName: 'Акбар' },
    });
    const { bot, calls } = buildBot();
    await bot.handleUpdate(startUpdate());

    const reply = calls.find((c) => c.method === 'sendMessage');
    expect(reply).toBeDefined();

    // Текст ≤ 5 строк
    const text = reply!.payload.text as string;
    const lineCount = text.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(5);

    // Keyboard: start_client:qubiq + menu:new + menu:help
    const markup = reply!.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
    expect(markup).toBeDefined();
    const allButtons = markup.inline_keyboard.flat();
    const cbDatas = allButtons.map((b) => b.callback_data).filter(Boolean);
    expect(cbDatas).toContain('start_client:qubiq');
    expect(cbDatas).toContain('menu:new');
    expect(cbDatas).toContain('menu:help');
    // geonline-fallback НЕ должен быть в start-меню
    expect(cbDatas).not.toContain('start_client:geonline');
  });

  it('(2) /start пустой реестр → 3-button fallback с menu:clients', async () => {
    mockLoadRegistry.mockResolvedValue({});
    const { bot, calls } = buildBot();
    await bot.handleUpdate(startUpdate());

    const reply = calls.find((c) => c.method === 'sendMessage');
    expect(reply).toBeDefined();

    const markup = reply!.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
    const allButtons = markup.inline_keyboard.flat();
    const cbDatas = allButtons.map((b) => b.callback_data).filter(Boolean);
    expect(cbDatas).toContain('menu:clients');
    expect(cbDatas).toContain('menu:help');
    expect(cbDatas).toContain('menu:new');
    // Не должно быть start_client кнопок
    expect(cbDatas.some((d) => d?.startsWith('start_client:'))).toBe(false);
  });

  it('(3) /help с {qubiq} → та же структура keyboard что /start (client + menu:new + menu:help)', async () => {
    mockLoadRegistry.mockResolvedValue({
      qubiq: { sheetId: 'abc123', name: 'Qubiq', topName: 'Акбар' },
    });
    const { bot, calls } = buildBot();
    await bot.handleUpdate(helpUpdate());

    const reply = calls.find((c) => c.method === 'sendMessage');
    expect(reply).toBeDefined();

    const markup = reply!.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
    const allButtons = markup.inline_keyboard.flat();
    const cbDatas = allButtons.map((b) => b.callback_data).filter(Boolean);
    expect(cbDatas).toContain('start_client:qubiq');
    expect(cbDatas).toContain('menu:new');
    expect(cbDatas).toContain('menu:help');
  });

  it('(4) callback start_client:qubiq → setActiveClient вызван + ответ содержит «Qubiq»', async () => {
    mockGetClientName.mockImplementation(async (id) => (id === 'qubiq' ? 'Qubiq' : undefined));
    mockGetClientSheetId.mockImplementation(async (id) =>
      id === 'qubiq' ? 'sheet-abc' : undefined,
    );
    const { bot, calls } = buildBot();
    await bot.handleUpdate(callbackUpdate('start_client:qubiq'));

    expect(mockSetActiveClient).toHaveBeenCalledWith(TEST_CHAT_ID, 'qubiq');

    const reply = calls.find((c) => c.method === 'sendMessage');
    expect(reply).toBeDefined();
    expect(reply!.payload.text as string).toContain('Qubiq');
  });

  it('(5) /report без URL, getActiveClient=qubiq → ответ содержит «Qubiq» и «/report https://»', async () => {
    mockGetActiveClient.mockResolvedValue('qubiq');
    mockGetClientName.mockImplementation(async (id) => (id === 'qubiq' ? 'Qubiq' : undefined));
    const { bot, calls } = buildBot();
    await bot.handleUpdate(reportUpdate('/report'));

    const reply = calls.find((c) => c.method === 'sendMessage');
    expect(reply).toBeDefined();
    const text = reply!.payload.text as string;
    expect(text).toContain('Qubiq');
    expect(text).toContain('/report https://');
  });

  it('(6) свободный текст, getActiveClient=qubiq → ответ содержит «Qubiq» и «/report»', async () => {
    mockGetActiveClient.mockResolvedValue('qubiq');
    mockGetClientName.mockImplementation(async (id) => (id === 'qubiq' ? 'Qubiq' : undefined));
    const { bot, calls } = buildBot();
    await bot.handleUpdate(plainTextUpdate('как дела?'));

    const reply = calls.find((c) => c.method === 'sendMessage');
    expect(reply).toBeDefined();
    const text = reply!.payload.text as string;
    expect(text).toContain('Qubiq');
    expect(text).toContain('/report');
  });

  it('(7) /report с невалидным URL + active client → generic invalid_url error (контекстная подсказка только для missing_arg)', async () => {
    mockGetActiveClient.mockResolvedValue('qubiq');
    mockGetClientName.mockImplementation(async (id) => (id === 'qubiq' ? 'Qubiq' : undefined));
    const { bot, calls } = buildBot();
    await bot.handleUpdate(reportUpdate('/report not-a-url'));

    const reply = calls.find((c) => c.method === 'sendMessage');
    expect(reply).toBeDefined();
    const text = reply!.payload.text as string;
    // Должен быть generic invalid_url, а НЕ контекстная подсказка с именем клиента
    expect(text).not.toContain('Qubiq');
    expect(text).toMatch(/Ссылка не распознана/);
  });
});
