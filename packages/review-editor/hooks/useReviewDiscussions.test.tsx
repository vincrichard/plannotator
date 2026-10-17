import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReviewDiscussionsProvider, useReviewDiscussionState, useDiscussionCommentRecovery, mergeDiscussionComments } from './useReviewDiscussions';
import type { CodeAnnotation } from '@plannotator/ui/types';
import { QuestionBadge } from '../components/FileRowBits';
import { adoptServerSession, __resetServerSessionForTests } from '@plannotator/ui/utils/serverSession';
import type { ReviewDiscussion, ReviewDiscussionComment } from '../../core/review-discussions';
let root: Root | undefined;
let host: HTMLElement | undefined;
let originalFetch: typeof fetch;
let discussions: ReturnType<typeof useReviewDiscussionState>;
const anchor = { filePath: 'unchanged.ts', lineStart: 12, lineEnd: 14, side: 'old' as const };
function Harness({ snapshot }: { snapshot: string }) { discussions = useReviewDiscussionState(snapshot); return <ReviewDiscussionsProvider value={{ ...discussions, conversionReady: true }}>
  <div data-file="unchanged.ts"><QuestionBadge filePath="unchanged.ts" /></div>
  <div data-file="other.ts"><QuestionBadge filePath="other.ts" /></div>
</ReviewDiscussionsProvider>; }
async function render(handler: (url: string, options?: RequestInit) => Promise<Response>) {
  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign((url: string | URL | Request, options?: RequestInit) => handler(String(url), options), { preconnect: originalFetch.preconnect });
  adoptServerSession('discussion-test');
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<Harness snapshot="snapshot-one" />));
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; host?.remove(); host = undefined;
  if (originalFetch) globalThis.fetch = originalFetch;
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
  __resetServerSessionForTests();
});
describe.if(typeof document !== 'undefined')('review discussions', () => {
  test('conversion recovery waits for draft resolution, preserves edits and does not resurrect deleted comments', async () => {
    const annotation: ReviewDiscussionComment = { ...anchor, id: 'discussion-one', type: 'comment', text: 'Change it', createdAt: 1 };
    const thread: ReviewDiscussion = { id: 'one', snapshotId: 'snapshot-one', anchor, messages: [], status: 'converted', createdAt: 1, updatedAt: 2, annotation };
    const edited = { ...annotation, id: 'discussion-edited', text: 'Reviewer edited this request' };
    const annotations: { current: CodeAnnotation[] } = { current: [edited] };
    const threads: ReviewDiscussion[] = [thread,
      { ...thread, id: 'edited', annotation: { ...edited, text: 'Older request' } },
      { ...thread, id: 'saved', conversionSaved: true, annotation: { ...annotation, id: 'already-saved' } },
    ];
    const addAnnotations = (recovered: CodeAnnotation[]) => { annotations.current = [...annotations.current, ...recovered]; };
    function Recovery({ ready, threads }: { ready: boolean; threads: ReviewDiscussion[] }) {
      useDiscussionCommentRecovery({ ready, threads, annotations, addAnnotations });
      return null;
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root!.render(<Recovery ready={false} threads={threads} />));
    expect(annotations.current).toEqual([edited]);
    await act(async () => root!.render(<Recovery ready threads={threads} />));
    expect(annotations.current).toEqual([edited, annotation]);
    await act(async () => root!.render(<Recovery ready threads={structuredClone(threads)} />));
    expect(annotations.current).toEqual([edited, annotation]);
    annotations.current = [];
    await act(async () => root!.render(<Recovery ready threads={structuredClone(threads)} />));
    expect(annotations.current).toEqual([]);
  });

  test('keeps questions separate, binds inline markers to their snapshot and original side, persists drafts', async () => {
    const thread: ReviewDiscussion = { id: 'one', snapshotId: 'snapshot-one', anchor, messages: [{ id: 'q', role: 'user', text: 'Why?', createdAt: 1 }], status: 'answered', createdAt: 1, updatedAt: 2 };
    await render(async () => Response.json({ supported: true, available: true, threads: [thread, { ...thread, id: 'other-snapshot', snapshotId: 'snapshot-two' }, { ...thread, id: 'converted', status: 'converted' }, { ...thread, id: 'resolved', status: 'resolved' }] }));
    expect(discussions.markers).toHaveLength(1);
    expect(discussions.markers[0]).toMatchObject({ ...anchor, id: 'discussion-marker-one' });
    await act(async () => discussions.setDraft('one', 'Unsent follow-up'));
    await act(async () => root!.unmount()); root = createRoot(host!);
    await act(async () => root!.render(<Harness snapshot="snapshot-one" />));
    expect(discussions.drafts.one).toBe('Unsent follow-up');
    await act(async () => root!.render(<Harness snapshot="snapshot-two" />));
    expect(discussions.markers[0].id).toBe('discussion-marker-other-snapshot');
  });

  test('file question badges count unresolved threads, not messages, and follow resolution and snapshot changes', async () => {
    const thread: ReviewDiscussion = { id: 'one', snapshotId: 'snapshot-one', anchor, messages: [
      { id: 'q', role: 'user', text: 'Why?', createdAt: 1 },
      { id: 'answer', role: 'assistant', text: 'Because…', createdAt: 2 },
      { id: 'follow-up', role: 'user', text: 'And?', createdAt: 3 },
    ], status: 'answered', createdAt: 1, updatedAt: 3 };
    let threads: ReviewDiscussion[] = [thread,
      { ...thread, id: 'running', status: 'answering' },
      { ...thread, id: 'failed', status: 'error', anchor: { ...anchor, filePath: 'other.ts' } },
      { ...thread, id: 'old', snapshotId: 'snapshot-two' },
      { ...thread, id: 'resolved', status: 'resolved' },
      { ...thread, id: 'converted', status: 'converted' },
    ];
    await render(async (_url, options) => {
      if (options) threads = threads.map(t => _url.endsWith('/' + t.id) ? { ...t, status: JSON.parse(String(options.body)).action === 'resolve' ? 'resolved' : 'converted' } : t);
      return Response.json({ supported: true, available: true, threads });
    });
    expect(host!.querySelector('[data-file="unchanged.ts"] [aria-label="2 unresolved questions"]')).not.toBeNull();
    expect(host!.querySelector('[data-file="other.ts"] [aria-label="1 unresolved question"]')).not.toBeNull();
    await act(async () => { await discussions.update('one', 'resolve'); });
    expect(host!.querySelector('[data-file="unchanged.ts"] [aria-label="1 unresolved question"]')).not.toBeNull();
    await act(async () => { await discussions.update('running', 'convert', 'Change it'); });
    expect(host!.querySelector('[data-file="unchanged.ts"]')!.textContent).toBe('');
    await act(async () => root!.render(<Harness snapshot="snapshot-two" />));
    expect(host!.querySelector('[data-file="unchanged.ts"] [aria-label="1 unresolved question"]')).not.toBeNull();
    expect(host!.querySelector('[data-file="other.ts"]')!.textContent).toBe('');
  });

  test('plain-text ended responses retain unsent questions and follow-ups across remounts', async () => {
    let ended = false;
    await render(async (_url, options) => {
      if (options || ended) { ended = true; return new Response('Review has ended', { status: 410 }); }
      return Response.json({ supported: true, available: true, threads: [] });
    });
    await act(async () => discussions.setDraft('existing-thread', 'Unsent follow-up'));
    await act(async () => expect(await discussions.create(anchor, 'Unsent initial question')).toBe(false));
    expect(discussions.ended).toBe(true);
    expect(discussions.error).toContain('This review has ended');
    expect(Object.values(discussions.failedQuestions)[0]).toMatchObject({ anchor, text: 'Unsent initial question' });
    await act(async () => root!.unmount()); root = createRoot(host!);
    await act(async () => root!.render(<Harness snapshot="snapshot-one" />));
    expect(discussions.drafts['existing-thread']).toBe('Unsent follow-up');
    expect(Object.values(discussions.failedQuestions)[0].text).toBe('Unsent initial question');
  });

  test('a network interruption preserves the question without declaring the review ended', async () => {
    await render(async (_url, options) => {
      if (options) throw new TypeError('Failed to fetch');
      return Response.json({ supported: true, available: true, threads: [] });
    });
    await act(async () => expect(await discussions.create(anchor, 'Keep this question')).toBe(false));
    expect(discussions.ended).toBe(false);
    expect(discussions.connectionError).toContain('Cannot reach this review');
    expect(Object.values(discussions.failedQuestions)[0].text).toBe('Keep this question');
  });

  test('retry after a lost response reuses message identity and echoes the server-session guard', async () => {
    const bodies: Record<string, unknown>[] = [];
    let fail = true;
    await render(async (_url, options) => {
      if (!options) return Response.json({ supported: true, available: true, threads: [] });
      bodies.push(JSON.parse(String(options.body)));
      if (fail) { fail = false; throw new Error('Connection lost after acceptance'); }
      return Response.json({ ok: true });
    });
    await act(async () => { try { await discussions.send('thread', 'Follow up'); } catch {} });
    await act(async () => { await discussions.send('thread', 'Follow up'); });
    expect(bodies[0].id).toBe(bodies[1].id);
    expect(bodies[1].serverSession).toBe('discussion-test');
    await act(async () => { await discussions.send('thread', 'Next question'); });
    expect(bodies[2].id).not.toBe(bodies[1].id);
  });

  test('retrying a question in the inline composer reuses its identity after a lost response', async () => {
    const ids: string[] = [];
    await render(async (_url, options) => {
      if (!options) return Response.json({ supported: true, available: true, threads: [] });
      ids.push(JSON.parse(String(options.body)).id);
      if (ids.length === 1) throw new Error('Response lost');
      return Response.json({ ok: true });
    });
    await act(async () => expect(await discussions.create(anchor, 'Question')).toBe(false));
    await act(async () => expect(await discussions.create(anchor, 'Question')).toBe(true));
    expect(ids[1]).toBe(ids[0]);
    expect(discussions.expandedThreads[ids[0]]).toBe(true);
    expect(Object.keys(discussions.failedQuestions)).toHaveLength(0);
  });

  test('a later successful question does not discard a different failed question', async () => {
    await render(async (_url, options) => {
      if (!options) return Response.json({ supported: true, available: true, threads: [] });
      const body = JSON.parse(String(options.body));
      return body.text === 'First question' ? Response.json({ error: 'Try again' }, { status: 503 }) : Response.json({ ok: true });
    });
    await act(async () => { await discussions.create(anchor, 'First question'); });
    await act(async () => { await discussions.create(anchor, 'Second question'); });
    expect(Object.values(discussions.failedQuestions).map(question => question.text)).toEqual(['First question']);
  });

  test('successful creation remains successful if the snapshot refresh fails', async () => {
    let posted = false;
    await render(async (_url, options) => {
      if (options) { posted = true; return Response.json({ ok: true }); }
      if (posted) throw new Error('Temporary polling outage');
      return Response.json({ supported: true, available: true, threads: [] });
    });
    await act(async () => expect(await discussions.create(anchor, 'Question')).toBe(true));
    expect(Object.keys(discussions.failedQuestions)).toHaveLength(0);
    const id = Object.keys(discussions.expandedThreads)[0];
    expect(discussions.expandedThreads[id]).toBe(true);
    await act(async () => discussions.setThreadExpanded(id, false));
    await act(async () => root!.render(<Harness snapshot="snapshot-one" />));
    expect(discussions.expandedThreads[id]).toBe(false);
  });
});

test('restoring an older draft retains an already-converted edited request without duplicating it', () => {
  const annotation = { ...anchor, id: 'discussion-one', type: 'comment' as const, text: 'Final instruction', createdAt: 1 };
  const thread: ReviewDiscussion = { id: 'one', snapshotId: 'snapshot-one', anchor, messages: [], status: 'converted', createdAt: 1, updatedAt: 2, annotation };
  const ordinary = { ...annotation, id: 'ordinary', text: 'Existing feedback' };
  const edited = { ...annotation, text: 'Edited instruction' };
  expect(mergeDiscussionComments([ordinary, annotation], [edited], [thread])).toEqual([ordinary, edited]);
});
