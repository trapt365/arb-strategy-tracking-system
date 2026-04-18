/**
 * Prepare Test Data — Story 0.3, Задача 2
 *
 * Конвертирует Soniox JSON → Transcript Interface Contract
 * и подготавливает тестовые входы для prompt-test.ts
 *
 * Использование:
 *   npx tsx scripts/prepare-test-data.ts
 *
 * Входы: data/soniox-results/*.json
 * Выходы: data/test-inputs/
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

// --- Types ---

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

// --- Soniox → Contract Converter ---

function convertSonioxToContract(soniox: SonioxTranscript): TranscriptContract {
  const speakerMap = new Map<string, TranscriptSegment[]>();
  let currentSpeaker: string | null = null;
  let currentSegment: { start: number; end: number; texts: string[] } | null = null;

  for (const token of soniox.tokens) {
    const speaker = token.speaker || "unknown";

    if (speaker !== currentSpeaker) {
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
    .map(([id, segments]) => ({ name: `Speaker ${id}`, segments }));

  return {
    speakers,
    metadata: {
      date: "unknown",
      duration: maxEndMs / 1000,
      meeting_type: "unknown",
    },
  };
}

// --- Language stats ---

function getLanguageStats(tokens: SonioxToken[]): Record<string, number> {
  const stats: Record<string, number> = {};
  for (const t of tokens) {
    if (t.language) {
      stats[t.language] = (stats[t.language] || 0) + 1;
    }
  }
  return stats;
}

// --- Main ---

function main() {
  const sonioxDir = join(process.cwd(), "data", "soniox-results");
  const outputDir = join(process.cwd(), "data", "test-inputs");

  if (!existsSync(sonioxDir)) {
    console.error(`❌ Директория не найдена: ${sonioxDir}`);
    process.exit(1);
  }

  mkdirSync(outputDir, { recursive: true });

  const files = readdirSync(sonioxDir).filter(f => f.endsWith(".json")).sort();
  console.log(`📁 Найдено ${files.length} Soniox JSON-файлов\n`);

  const summary: Array<{
    filename: string;
    speakers: number;
    segments: number;
    durationMin: number;
    languages: Record<string, number>;
    textLength: number;
  }> = [];

  for (const file of files) {
    const filePath = join(sonioxDir, file);
    const raw = readFileSync(filePath, "utf-8");
    const soniox: SonioxTranscript = JSON.parse(raw);

    const contract = convertSonioxToContract(soniox);
    const langStats = getLanguageStats(soniox.tokens);
    const totalSegments = contract.speakers.reduce((sum, s) => sum + s.segments.length, 0);

    const outName = basename(file, ".json").replace(".m4a", "");
    writeFileSync(
      join(outputDir, `${outName}.json`),
      JSON.stringify(contract, null, 2),
    );

    const info = {
      filename: file,
      speakers: contract.speakers.length,
      segments: totalSegments,
      durationMin: Math.round(contract.metadata.duration / 60 * 10) / 10,
      languages: langStats,
      textLength: soniox.text.length,
    };

    summary.push(info);

    console.log(`  ✅ ${file}`);
    console.log(`     Спикеры: ${info.speakers}, Сегменты: ${info.segments}, Длительность: ${info.durationMin} мин`);
    console.log(`     Языки: ${JSON.stringify(langStats)}`);
    console.log(`     Текст: ${info.textLength} символов\n`);
  }

  // Save summary
  writeFileSync(
    join(outputDir, "summary.json"),
    JSON.stringify(summary, null, 2),
  );

  console.log("━━━ ИТОГО ━━━");
  console.log(`  Конвертировано: ${files.length} файлов`);
  console.log(`  Выход: ${outputDir}/`);
  console.log(`  Сводка: ${join(outputDir, "summary.json")}`);

  // Recommendations for golden set diversity
  console.log("\n📋 Рекомендации для golden set:");
  const multiLang = summary.filter(s => Object.keys(s.languages).length > 1);
  const multiSpeaker = summary.filter(s => s.speakers > 2);
  console.log(`  Code-switching (>1 язык): ${multiLang.length} файлов`);
  console.log(`  Групповые (>2 спикера): ${multiSpeaker.length} файлов`);
}

main();
