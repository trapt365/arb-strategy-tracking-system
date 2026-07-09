import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { importStrategyXlsx, xlsxToText } from './f0-import.js';
import { F0OnboardingError } from './errors.js';
import { F0FullExtractionSchema } from './types.js';

// Story 8.5: фикстуры генерируются xlsx-пакетом в тесте — бинарники в репо не кладём.

function toBuffer(wb: XLSX.WorkBook): Buffer {
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function sheetOf(rows: unknown[][]): XLSX.WorkSheet {
  return XLSX.utils.aoa_to_sheet(rows);
}

/** Формат A: xlsx с машинными листами шаблона v2.0 (_okr/_stakeholder_map/_hypotheses/_meta). */
function templateWorkbook(): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    sheetOf([
      ['kr_number', 'key_result', 'owner', 'current_status', 'target', 'deadline', 'okr_group'],
      ['KR-1.1', 'Выручка отдела продаж', 'Айгерим', '12 млн', '20 млн', 'Q4 2026', 'Продажи'],
      ['KR-1.2', 'Конверсия в оплату', 'Айгерим', '', '9%', '', 'Продажи'],
      ['KR-2.1', 'NPS клиентов', '', '35', '50', 'Q4 2026', 'Сервис'],
    ]),
    '_okr',
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheetOf([
      ['full_name', 'speaker_name', 'department', 'role', 'telegram'],
      ['Айгерим Т.', 'Айгерим', 'Продажи', 'CCO', '@aigerim'],
      ['Бекзат С.', 'Бекзат', 'Сервис', '', ''],
    ]),
    '_stakeholder_map',
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheetOf([
      ['statement', 'if_then_because', 'metric', 'department', 'synthesized'],
      ['Видеозвонки поднимут конверсию', 'ЕСЛИ звонки ТО конверсия', 'конверсия %', 'Продажи', 'да'],
      ['Онбординг сократит отток', '', '', '', ''],
    ]),
    '_hypotheses',
  );
  XLSX.utils.book_append_sheet(
    wb,
    sheetOf([
      ['key', 'value'],
      ['company', 'ТОО Пример'],
    ]),
    '_meta',
  );
  XLSX.utils.book_append_sheet(wb, sheetOf([['просто заметки']]), 'Заметки');
  return wb;
}

/** Формат B: произвольная таблица клиента — шапка НЕ в первой строке, смешанные типы ячеек. */
function genericWorkbook(): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    sheetOf([
      ['Стратегия компании на 2026'],
      [],
      ['Согласована 01.02.2026'],
      ['Направление', 'Ключевой результат', 'База', 'Цель', 'Ответственный', 'Срок', 'Вес'],
      ['Продажи', 'Выручка от новых клиентов', 15000, 40000, 'Айгерим', new Date(Date.UTC(2026, 11, 31)), '0.4'],
      ['Продажи', 'Конверсия в оплату', '9%', '15%', 'Айгерим', 'Q4', '0.2'],
      ['Сервис', 'Отток клиентов', '', '5%', '', '', '0.4'],
    ]),
    'Стратегия',
  );
  XLSX.utils.book_append_sheet(wb, sheetOf([['протокол', 'встречи']]), 'Протокол');
  return wb;
}

describe('f0-import: формат A («наша» таблица)', () => {
  it('маппит _okr/_stakeholder_map/_hypotheses/_meta обратно в extraction', () => {
    const result = importStrategyXlsx(toBuffer(templateWorkbook()), 'strategy.xlsx');

    expect(result.format).toBe('template');
    expect(result.sheetName).toBe('_okr');
    // Контракт даунстрима: результат валиден по той же zod-схеме, что и LLM-ответ.
    expect(F0FullExtractionSchema.safeParse(result.extraction).success).toBe(true);

    const e = result.extraction;
    expect(e.company).toBe('ТОО Пример');
    // KR группируются в objectives по okr_group, порядок первого появления.
    expect(e.objectives.map((o) => o.title)).toEqual(['Продажи', 'Сервис']);
    expect(e.objectives[0]!.krs).toHaveLength(2);
    const kr11 = e.objectives[0]!.krs[0]!;
    expect(kr11).toMatchObject({
      formulation: 'Выручка отдела продаж',
      base: '12 млн',
      target: '20 млн',
      owner: 'Айгерим',
      deadline: 'Q4 2026',
      kr_type: 'metric',
    });
    // Пустые ячейки → null (инвариант 3 — не выдумываем) → дальше штатные 🔴 и вопросы.
    expect(e.objectives[0]!.krs[1]!.base).toBeNull();
    expect(e.objectives[1]!.krs[0]!.owner).toBeNull();

    expect(e.participants).toEqual([
      { name: 'Айгерим Т.', role: 'CCO', department: 'Продажи', contact: '@aigerim' },
      { name: 'Бекзат С.', role: null, department: 'Сервис', contact: null },
    ]);

    expect(e.hypotheses).toHaveLength(2);
    expect(e.hypotheses[0]).toMatchObject({ metric: 'конверсия %', synthesized: true });
    expect(e.hypotheses[1]).toMatchObject({ metric: null, synthesized: false });

    // Лишний лист честно показан в «Не распознано».
    expect(e.unrecognized.join(' ')).toContain('Заметки');
  });

  it('детектит формат A по машинным заголовкам и без имени _okr', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      sheetOf([
        ['kr_number', 'key_result', 'owner', 'target'],
        ['KR-1.1', 'Выручка', 'Айгерим', '20 млн'],
      ]),
      'OKR экспорт',
    );
    const result = importStrategyXlsx(toBuffer(wb), 'export.xlsx');
    expect(result.format).toBe('template');
    // okr_group нет → один objective с названием листа.
    expect(result.extraction.objectives).toEqual([
      {
        title: 'OKR экспорт',
        krs: [
          {
            formulation: 'Выручка',
            kr_type: 'metric',
            base: null,
            target: '20 млн',
            owner: 'Айгерим',
            deadline: null,
          },
        ],
      },
    ]);
    // Листа участников нет → участники из владельцев KR.
    expect(result.extraction.participants).toEqual([
      { name: 'Айгерим', role: null, department: null, contact: null },
    ]);
  });

  it('машинный лист без строк данных → import_unmappable, а не пустой черновик', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheetOf([['kr_number', 'key_result', 'owner']]), '_okr');
    expect(() => importStrategyXlsx(toBuffer(wb), 'empty.xlsx')).toThrowError(
      expect.objectContaining({ code: 'import_unmappable' }),
    );
  });
});

describe('f0-import: формат B (произвольная таблица)', () => {
  it('находит шапку не в первой строке, маппит синонимы и смешанные типы ячеек', () => {
    const result = importStrategyXlsx(toBuffer(genericWorkbook()), 'клиент.xlsx');

    expect(result.format).toBe('generic');
    expect(result.sheetName).toBe('Стратегия');
    expect(F0FullExtractionSchema.safeParse(result.extraction).success).toBe(true);

    const e = result.extraction;
    // company не выдумываем — в произвольной таблице её негде взять достоверно.
    expect(e.company).toBeNull();
    expect(e.objectives.map((o) => o.title)).toEqual(['Продажи', 'Сервис']);

    const kr1 = e.objectives[0]!.krs[0]!;
    // Числа и даты ячеек → строки (как в extraction из LLM).
    expect(kr1.base).toBe('15000');
    expect(kr1.target).toBe('40000');
    // Date-ячейка → ISO-дата; день допускает ±1 (round-trip через xlsx-serial зависит от TZ).
    expect(kr1.deadline).toMatch(/^2026-12-3[01]$/);
    expect(e.objectives[0]!.krs[1]!).toMatchObject({ base: '9%', target: '15%' });

    // Пустые ячейки → null → штатный 🔴.
    const krOtток = e.objectives[1]!.krs[0]!;
    expect(krOtток.base).toBeNull();
    expect(krOtток.owner).toBeNull();

    // Участники — уникальные имена из «Ответственный».
    expect(e.participants).toEqual([{ name: 'Айгерим', role: null, department: null, contact: null }]);

    // Гипотез не выдумываем (досинтез — отдельной кнопкой).
    expect(e.hypotheses).toEqual([]);

    // Незамапленная колонка и пропущенный лист — в «Не распознано».
    const unrecognized = e.unrecognized.join('\n');
    expect(unrecognized).toContain('«Вес»');
    expect(unrecognized).toContain('Протокол');
  });

  it('без листа, похожего на таблицу KR (порог ≥ 3 колонок) → import_unmappable', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      sheetOf([
        ['Имя', 'Телефон'],
        ['Айгерим', '+7 700'],
      ]),
      'Контакты',
    );
    expect(() => importStrategyXlsx(toBuffer(wb), 'contacts.xlsx')).toThrowError(
      expect.objectContaining({ code: 'import_unmappable' }),
    );
  });

  it('битый/чужой файл → внятная F0OnboardingError, не «тихо пусто»', () => {
    // Обрезанный zip-заголовок — XLSX.read падает → document_parse_failed.
    try {
      importStrategyXlsx(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]), 'broken.xlsx');
      expect.unreachable('битый zip должен кидать');
    } catch (err) {
      expect(err).toBeInstanceOf(F0OnboardingError);
      expect((err as F0OnboardingError).code).toBe('document_parse_failed');
    }
    // Просто текст xlsx-пакет молча парсит как CSV-лист → таблицы KR там нет → unmappable.
    try {
      importStrategyXlsx(Buffer.from('это не xlsx'), 'text.xlsx');
      expect.unreachable('текст вместо xlsx должен кидать');
    } catch (err) {
      expect(err).toBeInstanceOf(F0OnboardingError);
      expect((err as F0OnboardingError).code).toBe('import_unmappable');
    }
  });
});

describe('f0-import: xlsxToText (для досинтеза гипотез)', () => {
  it('текстифицирует листы с маркерами и данными', () => {
    const text = xlsxToText(toBuffer(genericWorkbook()), 'клиент.xlsx');
    expect(text).toContain('===== Лист: Стратегия =====');
    expect(text).toContain('===== Лист: Протокол =====');
    expect(text).toContain('Выручка от новых клиентов');
    expect(text).toContain('15000');
  });
});
