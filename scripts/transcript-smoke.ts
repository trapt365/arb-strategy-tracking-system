/**
 * Story 1.2 — Transcript adapter smoke test
 *
 * Modes:
 *   --url <url>            live: download → soniox → parse → validate
 *   --fixture <json-path>  offline: load saved soniox response → parse → validate
 *                          и diff с data/golden/transcript-N.json (если найден)
 *
 * Examples:
 *   npm run transcript:smoke -- --url 'https://drive.google.com/file/d/.../view'
 *   npm run transcript:smoke -- --fixture data/soniox-results/audio1663213769.m4a.json
 *   npm run transcript:smoke -- --fixture-all
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { transcribeFromUrl, parseSonioxTokens } from '../src/adapters/transcript.js';
import { TranscriptSchema } from '../src/types.js';
import { logger } from '../src/logger.js';

const META_DEFAULT = {
  clientId: 'smoke-test',
  meetingDate: new Date().toISOString(),
  meetingType: 'tracking_session',
};

const ROOT = process.cwd();

interface ParsedArgs {
  mode: 'url' | 'fixture' | 'fixture-all' | 'help';
  value?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--url' && argv[i + 1]) return { mode: 'url', value: argv[i + 1]! };
    if (argv[i] === '--fixture' && argv[i + 1]) return { mode: 'fixture', value: argv[i + 1]! };
    if (argv[i] === '--fixture-all') return { mode: 'fixture-all' };
    if (argv[i] === '--help' || argv[i] === '-h') return { mode: 'help' };
  }
  return { mode: 'help' };
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(`Story 1.2 transcript smoke test

Usage:
  npm run transcript:smoke -- --url <url>           # live (требует SONIOX_API_KEY + drive credentials)
  npm run transcript:smoke -- --fixture <path>      # offline по сохранённому soniox-result
  npm run transcript:smoke -- --fixture-all         # прогнать все data/soniox-results/*.json
`);
}

async function runUrlMode(url: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`▶︎ live transcribe: ${url}`);
  const result = await transcribeFromUrl(url, META_DEFAULT);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    speakerCount: result.speakers.length,
    segmentCount: result.speakers.reduce((acc, s) => acc + s.segments.length, 0),
    durationSec: result.metadata.duration,
  }, null, 2));
}

function findGoldenForFixture(fixtureFilename: string): string | null {
  // fixture name: audio1663213769.m4a.json → ищем transcript-N в manifest
  const audioName = fixtureFilename.replace(/\.json$/, '');
  const manifestPath = join(ROOT, 'data/golden/manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      items?: Array<{ source_file: string; files: { transcript: string } }>;
    };
    const item = manifest.items?.find((it) => it.source_file === audioName);
    if (!item) return null;
    const goldenPath = join(ROOT, 'data/golden', item.files.transcript);
    return existsSync(goldenPath) ? goldenPath : null;
  } catch {
    return null;
  }
}

interface DiffStat {
  speakerCountDiff: number;
  segmentCountDiff: number;
  segmentTextMismatches: number;
  segmentTimingMismatches: number;
}

function diffSpeakers(actual: ReturnType<typeof parseSonioxTokens>, expected: { speakers: Array<{ name: string; segments: Array<{ start: number; end: number; text: string }> }> }): DiffStat {
  const actualByName = new Map(actual.speakers.map((s) => [s.name, s.segments]));
  const expectedByName = new Map(expected.speakers.map((s) => [s.name, s.segments]));

  let segmentTextMismatches = 0;
  let segmentTimingMismatches = 0;
  let segmentCountDiff = 0;

  for (const [name, expectedSegs] of expectedByName) {
    const actualSegs = actualByName.get(name) ?? [];
    segmentCountDiff += Math.abs(expectedSegs.length - actualSegs.length);
    const compareLen = Math.min(expectedSegs.length, actualSegs.length);
    for (let i = 0; i < compareLen; i++) {
      const e = expectedSegs[i]!;
      const a = actualSegs[i]!;
      if (e.text !== a.text) segmentTextMismatches++;
      if (Math.abs(e.start - a.start) > 0.01 || Math.abs(e.end - a.end) > 0.01) {
        segmentTimingMismatches++;
      }
    }
  }

  return {
    speakerCountDiff: Math.abs(actual.speakers.length - expected.speakers.length),
    segmentCountDiff,
    segmentTextMismatches,
    segmentTimingMismatches,
  };
}

async function runFixtureMode(fixturePath: string): Promise<{ ok: boolean; diff?: DiffStat }> {
  const log = logger.child({ component: 'smoke', fixture: basename(fixturePath) });
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  if (!Array.isArray(fixture.tokens)) {
    log.error({ fixturePath }, 'fixture missing tokens[]');
    return { ok: false };
  }

  const parsed = parseSonioxTokens(fixture.tokens, META_DEFAULT);
  const validation = TranscriptSchema.safeParse(parsed);
  if (!validation.success) {
    log.error({ issues: validation.error.issues }, 'parser output failed TranscriptSchema');
    return { ok: false };
  }

  const goldenPath = findGoldenForFixture(basename(fixturePath));
  if (!goldenPath) {
    log.info(
      { speakerCount: parsed.speakers.length, segmentCount: parsed.speakers.reduce((a, s) => a + s.segments.length, 0) },
      'parser ok (no golden pair to diff)',
    );
    return { ok: true };
  }

  const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
  const diff = diffSpeakers(parsed, golden);
  log.info({ goldenPath: basename(goldenPath), ...diff }, 'fixture vs golden diff');
  const isClean =
    diff.speakerCountDiff === 0 &&
    diff.segmentCountDiff === 0 &&
    diff.segmentTextMismatches === 0 &&
    diff.segmentTimingMismatches === 0;
  return { ok: isClean, diff };
}

async function runFixtureAll(): Promise<void> {
  const dir = join(ROOT, 'data/soniox-results');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f));
  // eslint-disable-next-line no-console
  console.log(`▶︎ running ${files.length} fixtures`);
  let passed = 0;
  let failed = 0;
  for (const f of files) {
    const r = await runFixtureMode(f);
    if (r.ok) passed++;
    else failed++;
  }
  // eslint-disable-next-line no-console
  console.log(`\nresult: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.mode) {
    case 'help':
      printHelp();
      return;
    case 'url':
      await runUrlMode(args.value!);
      return;
    case 'fixture': {
      const r = await runFixtureMode(args.value!);
      if (!r.ok) process.exit(1);
      return;
    }
    case 'fixture-all':
      await runFixtureAll();
      return;
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('smoke test failed:', err);
  process.exit(1);
});
