import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { logger as rootLogger, type Logger } from './logger.js';
import { markBlockingKrIssues } from './f0-onboarding.js';
import { ClientCardSchema, type ClientCard, type F0FullExtraction } from './types.js';

// Story 7.5 (WP-39 Ф2): карточка клиента + чеклист готовности к неделе 1.
// Собирает карточку из данных онбординга (7.1–7.4), кладёт в data/{clientId}/card.json,
// считает чеклист готовности (🟢/🔴 + действие по каждому 🔴, инвариант 1 не обойти).

const DATA_ROOT = 'data';

// Транслитерация кириллицы для clientId-слага.
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

/** clientId-слаг из названия компании: транслит → [a-z0-9-], fallback 'client'. */
export function clientIdFromCompany(company: string): string {
  const lower = (company ?? '').toLowerCase();
  let out = '';
  for (const ch of lower) {
    if (TRANSLIT[ch] !== undefined) out += TRANSLIT[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
    else out += '-';
  }
  out = out.replace(/-+/g, '-').replace(/^-|-$/g, '');
  return out.length > 0 ? out : 'client';
}

/** OKR-направление участника: title objective, чей KR он ведёт (best-effort по owner). */
function matchOkrDirection(name: string, extraction: F0FullExtraction): string | null {
  for (const obj of extraction.objectives) {
    if (obj.krs.some((kr) => kr.owner !== null && kr.owner.trim() === name.trim())) {
      return obj.title;
    }
  }
  return null;
}

const CEO_ROLE_RE = /\b(ceo|гендир|ген\.?\s*дир|генеральный|founder|основатель|собственник)\b/i;

export interface BuildClientCardArgs {
  extraction: F0FullExtraction;
  schedule: string | null;
  trackerChatId: number | null;
  spreadsheetId: string | null;
  spreadsheetUrl: string | null;
  startDate: string; // ISO
  clientId?: string; // явный slug (иначе из company)
  now?: () => Date;
}

export function buildClientCard(args: BuildClientCardArgs): ClientCard {
  const nowFn = args.now ?? ((): Date => new Date());
  const company = args.extraction.company ?? '—';
  const clientId = args.clientId ?? clientIdFromCompany(company);
  const participants = args.extraction.participants.map((p) => ({
    name: p.name,
    role: p.role,
    okrDirection: matchOkrDirection(p.name, args.extraction),
    telegram: p.contact,
  }));
  const ceo =
    args.extraction.participants.find((p) => p.role !== null && CEO_ROLE_RE.test(p.role))?.name ??
    null;
  return {
    clientId,
    company,
    industry: null, // не собирается в F0 — инвариант 3 (не выдумываем)
    participants,
    ceo,
    trackerChatId: args.trackerChatId,
    schedule: args.schedule,
    spreadsheetId: args.spreadsheetId,
    sheetsUrl: args.spreadsheetUrl,
    startDate: args.startDate,
    createdAt: nowFn().toISOString(),
  };
}

export interface CardDeps {
  rootDir?: string;
  logger?: Pick<Logger, 'info' | 'warn'>;
}

/** Атомарно сохранить карточку в data/{clientId}/card.json. Warn-only. */
export async function persistClientCard(
  card: ClientCard,
  deps: CardDeps = {},
): Promise<string | null> {
  const root = deps.rootDir ?? DATA_ROOT;
  const log = deps.logger ?? rootLogger;
  const path = join(root, card.clientId, 'card.json');
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(card, null, 2), 'utf8');
    await fs.rename(tmp, path);
    log.info({ path, clientId: card.clientId }, 'client card persisted');
    return path;
  } catch (err) {
    log.warn({ err, path }, 'client card persist failed — continuing');
    return null;
  }
}

/** Загрузка карточки; null если нет/битая. */
export async function loadClientCard(
  clientId: string,
  deps: CardDeps = {},
): Promise<ClientCard | null> {
  const root = deps.rootDir ?? DATA_ROOT;
  const path = join(root, clientId, 'card.json');
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = ClientCardSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null; // битый JSON — игнорируем
  }
}

// === Чеклист готовности к неделе 1 ===

export interface ReadinessItem {
  key: 'data_loaded' | 'kr_countable' | 'participants_and_schedule' | 'sheets_ready';
  label: string;
  ok: boolean;
  action?: string; // что сделать, если 🔴
}

export function computeReadinessChecklist(
  card: ClientCard,
  extraction: F0FullExtraction,
): ReadinessItem[] {
  const blocking = markBlockingKrIssues(extraction);
  const hasSchedule = card.schedule !== null && card.schedule.trim().length > 0;
  return [
    {
      key: 'data_loaded',
      label: 'Данные загружены (OKR, гипотезы, участники)',
      ok: extraction.objectives.length > 0 && card.participants.length > 0,
      action: 'Загрузи артефакты клиента: /newclient и пришли файлы.',
    },
    {
      key: 'kr_countable',
      label: 'KR считаемы (есть база «с X до Y» и ответственный)',
      ok: blocking.length === 0,
      action: `Дозаполни ${blocking.length} 🔴 KR (базы/цели/ответственных): /resume — инвариант 1 не обойти.`,
    },
    {
      key: 'participants_and_schedule',
      label: 'Участники и слоты встреч заполнены',
      ok: card.participants.length > 0 && hasSchedule,
      action: 'Укажи участников и расписание встреч в диалоге онбординга.',
    },
    {
      key: 'sheets_ready',
      label: 'Google Sheets клиента создан и доступен',
      ok: card.spreadsheetId !== null,
      action: 'Создай таблицу клиента: /confirm (по шаблону v2.0).',
    },
  ];
}

/** Рендер чеклиста для Telegram: 🟢/🔴 по пунктам + действие для каждого 🔴. */
export function renderReadinessMessage(card: ClientCard, items: ReadinessItem[]): string {
  const allOk = items.every((i) => i.ok);
  const lines = [
    `📋 Готовность к неделе 1 — ${card.company}${allOk ? ' ✅' : ''}`,
  ];
  for (const item of items) {
    lines.push(`${item.ok ? '🟢' : '🔴'} ${item.label}`);
    if (!item.ok && item.action) lines.push(`   → ${item.action}`);
  }
  if (card.sheetsUrl) lines.push(`\n🔗 ${card.sheetsUrl}`);
  return lines.join('\n');
}
