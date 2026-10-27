import { setDraftRequestHeaders } from '@plannotator/ui/hooks/useAnnotationDraft';
import { useCallback, useEffect, useRef, useState } from 'react';
import { restoreComposerDrafts, snapshotComposerDrafts, subscribeComposerDrafts } from '@plannotator/ui/utils/composerDrafts';
import { currentServerSession, noteServerSessionMismatch, withServerSession } from '@plannotator/ui/utils/serverSession';

export interface ReviewLifecycle { id: string; frozen: boolean }
type Drafts = Record<string, unknown>;
interface Backup { base: Drafts; drafts: Drafts }
const endpoint = '/api/review-lifecycle';
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const entries = (value: unknown): Map<string, unknown> => new Map(Array.isArray(value) ? value.filter(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string') : []);

/** Apply only this browser's edits; preserve unrelated work saved by another tab/device. */
export function mergeComposerBackup({ base, drafts }: Backup, remote: Drafts) {
  const merged = { ...remote };
  let conflict = false;
  for (const name of new Set([...Object.keys(base), ...Object.keys(drafts)])) {
    const before = entries(base[name]);
    const local = entries(drafts[name]);
    const latest = entries(remote[name]);
    for (const key of new Set([...before.keys(), ...local.keys()])) {
      if (equal(before.get(key), local.get(key))) continue;
      if (!equal(latest.get(key), before.get(key)) && !equal(latest.get(key), local.get(key))) conflict = true;
      if (local.has(key)) latest.set(key, local.get(key)); else latest.delete(key);
    }
    merged[name] = [...latest];
  }
  return { drafts: merged, conflict };
}

export function useReviewLifecycle() {
  const [review, setReview] = useState<ReviewLifecycle>();
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [recovery, setRecovery] = useState<Drafts>();
  const base = useRef<Drafts>({});
  const revision = useRef(0);
  const needsSave = useRef(false);
  const flushRef = useRef<() => Promise<void>>(async () => {});
  const load = useCallback(async (value?: ReviewLifecycle) => {
    if (!value) return;
    setDraftRequestHeaders(() => { const nonce = currentServerSession(); return nonce ? { 'X-Plannotator-Session': nonce } : {}; });
    setReview(value);
    setReady(false);
    try {
      const response = await fetch(`${endpoint}/drafts`);
      if (!response.ok) throw new Error('Saved unfinished comments could not be loaded. Reload to retry.');
      const data = await response.json();
      base.current = data.drafts ?? {};
      revision.current = data.revision ?? 0;
      let backup: Backup | undefined;
      try { const saved = localStorage.getItem(`review-composers:${value.id}`); if (saved) backup = JSON.parse(saved); } catch { /* Server copy remains available. */ }
      const merged = backup?.base && backup.drafts ? mergeComposerBackup(backup, base.current) : { drafts: base.current, conflict: false };
      if (merged.conflict) {
        setRecovery(merged.drafts);
        restoreComposerDrafts(base.current);
      } else {
        restoreComposerDrafts(merged.drafts);
        needsSave.current = !equal(merged.drafts, base.current);
        setReady(true);
      }
      setError(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }, []);
  const recover = useCallback((useBrowser: boolean) => {
    restoreComposerDrafts(useBrowser && recovery ? recovery : base.current);
    needsSave.current = useBrowser;
    if (!useBrowser && review) try { localStorage.removeItem(`review-composers:${review.id}`); } catch { /* Optional browser backup. */ }
    setRecovery(undefined);
    setReady(true);
  }, [recovery, review]);

  useEffect(() => {
    if (!review || !ready) return;
    const backupKey = `review-composers:${review.id}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dirty = needsSave.current;
    needsSave.current = false;
    let saving: Promise<void> | undefined;
    let stopped = false;
    const backup = () => {
      try { localStorage.setItem(backupKey, JSON.stringify({ base: base.current, drafts: snapshotComposerDrafts() })); } catch { /* Server persistence still works without browser storage. */ }
    };
    const flush = (): Promise<void> => {
      clearTimeout(timer);
      if (saving) return saving;
      saving = (async () => {
        // Drain changes typed while a request is in flight before allowing snapshot refresh.
        while (dirty) {
          dirty = false;
          const drafts = snapshotComposerDrafts();
          const body = JSON.stringify(withServerSession({ drafts, revision: revision.current }));
          try {
            const response = await fetch(`${endpoint}/drafts`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: body.length < 32_000 });
            if (await noteServerSessionMismatch(response)) throw new Error('This review resumed in another session. Reload before continuing.');
            if (response.status === 409) throw new Error('Drafts changed in another tab. Reload to compare them with your unsaved browser edits.');
            if (!response.ok) throw new Error('Unfinished comments are not saved to the server. Keep this tab open and retry.');
            const result = await response.json();
            revision.current = result.revision;
            base.current = drafts;
            if (dirty) backup();
            else try { localStorage.removeItem(backupKey); } catch { /* Optional browser backup. */ }
            if (!stopped) setError(undefined);
          } catch (cause) {
            dirty = true;
            if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
            throw cause;
          }
        }
      })().finally(() => { saving = undefined; });
      return saving;
    };
    flushRef.current = flush;
    const changed = () => {
      dirty = true; backup(); clearTimeout(timer);
      timer = setTimeout(() => { void flush().catch(() => {}); }, 250);
    };
    const unsubscribe = subscribeComposerDrafts(changed);
    if (dirty) changed();
    let lastActivity = -Infinity;
    const activity = (event: Event) => {
      if (!event.isTrusted) return;
      // Raw scroll also fires for layout/navigation; wheel/touch/key/pointer indicate user input.
      const now = Date.now();
      if (now - lastActivity < 30_000) return;
      lastActivity = now;
      void fetch(`${endpoint}/activity`, { method: 'POST', headers: { 'X-Plannotator-Session': currentServerSession() ?? '' }, keepalive: true }).catch(() => {});
      if (dirty) void flush().catch(() => {});
    };
    const events = ['keydown', 'pointerdown', 'wheel', 'touchmove'];
    for (const event of events) window.addEventListener(event, activity, { capture: true, passive: true });
    const hide = () => { void flush().catch(() => {}); };
    window.addEventListener('pagehide', hide);
    return () => {
      stopped = true; unsubscribe(); clearTimeout(timer); hide();
      window.removeEventListener('pagehide', hide);
      for (const event of events) window.removeEventListener(event, activity, true);
    };
  }, [review?.id, ready]);

  const refresh = useCallback(async (update: () => Promise<boolean>) => {
    setRefreshing(true);
    try {
      if (!ready) throw new Error('Restore saved drafts before refreshing the snapshot.');
      await flushRef.current();
      const response = await fetch(`${endpoint}/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(withServerSession({})) });
      if (await noteServerSessionMismatch(response) || !response.ok || !await update()) throw new Error('Could not refresh the saved snapshot. Please retry.');
      setReview(previous => previous && { ...previous, frozen: false });
      setError(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRefreshing(false); }
  }, [ready]);
  return { review, ready, error, load, refresh, refreshing, recovery, recover };
}
