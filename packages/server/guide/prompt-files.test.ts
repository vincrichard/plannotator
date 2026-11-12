import { test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeGuideMethodology, buildGuideRepairPrompt, GUIDE_REVIEW_PROMPT } from './guide-review';
import { guideBlockRepairPrompt } from './guide-block-authoring';

test('guide generation and both repair paths read edited files without caching or dropping their payloads', () => {
  const root = mkdtempSync(join(tmpdir(), 'plannotator-prompt-files-'));
  const previous = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = root;
  const directory = join(root, 'review_prompts');
  mkdirSync(directory);
  try {
    expect(composeGuideMethodology()).toBe(GUIDE_REVIEW_PROMPT);
    writeFileSync(join(directory, 'guided-review.md'), 'Use a lifecycle table.\n');
    expect(composeGuideMethodology('Explain cleanup.')).toContain('Use a lifecycle table.');
    expect(composeGuideMethodology('Explain cleanup.')).toContain('Explain cleanup.');
    writeFileSync(join(directory, 'guided-review.md'), 'Use a small diagram.');
    expect(composeGuideMethodology()).toBe('Use a small diagram.');
    writeFileSync(join(directory, 'json-repair.md'), 'Repair syntax only.');
    expect(buildGuideRepairPrompt('BROKEN_PAYLOAD')).toContain('Repair syntax only.');
    expect(buildGuideRepairPrompt('BROKEN_PAYLOAD')).toContain('BROKEN_PAYLOAD');
    writeFileSync(join(directory, 'block-repair.md'), 'Repair uncovered ranges only.');
    const guide = { focused: true, title: 'Feature', intent: 'Explain it', sections: [], unplacedFiles: [] };
    const prompt = guideBlockRepairPrompt(guide, [{ message: 'Missing lines 4–9' }]);
    expect(prompt).toContain('Repair uncovered ranges only.');
    expect(prompt).toContain('Missing lines 4–9');
    expect(prompt).toContain(JSON.stringify(guide));
    writeFileSync(join(directory, 'guided-review.md'), '\n');
    expect(composeGuideMethodology()).toBe(GUIDE_REVIEW_PROMPT);
  } finally {
    if (previous === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
