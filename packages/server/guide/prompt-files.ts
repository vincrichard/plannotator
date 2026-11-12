import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPlannotatorDataDir } from '@plannotator/shared/data-dir';

/** Read at generation time so editing a prompt does not require a server restart. */
export function loadGuidePrompt(name: 'guided-review' | 'block-repair' | 'json-repair', fallback: string): string {
  try {
    return readFileSync(join(getPlannotatorDataDir(), 'review_prompts', `${name}.md`), 'utf8').trim() || fallback;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}
