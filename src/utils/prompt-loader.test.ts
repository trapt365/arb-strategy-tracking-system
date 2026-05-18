import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPrompt } from './prompt-loader.js';
import { F1PipelineError } from '../errors.js';

describe('loadPrompt', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'prompts-test-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('replaces {{vars}} in prompt template', async () => {
    await fs.writeFile(
      join(dir, 'extraction.md'),
      'Transcript:\n{{transcript}}\n\nMap:\n{{stakeholderMap}}',
      'utf8',
    );
    const result = await loadPrompt(
      'extraction',
      { transcript: 'foo', stakeholderMap: 'bar' },
      { rootDir: dir },
    );
    expect(result).toBe('Transcript:\nfoo\n\nMap:\nbar');
  });

  it('throws F1PipelineError(prompt_load) on missing file', async () => {
    await expect(
      loadPrompt('nonexistent', {}, { rootDir: dir }),
    ).rejects.toMatchObject({
      name: 'F1PipelineError',
      code: 'prompt_load',
      context: { reason: 'read_failed' },
    });
  });

  it('throws F1PipelineError on unreplaced variables', async () => {
    await fs.writeFile(
      join(dir, 'analysis.md'),
      '{{transcript}} {{missing}}',
      'utf8',
    );
    let captured: F1PipelineError | undefined;
    try {
      await loadPrompt('analysis', { transcript: 'x' }, { rootDir: dir });
    } catch (err) {
      captured = err as F1PipelineError;
    }
    expect(captured).toBeInstanceOf(F1PipelineError);
    expect(captured?.code).toBe('prompt_load');
    expect(captured?.context.reason).toBe('unreplaced_vars');
    expect(captured?.context.unreplaced).toEqual(['{{missing}}']);
  });

  it('replaces duplicate occurrences of the same key', async () => {
    await fs.writeFile(join(dir, 'p.md'), '{{x}} and {{x}} and {{x}}', 'utf8');
    const out = await loadPrompt('p', { x: 'A' }, { rootDir: dir });
    expect(out).toBe('A and A and A');
  });

  it('substitutes special characters as-is (cyrillic, JSON, escapes)', async () => {
    await fs.writeFile(join(dir, 'p.md'), 'Data: {{payload}}', 'utf8');
    const payload = JSON.stringify({ name: 'Жанель', items: [1, 2] }, null, 2);
    const out = await loadPrompt('p', { payload }, { rootDir: dir });
    expect(out).toContain('Жанель');
    expect(out).toContain('"items"');
    expect(out.match(/\{\{[a-zA-Z_]/g)).toBeNull();
  });
});
