// Story 9.2 (WP-39 Ф2): grounding — профиль клиента как единственный источник имён.
// Чистые функции без I/O. Сверка имён: case-insensitive + trim, без fuzzy-match.
// Намеренно: лучше увидеть 🔴 и исправить, чем молчаливо разрешить неоднозначное.

import type { ClientTop } from './types.js';
import type { F0FullExtraction } from './types.js';

type Row = Record<string, string>;

export interface GroundOwnerResult {
  name: string;
  matched: boolean;
}

/**
 * Сверяет извлечённое имя с профильными топами (case-insensitive + trim).
 * Возвращает {name: канонический из профиля, matched: true} или {name: extracted, matched: false}.
 */
export function groundOwnerName(extracted: string, tops: ClientTop[]): GroundOwnerResult {
  const normalised = extracted.trim().toLowerCase();
  for (const top of tops) {
    if (top.name.trim().toLowerCase() === normalised) {
      return { name: top.name, matched: true };
    }
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
    if (owner.length === 0) return row;
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

  const profileRows = tops.map((t) => ({
    name: t.name,
    role: t.title ?? null,
    department: t.area ?? null,
    contact: null as string | null,
  }));

  const seenNormalised = new Set(tops.map((t) => t.name.trim().toLowerCase()));

  const extraRows = extraction.participants.filter(
    (p) => !seenNormalised.has(p.name.trim().toLowerCase()),
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
