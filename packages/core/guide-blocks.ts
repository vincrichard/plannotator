/** Focused guide blocks share one slicer and coverage calculation across hosts and exports. */
import type { DiffFile } from './diff-files';
import type { CodeGuideOutput, GuideDiffRef, GuideLineRange } from './guide';

export const GUIDE_BLOCK_MAX_LINES = 250;

export interface GuideCoverageIssue {
  code: 'missing' | 'oversized' | 'invalid';
  file: string;
  blockId?: string;
  side?: 'old' | 'new';
  start?: number;
  end?: number;
  message: string;
}

export interface GuideCoverage {
  complete: boolean;
  coveredLines: number;
  totalLines: number;
  issues: GuideCoverageIssue[];
}

interface PatchRow {
  text: string;
  oldLine?: number;
  newLine?: number;
  oldBefore: number;
  newBefore: number;
  noNewline?: string;
}
interface PatchHunk { rows: PatchRow[]; }

export function isGuideLineRange(value: unknown): value is GuideLineRange {
  if (!value || typeof value !== 'object') return false;
  const r = value as GuideLineRange;
  return Number.isSafeInteger(r.start) && Number.isSafeInteger(r.end) && r.start >= 1 && r.end >= r.start;
}

function readPatch(patch: string): { header: string[]; hunks: PatchHunk[] } {
  const header: string[] = [];
  const hunks: PatchHunk[] = [];
  let hunk: PatchHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const text of patch.split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (match) {
      oldLine = Number(match[1]) + (match[2] === '0' ? 1 : 0);
      newLine = Number(match[3]) + (match[4] === '0' ? 1 : 0);
      hunk = { rows: [] };
      hunks.push(hunk);
    } else if (!hunk) {
      header.push(text);
    } else if (text.startsWith('\\') && hunk.rows.length) {
      hunk.rows[hunk.rows.length - 1].noNewline = text;
    } else if (text[0] === ' ' || text[0] === '+' || text[0] === '-') {
      const row: PatchRow = { text, oldBefore: oldLine, newBefore: newLine };
      if (text[0] !== '+') row.oldLine = oldLine++;
      if (text[0] !== '-') row.newLine = newLine++;
      hunk.rows.push(row);
    }
  }
  return { header, hunks };
}

function inRange(line: number | undefined, range: GuideLineRange | undefined): boolean {
  return line !== undefined && range !== undefined && line >= range.start && line <= range.end;
}

function selected(row: PatchRow, ref: GuideDiffRef): boolean {
  return !ref.oldRange && !ref.newRange || inRange(row.oldLine, ref.oldRange) || inRange(row.newLine, ref.newRange);
}

function rangePresent(hunks: PatchHunk[], range: GuideLineRange, side: 'old' | 'new'): boolean {
  let count = 0;
  for (const { rows } of hunks) {
    for (const row of rows) if (inRange(side === 'old' ? row.oldLine : row.newLine, range)) count++;
  }
  return count === range.end - range.start + 1;
}

function renderHunk(rows: PatchRow[]): string[] {
  const oldCount = rows.filter(row => row.oldLine !== undefined).length;
  const newCount = rows.filter(row => row.newLine !== undefined).length;
  const oldStart = rows[0].oldBefore - (oldCount === 0 ? 1 : 0);
  const newStart = rows[0].newBefore - (newCount === 0 ? 1 : 0);
  return [
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...rows.flatMap(row => row.noNewline ? [row.text, row.noNewline] : [row.text]),
  ];
}

export function guideContextLines(source: string): string[] {
  return source.split('\n');
}

/** Returns a patch with original line coordinates; annotations can keep using file/side/line. */
export function resolveGuideBlock(
  ref: GuideDiffRef,
  files: readonly DiffFile[],
): { file: DiffFile; displayedLines: number } | { error: string } {
  for (const side of ['old', 'new'] as const) {
    const range = ref[`${side}Range`];
    if (range !== undefined && !isGuideLineRange(range)) return { error: `Invalid ${side} range in ${ref.file}; use positive inclusive start/end lines.` };
  }
  if (ref.kind === 'context') {
    if (!ref.newRange || ref.oldRange || typeof ref.source !== 'string') {
      return { error: `Context block ${ref.id ?? ref.file} requires a verified repository excerpt and newRange only.` };
    }
    const lines = guideContextLines(ref.source);
    const count = ref.newRange.end - ref.newRange.start + 1;
    if (lines.length !== count) return { error: `Context excerpt for ${ref.file} does not match new lines ${ref.newRange.start}-${ref.newRange.end}.` };
    const a = JSON.stringify(`a/${ref.file}`);
    const b = JSON.stringify(`b/${ref.file}`);
    const patch = [
      `diff --git ${a} ${b}`, `--- ${a}`, `+++ ${b}`,
      `@@ -${ref.newRange.start},${count} +${ref.newRange.start},${count} @@`,
      ...lines.map(line => ` ${line}`), '',
    ].join('\n');
    return { file: { path: ref.file, patch, additions: 0, deletions: 0, status: 'modified' }, displayedLines: count };
  }
  const file = files.find(file => file.path === ref.file);
  if (!file) return { error: `Diff file ${ref.file} is not in the review patch. Use kind: "context" to quote unchanged repository code.` };
  const { header, hunks } = readPatch(file.patch);
  for (const side of ['old', 'new'] as const) {
    const range = ref[`${side}Range`];
    if (range && !rangePresent(hunks, range, side)) {
      return { error: `${ref.file} ${side} lines ${range.start}-${range.end} are not fully present in the review patch. Choose a range within its hunks or a separate context block.` };
    }
  }
  if (!ref.oldRange && !ref.newRange) {
    return { file, displayedLines: hunks.reduce((sum, hunk) => sum + hunk.rows.length, 0) };
  }
  const lines: string[] = [...header];
  let displayedLines = 0;
  let additions = 0;
  let deletions = 0;
  for (const { rows } of hunks) {
    let group: PatchRow[] = [];
    const flush = () => { if (group.length) { lines.push(...renderHunk(group)); group = []; } };
    for (const row of rows) {
      if (selected(row, ref)) {
        group.push(row);
        displayedLines++;
        if (row.text[0] === '+') additions++;
        if (row.text[0] === '-') deletions++;
      } else flush();
    }
    flush();
  }
  if (!displayedLines) return { error: `Block ${ref.id ?? ref.file} selects no code lines.` };
  return { file: { ...file, patch: `${lines.join('\n')}\n`, additions, deletions }, displayedLines };
}

function missingRanges(file: string, side: 'old' | 'new', lines: number[]): GuideCoverageIssue[] {
  const issues: GuideCoverageIssue[] = [];
  for (const line of lines) {
    const previous = issues[issues.length - 1];
    if (previous && previous.end === line - 1) previous.end = line;
    else issues.push({ code: 'missing', file, side, start: line, end: line, message: '' });
  }
  for (const issue of issues) {
    issue.message = `${file}: uncovered ${side === 'old' ? 'deleted' : 'added'} lines ${issue.start}-${issue.end}. Add a block or extend an existing block's ${side}Range.`;
  }
  return issues;
}

/** Context quotes never claim coverage; repeated blocks count changed source lines once. */
export function analyzeGuideCoverage(guide: CodeGuideOutput, files: readonly DiffFile[]): GuideCoverage {
  const issues: GuideCoverageIssue[] = [];
  const ids = new Set<string>();
  const refs = guide.sections.flatMap(section => section.diffs);
  const valid = new Set<GuideDiffRef>();
  for (const ref of refs) {
    if (guide.focused && (!ref.id?.trim() || ids.has(ref.id))) {
      issues.push({ code: 'invalid', file: ref.file, blockId: ref.id, message: `Each focused block needs a unique non-empty id; repair ${ref.id ?? ref.file}.` });
    }
    if (ref.id) ids.add(ref.id);
    if (ref.kind === 'context' && isGuideLineRange(ref.newRange) && ref.newRange.end - ref.newRange.start + 1 > GUIDE_BLOCK_MAX_LINES) {
      issues.push({ code: 'oversized', file: ref.file, blockId: ref.id, side: 'new', start: ref.newRange.start, end: ref.newRange.end,
        message: `Context block ${ref.id ?? ref.file} selects ${ref.newRange.end - ref.newRange.start + 1} source lines. Split it into meaningful blocks of at most ${GUIDE_BLOCK_MAX_LINES} lines.` });
      continue;
    }
    const resolved = resolveGuideBlock(ref, files);
    if ('error' in resolved) {
      issues.push({ code: 'invalid', file: ref.file, blockId: ref.id, message: resolved.error });
      continue;
    }
    valid.add(ref);
    if (resolved.displayedLines > GUIDE_BLOCK_MAX_LINES) issues.push({
      code: 'oversized', file: ref.file, blockId: ref.id,
      message: `Block ${ref.id ?? ref.file} displays ${resolved.displayedLines} source lines. Split it into meaningful blocks of at most ${GUIDE_BLOCK_MAX_LINES} lines.`,
    });
  }
  let totalLines = 0;
  let coveredLines = 0;
  for (const file of files) {
    const fileRefs = refs.filter(ref => valid.has(ref) && ref.kind !== 'context' && ref.file === file.path);
    const { hunks } = readPatch(file.patch);
    const missing = { old: [] as number[], new: [] as number[] };
    let changed = 0;
    for (const { rows } of hunks) for (const row of rows) {
      if (row.text[0] !== '+' && row.text[0] !== '-') continue;
      totalLines++; changed++;
      if (fileRefs.some(ref => selected(row, ref))) coveredLines++;
      else if (row.oldLine !== undefined) missing.old.push(row.oldLine);
      else if (row.newLine !== undefined) missing.new.push(row.newLine);
    }
    issues.push(...missingRanges(file.path, 'old', missing.old), ...missingRanges(file.path, 'new', missing.new));
    if (!changed && !fileRefs.length) issues.push({ code: 'missing', file: file.path, message: `${file.path}: the binary, rename, or metadata change needs an explicit diff block.` });
  }
  return { complete: issues.length === 0, coveredLines, totalLines, issues };
}
