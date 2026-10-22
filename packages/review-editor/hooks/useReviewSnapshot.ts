import { useCallback, useState } from 'react';
import type { SinceBaseSections, CommitDiffInfo } from '@plannotator/shared/types';
import type { SemanticDiffAdvert } from '@plannotator/shared/semantic-diff-types';
import type { CallFlowAdvert } from '@plannotator/shared/call-flow-types';
import type { DiffFile } from '../types';
import { parseDiffToFiles } from '../utils/diffParser';
import { readApprovalNotesAdvert } from '../reviewDecision';

/** Fields shared by initial loads, local diff switches and PR responses. */
export interface ReviewSnapshotResponse {
  rawPatch: string;
  gitRef: string;
  aiReviewContext?: string;
  snapshotId?: string;
  sections?: SinceBaseSections;
  commitInfo?: CommitDiffInfo;
  generatedFiles?: string[];
  baseBehindRemote?: boolean;
  approvalNotesSupported?: boolean;
  imagePreviewSupported?: boolean;
  markdownPreviewSupported?: boolean;
  semanticDiff?: SemanticDiffAdvert;
  callFlow?: CallFlowAdvert;
}

interface ReviewSnapshot {
  diffData: Pick<ReviewSnapshotResponse, 'rawPatch' | 'gitRef' | 'aiReviewContext'> | null;
  files: DiffFile[];
  snapshotId?: string;
  sections: SinceBaseSections | null;
  commitInfo: CommitDiffInfo | null;
  generatedFiles: Set<string>;
  baseBehindRemote: boolean;
  approvalNotesSupported: boolean;
  imagePreviewSupported: boolean;
  markdownPreviewSupported: boolean;
}

// Only sort when a fresh snapshot arrives. Live staging overrides must not move files.
function orderFilesBySections(files: DiffFile[], sections?: SinceBaseSections): DiffFile[] {
  if (!sections) return files;
  const rank = (file: DiffFile): number => {
    const entry = sections.files[file.path];
    const group = entry?.group ?? 'committed';
    if (group === 'committed') return 0;
    if (group === 'changes') return entry?.staged ? 1 : 2;
    return 3;
  };
  return files
    .map((file, index) => ({ file, index }))
    .sort((a, b) => rank(a.file) - rank(b.file) || a.index - b.index)
    .map(entry => entry.file);
}

/** Keeps the rendered patch, file order and snapshot metadata in one update. */
export function useReviewSnapshot() {
  const [state, setState] = useState<ReviewSnapshot>({
    diffData: null, files: [], sections: null, commitInfo: null,
    generatedFiles: new Set(), baseBehindRemote: false,
    approvalNotesSupported: false, imagePreviewSupported: false, markdownPreviewSupported: false,
  });
  const applySnapshot = useCallback((data: ReviewSnapshotResponse): DiffFile[] => {
    const files = orderFilesBySections(parseDiffToFiles(data.rawPatch), data.sections);
    setState(previous => ({
      diffData: { rawPatch: data.rawPatch, gitRef: data.gitRef, aiReviewContext: data.aiReviewContext },
      files,
      snapshotId: data.snapshotId,
      sections: data.sections ?? null,
      commitInfo: data.commitInfo ?? null,
      generatedFiles: new Set(data.generatedFiles ?? []),
      baseBehindRemote: data.baseBehindRemote === true,
      // Older servers omit these on switches; absence must not revoke a known capability.
      approvalNotesSupported: data.approvalNotesSupported === undefined ? previous.approvalNotesSupported : readApprovalNotesAdvert(data.approvalNotesSupported),
      imagePreviewSupported: data.imagePreviewSupported === undefined ? previous.imagePreviewSupported : data.imagePreviewSupported === true,
      markdownPreviewSupported: data.markdownPreviewSupported === undefined ? previous.markdownPreviewSupported : data.markdownPreviewSupported === true,
    }));
    return files;
  }, []);
  const setBaseBehindRemote = useCallback((behind: boolean) => {
    setState(previous => previous.baseBehindRemote === behind ? previous : { ...previous, baseBehindRemote: behind });
  }, []);
  return { ...state, applySnapshot, setBaseBehindRemote };
}
