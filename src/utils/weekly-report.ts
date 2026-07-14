import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { logger as rootLogger } from '../logger.js';
import { DeliveryReadyReportSchema, type DeliveryReadyReport } from '../types.js';

const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Story 9.7: ISO 8601 week numbering with correct year-boundary handling (deferred [C11]).
 * Find the nearest Thursday (Mon=1…Sun=7, shift +3 to Thu=4), take its year,
 * count difference in weeks from the first Thursday of that year.
 */
export function getISOWeekAndYear(dateStr: string): { week: number; year: number } {
  // Accept both YYYY-MM-DD and ISO datetime strings — slice to date-only part.
  const datePart = dateStr.slice(0, 10);
  const d = new Date(`${datePart}T00:00:00Z`);

  // Shift to nearest Thursday: getUTCDay() returns 0=Sun,1=Mon,...,6=Sat
  // ISO week: Mon=1...Sun=7. Thu=4.
  // dayOfWeek: 1=Mon,...,7=Sun (ISO)
  const dow = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // 1=Mon..7=Sun
  // Offset to Thursday: Thu is dow=4; offset = 4 - dow
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + (4 - dow));

  const year = thursday.getUTCFullYear();

  // First Thursday of the year
  const jan4 = new Date(`${year}-01-04T00:00:00Z`); // Jan 4 is always in week 1
  const jan4Dow = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const firstThursday = new Date(jan4);
  firstThursday.setUTCDate(jan4.getUTCDate() + (4 - jan4Dow));

  const diffMs = thursday.getTime() - firstThursday.getTime();
  const week = Math.round(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1;

  return { week, year };
}

export interface LoadWeekReportsOpts {
  rootDir?: string;
  now?: Date;
}

/**
 * Story 9.7: scan data/{clientId}/ for date-dirs in the current ISO week,
 * read .report.json files, parse with DeliveryReadyReportSchema, return sorted by meetingDate asc.
 * If data/{clientId}/ doesn't exist → return [].
 * Invalid/unreadable files → log.warn + skip.
 */
export async function loadWeekReports(
  clientId: string,
  opts?: LoadWeekReportsOpts,
): Promise<DeliveryReadyReport[]> {
  const rootDir = opts?.rootDir ?? 'data';
  const now = opts?.now ?? new Date();
  const log = rootLogger;

  const todayStr = now.toISOString().slice(0, 10);
  const currentWeek = getISOWeekAndYear(todayStr);

  const root = join(rootDir, clientId);

  let dirEntries: import('node:fs').Dirent[];
  try {
    dirEntries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    // ENOENT = directory never created (no meetings yet) → treated as empty, not an error.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    // Any other error (EACCES, I/O error, etc.) → caller logs and shows error message.
    throw err;
  }

  const dateDirs = dirEntries
    .filter((d) => d.isDirectory() && DATE_DIR_RE.test(d.name))
    .map((d) => d.name)
    .filter((dir) => {
      const { week, year } = getISOWeekAndYear(dir);
      return week === currentWeek.week && year === currentWeek.year;
    });

  const reports: DeliveryReadyReport[] = [];

  for (const dateDir of dateDirs) {
    const dirPath = join(root, dateDir);
    let files: string[];
    try {
      files = await fs.readdir(dirPath);
    } catch (err) {
      log.warn({ err, dir: dirPath, clientId }, 'weekly.readdir_failed');
      continue;
    }

    const reportFiles = files.filter((f) => f.endsWith('.report.json'));

    for (const fname of reportFiles) {
      const fullPath = join(dirPath, fname);
      let json: unknown;
      try {
        const content = await fs.readFile(fullPath, 'utf8');
        json = JSON.parse(content);
      } catch (err) {
        log.warn({ err, file: fullPath, clientId }, 'weekly.read_failed');
        continue;
      }

      const parsed = DeliveryReadyReportSchema.safeParse(json);
      if (!parsed.success) {
        log.warn(
          { file: fullPath, clientId, issues: parsed.error.issues },
          'weekly.schema_skip',
        );
        continue;
      }

      reports.push(parsed.data);
    }
  }

  // Sort by meetingDate ascending (date-only prefix is lexicographically sortable)
  reports.sort((a, b) => a.meetingDate.localeCompare(b.meetingDate));

  return reports;
}

/**
 * D12: все отчёты клиента за всё время (без фильтра по текущей неделе).
 * Объёмы малые (десятки .report.json) — читаем всё и группируем в памяти.
 */
export async function loadAllReports(
  clientId: string,
  opts?: { rootDir?: string },
): Promise<DeliveryReadyReport[]> {
  const rootDir = opts?.rootDir ?? 'data';
  const log = rootLogger;
  const root = join(rootDir, clientId);

  let dirEntries: import('node:fs').Dirent[];
  try {
    dirEntries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const reports: DeliveryReadyReport[] = [];
  for (const entry of dirEntries) {
    if (!entry.isDirectory() || !DATE_DIR_RE.test(entry.name)) continue;
    const dirPath = join(root, entry.name);
    let files: string[];
    try {
      files = await fs.readdir(dirPath);
    } catch (err) {
      log.warn({ err, dir: dirPath, clientId }, 'weekly.readdir_failed');
      continue;
    }
    for (const fname of files.filter((f) => f.endsWith('.report.json'))) {
      const fullPath = join(dirPath, fname);
      try {
        const parsed = DeliveryReadyReportSchema.safeParse(
          JSON.parse(await fs.readFile(fullPath, 'utf8')),
        );
        if (!parsed.success) {
          log.warn({ file: fullPath, clientId, issues: parsed.error.issues }, 'weekly.schema_skip');
          continue;
        }
        reports.push(parsed.data);
      } catch (err) {
        log.warn({ err, file: fullPath, clientId }, 'weekly.read_failed');
      }
    }
  }

  reports.sort((a, b) => a.meetingDate.localeCompare(b.meetingDate));
  return reports;
}

export interface WeekGroup {
  week: number;
  year: number;
  reports: DeliveryReadyReport[];
}

/**
 * D12: группировка отчётов по ISO-неделе (абсолютный номер недели года).
 * Возвращает недели по убыванию (свежие сверху), отчёты внутри — по meetingDate asc.
 */
export function groupReportsByWeek(reports: DeliveryReadyReport[]): WeekGroup[] {
  const map = new Map<string, WeekGroup>();
  for (const r of reports) {
    const { week, year } = getISOWeekAndYear(r.meetingDate);
    const key = `${year}-${week}`;
    const group = map.get(key) ?? { week, year, reports: [] };
    group.reports.push(r);
    map.set(key, group);
  }
  return [...map.values()].sort((a, b) => b.year - a.year || b.week - a.week);
}

/**
 * Story 9.7: format weekly aggregate report (plain text, no MarkdownV2).
 * Header: 📅 Нед. {week}/{year} — {clientName}
 * No meetings: «\n\nВстреч за неделю не обработано.»
 * With meetings: встречи, все commitments, все alerts.
 */
export function formatWeeklyReport(
  reports: DeliveryReadyReport[],
  clientName: string,
  week: number,
  year: number,
): string {
  const header = `📅 Нед. ${week}/${year} — ${clientName}`;

  if (reports.length === 0) {
    return `${header}\n\nВстреч за неделю не обработано.`;
  }

  const lines: string[] = [header, '', `Встреч: ${reports.length}`];

  for (const r of reports) {
    lines.push(`${r.meetingDate} — ${r.topName}: ${r.summaryLine}`);
  }

  const allCommitments = reports.flatMap((r) => r.commitments);
  if (allCommitments.length > 0) {
    lines.push('', 'Обязательства (K):');
    for (const c of allCommitments) {
      const deadline = c.deadline.trim() ? `, до ${c.deadline}` : '';
      lines.push(`• ${c.who} → ${c.what}${deadline}`);
    }
  }

  const allAlerts = reports.flatMap((r) => r.alerts);
  if (allAlerts.length > 0) {
    lines.push('', 'Алерты (M):');
    for (const a of allAlerts) {
      lines.push(`• ${a}`);
    }
  }

  return lines.join('\n');
}
