import 'dotenv/config';
import { config } from '../src/config.js';
import { createSheetsWriteClient } from '../src/adapters/sheets.js';

// Добавляет header-only вкладку `_f5_metrics` в шаблон F0_SHEETS_TEMPLATE_ID, если её нет.
// F1 /report читает `_f5_metrics`; без вкладки — sheet_not_found. С одной шапкой — 0 метрик (ок).
// Идемпотентно: если вкладка уже есть, ничего не меняет (данные не трогаем).
// Запуск: npx tsx scripts/add-f5-metrics-tab.ts

const F5_SHEET = '_f5_metrics';
// Должно совпадать с EXPECTED_HEADERS.f5Metrics в src/adapters/sheets.ts.
const F5_HEADER = [
  'department',
  'metric_name',
  'metric_type',
  'unit',
  'source',
  'owner_speaker_name',
  'ranges',
  'update_frequency',
  'risk_notes',
  'notes',
] as const;

// WSL-сеть до Google иногда не рвёт сокет с ошибкой, а «немо» зависает — обычный ретрай
// по ошибке тут не срабатывает. Поэтому каждую попытку гоним в гонке с таймером: зависание
// → отвал по таймауту → следующий ретрай (новый сокет).
function withTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms).unref(),
    ),
  ]);
}

async function withRetries<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const delays = [1000, 2000, 4000, 8000, 8000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await withTimeout(25_000, fn);
    } catch (err) {
      lastErr = err;
      if (attempt === delays.length) break;
      // eslint-disable-next-line no-console
      console.error(`… ${label}: сетевой сбой, повтор ${attempt + 1}/${delays.length}`);
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  throw lastErr;
}

async function main(): Promise<void> {
  const templateId = config.F0_SHEETS_TEMPLATE_ID.trim();
  if (templateId === '') {
    // eslint-disable-next-line no-console
    console.error('❌ F0_SHEETS_TEMPLATE_ID пуст в .env');
    process.exit(1);
  }
  const sheets = await createSheetsWriteClient();

  const meta = await withRetries('get meta', () =>
    sheets.spreadsheets.get({
      spreadsheetId: templateId,
      fields: 'properties.title,sheets.properties(title)',
    }),
  );
  const title = meta.data.properties?.title ?? '?';
  const titles = (meta.data.sheets ?? [])
    .map((s) => s.properties?.title)
    .filter((t): t is string => Boolean(t));

  // eslint-disable-next-line no-console
  console.log(`\n📄 Шаблон: «${title}»  (${templateId})`);

  if (titles.includes(F5_SHEET)) {
    // eslint-disable-next-line no-console
    console.log(`✅ Вкладка «${F5_SHEET}» уже есть — ничего не меняю.\n`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`➕ Вкладки «${F5_SHEET}» нет — создаю с шапкой…`);
  await withRetries('addSheet', () =>
    sheets.spreadsheets.batchUpdate({
      spreadsheetId: templateId,
      requestBody: { requests: [{ addSheet: { properties: { title: F5_SHEET } } }] },
    }),
  );
  await withRetries('write header', () =>
    sheets.spreadsheets.values.update({
      spreadsheetId: templateId,
      range: `${F5_SHEET}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [[...F5_HEADER]] },
    }),
  );
  // eslint-disable-next-line no-console
  console.log(`✅ Готово. Шапка: ${F5_HEADER.join(' | ')}\n`);
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('❌', err?.message ?? err);
  process.exit(1);
});
