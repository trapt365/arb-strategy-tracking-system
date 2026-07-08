import 'dotenv/config';
import { createClientSpreadsheet } from '../src/f0-sheets.js';
import { F0SheetsError } from '../src/errors.js';
import { logger } from '../src/logger.js';
import type { F0FullExtraction } from '../src/types.js';

// Story 7.4 live smoke: реальная копия шаблона v2.0 + запись данных + шаринг.
// Требует: F0_SHEETS_TEMPLATE_ID (fileId шаблона в Drive как Google Sheet),
// F0_SHEETS_SHARE_EMAILS (кому выдать доступ), рабочие креды SA с доступом к шаблону.
// Запуск: npx tsx scripts/f0-sheets-smoke.ts

const extraction: F0FullExtraction = {
  document_type: 'strategy',
  company: 'SMOKE-TEST',
  objectives: [
    {
      title: 'Рост выручки',
      krs: [
        { formulation: 'Подписчики с 15 000 до 50 000', base: '15 000', target: '50 000', owner: 'Мақсат', deadline: 'Q4 2026' },
        { formulation: 'EBITDA до 15%', base: '9%', target: '15%', owner: 'Дамир', deadline: 'Q4 2026' },
      ],
    },
  ],
  hypotheses: [
    { statement: 'Лидмагниты повышают доходимость', ifThenBecause: 'ЕСЛИ давать лидмагнит, ТО доходимость растёт, ПОТОМУ ЧТО ниже барьер', metric: 'доходимость, %', department: 'Маркетинг', synthesized: false },
    { statement: 'B2G пилот', ifThenBecause: null, metric: 'кол-во сделок', department: 'Продажи', synthesized: true },
  ],
  participants: [
    { name: 'Дамир', role: 'CEO', department: 'Управление', contact: '@damir' },
    { name: 'Жанель', role: 'РОП', department: 'Продажи', contact: null },
  ],
  unrecognized: [],
};

async function main(): Promise<void> {
  const dateStr = new Date().toISOString().slice(0, 10);
  try {
    const result = await createClientSpreadsheet({
      extraction,
      spreadsheetName: `Стратегический трекинг v2.0 — SMOKE (${dateStr})`,
      logger,
    });
    // eslint-disable-next-line no-console
    console.log('✅ SPREADSHEET CREATED');
    // eslint-disable-next-line no-console
    console.log('URL:', result.spreadsheetUrl);
    // eslint-disable-next-line no-console
    console.log('counts:', JSON.stringify(result.counts), 'shared:', result.shared.join(', ') || '(none)');
    // eslint-disable-next-line no-console
    console.log('\n⚠️ Удали тестовую таблицу вручную из Drive сервис-аккаунта после проверки.');
  } catch (err) {
    if (err instanceof F0SheetsError) {
      // eslint-disable-next-line no-console
      console.error(`❌ F0SheetsError [${err.code}]`, JSON.stringify(err.context));
      if (err.spreadsheetId) {
        // eslint-disable-next-line no-console
        console.error('   (таблица создана:', err.spreadsheetId, '— повтори тем же id, чтобы не плодить дубли)');
      }
    } else {
      // eslint-disable-next-line no-console
      console.error('❌ UNEXPECTED', err);
    }
    process.exit(1);
  }
}

void main();
