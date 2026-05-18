import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { F1PipelineError } from '../errors.js';

// Allow dots/hyphens/digits in placeholder keys (rejecting only `}` and whitespace);
// the old `[a-zA-Z_][a-zA-Z0-9_]*` form silently shipped `{{week-number}}` to Claude
// as literal text.
const PLACEHOLDER_RE = /\{\{([^}\s]+)\}\}/g;

export interface LoadPromptOpts {
  rootDir?: string;
}

export async function loadPrompt(
  name: string,
  vars: Record<string, string>,
  opts: LoadPromptOpts = {},
): Promise<string> {
  const dir = opts.rootDir ?? join(process.cwd(), 'prompts');
  const path = join(dir, `${name}.md`);
  let content: string;
  try {
    content = await fs.readFile(path, 'utf8');
  } catch (err) {
    throw new F1PipelineError(
      'prompt_load',
      { name, path, reason: 'read_failed' },
      { cause: err },
    );
  }

  // Validate types up-front: TS `Record<string, string>` doesn't enforce at runtime,
  // and an undefined coerced via `replaceAll` would silently inject the literal
  // string 'undefined' into the prompt.
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v !== 'string') {
      throw new F1PipelineError('prompt_load', {
        name,
        reason: 'non_string_var',
        key: k,
        type: typeof v,
      });
    }
  }

  // Single-pass substitution: prevents cross-substitution where a placeholder is
  // injected via a value (e.g. a transcript containing the literal text
  // "{{stakeholderMap}}") and then resolved by a later iteration.
  const unreplaced = new Set<string>();
  const out = content.replace(PLACEHOLDER_RE, (match, key: string) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return vars[key]!;
    }
    unreplaced.add(match);
    return match;
  });
  if (unreplaced.size > 0) {
    throw new F1PipelineError('prompt_load', {
      name,
      reason: 'unreplaced_vars',
      unreplaced: [...unreplaced],
      providedVars: Object.keys(vars),
    });
  }
  return out;
}
