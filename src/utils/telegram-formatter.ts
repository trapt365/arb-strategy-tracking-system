import type { Commitment, Citation, DeliveryReadyReport, FormatSection } from '../types.js';

export type ProgressStep =
  | 'queued'
  | 'running_extraction'
  | 'running_analysis'
  | 'running_formatting'
  | 'almost_ready';

export type ErrorCode =
  | 'invalid_url'
  | 'unsupported_provider'
  | 'missing_arg'
  | 'transcript_too_short'
  | 'transcript_download_failed'
  | 'pipeline_failed'
  | 'queue_overflow'
  | 'unauthorized'
  | 'timeout';

const TELEGRAM_MSG_MAX = 4096;
export const TELEGRAM_SAFE_MARGIN = 4000;

// MarkdownV2 reserved chars (Telegram docs). Order in regex doesn't matter; we escape each.
// Source: https://core.telegram.org/bots/api#markdownv2-style
const MD2_RESERVED_RE = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMarkdownV2(text: string): string {
  if (text.length === 0) return text;
  return text.replace(MD2_RESERVED_RE, (ch) => `\\${ch}`);
}

export function formatHeader(args: {
  emoji: string;
  topName: string;
  topic: string;
  period: string;
}): string {
  return `${args.emoji} ${args.topName} │ ${args.topic} │ ${args.period}`;
}

export function formatProgressStep(step: ProgressStep): string {
  switch (step) {
    case 'queued':
      return 'Принято. Отчёт через ~15 мин.';
    case 'running_extraction':
      return '🔄 Читаю транскрипт…';
    case 'running_analysis':
      return '🔄 Формирую отчёт…';
    case 'running_formatting':
      return '🔄 Форматирую секции…';
    case 'almost_ready':
      return '🔄 Почти готово…';
  }
}

export function formatQueueAck(position: number, totalSize: number): string {
  if (totalSize <= 1) {
    return '✅ Принято. Отчёт через ~15 мин.';
  }
  return `✅ Принято. В очереди: ${position} из ${totalSize}.`;
}

export function formatErrorMessage(code: ErrorCode): string {
  switch (code) {
    case 'invalid_url':
    case 'unsupported_provider':
      return '⚠️ Ссылка не распознана. Проверь формат.';
    case 'missing_arg':
      return '⚠️ Укажи ссылку. Пример: /report https://drive.google.com/...';
    case 'transcript_too_short':
      return '⚠️ Слишком короткий. Отчёт требует ≥ 2 мин.';
    case 'transcript_download_failed':
      return '⚠️ Не удалось скачать файл. Проверь доступ по ссылке.';
    case 'queue_overflow':
      return '⚠️ Очередь заполнена. Попробуй позже.';
    case 'unauthorized':
      return '⚠️ Доступ ограничен.';
    case 'pipeline_failed':
    case 'timeout':
      return '⏰ Задержка. Тимур уведомлён. Пиши отчёт вручную.';
  }
}

function fmtTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function commitmentEmoji(status: Commitment['status']): string {
  switch (status) {
    case 'completed': return '🟢 Выполнено';
    case 'overdue':   return '🔴 Просрочено';
    case 'open':
    default:          return '🔵 Новое';
  }
}

function commitmentEmojiPlain(status: Commitment['status']): string {
  return commitmentEmoji(status);
}

function renderCommitment(c: Commitment): string {
  const emoji = commitmentEmoji(c.status);
  const who = escapeMarkdownV2(c.who);
  const what = escapeMarkdownV2(c.what);
  const deadline = c.deadline.trim().length > 0 ? `, до ${escapeMarkdownV2(c.deadline)}` : '';
  const quote = c.quote.trim().length > 0 ? ` \\— _${escapeMarkdownV2(c.quote)}_` : '';
  return `${emoji}: ${who} → ${what}${deadline}${quote}`;
}

function renderCitation(c: Citation): string {
  const ts = escapeMarkdownV2(fmtTimestamp(c.timestamp));
  const text = escapeMarkdownV2(c.text);
  const speaker = escapeMarkdownV2(c.speaker);
  return `\\[${ts}\\] _${text}_ \\— ${speaker}`;
}

function renderDecisions(decisions: string[]): string {
  if (decisions.length === 0) return '📌 Решения: —';
  const lines = decisions.map((d) => `• ${escapeMarkdownV2(d)}`);
  return ['📌 *Решения:*', ...lines].join('\n');
}

function renderCommitments(commitments: Commitment[]): string {
  if (commitments.length === 0) return '*Commitments:* —';
  const lines = commitments.map((c) => renderCommitment(c));
  return ['*Commitments:*', ...lines].join('\n');
}

function renderCitations(citations: Citation[]): string {
  if (citations.length === 0) return '📝 *Цитаты:* —';
  const lines = citations.slice(0, 10).map((c) => renderCitation(c));
  return ['📝 *Цитаты:*', ...lines].join('\n');
}

function renderSection(section: FormatSection): string {
  const title = `*${escapeMarkdownV2(section.title)}*`;
  const content = escapeMarkdownV2(section.content);
  return `${title}\n${content}`;
}

function buildHeaderForReport(report: DeliveryReadyReport): string {
  const topic = report.department && report.department.length > 0 ? report.department : 'Отчёт';
  const period =
    report.weekNumber && report.weekNumber.length > 0 ? `Нед. ${report.weekNumber}` : '—';
  return formatHeader({
    emoji: '📋',
    topName: escapeMarkdownV2(report.topName),
    topic: escapeMarkdownV2(topic),
    period: escapeMarkdownV2(period),
  });
}

export function formatFullDeliveryReport(
  report: Extract<DeliveryReadyReport, { partial: false }>,
): string {
  const parts: string[] = [];
  parts.push(buildHeaderForReport(report));
  parts.push(`*${escapeMarkdownV2(report.summaryLine)}*`);

  for (const section of report.sections) {
    parts.push(renderSection(section));
  }

  if (report.commitments.length > 0) {
    parts.push(renderCommitments(report.commitments));
  }

  if (report.topMessageDraft && report.topMessageDraft.trim().length > 0) {
    const draftHeader = `📱 *Для ${escapeMarkdownV2(report.topName)}:*`;
    const draftBody = `_${escapeMarkdownV2(report.topMessageDraft)}_`;
    parts.push(`${draftHeader}\n${draftBody}`);
  }

  return parts.join('\n\n');
}

export function formatPartialReportFallback(
  report: Extract<DeliveryReadyReport, { partial: true }>,
): string {
  const parts: string[] = [];
  parts.push(buildHeaderForReport(report));
  parts.push('⚠️ *Автоформатирование не удалось\\. Сырые данные:*');
  parts.push(renderDecisions(report.extractionFallback.decisions));
  parts.push(renderCommitments(report.extractionFallback.commitments));
  parts.push(renderCitations(report.extractionFallback.citations));
  return parts.join('\n\n');
}

export function formatDeliveryReport(report: DeliveryReadyReport): string {
  if (report.partial) {
    return formatPartialReportFallback(report);
  }
  return formatFullDeliveryReport(report);
}

/**
 * Plain-text delivery format for Telegram forwarding.
 * No MarkdownV2 escaping — Aziza forwards this message to the top manager.
 */
export function formatDeliveryPlainText(
  report: Extract<DeliveryReadyReport, { partial: false }>,
): string {
  const parts: string[] = [];
  const topic = report.department ?? 'Отчёт';
  const period = report.weekNumber ? `Нед. ${report.weekNumber}` : '—';
  parts.push(`📋 ${report.topName} │ ${topic} │ ${period}`);
  parts.push(report.summaryLine);

  for (const section of report.sections) {
    parts.push(`\n${section.title}\n${section.content}`);
  }

  if (report.commitments.length > 0) {
    const commitLines = report.commitments.map((c) => {
      const emoji = commitmentEmojiPlain(c.status);
      const deadline = c.deadline.trim() ? `, до ${c.deadline}` : '';
      return `${emoji}: ${c.who} → ${c.what}${deadline}`;
    });
    parts.push(`\nCommitments:\n${commitLines.join('\n')}`);
  }

  return parts.join('\n');
}

/**
 * Story 1.8: onboarding welcome message (plain text — no parse_mode).
 * Single source of truth for /start and /help.
 */
export function formatWelcomeMessage(firstName?: string): string {
  const trimmed = firstName?.trim();
  const greeting = trimmed && trimmed.length > 0 ? `Привет, ${trimmed}!` : 'Привет!';
  return [
    `👋 ${greeting} Я — AI-трекинг бот.`,
    '',
    'Я слушаю записи встреч с топами и готовлю отчёты, которые ты пересылаешь клиенту.',
    '',
    'Основное:',
    '/report <ссылка> — создать отчёт по записи (Google Drive / Zoom)',
    '',
    'Скоро:',
    '🔍 Найти — поиск прошлых отчётов',
    '📋 Повестка — подготовка к встрече',
    '📊 Статус — текущее состояние',
    '',
    'Отправь ссылку на запись — и я сделаю первый отчёт.',
    'Команда /help — повторить эту инструкцию.',
  ].join('\n');
}

/**
 * Story 1.8: short fallback hint for unknown commands / free-form text (UX-DR3).
 * Plain text — no parse_mode.
 */
export function formatHelpHint(): string {
  return 'ℹ️ Не понял команду. Используй /report <ссылка> для отчёта или /help для инструкции.';
}

/**
 * Story 1.9: ops-channel alert formatter (plain text, no parse_mode).
 * Truncates each field independently; total budget ≤ 1500 chars (Telegram limit ~4096 with margin).
 */
export interface FormatOpsAlertArgs {
  pipeline: string;
  step: string;
  clientId?: string;
  level: 'error' | 'warn' | 'info';
  message: string;
  errorCode?: string;
  context?: Record<string, unknown>;
}

const OPS_LEVEL_ICON: Record<FormatOpsAlertArgs['level'], string> = {
  error: '🚨',
  warn: '⚠️',
  info: 'ℹ️',
};

function truncatePlain(s: string, max: number): string {
  if (s.length <= max) return s;
  const suffix = '...[truncated]';
  const head = Math.max(0, max - suffix.length);
  return s.slice(0, head) + suffix;
}

/** Обрезка с многоточием «…» для пользовательских текстов (F0-черновики и вопросы). */
export function truncateEllipsis(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function safeStringifyForOps(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function formatOpsAlert(args: FormatOpsAlertArgs): string {
  const icon = OPS_LEVEL_ICON[args.level];
  const clientIdPart = args.clientId && args.clientId.length > 0 ? ` ${args.clientId}` : '';
  const header = `${icon} [${args.pipeline}/${args.step}]${clientIdPart}`;
  const body = truncatePlain(args.message, 500);
  const lines = [header, body];

  if (args.errorCode && args.errorCode.length > 0) {
    lines.push(`error_code: ${args.errorCode}`);
  }
  if (args.context && Object.keys(args.context).length > 0) {
    lines.push(`context: ${truncatePlain(safeStringifyForOps(args.context), 500)}`);
  }
  return lines.join('\n');
}

/**
 * Story 1.9: watchdog repeat-alert formatter (plain text).
 * Used on 4h/24h thresholds. `escalateAidar` flips icon to 🚨 and adds aidar mention if provided.
 */
export interface FormatWatchdogRepeatArgs {
  hoursDown: number;
  lastSuccessAt: string;
  lastFailureAt: string | null;
  lastFailureReason?: string;
  aidarMention?: string;
  escalateAidar: boolean;
}

function humanReadableOpsDate(iso: string): string {
  if (!iso) return '—';
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}

export function formatWatchdogRepeat(args: FormatWatchdogRepeatArgs): string {
  const icon = args.escalateAidar ? '🚨' : '⚠️';
  const lines: string[] = [];
  lines.push(`${icon} Pipeline down > ${args.hoursDown}ч.`);

  if (args.escalateAidar && args.aidarMention && args.aidarMention.length > 0) {
    lines.push(`${args.aidarMention} — Тимур может быть недоступен.`);
  }

  lines.push(`Последний успех: ${humanReadableOpsDate(args.lastSuccessAt)}`);

  if (args.lastFailureAt) {
    const reason = args.lastFailureReason ? ` (${args.lastFailureReason})` : '';
    lines.push(`Последний сбой: ${humanReadableOpsDate(args.lastFailureAt)}${reason}`);
  }

  lines.push(
    args.escalateAidar
      ? 'Запусти runbook docs/aziza-runbook-v1.0.md.'
      : 'Проверь логи на VPS.',
  );

  return lines.join('\n');
}

export function formatTopMessagePlainText(topName: string, draft: string): string {
  const prefix = `📱 Для ${topName}:\n`;
  const maxDraftLength = Math.max(0, 500 - prefix.length);
  return `${prefix}${draft.trim().slice(0, maxDraftLength).trimEnd()}`;
}

export function splitForTelegram(
  text: string,
  maxLen: number = TELEGRAM_SAFE_MARGIN,
  continuationPrefix?: string,
): string[] {
  if (maxLen <= 0 || maxLen > TELEGRAM_MSG_MAX) {
    maxLen = TELEGRAM_SAFE_MARGIN;
  }
  if (text.length <= maxLen) return [text];

  const continuation =
    continuationPrefix && continuationPrefix.length > 0
      ? `${continuationPrefix}\n\n`
      : '';

  const result: string[] = [];
  const blocks = text.split('\n\n');
  let current = '';

  const flush = (): void => {
    if (current.length === 0) return;
    if (result.length === 0) {
      result.push(current);
    } else {
      result.push(`${continuation}${current}`);
    }
    current = '';
  };

  for (const block of blocks) {
    if (block.length === 0) continue;
    const candidate = current.length === 0 ? block : `${current}\n\n${block}`;
    const budget =
      result.length === 0 ? maxLen : maxLen - continuation.length;
    if (candidate.length <= budget) {
      current = candidate;
      continue;
    }
    // Doesn't fit. Flush current then start a new chunk with this block,
    // unless the block itself exceeds budget — then split it line by line.
    flush();
    if (block.length <= maxLen - continuation.length) {
      current = block;
      continue;
    }
    // Block too large — split by \n.
    const lines = block.split('\n');
    for (const line of lines) {
      const lineCandidate = current.length === 0 ? line : `${current}\n${line}`;
      const lineBudget =
        result.length === 0 ? maxLen : maxLen - continuation.length;
      if (lineCandidate.length <= lineBudget) {
        current = lineCandidate;
      } else {
        flush();
        if (line.length <= maxLen - continuation.length) {
          current = line;
        } else {
          // Hard split by characters as last resort.
          let i = 0;
          const hardBudget = maxLen - continuation.length;
          while (i < line.length) {
            let end = i + hardBudget;
            // Don't split between a backslash and its escaped char (MarkdownV2 safety).
            if (end < line.length && line[end - 1] === '\\') {
              end -= 1;
            }
            if (end <= i) end = i + 1; // guard against zero-advance on degenerate input
            const slice = line.slice(i, end);
            current = slice;
            flush();
            i = end;
          }
        }
      }
    }
  }
  flush();
  return result;
}
