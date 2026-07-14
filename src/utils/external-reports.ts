// D12b (live-run 14.07): внешние отчёты-ссылки в меню недельных отчётов и трекера гипотез.
// История клиента, накопленная ДО подключения бота (готовые отчёты трекера в Google Docs),
// подключается файлом data/{clientId}/external-reports.json — меню показывает их
// url-кнопками рядом с отчётами, сгенерированными ботом. Файл правится вручную.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { logger as rootLogger } from '../logger.js';

const ExternalReportSchema = z.object({
  week: z.number().int(),
  year: z.number().int(),
  title: z.string().optional(),
  url: z.string().url(),
});
export type ExternalReport = z.infer<typeof ExternalReportSchema>;

const ExternalReportsFileSchema = z.object({
  weekly: z.array(ExternalReportSchema).default([]),
  hypo: z.array(ExternalReportSchema).default([]),
});
export type ExternalReports = z.infer<typeof ExternalReportsFileSchema>;

const EMPTY: ExternalReports = { weekly: [], hypo: [] };

export async function loadExternalReports(
  clientId: string,
  opts?: { rootDir?: string },
): Promise<ExternalReports> {
  const file = join(opts?.rootDir ?? 'data', clientId, 'external-reports.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    rootLogger.warn({ err, file, clientId }, 'external_reports.read_failed');
    return EMPTY;
  }
  try {
    const parsed = ExternalReportsFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      rootLogger.warn({ file, clientId, issues: parsed.error.issues }, 'external_reports.schema_skip');
      return EMPTY;
    }
    return parsed.data;
  } catch (err) {
    rootLogger.warn({ err, file, clientId }, 'external_reports.parse_failed');
    return EMPTY;
  }
}
