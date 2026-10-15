import React, { useEffect, useMemo, useState } from 'react';
import type { SelectedLineRange } from '@plannotator/ui/types';
import type { DiffFile } from '../../types';
import type { ReviewFileContents } from '../../hooks/useFileContents';
import type { IDockviewPanelProps } from 'dockview-react';
import { DiffViewer } from '../../components/DiffViewer';
import { useReviewState } from '../ReviewStateContext';
import { getReviewDiffPanelFilePath, type ReviewDiffPanelParams } from '../reviewPanelTypes';
import { annotationMatchesPrScope } from '../../utils/annotationScope';

/**
 * Thin adapter between dockview's panel API and the existing DiffViewer.
 *
 * Receives `filePath` from dockview params, reads everything else from
 * the ReviewStateContext. The existing DiffViewer component is not modified.
 */
export const ReviewDiffPanel: React.FC<IDockviewPanelProps> = (props) => {
  const state = useReviewState();
  const filePath =
    getReviewDiffPanelFilePath(props.params) ??
    getReviewDiffPanelFilePath(props.api.getParameters<ReviewDiffPanelParams>());
  const file = filePath
    ? state.files.find(candidate => candidate.path === filePath)
    : undefined;
  return file ? <ReviewFileDiff file={file} /> : (
    <div className="h-full flex items-center justify-center text-muted-foreground text-sm">File not found</div>
  );
};

/** The normal review viewer, also used for targets opened in References. */
export const ReviewFileDiff: React.FC<{
  file: DiffFile;
  reference?: { target: SelectedLineRange | null; isActive: boolean; unchanged: boolean; fileContents: ReviewFileContents | null };
}> = ({ file, reference }) => {
  const state = useReviewState();
  const [referenceSelection, setReferenceSelection] = useState<SelectedLineRange | null>(null);
  useEffect(() => {
    setReferenceSelection(reference?.target ?? null);
  }, [reference?.target]);
  const selection = reference ? referenceSelection : state.pendingSelection;
  const isFocusedFile = reference ? reference.isActive : state.focusedFilePath === file.path;

  const fileAnnotations = useMemo(
    () => {
      if (!file) return [];
      const currentPrUrl = state.prMetadata?.url;
      const currentDiffScope = state.prDiffScope;
      return state.allAnnotations.filter((a) =>
        a.filePath === file.path &&
        annotationMatchesPrScope(a, currentPrUrl, currentDiffScope)
      );
    },
    [state.allAnnotations, file, state.prMetadata, state.prDiffScope]
  );

  const aiMessagesForFile = useMemo(
    () =>
      file
        ? state.aiMessages.filter(
            (m) => m.question.filePath === file.path
          )
        : [],
    [state.aiMessages, file]
  );

  const reviewFilePaths = useMemo(
    () => new Set(state.files.map((candidate) => candidate.path)),
    [state.files]
  );

  const searchMatchesForFile = useMemo(
    () =>
      file && isFocusedFile && !reference
        ? state.activeFileSearchMatches
        : [],
    [state.activeFileSearchMatches, isFocusedFile, file, reference]
  );

  // Keying on reviewBase forces a remount when the user picks a new base.
  // Otherwise the file-content fetch for the new base can land before the new
  // patch, and Pierre briefly reconciles old-patch + new-content → "trailing
  // context mismatch" warnings in the console.
  return (
    <div key={`${file.path}:${state.reviewBase ?? ''}:${state.activeDiffBase ?? ''}:${state.snapshotId ?? ''}`} className="h-full relative">
      <DiffViewer
        patch={file.patch}
        filePath={file.path}
        fileContents={reference?.fileContents}
        oldPath={file.oldPath}
        status={file.status}
        reviewBase={state.reviewBase}
        reviewSnapshotId={state.snapshotId}
        imagePreviewAvailable={state.imagePreviewAvailable}
        imageSnapshotId={state.snapshotId}
        contextExpansionAvailable={reference?.unchanged ? false : state.contextExpansionAvailable}
        prUrl={state.prMetadata?.url}
        prDiffScope={state.prDiffScope}
        isFocused={isFocusedFile}
        diffStyle={reference?.unchanged ? 'unified' : state.diffStyle}
        diffOverflow={state.diffOverflow}
        diffIndicators={state.diffIndicators}
        lineDiffType={state.lineDiffType}
        disableLineNumbers={state.disableLineNumbers}
        disableBackground={state.disableBackground}
        expandUnchanged={reference ? true : state.expandUnchanged}
        fontFamily={state.fontFamily}
        fontSize={state.fontSize}
        annotations={fileAnnotations}
        selectedAnnotationId={state.selectedAnnotationId}
        scrollTargetAnnotation={state.scrollTargetAnnotation}
        pendingSelection={selection}
        compactTouchLayout={state.isCompactTouchLayout}
        onLineSelection={reference ? setReferenceSelection : state.onLineSelection}
        onAddAnnotation={(type, text, suggestedCode, originalCode, label, decorations, tokenMeta) => {
          if (!selection) return;
          state.onAddAnnotationForFile(file.path, type, text, suggestedCode, originalCode, label, decorations, tokenMeta,
            reference ? { file, range: selection } : undefined);
          if (reference) setReferenceSelection(null);
        }}
        onAddFileComment={(text) => state.onAddFileCommentForFile(file.path, text)}
        onEditAnnotation={state.onEditAnnotation}
        onSelectAnnotation={state.onSelectAnnotation}
        onDeleteAnnotation={state.onDeleteAnnotation}
        isViewed={state.viewedFiles.has(file.path)}
        isGenerated={state.generatedFiles.has(file.path)}
        onToggleViewed={() => state.onToggleViewed(file.path)}
        showViewedControls={!reference?.unchanged && state.showViewedControls}
        isStaged={state.stagedFiles.has(file.path)}
        isStaging={state.stagingFile === file.path}
        onStage={() => state.onStage(file.path)}
        // Per-path gate (falls back to the mode-level flag): in since-base the
        // single-file header lists committed files too — mode-level canStageFiles
        // alone would offer a no-op Git Add on them that flips local state.
        // Mirrors the `a` shortcut and the all-files header.
        canStage={state.canStagePath ? state.canStagePath(file.path) : state.canStageFiles}
        showStageControls={!reference?.unchanged && state.showStageControls}
        stageError={state.stageError}
        searchQuery={reference || state.isSearchPending ? '' : state.debouncedSearchQuery}
        searchMatches={searchMatchesForFile}
        activeSearchMatchId={!reference && isFocusedFile ? state.activeSearchMatchId : null}
        activeSearchMatch={
          !reference && isFocusedFile && state.activeSearchMatch?.filePath === file.path
            ? state.activeSearchMatch
            : null
        }
        aiAvailable={state.aiAvailable}
        onAskAI={(question) => state.onAskAIForFile(file.path, question,
          reference && selection ? { file, range: selection } : undefined)}
        isAILoading={state.isAILoading}
        onViewAIResponse={state.onViewAIResponse}
        aiMessages={aiMessagesForFile}
        onClickAIMarker={state.onClickAIMarker}
        aiHistoryMessages={reference ? aiMessagesForFile : isFocusedFile ? state.aiHistoryForSelection : []}
        onCodeNavRequest={state.onCodeNavRequest}
        onTokenHoverEnter={state.onTokenHoverEnter}
        onTokenHoverLeave={state.onTokenHoverLeave}
        reviewFilePaths={reviewFilePaths}
        onOpenReviewFile={state.openDiffFile}
        markdownPreviewSupported={!reference && !!state.markdownPreview}
        markdownView={state.markdownPreview ? state.markdownPreview.viewOf(file.path) : 'source'}
        markdownViewDisabledReason={state.markdownPreview?.lockReason(file.path) ?? null}
        onMarkdownViewChange={state.markdownPreview
          ? (view, how) => (how === 'chosen' ? state.markdownPreview!.choose : state.markdownPreview!.show)(file.path, view)
          : undefined}
      />
    </div>
  );
};
