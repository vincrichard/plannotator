import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, realpath, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Use only the explicitly launching session, never the newest session on disk. */
export function reviewTurnSession(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const id = env.PLANNOTATOR_DISCUSSION_SESSION_ID
    ?? env.PLANNOTATOR_SESSION_TAG?.match(/^claude-code:(.+)$/)?.[1]
    ?? env.CLAUDE_CODE_SESSION_ID ?? env.CODEX_THREAD_ID;
  return id && UUID.test(id) ? id : undefined;
}

async function git(cwd: string, args: string[], index?: string): Promise<string> {
  const { stdout } = await exec('git', ['--no-pager', '-c', 'color.ui=false', ...args], {
    cwd, timeout: 20_000, maxBuffer: 1024 * 1024,
    env: { ...process.env, ...(index && { GIT_INDEX_FILE: index }) },
  });
  return stdout.replace(/\r?\n$/, '');
}

async function ref(cwd: string, name: string): Promise<string | null> {
  try { return await git(cwd, ['rev-parse', '--verify', '--quiet', name]); }
  catch { return null; }
}

async function location(cwd: string, session: string) {
  if (!UUID.test(session)) throw new Error('Invalid review turn session');
  let root: string;
  try { root = await realpath(await git(cwd, ['rev-parse', '--show-toplevel'])); }
  catch { return null; }
  // Linked worktrees share refs, but must not share turn snapshots.
  const key = createHash('sha256').update(`${root}\0${session}`).digest('hex');
  const prefix = `refs/plannotator/turns/${key}`;
  return { root, before: `${prefix}/before`, latest: `${prefix}/latest`, stopped: `${prefix}/stopped` };
}

export async function readReviewTurn(cwd: string, session: string): Promise<string | null> {
  const loc = await location(cwd, session);
  return loc ? ref(loc.root, `${loc.latest}^{commit}`) : null;
}

async function snapshotTree(cwd: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'plannotator-turn-'));
  try {
    const index = join(dir, 'index');
    const sourceIndex = resolve(cwd, await git(cwd, ['rev-parse', '--git-path', 'index']));
    try {
      const times = await stat(sourceIndex);
      await copyFile(sourceIndex, index);
      // Git uses the index timestamp to detect same-size edits with unchanged file stats.
      await utimes(index, times.atime, times.mtime);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const head = await ref(cwd, 'HEAD');
      await git(cwd, ['read-tree', ...(head ? [head] : ['--empty'])], index);
    }
    await git(cwd, ['add', '-A', '--', '.'], index);
    return await git(cwd, ['write-tree'], index);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function commit(cwd: string, tree: string, parent: string | null, message: string) {
  return git(cwd, ['-c', 'user.name=Plannotator', '-c', 'user.email=snapshot@plannotator.invalid',
    'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message]);
}

/** Private refs and a temporary index leave HEAD, the real index and working files untouched. */
export async function captureReviewTurn(
  phase: 'start' | 'review' | 'stop', cwd: string, session: string, turnId?: string,
): Promise<void> {
  if (turnId !== undefined && (!turnId || turnId.length > 200 || /[\r\n\0]/.test(turnId))) {
    throw new Error('Invalid review turn id');
  }
  const loc = await location(cwd, session);
  if (!loc) return;
  const before = await ref(loc.root, loc.before);
  if (phase === 'start') {
    if (before && turnId && await git(loc.root, ['show', '-s', '--format=%s', before]) === turnId) return;
    // A failed new capture must not make the next stop use an older baseline.
    if (before) await git(loc.root, ['update-ref', '-d', loc.before, before]);
    const tree = await snapshotTree(loc.root);
    const previous = await ref(loc.root, loc.latest);
    const sha = await commit(loc.root, tree, previous, turnId ?? `User turn ${randomUUID()}`);
    await git(loc.root, ['update-ref', loc.before, sha, '']);
    return;
  }
  if (!before) return;
  if (phase === 'review' && await ref(loc.root, loc.stopped) === before) return;
  if (turnId && await git(loc.root, ['show', '-s', '--format=%s', before]) !== turnId) return;
  const tree = await snapshotTree(loc.root);
  const latest = await ref(loc.root, loc.latest);
  const beforeTree = await ref(loc.root, `${before}^{tree}`);
  let next = latest;
  if (tree !== beforeTree) {
    if (!latest || await ref(loc.root, `${latest}^`) !== before || await ref(loc.root, `${latest}^{tree}`) !== tree) {
      next = await commit(loc.root, tree, before, 'Last turn changes');
    }
  } else if (latest && await ref(loc.root, `${latest}^`) === before) {
    // A turn can be previewed mid-edit and then revert everything it changed.
    next = await ref(loc.root, `${before}^`);
  }
  // Compare-and-swap refuses an overlapping newer turn; it cannot publish this stale capture.
  const commands = [`verify ${loc.before} ${before}`];
  if (next !== latest) commands.push(next
    ? `update ${loc.latest} ${next} ${latest ?? '0'.repeat(before.length)}`
    : `delete ${loc.latest} ${latest}`);
  // Stop can re-enter after another hook requests more work in the same turn.
  if (phase === 'stop') commands.push(`update ${loc.stopped} ${before}`);
  await new Promise<void>((resolve, reject) => {
    const child = execFile('git', ['update-ref', '--stdin'], { cwd: loc.root, timeout: 20_000 }, error => error ? reject(error) : resolve());
    child.stdin!.on('error', reject);
    child.stdin!.end(`${commands.join('\n')}\n`);
  });
}
