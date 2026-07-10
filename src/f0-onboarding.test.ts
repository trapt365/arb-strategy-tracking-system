import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  markBlockingKrIssues,
  markHypothesesWithoutMetric,
  renderF0FullDraftMessage,
  renderF0DraftSummaryMessage,
  runF0FullDraft,
  persistF0FullDraft,
  persistF0Session,
  loadF0Session,
  deleteF0Session,
} from './f0-onboarding.js';
import { F0OnboardingError } from './errors.js';
import type { F0FullExtraction, F0ObjectiveDraft, F0PersistedSession } from './types.js';

const countableKr = {
  formulation: 'Увеличить подписчиков Instagram с 15 000 до 50 000',
  base: '15 000',
  target: '50 000',
  owner: 'Мақсат',
  deadline: 'До 30.06.2026',
};

const uncountableKr = {
  formulation: '50 000 лид алу (ЕБТ рекордтары)',
  base: null,
  target: '50 000',
  owner: null,
  deadline: 'Постоянно',
};

const objectives = (krs: F0ObjectiveDraft['krs']): { objectives: F0ObjectiveDraft[] } => ({
  objectives: [{ title: 'O1', krs }],
});

function fullExtraction(overrides: Partial<F0FullExtraction> = {}): F0FullExtraction {
  return {
    document_type: 'strategy',
    company: 'GeOnline',
    objectives: [{ title: 'O1', krs: [countableKr] }],
    hypotheses: [
      { statement: 'Лидмагниты повышают доходимость', ifThenBecause: 'ЕСЛИ … ТО … ПОТОМУ ЧТО …', metric: 'доходимость до вебинара, %', department: 'Маркетинг', synthesized: false },
      { statement: 'Выход на B2G через пилот', ifThenBecause: null, metric: null, department: 'Продажи', synthesized: true },
    ],
    participants: [
      { name: 'Дамир Самарханов', role: 'CEO', department: null, contact: null },
      { name: 'Жанель', role: null, department: 'Продажи', contact: null },
    ],
    unrecognized: [],
    ...overrides,
  };
}

describe('markBlockingKrIssues (инвариант 1)', () => {
  it('passes countable KR (numeric base + target + owner)', () => {
    expect(markBlockingKrIssues(objectives([countableKr]))).toEqual([]);
  });

  it('flags KR without base and owner with exact reasons', () => {
    const issues = markBlockingKrIssues(objectives([countableKr, uncountableKr]));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ ref: 'O1.2', reasons: ['no_base', 'no_owner'] });
  });

  it('treats non-numeric base/target and blank owner as missing', () => {
    const kr = { ...countableKr, base: 'высокая', target: 'рост', owner: '  ' };
    expect(markBlockingKrIssues(objectives([kr]))[0]!.reasons).toEqual([
      'no_base',
      'no_target',
      'no_owner',
    ]);
  });

  it('milestone KR: не требует базы/цели, только ответственного (WP-39.x)', () => {
    const milestone = {
      formulation: 'Внедрена система бюджетирования',
      kr_type: 'milestone' as const,
      base: null,
      target: null,
      owner: 'Мақсат',
      deadline: null,
    };
    // milestone с owner — чист (base/target не спрашиваем).
    expect(markBlockingKrIssues(objectives([milestone]))).toEqual([]);
    // milestone без owner — только no_owner (не no_base/no_target).
    expect(markBlockingKrIssues(objectives([{ ...milestone, owner: null }]))[0]!.reasons).toEqual([
      'no_owner',
    ]);
  });
});

describe('markHypothesesWithoutMetric (инвариант 2)', () => {
  it('flags only hypotheses with null/blank metric', () => {
    const issues = markHypothesesWithoutMetric(fullExtraction());
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ index: 1, ref: 'H2', statement: 'Выход на B2G через пилот' });
  });

  it('treats blank metric as missing', () => {
    const ex = fullExtraction({
      hypotheses: [{ statement: 'X', ifThenBecause: null, metric: '   ', department: null, synthesized: false }],
    });
    expect(markHypothesesWithoutMetric(ex)).toHaveLength(1);
  });
});

describe('renderF0FullDraftMessage', () => {
  it('renders OKR + hypotheses (🔴 no-metric + synthesized) + participants', () => {
    const ex = fullExtraction();
    const msg = renderF0FullDraftMessage({
      extraction: ex,
      krIssues: markBlockingKrIssues(ex),
      hypothesisIssues: markHypothesesWithoutMetric(ex),
      sourceName: 'strategy.pdf, okr.md',
      draftId: 'abc12345',
    });
    expect(msg).toContain('🧪 Банк гипотез — 2');
    expect(msg).toContain('🔴 Без метрики проверки — 1 из 2');
    expect(msg).toContain('⚠️требует подтверждения');
    expect(msg).toContain('1 гипотез синтезированы из решений');
    expect(msg).toContain('👥 Участники — 2');
    expect(msg).toContain('Дамир Самарханов (CEO)');
    expect(msg).toContain('✅ Все 1 KR считаемы.');
  });

  it('signals absence of OKR instead of silently omitting the section', () => {
    const ex = fullExtraction({ objectives: [] });
    const msg = renderF0FullDraftMessage({
      extraction: ex,
      krIssues: [],
      hypothesisIssues: markHypothesesWithoutMetric(ex),
      sourceName: 'protocol.md',
      draftId: 'abc12345',
    });
    expect(msg).toContain('📊 OKR в документах не найдены');
    expect(msg).toContain('🧪 Банк гипотез — 2');
  });

  it('renders unrecognized block verbatim (инвариант 3)', () => {
    const ex = fullExtraction({
      unrecognized: ['Строка с противоречивыми цифрами: 200к vs 220к (раздел «Продажи»)'],
    });
    const msg = renderF0FullDraftMessage({
      extraction: ex,
      krIssues: markBlockingKrIssues(ex),
      hypothesisIssues: markHypothesesWithoutMetric(ex),
      sourceName: 'okr.md',
      draftId: 'abc12345',
    });
    expect(msg).toContain('❓ Не распознано');
    expect(msg).toContain('противоречивыми цифрами');
  });
});

describe('renderF0DraftSummaryMessage (Story 8.3, W4)', () => {
  it('компактно: счётчики + 🔴-блоки, без полных таблиц KR/гипотез/участников', () => {
    const ex = fullExtraction({
      objectives: [{ title: 'O1', krs: [countableKr, uncountableKr] }],
    });
    const msg = renderF0DraftSummaryMessage({
      extraction: ex,
      krIssues: markBlockingKrIssues(ex),
      hypothesisIssues: markHypothesesWithoutMetric(ex),
      sourceName: 'strategy.pdf, okr.md',
      draftId: 'abc12345',
    });
    expect(msg).toContain('Извлечено: цели 1 · KR 2 · гипотезы 2 · участники 2');
    expect(msg).toContain('🔴 Неполные KR — 1 из 2');
    expect(msg).toContain('🔴 Гипотезы без метрики — 1 из 2: H2');
    // Полные таблицы не инлайнятся: нет по-строчных деталей KR и списка участников.
    expect(msg).not.toContain('база: ');
    expect(msg).not.toContain('👥 Участники');
    expect(msg).not.toContain('Дамир Самарханов');
    // Обещание ссылки после /confirm.
    expect(msg).toContain('/confirm');
    expect(msg).toContain('Черновик сохранён (abc12345)');
  });

  it('🔴 KR обрезаются до 10, «Не распознано» до 5 — с хвостом «и ещё N»', () => {
    const krs = Array.from({ length: 13 }, (_, i) => ({
      formulation: `KR номер ${i + 1}`,
      base: null,
      target: null,
      owner: null,
      deadline: null,
    }));
    const ex = fullExtraction({
      objectives: [{ title: 'O1', krs }],
      unrecognized: Array.from({ length: 7 }, (_, i) => `непонятная строка ${i + 1}`),
    });
    const msg = renderF0DraftSummaryMessage({
      extraction: ex,
      krIssues: markBlockingKrIssues(ex),
      hypothesisIssues: [],
      sourceName: 'okr.md',
      draftId: 'abc12345',
    });
    expect(msg).toContain('🔴 Неполные KR — 13 из 13');
    expect(msg).toContain('… и ещё 3');
    expect(msg).toContain('❓ Не распознано — 7:');
    expect(msg).toContain('… и ещё 2');
    expect(msg).not.toContain('KR номер 11');
  });

  it('OKR отсутствуют → явный сигнал, а не молчание', () => {
    const ex = fullExtraction({ objectives: [] });
    const msg = renderF0DraftSummaryMessage({
      extraction: ex,
      krIssues: [],
      hypothesisIssues: markHypothesesWithoutMetric(ex),
      sourceName: 'protocol.md',
      draftId: 'abc12345',
    });
    expect(msg).toContain('📊 OKR в документах не найдены');
    expect(msg).toContain('цели 0');
  });
});

describe('runF0FullDraft', () => {
  it('sanitizes, extracts, validates both invariants and loads the full prompt', async () => {
    const callClaude = vi.fn().mockResolvedValue({
      raw: '{}',
      parsed: fullExtraction(),
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const loadPrompt = vi.fn().mockResolvedValue('PROMPT');

    const result = await runF0FullDraft(
      { documentText: '# OKR\n\nvscode-remote://junk/url текст', sourceName: 'a.md' },
      { callClaude, loadPrompt },
    );

    expect(loadPrompt).toHaveBeenCalledWith(
      'f0-full-extraction',
      expect.objectContaining({ documentText: expect.not.stringContaining('vscode-remote') }),
    );
    expect(callClaude).toHaveBeenCalledWith(
      'PROMPT',
      expect.objectContaining({ stepName: 'f0_full_extraction', maxTokens: expect.any(Number) }),
    );
    expect(result.krIssues).toHaveLength(0);
    expect(result.hypothesisIssues).toHaveLength(1);
    expect(result.totalKrs).toBe(1);
  });

  it('story 9.2: profileParticipants передаётся в loadPrompt при наличии профиля', async () => {
    const callClaude = vi.fn().mockResolvedValue({
      raw: '{}',
      parsed: fullExtraction(),
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const loadPrompt = vi.fn().mockResolvedValue('PROMPT');

    await runF0FullDraft(
      { documentText: '# OKR', sourceName: 'a.md', profileParticipants: '- Дамир Сайлов (CEO, зона: Финансы)' },
      { callClaude, loadPrompt },
    );

    expect(loadPrompt).toHaveBeenCalledWith(
      'f0-full-extraction',
      expect.objectContaining({ profileParticipants: '- Дамир Сайлов (CEO, зона: Финансы)' }),
    );
  });

  it('passes non-empty presentationHint to loadPrompt when isPresentationOnly: true', async () => {
    const mockLoadPrompt = vi.fn(async () => '{}');
    const mockCallClaude = vi.fn(async () => ({
      parsed: {
        document_type: 'strategy',
        company: null,
        objectives: [],
        hypotheses: [],
        participants: [],
        unrecognized: [],
      },
      usage: { input_tokens: 10, output_tokens: 10 },
    }));
    await runF0FullDraft(
      { documentText: 'Стратегия', sourceName: 'deck.pptx', isPresentationOnly: true },
      { callClaude: mockCallClaude as never, loadPrompt: mockLoadPrompt as never },
    );
    expect(mockLoadPrompt).toHaveBeenCalledWith(
      'f0-full-extraction',
      expect.objectContaining({ presentationHint: expect.stringContaining('переноси KR') }),
    );
  });

  it('passes empty presentationHint to loadPrompt when isPresentationOnly is false/omitted', async () => {
    const mockLoadPrompt = vi.fn(async () => '{}');
    const mockCallClaude = vi.fn(async () => ({
      parsed: {
        document_type: 'strategy',
        company: null,
        objectives: [],
        hypotheses: [],
        participants: [],
        unrecognized: [],
      },
      usage: { input_tokens: 10, output_tokens: 10 },
    }));
    await runF0FullDraft(
      { documentText: 'Стратегия', sourceName: 'doc.md' },
      { callClaude: mockCallClaude as never, loadPrompt: mockLoadPrompt as never },
    );
    expect(mockLoadPrompt).toHaveBeenCalledWith(
      'f0-full-extraction',
      expect.objectContaining({ presentationHint: '' }),
    );
  });

  it('throws not_okr_document for document_type=other (инвариант 3)', async () => {
    const callClaude = vi.fn().mockResolvedValue({
      raw: '{}',
      parsed: fullExtraction({ document_type: 'other', objectives: [], hypotheses: [], participants: [] }),
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const loadPrompt = vi.fn().mockResolvedValue('PROMPT');
    await expect(
      runF0FullDraft({ documentText: 'readme', sourceName: 'README.md' }, { callClaude, loadPrompt }),
    ).rejects.toBeInstanceOf(F0OnboardingError);
  });
});

describe('persistF0FullDraft', () => {
  it('writes full draft json atomically into rootDir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f0-drafts-'));
    try {
      const ex = fullExtraction();
      const path = await persistF0FullDraft(
        {
          draftId: 'abc12345',
          chatId: 42,
          sourceNames: ['strategy.pdf', 'okr.md'],
          createdAt: '2026-07-07T10:00:00.000Z',
          result: {
            extraction: ex,
            krIssues: markBlockingKrIssues(ex),
            hypothesisIssues: markHypothesesWithoutMetric(ex),
            totalKrs: 1,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
        { rootDir: dir },
      );
      expect(path).toBe(join(dir, 'abc12345.json'));
      const saved = JSON.parse(readFileSync(path!, 'utf8'));
      expect(saved.chatId).toBe(42);
      expect(saved.sourceNames).toEqual(['strategy.pdf', 'okr.md']);
      expect(saved.hypothesisIssues).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is warn-only: returns null on unwritable dir instead of throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f0-drafts-'));
    try {
      const filePath = join(dir, 'not-a-dir');
      writeFileSync(filePath, 'x');
      const ex = fullExtraction();
      const path = await persistF0FullDraft(
        {
          draftId: 'abc12345',
          chatId: 42,
          sourceNames: ['okr.md'],
          createdAt: '2026-07-07T10:00:00.000Z',
          result: {
            extraction: ex,
            krIssues: [],
            hypothesisIssues: [],
            totalKrs: 1,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
        { rootDir: filePath },
      );
      expect(path).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// === Story 7.3: persist/restore сессии онбординга ===

describe('persistF0Session / loadF0Session (AC3 round-trip)', () => {
  function session(dir: string): F0PersistedSession {
    return {
      chatId: 555,
      sessionId: 'sess0001',
      phase: 'filling',
      draftId: 'drft0001',
      sourceNames: ['strategy.pdf'],
      extraction: fullExtraction(),
      gaps: [
        { kind: 'kr_owner', objectiveIndex: 0, krIndex: 0, ref: 'O1.1', question: 'Кто?' },
        { kind: 'schedule', ref: 'расписание', question: 'Слоты?' },
      ],
      gapIndex: 1,
      schedule: null,
      updatedAt: '2026-07-07T10:00:00.000Z',
    };
  }

  it('restores exact state from disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f0-sess-'));
    try {
      const s = session(dir);
      await persistF0Session(s, { rootDir: dir });
      const loaded = await loadF0Session(555, { rootDir: dir });
      expect(loaded).not.toBeNull();
      expect(loaded!.phase).toBe('filling');
      expect(loaded!.gapIndex).toBe(1);
      expect(loaded!.gaps).toHaveLength(2);
      expect(loaded!.extraction.hypotheses).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Ревью эпика 9: пакет документов и принятый xlsx-импорт переживают рестарт —
  // без этих полей restore обнулял их, и «↩️ Восстановил…» показывал пустой пакет.
  it('collecting-сессия: documents и importResult переживают round-trip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f0-sess-'));
    try {
      const s: F0PersistedSession = {
        ...session(dir),
        phase: 'collecting',
        draftId: undefined,
        extraction: undefined,
        documents: [{ sourceName: 'strategy.docx', text: 'Цели компании...' }],
        documentsChars: 16,
        importResult: {
          extraction: fullExtraction(),
          format: 'template',
          sheetName: 'KR',
          mappedColumns: ['objective', 'key_result'],
          sourceName: 'strategy.xlsx',
        },
      };
      await persistF0Session(s, { rootDir: dir });
      const loaded = await loadF0Session(555, { rootDir: dir });
      expect(loaded).not.toBeNull();
      expect(loaded!.documents).toHaveLength(1);
      expect(loaded!.documents![0]!.sourceName).toBe('strategy.docx');
      expect(loaded!.documentsChars).toBe(16);
      expect(loaded!.importResult?.sourceName).toBe('strategy.xlsx');
      expect(loaded!.importResult?.extraction.hypotheses).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a missing session file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f0-sess-'));
    try {
      expect(await loadF0Session(999, { rootDir: dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for an invalid/corrupt session file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f0-sess-'));
    try {
      writeFileSync(join(dir, 'session-777.json'), '{ not: valid json');
      expect(await loadF0Session(777, { rootDir: dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deleteF0Session removes the persisted file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'f0-sess-'));
    try {
      await persistF0Session(session(dir), { rootDir: dir });
      await deleteF0Session(555, { rootDir: dir });
      expect(await loadF0Session(555, { rootDir: dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
