/** Real desktop review, isolated repository/data directory; never opens or replaces a user's session. */
import { chromium, firefox, webkit, expect, test, type Locator, type Page } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? '.local/plannotator');
const proofDir = resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? '.local/proof/references');
const definition = ':1 export function widget(value: number) {';
const otherReference = ':2 export const next = widget(2);';

async function review(page: Page, staged = false, contextLines = 60, addedReference = false, methods = false) {
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
    Array.from({ length: contextLines }, (_, i) => contextLines > 60 && i === 499 ? 'export const middle = widget(6);\n' : `// context ${i}\n`).join('') + 'export const distant = widget(4);\n' + (contextLines > 60 ? Array.from({ length: 400 }, (_, i) => `// tail ${i}\n`).join('') : '');
  writeFileSync(join(repo, 'c-distant.ts'), distant);
  const methodSource = '# before method\n'.repeat(20) + 'class Runner:\n    @staticmethod\n    def run(value):\n'
    + Array.from({ length: 240 }, (_, i) => `        v${i} = ${i}\n`).join('')
    + '        return value\n' + '# unrelated tail\n'.repeat(80);
  if (methods) writeFileSync(join(repo, 'methods.py'), methodSource);
  git('add', '.');
  git('commit', '-m', 'base');
  if (methods) writeFileSync(join(repo, 'methods.py'), methodSource.replace('v30 = 30', 'v30 = 300\n        added = 1').replace('v190 = 190', 'v190 = 1900'));
  writeFileSync(join(repo, 'c-distant.ts'), distant.replace('setting = 1', 'setting = 2').replace('widget(4)', contextLines > 60 ? 'widget(5)' : 'widget(4)'));
  writeFileSync(join(repo, 'a-main.ts'), "import { widget } from './helper';\nexport const main = widget(10);\n");
  writeFileSync(join(repo, 'b-other.ts'), "import { widget } from './helper';\nexport const next = widget(2);\nexport const extra = widget(3);\n");
  if (addedReference) {
    writeFileSync(join(repo, 'd-added.ts'), Array.from({ length: 1000 }, (_, i) =>
      i === 239 ? 'const result = widget(7);\n' : `export const row${i} = { name: 'cold reference row ${i}', value: ${i}, enabled: true };\n`).join(''));
    git('add', 'd-added.ts');
  }
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

for (const browserName of ['chromium', 'firefox'] as const) {
  test.describe(`reference scroll (${browserName})`, () => {
    test('keeps a distant reference visible after rendering and opening or closing a comment', async () => {
      const browser = await ({ chromium, firefox }[browserName]).launch();
      const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
      const session = await review(page, false, 600);
      try {
        await openReferences(page);
        const side = page.locator('[data-reference-file]');
        await choose(page, ':603 export const distant = widget(5);');
        await expect(side).toHaveAttribute('data-reference-file', 'c-distant.ts');
        const line = side.locator('[data-additions] [data-line="603"]');
        await expect(line).toHaveAttribute('data-selected-line', /.+/);
        // Full-file rendering can finish after the first successful scroll.
        await page.waitForTimeout(1000);
        await expect(line).toBeInViewport();
        await choose(page, ':502 export const middle = widget(6);');
        await expect(side.locator('[data-additions] [data-line="502"]')).toBeInViewport();
        await choose(page, ':603 export const distant = widget(5);');
        await expect(line).toBeInViewport();
        // Let the reference jump's smooth scroll finish before testing the composer.
        await page.waitForTimeout(1000);
        const top = await line.evaluate(el => el.getBoundingClientRect().top);
        await line.locator('[data-char]').filter({ hasText: /^widget$/ }).click();
        await expect(page.getByPlaceholder('Leave feedback...')).toBeVisible();
        await page.getByPlaceholder('Leave feedback...').fill('keep this draft in place');
        await expect.poll(() => line.evaluate(el => el.getBoundingClientRect().top)).toBeCloseTo(top, 0);
        await page.keyboard.press('Escape');
        await expect(page.getByPlaceholder('Leave feedback...')).toBeHidden();
        await expect.poll(() => line.evaluate(el => el.getBoundingClientRect().top)).toBeCloseTo(top, 0);
        await selectLine(page, side, 603, 'additions');
        await expect(page.getByPlaceholder('Leave feedback...')).toHaveValue('keep this draft in place');
      } finally { await session.close(); await browser.close(); }
    });
  });
}

// The real Mac WKWebView resets its shadow-DOM scroller natively during repaint.
// Simulate that zero-offset event here to guard recovery for its Safari-less UA;
// this is a deterministic guardian regression, not WebKit engine coverage.
test('recovers native scroll resets in embedded WebKit without affecting Chromium', async () => {
  const browser = await chromium.launch();
  try {
    for (const embeddedWebKit of [true, false]) {
      const page = await browser.newPage({
        viewport: { width: 1600, height: 1000 },
        ...(embeddedWebKit ? { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)' } : {}),
      });
      const session = await review(page, false, 600);
      try {
        if (embeddedWebKit) {
          await page.locator('diffs-container').first().locator('[data-additions] [data-line="2"] [data-char]').filter({ hasText: /^widget$/ }).click({ modifiers: ['Meta'] });
          await expect(page.getByLabel('Symbol locations')).toBeVisible();
        } else {
          await openReferences(page);
        }
        await choose(page, ':603 export const distant = widget(5);');
        const line = page.locator('[data-reference-file] [data-additions] [data-line="603"]');
        await expect(line).toBeInViewport();
        await page.waitForTimeout(1000);
        const result = await line.evaluate(el => {
          let viewport: Element | null = el;
          while (viewport && !(viewport.scrollHeight > viewport.clientHeight && getComputedStyle(viewport).overflowY === 'auto')) {
            viewport = viewport.parentElement ?? (viewport.getRootNode() as ShadowRoot).host ?? null;
          }
          if (!viewport) throw new Error('Reference scroll viewport missing');
          const before = viewport.scrollTop;
          viewport.scrollTop = 0;
          viewport.dispatchEvent(new Event('scroll'));
          return { before, after: viewport.scrollTop };
        });
        expect(result.before).toBeGreaterThan(200);
        expect(result.after).toBe(embeddedWebKit ? result.before : 0);
      } finally { await session.close(); await page.close(); }
    }
  } finally { await browser.close(); }
});

test('references take most of the dock and close shortcuts target the focused review tab', async ({ page }) => {
  const session = await review(page);
  try {
    await openReferences(page);
    const side = page.locator('[data-reference-file]');
    const panel = page.locator('.dv-groupview').filter({ has: side });
    const widthFraction = async () => {
      const bounds = await panel.boundingBox();
      const parent = await page.locator('.dv-dockview').boundingBox();
      return bounds!.width / parent!.width;
    };
    await expect.poll(widthFraction).toBeGreaterThan(0.65);
    await expect.poll(widthFraction).toBeLessThan(0.75);
    const codeBounds = await side.boundingBox();
    const listBounds = await page.getByLabel('Symbol locations').boundingBox();
    expect(listBounds!.x).toBeGreaterThanOrEqual(codeBounds!.x + codeBounds!.width - 1);
    expect(Math.abs(listBounds!.y - codeBounds!.y)).toBeLessThan(2);
    expect(codeBounds!.height).toBeGreaterThan(600);
    await page.screenshot({ path: join(proofDir, 'reference-focus.png') });
    await openReferences(page);
    await expect.poll(widthFraction).toBeGreaterThan(0.65);
    await selectLine(page, side, 2, 'unified');
    await page.getByPlaceholder('Leave feedback...').fill('w');
    await page.keyboard.press('w');
    await expect(side).toBeVisible();
    await expect(page.getByPlaceholder('Leave feedback...')).toHaveValue('ww');
    await page.keyboard.press('Escape');
    await page.getByLabel('Symbol locations').getByRole('heading', { name: 'Definitions', exact: true }).click();
    await page.keyboard.press('w');
    await expect(side).toHaveCount(0);
    await expect(page.locator('.dv-tab').filter({ hasText: 'All files' })).toBeVisible();
    await openReferences(page);
    await expect.poll(widthFraction).toBeGreaterThan(0.65);
    await page.locator('.dv-tab').filter({ hasText: 'All files' }).click();
    // Browser chrome may reserve this chord; verify the app handles it when delivered.
    const cancelled = await page.evaluate(() => !window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'w', code: 'KeyW', ctrlKey: true, bubbles: true, cancelable: true,
    })));
    expect(cancelled).toBe(true);
    await expect(page.locator('.dv-tab').filter({ hasText: 'All files' })).toHaveCount(0);
    await expect(side).toBeVisible();
    const metaCancelled = await page.evaluate(() => !window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'w', code: 'KeyW', metaKey: true, bubbles: true, cancelable: true,
    })));
    expect(metaCancelled).toBe(true);
    await expect(side).toHaveCount(0);
    expect((await page.request.get(`${session.url}/api/diff`)).ok()).toBe(true);
  } finally { await session.close(); }
});


test('WebKit reaches a cold added-file reference without a second click', async () => {
  const browser = await webkit.launch({ args: [] });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 650 } });
    const session = await review(page, false, 60, true);
    try {
      await openReferences(page);
      await expect(page.locator('[data-reference-file="helper.ts"] [data-line="1"]').first()).toBeVisible();
      await choose(page, ':240 const result = widget(7);');
      const side = page.locator('[data-reference-file="d-added.ts"]');
      // Let worker highlighting replace the initial rows; do not hover or scroll the code.
      await expect(side.locator('[data-line="240"] [data-char]').filter({ hasText: 'widget' })).toBeVisible();
      await page.waitForTimeout(1000);
      await expect.poll(() => side.locator('[data-line="240"]').first().evaluate(el => {
        const bounds = el.getRootNode() instanceof ShadowRoot
          ? (el.getRootNode() as ShadowRoot).host.closest('[data-reference-file]')?.getBoundingClientRect()
          : null;
        const line = el.getBoundingClientRect();
        return !!bounds && line.height > 0 && line.top >= bounds.top && line.bottom <= bounds.bottom;
      })).toBe(true);
    } finally { await session.close(); }
  } finally { await browser.close(); }
});


test('line jumps recover interrupted rendering and yield to manual scrolling', async ({ page }) => {
  const session = await review(page, false, 600);
  try {
    await openReferences(page);
    await choose(page, ':603 export const distant = widget(5);');
    const side = page.locator('[data-reference-file="c-distant.ts"]');
    const line = side.locator('[data-additions] [data-line="603"]');
    await expect(line).toBeInViewport();
    await page.waitForTimeout(1000);
    // Model the measured WebKit failure: row replacement interrupts a jump
    // at a nonzero offset. The older zero-reset guardian cannot recover it.
    const interrupt = () => line.evaluate(el => {
      let viewport: Element | null = el;
      while (viewport && getComputedStyle(viewport).overflowY !== 'auto') {
        viewport = viewport.parentElement ?? (viewport.getRootNode() as ShadowRoot).host ?? null;
      }
      if (!viewport) throw new Error('Reference viewport missing');
      el.replaceWith(el.cloneNode(true));
      viewport.scrollTop -= 900;
      viewport.dispatchEvent(new Event('scroll'));
    });
    await interrupt();
    await expect(line).toBeInViewport();
    const bounds = await side.boundingBox();
    await page.mouse.move(bounds!.x + 100, bounds!.y + 100);
    await page.mouse.wheel(0, -900);
    await expect(line).not.toBeInViewport();
    await interrupt();
    await page.waitForTimeout(300);
    await expect(line).not.toBeInViewport();
  } finally { await session.close(); }
});


test('reference history restores nested lookups and preserves a manually resized dock', async ({ page }) => {
  const session = await review(page);
  try {
    await openReferences(page);
    const side = page.locator('[data-reference-file]');
    const group = page.locator('.dv-groupview').filter({ has: side });
    const before = (await group.boundingBox())!;
    await page.mouse.move(before.x - 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + 180, before.y + before.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await group.boundingBox())!.width).toBeLessThan(before.width - 100);
    const resized = (await group.boundingBox())!.width;
    await choose(page, otherReference);
    await side.locator('[data-additions] [data-line="2"] [data-char]').filter({ hasText: /^next$/ }).click({ modifiers: ['ControlOrMeta'] });
    await expect(page.locator('.dv-tab').filter({ hasText: 'References: next' })).toBeVisible();
    await expect(page.getByLabel('Symbol locations').getByRole('heading', { name: 'Definitions', exact: true })).toBeVisible();
    // Meta and Control, including the shifted '_' emitted by Mac keyboards.
    const jump = async (forward = false, meta = false) => {
      const handled = await page.evaluate(({ forward, meta }) => !window.dispatchEvent(new KeyboardEvent('keydown', {
        key: forward ? '_' : '-', code: 'Minus', metaKey: meta, ctrlKey: !meta,
        shiftKey: forward, bubbles: true, cancelable: true,
      })), { forward, meta });
      expect(handled).toBe(true);
    };
    await jump(false, true);
    await expect(page.locator('.dv-tab').filter({ hasText: 'References: widget' })).toBeVisible();
    await expect(side).toHaveAttribute('data-reference-file', 'b-other.ts');
    await page.keyboard.press('Control+-');
    await expect(side).toHaveAttribute('data-reference-file', 'helper.ts');
    await page.keyboard.press('Control+Shift+-');
    await expect(side).toHaveAttribute('data-reference-file', 'b-other.ts');
    await jump(true, true);
    await expect(page.locator('.dv-tab').filter({ hasText: 'References: next' })).toBeVisible();
    await jump();
    await choose(page, ':63 export const distant = widget(4);');
    await jump(true); // A new link discards the old forward branch, without browser zoom.
    await expect(side).toHaveAttribute('data-reference-file', 'c-distant.ts');
    await expect(side.locator('[data-additions] [data-line="63"]')).toBeInViewport();
    await page.locator('.dv-tab').filter({ hasText: 'All files' }).click();
    await openReferences(page);
    await expect(side).toHaveAttribute('data-reference-file', 'helper.ts');
    await expect.poll(async () => Math.abs((await group.boundingBox())!.width - resized)).toBeLessThan(3);
    await selectLine(page, side, 2, 'unified');
    await page.getByPlaceholder('Leave feedback...').fill('preserve navigation draft');
    await page.getByPlaceholder('Leave feedback...').dispatchEvent('keydown', { key: '-', code: 'Minus', metaKey: true });
    await expect(side).toHaveAttribute('data-reference-file', 'helper.ts');
    await expect(page.getByPlaceholder('Leave feedback...')).toHaveValue('preserve navigation draft');
    await page.keyboard.press('Escape');
    await jump();
    await expect(side).toHaveAttribute('data-reference-file', 'a-main.ts');
    await jump(true);
    await expect(side).toHaveAttribute('data-reference-file', 'helper.ts');
    await selectLine(page, side, 2, 'unified');
    await expect(page.getByPlaceholder('Leave feedback...')).toHaveValue('preserve navigation draft');
  } finally { await session.close(); }
});


test('back past the first reference closes its pane; forward restores width and pending comments', async ({ page }) => {
  const session = await review(page);
  try {
    await openReferences(page);
    const side = page.locator('[data-reference-file]');
    const group = page.locator('.dv-groupview').filter({ has: side });
    const before = (await group.boundingBox())!;
    await page.mouse.move(before.x - 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + 140, before.y + before.height / 2, { steps: 8 });
    await page.mouse.up();
    const width = (await group.boundingBox())!.width;
    await selectLine(page, side, 2, 'unified');
    await page.getByPlaceholder('Leave feedback...').fill('draft across history close');
    await page.keyboard.press('Escape');
    await page.getByLabel('Symbol locations').getByRole('heading', { name: 'Definitions', exact: true }).click();
    await page.keyboard.press('Control+-');
    await expect(side).toHaveCount(0);
    await expect(page.locator('.dv-active-group .dv-tab').filter({ hasText: 'All files' })).toBeVisible();
    await page.keyboard.press('Control+Shift+-');
    await expect(side).toHaveAttribute('data-reference-file', 'helper.ts');
    await expect.poll(async () => Math.abs((await group.boundingBox())!.width - width)).toBeLessThan(3);
    await selectLine(page, side, 2, 'unified');
    await expect(page.getByPlaceholder('Leave feedback...')).toHaveValue('draft across history close');
  } finally { await session.close(); }
});


test('one method control expands all its hunks in all-files and single-file views', async ({ page }) => {
  const session = await review(page, false, 60, false, true);
  try {
    // Bring the last file into the virtualized all-files window without changing the selected tab.
    const methodHeader = page.getByText('methods.py', { exact: true }).last();
    await methodHeader.scrollIntoViewIfNeeded();
    const viewer = page.locator('diffs-container').filter({ has: page.locator('[data-expand-method="Runner.run"]') });
    await expect(viewer).toHaveCount(1);
    await expect(viewer.locator('[data-expand-method]')).toHaveCount(1);
    await expect(viewer.locator('[data-expand-method]')).toHaveText('Expand Runner.run (244 lines)');
    await expect(viewer.locator('[data-additions] [data-line="23"]')).toHaveCount(0);
    await expect(viewer.locator('[data-expand-method]')).toBeVisible();
    await page.screenshot({ path: join(proofDir, 'method-context.png') });
    // Keep the whole expanded method in the virtualized window for line assertions.
    await page.setViewportSize({ width: 1600, height: 9000 });
    await viewer.locator('[data-expand-method]').click();
    // The signature, a previously hidden middle line and final body line are now present.
    await expect(page.locator('diffs-container [data-additions] [data-line="23"]').filter({ hasText: 'def run' })).toHaveCount(1);
    await expect(page.locator('diffs-container [data-additions] [data-line="150"]').filter({ hasText: 'v125' })).toHaveCount(1);
    await expect(page.locator('diffs-container [data-additions] [data-line="265"]').filter({ hasText: 'return value' })).toHaveCount(1);
    // The normal remaining-context controls still work and unrelated tail stays collapsed.
    await expect(page.locator('diffs-container [data-additions] [data-line="330"]')).toHaveCount(0);
    const expandedViewer = page.locator('diffs-container').filter({ has: page.locator('[data-additions] [data-line="265"]') });
    await selectLine(page, expandedViewer, 149, 'deletions');
    await comment(page, 'old method context');
    await page.getByRole('button', { name: /M methods.py/ }).click();
    await expect(page.locator('.dv-tab').filter({ hasText: 'methods.py' })).toBeVisible();
    const single = page.locator('.dv-active-group diffs-container');
    await expect(single.locator('[data-expand-method]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Unified', exact: true }).click();
    await expect(single.locator('[data-expand-method]')).toHaveCount(1);
    await single.locator('[data-expand-method]').click();
    await expect(single.locator('[data-unified] [data-line="23"]')).toContainText('def run');
    await expect(single.locator('[data-unified] [data-line="150"]')).toContainText('v125');
    await expect(single.locator('[data-unified] [data-line="265"]')).toContainText('return value');
    await selectLine(page, single, 150, 'unified');
    await comment(page, 'expanded method context');
    await expect.poll(() => annotations(page)).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: 'methods.py', lineStart: 149, lineEnd: 149, side: 'old', text: 'old method context' }),
      expect.objectContaining({ filePath: 'methods.py', lineStart: 150, lineEnd: 150, side: 'new', text: 'expanded method context' }),
    ]));
  } finally { await session.close(); }
});
