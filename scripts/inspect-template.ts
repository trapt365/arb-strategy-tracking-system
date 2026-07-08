import 'dotenv/config';
import { config } from '../src/config.js';
import { createSheetsWriteClient } from '../src/adapters/sheets.js';

// Диагностика структуры шаблона F0_SHEETS_TEMPLATE_ID: печатает все вкладки
// (title / скрытая ли) и первую строку (заголовки) каждой. Только чтение.
// Запуск: npx tsx scripts/inspect-template.ts

// WSL-сеть до Google периодически рвёт сокет (ETIMEDOUT) — ретраим, как смоук.
async function withRetries<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const delays = [1000, 2000, 4000, 8000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
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
      fields: 'properties.title,sheets.properties(sheetId,title,hidden)',
    }),
  );
  // eslint-disable-next-line no-console
  console.log(`\n📄 Шаблон: «${meta.data.properties?.title ?? '?'}»  (${templateId})\n`);
  const props = (meta.data.sheets ?? []).map((s) => s.properties).filter(Boolean);
  const titles = props.map((p) => p!.title!).filter(Boolean);

  const ranges = titles.map((t) => `'${t}'!1:1`);
  const headerResp = await withRetries('get headers', () =>
    sheets.spreadsheets.values.batchGet({
      spreadsheetId: templateId,
      ranges,
    }),
  );
  const valueRanges = headerResp.data.valueRanges ?? [];

  titles.forEach((title, i) => {
    const hidden = props[i]!.hidden ? '  (скрытая)' : '';
    const header = (valueRanges[i]?.values?.[0] ?? []).map(String);
    // eslint-disable-next-line no-console
    console.log(`• «${title}»${hidden}`);
    // eslint-disable-next-line no-console
    console.log(`    заголовки: ${header.length > 0 ? header.join(' | ') : '(пусто)'}\n`);
  });

  const need = ['_okr', '_stakeholder_map', '_hypotheses', '_f5_metrics'];
  const missing = need.filter((n) => !titles.includes(n));
  // eslint-disable-next-line no-console
  console.log('— Проверка машиночитаемых вкладок —');
  // eslint-disable-next-line no-console
  console.log(`  есть: ${need.filter((n) => titles.includes(n)).join(', ') || '(ни одной)'}`);
  // eslint-disable-next-line no-console
  console.log(`  нет:  ${missing.join(', ') || '(все на месте)'}`);
}

void main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('❌', err?.message ?? err);
  process.exit(1);
});
