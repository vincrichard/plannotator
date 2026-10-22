import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { ForkParent } from './read-only-fork';

const exec = promisify(execFile);
const STARTUP_TIMEOUT_MS = 2 * 60_000;
const READ_PERMISSIONS = [
  { action: '*', resource: '*', effect: 'deny' },
  ...['read', 'glob', 'grep'].map(action => ({ action, resource: '*', effect: 'allow' })),
];
type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OpenCode returned an invalid API response');
  return value as JsonObject;
}

/** Native OpenCode 2 API; owns its fork, never the shared server or parent execution. */
export async function opencodeAnswer(parent: ForkParent, sessionId: string | undefined, prompt: string, signal: AbortSignal,
  remember: (id: unknown) => string, executable = 'opencode', onActivity?: () => void): Promise<string> {
  const api = async (method: string, path: string, body?: object, requestSignal: AbortSignal | null = signal): Promise<JsonObject> => {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new Error('OpenCode API request timed out after 2 minutes')), STARTUP_TIMEOUT_MS);
    const combined = requestSignal ? AbortSignal.any([requestSignal, timeout.signal]) : timeout.signal;
    try {
      const { stdout } = await exec(executable, ['api', method, path, ...(body ? ['--data', JSON.stringify(body)] : [])], {
        cwd: parent.cwd, signal: combined, maxBuffer: 4 * 1024 * 1024,
      });
      if (!stdout.trim()) return {};
      const result = object(JSON.parse(stdout));
      if (typeof result._tag === 'string') throw new Error(typeof result.message === 'string' ? result.message : result._tag);
      return result;
    } catch (error) {
      combined.throwIfAborted();
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new Error(`OpenCode request failed: ${stderr || (error instanceof Error ? error.message : String(error))}`);
    } finally { clearTimeout(timer); }
  };
  const checkFork = (data: JsonObject) => {
    if (object(data.fork).sessionID !== parent.sessionId) {
      throw new Error('OpenCode did not return a fork of the launching session');
    }
    return remember(data.id);
  };
  signal.throwIfAborted();
  const fork = sessionId
    ? object((await api('get', `/api/session/${sessionId}`)).data)
    : object((await api('post', `/api/session/${parent.sessionId}/fork`, {})).data);
  const id = checkFork(fork);
  const path = `/api/session/${id}`;
  onActivity?.();
  // Session rules take precedence over inherited/global permissions, with the last match winning.
  await api('patch', path, { permissions: READ_PERMISSIONS });
  const locked = object((await api('get', path)).data);
  checkFork(locked);
  if (JSON.stringify(locked.permissions) !== JSON.stringify(READ_PERMISSIONS)) {
    throw new Error('OpenCode did not apply the read-only fork permissions');
  }
  onActivity?.();
  const messages = async (cursor?: string) => {
    const query = cursor ? `cursor=${encodeURIComponent(cursor)}&limit=100` : 'order=desc&limit=100';
    const page = await api('get', `${path}/message?${query}`);
    if (!Array.isArray(page.data)) throw new Error('OpenCode returned invalid session messages');
    return { data: page.data.map(object), next: object(page.cursor).next };
  };
  const baseline = (await messages()).data[0]?.id;
  let admitted = false;
  let completed = false;
  try {
    signal.throwIfAborted();
    // Finish admission even on cancellation so interrupt cannot race a prompt still being accepted.
    admitted = true;
    const question = object((await api('post', `${path}/prompt`, { text: prompt }, null)).data);
    if (typeof question.id !== 'string' || !/^msg_[a-zA-Z0-9_-]+$/.test(question.id) || question.sessionID !== id) {
      throw new Error('OpenCode returned an invalid question identity');
    }
    signal.throwIfAborted();
    onActivity?.();
    let previous = '';
    while (true) {
      const current: JsonObject[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let found = false;
      do {
        const page = await messages(cursor);
        for (const message of page.data) {
          if (message.id === question.id) { found = true; break; }
          if (message.id === baseline) break;
          current.push(message);
        }
        if (found || page.data.some(message => message.id === baseline)) break;
        cursor = typeof page.next === 'string' && page.next ? page.next : undefined;
        if (cursor && cursors.has(cursor)) throw new Error('OpenCode returned a repeated message cursor');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      signal.throwIfAborted();
      if (found) {
        const fingerprint = JSON.stringify(current);
        if (fingerprint !== previous) { previous = fingerprint; onActivity?.(); }
        if (current.some(message => message.type === 'user')) throw new Error('OpenCode fork received another question while answering');
        const idle = current.find(message => message.type === 'idle');
        if (idle) {
          if (idle.outcome !== 'succeeded') {
            throw new Error(typeof object(idle.error ?? {}).message === 'string' ? String(object(idle.error).message) : 'OpenCode answer did not complete');
          }
          const answer = current.find(message => message.type === 'assistant');
          if (!answer || answer.finish !== 'stop' || typeof object(answer.time).completed !== 'number' || answer.error || !Array.isArray(answer.content)) {
            throw new Error('OpenCode completed without a final answer');
          }
          const text = answer.content.map(object).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
          if (!text.trim()) throw new Error('OpenCode completed without a final answer');
          completed = true;
          return text;
        }
      }
      await delay(1000, undefined, { signal });
    }
  } finally {
    if (admitted && !completed) {
      // Interrupt only the verified child, including on transport failure; keep it for follow-ups.
      await api('post', `${path}/interrupt`, {}, null).catch(() => {});
    }
  }
}
