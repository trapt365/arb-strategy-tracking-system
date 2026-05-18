/**
 * F1 Smoke-test — Story 1.4a
 *
 * Запускает runF1Steps12 на одном golden-транскрипте с реальным Claude API.
 * НЕ запускается в CI (нужен ANTHROPIC_API_KEY).
 *
 * Usage:
 *   npm run f1:smoke                                          # data/golden/transcript-1.json, topName 'Жанель'
 *   npm run f1:smoke -- data/golden/transcript-3.json
 *   npm run f1:smoke -- data/golden/transcript-3.json Айдар   # override topName
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { runF1 } from '../src/f1-report.js';
import {
  TranscriptSchema,
  ClientContextSchema,
  type Stakeholder,
  type OkrKr,
} from '../src/types.js';

const snakeToCamel = (s: string): string =>
  s.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

function rekeyCamel<T>(obj: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[snakeToCamel(k)] = v;
  return out as T;
}

// `new Date().toISOString()` returns `…Z` (no explicit offset). TranscriptSchema's
// `meetingDate` requires `z.iso.datetime({ offset: true })`, which rejects `Z` —
// so emit `+00:00` instead. Same UTC instant; just preserves the offset literal.
function nowIsoWithOffset(): string {
  return new Date().toISOString().replace(/Z$/, '+00:00');
}

async function main(): Promise<void> {
  const transcriptPath = process.argv[2] ?? 'data/golden/transcript-1.json';
  // Second CLI arg = topName override (default 'Жанель' to match existing
  // stakeholder-map.json fixture). Spec D1 + dev hardcode previously made the
  // smoke nondiagnostic for other tops.
  const topName = process.argv[3] ?? 'Жанель';

  const transcriptRaw = JSON.parse(await fs.readFile(transcriptPath, 'utf8'));
  if (!transcriptRaw.metadata) {
    transcriptRaw.metadata = {
      date: nowIsoWithOffset(),
      duration: 600,
      meeting_type: 'tracking_session',
    };
  } else {
    transcriptRaw.metadata.date ??= nowIsoWithOffset();
    transcriptRaw.metadata.duration ??= 600;
    transcriptRaw.metadata.meeting_type ??= 'tracking_session';
  }
  const transcript = TranscriptSchema.parse(transcriptRaw);

  const stakeholdersRaw = JSON.parse(
    await fs.readFile('data/stakeholder-map.json', 'utf8'),
  ) as Record<string, unknown>[];
  const stakeholders = stakeholdersRaw.map((r) => rekeyCamel<Stakeholder>(r));

  const okrRaw = JSON.parse(
    await fs.readFile('data/okr-context.json', 'utf8'),
  ) as { krs: Record<string, unknown>[] };
  const okrs = okrRaw.krs.map((r) => rekeyCamel<OkrKr>(r));

  const clientContext = ClientContextSchema.parse({
    clientId: 'geonline',
    stakeholders,
    okrs,
    f5Metrics: [],
    readAt: new Date().toISOString(),
  });

  const result = await runF1({
    transcript,
    clientContext,
    meta: {
      clientId: 'geonline',
      topName,
      meetingDate: transcript.metadata.date,
      meetingType: transcript.metadata.meeting_type,
    },
    deps: {
      rootDir: join(process.cwd(), 'data', 'smoke-results'),
    },
  });

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        reportId: result.reportId,
        durationsMs: result.durationsMs,
        tokens: result.tokens,
        partial: result.partial,
        partialReason: result.partialReason,
        summaryLine: result.formattedReport.summaryLine,
        sectionsCount: result.formattedReport.partial
          ? 0
          : result.formattedReport.sections.length,
        topMessageDraftPresent:
          !result.formattedReport.partial && !!result.formattedReport.topMessageDraft,
        commitmentsCount: result.formattedReport.commitments.length,
        commitments: result.extraction.commitments.length,
        citations: result.extraction.citations.length,
        decisions: result.extraction.decisions.length,
        facts: result.extraction.facts.length,
        speakerCheck: result.extraction.speaker_check ?? [],
        okrCoverage: result.analysis.okr_coverage.length,
        alerts: result.analysis.alerts,
        statusUpdates: result.analysis.commitments_status_updates?.length ?? 0,
        openCommitmentsBefore: result.openCommitmentsBefore.length,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('F1 smoke failed:', err);
  process.exit(1);
});
