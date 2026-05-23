#!/usr/bin/env tsx
/**
 * Story 1.10: Client offboarding CLI.
 *
 * Usage:
 *   npx tsx scripts/offboard-client.ts --client-id <id>            # dry-run
 *   npx tsx scripts/offboard-client.ts --client-id <id> --confirm  # delete
 *
 * Removes ONLY `data/{slug}/` — never touches infrastructure state
 * (data/.ops-state.json, data/.scheduler-state.json, data/.backups/).
 * Prints a Manual TODO checklist (Sheets revoke, chat whitelist, etc.)
 * after deletion — Sheets and Telegram side are NOT automated.
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  assertClientId,
  slugifyClientId,
  ClientIdError,
} from '../src/utils/client-id.js';

interface Args {
  clientId: string;
  confirm: boolean;
  dataRoot: string;
}

function printUsage(): void {
  console.log(
    'Usage: tsx scripts/offboard-client.ts --client-id <id> [--confirm] [--data-root <path>]',
  );
}

function parseArgs(argv: string[]): Args {
  let clientId = '';
  let confirm = false;
  let dataRoot = 'data';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--client-id' && argv[i + 1] !== undefined) {
      clientId = argv[++i]!;
    } else if (a === '--confirm') {
      confirm = true;
    } else if (a === '--data-root' && argv[i + 1] !== undefined) {
      dataRoot = argv[++i]!;
    } else if (a === '--help' || a === '-h') {
      printUsage();
      process.exit(0);
    }
  }
  if (clientId.length === 0) {
    console.error('Error: --client-id is required');
    printUsage();
    process.exit(1);
  }
  return { clientId, confirm, dataRoot };
}

interface DirStats {
  files: number;
  bytes: number;
  byExt: Record<string, number>;
}

async function walkStats(dir: string): Promise<DirStats> {
  const stats: DirStats = { files: 0, bytes: 0, byExt: {} };
  async function recur(d: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        await recur(p);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const s = await fs.stat(p);
        stats.files++;
        stats.bytes += s.size;
        const ext = e.name.includes('.')
          ? e.name.slice(e.name.indexOf('.'))
          : '(noext)';
        stats.byExt[ext] = (stats.byExt[ext] ?? 0) + 1;
      } catch {
        // skip unreadable
      }
    }
  }
  await recur(dir);
  return stats;
}

function printManualTodos(): void {
  console.log('\nManual TODO (NOT automated):');
  console.log('  1. Revoke service-account access to client Sheets (Share → remove).');
  console.log('  2. Archive or filter _ops_logs rows for clientId via Sheet UI.');
  console.log('  3. Remove client chat IDs from TELEGRAM_TRACKER_CHAT_IDS env.');
  console.log('  4. Remove client OAuth/API tokens from secret manager.');
  console.log('  5. Record deletion in docs/timur-ops-runbook.md offboarding checklist.');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  try {
    assertClientId(args.clientId);
  } catch (err) {
    if (err instanceof ClientIdError) {
      console.error(`Invalid clientId: ${err.reason} (${err.clientId})`);
      process.exit(1);
    }
    throw err;
  }

  const slug = slugifyClientId(args.clientId);
  const clientDir = join(args.dataRoot, slug);

  try {
    await fs.stat(clientDir);
  } catch {
    console.warn(
      `${clientDir} does not exist (already offboarded or never onboarded).`,
    );
    process.exit(0);
  }

  const stats = await walkStats(clientDir);
  console.log(`\n=== Offboarding plan for clientId='${args.clientId}' (slug='${slug}') ===`);
  console.log(`Path: ${clientDir}`);
  console.log(`Files: ${stats.files}, Total bytes: ${stats.bytes}`);
  console.log('By extension:');
  for (const [ext, count] of Object.entries(stats.byExt).sort()) {
    console.log(`  ${ext}: ${count}`);
  }

  if (!args.confirm) {
    console.log('\nDry-run (no deletion). Re-run with --confirm to actually delete.');
    process.exit(0);
  }

  const t0 = Date.now();
  await fs.rm(clientDir, { recursive: true, force: true });
  const elapsed = Date.now() - t0;
  console.log(
    `\nDeleted ${clientDir} (${stats.files} files, ${stats.bytes} bytes) in ${elapsed}ms`,
  );
  printManualTodos();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
