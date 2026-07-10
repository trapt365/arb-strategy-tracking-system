import { describe, expect, it } from 'vitest';
import { buildQnDraft } from './f0-questionnaire.js';

// Ревью эпика 9: /skip на шаге KR НЕ должен оставлять литерал «/skip» как формулировку —
// пропущенное направление уходит в черновик без KR (krs: []).
describe('buildQnDraft — пропуск KR (ревью эпика 9)', () => {
  it('направление с пропущенным KR (дырка в qnKrData) → objective с krs: []', () => {
    const draft = buildQnDraft({
      qnObjectives: ['Рост выручки', 'Удержание команды'],
      // objIdx 0 пропущен (delete krData[0]) → индекс отсутствует; objIdx 1 заполнен.
      qnKrData: [undefined as never, { formulation: 'Отток < 5%', owner: null }],
      qnHypotheses: [],
    });
    const objectives = draft.extraction.objectives;
    expect(objectives).toHaveLength(2);
    expect(objectives[0]!.krs).toEqual([]); // пропущенное — без KR
    expect(objectives[1]!.krs).toHaveLength(1);
    // Нигде не должно быть литерала «/skip».
    const serialized = JSON.stringify(draft.extraction);
    expect(serialized).not.toContain('/skip');
  });

  it('все KR собраны → каждый objective получает свой KR', () => {
    const draft = buildQnDraft({
      qnObjectives: ['O1'],
      qnKrData: [{ formulation: 'KR1', owner: 'Дамир' }],
      qnHypotheses: [],
    });
    expect(draft.extraction.objectives[0]!.krs[0]!.formulation).toBe('KR1');
    expect(draft.extraction.objectives[0]!.krs[0]!.owner).toBe('Дамир');
  });
});
