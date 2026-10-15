import { useMemo, useState } from 'react';
import type { DiffFile } from '../types';
import { useFileContents } from './useFileContents';
import { unchangedReferenceFile } from '../utils/referencePreview';

/** Mounted per path/snapshot by the References panel; never caches working-tree bytes. */
export function useCodeNavPreview(filePath: string, changedFile: DiffFile | undefined, reviewBase?: string, snapshotId?: string) {
  const [reloadToken, setReloadToken] = useState(0);
  const { fileContents, loading, stale } = useFileContents({
    filePath,
    oldPath: changedFile?.oldPath,
    reviewBase,
    reviewSnapshotId: snapshotId,
    enabled: true,
    reloadToken,
  });
  const file = useMemo(() => {
    if (changedFile) return changedFile;
    if (!fileContents || fileContents.new == null || fileContents.old !== fileContents.new) return null;
    if (fileContents.new.includes('\0')) return null;
    return unchangedReferenceFile(filePath, fileContents.new);
  }, [filePath, changedFile, fileContents]);

  return {
    file,
    retry: () => setReloadToken(token => token + 1),
    fileContents,
    loading,
    error: stale
      ? 'The review snapshot is stale. Refresh the review to load this file.'
      : !loading && !file
        ? 'This file is unavailable or differs from the selected review. Refresh or choose another diff.'
        : null,
  };
}
