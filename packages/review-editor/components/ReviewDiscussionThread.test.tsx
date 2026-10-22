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
function Harness({ ready, currentThread = thread }: { ready: boolean; currentThread?: ReviewDiscussion }) {
  const discussions = useReviewDiscussionState('snapshot');
  return <ReviewDiscussionsProvider value={{ ...discussions, conversionReady: ready, conversionUnavailableReason: 'Restore saved comments first' }}>
    <ReviewDiscussionThread thread={currentThread} />
  </ReviewDiscussionsProvider>;
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; host?.remove(); host = undefined;
  if (originalFetch) globalThis.fetch = originalFetch;
});
describe.if(typeof document !== 'undefined')('discussion conversion', () => {
  test('folds history per new question while keeping its pending and completed answer visible', async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => Response.json({ supported: true, available: true, threads: [] }), { preconnect: originalFetch.preconnect });
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    const messages = [...thread.messages, { id: 'answer-one', role: 'assistant' as const, text: 'First answer', createdAt: 2 }];
    const render = async () => act(async () => root!.render(<Harness ready currentThread={{ ...thread, messages: [...messages] }} />));
    await render();
    await act(async () => host!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
    expect(host.querySelector('details')).toBeNull();
    messages.push({ id: 'question-two', role: 'user', text: 'Second question', createdAt: 3 });
    await render();
    const history = host.querySelector('details')!;
    expect(history.open).toBe(false);
    expect(history.textContent).toContain('First answer');
    expect(history.textContent).not.toContain('Second question');
    expect(host.querySelector('button[aria-expanded]')!.textContent).toContain('Second question');
    history.open = true;
    messages.push({ id: 'answer-two', role: 'assistant', text: 'Second answer', createdAt: 4 });
    await render();
    expect(host.querySelector('details')!.open).toBe(true);
    expect(host.querySelector('details')!.textContent).not.toContain('Second answer');
    messages.push({ id: 'question-three', role: 'user', text: 'Third question', createdAt: 5 });
    await render();
    expect(host.querySelector('details')!.open).toBe(false);
    expect(host.querySelector('details')!.textContent).toContain('Second answer');
    expect(host.querySelector('details')!.textContent).not.toContain('Third question');
  });

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
