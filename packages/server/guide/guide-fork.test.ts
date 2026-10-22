import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentJobHandler } from '../agent-jobs';
import { createGuideSession } from './guide-review';

const parentId = '11111111-1111-4111-8111-111111111111';
const forkId = '22222222-2222-4222-8222-222222222222';
const output = JSON.stringify({ title: 'Inherited intent', intent: 'Explain the snapshot', sections: [
  { title: 'Update value', overview: 'Context from the conversation', diffs: [{ file: 'main.ts' }] },
], unplacedFiles: [] });
const patch = 'diff --git a/main.ts b/main.ts\n--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-old\n+snapshot-value\n';
const jobsUrl = new URL('http://localhost/api/agents/jobs');
const originalPath = process.env.PATH;
const dirs: string[] = [];
afterEach(() => { process.env.PATH = originalPath; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(provider: 'codex' | 'claude' | 'opencode', mode: 'success' | 'failure' | 'pending' | 'malformed' = 'success') {
  const cwd = mkdtempSync(join(tmpdir(), 'guide-fork-')); dirs.push(cwd);
  const text = mode === 'malformed' ? 'broken guide JSON' : output;
  const parentSessionId = provider === 'opencode' ? 'ses_guideParent' : parentId;
  writeFileSync(join(cwd, provider), `#!/usr/bin/env node
const fs = require('node:fs');
const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
fs.appendFileSync('argv.jsonl', JSON.stringify(process.argv.slice(2))+'\\n');
${provider === 'opencode' ? `
const [, method, route] = process.argv.slice(2);
const bodyIndex = process.argv.indexOf('--data');
const body = bodyIndex < 0 ? {} : JSON.parse(process.argv[bodyIndex + 1]);
if (route.endsWith('/fork')) {
 ${mode === 'failure' ? `console.error('Parent session unavailable'); process.exit(1);` : ''}
 fs.rmSync('prompt.txt', {force:true});
 send({data:{id:'ses_guideFork',fork:{sessionID:'${parentSessionId}'}}});
} else if (method.toLowerCase() === 'patch') {
 fs.writeFileSync('permissions.json',JSON.stringify(body.permissions)); send({});
} else if (route.includes('/message?')) {
 send({data:fs.existsSync('prompt.txt') ? [
  {id:'msg_idle',type:'idle',outcome:'succeeded'},
  {id:'msg_answer',type:'assistant',time:{completed:1},finish:'stop',content:[{type:'text',text:${JSON.stringify(text)}}]},
  {id:'msg_question',type:'user'},
 ] : [], cursor:{}});
} else if (route.endsWith('/prompt')) {
 fs.writeFileSync('prompt.txt',body.text); send({data:{id:'msg_question',sessionID:'ses_guideFork'}});
} else send({data:{id:'ses_guideFork',fork:{sessionID:'${parentSessionId}'},permissions:JSON.parse(fs.readFileSync('permissions.json','utf8'))}});
` : provider === 'claude' ? `
let prompt=''; process.stdin.on('data', chunk=>prompt+=chunk);
process.stdin.on('end',()=>{
 fs.writeFileSync('prompt.txt',prompt);
 send({type:'system',subtype:'init',session_id:'${forkId}'});
 send({type:'result',subtype:'success',session_id:'${forkId}',result:${JSON.stringify(text)}});
});` : `
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(!m.method)return;
 fs.appendFileSync('calls.jsonl',JSON.stringify(m)+'\\n');
 const reply=result=>send({id:m.id,result});
 if(m.method==='initialize')reply({});
 if(m.method==='config/read')reply({config:{}});
 if(m.method==='thread/fork') ${mode === 'failure' ? `send({id:m.id,error:{message:'Parent session unavailable'}});` : `reply({thread:{id:'${forkId}'}});`}
 if(m.method==='turn/start'){
   fs.writeFileSync('prompt.txt',m.params.input[0].text);
   reply({turn:{id:'t'}});
   ${mode === 'pending' ? '' : `send({method:'item/completed',params:{item:{type:'agentMessage',phase:'final_answer',text:${JSON.stringify(text)}}}});
   send({method:'turn/completed',params:{turn:{id:'t',status:'completed'}}});`}
 }
});`}
`, { mode: 0o700 });
  // All other provider discovery stays off PATH; the fake CLI still needs node.
  writeFileSync(join(cwd, 'node'), `#!/bin/sh\nexec '${Bun.which('node')}' "$@"\n`, { mode: 0o700 });
  process.env.PATH = cwd;
  const guide = createGuideSession();
  const parent = { provider, sessionId: parentSessionId, cwd };
  const handler = createAgentJobHandler({ mode: 'review', getServerUrl: () => 'http://localhost', getCwd: () => cwd,
    guideForkProvider: provider,
    buildCommand: async (_provider, config) => ({
      ...await guide.buildCommand({ parent, cwd, patch, diffType: 'staged', config, changedFiles: [{ path: 'main.ts', additions: 1, deletions: 1 }] }),
      changedFilesSnapshot: ['main.ts'],
    }),
    onJobComplete: async (job, meta) => {
      const result = await guide.onJobComplete({ job, meta, changedFiles: meta.changedFilesSnapshot! });
      if (!result.summary) { job.status = 'failed'; job.error = result.error ?? 'Invalid guide'; }
      else job.summary = result.summary;
    },
  });
  return { cwd, guide, handler };
}
async function launch(handler: ReturnType<typeof createAgentJobHandler>) {
  const response = await handler.handle(new Request(jobsUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
    // Old UI settings and client argv cannot override the server-owned parent.
    body: JSON.stringify({ provider: 'guide', engine: 'claude', model: 'other-model', command: ['false'] }),
  }), jobsUrl);
  expect(response?.status).toBe(201);
  const { job } = await response!.json();
  expect(JSON.stringify(job)).not.toContain(parentId);
  return job.id as string;
}
async function terminal(handler: ReturnType<typeof createAgentJobHandler>, id: string) {
  for (let i = 0; i < 200; i++) {
    const job = handler.getJob(id)!;
    if (['done', 'failed', 'killed'].includes(job.status)) return job;
    await Bun.sleep(10);
  }
  throw new Error('Guide did not finish');
}

for (const provider of ['codex', 'claude', 'opencode'] as const) test(`${provider} guide inherits parent and validates final output through normal job ingestion`, async () => {
  const { cwd, guide, handler } = fixture(provider);
  try {
    const id = await launch(handler);
    expect((await terminal(handler, id)).status).toBe('done');
    expect(guide.getGuide(id)?.sections[0].diffs).toEqual([{ file: 'main.ts' }]);
    const prompt = readFileSync(join(cwd, 'prompt.txt'), 'utf8');
    expect(prompt).toContain(patch);
    expect(prompt).not.toContain('git diff --cached');
    expect(prompt).toContain('Return only JSON');
    expect(readFileSync(join(cwd, 'argv.jsonl'), 'utf8')).not.toContain('other-model');
    if (provider === 'codex') {
      const calls = readFileSync(join(cwd, 'calls.jsonl'), 'utf8');
      expect(calls).toContain('thread/fork'); expect(calls).toContain(parentId);
      expect(calls).not.toContain('thread/start'); expect(calls).not.toContain('thread/resume');
    } else {
      const args = readFileSync(join(cwd, 'argv.jsonl'), 'utf8');
      if (provider === 'claude') { expect(args).toContain('--fork-session'); expect(args).toContain(parentId); }
      else { expect(args).toContain('/api/session/ses_guideParent/fork'); expect(args).toContain('/api/session/ses_guideFork/prompt'); }
    }
    // Regenerating forks the launching session afresh, not the earlier guide's fork.
    expect((await terminal(handler, await launch(handler))).status).toBe('done');
  } finally { handler.killAll(); }
});

for (const provider of ['codex', 'opencode'] as const) test(`${provider}: unavailable parent fails visibly without a context-free fallback`, async () => {
  const { handler, guide } = fixture(provider, 'failure');
  try {
    const id = await launch(handler);
    expect((await terminal(handler, id)).error).toContain('Parent session unavailable');
    expect(guide.getGuide(id)).toBeNull();
  } finally { handler.killAll(); }
});

test('cancelling a fork never publishes its result', async () => {
  const { handler, guide, cwd } = fixture('codex', 'pending');
  const id = await launch(handler);
  for (let i = 0; i < 200 && !existsSync(join(cwd, 'prompt.txt')); i++) await Bun.sleep(10);
  expect(existsSync(join(cwd, 'prompt.txt'))).toBe(true);
  const response = await handler.handle(new Request(`${jobsUrl}/${id}`, { method: 'DELETE' }), new URL(`${jobsUrl}/${id}`));
  expect(response?.status).toBe(200);
  await Bun.sleep(50);
  expect(handler.getJob(id)?.status).toBe('killed');
  expect(guide.getGuide(id)).toBeNull();
});

test('malformed fork output stays available for existing manual repair', async () => {
  const { handler, guide } = fixture('codex', 'malformed');
  try {
    const id = await launch(handler);
    expect((await terminal(handler, id)).status).toBe('failed');
    expect(guide.getFailedPayload(id)).toBe('broken guide JSON');
    expect(guide.submitManualOutput(id, output, ['main.ts'])).toMatchObject({ ok: true });
    expect(guide.getGuide(id)).not.toBeNull();
  } finally { handler.killAll(); }
});
