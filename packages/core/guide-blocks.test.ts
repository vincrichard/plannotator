import { describe, expect, test } from 'bun:test';
import { parseDiffToFiles } from './diff-files';
import { analyzeGuideCoverage, resolveGuideBlock } from './guide-blocks';
import type { CodeGuideOutput, GuideDiffRef } from './guide';
import { validateGuideOutput, GUIDE_SCHEMA_JSON } from './guide-prompt';
import { buildGuideSnapshot, parseGuideSnapshot, createGuideHtml } from './guide-format';
import { FIXTURE_V1_FOCUSED } from './guide-format-fixtures';

function guide(...refs: GuideDiffRef[]): CodeGuideOutput {
  return { focused: true, title: 'Flow', intent: 'Explain the flow.', sections: [{ title: 'Run', overview: 'Do the work.', diffs: refs }] };
}
function addedFile(count: number) {
  return parseDiffToFiles(`diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,${count} @@\n${Array.from({ length: count }, (_, i) => `+line ${i + 1}`).join('\n')}\n`);
}
const modified = parseDiffToFiles(`diff --git a/run.ts b/run.ts
index abc..def 100644
--- a/run.ts
+++ b/run.ts
@@ -10,4 +10,5 @@
 before
-old one
-old two
+new one
+new two
+new three
 after
`);

describe('focused guide coverage', () => {
  test('900 added lines require multiple blocks, with exact missing ranges and unique coverage', () => {
    const files = addedFile(900);
    const full = analyzeGuideCoverage(guide({ id: 'all', file: 'new.ts' }), files);
    expect(full.complete).toBe(false);
    expect(full.coveredLines).toBe(900);
    expect(full.issues[0].code).toBe('oversized');
    expect(full.issues[0].message).toContain('250');
    const blocks = [1, 251, 501, 751].map(start => ({ id: `part-${start}`, file: 'new.ts', newRange: { start, end: Math.min(start + 249, 900) } }));
    const missing = analyzeGuideCoverage(guide(...blocks.slice(0, 3)), files);
    expect(missing.issues).toEqual([{ code: 'missing', file: 'new.ts', side: 'new', start: 751, end: 900, message: expect.stringContaining('751-900') }]);
    const complete = analyzeGuideCoverage(guide(...blocks, { ...blocks[0], id: 'repeated' }), files);
    expect(complete).toEqual({ complete: true, coveredLines: 900, totalLines: 900, issues: [] });
  });

  test('requires both deleted and added lines, unchanged quotes never fill a coverage gap', () => {
    const additions: GuideDiffRef = { id: 'new', file: 'run.ts', newRange: { start: 11, end: 13 } };
    const context: GuideDiffRef = { id: 'context', file: 'run.ts', kind: 'context', newRange: { start: 11, end: 13 }, source: 'new one\nnew two\nnew three' };
    const partial = analyzeGuideCoverage(guide(additions, context), modified);
    expect(partial.coveredLines).toBe(3);
    expect(partial.issues[0]).toMatchObject({ code: 'missing', side: 'old', start: 11, end: 12 });
    const complete = analyzeGuideCoverage(guide(additions, { id: 'old', file: 'run.ts', oldRange: { start: 11, end: 12 } }), modified);
    expect(complete.complete).toBe(true);
    expect(complete.totalLines).toBe(5);
  });

  test('oversized context reports the range and limit even before the server captures it', () => {
    const report = analyzeGuideCoverage(guide({ id: 'too-long', file: 'context.ts', kind: 'context', newRange: { start: 1, end: 251 } }), []);
    expect(report.issues[0]).toMatchObject({ code: 'oversized', start: 1, end: 251 });
    expect(report.issues[0].message).toContain('250');
  });

  test('metadata-only and binary files require an explicit block', () => {
    const files = parseDiffToFiles('diff --git a/a.png b/a.png\nBinary files a/a.png and b/a.png differ\ndiff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n');
    expect(analyzeGuideCoverage(guide(), files).issues).toHaveLength(2);
    expect(analyzeGuideCoverage(guide(...files.map(file => ({ id: file.path, file: file.path }))), files).complete).toBe(true);
  });

  test('duplicate block IDs are actionable, repeated source ranges with different IDs are valid', () => {
    const ref = { id: 'same', file: 'run.ts' };
    expect(analyzeGuideCoverage(guide(ref, ref), modified).issues[0]).toMatchObject({ code: 'invalid', blockId: 'same' });
  });
});

describe('focused patch slicing', () => {
  test('preserves source coordinates on interior additions and deletions', () => {
    const added = resolveGuideBlock({ file: 'run.ts', newRange: { start: 12, end: 13 } }, modified);
    if ('error' in added) throw new Error(added.error);
    expect(added.file.patch).toContain('@@ -12,0 +12,2 @@\n+new two\n+new three');
    expect(added.file.patch).not.toContain('old one');
    expect(added.file.path).toBe('run.ts');
    expect(added.displayedLines).toBe(2);
    const removed = resolveGuideBlock({ file: 'run.ts', oldRange: { start: 12, end: 12 } }, modified);
    if ('error' in removed) throw new Error(removed.error);
    expect(removed.file.patch).toContain('@@ -12,1 +10,0 @@\n-old two');
  });

  test('counts shared unchanged rows once and both sides of a replacement separately', () => {
    const resolved = resolveGuideBlock({ file: 'run.ts', oldRange: { start: 10, end: 13 }, newRange: { start: 10, end: 14 } }, modified);
    if ('error' in resolved) throw new Error(resolved.error);
    expect(resolved.displayedLines).toBe(7);
    expect(resolved.file.patch).toContain('@@ -10,4 +10,5 @@');
  });

  test('rejects invalid/outside-hunk ranges instead of widening to the whole file', () => {
    expect(resolveGuideBlock({ file: 'run.ts', newRange: { start: 0, end: 4 } }, modified)).toHaveProperty('error');
    expect(resolveGuideBlock({ file: 'run.ts', newRange: { start: 10, end: 50 } }, modified)).toHaveProperty('error');
    expect(resolveGuideBlock({ file: 'absent.ts' }, modified)).toHaveProperty('error');
  });

  test('context preserves line numbers, trailing blank selected lines and empty source lines', () => {
    const ref: GuideDiffRef = { id: 'entry', kind: 'context', file: 'other/entry.ts', newRange: { start: 50, end: 51 }, source: 'run();\n' };
    const block = resolveGuideBlock(ref, []);
    if ('error' in block) throw new Error(block.error);
    expect(block.file.patch).toContain('@@ -50,2 +50,2 @@\n run();\n \n');
    expect(block.displayedLines).toBe(2);
    expect(resolveGuideBlock({ ...ref, newRange: { start: 3, end: 3 }, source: '' }, [])).toHaveProperty('displayedLines', 1);
    expect(resolveGuideBlock({ ...ref, source: 'one line' }, [])).toHaveProperty('error');
  });

  test('preserves no-newline markers after the selected source line', () => {
    const files = parseDiffToFiles('diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n');
    const block = resolveGuideBlock({ file: 'f', newRange: { start: 1, end: 1 } }, files);
    if ('error' in block) throw new Error(block.error);
    expect(block.file.patch).toContain('+new\n\\ No newline at end of file');
    expect(block.displayedLines).toBe(1);
  });
});

describe('focused input and portable format', () => {
  test('keeps repeated ranges and context paths, strips generator-supplied source, never auto-fills missing files', () => {
    const input = guide(
      { id: 'first', file: 'run.ts', newRange: { start: 11, end: 11 } },
      { id: 'second', file: 'run.ts', newRange: { start: 12, end: 13 } },
      { id: 'context', kind: 'context', file: 'other.ts', newRange: { start: 1, end: 1 }, source: 'fabricated' },
    );
    const parsed = validateGuideOutput(input, ['run.ts', 'missing.ts']);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.guide.focused).toBe(true);
    expect(parsed.guide.sections[0].diffs).toHaveLength(3);
    expect(parsed.guide.sections[0].diffs[2].source).toBeUndefined();
    expect(parsed.guide.unplacedFiles).toBeUndefined();
    input.sections[0].diffs[0].newRange!.start = 0;
    expect(validateGuideOutput(input, ['run.ts'])).toHaveProperty('error');
  });

  test('schema requires focused blocks with stable IDs and forbids generator source text', () => {
    const schema = JSON.parse(GUIDE_SCHEMA_JSON);
    expect(schema.required).toContain('focused');
    const block = schema.properties.sections.items.properties.diffs.items;
    expect(block.required).toContain('id');
    expect(block.properties.source).toBeUndefined();
  });

  test('portable snapshots retain focused mode, coordinates and captured context', () => {
    const snapshot = buildGuideSnapshot({ guide: FIXTURE_V1_FOCUSED.guide, reviewed: [], review: { ...FIXTURE_V1_FOCUSED.review, source: FIXTURE_V1_FOCUSED.source } });
    const parsed = parseGuideSnapshot(snapshot);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.guide.focused).toBe(true);
    expect(parsed.value.guide.sections[0].diffs).toEqual(FIXTURE_V1_FOCUSED.guide.sections[0].diffs);
    const bad = structuredClone(snapshot);
    bad.guide.sections[0].diffs[0].file = '../outside.ts';
    expect(parseGuideSnapshot(bad).ok).toBe(false);
    bad.guide.sections[0].diffs[0].file = 'src/caller.ts';
    bad.guide.sections[0].diffs.pop();
    const incomplete = parseGuideSnapshot(bad);
    expect(incomplete.ok).toBe(false);
    if (!incomplete.ok) expect(incomplete.error.message).toContain('package.json');
  });

  test('focused portable HTML displays all captured code offline without invoking the older hosted viewer', () => {
    const html = createGuideHtml(FIXTURE_V1_FOCUSED, { viewer: { baseUrl: 'https://guides.show/v1/', js: 'old.js', css: 'old.css' } });
    expect(html).not.toContain('<script type="module"');
    expect(html).not.toContain('rel="stylesheet"');
    expect(html).not.toContain('rel="modulepreload"');
    expect(html.match(/<details open class="pgr-block">/g)).toHaveLength(4);
    expect(html).toContain('src/caller.ts · new 10–11 · Repository context');
    expect(html).toContain('<span class="pgr-number">10</span>');
    expect(html).toContain('<code> const refreshed = refresh(token);</code>');
    expect(html).toContain('Reject missing input.');
    expect(html).toContain('works offline');
    expect(html).toContain('&lt;/script&gt;&lt;!--');
    expect(html).toContain('pgr-focused');
  });

});
