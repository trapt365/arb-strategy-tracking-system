/**
 * Soniox Webhook Test — Story 0.1, Task 4
 *
 * Поднимает локальный HTTP-сервер для приёма webhook-callback'ов от Soniox,
 * отправляет тестовую транскрипцию с указанным webhook URL и логирует
 * payload + latency для статусов `completed` и `error`.
 *
 * Использование:
 *   SONIOX_API_KEY=xxx \
 *   SONIOX_WEBHOOK_URL=https://abcd1234.ngrok.io/soniox \
 *   SONIOX_WEBHOOK_SECRET=mysecret \
 *   npx tsx scripts/soniox-webhook-test.ts <audio-file>
 *
 * Требования:
 *   - ngrok (или аналог) для проброса локального порта 8787 наружу.
 *   - Запустить ngrok отдельным процессом: `ngrok http 8787`,
 *     взять https URL и подставить в SONIOX_WEBHOOK_URL (с суффиксом /soniox).
 *
 * Скрипт:
 *   1. Запускает HTTP-сервер на 0.0.0.0:8787.
 *   2. Загружает аудио → /files.
 *   3. Создаёт транскрипцию с webhook_url + webhook_auth_header_*.
 *   4. Ждёт прихода webhook (или таймаут 15 мин).
 *   5. Печатает payload, latency, статус, проверяет header авторизации.
 *
 * Это одноразовый скрипт, НЕ production-код.
 */

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// --- Config ---

const API_BASE = "https://api.soniox.com/v1";
const MODEL = "stt-async-v4";
const PORT = Number(process.env.SONIOX_WEBHOOK_PORT ?? 8787);
const WEBHOOK_PATH = "/soniox";
const FETCH_TIMEOUT_MS = 15 * 60 * 1000;
const WAIT_TIMEOUT_MS = 15 * 60 * 1000;

const API_KEY = process.env.SONIOX_API_KEY?.trim();
const WEBHOOK_URL = process.env.SONIOX_WEBHOOK_URL?.trim();
const WEBHOOK_SECRET = process.env.SONIOX_WEBHOOK_SECRET?.trim() ?? "test-secret-value";

if (!API_KEY) {
  console.error("ERROR: SONIOX_API_KEY не задан или пустой.");
  process.exit(1);
}
if (!WEBHOOK_URL) {
  console.error("ERROR: SONIOX_WEBHOOK_URL не задан. Запусти ngrok и подставь публичный URL (с суффиксом /soniox).");
  process.exit(1);
}

const audioPath = process.argv[2];
if (!audioPath) {
  console.error("Использование: npx tsx scripts/soniox-webhook-test.ts <audio-file>");
  process.exit(1);
}

// --- Webhook receiver ---

interface WebhookEvent {
  receivedAt: number;
  authHeader: string | undefined;
  authMatched: boolean;
  body: unknown;
}

async function startWebhookServer(): Promise<{
  waitForEvent: () => Promise<WebhookEvent>;
  close: () => Promise<void>;
}> {
  let resolveEvent: ((event: WebhookEvent) => void) | null = null;
  const eventPromise = new Promise<WebhookEvent>((resolve) => {
    resolveEvent = resolve;
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== WEBHOOK_PATH || req.method !== "POST") {
      res.statusCode = 404;
      res.end();
      return;
    }

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let parsed: unknown = raw;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // оставляем raw текстом
      }

      const authHeader = req.headers["authorization"];
      const expected = `Bearer ${WEBHOOK_SECRET}`;
      const authMatched = authHeader === expected;

      const event: WebhookEvent = {
        receivedAt: Date.now(),
        authHeader: typeof authHeader === "string" ? authHeader : undefined,
        authMatched,
        body: parsed,
      };

      res.statusCode = 200;
      res.end("ok");

      if (resolveEvent) {
        resolveEvent(event);
        resolveEvent = null;
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`📡 Webhook receiver слушает 0.0.0.0:${PORT}${WEBHOOK_PATH}`);
      console.log(`   Внешний URL (передаём в Soniox): ${WEBHOOK_URL}`);
      resolve();
    });
  });

  return {
    waitForEvent: () =>
      Promise.race([
        eventPromise,
        new Promise<WebhookEvent>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Timeout: webhook не пришёл за ${WAIT_TIMEOUT_MS / 1000}с`)),
            WAIT_TIMEOUT_MS,
          ),
        ),
      ]),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// --- Soniox API helpers ---

async function apiRequest<T>(method: string, path: string, body?: FormData | object): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${API_KEY}` };
  let fetchBody: BodyInit | undefined;
  if (body instanceof FormData) {
    fetchBody = body;
  } else if (body) {
    headers["Content-Type"] = "application/json";
    fetchBody = JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE}${path}`, {
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

async function uploadFile(filePath: string): Promise<string> {
  const buf = readFileSync(filePath);
  const fileName = basename(filePath);
  const fd = new FormData();
  fd.append("file", new Blob([buf]), fileName);
  console.log(`📤 Загрузка ${fileName} (${(buf.length / (1024 * 1024)).toFixed(1)} MB)...`);
  const result = await apiRequest<{ id: string }>("POST", "/files", fd);
  console.log(`   ✅ file_id: ${result.id}`);
  return result.id;
}

async function createTranscriptionWithWebhook(fileId: string, webhookUrl: string): Promise<string> {
  console.log(`🔄 Создаю транскрипцию с webhook → ${webhookUrl}`);
  const result = await apiRequest<{ id: string; status: string }>("POST", "/transcriptions", {
    file_id: fileId,
    model: MODEL,
    enable_speaker_diarization: true,
    enable_language_identification: true,
    language_hints: ["ru", "kk"],
    webhook_url: webhookUrl,
    webhook_auth_header_name: "Authorization",
    webhook_auth_header_value: `Bearer ${WEBHOOK_SECRET}`,
  });
  console.log(`   ✅ transcription_id: ${result.id} (статус: ${result.status})`);
  return result.id;
}

// --- Main ---

async function main(): Promise<void> {
  console.log("🧪 Soniox Webhook Test — Story 0.1, Task 4");
  console.log(`   API: ${API_BASE}`);
  console.log(`   Audio: ${audioPath}`);

  let stat;
  try {
    stat = statSync(audioPath);
  } catch (err) {
    console.error(`Не удалось открыть файл "${audioPath}": ${(err as Error).message}`);
    process.exit(1);
  }
  if (!stat.isFile()) {
    console.error(`"${audioPath}" не является файлом.`);
    process.exit(1);
  }

  const server = await startWebhookServer();

  try {
    const fileId = await uploadFile(audioPath);
    const sentAt = Date.now();
    const transcriptionId = await createTranscriptionWithWebhook(fileId, WEBHOOK_URL!);

    console.log(`⏳ Жду webhook...`);
    const event = await server.waitForEvent();
    const latency = event.receivedAt - sentAt;

    console.log(`\n📨 Webhook получен:`);
    console.log(`   Latency от создания транскрипции: ${(latency / 1000).toFixed(1)}с`);
    console.log(`   Authorization header: ${event.authHeader ?? "(отсутствует)"}`);
    console.log(`   Auth matched: ${event.authMatched ? "✅" : "❌"}`);
    console.log(`   Payload:`);
    console.log(JSON.stringify(event.body, null, 2));

    console.log(`\n✅ Тест webhook завершён успешно для transcription_id=${transcriptionId}`);
  } finally {
    await server.close();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
