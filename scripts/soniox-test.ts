/**
 * Soniox Validation Script — Story 0.1
 *
 * Тестирует Soniox async transcription API на реальных записях.
 * Одноразовый скрипт, НЕ production-код.
 *
 * Использование:
 *   SONIOX_API_KEY=xxx npx tsx scripts/soniox-test.ts <audio-file-or-dir>
 *
 * Примеры:
 *   # Одиночный файл
 *   SONIOX_API_KEY=xxx npx tsx scripts/soniox-test.ts data/test-audio/clean-1on1.webm
 *
 *   # Все файлы в папке
 *   SONIOX_API_KEY=xxx npx tsx scripts/soniox-test.ts data/test-audio/
 *
 * Результат сохраняется в docs/soniox-validation-results.md
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join, basename, extname } from "node:path";

// --- Config ---

const API_BASE = "https://api.soniox.com/v1";
const MODEL = "stt-async-v4";
const SUPPORTED_EXTENSIONS = new Set([
  ".aac", ".aiff", ".amr", ".asf", ".flac",
  ".mp3", ".ogg", ".wav", ".webm", ".m4a", ".mp4",
]);
const POLL_INTERVAL_MS = 5_000;
const MAX_POLL_ATTEMPTS = 120; // 10 min max
const FETCH_TIMEOUT_MS = 15 * 60 * 1000; // 15 min — покрывает upload 1 GB и долгие GET

const API_KEY = process.env.SONIOX_API_KEY?.trim();
if (!API_KEY) {
  console.error("ERROR: SONIOX_API_KEY не задан или пустой. Установите переменную окружения.");
  console.error("  SONIOX_API_KEY=xxx npx tsx scripts/soniox-test.ts <audio>");
  process.exit(1);
}

// --- Types ---

interface SonioxToken {
  text: string;
  start_ms: number;
  end_ms: number;
  confidence: number;
  speaker: string;
  language: string;
  is_audio_event: boolean;
}

interface SonioxTranscript {
  id: string;
  text: string;
  tokens: SonioxToken[];
}

interface TranscriptionStatus {
  id: string;
  status: string; // "queued" | "processing" | "completed" | "error"
  error_message?: string;
  created_at?: string;
}

interface FileUploadResponse {
  id: string;
  filename: string;
}

interface TestResult {
  filename: string;
  fileSize: string;
  uploadTime: number;
  transcriptionTime: number;
  totalTime: number;
  status: "success" | "error";
  error?: string;
  textLength?: number;
  tokenCount?: number;
  speakers?: string[];
  languages?: string[];
  durationMs?: number;
  sampleText?: string;
  languageBreakdown?: Record<string, number>;
  speakerBreakdown?: Record<string, number>;
}

// --- API Helpers ---

async function apiRequest<T>(
  method: string,
  path: string,
  body?: FormData | object,
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
  };

  let fetchBody: BodyInit | undefined;
  if (body instanceof FormData) {
    fetchBody = body;
  } else if (body) {
    headers["Content-Type"] = "application/json";
    fetchBody = JSON.stringify(body);
  }

  const response = await fetch(url, {
    method,
    headers,
    body: fetchBody,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API ${method} ${path} → ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

// --- Step 1: Upload file ---

async function uploadFile(filePath: string): Promise<string> {
  const fileBuffer = readFileSync(filePath);
  const fileName = basename(filePath);

  const formData = new FormData();
  formData.append("file", new Blob([fileBuffer]), fileName);

  console.log(`  📤 Загрузка ${fileName} (${formatBytes(fileBuffer.length)})...`);

  const result = await apiRequest<FileUploadResponse>("POST", "/files", formData);
  console.log(`  ✅ Файл загружен: ${result.id}`);
  return result.id;
}

// --- Step 2: Create transcription ---

async function createTranscription(
  fileId: string,
  webhook?: { url: string; authHeaderName?: string; authHeaderValue?: string },
): Promise<string> {
  const body: Record<string, unknown> = {
    file_id: fileId,
    model: MODEL,
    enable_speaker_diarization: true,
    enable_language_identification: true,
    language_hints: ["ru", "kk"],
  };

  if (webhook?.url) {
    body.webhook_url = webhook.url;
    if (webhook.authHeaderName && webhook.authHeaderValue) {
      body.webhook_auth_header_name = webhook.authHeaderName;
      body.webhook_auth_header_value = webhook.authHeaderValue;
    }
  }

  console.log(`  🔄 Создаю транскрипцию (модель: ${MODEL})...`);

  const result = await apiRequest<TranscriptionStatus>(
    "POST",
    "/transcriptions",
    body,
  );

  console.log(`  ✅ Транскрипция создана: ${result.id} (статус: ${result.status})`);
  return result.id;
}

// --- Step 3: Poll status ---

const KNOWN_PENDING_STATUSES = new Set(["queued", "processing"]);

async function waitForCompletion(transcriptionId: string): Promise<void> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const status = await apiRequest<TranscriptionStatus>(
      "GET",
      `/transcriptions/${transcriptionId}`,
    );

    if (status.status === "completed") {
      console.log(`  ✅ Транскрипция завершена`);
      return;
    }

    if (status.status === "error") {
      throw new Error(
        `Транскрипция завершилась с ошибкой: ${status.error_message || "unknown"}`,
      );
    }

    if (!KNOWN_PENDING_STATUSES.has(status.status)) {
      throw new Error(
        `Неизвестный статус транскрипции: "${status.status}" (id=${transcriptionId}). Прерываю polling.`,
      );
    }

    process.stdout.write(
      `  ⏳ Статус: ${status.status} (попытка ${attempt + 1}/${MAX_POLL_ATTEMPTS})...\r`,
    );
    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Timeout: транскрипция не завершилась за ${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 1000}с`);
}

// --- Step 4: Get transcript ---

async function getTranscript(transcriptionId: string): Promise<SonioxTranscript> {
  console.log(`  📥 Получаю результат транскрипции...`);
  return apiRequest<SonioxTranscript>(
    "GET",
    `/transcriptions/${transcriptionId}/transcript`,
  );
}

// --- Analysis ---

function analyzeTranscript(transcript: SonioxTranscript): {
  speakers: string[];
  languages: string[];
  durationMs: number;
  languageBreakdown: Record<string, number>;
  speakerBreakdown: Record<string, number>;
} {
  const speakers = new Set<string>();
  const languages = new Set<string>();
  const languageBreakdown: Record<string, number> = {};
  const speakerBreakdown: Record<string, number> = {};
  let maxEndMs = 0;

  if (!Array.isArray(transcript.tokens)) {
    throw new Error(
      `Soniox response не содержит поля tokens (или оно не массив): ${JSON.stringify(transcript).slice(0, 200)}`,
    );
  }

  for (const token of transcript.tokens) {
    if (token.speaker) speakers.add(token.speaker);
    if (token.language) {
      languages.add(token.language);
      languageBreakdown[token.language] =
        (languageBreakdown[token.language] || 0) + 1;
    }
    if (token.speaker) {
      speakerBreakdown[token.speaker] =
        (speakerBreakdown[token.speaker] || 0) + 1;
    }
    if (token.end_ms > maxEndMs) maxEndMs = token.end_ms;
  }

  return {
    speakers: [...speakers].sort(),
    languages: [...languages].sort(),
    durationMs: maxEndMs,
    languageBreakdown,
    speakerBreakdown,
  };
}

// --- Process single file ---

async function processFile(filePath: string): Promise<TestResult> {
  const filename = basename(filePath);
  const fileSize = formatBytes(statSync(filePath).size);

  console.log(`\n━━━ ${filename} ━━━`);

  const totalStart = Date.now();

  try {
    // Upload
    const uploadStart = Date.now();
    const fileId = await uploadFile(filePath);
    const uploadTime = Date.now() - uploadStart;

    // Create transcription
    const transcriptionStart = Date.now();
    const transcriptionId = await createTranscription(fileId);

    // Wait for completion
    await waitForCompletion(transcriptionId);
    const transcriptionTime = Date.now() - transcriptionStart;

    // Get result
    const transcript = await getTranscript(transcriptionId);
    const totalTime = Date.now() - totalStart;

    // Save raw JSON ДО анализа — чтобы локальная I/O ошибка не маскировала успешный вызов API
    const outputDir = join(process.cwd(), "data", "soniox-results");
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
    try {
      writeFileSync(
        join(outputDir, `${filename}.json`),
        JSON.stringify(transcript, null, 2),
      );
    } catch (writeErr) {
      console.error(
        `  ⚠️  Не удалось сохранить raw JSON для ${filename}: ${(writeErr as Error).message}. API-результат получен, продолжаю анализ.`,
      );
    }

    // Analyze
    const analysis = analyzeTranscript(transcript);

    console.log(`  📊 Результат:`);
    console.log(`     Текст: ${transcript.text.length} символов, ${transcript.tokens.length} tokens`);
    console.log(`     Спикеры: ${analysis.speakers.join(", ") || "не определены"}`);
    console.log(`     Языки: ${analysis.languages.join(", ") || "не определены"}`);
    console.log(`     Длительность: ${formatDuration(analysis.durationMs)}`);
    console.log(`     Время обработки: загрузка ${(uploadTime / 1000).toFixed(1)}с, транскрипция ${(transcriptionTime / 1000).toFixed(1)}с, итого ${(totalTime / 1000).toFixed(1)}с`);
    console.log(`     Распределение токенов по языкам:`, analysis.languageBreakdown);
    console.log(`     Распределение токенов по спикерам:`, analysis.speakerBreakdown);
    const previewSuffix = transcript.text.length > 200 ? "..." : "";
    console.log(`     Первые 200 символов: "${transcript.text.slice(0, 200)}${previewSuffix}"`);

    return {
      filename,
      fileSize,
      uploadTime,
      transcriptionTime,
      totalTime,
      status: "success",
      textLength: transcript.text.length,
      tokenCount: transcript.tokens.length,
      speakers: analysis.speakers,
      languages: analysis.languages,
      durationMs: analysis.durationMs,
      sampleText: transcript.text.slice(0, 200) + (transcript.text.length > 200 ? "..." : ""),
      languageBreakdown: analysis.languageBreakdown,
      speakerBreakdown: analysis.speakerBreakdown,
    };
  } catch (error) {
    const totalTime = Date.now() - totalStart;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`  ❌ Ошибка: ${message}`);

    return {
      filename,
      fileSize,
      uploadTime: 0,
      transcriptionTime: 0,
      totalTime,
      status: "error",
      error: message,
    };
  }
}

// --- Report generation ---

function generateReport(results: TestResult[]): string {
  const now = new Date().toISOString().split("T")[0];
  const successful = results.filter((r) => r.status === "success");
  const failed = results.filter((r) => r.status === "error");

  let report = `# Результаты валидации Soniox API

Дата: ${now}
Модель: ${MODEL}
Файлов обработано: ${results.length} (успех: ${successful.length}, ошибки: ${failed.length})

## Сводная таблица

| Файл | Размер | WER (ручная) | Diarization | Code-switching | Время обработки |
|------|--------|-------------|-------------|----------------|-----------------|
`;

  for (const r of results) {
    if (r.status === "success") {
      const speakers = r.speakers?.join(", ") || "—";
      const langs = r.languages?.join(", ") || "—";
      const time = `${(r.totalTime / 1000).toFixed(1)}с`;
      report += `| ${r.filename} | ${r.fileSize} | _TODO_ | ${speakers} | ${langs} | ${time} |\n`;
    } else {
      report += `| ${r.filename} | ${r.fileSize} | ERROR | — | — | — |\n`;
    }
  }

  report += `
## Детали по каждому файлу

`;

  for (const r of results) {
    report += `### ${r.filename}

- **Размер:** ${r.fileSize}
- **Статус:** ${r.status}
`;

    if (r.status === "success") {
      report += `- **Конец последнего токена (≈длительность речи):** ${formatDuration(r.durationMs || 0)}
- **Tokens:** ${r.tokenCount}
- **Текст:** ${r.textLength} символов
- **Спикеры:** ${r.speakers?.join(", ")}
- **Языки:** ${r.languages?.join(", ")}
- **Распределение токенов по языкам:** ${JSON.stringify(r.languageBreakdown)}
- **Распределение токенов по спикерам:** ${JSON.stringify(r.speakerBreakdown)}
- **Время загрузки:** ${(r.uploadTime / 1000).toFixed(1)}с
- **Время транскрипции:** ${(r.transcriptionTime / 1000).toFixed(1)}с
- **Общее время:** ${(r.totalTime / 1000).toFixed(1)}с
- **WER (ручная оценка):** _TODO: оценить вручную_
- **Первые 200 символов:** "${r.sampleText}"
`;
    } else {
      report += `- **Ошибка:** ${r.error}
`;
    }

    report += "\n";
  }

  report += `## Go/No-Go оценка

### Критические критерии

| Критерий | Порог | Результат | Статус |
|----------|-------|-----------|--------|
| WER на worst-case | < 15% | _TODO_ | ⬜ |
| Code-switching рус↔каз | Корректно на >= 3 записях | _TODO_ | ⬜ |

### Важные критерии

| Критерий | Порог | Результат | Статус |
|----------|-------|-----------|--------|
| Полный поток (запись → JSON) | < 5 мин для 30 мин | _TODO_ | ⬜ |
| Формат Google Meet совместим | webm/mp4 принимается | _TODO_ | ⬜ |
| Webhook работает | completed + error | _TODO_ | ⬜ |
| Fallback friction | < 2 мин | _TODO_ | ⬜ |

### Решение

> _TODO: Go / No-Go с обоснованием_

## Формат API ответа (Soniox)

\`\`\`json
{
  "id": "uuid",
  "text": "полный текст",
  "tokens": [
    {
      "text": "слово",
      "start_ms": 0,
      "end_ms": 450,
      "confidence": 0.97,
      "speaker": "1",
      "language": "ru",
      "is_audio_event": false
    }
  ]
}
\`\`\`

## Маппинг на Transcript Interface Contract

| Soniox | Interface Contract | Преобразование |
|--------|-------------------|----------------|
| tokens[].speaker | speakers[].name | Группировка по speaker, name = "Speaker {N}" |
| tokens[].start_ms, end_ms | segments[].start, end | Объединение последовательных tokens одного speaker |
| tokens[].text | segments[].text | Конкатенация текстов в сегменте |
| max(end_ms) | metadata.duration | Максимальное end_ms |
| tokens[].language | — | Доп. метаинформация (не в контракте) |

## Rate Limits и ценообразование

- **Rate limits:** _TODO: проверить_
- **Макс. размер файла:** 1 GB
- **Ценообразование:** _TODO: проверить в console.soniox.com_
- **Бюджет:** $0-30/мес
`;

  return report;
}

// --- Error resilience test ---

async function testErrorHandling(): Promise<void> {
  console.log("\n━━━ Тест обработки ошибок ━━━");

  // Empty/invalid file test
  try {
    console.log("  🧪 Тест: пустой файл...");
    const formData = new FormData();
    formData.append("file", new Blob([]), "empty.wav");
    await apiRequest<FileUploadResponse>("POST", "/files", formData);
    console.log("  ⚠️  Пустой файл принят (неожиданно)");
  } catch (e) {
    console.log(`  ✅ Пустой файл отклонён: ${(e as Error).message.slice(0, 100)}`);
  }

  // Invalid file content
  try {
    console.log("  🧪 Тест: битый файл (текст вместо аудио)...");
    const formData = new FormData();
    formData.append("file", new Blob(["not audio content"]), "fake.mp3");
    await apiRequest<FileUploadResponse>("POST", "/files", formData);
    console.log("  ⚠️  Битый файл принят на upload (ошибка может быть при транскрипции)");
  } catch (e) {
    console.log(`  ✅ Битый файл отклонён: ${(e as Error).message.slice(0, 100)}`);
  }
}

// --- Utilities ---

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const remainSec = sec % 60;
  return min > 0 ? `${min}м ${remainSec}с` : `${sec}с`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Main ---

async function main() {
  const input = process.argv[2];

  if (!input) {
    console.log(`Soniox Validation Script — Story 0.1

Использование:
  SONIOX_API_KEY=xxx npx tsx scripts/soniox-test.ts <audio-file-or-dir>

Поддерживаемые форматы: ${[...SUPPORTED_EXTENSIONS].join(", ")}

Режимы:
  <file>     — обработать один файл
  <dir>      — обработать все аудио-файлы в директории
  --errors   — тест обработки ошибок (пустой/битый файл)
`);
    process.exit(0);
  }

  console.log("🎯 Soniox Validation — Story 0.1");
  console.log(`   API: ${API_BASE}`);
  console.log(`   Модель: ${MODEL}`);
  console.log(`   Время: ${new Date().toISOString()}\n`);

  // Error handling test mode
  if (input === "--errors") {
    await testErrorHandling();
    return;
  }

  // Collect files
  let files: string[] = [];
  let stat;
  try {
    stat = statSync(input);
  } catch (err) {
    console.error(`Не удалось открыть путь "${input}": ${(err as Error).message}`);
    process.exit(1);
  }

  if (stat.isDirectory()) {
    files = readdirSync(input)
      .map((f) => join(input, f))
      .filter((p) => {
        try {
          return statSync(p).isFile() && SUPPORTED_EXTENSIONS.has(extname(p).toLowerCase());
        } catch {
          return false;
        }
      })
      .sort();

    if (files.length === 0) {
      console.error(`Нет аудио-файлов в ${input}`);
      console.error(`Поддерживаемые форматы: ${[...SUPPORTED_EXTENSIONS].join(", ")}`);
      process.exit(1);
    }

    console.log(`📁 Найдено ${files.length} аудио-файлов в ${input}`);
  } else {
    const ext = extname(input).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      console.error(`Неподдерживаемый формат: ${ext}`);
      console.error(`Поддерживаемые: ${[...SUPPORTED_EXTENSIONS].join(", ")}`);
      process.exit(1);
    }
    files = [input];
  }

  // Process files
  const results: TestResult[] = [];
  for (const file of files) {
    const result = await processFile(file);
    results.push(result);
  }

  // Generate report — timestamped, чтобы не затирать ручные правки прошлых прогонов
  const report = generateReport(results);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").split("T")[0] +
    "_" + new Date().toISOString().split("T")[1].slice(0, 8).replace(/:/g, "-");
  const reportPath = join(process.cwd(), "docs", `soniox-validation-results-${timestamp}.md`);
  if (!existsSync(join(process.cwd(), "docs"))) {
    mkdirSync(join(process.cwd(), "docs"), { recursive: true });
  }
  writeFileSync(reportPath, report);

  // Summary
  const successful = results.filter((r) => r.status === "success");
  console.log(`\n━━━ ИТОГО ━━━`);
  console.log(`  Обработано: ${results.length} файлов`);
  console.log(`  Успешно: ${successful.length}`);
  console.log(`  Ошибки: ${results.length - successful.length}`);
  console.log(`  Отчёт сохранён: ${reportPath}`);
  console.log(`  Raw JSON: data/soniox-results/`);
  console.log(`\n  ⚠️  Не забудьте вручную оценить WER и заполнить Go/No-Go в отчёте!`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
