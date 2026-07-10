import type { ClientProfile, ClientTop } from './types.js';
import { truncateEllipsis as truncate } from './utils/telegram-formatter.js';

// Story 9.1 (CR-3): «Профиль клиента» — обязательный первый шаг онбординга.
// Чистые функции очереди вопросов Части A вопросника v1.0 (по образцу f0-fill.ts):
// bot.ts остаётся тонким. Формулировки, примеры, порядок и 🔑-маркировка — дословно
// по docs/onboarding-questionnaire-v1.0.md.

export type ProfileQuestionType = 'text' | 'number' | 'tops' | 'choice' | 'file-ok';

export interface ProfileQuestion {
  /** id вопроса вопросника, напр. 'a1_1' (A1.1). */
  id: string;
  /** Блок Части A — заголовок показывается при входе в блок. */
  block: 'A1' | 'A2' | 'A3' | 'A4';
  /** 🔑 — критический минимум (нельзя пропустить: /skip → пояснение + повтор). */
  key: boolean;
  type: ProfileQuestionType;
  /** Текст вопроса — дословно по Части A. */
  text: string;
  /** Пример ответа (стандарт SAM: калибрует детализацию). */
  example?: string;
}

// Заголовки блоков — дословно по Части A.
export const PROFILE_BLOCK_HEADERS: Record<ProfileQuestion['block'], string> = {
  A1: 'A1. Компания и история',
  A2: 'A2. Цифры — Точка А (стартовые показатели)',
  A3: 'A3. Люди и оргструктура',
  A4: 'A4. Запрос и ожидания (проблематизация первого прохода)',
};

// 🔑-минимум: только название + суть; топы/DM — в начале расширенного.
export const PROFILE_MIN_QUESTIONS: ProfileQuestion[] = [
  {
    id: 'a1_1',
    block: 'A1',
    key: true,
    type: 'text',
    text: 'Как называется компания?',
  },
  {
    id: 'a1_2',
    block: 'A1',
    key: true,
    type: 'text',
    text: 'Чем занимается компания и для кого? Отрасль, продукт, кто клиент.',
    example:
      'Образовательный центр подготовки к ЕНТ, Алматы+онлайн; клиенты — родители школьников 9–11 классов',
  },
];

// Расширенный профиль — опционален, порядок блоков как в Части A.
// a3_2 и a3_3 — всегда первыми (a3_2 перед a3_3: profileDmKeyboard строит список из tops).
export const PROFILE_EXT_QUESTIONS: ProfileQuestion[] = [
  {
    id: 'a3_2',
    block: 'A3',
    key: false,
    type: 'tops',
    text:
      'Кто из топов участвует в исполнении стратегии? По каждому: имя, должность, полномочия, зона ответственности. По одному сообщением.',
    example: 'Дамир — коммерческий директор, полный P&L продаж, зона: выручка и воронка',
  },
  {
    id: 'a3_3',
    block: 'A3',
    key: false,
    type: 'choice',
    text: 'Кто принимает финальные решения по стратегии (decision maker)?',
  },
  {
    id: 'a1_3',
    block: 'A1',
    key: false,
    type: 'text',
    text: 'Год основания и история в двух предложениях: как возник бизнес, ключевые повороты.',
    example: 'Основан в 2018 партнёрами-репетиторами; в 2023 запустили онлайн и выросли ×3',
  },
  {
    id: 'a1_4',
    block: 'A1',
    key: false,
    type: 'text',
    text: 'Кто владельцы/партнёры и кто из них в операционке?',
    example: 'Два партнёра 60/40, оба в операционке; третий — младший партнёр, не участвует',
  },
  {
    id: 'a2_1',
    block: 'A2',
    key: false,
    type: 'number',
    text: 'Выручка за последние 12 месяцев? (точная или прикидка — пометь)',
    example: '120 млн ₸, прикидка',
  },
  {
    id: 'a2_2',
    block: 'A2',
    key: false,
    type: 'number',
    text: 'Прибыльность: чистая прибыль или маржа, %',
    example: '12% маржа; «не знаю» допустимо',
  },
  {
    id: 'a2_3',
    block: 'A2',
    key: false,
    type: 'text',
    text: 'Юнит-экономика живьём: средний чек, клиентов/сделок в месяц, конверсия — что знаешь',
    example: 'Чек 200 тыс ₸, 86% в рассрочку, ~2500 лидов/мес, конверсия ~20%',
  },
  {
    id: 'a2_4',
    block: 'A2',
    key: false,
    type: 'text',
    text: 'Есть ли долги, кредиты, кассовые разрывы, которые давят на решения?',
  },
  {
    id: 'a2_5',
    block: 'A2',
    key: false,
    type: 'number',
    text: 'Сколько людей в компании?',
    example: '35',
  },
  {
    id: 'a3_1',
    block: 'A3',
    key: false,
    type: 'file-ok',
    text: 'Текущая оргструктура — опиши или пришли файл 📎',
  },
  {
    id: 'a4_1',
    block: 'A4',
    key: false,
    type: 'text',
    text: 'Что привело? В чём именно сейчас проблема или задача?',
  },
  {
    id: 'a4_2',
    block: 'A4',
    key: false,
    type: 'text',
    text: 'Почему это стало актуальным именно сейчас? Что случилось?',
  },
  {
    id: 'a4_3',
    block: 'A4',
    key: false,
    type: 'text',
    text: 'Что уже пробовали, чтобы решить (консультанты, школы, свои попытки)? Что не сработало и почему?',
    example: 'Прошли курс Х, заказывали маркетинг-стратегию — не были готовы внедрять',
  },
  {
    id: 'a4_4',
    block: 'A4',
    key: false,
    type: 'text',
    text: 'Образ результата: что будет успехом через 3 месяца? А через год?',
    example: '(год) Кассовый разрыв ≤500 млн, EBITDA 12%, я не в операционке',
  },
  {
    id: 'a4_5',
    block: 'A4',
    key: false,
    type: 'text',
    text: 'Желаемые финансовые показатели — одна амбициозная цифра с горизонтом',
    example: '×2 по выручке за учебный год',
  },
  {
    id: 'a4_6',
    block: 'A4',
    key: false,
    type: 'choice',
    text:
      'Главный приоритет — расставь 1-2-3: скорость роста / максимальная прибыль / минимизация рисков / выход собственника из операционки / доля рынка',
  },
];

/** Единая очередь: минимум, затем расширенная часть. */
export const PROFILE_QUESTIONS: ProfileQuestion[] = [
  ...PROFILE_MIN_QUESTIONS,
  ...PROFILE_EXT_QUESTIONS,
];

export const PROFILE_MIN_COUNT = PROFILE_MIN_QUESTIONS.length;
export const PROFILE_EXT_COUNT = PROFILE_EXT_QUESTIONS.length;
export const PROFILE_TOTAL_COUNT = PROFILE_QUESTIONS.length;

// Варианты ранжирования A4.6 — дословно по вопроснику; порядок фиксирован
// (callback data f0p_prio:{index} указывает в этот массив).
export const PROFILE_PRIORITY_OPTIONS: string[] = [
  'скорость роста',
  'максимальная прибыль',
  'минимизация рисков',
  'выход собственника из операционки',
  'доля рынка',
];

/** Сколько приоритетов надо расставить в A4.6 («расставь 1-2-3»). */
export const PROFILE_PRIORITY_PICKS = 3;

/** Вопрос по индексу единой очереди; undefined — очередь пройдена. */
export function nextProfileQuestion(qIndex: number): ProfileQuestion | undefined {
  return PROFILE_QUESTIONS[qIndex];
}

/** 🔑-минимум собран: A1.1 (название) + A1.2 (суть) (AC1). */
export function isMinimumComplete(profile: ClientProfile): boolean {
  return (
    (profile.companyName ?? '').trim().length > 0 &&
    (profile.businessSummary ?? '').trim().length > 0
  );
}

/**
 * Разбор ответа A3.2 по формату примера: «Имя — должность, полномочия, зона: …».
 * null — не разложился (bot: один переспрос, затем принять как есть: name = ответ).
 */
export function parseTopAnswer(answer: string): ClientTop | null {
  const value = answer.trim();
  if (value.length === 0) return null;
  const dash = value.match(/\s+[—–-]\s+/);
  if (dash === null || dash.index === undefined) return null;
  const name = value.slice(0, dash.index).trim();
  const rest = value.slice(dash.index + dash[0].length).trim();
  if (name.length === 0 || rest.length === 0) return null;
  const segments = rest.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  let title: string | null = null;
  let authority: string | null = null;
  let area: string | null = null;
  const other: string[] = [];
  for (const seg of segments) {
    const areaMatch = seg.match(/^зона(?:\s+ответственности)?\s*:\s*(.+)$/iu);
    if (areaMatch !== null) {
      area = areaMatch[1]!.trim();
    } else if (title === null) {
      title = seg;
    } else {
      other.push(seg);
    }
  }
  if (other.length > 0) authority = other.join(', ');
  return { name, title, authority, area };
}

/** Топ «как есть» после неудачного переспроса: name = весь ответ, остальное null. */
export function topFromRawAnswer(answer: string): ClientTop {
  return { name: answer.trim(), title: null, authority: null, area: null };
}

/**
 * Применяет текстовый ответ к профилю (мутирует). Возвращает true, если поле
 * записано; false — пустой ответ или неизвестный вопрос (очередь не двигать).
 * Вопросы 'tops' и кнопочные ветки A3.3/A4.6 обрабатываются в bot.ts отдельно,
 * но текстовый ответ на a3_3/a4_6 применяется здесь (вопросник: «выбор / текст»).
 */
export function applyProfileAnswer(
  profile: ClientProfile,
  question: ProfileQuestion,
  answer: string,
): boolean {
  const value = answer.trim();
  if (value.length === 0) return false;
  switch (question.id) {
    case 'a1_1':
      profile.companyName = value;
      return true;
    case 'a1_2':
      profile.businessSummary = value;
      return true;
    case 'a1_3':
      profile.history = value;
      return true;
    case 'a1_4':
      profile.owners = value;
      return true;
    case 'a2_1':
      profile.financials = { ...(profile.financials ?? {}) };
      profile.financials.start = { ...(profile.financials.start ?? {}), revenue: value };
      return true;
    case 'a2_2':
      profile.financials = { ...(profile.financials ?? {}) };
      profile.financials.start = { ...(profile.financials.start ?? {}), profitability: value };
      return true;
    case 'a2_3':
      profile.financials = { ...(profile.financials ?? {}) };
      profile.financials.start = { ...(profile.financials.start ?? {}), unitEconomics: value };
      return true;
    case 'a2_4':
      profile.financials = { ...(profile.financials ?? {}) };
      profile.financials.start = { ...(profile.financials.start ?? {}), debts: value };
      return true;
    case 'a2_5':
      profile.headcount = value;
      return true;
    case 'a3_1':
      profile.orgStructure = value;
      return true;
    case 'a3_3':
      profile.decisionMaker = value;
      return true;
    case 'a4_1':
      profile.request = { ...(profile.request ?? {}), problem: value };
      return true;
    case 'a4_2':
      profile.request = { ...(profile.request ?? {}), trigger: value };
      return true;
    case 'a4_3':
      profile.request = { ...(profile.request ?? {}), tried: value };
      return true;
    case 'a4_4':
      profile.request = { ...(profile.request ?? {}), resultImage: value };
      return true;
    case 'a4_5':
      profile.financials = { ...(profile.financials ?? {}), target: value };
      return true;
    case 'a4_6':
      profile.request = { ...(profile.request ?? {}), priorities: [value] };
      return true;
    default:
      return false;
  }
}

/** Вопрос уже отвечен в профиле (для дозаполнения из карточки — не переспрашиваем). */
export function isQuestionAnswered(profile: ClientProfile, question: ProfileQuestion): boolean {
  const filled = (v: string | undefined): boolean => (v ?? '').trim().length > 0;
  switch (question.id) {
    case 'a1_1':
      return filled(profile.companyName);
    case 'a1_2':
      return filled(profile.businessSummary);
    case 'a1_3':
      return filled(profile.history);
    case 'a1_4':
      return filled(profile.owners);
    case 'a2_1':
      return filled(profile.financials?.start?.revenue);
    case 'a2_2':
      return filled(profile.financials?.start?.profitability);
    case 'a2_3':
      return filled(profile.financials?.start?.unitEconomics);
    case 'a2_4':
      return filled(profile.financials?.start?.debts);
    case 'a2_5':
      return filled(profile.headcount);
    case 'a3_1':
      return filled(profile.orgStructure);
    case 'a3_2':
      return (profile.tops ?? []).length > 0;
    case 'a3_3':
      return filled(profile.decisionMaker);
    case 'a4_1':
      return filled(profile.request?.problem);
    case 'a4_2':
      return filled(profile.request?.trigger);
    case 'a4_3':
      return filled(profile.request?.tried);
    case 'a4_4':
      return filled(profile.request?.resultImage);
    case 'a4_5':
      return filled(profile.financials?.target);
    case 'a4_6':
      return (profile.request?.priorities ?? []).length > 0;
    default:
      return false;
  }
}

/** Заполненность расширенной части (счётчик для карточки клиента). */
export function countExtendedFilled(profile: ClientProfile): { filled: number; total: number } {
  const filled = PROFILE_EXT_QUESTIONS.filter((q) => isQuestionAnswered(profile, q)).length;
  return { filled, total: PROFILE_EXT_COUNT };
}

export interface RenderProfileQuestionOpts {
  /** Позиция в своей части: минимум (i/4) или расширенная (i/14) — отдельно. */
  index: number;
  total: number;
  /** Заголовок блока — только при входе в блок (паттерн 8.6). */
  withHeader: boolean;
}

/**
 * Рендер вопроса: заголовок блока (при входе), 🔑-маркировка, прогресс (i/N),
 * пример и подсказка «текстом · /skip» (📎 — только в A3.1; голос появится в 9.5).
 */
export function renderProfileQuestion(
  q: ProfileQuestion,
  opts: RenderProfileQuestionOpts,
): string {
  const lines: string[] = [];
  if (opts.withHeader) lines.push(`📋 ${PROFILE_BLOCK_HEADERS[q.block]}`);
  const keyMark = q.key ? '🔑 ' : '';
  lines.push(`❓ ${keyMark}(${opts.index}/${opts.total}) ${q.text}`);
  if (q.example !== undefined) lines.push(`Пример: «${q.example}»`);
  lines.push(
    q.type === 'file-ok'
      ? 'Ответь текстом · 📎 файлом · 🎤 голосом · /skip — пропустить.'
      : 'Ответь текстом · 🎤 голосом · /skip — пропустить.',
  );
  return lines.join('\n');
}

/** Компактная строка топа для карточки/статуса: «Имя (должность)». */
export function renderTopShort(top: ClientTop): string {
  return top.title !== null && top.title.length > 0 ? `${top.name} (${top.title})` : top.name;
}

/** Компактные строки профиля для карточки клиента (≤3 строки). */
export function renderProfileCardLines(profile: ClientProfile): string[] {
  const lines: string[] = [];
  if ((profile.businessSummary ?? '').length > 0) {
    lines.push(`Суть: ${truncate(profile.businessSummary!, 80)}`);
  }
  const tops = profile.tops ?? [];
  const topsPart =
    tops.length > 0
      ? `Топы: ${tops.slice(0, 3).map(renderTopShort).join(', ')}${tops.length > 3 ? ' …' : ''}`
      : null;
  const dmPart =
    (profile.decisionMaker ?? '').length > 0 ? `DM: ${profile.decisionMaker}` : null;
  if (topsPart !== null || dmPart !== null) {
    lines.push([topsPart, dmPart].filter((p) => p !== null).join(' · '));
  }
  const ext = countExtendedFilled(profile);
  lines.push(
    `Профиль: минимум ${isMinimumComplete(profile) ? '✓' : '—'} · расширенный ${ext.filled}/${ext.total}`,
  );
  return lines;
}

/** Статус профиля для /status во время онбординга (компактно, ≤15 строк). */
export function renderProfileStatusMessage(profile: ClientProfile): string {
  const minAnswered = PROFILE_MIN_QUESTIONS.filter((q) => isQuestionAnswered(profile, q)).length;
  const ext = countExtendedFilled(profile);
  const lines = [
    `👤 Профиль клиента — ${profile.companyName ?? '—'}`,
    `Минимум 🔑: ${minAnswered}/${PROFILE_MIN_COUNT} · расширенный: ${ext.filled}/${ext.total}`,
  ];
  lines.push(...renderProfileCardLines(profile).filter((l) => !l.startsWith('Профиль:')));
  lines.push('Продолжить вопросы — /resume.');
  return lines.join('\n');
}
