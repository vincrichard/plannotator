import { describe, expect, test } from 'bun:test';
import { getSingularPatch } from '@pierre/diffs';
import { annotationRange, inlineAnnotationLine } from './annotationRange';

const patch = `diff --git a/demo.ts b/demo.ts
--- a/demo.ts
+++ b/demo.ts
@@ -174,5 +186,6 @@
 context
 context
 context
-old first
-old second
+new first
+new second
+new third
`;

describe('annotation coordinates', () => {
  test('mixed-side selections keep one coordinate system in either drag direction', () => {
    const expected = { start: 189, end: 190, side: 'additions' } as const;
    expect(annotationRange(patch, { start: 177, side: 'deletions', end: 190, endSide: 'additions' })).toEqual(expected);
    expect(annotationRange(patch, { start: 190, side: 'additions', end: 177, endSide: 'deletions' })).toEqual(expected);
  });
  test('old-only selections and expanded unchanged selections retain their side and lines', () => {
    expect(annotationRange(patch, { start: 178, end: 177, side: 'deletions' })).toEqual({ start: 177, end: 178, side: 'deletions' });
    expect(annotationRange(patch, { start: 250, end: 240, side: 'additions' })).toEqual({ start: 240, end: 250, side: 'additions' });
  });
  test('legacy ranges ending in hidden context render on a visible line inside their saved range', () => {
    const diff = getSingularPatch(patch);
    const saved = { lineStart: 177, lineEnd: 190, side: 'old' as const };
    expect(inlineAnnotationLine(saved, diff)).toBe(178);
    expect(saved.lineEnd).toBe(190);
    expect(inlineAnnotationLine({ ...saved, lineStart: 240, lineEnd: 250 }, diff)).toBe(250);
    expect(inlineAnnotationLine({ lineStart: 189, lineEnd: 191, side: 'new' }, diff)).toBe(191);
  });
});
