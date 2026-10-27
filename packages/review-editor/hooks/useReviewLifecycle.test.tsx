import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useComposerDraftState } from '@plannotator/ui/hooks/useComposerDraftState';
import { setDraftRequestHeaders, getDraftTransport, stageCodeDraftRecovery } from '@plannotator/ui/hooks/useAnnotationDraft';
import { useReviewLifecycle } from './useReviewLifecycle';
import { useReviewDiscussionState } from './useReviewDiscussions';
import { useAnnotationToolbar } from './useAnnotationToolbar';
import { restoreComposerDrafts } from '@plannotator/ui/utils/composerDrafts';
import { adoptServerSession, __resetServerSessionForTests } from '@plannotator/ui/utils/serverSession';

let root: Root | undefined;
let host: HTMLElement;
let lifecycle: ReturnType<typeof useReviewLifecycle>;
let discussion: ReturnType<typeof useReviewDiscussionState>;
let field: ReturnType<typeof useComposerDraftState<string>>;
let toolbar: ReturnType<typeof useAnnotationToolbar>;
const originalFetch = globalThis.fetch;
const range = { start: 1, end: 1, side: 'additions' as const };
const noop = () => {};
function Composer() {
  toolbar = useAnnotationToolbar({ filePath: 'a.ts', patch: '@@ -1 +1 @@\n-a\n+b', isFocused: true, onLineSelection: noop, onAddAnnotation: noop, onEditAnnotation: noop });
  return null;
}
function Harness() {
  field = useComposerDraftState('general-note-test', '');
  lifecycle = useReviewLifecycle();
  discussion = useReviewDiscussionState('snapshot', lifecycle.ready ? lifecycle.review?.id : undefined);
  return lifecycle.ready ? <Composer /> : null;
}
async function mount(nonce: string, id = 'logical-review') {
  adoptServerSession(nonce);
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  await act(async () => root!.render(<Harness />));
  await act(async () => lifecycle.load({ id, frozen: true }));
}
async function unmount() { if (root) await act(async () => root!.unmount()); root = undefined; host?.remove(); }
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 320)); });
afterEach(async () => { await unmount(); globalThis.fetch = originalFetch; restoreComposerDrafts({}); sessionStorage.clear(); localStorage.clear(); __resetServerSessionForTests(); setDraftRequestHeaders(); });

describe.if(typeof document !== 'undefined')('durable review UI', () => {
  test('unfinished composer and discussion retries survive restart with a fresh transport nonce, then clear after submission', async () => {
    let saved: Record<string, unknown> = {};
    let revision = 0;
    const accepted = new Set<string>();
    const writes: string[] = [];
    let loseResponse = true;
    globalThis.fetch = Object.assign(async (input: string | URL | Request, options?: RequestInit) => {
      const url = String(input);
      const body = options?.body ? JSON.parse(String(options.body)) : {};
      if (url.endsWith('/drafts')) {
        if (options?.method === 'PUT') { expect(body.revision).toBe(revision); revision++; saved = structuredClone(body.drafts); writes.push(body.serverSession); }
        return Response.json({ drafts: saved, revision });
      }
      if (url.endsWith('/messages')) {
        accepted.add(body.id);
        if (loseResponse) { loseResponse = false; throw new Error('Lost acceptance response'); }
        return Response.json({ ok: true });
      }
      return Response.json({ supported: true, available: true, threads: [] });
    }, { preconnect: originalFetch.preconnect });
    await mount('before-suspension');
    await act(async () => toolbar.openLineAnnotation(range));
    await act(async () => { field[1]('Unfinished general note'); toolbar.setCommentText('Unfinished comment'); toolbar.setSuggestedCode('replacement'); discussion.setDraft('thread', 'Unfinished question'); });
    const editing = { id: 'saved-comment', type: 'comment' as const, text: 'Original comment', createdAt: 1, filePath: 'a.ts', lineStart: 2, lineEnd: 2, side: 'new' as const };
    await act(async () => toolbar.startEdit(editing));
    await act(async () => toolbar.setCommentText('Unfinished edit'));
    await act(async () => { try { await discussion.send('thread', 'Unfinished question'); } catch {} });
    await settle();
    await unmount();
    // A reopened tab has neither the old module Maps nor sessionStorage.
    restoreComposerDrafts({}); sessionStorage.clear(); localStorage.clear();
    await mount('after-resume');
    expect(discussion.drafts.thread).toBe('Unfinished question');
    expect(field[0]).toBe('Unfinished general note');
    await act(async () => toolbar.openLineAnnotation(range));
    expect(toolbar.commentText).toBe('Unfinished comment');
    expect(toolbar.suggestedCode).toBe('replacement');
    await act(async () => toolbar.startEdit(editing));
    expect(toolbar.commentText).toBe('Unfinished edit');
    await act(async () => toolbar.handleSubmitAnnotation());
    await act(async () => toolbar.openLineAnnotation(range));
    await act(async () => { await discussion.send('thread', discussion.drafts.thread); toolbar.handleSubmitAnnotation(); discussion.setDraft('thread', ''); });
    expect(accepted.size).toBe(1);
    await settle();
    expect(writes).toContain('after-resume');
    await unmount(); restoreComposerDrafts({}); sessionStorage.clear(); localStorage.clear();
    await mount('third-transport');
    await act(async () => toolbar.openLineAnnotation(range));
    expect(toolbar.commentText).toBe('');
    expect(discussion.drafts.thread).toBe('');
  });

  test('polls and synthetic input cannot prolong the review; trusted input is throttled and refresh is explicit', async () => {
    const requests: string[] = [];
    const add = spyOn(window, 'addEventListener');
    globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
      requests.push(String(input));
      return Response.json(String(input).endsWith('/drafts') ? { drafts: {}, revision: 0 } : { supported: true, available: true, threads: [] });
    }, { preconnect: originalFetch.preconnect });
    try {
      await mount('transport');
      const activity = add.mock.calls.find(call => call[0] === 'wheel')![1] as EventListener;
      activity({ isTrusted: false } as Event);
      window.dispatchEvent(new Event('scroll'));
      expect(requests.filter(url => url.endsWith('/activity'))).toHaveLength(0);
      activity({ isTrusted: true } as Event); activity({ isTrusted: true } as Event);
      expect(requests.filter(url => url.endsWith('/activity'))).toHaveLength(1);
      expect(lifecycle.review?.frozen).toBe(true);
      expect(requests.some(url => url.endsWith('/refresh'))).toBe(false);
      let updated = false;
      await act(async () => lifecycle.refresh(async () => { updated = true; return true; }));
      expect(updated).toBe(true);
      expect(lifecycle.review?.frozen).toBe(false);
    } finally { add.mockRestore(); }
  });
  test('failed draft save blocks refresh and keeps the browser backup for retry', async () => {
    const requests: string[] = [];
    globalThis.fetch = Object.assign(async (input: string | URL | Request, options?: RequestInit) => {
      const url = String(input); requests.push(url);
      if (url.endsWith('/drafts')) return options?.method === 'PUT' ? new Response('offline', { status: 503 }) : Response.json({ drafts: {}, revision: 0 });
      return Response.json({ supported: true, available: true, threads: [] });
    }, { preconnect: originalFetch.preconnect });
    await mount('transport');
    await act(async () => field[1]('Do not lose this'));
    await act(async () => lifecycle.refresh(async () => { throw new Error('Must not refresh'); }));
    expect(requests.some(url => url.endsWith('/refresh'))).toBe(false);
    expect(lifecycle.review?.frozen).toBe(true);
    expect(lifecycle.error).toBeTruthy();
    expect(localStorage.getItem('review-composers:logical-review')).toContain('Do not lose this');
  });

  test('browser recovery preserves other-device edits and asks before replacing a conflicting field', async () => {
    const before = { fields: [['general-note-test', 'Original'], ['other-note', 'Old other note']] };
    const local = { fields: [['general-note-test', 'Browser edit'], ['other-note', 'Old other note']] };
    const remote = { fields: [['general-note-test', 'Device edit'], ['other-note', 'New other note']] };
    localStorage.setItem('review-composers:logical-review', JSON.stringify({ base: before, drafts: local }));
    let saved: Record<string, unknown> | undefined;
    globalThis.fetch = Object.assign(async (input: string | URL | Request, options?: RequestInit) => {
      if (String(input).endsWith('/drafts')) {
        if (options?.method === 'PUT') { const body = JSON.parse(String(options.body)); expect(body.revision).toBe(7); saved = body.drafts; return Response.json({ revision: 8 }); }
        return Response.json({ drafts: remote, revision: 7 });
      }
      return Response.json({ supported: true, available: true, threads: [] });
    }, { preconnect: originalFetch.preconnect });
    await mount('new-transport');
    expect(lifecycle.ready).toBe(false);
    expect(lifecycle.recovery).toBeTruthy();
    expect(saved).toBeUndefined();
    await act(async () => lifecycle.recover(true));
    expect(field[0]).toBe('Browser edit');
    await settle();
    expect(saved?.fields).toEqual([['general-note-test', 'Browser edit'], ['other-note', 'New other note']]);
  });

  test('annotation draft writes and deletes carry the resumed nonce', async () => {
    const headers: (HeadersInit | undefined)[] = [];
    globalThis.fetch = Object.assign(async (input: string | URL | Request, options?: RequestInit) => {
      if (String(input).startsWith('/api/draft') && options) headers.push(options.headers);
      return Response.json(String(input).endsWith('/drafts') ? { drafts: {}, revision: 0 } : { supported: true, available: true, threads: [] });
    }, { preconnect: originalFetch.preconnect });
    await mount('resumed-nonce');
    await getDraftTransport().save({ codeAnnotations: [], draftGeneration: 1 }, { keepalive: false });
    await getDraftTransport().remove(2, { keepalive: false });
    expect(headers.map(value => new Headers(value).get('X-Plannotator-Session'))).toEqual(['resumed-nonce', 'resumed-nonce']);
  });

  test('refresh waits for a pending save and for edits typed while that save is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    let writes = 0;
    globalThis.fetch = Object.assign(async (input: string | URL | Request, options?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/drafts')) {
        if (!options) return Response.json({ drafts: {}, revision: 0 });
        const body = JSON.parse(String(options.body));
        const text = body.drafts.fields.find(([key]: [string]) => key === 'general-note-test')[1];
        order.push(text); writes++;
        if (writes === 1) await gate;
        return Response.json({ revision: writes });
      }
      if (url.endsWith('/refresh')) order.push('refresh');
      return Response.json({ supported: true, available: true, threads: [] });
    }, { preconnect: originalFetch.preconnect });
    await mount('transport');
    await act(async () => field[1]('first edit'));
    await settle();
    await act(async () => field[1]('later edit'));
    let refreshing!: Promise<void>;
    await act(async () => { refreshing = lifecycle.refresh(async () => { order.push('update'); return true; }); });
    expect(order).toEqual(['first edit']);
    await act(async () => { release(); await refreshing; });
    expect(order).toEqual(['first edit', 'later edit', 'refresh', 'update']);
  });

  test('a comment staged before autosave survives a rejected old-session write and merges other-device comments on resume', async () => {
    let resumed = false;
    const original = { id: 'original', text: 'Before' };
    globalThis.fetch = Object.assign(async (input: string | URL | Request, options?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/drafts')) return options ? new Response('suspended', { status: 409 }) : Response.json({ drafts: {}, revision: 0 });
      if (url === '/api/draft') {
        if (options?.method === 'POST') return Response.json({ code: 'session_mismatch' }, { status: 409 });
        return Response.json({ codeAnnotations: resumed ? [{ id: 'original', text: 'Other device edit' }, { id: 'other', text: 'Other device comment' }] : [original], draftGeneration: 2 });
      }
      return Response.json({ supported: true, available: true, threads: [] });
    }, { preconnect: originalFetch.preconnect });
    await mount('old-session');
    await getDraftTransport().load();
    const pending = { codeAnnotations: [original, { id: 'added', text: 'Just added' }], draftGeneration: 3 };
    await act(async () => stageCodeDraftRecovery(pending));
    await act(async () => { await expect(getDraftTransport().save(pending, { keepalive: false })).rejects.toThrow('session changed'); });
    await unmount(); restoreComposerDrafts({}); sessionStorage.clear(); __resetServerSessionForTests(); resumed = true;
    await mount('new-session');
    const restored = await getDraftTransport().load();
    expect(restored.data).toMatchObject({ codeAnnotations: [
      { id: 'original', text: 'Other device edit' }, { id: 'other', text: 'Other device comment' }, { id: 'added', text: 'Just added' },
    ] });
  });

});
