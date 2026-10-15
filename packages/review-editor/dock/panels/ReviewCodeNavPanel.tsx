import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import type { IDockviewPanelProps } from 'dockview-react';
import { useReviewState } from '../ReviewStateContext';
import { useCodeNavPreview } from '../../hooks/useCodeNavPreview';
import { ReviewFileDiff } from './ReviewDiffPanel';
import { referenceLineInSnapshot } from '../../utils/referencePreview';
import { readPatchLines } from '../../utils/codeAnnotationAnchor';
import type { SelectedLineRange } from '@plannotator/ui/types';
import type { CodeNavLocation } from '@plannotator/shared/code-nav';

function basename(filePath: string): string {
  const i = filePath.lastIndexOf('/');
  return i === -1 ? filePath : filePath.slice(i + 1);
}

function dirname(filePath: string): string {
  const i = filePath.lastIndexOf('/');
  return i === -1 ? '' : filePath.slice(0, i);
}

interface FileGroup {
  filePath: string;
  locations: CodeNavLocation[];
}

function groupByFile(locations: CodeNavLocation[]): FileGroup[] {
  const map = new Map<string, CodeNavLocation[]>();
  for (const loc of locations) {
    const existing = map.get(loc.filePath);
    if (existing) existing.push(loc);
    else map.set(loc.filePath, [loc]);
  }
  return Array.from(map.entries()).map(([filePath, locations]) => ({
    filePath,
    locations,
  }));
}

interface ReferenceTarget {
  filePath: string;
  line: number;
  side: 'old' | 'new';
  /** Absent for sidebar jumps, whose coordinates already belong to the review. */
  snippet?: string;
}

const CodePreview: React.FC<{ target: ReferenceTarget; isActive: boolean }> = ({ target, isActive }) => {
  const state = useReviewState();
  const changedFile = state.files.find(file => file.path === target.filePath || file.oldPath === target.filePath);
  const preview = useCodeNavPreview(changedFile?.path ?? target.filePath, changedFile, state.reviewBase, state.snapshotId);
  const range = useMemo<SelectedLineRange | null>(() => {
    let line: number | null = target.line;
    if (target.snippet !== undefined) {
      const content = preview.fileContents?.new;
      line = content != null
        ? referenceLineInSnapshot(content, target.line, target.snippet)
        : changedFile && readPatchLines(changedFile.patch, 'new', target.line, target.line)?.trimEnd() === target.snippet.trimEnd()
          ? target.line : null;
    }
    return line == null ? null : { start: line, end: line, side: target.side === 'old' ? 'deletions' : 'additions' };
  }, [target, preview.fileContents, changedFile]);

  return (
    <div className="h-full min-h-0 flex flex-col" data-reference-file={preview.file?.path ?? target.filePath}>
      {preview.error && <div role="status" className="p-3 text-xs text-muted-foreground">{preview.error} <button className="text-primary underline" onClick={preview.retry}>Retry file</button></div>}
      {!preview.error && !preview.loading && target.snippet !== undefined && !range && (
        <div role="status" className="px-3 py-2 text-xs text-muted-foreground">
          This working-tree reference could not be located unambiguously in the review snapshot. Select a line in the reviewed code to comment.
        </div>
      )}
      {!changedFile && preview.file && <div className="px-3 py-1 text-xs text-muted-foreground">Unchanged file · review snapshot</div>}
      {preview.file ? (
        <div className="flex-1 min-h-0">
          <ReviewFileDiff file={preview.file} reference={{ target: range, isActive, unchanged: !changedFile }} />
        </div>
      ) : preview.loading && <div role="status" className="p-3 text-xs text-muted-foreground">Loading reviewed file…</div>}
    </div>
  );
};

const ReferenceList: React.FC<{
  groups: FileGroup[];
  selectedLocation: ReferenceTarget | null;
  onSelect: (loc: CodeNavLocation) => void;
}> = ({ groups, selectedLocation, onSelect }) => {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggleCollapse = (filePath: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  return (
    <div className="text-[11px]">
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.filePath);
        return (
          <div key={group.filePath}>
            <button
              className="w-full text-left px-2 py-1 flex items-center gap-1.5 hover:bg-muted/50 transition-colors sticky top-0 bg-card/95 backdrop-blur-sm z-10"
              onClick={() => toggleCollapse(group.filePath)}
              title={group.filePath}
            >
              <svg
                className={`w-3 h-3 text-muted-foreground flex-shrink-0 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              <span className="font-medium truncate text-foreground">
                {basename(group.filePath)}
              </span>
              <span className="text-muted-foreground/60 truncate text-[10px]">
                {dirname(group.filePath)}
              </span>
              <span className="ml-auto text-[10px] font-mono text-muted-foreground/50 flex-shrink-0">
                ({group.locations.length})
              </span>
            </button>
            {!isCollapsed && (
              <div>
                {group.locations.map((loc, i) => {
                  const isSelected =
                    selectedLocation?.filePath === loc.filePath &&
                    selectedLocation?.line === loc.line;
                  return (
                    <button
                      key={`${loc.line}-${i}`}
                      className={`w-full text-left pl-7 pr-2 py-0.5 flex items-center gap-1.5 transition-colors ${
                        isSelected
                          ? 'bg-primary/15 text-primary'
                          : 'hover:bg-muted/40 text-muted-foreground'
                      }`}
                      onClick={() => onSelect(loc)}
                    >
                      <span className="font-mono text-[10px] flex-shrink-0 w-8 text-right">
                        :{loc.line}
                      </span>
                      <span className="truncate font-mono text-[10px]">
                        {loc.snippet.trim()}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export const ReviewCodeNavPanel: React.FC<IDockviewPanelProps> = (props) => {
  const state = useReviewState();
  const containerRef = useRef<HTMLDivElement>(null);
  const { codeNavResult, codeNavIsLoading, codeNavActiveSymbol } = state;
  const [isActive, setIsActive] = useState(props.api.isActive);
  useEffect(() => {
    const listener = props.api.onDidActiveChange(event => setIsActive(event.isActive));
    return () => listener.dispose();
  }, [props.api]);

  const definitions = useMemo(() => groupByFile(codeNavResult?.definitions ?? []), [codeNavResult]);
  const references = useMemo(() => groupByFile(codeNavResult?.references ?? []), [codeNavResult]);
  const [selectedLocation, setSelectedLocation] = useState<ReferenceTarget | null>(null);

  useEffect(() => {
    const first = codeNavResult?.definitions[0] ?? codeNavResult?.references[0];
    setSelectedLocation(first ? { ...first, side: 'new' } : null);
  }, [codeNavResult]);

  const requestedAnnotation = state.allAnnotations.find(annotation => annotation.id === props.params?.annotationId);
  useEffect(() => {
    if (requestedAnnotation) {
      setSelectedLocation({ filePath: requestedAnnotation.filePath, line: Math.max(1, requestedAnnotation.lineStart), side: requestedAnnotation.side });
    }
  }, [requestedAnnotation, state.scrollTargetAnnotation]);

  useEffect(() => {
    props.api.updateParameters({ filePath: selectedLocation?.filePath });
  }, [selectedLocation?.filePath, props.api]);

  const handleSelect = useCallback((loc: CodeNavLocation) => {
    props.api.updateParameters({ annotationId: undefined });
    setSelectedLocation({ ...loc, side: 'new' });
  }, [props.api]);

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      aria-label="References"
      className="h-full min-h-0 flex flex-col border-t border-border/50"
      onKeyDown={event => {
        // Escape in a comment composer belongs to the composer, not the panel.
        if (event.key === 'Escape' && event.target === containerRef.current) props.api.close();
      }}
    >
      <div className="max-h-[35%] shrink-0 overflow-auto border-b border-border/30" aria-label="Symbol locations">
        {codeNavIsLoading ? (
          <div role="status" className="p-3 text-xs text-muted-foreground">Searching for {codeNavActiveSymbol}…</div>
        ) : codeNavResult?.backend === 'unavailable' ? (
          <div className="p-3 text-xs text-muted-foreground">
            Install <a href="https://github.com/BurntSushi/ripgrep" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">ripgrep</a> for code navigation
          </div>
        ) : (
          <>
            {definitions.length > 0 && <>
              <h3 className="px-2 py-1 text-xs font-medium">Definitions</h3>
              <ReferenceList groups={definitions} selectedLocation={selectedLocation} onSelect={handleSelect} />
            </>}
            {references.length > 0 && <>
              <h3 className="px-2 py-1 text-xs font-medium">References</h3>
              <ReferenceList groups={references} selectedLocation={selectedLocation} onSelect={handleSelect} />
            </>}
            {codeNavResult && !definitions.length && !references.length && (
              <div className="p-3 text-xs text-muted-foreground">No results for {codeNavActiveSymbol}</div>
            )}
          </>
        )}
      </div>
      <div className="flex-1 min-h-0">
        {selectedLocation ? (
          <CodePreview
            key={`${selectedLocation.filePath}:${state.snapshotId ?? ''}:${state.reviewBase ?? ''}:${state.activeDiffBase ?? ''}`}
            target={selectedLocation}
            isActive={isActive}
          />
        ) : <div className="p-3 text-xs text-muted-foreground">Select a reference to review</div>}
      </div>
    </div>
  );
};
