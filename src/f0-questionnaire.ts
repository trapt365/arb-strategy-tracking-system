/**
 * Story 9.5: Вопросник с голосовыми ответами.
 * Тексты вопросов B1.3/B2.1/B2.2/B5.1/B5.2 и buildQnDraft().
 */

import { markBlockingKrIssues, markHypothesesWithoutMetric } from './f0-onboarding.js';
import type { F0FullDraftResult } from './f0-onboarding.js';
import type { ClientProfile, F0FullExtraction } from './types.js';

// ─── Тексты вопросов (из docs/onboarding-questionnaire-v1.0.md) ─────────────

/** B1.3: сбор направлений (objectives) */
export const QN_B1_3_TEXT =
  'Назови 3–5 направлений (целей года), по которым пойдёт стратегия.\n' +
  'Добавляй по одному. Пример: «Рост выручки», «Развитие команды».\n' +
  'Ответь текстом · 🎤 голосом · или нажми ✅ Готово когда добавил все.';

/** B2.1: ключевой результат (формулировка «с X до Y к сроку») */
export function qnB2_1Text(objectiveTitle: string): string {
  return (
    `Направление «${objectiveTitle}»: как поймём, что получилось?\n` +
    'Сформулируй KR «с X до Y к сроку». Пример: «Выручка с 5 до 10 млн к 31 декабря».\n' +
    'Ответь текстом · 🎤 голосом · /skip — пропустить.'
  );
}

/** B2.2: ответственный за KR */
export function qnB2_2Text(objectiveTitle: string): string {
  return `Кто отвечает за результат по направлению «${objectiveTitle}»? Выбери из списка топов.`;
}

/** B5.1: формулировка гипотезы */
export const QN_B5_1_TEXT =
  'Сформулируй гипотезу по шаблону:\n' +
  '«ЕСЛИ (действие) — ТО (эффект с числом) — ПОТОМУ ЧТО (основание)»\n' +
  'Пример: «ЕСЛИ введём рассрочку — ТО конверсия вырастет с 20% до 26% — ПОТОМУ ЧТО 86% платят в рассрочку».\n' +
  'Ответь текстом · 🎤 голосом · или нажми ✅ Готово если гипотез нет.';

/** B5.2: метрика проверки гипотезы */
export const QN_B5_2_TEXT =
  'Чем проверим эту гипотезу? Метрика и срок.\n' +
  'Пример: «Конверсия через 2 месяца после запуска».\n' +
  'Ответь текстом · 🎤 голосом · /skip — пропустить (гипотеза уйдёт в 🔴).';

// ─── buildQnDraft ────────────────────────────────────────────────────────────

/**
 * Структурный subset F0Session, который удовлетворяет QnSessionData через structural typing.
 * Не нужно экспортировать F0Session из createBot() — достаточно buildQnDraft(session).
 */
export interface QnSessionData {
  qnObjectives?: string[];
  qnKrData?: Array<{ formulation: string; owner: string | null }>;
  qnHypotheses?: Array<{ statement: string; metric: string | null }>;
  profile?: ClientProfile;
}

/**
 * Строит F0FullDraftResult из данных вопросника — тот же тип, что у импорта/синтеза.
 * KR «как есть» (base/target/deadline = null → gaps → штатное дозаполнение).
 */
export function buildQnDraft(session: QnSessionData): F0FullDraftResult {
  const objectives = session.qnObjectives ?? [];
  const krData = session.qnKrData ?? [];
  const hypotheses = session.qnHypotheses ?? [];
  const profile = session.profile;

  // Строим objectives: каждый objective получает ровно один KR из qnKrData (по индексу).
  const builtObjectives = objectives.map((title, idx) => {
    const kr = krData[idx];
    if (kr !== undefined) {
      return {
        title,
        krs: [
          {
            formulation: kr.formulation,
            base: null,
            target: null,
            owner: kr.owner,
            deadline: null,
          },
        ],
      };
    }
    return { title, krs: [] };
  });

  // Строим гипотезы.
  const builtHypotheses = hypotheses.map((h) => ({
    statement: h.statement,
    ifThenBecause: null,
    metric: h.metric,
    department: null,
    synthesized: false,
  }));

  // Участники из профиля (топы).
  const tops = profile?.tops ?? [];
  const participants = tops.map((top) => ({
    name: top.name,
    role: top.title ?? null,
    department: top.area ?? null,
    contact: null,
  }));

  const extraction: F0FullExtraction = {
    document_type: 'strategy',
    company: profile?.companyName ?? null,
    objectives: builtObjectives,
    hypotheses: builtHypotheses,
    participants,
    unrecognized: [],
  };

  const krIssues = markBlockingKrIssues(extraction);
  const hypothesisIssues = markHypothesesWithoutMetric(extraction);
  const totalKrs = extraction.objectives.reduce((sum, o) => sum + o.krs.length, 0);

  return {
    extraction,
    krIssues,
    hypothesisIssues,
    totalKrs,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}
