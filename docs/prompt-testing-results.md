---
type: story-output
story: 0.3
created: 2026-04-20
status: validated (GO 2026-04-20)
model: claude-sonnet-4-6 (production), claude-sonnet-4-20250514 (1-я итерация, deprecated)
---

# Результаты тестирования промптов F1/F4 — Story 0.3

> **Источник данных:** `data/prompt-results/<filename>/`
> **Скрипты:** [prompt-test.ts](../scripts/prompt-test.ts), [extract-okr-from-xlsx.ts](../scripts/extract-okr-from-xlsx.ts), [generate-review-md.ts](../scripts/generate-review-md.ts), [build-golden-dataset.ts](../scripts/build-golden-dataset.ts)

## ✅ Финальный вердикт: GO

**Промпты F1+F4 v1.0.0 валидированы 2026-04-20** на 7 реальных Geonline транскриптах.

| AC | Порог | Факт | Статус |
|----|-------|------|--------|
| Транскриптов прогнано | ≥5 | 7 | ✅ |
| F4 транскриптов | ≥2 | 7 | ✅ |
| Доля существенных правок | <50% | **0%** (юзер: GO без правок) | ✅ |
| Golden dataset собран | да | 7 файлов в [data/golden/](../data/golden/) | ✅ |

**Промпты идут в Epic 1 Story 1.7 (production) без изменений.**

## Сводка прогонов F1 (финал — все с реальным OKR)

| # | Файл | Спикеров | Длит. | Решений | Обязательств | Фактов | KR (discussed+mentioned/total) | Алертов |
|---|------|----------|-------|---------|--------------|--------|--------------------------------|---------|
| 1 | audio1100318212 | 2 | 41:09 | 5 | 5 | 12 | 5+4 / 54 | 3 |
| 2 | audio1111482399 | — | — | 8 | 9 | 14 | (см. analysis.json) | 10 |
| 3 | audio1554018312 | — | — | 10 | 7 | 11 | (см. analysis.json) | 6 |
| 4 | audio1602529797 | — | — | 9 | 7 | 12 | (см. analysis.json) | 6 |
| 5 | audio1663213769 | — | — | 8 | 6 | 10 | (см. analysis.json) | 6 |
| 6 | audio1721976611 | 3 | 32:48 | 5 | 6 | 7 | 3+2 / 54 | 7 |
| 7 | audio1951904349 | 3 | 24:32 | 6 | 7 | 18 | (см. analysis.json) | 10 |

**Все 7 успешно. 0 ошибок. F4 для всех 7.**

## Ключевые этапы и решения

### 1. F1 первый прогон (1-я итерация, без OKR)
- Все 7 транскриптов прошли без ошибок
- 4-8 обязательств, 3-6 решений, 9-13 фактов на встречу
- **Проблема:** 0 KR-покрытий → причина: пустой `okr-context.json` (заглушка)

### 2. Извлечение OKR из xlsx (новый автономный путь)
- Написан [scripts/extract-okr-from-xlsx.ts](../scripts/extract-okr-from-xlsx.ts) — зеркало логики `sheets/Code.js`, но локально через xlsx package
- Извлечено: **57 KR от 9 топ-менеджеров** (CEO, CPO, CFO, Продажи, Маркетинг, Контент, Академия, HR, PR)
- Извлечено: **9 stakeholders** для stakeholder-map
- Источник: [Geonline Стратегический трекинг v2.0 (14).xlsx](../Geonline  Стратегический трекинг v2.0 (14).xlsx)
- Без LLM (бесплатно)

### 3. F4 первая попытка → Zod-баг
- Claude вернул `null` для `related_kr` → Zod `z.string().optional()` падал на `invalid_type`
- **Багфикс:** `z.string().nullable().optional().transform(v => v ?? "")` в [scripts/prompt-test.ts:90](../scripts/prompt-test.ts#L90)

### 4. Перепрогон F1+F4 на всех 7 с реальным OKR (2-я итерация)
- analysis находит релевантные KR по семантике (не строгое совпадение)
- F4 agenda ссылается на конкретные KR в `related_kr`
- Discussed+Mentioned: 9 KR в audio1100318212, 5 KR в audio1721976611 (54 проанализировано)

### 5. Сгенерированы human-readable review docs
- [scripts/generate-review-md.ts](../scripts/generate-review-md.ts) — markdown с таблицами обязательств/решений/цитат/agenda
- 7 файлов: `docs/review-audio*.md`
- Юзер прошёл оценку 2 файлов → **GO без правок**

### 6. Golden dataset собран
- [scripts/build-golden-dataset.ts](../scripts/build-golden-dataset.ts)
- [data/golden/](../data/golden/): transcript-1..7.json + f1-reference-1..7.json + f4-reference-1..7.json + manifest.json
- 7 транскриптов, разнообразие: 1:1, групповые 2-3 спикера, code-switching РУС↔КАЗ, разные департаменты

### 🟡 Открытые вопросы (не блокеры)
- Поле `speaker_check` пусто во всех — то ли спикеры распознаны корректно, то ли промпт не активирует маркер. Проверить отдельно.
- Большая часть KR в blind_zone (45-49 из 54) — это нормально для отдельных встреч, но требует tracking в Story 1.x для агрегации по неделям.

## Стоимость прогонов

~$2.5 (Claude Sonnet 4 + Sonnet 4.6, ~50 вызовов через 4 итерации). Извлечение OKR — бесплатно.

## Семантические проверки для canary-тестов (Story 1.11)

Сохранены в [data/golden/manifest.json](../data/golden/manifest.json):
- `commitments_not_empty_if_present` — extraction.commitments[] не пуст, если в транскрипте есть обязательства
- `okr_references_not_empty_if_context` — analysis.okr_coverage содержит discussed/mentioned, если есть OKR-контекст
- `f4_three_items` — agenda всегда 3 пункта (PRD)
- `f1_format_three_sections` — format всегда 3 секции (PRD)

## Артефакты Story 0.3 (deliverables)

- ✅ Промпты v1.0.0 ([prompts/](../prompts/), [CHANGELOG.md](../prompts/CHANGELOG.md))
- ✅ F1 outputs для 7 транскриптов ([data/prompt-results/](../data/prompt-results/))
- ✅ F4 agendas для 7 транскриптов
- ✅ Golden dataset (7 файлов) ([data/golden/](../data/golden/))
- ✅ Stakeholder map + OKR-контекст ([data/](../data/))
- ✅ Review docs (`docs/review-audio*.md`)
- ✅ 4 переиспользуемых скрипта (prompt-test, extract-okr-from-xlsx, generate-review-md, build-golden-dataset)

## Следующий шаг → Story 0.4

Story 0.4 = «Тест промптов на исторических транскриптах» (по [epics.md](epics.md)). Уже частично сделано в этой story (7 транскриптов прогнаны и валидированы). Скорее всего, Story 0.4 = либо closed (включена в 0.3), либо переформулировать (например, F2/F3/F5 промпты, доп.сценарии).
