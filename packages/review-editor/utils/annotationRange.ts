import type { FileDiffMetadata } from '@pierre/diffs';
import type { SelectedLineRange } from '@plannotator/ui/types';

/** Comments have one side; a mixed selection uses only its selected new-side lines. */
export function annotationRange(patch: string, range: SelectedLineRange): SelectedLineRange {
  const side = range.side ?? 'additions';
  const endSide = range.endSide ?? side;
  if (side === endSide) return { start: Math.min(range.start, range.end), end: Math.max(range.start, range.end), side };
  const rows: Array<{ additions?: number; deletions?: number }> = [];
  let oldLine = 0, newLine = 0, inHunk = false;
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) { oldLine = Number(header[1]); newLine = Number(header[2]); inHunk = true; continue; }
    if (!inHunk) continue;
    if (line.startsWith(' ')) rows.push({ additions: newLine++, deletions: oldLine++ });
    else if (line.startsWith('-')) rows.push({ deletions: oldLine++ });
    else if (line.startsWith('+')) rows.push({ additions: newLine++ });
    else if (!line.startsWith('\\')) inHunk = false;
  }
  const start = rows.findIndex(row => row[side] === range.start);
  const end = rows.findIndex(row => row[endSide] === range.end);
  const selected = start < 0 || end < 0 ? [] : rows.slice(Math.min(start, end), Math.max(start, end) + 1)
    .flatMap(row => row.additions === undefined ? [] : [row.additions]);
  // Expanded context can be absent from the patch; its explicit new-side endpoint is still valid.
  const endpoint = side === 'additions' ? range.start : range.end;
  return { start: selected[0] ?? endpoint, end: selected.at(-1) ?? endpoint, side: 'additions' };
}

/** Keep a card on a visible part of its saved range without rewriting its anchor. */
export function inlineAnnotationLine(
  annotation: { lineStart: number; lineEnd: number; side: 'old' | 'new' },
  diff: FileDiffMetadata,
): number {
  const start = Math.min(annotation.lineStart, annotation.lineEnd);
  const end = Math.max(annotation.lineStart, annotation.lineEnd);
  let visible: number | undefined;
  for (const hunk of diff.hunks) {
    const from = annotation.side === 'old' ? hunk.deletionStart : hunk.additionStart;
    const count = annotation.side === 'old' ? hunk.deletionCount : hunk.additionCount;
    const to = Math.min(end, from + count - 1);
    if (count > 0 && to >= Math.max(start, from)) visible = Math.max(visible ?? to, to);
  }
  return visible ?? end;
}
