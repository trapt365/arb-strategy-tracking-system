/**
 * F0 Story 7.1/7.2 smoke: артефакты стратегии (md/txt/docx/pdf) → черновик онбординга.
 *
 * Использование:
 *   npx tsx scripts/f0-smoke.ts <файл> [<файл2> …] [--no-claude]
 *
 * --no-claude: только извлечение текста + сборка промпта (offline, без API-ключей).
 *
 * Эталоны (WSL):
 *   "/mnt/c/Users/Timur/Downloads/GeOnline OKR Framework 2026.pdf"
 *   "/mnt/c/Users/Timur/Documents/Vault1/SAM итоговый протокол стратегической сессии 08 и 09 января.md"
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { extractTextFromDocument } from '../src/utils/f0-document.js';

function mimeFor(name: string): string | undefined {
  const n = name.toLowerCase();
  if (n.endsWith('.pdf')) return 'application/pdf';
  if (n.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (n.endsWith('.md') || n.endsWith('.markdown')) return 'text/markdown';
  return 'text/plain';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const noClaude = args.includes('--no-claude');
  const files = args.filter((a) => !a.startsWith('--'));
  if (files.length === 0) {
    console.error('usage: npx tsx scripts/f0-smoke.ts <файл> [<файл2> …] [--no-claude] [--okr-only]');
    process.exit(2);
  }

  const docs: { sourceName: string; text: string }[] = [];
  for (const filePath of files) {
    const sourceName = basename(filePath);
    const buf = readFileSync(filePath);
    const extracted = await extractTextFromDocument(buf, sourceName, mimeFor(sourceName));
    docs.push({ sourceName, text: extracted.text });
    console.log(`[f0-smoke] ${sourceName}: kind=${extracted.kind}, bytes=${buf.length}, chars=${extracted.text.length}`);
  }

  const combined = docs.map((d) => `===== Файл: ${d.sourceName} =====\n\n${d.text}`).join('\n\n');
  const sourceName = docs.map((d) => d.sourceName).join(', ');

  if (noClaude) {
    const { loadPrompt } = await import('../src/utils/prompt-loader.js');
    const { sanitizeStrategyDocText } = await import('../src/utils/f0-input.js');
    const prompt = await loadPrompt('f0-full-extraction', {
      documentText: sanitizeStrategyDocText(combined, sourceName),
    });
    console.log(`[f0-smoke] prompt (f0-full-extraction) assembled: ${prompt.length} chars (--no-claude)`);
    console.log('[f0-smoke] PASS');
    return;
  }

  const startedAt = Date.now();
  const { runF0FullDraft, renderF0FullDraftMessage } = await import('../src/f0-onboarding.js');
  const result = await runF0FullDraft({ documentText: combined, sourceName });
  const durationSec = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `[f0-smoke] ${result.extraction.objectives.length} obj, ${result.totalKrs} KR (🔴${result.krIssues.length}), ` +
      `${result.extraction.hypotheses.length} гипотез (🔴без метрики ${result.hypothesisIssues.length}, ` +
      `синтез ${result.extraction.hypotheses.filter((h) => h.synthesized).length}), ` +
      `${result.extraction.participants.length} участников, ${durationSec}s`,
  );
  console.log('──────── черновик онбординга ────────');
  console.log(
    renderF0FullDraftMessage({
      extraction: result.extraction,
      krIssues: result.krIssues,
      hypothesisIssues: result.hypothesisIssues,
      sourceName,
      draftId: 'smoke000',
    }),
  );
  console.log('──────────────────────────────────────');
  if (durationSec > 15 * 60) {
    console.error('[f0-smoke] FAIL: дольше 15 минут (AC #1)');
    process.exit(1);
  }
  console.log('[f0-smoke] PASS');
}

main().catch((err) => {
  console.error('[f0-smoke] FAIL:', err);
  process.exit(1);
});
