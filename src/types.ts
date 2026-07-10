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
  url: z.string().optional(),
  filePath: z.string().optional(),
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
  approvalStatus: z.enum(['approved', 'editing', 'rejected', 'delivered']).optional(),
  lastReportText: z.string().optional(),
  pendingEditInstructionMessageId: z.number().int().optional(),
  // Story 1.7: delivery tracking
  deliveryMessageIds: z.array(z.number().int()).optional(),
  topMessageDraft: z.string().optional(),
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

// === Story 7.1: F0 onboarding — черновик панели OKR (WP-39 Ф2) ===
// Контракт Claude-ответа. Инвариант 3 («не выдумывать») зашит в схему:
// отсутствующее в документе значение — null, сомнительные фрагменты — в unrecognized.

export const F0KrDraftSchema = z.object({
  formulation: z.string().min(1),
  // metric — численный KR с базой/целью «с X до Y»; milestone — бинарная веха
  // (внедрено/согласовано/запущено/создано), у которой base/target не требуются
  // (инвариант 1 их не спрашивает). optional — обратная совместимость: старые черновики
  // и отсутствующее поле трактуются как metric (markBlockingKrIssues).
  kr_type: z.enum(['metric', 'milestone']).optional(),
  // Числовая база «с X» как записано в документе; null если базы в документе нет.
  base: z.string().nullable(),
  // Целевое значение «до Y»; null если цель не числовая/отсутствует.
  target: z.string().nullable(),
  owner: z.string().nullable(),
  // Срок как записан в документе («До 30.07.2026», «Q1 2026», «Постоянно»); не нормализуем.
  deadline: z.string().nullable(),
});
export type F0KrDraft = z.infer<typeof F0KrDraftSchema>;

export const F0ObjectiveDraftSchema = z.object({
  title: z.string().min(1),
  krs: z.array(F0KrDraftSchema),
});
export type F0ObjectiveDraft = z.infer<typeof F0ObjectiveDraftSchema>;

// === Story 7.2: полный вход — гипотезы + участники ===

export const F0HypothesisDraftSchema = z.object({
  // Краткое название гипотезы (как в трекере) — всегда есть.
  statement: z.string().min(1),
  // Полная формулировка ЕСЛИ-ТО-ПОТОМУ ЧТО; null если в документе только краткое название.
  ifThenBecause: z.string().nullable(),
  // Метрика проверки (инвариант 2). null → бот пометит 🔴 и потребует дозаполнения.
  metric: z.string().nullable(),
  department: z.string().nullable(),
  // true — гипотеза синтезирована из решения/инициативы (кейс SAM), требует подтверждения.
  synthesized: z.boolean(),
});
export type F0HypothesisDraft = z.infer<typeof F0HypothesisDraftSchema>;

export const F0ParticipantDraftSchema = z.object({
  name: z.string().min(1),
  role: z.string().nullable(),
  department: z.string().nullable(),
  // telegram/телефон — почти всегда отсутствует в артефактах, спрашивается в 7.3.
  contact: z.string().nullable(),
});
export type F0ParticipantDraft = z.infer<typeof F0ParticipantDraftSchema>;

export const F0FullExtractionSchema = z.object({
  document_type: z.enum(['strategy', 'other']),
  company: z.string().nullable(),
  objectives: z.array(F0ObjectiveDraftSchema),
  hypotheses: z.array(F0HypothesisDraftSchema),
  participants: z.array(F0ParticipantDraftSchema),
  unrecognized: z.array(z.string()),
});
export type F0FullExtraction = z.infer<typeof F0FullExtractionSchema>;

// === Story 7.3: диалог дозаполнения + персист сессии ===

export const F0GapSchema = z.object({
  kind: z.enum(['kr_base', 'kr_target', 'kr_owner', 'hypo_metric', 'participant_contact', 'schedule']),
  objectiveIndex: z.number().int().optional(),
  krIndex: z.number().int().optional(),
  hypothesisIndex: z.number().int().optional(),
  participantIndex: z.number().int().optional(),
  ref: z.string(),
  question: z.string(),
  // Story 8.6 (W5): заголовок сущности на первом вопросе группы (KR целиком).
  // Optional — сессии, персистнутые до 8.6, валидны без него.
  header: z.string().optional(),
});

// === Story 9.1: профиль клиента — обязательный первый шаг онбординга (Часть A) ===

// Топ-менеджер из A3.2: «имя — должность, полномочия, зона: …». Всё, кроме имени,
// может не разложиться из свободного ответа (инвариант 3: не выдумываем) → nullable.
export const ClientTopSchema = z.object({
  name: z.string().min(1),
  title: z.string().nullable(), // должность
  authority: z.string().nullable(), // полномочия
  area: z.string().nullable(), // зона ответственности
});
export type ClientTop = z.infer<typeof ClientTopSchema>;

// Финансовая «Точка А» (A2) + желаемая цифра (A4.5). Все поля optional —
// неотвеченные вопросы остаются незаполненными (инвариант 3).
export const ClientProfileFinancialsSchema = z.object({
  start: z
    .object({
      revenue: z.string().optional(), // A2.1
      profitability: z.string().optional(), // A2.2
      unitEconomics: z.string().optional(), // A2.3
      debts: z.string().optional(), // A2.4
    })
    .optional(),
  target: z.string().optional(), // A4.5
});

// Запрос и ожидания (A4).
export const ClientProfileRequestSchema = z.object({
  problem: z.string().optional(), // A4.1
  trigger: z.string().optional(), // A4.2
  tried: z.string().optional(), // A4.3
  resultImage: z.string().optional(), // A4.4
  priorities: z.array(z.string()).optional(), // A4.6 — ранжирование 1-2-3
});

// Профиль клиента по Части A вопросника v1.0. ВСЁ optional (паттерн 8.5/8.6):
// старые card.json / session-*.json читаются без миграции.
export const ClientProfileSchema = z.object({
  companyName: z.string().optional(), // A1.1 🔑
  businessSummary: z.string().optional(), // A1.2 🔑
  history: z.string().optional(), // A1.3
  owners: z.string().optional(), // A1.4
  financials: ClientProfileFinancialsSchema.optional(), // A2.1–A2.4 + A4.5
  headcount: z.string().optional(), // A2.5
  orgStructure: z.string().optional(), // A3.1 (текст или референс 📎 на файл)
  request: ClientProfileRequestSchema.optional(), // A4
  tops: z.array(ClientTopSchema).optional(), // A3.2 🔑
  decisionMaker: z.string().optional(), // A3.3 🔑
});
export type ClientProfile = z.infer<typeof ClientProfileSchema>;

// Персист сессии онбординга — переживает рестарт бота (AC3 Story 7.3).
export const F0PersistedSessionSchema = z.object({
  chatId: z.number().int(),
  sessionId: z.string().min(1),
  // Story 9.1: 'profile' — диалог профиля клиента до сбора документов.
  phase: z.enum(['profile', 'collecting', 'filling', 'ready', 'questionnaire']),
  // Story 9.1: до сборки черновика (фаза profile/collecting) черновика нет —
  // draftId/extraction optional. Старые файлы (7.3–8.6) содержат оба поля и валидны.
  draftId: z.string().min(1).optional(),
  sourceNames: z.array(z.string()),
  extraction: F0FullExtractionSchema.optional(),
  gaps: z.array(F0GapSchema),
  gapIndex: z.number().int().nonnegative(),
  schedule: z.string().nullable(),
  // Story 7.4: id созданной Google Sheets — переживает рестарт, гарантирует retry без дублей.
  spreadsheetId: z.string().optional(),
  // Story 8.6 (W6): индекс пробела, по которому уже был переспрос числового формата —
  // рестарт посреди переспроса не начинает валидацию заново. Optional (совместимость 7.3).
  retryGapIndex: z.number().int().nonnegative().optional(),
  // Story 8.5: путь онбординга (import — один xlsx без LLM; synthesis — документы через
  // LLM). Optional — сессии до 8.5 валидны без него (трактуются как synthesis).
  mode: z.enum(['import', 'synthesis']).optional(),
  // Story 8.5: текстифицированный xlsx для кнопки «🧠 Досинтезировать гипотезы» —
  // переживает рестарт, чтобы кнопка работала и после перезапуска бота.
  importSourceText: z.string().optional(),
  // Ревью эпика 9: пакет документов и принятый xlsx-импорт переживают рестарт.
  // Сессия фазы collecting с профилем персистится (9.1), но без этих полей restore
  // отвечал «↩️ Восстановил…» с пустым пакетом — файлы приходилось слать заново.
  documents: z.array(z.object({ sourceName: z.string(), text: z.string() })).optional(),
  documentsChars: z.number().int().nonnegative().optional(),
  importResult: z
    .object({
      extraction: F0FullExtractionSchema,
      format: z.enum(['template', 'generic']),
      sheetName: z.string(),
      mappedColumns: z.array(z.string()),
      sourceName: z.string(),
    })
    .optional(),
  // Story 9.1: профиль клиента (Часть A) + позиция диалога профиля. Всё optional —
  // сессии до 9.1 валидны без них; persist после каждого ответа переживает рестарт.
  profile: ClientProfileSchema.optional(),
  profileQIndex: z.number().int().nonnegative().optional(),
  // Индекс вопроса, по которому уже был переспрос (числовой формат 8.6 / формат топа) —
  // рестарт посреди переспроса не начинает валидацию заново.
  profileRetryQIndex: z.number().int().nonnegative().optional(),
  // Трекер выбрал «➕ Расширенный профиль» (иначе после минимума — экран выбора).
  profileExtended: z.boolean().optional(),
  // Дозаполнение профиля из карточки готового клиента: ответы дописываются в card.json.
  profileCardClientId: z.string().optional(),
  // Story 9.5: вопросник-фаза — этапы, индексы, накопленные данные.
  qnStage: z.enum(['obj_collect', 'b2_kr', 'hypo_collect']).optional(),
  qnObjIdx: z.number().int().nonnegative().optional(),
  qnKrStep: z.enum(['text', 'owner']).optional(),
  qnHypoStep: z.enum(['statement', 'metric']).optional(),
  qnObjectives: z.array(z.string()).optional(),
  qnKrData: z.array(z.object({ formulation: z.string(), owner: z.string().nullable() })).optional(),
  qnHypotheses: z.array(z.object({ statement: z.string(), metric: z.string().nullable() })).optional(),
  qnRetryKrIdx: z.number().int().nonnegative().optional(),
  // Story 9.5: голосовые ответы — pending transcript, ждём подтверждения трекером.
  voicePending: z.object({ transcript: z.string() }).optional(),
  updatedAt: z.string().min(1),
});
export type F0PersistedSession = z.infer<typeof F0PersistedSessionSchema>;

// === Story 7.5: карточка клиента + чеклист готовности к неделе 1 ===

export const ClientCardParticipantSchema = z.object({
  name: z.string().min(1),
  role: z.string().nullable(),
  // OKR-направление — objective.title, чей KR ведёт участник (best-effort матч по owner).
  okrDirection: z.string().nullable(),
  telegram: z.string().nullable(),
});
export type ClientCardParticipant = z.infer<typeof ClientCardParticipantSchema>;

export const ClientCardSchema = z.object({
  clientId: z.string().min(1),
  company: z.string(),
  // Отрасль не собирается в F0 (инвариант 3 — не выдумываем) → null до ручного заполнения.
  industry: z.string().nullable(),
  participants: z.array(ClientCardParticipantSchema),
  ceo: z.string().nullable(),
  trackerChatId: z.number().int().nullable(),
  schedule: z.string().nullable(),
  spreadsheetId: z.string().nullable(),
  sheetsUrl: z.string().nullable(),
  startDate: z.string(), // ISO-дата старта онбординга
  createdAt: z.string(),
  // Story 9.1: профиль клиента (Часть A). Optional — карточки до 9.1 читаются без миграции.
  profile: ClientProfileSchema.optional(),
});
export type ClientCard = z.infer<typeof ClientCardSchema>;

// === Story 7.6: минимальная мультиклиентность — реестр clientId→sheetId ===

export const ClientRegistryEntrySchema = z.object({
  sheetId: z.string().min(1),
  name: z.string(),
  // Топ-менеджер клиента (для F1 /report) — имя из карточки; опционально.
  topName: z.string().optional(),
  createdAt: z.string(),
});
export type ClientRegistryEntry = z.infer<typeof ClientRegistryEntrySchema>;

export const ClientRegistrySchema = z.record(z.string(), ClientRegistryEntrySchema);
export type ClientRegistry = z.infer<typeof ClientRegistrySchema>;
