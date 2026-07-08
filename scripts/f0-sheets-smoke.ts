import 'dotenv/config';
import { createClientSpreadsheet } from '../src/f0-sheets.js';
import { createSheetsWriteClient } from '../src/adapters/sheets.js';
import { F0SheetsError } from '../src/errors.js';
import { logger } from '../src/logger.js';
import type { F0FullExtraction } from '../src/types.js';

// Story 7.4 + 8.1 live smoke: реальная копия шаблона v2.0 + запись данных + шаринг,
// затем проверки чистого шаблона (story 8.1):
//   - ни в одном листе нет строки «geonline» (шаблон чист от данных прошлых клиентов);
//   - формульные панели ожили данными клиента («📊 Все OKR» показывает компанию из _meta);
//   - персональные листы «👤 {Имя}» созданы по владельцам KR, эталон остался скрытым;
//   - _meta заполнен.
// Требует: F0_SHEETS_TEMPLATE_ID (чистый шаблон из scripts/f0-build-template.ts),
// F0_SHEETS_SHARE_EMAILS, OAuth-креды с write-доступом.
// Запуск: npx tsx scripts/f0-sheets-smoke.ts

// Имена намеренно нейтральные (НЕ из Geonline) — иначе проверка «нет geonline» слепнет.
const extraction: F0FullExtraction = {
  document_type: 'strategy',
  company: 'SMOKE-TEST',
  objectives: [
    {
      title: 'Рост выручки',
      krs: [
        { formulation: 'Подписчики с 15 000 до 50 000', base: '15 000', target: '50 000', owner: 'Айгерим', deadline: 'Q4 2026' },
        { formulation: 'EBITDA до 15%', base: '9%', target: '15%', owner: 'Бекзат', deadline: 'Q4 2026' },
      ],
    },
  ],
  hypotheses: [
    { statement: 'Лидмагниты повышают доходимость', ifThenBecause: 'ЕСЛИ давать лидмагнит, ТО доходимость растёт, ПОТОМУ ЧТО ниже барьер', metric: 'доходимость, %', department: 'Маркетинг', synthesized: false },
    { statement: 'B2G пилот', ifThenBecause: null, metric: 'кол-во сделок', department: 'Продажи', synthesized: true },
  ],
  participants: [
    { name: 'Айгерим', role: 'CEO', department: 'Управление', contact: '@aigerim' },
    { name: 'Бекзат', role: 'РОП', department: 'Продажи', contact: null },
  ],
  unrecognized: [],
};

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

async function verifyCleanTemplate(spreadsheetId: string): Promise<CheckResult[]> {
  const sheets = await createSheetsWriteClient();
  const checks: CheckResult[] = [];

  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(title,hidden)',
  });
  const titles = (meta.data.sheets ?? []).map((s) => ({
    title: s.properties?.title ?? '',
    hidden: s.properties?.hidden === true,
  }));

  // Персональные листы по владельцам KR видимы; эталон скрыт.
  for (const owner of ['Айгерим', 'Бекзат']) {
    const sheet = titles.find((t) => t.title === `👤 ${owner}`);
    checks.push({
      name: `персональный лист «👤 ${owner}» создан и видим`,
      ok: sheet !== undefined && !sheet.hidden,
    });
  }
  const etalon = titles.find((t) => t.title === '👤 Шаблон топа');
  checks.push({
    name: 'эталон «👤 Шаблон топа» присутствует и скрыт',
    ok: etalon !== undefined && etalon.hidden,
  });

  // Полное сканирование значений всех листов: нигде нет «geonline».
  const ranges = titles.map((t) => `'${t.title.replace(/'/g, "''")}'!A1:M80`);
  const values = await sheets.spreadsheets.values.batchGet({ spreadsheetId, ranges });
  const geonlineHits: string[] = [];
  const cellText = new Map<string, string>();
  (values.data.valueRanges ?? []).forEach((vr, i) => {
    const flat = (vr.values ?? []).flat().map(String).join('\n');
    cellText.set(titles[i]!.title, flat);
    if (/geonline/i.test(flat)) geonlineHits.push(titles[i]!.title);
  });
  checks.push({
    name: 'ни в одном листе нет строки «geonline»',
    ok: geonlineHits.length === 0,
    detail: geonlineHits.length > 0 ? `найдено в: ${geonlineHits.join(', ')}` : undefined,
  });

  // Fix B: формульные панели ожили данными клиента без участия кода.
  checks.push({
    name: '«📊 Все OKR» показывает компанию из _meta (формулы живы)',
    ok: (cellText.get('📊 Все OKR') ?? '').includes('SMOKE-TEST'),
  });
  checks.push({
    name: '«🧪 Банк гипотез» показывает гипотезы из _hypotheses',
    ok: (cellText.get('🧪 Банк гипотез') ?? '').includes('Лидмагниты'),
  });
  checks.push({
    name: 'персональный лист топа отфильтровал его KR',
    ok: (cellText.get('👤 Айгерим') ?? '').includes('Подписчики'),
  });
  checks.push({
    name: '_meta заполнен (company/onboarding_date)',
    ok: (cellText.get('_meta') ?? '').includes('SMOKE-TEST'),
  });
  checks.push({
    name: '_stakeholder_map содержит telegram-контакт',
    ok: (cellText.get('_stakeholder_map') ?? '').includes('@aigerim'),
  });
  return checks;
}

async function main(): Promise<void> {
  const dateStr = new Date().toISOString().slice(0, 10);
  try {
    const result = await createClientSpreadsheet({
      extraction,
      spreadsheetName: `Стратегический трекинг v2.0 — SMOKE (${dateStr})`,
      meta: { onboardingDate: dateStr, tracker: 'smoke' },
      logger,
    });
    // eslint-disable-next-line no-console
    console.log('✅ SPREADSHEET CREATED');
    // eslint-disable-next-line no-console
    console.log('URL:', result.spreadsheetUrl);
    // eslint-disable-next-line no-console
    console.log('counts:', JSON.stringify(result.counts), 'shared:', result.shared.join(', ') || '(none)');

    // eslint-disable-next-line no-console
    console.log('\n— Проверки чистого шаблона (story 8.1) —');
    const checks = await verifyCleanTemplate(result.spreadsheetId);
    for (const c of checks) {
      // eslint-disable-next-line no-console
      console.log(`${c.ok ? '✅' : '❌'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
    }
    const failed = checks.filter((c) => !c.ok).length;
    // eslint-disable-next-line no-console
    console.log(
      failed === 0
        ? '\n✅ SMOKE PASS. ⚠️ Удали тестовую таблицу вручную из Drive после проверки.'
        : `\n❌ SMOKE FAIL: ${failed} проверок не прошло. Таблица оставлена для разбора.`,
    );
    if (failed > 0) process.exit(1);
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
