import type { ReviewDiscussionAnchor } from './review-discussions';

export function limitDiscussionContext(value: string, max = 8_000): string {
  return value.length > max ? `${value.slice(0, max)}\n[Excerpt shortened; select fewer lines for more detail.]` : value;
}

/** Preserve both sides' source coordinates without attaching unrelated hunks or files. */
export function selectedDiffContext(patch: string, anchor: ReviewDiscussionAnchor): string {
  const rows: { text: string; old?: number; new?: number; hunk: number; selected: boolean }[] = [];
  let old = 0, next = 0, hunk = 0;
  for (const text of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) { old = Number(header[1]); next = Number(header[2]); hunk++; continue; }
    if (!hunk || ![' ', '+', '-'].includes(text[0])) continue;
    const oldLine = text[0] === '+' ? undefined : old++;
    const newLine = text[0] === '-' ? undefined : next++;
    const line = anchor.side === 'old' ? oldLine : newLine;
    rows.push({ text, old: oldLine, new: newLine, hunk,
      selected: line !== undefined && line >= anchor.lineStart && line <= anchor.lineEnd });
  }
  const included = new Set<number>();
  rows.forEach((row, index) => {
    if (row.selected) for (let i = Math.max(0, index - 3); i <= Math.min(rows.length - 1, index + 3); i++) {
      if (rows[i].hunk === row.hunk) included.add(i);
    }
  });
  if (!included.size) return '';
  const indices = [...included].sort((a, b) => a - b);
  const lines = indices.slice(0, 80).map(index => {
    const row = rows[index];
    return `${row.old ?? '-'} ${row.new ?? '-'} | ${row.text}`;
  });
  if (indices.length > 80) lines.push('[Excerpt shortened to 80 diff lines.]');
  return limitDiscussionContext(`old new | diff\n${lines.join('\n')}`);
}
