import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { ReviewDiscussion, ReviewDiscussionAnchor, ReviewDiscussionsSnapshot } from '../../core/review-discussions';
import { withServerSession, noteServerSessionMismatch, currentServerSession } from '@plannotator/ui/utils/serverSession';
import type { CodeAnnotation } from '@plannotator/ui/types';

interface CreateQuestion {
  id: string;
  snapshotId?: string;
  anchor: ReviewDiscussionAnchor;
  text: string;
  codeContext?: string;
}
const disconnectedMessage = 'Cannot reach this review. Unsent questions are kept in this tab. Check the connection or download saved questions before reopening.';
const endedMessage = 'This review has ended. Your question was not sent. Keep this tab open to copy unsent text, or download saved questions before starting another review.';
const markerPrefix = 'discussion-marker-';
export function discussionIdFromMarker(id: string) { return id.startsWith(markerPrefix) ? id.slice(markerPrefix.length) : null; }

export function useReviewDiscussionState(snapshotId?: string) {
  const [state, setState] = useState<ReviewDiscussionsSnapshot>({ supported: false, available: false, snapshotId: snapshotId ?? '', version: 0, threads: [] });
  const [error, setError] = useState<string>();
  const storageKey = `review-discussion-drafts:${location.pathname}:${currentServerSession() ?? 'loading'}`;
  const [disconnected, setDisconnected] = useState(false);
  const [ended, setEnded] = useState(false);
  const endedRef = useRef(false);
  const markEnded = useCallback(() => {
    endedRef.current = true;
    setEnded(true);
    setError(endedMessage);
  }, []);
  const [failedQuestions, setFailedQuestions] = useState<Record<string, CreateQuestion>>(() => {
    try { return JSON.parse(sessionStorage.getItem(storageKey + ':pending') ?? '{}'); } catch { return {}; }
  });
  const saveFailedQuestions = useCallback((update: (previous: Record<string, CreateQuestion>) => Record<string, CreateQuestion>) => {
    setFailedQuestions(previous => {
      const next = update(previous);
      try { sessionStorage.setItem(storageKey + ':pending', JSON.stringify(next)); } catch { /* Keep the in-memory copy. */ }
      return next;
    });
  }, [storageKey]);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    try { return JSON.parse(sessionStorage.getItem(storageKey) ?? '{}'); } catch { return {}; }
  });
  useEffect(() => {
    try { setDrafts(JSON.parse(sessionStorage.getItem(storageKey) ?? '{}')); } catch { setDrafts({}); }
    try { setFailedQuestions(JSON.parse(sessionStorage.getItem(storageKey + ':pending') ?? '{}')); } catch { setFailedQuestions({}); }
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
    const response = await fetch('/api/review-discussions').catch(() => { if (mounted.current) setDisconnected(true); throw new Error(disconnectedMessage); });
    if (response.status === 410) { if (mounted.current) markEnded(); return; }
    if (response.status === 404) return;
    if (!response.ok) { if (mounted.current) setDisconnected(true); throw new Error(disconnectedMessage); }
    if (mounted.current) setDisconnected(false);
    const next: ReviewDiscussionsSnapshot = await response.json();
    if (mounted.current && before === revision.current) setState(previous => (next.version ?? 0) < (previous.version ?? 0) || JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }, [markEnded]);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(); } catch { if (!cancelled) setDisconnected(true); }
      if (!cancelled && !endedRef.current) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { cancelled = true; mounted.current = false; clearTimeout(timer); };
  }, [refresh]);
  const request = useCallback(async (path: string, method: string, body: object) => {
    if (endedRef.current) throw new Error(endedMessage);
    revision.current++;
    setError(undefined);
    const response = await fetch(`/api/review-discussions${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(withServerSession(body)) }).catch(() => { setDisconnected(true); throw new Error(disconnectedMessage); });
    if (response.status === 410) { markEnded(); throw new Error(endedMessage); }
    if (await noteServerSessionMismatch(response)) throw new Error('This address now belongs to a different review. Your question was not sent. Copy it before reloading.');
    if (response.status === 401 || response.status === 403) throw new Error('Review access was lost. Your question is kept; reopen the original private access link.');
    const result = await response.json().catch(() => { throw new Error(disconnectedMessage); });
    if (response.status === 409 && result.error === 'This review has ended.') { markEnded(); throw new Error(endedMessage); }
    if (!response.ok) throw new Error(result.error ?? 'Could not save discussion');
    revision.current++;
    try { await refresh(); } catch { /* The mutation succeeded; polling will recover its snapshot. */ }
    return result;
  }, [refresh, markEnded]);
  const create = useCallback(async (anchor: ReviewDiscussionAnchor, text: string, codeContext?: string, retry?: CreateQuestion) => {
    const question = retry ?? Object.values(failedQuestions).find(previous =>
      previous.snapshotId === snapshotId && previous.text === text && previous.codeContext === codeContext
      && JSON.stringify(previous.anchor) === JSON.stringify(anchor)) ?? { id: crypto.randomUUID(), snapshotId, anchor, text, codeContext };
    saveFailedQuestions(previous => ({ ...previous, [question.id]: question }));
    try {
      await request('', 'POST', question);
      setThreadExpanded(question.id, true);
      saveFailedQuestions(previous => {
        const next = { ...previous };
        delete next[question.id];
        return next;
      });
      return true;
    } catch (cause) {
      saveFailedQuestions(previous => ({ ...previous, [question.id]: question }));
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  }, [snapshotId, request, setThreadExpanded, failedQuestions, saveFailedQuestions]);
  const pendingMessages = useRef(new Map<string, { id: string; text: string }>());
  const send = useCallback(async (id: string, text: string) => {
    let message = pendingMessages.current.get(id);
    if (!message || message.text !== text) {
      message = { id: crypto.randomUUID(), text };
      pendingMessages.current.set(id, message);
    }
    await request(`/${encodeURIComponent(id)}/messages`, 'POST', message);
    pendingMessages.current.delete(id);
  }, [request]);
  const update = useCallback(async (id: string, action: 'resolve' | 'reopen' | 'convert' | 'keep-waiting' | 'cancel', text?: string) => {
    const messageId = action === 'keep-waiting' || action === 'cancel' ? state.threads.find(thread => thread.id === id)?.messages.at(-1)?.id : undefined;
    return request(`/${encodeURIComponent(id)}`, 'PATCH', { action, text, messageId });
  }, [request, state.threads]);
  const setDraft = useCallback((id: string, text: string) => setDrafts(previous => {
    const next = { ...previous, [id]: text };
    try { sessionStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Keep the in-memory draft when storage is unavailable. */ }
    return next;
  }), [storageKey]);
  const markRead = useCallback((thread: ReviewDiscussion) => setSeen(previous => previous[thread.id] === thread.updatedAt ? previous : { ...previous, [thread.id]: thread.updatedAt }), []);
  const markers = useMemo<CodeAnnotation[]>(() => state.threads.filter(thread => thread.status !== 'converted' && thread.status !== 'resolved' && (thread.anchor.scope ?? 'line') === 'line' && thread.snapshotId === snapshotId).map(thread => ({
    ...thread.anchor, id: markerPrefix + thread.id, type: 'comment', text: `${thread.status}:${thread.updatedAt}`, createdAt: thread.createdAt,
  })), [state.threads, snapshotId]);
  return { ...state, snapshotId, markers, error: error ?? (disconnected ? disconnectedMessage : undefined), ended, disconnected, connectionError: ended ? endedMessage : disconnected ? disconnectedMessage : undefined, failedQuestions, create, send, update, drafts, setDraft, seen, markRead, expandedThreads, setThreadExpanded };
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

/** Recover converted comments only after the reviewer settles the saved draft. */
export function useDiscussionCommentRecovery({ threads, annotations, ready, addAnnotations }: {
  threads: ReviewDiscussion[];
  annotations: RefObject<CodeAnnotation[]>;
  ready: boolean;
  addAnnotations(annotations: CodeAnnotation[]): void;
}) {
  const recoveredIds = useRef(new Set<string>());
  useEffect(() => {
    if (!ready) return;
    const recovered = threads.flatMap(thread => {
      const { annotation } = thread;
      if (thread.status !== 'converted' || !annotation || thread.conversionSaved || recoveredIds.current.has(thread.id)) return [];
      recoveredIds.current.add(thread.id);
      return annotations.current.some(existing => existing.id === annotation.id) ? [] : [annotation];
    });
    addAnnotations(recovered);
  }, [threads, annotations, ready, addAnnotations]);
}
