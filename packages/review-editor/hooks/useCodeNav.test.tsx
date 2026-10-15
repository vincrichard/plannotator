import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useCodeNav, type CodeNavRequest, type CodeNavResponse } from './useCodeNav';

let root: Root | undefined;
let host: HTMLElement | undefined;
let originalFetch: typeof fetch;
let nav: ReturnType<typeof useCodeNav>;
const request: CodeNavRequest = { symbol: 'widget', filePath: 'main.ts', line: 7, charStart: 0, side: 'old' };
const result: CodeNavResponse = {
  backend: 'search', complete: true, searchScope: 'head', stats: { elapsedMs: 1, capped: false },
  definitions: [{ kind: 'definition', confidence: 'likely', filePath: 'helper.ts', line: 10, column: 1, snippet: 'function widget() {}' }], references: [],
};
function Harness({ snapshot }: { snapshot: string }) { nav = useCodeNav(snapshot); return null; }
async function render(snapshot = 'one') {
  if (!host) {
    originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => Response.json(result), { preconnect: originalFetch.preconnect });
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  }
  await act(async () => { root!.render(<Harness snapshot={snapshot} />); });
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; host?.remove(); host = undefined;
  if (originalFetch) globalThis.fetch = originalFetch;
});
describe.if(typeof document !== 'undefined')('reference navigation history', () => {
  test('restores source sides, result lists and lines; branches and clears on snapshot changes', async () => {
    await render();
    await act(async () => { await nav.resolve(request); });
    await act(async () => nav.select({ filePath: 'other.ts', line: 40, side: 'new' }));
    await act(async () => nav.select({ filePath: 'other.ts', line: 40, side: 'new' }));
    await act(async () => nav.go(-1));
    expect(nav.target?.filePath).toBe('helper.ts');
    await act(async () => nav.go(-1));
    expect(nav.target).toEqual({ filePath: 'main.ts', line: 7, side: 'old' });
    expect(nav.canGoBack).toBe(false);
    await act(async () => nav.go(1));
    expect(nav.target?.line).toBe(10);
    expect(nav.result).toEqual(result);
    await act(async () => nav.select({ filePath: 'branch.ts', line: 20, side: 'new' }));
    expect(nav.canGoForward).toBe(false);
    await render('two');
    expect(nav.target).toBeNull();
    expect(nav.canGoBack).toBe(false);
  });

  test('back cancels a pending lookup and ignores a late response', async () => {
    await render();
    await act(async () => { await nav.resolve(request); });
    let finish!: (response: Response) => void;
    globalThis.fetch = Object.assign(() => new Promise<Response>(resolve => { finish = resolve; }), { preconnect: originalFetch.preconnect });
    let pending!: Promise<void>;
    await act(async () => { pending = nav.resolve({ ...request, symbol: 'other', filePath: 'other.ts' }); });
    expect(nav.isLoading).toBe(true);
    await act(async () => nav.go(-1));
    expect(nav.target?.filePath).toBe('helper.ts');
    await act(async () => { finish(Response.json({ ...result, definitions: [] })); await pending; });
    expect(nav.target?.filePath).toBe('helper.ts');
    expect(nav.activeSymbol).toBe('widget');
    expect(nav.isLoading).toBe(false);
  });
});
