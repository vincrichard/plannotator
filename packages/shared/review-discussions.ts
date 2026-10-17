import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ReviewDiscussion, ReviewDiscussionAnchor, ReviewDiscussionsSnapshot } from '@plannotator/core/review-discussions';
import { validateAnnotationPatch } from './external-annotation';
import { callFlowInstallOriginAllowed } from './call-flow-install';

export interface DiscussionAgent {
  answer(prompt: string, signal: AbortSignal): Promise<{ sessionId: string; text: string }>;
  dispose(): void;
}
interface StoredThread extends ReviewDiscussion { forkId?: string; context: string; cwd: string }
interface Options {
  file: string;
  serverSession: string;
  provider?: 'codex' | 'claude';
  supported?: boolean;
  unavailableReason?: string;
  getSnapshotId(): string;
  getContext(): { snapshotId: string; patch: string; description: string; cwd: string };
  isDecided(): boolean;
  createAgent(options: { cwd: string; sessionId?: string; onSessionId(id: string): void }): DiscussionAgent;
}
const BASE = '/api/review-discussions';
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const text = (value: unknown, max = 32_000): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function anchorInput(value: unknown): ReviewDiscussionAnchor | null {
  if (!object(value)) return null;
  const scope = value.scope ?? 'line';
  if (!['line', 'file', 'general'].includes(String(scope))) return null;
  if (typeof value.filePath !== 'string' || value.filePath.length > 4096) return null;
  if (scope !== 'general' && (!value.filePath || value.filePath.startsWith('/') || value.filePath.split(/[\\/]/).includes('..'))) return null;
  if (value.side !== 'old' && value.side !== 'new') return null;
  if (![value.lineStart, value.lineEnd].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= (scope === 'line' ? 1 : 0) && n <= 100_000_000)) return null;
  if (Number(value.lineEnd) < Number(value.lineStart)) return null;
  const patch = validateAnnotationPatch('review', value);
  if ('error' in patch) return null;
  // Only location metadata crosses into a regular reviewer comment.
  const fields = patch.fields as Record<string, unknown>;
  const keys = ['filePath', 'lineStart', 'lineEnd', 'side', 'scope', 'charStart', 'charEnd', 'tokenText', 'selectedText', 'prUrl', 'prNumber', 'prTitle', 'prRepo', 'diffScope', 'commitSha', 'commitSubject', 'gitButlerDiffType', 'gitButlerDiffLabel', 'gitButlerBase', 'gitButlerSnapshotId'];
  return Object.fromEntries(keys.filter(k => fields[k] !== undefined).map(k => [k, fields[k]])) as unknown as ReviewDiscussionAnchor;
}

/** Session-owned discussion store: ordinary annotation drafts never contain questions. */
export function createReviewDiscussions(options: Options) {
  let threads: StoredThread[] = [];
  let version = 0;
  let stopped = false;
  const running = new Map<string, { controller: AbortController; agent: DiscussionAgent }>();
  try {
    const saved = JSON.parse(readFileSync(options.file, 'utf8'));
    if (!object(saved) || saved.serverSession !== options.serverSession || !Array.isArray(saved.threads)) throw new Error('Invalid discussion store');
    threads = saved.threads;
    version = Number(saved.version) || 0;
    for (const thread of threads) if (thread.status === 'answering') {
      thread.status = 'error';
      thread.error = 'The answer was interrupted. Send a follow-up to continue this discussion.';
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const save = () => {
    mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });
    const temporary = `${options.file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ serverSession: options.serverSession, version: version + 1, threads }), { mode: 0o600 });
    renameSync(temporary, options.file);
    version++;
  };
  const snapshot = (): ReviewDiscussionsSnapshot => ({
    supported: options.supported !== false, available: options.supported !== false && !stopped && !options.unavailableReason && !!options.provider,
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.unavailableReason ? { reason: options.unavailableReason } : {}),
    snapshotId: options.getSnapshotId(), version,
    threads: threads.map(({ forkId, context, cwd, ...thread }) => thread),
  });
  const cancel = (id: string) => {
    const job = running.get(id);
    running.delete(id);
    job?.controller.abort();
    job?.agent.dispose();
  };
  const run = (thread: StoredThread, question: string) => {
    const controller = new AbortController();
    let agent: DiscussionAgent;
    try { agent = options.createAgent({ cwd: thread.cwd, sessionId: thread.forkId, onSessionId(id) {
      if (controller.signal.aborted) return;
      thread.forkId = id;
      save();
    } }); } catch (error) {
      thread.status = 'error';
      thread.error = error instanceof Error ? error.message : 'Could not start the discussion fork.';
      save();
      return;
    }
    running.set(thread.id, { controller, agent });
    const context = thread.messages.some(message => message.role === 'assistant')
      ? `Continue the same discussion at ${thread.anchor.filePath || '(whole review)'}:${thread.anchor.lineStart}-${thread.anchor.lineEnd} (${thread.anchor.side}), snapshot ${thread.snapshotId}. Use the reviewed code captured earlier; working files may have changed.`
      : thread.context;
    const prompt = `${context}\n\nReviewer question:\n${question}\n\nAnswer this question only. Do not edit files, run modifications, submit or approve a review, or start another agent. This is a discussion fork; the parent agent receives change requests only on final review submission. Return a self-contained final answer; internal reasoning and intermediate messages are not displayed.`;
    void agent.answer(prompt, controller.signal).then(({ sessionId, text: answer }) => {
      if (controller.signal.aborted || stopped) return;
      if (!text(answer, 200_000)) throw new Error('The agent returned no final answer.');
      thread.forkId = sessionId;
      thread.messages.push({ id: crypto.randomUUID(), role: 'assistant', text: answer, createdAt: Date.now() });
      thread.status = 'answered';
      thread.updatedAt = Date.now();
      save();
    }).catch(error => {
      if (controller.signal.aborted || stopped) return;
      thread.status = 'error';
      thread.error = error instanceof Error ? error.message.slice(0, 2000) : 'The agent could not answer.';
      thread.updatedAt = Date.now();
      try { save(); } catch { thread.error = 'Could not persist the discussion. Keep this review open and retry.'; }
    }).finally(() => {
      if (running.get(thread.id)?.controller === controller) running.delete(thread.id);
      agent.dispose();
    });
  };
  const fail = (error: string, status = 400) => Response.json({ error }, { status });
  return {
    snapshot,
    acknowledgeConversions(draft: unknown) {
      if (!object(draft) || !Array.isArray(draft.codeAnnotations)) return;
      const ids = new Set(draft.codeAnnotations.filter(object).map(a => a.id));
      let changed = false;
      for (const thread of threads) if (thread.annotation && !thread.conversionSaved && ids.has(thread.annotation.id)) {
        thread.conversionSaved = true;
        changed = true;
      }
      if (changed) save();
    },
    dispose() {
      stopped = true;
      for (const id of running.keys()) cancel(id);
    },
    async handle(req: Request): Promise<Response | null> {
      const url = new URL(req.url);
      if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return null;
      if (req.method === 'GET' && url.pathname === BASE) return Response.json(snapshot(), { headers: { 'Cache-Control': 'no-store' } });
      if (req.method !== 'POST' && req.method !== 'PATCH') return fail('Method not allowed', 405);
      if (!callFlowInstallOriginAllowed(req.headers.get('origin'), url.host, req.headers.get('sec-fetch-site'))) return fail('Cross-origin discussion requests are not allowed', 403);
      if (stopped || options.isDecided()) return fail('This review has ended.', 409);
      if (!snapshot().available) return fail(options.unavailableReason ?? 'No supported parent agent session is available.', 503);
      let body: Record<string, unknown>;
      try {
        const raw = await req.text();
        if (raw.length > 150_000) return fail('Discussion request is too large', 413);
        const parsed = JSON.parse(raw);
        if (!object(parsed)) return fail('Expected an object');
        body = parsed;
      } catch { return fail('Invalid JSON'); }
      if (body.serverSession !== options.serverSession) return fail('This browser belongs to a different review session.', 409);
      if (stopped || options.isDecided()) return fail('This review has ended.', 409);
      try {
        if (url.pathname === BASE && req.method === 'POST') {
          if (typeof body.id !== 'string' || !ID.test(body.id) || !text(body.text)) return fail('A valid id and question are required');
          const existing = threads.find(t => t.id === body.id);
          if (existing) {
            if (existing.messages[0]?.text !== body.text || existing.snapshotId !== body.snapshotId || JSON.stringify(existing.anchor) !== JSON.stringify(anchorInput(body.anchor))) return fail('This request id was already used for a different question.', 409);
            return Response.json({ thread: snapshot().threads.find(t => t.id === body.id) });
          }
          if (threads.length >= 100) return fail('This review already has 100 discussions.', 409);
          const anchor = anchorInput(body.anchor);
          if (!anchor) return fail('Invalid discussion location');
          const context = options.getContext();
          if (body.snapshotId !== context.snapshotId) return fail('The reviewed snapshot changed. Select the code again.', 409);
          if (body.codeContext !== undefined && (typeof body.codeContext !== 'string' || body.codeContext.length > 64_000)) return fail('Invalid code context');
          const now = Date.now();
          const thread: StoredThread = {
            id: body.id, anchor, cwd: context.cwd, snapshotId: context.snapshotId, status: 'answering', createdAt: now, updatedAt: now,
            messages: [{ id: `${body.id}-question`, role: 'user', text: body.text, createdAt: now }],
            context: `Plannotator review discussion.\n${context.description}\nSnapshot: ${context.snapshotId}\nLocation: ${anchor.filePath || '(whole review)'}:${anchor.lineStart}-${anchor.lineEnd} (${anchor.side})\nSelected code from the review:\n${body.codeContext ?? anchor.selectedText ?? ''}\nReviewed patch${context.patch.length > 200_000 ? ' (truncated)' : ''}:\n${context.patch.slice(0, 200_000)}`,
          };
          threads.push(thread);
          try { save(); } catch (error) { threads.pop(); throw error; }
          run(thread, body.text);
          return Response.json({ thread: snapshot().threads.find(t => t.id === thread.id) }, { status: 201 });
        }
        const match = url.pathname.match(/^\/api\/review-discussions\/([a-zA-Z0-9_-]{1,128})(\/messages)?$/);
        const thread = match && threads.find(t => t.id === match[1]);
        if (!thread) return fail('Discussion not found', 404);
        const previous = structuredClone(thread);
        const persist = () => {
          try { save(); } catch (error) {
            for (const key of Object.keys(thread)) delete (thread as unknown as Record<string, unknown>)[key];
            Object.assign(thread, previous);
            throw error;
          }
        };
        if (match![2] && req.method === 'POST') {
          if (typeof body.id !== 'string' || !ID.test(body.id) || !text(body.text)) return fail('A valid message id and question are required');
          const existing = thread.messages.find(m => m.id === body.id);
          if (existing) return existing.text === body.text && existing.role === 'user' ? Response.json({ thread: snapshot().threads.find(t => t.id === thread.id) }) : fail('Message id already used', 409);
          if (thread.status === 'converted' || thread.status === 'resolved') return fail('This discussion is closed.', 409);
          if (thread.status === 'answering') return fail('Wait for the current answer before sending a follow-up.', 409);
          if (thread.messages.length >= 200) return fail('This discussion has reached its message limit.', 409);
          thread.messages.push({ id: body.id, role: 'user', text: body.text, createdAt: Date.now() });
          thread.status = 'answering';
          delete thread.error;
          thread.updatedAt = Date.now();
          persist();
          run(thread, body.text);
        } else if (!match![2] && req.method === 'PATCH') {
          if (!['resolve', 'reopen', 'convert'].includes(String(body.action))) return fail('Unknown discussion action');
          if (thread.status === 'converted') {
            if (body.action !== 'convert') return fail('This discussion was converted to a review comment.', 409);
            return Response.json({ thread: snapshot().threads.find(t => t.id === thread.id), annotation: thread.annotation });
          }
          if (body.action === 'convert') {
            if (!text(body.text)) return fail('Write the change request before converting the discussion.');
            if (thread.snapshotId !== options.getSnapshotId()) return fail('The reviewed snapshot changed. Return to the original view before requesting this change.', 409);
            thread.annotation = { ...thread.anchor, id: `discussion-${thread.id}`, type: 'comment', text: body.text, createdAt: Date.now() };
            thread.conversionSaved = false;
            thread.status = 'converted';
          } else if (body.action === 'resolve') thread.status = 'resolved';
          else {
            if (thread.status !== 'resolved') return fail('Only resolved discussions can be reopened.', 409);
            thread.status = 'answered';
          }
          thread.updatedAt = Date.now();
          persist();
          cancel(thread.id);
        } else return fail('Method not allowed', 405);
        const result = snapshot().threads.find(t => t.id === thread.id)!;
        return Response.json({ thread: result, ...(result.annotation ? { annotation: result.annotation } : {}) });
      } catch (error) {
        return fail(error instanceof Error ? error.message : 'Could not save the discussion.', 500);
      }
    },
  };
}
