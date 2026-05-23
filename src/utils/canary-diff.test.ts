import { describe, it, expect } from 'vitest';
import {
  computeStructuralDiff,
  runSemanticAssertions,
  classifyVerdict,
  aggregateRunVerdict,
  extractCurrentPromptVersion,
  renderMarkdownReport,
  renderJsonReport,
  DIFF_DIMENSIONS,
  type ActualPipelineOutput,
  type ReferencePipelineOutput,
  type ManifestItem,
  type CanaryRunResult,
} from './canary-diff.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeActual(overrides?: Partial<ActualPipelineOutput>): ActualPipelineOutput {
  return {
    extraction: {
      commitments: new Array(5).fill(0).map((_, i) => ({ id: i })),
      citations: new Array(5).fill(0),
      decisions: new Array(5).fill(0),
      facts: new Array(12).fill(0),
    },
    analysis: {
      okr_coverage: [
        ...new Array(5).fill(0).map(() => ({ status: 'discussed' as const })),
        ...new Array(4).fill(0).map(() => ({ status: 'mentioned' as const })),
        ...new Array(38).fill(0).map(() => ({ status: 'blind_zone' as const })),
      ],
      alerts: new Array(5).fill(0),
    },
    formattedReport: { partial: false, sections: new Array(3).fill(0) },
    ...overrides,
  };
}

function makeReference(
  overrides?: Partial<ReferencePipelineOutput>,
): ReferencePipelineOutput {
  return {
    extraction: {
      commitments: new Array(5).fill(0),
      citations: new Array(5).fill(0),
      decisions: new Array(5).fill(0),
      facts: new Array(12).fill(0),
    },
    analysis: {
      okr_coverage: [
        ...new Array(5).fill(0).map(() => ({ status: 'discussed' as const })),
        ...new Array(4).fill(0).map(() => ({ status: 'mentioned' as const })),
        ...new Array(38).fill(0).map(() => ({ status: 'blind_zone' as const })),
      ],
      alerts: new Array(5).fill(0),
    },
    format: { report_sections: new Array(3).fill(0) },
    ...overrides,
  };
}

const MANIFEST_ITEM_WITH_COMMITMENTS: ManifestItem = {
  n: 1,
  scenario: '1:1 двух спикеров, code-switching РУС↔КАЗ',
  stats: { commitments: 5 },
};

const MANIFEST_ITEM_NO_COMMITMENTS: ManifestItem = {
  n: 99,
  scenario: 'fixture without commitments',
  stats: { commitments: 0 },
};

// ─────────────────────────────────────────────────────────────────────────────
// computeStructuralDiff
// ─────────────────────────────────────────────────────────────────────────────

describe('computeStructuralDiff', () => {
  it('identical actual + reference → 0% across all dimensions', () => {
    const diff = computeStructuralDiff(makeActual(), makeReference());
    expect(diff.diffPercent).toBe(0);
    for (const dim of DIFF_DIMENSIONS) expect(diff[dim]).toBe(0);
    expect(diff.partialReport).toBe(false);
  });

  it('+1 commitment vs reference 5 → 20% commitmentsDiff, 2.5% overall', () => {
    const actual = makeActual({
      extraction: {
        commitments: new Array(6).fill(0),
        citations: new Array(5).fill(0),
        decisions: new Array(5).fill(0),
        facts: new Array(12).fill(0),
      },
    });
    const diff = computeStructuralDiff(actual, makeReference());
    expect(diff.commitmentsDiff).toBeCloseTo(0.2, 5);
    // 0.2 / 8 dimensions × 100 = 2.5%
    expect(diff.diffPercent).toBeCloseTo(2.5, 5);
  });

  it('partial=true → sectionsDiff=1.0, partialReport=true, diffPercent ≥ 12.5%', () => {
    const actual = makeActual({ formattedReport: { partial: true } });
    const diff = computeStructuralDiff(actual, makeReference());
    expect(diff.sectionsDiff).toBe(1);
    expect(diff.partialReport).toBe(true);
    // Только sectionsDiff != 0, остальные = 0 → 1/8 × 100 = 12.5%
    expect(diff.diffPercent).toBeCloseTo(12.5, 5);
  });

  it('всё пусто vs reference заполнено → каждая dimension = 1.0, diffPercent ≈ 100', () => {
    const actual = makeActual({
      extraction: { commitments: [], citations: [], decisions: [], facts: [] },
      analysis: { okr_coverage: [], alerts: [] },
      formattedReport: { partial: false, sections: [] },
    });
    const diff = computeStructuralDiff(actual, makeReference());
    expect(diff.diffPercent).toBeCloseTo(100, 5);
    for (const dim of DIFF_DIMENSIONS) expect(diff[dim]).toBe(1);
  });

  it('division-by-zero защита: ref=0 actual=0 → 0, ref=0 actual=3 → 3.0', () => {
    const actual = makeActual({
      extraction: { commitments: [], citations: [], decisions: [], facts: [] },
      analysis: { okr_coverage: [], alerts: [] },
    });
    const reference = makeReference({
      extraction: { commitments: [], citations: [], decisions: [], facts: [] },
      analysis: { okr_coverage: [], alerts: [] },
    });
    let diff = computeStructuralDiff(actual, reference);
    expect(diff.commitmentsDiff).toBe(0);
    expect(diff.alertsDiff).toBe(0);

    diff = computeStructuralDiff(
      makeActual({
        extraction: {
          commitments: new Array(3).fill(0),
          citations: [],
          decisions: [],
          facts: [],
        },
      }),
      makeReference({
        extraction: { commitments: [], citations: [], decisions: [], facts: [] },
      }),
    );
    // ratio = |3-0| / max(1,0) = 3
    expect(diff.commitmentsDiff).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// runSemanticAssertions
// ─────────────────────────────────────────────────────────────────────────────

describe('runSemanticAssertions', () => {
  it('commitments_not_empty_if_present passes when actual has commitments', () => {
    const results = runSemanticAssertions(
      makeActual(),
      MANIFEST_ITEM_WITH_COMMITMENTS,
      { okrs: new Array(57).fill(0) },
    );
    const c = results.find((r) => r.name === 'commitments_not_empty_if_present');
    expect(c?.pass).toBe(true);
  });

  it('commitments_not_empty_if_present fails when actual empty but golden expects', () => {
    const actual = makeActual({
      extraction: {
        commitments: [],
        citations: new Array(5).fill(0),
        decisions: new Array(5).fill(0),
        facts: new Array(12).fill(0),
      },
    });
    const results = runSemanticAssertions(actual, MANIFEST_ITEM_WITH_COMMITMENTS, {
      okrs: new Array(57).fill(0),
    });
    const c = results.find((r) => r.name === 'commitments_not_empty_if_present');
    expect(c?.pass).toBe(false);
    expect(c?.detail).toContain('expected non-empty');
  });

  it('commitments_not_empty_if_present auto-passes when golden has 0 commitments', () => {
    const actual = makeActual({
      extraction: {
        commitments: [],
        citations: new Array(5).fill(0),
        decisions: new Array(5).fill(0),
        facts: new Array(12).fill(0),
      },
    });
    const results = runSemanticAssertions(actual, MANIFEST_ITEM_NO_COMMITMENTS, {
      okrs: new Array(57).fill(0),
    });
    const c = results.find((r) => r.name === 'commitments_not_empty_if_present');
    expect(c?.pass).toBe(true);
    expect(c?.detail).toContain('auto-pass');
  });

  it('okr_references_not_empty_if_context fails when ctx has OKRs but no discussed/mentioned', () => {
    const actual = makeActual({
      analysis: {
        okr_coverage: new Array(57).fill(0).map(() => ({ status: 'blind_zone' as const })),
        alerts: new Array(5).fill(0),
      },
    });
    const results = runSemanticAssertions(actual, MANIFEST_ITEM_WITH_COMMITMENTS, {
      okrs: new Array(57).fill(0),
    });
    const r = results.find((r) => r.name === 'okr_references_not_empty_if_context');
    expect(r?.pass).toBe(false);
  });

  it('okr_references_not_empty_if_context auto-passes when no OKR context loaded', () => {
    const actual = makeActual({
      analysis: {
        okr_coverage: new Array(57).fill(0).map(() => ({ status: 'blind_zone' as const })),
        alerts: new Array(5).fill(0),
      },
    });
    const results = runSemanticAssertions(actual, MANIFEST_ITEM_WITH_COMMITMENTS, {
      okrs: [],
    });
    const r = results.find((r) => r.name === 'okr_references_not_empty_if_context');
    expect(r?.pass).toBe(true);
    expect(r?.detail).toContain('auto-pass');
  });

  it('f1_format_three_sections fails for partial reports', () => {
    const actual = makeActual({ formattedReport: { partial: true } });
    const results = runSemanticAssertions(actual, MANIFEST_ITEM_WITH_COMMITMENTS, {
      okrs: new Array(57).fill(0),
    });
    const r = results.find((r) => r.name === 'f1_format_three_sections');
    expect(r?.pass).toBe(false);
    expect(r?.detail).toContain('partial');
  });

  it('f1_format_three_sections fails when wrong number of sections', () => {
    const actual = makeActual({
      formattedReport: { partial: false, sections: new Array(2).fill(0) },
    });
    const results = runSemanticAssertions(actual, MANIFEST_ITEM_WITH_COMMITMENTS, {
      okrs: new Array(57).fill(0),
    });
    const r = results.find((r) => r.name === 'f1_format_three_sections');
    expect(r?.pass).toBe(false);
    expect(r?.detail).toContain('got 2');
  });

  it('returns exactly 3 assertions in order — F4 NOT executed', () => {
    const results = runSemanticAssertions(makeActual(), MANIFEST_ITEM_WITH_COMMITMENTS, {
      okrs: new Array(57).fill(0),
    });
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.name)).toEqual([
      'commitments_not_empty_if_present',
      'okr_references_not_empty_if_context',
      'f1_format_three_sections',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyVerdict — границы 29.9 / 30 / 49.9 / 50 / 50.1
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyVerdict', () => {
  const okAsserts = [
    { name: 'commitments_not_empty_if_present', pass: true, detail: '' },
    { name: 'okr_references_not_empty_if_context', pass: true, detail: '' },
    { name: 'f1_format_three_sections', pass: true, detail: '' },
  ] as const;

  it('diff 29.9% + clean → pass', () => {
    expect(classifyVerdict({ diffPercent: 29.9, assertions: [...okAsserts] })).toBe(
      'pass',
    );
  });

  it('diff 30.0% (inclusive boundary) → review', () => {
    expect(classifyVerdict({ diffPercent: 30, assertions: [...okAsserts] })).toBe(
      'review',
    );
  });

  it('diff 49.9% → review', () => {
    expect(classifyVerdict({ diffPercent: 49.9, assertions: [...okAsserts] })).toBe(
      'review',
    );
  });

  it('diff 50.0% (still review — exclusive rollback) → review', () => {
    expect(classifyVerdict({ diffPercent: 50, assertions: [...okAsserts] })).toBe(
      'review',
    );
  });

  it('diff 50.1% → rollback', () => {
    expect(classifyVerdict({ diffPercent: 50.1, assertions: [...okAsserts] })).toBe(
      'rollback',
    );
  });

  it('low diff + 1 assertion fail → review', () => {
    const asserts = [
      { name: 'commitments_not_empty_if_present' as const, pass: false, detail: '' },
      ...okAsserts.slice(1),
    ];
    expect(classifyVerdict({ diffPercent: 10, assertions: asserts })).toBe('review');
  });

  it('low diff + ≥2 assertion fails → rollback', () => {
    const asserts = [
      { name: 'commitments_not_empty_if_present' as const, pass: false, detail: '' },
      { name: 'okr_references_not_empty_if_context' as const, pass: false, detail: '' },
      { name: 'f1_format_three_sections' as const, pass: true, detail: '' },
    ];
    expect(classifyVerdict({ diffPercent: 10, assertions: asserts })).toBe('rollback');
  });

  it('error input → error verdict regardless of diff/asserts', () => {
    expect(
      classifyVerdict({
        diffPercent: 0,
        assertions: [...okAsserts],
        error: { code: 'extraction_validation', message: 'broken' },
      }),
    ).toBe('error');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// aggregateRunVerdict
// ─────────────────────────────────────────────────────────────────────────────

describe('aggregateRunVerdict', () => {
  it('all pass → pass', () => {
    expect(aggregateRunVerdict(['pass', 'pass', 'pass', 'pass'])).toBe('pass');
  });

  it('any rollback → rollback', () => {
    expect(aggregateRunVerdict(['pass', 'pass', 'rollback', 'pass'])).toBe('rollback');
  });

  it('any review (no rollback) → review', () => {
    expect(aggregateRunVerdict(['pass', 'review', 'pass'])).toBe('review');
  });

  it('mixed review + rollback → rollback (rollback dominates)', () => {
    expect(aggregateRunVerdict(['review', 'rollback'])).toBe('rollback');
  });

  it('mixed pass + error → pass (one error does not fail run)', () => {
    expect(aggregateRunVerdict(['pass', 'pass', 'error', 'pass'])).toBe('pass');
  });

  it('all error → error (canary infrastructure broken)', () => {
    expect(aggregateRunVerdict(['error', 'error', 'error'])).toBe('error');
  });

  it('empty items → error', () => {
    expect(aggregateRunVerdict([])).toBe('error');
  });

  it('error + review (no pass/rollback) → review', () => {
    expect(aggregateRunVerdict(['error', 'review'])).toBe('review');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractCurrentPromptVersion
// ─────────────────────────────────────────────────────────────────────────────

describe('extractCurrentPromptVersion', () => {
  it('returns first ## v line as version', () => {
    const md = `# Prompt Changelog\n\n## v1.2.0 — 2026-04-30 (Story 1.4b)\n- changes\n\n## v1.1.0 — 2026-04-30\n`;
    expect(extractCurrentPromptVersion(md)).toBe('v1.2.0');
  });

  it('empty content → unknown', () => {
    expect(extractCurrentPromptVersion('')).toBe('unknown');
  });

  it('malformed (no ## v line) → unknown', () => {
    expect(extractCurrentPromptVersion('# Some Doc\nNo versions here')).toBe('unknown');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderMarkdownReport / renderJsonReport
// ─────────────────────────────────────────────────────────────────────────────

function makeRunResult(): CanaryRunResult {
  return {
    verdict: 'review',
    meta: {
      timestamp: '2026-05-23T14:30:00+05:00',
      model: 'claude-sonnet-4-6',
      promptsVersion: 'v1.2.0',
      itemsRequested: [1, 2],
      outDir: 'data/canary-results/2026-05-23-14-30-00',
      totalTokens: { input: 30000, output: 7000 },
      estimatedCostUsd: 0.195,
      totalDurationMs: 60_000,
      pricing: { inputPerToken: 0.000003, outputPerToken: 0.000015 },
      noClaude: false,
      semanticChecksSource: 'manifest',
    },
    items: [
      {
        n: 1,
        scenario: '1:1 двух спикеров',
        verdict: 'pass',
        diff: {
          commitmentsDiff: 0,
          citationsDiff: 0,
          decisionsDiff: 0,
          factsDiff: 0,
          alertsDiff: 0,
          okrDiscussedDiff: 0,
          okrMentionedDiff: 0,
          sectionsDiff: 0,
          diffPercent: 0,
          partialReport: false,
        },
        assertions: [
          { name: 'commitments_not_empty_if_present', pass: true, detail: '5 commitments' },
          {
            name: 'okr_references_not_empty_if_context',
            pass: true,
            detail: '9 OKR references',
          },
          { name: 'f1_format_three_sections', pass: true, detail: '3 sections' },
        ],
        tokens: { input: 12345, output: 3456 },
        estimatedCostUsd: 0.088375,
        durationsMs: { total: 28000 },
        artifactsDir: 'data/canary-results/2026-05-23-14-30-00/item-1',
      },
      {
        n: 2,
        scenario: 'Группа, реструктуризация',
        verdict: 'review',
        diff: {
          commitmentsDiff: 0.5,
          citationsDiff: 0.2,
          decisionsDiff: 0,
          factsDiff: 0,
          alertsDiff: 0,
          okrDiscussedDiff: 0,
          okrMentionedDiff: 0,
          sectionsDiff: 0,
          diffPercent: 35.5,
          partialReport: false,
        },
        assertions: [
          { name: 'commitments_not_empty_if_present', pass: true, detail: '7 commitments' },
          {
            name: 'okr_references_not_empty_if_context',
            pass: true,
            detail: '9 OKR references',
          },
          { name: 'f1_format_three_sections', pass: true, detail: '3 sections' },
        ],
        tokens: { input: 18000, output: 4000 },
        estimatedCostUsd: 0.114,
        durationsMs: { total: 32000 },
        artifactsDir: 'data/canary-results/2026-05-23-14-30-00/item-2',
      },
    ],
  };
}

describe('renderMarkdownReport', () => {
  it('contains all required sections', () => {
    const md = renderMarkdownReport(makeRunResult());
    expect(md).toContain('# Canary Run');
    expect(md).toContain('## Header');
    expect(md).toContain('## Verdict');
    expect(md).toContain('## Items Summary');
    expect(md).toContain('## Per-item Details');
    expect(md).toContain('## Rollback Procedure'); // review verdict → rollback section present
    expect(md).toContain('## F4 Canary');
    expect(md).toContain('Semantic checks: manifest');
  });

  it('marks built-in semantic checks when manifest block is missing', () => {
    const run: CanaryRunResult = {
      ...makeRunResult(),
      meta: { ...makeRunResult().meta, semanticChecksSource: 'built-in-defaults' },
    };
    const md = renderMarkdownReport(run);
    expect(md).toContain('built-in defaults');
    expect(md).toContain('manifest semantic_checks missing');
  });

  it('omits rollback procedure when verdict is pass', () => {
    const passRun = { ...makeRunResult(), verdict: 'pass' as const };
    const md = renderMarkdownReport(passRun);
    expect(md).not.toContain('## Rollback Procedure');
    expect(md).toContain('🟢 **PASS**');
  });

  it('shows error verdict label when run errored', () => {
    const errRun: CanaryRunResult = {
      verdict: 'error',
      meta: makeRunResult().meta,
      items: [
        {
          n: 1,
          scenario: 'failed',
          verdict: 'error',
          error: { code: 'extraction_validation', message: 'Claude returned malformed JSON' },
        },
      ],
    };
    const md = renderMarkdownReport(errRun);
    expect(md).toContain('⚪ **ERROR**');
    expect(md).toContain('extraction_validation');
  });

  it('per-item details include diff dimensions and assertion summaries', () => {
    const md = renderMarkdownReport(makeRunResult());
    expect(md).toContain('commitmentsDiff=');
    expect(md).toContain('sectionsDiff=');
    expect(md).toContain('✓ commitments_not_empty_if_present');
  });
});

describe('renderJsonReport', () => {
  it('shape includes meta, aggregate, items[]', () => {
    const json = renderJsonReport(makeRunResult());
    expect(json.meta.model).toBe('claude-sonnet-4-6');
    expect(json.meta.promptsVersion).toBe('v1.2.0');
    expect(json.aggregate.verdict).toBe('review');
    expect(json.aggregate.totalTokens).toEqual({ input: 30000, output: 7000 });
    expect(json.items).toHaveLength(2);
    expect(json.items[0]!.verdict).toBe('pass');
    expect(json.items[0]!.estimatedCostUsd).toBe(0.088375);
    expect(json.items[1]!.diff?.diffPercent).toBe(35.5);
  });

  it('omits diff/assertions/tokens when undefined (error items)', () => {
    const errRun: CanaryRunResult = {
      verdict: 'error',
      meta: makeRunResult().meta,
      items: [
        {
          n: 1,
          scenario: 'failed',
          verdict: 'error',
          error: { code: 'unknown', message: 'timeout' },
        },
      ],
    };
    const json = renderJsonReport(errRun);
    expect(json.items[0]!.error?.code).toBe('unknown');
    expect(json.items[0]!.diff).toBeUndefined();
    expect(json.items[0]!.assertions).toBeUndefined();
    expect(json.items[0]!.tokens).toBeUndefined();
    expect(json.items[0]!.estimatedCostUsd).toBeUndefined();
  });
});
