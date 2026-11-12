import React, { useCallback, useMemo } from 'react';
import { GuideHostProvider, type GuideDiffRendererContext, type GuideHostValue } from '@plannotator/guide-viewer/host';
import { DiscussionMarkdown } from '../DiscussionResponse';
import { AnnotationBadge, QuestionBadge } from '../FileRowBits';
import { useReviewState } from '../../dock/ReviewStateContext';
import { AllFilesCodeView, type AllFilesCodeViewProps } from '../AllFilesCodeView';

/**
 * The review app's guide host: adapts ReviewState into the narrow contract the
 * packaged guide chain consumes (`@plannotator/guide-viewer/host`), and names
 * `AllFilesCodeView` as the diff renderer with the full in-app wiring
 * (annotations, staging, viewed, search, AI markers).
 *
 * This is the only place review state reaches the guide chain. The portable
 * viewer provides the same contract with a read-only renderer, so both hosts
 * render byte-identical guides (decision record D2).
 */
type InAppRendererProps = Omit<
  AllFilesCodeViewProps,
  | 'files'
  | 'fileScrollTarget'
  | 'fileOrder'
  | 'mountCollapsed'
  | 'initialScrollPosition'
  | 'onScrollPositionChange'
  | 'onFileCollapsedChange'
  | 'isActive'
  | 'allowScrollChaining'
>;

export const ReviewGuideHost: React.FC<{ active: boolean; children: React.ReactNode }> = ({ active, children }) => {
  const state = useReviewState();

  const annotationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const annotation of state.allAnnotations) {
      counts.set(annotation.filePath, (counts.get(annotation.filePath) ?? 0) + 1);
    }
    return counts;
  }, [state.allAnnotations]);

  const getDiffRendererProps = useCallback(
    ({ focused, blockId, contextOnly, guideContext }: GuideDiffRendererContext): InAppRendererProps => ({
      diffStyle: state.diffStyle,
      diffOverflow: state.diffOverflow,
      diffIndicators: state.diffIndicators,
      lineDiffType: state.lineDiffType,
      disableLineNumbers: state.disableLineNumbers,
      disableBackground: state.disableBackground,
      expandUnchanged: state.expandUnchanged,
      fontFamily: state.fontFamily,
      fontSize: state.fontSize,
      annotations: state.allAnnotations,
      selectedAnnotationId: state.selectedAnnotationId,
      scrollTargetAnnotation: active && focused ? state.scrollTargetAnnotation : null,
      // Only the focused card is the selection target; a shared pending
      // selection painted on every mounted card would highlight the wrong file.
      pendingSelection: active && focused ? state.pendingSelection : null,
      reviewBase: state.reviewBase,
      reviewSnapshotId: state.feedbackDiffContext?.snapshotId,
      onLineSelection: state.onLineSelection,
      onAddAnnotationForFile: state.onAddAnnotationForFile,
      onEditAnnotation: state.onEditAnnotation,
      onSelectAnnotation: state.onSelectAnnotation,
      onDeleteAnnotation: state.onDeleteAnnotation,
      onAddFileCommentForFile: state.onAddFileCommentForFile,
      viewedFiles: state.viewedFiles,
      onToggleViewed: contextOnly ? undefined : state.onToggleViewed,
      showViewedControls: blockId ? false : state.showViewedControls,
      stagedFiles: state.stagedFiles,
      onStage: state.onStage,
      canStageFiles: contextOnly ? false : state.canStageFiles,
      showStageControls: contextOnly ? false : state.showStageControls,
      canStagePath: state.canStagePath,
      stagingFile: state.stagingFile,
      stageError: state.stageError,
      prUrl: state.prMetadata?.url,
      prDiffScope: state.prDiffScope,
      searchQuery: state.isSearchPending ? '' : state.debouncedSearchQuery,
      searchMatches: state.searchMatches,
      activeSearchMatchId: state.activeSearchMatchId,
      activeSearchMatch: active ? state.allFilesActiveSearchMatch : null,
      onCodeNavRequest: state.onCodeNavRequest,
      aiAvailable: state.aiAvailable,
      onAskAIForFile: (filePath, question, selection) => state.onAskAIForFile(filePath, question, selection ? { ...selection, guideContext } : undefined),
      isAILoading: state.isAILoading,
      onViewAIResponse: state.onViewAIResponse,
      aiMessages: state.aiMessages,
      onClickAIMarker: state.onClickAIMarker,
      getAIHistoryForFile: state.getAIHistoryForFile,
    }),
    [state, active],
  );

  const value = useMemo<GuideHostValue<InAppRendererProps>>(
    () => ({
      active,
      files: state.files,
      DiffRenderer: AllFilesCodeView,
      getDiffRendererProps,
      renderExplanation: text => <DiscussionMarkdown text={text} />,
      renderFileBadges: filePath => <>
        <AnnotationBadge count={annotationCounts.get(filePath) ?? 0} />
        <QuestionBadge filePath={filePath} />
      </>,
      revealFile: state.guideRevealFile,
      onRevealFile: state.onGuideRevealFile,
      activeSearchMatch: active ? state.allFilesActiveSearchMatch : null,
    }),
    [active, state.files, annotationCounts, getDiffRendererProps, state.guideRevealFile, state.onGuideRevealFile, state.allFilesActiveSearchMatch],
  );

  return <GuideHostProvider value={value}>{children}</GuideHostProvider>;
};
