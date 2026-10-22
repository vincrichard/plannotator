import { afterEach, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiscussionAgent, discoverDiscussionParent } from './review-discussion-agent';
const parentId = '11111111-1111-4111-8111-111111111111';
const forkId = '22222222-2222-4222-8222-222222222222';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fake(body: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'discussion-agent-')); dirs.push(cwd);
  const executablePath = join(cwd, 'agent');
  writeFileSync(executablePath, '#!/usr/bin/env node\n' + body, { mode: 0o700 });
  return { cwd, executablePath };
}
const rpc = (extra = '') => `
const fs=require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line); if(!m.method)return;
 fs.appendFileSync('calls.jsonl',JSON.stringify(m)+'\\n');
 const send=(x)=>process.stdout.write(JSON.stringify(x)+'\\n');
 const reply=result=>send({id:m.id,result});
 if(m.method==='initialize') reply({});
 if(m.method==='config/read') reply({config:{mcp_servers:{danger:{command:'writer'}}}});
 if(m.method==='thread/fork'||m.method==='thread/resume') reply({thread:{id:'${forkId}'}});
 if(m.method==='turn/start'){
   reply({turn:{id:'t'}});
   ${extra || `
   send({method:'item/agentMessage/delta',params:{delta:'unpublished thought'}});
   send({method:'item/completed',params:{item:{type:'agentMessage',phase:'commentary',text:'unpublished progress'}}});
   send({method:'item/completed',params:{item:{type:'agentMessage',phase:'final_answer',text:'Final answer'}}});
   send({method:'turn/completed',params:{turn:{id:'t',status:'completed'}}});`}
 }
});`;

test('parent discovery never guesses or falls back from invalid explicit identity', () => {
  expect(discoverDiscussionParent({ CODEX_THREAD_ID: parentId }, '/repo')).toEqual({ provider: 'codex', sessionId: parentId, cwd: '/repo' });
  expect(discoverDiscussionParent({ PLANNOTATOR_SESSION_TAG: `claude-code:${parentId}` }, '/repo')?.provider).toBe('claude');
  expect(discoverDiscussionParent({ CODEX_SESSION_ID: parentId }, '/repo')).toBeNull();
  expect(discoverDiscussionParent({ CODEX_THREAD_ID: parentId, PLANNOTATOR_DISCUSSION_PROVIDER: 'claude' }, '/repo')).toBeNull();
  expect(discoverDiscussionParent({ CODEX_THREAD_ID: '--last' }, '/repo')).toBeNull();
});

test('fork once and resume fork with read-only policy; only completed final answer is returned', async () => {
  const fixture = fake(rpc());
  let persisted: string | undefined;
  const agent = createDiscussionAgent({ provider: 'codex', sessionId: parentId, cwd: fixture.cwd }, {
    executablePath: fixture.executablePath, onSessionId: id => { persisted = id; },
  });
  expect(await agent.answer('why?', new AbortController().signal)).toEqual({ sessionId: forkId, text: 'Final answer' });
  expect(persisted).toBe(forkId);
  await agent.answer('followup', new AbortController().signal);
  const calls = readFileSync(join(fixture.cwd, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(calls.filter(m => m.method === 'thread/fork').map(m => m.params.threadId)).toEqual([parentId]);
  expect(calls.filter(m => m.method === 'thread/resume').map(m => m.params.threadId)).toEqual([forkId]);
  for (const m of calls.filter(m => ['thread/fork', 'thread/resume'].includes(m.method))) {
    expect(m.params.sandbox).toBe('read-only'); expect(m.params.approvalPolicy).toBe('never');
    expect(m.params.config.mcp_servers.danger.enabled).toBe(false);
  }
  for (const m of calls.filter(m => m.method === 'turn/start')) expect(m.params.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
  agent.dispose();
});

test('cancellation rejects promptly and does not publish incomplete output', async () => {
  const fixture = fake(rpc("send({method:'item/completed',params:{item:{type:'agentMessage',phase:'final_answer',text:'partial'}}});"));
  const controller = new AbortController();
  const agent = createDiscussionAgent({ provider: 'codex', sessionId: parentId, cwd: fixture.cwd }, {
    executablePath: fixture.executablePath, onSessionId: () => setTimeout(() => controller.abort(), 20),
  });
  await expect(agent.answer('why?', controller.signal)).rejects.toThrow(); agent.dispose();
});

test('failed fork does not fall back to fresh session or resume parent', async () => {
  const fixture = fake(rpc().replace(`reply({thread:{id:'${forkId}'}})`, `send({id:m.id,error:{message:'Parent unavailable'}})`));
  const agent = createDiscussionAgent({ provider: 'codex', sessionId: parentId, cwd: fixture.cwd }, fixture);
  await expect(agent.answer('why?', new AbortController().signal)).rejects.toThrow('Parent unavailable');
  const calls = readFileSync(join(fixture.cwd, 'calls.jsonl'), 'utf8');
  expect(calls).not.toContain('thread/start'); expect(calls).not.toContain('turn/start');
  expect(() => createDiscussionAgent({ provider: 'codex', sessionId: parentId, cwd: fixture.cwd }, { sessionId: parentId })).toThrow();
});

test('Claude forks then resumes using read tools only and returns result rather than thinking/progress', async () => {
  const fixture = fake(`
const fs=require('node:fs');fs.appendFileSync('args.jsonl',JSON.stringify(process.argv.slice(2))+'\\n');
process.stdin.resume();process.stdin.on('end',()=>{
for(const event of [
 {type:'system',subtype:'init',session_id:'${forkId}'},
 {type:'assistant',message:{content:[{type:'thinking',thinking:'private'},{type:'text',text:'progress'}]}},
 {type:'result',subtype:'success',session_id:'${forkId}',result:'Completed reply'}
]) process.stdout.write(JSON.stringify(event)+'\\n');});`);
  const agent = createDiscussionAgent({ provider: 'claude', sessionId: parentId, cwd: fixture.cwd }, fixture);
  expect((await agent.answer('question', new AbortController().signal)).text).toBe('Completed reply');
  await agent.answer('followup', new AbortController().signal);
  const [first, next] = readFileSync(join(fixture.cwd, 'args.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(first).toContain('--fork-session'); expect(first).toContain(parentId);
  expect(next).not.toContain('--fork-session'); expect(next).toContain(forkId);
  expect(first[first.indexOf('--tools') + 1]).toBe('Read,Glob,Grep');
  expect(first).toContain('--strict-mcp-config'); expect(first).toContain('{"disableAllHooks":true}');
});

// Shorten host limits while the fixture processes use real pipes and timers.
const realSetTimeout = globalThis.setTimeout;
function shortTimeouts() {
  return spyOn(globalThis, 'setTimeout').mockImplementation(((callback: TimerHandler, ms?: number, ...args: unknown[]) =>
    realSetTimeout(callback, ms === 120_000 ? 1000 : ms === 900_000 ? 100 : ms === 30_000 ? 30 : ms, ...args)) as typeof setTimeout);
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise(resolve => realSetTimeout(resolve, 10));
  }
  throw new Error('Fixture did not reach the expected state');
}

test('slow startup and answers beyond fifteen minutes survive until a final answer', async () => {
  const fixture = fake(rpc(`
    send({method:'item/reasoning/textDelta',params:{threadId:'${forkId}',delta:'private'}});
    const timer=setInterval(()=>{if(!fs.existsSync('finish'))return;clearInterval(timer);
      send({method:'item/completed',params:{item:{type:'agentMessage',phase:'final_answer',text:'Late final'}}});
      send({method:'turn/completed',params:{turn:{id:'t',status:'completed'}}});
    },10);`).replace(`reply({thread:{id:'${forkId}'}})`, `{
      const timer=setInterval(()=>{if(!fs.existsSync('fork'))return;clearInterval(timer);reply({thread:{id:'${forkId}'}})},10);
    }`));
  const agent = createDiscussionAgent({ provider: 'codex', sessionId: parentId, cwd: fixture.cwd }, fixture);
  let activity = 0;
  let result: { text: string } | undefined, error: unknown;
  const timers = shortTimeouts();
  try {
    const answer = agent.answer('why?', new AbortController().signal, () => { activity++; }).then(value => { result = value; }, cause => { error = cause; });
    await until(() => existsSync(join(fixture.cwd, 'calls.jsonl')) && readFileSync(join(fixture.cwd, 'calls.jsonl'), 'utf8').includes('thread/fork'));
    await new Promise(resolve => realSetTimeout(resolve, 60));
    await Promise.resolve();
    expect(error).toBeUndefined();
    writeFileSync(join(fixture.cwd, 'fork'), '');
    await until(() => activity >= 5);
    await new Promise(resolve => realSetTimeout(resolve, 150));
    await Promise.resolve();
    expect(error).toBeUndefined(); expect(result).toBeUndefined();
    writeFileSync(join(fixture.cwd, 'finish'), '');
    await answer;
    expect(error).toBeUndefined(); expect(result?.text).toBe('Late final');
  } finally { agent.dispose(); timers.mockRestore(); }
});

for (const provider of ['codex', 'claude'] as const) test(`${provider} startup remains bounded and reports startup failure`, async () => {
  const fixture = fake("require('node:fs').writeFileSync('started','');process.stdin.resume();setInterval(()=>{},1000);");
  const agent = createDiscussionAgent({ provider, sessionId: parentId, cwd: fixture.cwd }, fixture);
  const timers = shortTimeouts();
  try {
    const answer = agent.answer('why?', new AbortController().signal).catch(error => error);
    await until(() => existsSync(join(fixture.cwd, 'started')));
    const error = await answer;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(provider === 'codex' ? 'initialize' : 'initialize its discussion session');
  } finally { agent.dispose(); timers.mockRestore(); }
});

test('Claude partial activity is private, survives long answers and preserves cancellation reasons', async () => {
  const fixture = fake(`process.stdin.resume(); process.stdin.on('end',()=>{
    for(const event of [{type:'system',subtype:'init',session_id:'${forkId}'},
      {type:'stream_event',event:{type:'content_block_delta',delta:{text:'private'}}}])
      process.stdout.write(JSON.stringify(event)+'\\n');
    setInterval(()=>{},1000);
  });`);
  const agent = createDiscussionAgent({ provider: 'claude', sessionId: parentId, cwd: fixture.cwd }, fixture);
  const controller = new AbortController(); let activity = 0; let error: Error | undefined;
  const timers = shortTimeouts();
  try {
    const answer = agent.answer('why?', controller.signal, () => { activity++; }).catch(cause => { error = cause; });
    await until(() => activity === 2);
    await new Promise(resolve => realSetTimeout(resolve, 150));
    await Promise.resolve(); expect(error).toBeUndefined();
    controller.abort(new Error('Reviewer cancelled this answer'));
    await answer;
    expect(error?.message).toBe('Reviewer cancelled this answer');
  } finally { agent.dispose(); timers.mockRestore(); }
});

for (const provider of ['codex', 'claude'] as const) test(`${provider} process exit is reported separately from timeout or cancellation`, async () => {
  const fixture = fake(provider === 'codex' ? rpc('process.exit(17);') : 'process.exit(17);');
  const agent = createDiscussionAgent({ provider, sessionId: parentId, cwd: fixture.cwd }, fixture);
  try {
    await expect(agent.answer('why?', new AbortController().signal)).rejects.toThrow('exited');
  } finally { agent.dispose(); }
});
