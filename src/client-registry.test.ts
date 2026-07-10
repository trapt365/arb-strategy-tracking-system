import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  loadRegistry,
  upsertClient,
  setActiveClient,
  getActiveClient,
  getClientSheetId,
  getClientTopName,
  getClientName,
  listClientIds,
} from './client-registry.js';

let dir: string;
beforeEach(async () => {
  dir = join(tmpdir(), `registry-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
});
const deps = (): { rootDir: string } => ({ rootDir: dir });

describe('client-registry', () => {
  it('loadRegistry — пусто, если файла нет', async () => {
    expect(await loadRegistry(deps())).toEqual({});
  });

  it('upsert + load roundtrip', async () => {
    await upsertClient('romashka', { sheetId: 'sheet-R', name: 'Ромашка', topName: 'Дамир' }, deps());
    const reg = await loadRegistry(deps());
    expect(reg.romashka).toMatchObject({ sheetId: 'sheet-R', name: 'Ромашка', topName: 'Дамир' });
    expect(reg.romashka!.createdAt).toBeTruthy();
  });

  it('getClientSheetId — реестр для нового, config-fallback для geonline, undefined для неизвестного', async () => {
    await upsertClient('romashka', { sheetId: 'sheet-R', name: 'Ромашка' }, deps());
    expect(await getClientSheetId('romashka', deps())).toBe('sheet-R');
    // geonline не в реестре → fallback на config.GEONLINE_F0_SHEET_ID (vitest env = 'test-sheet-id')
    expect(await getClientSheetId('geonline', deps())).toBe('test-sheet-id');
    expect(await getClientSheetId('unknown-x', deps())).toBeUndefined();
  });

  it('getClientName (Story 8.2) — название компании из реестра, undefined для незарегистрированного', async () => {
    await upsertClient('romashka', { sheetId: 'sheet-R', name: 'Ромашка' }, deps());
    expect(await getClientName('romashka', deps())).toBe('Ромашка');
    expect(await getClientName('geonline', deps())).toBeUndefined();
  });

  it('getClientTopName', async () => {
    await upsertClient('romashka', { sheetId: 'sheet-R', name: 'Ромашка', topName: 'Дамир' }, deps());
    expect(await getClientTopName('romashka', deps())).toBe('Дамир');
    expect(await getClientTopName('geonline', deps())).toBeUndefined();
  });

  it('listClientIds — всегда включает geonline + зарегистрированных', async () => {
    await upsertClient('romashka', { sheetId: 'sheet-R', name: 'Ромашка' }, deps());
    const ids = await listClientIds(deps());
    expect(ids).toContain('geonline');
    expect(ids).toContain('romashka');
  });

  it('createdAt сохраняется при повторном upsert (не перезатирается)', async () => {
    await upsertClient('romashka', { sheetId: 'sheet-R', name: 'Ромашка' }, deps());
    const first = (await loadRegistry(deps())).romashka!.createdAt;
    await upsertClient('romashka', { sheetId: 'sheet-R2', name: 'Ромашка 2' }, deps());
    const reg = await loadRegistry(deps());
    expect(reg.romashka!.createdAt).toBe(first);
    expect(reg.romashka!.sheetId).toBe('sheet-R2');
  });

  it('битый JSON → пустой реестр (не бросает)', async () => {
    await fs.writeFile(join(dir, 'registry.json'), '{ broken', 'utf8');
    expect(await loadRegistry(deps())).toEqual({});
  });

  it('одна битая запись не роняет весь реестр — валидные сохраняются', async () => {
    const mixed = {
      good: { sheetId: 'sheet-G', name: 'Хорошая', createdAt: '2026-01-01T00:00:00.000Z' },
      bad: { name: 'Без sheetId' }, // не проходит ClientRegistryEntrySchema (нет sheetId/createdAt)
    };
    await fs.writeFile(join(dir, 'registry.json'), JSON.stringify(mixed), 'utf8');
    const reg = await loadRegistry(deps());
    expect(reg.good).toMatchObject({ sheetId: 'sheet-G', name: 'Хорошая' });
    expect(reg.bad).toBeUndefined();
  });

  it('JSON-массив (не объект) → пустой реестр', async () => {
    await fs.writeFile(join(dir, 'registry.json'), '[1,2,3]', 'utf8');
    expect(await loadRegistry(deps())).toEqual({});
  });

  // Ревью эпика 9: caller должен видеть, легла ли запись активного клиента —
  // ложное «✅ Клиент: X» отправляло следующий /report в geonline-fallback.
  it('setActiveClient — true при успехе, значение читается обратно', async () => {
    expect(await setActiveClient(42, 'romashka', deps())).toBe(true);
    expect(await getActiveClient(42, deps())).toBe('romashka');
  });

  it('setActiveClient — false при сбое записи (rootDir занят файлом)', async () => {
    const blocked = join(dir, 'as-file');
    await fs.writeFile(blocked, 'not a dir', 'utf8');
    expect(await setActiveClient(42, 'romashka', { rootDir: join(blocked, 'sub') })).toBe(false);
  });
});
