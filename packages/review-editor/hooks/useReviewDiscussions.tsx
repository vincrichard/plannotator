import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReviewDiscussion, ReviewDiscussionAnchor } from '../../core/review-discussions';
import { withServerSession, noteServerSessionMismatch, currentServerSession } from '@plannotator/ui/utils/serverSession';
import type { CodeAnnotation } from '@plannotator/ui/types';

interface Snapshot {
  supported?: boolean;
  available: boolean;
  reason?: string;
  provider?: 'codex' | 'claude';
  snapshotId?: string;
  threads: ReviewDiscussion[];
  version?: number;
}
interface CreateQuestion { id: string; snapshotId?: string; anchor: ReviewDiscussionAnchor; text: string; codeContext?: string }
const markerPrefix = 'discussion-marker-';
export function discussionIdFromMarker(id: string) { return id.startsWith(markerPrefix) ? id.slice(markerPrefix.length) : null; }

export function useReviewDiscussionState(snapshotId?: string) {
  const [state, setState] = useState<Snapshot>({ available: false, threads: [] });
  const [error, setError] = useState<string>();
  const [failedQuestions, setFailedQuestions] = useState<Record<string, CreateQuestion>>({});
  const storageKey = `review-discussion-drafts:${location.pathname}:${currentServerSession() ?? 'loading'}`;
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    try { return JSON.parse(sessionStorage.getItem(storageKey) ?? '{}'); } catch { return {}; }
  });
  useEffect(() => {
    try { setDrafts(JSON.parse(sessionStorage.getItem(storageKey) ?? '{}')); } catch { setDrafts({}); }
  }, [storageKey]);
  const [expandedThreads, setExpandedThreads] = useState<Record<string, boolean>>({});
  const setThreadExpanded = useCallback((id: string, expanded: boolean) => {
    setExpandedThreads(previous => ({ ...previous, [id]: expanded }));
  }, []);
  const [seen, setSeen] = useState<Record<string, number>>({});
  const revision = useRef(0);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    const before = revision.current;
    const response = await fetch('/api/review-discussions');
    if (response.status === 404) return;
    if (!response.ok) throw new Error('Could not load discussions. Retrying…');
    const next: Snapshot = await response.json();
    if (mounted.current && before === revision.current) setState(previous => (next.version ?? 0) < (previous.version ?? 0) || JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }, []);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(); } catch (cause) { if (!cancelled) setError(String(cause instanceof Error ? cause.message : cause)); }
      if (!cancelled) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { cancelled = true; mounted.current = false; clearTimeout(timer); };
  }, [refresh]);
  const request = useCallback(async (path: string, method: string, body: object) => {
    revision.current++;
    setError(undefined);
    const response = await fetch(`/api/review-discussions${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(withServerSession(body)) });
    await noteServerSessionMismatch(response);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Could not save discussion');
    revision.current++;
    try { await refresh(); } catch { /* The mutation succeeded; polling will recover its snapshot. */ }
    return result;
  }, [refresh]);
  const create = useCallback(async (anchor: ReviewDiscussionAnchor, text: string, codeContext?: string, retry?: CreateQuestion) => {
    const question = retry ?? Object.values(failedQuestions).find(previous =>
      previous.snapshotId === snapshotId && previous.text === text && previous.codeContext === codeContext
      && JSON.stringify(previous.anchor) === JSON.stringify(anchor)) ?? { id: crypto.randomUUID(), snapshotId, anchor, text, codeContext };
    try { await request('', 'POST', question); setThreadExpanded(question.id, true); setFailedQuestions(previous => { const next = { ...previous }; delete next[question.id]; return next; }); return true; }
    catch (cause) { setFailedQuestions(previous => ({ ...previous, [question.id]: question })); setError(cause instanceof Error ? cause.message : String(cause)); return false; }
  }, [snapshotId, request, setThreadExpanded, failedQuestions]);
  const pendingMessages = useRef(new Map<string, { id: string; text: string }>());
  const send = useCallback(async (id: string, text: string) => {
    let message = pendingMessages.current.get(id);
    if (!message || message.text !== text) { message = { id: crypto.randomUUID(), text }; pendingMessages.current.set(id, message); }
    await request(`/${encodeURIComponent(id)}/messages`, 'POST', message);
    pendingMessages.current.delete(id);
  }, [request]);
  const update = useCallback(async (id: string, action: 'resolve' | 'reopen' | 'convert', text?: string) => {
    return request(`/${encodeURIComponent(id)}`, 'PATCH', { action, text });
  }, [request]);
  const setDraft = useCallback((id: string, text: string) => setDrafts(previous => {
    const next = { ...previous, [id]: text };
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Keep the in-memory draft when storage is unavailable. */ }
    return next;
  }), [storageKey]);
  const markRead = useCallback((thread: ReviewDiscussion) => setSeen(previous => previous[thread.id] === thread.updatedAt ? previous : { ...previous, [thread.id]: thread.updatedAt }), []);
  const markers = useMemo<CodeAnnotation[]>(() => state.threads.filter(thread => thread.status !== 'converted' && thread.status !== 'resolved' && (thread.anchor.scope ?? 'line') === 'line' && thread.snapshotId === snapshotId).map(thread => ({
    ...thread.anchor, id: markerPrefix + thread.id, type: 'comment', text: `${thread.status}:${thread.updatedAt}`, createdAt: thread.createdAt,
  })), [state.threads, snapshotId]);
  return { ...state, snapshotId, markers, error, failedQuestions, create, send, update, drafts, setDraft, seen, markRead, expandedThreads, setThreadExpanded };
}
export type ReviewDiscussions = ReturnType<typeof useReviewDiscussionState> & {
  conversionReady: boolean;
  conversionUnavailableReason?: string;
};
const Context = createContext<ReviewDiscussions | null>(null);
export const ReviewDiscussionsProvider = Context.Provider;
export const useReviewDiscussions = () => useContext(Context);
export function useDiscussionAnnotations(annotations: CodeAnnotation[], filePath?: string) {
  const discussion = useReviewDiscussions();
  return useMemo(() => discussion?.markers.length ? [...annotations, ...discussion.markers.filter(marker => !filePath || marker.filePath === filePath)] : annotations, [annotations, discussion?.markers, filePath]);
}

/** Draft restoration must not replace a change request already recovered from a discussion. */
export function mergeDiscussionComments(restored: CodeAnnotation[], current: CodeAnnotation[], threads: ReviewDiscussion[]): CodeAnnotation[] {
  const converted = new Set(threads.flatMap(thread => thread.annotation ? [thread.annotation.id] : []));
  const retained = current.filter(annotation => converted.has(annotation.id));
  const ids = new Set(retained.map(annotation => annotation.id));
  return [...restored.filter(annotation => !ids.has(annotation.id)), ...retained];
}
