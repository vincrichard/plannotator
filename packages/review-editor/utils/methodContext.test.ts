import { describe, expect, test } from 'bun:test';
import { processFile, getSingularPatch } from '@pierre/diffs';
import { createTwoFilesPatch } from 'diff';
import { changedMethods, methodExpansions } from './methodContext';

function fixture(old: string, next: string) {
  const patch = createTwoFilesPatch('methods.py', 'methods.py', old, next);
  const diff = processFile(patch, { oldFile: { name: 'methods.py', contents: old }, newFile: { name: 'methods.py', contents: next } });
  if (!diff) throw new Error('Expected a diff');
  return { patch, diff };
}
const body = 'class C:\n    def run(self):\n' + Array.from({length: 140}, (_, i) => `        v${i} = ${i}\n`).join('') + '        return v139\n\ndef other():\n    return 1\n';

describe('method expansion', () => {
  test('one control for the first change spans the signature, interior gap and trailing body', () => {
    const { diff } = fixture(body, body.replace('v20 = 20', 'v20 = 200').replace('v100 = 100', 'v100 = 1000'));
    const methods = changedMethods(diff, 'additions');
    expect(methods).toEqual([{ name: 'C.run', start: 2, end: 143, hunkIndex: 0, side: 'additions' }]);
    expect(methodExpansions(diff, 'additions', methods[0])).toEqual([
      { index: 0, direction: 'down', count: 17 },
      { index: 1, direction: 'both', count: 71 },
      { index: 2, direction: 'up', count: 36 },
    ]);
  });
  test('old and new coordinates differ after insertions without losing the old method context', () => {
    const next = body.replace('v20 = 20', 'v20 = 200\n        inserted = 1').replace('v100 = 100', 'v100 = 1000');
    const { diff } = fixture(body, next);
    expect(changedMethods(diff, 'deletions')[0].end).toBe(143);
    expect(changedMethods(diff, 'additions')[0].end).toBe(144);
    expect(methodExpansions(diff, 'deletions', changedMethods(diff, 'deletions')[0]).at(-1)?.count).toBe(36);
    expect(methodExpansions(diff, 'additions', changedMethods(diff, 'additions')[0]).at(-1)?.count).toBe(36);
  });
  test('deletion-only changes retain the old method and its snapshot boundaries', () => {
    const { diff } = fixture(body, body.replace('        v20 = 20\n', ''));
    expect(changedMethods(diff, 'additions')).toEqual([]);
    expect(changedMethods(diff, 'deletions')).toEqual([
      { name: 'C.run', start: 2, end: 143, hunkIndex: 0, side: 'deletions' },
    ]);
  });
  test('a nested change belongs to its innermost function', () => {
    const old = 'def outer():\n    def inner():\n        return 1\n    return inner()\n';
    const { diff } = fixture(old, old.replace('return 1', 'return 2'));
    expect(changedMethods(diff, 'additions').map(method => method.name)).toEqual(['outer.inner']);
  });
  test('partial diffs and module-level changes do not claim a full method', () => {
    const { patch, diff } = fixture(body, body + 'module_value = 1\n');
    expect(changedMethods(getSingularPatch(patch), 'additions')).toEqual([]);
    expect(changedMethods(diff, 'additions')).toEqual([]);
  });
});
