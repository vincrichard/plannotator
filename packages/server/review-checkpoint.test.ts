import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReviewServer } from './review';
import { getVcsContext, runVcsDiff } from './vcs';
import { saveReviewProgress } from '@plannotator/shared/review-progress';

// Guards against resuming old comments on new code, stale-tab writes, and unsafe suspension.
test('durable review checkpoints restore exact text, drafts, viewed identity and discussions with a fresh transport nonce', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plannotator-checkpoint-'));
  const before = { ...process.env };
  let server: Awaited<ReturnType<typeof startReviewServer>> | undefined;
  try {
    const data = join(root, 'data'); mkdirSync(data, { mode: 0o700 });
    process.env.PLANNOTATOR_DATA_DIR = data;
    process.env.PLANNOTATOR_REVIEW_ID = 'a'.repeat(32);
    process.env.PLANNOTATOR_REVIEW_CHECKPOINT = join(root, 'checkpoint.json');
    process.env.PLANNOTATOR_REMOTE = '0'; process.env.PLANNOTATOR_AI = '1';
    process.env.PLANNOTATOR_DISCUSSION_PROVIDER = 'codex';
    process.env.PLANNOTATOR_DISCUSSION_SESSION_ID = '11111111-1111-4111-8111-111111111111';
    delete process.env.PLANNOTATOR_PORT;
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], { cwd: root });
      if (result.exitCode) throw new Error(result.stderr.toString());
      return result.stdout.toString();
    };
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.test');
    writeFileSync(join(root, '.gitignore'), 'data/\ncheckpoint.json\nactivity.json\ncomposer-drafts.json\n');
    writeFileSync(join(root, 'a.txt'), 'old\n'); git('add', '.'); git('commit', '-qm', 'initial');
    writeFileSync(join(root, 'a.txt'), 'reviewed\n');
    const start = async () => {
      process.env.PLANNOTATOR_REVIEW_ID = 'a'.repeat(32);
      process.env.PLANNOTATOR_REVIEW_CHECKPOINT = join(root, 'checkpoint.json');
      process.env.PLANNOTATOR_REVIEW_CONTROL_TOKEN = 'c'.repeat(64);
      const context = await getVcsContext(root, 'git');
      const diff = await runVcsDiff('uncommitted', 'HEAD', root);
      return startReviewServer({ rawPatch: diff.patch, gitRef: 'HEAD', diffType: 'uncommitted', gitContext: context,
        initialBase: 'HEAD', initialBaseExplicit: true, initialFileIdentities: { 'a.txt': 'original-file' },
        htmlContent: '<html></html>', gitRemoteCheck: false, origin: 'codex' });
    };
    server = await start();
    const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(`${server!.url}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const payload = await (await request('/api/diff')).json();
    const auth = { Authorization: `Bearer ${'c'.repeat(64)}` };
    expect(process.env.PLANNOTATOR_REVIEW_CONTROL_TOKEN).toBeUndefined();
    expect((await request('/api/host/suspend', 'POST')).status).toBe(401);
    expect((await request('/api/host/suspend', 'POST', {}, { ...auth, Origin: server.url })).status).toBe(403);
    expect((await request('/api/draft', 'POST', { codeAnnotations: [{ id: 'comment', text: 'keep this comment' }] }, { 'X-Plannotator-Session': payload.serverSession })).status).toBe(200);
    expect((await request('/api/review-lifecycle/drafts', 'PUT', { serverSession: payload.serverSession, revision: 0, drafts: { lines: [['line', { commentText: 'unfinished' }]] } })).status).toBe(200);
    const staleDraft = await request('/api/review-lifecycle/drafts', 'PUT', { serverSession: payload.serverSession, revision: 0, drafts: {} });
    expect(staleDraft.status).toBe(409);
    expect(await staleDraft.json()).toMatchObject({ code: 'draft_conflict', revision: 1 });
    let progress = await (await request(`/api/review-progress?snapshot=${encodeURIComponent(payload.snapshotId)}`)).json();
    expect((await request(`/api/review-progress?snapshot=${encodeURIComponent(payload.snapshotId)}`, 'POST', {
      key: progress.key, changes: [{ path: 'a.txt', fingerprint: progress.fingerprints['a.txt'], viewed: true }],
    }, { 'X-Plannotator-Session': payload.serverSession })).status).toBe(200);
    progress = await (await request(`/api/review-progress?snapshot=${encodeURIComponent(payload.snapshotId)}`)).json();
    expect(progress.viewedFiles).toEqual(['a.txt']);
    const opener = { serverSession: payload.serverSession, snapshotId: payload.snapshotId, id: 'opening', role: 'assistant', text: 'Saved explanation', anchor: { filePath: 'a.txt', lineStart: 1, lineEnd: 1, side: 'new' } };
    expect((await request('/api/review-discussions', 'POST', opener)).status).toBe(201);
    expect((await request('/api/host/suspend', 'POST', { lastActivityAt: 0 }, auth)).status).toBe(409);
    writeFileSync(join(root, 'activity.json'), JSON.stringify({ last_activity_at: Date.now() / 1000 - 5 }));
    writeFileSync(join(root, 'a.txt'), 'unreviewed change\n');
    expect((await request('/api/host/suspend', 'POST', {}, auth)).status).toBe(409);
    expect((await request('/api/review-lifecycle/activity', 'POST', {}, { 'X-Plannotator-Session': payload.serverSession })).status).toBe(200);
    writeFileSync(join(root, 'a.txt'), 'reviewed\n');
    expect((await request('/api/host/suspend', 'POST', {}, auth)).status).toBe(409);
    writeFileSync(join(root, 'activity.json'), JSON.stringify({ last_activity_at: Date.now() / 1000 - 5 }));
    const suspended = await request('/api/host/suspend', 'POST', {}, auth);
    const suspendedBody = await suspended.json();
    expect(suspendedBody).toMatchObject({ saved: true, snapshotId: payload.snapshotId });
    expect(statSync(join(root, 'checkpoint.json')).mode & 0o077).toBe(0);
    expect((await request('/api/draft', 'POST', { codeAnnotations: [] })).status).toBe(409);
    server.stop(); server = undefined;
    // A later review overwrites the shared file record; the saved review keeps its own marks.
    const checkpoint = JSON.parse(readFileSync(join(root, 'checkpoint.json'), 'utf8'));
    checkpoint.payload.gitContext.diffOptions.push({ id: `commit:${'f'.repeat(40)}`, label: 'Last turn changes' });
    writeFileSync(join(root, 'checkpoint.json'), JSON.stringify(checkpoint));
    saveReviewProgress({ ...checkpoint.progress, fingerprints: { 'a.txt': 'another-review-version' } }, [{ path: 'a.txt', fingerprint: 'another-review-version', viewed: false }]);
    writeFileSync(join(root, 'a.txt'), 'changed after suspension\n');
    server = await start();
    const resumed = await (await request('/api/diff')).json();
    expect(resumed.rawPatch).toBe(payload.rawPatch);
    expect(resumed.snapshotId).toBe(payload.snapshotId);
    expect(resumed.serverSession).not.toBe(payload.serverSession);
    expect(resumed.reviewLifecycle.frozen).toBe(true);
    expect((await request('/api/agents/jobs', 'POST', {})).status).toBe(409);
    expect((await request('/api/draft', 'POST', { codeAnnotations: [] }, { 'X-Plannotator-Session': payload.serverSession })).status).toBe(409);
    expect((await request('/api/review-progress', 'POST', {}, { 'X-Plannotator-Session': payload.serverSession })).status).toBe(409);
    expect(await (await request(`/api/file-content?path=a.txt&snapshot=${encodeURIComponent(payload.snapshotId)}`)).json()).toEqual({ oldContent: 'old\n', newContent: 'reviewed\n' });
    expect((await request('/api/file-content?path=.gitignore')).status).toBe(404);
    expect((await request('/api/code-nav/file?path=a.txt')).status).toBe(409);
    expect((await request('/api/diff/switch', 'POST', { diffType: 'uncommitted' })).status).toBe(409);
    expect(await (await request(`/api/review-progress?snapshot=${encodeURIComponent(payload.snapshotId)}`)).json()).toEqual(progress);
    expect((await request(`/api/review-progress?snapshot=${encodeURIComponent(payload.snapshotId)}`, 'POST', {
      key: progress.key, changes: [{ path: 'a.txt', fingerprint: progress.fingerprints['a.txt'], viewed: false }],
    }, { 'X-Plannotator-Session': resumed.serverSession })).status).toBe(200);
    expect(JSON.parse(readFileSync(join(root, 'checkpoint.json'), 'utf8')).viewedState).toEqual({ viewedFiles: [], suppressedFiles: ['a.txt'] });
    expect(JSON.stringify(await (await request('/api/draft')).json())).toContain('keep this comment');
    expect(JSON.stringify(await (await request('/api/review-lifecycle/drafts')).json())).toContain('unfinished');
    expect((await (await request('/api/review-discussions')).json()).threads[0].messages[0].text).toBe('Saved explanation');
    expect((await request('/api/review-discussions', 'POST', { ...opener, id: 'stale' })).status).toBe(503);
    expect((await (await request('/api/review-discussions')).json()).available).toBe(false);
    expect((await request('/api/review-discussions/opening/messages', 'POST', { serverSession: resumed.serverSession, id: 'followup', text: 'Read the current file' })).status).toBe(503);
    expect((await request('/api/review-discussions', 'POST', { ...opener, serverSession: resumed.serverSession, id: 'blocked' })).status).toBe(503);
    expect((await request('/api/review-lifecycle/refresh', 'POST', { serverSession: payload.serverSession })).status).toBe(409);
    expect((await request('/api/review-lifecycle/refresh', 'POST', { serverSession: resumed.serverSession })).status).toBe(200);
    const refreshHeaders = { 'X-Plannotator-Session': resumed.serverSession };
    expect((await request('/api/diff/switch', 'POST', {}, refreshHeaders)).status).toBe(400);
    expect((await (await request('/api/diff')).json()).reviewLifecycle.frozen).toBe(true);
    expect(statSync(join(root, 'checkpoint.json')).size).toBeGreaterThan(0);
    expect((await request('/api/review-lifecycle/refresh', 'POST', { serverSession: resumed.serverSession })).status).toBe(200);
    expect((await request('/api/diff/switch', 'POST', { diffType: 'uncommitted', base: 'HEAD' }, refreshHeaders)).status).toBe(200);
    expect((await (await request('/api/diff')).json()).rawPatch).toContain('changed after suspension');
    expect((await request('/api/review-discussions', 'POST', { ...opener, id: 'stale' })).status).toBe(409);
  } finally {
    server?.stop();
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
