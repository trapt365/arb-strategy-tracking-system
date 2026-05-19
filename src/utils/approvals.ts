import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ApprovalRecord } from '../types.js';

const DEFAULT_DATA_ROOT = 'data';

function approvalsPath(clientId: string, dataRoot: string): string {
  return path.join(dataRoot, clientId, 'approvals.jsonl');
}

/** Append an approval record to disk. Creates directory if needed. */
export async function appendApproval(
  record: ApprovalRecord,
  dataRoot = DEFAULT_DATA_ROOT,
): Promise<void> {
  const filePath = approvalsPath(record.clientId, dataRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * Disk-level guard: check if a reportId was already approved.
 * On 1.6, double-tap prevention is in-memory (job.approvalStatus);
 * this is a safety net for future restart scenarios (Story 1.10).
 */
export async function isAlreadyApproved(
  clientId: string,
  reportId: string,
  dataRoot = DEFAULT_DATA_ROOT,
): Promise<boolean> {
  const filePath = approvalsPath(clientId, dataRoot);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content.split('\n').some((line) => {
      if (!line.trim()) return false;
      try {
        const rec = JSON.parse(line) as { reportId?: string };
        return rec.reportId === reportId;
      } catch {
        return false;
      }
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}
