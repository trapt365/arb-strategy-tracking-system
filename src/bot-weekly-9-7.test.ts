/**
 * Story 9.7: weekly report tests — отдельный файл, чтобы vi.mock hoisting не влиял
 * на существующие тесты в bot.test.ts и bot-start-9-3.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import pino from 'pino';
import type { Update } from 'grammy/types';
import { createBot, FALLBACK_BOT_INFO, type BotDeps } from './bot.js';
import type { DeliveryReadyReport } from './types.js';
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
  mockLoadWeekReports,
} = vi.hoisted(() => ({
  mockLoadRegistry: vi.fn<[], Promise<ClientRegistry>>(),
  mockGetActiveClient: vi.fn<[number], Promise<string | undefined>>(),
  mockSetActiveClient: vi.fn<[number, string], Promise<boolean>>(),
  mockGetClientName: vi.fn<[string], Promise<string | undefined>>(),
  mockGetClientSheetId: vi.fn<[string], Promise<string | undefined>>(),
  mockListClientIds: vi.fn<[], Promise<string[]>>(),
  mockGetClientTopName: vi.fn<[string], Promise<string | undefined>>(),
  mockUpsertClient: vi.fn<[string, { sheetId: string; name: string; topName?: string }], Promise<void>>(),
  mockLoadClientCard: vi.fn<[string], Promise<null>>(),
  mockLoadWeekReports: vi.fn<[string], Promise<DeliveryReadyReport[]>>(),
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

// Partial mock: loadWeekReports — мок, formatWeeklyReport и getISOWeekAndYear — реальные.
vi.mock('./utils/weekly-report.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/weekly-report.js')>();
  return {
    ...actual,
    loadWeekReports: mockLoadWeekReports,
  };
});

// ── Test helpers ──────────────────────────────────────────────────────────────

const silentLogger = pino({ level: 'silent' }) as unknown as BotDeps['logger'];
const TEST_CHAT_ID = 7891;

let updateCounter = 1;

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
    now: () => new Date('2026-07-09T10:00:00.000Z'),
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

// ── Sample data ──────────────────────────────────────────────────────────────

const report1: DeliveryReadyReport = {
  partial: false,
  reportId: 'rep-001',
  clientId: 'qubiq',
  topName: 'Акбар',
  meetingDate: '2026-07-07',
  summaryLine: 'Обсудили стратегию роста',
  sections: [{ title: 'Ключевые решения', content: 'Расширение рынка' }],
  commitments: [{ who: 'Акбар', what: 'Подготовить презентацию', deadline: '2026-07-14', quote: '', status: 'open' }],
  alerts: ['Риск задержки Q3'],
};

const report2: DeliveryReadyReport = {
  partial: false,
  reportId: 'rep-002',
  clientId: 'qubiq',
  topName: 'Марина',
  meetingDate: '2026-07-08',
  summaryLine: 'Бюджет согласован',
  sections: [{ title: 'Финансы', content: 'Увеличение бюджета на 20%' }],
  commitments: [],
  alerts: [],
};

// ── beforeEach: reset mocks ───────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadRegistry.mockResolvedValue({});
  mockGetActiveClient.mockResolvedValue(undefined);
  mockSetActiveClient.mockResolvedValue(true);
  mockGetClientName.mockResolvedValue(undefined);
  mockGetClientSheetId.mockResolvedValue(undefined);
  mockListClientIds.mockResolvedValue(['geonline']);
  mockGetClientTopName.mockResolvedValue(undefined);
  mockUpsertClient.mockResolvedValue(undefined);
  mockLoadClientCard.mockResolvedValue(null);
  mockLoadWeekReports.mockResolvedValue([]);
});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('Story 9.7 — weekly:clientId callback', () => {
  it('(1) weekly:qubiq с 2 отчётами → ctx.reply содержит summaryLine обеих встреч', async () => {
    mockGetClientName.mockImplementation(async (id) =>
      id === 'qubiq' ? 'Qubiq' : undefined,
    );
    mockGetClientSheetId.mockImplementation(async (id) =>
      id === 'qubiq' ? 'sheet1' : undefined,
    );
    mockLoadWeekReports.mockResolvedValue([report1, report2]);

    const { bot, calls } = buildBot();
    await bot.handleUpdate(callbackUpdate('weekly:qubiq'));

    const replies = calls.filter((c) => c.method === 'sendMessage');
    expect(replies.length).toBeGreaterThan(0);

    const allText = replies.map((r) => r.payload.text as string).join('\n');
    expect(allText).toContain(report1.summaryLine);
    expect(allText).toContain(report2.summaryLine);
    expect(allText).toContain('Нед.');
  });

  it('(4) weekly:qubiq — loadWeekReports throws → ctx.reply содержит «Не удалось загрузить»', async () => {
    mockGetClientName.mockImplementation(async (id) =>
      id === 'qubiq' ? 'Qubiq' : undefined,
    );
    mockGetClientSheetId.mockResolvedValue(undefined);
    const accessErr = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    mockLoadWeekReports.mockRejectedValue(accessErr);

    const { bot, calls } = buildBot();
    await bot.handleUpdate(callbackUpdate('weekly:qubiq'));

    const replies = calls.filter((c) => c.method === 'sendMessage');
    expect(replies.length).toBeGreaterThan(0);
    const allText = replies.map((r) => r.payload.text as string).join('\n');
    expect(allText).toContain('Не удалось загрузить');
  });

  it('(2) weekly:qubiq без встреч → ctx.reply содержит «не обработано»', async () => {
    mockGetClientName.mockImplementation(async (id) =>
      id === 'qubiq' ? 'Qubiq' : undefined,
    );
    mockGetClientSheetId.mockResolvedValue(undefined);
    mockLoadWeekReports.mockResolvedValue([]);

    const { bot, calls } = buildBot();
    await bot.handleUpdate(callbackUpdate('weekly:qubiq'));

    const replies = calls.filter((c) => c.method === 'sendMessage');
    expect(replies.length).toBeGreaterThan(0);

    const allText = replies.map((r) => r.payload.text as string).join('\n');
    expect(allText).toContain('не обработано');
  });

  it('(3) start_client:qubiq → клавиатура содержит callback_data weekly:qubiq', async () => {
    mockGetClientName.mockImplementation(async (id) =>
      id === 'qubiq' ? 'Qubiq' : undefined,
    );
    mockGetClientSheetId.mockImplementation(async (id) =>
      id === 'qubiq' ? 'sheet1' : undefined,
    );
    mockLoadClientCard.mockResolvedValue(null);

    const { bot, calls } = buildBot();
    await bot.handleUpdate(callbackUpdate('start_client:qubiq'));

    const reply = calls.find((c) => c.method === 'sendMessage');
    expect(reply).toBeDefined();

    const markup = reply!.payload.reply_markup as {
      inline_keyboard: { text: string; callback_data?: string }[][];
    };
    expect(markup).toBeDefined();
    const allButtons = markup.inline_keyboard.flat();
    const cbDatas = allButtons.map((b) => b.callback_data).filter(Boolean);
    expect(cbDatas).toContain('weekly:qubiq');
  });
});
