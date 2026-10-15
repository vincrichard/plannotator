import { formatPatchPathToken } from '@plannotator/shared/diff-paths';
import type { DiffFile } from '../types';

/** A context-only patch lets the ordinary diff viewer comment on unchanged files. */
export function unchangedReferenceFile(filePath: string, content: string): DiffFile {
  const lines = content ? content.split('\n') : [];
  if (content.endsWith('\n')) lines.pop();
  const oldPath = formatPatchPathToken('a', filePath);
  const newPath = formatPatchPathToken('b', filePath);
  const patch = [
    `diff --git ${oldPath} ${newPath}`,
    `--- ${oldPath}`,
    `+++ ${newPath}`,
    ...(lines.length ? [
      `@@ -1,${lines.length} +1,${lines.length} @@`,
      ...lines.map(line => ` ${line}`),
      ...(!content.endsWith('\n') ? ['\\ No newline at end of file'] : []),
    ] : []),
    '',
  ].join('\n');
  return { path: filePath, patch, additions: 0, deletions: 0, status: 'modified' };
}

/** Search locations describe the working tree, not necessarily the reviewed revision. */
export function referenceLineInSnapshot(content: string, line: number, snippet: string): number | null {
  const lines = content.split('\n');
  const expected = snippet.trimEnd();
  if (!expected) return null;
  if (lines[line - 1]?.trimEnd() === expected) return line;
  const matches = lines.flatMap((text, index) => text.trimEnd() === expected ? [index + 1] : []);
  return matches.length === 1 ? matches[0] : null;
}
