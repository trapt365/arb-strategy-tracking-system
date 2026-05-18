# Prompt Changelog

## v1.2.0 — 2026-04-30 (Story 1.4b)

- `format-tracker.md`: добавлены template variables `{{topName}}`, `{{department}}`, `{{weekNumber}}` (контекст встречи в шапке) — для seamless integration с `formatHeader()` (Story 1.5 bot.ts).
- `format-tracker.md`: добавлены входные блоки `{{commitmentsBefore}}` (open commitments из 1.4a) и `{{alerts}}` (analysis.alerts) — промпт разделяет «новые» обязательства от «продолжающихся» и формирует Section 3 ТОЛЬКО при наличии алертов.
- `format-tracker.md`: добавлено опциональное поле `top_message_draft` в JSON-output — 3-5 строк draft для копирования трекером в WhatsApp топу (UX-DR4 + UX spec line 99 «📱 Для топа»).
- `format-tracker.md`: расширен лимит `summary_line` до 200 chars (было 100).
- `format-tracker.md`: явные правила для казахских цитат — `[KK]` дословно, `[KK/RU]` для code-switching (FR44, NFR71).
- **Backward compatibility:** Существующие golden reference outputs (если есть) могут не пройти Zod validation на новые поля → safeParse в Story 1.4b обеспечивает graceful fallback (partial result).

## v1.1.0 — 2026-04-30 (Story 1.4a)

- `analysis.md`: добавлена переменная `{{openCommitments}}` для cross-session accountability.
- `analysis.md`: добавлено поле `commitments_status_updates` в JSON-output (статусы `open` / `completed` / `overdue` + `evidence_quote`).
- `analysis.md`: добавлено правило в alerts — пометка цитат с `approximate: true` и просроченных commitments из прошлых встреч.
- **Backward compatibility:** старые F1 reference outputs в `data/golden/` НЕ содержат `commitments_status_updates` — Zod default `[]` совместим. Canary diff (Story 1.11) ожидаемо покажет небольшие изменения в analysis output из-за нового блока.
- `extraction.md` — без изменений (остаётся v1.0.0).

## v1.0.0 — 2026-04-20 (validated)

**Story 0.3 Задача 3.4:** Промпты прошли validation на 7 реальных Geonline транскриптах. Юзер: GO без правок (0% существенных правок, порог < 50%). Промпты идут в Epic 1 Story 1.7 (production).

Без изменений по сравнению с v0.1.0 (промпты сразу попали в порог).

## v0.1.0 — 2026-04-18

- Создание начальных версий промптов:
  - `extraction.md` v0.1 — извлечение фактов, решений, цитат, обязательств
  - `analysis.md` v0.1 — OKR-покрытие, статус гипотез, алерты
  - `format-tracker.md` v0.1 — форматирование отчёта для трекера
  - `agenda.md` v0.1 — F4 повестка к встрече
- Создание few-shot примеров:
  - `examples/commitments-positive.md` — 4 примера правильных обязательств
  - `examples/commitments-negative.md` — 6 граничных случаев (5 не-обязательств + 1 code-switching)
