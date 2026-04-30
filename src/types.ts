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
