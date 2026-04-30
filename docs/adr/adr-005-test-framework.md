# ADR-005: Test framework — vitest

**Date:** 2026-04-22
**Status:** accepted
**Story:** 1.2

## Decision

Использовать **vitest** как test framework для production-кода в `src/`.

## Rationale

- Проект использует ESM (`"type": "module"`, Node16 module resolution). Vitest даёт нативную поддержку ESM без сборки.
- Snapshot API нужен для регрессии парсера на 7 golden transcripts.
- Совместим с jest API → низкий barrier-to-entry.

## Альтернативы

- **node:test** (built-in) — нет snapshot API; неудобно для golden-dataset тестов.
- **jest** — `ts-jest` или сборка; ESM на Node16 modules до сих пор experimental.
