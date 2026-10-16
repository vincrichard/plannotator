import { FileDiff, type FileDiffMetadata } from '@pierre/diffs';
import { methodRanges, type MethodRange } from '@plannotator/ui/utils/methodRanges';

type Side = 'additions' | 'deletions';
interface MethodContext extends MethodRange { hunkIndex: number; side: Side }
const cache = new WeakMap<FileDiffMetadata, Record<Side, MethodContext[]>>();
const expanded = new WeakMap<object, { diff: FileDiffMetadata; methods: Set<MethodContext> }>();

/** Only the innermost method owning a changed line gets a control, at its first changed hunk. */
export function changedMethods(diff: FileDiffMetadata, side: Side): MethodContext[] {
  if (diff.isPartial) return [];
  const lines = side === 'additions' ? diff.additionLines : diff.deletionLines;
  const methods = methodRanges(side === 'deletions' ? diff.prevName ?? diff.name : diff.name, lines.join(''));
  const found = new Map<MethodRange, number>();
  diff.hunks.forEach((hunk, hunkIndex) => {
    for (const segment of hunk.hunkContent) {
      if (segment.type !== 'change') continue;
      const start = side === 'additions' ? segment.additionLineIndex : segment.deletionLineIndex;
      const count = side === 'additions' ? segment.additions : segment.deletions;
      for (let line = start + 1; line <= start + count; line++) {
        const method = methods.filter(method => method.start <= line && method.end >= line)
          .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
        if (method && !found.has(method)) found.set(method, hunkIndex);
      }
    }
  });
  return [...found].map(([method, hunkIndex]) => ({ ...method, hunkIndex, side }));
}

/** Expand every unchanged gap intersecting this method, retaining the original patch and sides. */
export function methodExpansions(diff: FileDiffMetadata, side: Side, method: MethodRange) {
  const lines = side === 'additions' ? diff.additionLines : diff.deletionLines;
  const gaps: Array<{ index: number; direction: 'up' | 'down' | 'both'; count: number }> = [];
  let start = 1;
  for (let index = 0; index <= diff.hunks.length; index++) {
    const hunk = diff.hunks[index];
    const next = hunk ? (side === 'additions' ? hunk.additionStart : hunk.deletionStart) : lines.length + 1;
    const end = next - 1;
    const from = Math.max(start, method.start), to = Math.min(end, method.end);
    if (from <= to) gaps.push({ index, direction: from > start ? 'down' : to < end ? 'up' : 'both', count: to - from + 1 });
    if (hunk) start = next + (side === 'additions' ? hunk.additionCount : hunk.deletionCount);
  }
  return gaps;
}

/** Enhance native separators in both FileDiff and CodeView; never replace their normal controls. */
export function decorateMethodContext(node: HTMLElement, instance: unknown): void {
  if (!(instance instanceof FileDiff) || !instance.fileDiff || instance.fileDiff.isPartial) return;
  const diff = instance.fileDiff;
  const root = node.shadowRoot;
  if (!root) return;
  const separators = [...root.querySelectorAll<HTMLElement>('[data-separator][data-expand-index]')]
    .filter(separator => separator.closest('[data-gutter]') && !separator.closest('[data-additions]'));
  if (!separators.length) return;
  let contexts = cache.get(diff);
  if (!contexts) {
    contexts = { additions: changedMethods(diff, 'additions'), deletions: changedMethods(diff, 'deletions') };
    cache.set(diff, contexts);
  }
  let shown = expanded.get(instance);
  if (shown?.diff !== diff) {
    shown = { diff, methods: new Set() };
    expanded.set(instance, shown);
  }
  for (const control of root.querySelectorAll('[data-expand-method]')) control.remove();
  // Split views put the shared expansion controls in the old gutter; prefer new method names.
  const candidates = [...contexts.additions, ...contexts.deletions.filter(old =>
    !contexts.additions.some(next => next.name === old.name && next.hunkIndex === old.hunkIndex))];
  for (const separator of separators) {
    for (const method of candidates) {
      const side = method.side;
      if (shown.methods.has(method)) continue;
      const hunk = diff.hunks[method.hunkIndex];
      const start = side === 'additions' ? hunk.additionStart : hunk.deletionStart;
      const controlIndex = method.start < start ? method.hunkIndex : method.hunkIndex + 1;
      const gaps = methodExpansions(diff, side, method);
      const firstGap = gaps.find(gap => gap.index >= controlIndex);
      if (Number(separator.dataset.expandIndex) !== firstGap?.index) continue;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.expandMethod = method.name;
      button.textContent = `Expand ${method.name} (${method.end - method.start + 1} lines)`;
      button.title = `Show the entire ${side === 'deletions' ? 'old' : 'new'} method, lines ${method.start}–${method.end}, including gaps between changes`;
      button.style.cssText = 'font:inherit;color:inherit;background:transparent;border:0;padding:0 8px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;text-decoration:underline';
      button.onclick = event => {
        event.stopPropagation();
        shown.methods.add(method);
        for (const gap of gaps) instance.expandHunk(gap.index, gap.direction, gap.count);
      };
      separator.querySelector('[data-separator-content]')?.append(button);
    }
  }
}
