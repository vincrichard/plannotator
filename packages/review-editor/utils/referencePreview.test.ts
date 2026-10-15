import { describe, expect, test } from 'bun:test';
import { getSingularPatch } from '@pierre/diffs';
import { parseDiffToFiles } from '@plannotator/shared/diff-files';
import { readPatchLines } from './codeAnnotationAnchor';
import { referenceLineInSnapshot, unchangedReferenceFile } from './referencePreview';

describe('unchanged reference files', () => {
  // Inventing a trailing line or an addition would give comments incorrect coordinates/sides.
  for (const content of ['first\nlast\n', 'first\nlast', '\n', 'first\n\n', 'first\r\nlast\r\n']) {
    test(`preserves full context and both line-number sides: ${JSON.stringify(content)}`, () => {
      const file = unchangedReferenceFile('src/a file.ts', content);
      const parsed = getSingularPatch(file.patch);
      expect(parsed.hunks).toHaveLength(1);
      expect(parseDiffToFiles(file.patch)).toEqual([file]);
      const lines = content.split('\n');
      if (content.endsWith('\n')) lines.pop();
      for (const side of ['old', 'new'] as const) {
        expect(readPatchLines(file.patch, side, 1, lines.length)).toBe(lines.join('\n'));
        expect(readPatchLines(file.patch, side, lines.length + 1, lines.length + 1)).toBeNull();
      }
    });
  }

  test('quotes paths and preserves source that resembles diff metadata', () => {
    const file = unchangedReferenceFile('src/"quoted"\t日本.ts', '--- source\n+++ source\n@@ header\n');
    expect(parseDiffToFiles(file.patch)[0].path).toBe(file.path);
    expect(readPatchLines(file.patch, 'new', 1, 3)).toBe('--- source\n+++ source\n@@ header');
  });

  test('an empty file has no invented commentable line', () => {
    const file = unchangedReferenceFile('empty.ts', '');
    expect(getSingularPatch(file.patch).hunks).toHaveLength(0);
  });
});

describe('working-tree reference coordinates against a review snapshot', () => {
  test('keeps an exact match, or moves to a unique matching source line', () => {
    expect(referenceLineInSnapshot('header\ncall();\n', 2, 'call();')).toBe(2);
    expect(referenceLineInSnapshot('header\ncall();\n', 8, 'call();')).toBe(2);
  });

  test('does not guess when a symbol is missing or the moved line is ambiguous', () => {
    expect(referenceLineInSnapshot('other();\n', 1, 'call();')).toBeNull();
    expect(referenceLineInSnapshot('call();\ncall();\n', 9, 'call();')).toBeNull();
    expect(referenceLineInSnapshot('\n', 1, '')).toBeNull();
  });
});
