import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyGuideBlockUpdates, captureGuideContext, hydrateGuideContext } from './guide-block-authoring';
import { createGuideSession } from './guide-review';
import { buildAuthoredGuideSnapshot } from './guide-cli';
import type { CodeGuideOutput } from '@plannotator/shared/guide';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const patch = 'diff --git a/main.ts b/main.ts\nnew file mode 100644\n--- /dev/null\n+++ b/main.ts\n@@ -0,0 +1,3 @@\n+start();\n+run();\n+end();\n';
const guide = (): CodeGuideOutput => ({ focused: true, title: 'Task lifecycle', intent: 'Run and stop a task', sections: [
  { title: 'Run the task', overview: 'Start, run, then stop.', diffs: [{ id: 'start', file: 'main.ts', summary: 'Start the task.', newRange: { start: 1, end: 1 } }] },
], unplacedFiles: [] });

function repository() {
  const cwd = mkdtempSync(join(tmpdir(), 'guide-blocks-')); dirs.push(cwd);
  execFileSync('git', ['init', '-q'], { cwd });
  writeFileSync(join(cwd, 'context.ts'), 'first\nsecond\nthird\n');
  execFileSync('git', ['add', 'context.ts'], { cwd });
  return cwd;
}

test('context uses repository bytes, rejects traversal and symlinks, and retains captured versions', () => {
  const cwd = repository();
  const output = guide();
  output.sections[0].diffs = [{ id: 'ctx', kind: 'context', file: 'context.ts', newRange: { start: 2, end: 3 }, source: 'invented' }];
  const snapshot = captureGuideContext(cwd)!;
  expect(hydrateGuideContext(output, snapshot).sections[0].diffs[0].source).toBe('second\nthird');
  writeFileSync(join(cwd, 'context.ts'), 'different\nsecond\nthird\n');
  expect(hydrateGuideContext(output, snapshot).sections[0].diffs[0].source).toBe('second\nthird');
  output.sections[0].diffs[0].newRange = { start: 1, end: 1 };
  expect(hydrateGuideContext(output, snapshot).sections[0].diffs[0].source).toBeUndefined();
  output.sections[0].diffs[0].file = '../secret';
  expect(hydrateGuideContext(output, snapshot).sections[0].diffs[0].source).toBeUndefined();
  symlinkSync('/etc/passwd', join(cwd, 'link'));
  execFileSync('git', ['add', 'link'], { cwd });
  expect(captureGuideContext(cwd)?.files.has('link')).toBe(false);
});

test('partial updates replace one stable block and reject cross-section moves atomically', () => {
  const original = guide();
  const updated = applyGuideBlockUpdates(original, [{ sectionIndex: 0, block: { id: 'start', file: 'main.ts', newRange: { start: 1, end: 3 } } }]);
  expect(updated.sections[0].diffs).toHaveLength(1);
  expect(original.sections[0].diffs[0].newRange?.end).toBe(1);
  original.sections.push({ title: 'Unchanged section', overview: 'Keep this', diffs: [] });
  expect(() => applyGuideBlockUpdates(original, [{ sectionIndex: 1, block: { id: 'start', file: 'main.ts' } }])).toThrow('belongs to section 0');
});

test('incomplete guides expose actionable coverage and can be completed by a CAS block update', async () => {
  const session = createGuideSession();
  const initial = await session.onJobComplete({ job: { id: 'g' }, meta: { finalOutput: JSON.stringify(guide()) }, changedFiles: ['main.ts'],
    launchReview: { rawPatch: patch, gitRef: 'HEAD', source: { kind: 'local', repo: 'test' } } });
  expect(initial.summary).toBeNull();
  expect(initial.error).toContain('main.ts');
  expect(session.getGuide('g')).toBeNull();
  const draft = session.getDraft('g')!;
  expect(draft.coverage.complete).toBe(false);
  expect(session.updateBlocks('g', draft.revision - 1, [])).toMatchObject({ status: 409 });
  session.saveReviewed('g', [true]);
  const result = session.updateBlocks('g', draft.revision, [{ sectionIndex: 0, block: { id: 'rest', file: 'main.ts', summary: 'Run, then end.', newRange: { start: 2, end: 3 } } }]);
  expect(result).toMatchObject({ ok: true, draft: { coverage: { complete: true } } });
  expect(session.getGuide('g')?.sections[0].diffs).toHaveLength(2);
  expect(session.getGuide('g')?.reviewed).toEqual([false]);
  const complete = session.getDraft('g')!;
  expect(session.updateBlocks('g', complete.revision, [{ sectionIndex: 0, block: { id: 'rest', file: 'main.ts', newRange: { start: 3, end: 3 } } }])).toMatchObject({ status: 422 });
  expect(session.getDraft('g')?.revision).toBe(complete.revision);
  expect(session.getGuide('g')).not.toBeNull();
});

test('authored guides enforce line coverage and allow repeated focused file excerpts', () => {
  const cwd = repository();
  const output = guide();
  expect(buildAuthoredGuideSnapshot(JSON.stringify(output), patch, { cwd })).toMatchObject({ ok: false });
  output.sections[0].diffs.push({ id: 'rest', file: 'main.ts', summary: 'Run and end.', newRange: { start: 2, end: 3 } });
  expect(buildAuthoredGuideSnapshot(JSON.stringify(output), patch, { cwd })).toMatchObject({ ok: true });
});


test('staged and commit context capture immutable blob versions instead of a later worktree', () => {
  const cwd = repository();
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'base'], { cwd });
  const committed = captureGuideContext(cwd, 'last-commit');
  writeFileSync(join(cwd, 'context.ts'), 'staged\n');
  execFileSync('git', ['add', 'context.ts'], { cwd });
  const staged = captureGuideContext(cwd, 'staged');
  writeFileSync(join(cwd, 'context.ts'), 'worktree\n');
  const output = guide();
  output.sections[0].diffs = [{ id: 'ctx', file: 'context.ts', kind: 'context', newRange: { start: 1, end: 1 } }];
  expect(hydrateGuideContext(output, committed).sections[0].diffs[0].source).toBe('first');
  expect(hydrateGuideContext(output, staged).sections[0].diffs[0].source).toBe('staged');
  expect(captureGuideContext(cwd, 'static-patch')).toBeUndefined();
});


test('manual repair cannot downgrade a newly generated guide to unbounded legacy whole files', async () => {
  const session = createGuideSession();
  const built = await session.buildCommand({ cwd: tmpdir(), patch, diffType: 'static-patch', config: { engine: 'claude' } });
  await session.onJobComplete({ job: { id: 'new', prompt: built.prompt }, meta: { finalOutput: 'broken JSON' }, changedFiles: ['main.ts'],
    launchReview: { rawPatch: patch, gitRef: 'HEAD', source: { kind: 'local', repo: 'test' } } });
  const legacy = { title: 'Legacy', intent: 'Bypass', sections: [{ title: 'All', overview: 'Everything.', diffs: [{ file: 'main.ts' }] }] };
  expect(session.submitManualOutput('new', JSON.stringify(legacy), ['main.ts'])).toMatchObject({ error: expect.stringContaining('focused blocks') });
  expect(session.getGuide('new')).toBeNull();
});
