import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DiffFile } from '../types';
import { useCodeNavPreview } from './useCodeNavPreview';

let root: Root | undefined;
let host: HTMLElement | undefined;
let originalFetch: typeof fetch;
let preview: ReturnType<typeof useCodeNavPreview>;

function Harness({ path, snapshot, changed }: { path: string; snapshot: string; changed?: DiffFile }) {
  preview = useCodeNavPreview(path, changed, 'main', snapshot);
  return null;
}

async function render(path = 'helper.ts', snapshot = 'one', changed?: DiffFile) {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => { root!.render(<Harness key={`${path}:${snapshot}`} path={path} snapshot={snapshot} changed={changed} />); });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
  if (originalFetch) globalThis.fetch = originalFetch;
});

describe.if(typeof document !== 'undefined')('reference snapshot loading', () => {
  test('a failed snapshot read can be retried without changing the diff identity', async () => {
    originalFetch = globalThis.fetch;
    let stale = true;
    globalThis.fetch = (async (url: string) => {
      expect(url).toContain('snapshot=one');
      expect(url).toContain('base=main');
      return stale ? Response.json({ error: 'stale' }, { status: 409 })
        : Response.json({ oldContent: 'same\n', newContent: 'same\n' });
    }) as typeof fetch;
    await render();
    expect(preview.file).toBeNull();
    expect(preview.error).toContain('stale');
    stale = false;
    await act(async () => preview.retry());
    expect(preview.error).toBeNull();
    expect(preview.file?.patch).toContain('\n same\n');
  });

  test('a missing, binary, or changed file outside the patch is never presented as unchanged', async () => {
    originalFetch = globalThis.fetch;
    for (const [oldContent, newContent] of [[null, null], ['old\n', 'new\n'], ['\0', '\0']]) {
      globalThis.fetch = (async () => Response.json({ oldContent, newContent })) as typeof fetch;
      await render('helper.ts', String(newContent));
      expect(preview.file).toBeNull();
      expect(preview.error).not.toBeNull();
    }
  });

  test('a late aborted response cannot overwrite a successful retry', async () => {
    originalFetch = globalThis.fetch;
    let finishOld!: (response: Response) => void;
    let calls = 0;
    globalThis.fetch = (async () => ++calls === 1
      ? new Promise<Response>(resolve => { finishOld = resolve; })
      : Response.json({ oldContent: 'current\n', newContent: 'current\n' })) as typeof fetch;
    await render('current.ts', 'one');
    await act(async () => preview.retry());
    await act(async () => finishOld(Response.json({ oldContent: 'late\n', newContent: 'late\n' })));
    expect(preview.file?.path).toBe('current.ts');
    expect(preview.file?.patch).toContain('\n current\n');
  });

  test('changed targets retain the actual patch even when expansion fails', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => Response.json({}, { status: 404 })) as typeof fetch;
    const file: DiffFile = { path: 'changed.ts', patch: '--- a/changed.ts\n+++ b/changed.ts\n@@ -1 +1 @@\n-old\n+new\n', additions: 1, deletions: 1, status: 'modified' };
    await render(file.path, 'one', file);
    expect(preview.file).toBe(file);
  });
});
