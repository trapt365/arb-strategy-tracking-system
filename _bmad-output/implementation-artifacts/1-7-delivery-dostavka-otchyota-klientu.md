# Story 1.7: Delivery — доставка отчёта клиенту

Status: done

## Пользовательская история

Как **коуч практики (Азиза)**,
Я хочу **чтобы после одобрения отчёта бот подготовил текст для пересылки топу от моего имени**,
Чтобы **pipeline был невидим для клиента, а топ получал отчёт от трекера (ADR-004)**.

## Контекст и границы scope

**Эта история** добавляет delivery step после approval из Story 1.6. Когда Азиза нажимает [✅ Подтвердить → Жанель], бот помимо записи в `approvals.jsonl` (1.6) теперь:

1. Отправляет **delivery-сообщение** — форматированный блок текста, который Азиза может переслать или скопировать топу.
2. Отправляет **plain-text блок «📱 Для {Name}»** (из `topMessageDraft`) — 3-5 строк без Markdown, оптимизированный для копирования в WhatsApp.
3. Активирует кнопку **[📝 Уточнение]** — отправляет follow-up correction к уже доставленному отчёту.
4. Обновляет **commitment lifecycle emojis** (🔵→🟡/🟢/🔴) в рендеринге на основе поля `status` в `Commitment`.
5. Переводит статус отчёта: `approved → delivered`.

**Архитектурный принцип (ADR-004):** Бот НЕ отправляет ничего клиенту напрямую. Азиза получает готовый текст и пересылает его самостоятельно. Pipeline невидим для клиента.

**Что входит в Story 1.7 (production-код в `src/`):**

- **`src/utils/telegram-formatter.ts`** — обновить `renderCommitment` для lifecycle emojis; добавить `formatDeliveryForForwarding(report)` для чистого forwarding-формата; добавить `formatTopMessagePlainText(topName, draft)` для WhatsApp plain-text.
- **`src/bot.ts`** — изменить approve handler: после approval отправить delivery-блок + plain-text блок; обновить `post_note` stub на рабочий handler для уточнений; добавить `post_detail` stub с пояснением; добавить `job.approvalStatus = 'delivered'` после успешной доставки; добавить retry-кнопку `[🔄 Повторить]` при ошибке доставки.
- **`src/types.ts`** — расширить `approvalStatus` enum: добавить `'delivered'`; добавить `deliveryMessageIds?: number[]` на `ReportJob` для отслеживания delivery-сообщений.

**Что НЕ входит (следующие stories):**

- **Commitment lifecycle SOURCE data** — данные lifecycle (🟡/🟢/🔴) зависят от `commitments-history.ts` и `commitments_status_updates` из F1 Step 2 (analysis). Story 1.7 только рендерит emoji на основе существующего поля `status` в `CommitmentSchema` (уже `'open' | 'completed' | 'overdue' | undefined`). **Историческое сравнение** (предыдущая неделя vs текущая) — Story 1.10.
- **Persistence** на диск для delivered status — Story 1.10.
- **Undo delivery** — не предусмотрен. Азиза контролирует момент пересылки вручную.
- **Авто-delivery (прямая отправка клиенту от бота)** — Growth (при 5+ клиентах). ADR-004.
- **F3-lite delivery** — Epic 4.
- **[🔗 Подробнее]** — полная функциональность (ссылка на Docs/Sheets reference layer) — Story 1.13. На 1.7 расширяем stub: popup «Скоро доступно 🔜».
- **Old approve keyboard cleanup** после edit+re-approve — deferred из Story 1.6 review.

**Контракт с Story 1.6:**

```typescript
// Story 1.6 уже устанавливает при approve:
// job.approvalStatus = 'approved'
// job.lastReportText = текст отчёта (MarkdownV2)
// appendApproval() записан в approvals.jsonl
// buildPostApproveKeyboard(jobId) → [📝 Уточнение] [🔗 Подробнее]

// Story 1.7 ПОСЛЕ approve добавляет:
// 1. Delivery сообщение (forwarding-ready отчёт)
// 2. Plain-text блок для WhatsApp
// 3. job.approvalStatus = 'delivered' (после успешной отправки delivery)
// 4. job.deliveryMessageIds = [msgId1, msgId2, ...] (для retry/tracking)

// Story 1.7 ИЗМЕНЯЕТ post_note handler:
// Старый: stub → "Скоро доступно 🔜"
// Новый: prompt "Напиши уточнение" → reply → бот рендерит follow-up сообщение
```

## Критерии приёмки

1. **Сценарий: delivery-сообщение отправляется после approve** (FR / [epics.md: Story 1.7, AC #1])
   ```
   Дано Азиза нажала [✅ Подтвердить → Жанель]
   И job.approvalStatus === 'approved' (Story 1.6 approve handler)
   Когда approve handler завершает запись в approvals.jsonl
   Тогда бот отправляет delivery-блок: formatted report text (MarkdownV2)
     с emoji-type + трёхуровневый header (📋 Name │ Topic │ Week)
     + max 3 секции + commitments с lifecycle emoji
   И сразу после — plain-text блок «📱 Для {topName}:» (без MarkdownV2, plain text)
     из topMessageDraft (3-5 строк для WhatsApp copy-paste)
   И job.approvalStatus переходит: 'approved' → 'delivered'
   И job.deliveryMessageIds содержит message_id доставленных сообщений
   И log.info({ step:'bot.delivery.completed', jobId, topName })
   ```

2. **Сценарий: commitment lifecycle emojis** (FR / [epics.md: Story 1.7, AC commitments lifecycle])
   ```
   Дано отчёт содержит commitments с полем status
   Когда рендеринг commitments для delivery
   Тогда status undefined или 'open' → 🔵 Новое
   И status 'completed' → 🟢 Выполнено
   И status 'overdue' → 🔴 Просрочено
   И каждый emoji дублируется текстовой меткой: не "🔵", а "🔵 Новое"
   ```

3. **Сценарий: plain-text блок для WhatsApp** (UX / [ux-design-specification.md, line 99])
   ```
   Дано topMessageDraft существует и не пустой
   Когда delivery-блок отправлен
   Тогда следующее сообщение — plain text (parse_mode отсутствует):
     "📱 Для {topName}:\n{topMessageDraft}"
   И текст можно скопировать и вставить в WhatsApp без артефактов форматирования
   И длина ≤ 500 символов (3-5 строк)
   ```

4. **Сценарий: topMessageDraft отсутствует** (resilience)
   ```
   Дано topMessageDraft === undefined или пустой
   Когда delivery-блок отправлен
   Тогда plain-text блок для WhatsApp НЕ отправляется
   И delivery считается успешным (topMessageDraft опционален)
   ```

5. **Сценарий: delivery сообщение > 4096 символов** (FR / [epics.md: Story 1.7, AC #2])
   ```
   Дано delivery text > 4096 символов
   Когда delivery отправляется
   Тогда split на 2+ сообщений с header «📋 Name (продолжение)»
   И все message_id сохранены в job.deliveryMessageIds
   ```

6. **Сценарий: delivery failure — retry кнопка** (FR / [epics.md: Story 1.7, AC #3])
   ```
   Дано Telegram API error при отправке delivery
   Когда error caught
   Тогда ctx.reply: "⚠️ Не доставлено. Попробуй ещё раз."
     с InlineKeyboard: [🔄 Повторить] (callback_data: retry_delivery:{jobId})
   И job.approvalStatus остаётся 'approved' (не 'delivered')
   И log.warn({ step:'bot.delivery.failed', jobId, error })
   И alertOps WARN если это 2-й подряд failure
   ```

7. **Сценарий: retry delivery** (FR)
   ```
   Дано Азиза нажимает [🔄 Повторить]
   Когда retry_delivery callback получен
   Тогда повторная попытка отправки delivery-блока
   И при успехе: job.approvalStatus = 'delivered'
   И при повторной ошибке: снова "⚠️ Не доставлено. [🔄 Повторить]"
   ```

8. **Сценарий: [📝 Уточнение] — follow-up correction** (UX / [ux-design-specification.md, line 183])
   ```
   Дано job.approvalStatus === 'delivered'
   Когда Азиза нажимает [📝 Уточнение]
   Тогда bot.answerCallbackQuery: ""
   И ctx.reply: "📝 Напиши уточнение для {topName}. Ответь на это сообщение."
   И pendingNotes.set(chatId, { jobId, instructionMessageId })

   Затем Азиза ОТВЕЧАЕТ (reply) с текстом уточнения
   Когда handler проверяет pendingNotes
   Тогда бот отправляет: "📝 Уточнение к отчёту {topName}:\n{correction text}"
     как plain text (для WhatsApp forwarding)
   И log.info({ step:'bot.post_note.sent', jobId })
   И pendingNotes.delete(chatId)
   ```

9. **Сценарий: [📝 Уточнение] до delivery (еще approved, не delivered)** (edge case)
   ```
   Дано job.approvalStatus === 'approved' (delivery не произошёл)
   Когда Азиза нажимает [📝 Уточнение]
   Тогда bot.answerCallbackQuery: "ℹ️ Сначала дождись доставки отчёта." (popup)
   ```

10. **Сценарий: [🔗 Подробнее] остаётся stub** (Story 1.13 scope)
    ```
    Дано Азиза нажимает [🔗 Подробнее]
    Когда callback получен
    Тогда bot.answerCallbackQuery: "Скоро доступно 🔜" (popup, как в 1.6)
    ```

11. **Сценарий: double-tap на delivery retry** (defensive)
    ```
    Дано job.approvalStatus === 'delivered' (delivery уже успешен)
    Когда Азиза нажимает [🔄 Повторить] (старая кнопка)
    Тогда bot.answerCallbackQuery: "ℹ️ Уже доставлено." (popup)
    ```

12. **Сценарий: partial report — нет delivery** (архитектурное ограничение)
    ```
    Дано отчёт partial === true
    Когда approve flow (partial отчёт не получает approve-кнопки — Story 1.5/1.6)
    Тогда delivery flow не вызывается (нет approve → нет delivery)
    ```

## Задачи / Подзадачи

- [x] **Задача 1: `src/types.ts` — расширить approvalStatus + deliveryMessageIds** (КП: #1, #6)
  - [x] 1.1 Расширить `approvalStatus` enum:
    ```typescript
    approvalStatus: z.enum(['approved', 'editing', 'rejected', 'delivered']).optional(),
    ```
  - [x] 1.2 Добавить `deliveryMessageIds` на `ReportJobSchema`:
    ```typescript
    deliveryMessageIds: z.array(z.number().int()).optional(),
    ```
    Поле опционально — не ломает существующие тесты.

- [x] **Задача 2: `src/utils/telegram-formatter.ts` — commitment lifecycle + delivery formatting** (КП: #2, #3, #4)
  - [x] 2.1 Обновить `renderCommitment(c: Commitment)` — lifecycle emoji на основе `c.status`:
    ```typescript
    function commitmentEmoji(status: Commitment['status']): string {
      switch (status) {
        case 'completed': return '🟢 Выполнено';
        case 'overdue':   return '🔴 Просрочено';
        case 'open':
        default:          return '🔵 Новое';
      }
    }

    function renderCommitment(c: Commitment): string {
      const emoji = commitmentEmoji(c.status);
      const who = escapeMarkdownV2(c.who);
      const what = escapeMarkdownV2(c.what);
      const deadline = c.deadline.trim().length > 0 ? `, до ${escapeMarkdownV2(c.deadline)}` : '';
      const quote = c.quote.trim().length > 0 ? ` \\— _${escapeMarkdownV2(c.quote)}_` : '';
      return `${emoji}: ${who} → ${what}${deadline}${quote}`;
    }
    ```
    **ВАЖНО:** `renderCommitments` header тоже обновить — убрать хардкод `🔵`:
    ```typescript
    // Было: return ['🔵 *Commitments:*', ...lines].join('\n');
    // Стало:
    return ['*Commitments:*', ...lines].join('\n');
    ```
  - [x] 2.2 Добавить `formatDeliveryPlainText(report)` — plain-text версия отчёта без MarkdownV2 для forwarding-копирования:
    ```typescript
    /**
     * Plain-text delivery format for Telegram forwarding.
     * No MarkdownV2 escaping — Aziza forwards this message to the top manager.
     */
    export function formatDeliveryPlainText(
      report: Extract<DeliveryReadyReport, { partial: false }>,
    ): string {
      const parts: string[] = [];
      const topic = report.department ?? 'Отчёт';
      const period = report.weekNumber ? `Нед. ${report.weekNumber}` : '—';
      parts.push(`📋 ${report.topName} │ ${topic} │ ${period}`);
      parts.push(report.summaryLine);

      for (const section of report.sections) {
        parts.push(`\n${section.title}\n${section.content}`);
      }

      if (report.commitments.length > 0) {
        const commitLines = report.commitments.map((c) => {
          const emoji = commitmentEmojiPlain(c.status);
          const deadline = c.deadline.trim() ? `, до ${c.deadline}` : '';
          return `${emoji}: ${c.who} → ${c.what}${deadline}`;
        });
        parts.push(`\nCommitments:\n${commitLines.join('\n')}`);
      }

      return parts.join('\n');
    }
    ```
  - [x] 2.3 Добавить `formatTopMessagePlainText(topName, draft)`:
    ```typescript
    export function formatTopMessagePlainText(topName: string, draft: string): string {
      return `📱 Для ${topName}:\n${draft}`;
    }
    ```
  - [x] 2.4 Тесты:
    - `renderCommitment` с `status: 'completed'` → содержит `🟢 Выполнено`.
    - `renderCommitment` с `status: 'overdue'` → содержит `🔴 Просрочено`.
    - `renderCommitment` с `status: undefined` → содержит `🔵 Новое`.
    - `formatDeliveryPlainText` — plain text, без `\\` escape chars.
    - `formatTopMessagePlainText` — формат `📱 Для {Name}:\n{text}`.

- [x] **Задача 3: `src/bot.ts` — delivery после approve + retry** (КП: #1, #5, #6, #7)
  - [x] 3.1 Импортировать новые функции:
    ```typescript
    import {
      formatDeliveryReport,
      formatDeliveryPlainText,
      formatTopMessagePlainText,
      splitForTelegram,
      TELEGRAM_SAFE_MARGIN,
      escapeMarkdownV2,
    } from './utils/telegram-formatter.js';
    ```
  - [x] 3.2 Добавить `deliverReport(job)` helper в scope `createBot`:
    ```typescript
    /**
     * Send delivery-ready messages after approval.
     * Returns true if delivery succeeded, false otherwise.
     */
    async function deliverReport(job: ReportJob): Promise<boolean> {
      // Нужен formattedReport из completedJobs context.
      // job.lastReportText — MarkdownV2 текст отчёта (Set in Story 1.5/1.6).
      // Delivery: отправить lastReportText как forwarding-ready сообщение.

      const messageIds: number[] = [];
      const continuation = `📋 ${escapeMarkdownV2(job.topName)} \\(продолжение\\)`;
      const parts = splitForTelegram(job.lastReportText ?? '', TELEGRAM_SAFE_MARGIN, continuation);

      for (let i = 0; i < parts.length; i++) {
        const sent = await bot.api.sendMessage(job.chatId, parts[i]!, {
          parse_mode: 'MarkdownV2',
        });
        messageIds.push(sent.message_id);
      }

      // Отправить plain-text блок для WhatsApp если topMessageDraft есть.
      // Нужен доступ к report object — через формирование из job context.
      // topMessageDraft хранится... в formattedReport, не на job.
      // Workaround: сохранить topMessageDraft на job в processJob.
      if (job.topMessageDraft && job.topMessageDraft.trim().length > 0) {
        const plainText = formatTopMessagePlainText(job.topName, job.topMessageDraft);
        const sent = await bot.api.sendMessage(job.chatId, plainText);
        messageIds.push(sent.message_id);
      }

      job.deliveryMessageIds = messageIds;
      job.approvalStatus = 'delivered';
      return true;
    }
    ```
  - [x] 3.3 В approve handler (после `appendApproval` и `log.info`), добавить delivery call:
    ```typescript
    // Deliver report to Aziza for forwarding.
    try {
      await deliverReport(job);
      log.info({ step: 'bot.delivery.completed', jobId, topName: job.topName }, 'delivery sent');
    } catch (err) {
      log.warn({ err, jobId }, 'bot.delivery.failed');
      await ctx.reply('⚠️ Не доставлено. Попробуй ещё раз.', {
        reply_markup: new InlineKeyboard().text('🔄 Повторить', `retry_delivery:${jobId}`),
      });
    }
    ```
  - [x] 3.4 Добавить `bot.callbackQuery(/^retry_delivery:/, ...)` handler:
    ```typescript
    bot.callbackQuery(/^retry_delivery:(.+)$/, async (ctx) => {
      const jobId = ctx.match[1]!;
      const job = peekJob(jobId);

      if (job === undefined) {
        await ctx.answerCallbackQuery({ text: 'ℹ️ Отчёт уже недоступен.' });
        return;
      }
      if (job.approvalStatus === 'delivered') {
        await ctx.answerCallbackQuery({ text: 'ℹ️ Уже доставлено.' });
        return;
      }

      await ctx.answerCallbackQuery();

      try {
        await deliverReport(job);
        log.info({ step: 'bot.delivery.retry.completed', jobId }, 'delivery retry succeeded');
      } catch (err) {
        log.warn({ err, jobId }, 'bot.delivery.retry.failed');
        await ctx.reply('⚠️ Не доставлено. Попробуй ещё раз.', {
          reply_markup: new InlineKeyboard().text('🔄 Повторить', `retry_delivery:${jobId}`),
        });
        alertOps({
          pipeline: 'F1',
          step: 'bot.delivery.retry.failed',
          clientId: job.clientId,
          error: err,
          context: { jobId },
        });
      }
    });
    ```

- [x] **Задача 4: `src/bot.ts` — сохранить topMessageDraft на job** (КП: #3, #4)
  - [x] 4.1 В `src/types.ts` добавить `topMessageDraft` на `ReportJobSchema`:
    ```typescript
    topMessageDraft: z.string().optional(),
    ```
  - [x] 4.2 В `processJob`, после `const text = formatDeliveryReport(result.formattedReport)`:
    ```typescript
    // Preserve topMessageDraft for delivery step (Story 1.7).
    if (!result.formattedReport.partial && result.formattedReport.topMessageDraft) {
      job.topMessageDraft = result.formattedReport.topMessageDraft;
    }
    ```
    **ВАЖНО:** `result.formattedReport` — `DeliveryReadyReport`. Для non-partial, `topMessageDraft` доступен. Сохраняем на job чтобы delivery helper мог использовать без доступа к `result`.

- [x] **Задача 5: `src/bot.ts` — [📝 Уточнение] handler** (КП: #8, #9)
  - [x] 5.1 Добавить state `pendingNotes`:
    ```typescript
    interface PendingNote { jobId: string; instructionMessageId: number }
    const pendingNotes = new Map<number, PendingNote>();
    ```
  - [x] 5.2 Заменить stub `post_note` handler:
    ```typescript
    bot.callbackQuery(/^post_note:(.+)$/, async (ctx) => {
      const jobId = ctx.match[1]!;
      const job = peekJob(jobId);

      if (job === undefined) {
        await ctx.answerCallbackQuery({ text: 'ℹ️ Отчёт уже недоступен.' });
        return;
      }
      // Уточнение доступно только после delivery.
      if (job.approvalStatus !== 'delivered') {
        await ctx.answerCallbackQuery({ text: 'ℹ️ Сначала дождись доставки отчёта.' });
        return;
      }

      await ctx.answerCallbackQuery();

      const sent = await ctx.reply(
        `📝 Напиши уточнение для ${job.topName}. Ответь на это сообщение.`,
      );
      pendingNotes.set(job.chatId, { jobId, instructionMessageId: sent.message_id });
      log.info({ step: 'bot.post_note.started', jobId }, 'note flow started');
    });
    ```
  - [x] 5.3 Обновить `post_detail` — оставить stub отдельно:
    ```typescript
    bot.callbackQuery(/^post_detail:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery({ text: 'Скоро доступно 🔜' });
      log.info({ step: 'bot.post_approve.stub', action: ctx.callbackQuery.data }, 'stub handler');
    });
    ```
    **ВАЖНО:** Разбить единый `post_(note|detail)` regex на два отдельных handler'а.
  - [x] 5.4 В `bot.on('message:text')` handler — добавить проверку `pendingNotes` ПЕРЕД существующей проверкой `pendingEdits`:
    ```typescript
    // Check pendingNotes first (post-delivery corrections).
    const note = pendingNotes.get(chatId);
    if (note !== undefined) {
      const replyToId = ctx.message.reply_to_message?.message_id;
      if (replyToId === undefined) return; // Не reply — игнор.
      if (replyToId !== note.instructionMessageId) {
        // Reply на другое сообщение — пропустить (может быть edit reply).
        // Не блокировать — fallthrough к pendingEdits.
      } else {
        const job = peekJob(note.jobId);
        if (job === undefined) {
          pendingNotes.delete(chatId);
          await ctx.reply('ℹ️ Отчёт уже недоступен.');
          return;
        }
        const correction = ctx.message.text.trim();
        if (!correction) return;

        pendingNotes.delete(chatId);
        const noteText = `📝 Уточнение к отчёту ${job.topName}:\n${correction}`;
        await ctx.reply(noteText); // plain text, для WhatsApp forwarding.
        log.info(
          { step: 'bot.post_note.sent', jobId: note.jobId, len: correction.length },
          'note sent',
        );
        return;
      }
    }
    ```
    **ВАЖНО:** Если reply не на note instruction — НЕ return, fallthrough к pendingEdits проверке. Порядок: pendingNotes → pendingEdits → ignore.

- [x] **Задача 6: Тесты `src/bot.test.ts` — delivery flow** (КП: #1–#12)
  - [x] 6.1 Delivery после approve:
    - Simulate approve callback → verify `sendMessage` вызван с delivery текстом после approve сообщения.
    - Verify `job.approvalStatus === 'delivered'`.
    - Verify `job.deliveryMessageIds` содержит message_id.
  - [x] 6.2 Plain-text WhatsApp блок:
    - Job с `topMessageDraft` → verify отдельный `sendMessage` без `parse_mode` с текстом «📱 Для {Name}».
    - Job без `topMessageDraft` → verify только один delivery-блок, без plain-text.
  - [x] 6.3 Delivery failure + retry:
    - Mock `sendMessage` throw → verify "⚠️ Не доставлено. [🔄 Повторить]".
    - Simulate `retry_delivery:{jobId}` callback → verify повторная доставка.
  - [x] 6.4 Post-note flow:
    - Simulate `post_note:{jobId}` callback (job delivered) → verify instruction message.
    - Simulate reply → verify plain-text note sent.
    - Simulate `post_note:{jobId}` callback (job approved, not delivered) → verify popup "Сначала дождись доставки".
  - [x] 6.5 Commitment lifecycle:
    - Отчёт с `status: 'completed'` commitment → delivery содержит `🟢 Выполнено`.
    - Отчёт с `status: 'overdue'` commitment → delivery содержит `🔴 Просрочено`.
  - [x] 6.6 Double-tap retry после success → "ℹ️ Уже доставлено."

- [x] **Задача 7: Регрессия — все 236 существующих тестов** (КП: backward compat)
  - [x] 7.1 `npm test` → все 236+ тестов зелёные.
  - [x] 7.2 `npx tsc --noEmit` → no errors.
  - [x] 7.3 Проверить что `renderCommitment` lifecycle emoji не ломает существующие тесты `telegram-formatter.test.ts`.
    - **ВАЖНО:** Существующие тесты используют фикстуры с `status: undefined` (или без status). Все должны рендерить `🔵 Новое` (backward compatible).
    - Проверить `formatFullDeliveryReport` тесты — header `Commitments:` может измениться (был `🔵 *Commitments:*`).

- [x] **Задача 8: Sprint status + Dev Agent Record** (finalize)
  - [x] 8.1 Обновить `sprint-status.yaml`: `1-7-delivery-dostavka-otchyota-klientu: backlog → ready-for-dev`.
  - [x] 8.2 Обновить story file status lifecycle: `ready-for-dev` → `in-progress` → `review`.
  - [x] 8.3 Заполнить Dev Agent Record.

### Review Findings

- [x] [Review][Patch] `retry_delivery` can bypass approval and deliver an unapproved report [`src/bot.ts:843`] — fixed: retry now requires `approvalStatus === 'approved'`.
- [x] [Review][Patch] Delivered reports can still be moved back into edit flow via stale edit callbacks [`src/bot.ts:766`] — fixed: edit now treats `delivered` as already confirmed.
- [x] [Review][Patch] WhatsApp plain-text block does not enforce the 500-character acceptance limit [`src/utils/telegram-formatter.ts:229`] — fixed: full WhatsApp block is capped at 500 chars.

## Dev Notes

### Соответствие архитектуре

- **ADR-004 (F3-lite delivery — ручная отправка):** Применяется и к F1: бот НЕ отправляет клиенту напрямую. Бот отправляет Азизе delivery-ready текст, Азиза пересылает сама. Никакого direct messaging с top managers.
- **Два формата delivery** (architecture#Telegram UX): (1) MarkdownV2 formatted report для Telegram forwarding, (2) plain-text «📱 Для {Name}» блок для WhatsApp copy-paste. Оба отправляются Азизе.
- **Callback data формат** (architecture#Format Patterns): `retry_delivery:reportId`, `post_note:reportId`, `post_detail:reportId`. Существующие `approve:`, `edit:`, `reject:` — не трогать.
- **InlineKeyboard только в `bot.ts`** — delivery helpers в `telegram-formatter.ts` возвращают только текст, без grammY imports.
- **Whitelist middleware** (architecture#Authentication): retry и post_note callbacks защищены тем же whitelist из Story 1.5.
- **No silent catches**: delivery failure → alertOps при повторном failure; log.warn при каждом.
- **Never silent rule** (UX-DR39): delivery error → reply с retry кнопкой.
- **Commitment lifecycle** (UX spec, line 474): `🔵 Новое`, `🟡 В работе`, `🟢 Выполнено`, `🔴 Просрочено`. **НО**: CommitmentSchema имеет `status: 'open' | 'completed' | 'overdue' | undefined`. Нет значения `'in_progress'` — на MVP маппинг: open/undefined → 🔵, completed → 🟢, overdue → 🔴. `🟡 В работе` — Growth (когда commitments-history добавит отслеживание прогресса, Story 1.10).

### Source tree (изменения)

| Файл | Действие | ~LOC |
|------|----------|------|
| `src/types.ts` | добавить `'delivered'` в enum, `deliveryMessageIds`, `topMessageDraft` | ~5 |
| `src/utils/telegram-formatter.ts` | обновить `renderCommitment` + lifecycle; добавить `formatDeliveryPlainText`, `formatTopMessagePlainText`; обновить header `Commitments:` | ~50 |
| `src/utils/telegram-formatter.test.ts` | тесты lifecycle emoji, plain text formatting | ~30 |
| `src/bot.ts` | `deliverReport` helper; delivery в approve handler; retry_delivery handler; split post_note/post_detail; pendingNotes state; message:text update | ~80 |
| `src/bot.test.ts` | тесты delivery flow (6+ кейсов) | ~80 |

### Testing Standards

- **Delivery тесты**: mock `bot.api.sendMessage` — проверить вызовы: (1) MarkdownV2 delivery, (2) plain text WhatsApp block, (3) retry message with keyboard.
- **pendingNotes тесты**: аналогично pendingEdits pattern из Story 1.6 — simulate callbackQuery + textReplyUpdate.
- **Commitment lifecycle тесты**: unit tests в `telegram-formatter.test.ts` — каждый status → правильный emoji.
- **НЕ вызывать `bot.start()` в тестах** — только `bot.handleUpdate(update)`.
- **Используй существующие helpers** из 1.6 тестов: `callbackUpdate`, `textReplyUpdate`, `runJobFromBot`.

### Контракты с другими stories

- **Story 1.6**: `approve` handler расширяется delivery step. `buildPostApproveKeyboard` не меняется. `post_note` regex разделяется от `post_detail`. `completedJobs` Map уже содержит approved jobs — delivery использует тот же lookup через `peekJob`.
- **Story 1.10 (persistence)**: `job.approvalStatus = 'delivered'` — in-memory на MVP. Story 1.10 добавит persistence. `deliveryMessageIds` — для future reference.
- **Story 1.13 (поиск отчётов)**: `[🔗 Подробнее]` — остаётся stub до 1.13.
- **Story 1.9 (ops/alerts)**: `alertOps` при повторном delivery failure. Расширение alertOps — Story 1.9.

### LLM-Dev-Agent Guardrails

- **НЕ отправлять сообщения напрямую клиентам (top managers)** — только Азизе. ADR-004. Бот не знает chatId топов на MVP.
- **НЕ менять `renderFinalReport`** — delivery использует `job.lastReportText` (уже сохранённый в Story 1.6). Не дублировать рендеринг.
- **НЕ удалять `formatDeliveryReport`** и не менять его сигнатуру — он используется в `processJob` для первичного рендеринга. Delivery step использует `job.lastReportText` (результат `formatDeliveryReport`).
- **НЕ хранить `pendingNotes` вне `createBot` scope** — closure pattern как pendingEdits.
- **НЕ менять approve handler порядок**: `approvalStatus = 'approved'` → `answerCallbackQuery` → `editMessageReplyMarkup` → `ctx.reply` подтверждение → `appendApproval` → delivery. Delivery — последний step.
- **Delivery failure НЕ отменяет approve**: если delivery fails, approve record уже записан. `approvalStatus` остаётся `'approved'` (не reverted). Retry повторяет только delivery.
- **`formatDeliveryPlainText` — отдельная функция от `formatFullDeliveryReport`**: plain text НЕ содержит MarkdownV2 escaping. Два разных формата для двух целей.
- **`message:text` handler — pendingNotes ПЕРЕД pendingEdits**: note reply checking идёт первым. Если reply не на note instruction — fallthrough к pendingEdits.
- **Commitment emoji change = breaking test change**: обновить фикстуры в `telegram-formatter.test.ts`. Старые тесты с `status: undefined` должны получить `🔵 Новое` вместо `🔵`.
- **НЕ `console.log`** — всегда pino logger: `{pipeline:'F1', step:'bot.delivery.*' | 'bot.post_note.*'}`.
- **ВСЕГДА `ctx.answerCallbackQuery()`** в callback handlers — без этого Telegram spinner бесконечный.
- **Plain text для WhatsApp** (📱 блок) — `parse_mode` НЕ указывать в `sendMessage`. Telegram по умолчанию отправит plain text.

### Previous Story Intelligence (Story 1.6)

**Ключевые паттерны из 1.6 для переиспользования:**
- `peekJob` для lookup в `queue + completedJobs` — delivery handler тоже использует `peekJob`.
- `pendingEdits` pattern: Map<chatId, { jobId, instructionMessageId }> — скопировать для `pendingNotes`.
- `bot.on('message:text')` handler уже обрабатывает `pendingEdits` — добавить `pendingNotes` check перед ним.
- `callbackUpdate` / `textReplyUpdate` helpers в тестах — переиспользовать для delivery тестов.
- MarkdownV2 fallback (retry без parse_mode на error 400) — применить и к delivery `sendMessage` если потребуется.

**Review findings из 1.6 (deferred items, relevant для 1.7):**
- [Defer] Старая approve-клавиатура остаётся на оригинальном сообщении после edit — два сообщения с кнопками на один job. **Решение в 1.7:** не исправлять — acknowledged as MVP limitation.
- [Defer] `pendingEdits` ключ по chatId — коллизия при нескольких авторизованных пользователях в одном чате. **Аналогично для `pendingNotes`** — MVP single-user deployment.

### Project Structure Notes

- Все изменения в существующих файлах (`src/bot.ts`, `src/types.ts`, `src/utils/telegram-formatter.ts`).
- Новых файлов НЕТ — delivery logic добавляется в `bot.ts` (оркестрация) и `telegram-formatter.ts` (форматирование). Соответствует architecture#Structure Patterns: «Pipeline flow — один файл».
- Пути: `src/utils/telegram-formatter.ts` (formatting), `src/bot.ts` (handlers), `src/types.ts` (schemas).

### References

- [Source: _bmad-output/planning-artifacts/epics.md, Story 1.7 — lines 672-699]
- [Source: _bmad-output/planning-artifacts/architecture.md#ADR-004 — ручная отправка]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md, line 93-99 — post-approve + WhatsApp]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md, line 183 — post-approve correction]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md, line 474 — commitment lifecycle 🔵🟡🟢🔴]
- [Source: _bmad-output/planning-artifacts/ux-design-specification.md, line 873 — delivery error UX]
- [Source: _bmad-output/planning-artifacts/architecture.md#Authentication — whitelist chat_id]
- [Source: _bmad-output/planning-artifacts/architecture.md#API & Communication Patterns — retry]
- [Source: src/bot.ts — approve handler (lines 650-700), post_note stub (lines 786-789)]
- [Source: src/utils/telegram-formatter.ts — renderCommitment (line 92), formatFullDeliveryReport (line 143)]
- [Source: src/types.ts — CommitmentSchema (line 99), ReportJobSchema, DeliveryReadyReportSchema]
- [Source: 1-6-approval-workflow-approve-edit-reject.md — контракт с Story 1.7]

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Debug Log References
- Все 256 тестов зелёные (vitest), typecheck clean (tsc --noEmit)
- 31 тест в telegram-formatter.test.ts (было 20, +11 новых для lifecycle emoji, plain text)
- 35 тестов в bot.test.ts (было 22, +13 новых для delivery flow)
- Исправлены 3 существующих теста Story 1.6 — адаптированы к delivery-after-approve (AC#3: approved→delivered, AC#9: post_note→post_detail stub)

### Completion Notes List
- ✅ Задача 1: Расширен `approvalStatus` enum: добавлен `'delivered'`; добавлены `deliveryMessageIds` и `topMessageDraft` на `ReportJobSchema`
- ✅ Задача 2: `renderCommitment` обновлён для lifecycle emoji (🔵 Новое / 🟢 Выполнено / 🔴 Просрочено) на основе `c.status`; убран hardcoded `🔵` из header `*Commitments:*`; добавлены `formatDeliveryPlainText` и `formatTopMessagePlainText`
- ✅ Задача 3: Добавлен `deliverReport(job)` helper; delivery call в approve handler после `appendApproval`; `retry_delivery` callback handler; handled double-tap ('delivered' → "Уже доставлено")
- ✅ Задача 4: `topMessageDraft` сохраняется на job в `processJob` из `result.formattedReport.topMessageDraft`
- ✅ Задача 5: Разделён `post_(note|detail)` regex на два отдельных handler'а; `post_note` — рабочий handler с `pendingNotes` state; `post_detail` — stub ("Скоро доступно 🔜"); `message:text` handler обновлён: pendingNotes → pendingEdits fallthrough
- ✅ Задача 6: 13 новых тестов в bot.test.ts — delivery after approve, WhatsApp plain-text block, delivery failure + retry, post_note flow, double-tap retry, commitment lifecycle in delivery
- ✅ Задача 7: 256/256 тестов зелёные, typecheck clean
- ✅ Задача 8: sprint-status.yaml и story file обновлены

### Change Log
- 2026-05-20: Story 1.7 delivery implementation complete — delivery after approve, commitment lifecycle emojis, WhatsApp plain-text block, retry_delivery handler, post_note handler, 256/256 tests pass

### File List
- `src/types.ts` — добавлен `'delivered'` в approvalStatus, `deliveryMessageIds`, `topMessageDraft`
- `src/utils/telegram-formatter.ts` — `commitmentEmoji`/`commitmentEmojiPlain`, обновлён `renderCommitment`/`renderCommitments`, добавлены `formatDeliveryPlainText`, `formatTopMessagePlainText`
- `src/utils/telegram-formatter.test.ts` — +11 тестов (lifecycle emoji, plain text formatting)
- `src/bot.ts` — `deliverReport` helper, delivery в approve handler, `retry_delivery` handler, `pendingNotes` state, `post_note` handler (split from stub), `post_detail` stub, `message:text` pendingNotes check, `topMessageDraft` preservation in processJob, `'delivered'` guard in approve
- `src/bot.test.ts` — +13 тестов (delivery flow), обновлены 3 существующих теста (AC#3, AC#9 адаптированы)
