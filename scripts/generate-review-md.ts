/**
 * Generate Markdown Review — Story 0.3
 *
 * Читает выходы F1/F4 из data/prompt-results/<name>/ и формирует
 * человекочитаемый markdown-обзор для ручной экспертной оценки.
 *
 * Использование:
 *   npx tsx scripts/generate-review-md.ts <prompt-results-dir-name>
 *   npx tsx scripts/generate-review-md.ts --all
 *
 * Выход: docs/review-<name>.md
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const RESULTS_DIR = "data/prompt-results";
const OUT_DIR = "docs";

type Commitment = { who: string; what: string; deadline: string; quote: string };
type Citation = { timestamp: number; speaker: string; text: string };
type OkrCov = { kr: string; status: string; mentions_count?: number; substance?: boolean };
type Hypothesis = { hypothesis: string; status: string; evidence?: string[] };
type ReportSection = { title: string; content: string };
type AgendaItem = { priority: number; title: string; details: string; source: string; related_kr: string };

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function escapePipe(s: string): string {
  return String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function generate(name: string): string {
  const dir = join(RESULTS_DIR, name);

  const extraction = readJson<{
    decisions: string[];
    commitments: Commitment[];
    citations: Citation[];
    facts: string[];
    speaker_check: string[];
  }>(join(dir, "extraction.json"));
  const analysis = readJson<{
    okr_coverage: OkrCov[];
    hypothesis_status: Hypothesis[];
    alerts: string[];
  }>(join(dir, "analysis.json"));
  const format = readJson<{
    report_sections: ReportSection[];
    summary_line: string;
    commitment_count: number;
    alert_count: number;
  }>(join(dir, "format.json"));
  const agenda = readJson<{
    agenda_items: AgendaItem[];
    meeting_focus: string;
    preparation_notes: string;
  }>(join(dir, "agenda.json"));
  const contract = readJson<{
    speakers: Array<{ name: string; segments: Array<{ start: number; end: number; text: string }> }>;
    metadata: { date: string; duration: number; meeting_type: string };
  }>(join(dir, "transcript-contract.json"));

  if (!extraction || !analysis || !format) {
    throw new Error(`Не найдены F1-выходы в ${dir}`);
  }

  const lines: string[] = [];
  lines.push(`# Ревью: ${name}`);
  lines.push("");
  lines.push(`> Файл оценки выходов F1/F4 для Story 0.3 (Задача 3.2).`);
  lines.push(`> Источник: [data/prompt-results/${name}/](../data/prompt-results/${name}/)`);
  lines.push(`> Транскрипт: [transcript-contract.json](../data/prompt-results/${name}/transcript-contract.json)`);
  if (contract) {
    lines.push(`>`);
    lines.push(`> **Спикеров:** ${contract.speakers.length} | **Длительность:** ${fmtTime(contract.metadata.duration)}`);
  }
  lines.push("");

  // === Format summary ===
  lines.push("## Сводка отчёта (F1 format)");
  lines.push("");
  lines.push(`**${format.summary_line}**`);
  lines.push("");
  lines.push(`Обязательств: ${format.commitment_count} · Алертов: ${format.alert_count}`);
  lines.push("");

  // === Decisions ===
  lines.push("## Решения");
  lines.push("");
  lines.push("| # | Решение | ✅/✏️ |");
  lines.push("|---|---------|-------|");
  extraction.decisions.forEach((d, i) => {
    lines.push(`| ${i + 1} | ${escapePipe(d)} |  |`);
  });
  lines.push("");

  // === Commitments ===
  lines.push("## Обязательства");
  lines.push("");
  lines.push("| # | Кто | Что | Срок | Цитата | ✅/✏️ |");
  lines.push("|---|-----|-----|------|--------|-------|");
  extraction.commitments.forEach((c, i) => {
    lines.push(
      `| ${i + 1} | ${escapePipe(c.who)} | ${escapePipe(c.what)} | ${escapePipe(c.deadline)} | ${escapePipe(c.quote)} |  |`,
    );
  });
  lines.push("");

  // === Citations ===
  lines.push("## Ключевые цитаты");
  lines.push("");
  lines.push("| Время | Спикер | Текст | ✅/✏️ |");
  lines.push("|-------|--------|-------|-------|");
  extraction.citations.forEach(c => {
    lines.push(`| ${fmtTime(c.timestamp)} | ${escapePipe(c.speaker)} | ${escapePipe(c.text)} |  |`);
  });
  lines.push("");

  // === Facts ===
  lines.push("## Факты");
  lines.push("");
  extraction.facts.forEach(f => {
    lines.push(`- ${f}`);
  });
  lines.push("");

  // === Speaker check ===
  if (extraction.speaker_check && extraction.speaker_check.length > 0) {
    lines.push("## ⚠️ Speaker check (несоответствия)");
    lines.push("");
    extraction.speaker_check.forEach(s => lines.push(`- ${s}`));
    lines.push("");
  }

  // === OKR coverage ===
  lines.push("## OKR-покрытие (analysis)");
  lines.push("");
  const discussed = analysis.okr_coverage.filter(k => k.status === "discussed");
  const mentioned = analysis.okr_coverage.filter(k => k.status === "mentioned");
  const blind = analysis.okr_coverage.filter(k => k.status === "blind_zone");
  lines.push(`**Discussed:** ${discussed.length} · **Mentioned:** ${mentioned.length} · **Blind zone:** ${blind.length} · **Всего:** ${analysis.okr_coverage.length}`);
  lines.push("");
  lines.push("### Discussed");
  lines.push("");
  if (discussed.length === 0) {
    lines.push("_нет_");
  } else {
    lines.push("| KR | Substance | Mentions | ✅/✏️ |");
    lines.push("|----|-----------|----------|-------|");
    discussed.forEach(k => {
      lines.push(`| ${escapePipe(k.kr)} | ${k.substance ? "yes" : "no"} | ${k.mentions_count ?? "—"} |  |`);
    });
  }
  lines.push("");
  lines.push("### Mentioned");
  lines.push("");
  if (mentioned.length === 0) {
    lines.push("_нет_");
  } else {
    mentioned.forEach(k => lines.push(`- ${k.kr}`));
  }
  lines.push("");

  // === Hypothesis status ===
  if (analysis.hypothesis_status.length > 0) {
    lines.push("## Гипотезы");
    lines.push("");
    lines.push("| # | Гипотеза | Статус | Evidence |");
    lines.push("|---|----------|--------|----------|");
    analysis.hypothesis_status.forEach((h, i) => {
      const ev = (h.evidence || []).join("; ");
      lines.push(`| ${i + 1} | ${escapePipe(h.hypothesis)} | ${h.status} | ${escapePipe(ev)} |`);
    });
    lines.push("");
  }

  // === Alerts ===
  if (analysis.alerts.length > 0) {
    lines.push("## ⚠️ Алерты");
    lines.push("");
    analysis.alerts.forEach(a => lines.push(`- ${a}`));
    lines.push("");
  }

  // === Format report sections ===
  lines.push("## Отчёт (F1 format → output)");
  lines.push("");
  format.report_sections.forEach(s => {
    lines.push(`### ${s.title}`);
    lines.push("");
    lines.push(s.content);
    lines.push("");
  });

  // === F4 Agenda ===
  if (agenda) {
    lines.push("## F4: Повестка следующей встречи");
    lines.push("");
    lines.push(`**Фокус:** ${agenda.meeting_focus}`);
    lines.push("");
    lines.push(`**Подготовка:** ${agenda.preparation_notes}`);
    lines.push("");
    lines.push("| # | Приоритет | Заголовок | Источник | Related KR | ✅/✏️ |");
    lines.push("|---|-----------|-----------|----------|------------|-------|");
    agenda.agenda_items.forEach((a, i) => {
      lines.push(
        `| ${i + 1} | ${a.priority} | ${escapePipe(a.title)} | ${a.source} | ${escapePipe(a.related_kr)} |  |`,
      );
    });
    lines.push("");
    agenda.agenda_items.forEach((a, i) => {
      lines.push(`### Деталь #${i + 1}: ${a.title}`);
      lines.push("");
      lines.push(a.details);
      lines.push("");
    });
  } else {
    lines.push("## F4: Повестка следующей встречи");
    lines.push("");
    lines.push("_F4 не прогонялся для этого транскрипта (нет agenda.json)_");
    lines.push("");
  }

  // === Review template ===
  lines.push("---");
  lines.push("");
  lines.push("## Итог ручной оценки (заполни)");
  lines.push("");
  lines.push("| Критерий | Существенных правок | Комментарии |");
  lines.push("|----------|---------------------|-------------|");
  lines.push("| Фактическая точность (citations) | | |");
  lines.push("| Извлечение обязательств | | |");
  lines.push("| Решения | | |");
  lines.push("| OKR-покрытие | | |");
  lines.push("| Speaker check | | |");
  lines.push("| F4 agenda — релевантность | | |");
  lines.push("");
  lines.push("**Общий вердикт:** GO / ITERATE / STOP");
  lines.push("**Доля правок:** %");
  lines.push("");

  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const targets = all
    ? readdirSync(RESULTS_DIR).filter(d => existsSync(join(RESULTS_DIR, d, "extraction.json")))
    : args.filter(a => !a.startsWith("--"));

  if (targets.length === 0) {
    console.log("Использование:");
    console.log("  npx tsx scripts/generate-review-md.ts <name>");
    console.log("  npx tsx scripts/generate-review-md.ts --all");
    process.exit(0);
  }

  for (const name of targets) {
    try {
      const md = generate(name);
      const out = join(OUT_DIR, `review-${name.replace(/\.[^.]+$/, "")}.md`);
      writeFileSync(out, md);
      console.log(`✅ ${out}`);
    } catch (e) {
      console.error(`❌ ${name}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

main();
