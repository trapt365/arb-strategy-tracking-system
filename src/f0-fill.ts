import type { F0FullExtraction } from './types.js';
import { markBlockingKrIssues, markHypothesesWithoutMetric } from './f0-onboarding.js';
import { truncateEllipsis as truncate } from './utils/telegram-formatter.js';

// Story 7.3: диалог дозаполнения — вычисление пробелов черновика и применение ответов.
// Спрашиваем ТОЛЬКО отсутствующее (kickoff WP-39): базы/цели/ответственные KR,
// метрики гипотез, контакты участников, слоты встреч.

export type F0GapKind =
  | 'kr_base'
  | 'kr_target'
  | 'kr_owner'
  | 'hypo_metric'
  | 'participant_contact'
  | 'schedule';

export interface F0Gap {
  kind: F0GapKind;
  /** Локатор в extraction (не для schedule). */
  objectiveIndex?: number;
  krIndex?: number;
  hypothesisIndex?: number;
  participantIndex?: number;
  /** Человекочитаемый адрес, например «O1.2» / «H3» / участник. */
  ref: string;
  /** Текст вопроса трекеру. */
  question: string;
  /** Story 8.6 (W5): заголовок сущности — только на первом вопросе группы (KR целиком). */
  header?: string;
}

/**
 * Пробелы черновика в порядке диалога: сначала блокирующие KR (инвариант 1),
 * затем метрики гипотез (инвариант 2), контакты участников, и финальный вопрос
 * про расписание встреч. Заполненные поля не спрашиваются.
 */
export function computeF0Gaps(extraction: F0FullExtraction): F0Gap[] {
  const gaps: F0Gap[] = [];

  // KR: база / цель / ответственный — используем ту же логику инварианта 1.
  // Story 8.6 (W5): вопросы одного KR идут подряд под общим заголовком сущности —
  // заголовок кладём на ПЕРВЫЙ вопрос группы, дальше короткие вопросы с ref.
  const krIssues = markBlockingKrIssues(extraction);
  const GAP_LABELS: Record<'no_base' | 'no_target' | 'no_owner', string> = {
    no_base: 'база «с X»',
    no_target: 'цель «до Y»',
    no_owner: 'ответственный',
  };
  for (const issue of krIssues) {
    const kr = extraction.objectives[issue.objectiveIndex]?.krs[issue.krIndex];
    const short = kr ? truncate(kr.formulation, 60) : issue.ref;
    const missing = issue.reasons.map((r) => GAP_LABELS[r]).join(', ');
    const header = `📍 KR ${issue.ref} «${short}» — не хватает: ${missing}.`;
    const firstOfKr = gaps.length;
    for (const reason of issue.reasons) {
      if (reason === 'no_base') {
        gaps.push({
          kind: 'kr_base',
          objectiveIndex: issue.objectiveIndex,
          krIndex: issue.krIndex,
          ref: issue.ref,
          question: `База «с X» для KR ${issue.ref} — текущее значение метрики?`,
        });
      } else if (reason === 'no_target') {
        gaps.push({
          kind: 'kr_target',
          objectiveIndex: issue.objectiveIndex,
          krIndex: issue.krIndex,
          ref: issue.ref,
          question: `Цель «до Y» для KR ${issue.ref}?`,
        });
      } else if (reason === 'no_owner') {
        gaps.push({
          kind: 'kr_owner',
          objectiveIndex: issue.objectiveIndex,
          krIndex: issue.krIndex,
          ref: issue.ref,
          question: `Кто ответственный за KR ${issue.ref}? (имя)`,
        });
      }
    }
    if (gaps.length > firstOfKr) gaps[firstOfKr]!.header = header;
  }

  // Гипотезы без метрики (инвариант 2).
  const hypoIssues = markHypothesesWithoutMetric(extraction);
  for (const issue of hypoIssues) {
    const h = extraction.hypotheses[issue.index];
    gaps.push({
      kind: 'hypo_metric',
      hypothesisIndex: issue.index,
      ref: issue.ref,
      question: `Метрика проверки гипотезы ${issue.ref} «${truncate(issue.statement, 60)}»? (как измерим)`,
    });
  }

  // Участники без telegram-контакта.
  extraction.participants.forEach((p, i) => {
    if (p.contact === null || p.contact.trim().length === 0) {
      gaps.push({
        kind: 'participant_contact',
        participantIndex: i,
        ref: p.name,
        question: `Telegram-контакт участника ${p.name}? (@username или пропусти /skip)`,
      });
    }
  });

  // Финальный вопрос — расписание трекшн-встреч (в extraction не хранится).
  gaps.push({
    kind: 'schedule',
    ref: 'расписание',
    question:
      'Расписание трекшн-встреч: день и время по участникам (свободным текстом). ' +
      'Например: «Айгерим — вт 15:00, Бекзат — чт 11:00».',
  });

  return gaps;
}

// (truncate — общий хелпер из telegram-formatter)

// === Story 8.6 (W6): мягкая валидация числовых ответов ===

/** Пробел ждёт числовое значение (база «с X» / цель «до Y» KR). */
export function needsNumericAnswer(gap: F0Gap): boolean {
  return gap.kind === 'kr_base' || gap.kind === 'kr_target';
}

/**
 * Ответ похож на числовой — критерий тот же, что у инварианта 1
 * (markBlockingKrIssues/hasNumeric): есть хотя бы одна цифра.
 * «70% → 90%», «15 000» проходят; «нет данных» — нет.
 */
export const looksNumericAnswer = (value: string): boolean => /\d/.test(value);

/**
 * Применяет ответ трекера к черновику (мутирует extraction). Возвращает true,
 * если поле было записано; false для kind='schedule' (хранится на сессии, не в extraction).
 */
export function applyF0Answer(extraction: F0FullExtraction, gap: F0Gap, answer: string): boolean {
  const value = answer.trim();
  if (value.length === 0) return false;

  switch (gap.kind) {
    case 'kr_base':
    case 'kr_target':
    case 'kr_owner': {
      const kr = extraction.objectives[gap.objectiveIndex!]?.krs[gap.krIndex!];
      if (kr === undefined) return false;
      if (gap.kind === 'kr_base') kr.base = value;
      else if (gap.kind === 'kr_target') kr.target = value;
      else kr.owner = value;
      return true;
    }
    case 'hypo_metric': {
      const h = extraction.hypotheses[gap.hypothesisIndex!];
      if (h === undefined) return false;
      h.metric = value;
      return true;
    }
    case 'participant_contact': {
      const p = extraction.participants[gap.participantIndex!];
      if (p === undefined) return false;
      p.contact = value;
      return true;
    }
    case 'schedule':
      return false;
  }
}
