# Story 1.4b: F1 форматирование и подготовка к доставке (шаги 3-4)

Status: done

## Пользовательская история

Как **коуч практики (Азиза)**,
Я хочу **получить отформатированный сканируемый отчёт по встрече, готовый к двухшаговому approve в Telegram**,
Чтобы **за < 2 минут проверить и одобрить отчёт без ручного переписывания, а при сбое форматирования получить сырые данные извлечения вместо «тишины»**.

## Контекст и границы scope

**Что входит в Story 1.4b (production-код в `src/`):**

- `src/f1-report.ts` — расширение существующего файла (Story 1.4a):
  - Новая функция `runF1Steps34({ extraction, analysis, openCommitmentsBefore, meta, deps })` → `{ formattedReport: FormattedReport | null, partial: boolean, partialReason?, rawResponses: { format }, durationsMs, tokens }`. Шаг 3 — formatting через Claude (промпт `format-tracker.md`). Шаг 4 — delivery prep (структура `DeliveryReadyReport`, готовая для `bot.ts` Story 1.5).
  - Новая orchestrator-функция `runF1({ transcript, clientContext, meta, deps })` → объединяет 1-2 + 3-4. Возвращает `RunF1Result = RunF1Steps12Result & { formattedReport, partial, partialReason }`.
  - `runF1Steps12` остаётся неизменной (контракт зафиксирован 1.4a — review). 3-4 строится поверх результата 1-2.
- `src/types.ts` — новые Zod-схемы:
  - `FormatSectionSchema` — `{ title: string, content: string }`.
  - `FormatOutputSchema` — `{ report_sections: FormatSection[1..3], summary_line: string (≤ 200 chars), commitment_count: number, alert_count: number, top_message_draft: string (опционально, 3-5 строк для копирования в WhatsApp) }`.
  - `DeliveryReadyReportSchema` — финальный объект для bot.ts: `{ reportId, clientId, topName, meetingDate, header, summaryLine, sections: [...], commitments: Commitment[], alerts: string[], topMessageDraft?, partial: false }` (полный) ИЛИ `{ ...meta, partial: true, partialReason, extractionFallback: { commitments, citations, decisions, facts } }` (graceful degradation).
- `src/adapters/claude.ts` — расширение существующего:
  - Новый non-throwing вариант `callClaudeSafe<T>(prompt, opts) → { raw, parsed: T | null, validationErrors?: ZodIssue[], usage }`. Реализация: внутри callClaude добавить опцию `safeParse?: boolean`. Если `safeParse === true` — на Zod-failure вернуть `{ raw, parsed: null, validationErrors: zodError.issues, usage }` ВМЕСТО throw. JSON.parse-failure всё равно throws (это сломанный response, не схема-mismatch). Network/HTTP errors — поведение без изменений (throw F1PipelineError('claude_api')). На retry-исчерпании — throw (caller получит partial result через свой try/catch, см. AC #5).
- `src/errors.ts` — расширение `F1PipelineCode`:
  - Добавить коды: `format_partial` (informational, не throw — обёрнут в meta.json для аудита), `format_validation_failed` (Zod safeParse fail после успешного Claude call), `delivery_prep` (если безопасное построение `DeliveryReadyReport` упало — например, на required field у extraction).
- `prompts/format-tracker.md` — обновить до v1.2.0:
  - Добавить новые template variables: `{{topName}}`, `{{department}}`, `{{weekNumber}}` (для шапки/header — но сам header формирует bot.ts через `formatHeader()`, **не промпт**). Промпт получает контекст для генерации правильного `summary_line`.
  - Добавить вход `{{commitmentsBefore}}` (open commitments из 1.4a) — чтобы промпт мог выделить «продолжающиеся» обязательства от «новых».
  - Добавить вход `{{alerts}}` (analysis.alerts) — чтобы Section 3 включала только реальные алерты.
  - Добавить новое поле в JSON-output: `top_message_draft` — 3-5 строк для копирования трекером в WhatsApp/Telegram топу (UX-DR4 + UX spec line 99 «Секция 📱 для топа»). Это **draft текста, который трекер скопирует**, не финальное сообщение клиенту. На MVP — опциональное поле (фронт-section в Telegram-отчёте Story 1.5).
  - Russian-only output. Казахские цитаты в оригинале с пометкой `[KK]` (FR44, NFR71).
- `prompts/CHANGELOG.md` — bump v1.1.0 → v1.2.0 + описание изменений в format-tracker.md.
- Persistence (продолжение Day-1 fix #5):
  - `data/{clientId}/{YYYY-MM-DD}/f1-{topNameSlug}-{shortId}.format.raw.txt` — raw Claude output (даже при safeParse fail).
  - `data/{clientId}/{YYYY-MM-DD}/f1-{topNameSlug}-{shortId}.format.json` — `FormatOutput` parsed (только при success).
  - `data/{clientId}/{YYYY-MM-DD}/f1-{topNameSlug}-{shortId}.report.json` — финальный `DeliveryReadyReport` (что уйдёт в bot.ts). Записывается даже при `partial: true` (с extractionFallback).
  - `data/{clientId}/{YYYY-MM-DD}/f1-{topNameSlug}-{shortId}.commitments-updates.json` — overlay-файл со списком `commitments_status_updates` из analysis (Story 1.4a возвращает это поле, но на 1.4a НЕ записывается). На 1.4b — append-only side-overlay; **исходные `*.extraction.json` НЕ модифицируются** (immutable, append-only backup; полный persistence-слой commitments — Story 1.10). `loadOpenCommitments` (1.4a) при чтении прошлых extraction'ов **не обращает внимание** на эти overlay-файлы — то есть статус-апдейты на 1.4b пока не влияют на следующий запуск (это будет интегрировано в Story 1.10). Значит на 1.4b overlay-файлы — это **аудит-trail**, а не функциональный feedback loop. Это снимает риск «двойной правды» между промптом и хранилищем.
  - Update `*.meta.json` — добавить поля: `formatStepDurationMs`, `partial: boolean`, `partialReason?`, `formatTokens: { input, output }`.
- `scripts/f1-smoke.ts` — расширить: вызывать `runF1` (1-4), печатать `formattedReport.summaryLine` + первую секцию, чтобы убедиться в end-to-end работоспособности.
- Unit-тесты:
  - `src/f1-report.test.ts` — добавить блоки тестов для `runF1Steps34` и `runF1` (mock callClaude и/или callClaudeSafe).
  - `src/adapters/claude.test.ts` — добавить тесты для `callClaudeSafe`: happy path (parsed), Zod fail → `parsed: null + validationErrors`, JSON.parse fail → throws (как раньше), HTTP fail → throws (как раньше).

**Что НЕ входит (следующие stories):**

- **Telegram доставка / `bot.ts` / `formatHeader()` / approveKeyboard / message split > 4096 / inline buttons** — Story 1.5 (`/report` команда + progress) и Story 1.6 (approval workflow). 1.4b возвращает структурированный `DeliveryReadyReport` объект; рендеринг в Telegram-сообщение делает bot.ts. Architecture enforcement #4 (`formatHeader()` для заголовков) — **обязательство bot.ts**, не f1-report.ts.
- **Полный persistence-слой commitments (read+update в источнике истины)** — Story 1.10. На 1.4b: только запись `commitments-updates.json` overlay; `loadOpenCommitments` (1.4a) пока их не учитывает.
- **Auto-cleanup `*.raw.txt` через 14 дней** — Story 1.9.
- **Circuit breaker + ops alerts panel** — Story 1.9. На 1.4b: используется stub `isClaudeCircuitOpen()` (всегда false) из 1.4a.
- **Canary test и golden dataset diff** — Story 1.11. На 1.4b: golden-фикстуры используются как regression input в unit-тестах (опционально), но diff-метрики и threshold 30% — отдельная история.
- **Smart transcript trimming для context_length_exceeded** — Story 1.9 / Growth. На 1.4b: extraction-payload в format-промпте может разрастись на длинных встречах; на MVP с ~30-минутными транскриптами это не критично; deferred.
- **F3-lite formatting (`format-ceo.md` промпт)** — Epic 4. Не пересекается с 1.4b.
- **Streaming Claude response** — Growth. На 1.4b: синхронный messages.create (как 1.4a).

**Контракт между 1.4a и 1.4b:**

```typescript
// 1.4a output (зафиксирован):
RunF1Steps12Result = {
  extraction, analysis, rawResponses, openCommitmentsBefore,
  reportId, durationsMs: { extraction, analysis, total }, tokens
}

// 1.4b расширяет:
RunF1Result = RunF1Steps12Result & {
  formattedReport: DeliveryReadyReport;  // всегда есть; partial=true при сбое 3-4
  partial: boolean;
  partialReason?: 'format_step_failed' | 'format_validation_failed' | 'format_retry_exhausted';
  durationsMs: { extraction, analysis, format, total };  // расширение
  tokens: { input, output };  // суммирует все 3 шага
}
```

## Критерии приёмки

1. **Сценарий: `runF1` на валидном входе возвращает `DeliveryReadyReport` (полный happy path 1-4)** (FR1, FR2, FR4, FR62 из Story 1.4b epic AC)
   ```
   Дано Transcript + ClientContext + meta как в Story 1.4a (см. AC #1)
   Когда вызывается runF1({ transcript, clientContext, meta, deps })
   Тогда выполняется runF1Steps12 (1.4a контракт неизменен)
     И extraction + analysis получены и сохранены
     И затем выполняется runF1Steps34({ extraction, analysis, openCommitmentsBefore, meta, deps })
   И в шаге 3 (formatting):
     - loadPrompt('format-tracker', { extractionOutput, analysisOutput, commitmentsBefore, alerts, topName, department, weekNumber? })
     - callClaudeSafe(prompt, { stepName: 'format', schema: FormatOutputSchema, signal? })
       возвращает { raw, parsed: FormatOutput, usage }
     - parsed.report_sections.length: 1..3 (промпт обязан вернуть max 3)
     - parsed.summary_line.length ≤ 200 (Zod constraint)
     - parsed.commitment_count, parsed.alert_count — number
     - parsed.top_message_draft — string (опционально, 3-5 строк) или undefined
   И в шаге 4 (delivery prep):
     - Сборка DeliveryReadyReport: { reportId, clientId, topName, meetingDate, summaryLine: parsed.summary_line, sections: parsed.report_sections, commitments: extraction.commitments, alerts: analysis.alerts, topMessageDraft: parsed.top_message_draft, partial: false }
     - DeliveryReadyReportSchema.parse() прошла (fail-fast на нашей же сборке — ловит баги в коде, не в Claude)
   И возврат: { ...runF1Steps12Result, formattedReport, partial: false, durationsMs: { ..., format, total }, tokens (суммируется) }
   И persistance: f1-{slug}-{id}.format.raw.txt + f1-{slug}-{id}.format.json + f1-{slug}-{id}.report.json
   ```

2. **Сценарий: Zod `safeParse()` для шага 3 — graceful degradation, НЕ fail-fast** (architecture#Process Patterns: «Steps 3-4 → safeParse + partial fallback»)
   ```
   Дано Claude вернул JSON с структурным нарушением FormatOutputSchema (например, report_sections — не массив, или summary_line > 200 chars, или missing commitment_count)
   Когда callClaudeSafe(prompt, { stepName: 'format', schema: FormatOutputSchema })
   Тогда возвращает { raw, parsed: null, validationErrors: zodError.issues, usage }
     И НЕ throws — runF1Steps34 решает что делать
   И runF1Steps34:
     - сохраняет raw в *.format.raw.txt (даже при validation fail — Day-1 fix #5)
     - log.warn({ step: 'f1.format.validation_failed', validationErrors, ... })
     - alertOps({ pipeline: 'F1', step: 'f1.format.validation', ... })
     - возвращает partial result (см. AC #5): formattedReport с partial: true, partialReason: 'format_validation_failed', extractionFallback: { commitments, citations, decisions, facts }
     - НЕ throws — caller (Story 1.5 bot.ts) получает результат с partial-флагом
   И analysis_validation поведение (1.4a) НЕ изменено: parse() для шагов 1-2 сохраняется (fail-fast).
   ```

3. **Сценарий: Retry policy для шага 3 — те же правила, что и в 1.4a** (architecture#API Patterns Retry, FR34)
   ```
   Дано Claude API возвращает 429, 500, 503, 529 или сетевая ошибка
   Когда callClaudeSafe обернул вызов в withRetry({maxRetries: 3, backoffMs: [1000, 3000, 9000]})
   Тогда поведение идентично callClaude из 1.4a:
     - retry на 429, 500-599, 529, ECONNRESET/ETIMEDOUT/ENOTFOUND/EAI_AGAIN
     - НЕ retry: 400, 401, 403, AbortError, 'context_length_exceeded'
     - на исчерпании retry → throw F1PipelineError('claude_api', { stepName: 'format', httpStatus, attemptCount: 4 })
   И в runF1Steps34: на этот throw срабатывает try/catch — возвращается partial result (см. AC #5)
   И при abort через deps.signal — withRetry прекращает retry-loop И backoff sleep (review fix 1.4a применяется автоматически).
   ```

4. **Сценарий: Шаг 3 (formatting) упал после 3 попыток — partial result с extraction fallback** (FR30, FR62, NFR10, epic 1.4b AC «pipeline graceful degradation»)
   ```
   Дано Claude API вернул 500 четыре раза подряд (initial + 3 retries) НА шаге 3
   Когда runF1Steps34 ловит F1PipelineError('claude_api', ...) от callClaudeSafe
   Тогда:
     - log.error({ step: 'f1.format.retry_exhausted', err })
     - alertOps({ pipeline: 'F1', step: 'f1.format', clientId, error })
     - формируется DeliveryReadyReport: {
         reportId, clientId, topName, meetingDate,
         partial: true,
         partialReason: 'format_retry_exhausted',
         extractionFallback: {
           commitments: extraction.commitments,
           citations: extraction.citations.slice(0, 10),  // первые 10 цитат
           decisions: extraction.decisions,
           facts: extraction.facts,
         },
         alerts: analysis.alerts,
         summaryLine: 'Автоформатирование не удалось — сырые данные извлечения',
         sections: [],
         commitments: extraction.commitments,
       }
     - DeliveryReadyReportSchema.parse(formattedReport) прошла (partial-вариант валиден)
     - persistence: *.report.json записан с partial:true; *.format.raw.txt НЕ записан (raw отсутствует — все попытки упали до получения текста)
     - возврат: НЕ throw, а { ..., formattedReport, partial: true, partialReason: 'format_retry_exhausted' }
   И caller (Story 1.5) при `partial === true` рендерит в Telegram «⚠️ Автоформатирование не удалось. Сырые данные:» + extractionFallback (UX spec) + ops-алерт Тимуру (FR79).
   ```

5. **Сценарий: Шаг 3 (formatting) — Claude OK, но safeParse не прошла → partial result с тем же fallback** (architecture safeParse semantics)
   ```
   Дано callClaudeSafe вернул { raw: '<some text>', parsed: null, validationErrors }
   Когда runF1Steps34 видит parsed === null
   Тогда:
     - сохраняет raw в *.format.raw.txt (для дебага)
     - log.warn({ step: 'f1.format.validation_failed', validationErrors }, 'format step Zod safeParse fail')
     - alertOps({ pipeline: 'F1', step: 'f1.format.validation', clientId })
     - формирует DeliveryReadyReport как в AC #4, но с partialReason: 'format_validation_failed'
     - возврат: { ..., partial: true, partialReason: 'format_validation_failed' }
   И summaryLine partial-варианта: «Формат отчёта повреждён — сырые данные извлечения» (отличается от AC #4 для трассируемости).
   ```

6. **Сценарий: Russian output + Kazakh quotes preservation** (FR44, NFR71)
   ```
   Дано extraction.citations[i].text содержит казахскую цитату (например, "Мен ертең жасаймын")
   Когда формируется final formatted report
   Тогда промпт format-tracker.md ИНСТРУКТИРУЕТ Claude:
     - весь narrative — на русском
     - казахские цитаты — оставляются дословно с пометкой `[KK]` перед или после цитаты
     - смешанные (code-switching) цитаты — целиком в оригинале с `[KK/RU]`
   И code НЕ занимается detection-of-language — это полностью задача промпта (промпт уже видит ту же цитату из extraction)
   И Zod-проверки в FormatOutputSchema на язык НЕ выполняются (нельзя надёжно через regex; хорошие промпт-инструкции достаточны на MVP)
   И тест: golden-фикстура с казахской цитатой → проверка summary_line на русском, наличие [KK] в одной из секций (это soft-assertion, проверяется ручным review при canary, не unit-тестом).
   ```

7. **Сценарий: Сохранение `*.format.raw.txt` + `*.format.json` + финального `*.report.json`** (Day-1 fix #5 продолжение)
   ```
   Дано шаг 3 завершился (успешно ИЛИ с safeParse fail после получения raw)
   Когда выполняется persistFormatStep
   Тогда:
     - data/{clientId}/{YYYY-MM-DD}/f1-{slug}-{id}.format.raw.txt — text/plain UTF-8 (raw Claude output, всегда если есть raw)
     - data/{clientId}/{YYYY-MM-DD}/f1-{slug}-{id}.format.json — pretty-printed FormatOutput (только если parsed !== null)
   И отдельно (всегда, даже при partial):
     - data/{clientId}/{YYYY-MM-DD}/f1-{slug}-{id}.report.json — pretty-printed DeliveryReadyReport (полный или partial-вариант)
   И при IO-failure — log.error + alertOps + НЕ блокировать возврат (warn-only side-effect, как 1.4a Day-1 fix #5)
   И *.meta.json (1.4a) расширяется: { ..., formatStepDurationMs, partial, partialReason, formatTokens }
   ```

8. **Сценарий: Запись `commitments-updates.json` overlay из analysis** (Story 1.4a deferred → 1.4b minimal scope)
   ```
   Дано analysis.commitments_status_updates содержит элементы (1+) — Claude обновил статус прошлого commitment'а на основании новой встречи
     И каждый элемент: { who, what, previous_quote, new_status: 'open'|'completed'|'overdue', evidence_quote? }
   Когда runF1Steps34 обнаруживает analysis.commitments_status_updates.length > 0
   Тогда:
     - data/{clientId}/{YYYY-MM-DD}/f1-{slug}-{id}.commitments-updates.json — записывается:
       { reportId, meetingDate, updates: analysis.commitments_status_updates, sourceFiles: openCommitmentsBefore.sourceFiles  /* передано из 1.4a */ }
     - log.info({ step: 'f1.commitments-updates.persisted', count })
   И ИЗ исходных *.extraction.json (1.4a) НИЧЕГО НЕ читается и НЕ перезаписывается (immutable backup)
   И loadOpenCommitments (1.4a) при следующем запуске НЕ читает overlay-файлы (1.4b не меняет 1.4a-логику; интеграция статусов в loadOpenCommitments — Story 1.10)
   И если analysis.commitments_status_updates пуст — overlay-файл НЕ создаётся (избегаем мусора)
   ```

9. **Сценарий: Latency monitoring + child-logger расширены для шага 3** (1.4a AC #12 + extension)
   ```
   Дано child-logger из 1.4a: logger.child({ pipeline: 'F1', step: 'f1.run', clientId, topName })
   Когда выполняется шаг 3
   Тогда логируется:
     log.info({ step: 'f1.format.start', extractionPayloadSize, analysisPayloadSize, openCommitmentsCount })
     log.info({ step: 'f1.format.complete', durationMs, inputTokens, outputTokens, sectionsCount, commitmentCount, alertCount, topMessageDraftPresent: boolean })
     log.info({ step: 'f1.run.total', totalDurationMs, status: 'ok'|'partial'|'error' })
   И при partial=true → log.warn({ step: 'f1.format.partial', partialReason })
   И totalDurationMs > 15 * 60 * 1000 → log.warn({ slaExceeded: true }) — обновлённый порог учитывает шаг 3 (~30 с дополнительно к 1-2)
   ```

10. **Сценарий: AbortSignal во время шага 3** (review fix 1.4a применяется к новому шагу)
    ```
    Дано caller передал AbortController.signal в runF1
    Когда controller.abort() вызван во время шага 3 (Claude call ИЛИ backoff)
    Тогда withRetry прекращает retry-loop (review fix 1.4a)
      И SDK отменяет in-flight request
      И callClaudeSafe re-throws AbortError (НЕ маскирует под parsed:null — abort это не валидация-fail)
      И runF1Steps34 ловит AbortError → проверяет err.name === 'AbortError'
      → log.warn({ step: 'f1.format.aborted', reason: 'aborted_by_caller' })
      → re-throws AbortError (caller bot.ts знает что делать с abort, partial result не имеет смысла)
    И persistance шага 3 НЕ выполняется (raw отсутствует, parsed отсутствует)
    И .meta.json финализируется (try/finally) с status: 'error', errorCode: 'aborted'
    ```

11. **Сценарий: orchestrator `runF1` проксирует ошибки 1-2 без изменений** (контракт 1.4a сохранён)
    ```
    Дано runF1Steps12 throws F1PipelineError('extraction_validation' | 'analysis_validation' | 'claude_api' | 'empty_client_context')
    Когда runF1 ловит ошибку шага 1-2
    Тогда runF1 re-throws ту же ошибку без обёртки
      И runF1Steps34 НЕ вызывается (extraction/analysis невалидны → форматировать нечего)
      И persistance шагов 1-2 уже выполнена в 1.4a logic (raw сохранён даже при fail)
      И meta.json содержит status: 'error', errorCode из 1.4a
    NB: runF1 НЕ запускает шаг 3 даже на partial-data из 1-2; разделение 1-2 (fail-fast) и 3-4 (graceful) — архитектурное решение, нельзя смешивать.
    ```

12. **Сценарий: `runF1Steps34` без orchestrator — может быть вызван отдельно** (testability + reuse)
    ```
    Дано extraction + analysis получены отдельно (например, реgenerated из *.extraction.json + *.analysis.json для retry-without-1-2)
    Когда runF1Steps34({ extraction, analysis, openCommitmentsBefore: [], meta, deps }) вызывается напрямую
    Тогда возвращается полный или partial DeliveryReadyReport
      И reportId передаётся через meta (для re-use существующих файлов; если не передан — генерируется новый)
    И use case: ops-recovery (формат сломался для конкретного отчёта, dev запускает re-format на сохранённых extraction/analysis без re-extraction)
    NB: scope MVP: эта функция используется только из runF1 + smoke-test. Standalone CLI для re-format — Story 1.9 / Growth.
    ```

13. **Сценарий: Claude вернул не-JSON / no_text_block — partial с `format_step_failed`** (D2 resolved 2026-05-18, замещает spec line 24 «JSON.parse throws»)
    ```
    Дано Claude API вернул HTTP 200, но текстовый блок не парсится как JSON
      ИЛИ response.content не содержит ни одного text-блока (no_text_block)
    Когда `callClaudeSafe` бросает `F1PipelineError('claude_response_invalid', { reason: 'json_parse_failed' | 'no_text_block' })`
    Тогда runF1Steps34 ловит F1PipelineError code === 'claude_response_invalid':
      - сохраняет raw в *.format.raw.txt (если он есть; для no_text_block — отсутствует)
      - log.warn({ step: 'f1.format.response_invalid', reason })
      - alertOps({ pipeline: 'F1', step: 'f1.format.response_invalid' }) — с sanitized err (без полного raw)
      - формирует partial DeliveryReadyReport с partialReason: 'format_step_failed'
      - tokens восстанавливаются из err.context.usage (Claude billed for the call)
      - log.warn({ step: 'f1.format.partial', partialReason: 'format_step_failed', durationMs, inputTokens, outputTokens })
      - persist *.report.json + *.commitments-updates.json (если есть updates)
      - возврат: { ..., partial: true, partialReason: 'format_step_failed', tokens: {...recovered} }
    NB: Spec line 24 пересмотрен — JSON.parse fail НЕ throw (Claude уже билинговался + Азизе нужен extraction fallback вместо тишины). Различие partialReason для трассировки: `format_step_failed` (response-level) vs `format_validation_failed` (schema-level).

14. **Сценарий: `top_message_draft` опционален и не блокирует валидацию** (UX-DR4 + UX spec line 99 + D1 resolved 2026-05-18 — post-parse fallback)
    ```
    Дано Claude возвращает FormatOutput БЕЗ top_message_draft (промпт MVP — soft-recommendation, не required)
    Когда FormatOutputSchema.safeParse выполняется
    Тогда parsed.top_message_draft === undefined → валидно (Zod .optional())
      И DeliveryReadyReport.topMessageDraft === undefined
      И bot.ts (Story 1.5) рендерит секцию «📱 Для топа» только если topMessageDraft присутствует
    И если top_message_draft присутствует — длина 3-5 строк (~150-400 chars), содержит 1+ commitment с deadline
    И Zod constraint: top_message_draft?: z.string().min(20).max(800).optional()
    ```

## Задачи / Подзадачи

- [x] **Задача 1: Расширить `src/types.ts` — Format/Delivery schemas** (КП: #1, #2, #4, #5)
  - [x] 1.1 `FormatSectionSchema`:
    ```ts
    export const FormatSectionSchema = z.object({
      title: z.string().min(1).max(120),
      content: z.string().min(1).max(3500),  // ~3500 chars per section, leaves room для max 3 секций под 4096
    });
    ```
  - [x] 1.2 `FormatOutputSchema`:
    ```ts
    export const FormatOutputSchema = z.object({
      report_sections: z.array(FormatSectionSchema).min(1).max(3),
      summary_line: z.string().min(1).max(200),
      commitment_count: z.number().int().nonnegative(),
      alert_count: z.number().int().nonnegative(),
      top_message_draft: z.string().min(20).max(800).optional(),
    });
    export type FormatOutput = z.infer<typeof FormatOutputSchema>;
    ```
  - [x] 1.3 `DeliveryReadyReportSchema` — discriminated union по `partial`:
    ```ts
    const FullDeliveryReportSchema = z.object({
      partial: z.literal(false),
      reportId: z.string().min(1),
      clientId: z.string().min(1),
      topName: z.string().min(1),
      meetingDate: z.iso.datetime({ offset: true }),
      summaryLine: z.string().min(1).max(200),
      sections: z.array(FormatSectionSchema).min(1).max(3),
      commitments: z.array(CommitmentSchema),
      alerts: z.array(z.string()),
      topMessageDraft: z.string().min(20).max(800).optional(),
    });

    const PartialDeliveryReportSchema = z.object({
      partial: z.literal(true),
      partialReason: z.enum(['format_step_failed', 'format_validation_failed', 'format_retry_exhausted']),
      reportId: z.string().min(1),
      clientId: z.string().min(1),
      topName: z.string().min(1),
      meetingDate: z.iso.datetime({ offset: true }),
      summaryLine: z.string().min(1).max(200),
      sections: z.array(FormatSectionSchema).max(0),  // empty
      commitments: z.array(CommitmentSchema),
      alerts: z.array(z.string()),
      extractionFallback: z.object({
        commitments: z.array(CommitmentSchema),
        citations: z.array(CitationSchema).max(10),
        decisions: z.array(z.string()),
        facts: z.array(z.string()),
      }),
    });

    export const DeliveryReadyReportSchema = z.discriminatedUnion('partial', [
      FullDeliveryReportSchema,
      PartialDeliveryReportSchema,
    ]);
    export type DeliveryReadyReport = z.infer<typeof DeliveryReadyReportSchema>;
    ```
  - [x] 1.4 Re-export из `src/f1-report.ts`: `export type { FormatOutput, DeliveryReadyReport } from './types.js';`

- [x] **Задача 2: Расширить `src/errors.ts` — F1PipelineCode** (КП: #5)
  - [x] 2.1 Добавить коды:
    ```ts
    export type F1PipelineCode =
      | 'prompt_load'
      | 'claude_api'
      | 'claude_response_invalid'
      | 'extraction_validation'
      | 'analysis_validation'
      | 'empty_client_context'
      | 'persist'
      // 1.4b additions:
      | 'format_validation_failed'  // Zod safeParse fail на FormatOutputSchema (informational, переходит в partial result)
      | 'delivery_prep'             // ошибка построения DeliveryReadyReport на нашей стороне (баг кода, не Claude)
      ;
    ```
  - [x] 2.2 NB: `format_validation_failed` обычно НЕ throws (используется как `.code` в alertOps context); throw происходит только если Зод-проверка нашего же DeliveryReadyReport не прошла (это баг в коде, не Claude → throw как `delivery_prep`).

- [x] **Задача 3: `src/adapters/claude.ts` — `callClaudeSafe`** (КП: #2, #3, #5)
  - [x] 3.1 Добавить опцию `safeParse?: boolean` в `CallClaudeOpts<T>`:
    ```ts
    export interface CallClaudeOpts<T> {
      stepName: string;
      schema: ZodType<T>;
      model?: string;
      maxTokens?: number;
      signal?: AbortSignal;
      logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
      safeParse?: boolean;  // 1.4b
    }
    ```
  - [x] 3.2 Расширить `CallClaudeResult<T>`: при `safeParse=true` поле `parsed` может быть `null`, и появляется `validationErrors`:
    ```ts
    export interface CallClaudeResult<T> {
      raw: string;
      parsed: T | null;             // null только при safeParse: true И Zod-fail
      validationErrors?: unknown;   // Zod issues, только при parsed: null
      usage: { input_tokens: number; output_tokens: number };
    }
    ```
    **NB:** для callers с `safeParse !== true` `parsed` всегда non-null (контракт 1.4a сохранён через TypeScript type narrowing — добавить overload-перегрузку или helper-тип `Result<T, SafeParse>`).
  - [x] 3.3 Альтернатива (рекомендуется): отдельная public-функция `callClaudeSafe<T>` с явным type signature — чище, без overload:
    ```ts
    export interface CallClaudeSafeResult<T> {
      raw: string;
      parsed: T | null;
      validationErrors?: unknown;
      usage: { input_tokens: number; output_tokens: number };
    }
    export async function callClaudeSafe<T>(
      prompt: string,
      opts: CallClaudeOpts<T>,
    ): Promise<CallClaudeSafeResult<T>>
    ```
    Внутри: переиспользуется тот же приватный `executeClaudeCall(prompt, opts)` (рефакторинг общего кода — http call + retry + raw extraction); затем `safeParseClaudeJSON(raw, schema)` вместо `parseClaudeJSON`.
  - [x] 3.4 Реализация `safeParseClaudeJSON<T>`:
    ```ts
    function safeParseClaudeJSON<T>(
      raw: string,
      schema: ZodType<T>,
    ): { parsed: T | null; validationErrors?: unknown } {
      let cleaned = raw.trim();
      if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
      else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
      if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
      cleaned = cleaned.trim();
      let json: unknown;
      try {
        json = JSON.parse(cleaned);
      } catch (err) {
        // JSON.parse fail = всё ещё throws; safeParse касается только Zod
        throw new F1PipelineError('claude_response_invalid', {
          reason: 'json_parse_failed',
          raw, rawSnippet: raw.slice(0, 500),
          parseError: (err as Error).message,
        }, { cause: err });
      }
      const result = schema.safeParse(json);
      if (result.success) return { parsed: result.data };
      return { parsed: null, validationErrors: result.error.issues };
    }
    ```
  - [x] 3.5 Тесты `src/adapters/claude.test.ts`:
    - happy path: `callClaudeSafe(prompt, { schema: TestSchema })` → `{ parsed: TestSchema.shape, raw, usage }`
    - Zod fail: `callClaudeSafe` с raw нарушающим schema → `{ parsed: null, validationErrors, raw, usage }` БЕЗ throw
    - JSON.parse fail (raw = 'not-json') → throws F1PipelineError('claude_response_invalid')
    - HTTP 500 х4 → throws F1PipelineError('claude_api')
    - AbortSignal → throws AbortError, не возвращает partial
    - safeParse: false (default) — поведение неизменно (1.4a контракт)

- [x] **Задача 4: Расширить `prompts/format-tracker.md`** (КП: #1, #6, #13)
  - [x] 4.1 Обновить header до v1.2.0 (комментарий в начале файла), bump в `prompts/CHANGELOG.md`.
  - [x] 4.2 Добавить новые input-блоки:
    ```
    ## Контекст встречи (вход)

    {{topName}} — {{department}} — нед. {{weekNumber}}

    ## Открытые обязательства из прошлых встреч (для маркировки «продолжающиеся»)

    {{commitmentsBefore}}

    ## Алерты из анализа (для Section 3)

    {{alerts}}
    ```
  - [x] 4.3 Обновить инструкции по формату output:
    - Section 1 «Ключевые решения и обязательства»: разделять «новые» (нет в commitmentsBefore) и «продолжающиеся» (совпадение по who+what+deadline).
    - Section 2 «OKR-покрытие»: только KR с status === 'discussed' или 'mentioned'; blind_zone выводить отдельной строкой "🔴 Слепые зоны: KR-X, KR-Y".
    - Section 3 «Алерты»: ТОЛЬКО если alerts.length > 0 (иначе секция отсутствует, report_sections.length === 2).
    - Russian narrative; казахские цитаты с `[KK]`.
  - [x] 4.4 Расширить JSON output schema (отражает FormatOutputSchema):
    ```
    {
      "report_sections": [{ "title": "...", "content": "..." }],
      "summary_line": "Одна строка ≤ 200 chars",
      "commitment_count": 3,
      "alert_count": 1,
      "top_message_draft": "Жанель, по итогам встречи: ..."  // опционально, 3-5 строк
    }
    ```
  - [x] 4.5 Добавить секцию «📱 Для топа (опциональный draft для трекера)»:
    ```
    Если у топа есть 1+ обязательство с deadline на этой неделе:
    Сгенерируй 3-5 строк текста для копирования трекером в WhatsApp/Telegram.
    Тон: дружелюбный, конкретный, упоминает имя.
    Формат: «{Имя}, по итогам: {ключевое решение}. Ты берёшь {commitment} к {deadline}.»
    ```
  - [x] 4.6 Если top_message_draft не релевантен (нет commitments с deadline) → НЕ возвращать поле (Zod .optional() допускает undefined).

- [x] **Задача 5: `src/f1-report.ts` — `runF1Steps34` + orchestrator `runF1`** (КП: #1, #4, #5, #7, #8, #9, #10, #11, #12)
  - [x] 5.1 Сигнатура:
    ```ts
    export interface RunF1Steps34Input {
      extraction: ExtractionOutput;
      analysis: AnalysisOutput;
      openCommitmentsBefore: Commitment[];
      meta: {
        clientId: string;
        topName: string;
        meetingDate: string;
        meetingType?: string;
        reportId?: string;  // если standalone-вызов и хотим re-use существующих файлов
      };
      deps?: {
        logger?: Logger;
        signal?: AbortSignal;
        rootDir?: string;
        callClaudeSafe?: typeof callClaudeSafe;
        loadPrompt?: typeof loadPrompt;
      };
    }

    export interface RunF1Steps34Result {
      formattedReport: DeliveryReadyReport;  // всегда, partial при сбое
      partial: boolean;
      partialReason?: 'format_step_failed' | 'format_validation_failed' | 'format_retry_exhausted';
      rawResponses: { format: string | null };  // null если retry exhausted (raw не получен)
      durationsMs: { format: number };
      tokens: { input: number; output: number };  // только шаг 3
    }

    export interface RunF1Result extends RunF1Steps12Result {
      formattedReport: DeliveryReadyReport;
      partial: boolean;
      partialReason?: 'format_step_failed' | 'format_validation_failed' | 'format_retry_exhausted';
      durationsMs: { extraction: number; analysis: number; format: number; total: number };
      // tokens: { input, output } — суммирует все 3 шага (overrides 1.4a's)
    }

    export async function runF1Steps34(input: RunF1Steps34Input): Promise<RunF1Steps34Result>
    export async function runF1(input: RunF1Steps12Input): Promise<RunF1Result>
    ```
  - [x] 5.2 Реализация `runF1Steps34`:
    1. Child-logger из deps.logger (или roоtLogger).child({pipeline:'F1', step:'f1.steps34', ...}).
    2. ReportId: meta.reportId ?? randomUUID().slice(0,8).
    3. formatStartMs = Date.now().
    4. log.info({step:'f1.format.start', extractionPayloadSize, analysisPayloadSize, openCommitmentsCount}).
    5. Подготовить vars для loadPrompt:
       - `extractionOutput`: JSON.stringify(extraction, null, 2)
       - `analysisOutput`: JSON.stringify(analysis, null, 2)
       - `commitmentsBefore`: JSON.stringify(openCommitmentsBefore, null, 2) (даже если []; всегда поле)
       - `alerts`: JSON.stringify(analysis.alerts, null, 2)
       - `topName`: meta.topName
       - `department`: extracted из stakeholderMap (передавать в meta? или из ClientContext?). **Решение:** добавить опциональное поле `department?: string` в `runF1Steps34Input.meta`; orchestrator `runF1` подставляет stakeholders.find(s=>s.speakerName===topName)?.department ?? '—'.
       - `weekNumber`: ISO week number из meta.meetingDate; helper `getISOWeekNumber(date: string): string`. Допустимый fallback: '—'.
    6. Promise попытки `result = await callClaudeSafe(prompt, {stepName:'format', schema: FormatOutputSchema, signal: deps.signal, logger: log})`.
    7. Try-catch вокруг (6):
       - catch F1PipelineError code=='claude_api' (retry exhausted) → persist `*.report.json` с partial; partialReason='format_retry_exhausted'; alertOps; log.error; return.
       - catch AbortError → re-throw без partial-обёртки (caller знает).
    8. Если result.parsed === null (safeParse fail):
       - persist `*.format.raw.txt` с result.raw.
       - log.warn({step:'f1.format.validation_failed', validationErrors: result.validationErrors}).
       - alertOps.
       - сборка partial DeliveryReadyReport как в AC #5.
       - persist `*.report.json`.
       - return { formattedReport, partial:true, partialReason:'format_validation_failed', rawResponses:{format:result.raw}, durationsMs, tokens }.
    9. Если result.parsed !== null (success):
       - persist `*.format.raw.txt`, `*.format.json`.
       - сборка full DeliveryReadyReport через хелпер `assembleFullDeliveryReport({reportId, meta, extraction, analysis, formatOutput: result.parsed})`. Этот хелпер чистый, easily testable.
       - DeliveryReadyReportSchema.parse() — fail-fast если наш код собрал невалид (это баг наш, не Claude → throw F1PipelineError('delivery_prep')).
       - persist `*.report.json`.
       - return { formattedReport, partial:false, rawResponses:{format:result.raw}, durationsMs, tokens }.
    10. Запись commitments-updates overlay (см. Задача 6).
    11. log.info({step:'f1.format.complete', durationMs, ...metrics}).
  - [x] 5.3 Реализация orchestrator `runF1`:
    ```ts
    export async function runF1(input: RunF1Steps12Input): Promise<RunF1Result> {
      const totalStart = Date.now();
      const step12 = await runF1Steps12(input);  // throws на 1-2 fail (extraction_validation/analysis_validation/claude_api/empty_client_context)
      // если step12 успешно → runF1Steps34
      const department = input.clientContext.stakeholders.find(s => s.speakerName === input.meta.topName)?.department;
      const step34 = await runF1Steps34({
        extraction: step12.extraction,
        analysis: step12.analysis,
        openCommitmentsBefore: step12.openCommitmentsBefore,
        meta: { ...input.meta, reportId: step12.reportId, department },
        deps: input.deps,
      });
      const totalDuration = Date.now() - totalStart;
      // SLA warn в orchestrator (1.4a's уже считал total для шагов 1-2; теперь — для всего pipeline)
      const log = (input.deps?.logger ?? rootLogger).child({pipeline:'F1', step:'f1.run.total', clientId: input.meta.clientId});
      if (totalDuration > F1_TOTAL_LATENCY_WARN_MS) {
        log.warn({totalDurationMs: totalDuration, slaExceeded: true, partial: step34.partial});
      } else {
        log.info({totalDurationMs: totalDuration, status: step34.partial ? 'partial' : 'ok'});
      }
      return {
        ...step12,
        formattedReport: step34.formattedReport,
        partial: step34.partial,
        partialReason: step34.partialReason,
        durationsMs: { ...step12.durationsMs, format: step34.durationsMs.format, total: totalDuration },
        tokens: { input: step12.tokens.input + step34.tokens.input, output: step12.tokens.output + step34.tokens.output },
      };
    }
    ```
  - [x] 5.4 Helper `assembleFullDeliveryReport(args): DeliveryReadyReport`:
    ```ts
    function assembleFullDeliveryReport(args: {
      reportId: string;
      meta: RunF1Steps34Input['meta'];
      extraction: ExtractionOutput;
      analysis: AnalysisOutput;
      formatOutput: FormatOutput;
    }): DeliveryReadyReport {
      return {
        partial: false,
        reportId: args.reportId,
        clientId: args.meta.clientId,
        topName: args.meta.topName,
        meetingDate: args.meta.meetingDate,
        summaryLine: args.formatOutput.summary_line,
        sections: args.formatOutput.report_sections,
        commitments: args.extraction.commitments,
        alerts: args.analysis.alerts,
        topMessageDraft: args.formatOutput.top_message_draft,
      };
    }
    ```
  - [x] 5.5 Helper `assemblePartialDeliveryReport(args): DeliveryReadyReport`:
    ```ts
    function assemblePartialDeliveryReport(args: {
      reportId: string;
      meta: RunF1Steps34Input['meta'];
      extraction: ExtractionOutput;
      analysis: AnalysisOutput;
      partialReason: 'format_step_failed' | 'format_validation_failed' | 'format_retry_exhausted';
    }): DeliveryReadyReport {
      const summaryByReason = {
        format_step_failed: 'Автоформатирование не удалось — сырые данные извлечения',
        format_validation_failed: 'Формат отчёта повреждён — сырые данные извлечения',
        format_retry_exhausted: 'Автоформатирование не удалось — сырые данные извлечения',
      };
      return {
        partial: true,
        partialReason: args.partialReason,
        reportId: args.reportId,
        clientId: args.meta.clientId,
        topName: args.meta.topName,
        meetingDate: args.meta.meetingDate,
        summaryLine: summaryByReason[args.partialReason],
        sections: [],
        commitments: args.extraction.commitments,
        alerts: args.analysis.alerts,
        extractionFallback: {
          commitments: args.extraction.commitments,
          citations: args.extraction.citations.slice(0, 10),
          decisions: args.extraction.decisions,
          facts: args.extraction.facts,
        },
      };
    }
    ```
  - [x] 5.6 Helper `getISOWeekNumber(isoDate: string): string`:
    ```ts
    // Стандартная ISO 8601 week numbering (Mon-Sun, неделя с 4 января)
    function getISOWeekNumber(isoDate: string): string {
      const d = new Date(isoDate);
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
      const week1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
      const weekNum = 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);
      return String(weekNum);
    }
    ```
    Тест: `getISOWeekNumber('2026-04-30T10:00:00+05:00') === '18'` (примерно — verify через дата-калькулятор).

- [x] **Задача 6: Persistence шага 3 + commitments-updates overlay** (КП: #7, #8)
  - [x] 6.1 `persistFormatStep(meta, reportId, {raw, parsed}, rootDir, log)` — аналог `persistStep` 1.4a, для format-step. Записывает `f1-{slug}-{id}.format.raw.txt` (если raw !== null) + `f1-{slug}-{id}.format.json` (если parsed !== null). Warn-only на IO fail.
  - [x] 6.2 `persistDeliveryReport(meta, reportId, deliveryReport, rootDir, log)` — записывает `f1-{slug}-{id}.report.json` (всегда, full или partial). Warn-only.
  - [x] 6.3 `persistCommitmentsUpdates(meta, reportId, updates: AnalysisOutput['commitments_status_updates'], sourceFiles: string[], rootDir, log)` — если updates.length > 0 → записывает `f1-{slug}-{id}.commitments-updates.json`. Иначе skip.
  - [x] 6.4 Расширить `persistMeta` (1.4a): добавить поля `formatStepDurationMs`, `partial`, `partialReason`, `formatTokens`. Меняем структуру `MetaPayload` в `f1-report.ts`.
  - [x] 6.5 Все persistance — async (`fs.promises.*`), warn-only (НЕ throw из pipeline; alertOps).

- [x] **Задача 7: Расширить `scripts/f1-smoke.ts`** (КП: #1, #5)
  - [x] 7.1 Заменить вызов `runF1Steps12` на `runF1` (full pipeline).
  - [x] 7.2 Печатать в output:
    ```
    {
      reportId,
      durationsMs: { extraction, analysis, format, total },
      tokens: { input, output },
      partial,
      partialReason,
      summaryLine: formattedReport.summaryLine,
      sectionsCount: formattedReport.partial ? 0 : formattedReport.sections.length,
      topMessageDraftPresent: !formattedReport.partial && !!formattedReport.topMessageDraft,
      commitmentsCount: formattedReport.commitments.length,
    }
    ```
  - [x] 7.3 Сохранять `data/smoke-results/{client}/{date}/...` — пути уже от runF1 (rootDir в deps).
  - [x] 7.4 Тестовый запуск: `npm run f1:smoke -- data/golden/transcript-1.json` с реальным `ANTHROPIC_API_KEY`. Ожидаемое: full pipeline отработал, partial: false, sectionsCount: 2 или 3.

- [x] **Задача 8: Unit-тесты `src/f1-report.test.ts` — runF1Steps34 + runF1** (КП: #1, #2, #3, #4, #5, #6, #8, #9, #10, #11, #12)
  - [x] 8.1 Mock `callClaudeSafe` через `vi.fn()` — возвращает `{raw, parsed, usage}` или `{raw, parsed: null, validationErrors, usage}`.
  - [x] 8.2 Тесты `runF1Steps34`:
    - happy path → returns full DeliveryReadyReport, partial: false; persistence verified (3 файла: format.raw.txt + format.json + report.json).
    - safeParse fail (parsed: null) → returns partial DeliveryReadyReport, partialReason: 'format_validation_failed'; persistance: format.raw.txt + report.json (без format.json).
    - retry exhausted (mock callClaudeSafe throws F1PipelineError('claude_api')) → returns partial, partialReason: 'format_retry_exhausted'; persistance: только report.json (raw недоступен).
    - AbortSignal → re-throws AbortError, runF1Steps34 НЕ маскирует под partial.
    - top_message_draft optional → отсутствие поля валидируется без ошибки.
    - commitments_status_updates пуст → commitments-updates.json НЕ создан.
    - commitments_status_updates непуст → commitments-updates.json создан с правильным содержимым.
  - [x] 8.3 Тесты `runF1` (orchestrator):
    - happy path → 1-2 + 3-4 успешно, returns full RunF1Result.
    - 1-2 fail (extraction_validation) → throws, runF1Steps34 НЕ вызывается (vi.fn assertion).
    - 1-2 ok + 3 fail → returns partial result; шаг 3 errors не маскируют шаг 1-2 (extraction/analysis сохранены).
    - durationsMs.total > 15min → log.warn({slaExceeded: true}).
    - department lookup: stakeholderMap содержит топа → department правильный передан в format.
    - department lookup: stakeholderMap НЕ содержит топа → department='—' fallback.
  - [x] 8.4 Тест assembleFullDeliveryReport как pure function (no mocks).
  - [x] 8.5 Тест assemblePartialDeliveryReport: проверка summaryLine для каждого partialReason.
  - [x] 8.6 Тест getISOWeekNumber: 2-3 известные даты.

- [x] **Задача 9: Обновить sprint-status.yaml + Dev Agent Record** (workflow finalize)
  - [x] 9.1 sprint-status: `1-4b-f1-formatirovanie-i-podgotovka-k-dostavke: ready-for-dev → in-progress` (на старте Dev) → `review` (на финише). last_updated → текущая дата.
  - [x] 9.2 Story file: статус `ready-for-dev` → `in-progress` → `review`.
  - [x] 9.3 Заполнить Dev Agent Record (Debug Log References, Completion Notes, File List, Change Log).

### Review Findings (2026-05-18, bmad-code-review)

Источники: external reviewer (3 findings) + Blind Hunter + Edge Case Hunter + Acceptance Auditor. Всего после dedup/dismiss: **3 decision-needed**, **13 patch**, **16 defer**, **8 dismissed**.

#### Decisions resolved (2026-05-18, Тимур)

- **D1 → post-parse fallback** — на Zod validation fail если errors ограничены `top_message_draft` path, удалить поле и retry parse. Дополнительный patch P14.
- **D2 → сохранить partial, обновить spec** — `format_step_failed` как полноценный partialReason. Дополнительные patches P15 (spec AC + Task 8.x test).
- **D3 → ослабить schema** — `meetingDate: z.iso.datetime()` без `offset:true`. Дополнительный patch P16.

#### Patch (исправить — fix unambiguous)

- [ ] [Review][Patch] **P1 [HIGH]: slugifyClientId отсутствует в 3 persist-функциях шага 3** [src/f1-report.ts:709,746,779](src/f1-report.ts#L709) — `persistFormatStep`, `persistDeliveryReport`, `persistCommitmentsUpdates` строят путь через сырой `meta.clientId`, тогда как `persistStep` ([line 132](src/f1-report.ts#L132)) и `persistMeta` ([line 185](src/f1-report.ts#L185)) применяют `slugifyClientId`. При clientId с пробелами/`/` артефакты шага 3 уходят в другую директорию, чем шага 1-2. Client isolation сломан. (external #1)
- [ ] [Review][Patch] **P2 [HIGH]: topNameSlug может вернуть пустую строку → "f1--{reportId}.…"** — для `meta.topName = "."`, `"   "`, `"<>"` slug даёт `""`, получаем double-dash в filename. Добавить guard: throw `F1PipelineError` или fallback `'unknown-top'` если slug пуст. (C12)
- [ ] [Review][Patch] **P3 [MEDIUM]: *.meta.json не обновляется состоянием шага 3** — `persistMeta` вызывается только в `runF1Steps12`'s finally до старта формата ([src/f1-report.ts:563](src/f1-report.ts#L563)). `MetaPayload` определяет `partial`, `partialReason`, `formatTokens` ([line 170-173](src/f1-report.ts#L170)) — но эти поля никогда не записываются. AC спека line 39 + line 230 требуют. Fix: вызывать `persistMeta` после `runF1Steps34` в `runF1` с дополненным payload. (external #2)
- [ ] [Review][Patch] **P4 [MEDIUM]: commitments-updates.json теряет sourceFiles (AC #8)** [src/f1-report.ts:783-790](src/f1-report.ts#L783) — пишет `{reportId, meetingDate, updates}`. AC #8 (spec line 199-200) требует `sourceFiles: openCommitmentsBefore.sourceFiles`. Сигнатура функции даже не принимает `sourceFiles`. Это разрывает audit-trail для Story 1.10. Fix: расширить `loadOpenCommitments` чтобы возвращал `{commitments, sourceFiles}`, прокинуть через `RunF1Steps12Result.openCommitmentsBefore`, передать в `persistCommitmentsUpdates`. (external #3)
- [ ] [Review][Patch] **P5 [MEDIUM]: runF1 пропускает f1.run.total на ошибке + SLA-info-info взаимоисключающие** [src/f1-report.ts:1126-1145](src/f1-report.ts#L1126) — `if (totalDuration > SLA) warn else info` — info без status никогда не эмитится на SLA-breach; на throw из runF1Steps34 (`AbortError`, `delivery_prep`) канонический `f1.run.total` лог вообще не эмитится (нет try/finally). Fix: всегда info (status: ok/partial/error/aborted), дополнительно warn на SLA-breach, обернуть в try/finally. (B3 + A1)
- [ ] [Review][Patch] **P6 [MEDIUM]: дублирование f1.run.total — runF1Steps12 finally + runF1 orchestrator** — `runF1Steps12.finally` эмитит `step:'f1.run.total'` с длительностью только шагов 1-2 ([src/f1-report.ts:543-561](src/f1-report.ts#L543)), потом `runF1` эмитит ещё один с полной длительностью. Два события с тем же key искажают дашборды. Fix: переименовать первый в `f1.steps12.total`, оставить `f1.run.total` только в orchestrator. (A2)
- [ ] [Review][Patch] **P7 [MEDIUM]: tokens=0 в claude_response_invalid partial-branch** [src/f1-report.ts:957](src/f1-report.ts#L957) — Claude вернул raw (200 OK), tokens были израсходованы, но `executeClaudeCall` бросает `claude_response_invalid` до прокидывания `usage`. partial-branch жёстко вписывает `tokens: { input: 0, output: 0 }`. Cost-tracking теряет траты на самом дорогом fail-mode. Fix: добавить `usage` в `F1PipelineError.context` для `claude_response_invalid` и читать его в partial-branch. (B4 + A5)
- [ ] [Review][Patch] **P8 [MEDIUM]: delivery_prep в happy-path оставляет format.json без report.json** [src/f1-report.ts:1031-1068](src/f1-report.ts#L1031) — `persistFormatStep` вызывается до `DeliveryReadyReportSchema.parse(full)`. Если parse() бросает `delivery_prep`, format.json уже на диске, report.json/commitments-updates.json нет. Fix: либо собирать DeliveryReadyReport до persistFormatStep, либо удалять format.json при последующем throw, либо записывать `report.json` с `partial: true, partialReason: 'delivery_prep'` (новый case). (B5)
- [ ] [Review][Patch] **P9 [MEDIUM]: raw transcript leaks в log sinks через err.context** [src/f1-report.ts ~line 350,395](src/f1-report.ts) — `extraction_validation` wraps upstream `claude_response_invalid.context` целиком, включая `raw: <полный Claude output>`. Pino сериализует `err` со всем context — фрагменты транскрипта уходят в логи. NFR71 / privacy. Fix: при wrapping убрать `raw` field либо обрезать до `rawSnippet`. (B9)
- [ ] [Review][Patch] **P10 [MEDIUM]: delivery_prep schema-fail НЕ обёрнут в try/catch в retry_exhausted + response_invalid branches** [src/f1-report.ts:899, 942](src/f1-report.ts#L899) — голый `DeliveryReadyReportSchema.parse(partial)` бросает ZodError напрямую, минуя `delivery_prep` wrapping. AC #4 явно требует «НЕ throw, а partial result». Happy-path и safeParse-fail branches уже обёрнуты ([line 1000](src/f1-report.ts#L1000), [line 1046](src/f1-report.ts#L1046)). Fix: одинаково обернуть все 4 branches. (A4)
- [ ] [Review][Patch] **P11 [MEDIUM]: partial branches не эмитят f1.format.complete / f1.format.partial** — AC #9 (spec line 215) требует `log.warn({step:'f1.format.partial', partialReason})` на partial. Текущий код эмитит `f1.format.complete` только в happy path ([src/f1-report.ts:1070-1082](src/f1-report.ts#L1070)). Partial-branches логируют `validation_failed` / `retry_exhausted` / `response_invalid` но не канонический `partial`. Dashboard'ы по `f1.format.complete` под-считают partials. Fix: добавить `log.warn({step:'f1.format.partial', partialReason, durationMs, ...})` в каждый partial-branch. (A9)
- [ ] [Review][Patch] **P12 [MEDIUM]: getISOWeekNumber('—') в prompt header при невалидном meetingDate** [src/f1-report.ts:632-644](src/f1-report.ts#L632) — `Number.isNaN(d.getTime())` → return `'—'`. `loadPrompt` принимает строку, в шаблон уходит `"нед. —"`. `runF1Steps34` может быть вызван standalone (Task 5.2 line 469) с любой meetingDate. Fix: при невалидной дате throw `F1PipelineError('delivery_prep', {reason: 'invalid_meeting_date'})` или пробрасывать guard `MEETING_DATE_PREFIX_RE` внутрь `runF1Steps34` тоже. (C3)
- [ ] [Review][Patch] **P13 [LOW]: format-tracker.md — противоречие "без markdown fences" + пример с ```fences```** [prompts/format-tracker.md ~line 67-82](prompts/format-tracker.md) — инструкция «Верни ТОЛЬКО валидный JSON (без markdown fences)» соседствует с примером в ```fences```. Claude может скопировать fences. Adapter их strip'ает, но детерминизм промпта страдает. Fix: убрать fences из примера (или заменить indent'ом). (A7)
- [ ] [Review][Patch] **P14 [MEDIUM] (D1 resolved): top_message_draft post-parse fallback** — В `safeParseClaudeJSON` ([src/adapters/claude.ts](src/adapters/claude.ts)) на Zod validation fail проверить, что все validationErrors относятся только к path `['top_message_draft']`. Если да — удалить поле из json и retry `schema.safeParse(json)`. Если retry успешно — вернуть parsed с warning-log `f1.format.top_message_draft_stripped`. Иначе — обычный `parsed: null + validationErrors`. Сохраняет полный отчёт при косметическом сбое draft'а.
- [ ] [Review][Patch] **P15 [LOW] (D2 resolved): legitimize format_step_failed partialReason** — (a) обновить spec line 24 (заменить «JSON.parse-failure всё равно throws» на описание partial-branch с alert); (b) добавить AC #14 в [1-4b spec](_bmad-output/implementation-artifacts/1-4b-f1-formatirovanie-i-podgotovka-k-dostavke.md) для сценария «claude_response_invalid → partial с partialReason='format_step_failed', persist raw if available»; (c) добавить test для format_step_failed branch в [src/f1-report.test.ts](src/f1-report.test.ts).
- [ ] [Review][Patch] **P16 [HIGH] (D3 resolved): ослабить DeliveryReadyReportSchema.meetingDate** [src/types.ts:190,204](src/types.ts#L190) — заменить `z.iso.datetime({ offset: true })` на `z.iso.datetime()` (принимает Z, любой offset, prefix-only date после нормализации). Проверить fixtures в [src/f1-report.test.ts](src/f1-report.test.ts) — убедиться что они всё ещё ОК. Также обновить spec line 293.

#### Defer (pre-existing / beyond MVP)

- [x] [Review][Defer] **topNameSlug collisions могут смешать commitments разных топов** [src/utils/commitments-history.ts](src/utils/commitments-history.ts) — `"Жанель Иванова"` vs `"Жанель  Иванова"` (двойной пробел) → одинаковый slug. `loadOpenCommitments` подтянет историю из обоих → cross-stakeholder data leak. Defer в Story 1.10 (full persistence + collision detection). (B1)
- [x] [Review][Defer] **multi text-block concat ломает JSON при interleaved tool_use** [src/adapters/claude.ts:220](src/adapters/claude.ts) — `response.content.filter(b=>b.type==='text').map(b=>b.text).join('')`. С текущим prompting (no tools) не случится; Story 1.9 / Growth. (B6)
- [x] [Review][Defer] **AbortError race в shouldRetryClaude** — `shouldRetryClaude` возвращает true на AbortError; полагается на withRetry signal short-circuit. Узкое race-window возможно при микросекундной задержке между SDK reject и signal flip. Минимальный практический impact. Story 1.9. (B7 + A6)
- [x] [Review][Defer] **MEETING_DATE_PREFIX_RE пропускает "9999-99-99"** [src/f1-report.ts:43](src/f1-report.ts#L43) — невалидная-но-prefix-совместимая дата создаст мусорные директории. Story 1.10 (full date validation). (B8)
- [x] [Review][Defer] **prompt_load AbortError эмитит alertOps как prompt_load_failed** [src/f1-report.ts:854-863](src/f1-report.ts#L854) — текущий loadPrompt не поддерживает abort; если в будущем добавится I/O cancellation, ops получит ложный alert. Story 1.9. (B12)
- [x] [Review][Defer] **report_sections.length === 0 от Claude → forced partial** [src/types.ts:170](src/types.ts) — `min(1).max(3)`. Для 5-минутного check-in с 0 решений / 0 OKR / 0 алертов — schema fails. Редкий случай; Story 1.9. (C4)
- [x] [Review][Defer] **extractionFallback.citations.slice(0,10) без priority** [src/f1-report.ts:693](src/f1-report.ts#L693) — берём первые 10, не отсортированные по `approximate:false`. Story 1.9 (citation ranking). (C6)
- [x] [Review][Defer] **persistDeliveryReport не поддерживает AbortSignal — пишет на диск после abort** [src/f1-report.ts:1031-1068](src/f1-report.ts#L1031) — `fs.promises.*` не принимает signal в Node 20 для writeFile. Wasted IO но не корректность. Story 1.9. (C8)
- [x] [Review][Defer] **commitment_count независим от commitments.length** [src/types.ts:172](src/types.ts) — schema без cross-field refinement. Claude может вернуть `commitment_count: 99` при 2 элементах. Story 1.9 (FormatOutputSchema cross-field refine). (C9)
- [x] [Review][Defer] **split-persist race: report.json есть, commitments-updates.json нет** [src/f1-report.ts:1061-1068](src/f1-report.ts#L1061) — оба warn-only; ENOSPC между двумя await'ами → silent inconsistency. Story 1.10 (atomic batch persist). (C10)
- [x] [Review][Defer] **getISOWeekNumber без года — W1 2026 vs W53 2025 неоднозначно** [src/f1-report.ts:632-644](src/f1-report.ts#L632) — meeting 2025-12-29 (Mon) → ISO week 1 2026. Promp header «нед. 1» без года. Story 1.9 (вернуть `W{NN}-{YYYY}`). (C11)
- [x] [Review][Defer] **partial: boolean (не literal) ломает type narrowing у consumers** [src/f1-report.ts:610-618](src/f1-report.ts#L610) — `RunF1Steps34Result.partial: boolean` вместо `true | false`. Story 1.5 (bot.ts) будет делать runtime narrowing. Story 1.5/1.10 — рефакторинг в discriminated result. (C13)
- [x] [Review][Defer] **test runF1 1-2 fail слабо проверяет non-call шага 3** [src/f1-report.test.ts:3216-3239](src/f1-report.test.ts) — `expect(claudeSafe).not.toHaveBeenCalled()` только; не проверяет, что loadPrompt format-tracker не вызывался, что .format.* / .report.json не созданы. (A10)
- [x] [Review][Defer] **AC #4 test пропускает assert по summaryLine/sections/commitments для retry_exhausted** [src/f1-report.test.ts:3036-3061](src/f1-report.test.ts) — AC спек (line 142-147) требует точные значения; тест проверяет только partial/partialReason/rawResponses. (A11)
- [x] [Review][Defer] **runF1 не проверяет signal между step12 и step34** [src/f1-report.ts:1107-1113](src/f1-report.ts#L1107) — если caller abort'ит в зазоре, всё равно делается prompt load + первая попытка Claude. Минимальный latency leak. (A14)
- [x] [Review][Defer] **alertOps shape непоследовательный** — `f1.format.validation_failed` передаёт `context: {validationErrors}`, `f1.format.response_invalid` — только `error: err`. Минимальный UX-fix для ops. Story 1.9. (A15)

#### Dismissed (8)

Не записаны в story (false positives / spec compliance / cosmetic):
- B2 (department lookup by speakerName) — код соответствует spec line 539.
- B11 (f5Metrics defensive guard) — Zod валидирует upstream через ClientContextSchema.
- C7 (sort stability) — V8 stable sort с 2018.
- C14 (response undefined guard) — SDK contract гарантирует non-null на success.
- C15 (circular cause walk) — depth limit (5) защищает.
- A8 (department fallback location wording) — cosmetic spec drift.
- A12 (no test for format_step_failed) — зависит от D2.
- A13 (spec AC #11 lists empty_client_context) — spec wording stale, не код-issue.

## Dev Notes

### Соответствие архитектуре

- **Provider-agnostic boundary** (architecture#Process Patterns): `@anthropic-ai/sdk` импортируется только в `src/adapters/claude.ts`. `runF1Steps34` вызывает `callClaudeSafe`, не SDK. Замена LLM = замена `claude.ts`.
- **Prompt loading enforcement** (architecture#Process Patterns + Anti-patterns): все промпты через `loadPrompt(name, vars)`. Inline template literals с `{{vars}}` запрещены. Grep-проверка при code-review:
  - `grep -rE 'anthropic\.messages\.create' src/` → только `src/adapters/claude.ts`.
  - `grep -rE 'const\s+\w+\s*=\s*\`[^\`]*\{\{' src/` → 0 результатов.
- **Zod parse vs safeParse strategy** (architecture line 466-468):
  - Шаги 1-2 (extraction, analysis): `parse()` — fail-fast (1.4a).
  - Шаги 3-4 (formatting, delivery): `safeParse()` + partial fallback — graceful degradation (1.4b).
  - Это **намеренная асимметрия**: без extraction/analysis pipeline бесполезен; без форматирования — Азиза получает сырые данные и может вручную составить отчёт.
- **Retry policy** (architecture#API Patterns): те же правила что и в 1.4a — `withRetry({maxRetries: 3, backoffMs: [1000, 3000, 9000]})` + `shouldRetryClaude` (429/5xx/network). Применяется к шагу 3 идентично 1-2.
- **Persistence (Day-1 fix #5)** (architecture hindsight): raw output сохраняется ВСЕГДА, даже при validation fail. Для шага 3 это критично — `*.format.raw.txt` единственный способ дебагать «почему Claude вернул не-JSON».
- **Logging structure** (architecture#Format Patterns): pino `child({pipeline, step, clientId})` — все логи шага 3 содержат эти поля. Step namespace: `f1.format.*` для grep-фильтрации.
- **No silent catches** (architecture Anti-patterns): каждый catch в шаге 3 логирует + alertOps. Partial result — это explicit fallback с алертом, не «глотание» ошибки.
- **Russian + Kazakh quotes** (FR44, NFR71): полностью задача промпта; в коде нет language detection. Промпт format-tracker.md инструктирует Claude.

### Source tree

- `src/types.ts` — добавить `FormatSectionSchema`, `FormatOutputSchema`, `DeliveryReadyReportSchema` (~80 LOC).
- `src/errors.ts` — расширить `F1PipelineCode` (2 новых кода).
- `src/adapters/claude.ts` — добавить `callClaudeSafe` + `safeParseClaudeJSON` (~80 LOC). Рефакторинг: выделить общий приватный `executeClaudeCall(prompt, opts)` для DRY между `callClaude` и `callClaudeSafe`.
- `src/f1-report.ts` — расширить с `runF1Steps34`, `runF1`, `assembleFullDeliveryReport`, `assemblePartialDeliveryReport`, `getISOWeekNumber`, `persistFormatStep`, `persistDeliveryReport`, `persistCommitmentsUpdates`, обновлённый `persistMeta` (~250 LOC к существующим ~510).
- `prompts/format-tracker.md` — обновить v1.2.0 (~30-50 LOC изменений).
- `prompts/CHANGELOG.md` — bump.
- `scripts/f1-smoke.ts` — заменить вызов на `runF1`, расширить output.
- `src/f1-report.test.ts` — добавить ~12-15 тестов (всего ~30+).
- `src/adapters/claude.test.ts` — добавить ~5 тестов для `callClaudeSafe`.

### Testing Standards

- Vitest как test runner (Story 1.1 + 1.4a уже настроен).
- Моки: `vi.fn()` для `callClaudeSafe`, `loadPrompt`, `loadOpenCommitments`. **НЕ мокать** `fs.promises` — использовать tmpdir-фикстуры (как 1.4a/1.3).
- Не запускать реальный Claude API в CI. Smoke-тест (`npm run f1:smoke`) — manual run с `ANTHROPIC_API_KEY`.
- Coverage threshold не выставляется на 1.4b (нет CI gate для coverage; только зелёные тесты + typecheck).

### Контракты с другими stories

- **Story 1.4a**: использует существующий `runF1Steps12` без изменений. Контракт зафиксирован 1.4a-review (commit 1.0.1). Любая регрессия 1.4a-тестов = блокер.
- **Story 1.5 (Telegram bot /report)**: получает `RunF1Result` из `runF1`. Если `partial: true` — рендерит `extractionFallback` с warning «⚠️ Автоформатирование не удалось». Если `partial: false` — рендерит `sections` через `formatHeader()` + `approveKeyboard()`. **bot.ts отвечает за split > 4096 chars** (FR68); 1.4b просто гарантирует `summary_line ≤ 200` и `section.content ≤ 3500`.
- **Story 1.6 (approval workflow)**: использует `formattedReport.reportId` как ключ для approval state. `approvals.jsonl` ссылается на `reportId`.
- **Story 1.7 (delivery)**: использует `formattedReport.topMessageDraft` (если присутствует) как готовый текст для трекера.
- **Story 1.9 (ops)**: расширит circuit breaker (заглушка из 1.4a) + auto-cleanup `*.raw.txt` + `*.format.raw.txt` через 14 дней. Story 1.9 также займётся context_length_exceeded (умной нарезкой).
- **Story 1.10 (data persistence + client isolation)**: интегрирует overlay-файлы `commitments-updates.json` в `loadOpenCommitments` (1.4a). На 1.4b overlay — только аудит-trail.
- **Story 1.11 (canary + golden)**: использует `RunF1Result` для diff против golden. Diff-метрики применяются к `summary_line` + commitments + sections.

### Project Structure Notes

- Никаких новых директорий. Всё в существующих `src/`, `src/adapters/`, `src/utils/`, `prompts/`, `scripts/`, `_bmad-output/implementation-artifacts/`.
- Файлы persistence (`*.format.json`, `*.report.json`, `*.commitments-updates.json`) — в существующей `data/{clientId}/{YYYY-MM-DD}/` структуре (1.4a + architecture line 558-564).

### References

- [epics.md:586](_bmad-output/planning-artifacts/epics.md#L586) — Story 1.4b epic AC.
- [epics.md:130](_bmad-output/planning-artifacts/epics.md#L130) — NFR10 partial results.
- [epics.md:89](_bmad-output/planning-artifacts/epics.md#L89) — FR62 partial result.
- [epics.md:71](_bmad-output/planning-artifacts/epics.md#L71) — FR44 Russian + Kazakh.
- [architecture.md:466-468](_bmad-output/planning-artifacts/architecture.md#L466-L468) — Zod safeParse strategy.
- [architecture.md:498](_bmad-output/planning-artifacts/architecture.md#L498) — formatHeader() для Telegram заголовков (bot.ts).
- [architecture.md:551](_bmad-output/planning-artifacts/architecture.md#L551) — `format-tracker.md` промпт.
- [ux-design-specification.md:466-467](_bmad-output/planning-artifacts/ux-design-specification.md#L466-L467) — Max 3 секции, > 4096 split.
- [ux-design-specification.md:500-523](_bmad-output/planning-artifacts/ux-design-specification.md#L500-L523) — F1 Report Telegram template (для bot.ts).
- [ux-design-specification.md:98-99](_bmad-output/planning-artifacts/ux-design-specification.md#L98-L99) — Секция «📱 Сообщение для топа».
- [1-4a-f1-izvlechenie-i-analiz.md](_bmad-output/implementation-artifacts/1-4a-f1-izvlechenie-i-analiz.md) — предыдущая story, контракт 1.4a/1.4b.
- [deferred-work.md](_bmad-output/implementation-artifacts/deferred-work.md) — deferred items 1.4a → 1.4b/1.10.
- [src/f1-report.ts](src/f1-report.ts) — точка расширения для шагов 3-4.
- [src/adapters/claude.ts](src/adapters/claude.ts) — точка расширения для `callClaudeSafe`.
- [prompts/format-tracker.md](prompts/format-tracker.md) — текущий v1.0.0 промпт, обновляется до v1.2.0.

## Previous Story Intelligence (Story 1.4a)

**Patterns зафиксированы 1.4a и должны быть переиспользованы:**

- **Async I/O only**: `fs.promises.*`, никаких `*Sync` (lesson Story 1.2 IWE).
- **withRetry signal-aware**: review fix 1.4a (retry.ts получил `signal` опцию + signal-aware sleep). Поэтому при abort во время backoff на шаге 3 — мгновенная отмена.
- **Persistence pattern**: `persistStep` (1.4a) — async, warn-only, raw сохраняется ДАЖЕ при validation fail. Применить тот же pattern к `persistFormatStep`.
- **Child-logger**: `logger.child({pipeline:'F1', step:'f1.run', clientId, topName})` — добавить child step namespace `f1.format.*`.
- **Defensive checks**: `empty_client_context` guard (1.4a AC #11) применён через `extraction_validation` с `reason`. На 1.4b аналогичного guard нет (extraction/analysis уже валидированы 1.4a → не может быть пустым).
- **F5Metrics empty contract**: `formatOkrContextForPrompt` всегда включает `f5Metrics: []` (review fix 1.4a). На 1.4b: `commitmentsBefore` всегда передаётся в формат-промпт (даже как `[]`), `alerts` — тоже всегда (массив строк может быть пустым).
- **error wrapping**: `F1PipelineError` со step-specific code (1.4a: `extraction_validation`, `analysis_validation`). На 1.4b: `format_validation_failed` (informational; в alertOps context, НЕ как throw — partial result покрывает) и `delivery_prep` (throw — баг в нашем коде).
- **Test fixture pattern**: tmpdir + golden JSON фикстуры. Не мокать fs.promises (хрупкие тесты).

**Lessons learned from 1.4a code-review (4 fixes 2026-04-30):**

1. Не пропустите `signal` через `withRetry` — abort во время backoff критичен для UX (Telegram bot timeout = 30s).
2. Не омить опциональные поля в JSON-payload, если контракт ожидает их наличие (даже как `[]`). Промпт может полагаться на наличие поля для условной ветки.
3. Не вводите новые error-codes, которые дублируют существующие пути. Лучше расширить существующий код через `reason` в context (как `extraction_validation` + `reason: 'empty_client_context'`).
4. Дедуп при чтении истории (commitments) делать по ВСЕМ записям, потом фильтровать по статусу — иначе latest-state может скрыть себя за более старой open-версией.

## Dev Agent Record

### Agent Model Used

claude-opus-4-7 (1M context)

### Debug Log References

- `npm run typecheck` → 0 ошибок.
- `npm test` → 144/144 тестов проходят (было 124 в 1.4a → +20 новых тестов 1.4b: 5 для `callClaudeSafe`, 7 для `runF1Steps34`, 5 для `runF1`-orchestrator, 3 helpers).
- `npm run build && find dist -name "*.test.js"` → пусто (test-файлы корректно исключены).
- Grep enforcement (architecture.md):
  - `grep -rE 'anthropic\.messages\.create|new Anthropic\(' src/ -l` → только `src/adapters/claude.ts` ✅
  - `grep -rE 'const\s+\w+\s*=\s*\`[^\`]*\{\{' src/` → 0 результатов ✅ (нет inline-промптов)
  - `grep -rE 'JSON\.parse\(\s*[a-zA-Z_]+\.content\b|JSON\.parse\(\s*raw\b' src/adapters/ src/f1-report.ts` → 0 результатов ✅ (только через `parseClaudeJSON` / `safeParseClaudeJSON`)

### Completion Notes List

- **F1 шаги 3-4 реализованы** — `runF1Steps34({extraction, analysis, openCommitmentsBefore, meta, deps})` собирает `DeliveryReadyReport` (full | partial) с persistence и логированием. Возвращает `{ formattedReport, partial, partialReason?, rawResponses, durationsMs, tokens, reportId }`.
- **Orchestrator `runF1`** — объединяет шаги 1-2 (Story 1.4a `runF1Steps12`) + 3-4. Возвращает `RunF1Result` со всеми durationsMs/tokens суммированы. Передаёт department из stakeholderMap в формат-промпт; fallback `'—'` если топ не в карте.
- **Provider-agnostic boundary сохранён** — `callClaudeSafe<T>` рядом с `callClaude<T>` в `src/adapters/claude.ts`. Общий приватный `executeClaudeCall` рефакторингом извлечён для DRY (HTTP + retry + raw extraction). `parseClaudeJSON` (throws) и `safeParseClaudeJSON` (returns null on Zod fail) — две точки выбора стратегии.
- **Zod safeParse strategy (architecture line 466-468)** — шаг 3 использует `callClaudeSafe` → на Zod validation fail возвращается `parsed: null + validationErrors`, runF1Steps34 формирует partial result. Шаги 1-2 без изменений (parse() fail-fast).
- **3 partial-reason различимы для трассировки**:
  - `format_validation_failed` — Zod safeParse вернул null после успешного Claude-ответа (raw сохранён).
  - `format_retry_exhausted` — все 4 попытки Claude API упали с retryable error (raw отсутствует).
  - `format_step_failed` — Claude вернул не-JSON / no_text_block (raw сохранён если есть).
  - `summaryLine` каждого partial-варианта различим: validation_failed → «Формат отчёта повреждён», остальные → «Автоформатирование не удалось».
- **AbortSignal** — пробрасывается в `callClaudeSafe` → SDK + `withRetry({signal})` (review fix 1.4a применяется автоматически). На abort во время backoff sleep — мгновенная отмена. AbortError НЕ маскируется под partial (caller знает что делать).
- **Persistence шага 3** — 3 новых файла + расширенный `*.meta.json`:
  - `f1-{slug}-{id}.format.raw.txt` — raw Claude (даже при validation fail).
  - `f1-{slug}-{id}.format.json` — pretty-printed `FormatOutput` (только при success).
  - `f1-{slug}-{id}.report.json` — pretty-printed `DeliveryReadyReport` (всегда, full или partial).
  - `*.meta.json` (1.4a → расширено): `formatStepDurationMs`, `partial`, `partialReason`, `formatTokens`.
  - Persist failures → log.error + alertOps + НЕ throw (warn-only, паттерн 1.4a).
- **Commitments-updates overlay (минимальный scope)** — если `analysis.commitments_status_updates.length > 0`, записывается `f1-{slug}-{id}.commitments-updates.json` с `{reportId, meetingDate, updates}`. **Источники истины (`*.extraction.json`) НЕ модифицируются** — append-only invariant сохранён. `loadOpenCommitments` (1.4a) пока НЕ читает overlay — Story 1.10 интегрирует.
- **Russian + Kazakh quotes (FR44, NFR71)** — задача промпта format-tracker.md v1.2.0; код language detection НЕ выполняет. Промпт инструктирует Claude: narrative русский, цитаты на казахском дословно с `[KK]`, code-switching с `[KK/RU]`.
- **Top message draft опционален** — `top_message_draft?: string.min(20).max(800)` в FormatOutputSchema. Промпт возвращает поле только если у топа есть commitment с deadline. Bot.ts (Story 1.5) рендерит секцию «📱 Для топа» только если поле присутствует.
- **DeliveryReadyReport как discriminated union** — `partial: false` (full) | `partial: true` (partial с `partialReason` + `extractionFallback`). Тип-дискриминатор гарантирует что bot.ts (Story 1.5) корректно ветвит rendering. `partial` варианты валидируются Zod на наличие `extractionFallback`.
- **Helpers экспортированы** — `assembleFullDeliveryReport`, `assemblePartialDeliveryReport`, `getISOWeekNumber`. Pure functions без side effects, прямо протестированы в `helpers (1.4b)` test block.
- **Smoke-test расширен** — `npm run f1:smoke` теперь вызывает `runF1` (full pipeline), печатает `summaryLine`, `sectionsCount`, `topMessageDraftPresent`, `partial/partialReason`, durations + tokens по всем 3 шагам.
- **Deferred work** (Story 1.5 / 1.9 / 1.10 / 1.11):
  - Telegram rendering / `formatHeader()` / approveKeyboard / split > 4096 — Story 1.5/1.6.
  - Полный persistence-слой commitments (read+update в источнике, интеграция overlay в loadOpenCommitments) — Story 1.10.
  - Auto-cleanup `*.format.raw.txt` через 14 дней — Story 1.9.
  - Smart transcript trimming для `context_length_exceeded` — Story 1.9 / Growth.
  - Streaming Claude response — Growth.
  - Prompt caching через `cache_control` — Growth.

### File List

**Modified files:**
- `src/types.ts` — добавлены `FormatSectionSchema`, `FormatOutputSchema`, `DeliveryReadyReportSchema` (discriminated union по `partial`), `PartialReasonSchema` + типы (`FormatSection`, `FormatOutput`, `DeliveryReadyReport`, `PartialReason`).
- `src/errors.ts` — расширен `F1PipelineCode`: добавлены `format_validation_failed`, `delivery_prep`.
- `src/adapters/claude.ts` — рефакторинг: общий `executeClaudeCall`, helper-ы `stripMarkdownFences`, `jsonParseOrThrow`, `safeParseClaudeJSON`. Новый public-export `callClaudeSafe<T>` + интерфейс `CallClaudeSafeResult<T>` (parsed: T | null + validationErrors?).
- `src/adapters/claude.test.ts` — +5 тестов для `callClaudeSafe` (happy path, Zod fail returns null, JSON.parse throws, HTTP 401 throws, AbortSignal throws).
- `src/f1-report.ts` — расширение: `runF1Steps34`, `runF1`, helpers (`getISOWeekNumber`, `assembleFullDeliveryReport`, `assemblePartialDeliveryReport`, `PARTIAL_SUMMARY_BY_REASON`), persistence (`persistFormatStep`, `persistDeliveryReport`, `persistCommitmentsUpdates`), расширенный `MetaPayload`. Импорты `callClaudeSafe`, `FormatOutputSchema`, `DeliveryReadyReportSchema`, `FormatOutput`, `DeliveryReadyReport`, `PartialReason`, `CommitmentStatusUpdate`. Re-exports `FormatOutput`, `DeliveryReadyReport`.
- `src/f1-report.test.ts` — +15 тестов: 7 для `runF1Steps34` (happy path persistence, safeParse fail, retry exhausted, AbortError re-throw, top_message_draft optional, commitments-updates пуст/непуст), 5 для `runF1` (happy path, 1-2 fail blocks 3-4, 1-2 ok + 3 fail returns partial, department lookup hit/miss), 3 helpers (assembleFullDeliveryReport, assemblePartialDeliveryReport summaryLine distinct, getISOWeekNumber).
- `prompts/format-tracker.md` — v1.0.0 → v1.2.0: добавлены input-блоки `{{topName}}`, `{{department}}`, `{{weekNumber}}`, `{{commitmentsBefore}}`, `{{alerts}}`; добавлена секция «📱 Для топа» с опциональным `top_message_draft`; правила для казахских цитат `[KK]` / `[KK/RU]`; расширен `summary_line` до 200 chars.
- `prompts/CHANGELOG.md` — добавлена запись v1.2.0 (Story 1.4b).
- `scripts/f1-smoke.ts` — заменён `runF1Steps12` на `runF1` (full pipeline). Output расширен: `partial`, `partialReason`, `summaryLine`, `sectionsCount`, `topMessageDraftPresent`, `commitmentsCount` (формат) + все поля 1.4a.
- `_bmad-output/implementation-artifacts/sprint-status.yaml` — story 1-4b: backlog → ready-for-dev → in-progress → review; last_updated → 2026-04-30.

## Change Log

| Дата | Версия | Описание | Автор |
|------|--------|----------|-------|
| 2026-04-30 | 0.1.0 | Story создана: F1 шаги 3-4 (formatting + delivery prep), `callClaudeSafe` с safeParse, `DeliveryReadyReport` discriminated union (full \| partial), persistance шага 3, commitments-updates overlay (минимальный scope, полный persistence в Story 1.10), prompts/format-tracker.md v1.2.0 (commitmentsBefore + alerts + top_message_draft). | bmad-create-story |
| 2026-04-30 | 1.0.0 | Implementation complete → review: `runF1Steps34` + `runF1` orchestrator, `callClaudeSafe` + общий `executeClaudeCall` helper, FormatOutput/DeliveryReadyReport schemas, persistance шага 3 (`*.format.raw.txt`/`*.format.json`/`*.report.json`), commitments-updates overlay, format-tracker.md → v1.2.0. typecheck/build clean, 144/144 тестов pass (+20 регрессий 1.4b), grep enforcement passed. | claude-opus-4-7 (Dev Agent) |
