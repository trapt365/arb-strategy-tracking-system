/**
 * Prompt Testing Script — Story 0.3
 *
 * Прогоняет F1-цепочку (4 шага) и F4-промпт через Claude API.
 * Одноразовый тестовый скрипт, НЕ production-код.
 *
 * Использование:
 *   npx tsx scripts/prompt-test.ts <transcript-json> [--f4]
 *   npx tsx scripts/prompt-test.ts data/soniox-results/  # все файлы в папке
 *
 * Переменные окружения (.env):
 *   API_KEY_CLAUDE — ключ Claude API
 *
 * Результаты: data/prompt-results/<filename>/
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { config } from "dotenv";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod/v4";

config();

// --- Config ---

const CLAUDE_MODEL = "claude-sonnet-4-6";
const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 3000, 9000];
const MAX_TOKENS = 8192;

const API_KEY = process.env.API_KEY_CLAUDE?.trim();
if (!API_KEY) {
  console.error("ERROR: API_KEY_CLAUDE не задан. Добавьте в .env файл.");
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: API_KEY });

// --- Zod Schemas ---

const ExtractionOutputSchema = z.object({
  decisions: z.array(z.string()),
  commitments: z.array(z.object({
    who: z.string(),
    what: z.string(),
    deadline: z.string(),
    quote: z.string(),
  })),
  citations: z.array(z.object({
    timestamp: z.number(),
    speaker: z.string(),
    text: z.string(),
  })),
  facts: z.array(z.string()),
  speaker_check: z.array(z.string()).optional().default([]),
});

const AnalysisOutputSchema = z.object({
  okr_coverage: z.array(z.object({
    kr: z.string(),
    status: z.enum(["discussed", "mentioned", "blind_zone"]),
    mentions_count: z.number().optional().default(0),
    substance: z.boolean().optional().default(false),
  })),
  hypothesis_status: z.array(z.object({
    hypothesis: z.string(),
    status: z.enum(["idea", "in_test", "result"]),
    evidence: z.array(z.string()).optional().default([]),
  })),
  alerts: z.array(z.string()),
});

const FormatOutputSchema = z.object({
  report_sections: z.array(z.object({
    title: z.string(),
    content: z.string(),
  })),
  summary_line: z.string(),
  commitment_count: z.number(),
  alert_count: z.number(),
});

const AgendaOutputSchema = z.object({
  agenda_items: z.array(z.object({
    priority: z.number(),
    title: z.string(),
    details: z.string(),
    source: z.string(),
    related_kr: z.string().nullable().optional().transform(v => v ?? ""),
  })),
  meeting_focus: z.string(),
  preparation_notes: z.string(),
});

type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;
type AnalysisOutput = z.infer<typeof AnalysisOutputSchema>;
type FormatOutput = z.infer<typeof FormatOutputSchema>;
type AgendaOutput = z.infer<typeof AgendaOutputSchema>;

// --- Soniox Types ---

interface SonioxToken {
  text: string;
  start_ms: number;
  end_ms: number;
  confidence: number;
  speaker: string;
  language: string;
}

interface SonioxTranscript {
  id: string;
  text: string;
  tokens: SonioxToken[];
}

// --- Transcript Interface Contract ---

interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

interface TranscriptSpeaker {
  name: string;
  segments: TranscriptSegment[];
}

interface TranscriptContract {
  speakers: TranscriptSpeaker[];
  metadata: {
    date: string;
    duration: number;
    meeting_type: string;
  };
}

// --- Prompt Loader ---

function loadPrompt(name: string, vars: Record<string, string>): string {
  const promptPath = join(process.cwd(), "prompts", `${name}.md`);
  if (!existsSync(promptPath)) {
    throw new Error(`Промпт не найден: ${promptPath}`);
  }

  let content = readFileSync(promptPath, "utf-8");

  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }

  // Fail fast: unreplaced vars
  const unreplaced = content.match(/\{\{[a-zA-Z]+\}\}/g);
  if (unreplaced) {
    throw new Error(
      `Незаменённые переменные в промпте "${name}": ${unreplaced.join(", ")}`
    );
  }

  return content;
}

// --- Claude API Call with Retry ---

function parseClaudeJSON<T>(raw: string, schema: z.ZodType<T>): T {
  // Strip markdown fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  const parsed = JSON.parse(cleaned);
  return schema.parse(parsed);
}

async function callClaude(prompt: string, stepName: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      console.log(`    🤖 Claude API: ${stepName} (попытка ${attempt + 1}/${MAX_RETRIES})...`);
      const startMs = Date.now();

      const message = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
      });

      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      const textBlock = message.content.find(b => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new Error("Claude не вернул текстовый ответ");
      }

      console.log(`    ✅ ${stepName}: ${elapsed}с, ${message.usage.input_tokens} in / ${message.usage.output_tokens} out`);
      return textBlock.text;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`    ❌ ${stepName} ошибка: ${msg}`);

      if (attempt < MAX_RETRIES - 1) {
        const delay = RETRY_DELAYS[attempt]!;
        console.log(`    ⏳ Повтор через ${delay / 1000}с...`);
        await sleep(delay);
      } else {
        throw new Error(`${stepName}: все ${MAX_RETRIES} попытки неуспешны. Последняя ошибка: ${msg}`);
      }
    }
  }

  throw new Error("Unreachable");
}

// --- Soniox → Transcript Contract Converter ---

function convertSonioxToContract(soniox: SonioxTranscript, filename: string): TranscriptContract {
  const speakerMap = new Map<string, TranscriptSegment[]>();
  let currentSpeaker: string | null = null;
  let currentSegment: { start: number; end: number; texts: string[] } | null = null;

  for (const token of soniox.tokens) {
    const speaker = token.speaker || "unknown";

    if (speaker !== currentSpeaker) {
      // Flush previous segment
      if (currentSegment && currentSpeaker) {
        const segments = speakerMap.get(currentSpeaker) || [];
        segments.push({
          start: currentSegment.start / 1000,
          end: currentSegment.end / 1000,
          text: currentSegment.texts.join(""),
        });
        speakerMap.set(currentSpeaker, segments);
      }

      currentSpeaker = speaker;
      currentSegment = { start: token.start_ms, end: token.end_ms, texts: [token.text] };
    } else if (currentSegment) {
      currentSegment.end = token.end_ms;
      currentSegment.texts.push(token.text);
    }
  }

  // Flush last segment
  if (currentSegment && currentSpeaker) {
    const segments = speakerMap.get(currentSpeaker) || [];
    segments.push({
      start: currentSegment.start / 1000,
      end: currentSegment.end / 1000,
      text: currentSegment.texts.join(""),
    });
    speakerMap.set(currentSpeaker, segments);
  }

  const maxEndMs = soniox.tokens.length > 0
    ? Math.max(...soniox.tokens.map(t => t.end_ms))
    : 0;

  const speakers: TranscriptSpeaker[] = [...speakerMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, segments]) => ({
      name: `Speaker ${id}`,
      segments,
    }));

  return {
    speakers,
    metadata: {
      date: "unknown",
      duration: maxEndMs / 1000,
      meeting_type: "unknown",
    },
  };
}

// --- Format transcript for prompt insertion ---

function formatTranscriptForPrompt(contract: TranscriptContract): string {
  const lines: string[] = [];

  // Merge all segments from all speakers, sort by start time
  const allSegments: { speaker: string; start: number; end: number; text: string }[] = [];
  for (const speaker of contract.speakers) {
    for (const seg of speaker.segments) {
      allSegments.push({ speaker: speaker.name, start: seg.start, end: seg.end, text: seg.text });
    }
  }
  allSegments.sort((a, b) => a.start - b.start);

  for (const seg of allSegments) {
    const mm = String(Math.floor(seg.start / 60)).padStart(2, "0");
    const ss = String(Math.floor(seg.start % 60)).padStart(2, "0");
    lines.push(`[${mm}:${ss}] ${seg.speaker}: ${seg.text.trim()}`);
  }

  return lines.join("\n");
}

// --- Run F1 Chain ---

interface F1Result {
  extraction: ExtractionOutput;
  analysis: AnalysisOutput;
  format: FormatOutput;
  rawResponses: { extraction: string; analysis: string; format: string };
  timing: { extraction: number; analysis: number; format: number; total: number };
}

async function runF1Chain(
  transcriptText: string,
  okrContext: string,
  stakeholderMap: string,
): Promise<F1Result> {
  const totalStart = Date.now();
  const rawResponses: Record<string, string> = {};
  const timing: Record<string, number> = {};

  // Step 1: Extraction
  const extractionStart = Date.now();
  const extractionPrompt = loadPrompt("extraction", { transcript: transcriptText, stakeholderMap });
  const extractionRaw = await callClaude(extractionPrompt, "Extraction");
  rawResponses.extraction = extractionRaw;
  const extraction = parseClaudeJSON(extractionRaw, ExtractionOutputSchema);
  timing.extraction = Date.now() - extractionStart;

  console.log(`    📊 Extraction: ${extraction.decisions.length} решений, ${extraction.commitments.length} обязательств, ${extraction.facts.length} фактов`);

  // Step 2: Analysis
  const analysisStart = Date.now();
  const analysisPrompt = loadPrompt("analysis", {
    okrContext,
    extractionOutput: JSON.stringify(extraction, null, 2),
    stakeholderMap,
  });
  const analysisRaw = await callClaude(analysisPrompt, "Analysis");
  rawResponses.analysis = analysisRaw;
  const analysis = parseClaudeJSON(analysisRaw, AnalysisOutputSchema);
  timing.analysis = Date.now() - analysisStart;

  console.log(`    📊 Analysis: ${analysis.okr_coverage.length} KRs, ${analysis.alerts.length} алертов`);

  // Step 3: Format
  const formatStart = Date.now();
  const formatPrompt = loadPrompt("format-tracker", {
    analysisOutput: JSON.stringify(analysis, null, 2),
    extractionOutput: JSON.stringify(extraction, null, 2),
  });
  const formatRaw = await callClaude(formatPrompt, "Format");
  rawResponses.format = formatRaw;
  const format = parseClaudeJSON(formatRaw, FormatOutputSchema);
  timing.format = Date.now() - formatStart;

  console.log(`    📊 Format: ${format.report_sections.length} секций, "${format.summary_line}"`);

  timing.total = Date.now() - totalStart;

  return {
    extraction,
    analysis,
    format,
    rawResponses: rawResponses as F1Result["rawResponses"],
    timing: timing as F1Result["timing"],
  };
}

// --- Run F4 Agenda ---

async function runF4Agenda(
  previousReport: string,
  okrContext: string,
  stakeholderMap: string,
): Promise<{ agenda: AgendaOutput; raw: string; timing: number }> {
  const start = Date.now();

  const prompt = loadPrompt("agenda", { previousReport, okrContext, stakeholderMap });
  const raw = await callClaude(prompt, "Agenda (F4)");
  const agenda = parseClaudeJSON(raw, AgendaOutputSchema);

  console.log(`    📊 Agenda: ${agenda.agenda_items.length} пунктов, ф��кус: "${agenda.meeting_focus}"`);

  return { agenda, raw, timing: Date.now() - start };
}

// --- Save Results ---

function saveResults(outputDir: string, filename: string, f1: F1Result, f4?: { agenda: AgendaOutput; raw: string }): void {
  const dir = join(outputDir, filename.replace(/\.[^.]+$/, ""));
  mkdirSync(dir, { recursive: true });

  // Raw responses
  writeFileSync(join(dir, "extraction-raw.txt"), f1.rawResponses.extraction);
  writeFileSync(join(dir, "analysis-raw.txt"), f1.rawResponses.analysis);
  writeFileSync(join(dir, "format-raw.txt"), f1.rawResponses.format);

  // Parsed outputs
  writeFileSync(join(dir, "extraction.json"), JSON.stringify(f1.extraction, null, 2));
  writeFileSync(join(dir, "analysis.json"), JSON.stringify(f1.analysis, null, 2));
  writeFileSync(join(dir, "format.json"), JSON.stringify(f1.format, null, 2));

  // Timing
  writeFileSync(join(dir, "timing.json"), JSON.stringify(f1.timing, null, 2));

  // F4
  if (f4) {
    writeFileSync(join(dir, "agenda-raw.txt"), f4.raw);
    writeFileSync(join(dir, "agenda.json"), JSON.stringify(f4.agenda, null, 2));
  }

  console.log(`    💾 Результаты сохранены: ${dir}/`);
}

// --- Load context data ---

function loadOkrContext(): string {
  // Try local cached OKR data, or return placeholder
  const paths = [
    join(process.cwd(), "data", "okr-context.json"),
    join(process.cwd(), "data", "okr-context.txt"),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      return readFileSync(p, "utf-8");
    }
  }

  console.log("  ⚠️  OKR-контекст не найден (data/okr-context.json). Используется пустой контекст.");
  return "OKR-контекст недоступен. Пропусти OKR-анализ и сфокусируйся на извлечении фактов и обязательств.";
}

function loadStakeholderMap(): string {
  const paths = [
    join(process.cwd(), "data", "stakeholder-map.json"),
    join(process.cwd(), "data", "stakeholder-map.txt"),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      return readFileSync(p, "utf-8");
    }
  }

  console.log("  ⚠️  Стейкхолдерная карта не найдена (data/stakeholder-map.json). Спикеры будут Speaker N.");
  return "Стейк��олдерная карта недоступна. Используй Speaker N для обозначения спикеров.";
}

// --- Diff stats between runs ---

function computeDiffStats(a: unknown, b: unknown, path = ""): { changed: number; total: number; details: string[] } {
  const details: string[] = [];
  let changed = 0;
  let total = 0;

  if (typeof a !== typeof b) {
    return { changed: 1, total: 1, details: [`${path}: type mismatch`] };
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    total = Math.max(a.length, b.length);
    if (a.length !== b.length) {
      details.push(`${path}: array length ${a.length} → ${b.length}`);
      changed += Math.abs(a.length - b.length);
    }
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const sub = computeDiffStats(a[i], b[i], `${path}[${i}]`);
      changed += sub.changed;
      total += sub.total;
      details.push(...sub.details);
    }
    return { changed, total: Math.max(total, 1), details };
  }

  if (a && typeof a === "object" && b && typeof b === "object" && !Array.isArray(a)) {
    const keys = new Set([...Object.keys(a as Record<string, unknown>), ...Object.keys(b as Record<string, unknown>)]);
    for (const key of keys) {
      const sub = computeDiffStats(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
      changed += sub.changed;
      total += sub.total;
      details.push(...sub.details);
    }
    return { changed, total: Math.max(total, 1), details };
  }

  // Primitive
  total = 1;
  if (a !== b) {
    changed = 1;
    details.push(`${path}: "${String(a).slice(0, 50)}" → "${String(b).slice(0, 50)}"`);
  }

  return { changed, total, details };
}

// --- Utilities ---

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  return min > 0 ? `${min}м ${sec % 60}с` : `${sec}��`;
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const runF4 = args.includes("--f4");
  const inputPath = args.find(a => !a.startsWith("--"));

  if (!inputPath) {
    console.log(`Prompt Testing Script — Story 0.3

Использование:
  npx tsx scripts/prompt-test.ts <transcript.json>     # один фай��
  npx tsx scripts/prompt-test.ts <dir>                 # все JSON в папке
  npx tsx scripts/prompt-test.ts <file> --f4           # F1 + F4

Переменные окружения (.env):
  API_KEY_CLAUDE — ключ Claude API

Промпты: prompts/*.md
Результаты: data/prompt-results/
`);
    process.exit(0);
  }

  console.log("🎯 Prompt Testing — Story 0.3");
  console.log(`   Модель: ${CLAUDE_MODEL}`);
  console.log(`   F4: ${runF4 ? "да" : "нет (добавьте --f4)"}`);
  console.log(`   Время: ${new Date().toISOString()}\n`);

  // Collect files
  let files: string[] = [];
  const stat = statSync(inputPath);

  if (stat.isDirectory()) {
    files = readdirSync(inputPath)
      .filter(f => f.endsWith(".json"))
      .map(f => join(inputPath, f))
      .sort();
    console.log(`📁 Найдено ${files.length} JSON-файлов в ${inputPath}\n`);
  } else {
    files = [inputPath];
  }

  // Load context
  const okrContext = loadOkrContext();
  const stakeholderMap = loadStakeholderMap();

  const outputDir = join(process.cwd(), "data", "prompt-results");
  mkdirSync(outputDir, { recursive: true });

  const results: Array<{
    filename: string;
    status: "success" | "error";
    error?: string;
    f1?: F1Result;
    f4?: { agenda: AgendaOutput; raw: string };
  }> = [];

  for (const file of files) {
    const filename = basename(file);
    console.log(`\n━━━ ${filename} ━━━`);

    try {
      // Load and convert Soniox transcript
      const raw = readFileSync(file, "utf-8");
      const soniox: SonioxTranscript = JSON.parse(raw);
      const contract = convertSonioxToContract(soniox, filename);
      const transcriptText = formatTranscriptForPrompt(contract);

      console.log(`  📝 Транскрипт: ${contract.speakers.length} спикеров, ${formatDuration(contract.metadata.duration * 1000)}`);

      // Save normalized transcript
      const normDir = join(outputDir, filename.replace(/\.[^.]+$/, ""));
      mkdirSync(normDir, { recursive: true });
      writeFileSync(join(normDir, "transcript-contract.json"), JSON.stringify(contract, null, 2));

      // Run F1 chain
      console.log("  🔗 Запуск F1-цепочки...");
      const f1 = await runF1Chain(transcriptText, okrContext, stakeholderMap);

      // Run F4 if requested
      let f4: { agenda: AgendaOutput; raw: string } | undefined;
      if (runF4) {
        console.log("  📋 Запуск F4-повестки...");
        const previousReport = JSON.stringify({
          extraction: f1.extraction,
          analysis: f1.analysis,
          format: f1.format,
        }, null, 2);
        const result = await runF4Agenda(previousReport, okrContext, stakeholderMap);
        f4 = { agenda: result.agenda, raw: result.raw };
      }

      saveResults(outputDir, filename, f1, f4);

      console.log(`  ⏱️  Общее время F1: ${formatDuration(f1.timing.total)}`);

      results.push({ filename, status: "success", f1, f4 });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  ❌ ОШИБКА: ${msg}`);
      results.push({ filename, status: "error", error: msg });
    }
  }

  // Summary
  console.log("\n━━━ ИТОГО ━━━");
  const ok = results.filter(r => r.status === "success");
  const failed = results.filter(r => r.status === "error");
  console.log(`  Обработано: ${results.length} файлов`);
  console.log(`  Успешно: ${ok.length}`);
  console.log(`  Ошибки: ${failed.length}`);
  console.log(`  Результаты: ${outputDir}/`);

  if (ok.length > 0) {
    console.log("\n  📊 Сводка:");
    for (const r of ok) {
      if (r.f1) {
        console.log(`    ${r.filename}: ${r.f1.extraction.commitments.length} обязательств, ${r.f1.extraction.decisions.length} решений, ${formatDuration(r.f1.timing.total)}`);
      }
    }
  }

  if (failed.length > 0) {
    console.log("\n  ❌ Ошибки:");
    for (const r of failed) {
      console.log(`    ${r.filename}: ${r.error}`);
    }
  }

  // Diff stats (if multiple runs exist)
  if (ok.length >= 2) {
    console.log("\n  📈 Diff-статистика между прогонами:");
    for (let i = 1; i < ok.length; i++) {
      const prev = ok[i - 1]!.f1!.extraction;
      const curr = ok[i]!.f1!.extraction;
      const diff = computeDiffStats(prev, curr);
      const pct = ((diff.changed / diff.total) * 100).toFixed(1);
      console.log(`    ${ok[i - 1]!.filename} ↔ ${ok[i]!.filename}: ${pct}% структурных изменений (${diff.changed}/${diff.total})`);
    }
  }

  console.log(`\n  ⚠️  Не забудьте: ручная экспертная оценка каждого выхода!`);
  console.log(`  📝  Критерии: фактическая точность, обязательства, OKR-покрытие, [speaker_check], [approximate]`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
