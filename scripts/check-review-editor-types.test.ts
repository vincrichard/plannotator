import { describe, expect, test } from 'bun:test';
import { checkCompilerResult, normalizeDiagnostics } from './check-review-editor-types';

const diagnostic = "packages/review-editor/App.tsx(10,2): error TS2322: Type 'number' is not assignable.\n  Missing property 'text'.\n";
const baseline = normalizeDiagnostics(diagnostic, '/repo');

describe('review-editor type baseline', () => {
  test('accepts line shifts and normalizes checkout and Bun dependency locations', () => {
    expect(checkCompilerResult(2, diagnostic.replace('(10,2)', '(99,7)'), '/repo', baseline))
      .toEqual({ added: [], stale: [] });
    expect(normalizeDiagnostics('/repo/' + diagnostic, '/repo')).toEqual(baseline);
    const imported = 'x.ts(1,1): error TS2345: Type import("/repo/node_modules/.bun/pkg@1+hash/node_modules/pkg/type") differs.';
    expect(normalizeDiagnostics(imported, '/repo')[0]).toContain('import("node_modules/pkg/type")');
  });

  test('rejects new diagnostics even if an existing error disappears', () => {
    const replacement = diagnostic.replace('TS2322', 'TS2345');
    expect(checkCompilerResult(2, replacement, '/repo', baseline)).toEqual({
      added: normalizeDiagnostics(replacement, '/repo'), stale: baseline,
    });
    expect(checkCompilerResult(2, diagnostic.replace("property 'text'", "property 'id'"), '/repo', baseline).added).toHaveLength(1);
  });

  test('rejects another occurrence of the same error and requires removing resolved entries', () => {
    expect(checkCompilerResult(2, diagnostic + diagnostic, '/repo', baseline).added).toEqual(baseline);
    expect(checkCompilerResult(0, '', '/repo', baseline)).toEqual({ added: [], stale: baseline });
    expect(checkCompilerResult(0, '', '/repo', [])).toEqual({ added: [], stale: [] });
  });

  test('never treats a compiler crash, missing command, or unparsed output as success', () => {
    expect(() => checkCompilerResult(2, '', '/repo', [])).toThrow('without a completed type check');
    expect(() => checkCompilerResult(137, diagnostic, '/repo', baseline)).toThrow('without a completed type check');
    expect(() => checkCompilerResult(null, '', '/repo', [])).toThrow('without a completed type check');
    expect(() => checkCompilerResult(1, 'command not found\n', '/repo', [])).toThrow('Unexpected compiler output');
    expect(() => checkCompilerResult(2, diagnostic + 'compiler crashed\n', '/repo', baseline)).toThrow('Unexpected compiler output');
  });
});
