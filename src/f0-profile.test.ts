import { describe, it, expect } from 'vitest';
import {
  PROFILE_MIN_QUESTIONS,
  PROFILE_EXT_QUESTIONS,
  PROFILE_QUESTIONS,
  PROFILE_MIN_COUNT,
  PROFILE_EXT_COUNT,
  PROFILE_PRIORITY_OPTIONS,
  nextProfileQuestion,
  isMinimumComplete,
  topFromRawAnswer,
  applyProfileAnswer,
  isQuestionAnswered,
  countExtendedFilled,
  renderProfileQuestion,
  renderProfileCardLines,
  renderProfileStatusMessage,
} from './f0-profile.js';
import {
  ClientProfileSchema,
  F0PersistedSessionSchema,
  type ClientProfile,
} from './types.js';

// Story 9.1: юнит-тесты чистых функций диалога «Профиль клиента» (Часть A).

describe('очередь вопросов Части A', () => {
  it('🔑-минимум: A1.1, A1.2 — в этом порядке, оба key (Story 10.2)', () => {
    expect(PROFILE_MIN_QUESTIONS.map((q) => q.id)).toEqual(['a1_1', 'a1_2']);
    expect(PROFILE_MIN_QUESTIONS.every((q) => q.key)).toBe(true);
    expect(PROFILE_MIN_COUNT).toBe(2);
  });

  it('расширенная часть: 15 вопросов; a3_2 первым, затем A1→A2→A3→A4 (Story 10.2)', () => {
    expect(PROFILE_EXT_QUESTIONS.map((q) => q.id)).toEqual([
      'a3_2',
      'a1_3', 'a1_4',
      'a2_1', 'a2_2', 'a2_3', 'a2_4', 'a2_5',
      'a3_1',
      'a4_1', 'a4_2', 'a4_3', 'a4_4', 'a4_5', 'a4_6',
    ]);
    expect(PROFILE_EXT_QUESTIONS.every((q) => !q.key)).toBe(true);
    expect(PROFILE_EXT_COUNT).toBe(15);
  });

  it('формулировки — дословно по вопроснику (выборочно)', () => {
    expect(PROFILE_QUESTIONS.find((q) => q.id === 'a1_1')!.text).toBe('Как называется компания?');
    expect(PROFILE_QUESTIONS.find((q) => q.id === 'a4_1')!.text).toBe(
      'Что привело? В чём именно сейчас проблема или задача?',
    );
    expect(PROFILE_QUESTIONS.find((q) => q.id === 'a1_2')!.example).toContain(
      'Образовательный центр подготовки к ЕНТ',
    );
  });

  it('типы: числовые A2.1/A2.2/A2.5, топы A3.2, choice A4.6, файл A3.1', () => {
    const byId = (id: string) => PROFILE_QUESTIONS.find((q) => q.id === id)!;
    expect(byId('a2_1').type).toBe('number');
    expect(byId('a2_2').type).toBe('number');
    expect(byId('a2_5').type).toBe('number');
    expect(byId('a3_2').type).toBe('tops');
    expect(byId('a4_6').type).toBe('choice');
    expect(byId('a3_1').type).toBe('file-ok');
  });

  it('nextProfileQuestion: индексация по единой очереди, за концом — undefined', () => {
    expect(nextProfileQuestion(0)!.id).toBe('a1_1');
    expect(nextProfileQuestion(PROFILE_MIN_COUNT)!.id).toBe('a3_2');
    expect(nextProfileQuestion(PROFILE_QUESTIONS.length)).toBeUndefined();
  });

  it('варианты A4.6 — дословно по вопроснику', () => {
    expect(PROFILE_PRIORITY_OPTIONS).toEqual([
      'скорость роста',
      'максимальная прибыль',
      'минимизация рисков',
      'выход собственника из операционки',
      'доля рынка',
    ]);
  });
});

describe('applyProfileAnswer / isQuestionAnswered', () => {
  const q = (id: string) => PROFILE_QUESTIONS.find((x) => x.id === id)!;

  it('раскладывает ответы по полям профиля (маппинг Части A)', () => {
    const p: ClientProfile = {};
    expect(applyProfileAnswer(p, q('a1_1'), 'Ромашка')).toBe(true);
    expect(applyProfileAnswer(p, q('a1_2'), 'Продаём ромашки')).toBe(true);
    expect(applyProfileAnswer(p, q('a2_1'), '120 млн ₸')).toBe(true);
    expect(applyProfileAnswer(p, q('a2_4'), 'кредит 40 млн')).toBe(true);
    expect(applyProfileAnswer(p, q('a2_5'), '35')).toBe(true);
    expect(applyProfileAnswer(p, q('a4_1'), 'Стагнация выручки')).toBe(true);
    expect(applyProfileAnswer(p, q('a4_5'), '×2 за год')).toBe(true);
    expect(p.companyName).toBe('Ромашка');
    expect(p.businessSummary).toBe('Продаём ромашки');
    expect(p.financials?.start?.revenue).toBe('120 млн ₸');
    expect(p.financials?.start?.debts).toBe('кредит 40 млн');
    expect(p.financials?.target).toBe('×2 за год');
    expect(p.headcount).toBe('35');
    expect(p.request?.problem).toBe('Стагнация выручки');
  });

  it('пустой ответ не записывается (false), поля остаются незаполненными (инвариант 3)', () => {
    const p: ClientProfile = {};
    expect(applyProfileAnswer(p, q('a1_1'), '   ')).toBe(false);
    expect(p.companyName).toBeUndefined();
    expect(isQuestionAnswered(p, q('a1_1'))).toBe(false);
  });

  it('isQuestionAnswered видит вложенные поля и топов', () => {
    const p: ClientProfile = {
      financials: { start: { profitability: '12%' } },
      tops: [{ name: 'Дамир', title: null, authority: null, area: null }],
      request: { priorities: ['скорость роста'] },
    };
    expect(isQuestionAnswered(p, q('a2_2'))).toBe(true);
    expect(isQuestionAnswered(p, q('a2_1'))).toBe(false);
    expect(isQuestionAnswered(p, q('a3_2'))).toBe(true);
    expect(isQuestionAnswered(p, q('a4_6'))).toBe(true);
  });
});

describe('isMinimumComplete', () => {
  it('true только при A1.1 + A1.2 (Story 10.2: топы/DM перенесены в расширенный)', () => {
    const p: ClientProfile = {
      companyName: 'Ромашка',
      businessSummary: 'Продаём ромашки',
    };
    expect(isMinimumComplete(p)).toBe(true);
    expect(isMinimumComplete({ ...p, companyName: undefined })).toBe(false);
    expect(isMinimumComplete({ ...p, businessSummary: undefined })).toBe(false);
    expect(isMinimumComplete({})).toBe(false);
  });
});

describe('рендер вопроса и счётчики', () => {
  it('заголовок блока при входе, 🔑-маркировка, прогресс (i/N), пример и подсказка', () => {
    const text = renderProfileQuestion(PROFILE_QUESTIONS[1]!, {
      index: 2,
      total: 2,
      withHeader: true,
    });
    expect(text).toContain('📋 A1. Компания и история');
    expect(text).toContain('❓ 🔑 (2/2) Чем занимается компания и для кого?');
    expect(text).toContain('Пример: «');
    expect(text).toContain('/skip');
    expect(text).toContain('🎤'); // Story 9.5: голосовой ввод в профиле
  });

  it('без заголовка — только вопрос; A3.1 подсказывает 📎', () => {
    const a13 = renderProfileQuestion(PROFILE_QUESTIONS.find((q) => q.id === 'a1_3')!, {
      index: 3,
      total: 15,
      withHeader: false,
    });
    expect(a13).not.toContain('📋');
    expect(a13).not.toContain('🔑');
    const a31 = renderProfileQuestion(PROFILE_QUESTIONS.find((q) => q.id === 'a3_1')!, {
      index: 8,
      total: 15,
      withHeader: true,
    });
    expect(a31).toContain('📎 файлом');
  });

  it('countExtendedFilled считает только расширенные поля (Story 11.9: total=15)', () => {
    const p: ClientProfile = {
      companyName: 'Ромашка', // минимум — не в счёт
      history: 'Основана в 2018',
      headcount: '35',
    };
    expect(countExtendedFilled(p)).toEqual({ filled: 2, total: 15 });
  });

  it('renderProfileCardLines: суть + топы + счётчик (компактно, ≤3 строки)', () => {
    const p: ClientProfile = {
      companyName: 'Ромашка',
      businessSummary: 'Продаём ромашки бизнесу',
      tops: [
        { name: 'Дамир', title: 'коммерческий директор', authority: null, area: null },
        { name: 'Айгерим', title: null, authority: null, area: null },
      ],
    };
    const lines = renderProfileCardLines(p);
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(lines[0]).toBe('Суть: Продаём ромашки бизнесу');
    expect(lines[1]).toContain('Дамир (коммерческий директор)');
    expect(lines[1]).not.toContain('DM:');
    expect(lines[2]).toBe('Профиль: минимум ✓ · расширенный 1/15');
  });

  it('renderProfileStatusMessage: компания, прогресс минимума и расширенной части', () => {
    const msg = renderProfileStatusMessage({
      companyName: 'Ромашка',
      businessSummary: 'Продаём ромашки',
    });
    expect(msg).toContain('👤 Профиль клиента — Ромашка');
    expect(msg).toContain('Минимум 🔑: 2/2');
    expect(msg).toContain('расширенный: 0/15');
    expect(msg).toContain('/resume');
  });
});

describe('совместимость схем (паттерн 8.5/8.6)', () => {
  it('ClientProfileSchema: пустой объект валиден — все поля optional', () => {
    expect(ClientProfileSchema.safeParse({}).success).toBe(true);
  });

  it('профиль после applyProfileAnswer проходит схему', () => {
    const p: ClientProfile = {};
    for (const q of PROFILE_QUESTIONS) {
      if (q.type === 'tops') continue;
      applyProfileAnswer(p, q, 'ответ 42');
    }
    p.tops = [{ name: 'Дамир', title: null, authority: null, area: null }];
    expect(ClientProfileSchema.safeParse(p).success).toBe(true);
  });

  it('F0PersistedSessionSchema: файл формата до 9.1 (без profile-полей) валиден', () => {
    const old = {
      chatId: 7890,
      sessionId: 'old-1',
      phase: 'filling',
      draftId: 'd-1',
      sourceNames: ['strategy.md'],
      extraction: {
        document_type: 'strategy',
        company: 'Ромашка',
        objectives: [],
        hypotheses: [],
        participants: [],
        unrecognized: [],
      },
      gaps: [],
      gapIndex: 0,
      schedule: null,
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    expect(F0PersistedSessionSchema.safeParse(old).success).toBe(true);
  });

  it('F0PersistedSessionSchema: сессия фазы profile без черновика валидна', () => {
    const profilePhase = {
      chatId: 7890,
      sessionId: 'new-1',
      phase: 'profile',
      sourceNames: [],
      gaps: [],
      gapIndex: 0,
      schedule: null,
      profile: { companyName: 'Ромашка' },
      profileQIndex: 1,
      updatedAt: '2026-07-09T00:00:00.000Z',
    };
    expect(F0PersistedSessionSchema.safeParse(profilePhase).success).toBe(true);
  });
});
