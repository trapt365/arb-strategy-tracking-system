import 'dotenv/config';
import type { sheets_v4 } from 'googleapis';
import { createSheetsWriteClient } from '../src/adapters/sheets.js';

// Story 8.1: генератор чистого шаблона «Стратегический трекинг v2.0» (шаблон-как-код).
// Строит/пересобирает эталонный spreadsheet с нуля: формульные панели поверх ⚙️-листов,
// скрытый эталон персонального листа топа, легенда методологии, протекции. Дизайн:
// _bmad-output/planning-artifacts/design-f0-template-v2-clean-2026-07-08.md (§3–§5).
//
// Запуск:
//   npx tsx scripts/f0-build-template.ts                       — создать новый шаблон
//   npx tsx scripts/f0-build-template.ts --spreadsheet-id <id> — пересобрать существующий
//   (+ --force, если title пересобираемой таблицы не содержит «ШАБЛОН»)
//
// После генерации (Manual TODO story 8.1): проверить глазами → F0_SHEETS_TEMPLATE_ID=<id>
// в prod .env + pm2 restart → удалить orphan-таблицу AIPLUS → пере-онбордить AIPLUS.

// === Палитра ===
const DARK = { red: 0.15, green: 0.19, blue: 0.22 }; // тёмная шапка таблиц
const WHITE = { red: 1, green: 1, blue: 1 };
const TAB_PANEL = { red: 0.1, green: 0.45, blue: 0.82 }; // синие вкладки-панели
const TAB_MANUAL = { red: 0.13, green: 0.55, blue: 0.13 }; // зелёные ручные листы
const TAB_DATA = { red: 0.45, green: 0.45, blue: 0.45 }; // серые ⚙️-данные

type Cell = string | number;

interface SheetSpec {
  title: string;
  hidden?: boolean;
  tabColor?: { red: number; green: number; blue: number };
  /** Число закреплённых строк сверху. */
  frozenRows?: number;
  /** 0-based строки, красящиеся в тёмную шапку (заголовки таблиц/секций). */
  headerRows?: number[];
  /** Значения с A1 (USER_ENTERED — строки с '=' становятся формулами). */
  rows: Cell[][];
  /** Warning-протекция всего листа (панели: править можно, но с предупреждением). */
  protectedWarning?: boolean;
  /** Ширины колонок, px: 0-based индекс → размер. */
  columnWidths?: Record<number, number>;
  /** Базовый фильтр: 0-based строка заголовка таблицы (до последней колонки строки). */
  filterHeaderRow?: number;
}

// === Формулы (RU-локаль: разделитель аргументов «;», колонок в массивах — «\») ===
// QUERY намеренно не используем: он типизирует колонку по большинству значений и МОЛЧА
// прячет значения меньшинного типа (смесь «9%»/чисел/«нет данных» в статусах — реальный
// кейс после ручных правок трекера). FILTER/SORT типы не трогают.

const metaLookup = (key: string, fallback: string): string =>
  `IFERROR(VLOOKUP("${key}";'_meta'!A:B;2;0);"${fallback}")`;

/** Колонки листа как массив-литерал: {'_okr'!J2:J\'_okr'!A2:A\…} (порядок панели). */
const cols = (sheet: string, letters: string[]): string =>
  `{${letters.map((l) => `'${sheet}'!${l}2:${l}`).join('\\')}}`;

// «📊 Все OKR» — единая сортированная таблица KR + участники и нагрузка справа.
const ALL_OKR: SheetSpec = {
  title: '📊 Все OKR',
  tabColor: TAB_PANEL,
  frozenRows: 7,
  headerRows: [5, 6],
  protectedWarning: true,
  // Basic filter намеренно не ставим: сортировка фильтром физически переставляет ячейки
  // и ломает QUERY-spill. Сортировать/фильтровать — в ⚙️ _okr.
  columnWidths: { 0: 180, 2: 420, 3: 140, 4: 140, 5: 110, 6: 140, 7: 30, 8: 160, 9: 200, 10: 110, 11: 60 },
  rows: [
    [`="📊 ВСЕ OKR — "&UPPER(${metaLookup('company', 'КЛИЕНТ')})`],
    [
      `="Период: "&${metaLookup('period', '—')}&"   ·   Онбординг: "&${metaLookup('onboarding_date', '—')}&"   ·   Трекер: "&${metaLookup('tracker', '—')}`,
    ],
    [],
    [
      'OKR-групп:',
      `=COUNTA(UNIQUE(FILTER('_okr'!J2:J;'_okr'!J2:J<>"")))`,
      'KR:',
      `=COUNTA('_okr'!A2:A)`,
      'Участников:',
      `=COUNTA('_stakeholder_map'!A2:A)`,
    ],
    [],
    ['🎯 ВСЕ KR (правь статусы в ⚙️ _okr — таблица пересчитается)', '', '', '', '', '', '', '', '👥 УЧАСТНИКИ И НАГРУЗКА'],
    ['OKR-группа', '№', 'Key Result', 'Текущий статус', 'Цель', 'Срок', 'Ответственный', '', 'Имя', 'Роль', 'BSC', 'KR'],
    [
      // OKR-группа, №, KR, статус, цель, срок, ответственный — сортировка по группе, №.
      `=IFERROR(SORT(FILTER(${cols('_okr', ['J', 'A', 'C', 'F', 'G', 'I', 'D'])};'_okr'!A2:A<>"");1;1;2;1);"Нет данных — заполни ⚙️ _okr")`,
      '', '', '', '', '', '', '',
      `=IFERROR(FILTER(${cols('_stakeholder_map', ['A', 'D', 'E'])};'_stakeholder_map'!A2:A<>"");"—")`,
      '', '',
      `=ARRAYFORMULA(IF(I8:I="";"";COUNTIF('_okr'!D:D;I8:I)))`,
    ],
  ],
};

// «🧪 Банк гипотез» — все гипотезы с рабочими колонками (owner/срок/статус из ⚙️).
const HYPO_BANK: SheetSpec = {
  title: '🧪 Банк гипотез',
  tabColor: TAB_PANEL,
  frozenRows: 4,
  headerRows: [3],
  protectedWarning: true,
  columnWidths: { 0: 280, 1: 420, 2: 200, 3: 140, 4: 90, 5: 110, 6: 140, 7: 110, 8: 110 },
  rows: [
    [`="🧪 БАНК ГИПОТЕЗ — "&UPPER(${metaLookup('company', 'КЛИЕНТ')})`],
    [
      `="Всего: "&COUNTA('_hypotheses'!A2:A)&"   ·   ⚠️ синтезированных (подтвердить с клиентом): "&COUNTIF('_hypotheses'!E2:E;"да")`,
    ],
    [],
    ['Гипотеза', 'ЕСЛИ — ТО — ПОТОМУ ЧТО', 'Метрика', 'Департамент', '⚠️ Синтез', 'Связь с OKR', 'Ответственный', 'Срок', 'Статус'],
    [`=IFERROR(FILTER('_hypotheses'!A2:I;'_hypotheses'!A2:A<>"");"Нет гипотез")`],
  ],
};

// «📅 Лог встреч» — ручной append трекером (позже — ботом из F1).
const MEETING_LOG: SheetSpec = {
  title: '📅 Лог встреч',
  tabColor: TAB_MANUAL,
  frozenRows: 1,
  headerRows: [0],
  columnWidths: { 0: 100, 1: 140, 2: 420, 3: 320, 4: 320 },
  filterHeaderRow: 0,
  rows: [['Дата', 'Топ', 'Итоги встречи', 'Договорённости', 'Повестка следующей']],
};

// «📋 Ограничения (узелки)» — TOC, ведётся трекером руками (структура из legacy).
const CONSTRAINTS: SheetSpec = {
  title: '📋 Ограничения (узелки)',
  tabColor: TAB_MANUAL,
  frozenRows: 1,
  headerRows: [0],
  columnWidths: { 0: 90, 1: 360, 2: 140, 3: 70, 4: 240, 5: 300, 6: 300 },
  filterHeaderRow: 0,
  rows: [['Приоритет', 'Ограничение', 'Тип TOC', 'Score', 'Влияние', 'Контекст', 'Решение топа']],
};

// «📖 Методология» — единственный источник легенды (персональные листы ссылаются сюда).
const METHODOLOGY: SheetSpec = {
  title: '📖 Методология',
  tabColor: TAB_PANEL,
  headerRows: [0],
  protectedWarning: true,
  columnWidths: { 0: 900 },
  rows: [
    ['📖 МЕТОДОЛОГИЯ СТРАТЕГИЧЕСКОГО ТРЕКИНГА v2.0'],
    [],
    ['ТИПЫ ИНИЦИАТИВ'],
    ['📌 задача — разовое действие с ответственным и сроком'],
    ['📦 проект — многошаговая инициатива с этапами'],
    ['🔬 гипотеза — проверяемое предположение (ЕСЛИ — ТО — ПОТОМУ ЧТО) с метрикой'],
    ['💡 идея — кандидат в бэклог, пока не в работе'],
    [],
    ['СТАТУСЫ'],
    ['🟢 в работе, по плану'],
    ['🟡 отклонение/риск — требует внимания'],
    ['🔴 блокировано/критично'],
    ['✅ выполнено'],
    ['🔄 повторяющийся ритм'],
    ['⏸️ на паузе'],
    ['⚠️ требует решения топа'],
    ['💭 идея/обсуждение'],
    ['🔮 бэклог (будущее)'],
    [],
    ['ЦВЕТА BSC: Финансы · Клиенты · Процессы · Развитие'],
    [],
    ['ПРАВИЛА РИТМА'],
    ['1. Еженедельная встреча с каждым топом — по его листу «👤 {Имя}».'],
    ['2. После встречи статусы KR и инициатив правятся в ⚙️-листах (_okr, _hypotheses); итоги — строкой в «📅 Лог встреч».'],
    ['3. Панели («📊 Все OKR», «🧪 Банк гипотез», «👤 …») — формулы: руками не править, пересчитываются сами.'],
    ['4. Имя топа — ключ связи листов: переименовал в _stakeholder_map → поправь owner в _okr и _hypotheses, иначе FILTER персонального листа рассыпется.'],
  ],
};

// «👤 Шаблон топа» — скрытый эталон; $B$1 (имя) параметризует все формулы. Копируется
// ботом duplicateSheet-ом в «👤 {Имя}» на каждого владельца KR (src/f0-sheets.ts).
// 4 зоны: шапка / 🎯 KR / ⚡ инициативы / 📚 легенда. FILTER-зонам отведено 12 строк —
// топ с >12 KR или >12 инициативами упрётся в #REF (расширить зону руками).
const TOP_TEMPLATE: SheetSpec = {
  title: '👤 Шаблон топа',
  hidden: true,
  tabColor: TAB_PANEL,
  protectedWarning: true,
  headerRows: [6, 7, 21, 22],
  columnWidths: { 0: 120, 1: 240, 2: 420, 3: 140, 4: 140, 5: 130, 6: 130, 7: 110, 8: 160, 9: 160, 10: 80 },
  rows: [
    ['Имя топа:', ''], // B1 заполняет бот при duplicateSheet
    [
      'Роль:',
      `=IFERROR(VLOOKUP($B$1;'_stakeholder_map'!A:E;4;0);"—")`,
      '',
      'BSC:',
      `=IFERROR(VLOOKUP($B$1;'_stakeholder_map'!A:E;5;0);"—")`,
    ],
    ['Зоны:', `=IFERROR(VLOOKUP($B$1;'_stakeholder_map'!A:F;6;0);"—")`],
    [
      'Последняя встреча:',
      `=IFERROR(INDEX(SORT(FILTER('📅 Лог встреч'!A2:E;'📅 Лог встреч'!B2:B=$B$1);1;0);1;1);"—")`,
      `=IFERROR("Итоги: "&INDEX(SORT(FILTER('📅 Лог встреч'!A2:E;'📅 Лог встреч'!B2:B=$B$1);1;0);1;3);"")`,
    ],
    [
      'Следующая встреча:',
      `=IFERROR(INDEX(SORT(FILTER('📅 Лог встреч'!A2:E;'📅 Лог встреч'!B2:B=$B$1);1;0);1;5);"— (повестка не задана)")`,
    ],
    [],
    ['🎯 KR ТОПА (статусы правь в ⚙️ _okr)'],
    ['№', 'Краткое название', 'Key Result', 'Владелец', 'Должность', 'Статус', 'Цель', 'Прогресс', 'Срок', 'OKR-группа', 'Квартал'],
    [`=IFERROR(FILTER('_okr'!A2:K;'_okr'!D2:D=$B$1);"Нет KR")`],
    [], [], [], [], [], [], [], [], [], [], [],
    [],
    ['⚡ ИНИЦИАТИВЫ И ГИПОТЕЗЫ ТОПА (ответственный назначается в ⚙️ _hypotheses)'],
    ['Гипотеза/инициатива', 'ЕСЛИ — ТО — ПОТОМУ ЧТО', 'Метрика', 'Департамент', '⚠️ Синтез', 'Связь с OKR', 'Ответственный', 'Срок', 'Статус'],
    [`=IFERROR(FILTER('_hypotheses'!A2:I;'_hypotheses'!G2:G=$B$1);"Нет — назначь owner в ⚙️ _hypotheses")`],
    [], [], [], [], [], [], [], [], [], [], [],
    [],
    ['📚 ЛЕГЕНДА (кратко): 🟢 по плану · 🟡 риск · 🔴 блок · ✅ готово · 🔄 ритм · ⏸️ пауза · ⚠️ нужно решение · 💭 идея · 🔮 бэклог'],
    ['Типы: 📌 задача · 📦 проект · 🔬 гипотеза · 💡 идея.  Полная методология — лист «📖 Методология».'],
    ['Данные правь в ⚙️-листах — панели пересчитаются сами.'],
  ],
};

// ⚙️-данные: единственный источник правды. Трекер правит их напрямую, панели пересчитываются.
function dataSheet(title: string, header: string[], widths: Record<number, number> = {}): SheetSpec {
  return {
    title,
    tabColor: TAB_DATA,
    frozenRows: 1,
    headerRows: [0],
    filterHeaderRow: 0,
    columnWidths: widths,
    rows: [header],
  };
}

const META = dataSheet('_meta', ['key', 'value'], { 0: 160, 1: 320 });
// Ключи _meta засеваем пустыми — F0 перезаписывает при онбординге.
META.rows.push(['company', ''], ['period', ''], ['onboarding_date', ''], ['tracker', '']);

const OKR = dataSheet(
  '_okr',
  ['kr_number', 'short_name', 'key_result', 'owner', 'owner_position', 'current_status', 'target', 'progress', 'deadline', 'okr_group', 'quarter'],
  { 0: 80, 1: 200, 2: 420, 3: 140, 4: 160, 5: 140, 6: 140, 7: 100, 8: 120, 9: 200, 10: 80 },
);

const STAKEHOLDERS = dataSheet(
  '_stakeholder_map',
  ['full_name', 'speaker_name', 'department', 'role', 'bsc_category', 'responsibility_areas', 'interests', 'telegram', 'notes'],
  { 0: 140, 1: 140, 2: 140, 3: 160, 4: 120, 5: 280, 6: 200, 7: 120, 8: 240 },
);

const HYPOTHESES = dataSheet(
  '_hypotheses',
  ['statement', 'if_then_because', 'metric', 'department', 'synthesized', 'okr_link', 'owner', 'deadline', 'status'],
  { 0: 280, 1: 420, 2: 200, 3: 140, 4: 100, 5: 100, 6: 140, 7: 110, 8: 110 },
);

// Схема — EXPECTED_HEADERS.f5Metrics (src/adapters/sheets.ts); F1 читает при /report.
const F5_METRICS = dataSheet(
  '_f5_metrics',
  ['department', 'metric_name', 'metric_type', 'unit', 'source', 'owner_speaker_name', 'ranges', 'update_frequency', 'risk_notes', 'notes'],
);

// Схема appendOpsLog (src/adapters/sheets.ts, story 1.9).
const OPS_LOGS = dataSheet('_ops_logs', [
  'timestamp', 'pipeline', 'step', 'client_id', 'duration_ms',
  'status', 'level', 'message', 'error_code', 'context_json',
]);

// Порядок листов: панели → ручные → методология → эталон (скрыт) → ⚙️-данные.
const SPECS: SheetSpec[] = [
  ALL_OKR, HYPO_BANK, MEETING_LOG, CONSTRAINTS, METHODOLOGY, TOP_TEMPLATE,
  META, OKR, STAKEHOLDERS, HYPOTHESES, F5_METRICS, OPS_LOGS,
];

// === Обвязка против «немых» зависаний WSL→Google (паттерн scripts/add-f5-metrics-tab.ts) ===

function withTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timeout ${ms}ms`)), ms).unref(),
    ),
  ]);
}

async function step<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const delays = [1000, 2000, 4000, 8000, 8000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const result = await withTimeout(30_000, fn);
      // eslint-disable-next-line no-console
      console.log(`✓ ${label}`);
      return result;
    } catch (err) {
      lastErr = err;
      if (attempt === delays.length) break;
      // eslint-disable-next-line no-console
      console.error(`… ${label}: сбой (${(err as Error).message}), повтор ${attempt + 1}/${delays.length}`);
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }
  throw lastErr;
}

// === Сборка ===

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const sheets = await createSheetsWriteClient();
  const existingId = argValue('--spreadsheet-id');
  const force = process.argv.includes('--force');
  const title =
    argValue('--name') ??
    `Стратегический трекинг v2.0 — ШАБЛОН (чистый, ${new Date().toISOString().slice(0, 10)})`;

  // 1. Создать новый spreadsheet или проверить пересобираемый.
  let spreadsheetId: string;
  if (existingId === undefined) {
    const created = await step('создание spreadsheet', () =>
      sheets.spreadsheets.create({
        requestBody: {
          properties: { title, locale: 'ru_RU', timeZone: 'Asia/Almaty' },
        },
        fields: 'spreadsheetId',
      }),
    );
    spreadsheetId = created.data.spreadsheetId!;
  } else {
    spreadsheetId = existingId;
    const meta = await step('чтение пересобираемого spreadsheet', () =>
      sheets.spreadsheets.get({ spreadsheetId, fields: 'properties.title' }),
    );
    const currentTitle = meta.data.properties?.title ?? '';
    // Защита от запуска по таблице живого клиента: пересборка сносит все листы.
    if (!currentTitle.includes('ШАБЛОН') && !force) {
      // eslint-disable-next-line no-console
      console.error(
        `❌ Title «${currentTitle}» не содержит «ШАБЛОН». Пересборка удаляет все листы — если это точно шаблон, повтори с --force.`,
      );
      process.exit(1);
    }
    await step('RU-локаль', () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              updateSpreadsheetProperties: {
                properties: { locale: 'ru_RU', timeZone: 'Asia/Almaty' },
                fields: 'locale,timeZone',
              },
            },
          ],
        },
      }),
    );
  }

  // 2. Обеспечить состав листов: создать недостающие, удалить лишние (вкл. дефолтный).
  const inventory = await step('инвентаризация листов', () =>
    sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets(properties(sheetId,title),protectedRanges(protectedRangeId))',
    }),
  );
  const existing = new Map<string, number>();
  const staleProtections: number[] = [];
  for (const s of inventory.data.sheets ?? []) {
    if (s.properties?.title != null && typeof s.properties.sheetId === 'number') {
      existing.set(s.properties.title, s.properties.sheetId);
    }
    for (const p of s.protectedRanges ?? []) {
      if (typeof p.protectedRangeId === 'number') staleProtections.push(p.protectedRangeId);
    }
  }

  const wanted = new Set(SPECS.map((s) => s.title));
  const structureRequests: sheets_v4.Schema$Request[] = [];
  for (const spec of SPECS) {
    if (!existing.has(spec.title)) {
      structureRequests.push({ addSheet: { properties: { title: spec.title } } });
    }
  }
  if (structureRequests.length > 0) {
    await step(`создание листов (${structureRequests.length})`, () =>
      sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: structureRequests } }),
    );
  }
  const refreshed = await step('карта листов', () =>
    sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties(sheetId,title)' }),
  );
  const titleToId = new Map<string, number>();
  for (const s of refreshed.data.sheets ?? []) {
    if (s.properties?.title != null && typeof s.properties.sheetId === 'number') {
      titleToId.set(s.properties.title, s.properties.sheetId);
    }
  }
  const deletions = [...titleToId.entries()]
    .filter(([t]) => !wanted.has(t))
    .map(([, id]) => ({ deleteSheet: { sheetId: id } }));
  const cleanupRequests: sheets_v4.Schema$Request[] = [
    ...staleProtections.map((id) => ({ deleteProtectedRange: { protectedRangeId: id } })),
    ...deletions,
  ];
  if (cleanupRequests.length > 0) {
    await step(`очистка (листов: ${deletions.length}, протекций: ${staleProtections.length})`, () =>
      sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: cleanupRequests } }),
    );
  }

  // 3. Содержимое: полная очистка значений + запись строк (формулы — USER_ENTERED).
  await step('очистка значений', () =>
    sheets.spreadsheets.values.batchClear({
      spreadsheetId,
      requestBody: { ranges: SPECS.map((s) => `'${s.title}'`) },
    }),
  );
  await step('запись содержимого', () =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: 'USER_ENTERED',
        // Пустая строка-разделитель как [''] — API отклоняет пустые списки в values.
        data: SPECS.map((s) => ({
          range: `'${s.title}'!A1`,
          values: s.rows.map((r) => (r.length > 0 ? r : [''])),
        })),
      },
    }),
  );

  // 4. Оформление: порядок/скрытие/цвет вкладок, frozen, тёмные шапки, ширины, фильтры,
  // warning-протекции панелей.
  const fmt: sheets_v4.Schema$Request[] = [];
  SPECS.forEach((spec, index) => {
    const sheetId = titleToId.get(spec.title)!;
    fmt.push({
      updateSheetProperties: {
        properties: {
          sheetId,
          index,
          hidden: spec.hidden ?? false,
          tabColor: spec.tabColor,
          gridProperties: { frozenRowCount: spec.frozenRows ?? 0 },
        },
        fields: 'index,hidden,tabColor,gridProperties.frozenRowCount',
      },
    });
    for (const row of spec.headerRows ?? []) {
      fmt.push({
        repeatCell: {
          range: { sheetId, startRowIndex: row, endRowIndex: row + 1 },
          cell: {
            userEnteredFormat: {
              backgroundColor: DARK,
              textFormat: { bold: true, foregroundColor: WHITE },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)',
        },
      });
    }
    // Крупный титул A1 у панелей (первая строка не шапка таблицы).
    if (!(spec.headerRows ?? []).includes(0)) {
      fmt.push({
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true, fontSize: 14 } } },
          fields: 'userEnteredFormat.textFormat',
        },
      });
    }
    for (const [col, px] of Object.entries(spec.columnWidths ?? {})) {
      fmt.push({
        updateDimensionProperties: {
          range: { sheetId, dimension: 'COLUMNS', startIndex: Number(col), endIndex: Number(col) + 1 },
          properties: { pixelSize: px },
          fields: 'pixelSize',
        },
      });
    }
    if (spec.filterHeaderRow !== undefined) {
      const width = spec.rows[spec.filterHeaderRow]?.length ?? 1;
      fmt.push({
        setBasicFilter: {
          filter: {
            range: {
              sheetId,
              startRowIndex: spec.filterHeaderRow,
              startColumnIndex: 0,
              endColumnIndex: width,
            },
          },
        },
      });
    }
    if (spec.protectedWarning) {
      fmt.push({
        addProtectedRange: {
          protectedRange: {
            range: { sheetId },
            warningOnly: true,
            description: 'Панель на формулах: правь данные в ⚙️-листах (_okr, _hypotheses, …)',
          },
        },
      });
    }
  });
  await step('оформление', () =>
    sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: fmt } }),
  );

  // eslint-disable-next-line no-console
  console.log(`\n✅ Шаблон собран: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
  // eslint-disable-next-line no-console
  console.log(
    [
      '\nДальше (Manual TODO story 8.1):',
      '  1. Проверь шаблон глазами (панели, эталон «👤 Шаблон топа», легенда, нет данных клиентов).',
      `  2. F0_SHEETS_TEMPLATE_ID=${spreadsheetId} в prod .env + pm2 restart.`,
      '  3. Удали orphan-таблицу AIPLUS, пере-онбордь AIPLUS через бота.',
      '  Примечание: FILTER-зоны персонального листа рассчитаны на ≤12 KR/инициатив на топа.',
    ].join('\n'),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('❌ Сборка шаблона не удалась:', err);
  process.exit(1);
});
