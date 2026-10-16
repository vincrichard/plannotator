import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useExternalAnnotations } from './useExternalAnnotations';
import { useAgentJobs } from './useAgentJobs';

const hasDom = typeof document !== 'undefined';
const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
  if (hasDom) document.body.innerHTML = '';
});

// A proxy without SSE must not replace the viewer's annotations every 500 ms
// merely because an empty store's valid version is zero.
describe.if(hasDom)('idle snapshot polling', () => {
  for (const kind of ['annotations', 'jobs'] as const) {
    test(`${kind}: version zero settles, new data and clears still arrive`, async () => {
      globalThis.EventSource = class {
        onerror: (() => void) | null = null;
        constructor() { queueMicrotask(() => this.onerror?.()); }
        close() {}
      } as unknown as typeof EventSource;
      let version = 0;
      let items: Array<{ id: string }> = [];
      let current: unknown[] = [];
      const requests: string[] = [];
      globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/capabilities')) return Response.json({ providers: [] });
        requests.push(url);
        const since = new URL(url, 'http://localhost').searchParams.get('since');
        return since !== null && Number(since) === version
          ? new Response(null, { status: 304 })
          : Response.json({ [kind]: items, version });
      }, { preconnect: originalFetch.preconnect });
      function Annotations() { current = useExternalAnnotations().externalAnnotations; return null; }
      function Jobs() { current = useAgentJobs().jobs; return null; }
      const host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
      await act(async () => root!.render(kind === 'jobs' ? <Jobs /> : <Annotations />));
      const tick = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 550)); });
      const initial = current;
      await tick();
      expect(requests.at(-1)).toEndWith('?since=0');
      expect(current).toBe(initial);
      items = [{ id: 'arrived' }]; version++;
      await tick();
      expect(current).toEqual(items);
      const arrived = current;
      await tick();
      expect(current).toBe(arrived);
      items = []; version++;
      await tick();
      expect(current).toEqual([]);
    });
  }
});
