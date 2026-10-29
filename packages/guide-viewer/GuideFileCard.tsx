import { limitDiscussionContext } from '@plannotator/core/review-discussion-context';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DiffFile } from './types';
import { useGuideHost } from './host';
import { renderInlineMarkdown } from './renderInlineMarkdown';
import { useGuideFileWindow } from './GuideViewportManager';

function estimateDiffHeight(patch: string): number {
  const lineCount = patch.split('\n').length;
  return Math.max(150, Math.min(lineCount * 21 + 52, 620));
}

interface GuideFileCardProps {
  guideContext?: string;
  file: DiffFile;
  blockId?: string;
  fullFile?: DiffFile;
  contextOnly?: boolean;
  summary?: string;
  focused: boolean;
  revealTarget: { filePath: string; token: number; blockId?: string } | null;
  onActivate: (filePath: string, blockId?: string) => void;
}

/**
 * One original-style Guided Review file block. The description and fixed-size
 * shell always remain in document flow; the expensive one-file CodeView only
 * exists while the shared outer viewport manager admits this file.
 */
export const GuideFileCard: React.FC<GuideFileCardProps> = ({
  file,
  guideContext,
  blockId,
  fullFile,
  contextOnly,
  summary,
  focused,
  revealTarget,
  onActivate,
}) => {
  const { DiffRenderer, getDiffRendererProps, active = true } = useGuideHost();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const scrollPositionRef = useRef(0);
  const [collapsed, setCollapsed] = useState(false);
  const [expandedContext, setExpandedContext] = useState(false);
  const shownFile = expandedContext && fullFile ? fullFile : file;
  const fileList = useMemo(() => [shownFile], [shownFile]);
  const { mounted, register, requestMount } = useGuideFileWindow(blockId ?? file.path, focused);
  const diffHeight = useMemo(() => estimateDiffHeight(shownFile.patch), [shownFile.patch]);
  const target = revealTarget?.filePath === file.path && (!blockId || revealTarget.blockId === blockId) ? revealTarget : null;
  const renderedHeight = collapsed ? 49 : diffHeight;

  // A navigation target can live far outside the current outer window or in a
  // chapter that was just reopened. Force its CodeView first, then move the
  // lightweight shell into view; the tokenized inner target completes the jump.
  useEffect(() => {
    if (!target) return;
    setCollapsed(false);
    requestMount();
    onActivate(file.path, blockId);
    const raf = requestAnimationFrame(() => {
      shellRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    return () => cancelAnimationFrame(raf);
    // Token identifies the navigation event; callback identity must not replay it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.token]);

  // Keyboard/sidebar focus may reach a file through a path that does not emit a
  // fresh guide reveal token. Ensure the focused shell is eligible to mount.
  useEffect(() => {
    if (focused) requestMount();
  }, [focused, requestMount]);

  const attachShell = useCallback((element: HTMLDivElement | null) => {
    shellRef.current = element;
    register(element);
  }, [register]);

  return (
    <div
      ref={attachShell}
      data-guide-file-shell={file.path}
      data-guide-block={blockId}
      className="scroll-mt-4"
      onPointerEnter={() => {
        requestMount();
        onActivate(file.path, blockId);
      }}
      onFocusCapture={() => {
        requestMount();
        onActivate(file.path, blockId);
      }}
    >
      {blockId && (
        <div className="mb-1.5 flex flex-wrap items-center gap-2 px-1 text-[11px] text-muted-foreground">
          <span>{contextOnly ? 'Unchanged context' : 'Focused diff'}</span>
          {fullFile && fullFile.patch !== file.patch && (
            <button type="button" className="underline underline-offset-2 hover:text-foreground"
              aria-expanded={expandedContext} onClick={() => { setExpandedContext(value => !value); scrollPositionRef.current = 0; }}>
              {expandedContext ? 'Show focused block' : 'Show full file diff'}
            </button>
          )}
        </div>
      )}
      {summary && (
        <p className="mb-1.5 px-1 text-xs leading-relaxed text-muted-foreground">
          {renderInlineMarkdown(summary)}
        </p>
      )}

      <div
        style={{ height: renderedHeight }}
        className="overflow-hidden rounded-lg border border-border/40 bg-background"
        data-guide-code-view-mounted={mounted ? 'true' : 'false'}
      >
        {mounted ? (
          <DiffRenderer
            {...getDiffRendererProps({ file: shownFile, focused, blockId, contextOnly, guideContext: `${guideContext ?? ''}${summary ? `\nBlock: ${limitDiscussionContext(summary, 800)}` : ''}` })}
            files={fileList}
            sourceSide={contextOnly ? 'new' : undefined}
            {...(blockId ? { contextExpansionAvailable: false } : {})}
            fileScrollTarget={target}
            fileOrder="list"
            mountCollapsed={collapsed}
            initialScrollPosition={scrollPositionRef.current}
            onScrollPositionChange={(position) => {
              scrollPositionRef.current = position;
            }}
            onFileCollapsedChange={(filePath, nextCollapsed) => {
              if (filePath === file.path) setCollapsed(nextCollapsed);
            }}
            isActive={active && focused}
            allowScrollChaining
          />
        ) : (
          <div className="flex h-full flex-col" aria-hidden="true">
            <div className="flex h-[33px] flex-shrink-0 items-center border-b border-border/40 px-3 font-mono text-[11px] text-muted-foreground/70">
              <span className="min-w-0 flex-1 truncate">{file.path}</span>
              <span className="ml-2 flex-shrink-0">
                {file.additions > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{file.additions}</span>}
                {file.deletions > 0 && <span className="ml-1 text-red-600/80 dark:text-red-400/80">-{file.deletions}</span>}
              </span>
            </div>
            {!collapsed && <div className="min-h-0 flex-1 bg-muted/[0.06]" />}
          </div>
        )}
      </div>
    </div>
  );
};

export { estimateDiffHeight };
