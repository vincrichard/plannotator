/** Real desktop review, isolated repository/data directory; never opens or replaces a user's session. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? '.local/plannotator');
const proofDir = resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? '.local/proof/references');
const definition = ':1 export function widget(value: number) {';
const otherReference = ':2 export const next = widget(2);';

async function review(page: Page, staged = false) {
  const root = mkdtempSync(join(tmpdir(), 'plannotator-references-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', repo, ...args], {
      encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    expect(result.status, result.stderr).toBe(0);
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Reference test');
  git('config', 'user.email', 'reference@example.invalid');
  writeFileSync(join(repo, 'a-main.ts'), "import { widget } from './helper';\nexport const main = widget(0);\n");
  writeFileSync(join(repo, 'b-other.ts'), "import { widget } from './helper';\nexport const previous = widget(1);\n");
  writeFileSync(join(repo, 'helper.ts'), 'export function widget(value: number) {\n  return value * 2;\n}\n');
  const distant = "import { widget } from './helper';\nexport const setting = 1;\n" +
    Array.from({ length: 60 }, (_, i) => `// context ${i}\n`).join('') + 'export const distant = widget(4);\n';
  writeFileSync(join(repo, 'c-distant.ts'), distant);
  git('add', '.');
  git('commit', '-m', 'base');
  writeFileSync(join(repo, 'c-distant.ts'), distant.replace('setting = 1', 'setting = 2'));
  writeFileSync(join(repo, 'a-main.ts'), "import { widget } from './helper';\nexport const main = widget(10);\n");
  writeFileSync(join(repo, 'b-other.ts'), "import { widget } from './helper';\nexport const next = widget(2);\nexport const extra = widget(3);\n");
  if (staged) {
    git('add', '.');
    // rg sees this working tree; comments must use the index's original coordinates/content.
    writeFileSync(join(repo, 'helper.ts'), '// working tree only\nexport function widget(value: number) {\n  return value * 99;\n}\n');
    writeFileSync(join(repo, 'b-other.ts'), "import { widget } from './helper';\nexport const workingOnly = widget(99);\n");
  }
  const ready = join(root, 'ready.jsonl');
  const child: ChildProcess = spawn(binary, ['review', repo, '--git', '--diff-type', staged ? 'staged' : 'uncommitted', '--no-git-remote-check', '--json'], {
    env: {
      PATH: process.env.PATH,
      PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_READY_FILE: ready,
      PLANNOTATOR_SKIP_BROWSER_OPEN: '1', PLANNOTATOR_REMOTE: '0', PLANNOTATOR_PORT: '0',
      PLANNOTATOR_AI: 'disabled', PLANNOTATOR_SHARE: 'disabled', PLANNOTATOR_UPDATE_CHECK: '0',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout!.on('data', data => { stdout += data; });
  child.stderr!.on('data', data => { stderr += data; });
  try {
    await expect.poll(() => existsSync(ready) ? readFileSync(ready, 'utf8') : stderr, { timeout: 30_000 }).toContain('"url"');
    const url = JSON.parse(readFileSync(ready, 'utf8').trim().split('\n')[0]).url;
    await page.context().addCookies([
      ['plannotator-plan-look-choice-resolved', 'true'], ['plannotator-guide-intro-seen', '2'],
      ['plannotator-edit-mode-announcement-seen', '3'], ['plannotator-token-hover-announcement-seen', '1'],
      ['plannotator-announce-tui-herdr-seen', '1'], ['plannotator-announce-ask-session-seen', '1'],
      ['plannotator-announce-agent-tool-seen', '1'],
    ].map(([name, value]) => ({ name, value, url })));
    await page.goto(url);
    await expect(page.locator('diffs-container').first().locator('[data-line="2"]').first()).toBeVisible();
    return {
      repo, url, output: () => stdout,
      async close() {
        if (child.exitCode === null) child.kill('SIGTERM'); // This test's own review child.
        await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    child.kill('SIGTERM'); // This test's own review child.
    throw error;
  }
}

async function openReferences(page: Page) {
  const token = page.locator('diffs-container').first().locator('[data-additions] [data-line="2"] [data-char]').filter({ hasText: /^widget$/ });
  await token.click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByLabel('Symbol locations').getByRole('heading', { name: 'Definitions', exact: true })).toBeVisible();
}

async function choose(page: Page, name: string) {
  await page.getByLabel('Symbol locations').getByRole('button', { name, exact: true }).click();
}

async function selectLine(page: Page, viewer: Locator, line: number, side: 'additions' | 'deletions' | 'unified') {
  // Clear Pierre's previous selection before choosing another range, as a reader does by clicking the code.
  const column = viewer.locator(`[data-${side}]`);
  await column.locator(`[data-line="${line}"]`).click();
  await column.locator(`[data-column-number="${line}"]`).last().click();
  if (!await page.getByPlaceholder('Leave feedback...').isVisible()) {
    await column.locator(`[data-column-number="${line}"]`).last().hover();
    await column.locator(`[data-column-number="${line}"] [data-utility-button]`).click();
  }
  await expect(page.getByPlaceholder('Leave feedback...')).toBeVisible();
}

async function selectAddedRange(page: Page, viewer: Locator, start: number, end: number) {
  const column = viewer.locator('[data-additions]');
  await expect(column.locator(`[data-column-number="${start}"]`)).toBeVisible();
  await expect(column.locator(`[data-column-number="${end}"]`)).toBeVisible();
  const from = await column.locator(`[data-column-number="${start}"]`).boundingBox();
  const to = await column.locator(`[data-column-number="${end}"]`).boundingBox();
  expect(from).not.toBeNull();
  expect(to).not.toBeNull();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.getByPlaceholder('Leave feedback...')).toBeVisible();
}

async function comment(page: Page, text: string) {
  await page.getByPlaceholder('Leave feedback...').fill(text);
  await page.getByRole('button', { name: 'Add Comment', exact: true }).click();
}

async function annotations(page: Page) {
  return page.evaluate(async () => (await (await fetch('/api/draft')).json()).codeAnnotations ?? []);
}

test.use({ viewport: { width: 1600, height: 1000 }, actionTimeout: 15_000, screenshot: 'only-on-failure' });
test.beforeAll(() => mkdirSync(proofDir, { recursive: true }));

test('references use review diffs, keep per-file drafts, and persist/export old and new comments', async ({ page }) => {
  const session = await review(page);
  try {
    await openReferences(page);
    const side = page.locator('[data-reference-file]');
    await expect(side).toHaveAttribute('data-reference-file', 'helper.ts');
    await expect(side.locator('[data-line-type="change-addition"], [data-line-type="change-deletion"]')).toHaveCount(0);
    await selectLine(page, side, 2, 'unified');
    await page.getByPlaceholder('Leave feedback...').fill('pending helper draft');
    await choose(page, otherReference);
    await expect(side.locator('[data-deletions] [data-line="2"]')).toHaveText('export const previous = widget(1);');
    await expect(side.locator('[data-additions] [data-line="3"]')).toHaveText('export const extra = widget(3);');
    await choose(page, definition);
    await selectLine(page, side, 2, 'unified');
    await expect(page.getByPlaceholder('Leave feedback...')).toHaveValue('pending helper draft');
    await comment(page, 'unchanged reference');
    await choose(page, ':63 export const distant = widget(4);');
    await expect(side.locator('[data-additions] [data-line="63"]')).toBeInViewport();
    await expect(side.locator('[data-additions] [data-line="63"]')).toHaveAttribute('data-selected-line', /.+/);
    await expect(side.locator('[data-deletions] [data-line="2"]')).toHaveText('export const setting = 1;');

    // A pending main-view comment must survive comments in a different side-view file.
    const main = page.locator('diffs-container').first();
    await selectLine(page, main, 2, 'additions');
    await page.getByPlaceholder('Leave feedback...').fill('pending main draft');
    await choose(page, otherReference);
    await selectLine(page, side, 2, 'deletions');
    await comment(page, 'removed reference');
    await selectAddedRange(page, side, 2, 3);
    await comment(page, 'added reference');
    await selectLine(page, main, 2, 'additions');
    await expect(page.getByPlaceholder('Leave feedback...')).toHaveValue('pending main draft');
    await comment(page, 'main comment');

    await expect.poll(() => annotations(page)).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: 'helper.ts', lineStart: 2, lineEnd: 2, side: 'new', text: 'unchanged reference' }),
      expect.objectContaining({ filePath: 'b-other.ts', lineStart: 2, lineEnd: 2, side: 'old', text: 'removed reference' }),
      expect.objectContaining({ filePath: 'b-other.ts', lineStart: 2, lineEnd: 3, side: 'new', text: 'added reference' }),
      expect.objectContaining({ filePath: 'a-main.ts', lineStart: 2, lineEnd: 2, side: 'new', text: 'main comment' }),
    ]));
    await page.screenshot({ path: join(proofDir, 'changed-reference-comments.png') });
    await page.reload();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.getByTitle('Annotations', { exact: true }).click();
    await page.getByText('unchanged reference', { exact: true }).click();
    await expect(side).toHaveAttribute('data-reference-file', 'helper.ts');
    await expect(side.getByText('unchanged reference', { exact: true })).toBeVisible();
    await page.screenshot({ path: join(proofDir, 'unchanged-reference-restored.png') });

    const sent = page.waitForRequest(request => request.url().endsWith('/api/feedback') && request.method() === 'POST');
    await page.getByRole('button', { name: 'Send Feedback' }).click();
    const payload = (await sent).postDataJSON();
    expect(payload.annotations).toHaveLength(4);
    expect(payload.feedback).toContain('helper.ts');
    expect(payload.feedback).toContain('removed reference');
    expect(payload.feedback).toContain('added reference');
    writeFileSync(join(proofDir, 'feedback.json'), JSON.stringify(payload, null, 2));
    await expect.poll(session.output).toContain('unchanged reference');
  } finally { await session.close(); }
});

test('working-tree search locations are checked against staged contents, without guessed jumps', async ({ page }) => {
  const session = await review(page, true);
  try {
    await openReferences(page);
    const side = page.locator('[data-reference-file]');
    await expect(side.locator('[data-line="2"]')).toHaveText('  return value * 2;');
    await expect(side.locator('[data-line="1"]')).toHaveAttribute('data-selected-line', /.+/);
    await choose(page, ':2 export const workingOnly = widget(99);');
    await expect(side.getByRole('status')).toContainText('could not be located unambiguously');
    await expect(side.locator('[data-additions] [data-line="2"]')).toHaveText('export const next = widget(2);');
    await expect(side.locator('[data-deletions] [data-line="2"]')).toHaveText('export const previous = widget(1);');
    await selectLine(page, side, 2, 'additions');
    await comment(page, 'reviewed index line');
    await expect.poll(() => annotations(page)).toEqual([expect.objectContaining({ filePath: 'b-other.ts', lineStart: 2, side: 'new' })]);
    await page.screenshot({ path: join(proofDir, 'staged-snapshot.png') });
  } finally { await session.close(); }
});
