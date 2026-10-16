/** Real review routes and browser, with a deterministic headless agent instead of a paid model. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? '.local/plannotator');
const proofDir = resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? '.local/proof/discussions');
const parentId = '11111111-1111-4111-8111-111111111111';

async function review(page: Page) {
  const root = mkdtempSync(join(tmpdir(), 'plannotator-discussions-'));
  const repo = join(root, 'repo');
  mkdirSync(repo);
  mkdirSync(join(root, 'bin'));
  const git = (...args: string[]) => {
    const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    expect(result.status, result.stderr).toBe(0);
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Discussion test');
  git('config', 'user.email', 'discussion@example.invalid');
  writeFileSync(join(repo, 'main.ts'), "import { widget } from './helper';\nexport const result = widget(1);\n");
  writeFileSync(join(repo, 'helper.ts'), 'export function widget(value: number) {\n  return value * 2;\n}\n');
  git('add', '.');
  git('commit', '-m', 'base');
  writeFileSync(join(repo, 'main.ts'), "import { widget } from './helper';\nexport const result = widget(2);\n");
  // The gate makes reviewing while answers are pending deterministic. Commentary/deltas must never become discussion messages.
  writeFileSync(join(root, 'bin', 'codex'), `#!${process.execPath}
const { createInterface } = require('node:readline');
const { appendFileSync, existsSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { randomUUID } = require('node:crypto');
const root = dirname(process.cwd());
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
let thread;
createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  appendFileSync(join(root, 'requests.jsonl'), JSON.stringify(request) + '\\n');
  const {id, method, params} = request;
  if (id === undefined) return;
  let result = {};
  if (method === 'config/read') result = {config:{mcp_servers:{example:{enabled:true}}}};
  if (method === 'model/list') result = {data:[]};
  if (method === 'thread/fork' || method === 'thread/resume') {
    thread = method === 'thread/fork' ? randomUUID() : params.threadId;
    result = {thread:{id:thread}};
  }
  if (method === 'turn/start') {
    const turn = randomUUID();
    send({id,result:{turn:{id:turn}}});
    send({method:'item/agentMessage/delta',params:{threadId:thread,turnId:turn,delta:'PRIVATE_PARTIAL_TEXT'}});
    send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{type:'agentMessage',phase:'commentary',text:'PRIVATE_REASONING_TEXT'}}});
    const timer = setInterval(() => {
      if (!existsSync(join(root, 'release'))) return;
      clearInterval(timer);
      const text = params.input[0].text.includes('Explain further') ? 'Completed follow-up answer.' : 'Completed answer for this discussion.';
      send({method:'item/completed',params:{threadId:thread,turnId:turn,item:{type:'agentMessage',phase:'final_answer',text}}});
      send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});
    }, 25);
    return;
  }
  send({id,result});
}).on('close', () => process.exit(0));
`, { mode: 0o700 });
  const ready = join(root, 'ready.jsonl');
  const child = spawn(binary, ['review', repo, '--git', '--diff-type', 'uncommitted', '--no-git-remote-check', '--json'], {
    env: {
      PATH: `${join(root, 'bin')}:${process.env.PATH}`,
      PLANNOTATOR_DISCUSSION_PROVIDER: 'codex', PLANNOTATOR_DISCUSSION_SESSION_ID: parentId,
      PLANNOTATOR_DATA_DIR: join(root, 'data'), PLANNOTATOR_READY_FILE: ready,
      PLANNOTATOR_SKIP_BROWSER_OPEN: '1', PLANNOTATOR_REMOTE: '0', PLANNOTATOR_PORT: '0',
      PLANNOTATOR_SHARE: 'disabled', PLANNOTATOR_UPDATE_CHECK: '0',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', stderr = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { stderr += data; });
  const close = async () => {
    if (child.exitCode === null) child.kill('SIGTERM'); // Only this test's own disposable review.
    await expect.poll(() => child.exitCode !== null || child.signalCode !== null).toBe(true);
    rmSync(root, { recursive: true, force: true });
  };
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
      close, output: () => output, release: () => writeFileSync(join(root, 'release'), ''),
      requests: () => existsSync(join(root, 'requests.jsonl')) ? readFileSync(join(root, 'requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    };
  } catch (error) { await close(); throw error; }
}

async function selectLine(page: Page, viewer: Locator, line: number, side: 'additions' | 'deletions' | 'unified') {
  const column = viewer.locator(`[data-${side}]`);
  await column.locator(`[data-line="${line}"]`).click();
  await column.locator(`[data-column-number="${line}"]`).last().click();
  if (!await page.getByPlaceholder('Leave feedback...').isVisible()) {
    await column.locator(`[data-column-number="${line}"]`).last().hover();
    await column.locator(`[data-column-number="${line}"] [data-utility-button]`).click();
  }
  await expect(page.getByPlaceholder('Leave feedback...')).toBeVisible();
}

const snapshot = (page: Page) => page.evaluate(async () => (await fetch('/api/review-discussions')).json());
const draft = (page: Page) => page.evaluate(async () => (await fetch('/api/draft')).json());
const sidebar = (page: Page) => page.locator('aside').filter({ has: page.getByRole('heading', { name: 'Discussions', exact: true }) });

test.beforeAll(() => mkdirSync(proofDir, { recursive: true }));
test.use({ viewport: { width: 1600, height: 1000 }, actionTimeout: 15_000, screenshot: 'only-on-failure' });

test('questions run separately while reviewing; only converted requests enter persisted final feedback', async ({ page }, testInfo) => {
  const session = await review(page);
  try {
    const main = page.locator('diffs-container').first();
    await selectLine(page, main, 2, 'deletions');
    await page.getByPlaceholder('Leave feedback...').fill('Why did the old call change?');
    await page.locator('.review-toolbar').getByRole('button', { name: 'Ask agent', exact: true }).click();
    await expect(sidebar(page)).toContainText('Answering');
    await expect.poll(async () => (await snapshot(page)).threads.length).toBe(1);

    // Selecting an unchanged reference while the first question runs must retain that question's old-side anchor.
    const token = main.locator('[data-additions] [data-line="2"] [data-char]').filter({ hasText: /^widget$/ });
    await token.click({ modifiers: ['ControlOrMeta'] });
    const side = page.locator('[data-reference-file="helper.ts"]');
    await expect(side).toBeVisible();
    await selectLine(page, side, 2, 'unified');
    await page.locator('.review-toolbar').getByRole('button', { name: 'Ask agent', exact: true }).click();
    await page.getByPlaceholder('Ask about this code...').fill('Why multiply in the helper?');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).threads.filter((thread: any) => thread.status === 'answering').length).toBe(2);
    await expect.poll(() => session.requests().filter(request => request.method === 'turn/start').length).toBe(2);
    expect((await draft(page)).codeAnnotations ?? []).toEqual([]);
    expect(session.output()).toBe('');
    await selectLine(page, main, 2, 'additions');
    await page.getByPlaceholder('Leave feedback...').fill('Keep the new call explicit.');
    await page.getByRole('button', { name: 'Add Comment', exact: true }).click();
    if (!await sidebar(page).isVisible()) await page.getByTitle('Ask agent', { exact: true }).click();
    expect(JSON.stringify(await snapshot(page))).not.toMatch(/PRIVATE_PARTIAL_TEXT|PRIVATE_REASONING_TEXT/);
    await expect(page.locator('body')).not.toContainText('PRIVATE_');
    await expect.poll(async () => (await draft(page)).codeAnnotations?.length).toBe(1);
    await page.reload();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.getByTitle('Ask agent', { exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).threads.filter((thread: any) => thread.status === 'answering').length).toBe(2);
    expect(session.requests().filter(request => request.method === 'turn/start')).toHaveLength(2);

    session.release();
    await expect.poll(async () => (await snapshot(page)).threads.filter((thread: any) => thread.status === 'answered').length).toBe(2);
    const threads = (await snapshot(page)).threads;
    const old = threads.find((thread: any) => thread.anchor.filePath === 'main.ts');
    const helper = threads.find((thread: any) => thread.anchor.filePath === 'helper.ts');
    expect(old.anchor).toMatchObject({ lineStart: 2, lineEnd: 2, side: 'old' });
    expect(helper.anchor).toMatchObject({ lineStart: 2, lineEnd: 2, side: 'new' });
    const oldThread = sidebar(page).locator(`[data-discussion-id="${old.id}"]`);
    await oldThread.getByRole('button', { expanded: false }).click();
    await expect(oldThread).toContainText('Completed answer for this discussion.');
    await oldThread.getByLabel('Follow-up question', { exact: true }).fill('Explain further');
    await oldThread.getByRole('button', { name: 'Send question', exact: true }).click();
    await expect(oldThread).toContainText('Completed follow-up answer.');
    await page.screenshot({ path: join(proofDir, `discussion-threads-${testInfo.project.name || 'chromium'}.png`) });
    const requests = session.requests();
    expect(requests.filter(request => request.method === 'thread/fork')).toHaveLength(2);
    expect(requests.filter(request => request.method === 'thread/fork').every(request => request.params.threadId === parentId)).toBe(true);
    expect(requests.filter(request => request.method === 'thread/resume')).toHaveLength(1);
    expect(requests.find(request => request.method === 'thread/resume').params.threadId).not.toBe(parentId);

    await oldThread.getByRole('button', { name: 'Resolve', exact: true }).click();
    await expect(oldThread).toHaveCount(0);
    const helperThread = sidebar(page).locator(`[data-discussion-id="${helper.id}"]`);
    await helperThread.getByRole('button', { expanded: false }).click();
    await helperThread.getByRole('button', { name: 'Request change', exact: true }).click();
    await helperThread.getByLabel('Change request', { exact: true }).fill('Document the helper multiplier.');
    await helperThread.getByRole('button', { name: 'Save change request', exact: true }).click();
    await expect(helperThread).toHaveCount(0);
    await expect.poll(async () => (await draft(page)).codeAnnotations).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: 'helper.ts', lineStart: 2, lineEnd: 2, side: 'new', text: 'Document the helper multiplier.' }),
      expect.objectContaining({ filePath: 'main.ts', lineStart: 2, lineEnd: 2, side: 'new', text: 'Keep the new call explicit.' }),
    ]));
    await expect.poll(async () => (await snapshot(page)).threads.find((thread: any) => thread.id === helper.id).conversionSaved).toBe(true);
    expect(session.output()).toBe('');

    await page.reload();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).threads.map((thread: any) => thread.status).sort()).toEqual(['converted', 'resolved']);
    const sent = page.waitForRequest(request => request.url().endsWith('/api/feedback') && request.method() === 'POST');
    await page.getByRole('button', { name: 'Send Feedback' }).click();
    const payload = (await sent).postDataJSON();
    expect(payload.annotations).toHaveLength(2);
    expect(payload.annotations).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: 'helper.ts', side: 'new', text: 'Document the helper multiplier.' }),
      expect.objectContaining({ filePath: 'main.ts', side: 'new', text: 'Keep the new call explicit.' }),
    ]));
    expect(payload.feedback).not.toMatch(/Why did|Why multiply|Completed answer|Explain further|PRIVATE_/);
    await expect.poll(session.output).toContain('Document the helper multiplier.');
  } finally { await session.close(); }
});

test('interrupted conversion preserves existing draft; deleting a saved converted comment survives reload', async ({ page }) => {
  const session = await review(page);
  try {
    await selectLine(page, page.locator('diffs-container').first(), 2, 'additions');
    await page.getByPlaceholder('Leave feedback...').fill('Preserve my ordinary comment.');
    await page.getByRole('button', { name: 'Add Comment', exact: true }).click();
    await expect.poll(async () => (await draft(page)).codeAnnotations?.length).toBe(1);
    await page.getByTitle('Ask agent', { exact: true }).click();
    await sidebar(page).getByLabel('Ask about this review', { exact: true }).fill('What should change here?');
    await sidebar(page).getByRole('button', { name: 'Ask agent', exact: true }).click();
    session.release();
    await expect.poll(async () => (await snapshot(page)).threads[0]?.status).toBe('answered');
    const id = (await snapshot(page)).threads[0].id;
    const thread = sidebar(page).locator(`[data-discussion-id="${id}"]`);
    await thread.getByRole('button', { expanded: false }).click();
    await thread.getByRole('button', { name: 'Request change', exact: true }).click();
    await thread.getByLabel('Change request', { exact: true }).fill('Disposable converted request.');
    // Simulate losing the browser after conversion is durable but before the ordinary draft saves.
    await page.route('**/api/draft', route => route.request().method() === 'POST' ? route.abort() : route.continue());
    await thread.getByRole('button', { name: 'Save change request', exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).threads[0]?.status).toBe('converted');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
    await page.unroute('**/api/draft');
    // Let the normal draft debounce expire while the person has not chosen Restore yet.
    await page.waitForTimeout(1500);
    expect((await draft(page)).codeAnnotations).toEqual([
      expect.objectContaining({ text: 'Preserve my ordinary comment.' }),
    ]);
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect.poll(async () => (await draft(page)).codeAnnotations?.length).toBe(2);
    await expect.poll(async () => (await snapshot(page)).threads[0]?.conversionSaved).toBe(true);
    await page.getByTitle('Annotations', { exact: true }).click();
    const card = page.locator('aside .group').filter({ hasText: 'Disposable converted request.' });
    await card.hover();
    await card.getByTitle('Delete', { exact: true }).click();
    await expect.poll(async () => (await draft(page)).codeAnnotations?.length).toBe(1);
    await page.reload();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.waitForTimeout(1500);
    expect((await draft(page)).codeAnnotations).toEqual([
      expect.objectContaining({ text: 'Preserve my ordinary comment.' }),
    ]);
    expect((await snapshot(page)).threads[0].conversionSaved).toBe(true);
    expect(session.output()).toBe('');
  } finally { await session.close(); }
});

test('failed initial draft read blocks conversion until saved comments load successfully', async ({ page }) => {
  await page.route('**/api/draft', route => route.request().method() === 'GET' ? route.abort() : route.continue());
  const session = await review(page);
  try {
    await page.getByTitle('Ask agent', { exact: true }).click();
    await sidebar(page).getByLabel('Ask about this review', { exact: true }).fill('Can we clarify this review?');
    await sidebar(page).getByRole('button', { name: 'Ask agent', exact: true }).click();
    session.release();
    await expect.poll(async () => (await snapshot(page)).threads[0]?.status).toBe('answered');
    const id = (await snapshot(page)).threads[0].id;
    const thread = sidebar(page).locator(`[data-discussion-id="${id}"]`);
    await thread.getByRole('button', { expanded: false }).click();
    await expect(thread.getByRole('button', { name: 'Request change', exact: true })).toBeDisabled();
    await expect(thread).toContainText(/reload before requesting changes/i);
    expect((await snapshot(page)).threads[0].status).toBe('answered');
    await page.unroute('**/api/draft');
    await page.reload();
    await page.getByTitle('Ask agent', { exact: true }).click();
    await thread.getByRole('button', { expanded: false }).click();
    await expect(thread.getByRole('button', { name: 'Request change', exact: true })).toBeEnabled();
    await thread.getByRole('button', { name: 'Request change', exact: true }).click();
    await thread.getByLabel('Change request', { exact: true }).fill('Only save once existing comments are loaded.');
    await thread.getByRole('button', { name: 'Save change request', exact: true }).click();
    await expect.poll(async () => (await draft(page)).codeAnnotations).toEqual([
      expect.objectContaining({ scope: 'general', text: 'Only save once existing comments are loaded.' }),
    ]);
    await expect.poll(async () => (await snapshot(page)).threads[0].conversionSaved).toBe(true);
    expect(session.output()).toBe('');
  } finally { await session.close(); }
});
