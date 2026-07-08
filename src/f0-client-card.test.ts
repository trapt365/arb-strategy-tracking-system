import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  clientIdFromCompany,
  buildClientCard,
  persistClientCard,
  loadClientCard,
  computeReadinessChecklist,
  renderReadinessMessage,
} from './f0-client-card.js';
import type { F0FullExtraction } from './types.js';

function extraction(overrides: Partial<F0FullExtraction> = {}): F0FullExtraction {
  return {
    document_type: 'strategy',
    company: 'Ромашка',
    objectives: [
      {
        title: 'Рост выручки',
        krs: [
          { formulation: 'Подписчики с 15 000 до 50 000', base: '15 000', target: '50 000', owner: 'Мақсат', deadline: '2026' },
          { formulation: 'EBITDA до 15%', base: '9%', target: '15%', owner: 'Дамир', deadline: 'Q4' },
        ],
      },
    ],
    hypotheses: [
      { statement: 'Лидмагниты', ifThenBecause: null, metric: 'доходимость', department: 'Маркетинг', synthesized: false },
    ],
    participants: [
      { name: 'Дамир', role: 'CEO', department: 'Управление', contact: '@damir' },
      { name: 'Мақсат', role: 'CMO', department: 'Маркетинг', contact: null },
    ],
    unrecognized: [],
    ...overrides,
  };
}

const fixedNow = (): Date => new Date('2026-07-08T09:00:00.000Z');

function card(overrides: Partial<Parameters<typeof buildClientCard>[0]> = {}) {
  return buildClientCard({
    extraction: extraction(),
    schedule: 'Вторник 14:00',
    trackerChatId: 7890,
    spreadsheetId: 'sheet-1',
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
    startDate: '2026-07-08',
    now: fixedNow,
    ...overrides,
  });
}

describe('clientIdFromCompany', () => {
  it('транслитерирует кириллицу и чистит слаг', () => {
    expect(clientIdFromCompany('Ромашка')).toBe('romashka');
    expect(clientIdFromCompany('ТОО «Гео Онлайн»')).toBe('too-geo-onlayn');
    expect(clientIdFromCompany('GeOnline')).toBe('geonline');
    expect(clientIdFromCompany('')).toBe('client');
  });
});

describe('buildClientCard', () => {
  it('определяет CEO, OKR-направление участника, telegram; industry=null', () => {
    const c = card();
    expect(c.clientId).toBe('romashka');
    expect(c.company).toBe('Ромашка');
    expect(c.industry).toBeNull(); // не собирается в F0
    expect(c.ceo).toBe('Дамир');
    const maksat = c.participants.find((p) => p.name === 'Мақсат')!;
    expect(maksat.okrDirection).toBe('Рост выручки'); // owner KR-1.1
    expect(maksat.telegram).toBeNull();
    const damir = c.participants.find((p) => p.name === 'Дамир')!;
    expect(damir.telegram).toBe('@damir');
    expect(c.schedule).toBe('Вторник 14:00');
    expect(c.spreadsheetId).toBe('sheet-1');
  });
});

describe('persist/load карточки', () => {
  it('roundtrip', async () => {
    const dir = join(tmpdir(), `card-${randomUUID()}`);
    const c = card();
    const path = await persistClientCard(c, { rootDir: dir });
    expect(path).toContain('romashka');
    const loaded = await loadClientCard('romashka', { rootDir: dir });
    expect(loaded).toMatchObject({ clientId: 'romashka', ceo: 'Дамир' });
  });

  it('loadClientCard → null если нет файла', async () => {
    expect(await loadClientCard('missing', { rootDir: join(tmpdir(), randomUUID()) })).toBeNull();
  });
});

describe('computeReadinessChecklist', () => {
  it('всё 🟢 при полных данных', () => {
    const items = computeReadinessChecklist(card(), extraction());
    expect(items.every((i) => i.ok)).toBe(true);
  });

  it('🔴 при незакрытых KR (инвариант 1)', () => {
    const ex = extraction({
      objectives: [
        { title: 'O1', krs: [{ formulation: 'X', base: null, target: '10', owner: null, deadline: null }] },
      ],
    });
    const c = card({ extraction: ex });
    const items = computeReadinessChecklist(c, ex);
    const kr = items.find((i) => i.key === 'kr_countable')!;
    expect(kr.ok).toBe(false);
    expect(kr.action).toContain('инвариант 1');
  });

  it('🔴 при отсутствии расписания и таблицы', () => {
    const c = card({ schedule: null, spreadsheetId: null, spreadsheetUrl: null });
    const items = computeReadinessChecklist(c, extraction());
    expect(items.find((i) => i.key === 'participants_and_schedule')!.ok).toBe(false);
    expect(items.find((i) => i.key === 'sheets_ready')!.ok).toBe(false);
  });
});

describe('renderReadinessMessage', () => {
  it('содержит 🟢/🔴 и ссылку', () => {
    const c = card();
    const msg = renderReadinessMessage(c, computeReadinessChecklist(c, extraction()));
    expect(msg).toContain('🟢');
    expect(msg).toContain('docs.google.com');
  });
});
