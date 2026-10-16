import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReviewDiscussions } from './review-discussions';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'plannotator-discussion-test-'));
  roots.push(root);
  let snapshotId = 'review-one';
  let decided = false;
  const calls: { prompt: string; signal: AbortSignal; complete(text: string): void; sessionId?: string }[] = [];
  const options = {
    file: join(root, 'threads.json'), serverSession: 'review-session', provider: 'codex' as const,
    getSnapshotId: () => snapshotId,
    getContext: () => ({ snapshotId, patch: '@@ -1 +1 @@\n-old\n+new', description: 'fixture repo', cwd: root }),
    isDecided: () => decided,
    createAgent: ({ sessionId, onSessionId }: { sessionId?: string; onSessionId(id: string): void }) => ({
      answer: (prompt: string, signal: AbortSignal) => new Promise<{ sessionId: string; text: string }>(resolve => {
        onSessionId(sessionId ?? 'private-fork');
        calls.push({ prompt, signal, sessionId, complete: text => resolve({ sessionId: 'private-fork', text }) });
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
