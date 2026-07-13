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
  renderClientCardMessage,
} from './f0-client-card.js';
import type { ClientProfile, F0FullExtraction } from './types.js';

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

  it('ревью 8.2–8.4: слаг капится до 32 символов без хвостового дефиса (callback_data ≤ 64 байта)', () => {
    const long = clientIdFromCompany('Товарищество с ограниченной ответственностью «Щупальца юга»');
    expect(long.length).toBeLessThanOrEqual(32);
    expect(long.endsWith('-')).toBe(false);
    expect(Buffer.byteLength(`client_use:${long}`, 'utf8')).toBeLessThanOrEqual(64);
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

// ─── Story 9.1: профиль клиента в карточке ──────────────────────────────────

const profileFixture: ClientProfile = {
  companyName: 'Ромашка',
  businessSummary: 'Продаём ромашки бизнесу',
  history: 'Основана в 2018',
  tops: [
    { name: 'Дамир', title: 'CEO', authority: 'все решения', area: 'всё' },
    { name: 'Мақсат', title: 'CMO', authority: null, area: 'маркетинг' },
  ],
};

describe('профиль клиента в карточке (Story 9.1)', () => {
  it('buildClientCard переносит profile как есть; без профиля поле отсутствует', () => {
    const withProfile = card({ profile: profileFixture });
    expect(withProfile.profile).toEqual(profileFixture);
    expect(card().profile).toBeUndefined(); // сессии до 9.1 — без профиля
  });

  it('renderClientCardMessage показывает профиль компактно (≤15 строк)', () => {
    const msg = renderClientCardMessage(card({ profile: profileFixture }));
    expect(msg).toContain('Суть: Продаём ромашки бизнесу');
    expect(msg).toContain('Дамир (CEO)');
    expect(msg).not.toContain('DM:');
    expect(msg).toContain('расширенный 2/15'); // заполнены a3_2 (tops), a1_3 (history)
    expect(msg.split('\n').length).toBeLessThanOrEqual(15);
  });

  it('карточка без профиля рендерится как раньше (регресс 8.4)', () => {
    const msg = renderClientCardMessage(card());
    expect(msg).not.toContain('Суть:');
    expect(msg).not.toContain('Профиль:');
    expect(msg).toContain('👤 Ромашка (romashka)');
  });

  it('roundtrip карточки с профилем; старый card.json без profile читается', async () => {
    const dir = join(tmpdir(), `card-${randomUUID()}`);
    await persistClientCard(card({ profile: profileFixture }), { rootDir: dir });
    const loaded = await loadClientCard('romashka', { rootDir: dir });
    expect(loaded?.profile?.tops).toHaveLength(2);

    // Старый формат (до 9.1): без поля profile — валиден без миграции.
    const dir2 = join(tmpdir(), `card-${randomUUID()}`);
    await persistClientCard(card(), { rootDir: dir2 });
    const legacy = await loadClientCard('romashka', { rootDir: dir2 });
    expect(legacy).not.toBeNull();
    expect(legacy!.profile).toBeUndefined();
  });
});
