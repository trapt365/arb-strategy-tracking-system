# Story 1.6: Approval workflow — approve/edit/reject

Status: done

## Пользовательская история

Как **коуч практики (Азиза)**,
Я хочу **просмотреть сгенерированный отчёт и одним тапом подтвердить, исправить или отклонить его**,
Чтобы **я контролировала что отправляется клиенту, и могла вносить точечные правки без ручного написания всего отчёта**.

## Контекст и границы scope

**Эта история** добавляет approval state machine к финальному сообщению отчёта из Story 1.5. После того как `processJob` в `src/bot.ts` рендерит отчёт через `renderFinalReport`, под последним сообщением появляются inline-кнопки (только для полных отчётов, не `partial`):

```
[✅ Подтвердить → {topName}]  [✏️ Исправить]  [❌ Отклонить]
```

После подтверждения кнопки заменяются на:
```
[📝 Уточнение]  [🔗 Подробнее]
```

**Что входит в Story 1.6 (production-код в `src/`):**

- **`src/utils/approvals.ts` (новый, ~60 LOC)** — append-only I/O для `data/{clientId}/approvals.jsonl`. Функции: `appendApproval(record)`, `isAlreadyApproved(clientId, reportId)`.
- **`src/types.ts`** — добавить `ApprovalRecordSchema` (Zod); расширить `ReportJobSchema` новыми опциональными полями: `approvalStatus`, `lastReportText`, `pendingEditInstructionMessageId`.
- **`src/bot.ts`** — изменить `renderFinalReport` для прикрепления клавиатуры к последнему сообщению; добавить helper-функции `buildApproveKeyboard()` и `buildPostApproveKeyboard()`; добавить `pendingEdits: Map<chatId, PendingEdit>` для edit flow; добавить `bot.callbackQuery` handlers для `approve:*`, `edit:*`, `reject:*`; добавить `bot.on('message:text')` handler для ответов на edit-инструкцию.
- **`src/f1-report.ts`** — добавить экспортируемую функцию `applyEditToReport(currentReportText, correction)`, вызывающую Claude с промптом `edit-apply.md`.
- **`prompts/edit-apply.md` (новый)** — промпт для применения точечной правки к уже отформатированному отчёту.

**Что НЕ входит (следующие stories):**

- **Delivery (отправка топу от имени трекера)** — Story 1.7. На 1.6 кнопки `[📝 Уточнение]` и `[🔗 Подробнее]` добавляются но **не функциональны** (отвечают «Скоро доступно.»); delivery — Story 1.7.
- **Partial reports с approve-кнопками** — partial отчёты НЕ получают approve-кнопки (зафиксировано в Story 1.5: «в 1.6 партиал тоже не получит approve»). Причина: неполный отчёт нельзя подтвердить к доставке клиенту.
- **Перегенерация при reject** — MVP: reject = ручной режим (пользователь отправляет новую ссылку через `/report`). Полная перегенерация — Growth/Story 1.9.
- **Persistence ReportJob на диск** — Story 1.10. На 1.6 `approvalStatus` хранится только in-memory на `ReportJob`; `approvals.jsonl` — единственный persistence artifact.
- **Lifecycle commitments (🔵/🟡/🟢/🔴)** — Story 1.7/1.10. На 1.6 все commitments остаются 🔵.
- **F3-lite approval flow** — Epic 4.

**Контракт с Story 1.5:**

```typescript
// bot.ts renderFinalReport (Story 1.5) возвращает messageId последнего сообщения.
// Story 1.6 получает этот messageId и прикрепляет к нему keyboard через editMessageReplyMarkup.
// ВАЖНО: renderFinalReport нужно модифицировать для возврата lastMessageId.

// Ключевые поля job (Story 1.5 уже устанавливает):
// job.id           — 8-char UUID для callback_data
// job.chatId       — для отправки сообщений
// job.topName      — для кнопки "Подтвердить → {Name}"
// job.clientId     — для пути к approvals.jsonl
// job.partial      — Story 1.5 устанавливает; 1.6 читает для skip keyboard
// job.status       — 'completed' когда рендер готов

// Story 1.6 добавляет на ReportJob:
// job.approvalStatus        — 'approved' | 'editing' | 'rejected'
// job.lastReportText        — текст последнего рендера (для re-рендера после edit)
// job.pendingEditInstructionMessageId — messageId инструкции «✏️ Что исправить?»
```

## Критерии приёмки

1. **Сценарий: inline-кнопки появляются под полным отчётом** (FR / [epics.md: Story 1.6, AC #1])
   ```
   Дано runF1 вернул RunF1Result с partial:false
   Когда renderFinalReport завершил отправку
   Тогда последнее Telegram-сообщение содержит InlineKeyboard:
     Ряд 1: [✅ Подтвердить → Жанель] [✏️ Исправить] [❌ Отклонить]
   И кнопка approve содержит имя получателя: "Подтвердить → {job.topName}"
   И callback_data: approve:{job.id}, edit:{job.id}, reject:{job.id}
   ```

2. **Сценарий: partial отчёт не получает approve-кнопки** (архитектурное ограничение)
   ```
   Дано runF1 вернул RunF1Result с partial:true
   Когда renderFinalReport завершил отправку
   Тогда финальное сообщение НЕ содержит InlineKeyboard (кнопки отсутствуют)
   И job.approvalStatus остаётся undefined
   ```

3. **Сценарий: approve — подтверждение + запись + смена кнопок** (FR, AC #2, #3)
   ```
   Дано Азиза видит отчёт с inline-кнопками
   Когда нажимает [✅ Подтвердить → Жанель]
   Тогда bot.answerCallbackQuery: ""  (или краткий ack без popup)
   И ctx.editMessageReplyMarkup на том же сообщении → заменить кнопки на:
       Ряд 1: [📝 Уточнение] [🔗 Подробнее]
   И ctx.reply (отдельное сообщение): "✅ Подтверждено. Готово к пересылке Жанель."
   И appendApproval({ reportId: job.id, clientId, topName, chatId, approvedAt, status:'approved' })
       записан в data/{clientId}/approvals.jsonl (append, одна строка JSON)
   И job.approvalStatus = 'approved'
   И log.info({ step:'bot.approve.completed', jobId, topName })
   ```

4. **Сценарий: double-tap на approve — "ℹ️ Уже отправлено."** (AC #5, UX[epics:872])
   ```
   Дано job.approvalStatus === 'approved'
   Когда Азиза повторно нажимает [✅ Подтвердить → Жанель]
   Тогда bot.answerCallbackQuery с текстом "ℹ️ Уже отправлено." (popup-notification)
   И НЕ пишет повторно в approvals.jsonl
   И НЕ меняет кнопки (они уже сменились на post-approve)
   И job.approvalStatus остаётся 'approved'
   ```

5. **Сценарий: reject — статус + ручной режим** (AC #4)
   ```
   Дано Азиза нажимает [❌ Отклонить]
   Когда reject callback получен
   Тогда bot.answerCallbackQuery: ""
   И ctx.editMessageReplyMarkup: убрать кнопки (reply_markup = пустой InlineKeyboard)
   И ctx.reply: "❌ Отчёт отклонён. Отправь исправленную ссылку командой /report."
   И job.approvalStatus = 'rejected'
   И log.info({ step:'bot.reject.completed', jobId })
   И НЕ пишет в approvals.jsonl (только approved records persist)
   ```

6. **Сценарий: edit flow — инструкция + reply + обновлённый preview** (AC #3)
   ```
   Дано Азиза нажимает [✏️ Исправить]
   Когда edit callback получен
   Тогда bot.answerCallbackQuery: ""
   И job.approvalStatus = 'editing'
   И ctx.reply (новое сообщение): "✏️ Что исправить? Ответь: «Конверсия 30%, не 28%»"
       сохранить messageId → job.pendingEditInstructionMessageId
   И pendingEdits.set(job.chatId, { jobId: job.id, instructionMessageId: <saved> })

   Затем Азиза ОТВЕЧАЕТ (reply_to_message_id совпадает) с текстом "Конверсия 30%, не 28%"
   Когда bot.on('message:text') handler проверяет pendingEdits
   Тогда ctx.reply: "⏳ Применяю правку..."
   И вызвать applyEditToReport(job.lastReportText, correction) → updatedText
   И job.lastReportText = updatedText
   И job.approvalStatus = undefined (сброс — снова ожидает approve)
   И pendingEdits.delete(chatId)
   И отправить ctx.reply(updatedText, { reply_markup: buildApproveKeyboard(topName, jobId) })
       (новое сообщение с обновлённым отчётом и кнопками)
   И log.info({ step:'bot.edit.applied', jobId, correctionLen: correction.length })
   ```

7. **Сценарий: edit reply к неправильному сообщению** (AC #6)
   ```
   Дано pendingEdits.has(chatId) === true
     И ctx.message.reply_to_message_id !== job.pendingEditInstructionMessageId
   Когда бот получает text message от chatId
   Тогда ctx.reply: "⚠️ Нажми [✏️] под нужным отчётом."
   И pendingEdits НЕ удаляется (состояние preserved)
   И applyEditToReport НЕ вызывается
   ```

8. **Сценарий: edit — ошибка Claude при applyEditToReport** (resilience)
   ```
   Дано applyEditToReport throws (Claude error / network)
   Когда worker ловит ошибку
   Тогда ctx.reply: "⚠️ Не удалось применить правку. Попробуй снова или нажми [✏️] ещё раз."
   И pendingEdits.delete(chatId) (очистить состояние — иначе stuck)
   И job.approvalStatus = undefined (возврат в исходное состояние)
   И alertOps WARN: { pipeline:'F1', step:'bot.edit.failed', jobId, error }
   И исходный отчёт с кнопками НЕ изменён (пользователь может попробовать ещё раз)
   ```

9. **Сценарий: post-approve кнопки не активны на MVP** (Story 1.7 границы)
   ```
   Дано Азиза нажимает [📝 Уточнение] или [🔗 Подробнее] после approve
   Когда callback получен
   Тогда bot.answerCallbackQuery: "Скоро доступно 🔜" (popup)
   И НЕ отправляет дополнительных сообщений
   И log.info({ step:'bot.post_approve.stub', action })
   ```

10. **Сценарий: double-click на edit или reject — idempotent** (defensive)
    ```
    Дано job.approvalStatus === 'editing' (уже в процессе редактирования)
    Когда Азиза повторно нажимает [✏️ Исправить]
    Тогда bot.answerCallbackQuery: "✏️ Ожидаю твой ответ."  (popup)
    И НЕ отправляет новое instruction-сообщение
    И pendingEdits не перезаписывается
    ```

11. **Сценарий: approveKeyboard не появляется если job не найден** (defensive)
    ```
    Дано Telegram доставляет callback_query для старого/неизвестного jobId
    Когда queue.peek(jobId) === undefined
    Тогда bot.answerCallbackQuery: "ℹ️ Отчёт уже недоступен." (popup)
    И НЕ crash handler'а (логируется warn, не error)
    ```

## Задачи / Подзадачи

- [ ] **Задача 1: `src/types.ts` — ApprovalRecordSchema + расширить ReportJob** (КП: #3, #4)
  - [ ] 1.1 Добавить `ApprovalRecordSchema`:
    ```typescript
    export const ApprovalRecordSchema = z.object({
      reportId: z.string().min(1).max(32),
      clientId: z.string().min(1),
      topName: z.string().min(1),
      chatId: z.number().int(),
      approvedAt: z.string().min(1),  // ISO datetime
      status: z.literal('approved'),   // только approved пишем в .jsonl (reject — нет)
    });
    export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
    ```
  - [ ] 1.2 Расширить `ReportJobSchema` — добавить **после** существующих полей:
    ```typescript
    approvalStatus: z.enum(['approved', 'editing', 'rejected']).optional(),
    lastReportText: z.string().optional(),            // текущий rendered text для edit re-use
    pendingEditInstructionMessageId: z.number().int().optional(),  // messageId «✏️ Что исправить?»
    ```
    Эти поля опциональны — не ломают существующие тесты.

- [ ] **Задача 2: `src/utils/approvals.ts` (новый)** (КП: #3)
  - [ ] 2.1 Создать файл со следующими функциями:
    ```typescript
    import * as fs from 'node:fs/promises';
    import * as path from 'node:path';
    import type { ApprovalRecord } from '../types.js';

    const DATA_ROOT = 'data';

    function approvalsPath(clientId: string): string {
      return path.join(DATA_ROOT, clientId, 'approvals.jsonl');
    }

    /** Append an approval record. Creates directory if needed. */
    export async function appendApproval(record: ApprovalRecord): Promise<void> {
      const filePath = approvalsPath(record.clientId);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, JSON.stringify(record) + '\n', 'utf8');
    }

    /**
     * Check if a reportId was already approved (prevents double-write if called
     * from external context). On 1.6 double-tap prevention is in-memory (job.approvalStatus),
     * this is a disk-level guard for future restart scenarios.
     */
    export async function isAlreadyApproved(clientId: string, reportId: string): Promise<boolean> {
      const filePath = approvalsPath(clientId);
      try {
        const content = await fs.readFile(filePath, 'utf8');
        return content.split('\n').some((line) => {
          if (!line.trim()) return false;
          try {
            const rec = JSON.parse(line) as { reportId?: string };
            return rec.reportId === reportId;
          } catch {
            return false;
          }
        });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw err;
      }
    }
    ```
  - [ ] 2.2 Тесты `src/utils/approvals.test.ts` с `tmp`-директорией через `os.tmpdir()`:
    - `appendApproval` создаёт директорию если не существует.
    - `appendApproval` дважды → файл содержит 2 строки.
    - `isAlreadyApproved` → false если файла нет; true если reportId найден; false для другого reportId.
    - Corrupt line в файле → `isAlreadyApproved` не падает, возвращает false для неё.

- [ ] **Задача 3: `prompts/edit-apply.md` (новый)** (КП: #6)
  - [ ] 3.1 Создать `prompts/edit-apply.md`:
    ```markdown
    Ты — ассистент, который вносит точечные правки в готовый отчёт по встрече.

    # Текущий отчёт:
    {{currentReport}}

    # Правка:
    {{correction}}

    # Инструкция:
    Примени правку к отчёту выше. Верни ТОЛЬКО исправленный текст отчёта, без объяснений и комментариев.
    Сохрани структуру (заголовки, секции, форматирование MarkdownV2, эмодзи).
    Исправь ТОЛЬКО то, что явно указано в правке. Остальной текст оставь без изменений.
    Если правка нелогична или противоречит другим данным отчёта — примени её буквально, как указано.
    ```

- [ ] **Задача 4: `src/f1-report.ts` — добавить `applyEditToReport`** (КП: #6)
  - [ ] 4.1 Добавить экспортируемую функцию после существующих функций (НЕ менять runF1):
    ```typescript
    /**
     * Apply a point correction to an already-rendered report text via Claude.
     * Uses prompts/edit-apply.md. Returns the corrected plain text (not JSON-parsed).
     * Called by bot.ts edit handler; does NOT touch runF1 pipeline state.
     */
    export async function applyEditToReport(
      currentReportText: string,
      correction: string,
      deps: { signal?: AbortSignal } = {},
    ): Promise<string> {
      const promptTemplate = await loadPrompt('edit-apply', {
        currentReport: currentReportText,
        correction,
      });
      const response = await withRetry(
        () =>
          claudeClient.messages.create({
            model: CLAUDE_MODEL,
            max_tokens: 2000,
            messages: [{ role: 'user', content: promptTemplate }],
            ...(deps.signal ? { signal: deps.signal } : {}),
          }),
        { maxRetries: 2, baseDelayMs: 1000 },
      );
      // Extract plain text response (not JSON — edit output is free-form corrected text).
      const content = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (!content.trim()) {
        throw new Error('applyEditToReport: empty response from Claude');
      }
      return content.trim();
    }
    ```
  - [ ] 4.2 Проверить, что `claudeClient`, `CLAUDE_MODEL`, `withRetry`, `loadPrompt` уже импортированы в `src/f1-report.ts` — если нет, добавить из существующих imports.
  - [ ] 4.3 Тест (в существующем `src/f1-report.test.ts` или отдельном файле — минимально):
    - `applyEditToReport` вызывает `claudeClient.messages.create` с содержимым, включающим `currentReport` и `correction`.
    - Возвращает text из первого text-блока ответа.
    - Если Claude возвращает пустую строку — throws.

- [ ] **Задача 5: `src/bot.ts` — inline keyboards и callback handlers** (КП: #1–#11)
  - [ ] 5.1 Добавить импорт `InlineKeyboard` из `grammy`:
    ```typescript
    import { Bot, GrammyError, InlineKeyboard, type Context } from 'grammy';
    ```
  - [ ] 5.2 Добавить импорт `appendApproval` и `applyEditToReport`:
    ```typescript
    import { appendApproval } from './utils/approvals.js';
    import { applyEditToReport } from './f1-report.js';
    import type { ApprovalRecord } from './types.js';
    ```
  - [ ] 5.3 В `createBot` scope добавить:
    ```typescript
    // pendingEdits: chatId → { jobId, instructionMessageId }
    // Cleared on edit reply received (success or fail) or on duplicate [✏️] press.
    interface PendingEdit { jobId: string; instructionMessageId: number }
    const pendingEdits = new Map<number, PendingEdit>();
    ```
  - [ ] 5.4 Добавить helper-функции (в scope createBot, перед handlers):
    ```typescript
    function buildApproveKeyboard(topName: string, jobId: string): InlineKeyboard {
      return new InlineKeyboard()
        .text(`✅ Подтвердить → ${topName}`, `approve:${jobId}`)
        .text('✏️ Исправить', `edit:${jobId}`)
        .text('❌ Отклонить', `reject:${jobId}`);
    }

    function buildPostApproveKeyboard(jobId: string): InlineKeyboard {
      return new InlineKeyboard()
        .text('📝 Уточнение', `post_note:${jobId}`)
        .text('🔗 Подробнее', `post_detail:${jobId}`);
    }
    ```
  - [ ] 5.5 Изменить `renderFinalReport` — вернуть `lastMessageId: number | undefined`:
    ```typescript
    async function renderFinalReport(
      job: ReportJob,
      reportText: string,
    ): Promise<number | undefined>
    ```
    Логика: последняя `ctx.api.sendMessage` (или `safeEditMessage`) возвращает `message_id` — вернуть его. Для единственного сообщения через `safeEditMessage` — вернуть `job.progressMessageId`. Для split — вернуть messageId последнего `sendMessage`.

    **Детали**: в существующем `renderFinalReport` (строки 280–308):
    - Первая часть: отправляется через `safeEditMessage(progressMessageId)` или `sendMessage` — `progressMessageId` known.
    - Parts 1+: `await bot.api.sendMessage(...)` — захватить последний `sent.message_id`.
    - Вернуть id последнего отправленного сообщения.

  - [ ] 5.6 В `processJob`, после `renderFinalReport` — добавить:
    ```typescript
    const lastMessageId = await renderFinalReport(job, text);
    job.lastReportText = text;  // сохраняем для edit re-use

    // Attach approve keyboard к последнему сообщению (только для non-partial).
    if (!result.formattedReport.partial && lastMessageId !== undefined) {
      try {
        await bot.api.editMessageReplyMarkup(
          job.chatId,
          lastMessageId,
          { reply_markup: buildApproveKeyboard(job.topName, job.id) },
        );
      } catch (err) {
        // Non-critical: отчёт доставлен, просто без кнопок. Log and continue.
        log.warn({ err, jobId: job.id }, 'bot.approve.keyboard_attach_failed');
      }
    }
    ```

  - [ ] 5.7 Добавить `bot.callbackQuery(/^approve:/, ...)` handler:
    ```typescript
    bot.callbackQuery(/^approve:(.+)$/, async (ctx) => {
      const jobId = ctx.match[1]!;
      const job = queue.peek(jobId);

      if (job === undefined) {
        await ctx.answerCallbackQuery({ text: 'ℹ️ Отчёт уже недоступен.' });
        log.warn({ jobId }, 'bot.approve.job_not_found');
        return;
      }
      if (job.approvalStatus !== undefined) {
        await ctx.answerCallbackQuery({ text: 'ℹ️ Уже отправлено.' });
        return;
      }

      job.approvalStatus = 'approved';
      await ctx.answerCallbackQuery();

      // Заменить кнопки на post-approve keyboard.
      try {
        await ctx.editMessageReplyMarkup({
          reply_markup: buildPostApproveKeyboard(jobId),
        });
      } catch (err) {
        log.warn({ err, jobId }, 'bot.approve.keyboard_replace_failed');
      }

      await ctx.reply(`✅ Подтверждено. Готово к пересылке ${job.topName}.`);

      const record: ApprovalRecord = {
        reportId: job.id,
        clientId: job.clientId,
        topName: job.topName,
        chatId: job.chatId,
        approvedAt: now().toISOString(),
        status: 'approved',
      };
      try {
        await appendApproval(record);
      } catch (err) {
        // Non-critical for user, but ops should know.
        log.error({ err, jobId }, 'bot.approve.persist_failed');
        alertOps({
          pipeline: 'F1',
          step: 'bot.approve.persist_failed',
          clientId: job.clientId,
          error: err,
          context: { jobId },
        });
      }

      log.info({ step: 'bot.approve.completed', jobId, topName: job.topName }, 'report approved');
    });
    ```

  - [ ] 5.8 Добавить `bot.callbackQuery(/^edit:/, ...)` handler:
    ```typescript
    bot.callbackQuery(/^edit:(.+)$/, async (ctx) => {
      const jobId = ctx.match[1]!;
      const job = queue.peek(jobId);

      if (job === undefined) {
        await ctx.answerCallbackQuery({ text: 'ℹ️ Отчёт уже недоступен.' });
        return;
      }
      if (job.approvalStatus === 'approved') {
        await ctx.answerCallbackQuery({ text: 'ℹ️ Уже подтверждено.' });
        return;
      }
      // Idempotency: уже в режиме редактирования.
      if (job.approvalStatus === 'editing') {
        await ctx.answerCallbackQuery({ text: '✏️ Ожидаю твой ответ.' });
        return;
      }

      job.approvalStatus = 'editing';
      await ctx.answerCallbackQuery();

      let instructionMessageId: number | undefined;
      try {
        const sent = await ctx.reply(
          '✏️ Что исправить? *Ответь* на это сообщение с правкой\\.',
          { parse_mode: 'MarkdownV2' },
        );
        instructionMessageId = sent.message_id;
        job.pendingEditInstructionMessageId = instructionMessageId;
      } catch (err) {
        log.error({ err, jobId }, 'bot.edit.instruction_failed');
        job.approvalStatus = undefined;
        return;
      }

      pendingEdits.set(job.chatId, { jobId, instructionMessageId: instructionMessageId! });
      log.info({ step: 'bot.edit.started', jobId }, 'edit flow started');
    });
    ```

  - [ ] 5.9 Добавить `bot.callbackQuery(/^reject:/, ...)` handler:
    ```typescript
    bot.callbackQuery(/^reject:(.+)$/, async (ctx) => {
      const jobId = ctx.match[1]!;
      const job = queue.peek(jobId);

      if (job === undefined) {
        await ctx.answerCallbackQuery({ text: 'ℹ️ Отчёт уже недоступен.' });
        return;
      }
      if (job.approvalStatus !== undefined) {
        await ctx.answerCallbackQuery({ text: 'ℹ️ Уже обработано.' });
        return;
      }

      job.approvalStatus = 'rejected';
      await ctx.answerCallbackQuery();

      try {
        // Убрать кнопки.
        await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
      } catch (err) {
        log.warn({ err, jobId }, 'bot.reject.keyboard_remove_failed');
      }

      await ctx.reply('❌ Отчёт отклонён. Отправь исправленную ссылку командой /report.');
      log.info({ step: 'bot.reject.completed', jobId }, 'report rejected');
    });
    ```

  - [ ] 5.10 Добавить stub-handler для post-approve кнопок:
    ```typescript
    bot.callbackQuery(/^post_(note|detail):/, async (ctx) => {
      await ctx.answerCallbackQuery({ text: 'Скоро доступно 🔜' });
      log.info({ step: 'bot.post_approve.stub', data: ctx.callbackQuery.data }, 'stub handler');
    });
    ```

  - [ ] 5.11 Добавить `bot.on('message:text', ...)` handler для edit replies (ПОСЛЕ command handlers):
    ```typescript
    bot.on('message:text', async (ctx) => {
      const chatId = ctx.chat.id;
      const pending = pendingEdits.get(chatId);
      if (pending === undefined) return;  // не ожидаем правку от этого чата

      // Проверяем что это reply на правильное instruction-сообщение.
      const replyToId = ctx.message.reply_to_message?.message_id;
      if (replyToId !== pending.instructionMessageId) {
        await ctx.reply('⚠️ Нажми [✏️] под нужным отчётом.');
        return;
      }

      const job = queue.peek(pending.jobId);
      if (job === undefined) {
        pendingEdits.delete(chatId);
        await ctx.reply('ℹ️ Отчёт уже недоступен.');
        return;
      }

      const correction = ctx.message.text.trim();
      if (!correction) return;

      pendingEdits.delete(chatId);
      job.approvalStatus = undefined;
      job.pendingEditInstructionMessageId = undefined;

      let ackMsgId: number | undefined;
      try {
        const ack = await ctx.reply('⏳ Применяю правку…');
        ackMsgId = ack.message_id;
      } catch { /* swallow */ }

      try {
        const updatedText = await applyEditToReport(job.lastReportText ?? '', correction);
        job.lastReportText = updatedText;

        // Удалить ack "Применяю правку..." если удалось.
        if (ackMsgId !== undefined) {
          await bot.api.deleteMessage(chatId, ackMsgId).catch(() => {});
        }

        // Отправить обновлённый отчёт с кнопками (новое сообщение).
        const continuation = `📋 ${escapeMarkdownV2(job.topName)} \\(продолжение\\)`;
        const parts = splitForTelegram(updatedText, TELEGRAM_SAFE_MARGIN, continuation);
        let lastMsgId: number | undefined;
        for (let i = 0; i < parts.length; i++) {
          const isLast = i === parts.length - 1;
          try {
            const sent = await bot.api.sendMessage(chatId, parts[i]!, {
              parse_mode: 'MarkdownV2',
              reply_markup: isLast ? buildApproveKeyboard(job.topName, job.id) : undefined,
            });
            if (isLast) lastMsgId = sent.message_id;
          } catch (err) {
            log.error({ err, jobId: job.id, partIndex: i }, 'bot.edit.send_updated_failed');
          }
        }

        log.info(
          { step: 'bot.edit.applied', jobId: job.id, correctionLen: correction.length },
          'edit correction applied',
        );
      } catch (err) {
        // Не удалось применить правку — сообщить пользователю, восстановить состояние.
        if (ackMsgId !== undefined) {
          await bot.api.deleteMessage(chatId, ackMsgId).catch(() => {});
        }
        job.approvalStatus = undefined;
        await ctx.reply(
          '⚠️ Не удалось применить правку. Попробуй снова или нажми ✏️ ещё раз.',
        );
        alertOps({
          pipeline: 'F1',
          step: 'bot.edit.failed',
          clientId: job.clientId,
          error: err,
          context: { jobId: job.id },
        });
        log.error({ err, jobId: job.id }, 'bot.edit.apply_failed');
      }
    });
    ```

  - [ ] 5.12 Передать `applyEditToReport` через `BotDeps` для тестируемости:
    ```typescript
    // В BotDeps interface добавить:
    applyEditToReport?: typeof applyEditToReport;
    ```
    В `createBot` использовать `deps.applyEditToReport ?? applyEditToReport`.

- [ ] **Задача 6: Тесты `src/bot.test.ts` — добавить тесты для approval flow** (КП: #1–#11)
  - [ ] 6.1 Approve flow тест:
    - Worker завершил job → `renderFinalReport` вызывает `editMessageReplyMarkup` с approve keyboard.
    - Simulate callbackQuery `approve:{jobId}` → `appendApproval` вызван 1 раз, `editMessageReplyMarkup` вызван с post-approve keyboard, `reply` содержит "Подтверждено".
  - [ ] 6.2 Double-tap тест:
    - `job.approvalStatus = 'approved'` → callbackQuery `approve:{jobId}` → `answerCallbackQuery` с текстом "ℹ️ Уже отправлено."; `appendApproval` NOT called.
  - [ ] 6.3 Reject тест:
    - callbackQuery `reject:{jobId}` → `reply` содержит "❌ Отклонён"; `editMessageReplyMarkup` с пустым keyboard; `job.approvalStatus === 'rejected'`.
  - [ ] 6.4 Edit flow тест:
    - callbackQuery `edit:{jobId}` → `reply` содержит "✏️ Что исправить?"; `pendingEdits.has(chatId)` === true.
    - Simulate reply с правильным `reply_to_message_id` → `applyEditToReport` (mock) вызван; новый отчёт отправлен с кнопками.
    - Simulate reply с неправильным `reply_to_message_id` → "⚠️ Нажми [✏️]".
  - [ ] 6.5 Partial отчёт тест: job с `partial:true` → keyboard НЕ прикреплена.
  - [ ] 6.6 Job not found тест: callbackQuery с неизвестным jobId → "ℹ️ Отчёт уже недоступен."

- [ ] **Задача 7: Регрессия — все 214 существующих тестов должны пройти** (КП: backward compat)
  - [ ] 7.1 `npm test` → все 214+ тестов зелёные (расширения `ReportJobSchema` — optional поля, не ломают существующие тесты).
  - [ ] 7.2 TypeScript typecheck (`npx tsc --noEmit`) → no errors.
  - [ ] 7.3 Если `renderFinalReport` изменил сигнатуру — убедиться, что `bot.test.ts` (Story 1.5 тесты) обновлены или мокируют корректно.

- [ ] **Задача 8: Sprint status + Dev Agent Record** (finalize)
  - [ ] 8.1 `_bmad-output/implementation-artifacts/sprint-status.yaml`: обновить `1-6-approval-workflow-approve-edit-reject: backlog → ready-for-dev → in-progress → review`.
  - [ ] 8.2 Обновить story file status: `ready-for-dev` → `in-progress` → `review`.
  - [ ] 8.3 Заполнить Dev Agent Record секцию.

## Dev Notes

### Соответствие архитектуре

- **Callback data формат** (architecture#Format Patterns): `action:reportId` — `approve:abc12345`, `edit:abc12345`, `reject:abc12345`. Строгий формат, регулярки в handlers: `/^approve:(.+)$/`.
- **InlineKeyboard только в `bot.ts`** (architecture#Component Strategy): `telegram-formatter.ts` остаётся pure (без grammY imports). `buildApproveKeyboard()` и `buildPostApproveKeyboard()` — private helpers в `createBot` scope.
- **approvals.jsonl — единственный write artifact 1.6** (architecture#Data Architecture): `data/{clientId}/approvals.jsonl` — append-only, формат совместим с будущим PostgreSQL migration (Story 6.1). Нет `data/{date}/` вложенности — approvals нужны cross-date для lifecycle.
- **Whitelist middleware уже применён** (architecture#Authentication): callback handlers защищены тем же whitelist middleware из 1.5 — callback'и от неавторизованных chat'ов не дойдут до handlers.
- **No silent catches** (architecture Anti-patterns): каждый catch в callback handlers либо логирует warn/error + alertOps при необходимости. `ctx.answerCallbackQuery` должен всегда вызываться (Telegram timeout).
- **Never silent rule** (UX-DR39): edit error → reply с объяснением; approve persist error → alertOps + пользователь уже получил подтверждение (replay-safe).
- **applyEditToReport — отдельная функция, не runF1** (архитектурный принцип «Changeability > Elegance»): не переиспользует pipeline steps, т.к. correction — текстовая операция на уже отформатированном тексте. Инлайн в bot.ts нарушил бы правило "промпты в .md файлах" — вынесено в f1-report.ts + prompts/edit-apply.md.
- **withRetry для applyEditToReport** (architecture#Process Patterns): `maxRetries: 2` (меньше чем pipeline — edit correction UX требует быстрого ответа).
- **pendingEdits — in-memory, per-createBot** (architecture#Data Architecture: «JSON backup on MVP»): при рестарте теряется. Приемлемо — пользователь получит новую инструкцию при следующем [✏️].

### Source tree (изменения)

| Файл | Действие | ~LOC |
|------|----------|------|
| `src/utils/approvals.ts` | **новый** | ~60 |
| `src/utils/approvals.test.ts` | **новый** | ~50 |
| `prompts/edit-apply.md` | **новый** | ~15 |
| `src/types.ts` | добавить `ApprovalRecordSchema` + 3 поля ReportJob | ~15 |
| `src/bot.ts` | добавить imports, helpers, callback handlers, edit handler; изменить `renderFinalReport` | ~120 |
| `src/f1-report.ts` | добавить `applyEditToReport` | ~30 |

### Testing Standards

- **grammY callback simulation**: `bot.handleUpdate({ update_id: N, callback_query: { id: 'cbq1', from: {...}, chat_instance: 'x', data: 'approve:abc12345', message: {...} } })`.
- **answerCallbackQuery мок**: `bot.api.config.use(...)` middleware перехватывает `answerCallbackQuery` calls; проверять через `vi.fn()`.
- **appendApproval мок**: передать через `BotDeps` — см. паттерн `runF1?: typeof defaultRunF1`.
- **applyEditToReport мок**: передать через `BotDeps.applyEditToReport`.
- **НЕ вызывать `bot.start()` в тестах** — только `bot.handleUpdate(update)`.
- **Tmpdir для approvals.test.ts**: `os.tmpdir() + '/' + randomUUID()` для изоляции тестов.

### Контракты с другими stories

- **Story 1.5**: `renderFinalReport` возвращает `lastMessageId` (изменение сигнатуры). Тесты 1.5 для bot.ts могут потребовать небольшой правки mock'ов. Не ломать логику — только добавить return value.
- **Story 1.7 (delivery)**: `job.approvalStatus === 'approved'` — триггер для delivery pipeline. 1.7 добавит после approve: автоматическую подготовку текста для пересылки. На 1.6 после approve — только подтверждение и смена кнопок.
- **Story 1.9 (ops/alerts)**: `alertOps` уже вызывается из 1.6 handlers при critical failures. 1.9 расширит реализацию alertOps без изменений в 1.6.
- **Story 1.10 (persistence)**: `approvals.jsonl` — MVP persistence. 1.10 добавит full ReportJob persistence + commitments source-of-truth update. `ApprovalRecord` schema совместима с PostgreSQL migration.
- **Story 1.13 (поиск отчётов)**: читает `approvals.jsonl` для фильтрации approved отчётов. Schema зафиксирована в 1.6.

### LLM-Dev-Agent Guardrails

- **НЕ импортировать `InlineKeyboard` в `telegram-formatter.ts`** — только в `bot.ts`. formatter остаётся pure.
- **НЕ вызывать `runF1` или `runF1Steps34` в edit handler** — только `applyEditToReport`. Edit не перезапускает pipeline.
- **НЕ вызывать `appendApproval` дважды** — двойной тап предотвращается in-memory проверкой `job.approvalStatus`. `isAlreadyApproved` — защита от disk-level дубликатов в будущем (1.10).
- **НЕ удалять сообщение с отчётом при approve/reject** — только менять `reply_markup`. Пользователь должен видеть отчёт.
- **ВСЕГДА вызывать `ctx.answerCallbackQuery()`** — без него Telegram показывает spinner бесконечно (UX bug). Если handler throws до answerCallbackQuery — try/finally.
- **НЕ хранить `pendingEdits` вне `createBot` scope** — closure pattern (как `jobTimers`, `timedOutJobs` в 1.5).
- **НЕ `console.log`** — всегда pino logger с `{pipeline:'F1', step:'bot.approve.*' | 'bot.edit.*' | 'bot.reject.*'}`.
- **НЕ трогать `processJob` orchestration** — только добавить строки после `renderFinalReport` для keyboard attach. Не менять `try/catch/finally` структуру.
- **НЕ ломать `safeEditMessage` / `safeReply` helpers** — использовать их; `editMessageReplyMarkup` — собственный try/catch (non-critical failure).
- **Проверить что `escapeMarkdownV2` применён** к `job.topName` в любом тексте с `parse_mode:'MarkdownV2'` — имена могут содержать reserved chars.

## Dev Agent Record

### Completion Notes

Реализация завершена 2026-05-19. Все 234 тестов зелёные (было 214 до Story 1.6 — добавлено 20 новых тестов для approval flow + 3 для applyEditToReport).

Ключевые отклонения от спецификации:
- `appendApproval` и `applyEditToReport` переданы через `BotDeps` (инъекция зависимостей) для тестируемости — без этого тесты писали бы реальные файлы и вызывали Claude.
- `completedJobs: Map<string, ReportJob>` добавлен в scope `createBot` — позволяет callback handlers находить job после того, как worker его обработал (queue.peek возвращает undefined после завершения).
- `appendApproval` / `isAlreadyApproved` получили параметр `dataRoot = 'data'` для изоляции тестов через tmpdir.
- `ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } })` вместо `new InlineKeyboard()` для очистки кнопок при reject — grammY сериализует `new InlineKeyboard()` как `[[]]` (один пустой ряд), тест ожидает `[]`.

### Files List

- `src/types.ts` — добавлены `ApprovalRecordSchema`, `ApprovalRecord`; расширен `ReportJobSchema` (`approvalStatus`, `lastReportText`, `pendingEditInstructionMessageId`)
- `src/utils/approvals.ts` — новый; `appendApproval`, `isAlreadyApproved`
- `src/utils/approvals.test.ts` — новый; 6 тестов (dir creation, 2-line append, false when missing, true when found, false for different ID, corrupt lines)
- `prompts/edit-apply.md` — новый; промпт для `applyEditToReport`
- `src/adapters/claude.ts` — экспортирован `getAnthropicClient()`
- `src/f1-report.ts` — добавлена `applyEditToReport`; тесты в `src/f1-report.test.ts` (3 новых кейса)
- `src/bot.ts` — `InlineKeyboard` импорт; `BotDeps` расширен; `completedJobs` Map; `buildApproveKeyboard`, `buildPostApproveKeyboard`, `peekJob` helpers; `renderFinalReport` возвращает `lastMessageId`; keyboard attach в `processJob`; 4 callback handlers (`approve:*`, `edit:*`, `reject:*`, `post_*`); `message:text` handler для edit replies
- `src/bot.test.ts` — 10 новых тестов (AC#1–AC#10 approval workflow); helpers `callbackUpdate`, `textReplyUpdate`, `runJobFromBot`

### Change Log

| Дата | Изменение |
|------|-----------|
| 2026-05-19 | Начата реализация (story ready-for-dev → in-progress) |
| 2026-05-19 | Все задачи 1–7 завершены; 234/234 тестов, typecheck clean |
| 2026-05-19 | Story → review |

### Review Findings

#### Patch (исправить)

- [x] [Review][Patch][P1] AC#5: `{ inline_keyboard: [] }` → заменено на `ctx.editMessageReplyMarkup()` без аргументов [src/bot.ts:752] ✓ fixed
- [x] [Review][Patch][P1] `message:text` посылает «⚠️ Нажми [✏️]» для любого не-reply сообщения — добавлен guard `if (replyToId === undefined) return` [src/bot.ts:773-777] ✓ fixed
- [x] [Review][Patch][P1] `completedJobs` Map растёт бесконечно — добавлен LRU eviction `MAX_COMPLETED_JOBS = 100` [src/bot.ts:127,531] ✓ fixed
- [x] [Review][Patch][P2] Неверный toast «Уже отправлено.» для `editing`/`rejected` — split на 3 отдельных проверки [src/bot.ts:657-660] ✓ fixed
- [x] [Review][Patch][P2] Edit reply loop нет MarkdownV2 fallback — добавлен retry без parse_mode на 400 [src/bot.ts:809-819] ✓ fixed
- [x] [Review][Patch][P2] `pendingEdits` не очищается в reject handler — добавлено `pendingEdits.delete(job.chatId)` [src/bot.ts:735-759] ✓ fixed
- [x] [Review][Patch][P2] Multi-report edit state corruption — ✏️ на B при активном A: добавлена очистка state предыдущего job перед перезаписью `pendingEdits` [src/bot.ts:714] ✓ fixed (external LLM)
- [x] [Review][Patch][P3] Пустая правка — добавлен reply «⚠️ Напиши что именно исправить.» [src/bot.ts:786-787] ✓ fixed
- [x] [Review][Patch][P3] AC#9: stub log поле `data` → `action` [src/bot.ts:763] ✓ fixed
- [x] [Review][Patch][P3] AC#11: добавлены `log.warn` в edit и reject job-not-found [src/bot.ts:702,740] ✓ fixed
- [x] [Review][Patch][P3] AC#8: `log.error` → `log.warn` для `bot.edit.failed` [src/bot.ts:838] ✓ fixed
- [x] [Review][Patch][P3] AC#6: instruction text дополнен примером «Конверсия 30%, не 28%» [src/bot.ts:720] ✓ fixed

#### Defer (отложить)

- [x] [Review][Defer] `applyEditToReport` нет AbortSignal / timeout — пользователь застревает на «⏳ Применяю правку…» при зависшем Claude [src/f1-report.ts:1389] — deferred → Story 1.9 timeout infrastructure
- [x] [Review][Defer] `applyEditToReport` нет `stop_reason` проверки — молчаливая обрезка отчёта при `max_tokens: 2000` exceeded [src/f1-report.ts:1428] — deferred → Story 1.9 enhancement
- [x] [Review][Defer] `appendApproval` failure: `approvalStatus='approved'` в памяти, но нет записи на диске — состояние рассинхронизировано после рестарта [src/bot.ts:662,683] — deferred → Story 1.10 persistence
- [x] [Review][Defer] `isAlreadyApproved` определён но нигде не вызывается в approve handler [src/approvals.ts:26] — deferred → Story 1.10 (disk-level idempotency)
- [x] [Review][Defer] Старая approve-клавиатура остаётся на оригинальном сообщении после edit — два сообщения с кнопками на один job [src/bot.ts] — deferred → Story 1.7 UX polish
- [x] [Review][Defer] `pendingEdits` ключ по chatId — коллизия при нескольких авторизованных пользователях в одном чате [src/bot.ts:130] — deferred → MVP single-user deployment; Story 1.10
- [x] [Review][Defer] `completedJobs` нет TTL/expiry на старые одобрения — week-old отчёты остаются аппрувабельными [src/bot.ts:127] — deferred → Story 1.10 persistence
