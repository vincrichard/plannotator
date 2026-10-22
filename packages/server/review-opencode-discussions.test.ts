import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReviewServer } from './review';

test('embedded OpenCode reviews use their explicit parent and fail closed without one', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'plannotator-opencode-discussion-'));
  const before = { ...process.env };
  try {
    process.env.PLANNOTATOR_DATA_DIR = cwd;
    process.env.PLANNOTATOR_REMOTE = '0';
    process.env.PLANNOTATOR_DISCUSSION_PROVIDER = 'codex';
    process.env.PLANNOTATOR_DISCUSSION_SESSION_ID = '11111111-1111-4111-8111-111111111111';
    for (const sessionId of ['ses_launchingSession', '']) {
      const server = await startReviewServer({ rawPatch: '', gitRef: 'HEAD', htmlContent: '<html></html>',
        origin: 'opencode', agentCwd: cwd, opencodeSessionId: sessionId });
      try {
        const snapshot = await (await fetch(`${server.url}/api/review-discussions`)).json();
        expect(snapshot.supported).toBe(true);
        expect(snapshot.available).toBe(Boolean(sessionId));
        if (sessionId) expect(snapshot.provider).toBe('opencode');
        else {
          expect(snapshot.provider).toBeUndefined();
          expect(snapshot.reason).toContain('OpenCode');
        }
      } finally { server.stop(); }
    }
    expect(process.env.PLANNOTATOR_DISCUSSION_PROVIDER).toBe('codex');
  } finally {
    for (const key of ['PLANNOTATOR_DATA_DIR', 'PLANNOTATOR_REMOTE', 'PLANNOTATOR_DISCUSSION_PROVIDER', 'PLANNOTATOR_DISCUSSION_SESSION_ID']) {
      if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
    }
    rmSync(cwd, { recursive: true, force: true });
  }
}, 20_000);
