import { describe, expect, it } from 'vitest';
import {
  computeF0Gaps,
  applyF0Answer,
  needsNumericAnswer,
  looksNumericAnswer,
} from './f0-fill.js';
import type { F0FullExtraction } from './types.js';

function extraction(overrides: Partial<F0FullExtraction> = {}): F0FullExtraction {
  return {
    document_type: 'strategy',
    company: 'GeOnline',
    objectives: [
      {
        title: 'O1',
        krs: [
          // счётный, без пробелов
          { formulation: 'Подписчики с 15 000 до 50 000', base: '15 000', target: '50 000', owner: 'Мақсат', deadline: '2026' },
          // без базы и ответственного
          { formulation: 'EBITDA 15%', base: null, target: '15%', owner: null, deadline: '2026' },
        ],
      },
    ],
    hypotheses: [
      { statement: 'Лидмагниты повышают доходимость', ifThenBecause: null, metric: 'доходимость, %', department: 'Маркетинг', synthesized: false },
      { statement: 'B2G пилот', ifThenBecause: null, metric: null, department: 'Продажи', synthesized: true },
    ],
    participants: [
      { name: 'Дамир', role: 'CEO', department: null, contact: '@damir' },
      { name: 'Жанель', role: null, department: 'Продажи', contact: null },
    ],
    unrecognized: [],
    ...overrides,
  };
}

describe('computeF0Gaps — спрашиваем только отсутствующее (AC1)', () => {
  it('asks only for missing base/owner, missing metric, missing contact + schedule', () => {
    const gaps = computeF0Gaps(extraction());
    const kinds = gaps.map((g) => g.kind);
    // KR2: no_base + no_owner (target есть); гипотеза 2: metric; участник Жанель: contact; +schedule
    expect(kinds).toEqual(['kr_base', 'kr_owner', 'hypo_metric', 'participant_contact', 'schedule']);
    // Ничего не спрашиваем про заполненный KR1 / гипотезу 1 / участника с контактом.
    expect(gaps.find((g) => g.kind === 'participant_contact')!.ref).toBe('Жанель');
    expect(gaps.find((g) => g.kind === 'hypo_metric')!.ref).toBe('H2');
  });

  it('8.6 (W5): вопросы одного KR идут подряд, заголовок сущности — только на первом', () => {
    const ex = extraction({
      objectives: [
        {
          title: 'O1',
          krs: [
            // KR1: нет базы, цели и ответственного → 3 вопроса подряд
            { formulation: 'NPS вырастет', base: null, target: null, owner: null, deadline: null },
            // KR2: нет только ответственного
            { formulation: 'EBITDA 15%', base: '9%', target: '15%', owner: null, deadline: '2026' },
          ],
        },
      ],
    });
    const gaps = computeF0Gaps(ex);
    const krGaps = gaps.filter((g) => g.kind.startsWith('kr_'));
    expect(krGaps.map((g) => `${g.ref}:${g.kind}`)).toEqual([
      'O1.1:kr_base',
      'O1.1:kr_target',
      'O1.1:kr_owner',
      'O1.2:kr_owner',
    ]);
    // Заголовок группы: первый вопрос каждого KR, с формулировкой и списком пробелов.
    expect(krGaps[0]!.header).toContain('📍 KR O1.1 «NPS вырастет»');
    expect(krGaps[0]!.header).toContain('не хватает: база «с X», цель «до Y», ответственный');
    expect(krGaps[1]!.header).toBeUndefined();
    expect(krGaps[2]!.header).toBeUndefined();
    expect(krGaps[3]!.header).toContain('📍 KR O1.2 «EBITDA 15%»');
    // Короткие вопросы несут ref — контекст не теряется при /resume посреди группы.
    expect(krGaps[1]!.question).toContain('O1.1');
  });

  it('always ends with a schedule question even when nothing else is missing', () => {
    const clean = extraction({
      objectives: [{ title: 'O1', krs: [{ formulation: 'X', base: '1', target: '2', owner: 'A', deadline: '2026' }] }],
      hypotheses: [{ statement: 'H', ifThenBecause: null, metric: 'm', department: null, synthesized: false }],
      participants: [{ name: 'A', role: null, department: null, contact: '@a' }],
    });
    const gaps = computeF0Gaps(clean);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.kind).toBe('schedule');
  });
});

describe('applyF0Answer — запись ответа в черновик', () => {
  it('writes base and owner into the located KR', () => {
    const ex = extraction();
    const gaps = computeF0Gaps(ex);
    applyF0Answer(ex, gaps.find((g) => g.kind === 'kr_base')!, '10%');
    applyF0Answer(ex, gaps.find((g) => g.kind === 'kr_owner')!, 'Бакыт');
    expect(ex.objectives[0]!.krs[1]!.base).toBe('10%');
    expect(ex.objectives[0]!.krs[1]!.owner).toBe('Бакыт');
  });

  it('writes hypothesis metric and participant contact', () => {
    const ex = extraction();
    const gaps = computeF0Gaps(ex);
    applyF0Answer(ex, gaps.find((g) => g.kind === 'hypo_metric')!, 'кол-во контрактов B2G');
    applyF0Answer(ex, gaps.find((g) => g.kind === 'participant_contact')!, '@zhanel');
    expect(ex.hypotheses[1]!.metric).toBe('кол-во контрактов B2G');
    expect(ex.participants[1]!.contact).toBe('@zhanel');
  });

  it('closing the base+owner gaps clears the blocking KR (инвариант 1 satisfiable)', () => {
    const ex = extraction();
    const gaps = computeF0Gaps(ex);
    applyF0Answer(ex, gaps.find((g) => g.kind === 'kr_base')!, '10%');
    applyF0Answer(ex, gaps.find((g) => g.kind === 'kr_owner')!, 'Бакыт');
    // после закрытия пробелов повторный расчёт не даёт KR-пробелов
    const after = computeF0Gaps(ex).filter((g) => g.kind.startsWith('kr_'));
    expect(after).toEqual([]);
  });

  it('schedule answers are not written to extraction (handled on session)', () => {
    const ex = extraction();
    const scheduleGap = computeF0Gaps(ex).find((g) => g.kind === 'schedule')!;
    expect(applyF0Answer(ex, scheduleGap, 'Жанель вт 15:00')).toBe(false);
  });

  it('ignores empty answers', () => {
    const ex = extraction();
    const gap = computeF0Gaps(ex).find((g) => g.kind === 'kr_base')!;
    expect(applyF0Answer(ex, gap, '   ')).toBe(false);
    expect(ex.objectives[0]!.krs[1]!.base).toBeNull();
  });
});

describe('8.6 (W6): валидация числовых ответов', () => {
  it('needsNumericAnswer — только база и цель KR', () => {
    const gaps = computeF0Gaps(extraction());
    expect(needsNumericAnswer(gaps.find((g) => g.kind === 'kr_base')!)).toBe(true);
    expect(needsNumericAnswer(gaps.find((g) => g.kind === 'kr_owner')!)).toBe(false);
    expect(needsNumericAnswer(gaps.find((g) => g.kind === 'hypo_metric')!)).toBe(false);
    expect(needsNumericAnswer(gaps.find((g) => g.kind === 'schedule')!)).toBe(false);
  });

  it('looksNumericAnswer — критерий инварианта 1: есть цифра', () => {
    expect(looksNumericAnswer('15 000')).toBe(true);
    expect(looksNumericAnswer('70% → 90%')).toBe(true);
    expect(looksNumericAnswer('с 9% до 15%')).toBe(true);
    expect(looksNumericAnswer('нет данных')).toBe(false);
    expect(looksNumericAnswer('примерно как сейчас')).toBe(false);
  });
});
