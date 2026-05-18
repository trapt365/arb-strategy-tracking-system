import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { logger as rootLogger, type Logger } from '../logger.js';
import { ExtractionOutputSchema, type Commitment } from '../types.js';

export interface LoadOpenCommitmentsOpts {
  rootDir?: string;
  maxAgeDays?: number;
  now?: Date;
  logger?: Pick<Logger, 'warn' | 'info'>;
}

export interface OpenCommitmentsResult {
  openCommitments: Commitment[];
  sourceFiles: string[];
}

const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

// NUL separator in dedup key prevents collisions between values that happen to
// concatenate identically (e.g. `who='a b'` + `what='c'` vs `who='a'` + `what='b c'`).
// Source uses the escape sequence rather than literal `\0` so the file stays plain
// ASCII (otherwise git treats it as binary).
const KEY_SEP = String.fromCharCode(0);

export function topNameSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[\\/<>:"|?*]/g, '_');
}

interface CommitmentWithMeta {
  commitment: Commitment;
  mtimeMs: number;
  // Sort key for deterministic tiebreak when two files share the same mtime
  // (batch regen, tarball restore with sec-precision utimes, etc.). Iterating
  // newest-date-first -> smaller dateOrder wins for ties.
  dateOrder: number;
}

export async function loadOpenCommitments(
  clientId: string,
  topName: string,
  opts: LoadOpenCommitmentsOpts = {},
): Promise<OpenCommitmentsResult> {
  const rootDir = opts.rootDir ?? 'data';
  const maxAgeDays = opts.maxAgeDays ?? 90;
  const now = opts.now ?? new Date();
  const log = opts.logger ?? rootLogger;
  const root = join(rootDir, clientId);

  try {
    await fs.stat(root);
  } catch {
    return { openCommitments: [], sourceFiles: [] };
  }

  const slug = topNameSlug(topName);
  const filePattern = new RegExp(
    `^f1-${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[a-f0-9]+\\.extraction\\.json$`,
  );
  const cutoffMs = now.getTime() - maxAgeDays * 86_400_000;

  let dirEntries: import('node:fs').Dirent[];
  try {
    dirEntries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { openCommitments: [], sourceFiles: [] };
  }

  const dateDirs = dirEntries
    .filter((d) => d.isDirectory() && DATE_DIR_RE.test(d.name))
    .map((d) => d.name)
    .sort()
    .reverse();

  const sourceFiles: string[] = [];
  const buckets = new Map<string, CommitmentWithMeta>();

  for (let dateIdx = 0; dateIdx < dateDirs.length; dateIdx++) {
    const dateName = dateDirs[dateIdx]!;
    const dirPath = join(root, dateName);
    const dateMs = Date.parse(`${dateName}T00:00:00Z`);
    if (Number.isFinite(dateMs) && dateMs < cutoffMs) continue;

    let files: string[];
    try {
      files = await fs.readdir(dirPath);
    } catch {
      continue;
    }

    for (const fname of files) {
      if (!filePattern.test(fname)) continue;
      const fullPath = join(dirPath, fname);
      let stat: import('node:fs').Stats;
      try {
        stat = await fs.stat(fullPath);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoffMs) continue;

      let json: unknown;
      try {
        const content = await fs.readFile(fullPath, 'utf8');
        json = JSON.parse(content);
      } catch (err) {
        log.warn?.(
          { step: 'commitments_history.read_failed', file: fullPath, err },
          'failed to read past extraction file',
        );
        continue;
      }

      const parsed = ExtractionOutputSchema.safeParse(json);
      if (!parsed.success) {
        log.warn?.(
          { step: 'commitments_history.schema_skip', file: fullPath, issues: parsed.error.issues },
          'past extraction file does not match current schema, skipping',
        );
        continue;
      }

      sourceFiles.push(join(clientId, dateName, fname));

      // NB: include ALL statuses in dedup. Filtering 'completed'/'overdue' before
      // dedup would let an older 'open' copy shadow a newer 'completed' close,
      // resurrecting commitments that were already closed in a later session.
      //
      // Tiebreak when mtimeMs is equal across files (e.g. batch regen, tarball
      // restore with sec-precision utimes): prefer entries from a NEWER date dir.
      // `dateIdx` iterates newest-first, so smaller dateIdx wins.
      for (const c of parsed.data.commitments) {
        const key = `${c.who}${KEY_SEP}${c.what}${KEY_SEP}${c.deadline}`;
        const existing = buckets.get(key);
        const wins =
          !existing ||
          stat.mtimeMs > existing.mtimeMs ||
          (stat.mtimeMs === existing.mtimeMs && dateIdx < existing.dateOrder);
        if (wins) {
          buckets.set(key, { commitment: c, mtimeMs: stat.mtimeMs, dateOrder: dateIdx });
        }
      }
    }
  }

  const openCommitments = [...buckets.values()]
    .filter((b) => b.commitment.status === undefined || b.commitment.status === 'open')
    .map((b) => b.commitment);
  return { openCommitments, sourceFiles };
}
