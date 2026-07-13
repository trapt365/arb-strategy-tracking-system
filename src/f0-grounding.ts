// Story 9.2 (WP-39 Ф2): grounding — профиль клиента как единственный источник имён.
// Чистые функции без I/O. Сверка имён: точное (case-insensitive + trim), затем
// fuzzy по подмножеству токенов (ревью эпика 9: «Петров» ⊂ «Иван Петров»).
// Неоднозначность (2+ топа-кандидата, напр. однофамильцы) → 🔴 (нужен человек).

import type { ClientTop } from './types.js';
import type { F0FullExtraction } from './types.js';

type Row = Record<string, string>;

export interface GroundOwnerResult {
  name: string;
  matched: boolean;
}

function nameTokens(name: string): string[] {
  return name
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Сверяет извлечённое имя с профильными топами.
 * 1) Точное совпадение (case-insensitive + trim) — приоритет.
 * 2) Ревью эпика 9: fuzzy по подмножеству токенов — «Петров» ⊂ «Иван Петров»
 *    (импорт xlsx часто содержит только фамилию). Принимаем ТОЛЬКО единственного
 *    кандидата: если под fuzzy подходит 2+ топа (однофамильцы) — неоднозначно → 🔴.
 * Возвращает {name: канонический из профиля, matched: true} или {name: extracted, matched: false}.
 */
export function groundOwnerName(extracted: string, tops: ClientTop[]): GroundOwnerResult {
  const normalised = extracted.trim().toLowerCase();
  for (const top of tops) {
    if (top.name.trim().toLowerCase() === normalised) {
      return { name: top.name, matched: true };
    }
  }
  const extractedTokens = nameTokens(extracted);
  if (extractedTokens.length === 0) return { name: extracted, matched: false };
  const fuzzy = tops.filter((top) => {
    const topTokens = nameTokens(top.name);
    if (topTokens.length === 0) return false;
    const extractedSubsetOfTop = extractedTokens.every((t) => topTokens.includes(t));
    const topSubsetOfExtracted = topTokens.every((t) => extractedTokens.includes(t));
    return extractedSubsetOfTop || topSubsetOfExtracted;
  });
  if (fuzzy.length === 1) {
    return { name: fuzzy[0]!.name, matched: true };
  }
  return { name: extracted, matched: false };
}

/**
 * Применяет grounding к массиву OKR-строк.
 * Если tops передан: owner каждой строки проверяется — совпадение → канонический из профиля;
 * несовпадение → «🔴 <extracted>».
 * Если tops не передан или пустой — возвращает строки без изменений (old sessions).
 */
export function groundedOkrRows(rows: Row[], tops?: ClientTop[]): Row[] {
  if (!tops || tops.length === 0) return rows;
  return rows.map((row) => {
    const owner = (row.owner ?? '').trim();
    if (owner.length === 0 || owner === '—') return row;
    const result = groundOwnerName(owner, tops);
    if (result.matched) {
      return { ...row, owner: result.name };
    }
    return { ...row, owner: `🔴 ${owner}` };
  });
}

/**
 * Строит список стейкхолдеров с grounding-приоритетом:
 * если tops передан — профильные топы идут первыми, затем участники из extraction,
 * которых нет в профиле (дедупликация по нормализованному имени).
 * Если tops не передан — возвращает participants без изменений (old sessions).
 */
export function groundedStakeholderRows(
  extraction: Pick<F0FullExtraction, 'participants'>,
  tops?: ClientTop[],
): Array<{ name: string; role: string | null; department: string | null; contact: string | null }> {
  if (!tops || tops.length === 0) return extraction.participants;

  // Ревью эпика 9: пополевый merge, а не замена целиком. Профиль побеждает только
  // непустыми полями; role/department/contact, собранные из документов и диалога
  // дозаполнения (gap participant_contact), сохраняются, если у топа поле пустое.
  const profileRows = tops.map((t) => {
    const match = extraction.participants.find((p) => groundOwnerName(p.name, [t]).matched);
    return {
      name: t.name,
      role: t.title ?? match?.role ?? null,
      department: t.area ?? match?.department ?? null,
      contact: match?.contact ?? null,
    };
  });

  // Участники extraction, не совпавшие ни с одним топом (точно или fuzzy).
  const extraRows = extraction.participants.filter(
    (p) => !tops.some((t) => groundOwnerName(p.name, [t]).matched),
  );

  return [...profileRows, ...extraRows];
}

/**
 * Формирует многострочный список топов для промпта F0-извлечения.
 * Пустой массив → пустая строка (промпт видит пустую секцию, нейтрален).
 */
export function profileTopsContext(tops: ClientTop[]): string {
  if (tops.length === 0) return '';
  return tops
    .map((t) => `- ${t.name} (${t.title ?? '—'}, зона: ${t.area ?? '—'})`)
    .join('\n');
}

/**
 * Возвращает канонические имена топов из профиля — используется как extraOwners
 * для ensurePersonalSheets.
 */
export function profileTopNames(tops: ClientTop[]): string[] {
  return tops.map((t) => t.name);
}

// Story 10.3: флаг смешения клиентов — сравнение названия компании из LLM-извлечения
// с профилем трекера. Чистая функция без I/O.

export interface CompanyMismatch {
  extracted: string;
  profile: string;
}

/**
 * Сравнивает извлечённое название компании с профильным.
 * Возвращает null, если:
 *   - extractedCompany === null
 *   - profileCompanyName отсутствует / пустая строка
 *   - нормализованные значения (trim + toLowerCase) совпадают
 * Иначе возвращает { extracted, profile } с оригинальными значениями (для UX-текста).
 */
export function detectCompanyMismatch(
  extractedCompany: string | null,
  profileCompanyName: string | undefined,
): CompanyMismatch | null {
  if (extractedCompany === null) return null;
  const extractedTrimmed = extractedCompany.trim();
  if (extractedTrimmed.length === 0) return null;
  if (profileCompanyName === undefined || profileCompanyName === null) return null;
  const profileTrimmed = profileCompanyName.trim();
  if (profileTrimmed.length === 0) return null;
  if (extractedTrimmed.toLowerCase() === profileTrimmed.toLowerCase()) return null;
  return { extracted: extractedCompany, profile: profileCompanyName };
}
