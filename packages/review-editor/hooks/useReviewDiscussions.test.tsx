import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useReviewDiscussionState, mergeDiscussionComments } from './useReviewDiscussions';
import { adoptServerSession, __resetServerSessionForTests } from '@plannotator/ui/utils/serverSession';
import type { ReviewDiscussion } from '../../core/review-discussions';
let root: Root | undefined;
let host: HTMLElement | undefined;
let originalFetch: typeof fetch;
let discussions: ReturnType<typeof useReviewDiscussionState>;
const anchor = { filePath: 'unchanged.ts', lineStart: 12, lineEnd: 14, side: 'old' as const };
function Harness({ snapshot }: { snapshot: string }) { discussions = useReviewDiscussionState(snapshot); return null; }
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
  });
});

test('restoring an older draft retains an already-converted edited request without duplicating it', () => {
  const annotation = { ...anchor, id: 'discussion-one', type: 'comment' as const, text: 'Final instruction', createdAt: 1 };
  const thread: ReviewDiscussion = { id: 'one', snapshotId: 'snapshot-one', anchor, messages: [], status: 'converted', createdAt: 1, updatedAt: 2, annotation };
  const ordinary = { ...annotation, id: 'ordinary', text: 'Existing feedback' };
  const edited = { ...annotation, text: 'Edited instruction' };
  expect(mergeDiscussionComments([ordinary, annotation], [edited], [thread])).toEqual([ordinary, edited]);
});
