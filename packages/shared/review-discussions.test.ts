import { afterEach, describe, expect, test, setSystemTime } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewDiscussions } from './review-discussions';

const roots: string[] = [];
afterEach(() => { setSystemTime(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'plannotator-discussion-test-'));
  roots.push(root);
  let snapshotId = 'review-one';
  let decided = false;
  const calls: { prompt: string; signal: AbortSignal; complete(text: string): void; activity(): void; sessionId?: string }[] = [];
  const options = {
    file: join(root, 'threads.json'), serverSession: 'review-session', provider: 'codex' as const,
    getSnapshotId: () => snapshotId,
    getContext: () => ({ snapshotId, patch: '@@ -1 +1 @@\n-old\n+new', description: 'fixture repo', cwd: root }),
    isDecided: () => decided,
    createAgent: ({ sessionId, onSessionId }: { sessionId?: string; onSessionId(id: string): void }) => ({
      answer: (prompt: string, signal: AbortSignal, onActivity?: () => void) => new Promise<{ sessionId: string; text: string }>(resolve => {
        onSessionId(sessionId ?? 'private-fork');
        calls.push({ prompt, signal, sessionId, activity: () => onActivity?.(), complete: text => resolve({ sessionId: 'private-fork', text }) });
      }),
      dispose() {},
    }),
  };
  const store = createReviewDiscussions(options);
  const request = (method: string, path = '', body?: unknown, headers = {}) => store.handle(new Request(`http://localhost:1234/api/review-discussions${path}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
    ...(body ? { body: JSON.stringify({ serverSession: 'review-session', ...body as object }) } : {}),
  }));
  const question = { id: 'question-1', snapshotId, anchor: { filePath: 'other.ts', lineStart: 12, lineEnd: 14, side: 'old' }, text: 'Why remove this?', codeContext: 'removed code' };
  return { store, request, question, calls, options, setSnapshot: (value: string) => { snapshotId = value; }, decide: () => { decided = true; } };
}
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); };

describe('review discussions', () => {
  test('agent openers persist without running a model; the first reply supplies the opener and captured review to a new fork', async () => {
    const f = setup();
    const opening = { ...f.question, role: 'assistant', text: 'This removal loses the retry guard.' };
    expect((await f.request('POST', '', opening))!.status).toBe(201);
    expect(f.calls).toHaveLength(0);
    expect(f.store.snapshot().threads[0]).toMatchObject({ status: 'answered', messages: [{ role: 'assistant', text: opening.text }] });
    expect((await f.request('POST', '', opening))!.status).toBe(200);
    expect((await f.request('POST', '', { ...opening, role: 'user' }))!.status).toBe(409);
    expect(f.store.snapshot().threads).toHaveLength(1);
    f.store.dispose();
    const restored = createReviewDiscussions(f.options);
    expect(restored.snapshot().threads[0].messages[0].role).toBe('assistant');
    f.setSnapshot('later-review');
    const reply = (id: string, text: string) => restored.handle(new Request('http://localhost:1234/api/review-discussions/question-1/messages', {
      method: 'POST', body: JSON.stringify({ serverSession: 'review-session', id, text }),
    }));
    expect((await reply('reply-one', 'Can you explain the risk?'))!.status).toBe(200);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].sessionId).toBeUndefined();
    expect(f.calls[0].prompt).toContain(opening.text);
    expect(f.calls[0].prompt).toContain('removed code');
    expect(f.calls[0].prompt).toContain('@@ -1 +1 @@\n-old\n+new');
    expect(f.calls[0].prompt).toContain('Snapshot: review-one');
    expect(f.calls[0].prompt).toContain('Can you explain the risk?');
    f.calls[0].complete('The retry guard handled transient failures.'); await settle();
    await reply('reply-two', 'Explain further');
    expect(f.calls[1].sessionId).toBe('private-fork');
    expect(f.calls[1].prompt).not.toContain('Reviewed patch');
    f.calls[1].complete('Second explanation'); await settle();
    expect(restored.snapshot().threads[0].messages.map(m => m.role)).toEqual(['assistant', 'user', 'assistant', 'user', 'assistant']);
    restored.dispose();
  });

  test('agent-opened line, file and general threads resolve or convert without an answer', async () => {
    const f = setup();
    for (const scope of ['line', 'file', 'general']) {
      const anchor = { ...f.question.anchor, scope, ...(scope === 'general' ? { filePath: '', lineStart: 0, lineEnd: 0 } : {}) };
      const opening = { ...f.question, id: scope, role: 'assistant', anchor, text: 'Agent finding, not a reviewer instruction' };
      expect((await f.request('POST', '', opening))!.status).toBe(201);
      await f.request('PATCH', `/${scope}`, { action: 'resolve' });
      expect(f.store.snapshot().threads.find(t => t.id === scope)?.status).toBe('resolved');
      await f.request('PATCH', `/${scope}`, { action: 'reopen' });
      const result = await (await f.request('PATCH', `/${scope}`, { action: 'convert', text: 'Please keep the retry guard.' }))!.json();
      expect(result.annotation).toMatchObject({ ...anchor, type: 'comment', text: 'Please keep the retry guard.' });
      expect(JSON.stringify(result.annotation)).not.toContain(opening.text);
    }
    expect(f.calls).toHaveLength(0);
    f.store.dispose();
  });

  test('agent openings preserve role validation, session, snapshot and origin checks', async () => {
    const f = setup();
    for (const role of ['system', null, 1, {}]) expect((await f.request('POST', '', { ...f.question, role }))!.status).toBe(400);
    const opening = { ...f.question, role: 'assistant' };
    expect((await f.request('POST', '', opening, { origin: 'https://attacker.test' }))!.status).toBe(403);
    expect((await f.request('POST', '', { ...opening, serverSession: 'other' }))!.status).toBe(409);
    expect((await f.request('POST', '', { ...opening, snapshotId: 'other' }))!.status).toBe(409);
    expect((await f.request('POST', '', { ...opening, anchor: { ...opening.anchor, filePath: '../secret' } }))!.status).toBe(400);
    f.decide();
    expect((await f.request('POST', '', opening))!.status).toBe(409);
    expect(f.store.snapshot().threads).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
    f.store.dispose();
  });

  test('answers are final-only, anchored, private and persisted; follow-ups resume the same fork', async () => {
    const f = setup();
    expect((await f.request('POST', '', f.question))!.status).toBe(201);
    const waiting = await (await f.request('GET'))!.json();
    expect(waiting.threads[0].status).toBe('answering');
    expect(waiting.threads[0].messages.map((m: { role: string }) => m.role)).toEqual(['user']);
    expect(JSON.stringify(waiting)).not.toContain('private-fork');
    expect(f.calls[0].prompt).toContain('other.ts:12-14 (old)');
    expect(f.calls[0].prompt).toContain('removed code');
    f.calls[0].complete('Final explanation');
    await settle();
    expect(f.store.snapshot().threads[0].messages.at(-1)?.text).toBe('Final explanation');
    expect(JSON.parse(readFileSync(f.options.file, 'utf8')).threads[0].forkId).toBe('private-fork');
    expect((await f.request('POST', '/question-1/messages', { id: 'followup', text: 'What about errors?' }))!.status).toBe(200);
    expect(f.calls[1].sessionId).toBe('private-fork');
    expect(f.calls[1].prompt).not.toContain('Reviewed patch');
    expect(f.calls[1].prompt).toContain('other.ts:12-14 (old)');
    f.calls[1].complete('Follow-up answer');
    await settle();
    const restored = createReviewDiscussions(f.options);
    expect(restored.snapshot().threads[0].messages).toHaveLength(4);
    restored.dispose(); f.store.dispose();
  });

  test('network retries do not fork twice; another thread can answer independently', async () => {
    const f = setup();
    await f.request('POST', '', f.question);
    await f.request('POST', '', f.question);
    expect(f.calls).toHaveLength(1);
    expect((await f.request('POST', '', { ...f.question, text: 'Different question' }))!.status).toBe(409);
    expect((await f.request('POST', '/question-1/messages', { id: 'next', text: 'too early' }))!.status).toBe(409);
    await f.request('POST', '', { ...f.question, id: 'question-2', anchor: { ...f.question.anchor, filePath: 'another.ts', side: 'new' } });
    expect(f.calls).toHaveLength(2);
    f.calls[1].complete('Second finished first'); await settle();
    expect(f.store.snapshot().threads[0].status).toBe('answering');
    expect(f.store.snapshot().threads[1].status).toBe('answered');
    f.store.dispose();
  });

  test('silent answers keep running; waiting acknowledges silence, cancel ignores late output and stale actions', async () => {
    const f = setup();
    const start = Date.now();
    setSystemTime(start);
    await f.request('POST', '', f.question);
    const messageId = f.store.snapshot().threads[0].messages[0].id;
    expect(f.store.snapshot().threads[0].activity).toEqual({ startedAt: start });
    setSystemTime(start + 1000);
    f.calls[0].activity();
    const version = f.store.snapshot().version;
    f.calls[0].activity();
    expect(f.store.snapshot().version).toBe(version);
    setSystemTime(start + 20 * 60_000);
    expect(f.store.snapshot().threads[0].status).toBe('answering');
    expect(f.calls[0].signal.aborted).toBe(false);
    expect((await f.request('PATCH', '/question-1', { action: 'keep-waiting', messageId }))!.status).toBe(200);
    expect(f.store.snapshot().threads[0].activity).toEqual({ startedAt: start, lastActivityAt: start + 1000, waitRequestedAt: start + 20 * 60_000 });
    expect(f.calls).toHaveLength(1);
    expect((await f.request('PATCH', '/question-1', { action: 'cancel', messageId }, { origin: 'https://attacker.test' }))!.status).toBe(403);
    expect(f.calls[0].signal.aborted).toBe(false);
    expect((await f.request('PATCH', '/question-1', { action: 'cancel', messageId }))!.status).toBe(200);
    expect(f.calls[0].signal.aborted).toBe(true);
    await f.request('POST', '/question-1/messages', { id: 'followup', text: 'Try again' });
    expect((await f.request('PATCH', '/question-1', { action: 'cancel', messageId }))!.status).toBe(409);
    expect((await f.request('PATCH', '/question-1', { action: 'keep-waiting', messageId }))!.status).toBe(409);
    f.calls[0].activity(); f.calls[0].complete('Late cancelled answer'); await settle();
    expect(f.calls[1].signal.aborted).toBe(false);
    expect(f.store.snapshot().threads[0].messages).toHaveLength(2);
    expect(f.store.snapshot().threads[0].activity).toEqual({ startedAt: start + 20 * 60_000 });
    f.calls[1].complete('New answer'); await settle();
    expect(f.store.snapshot().threads[0].status).toBe('answered');
    f.store.dispose();
  });

  test('resolve cancels only its own fork and ignores late answers', async () => {
    const f = setup();
    await f.request('POST', '', f.question);
    await f.request('POST', '', { ...f.question, id: 'other' });
    expect((await f.request('PATCH', '/question-1', { action: 'resolve' }))!.status).toBe(200);
    expect(f.calls[0].signal.aborted).toBe(true);
    expect(f.calls[1].signal.aborted).toBe(false);
    f.calls[0].complete('Late answer'); await settle();
    expect(f.store.snapshot().threads[0].messages).toHaveLength(1);
    expect((await f.request('PATCH', '/question-1', { action: 'reopen' }))!.status).toBe(200);
    expect(f.store.snapshot().threads[0].status).toBe('answered');
    f.store.dispose();
  });

  test('conversion retains old-side location and recovery copy until ordinary draft saves it', async () => {
    const f = setup();
    await f.request('POST', '', f.question);
    f.calls[0].complete('Answer not a change request'); await settle();
    const response = await (await f.request('PATCH', '/question-1', { action: 'convert', text: 'Preserve the error branch.' }))!.json();
    expect(response.annotation).toMatchObject({ filePath: 'other.ts', lineStart: 12, lineEnd: 14, side: 'old', type: 'comment', text: 'Preserve the error branch.' });
    expect(JSON.stringify(response.annotation)).not.toContain('Answer not a change request');
    const retry = await (await f.request('PATCH', '/question-1', { action: 'convert', text: 'Preserve the error branch.' }))!.json();
    expect(retry.annotation.id).toBe(response.annotation.id);
    expect(f.store.snapshot().threads[0].conversionSaved).toBe(false);
    f.store.acknowledgeConversions({ codeAnnotations: [response.annotation] });
    expect(f.store.snapshot().threads[0].conversionSaved).toBe(true);
    expect((await f.request('POST', '/question-1/messages', { id: 'no', text: 'followup' }))!.status).toBe(409);
    f.store.dispose();
  });

  test('snapshot changes cannot retarget questions or converted comments', async () => {
    const f = setup();
    await f.request('POST', '', f.question);
    f.setSnapshot('different-review');
    expect((await f.request('POST', '', { ...f.question, id: 'wrong' }))!.status).toBe(409);
    expect((await f.request('PATCH', '/question-1', { action: 'convert', text: 'Change it' }))!.status).toBe(409);
    expect(f.store.snapshot().threads[0].anchor.filePath).toBe('other.ts');
    f.store.dispose();
  });

  test('cross-origin, stale sessions, invalid anchors and ended reviews cannot launch agents', async () => {
    const f = setup();
    expect((await f.request('POST', '', f.question, { origin: 'https://attacker.test' }))!.status).toBe(403);
    expect((await f.request('POST', '', { ...f.question, serverSession: 'old-session' }))!.status).toBe(409);
    expect((await f.request('POST', '', { ...f.question, anchor: { ...f.question.anchor, side: 'both' } }))!.status).toBe(400);
    expect((await f.request('POST', '', { ...f.question, anchor: { ...f.question.anchor, lineStart: -1 } }))!.status).toBe(400);
    expect((await f.request('POST', '', { ...f.question, anchor: { ...f.question.anchor, filePath: '../secret' } }))!.status).toBe(400);
    f.decide();
    expect((await f.request('POST', '', f.question))!.status).toBe(409);
    expect(f.calls).toHaveLength(0);
    f.store.dispose();
  });

  test('unavailable parent does not fall back to an unrelated agent and interrupted state is recoverable', async () => {
    const f = setup();
    const unavailable = createReviewDiscussions({ ...f.options, provider: undefined, unavailableReason: 'Missing explicit parent' });
    const response = await unavailable.handle(new Request('http://localhost:1234/api/review-discussions', { method: 'POST', body: JSON.stringify(f.question) }));
    expect(response!.status).toBe(503);
    expect(f.calls).toHaveLength(0);
    await f.request('POST', '', f.question);
    f.store.dispose();
    const restored = createReviewDiscussions(f.options);
    expect(restored.snapshot().threads[0].status).toBe('error');
    expect(restored.snapshot().threads[0].messages[0].text).toBe(f.question.text);
    restored.dispose(); unavailable.dispose();
  });
});
