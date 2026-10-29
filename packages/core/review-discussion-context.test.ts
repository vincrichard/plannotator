import { expect, test } from 'bun:test';
import { selectedDiffContext } from './review-discussion-context';

const patch = 'diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -10,3 +20,3 @@\n before\n-old call\n+new call\n after\n@@ -100 +200 @@\n-unrelated old\n+unrelated new\n';
for (const side of ['old', 'new'] as const) test(`selected ${side} code includes source coordinates and nearby replacement only`, () => {
  const line = side === 'old' ? 11 : 21;
  const result = selectedDiffContext(patch, { filePath: 'new.ts', side, lineStart: line, lineEnd: line });
  expect(result).toContain('11 - | -old call');
  expect(result).toContain('- 21 | +new call');
  expect(result).not.toContain('unrelated');
});

test('a late selection in a 900-line addition stays small and includes the selected line', () => {
  const patch = '@@ -0,0 +1,900 @@\n' + Array.from({ length: 900 }, (_, i) => `+line ${i + 1}`).join('\n');
  const anchor = { filePath: 'large.ts', side: 'new' as const, lineStart: 800, lineEnd: 800 };
  const result = selectedDiffContext(patch, anchor);
  expect(result).toContain('- 800 | +line 800');
  expect(result).not.toContain('+line 1\n');
  expect(result.length).toBeLessThan(300);
  const broad = selectedDiffContext(patch, { ...anchor, lineStart: 1, lineEnd: 900 });
  expect(broad).toContain('shortened');
  expect(broad.split('\n').length).toBeLessThanOrEqual(82);
});
