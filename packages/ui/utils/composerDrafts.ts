// Optional host persistence for composers; without a subscriber these remain in-memory Maps.
const stores = new Map<string, Map<string, unknown>>();
const listeners = new Set<() => void>();
const restoreListeners = new Set<() => void>();
let restoreVersion = 0;
export const composerDraftVersion = () => restoreVersion;
export function subscribeComposerRestore(listener: () => void) { restoreListeners.add(listener); return () => { restoreListeners.delete(listener); }; }
let restoring = false;
function changed() { if (!restoring) for (const listener of listeners) listener(); }

export function createComposerDraftStore<T>(name: string): Map<string, T> {
  const store = new class extends Map<string, T> {
    set(key: string, value: T) { super.set(key, value); changed(); return this; }
    delete(key: string) { const deleted = super.delete(key); if (deleted) changed(); return deleted; }
    clear() { const hadItems = this.size > 0; super.clear(); if (hadItems) changed(); }
  }();
  stores.set(name, store);
  return store;
}

export function snapshotComposerDrafts(): Record<string, unknown> {
  return Object.fromEntries([...stores].map(([name, store]) => [name, [...store]]));
}

export function restoreComposerDrafts(drafts: Record<string, unknown>) {
  restoring = true;
  try {
    for (const [name, store] of stores) {
      store.clear();
      const entries = drafts[name];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string') store.set(entry[0], entry[1]);
    }
  } finally { restoring = false; }
  restoreVersion++;
  for (const listener of restoreListeners) listener();
}

export function subscribeComposerDrafts(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
