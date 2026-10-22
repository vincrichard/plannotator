import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useReviewSnapshot, type ReviewSnapshotResponse } from './useReviewSnapshot';

let root: Root | undefined;
let host: HTMLElement | undefined;
let snapshot: ReturnType<typeof useReviewSnapshot>;
const rendered: Array<{ id?: string; paths: string[] }> = [];
const patch = (...paths: string[]) => paths.map(path =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
).join('');
function Harness() {
  snapshot = useReviewSnapshot();
  rendered.push({ id: snapshot.snapshotId, paths: snapshot.files.map(file => file.path) });
  return null;
}
async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Harness />));
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
  rendered.length = 0;
});

describe.if(typeof document !== 'undefined')('review snapshot application', () => {
  test('loads and refreshes files with their snapshot identity and stable section order', async () => {
    await mount();
    const data: ReviewSnapshotResponse = {
      rawPatch: patch('untracked.ts', 'unstaged.ts', 'staged.ts', 'committed.ts'),
      gitRef: 'since base', snapshotId: 'first', aiReviewContext: 'current changes',
      sections: { base: 'main', mergeBase: 'abc', files: {
        'untracked.ts': { group: 'untracked', staged: false },
        'unstaged.ts': { group: 'changes', staged: false },
        'staged.ts': { group: 'changes', staged: true },
        'committed.ts': { group: 'committed', staged: false },
      } },
    };
    await act(async () => { snapshot.applySnapshot(data); });
    expect(snapshot.files.map(file => file.path)).toEqual(['committed.ts', 'staged.ts', 'unstaged.ts', 'untracked.ts']);
    const files = snapshot.files;
    await act(async () => snapshot.setBaseBehindRemote(true));
    expect(snapshot.files).toBe(files);
    await act(async () => { snapshot.applySnapshot({ rawPatch: patch('refreshed.ts'), gitRef: 'refreshed', snapshotId: 'second' }); });
    expect(snapshot.diffData?.aiReviewContext).toBeUndefined();
    expect(snapshot.sections).toBeNull();
    expect(snapshot.baseBehindRemote).toBe(false);
    expect(rendered.filter(value => value.id === 'second')).toEqual([{ id: 'second', paths: ['refreshed.ts'] }]);
  });

  test('switching from a commit to PR content clears sidecars but retains omitted capabilities', async () => {
    await mount();
    expect(snapshot.imagePreviewSupported).toBe(false);
    await act(async () => { snapshot.applySnapshot({
      rawPatch: patch('generated.ts'), gitRef: 'commit', snapshotId: 'commit',
      generatedFiles: ['generated.ts'], baseBehindRemote: true,
      approvalNotesSupported: true, imagePreviewSupported: true, markdownPreviewSupported: true,
      commitInfo: { sha: 'abc', shortSha: 'abc', subject: 'Change', body: '', author: 'Test', authorEmail: 'test@example.invalid', committedAt: 1 },
    }); });
    expect(snapshot.commitInfo?.sha).toBe('abc');
    expect(snapshot.generatedFiles.has('generated.ts')).toBe(true);
    await act(async () => { snapshot.applySnapshot({ rawPatch: patch('pr.ts'), gitRef: 'PR', snapshotId: 'pr' }); });
    expect(snapshot.commitInfo).toBeNull();
    expect(snapshot.generatedFiles.size).toBe(0);
    expect(snapshot.baseBehindRemote).toBe(false);
    expect(snapshot.approvalNotesSupported).toBe(true);
    expect(snapshot.imagePreviewSupported).toBe(true);
    expect(snapshot.markdownPreviewSupported).toBe(true);
    await act(async () => { snapshot.applySnapshot({ rawPatch: '', gitRef: 'empty', imagePreviewSupported: false, markdownPreviewSupported: false, approvalNotesSupported: false }); });
    expect(snapshot.files).toEqual([]);
    expect(snapshot.snapshotId).toBeUndefined();
    expect(snapshot.imagePreviewSupported).toBe(false);
    expect(snapshot.markdownPreviewSupported).toBe(false);
    expect(snapshot.approvalNotesSupported).toBe(false);
  });
});
