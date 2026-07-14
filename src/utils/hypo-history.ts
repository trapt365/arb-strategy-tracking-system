// D12 (live-run 14.07): история прогонов трекера гипотез.
// Раньше трекер генерировался на лету и никуда не сохранялся — трекер не видел,
// какие отчёты по гипотезам уже есть. Теперь каждый успешный прогон пишется в
// data/{clientId}/hypo-reports/{epochSec}.json и доступен из меню кнопки.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { logger as rootLogger } from '../logger.js';

const HypoHistoryEntrySchema = z.object({
  week: z.number().int(),
  year: z.number().int(),
  generatedAt: z.string().min(1),
  compact: z.string(),
  full: z.string(),
});
export type HypoHistoryEntry = z.infer<typeof HypoHistoryEntrySchema>;

export interface HypoHistoryItem {
  id: string; // basename без .json — используется в callback data
  week: number;
  year: number;
  generatedAt: string;
}

const ID_RE = /^\d+$/; // защита от path traversal: id приходит из callback data

function historyDir(clientId: string, rootDir: string): string {
  return join(rootDir, clientId, 'hypo-reports');
}

export async function saveHypoReport(
  clientId: string,
  entry: HypoHistoryEntry,
  opts?: { rootDir?: string },
): Promise<string> {
  const dir = historyDir(clientId, opts?.rootDir ?? 'data');
  await fs.mkdir(dir, { recursive: true });
  const id = String(Math.floor(Date.parse(entry.generatedAt) / 1000));
  await fs.writeFile(join(dir, `${id}.json`), JSON.stringify(entry, null, 2), 'utf8');
  return id;
}

export async function listHypoReports(
  clientId: string,
  opts?: { rootDir?: string },
): Promise<HypoHistoryItem[]> {
  const dir = historyDir(clientId, opts?.rootDir ?? 'data');
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const items: HypoHistoryItem[] = [];
  for (const f of files.filter((f) => f.endsWith('.json'))) {
    const id = f.slice(0, -'.json'.length);
    if (!ID_RE.test(id)) continue;
    try {
      const parsed = HypoHistoryEntrySchema.safeParse(
        JSON.parse(await fs.readFile(join(dir, f), 'utf8')),
      );
      if (!parsed.success) continue;
      items.push({
        id,
        week: parsed.data.week,
        year: parsed.data.year,
        generatedAt: parsed.data.generatedAt,
      });
    } catch (err) {
      rootLogger.warn({ err, file: f, clientId }, 'hypo_history.read_failed');
    }
  }
  // Свежие сверху (id = epoch seconds).
  items.sort((a, b) => Number(b.id) - Number(a.id));
  return items;
}

export async function loadHypoReport(
  clientId: string,
  id: string,
  opts?: { rootDir?: string },
): Promise<HypoHistoryEntry | null> {
  if (!ID_RE.test(id)) return null;
  const file = join(historyDir(clientId, opts?.rootDir ?? 'data'), `${id}.json`);
  try {
    const parsed = HypoHistoryEntrySchema.safeParse(JSON.parse(await fs.readFile(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
