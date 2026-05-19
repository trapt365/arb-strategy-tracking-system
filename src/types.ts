import { z } from 'zod';

export const TranscriptSegmentSchema = z
  .object({
    start: z.number().nonnegative(),
    end: z.number().nonnegative(),
    text: z.string().refine((t) => t.trim().length > 0, 'segment text must not be empty'),
  })
  .refine((s) => s.start <= s.end, 'segment start must be <= end');

export const TranscriptSpeakerSchema = z
  .object({
    name: z.string().min(1),
    segments: z.array(TranscriptSegmentSchema).min(1),
  })
  .refine((sp) => {
    for (let i = 1; i < sp.segments.length; i++) {
      if (sp.segments[i]!.start < sp.segments[i - 1]!.start) return false;
    }
    return true;
  }, 'segments must be sorted by start ascending within a speaker');

export const TranscriptMetadataSchema = z.object({
  // Строгий ISO-8601 с обязательной timezone offset (Z или ±HH:MM). Не принимает
  // произвольные строки, которые случайно парсятся Date.parse.
  date: z.iso.datetime({ offset: true }),
  duration: z.number().nonnegative(),
  meeting_type: z.string().min(1),
});

export const TranscriptSchema = z.object({
  speakers: z.array(TranscriptSpeakerSchema).min(1),
  metadata: TranscriptMetadataSchema,
});

export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;
export type TranscriptSpeaker = z.infer<typeof TranscriptSpeakerSchema>;
export type TranscriptMetadata = z.infer<typeof TranscriptMetadataSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;

export interface TranscriptMeta {
  clientId: string;
  meetingDate: string;
  meetingType?: string;
}

export const StakeholderSchema = z.object({
  fullName: z.string().min(1),
  speakerName: z.string().min(1),
  department: z.string().min(1),
  role: z.string(),
  bscCategory: z.string(),
  responsibilityAreas: z.string(),
  interests: z.string(),
  notes: z.string(),
});
export type Stakeholder = z.infer<typeof StakeholderSchema>;

export const OkrKrSchema = z.object({
  krNumber: z.string().min(1),
  shortName: z.string(),
  keyResult: z.string().min(1),
  owner: z.string().min(1),
  ownerPosition: z.string(),
  currentStatus: z.string(),
  target: z.string(),
  progress: z.string(),
  deadline: z.string(),
  okrGroup: z.string(),
  quarter: z.string(),
});
export type OkrKr = z.infer<typeof OkrKrSchema>;

export const F5MetricSchema = z.object({
  department: z.string().min(1),
  metricName: z.string(),
  metricType: z.enum(['leading', 'lagging']),
  unit: z.string(),
  source: z.string(),
  ownerSpeakerName: z.string(),
  ranges: z.array(z.string()),
  updateFrequency: z.string(),
  riskNotes: z.string(),
  notes: z.string(),
});
export type F5Metric = z.infer<typeof F5MetricSchema>;

export const ClientContextSchema = z.object({
  clientId: z.string().min(1),
  stakeholders: z.array(StakeholderSchema).min(1),
  okrs: z.array(OkrKrSchema).min(1),
  f5Metrics: z.array(F5MetricSchema),
  readAt: z.iso.datetime({ offset: true }),
});
export type ClientContext = z.infer<typeof ClientContextSchema>;

// === F1 pipeline contracts (Story 1.4a) ===

export const CommitmentSchema = z.object({
  who: z.string().min(1),
  what: z.string().min(1),
  // free-form: "не указан" | "до пятницы" | ISO-дата; промпт может вернуть пустую строку
  // для отсутствия — поэтому min(1) НЕ ставим (валидация содержания на промпте).
  deadline: z.string(),
  quote: z.string().min(1),
  status: z.enum(['open', 'completed', 'overdue']).optional(),
});
export type Commitment = z.infer<typeof CommitmentSchema>;

export const CitationSchema = z.object({
  timestamp: z.number().nonnegative(),
  speaker: z.string().min(1),
  text: z.string().min(1),
  approximate: z.boolean().optional().default(false),
});
export type Citation = z.infer<typeof CitationSchema>;

export const ExtractionOutputSchema = z.object({
  decisions: z.array(z.string()),
  commitments: z.array(CommitmentSchema),
  citations: z.array(CitationSchema),
  facts: z.array(z.string()),
  speaker_check: z.array(z.string()).optional().default([]),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;

export const OkrCoverageItemSchema = z.object({
  kr: z.string().min(1),
  status: z.enum(['discussed', 'mentioned', 'blind_zone']),
  mentions_count: z.number().int().nonnegative().optional().default(0),
  substance: z.boolean().optional().default(false),
});
export type OkrCoverageItem = z.infer<typeof OkrCoverageItemSchema>;

export const HypothesisItemSchema = z.object({
  hypothesis: z.string().min(1),
  status: z.enum(['idea', 'in_test', 'result']),
  evidence: z.array(z.string()).optional().default([]),
});
export type HypothesisItem = z.infer<typeof HypothesisItemSchema>;

export const CommitmentStatusUpdateSchema = z.object({
  who: z.string(),
  what: z.string(),
  previous_quote: z.string(),
  new_status: z.enum(['open', 'completed', 'overdue']),
  evidence_quote: z.string().optional(),
});
export type CommitmentStatusUpdate = z.infer<typeof CommitmentStatusUpdateSchema>;

export const AnalysisOutputSchema = z.object({
  okr_coverage: z.array(OkrCoverageItemSchema),
  hypothesis_status: z.array(HypothesisItemSchema),
  alerts: z.array(z.string()),
  commitments_status_updates: z.array(CommitmentStatusUpdateSchema).optional().default([]),
});
export type AnalysisOutput = z.infer<typeof AnalysisOutputSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// F1 Step 3-4: Format + Delivery prep (Story 1.4b)
// ─────────────────────────────────────────────────────────────────────────────

export const FormatSectionSchema = z.object({
  title: z.string().min(1).max(120),
  content: z.string().min(1).max(3500),
});
export type FormatSection = z.infer<typeof FormatSectionSchema>;

export const FormatOutputSchema = z.object({
  report_sections: z.array(FormatSectionSchema).min(1).max(3),
  summary_line: z.string().min(1).max(200),
  commitment_count: z.number().int().nonnegative(),
  alert_count: z.number().int().nonnegative(),
  top_message_draft: z.string().min(20).max(800).optional(),
});
export type FormatOutput = z.infer<typeof FormatOutputSchema>;

export const PartialReasonSchema = z.enum([
  'format_step_failed',
  'format_validation_failed',
  'format_retry_exhausted',
]);
export type PartialReason = z.infer<typeof PartialReasonSchema>;

// Accept both bare date `YYYY-MM-DD` and full ISO datetime (with or without offset).
// Pre-check `MEETING_DATE_PREFIX_RE` in f1-report.ts already gates the prefix; this schema
// stays lenient because Sheets/Telegram surfaces meetingDate as a date-only string.
const MeetingDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, 'meetingDate must start with YYYY-MM-DD');

const FullDeliveryReportSchema = z.object({
  partial: z.literal(false),
  reportId: z.string().min(1),
  clientId: z.string().min(1),
  topName: z.string().min(1),
  meetingDate: MeetingDateSchema,
  // Story 1.5: optional поля для трёхуровневого header'а в Telegram. Story 1.4b runF1
  // прокидывает department из stakeholderMap; weekNumber вычисляется через getISOWeekNumber.
  department: z.string().min(1).max(100).optional(),
  weekNumber: z.string().min(1).max(20).optional(),
  summaryLine: z.string().min(1).max(200),
  sections: z.array(FormatSectionSchema).min(1).max(3),
  commitments: z.array(CommitmentSchema),
  alerts: z.array(z.string()),
  topMessageDraft: z.string().min(20).max(800).optional(),
});

const PartialDeliveryReportSchema = z.object({
  partial: z.literal(true),
  partialReason: PartialReasonSchema,
  reportId: z.string().min(1),
  clientId: z.string().min(1),
  topName: z.string().min(1),
  meetingDate: MeetingDateSchema,
  department: z.string().min(1).max(100).optional(),
  weekNumber: z.string().min(1).max(20).optional(),
  summaryLine: z.string().min(1).max(200),
  sections: z.array(FormatSectionSchema).max(0),
  commitments: z.array(CommitmentSchema),
  alerts: z.array(z.string()),
  extractionFallback: z.object({
    commitments: z.array(CommitmentSchema),
    citations: z.array(CitationSchema).max(10),
    decisions: z.array(z.string()),
    facts: z.array(z.string()),
  }),
});

export const DeliveryReadyReportSchema = z.discriminatedUnion('partial', [
  FullDeliveryReportSchema,
  PartialDeliveryReportSchema,
]);
export type DeliveryReadyReport = z.infer<typeof DeliveryReadyReportSchema>;

// === Story 1.5: Telegram bot — ReportJob ===

export const ReportJobStatusSchema = z.enum(['queued', 'running', 'completed', 'failed']);
export type ReportJobStatus = z.infer<typeof ReportJobStatusSchema>;

export const ReportJobSchema = z.object({
  id: z.string().length(8),
  chatId: z.number().int(),
  url: z.string().min(1),
  clientId: z.string().min(1),
  topName: z.string().min(1),
  meetingDate: z.string().min(1),
  meetingType: z.string().optional(),
  progressMessageId: z.number().int().optional(),
  status: ReportJobStatusSchema.default('queued'),
  queuedAt: z.string().min(1),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  retryCount: z.number().int().nonnegative().default(0),
  partial: z.boolean().optional(),
  partialReason: PartialReasonSchema.optional(),
  // Story 1.6: approval state machine (in-memory only; Story 1.10 adds disk persistence)
  approvalStatus: z.enum(['approved', 'editing', 'rejected']).optional(),
  lastReportText: z.string().optional(),
  pendingEditInstructionMessageId: z.number().int().optional(),
});
export type ReportJob = z.infer<typeof ReportJobSchema>;

// === Story 1.6: Approval record ===

export const ApprovalRecordSchema = z.object({
  reportId: z.string().min(1).max(32),
  clientId: z.string().min(1),
  topName: z.string().min(1),
  chatId: z.number().int(),
  approvedAt: z.string().min(1),
  status: z.literal('approved'),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
