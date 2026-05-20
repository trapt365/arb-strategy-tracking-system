import { describe, it, expect } from 'vitest';
import {
  escapeMarkdownV2,
  formatHeader,
  formatProgressStep,
  formatQueueAck,
  formatErrorMessage,
  formatDeliveryReport,
  formatFullDeliveryReport,
  formatPartialReportFallback,
  formatDeliveryPlainText,
  formatTopMessagePlainText,
  formatWelcomeMessage,
  formatHelpHint,
  splitForTelegram,
  TELEGRAM_SAFE_MARGIN,
} from './telegram-formatter.js';
import type { DeliveryReadyReport } from '../types.js';

describe('escapeMarkdownV2', () => {
  it('экранирует все 18 reserved chars Telegram MarkdownV2', () => {
    expect(escapeMarkdownV2('a_b*c.d!')).toBe('a\\_b\\*c\\.d\\!');
    expect(escapeMarkdownV2('[link](url)')).toBe('\\[link\\]\\(url\\)');
    expect(escapeMarkdownV2('# header')).toBe('\\# header');
    expect(escapeMarkdownV2('a > b')).toBe('a \\> b');
    expect(escapeMarkdownV2('100% + 1')).toBe('100% \\+ 1');
    expect(escapeMarkdownV2('1-2-3')).toBe('1\\-2\\-3');
    expect(escapeMarkdownV2('a=b|c')).toBe('a\\=b\\|c');
    expect(escapeMarkdownV2('{a}~b`c')).toBe('\\{a\\}\\~b\\`c');
    expect(escapeMarkdownV2('back\\slash')).toBe('back\\\\slash');
  });

  it('пустая строка → пустая', () => {
    expect(escapeMarkdownV2('')).toBe('');
  });

  it('текст без reserved chars не меняется', () => {
    expect(escapeMarkdownV2('hello мир')).toBe('hello мир');
  });
});

describe('formatHeader', () => {
  it('собирает трёхуровневый header через │', () => {
    expect(
      formatHeader({ emoji: '📋', topName: 'Жанель', topic: 'Продажи', period: 'Нед. 18' }),
    ).toBe('📋 Жанель │ Продажи │ Нед. 18');
  });
});

describe('formatProgressStep', () => {
  it('маппинг 5 состояний', () => {
    expect(formatProgressStep('queued')).toMatch(/Принято/);
    expect(formatProgressStep('running_extraction')).toBe('🔄 Читаю транскрипт…');
    expect(formatProgressStep('running_analysis')).toBe('🔄 Формирую отчёт…');
    expect(formatProgressStep('running_formatting')).toBe('🔄 Форматирую секции…');
    expect(formatProgressStep('almost_ready')).toBe('🔄 Почти готово…');
  });
});

describe('formatQueueAck', () => {
  it('N=1 → "✅ Принято. Отчёт через ~15 мин."', () => {
    expect(formatQueueAck(1, 1)).toBe('✅ Принято. Отчёт через ~15 мин.');
  });

  it('N=2 из 3 → queue position', () => {
    expect(formatQueueAck(2, 3)).toBe('✅ Принято. В очереди: 2 из 3.');
  });
});

describe('formatErrorMessage', () => {
  it('invalid_url и unsupported_provider → одинаковое сообщение (UX-DR65)', () => {
    const msg = '⚠️ Ссылка не распознана. Проверь формат.';
    expect(formatErrorMessage('invalid_url')).toBe(msg);
    expect(formatErrorMessage('unsupported_provider')).toBe(msg);
  });

  it('transcript_too_short — UX-DR66 wording', () => {
    expect(formatErrorMessage('transcript_too_short')).toBe(
      '⚠️ Слишком короткий. Отчёт требует ≥ 2 мин.',
    );
  });

  it('pipeline_failed и timeout → одинаково "⏰ Задержка..."', () => {
    const msg = '⏰ Задержка. Тимур уведомлён. Пиши отчёт вручную.';
    expect(formatErrorMessage('pipeline_failed')).toBe(msg);
    expect(formatErrorMessage('timeout')).toBe(msg);
  });

  it('queue_overflow / unauthorized / missing_arg', () => {
    expect(formatErrorMessage('queue_overflow')).toMatch(/Очередь заполнена/);
    expect(formatErrorMessage('unauthorized')).toMatch(/Доступ ограничен/);
    expect(formatErrorMessage('missing_arg')).toMatch(/Укажи ссылку/);
    expect(formatErrorMessage('transcript_download_failed')).toMatch(/Не удалось скачать/);
  });
});

describe('splitForTelegram', () => {
  it('text ≤ maxLen → единственная часть', () => {
    expect(splitForTelegram('short', 100)).toEqual(['short']);
  });

  it('text > maxLen → split по \\n\\n', () => {
    const txt = 'A'.repeat(100) + '\n\n' + 'B'.repeat(100) + '\n\n' + 'C'.repeat(100);
    const parts = splitForTelegram(txt, 150, '📋 (продолжение)');
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(150);
    // Continuation header в parts[1+]
    for (let i = 1; i < parts.length; i++) {
      expect(parts[i]!.startsWith('📋 (продолжение)')).toBe(true);
    }
  });

  it('одна "секция" больше maxLen → split по \\n', () => {
    const big = 'line1\nline2\nline3\nline4'.repeat(50);
    const parts = splitForTelegram(big, 200, 'X');
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(200);
  });

  it('hard-split по символам когда line.length > budget', () => {
    const monster = 'X'.repeat(10000);
    const parts = splitForTelegram(monster, 100, 'C');
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(100);
  });

  it('default maxLen = TELEGRAM_SAFE_MARGIN', () => {
    expect(splitForTelegram('short')).toEqual(['short']);
    expect(TELEGRAM_SAFE_MARGIN).toBe(4000);
  });
});

const FULL_FIXTURE: Extract<DeliveryReadyReport, { partial: false }> = {
  partial: false,
  reportId: 'rep-1',
  clientId: 'geonline',
  topName: 'Жанель',
  meetingDate: '2026-05-19',
  department: 'Продажи',
  weekNumber: '18',
  summaryLine: 'Конверсия 28%, гипотеза подтверждается',
  sections: [
    { title: 'Решения', content: 'Перевести менеджеров на видеозвонки' },
    { title: 'KR', content: '🟢 KR-2.3 Конверсия: 28% (цель 30%)' },
  ],
  commitments: [
    {
      who: 'Жанель',
      what: 'Видеозвонки для всех',
      deadline: 'до 17.03',
      quote: 'переводим всех на видеозвонки',
    },
  ],
  alerts: [],
  topMessageDraft: 'Жанель, по итогам встречи переходим на видео.',
};

const PARTIAL_FIXTURE: Extract<DeliveryReadyReport, { partial: true }> = {
  partial: true,
  partialReason: 'format_validation_failed',
  reportId: 'rep-2',
  clientId: 'geonline',
  topName: 'Жанель',
  meetingDate: '2026-05-19',
  department: 'Продажи',
  weekNumber: '18',
  summaryLine: 'Автоформатирование не удалось',
  sections: [],
  commitments: [],
  alerts: [],
  extractionFallback: {
    decisions: ['Перевести менеджеров на видео', 'Найм нового менеджера'],
    commitments: [
      { who: 'Жанель', what: 'видео', deadline: 'до 17.03', quote: 'переводим всех' },
    ],
    citations: [{ timestamp: 65, speaker: 'Жанель', text: 'переводим всех на видео' }],
    facts: [],
  },
};

describe('formatDeliveryReport (full)', () => {
  it('содержит трёхуровневый header, summary, sections, draft', () => {
    const out = formatFullDeliveryReport(FULL_FIXTURE);
    expect(out).toContain('📋 Жанель │ Продажи │ Нед\\. 18');
    expect(out).toContain('Конверсия 28%');
    expect(out).toContain('Решения');
    expect(out).toContain('📱');
  });

  it('header degrades к "—" если department/weekNumber отсутствуют', () => {
    const noMeta = { ...FULL_FIXTURE, department: undefined, weekNumber: undefined };
    const out = formatFullDeliveryReport(noMeta);
    expect(out).toContain('Отчёт');
    expect(out).toContain('—');
  });

  it('экранирует MarkdownV2 reserved chars в пользовательском контенте', () => {
    const tricky = {
      ...FULL_FIXTURE,
      summaryLine: 'a_b*c.d!',
    };
    const out = formatFullDeliveryReport(tricky);
    expect(out).toContain('a\\_b\\*c\\.d\\!');
  });
});

describe('formatPartialReportFallback', () => {
  it('начинается с warning "Автоформатирование не удалось"', () => {
    const out = formatPartialReportFallback(PARTIAL_FIXTURE);
    expect(out).toContain('Автоформатирование не удалось');
    expect(out).toContain('Решения');
    expect(out).toContain('Commitments');
    expect(out).toContain('Цитаты');
  });
});

describe('formatDeliveryReport (discriminated)', () => {
  it('partial:false → full render', () => {
    const out = formatDeliveryReport(FULL_FIXTURE);
    expect(out).toContain('Конверсия 28%');
  });

  it('partial:true → fallback', () => {
    const out = formatDeliveryReport(PARTIAL_FIXTURE);
    expect(out).toContain('Автоформатирование не удалось');
  });
});

describe('commitment lifecycle emojis (Story 1.7)', () => {
  it('status: completed → 🟢 Выполнено в delivery report', () => {
    const fixture = {
      ...FULL_FIXTURE,
      commitments: [
        { who: 'Жанель', what: 'видео', deadline: 'до 17.03', quote: 'переводим', status: 'completed' as const },
      ],
    };
    const out = formatFullDeliveryReport(fixture);
    expect(out).toContain('🟢 Выполнено');
  });

  it('status: overdue → 🔴 Просрочено в delivery report', () => {
    const fixture = {
      ...FULL_FIXTURE,
      commitments: [
        { who: 'Жанель', what: 'видео', deadline: 'до 17.03', quote: 'переводим', status: 'overdue' as const },
      ],
    };
    const out = formatFullDeliveryReport(fixture);
    expect(out).toContain('🔴 Просрочено');
  });

  it('status: undefined → 🔵 Новое (backward compat)', () => {
    const fixture = {
      ...FULL_FIXTURE,
      commitments: [
        { who: 'Жанель', what: 'видео', deadline: 'до 17.03', quote: 'переводим' },
      ],
    };
    const out = formatFullDeliveryReport(fixture);
    expect(out).toContain('🔵 Новое');
  });

  it('status: open → 🔵 Новое', () => {
    const fixture = {
      ...FULL_FIXTURE,
      commitments: [
        { who: 'Жанель', what: 'видео', deadline: 'до 17.03', quote: 'переводим', status: 'open' as const },
      ],
    };
    const out = formatFullDeliveryReport(fixture);
    expect(out).toContain('🔵 Новое');
  });

  it('commitments header больше не содержит hardcoded 🔵', () => {
    const out = formatFullDeliveryReport(FULL_FIXTURE);
    // Header should be *Commitments:* without 🔵 prefix
    expect(out).toContain('*Commitments:*');
    expect(out).not.toMatch(/🔵 \*Commitments:\*/);
  });
});

describe('formatDeliveryPlainText (Story 1.7)', () => {
  it('plain text без MarkdownV2 escape chars', () => {
    const out = formatDeliveryPlainText(FULL_FIXTURE);
    expect(out).not.toContain('\\');
    expect(out).toContain('📋 Жанель │ Продажи │ Нед. 18');
    expect(out).toContain('Конверсия 28%');
    expect(out).toContain('Решения');
  });

  it('включает commitments с lifecycle emoji', () => {
    const fixture = {
      ...FULL_FIXTURE,
      commitments: [
        { who: 'Жанель', what: 'видео', deadline: 'до 17.03', quote: 'переводим', status: 'completed' as const },
      ],
    };
    const out = formatDeliveryPlainText(fixture);
    expect(out).toContain('🟢 Выполнено');
    expect(out).toContain('Commitments:');
  });

  it('без commitments → нет секции Commitments', () => {
    const fixture = { ...FULL_FIXTURE, commitments: [] };
    const out = formatDeliveryPlainText(fixture);
    expect(out).not.toContain('Commitments:');
  });
});

describe('formatWelcomeMessage (Story 1.8)', () => {
  it('с непустым firstName → "Привет, {Name}!"', () => {
    const out = formatWelcomeMessage('Азиза');
    expect(out).toContain('Привет, Азиза!');
    expect(out).toContain('AI-трекинг бот');
  });

  it('без имени → "Привет!" без запятой', () => {
    const out = formatWelcomeMessage(undefined);
    expect(out).toContain('Привет!');
    expect(out).not.toContain('Привет, ');
  });

  it('пустая строка → "Привет!" без запятой (graceful)', () => {
    const out = formatWelcomeMessage('');
    expect(out).toContain('Привет!');
    expect(out).not.toContain('Привет, !');
    expect(out).not.toContain('Привет, ,');
  });

  it('содержит /report и /help', () => {
    const out = formatWelcomeMessage('Азиза');
    expect(out).toContain('/report');
    expect(out).toContain('/help');
  });

  it('перечисляет будущие Bot Menu items «скоро»', () => {
    const out = formatWelcomeMessage('Азиза');
    expect(out).toContain('🔍 Найти');
    expect(out).toContain('📋 Повестка');
    expect(out).toContain('📊 Статус');
    expect(out).toContain('Скоро');
  });

  it('plain text — НЕ содержит MarkdownV2-escape backslashes', () => {
    // Welcome is plain text — we do not pre-escape; reserved chars appear literally.
    const out = formatWelcomeMessage('Азиза');
    expect(out).not.toContain('\\');
  });
});

describe('formatHelpHint (Story 1.8)', () => {
  it('содержит /report и /help', () => {
    const out = formatHelpHint();
    expect(out).toContain('/report');
    expect(out).toContain('/help');
  });

  it('начинается с ℹ и говорит "Не понял"', () => {
    const out = formatHelpHint();
    expect(out.startsWith('ℹ️')).toBe(true);
    expect(out).toMatch(/Не понял/);
  });

  it('plain text — без backslash-escape MarkdownV2 символов', () => {
    const out = formatHelpHint();
    expect(out).not.toContain('\\');
  });
});

describe('formatTopMessagePlainText (Story 1.7)', () => {
  it('формат "📱 Для {Name}:\\n{text}"', () => {
    const out = formatTopMessagePlainText('Жанель', 'По итогам встречи переходим на видео.');
    expect(out).toBe('📱 Для Жанель:\nПо итогам встречи переходим на видео.');
  });

  it('ограничивает полный WhatsApp block до 500 символов', () => {
    const out = formatTopMessagePlainText('Жанель', 'А'.repeat(800));
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out).toMatch(/^📱 Для Жанель:\nА+$/);
  });
});
