import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { callClaude as defaultCallClaude } from './adapters/claude.js';
import { loadPrompt as defaultLoadPrompt } from './utils/prompt-loader.js';
import { sanitizeStrategyDocText } from './utils/f0-input.js';
import { truncateEllipsis as truncate } from './utils/telegram-formatter.js';
import { logger as rootLogger, type Logger } from './logger.js';
import { F0OnboardingError } from './errors.js';
import {
  F0FullExtractionSchema,
  F0PersistedSessionSchema,
  type F0FullExtraction,
  type F0ObjectiveDraft,
  type F0PersistedSession,
} from './types.js';

// Story 7.1 (WP-39 Ф2): вертикальный срез F0 — OKR-документ → черновик панели OKR.
// Один Claude-вызов извлечения + чистая валидация инварианта 1 + рендер черновика.
// Диалог дозаполнения — Story 7.3; создание Sheets — Story 7.4.

// === Инвариант 1 (ослаблен, c81754c): KR без числовой базы «с X до Y» и ответственного
// помечается 🔴 и попадает в предупреждение /confirm — но не блокирует завершение ===

export type F0KrIssueReason = 'no_base' | 'no_target' | 'no_owner';

export interface F0KrIssue {
  objectiveIndex: number;
  krIndex: number;
  /** Человекочитаемый адрес KR в черновике, например «O2.3». */
  ref: string;
  formulation: string;
  reasons: F0KrIssueReason[];
}

const hasNumeric = (value: string | null): boolean => value !== null && /\d/.test(value);

/**
 * Чистая функция: помечает несчитаемые KR (инвариант 1 WP-39).
 * 🔴 если нет числовой базы «с X», числовой цели «до Y» или ответственного.
 */
export function markBlockingKrIssues(extraction: { objectives: F0ObjectiveDraft[] }): F0KrIssue[] {
  const issues: F0KrIssue[] = [];
  extraction.objectives.forEach((objective, objectiveIndex) => {
    objective.krs.forEach((kr, krIndex) => {
      const reasons: F0KrIssueReason[] = [];
      // milestone-KR (бинарная веха «внедрено/согласовано/запущено») не имеет базы/цели
      // «с X до Y» — не требуем их (иначе ложные no_base/no_target). metric-KR — как раньше.
      const isMilestone = kr.kr_type === 'milestone';
      if (!isMilestone && !hasNumeric(kr.base)) reasons.push('no_base');
      if (!isMilestone && !hasNumeric(kr.target)) reasons.push('no_target');
      if (kr.owner === null || kr.owner.trim().length === 0) reasons.push('no_owner');
      if (reasons.length > 0) {
        issues.push({
          objectiveIndex,
          krIndex,
          ref: `O${objectiveIndex + 1}.${krIndex + 1}`,
          formulation: kr.formulation,
          reasons,
        });
      }
    });
  });
  return issues;
}

export const F0_ISSUE_REASON_LABELS: Record<F0KrIssueReason, string> = {
  no_base: 'нет числовой базы «с X»',
  no_target: 'нет числовой цели «до Y»',
  no_owner: 'нет ответственного',
};

// === Инвариант 2: каждая гипотеза имеет метрику проверки ===

export interface F0HypothesisIssue {
  index: number;
  ref: string;
  statement: string;
}

/** Гипотезы без метрики проверки (инвариант 2 WP-39) → 🔴. */
export function markHypothesesWithoutMetric(extraction: {
  hypotheses: { statement: string; metric: string | null }[];
}): F0HypothesisIssue[] {
  const issues: F0HypothesisIssue[] = [];
  extraction.hypotheses.forEach((h, index) => {
    if (h.metric === null || h.metric.trim().length === 0) {
      issues.push({ index, ref: `H${index + 1}`, statement: h.statement });
    }
  });
  return issues;
}

// === Пайплайн извлечения (полный: OKR + гипотезы + участники) ===

export interface RunF0DraftArgs {
  /** Сырой текст пакета (конкатенация файлов; чистка выполняется внутри). */
  documentText: string;
  /** Имена исходных файлов через запятую — для логов и черновика. */
  sourceName: string;
  /**
   * Story 9.2: список топов из профиля клиента для промпта F0-извлечения.
   * Пустая строка, когда профиля нет — промпт видит пустую секцию (нейтрально).
   */
  profileParticipants?: string;
  signal?: AbortSignal;
}

export interface RunF0DraftDeps {
  callClaude?: typeof defaultCallClaude;
  loadPrompt?: typeof defaultLoadPrompt;
  logger?: Logger;
}

// Полное извлечение шире OKR-only (панель + гипотезы + участники) — потолок токенов
// выше дефолтного 8192, иначе большой пакет обрезается на середине JSON. Консолидированный
// вход (~38k токенов, все сессии в одном файле) даёт >16k выходного JSON → обрезка;
// подняли до 32k. Если и этого мало → stop_reason=max_tokens отдаст внятную ошибку
// («убери лишние файлы»); устойчивое решение — почанковая экстракция (deferred-work #3).
export const F0_FULL_MAX_TOKENS = 32_000;

// Генерация до 32k токенов из большого пакета занимает ~8-10 мин — дефолтный клиентский
// таймаут SDK (CLAUDE_TIMEOUT_MS=120с) не хватает → `claude_api: Request timed out.`
// (см. deferred-work.md, прод-баг Ф2). Даём щедрый per-call таймаут под 32k.
export const F0_FULL_TIMEOUT_MS = 720_000;

export interface F0FullDraftResult {
  extraction: F0FullExtraction;
  krIssues: F0KrIssue[];
  hypothesisIssues: F0HypothesisIssue[];
  totalKrs: number;
  usage: { input_tokens: number; output_tokens: number };
}

export async function runF0FullDraft(
  args: RunF0DraftArgs,
  deps: RunF0DraftDeps = {},
): Promise<F0FullDraftResult> {
  const callClaude = deps.callClaude ?? defaultCallClaude;
  const loadPrompt = deps.loadPrompt ?? defaultLoadPrompt;
  const log = (deps.logger ?? rootLogger).child({ pipeline: 'F0', step: 'f0.full_extraction' });

  const documentText = sanitizeStrategyDocText(args.documentText, args.sourceName);
  const prompt = await loadPrompt('f0-full-extraction', {
    documentText,
    profileParticipants: args.profileParticipants ?? '',
  });

  log.info({ sourceName: args.sourceName, docChars: documentText.length }, 'f0 full extraction started');

  const { parsed, usage } = await callClaude(prompt, {
    stepName: 'f0_full_extraction',
    schema: F0FullExtractionSchema,
    maxTokens: F0_FULL_MAX_TOKENS,
    timeoutMs: F0_FULL_TIMEOUT_MS,
    signal: args.signal,
    logger: log,
  });

  if (parsed.document_type === 'other') {
    throw new F0OnboardingError('not_okr_document', {
      sourceName: args.sourceName,
      unrecognized: parsed.unrecognized.slice(0, 5),
    });
  }

  const krIssues = markBlockingKrIssues(parsed);
  const hypothesisIssues = markHypothesesWithoutMetric(parsed);
  const totalKrs = parsed.objectives.reduce((sum, o) => sum + o.krs.length, 0);

  log.info(
    {
      sourceName: args.sourceName,
      objectives: parsed.objectives.length,
      totalKrs,
      blockingKrs: krIssues.length,
      hypotheses: parsed.hypotheses.length,
      hypothesesWithoutMetric: hypothesisIssues.length,
      synthesizedHypotheses: parsed.hypotheses.filter((h) => h.synthesized).length,
      participants: parsed.participants.length,
      unrecognized: parsed.unrecognized.length,
    },
    'f0 full extraction complete',
  );

  return { extraction: parsed, krIssues, hypothesisIssues, totalKrs, usage };
}

// === Рендер черновика для Telegram (plain text, без parse_mode) ===

// Секция панели OKR (общая для рендера черновика).
function renderOkrSection(
  extraction: { objectives: F0ObjectiveDraft[] },
  krIssues: F0KrIssue[],
  lines: string[],
): number {
  const totalKrs = extraction.objectives.reduce((sum, o) => sum + o.krs.length, 0);
  if (extraction.objectives.length === 0) {
    // Явный сигнал: документ без OKR (например, протокол-нарратив) — не молчим,
    // иначе трекер не отличит «в документе нет OKR» от «извлечение сломалось».
    lines.push('📊 OKR в документах не найдены — заполнить вручную или приложить OKR-документ.');
    lines.push('');
    return 0;
  }
  const blockingKeys = new Set(krIssues.map((i) => `${i.objectiveIndex}:${i.krIndex}`));
  extraction.objectives.forEach((objective, oi) => {
    lines.push(`📌 ${objective.title}`);
    objective.krs.forEach((kr, ki) => {
      const marker = blockingKeys.has(`${oi}:${ki}`) ? '🔴 ' : '';
      lines.push(`  ${ki + 1}. ${marker}${kr.formulation}`);
      lines.push(
        `     база: ${kr.base ?? '—'} → цель: ${kr.target ?? '—'} | отв.: ${kr.owner ?? '—'} | срок: ${kr.deadline ?? '—'}`,
      );
    });
    lines.push('');
  });
  if (krIssues.length > 0) {
    lines.push(`🔴 KR требуют дозаполнения — ${krIssues.length} из ${totalKrs} несчитаемы:`);
    for (const issue of krIssues) {
      const reasons = issue.reasons.map((r) => F0_ISSUE_REASON_LABELS[r]).join(', ');
      lines.push(`  – ${issue.ref} «${truncate(issue.formulation, 80)}»: ${reasons}`);
    }
    lines.push(
      '⚠️ На /confirm такие KR попадут в предупреждение (не блокируют) — дозаполни базу «с X до Y» и ответственного в диалоге или позже в таблице.',
    );
    lines.push('');
  } else if (totalKrs > 0) {
    lines.push(`✅ Все ${totalKrs} KR считаемы.`);
    lines.push('');
  }
  return totalKrs;
}

export interface RenderF0FullDraftArgs {
  extraction: F0FullExtraction;
  krIssues: F0KrIssue[];
  hypothesisIssues: F0HypothesisIssue[];
  sourceName: string;
  draftId: string;
}

export function renderF0FullDraftMessage(args: RenderF0FullDraftArgs): string {
  const { extraction, krIssues, hypothesisIssues, sourceName, draftId } = args;
  const lines: string[] = [];
  lines.push(`🆕 Черновик онбординга — ${extraction.company ?? 'компания не определена'}`);
  lines.push(`Источник: ${sourceName}`);
  lines.push('');

  renderOkrSection(extraction, krIssues, lines);

  // Банк гипотез
  const hypoIssueIdx = new Set(hypothesisIssues.map((h) => h.index));
  lines.push(`🧪 Банк гипотез — ${extraction.hypotheses.length}`);
  extraction.hypotheses.forEach((h, i) => {
    const marker = hypoIssueIdx.has(i) ? '🔴 ' : '';
    const synth = h.synthesized ? ' ⚠️требует подтверждения' : '';
    lines.push(`  ${i + 1}. ${marker}${h.statement}${synth}`);
    lines.push(`     метрика: ${h.metric ?? '—'} | департамент: ${h.department ?? '—'}`);
  });
  lines.push('');
  if (hypothesisIssues.length > 0) {
    lines.push(
      `🔴 Без метрики проверки — ${hypothesisIssues.length} из ${extraction.hypotheses.length} (инвариант 2):`,
    );
    for (const issue of hypothesisIssues) {
      lines.push(`  – ${issue.ref} «${truncate(issue.statement, 80)}»`);
    }
    lines.push('');
  }
  const synthesizedCount = extraction.hypotheses.filter((h) => h.synthesized).length;
  if (synthesizedCount > 0) {
    lines.push(
      `⚠️ ${synthesizedCount} гипотез синтезированы из решений/инициатив — подтверди формулировки с трекером.`,
    );
    lines.push('');
  }

  // Участники
  lines.push(`👥 Участники — ${extraction.participants.length}`);
  for (const p of extraction.participants) {
    const parts = [p.role, p.department, p.contact].filter((x): x is string => x !== null);
    lines.push(`  – ${p.name}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`);
  }
  lines.push('');

  if (extraction.unrecognized.length > 0) {
    lines.push('❓ Не распознано (уточни или поправь документ):');
    for (const item of extraction.unrecognized) {
      lines.push(`  – ${truncate(item, 160)}`);
    }
    lines.push('');
  }

  lines.push(`Черновик сохранён (${draftId}). Дозаполнение в диалоге — следующий шаг онбординга.`);
  return lines.join('\n');
}

/**
 * Story 8.3 (W4): компактная доставка черновика — саммари + счётчики + блоки 🔴 и
 * «Не распознано» вместо полной простыни. Полные таблицы не инлайнятся: они появятся
 * в Google Sheets клиента после /confirm. Полный рендер (renderF0FullDraftMessage)
 * остаётся для смоуков/отладки.
 */
export function renderF0DraftSummaryMessage(args: RenderF0FullDraftArgs): string {
  const { extraction, krIssues, hypothesisIssues, sourceName, draftId } = args;
  const totalKrs = extraction.objectives.reduce((sum, o) => sum + o.krs.length, 0);
  const lines: string[] = [];
  lines.push(`🆕 Черновик онбординга — ${extraction.company ?? 'компания не определена'}`);
  lines.push(`Источник: ${truncate(sourceName, 140)}`);
  lines.push('');
  lines.push(
    `Извлечено: цели ${extraction.objectives.length} · KR ${totalKrs} · ` +
      `гипотезы ${extraction.hypotheses.length} · участники ${extraction.participants.length}`,
  );
  if (extraction.objectives.length === 0) {
    lines.push('📊 OKR в документах не найдены — приложи OKR-документ или заполни вручную.');
  }
  lines.push('');

  if (krIssues.length > 0) {
    lines.push(`🔴 Неполные KR — ${krIssues.length} из ${totalKrs} (дозаполним в диалоге):`);
    for (const issue of krIssues.slice(0, 10)) {
      const reasons = issue.reasons.map((r) => F0_ISSUE_REASON_LABELS[r]).join(', ');
      lines.push(`  – ${issue.ref} «${truncate(issue.formulation, 60)}»: ${reasons}`);
    }
    if (krIssues.length > 10) lines.push(`  … и ещё ${krIssues.length - 10}`);
  } else if (totalKrs > 0) {
    lines.push(`✅ Все ${totalKrs} KR считаемы.`);
  }
  if (hypothesisIssues.length > 0) {
    lines.push(
      `🔴 Гипотезы без метрики — ${hypothesisIssues.length} из ${extraction.hypotheses.length}: ` +
        `${hypothesisIssues.map((i) => i.ref).join(', ')} (спрошу в диалоге).`,
    );
  }
  const synthesized = extraction.hypotheses.filter((h) => h.synthesized).length;
  if (synthesized > 0) {
    lines.push(`⚠️ Гипотез синтезировано из решений/инициатив: ${synthesized} — подтверди формулировки.`);
  }

  if (extraction.unrecognized.length > 0) {
    lines.push('');
    lines.push(`❓ Не распознано — ${extraction.unrecognized.length}:`);
    for (const item of extraction.unrecognized.slice(0, 5)) {
      lines.push(`  – ${truncate(item, 120)}`);
    }
    if (extraction.unrecognized.length > 5) {
      lines.push(`  … и ещё ${extraction.unrecognized.length - 5}`);
    }
  }

  lines.push('');
  lines.push('Полные таблицы (OKR, гипотезы, участники) будут в Google Sheets клиента после /confirm — пришлю ссылку.');
  lines.push(`Черновик сохранён (${draftId}).`);
  return lines.join('\n');
}

// === Persist черновика (warn-only, по паттерну persistStep из f1-report) ===

export const F0_DRAFTS_DIR = join('data', '.onboarding');

export interface PersistF0DraftDeps {
  logger?: Logger;
  rootDir?: string;
}

/** Общая атомарная запись JSON (warn-only): сбой — warn, пайплайн не падает. */
async function writeJsonFile(
  payload: Record<string, unknown>,
  fileName: string,
  dir: string,
  log: Pick<Logger, 'info' | 'warn'>,
): Promise<string | null> {
  const path = join(dir, fileName);
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    const tmpPath = `${path}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(tmpPath, path);
    log.info({ path }, 'f0 json persisted');
    return path;
  } catch (err) {
    log.warn({ err, path }, 'f0 json persist failed — continuing');
    return null;
  }
}

export interface PersistF0FullDraftArgs {
  draftId: string;
  chatId: number;
  sourceNames: string[];
  createdAt: string;
  result: F0FullDraftResult;
}

export async function persistF0FullDraft(
  args: PersistF0FullDraftArgs,
  deps: PersistF0DraftDeps = {},
): Promise<string | null> {
  const log = (deps.logger ?? rootLogger).child({ pipeline: 'F0', step: 'f0.persist_draft' });
  return writeJsonFile(
    {
      draftId: args.draftId,
      chatId: args.chatId,
      sourceNames: args.sourceNames,
      createdAt: args.createdAt,
      extraction: args.result.extraction,
      krIssues: args.result.krIssues,
      hypothesisIssues: args.result.hypothesisIssues,
      totalKrs: args.result.totalKrs,
    },
    `${args.draftId}.json`,
    deps.rootDir ?? F0_DRAFTS_DIR,
    log,
  );
}

// === Story 7.3: персист/восстановление сессии онбординга ===

/** Персист состояния сессии (warn-only): переживает рестарт бота. */
export async function persistF0Session(
  session: F0PersistedSession,
  deps: PersistF0DraftDeps = {},
): Promise<string | null> {
  const log = (deps.logger ?? rootLogger).child({ pipeline: 'F0', step: 'f0.persist_session' });
  return writeJsonFile(
    session as unknown as Record<string, unknown>,
    `session-${session.chatId}.json`,
    deps.rootDir ?? F0_DRAFTS_DIR,
    log,
  );
}

/** Загрузка сессии с диска; null если файла нет или он не проходит валидацию. */
export async function loadF0Session(
  chatId: number,
  deps: PersistF0DraftDeps = {},
): Promise<F0PersistedSession | null> {
  const log = (deps.logger ?? rootLogger).child({ pipeline: 'F0', step: 'f0.load_session' });
  const dir = deps.rootDir ?? F0_DRAFTS_DIR;
  const path = join(dir, `session-${chatId}.json`);
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch {
    return null; // нет файла — обычная ситуация
  }
  try {
    const parsed = F0PersistedSessionSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log.warn({ path, issues: parsed.error.issues.slice(0, 3) }, 'f0 session file invalid — ignoring');
      return null;
    }
    return parsed.data;
  } catch (err) {
    log.warn({ err, path }, 'f0 session file unreadable — ignoring');
    return null;
  }
}

/** Удаление персиста сессии (например, при старте новой). Warn-only. */
export async function deleteF0Session(
  chatId: number,
  deps: PersistF0DraftDeps = {},
): Promise<void> {
  const dir = deps.rootDir ?? F0_DRAFTS_DIR;
  const path = join(dir, `session-${chatId}.json`);
  try {
    await fs.unlink(path);
  } catch {
    /* нет файла — ок */
  }
}
