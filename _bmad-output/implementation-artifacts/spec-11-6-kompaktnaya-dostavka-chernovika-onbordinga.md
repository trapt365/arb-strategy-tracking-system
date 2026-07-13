---
title: 'Компактная доставка черновика онбординга — резюме вместо полотна'
type: 'feature'
created: '2026-07-13'
status: 'done'
review_loop_iteration: 0
followup_review_recommended: false
baseline_revision: '91f7e474f977f00d5447de66a2f4a0114005a125'
final_revision: '816dadc47b9dd63bb9d37b12e61ab8412b32025b'
context: []
warnings: []
---

<intent-contract>

## Intent

**Problem:** `renderF0DraftSummaryMessage` выводит до 10 неполных KR построчно (ref + формулировка + причины) в сообщение Telegram. При 20+ незаполненных KR клиент видел «полотно» из перечисленных строк вместо краткого резюме — неинформативно и выглядит как ошибка.

**Approach:** Убрать per-KR строчный перечень из `renderF0DraftSummaryMessage`. Заменить на одну сводную строку с счётчиком. Обновить закрывающую фразу, явно упомянув что детали KR появятся в Google Sheets. Обновить затронутые тесты.

## Boundaries & Constraints

**Always:**
- Счётчик неполных KR в сообщении сохраняется (`🔴 N из M KR неполных`).
- Строка гипотез без метрики остаётся без изменений (она уже компактна — только счётчик).
- Блок «Не распознано» (до 5 строк) остаётся без изменений.
- `renderF0FullDraftMessage` (используется только для smoke/отладки) — не трогать.
- `F0_ISSUE_REASON_LABELS` — не удалять (используется в `renderF0FullDraftMessage` на строке 226).
- `npm test` и `npm run typecheck` зелёные после изменений.

**Block If:** нет.

**Never:**
- Не менять поведение `deliverF0Draft` в `bot.ts` — только рендер-функция.
- Не добавлять ссылку на Google Sheet в draft-сообщение (sheet создаётся только после `/confirm`).
- Не трогать `renderF0FullDraftMessage`, `runF0FullDraft`, типы `F0FullDraftResult`/`RenderF0FullDraftArgs`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| KR неполных > 0 | `krIssues.length = 20, totalKrs = 39` | Сообщение содержит `🔴 20 из 39 KR неполных — дозаполним в диалоге, детали в таблице.` Нет строк с ref/формулировкой/причиной. | — |
| KR неполных = 0, KR есть | `krIssues.length = 0, totalKrs = 5` | Сообщение содержит `✅ Все 5 KR считаемы.` | — |
| KR неполных = 0, KR нет | `totalKrs = 0, objectives.length = 0` | Сообщение содержит `📊 OKR в документах не найдены` | — |
| KR неполных = 13 (было > 10) | `krIssues.length = 13` | Только `🔴 13 из 13 KR неполных — дозаполним в диалоге, детали в таблице.` Нет overflow-строки «и ещё N» для KR. | — |

</intent-contract>

## Code Map

- `src/f0-onboarding.ts:326-335` — `renderF0DraftSummaryMessage`: блок вывода неполных KR (for-loop + overflow). Основное изменение.
- `src/f0-onboarding.ts:358-360` — `renderF0DraftSummaryMessage`: закрывающие строки. Обновить формулировку.
- `src/f0-onboarding.test.ts:158-220` — describe `renderF0DraftSummaryMessage (Story 8.3, W4)`: 2 теста требуют обновления.
- `src/bot.test.ts:1575-1589` — тест W4 compact delivery: проверяет только counts + `/confirm` + no `база:` — остаётся без изменений.

## Tasks & Acceptance

**Execution:**

- `src/f0-onboarding.ts` — в `renderF0DraftSummaryMessage` заменить блок KR issues (lines ~326–335). Было:
  ```typescript
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
  ```
  Стало:
  ```typescript
  if (krIssues.length > 0) {
    lines.push(`🔴 ${krIssues.length} из ${totalKrs} KR неполных — дозаполним в диалоге, детали в таблице.`);
  } else if (totalKrs > 0) {
    lines.push(`✅ Все ${totalKrs} KR считаемы.`);
  }
  ```

- `src/f0-onboarding.ts` — обновить закрывающую строку (lines ~359). Было:
  `'Полные таблицы (OKR, гипотезы, участники) будут в Google Sheets клиента после /confirm — пришлю ссылку.'`
  Стало:
  `'Полные таблицы (OKR, гипотезы, участники) и список неполных KR — в Google Sheets клиента после /confirm, пришлю ссылку.'`

- `src/f0-onboarding.test.ts` — обновить describe `renderF0DraftSummaryMessage (Story 8.3, W4)` → `renderF0DraftSummaryMessage (Story 8.3, W4; Story 11.6)`. Обновить два теста:
  1. Тест «компактно: счётчики + 🔴-блоки…» (line ~171): заменить `expect(msg).toContain('🔴 Неполные KR — 1 из 2')` на `expect(msg).toContain('🔴 1 из 2 KR неполных')`. Добавить: `expect(msg).not.toContain('O1.2');` (убедиться что ref KR не попадает в сообщение).
  2. Тест «🔴 KR обрезаются до 10…» (line ~201): переименовать в «🔴 KR — только счётчик, нет overflow-строки для KR»; заменить `expect(msg).toContain('🔴 Неполные KR — 13 из 13')` на `expect(msg).toContain('🔴 13 из 13 KR неполных')`; удалить `expect(msg).toContain('… и ещё 3')` (было KR overflow); удалить `expect(msg).not.toContain('KR номер 11')` (больше нет per-item списка). Оставить `expect(msg).toContain('… и ещё 2')` (это overflow для unrecognized — он остаётся).

**Acceptance Criteria:**

- Given `krIssues.length = 5, totalKrs = 12`, when `renderF0DraftSummaryMessage` вызвана, then сообщение содержит строку `🔴 5 из 12 KR неполных — дозаполним в диалоге, детали в таблице.` и не содержит ни одной строки формата `– O*.* «…»:`.

- Given `krIssues.length = 20`, when `renderF0DraftSummaryMessage` вызвана, then сообщение НЕ содержит строки `… и ещё` рядом с KR (overflow-перечня нет — перечня вообще нет).

- Given `krIssues.length = 0, totalKrs = 5`, when `renderF0DraftSummaryMessage` вызвана, then сообщение содержит `✅ Все 5 KR считаемы.`

- Given изменения применены, when `npm test` запущен, then все тесты проходят.

- Given изменения применены, when `npm run typecheck` запущен, then нет TypeScript ошибок.

## Design Notes

`F0_ISSUE_REASON_LABELS` остаётся в файле — используется в `renderF0FullDraftMessage` (line 226). Удалять не нужно.

Строка для `unrecognized` (❓) остаётся без изменений — она уже ограничена 5 строками и не упоминалась как проблема в правках.

Пример нового формата при 20 неполных KR из 39:
```
🆕 Черновик онбординга — Ромашка
Источник: strategy.md

Извлечено: цели 7 · KR 39 · гипотезы 32 · участники 8

🔴 20 из 39 KR неполных — дозаполним в диалоге, детали в таблице.
🔴 Гипотезы без метрики — 5 из 32: H1, H3, H7, H12, H18 (спрошу в диалоге).

Полные таблицы (OKR, гипотезы, участники) и список неполных KR — в Google Sheets клиента после /confirm, пришлю ссылку.
Черновик сохранён (a1b2c3d4).
```

## Verification

**Commands:**
- `npm test` — expected: все тесты зелёные, включая обновлённый describe `renderF0DraftSummaryMessage`
- `npm run typecheck` — expected: нет ошибок TypeScript

## Auto Run Result

**Summary:** Реализован P2-фич: `renderF0DraftSummaryMessage` больше не перечисляет неполные KR построчно. Вместо до 10 строк с ref/формулировкой/причинами — одна сводная строка `🔴 N из M KR неполных — дозаполним в диалоге, детали в таблице.` Footer сделан условным: упоминание "и список неполных KR" появляется только когда `krIssues.length > 0`. Добавлен тест для матричного row "все KR считаемы".

**Files changed:**
- `src/f0-onboarding.ts` — `renderF0DraftSummaryMessage`: per-KR for-loop удалён, заменён одной summary-строкой; footer стал условным + punctuation fix (запятая → em-dash)
- `src/f0-onboarding.test.ts` — describe переименован (Story 11.6); обновлены 2 теста + добавлены assertions для footer; новый тест "все KR считаемы"; новый тест "KR — только счётчик" с regression guards

**Review findings breakdown:**
- Patches applied: 4 (footer conditionality; em-dash punctuation fix; regression guard для per-KR items; footer text assertions в тестах)
- Items deferred: 2 (number-agreement "Все 1 KR"; broad `not.toContain('🔴')` assertion)
- Items rejected: 9

**Verification:**
- `npm run typecheck` → EXIT:0, нет ошибок TypeScript
- `npm test` → EXIT:0, 764/764 тестов (было 763 на baseline; +1 нетто: новый тест "все KR считаемы")

**Residual risks:**
- `renderF0FullDraftMessage` (smoke/debug renderer) не изменён — при анализе продовых сообщений важно помнить что compact-delivery использует `renderF0DraftSummaryMessage`

## Spec Change Log

## Review Triage Log

### 2026-07-13 — Review pass 1

- intent_gap: 0
- bad_spec: 0
- patch: 4: (high 0, medium 0, low 4)
- defer: 2: (high 0, medium 0, low 2)
- reject: 9
- addressed_findings:
  - `[low]` `[patch]` Overflow-тест: добавлен `expect(msg).not.toContain('KR номер 1')` как regression guard против случайного возврата per-KR loop
  - `[low]` `[patch]` Footer "и список неполных KR" сделан условным (`krIssues.length > 0`); запятая заменена на em-dash для соответствия стилю кода
  - `[low]` `[patch]` Добавлен `expect(msg).toContain('список неполных KR')` в overflow-тест (krIssues > 0) — верифицирует обновление footer
  - `[low]` `[patch]` Добавлен `expect(msg).not.toContain('список неполных KR')` в тест "все KR считаемы" — верифицирует что footer чист при отсутствии issues
