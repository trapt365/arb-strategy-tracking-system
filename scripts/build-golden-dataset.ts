/**
 * Build Golden Dataset — Story 0.3, Задача 5
 *
 * Собирает golden dataset из validated транскриптов в data/golden/:
 *   - transcript-{N}.json (Transcript Interface Contract)
 *   - f1-reference-{N}.json (extraction + analysis + format)
 *   - f4-reference-{N}.json (agenda, для 2+)
 *   - manifest.json (метаданные + семантические проверки)
 *
 * Использование:
 *   npx tsx scripts/build-golden-dataset.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const RESULTS_DIR = "data/prompt-results";
const GOLDEN_DIR = "data/golden";

// Validated транскрипты (юзер: GO 2026-04-20, 0% правок)
// Порядок = разнообразие (1:1 → группа → code-switching → длинные)
const VALIDATED = [
  { name: "audio1100318212.m4a", scenario: "1:1 двух спикеров, code-switching РУС↔КАЗ", department: "Продажи + CPO" },
  { name: "audio1554018312.m4a", scenario: "Группа, реструктуризация лидов и видеозвонков", department: "Продажи" },
  { name: "audio1721976611.m4a", scenario: "Группа 3 спикера, бюджет и стратегия запусков", department: "Маркетинг + Продажи" },
  { name: "audio1951904349.m4a", scenario: "Группа 3 спикера, оптимизация академического отдела", department: "Академия" },
  { name: "audio1111482399.m4a", scenario: "Реструктуризация команд: маркетинг + продажи", department: "CEO + Продажи" },
  { name: "audio1602529797.m4a", scenario: "Сокращение бюджетов при критическом EBITDA", department: "CFO" },
  { name: "audio1663213769.m4a", scenario: "Найм и реорганизация HR-процессов", department: "HR + CEO" },
];

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function fmtDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s}s`;
}

function main() {
  console.log("🥇 Build Golden Dataset — Story 0.3 Задача 5\n");

  mkdirSync(GOLDEN_DIR, { recursive: true });

  const manifest = {
    _generated: new Date().toISOString(),
    _validated_by: "Тимур (GO без правок 2026-04-20)",
    _model: "claude-sonnet-4-20250514 (1-я итерация) → claude-sonnet-4-6 (2-я итерация с реальным OKR)",
    _okr_context: "data/okr-context.json (57 KR, 9 топ-менеджеров, Geonline)",
    items: [] as Array<Record<string, unknown>>,
    semantic_checks: {
      // Используются в canary-тестах (Story 1.11)
      commitments_not_empty_if_present: "Если транскрипт содержит обязательства → extraction.commitments[] не пуст",
      okr_references_not_empty_if_context: "Если OKR-контекст присутствует → analysis.okr_coverage[] содержит discussed или mentioned",
      f4_three_items: "F4.agenda_items.length === 3 (макс. 3 пункта повестки по PRD)",
      f1_format_three_sections: "format.report_sections.length === 3 (сканируемый отчёт)",
    },
  };

  let n = 0;
  for (const item of VALIDATED) {
    n++;
    const dir = join(RESULTS_DIR, item.name);

    const contract = readJson<{
      speakers: Array<{ name: string; segments: Array<{ start: number; end: number; text: string }> }>;
      metadata: { date: string; duration: number; meeting_type: string };
    }>(join(dir, "transcript-contract.json"));

    const extraction = readJson(join(dir, "extraction.json"));
    const analysis = readJson(join(dir, "analysis.json"));
    const format = readJson(join(dir, "format.json"));

    const agendaPath = join(dir, "agenda.json");
    const agenda = existsSync(agendaPath) ? readJson(agendaPath) : null;

    // Write transcript-N.json
    writeFileSync(
      join(GOLDEN_DIR, `transcript-${n}.json`),
      JSON.stringify(contract, null, 2),
    );

    // Write f1-reference-N.json (объединённый: extraction + analysis + format)
    writeFileSync(
      join(GOLDEN_DIR, `f1-reference-${n}.json`),
      JSON.stringify({ extraction, analysis, format }, null, 2),
    );

    // Write f4-reference-N.json (если есть)
    if (agenda) {
      writeFileSync(
        join(GOLDEN_DIR, `f4-reference-${n}.json`),
        JSON.stringify(agenda, null, 2),
      );
    }

    // Add to manifest
    type ExtractionShape = { commitments: unknown[]; decisions: unknown[]; facts: unknown[]; citations: unknown[] };
    type AnalysisShape = { okr_coverage: Array<{ status: string }>; alerts: unknown[] };
    const ext = extraction as ExtractionShape;
    const ana = analysis as AnalysisShape;
    manifest.items.push({
      n,
      source_file: item.name,
      scenario: item.scenario,
      department: item.department,
      speakers_count: contract.speakers.length,
      duration: fmtDuration(contract.metadata.duration),
      duration_seconds: contract.metadata.duration,
      languages: ["ru", "kk"],
      stats: {
        commitments: ext.commitments.length,
        decisions: ext.decisions.length,
        facts: ext.facts.length,
        citations: ext.citations.length,
        okr_discussed: ana.okr_coverage.filter(k => k.status === "discussed").length,
        okr_mentioned: ana.okr_coverage.filter(k => k.status === "mentioned").length,
        alerts: ana.alerts.length,
      },
      has_f4: agenda !== null,
      files: {
        transcript: `transcript-${n}.json`,
        f1_reference: `f1-reference-${n}.json`,
        f4_reference: agenda ? `f4-reference-${n}.json` : null,
      },
    });

    console.log(`  ✅ #${n} ${item.name} (${item.scenario.slice(0, 40)}...)`);
  }

  writeFileSync(
    join(GOLDEN_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );

  console.log(`\n📊 Итого: ${n} транскриптов в golden dataset`);
  console.log(`📁 ${GOLDEN_DIR}/`);
  console.log(`📄 manifest.json — метаданные + семантические проверки`);
}

main();
