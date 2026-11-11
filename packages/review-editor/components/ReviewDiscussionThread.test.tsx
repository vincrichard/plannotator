import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReviewDiscussionThread } from './ReviewDiscussionThread';
import { DiscussionResponse } from './DiscussionResponse';
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
function Harness({ ready, currentThread }: { ready: boolean; currentThread?: ReviewDiscussion }) {
  const discussions = useReviewDiscussionState('snapshot');
  return <ReviewDiscussionsProvider value={{ ...discussions, conversionReady: ready, conversionUnavailableReason: 'Restore saved comments first' }}>
    <ReviewDiscussionThread thread={currentThread ?? discussions.threads[0] ?? thread} />
  </ReviewDiscussionsProvider>;
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; host?.remove(); host = undefined;
  if (originalFetch) globalThis.fetch = originalFetch;
});
describe.if(typeof document !== 'undefined')('discussion conversion', () => {
  test('responses render headings, tables, blockquotes and reference links', async () => {
    const response = '# Result\n\n| Change | Status |\n| --- | --- |\n| **Guard** | Kept |\n\n> Retain failures.\n\nSee [details][ref].\n\n[ref]: https://example.com/details';
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    await act(async () => root!.render(<DiscussionResponse text={response} />));
    expect(host.querySelector('h1')?.textContent).toBe('Result');
    expect(host.querySelectorAll('th')).toHaveLength(2);
    expect(host.querySelector('td strong')?.textContent).toBe('Guard');
    expect(host.querySelector('blockquote')?.textContent).toContain('Retain failures.');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.com/details');
  });
  test('response and draft copy buttons preserve Markdown, nested fences and indentation without copying explanations', async () => {
    const copied: string[] = [];
    const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
    try {
      const draft = '**Proposed reply**\n\n- Keep this list\n  - Nested item\n\n```go\n  run()\n```\n<script>literal text</script>';
      const response = `Here is the reply.\n\n\`\`\`\`draft\n${draft}\n\`\`\`\`\n\nAnother option:\n\n\`\`\`draft\nSecond draft\n\`\`\`\n\nExplanation stays outside.`;
      host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
      await act(async () => root!.render(<DiscussionResponse text={response} />));
      const button = (label: string) => [...host!.querySelectorAll('button')].find(node => node.textContent === label)!;
      expect(host.querySelectorAll('pre')).toHaveLength(2);
      expect(host.querySelector('pre')!.textContent).toBe(draft);
      expect(host.querySelector('script')).toBeNull();
      await act(async () => button('Copy response').click());
      await act(async () => button('Copy draft').click());
      await act(async () => button('Copy draft').click());
      expect(copied).toEqual([response, draft, 'Second draft']);
    } finally {
      if (previous) Object.defineProperty(navigator, 'clipboard', previous);
      else delete (navigator as { clipboard?: Clipboard }).clipboard;
    }
  });
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

  test('quiet answers can keep waiting without inventing activity, then cancel while retaining the question', async () => {
    originalFetch = globalThis.fetch;
    const startedAt = Date.now() - 20 * 60_000;
    let current: ReviewDiscussion = { ...thread, status: 'answering', activity: { startedAt, lastActivityAt: startedAt } };
    const mutations: { action: string; messageId: string }[] = [];
    globalThis.fetch = Object.assign(async (_url: string | URL | Request, options?: RequestInit) => {
      if (options) {
        const body = JSON.parse(String(options.body)); mutations.push(body);
        current = body.action === 'keep-waiting'
          ? { ...current, activity: { ...current.activity!, waitRequestedAt: Date.now() } }
          : { ...current, status: 'error', error: 'Answer cancelled' };
      }
      return Response.json({ supported: true, available: true, version: mutations.length, threads: [current] });
    }, { preconnect: originalFetch.preconnect });
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    await act(async () => root!.render(<Harness ready />));
    await act(async () => host!.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click());
    const button = (label: string) => [...host!.querySelectorAll('button')].find(item => item.textContent === label);
    // These action labels and the quiet state are deliberate user controls.
    expect(host.textContent).toContain('No activity received');
    expect(button('Send question')!.disabled).toBe(true);
    await act(async () => button('Keep waiting')!.click());
    expect(button('Keep waiting')).toBeUndefined();
    expect(current.activity!.lastActivityAt).toBe(startedAt);
    expect(current.status).toBe('answering');
    await act(async () => button('Cancel answer')!.click());
    expect(mutations.map(m => [m.action, m.messageId])).toEqual([['keep-waiting', 'message-one'], ['cancel', 'message-one']]);
    expect(button('Cancel answer')).toBeUndefined();
    expect(host.textContent).toContain('Answer cancelled');
    expect(current.messages).toEqual(thread.messages);
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
