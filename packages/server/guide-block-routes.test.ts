import { expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import * as bunGuideStore from '@plannotator/shared/guide-store';
import * as piGuideStore from '../../apps/pi-extension/generated/guide-store';
import { GUIDE_SNAPSHOT_SCRIPT_ID, parseGuideSnapshotJson } from '@plannotator/shared/guide-format';
import { startReviewServer as startBun } from './review';
import { startReviewServer as startPi } from '../../apps/pi-extension/server/serverReview';

const patch = `diff --git a/long.ts b/long.ts\nnew file mode 100644\n--- /dev/null\n+++ b/long.ts\n@@ -0,0 +1,900 @@\n${Array.from({ length: 900 }, (_, i) => `+step(${i + 1});`).join('\n')}\n`
  + 'diff --git a/end.ts b/end.ts\nnew file mode 100644\n--- /dev/null\n+++ b/end.ts\n@@ -0,0 +1 @@\n+finish();\n';
const output = { focused: true, title: 'Task lifecycle', intent: 'Start, run, finish.', sections: [
  { title: 'Run', overview: 'Run the task in stages.', diffs: [{ id: 'run', file: 'long.ts', summary: 'Run all steps.', newRange: { start: 1, end: 900 } }] },
  { title: 'Finish', overview: 'Release the task.', diffs: [{ id: 'end', file: 'end.ts', summary: 'Finish.', newRange: { start: 1, end: 1 } }] },
], unplacedFiles: [] };
const envKeys = ['PATH', 'PLANNOTATOR_DATA_DIR', 'PLANNOTATOR_PORT', 'PLANNOTATOR_REMOTE', 'PLANNOTATOR_DISCUSSION_PROVIDER', 'PLANNOTATOR_GUIDE_HISTORY', 'PLANNOTATOR_AI'] as const;

async function finished(url: string, id: string) {
  for (let i = 0; i < 300; i++) {
    const body = await (await fetch(`${url}/api/agents/jobs`)).json();
    const job = body.jobs.find((job: { id: string }) => job.id === id);
    if (job && !['starting', 'running'].includes(job.status)) return job;
    await Bun.sleep(20);
  }
  throw new Error('Guide job did not settle');
}

function snapshot(html: string) {
  const match = new RegExp(`<script id="${GUIDE_SNAPSHOT_SCRIPT_ID}" type="application/json">([\\s\\S]*?)</script>`).exec(html);
  expect(match).not.toBeNull();
  const parsed = parseGuideSnapshotJson(match![1]);
  if (!parsed.ok) throw new Error(`${parsed.error.path}: ${parsed.error.message}`);
  return parsed.value;
}

for (const [host, start] of [['Bun', startBun], ['Pi', startPi]] as const) {
  test(`${host}: focused guide coverage, guarded partial repair and durable export preserve review comments`, async () => {
    const previousCwd = process.cwd();
    const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    const directory = mkdtempSync(join(tmpdir(), 'guide-block-http-'));
    const storeModule = host === 'Bun' ? bunGuideStore : piGuideStore;
    const createStore = storeModule.createGuideStoreSession;
    let releaseSave: (() => void) | undefined;
    let markSaving: (() => void) | undefined;
    let holdSave = false;
    const saveStarted = new Promise<void>(resolve => { markSaving = resolve; });
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve; });
    const storeSpy = spyOn(storeModule, 'createGuideStoreSession').mockImplementation(options => {
      const store = createStore(options);
      const save = store.saveForJob;
      store.saveForJob = async (...args) => {
        if (holdSave) { markSaving!(); await saveGate; }
        return save(...args);
      };
      return store;
    });
    let server: Awaited<ReturnType<typeof startBun>> | Awaited<ReturnType<typeof startPi>> | undefined;
    try {
      execFileSync('git', ['init', '-q'], { cwd: directory });
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'base'], { cwd: directory });
      writeFileSync(join(directory, 'claude'), `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${JSON.stringify({ type: 'result', is_error: false, structured_output: output })}'\n`, { mode: 0o755 });
      process.chdir(directory);
      process.env.PATH = `${directory}:${previous.PATH ?? ''}`;
      process.env.PLANNOTATOR_DATA_DIR = join(directory, 'data');
      process.env.PLANNOTATOR_REMOTE = '0';
      process.env.PLANNOTATOR_DISCUSSION_PROVIDER = '';
      process.env.PLANNOTATOR_GUIDE_HISTORY = '1';
      delete process.env.PLANNOTATOR_AI;
      delete process.env.PLANNOTATOR_PORT;
      const options = { rawPatch: patch, gitRef: 'fixture..HEAD', diffType: 'static-patch' as const, htmlContent: '<html>Fixture</html>', hostControlToken: 'c'.repeat(40) };
      server = await start(options);
      const request = (path: string, method = 'GET', body?: unknown, origin?: string) => fetch(`${server!.url}${path}`, {
        method, headers: { 'content-type': 'application/json', ...(origin ? { Origin: origin } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const { serverSession } = await (await request('/api/diff')).json();
      expect(typeof serverSession).toBe('string');
      const comment = { id: 'keep-comment', filePath: 'long.ts', type: 'comment', side: 'new', lineStart: 10, lineEnd: 10, text: 'Keep this review comment.' };
      expect((await request('/api/draft', 'POST', { annotations: [], codeAnnotations: [comment], globalAttachments: [] })).status).toBe(200);
      const launch = await request('/api/agents/jobs', 'POST', { provider: 'guide', engine: 'claude' });
      expect(launch.status).toBe(201);
      const { job } = await launch.json();
      expect((await finished(server.url, job.id)).status).toBe('failed');
      expect((await request(`/api/guide/${job.id}`)).status).toBe(404);
      const path = `/api/guide/${job.id}`;
      const draft = await (await request(`${path}/coverage`)).json();
      expect(draft.coverage.complete).toBe(false);
      expect(draft.coverage.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'oversized', file: 'long.ts', blockId: 'run' })]));
      expect(draft.coverage.totalLines).toBe(901);
      expect((await request(`${path}/reviewed`, 'PUT', { reviewed: [true, true] })).status).toBe(200);
      const updates = Array.from({ length: 4 }, (_, i) => ({ sectionIndex: 0, block: {
        id: i ? `run-${i}` : 'run', file: 'long.ts', summary: `Task stage ${i + 1}.`, newRange: { start: i * 225 + 1, end: (i + 1) * 225 },
      } }));
      const body = { serverSession, revision: draft.revision, updates };
      expect((await request(`${path}/blocks`, 'PATCH', { ...body, serverSession: 'stale' })).status).toBe(409);
      expect((await request(`${path}/blocks`, 'PATCH', body, 'https://unrelated.invalid')).status).toBe(403);
      expect((await request(`${path}/blocks`, 'PATCH', { ...body, revision: draft.revision - 1 })).status).toBe(409);
      holdSave = true;
      const pendingRepair = request(`${path}/blocks`, 'PATCH', body);
      await saveStarted;
      const inFlight = await (await request(`${path}/coverage`)).json();
      const competing = await request(`${path}/blocks`, 'PATCH', { ...body, revision: inFlight.revision });
      expect(competing.status).toBe(409);
      expect((await competing.json()).error).toContain('being saved');
      expect((await request(`${path}/submit`, 'POST', { payload: JSON.stringify(inFlight.guide) })).status).toBe(409);
      expect((await request(`${path}/reviewed`, 'PUT', { reviewed: [true, true] })).status).toBe(409);
      expect((await request(`${path}/blocks`, 'PATCH', { ...body, revision: inFlight.revision })).status).toBe(409);
      holdSave = false;
      releaseSave!();
      const repairedResponse = await pendingRepair;
      expect(repairedResponse.status).toBe(200);
      const repaired = await repairedResponse.json();
      expect(repaired.coverage).toMatchObject({ complete: true, coveredLines: 901, totalLines: 901 });
      expect(repaired.guide.sections[0].diffs).toHaveLength(4);
      expect((await finished(server.url, job.id)).status).toBe('done');
      expect((await request(`${path}/blocks`, 'PATCH', body)).status).toBe(409);
      const live = await (await request(path)).json();
      expect(live.reviewed).toEqual([false, true]);
      expect((await (await request('/api/draft')).json()).codeAnnotations).toEqual([comment]);
      const exported = await request(`${path}/export`);
      expect(exported.status).toBe(200);
      const portable = snapshot(await exported.text());
      expect(portable.review.rawPatch).toBe(patch);
      expect(portable.guide.sections[0].diffs).toHaveLength(4);
      expect(portable.guide.reviewed).toEqual([false, true]);
      const saved = await (await request('/api/guides')).json();
      expect(saved).toHaveLength(1);
      const savedId = saved[0].id;
      // A request begun before close must not mutate the guide when its body arrives afterward.
      const delayedBody = JSON.stringify({ ...body, revision: repaired.revision });
      let delayed: ReturnType<typeof httpRequest>;
      const lateResponse = new Promise<number>((resolve, reject) => {
        delayed = httpRequest(`${server!.url}${path}/blocks`, { method: 'PATCH', headers: { 'content-type': 'application/json' } }, response => {
          response.resume(); response.on('end', () => resolve(response.statusCode!));
        });
        delayed.on('error', reject);
        delayed.write(delayedBody.slice(0, 1));
      });
      await Bun.sleep(30);
      const closed = await fetch(`${server.url}/api/host/close`, { method: 'POST', headers: { Authorization: `Bearer ${'c'.repeat(40)}` } });
      expect(closed.status).toBe(200);
      delayed!.end(delayedBody.slice(1));
      expect(await lateResponse).toBe(409);
      expect((await (await request(`${path}/coverage`)).json()).revision).toBe(repaired.revision);
      server.stop();
      server = await start({ ...options, rawPatch: '' });
      const restored = await request(`/api/guide/saved:${savedId}/export`);
      expect(restored.status).toBe(200);
      const restoredGuide = snapshot(await restored.text());
      expect(restoredGuide.review.rawPatch).toBe(patch);
      expect(restoredGuide.guide.sections[0].diffs).toHaveLength(4);
      expect(restoredGuide.guide.reviewed).toEqual([false, true]);
    } finally {
      releaseSave?.();
      storeSpy.mockRestore();
      server?.stop();
      process.chdir(previousCwd);
      for (const key of envKeys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
}
