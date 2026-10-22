import { afterEach, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReadOnlyFork, discoverForkParent } from './read-only-fork';
const instructions = 'Inspect this task without changing files.';
const parentId = '11111111-1111-4111-8111-111111111111';
const forkId = '22222222-2222-4222-8222-222222222222';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fake(body: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'discussion-agent-')); dirs.push(cwd);
  const executablePath = join(cwd, 'agent');
  writeFileSync(executablePath, '#!/usr/bin/env node\n' + body, { mode: 0o700 });
  return { cwd, executablePath, instructions };
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
  expect(discoverForkParent({ CODEX_THREAD_ID: parentId }, '/repo')).toEqual({ provider: 'codex', sessionId: parentId, cwd: '/repo' });
  expect(discoverForkParent({ PLANNOTATOR_SESSION_TAG: `claude-code:${parentId}` }, '/repo')?.provider).toBe('claude');
  expect(discoverForkParent({ CODEX_SESSION_ID: parentId }, '/repo')).toBeNull();
  expect(discoverForkParent({ CODEX_THREAD_ID: parentId, PLANNOTATOR_DISCUSSION_PROVIDER: 'claude' }, '/repo')).toBeNull();
  expect(discoverForkParent({ CODEX_THREAD_ID: '--last' }, '/repo')).toBeNull();
});

test('OpenCode discovery uses the launching session and refuses invalid explicit identity', () => {
  const sessionId = 'ses_launchingSession';
  expect(discoverForkParent({ OPENCODE_SESSION_ID: sessionId }, '/repo')).toEqual({ provider: 'opencode', sessionId, cwd: '/repo' });
  expect(discoverForkParent({ PLANNOTATOR_DISCUSSION_PROVIDER: 'opencode', PLANNOTATOR_DISCUSSION_SESSION_ID: sessionId }, '/repo'))
    .toEqual({ provider: 'opencode', sessionId, cwd: '/repo' });
  expect(discoverForkParent({ OPENCODE_SESSION_ID: sessionId, PLANNOTATOR_DISCUSSION_PROVIDER: 'opencode' }, '/repo')).toBeNull();
  for (const invalid of [parentId, 'ses_../parent', 'ses_parent?query', '--last', '']) {
    expect(discoverForkParent({ OPENCODE_SESSION_ID: invalid }, '/repo')).toBeNull();
    expect(discoverForkParent({ OPENCODE_SESSION_ID: sessionId, PLANNOTATOR_DISCUSSION_PROVIDER: 'opencode', PLANNOTATOR_DISCUSSION_SESSION_ID: invalid }, '/repo')).toBeNull();
  }
});

test('fork once and resume fork with read-only policy; only completed final answer is returned', async () => {
  const fixture = fake(rpc());
  let persisted: string | undefined;
  const agent = createReadOnlyFork({ provider: 'codex', sessionId: parentId, cwd: fixture.cwd }, {
    instructions, executablePath: fixture.executablePath, onSessionId: id => { persisted = id; },
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
  const turns = calls.filter(m => m.method === 'turn/start');
  for (const m of turns) expect(m.params.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
  expect(turns.map(m => m.params.input[0].text)).toEqual([`${instructions}\n\nwhy?`, `${instructions}\n\nfollowup`]);
  agent.dispose();
});

test('cancellation rejects promptly and does not publish incomplete output', async () => {
  const fixture = fake(rpc("send({method:'item/completed',params:{item:{type:'agentMessage',phase:'final_answer',text:'partial'}}});"));
  const controller = new AbortController();
  const agent = createReadOnlyFork({ provider: 'codex', sessionId: parentId, cwd: fixture.cwd }, {
    instructions, executablePath: fixture.executablePath, onSessionId: () => setTimeout(() => controller.abort(), 20),
  });
  await expect(agent.answer('why?', controller.signal)).rejects.toThrow(); agent.dispose();
});

test('failed fork does not fall back to fresh session or resume parent', async () => {
  const fixture = fake(rpc().replace(`reply({thread:{id:'${forkId}'}})`, `send({id:m.id,error:{message:'Parent unavailable'}})`));
  const agent = createReadOnlyFork({ provider: 'codex', sessionId: parentId, cwd: fixture.cwd }, fixture);
  await expect(agent.answer('why?', new AbortController().signal)).rejects.toThrow('Parent unavailable');
  const calls = readFileSync(join(fixture.cwd, 'calls.jsonl'), 'utf8');
  expect(calls).not.toContain('thread/start'); expect(calls).not.toContain('turn/start');
  expect(() => createReadOnlyFork({ provider: 'codex', sessionId: parentId, cwd: fixture.cwd }, { instructions, sessionId: parentId })).toThrow();
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
  const agent = createReadOnlyFork({ provider: 'claude', sessionId: parentId, cwd: fixture.cwd }, fixture);
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
  const agent = createReadOnlyFork({ provider: 'codex', sessionId: parentId, cwd: fixture.cwd }, fixture);
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
  const agent = createReadOnlyFork({ provider, sessionId: parentId, cwd: fixture.cwd }, fixture);
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
  const agent = createReadOnlyFork({ provider: 'claude', sessionId: parentId, cwd: fixture.cwd }, fixture);
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
  const agent = createReadOnlyFork({ provider, sessionId: parentId, cwd: fixture.cwd }, fixture);
  try {
    await expect(agent.answer('why?', new AbortController().signal)).rejects.toThrow('exited');
  } finally { agent.dispose(); }
});


const opencodeParent = 'ses_parent';
const opencodeChild = 'ses_child';
const readPermissions = [
  { action: '*', resource: '*', effect: 'deny' },
  ...['read', 'glob', 'grep'].map(action => ({ action, resource: '*', effect: 'allow' })),
];
function fakeOpenCode(mode = 'success') {
  return fake(`
const fs = require('node:fs');
const [api, method, path, flag, body] = process.argv.slice(2);
const input = body ? JSON.parse(body) : undefined;
fs.appendFileSync('calls.jsonl',JSON.stringify({api,method,path,input})+'\\n');
const emit = value => process.stdout.write(JSON.stringify(value));
const mode = ${JSON.stringify(mode)};
const child = '${opencodeChild}', parent = '${opencodeParent}';
if (path.endsWith('/fork')) {
  if (mode === 'unavailable') { console.error('Parent session unavailable'); process.exit(1); }
  if (mode === 'startup-timeout') { fs.writeFileSync('started',''); setInterval(()=>{},1000); }
  else emit({data:{id:mode === 'same-parent' ? parent : child,parentID:'ses_ancestor',fork:{sessionID:mode === 'wrong-parent' ? 'ses_other' : parent}}});
} else if (method === 'patch') {
  fs.writeFileSync('permissions.json', JSON.stringify(input.permissions));
} else if (path === '/api/session/'+child && method === 'get') {
  emit({data:{id:child,parentID:'ses_ancestor',fork:{sessionID:parent},permissions:mode === 'unsafe-permissions' ? [] : JSON.parse(fs.readFileSync('permissions.json','utf8'))}});
} else if (path.endsWith('/prompt')) {
  const count = fs.existsSync('question') ? Number(fs.readFileSync('question','utf8'))+1 : 1;
  fs.writeFileSync('question', String(count));
  const acknowledge = () => emit({data:{id:'msg_question'+count,sessionID:child}});
  if (mode === 'delayed-admission') {
    const timer = setInterval(() => { if (!fs.existsSync('acknowledge')) return; clearInterval(timer); acknowledge(); }, 10);
  } else acknowledge();
} else if (path.endsWith('/interrupt')) {
  emit({data:{interrupted:true}});
} else if (path.includes('/message?')) {
  const count = fs.existsSync('question') ? Number(fs.readFileSync('question','utf8')) : 0;
  const answer = {id:'msg_answer'+count,type:'assistant',time:{completed:1},finish:'stop',content:[
    {type:'reasoning',text:'PRIVATE THOUGHT'}, {type:'text',text:'Final answer '+count}]};
  const question = {id:'msg_question'+count,type:'user'};
  if (count && mode === 'poll-failure') { console.error('Transport disconnected'); process.exit(1); }
  if (!count) emit({data:[{id:'msg_inherited',type:'assistant',content:[{type:'text',text:'Inherited answer'}]}],cursor:{}});
  else if (mode === 'pending' && !fs.existsSync('finish')) emit({data:[{...answer,finish:undefined,time:{},content:[{type:'reasoning',text:'PRIVATE THOUGHT'}]},question],cursor:{}});
  else if (mode === 'failure') emit({data:[{id:'msg_idle'+count,type:'idle',outcome:'failed',error:{message:'Provider unavailable'}},answer,question],cursor:{}});
  else if (mode === 'foreign-question') emit({data:[{id:'msg_intruder',type:'user'},answer,question],cursor:{}});
  else if (mode === 'pagination' && !path.includes('cursor=')) emit({data:[{id:'msg_idle'+count,type:'idle',outcome:'succeeded'},answer],cursor:{next:'older page'}});
  else if (mode === 'pagination') emit({data:[question],cursor:{}});
  else emit({data:[{id:'msg_idle'+count,type:'idle',outcome:'succeeded'},answer,question],cursor:{}});
} else { console.error('Unexpected command: '+JSON.stringify(process.argv));process.exit(2); }
`);
}
function openCodeCalls(cwd: string): { api: string; method: string; path: string; input?: Record<string, unknown> }[] {
  return readFileSync(join(cwd, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

test('OpenCode locks a native fork before prompting, resumes it and returns only completed final text', async () => {
  const fixture = fakeOpenCode();
  let persisted: string | undefined;
  const agent = createReadOnlyFork({ provider: 'opencode', sessionId: opencodeParent, cwd: fixture.cwd }, {
    ...fixture, onSessionId: id => { persisted = id; },
  });
  try {
    expect(await agent.answer('why?', new AbortController().signal)).toEqual({ sessionId: opencodeChild, text: 'Final answer 1' });
    expect(persisted).toBe(opencodeChild);
    expect((await agent.answer('followup', new AbortController().signal)).text).toBe('Final answer 2');
    const calls = openCodeCalls(fixture.cwd);
    expect(calls.filter(call => call.path.endsWith('/fork'))).toHaveLength(1);
    expect(calls.filter(call => call.method === 'patch').map(call => call.input?.permissions)).toEqual([readPermissions, readPermissions]);
    const prompts = calls.filter(call => call.path.endsWith('/prompt'));
    expect(prompts.map(call => call.path)).toEqual([`/api/session/${opencodeChild}/prompt`, `/api/session/${opencodeChild}/prompt`]);
    expect(prompts.map(call => call.input?.text)).toEqual([`${instructions}\n\nwhy?`, `${instructions}\n\nfollowup`]);
    expect(calls.findIndex(call => call.method === 'patch')).toBeLessThan(calls.findIndex(call => call.path.endsWith('/prompt')));
    expect(calls.every(call => call.api === 'api')).toBe(true);
  } finally { agent.dispose(); }
});

for (const mode of ['same-parent', 'wrong-parent', 'unsafe-permissions', 'unavailable']) test(`OpenCode ${mode} fails closed before a prompt`, async () => {
  const fixture = fakeOpenCode(mode);
  const agent = createReadOnlyFork({ provider: 'opencode', sessionId: opencodeParent, cwd: fixture.cwd }, fixture);
  try {
    await expect(agent.answer('why?', new AbortController().signal)).rejects.toThrow();
    const calls = openCodeCalls(fixture.cwd);
    expect(calls.some(call => call.path.endsWith('/prompt') || call.path.endsWith('/interrupt'))).toBe(false);
  } finally { agent.dispose(); }
});

test('OpenCode follows message pages to its question and never returns an inherited answer', async () => {
  const fixture = fakeOpenCode('pagination');
  const agent = createReadOnlyFork({ provider: 'opencode', sessionId: opencodeParent, cwd: fixture.cwd }, fixture);
  try {
    expect((await agent.answer('why?', new AbortController().signal)).text).toBe('Final answer 1');
    expect(openCodeCalls(fixture.cwd).some(call => call.path.includes('cursor=older%20page'))).toBe(true);
  } finally { agent.dispose(); }
});

test('OpenCode silence stays pending, unchanged polls do not invent activity, cancellation interrupts only its fork', async () => {
  const fixture = fakeOpenCode('pending');
  const agent = createReadOnlyFork({ provider: 'opencode', sessionId: opencodeParent, cwd: fixture.cwd }, fixture);
  const controller = new AbortController();
  let activity = 0, settled = false;
  const timers = shortTimeouts();
  try {
    const answer = agent.answer('why?', controller.signal, () => { activity++; }).finally(() => { settled = true; });
    const caught = answer.catch(error => error);
    await until(() => existsSync(join(fixture.cwd, 'question')));
    await new Promise(resolve => realSetTimeout(resolve, 150));
    const before = activity;
    await new Promise(resolve => realSetTimeout(resolve, 1100));
    expect(activity).toBe(before);
    expect(settled).toBe(false);
    controller.abort(new Error('Reviewer cancelled this answer'));
    expect((await caught).message).toBe('Reviewer cancelled this answer');
    expect(openCodeCalls(fixture.cwd).filter(call => call.path.endsWith('/interrupt')).map(call => call.path))
      .toEqual([`/api/session/${opencodeChild}/interrupt`]);
  } finally { agent.dispose(); timers.mockRestore(); }
});

test('OpenCode cancellation waits for prompt admission before interrupting its child', async () => {
  const fixture = fakeOpenCode('delayed-admission');
  const agent = createReadOnlyFork({ provider: 'opencode', sessionId: opencodeParent, cwd: fixture.cwd }, fixture);
  const controller = new AbortController();
  try {
    const answer = agent.answer('why?', controller.signal).catch(error => error);
    await until(() => existsSync(join(fixture.cwd, 'question')));
    controller.abort(new Error('Cancelled during admission'));
    await new Promise(resolve => realSetTimeout(resolve, 50));
    expect(openCodeCalls(fixture.cwd).some(call => call.path.endsWith('/interrupt'))).toBe(false);
    writeFileSync(join(fixture.cwd, 'acknowledge'), '');
    expect((await answer).message).toBe('Cancelled during admission');
    expect(openCodeCalls(fixture.cwd).filter(call => call.path.endsWith('/interrupt')).map(call => call.path))
      .toEqual([`/api/session/${opencodeChild}/interrupt`]);
  } finally { agent.dispose(); }
});

for (const mode of ['failure', 'foreign-question', 'poll-failure']) test(`OpenCode ${mode} does not publish partial text`, async () => {
  const fixture = fakeOpenCode(mode);
  const agent = createReadOnlyFork({ provider: 'opencode', sessionId: opencodeParent, cwd: fixture.cwd }, fixture);
  try {
    await expect(agent.answer('why?', new AbortController().signal)).rejects.toThrow(mode === 'failure' ? 'Provider unavailable' : mode === 'poll-failure' ? 'Transport disconnected' : 'another question');
    expect(openCodeCalls(fixture.cwd).filter(call => call.path.endsWith('/interrupt')).map(call => call.path))
      .toEqual([`/api/session/${opencodeChild}/interrupt`]);
  } finally { agent.dispose(); }
});

test('OpenCode startup remains bounded without sending a prompt', async () => {
  const fixture = fakeOpenCode('startup-timeout');
  const agent = createReadOnlyFork({ provider: 'opencode', sessionId: opencodeParent, cwd: fixture.cwd }, fixture);
  const timers = shortTimeouts();
  try {
    await expect(agent.answer('why?', new AbortController().signal)).rejects.toThrow('OpenCode');
    expect(openCodeCalls(fixture.cwd).some(call => call.path.endsWith('/prompt'))).toBe(false);
  } finally { agent.dispose(); timers.mockRestore(); }
});
