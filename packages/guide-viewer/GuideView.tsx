import { limitDiscussionContext } from '@plannotator/core/review-discussion-context';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodeGuideData, GuideSection, GuideDiffRef } from '@plannotator/core/guide';
import type { DiffFile } from './types';
import { isLineRangeInPatch } from '@plannotator/core/diff-files';
import { analyzeGuideCoverage, resolveGuideBlock } from '@plannotator/core/guide-blocks';
import { useGuideHost } from './host';
import { renderInlineMarkdown } from './renderInlineMarkdown';
import { GuideSectionCard } from './GuideSectionCard';
import { GUIDE_EAGER_MOUNT_MAX_FILES, GuideViewportProvider } from './GuideViewportManager';

interface GuideViewProps {
  guide: CodeGuideData;
  reviewed: boolean[];
  onToggleReviewed: (index: number) => void;
  /** e.g. "Claude" / "Codex" — omitted when the generating job/engine is unknown. */
  engineLabel?: string;
  focusedFile: string | null;
  onFocusFile: (filePath: string) => void;
  /** Launch a fresh guide when a persisted guide no longer matches this branch. */
  onRegenerate?: () => void;
  /** Extra provenance line under the counts (portable exports: repo, PR link, changeset). */
  sourceLine?: React.ReactNode;
  /** Host-provided controls rendered top-right of the header (in-app: the export button). */
  headerActions?: React.ReactNode;
}

export interface ResolvedGuideBlock {
  id: string;
  ref: GuideDiffRef;
  file: DiffFile;
  fullFile?: DiffFile;
}

export interface ResolvedGuideSections {
  sectionBlocks?: ResolvedGuideBlock[][];
  sectionFiles: DiffFile[][];
  unplacedFiles: DiffFile[];
}

/** Resolve guide refs against the current patch while preserving generated
 * order. Focused refs keep distinct block identities; legacy refs retain
 * first-file placement. Invalid refs remain visible through coverage feedback. */
export function resolveGuideSectionFiles(guide: CodeGuideData, files: DiffFile[]): ResolvedGuideSections {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  if (guide.focused) {
    const sectionBlocks = guide.sections.map((section, sectionIndex) => section.diffs.flatMap((ref, index) => {
      const result = resolveGuideBlock(ref, files);
      if ('error' in result) return [];
      return [{ id: ref.id ?? `block:${sectionIndex}:${index}`, ref, file: result.file,
        fullFile: ref.kind === 'context' ? undefined : filesByPath.get(ref.file) }];
    }));
    return { sectionBlocks, sectionFiles: sectionBlocks.map(blocks => blocks.map(block => block.file)), unplacedFiles: [] };
  }
  const seen = new Set<string>();
  const sectionFiles = guide.sections.map((section) => {
    const resolved: DiffFile[] = [];
    for (const ref of section.diffs) {
      if (seen.has(ref.file)) continue;
      seen.add(ref.file);
      const file = filesByPath.get(ref.file);
      if (file) resolved.push(file);
    }
    return resolved;
  });

  const unplacedFiles: DiffFile[] = [];
  for (const filePath of guide.unplacedFiles ?? []) {
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    const file = filesByPath.get(filePath);
    if (file) unplacedFiles.push(file);
  }

  return { sectionFiles, unplacedFiles };
}

/**
 * Generated guide with the original vertical chapter/file-card layout. Every
 * lightweight file shell stays in document flow while GuideViewportProvider
 * bounds the mounted one-file Pierre CodeViews across all chapters.
 */
export const GuideView: React.FC<GuideViewProps> = ({
  guide,
  reviewed,
  onToggleReviewed,
  engineLabel,
  focusedFile,
  onFocusFile,
  onRegenerate,
  sourceLine,
  headerActions,
}) => {
  const host = useGuideHost();
  const resolved = useMemo(() => resolveGuideSectionFiles(guide, host.files), [guide, host.files]);
  // Only the guide's own files register shells; in-app the review may hold many more.
  const guideFileCount = resolved.sectionFiles.reduce((n, files) => n + files.length, 0) + resolved.unplacedFiles.length;
  const hasUnplaced = !guide.focused && (guide.unplacedFiles?.length ?? 0) > 0;
  const coverage = useMemo(() => guide.focused ? analyzeGuideCoverage(guide, host.files) : null, [guide, host.files]);
  const [focusedBlock, setFocusedBlock] = useState<string | null>(null);
  const blocks = resolved.sectionBlocks?.flat() ?? [];
  const currentBlock = blocks.find(block => block.id === focusedBlock && (!focusedFile || block.file.path === focusedFile))
    ?? blocks.find(block => block.file.path === focusedFile) ?? blocks[0];
  const activateBlock = (path: string, blockId?: string) => {
    if (blockId) setFocusedBlock(blockId);
    onFocusFile(path);
  };
  // The header counts sections, so the cards do too: "Everything else" is unnumbered.
  const cardTotal = guide.sections.length;
  const reviewedCount = reviewed.filter(Boolean).length;
  const effectiveFocusedFile = focusedFile
    ?? resolved.sectionFiles.find((files) => files.length > 0)?.[0]?.path
    ?? resolved.unplacedFiles[0]?.path
    ?? null;

  const localRevealTokenRef = useRef(0);
  const [localRevealTarget, setLocalRevealTarget] = useState<{ filePath: string; token: number; blockId?: string } | null>(null);
  const externalRevealTarget = host.revealFile
    ? { filePath: host.revealFile.path, token: host.revealFile.token, lineNumber: host.revealFile.lineNumber, side: host.revealFile.side }
    : null;
  const [lastExternalReveal, setLastExternalReveal] = useState<number | undefined>();
  useEffect(() => {
    if (host.revealFile?.token !== lastExternalReveal) {
      setLastExternalReveal(host.revealFile?.token);
      setLocalRevealTarget(null);
    }
  }, [host.revealFile?.token, lastExternalReveal]);
  const rawRevealTarget: { filePath: string; token: number; blockId?: string; lineNumber?: number; side?: 'old' | 'new' } | null = localRevealTarget ?? externalRevealTarget;
  const revealTarget = rawRevealTarget && guide.focused
    ? { ...rawRevealTarget, blockId: rawRevealTarget.blockId
      ?? blocks.find(block => block.file.path === rawRevealTarget.filePath && (!rawRevealTarget.lineNumber
        || isLineRangeInPatch(block.file.patch, rawRevealTarget.lineNumber, rawRevealTarget.lineNumber, rawRevealTarget.side ?? 'new')))?.id
      ?? blocks.find(block => block.file.path === rawRevealTarget.filePath)?.id }
    : rawRevealTarget;

  useEffect(() => {
    if (!revealTarget) return;
    if ('blockId' in revealTarget && typeof revealTarget.blockId === 'string') setFocusedBlock(revealTarget.blockId);
    onFocusFile(revealTarget.filePath);
    // Token identifies a navigation event; callback identity must not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealTarget?.filePath, revealTarget?.token]);

  const handleRequestReveal = useCallback(
    (filePath: string, blockId?: string) => {
      if (blockId) setFocusedBlock(blockId);
      onFocusFile(filePath);
      if (host.onRevealFile && !blockId) {
        host.onRevealFile(filePath);
      } else {
        localRevealTokenRef.current += 1;
        setLocalRevealTarget({ filePath, blockId, token: localRevealTokenRef.current });
      }
    },
    [onFocusFile, host.onRevealFile],
  );

  // Search results are global to the review, but an offscreen guide file has no
  // CodeView to receive the active match. Route each match change through the
  // same reveal channel as outline/sidebar jumps so its chapter opens, its shell
  // mounts, and the target viewer becomes active before line navigation runs.
  const activeSearchMatch = host.activeSearchMatch;
  useEffect(() => {
    if (!activeSearchMatch) return;
    const matchingBlock = blocks.find(block => block.file.path === activeSearchMatch.filePath && (!activeSearchMatch.lineNumber
      || isLineRangeInPatch(block.file.patch, activeSearchMatch.lineNumber, activeSearchMatch.lineNumber, activeSearchMatch.side === 'deletion' ? 'old' : 'new')));
    handleRequestReveal(activeSearchMatch.filePath, matchingBlock?.id);
  }, [activeSearchMatch?.id, activeSearchMatch?.filePath, handleRequestReveal]);

  const unplacedSection = useMemo<GuideSection | null>(
    () =>
      hasUnplaced
        ? {
            title: 'Everything else',
            overview: "Changed files the guide didn't place into a section — shown so nothing is silently left out.",
            diffs: (guide.unplacedFiles ?? []).map((file) => ({ file })),
          }
        : null,
    [guide.unplacedFiles, hasUnplaced],
  );

  return (
    <GuideViewportProvider className="w-full px-3 py-5 sm:px-6 sm:py-6 lg:px-10 lg:py-8" eager={guideFileCount <= GUIDE_EAGER_MOUNT_MAX_FILES}>
      {/* Header actions sit in a row above the title on narrow screens and float beside it from md up (desktop unchanged). */}
      {headerActions && <div className="mb-3 flex items-center justify-end gap-2 md:float-right md:mb-0 md:ml-6">{headerActions}</div>}
      <div className="max-w-[72ch]">
        <h1 className="text-[22px] font-semibold tracking-tight text-foreground [text-wrap:balance]">{guide.title}</h1>
        {guide.intent && (
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{renderInlineMarkdown(guide.intent)}</p>
        )}
        <p className="mt-2 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground/60">
          <span>
            {guide.sections.length} section{guide.sections.length !== 1 ? 's' : ''}
            {reviewedCount > 0 && ` · ${reviewedCount}/${guide.sections.length} reviewed`}
            {engineLabel && ` · generated by ${engineLabel}`}
          </span>
          {guide.saved && (
            <span
              className="rounded border border-border/50 bg-muted/40 px-1.5 py-px text-[10px] text-muted-foreground"
              title="This guide is persisted and will be available the next time this review opens"
            >
              Saved
            </span>
          )}
        </p>
        {sourceLine && (
          <p className="mt-1.5 font-mono text-[11px] text-muted-foreground/60">{sourceLine}</p>
        )}
        {guide.moved && (
          <p className="mt-1.5 font-mono text-[11px] text-muted-foreground/50">
            Generated on a different version of this branch
            {onRegenerate && (
              <>
                {' · '}
                <button
                  type="button"
                  onClick={onRegenerate}
                  className="underline-offset-2 hover:text-foreground hover:underline"
                >
                  Regenerate
                </button>
              </>
            )}
          </p>
        )}
      </div>

      {coverage && (
        <details className="mt-4 rounded-lg border border-border/50 bg-muted/20 px-4 py-3" open={!coverage.complete}>
          <summary className="cursor-pointer text-sm font-medium">
            {coverage.complete ? 'Complete coverage' : 'Guide incomplete'} · {coverage.coveredLines}/{coverage.totalLines} changed lines explained
          </summary>
          {!coverage.complete && <>
            <p className="mt-2 text-xs text-muted-foreground">The author can add or replace individual blocks to address these gaps. The ordinary diff remains available.</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
              {coverage.issues.map((issue, index) => <li key={`${issue.blockId ?? issue.file}:${index}`}>{issue.message}</li>)}
            </ul>
          </>}
        </details>
      )}

      <div className="mt-6 space-y-4">
        {guide.sections.map((section, index) => (
          <GuideSectionCard
            guideContext={`Guide: ${limitDiscussionContext(guide.title, 300)}\nIntent: ${limitDiscussionContext(guide.intent ?? '', 500)}`}
            key={`${section.title}:${index}`}
            section={section}
            files={resolved.sectionFiles[index] ?? []}
            blocks={resolved.sectionBlocks?.[index]}
            focusedBlock={currentBlock?.id}
            index={index}
            total={cardTotal}
            reviewed={!!reviewed[index]}
            onToggleReviewed={() => onToggleReviewed(index)}
            focusedFile={effectiveFocusedFile}
            revealTarget={revealTarget}
            onActivate={activateBlock}
            onRequestReveal={handleRequestReveal}
          />
        ))}

        {unplacedSection && (
          <GuideSectionCard
            guideContext={`Guide: ${limitDiscussionContext(guide.title, 300)}\nIntent: ${limitDiscussionContext(guide.intent ?? '', 500)}`}
            section={unplacedSection}
            files={resolved.unplacedFiles}
            index={guide.sections.length}
            total={cardTotal}
            showReviewed={false}
            numbered={false}
            focusedFile={effectiveFocusedFile}
            revealTarget={revealTarget}
            onActivate={activateBlock}
            onRequestReveal={handleRequestReveal}
          />
        )}
      </div>
    </GuideViewportProvider>
  );
};
