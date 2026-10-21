import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureReviewTurn, readReviewTurn } from './review-turn';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const session = '12345678-1234-1234-1234-123456789abc';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
function repo() {
  const cwd = mkdtempSync(join(tmpdir(), 'plannotator-turn-test-'));
  dirs.push(cwd);
  git(cwd, 'init', '-q');
  git(cwd, 'config', 'user.name', 'Test');
  git(cwd, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(cwd, 'file.txt'), 'committed\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'initial');
  return cwd;
}

test('last nonempty turn excludes earlier dirty work and survives question-only turns', async () => {
  const cwd = repo();
  writeFileSync(join(cwd, 'file.txt'), 'earlier turn\n');
  git(cwd, 'add', '.');
  writeFileSync(join(cwd, 'preexisting.txt'), 'already untracked\n');
  const index = readFileSync(join(cwd, '.git/index'));
  const head = git(cwd, 'rev-parse', 'HEAD');
  await captureReviewTurn('start', cwd, session, 'edit-turn');
  writeFileSync(join(cwd, 'file.txt'), 'latest turn\n');
  writeFileSync(join(cwd, 'new.txt'), 'added in this turn\n');
  await captureReviewTurn('stop', cwd, session, 'edit-turn');
  const sha = await readReviewTurn(cwd, session);
  expect(sha).toBeTruthy();
  const diff = git(cwd, 'diff', `${sha}^`, sha!);
  expect(diff).toContain('-earlier turn');
  expect(diff).toContain('+latest turn');
  expect(diff).toContain('new.txt');
  expect(diff).not.toContain('preexisting.txt');
  expect(readFileSync(join(cwd, '.git/index'))).toEqual(index);
  expect(git(cwd, 'rev-parse', 'HEAD')).toBe(head);
  await captureReviewTurn('start', cwd, session, 'question-turn');
  await captureReviewTurn('stop', cwd, session, 'question-turn');
  expect(await readReviewTurn(cwd, session)).toBe(sha);
  expect(await readReviewTurn(cwd, '87654321-1234-1234-1234-123456789abc')).toBeNull();
});

test('review during a turn captures its edits; stop updates it and later edits cannot change it', async () => {
  const cwd = repo();
  await captureReviewTurn('start', cwd, session, 'turn');
  writeFileSync(join(cwd, 'file.txt'), 'first edit\n');
  await captureReviewTurn('review', cwd, session);
  const first = await readReviewTurn(cwd, session);
  await captureReviewTurn('start', cwd, session, 'turn'); // duplicate hook keeps the original baseline
  writeFileSync(join(cwd, 'file.txt'), 'second edit\n');
  await captureReviewTurn('stop', cwd, session, 'stale-turn');
  expect(await readReviewTurn(cwd, session)).toBe(first);
  await captureReviewTurn('stop', cwd, session, 'turn');
  const last = await readReviewTurn(cwd, session);
  expect(git(cwd, 'show', `${last}^:file.txt`)).toBe('committed');
  expect(git(cwd, 'show', `${last}:file.txt`)).toBe('second edit');
  writeFileSync(join(cwd, 'file.txt'), 'later human edit\n');
  await captureReviewTurn('review', cwd, session);
  expect(await readReviewTurn(cwd, session)).toBe(last);
  await captureReviewTurn('stop', cwd, session, 'turn');
  const resumed = await readReviewTurn(cwd, session);
  expect(git(cwd, 'show', `${resumed}^:file.txt`)).toBe('committed');
  expect(git(cwd, 'show', `${resumed}:file.txt`)).toBe('later human edit');
});

test('deletions, ignored files, and missing baselines are handled without inventing a turn', async () => {
  const cwd = repo();
  await captureReviewTurn('stop', cwd, session);
  expect(await readReviewTurn(cwd, session)).toBeNull();
  writeFileSync(join(cwd, '.gitignore'), 'private.txt\n');
  writeFileSync(join(cwd, 'private.txt'), 'ignored secret\n');
  await captureReviewTurn('start', cwd, session, 'delete');
  rmSync(join(cwd, 'file.txt'));
  await captureReviewTurn('stop', cwd, session, 'delete');
  const sha = await readReviewTurn(cwd, session);
  expect(git(cwd, 'diff', `${sha}^`, sha!)).toContain('deleted file mode');
  expect(git(cwd, 'ls-tree', '-r', sha!)).not.toContain('private.txt');
  await expect(captureReviewTurn('start', cwd, '../foreign')).rejects.toThrow('session');
});

test('reverting a previewed turn restores the previous nonempty turn', async () => {
  const cwd = repo();
  await captureReviewTurn('start', cwd, session, 'first');
  writeFileSync(join(cwd, 'file.txt'), 'first\n');
  await captureReviewTurn('stop', cwd, session, 'first');
  const first = await readReviewTurn(cwd, session);
  await captureReviewTurn('start', cwd, session, 'reverted');
  writeFileSync(join(cwd, 'file.txt'), 'temporary\n');
  await captureReviewTurn('review', cwd, session);
  expect(await readReviewTurn(cwd, session)).not.toBe(first);
  writeFileSync(join(cwd, 'file.txt'), 'first\n');
  await captureReviewTurn('stop', cwd, session, 'reverted');
  expect(await readReviewTurn(cwd, session)).toBe(first);
});

test('native review launch advertises the turn as an immutable selectable diff with both file sides', async () => {
  const { prepareLocalReviewDiff, runVcsDiff, getVcsFileContentsForDiff } = await import('../server/vcs');
  const cwd = repo();
  const env = { ...process.env };
  try {
    process.env.PLANNOTATOR_DISCUSSION_SESSION_ID = session;
    writeFileSync(join(cwd, 'file.txt'), 'prior dirty work\n');
    await captureReviewTurn('start', cwd, session, 'active');
    writeFileSync(join(cwd, 'file.txt'), 'turn edit\n');
    const opened = await prepareLocalReviewDiff({ cwd, vcsType: 'git', requestedDiffType: 'uncommitted', configuredDiffType: 'uncommitted' });
    const option = opened.gitContext.diffOptions.find(option => option.label === 'Last turn changes');
    expect(option).toBeDefined();
    const diffType = option!.id as `commit:${string}`;
    const result = await runVcsDiff(diffType, 'main', cwd);
    expect(result.error).toBeUndefined();
    expect(result.patch).toContain('-prior dirty work');
    expect(result.patch).toContain('+turn edit');
    writeFileSync(join(cwd, 'file.txt'), 'later work\n');
    const sides = await getVcsFileContentsForDiff(diffType, 'main', 'file.txt', undefined, cwd);
    expect(sides).toEqual({ oldContent: 'prior dirty work\n', newContent: 'turn edit\n' });
  } finally {
    if (env.PLANNOTATOR_DISCUSSION_SESSION_ID === undefined) delete process.env.PLANNOTATOR_DISCUSSION_SESSION_ID;
    else process.env.PLANNOTATOR_DISCUSSION_SESSION_ID = env.PLANNOTATOR_DISCUSSION_SESSION_ID;
  }
});

test('the same session in linked worktrees has separate snapshots, including committed turn edits', async () => {
  const cwd = repo();
  const other = join(cwd, '..', `${cwd.split('/').at(-1)}-linked`);
  dirs.push(other);
  git(cwd, 'worktree', 'add', '-qb', 'linked', other);
  await captureReviewTurn('start', cwd, session, 'original');
  writeFileSync(join(cwd, 'file.txt'), 'original edit\n');
  await captureReviewTurn('stop', cwd, session, 'original');
  const original = await readReviewTurn(cwd, session);
  expect(await readReviewTurn(other, session)).toBeNull();
  await captureReviewTurn('start', other, session, 'linked');
  writeFileSync(join(other, 'file.txt'), 'committed turn edit\n');
  git(other, 'add', '.'); git(other, 'commit', '-qm', 'agent commit');
  await captureReviewTurn('stop', other, session, 'linked');
  const linked = await readReviewTurn(other, session);
  expect(await readReviewTurn(cwd, session)).toBe(original);
  expect(git(other, 'diff', `${linked}^`, linked!)).toContain('+committed turn edit');
});

test('force-staged ignored files stay in the snapshot, including with a split index', async () => {
  const cwd = repo();
  writeFileSync(join(cwd, '.gitignore'), 'forced.txt\n');
  writeFileSync(join(cwd, 'forced.txt'), 'before\n');
  git(cwd, 'add', '-f', 'forced.txt');
  git(cwd, 'update-index', '--split-index');
  const index = readFileSync(join(cwd, '.git/index'));
  await captureReviewTurn('start', cwd, session, 'forced');
  writeFileSync(join(cwd, 'forced.txt'), 'after\n');
  await captureReviewTurn('stop', cwd, session, 'forced');
  const sha = await readReviewTurn(cwd, session);
  expect(git(cwd, 'diff', `${sha}^`, sha!)).toContain('+after');
  expect(readFileSync(join(cwd, '.git/index'))).toEqual(index);
});

test('racy index timestamps cannot hide same-size edits in the captured baseline', async () => {
  const cwd = repo();
  git(cwd, 'config', 'core.trustctime', 'false');
  git(cwd, 'config', 'core.checkstat', 'minimal');
  const file = join(cwd, 'file.txt');
  const past = new Date('2000-01-01T00:00:00Z');
  utimesSync(file, past, past);
  git(cwd, 'add', '.');
  utimesSync(join(cwd, '.git/index'), past, past);
  writeFileSync(file, 'different\n');
  utimesSync(file, past, past);
  await captureReviewTurn('start', cwd, session, 'same-size');
  writeFileSync(file, 'last edit\n');
  utimesSync(file, past, past);
  await captureReviewTurn('stop', cwd, session, 'same-size');
  const sha = await readReviewTurn(cwd, session);
  expect(git(cwd, 'diff', `${sha}^`, sha!)).toContain('-different\n+last edit');
});
