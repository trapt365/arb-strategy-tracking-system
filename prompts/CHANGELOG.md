# Prompt Changelog

## v1.4.1 — 2026-07-08 (Story 8.2, Epic 8)

- Аудит W8 (нейтральный бренд): имя топа Geonline в примерах заменено на нейтральное — `analysis.md` (`"who": "Алия"`), `format-tracker.md` (`top_message_draft`). Это shape-примеры JSON-выхода, семантика инструкций не менялась.
- `f0-full-extraction.md`: упоминание «GeOnline BSC-версии» → нейтральное «BSC-версии стратегий» (описание формата, не привязка к клиенту).
- Исторические упоминания GeOnline в этом changelog не трогаем — это летопись, не runtime-текст.

## v1.4.0 — 2026-07-07 (Story 7.2, WP-39 Ф2)

- `f0-full-extraction.md` v0.1 — полное извлечение пакета артефактов: панель OKR + **банк гипотез** (ЕСЛИ-ТО-ПОТОМУ ЧТО + метрика проверки, инвариант 2) + **участники**. Template variable `{{documentText}}` (конкатенация нескольких файлов с маркерами `===== Файл: … =====`).
- Инвариант 2: метрика гипотезы обязательна; нет в документе → `metric: null` (бот пометит 🔴), не выдумывается.
- Синтез: документ без явных гипотез (протокол в стиле SAM — решения D/инициативы/action items) → кандидаты в гипотезы выводятся с `synthesized: true` («требует подтверждения трекером»). Few-shot синтез-кейса внутри промпта.
- `document_type: 'strategy' | 'other'`. Инвариант 3 «не выдумывать» и особенности форматов (RU/KZ, эмодзи-статусы, даты как есть).
- **Удалён `f0-okr-extraction.md` (7.1):** full-извлечение строго покрывает OKR-only, а бот после 7.2 использует только его. Прежний промпт остался бы дубль-контрактом (расхождение уже началось на `document_type` okr vs strategy). Убрали при code-review 7.2, чтобы не тащить двойную поддержку. История — в git.

## v1.3.0 — 2026-07-07 (Story 7.1, WP-39 Ф2)

- `f0-okr-extraction.md` v0.1 — новый промпт F0-онбординга: документ стратегии → панель OKR (objectives → KR: formulation/base/target/owner/deadline). Template variable `{{documentText}}`.
- Зашиты инварианты WP-39: «не выдумывать» (отсутствующее → `null`, сомнительное → `unrecognized[]`), запрет подстановки значений из аудит-колонок «Как улучшить», `document_type: 'other'` для не-OKR файлов.
- Учтены особенности реальных артефактов (эталон GeOnline OKR Framework 2026): rowspan-паттерн таблиц (Objective в первой строке группы), RU/KZ code-switching в формулировках, разноформатные сроки как есть («До 30.07.2026», «Постоянно», «Q1 2026»).
- Inline few-shot пример (положительный + null-кейсы) внутри промпта; отдельные файлы в `examples/` не создавались — извлечение одношаговое.
- Существующие промпты F1 — без изменений.

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
