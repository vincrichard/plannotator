import { useCallback, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import { composerDraftVersion, createComposerDraftStore, subscribeComposerRestore } from '../utils/composerDrafts';

const fields = createComposerDraftStore<unknown>('fields');

/** Behaves as useState unless the host explicitly restores durable composer drafts. */
export function useComposerDraftState<T>(key: string | undefined, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const version = useSyncExternalStore(subscribeComposerRestore, composerDraftVersion, composerDraftVersion);
  const restored = () => key && version && fields.has(key) ? fields.get(key) as T : initial;
  const [state, setState] = useState(() => ({ version, value: restored() }));
  const value = state.version === version ? state.value : restored();
  const set = useCallback<Dispatch<SetStateAction<T>>>(update => {
    setState(previous => {
      const before = previous.version === version ? previous.value : restored();
      const next = typeof update === 'function' ? (update as (previous: T) => T)(before) : update;
      if (key && version) fields.set(key, next);
      return { version, value: next };
    });
  }, [key, version, initial]);
  return [value, set];
}
