/**
 * Same-cwd commit:<sha> switches must not echo a gitContext — dual-runtime
 * (Bun + Pi).
 *
 * Failure caught: /api/diff/switch answering a Commits-rail click with the
 * launch-frozen session context. The client merges `gitContext` from every
 * switch response unconditionally, so echoing the frozen one reverts the base
 * picker and the commit-baseline list to launch-time data (a commit made
 * mid-session disappears until the next non-commit switch; a worktree review
 * repoints at the main repo). The recompute is deliberately skipped on that
 * hot path, so the correct response carries no `gitContext` at all — the
 * client keeps what it has. Regressed in 0.27.14-dev (#1497), caught by QA.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReviewServer as startBunReviewServer } from "./review";
import { startReviewServer as startPiReviewServer } from "../../apps/pi-extension/server";
import { getVcsContext, runVcsDiff } from "./vcs";
import { captureReviewTurn, readReviewTurn } from "../shared/review-turn";

const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
const originalPort = process.env.PLANNOTATOR_PORT;
const originalSession = process.env.PLANNOTATOR_DISCUSSION_SESSION_ID;
const tempDirs: string[] = [];

const RUNTIMES = [
  ["Bun", startBunReviewServer],
  ["Pi", startPiReviewServer],
] as const;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function initRepo(): string {
  const repoDir = makeTempDir("plannotator-commit-switch-repo-");
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["branch", "-M", "main"]);
  git(repoDir, ["config", "user.email", "test@example.com"]);
  git(repoDir, ["config", "user.name", "Test"]);
  writeFileSync(join(repoDir, "README.md"), "# repo\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-q", "-m", "initial"]);
  writeFileSync(join(repoDir, "a.txt"), "a\n");
  git(repoDir, ["add", "a.txt"]);
  git(repoDir, ["commit", "-q", "-m", "second"]);
  return repoDir;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

type SwitchResponse = {
  diffType?: string;
  rawPatch?: string;
  gitContext?: { recentCommits?: Array<{ hash?: string; sha?: string; subject?: string; message?: string }> };
};

async function switchDiff(url: string, body: Record<string, unknown>): Promise<SwitchResponse> {
  return (await fetch(`${url}/api/diff/switch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json())) as SwitchResponse;
}

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
  if (originalPort === undefined) delete process.env.PLANNOTATOR_PORT;
  else process.env.PLANNOTATOR_PORT = originalPort;
  if (originalSession === undefined) delete process.env.PLANNOTATOR_DISCUSSION_SESSION_ID;
  else process.env.PLANNOTATOR_DISCUSSION_SESSION_ID = originalSession;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("same-cwd commit switch keeps the client's git context", () => {
  for (const [runtime, startServer] of RUNTIMES) {
    test(`${runtime}: failed ready callback releases turn pins and closes its server`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-turn-pin-failure-");
      process.env.PLANNOTATOR_PORT = String(await reservePort());
      const session = '12345678-1234-1234-1234-123456789abc';
      process.env.PLANNOTATOR_DISCUSSION_SESSION_ID = session;
      const repoDir = initRepo();
      await captureReviewTurn('start', repoDir, session, 'turn');
      writeFileSync(join(repoDir, 'a.txt'), 'turn edit\n');
      await captureReviewTurn('stop', repoDir, session, 'turn');
      const gitContext = await getVcsContext(repoDir, 'git');
      const diff = await runVcsDiff('uncommitted', 'main', repoDir);
      let url = '';
      await expect(startServer({ rawPatch: diff.patch, gitRef: diff.label,
        diffType: 'uncommitted', gitContext, htmlContent: '<html>review</html>',
        onReady: async readyUrl => {
          url = readyUrl;
          expect(git(repoDir, ['for-each-ref', '--format=%(refname)', 'refs/plannotator/reviews'])).not.toBe('');
          throw new Error('ready failed');
        },
      })).rejects.toThrow('ready failed');
      expect(git(repoDir, ['for-each-ref', '--format=%(refname)', 'refs/plannotator/reviews'])).toBe('');
      await expect(fetch(`${url}/api/diff`)).rejects.toThrow();
    }, 20_000);

    test(`${runtime}: offered last-turn snapshots survive later turns and GC until the review stops`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-turn-pins-data-");
      process.env.PLANNOTATOR_PORT = String(await reservePort());
      const session = '12345678-1234-1234-1234-123456789abc';
      process.env.PLANNOTATOR_DISCUSSION_SESSION_ID = session;
      const repoDir = initRepo();
      const turn = async (n: number) => {
        await captureReviewTurn('start', repoDir, session, `turn-${n}`);
        writeFileSync(join(repoDir, 'a.txt'), `turn ${n}\n`);
        await captureReviewTurn('stop', repoDir, session, `turn-${n}`);
        return (await readReviewTurn(repoDir, session))!;
      };
      const first = await turn(1);
      const gitContext = await getVcsContext(repoDir, 'git');
      const diff = await runVcsDiff('uncommitted', 'main', repoDir);
      const server = await startServer({ rawPatch: diff.patch, gitRef: diff.label,
        diffType: 'uncommitted', gitContext, htmlContent: '<html>review</html>' });
      try {
        const second = await turn(2);
        await switchDiff(server.url, { diffType: 'uncommitted' });
        for (let n = 3; n <= 5; n++) await turn(n);
        git(repoDir, ['reflog', 'expire', '--expire=now', '--all']);
        git(repoDir, ['gc', '--prune=now']);
        expect((await switchDiff(server.url, { diffType: `commit:${first}` })).rawPatch).toContain('+turn 1');
        expect((await switchDiff(server.url, { diffType: `commit:${second}` })).rawPatch).toContain('+turn 2');
        expect(git(repoDir, ['for-each-ref', '--format=%(refname)', 'refs/plannotator/reviews'])).not.toBe('');
      } finally { server.stop(); }
      expect(git(repoDir, ['for-each-ref', '--format=%(refname)', 'refs/plannotator/reviews'])).toBe('');
    }, 20_000);

    test(`${runtime}: commit:<sha> switch omits gitContext; a recomputing switch still carries it`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir("plannotator-commit-switch-data-");
      if (runtime === "Pi") process.env.PLANNOTATOR_PORT = String(await reservePort());
      const repoDir = initRepo();
      const gitContext = await getVcsContext(repoDir, "git");
      const diff = await runVcsDiff("uncommitted", "main", repoDir);

      const server = await startServer({
        rawPatch: diff.patch,
        gitRef: diff.label,
        error: diff.error,
        diffType: "uncommitted",
        gitContext,
        origin: runtime === "Pi" ? "pi" : "claude-code",
        htmlContent: "<!doctype html><html><body>review</body></html>",
      });
      try {
        // A commit made mid-session: the launch-frozen context cannot know it.
        writeFileSync(join(repoDir, "b.txt"), "b\n");
        git(repoDir, ["add", "b.txt"]);
        git(repoDir, ["commit", "-q", "-m", "mid-session"]);
        const midSha = git(repoDir, ["rev-parse", "HEAD"]);

        // Control: a non-commit switch recomputes and delivers a fresh context
        // that includes the new commit. Proves the emit path still works.
        const control = await switchDiff(server.url, { diffType: "uncommitted" });
        expect(control.gitContext).toBeDefined();
        const subjects = JSON.stringify(control.gitContext?.recentCommits ?? []);
        expect(subjects).toContain("mid-session");

        // The regression: a same-cwd commit switch skips the recompute, so the
        // response must carry NO gitContext (not the launch-frozen one).
        const switched = await switchDiff(server.url, { diffType: `commit:${midSha}` });
        expect(switched.diffType).toBe(`commit:${midSha}`);
        expect("gitContext" in switched).toBe(false);
      } finally {
        await fetch(`${server.url}/api/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approved: false, feedback: "done", annotations: [] }),
        });
        await server.waitForDecision();
        server.stop();
      }
    }, 20_000);
  }
});
