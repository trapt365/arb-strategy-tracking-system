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
