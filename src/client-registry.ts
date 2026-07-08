import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from './config.js';
import { logger as rootLogger, type Logger } from './logger.js';
import {
  ClientRegistryEntrySchema,
  type ClientRegistry,
  type ClientRegistryEntry,
} from './types.js';

// Story 7.6 (WP-39 Ф2): минимальная мультиклиентность. Реестр clientId→{sheetId,name,topName}
// расшивает хардкод 'geonline'. Geonline остаётся рабочим через fallback на
// config.GEONLINE_F0_SHEET_ID (обратная совместимость, БЕЗ правок env вида GEONLINE_*).

const REGISTRY_DIR = 'data/clients';
const REGISTRY_FILE = 'registry.json';

export interface RegistryDeps {
  rootDir?: string;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

function registryPath(dir: string): string {
  return join(dir, REGISTRY_FILE);
}

/** Загрузка реестра с диска; {} если файла нет или он не проходит валидацию. */
export async function loadRegistry(deps: RegistryDeps = {}): Promise<ClientRegistry> {
  const dir = deps.rootDir ?? REGISTRY_DIR;
  const log = deps.logger ?? rootLogger;
  let raw: string;
  try {
    raw = await fs.readFile(registryPath(dir), 'utf8');
  } catch {
    return {}; // нет файла — обычная ситуация (пока онбординг не создал клиентов)
  }
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch (err) {
    log.warn({ err }, 'client registry unreadable JSON — treating as empty');
    return {};
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    log.warn({}, 'client registry is not an object — treating as empty');
    return {};
  }
  // Толерантный парсинг по-записно: одна битая запись не должна ронять весь реестр
  // (иначе все клиенты молча теряются и уходят в fallback). Отбрасываем только битые.
  const out: ClientRegistry = {};
  const dropped: string[] = [];
  for (const [clientId, entry] of Object.entries(obj as Record<string, unknown>)) {
    const parsed = ClientRegistryEntrySchema.safeParse(entry);
    if (parsed.success) out[clientId] = parsed.data;
    else dropped.push(clientId);
  }
  if (dropped.length > 0) {
    log.warn({ dropped: dropped.slice(0, 5), count: dropped.length }, 'client registry: skipped invalid entries');
  }
  return out;
}

/**
 * sheetId клиента: из реестра, либо fallback на config.GEONLINE_F0_SHEET_ID для 'geonline'
 * (регресс — старый пилот работает без записи в реестр). undefined для неизвестного клиента.
 */
export async function getClientSheetId(
  clientId: string,
  deps: RegistryDeps = {},
): Promise<string | undefined> {
  const registry = await loadRegistry(deps);
  const entry = registry[clientId];
  if (entry) return entry.sheetId;
  if (clientId === 'geonline') return config.GEONLINE_F0_SHEET_ID;
  return undefined;
}

/** Название компании клиента из реестра; undefined если клиент не зарегистрирован. */
export async function getClientName(
  clientId: string,
  deps: RegistryDeps = {},
): Promise<string | undefined> {
  const registry = await loadRegistry(deps);
  return registry[clientId]?.name;
}

/** Имя топ-менеджера клиента (для F1 /report); undefined если не задано. */
export async function getClientTopName(
  clientId: string,
  deps: RegistryDeps = {},
): Promise<string | undefined> {
  const registry = await loadRegistry(deps);
  return registry[clientId]?.topName;
}

/** Список известных clientId (реестр + geonline как встроенный). */
export async function listClientIds(deps: RegistryDeps = {}): Promise<string[]> {
  const registry = await loadRegistry(deps);
  const ids = new Set<string>(Object.keys(registry));
  ids.add('geonline');
  return [...ids];
}

// === Story 8.4 (W10): активный клиент чата — выбор из меню «Клиенты» ===
// Персистится (data/clients/active-clients.json {chatId: clientId}), чтобы выбор
// переживал рестарт: иначе /report молча уехал бы в geonline-fallback.

const ACTIVE_FILE = 'active-clients.json';

async function loadActiveClients(deps: RegistryDeps = {}): Promise<Record<string, string>> {
  const dir = deps.rootDir ?? REGISTRY_DIR;
  const log = deps.logger ?? rootLogger;
  let raw: string;
  try {
    raw = await fs.readFile(join(dir, ACTIVE_FILE), 'utf8');
  } catch {
    return {};
  }
  try {
    const obj: unknown = JSON.parse(raw);
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out: Record<string, string> = {};
    for (const [chatId, clientId] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof clientId === 'string' && clientId.length > 0) out[chatId] = clientId;
    }
    return out;
  } catch (err) {
    log.warn({ err }, 'active-clients unreadable JSON — treating as empty');
    return {};
  }
}

/** Активный клиент чата; undefined если не выбран. */
export async function getActiveClient(
  chatId: number,
  deps: RegistryDeps = {},
): Promise<string | undefined> {
  const map = await loadActiveClients(deps);
  return map[String(chatId)];
}

/** Атомарно запомнить активного клиента чата. Warn-only (не бросает). */
export async function setActiveClient(
  chatId: number,
  clientId: string,
  deps: RegistryDeps = {},
): Promise<void> {
  const dir = deps.rootDir ?? REGISTRY_DIR;
  const log = deps.logger ?? rootLogger;
  const map = await loadActiveClients(deps);
  map[String(chatId)] = clientId;
  const path = join(dir, ACTIVE_FILE);
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(map, null, 2), 'utf8');
    await fs.rename(tmp, path);
    log.info({ chatId, clientId }, 'active client saved');
  } catch (err) {
    log.warn({ err, chatId, clientId }, 'active client save failed — continuing');
  }
}

/** Атомарно добавить/обновить клиента в реестре. Warn-only (не бросает). */
export async function upsertClient(
  clientId: string,
  entry: Omit<ClientRegistryEntry, 'createdAt'> & { createdAt?: string },
  deps: RegistryDeps = {},
): Promise<ClientRegistry | null> {
  const dir = deps.rootDir ?? REGISTRY_DIR;
  const log = deps.logger ?? rootLogger;
  const registry = await loadRegistry(deps);
  const existing = registry[clientId];
  const next: ClientRegistry = {
    ...registry,
    [clientId]: {
      sheetId: entry.sheetId,
      name: entry.name,
      ...(entry.topName !== undefined ? { topName: entry.topName } : {}),
      // createdAt сохраняем от первой регистрации.
      createdAt: existing?.createdAt ?? entry.createdAt ?? new Date().toISOString(),
    },
  };
  const path = registryPath(dir);
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await fs.rename(tmp, path);
    log.info({ path, clientId }, 'client registry upserted');
    return next;
  } catch (err) {
    log.warn({ err, path, clientId }, 'client registry upsert failed — continuing');
    return null;
  }
}
