import type { ReadOnlyFork } from '@plannotator/shared/read-only-fork';
import { spawn } from 'node:child_process';
import { CodexAppServerProcess, type RpcMessage } from '../ai/providers/codex-app-server';
import { guardChildStreams, writeChildLine } from '../ai/providers/child-io';
import { killWindowsProcessTree } from '../ai/providers/command-path';

export interface ForkParent {
  provider: 'codex' | 'claude';
  sessionId: string;
  cwd: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STARTUP_TIMEOUT_MS = 2 * 60_000;

/** Never pick the most recent session: it can belong to another review. */
export function discoverForkParent(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ForkParent | null {
  let provider = env.PLANNOTATOR_DISCUSSION_PROVIDER;
  let sessionId = env.PLANNOTATOR_DISCUSSION_SESSION_ID;
  if (provider === undefined && sessionId === undefined) {
    const claudeTag = env.PLANNOTATOR_SESSION_TAG?.match(/^claude-code:(.+)$/)?.[1];
    if (claudeTag || env.CLAUDE_CODE_SESSION_ID) {
      provider = 'claude';
      sessionId = claudeTag || env.CLAUDE_CODE_SESSION_ID;
    } else if (env.CODEX_THREAD_ID) {
      provider = 'codex';
      sessionId = env.CODEX_THREAD_ID;
    }
  }
  return (provider === 'codex' || provider === 'claude') && sessionId && UUID.test(sessionId)
    ? { provider, sessionId, cwd } : null;
}

export interface ReadOnlyForkOptions {
  /** Server-owned task instructions; each caller supplies its own task. */
  instructions: string;
  sessionId?: string;
  onSessionId?: (sessionId: string) => void;
  /** Overrides are server-owned, never accepted from the browser. */
  executablePath?: string;
}

export function createReadOnlyFork(parent: ForkParent, options: ReadOnlyForkOptions): ReadOnlyFork {
  if (!UUID.test(parent.sessionId) || (options.sessionId && (!UUID.test(options.sessionId) || options.sessionId === parent.sessionId))) {
    throw new Error('Invalid discussion fork identity');
  }
  let sessionId = options.sessionId;
  let active: AbortController | null = null;
  let disposed = false;
  const remember = (id: unknown) => {
    if (typeof id !== 'string' || !UUID.test(id) || id === parent.sessionId || (sessionId && sessionId !== id)) {
      throw new Error('Agent did not return the expected separate discussion fork');
    }
    if (!sessionId) {
      sessionId = id;
      options.onSessionId?.(id);
    }
    return id;
  };
  return {
    async answer(prompt, signal, onActivity) {
      if (disposed) throw new Error('Discussion is closed');
      if (active) throw new Error('An answer is already running');
      signal.throwIfAborted();
      active = new AbortController();
      const controller = active;
      const abort = () => controller.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      try {
        const text = parent.provider === 'codex'
          ? await codexAnswer(parent, sessionId, `${options.instructions}\n\n${prompt}`, controller.signal, remember, options.executablePath, onActivity)
          : await claudeAnswer(parent, sessionId, `${options.instructions}\n\n${prompt}`, controller.signal, remember, options.executablePath, onActivity);
        controller.signal.throwIfAborted();
        if (!sessionId || !text.trim()) throw new Error('Agent completed without a final answer');
        return { sessionId, text };
      } catch (error) {
        controller.signal.throwIfAborted();
        throw error;
      } finally {
        signal.removeEventListener('abort', abort);
        active = null;
      }
    },
    dispose() {
      disposed = true;
      active?.abort(new Error('Discussion closed'));
    },
  };
}

async function codexAnswer(parent: ForkParent, sessionId: string | undefined, prompt: string, signal: AbortSignal,
  remember: (id: unknown) => string, executable = 'codex', onActivity?: () => void): Promise<string> {
  const proc = new CodexAppServerProcess();
  const abort = () => proc.kill();
  signal.addEventListener('abort', abort, { once: true });
  try {
    await proc.start(executable, parent.cwd, STARTUP_TIMEOUT_MS,
      ['hooks', 'apps', 'plugins', 'multi_agent'].flatMap(feature => ['-c', `features.${feature}=false`]));
    signal.throwIfAborted();
    onActivity?.();
    const { config } = await proc.sendAndWait({ method: 'config/read', params: { cwd: parent.cwd } }, STARTUP_TIMEOUT_MS);
    onActivity?.();
    const servers = (config as RpcMessage)?.mcp_servers as RpcMessage | undefined;
    const overrides = { mcp_servers: Object.fromEntries(Object.entries(servers ?? {})
      .map(([name]) => [name, { enabled: false }])) };
    const result = await proc.sendAndWait({
      method: sessionId ? 'thread/resume' : 'thread/fork',
      params: { threadId: sessionId ?? parent.sessionId, cwd: parent.cwd, sandbox: 'read-only', approvalPolicy: 'never',
        config: overrides, excludeTurns: true },
    }, STARTUP_TIMEOUT_MS);
    const id = remember((result.thread as RpcMessage)?.id);
    onActivity?.();
    signal.throwIfAborted();
    return await new Promise<string>((resolve, reject) => {
      let finalText = '';
      let lastLegacyText = '';
      let turnId: string | undefined;
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        unsubscribe();
        unrequest();
        signal.removeEventListener('abort', cancelled);
        if (error) reject(error); else resolve(finalText || lastLegacyText);
      };
      const cancelled = () => finish(new Error('Answer cancelled'));
      const unsubscribe = proc.onEvent(({ method, params }) => {
        if (params.threadId && params.threadId !== id) return;
        if (turnId && params.turnId && params.turnId !== turnId) return;
        if (method.startsWith('item/') || method.startsWith('turn/') || (method === 'error' && params.willRetry === true)) onActivity?.();
        if (method === 'item/completed') {
          const item = params.item as RpcMessage;
          if (item?.type === 'agentMessage' && typeof item.text === 'string') {
            if (item.phase === 'final_answer') finalText = item.text;
            else if (!item.phase) lastLegacyText = item.text;
          }
        } else if (method === 'turn/completed') {
          const turn = params.turn as RpcMessage;
          if (turnId && turn?.id !== turnId) return;
          finish(turn?.status === 'completed' ? undefined : new Error((turn?.error as RpcMessage)?.message as string || 'Agent turn did not complete'));
        } else if (method === 'process_exited') finish(new Error(typeof params.message === 'string' ? params.message : 'Codex exited before answering'));
        else if (method === 'error' && params.willRetry !== true) finish(new Error((params.error as RpcMessage)?.message as string || 'Codex failed'));
      });
      const unrequest = proc.onRequest((method, requestId) => {
        if (method === 'item/permissions/requestApproval') proc.respond(requestId, { permissions: {}, scope: 'turn' });
        else if (method.endsWith('/requestApproval')) proc.respond(requestId, { decision: 'decline' });
        else proc.respondError(requestId, 'Discussion tools cannot request input or additional permissions');
      });
      signal.addEventListener('abort', cancelled, { once: true });
      proc.sendAndWait({ method: 'turn/start', params: { threadId: id, approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false }, input: [{ type: 'text', text: prompt, text_elements: [] }] } }, STARTUP_TIMEOUT_MS)
        .then(result => { turnId = (result.turn as RpcMessage)?.id as string; if (!finished) onActivity?.(); }, error => finish(error));
    });
  } finally {
    signal.removeEventListener('abort', abort);
    proc.kill();
  }
}

async function claudeAnswer(parent: ForkParent, sessionId: string | undefined, prompt: string, signal: AbortSignal,
  remember: (id: unknown) => string, executable = 'claude', onActivity?: () => void): Promise<string> {
  const args = ['--print', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--resume', sessionId ?? parent.sessionId,
    ...(!sessionId ? ['--fork-session'] : []), '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep',
    '--permission-mode', 'dontAsk', '--setting-sources', '', '--settings', '{"disableAllHooks":true}',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands'];
  const env = { ...process.env };
  delete env.CLAUDECODE;
  const child = spawn(executable, args, { cwd: parent.cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
  return await new Promise<string>((resolve, reject) => {
    let buffer = '';
    let answer: string | undefined;
    let failure: Error | undefined;
    const kill = () => { if (!killWindowsProcessTree(child.pid)) child.kill('SIGKILL'); };
    const fail = (error: Error) => { failure ??= error; kill(); };
    const startupTimer = setTimeout(() => fail(new Error('Claude did not initialize its discussion session within 2 minutes')), STARTUP_TIMEOUT_MS);
    startupTimer.unref?.();
    const abort = () => fail(new Error('Answer cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    guardChildStreams(child, 'Claude discussion', fail);
    child.on('error', error => { clearTimeout(startupTimer); signal.removeEventListener('abort', abort); reject(error); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) { fail(new Error('Claude response exceeded the output limit')); return; }
      let boundary: number;
      while ((boundary = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'system' && event.subtype === 'init') { remember(event.session_id); clearTimeout(startupTimer); }
          if (['system', 'assistant', 'user', 'stream_event', 'result'].includes(event.type)) onActivity?.();
          if (event.type === 'result') {
            remember(event.session_id);
            if (event.is_error || event.subtype !== 'success') throw new Error(event.errors?.join('\n') || 'Claude did not complete its answer');
            if (typeof event.result === 'string') answer = event.result;
          }
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      }
    });
    child.on('close', code => {
      clearTimeout(startupTimer);
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Claude exited with status ${code}; check CLI authentication and session availability`));
      else if (answer === undefined) reject(new Error('Claude completed without a final answer'));
      else resolve(answer);
    });
    const writeError = writeChildLine(child, prompt, 'Claude discussion', fail);
    if (writeError) fail(writeError);
    child.stdin.end();
    if (signal.aborted) abort();
  });
}
