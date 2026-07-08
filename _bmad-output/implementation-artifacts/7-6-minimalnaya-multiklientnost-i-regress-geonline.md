# Story 7.6: Минимальная мультиклиентность и регресс Geonline

Status: done  # 2026-07-08: код + юнит-тесты + code-review-фиксы (ops-log fallback на geonline при отсутствии _ops_logs у клиента, per-entry registry parse, кросс-сессионный reuse таблицы, показ clientId-слага). Регресс Geonline зелёный (canary+golden). 502/502 vitest, tsc чист.

> Epic 7 (WP-39 Ф2), лёгкий формат. Завершает эпик: реестр клиентов вместо хардкода Geonline.

## Пользовательская история

Как **аналитик практики (Тимур)**,
я хочу **реестр клиентов вместо хардкода Geonline**,
чтобы **F1 работал для 2+ клиентов одного трекера, а Geonline продолжал работать как раньше**.

## Контекст и границы scope

Расшивка хардкода `'geonline'`: реестр `data/clients/registry.json` (clientId→{sheetId,name,topName}). `resolveSheetId` резолвит по реестру; Geonline работает через fallback на `config.GEONLINE_F0_SHEET_ID` (обратная совместимость, БЕЗ правок env вида `GEONLINE_*`). Онбординг (7.4/7.5) наполняет реестр. `/report` резолвит клиента; ops-лог пишется в таблицу своего клиента.

**В scope:**
- Модуль `src/client-registry.ts`: `loadRegistry` (Zod, {} если нет/битый), `getClientSheetId` (реестр → geonline fallback на config → undefined), `getClientTopName`, `listClientIds` (+ geonline), `upsertClient` (atomic, сохраняет `createdAt` первой регистрации).
- Типы `ClientRegistrySchema`/`ClientRegistryEntrySchema` (types.ts).
- `src/adapters/sheets.ts`: `resolveSheetId` → **async**, через реестр (2 вызова в `readClientContext`/`appendOpsLog` получили `await`); убран прямой хардкод `!== 'geonline'` и импорт config.
- Бот: `/report <url> [clientId]` — второй токен выбирает клиента (валидация по `listClientIds`, дефолт geonline); `topName` из реестра (fallback `DEFAULT_TOP_NAME`); ops-writer пишет `appendOpsLog(row, row.clientId)`; `finalizeClientCard` (7.5) вызывает `upsertClient(clientId, {sheetId: spreadsheetId, name, topName: ceo})`.

**Вне scope:** UI выбора клиента (аргумент команды достаточно для 1 трекера/2 клиентов); миграция существующих env; удаление `DEFAULT_CLIENT_ID`/`DEFAULT_TOP_NAME` (оставлены дефолтами обратной совместимости).

## Acceptance Criteria

1. **Given** 2 клиента (Geonline + пилот в реестре), **when** трекер запускает `/report <url> [clientId]`, **then** клиент резолвится (аргумент/дефолт geonline, не из хардкода), `resolveSheetId` работает по реестру clientId→sheetId, `appendOpsLog` пишет в таблицу своего клиента (`row.clientId`).
2. **Given** существующий пилот Geonline, **when** мультиклиентность включена, **then** регресс не сломан: `resolveSheetId('geonline')` === `GEONLINE_F0_SHEET_ID`, полный F1-цикл Geonline проходит как раньше (canary + golden + весь vitest зелёные).
3. **Given** новый клиент добавлен онбордингом, **when** таблица создана, **then** реестр пополняется (`upsertClient`) без правок кода и env-переменных `GEONLINE_*`.

## Задачи

1. Типы `ClientRegistry*` (types.ts).
2. Модуль `src/client-registry.ts` — юнит-тесты.
3. `resolveSheetId` async + реестр; `await` в вызовах; убрать мёртвый импорт config.
4. Бот: `/report` clientId-аргумент + topName из реестра; ops-writer по `row.clientId`; регистрация клиента в `finalizeClientCard`.
5. Тесты: registry load/upsert/getSheetId(geonline=config/new=registry/unknown=undefined)/topName/listIds/createdAt-preserve/битый JSON; регресс — весь существующий suite зелёный.

## Definition of Done

- AC1/AC3 юнитами (реестр + резолв); AC2 регрессом (весь vitest, canary+golden зелёные, `resolveSheetId('geonline')`==config).
- tsc чист; client isolation (NFR6) — пути `data/{clientId}` не пересекаются.
- Не коммичено — рабочее дерево оставлено Тимуру на проверку.
