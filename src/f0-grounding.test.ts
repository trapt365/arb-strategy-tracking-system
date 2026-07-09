import { describe, expect, it } from 'vitest';
import type { ClientTop } from './types.js';
import {
  groundOwnerName,
  groundedOkrRows,
  groundedStakeholderRows,
  profileTopsContext,
  profileTopNames,
} from './f0-grounding.js';

const tops: ClientTop[] = [
  { name: 'Дамир Сайлов', title: 'CEO', authority: 'P&L', area: 'Финансы' },
  { name: 'Азиза Асланова', title: 'Трекер', authority: null, area: 'Стратегия' },
];

// === groundOwnerName ===

describe('groundOwnerName', () => {
  it('точное совпадение (same case) → matched=true, канонический из профиля', () => {
    const result = groundOwnerName('Дамир Сайлов', tops);
    expect(result).toEqual({ name: 'Дамир Сайлов', matched: true });
  });

  it('case-insensitive совпадение → matched=true', () => {
    const result = groundOwnerName('дамир сайлов', tops);
    expect(result).toEqual({ name: 'Дамир Сайлов', matched: true });
  });

  it('trim: пробелы вокруг → совпадение', () => {
    const result = groundOwnerName('  Дамир Сайлов  ', tops);
    expect(result).toEqual({ name: 'Дамир Сайлов', matched: true });
  });

  it('нет совпадения → matched=false, extracted сохраняется', () => {
    const result = groundOwnerName('Д. Сайлов', tops);
    expect(result).toEqual({ name: 'Д. Сайлов', matched: false });
  });

  it('пустой список tops → matched=false', () => {
    const result = groundOwnerName('Дамир', []);
    expect(result).toEqual({ name: 'Дамир', matched: false });
  });
});

// === groundedOkrRows ===

describe('groundedOkrRows', () => {
  const rows = [
    { owner: 'Дамир Сайлов', kr_number: 'KR-1.1' },
    { owner: 'Д. Сайлов', kr_number: 'KR-1.2' },
    { owner: '', kr_number: 'KR-1.3' },
  ];

  it('без tops → passthrough, строки не изменяются', () => {
    const result = groundedOkrRows(rows);
    expect(result).toEqual(rows);
  });

  it('пустой tops → passthrough', () => {
    const result = groundedOkrRows(rows, []);
    expect(result).toEqual(rows);
  });

  it('совпадение → канонический из профиля; несовпадение → «🔴 <extracted>»', () => {
    const result = groundedOkrRows(rows, tops);
    expect(result[0]!.owner).toBe('Дамир Сайлов');
    expect(result[1]!.owner).toBe('🔴 Д. Сайлов');
    // пустой owner не трогается
    expect(result[2]!.owner).toBe('');
  });

  it('case-insensitive: «дамир сайлов» → канонический', () => {
    const result = groundedOkrRows([{ owner: 'дамир сайлов' }], tops);
    expect(result[0]!.owner).toBe('Дамир Сайлов');
  });
});

// === groundedStakeholderRows ===

describe('groundedStakeholderRows', () => {
  const extraction = {
    participants: [
      { name: 'Дамир Сайлов', role: 'CEO', department: 'Управление', contact: null },
      { name: 'Жанель', role: 'РОП', department: null, contact: null },
    ],
  };

  it('без tops → participants без изменений (старые сессии)', () => {
    const result = groundedStakeholderRows(extraction);
    expect(result).toEqual(extraction.participants);
  });

  it('с tops → профильные топы первыми, потом не-профильные участники', () => {
    const result = groundedStakeholderRows(extraction, tops);
    expect(result).toHaveLength(3);
    // Профильные топы первыми
    expect(result[0]!.name).toBe('Дамир Сайлов');
    expect(result[1]!.name).toBe('Азиза Асланова');
    // Жанель не в профиле — добавляется после
    expect(result[2]!.name).toBe('Жанель');
  });

  it('дедупликация: участник extraction совпадает с топом → только профильная запись', () => {
    const result = groundedStakeholderRows(extraction, tops);
    const names = result.map((r) => r.name);
    // Дамир Сайлов встречается только один раз (из профиля)
    expect(names.filter((n) => n === 'Дамир Сайлов')).toHaveLength(1);
  });

  it('профиль есть, extraction.participants=[] → только профильные строки', () => {
    const result = groundedStakeholderRows({ participants: [] }, tops);
    expect(result).toHaveLength(2);
    expect(result[0]!.name).toBe('Дамир Сайлов');
    expect(result[1]!.name).toBe('Азиза Асланова');
  });

  it('role берётся из title, area → department', () => {
    const result = groundedStakeholderRows({ participants: [] }, tops);
    expect(result[0]!.role).toBe('CEO');
    expect(result[0]!.department).toBe('Финансы');
    expect(result[1]!.role).toBe('Трекер');
    expect(result[1]!.department).toBe('Стратегия');
  });
});

// === profileTopsContext ===

describe('profileTopsContext', () => {
  it('пустой массив → пустая строка', () => {
    expect(profileTopsContext([])).toBe('');
  });

  it('форматирует каждую строку: «- {name} ({title}, зона: {area})»', () => {
    const ctx = profileTopsContext(tops);
    expect(ctx).toBe(
      '- Дамир Сайлов (CEO, зона: Финансы)\n- Азиза Асланова (Трекер, зона: Стратегия)',
    );
  });

  it('null title и area → «—»', () => {
    const ctx = profileTopsContext([
      { name: 'Имя', title: null, authority: null, area: null },
    ]);
    expect(ctx).toBe('- Имя (—, зона: —)');
  });
});

// === profileTopNames ===

describe('profileTopNames', () => {
  it('возвращает массив имён из профиля', () => {
    expect(profileTopNames(tops)).toEqual(['Дамир Сайлов', 'Азиза Асланова']);
  });

  it('пустой массив → []', () => {
    expect(profileTopNames([])).toEqual([]);
  });
});
