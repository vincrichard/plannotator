import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReviewDiscussionThread } from './ReviewDiscussionThread';
import { ReviewDiscussionsProvider, useReviewDiscussionState } from '../hooks/useReviewDiscussions';
import type { ReviewDiscussion } from '../../core/review-discussions';

const thread: ReviewDiscussion = {
  id: 'question-one', snapshotId: 'snapshot',
  anchor: { filePath: 'example.ts', lineStart: 4, lineEnd: 4, side: 'old' },
  messages: [{ id: 'message-one', role: 'user', text: 'Use the earlier guard', createdAt: 1 }],
  status: 'answered', createdAt: 1, updatedAt: 2,
};
let root: Root | undefined;
let host: HTMLElement | undefined;
let originalFetch: typeof fetch;
function Harness({ ready }: { ready: boolean }) {
  const discussions = useReviewDiscussionState('snapshot');
  return <ReviewDiscussionsProvider value={{ ...discussions, conversionReady: ready, conversionUnavailableReason: 'Restore saved comments first' }}>
    <ReviewDiscussionThread thread={thread} />
  </ReviewDiscussionsProvider>;
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; host?.remove(); host = undefined;
  if (originalFetch) globalThis.fetch = originalFetch;
});
describe.if(typeof document !== 'undefined')('discussion conversion', () => {
  test('cannot drop a thread while ordinary drafts are unreadable or awaiting restoration', async () => {
    originalFetch = globalThis.fetch;
    const mutations: unknown[] = [];
    globalThis.fetch = Object.assign(async (_url: string | URL | Request, options?: RequestInit) => {
      if (options) mutations.push(JSON.parse(String(options.body)));
      return Response.json({ supported: true, available: true, threads: [thread] });
    }, { preconnect: originalFetch.preconnect });
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    const render = async (ready: boolean) => act(async () => root!.render(<Harness ready={ready} />));
    const button = (text: string) => [...host!.querySelectorAll('button')].find(item => item.textContent === text)!;
    await render(false);
    await act(async () => host!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
    expect(button('Request change').disabled).toBe(true);
    await act(async () => button('Request change').click());
    expect(mutations).toHaveLength(0);
    expect(host.textContent).toContain('Restore saved comments first');
    await render(true);
    await act(async () => button('Request change').click());
    expect(button('Save change request').disabled).toBe(false);
    // Readiness may change while the conversion composer is already open.
    await render(false);
    expect(button('Save change request').disabled).toBe(true);
    await render(true);
    await act(async () => button('Save change request').click());
    expect(mutations).toEqual([{ action: 'convert', text: 'Use the earlier guard' }]);
  });
});
