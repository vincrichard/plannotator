/** Real review routes and browser, with a deterministic headless agent instead of a paid model. */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const binary = resolve(process.env.PLANNOTATOR_E2E_BINARY ?? '.local/plannotator');
const proofDir = resolve(process.env.PLANNOTATOR_E2E_PROOF_DIR ?? '.local/proof/discussions');
const parentId = '11111111-1111-4111-8111-111111111111';

async function review(page: Page, answerText?: string, longFile: boolean | 'deleted' = false) {
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
  const contents = (value: number) => longFile
    ? Array.from({ length: 160 }, (_, i) => `export const value${i + 1} = ${value};`).join('\n') + '\n'
    : `import { widget } from './helper';\nexport const result = widget(${value});\n`;
  writeFileSync(join(repo, 'main.ts'), contents(1));
  writeFileSync(join(repo, 'helper.ts'), 'export function widget(value: number) {\n  return value * 2;\n}\n');
  git('add', '.');
  git('commit', '-m', 'base');
  writeFileSync(join(repo, 'main.ts'), longFile === 'deleted' ? '' : contents(2));
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
      const text = ${answerText === undefined ? "params.input[0].text.includes('Explain further') ? 'Completed follow-up answer.' : 'Completed answer for this discussion.'" : JSON.stringify(answerText)};
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
  await column.locator(`[data-line="${line}"]`).last().click();
  await column.locator(`[data-column-number="${line}"]`).last().click();
  if (!await page.getByPlaceholder('Leave feedback...').isVisible()) {
    await column.locator(`[data-column-number="${line}"]`).last().hover();
    await column.locator(`[data-column-number="${line}"] [data-utility-button]`).click();
  }
  await expect(page.getByPlaceholder('Leave feedback...')).toBeVisible();
}

const snapshot = (page: Page) => page.evaluate(async () => (await fetch('/api/review-discussions')).json());
const draft = (page: Page) => page.evaluate(async () => (await fetch('/api/draft')).json());
async function askOnLine(page: Page, text: string) {
  await selectLine(page, page.locator('diffs-container').first(), 2, 'additions');
  await page.getByPlaceholder('Leave feedback...').fill(text);
  await page.locator('.review-toolbar').getByRole('button', { name: 'Ask agent', exact: true }).click();
}
async function expandThread(thread: Locator) {
  const header = thread.locator('button[aria-expanded]');
  await expect(header).toBeVisible();
  if (await header.getAttribute('aria-expanded') === 'false') await header.click();
  await expect(header).toHaveAttribute('aria-expanded', 'true');
}

test.beforeAll(() => mkdirSync(proofDir, { recursive: true }));
test.use({ viewport: { width: 1600, height: 1000 }, actionTimeout: 15_000, screenshot: 'only-on-failure' });

for (const mobile of [false, true]) test.describe(`agent opener on ${mobile ? 'phone' : 'desktop'}`, () => {
  test.use({ hasTouch: mobile });
  test('agent-started discussions sync, reply, resolve and convert', async ({ page }, testInfo) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 800 });
    const session = await review(page);
    const second = await page.context().newPage();
    try {
      await second.goto(page.url());
      const diff = await (await page.request.get(new URL('/api/diff', page.url()).href)).json();
      const endpoint = new URL('/api/review-discussions', page.url()).href;
      const opening = {
        id: 'agent-opening', serverSession: diff.serverSession, snapshotId: diff.snapshotId,
        role: 'assistant', text: 'Agent finding: removing this input may change retry behavior.',
        anchor: { filePath: 'main.ts', lineStart: 2, lineEnd: 2, side: 'old', scope: 'line' },
      };
      expect((await page.request.post(endpoint, { data: opening })).status()).toBe(201);
      expect((await page.request.post(endpoint, { data: opening })).status()).toBe(200);
      expect((await page.request.post(endpoint, { data: { ...opening, id: 'agent-to-resolve', text: 'Agent finding to dismiss.', anchor: { ...opening.anchor, side: 'new' } } })).status()).toBe(201);
      expect(session.requests()).toEqual([]);
      const firstThread = page.locator('[data-discussion-id="agent-opening"]');
      const secondThread = second.locator('[data-discussion-id="agent-opening"]');
      await expect(firstThread).toContainText('Awaiting your reply');
      await expect(secondThread).toContainText('Awaiting your reply');
      await expandThread(secondThread);
      await expect(secondThread.getByText('Agent', { exact: true })).toBeVisible();
      expect((await draft(page)).codeAnnotations ?? []).toEqual([]);
      await secondThread.getByLabel('Follow-up question', { exact: true }).fill('Explain further: which behavior changes?');
      await secondThread.getByRole('button', { name: 'Send question', exact: true }).click();
      await expect.poll(() => session.requests().filter(r => r.method === 'turn/start').length).toBe(1);
      const prompt = session.requests().find(r => r.method === 'turn/start').params.input[0].text;
      expect(prompt).toContain(opening.text);
      expect(prompt).toContain('Reviewed patch');
      expect(prompt).toContain('main.ts:2-2 (old)');
      expect(prompt).toContain('Explain further: which behavior changes?');
      session.release();
      await expect(secondThread).toContainText('Completed follow-up answer.');
      await page.reload();
      await expandThread(firstThread);
      await expect(firstThread).toContainText('Completed follow-up answer.');
      await expect(firstThread).not.toContainText('PRIVATE_');
      const resolved = page.locator('[data-discussion-id="agent-to-resolve"]');
      await expandThread(resolved);
      await resolved.getByRole('button', { name: 'Resolve', exact: true }).click();
      await expect(resolved).toHaveCount(0);
      await firstThread.getByRole('button', { name: 'Request change', exact: true }).click();
      await firstThread.getByLabel('Change request', { exact: true }).fill('Keep the retry behavior explicit.');
      await firstThread.getByRole('button', { name: 'Save change request', exact: true }).click();
      await expect(firstThread).toHaveCount(0);
      await expect(secondThread).toHaveCount(0);
      await expect.poll(async () => (await draft(page)).codeAnnotations).toEqual([
        expect.objectContaining({ filePath: 'main.ts', lineStart: 2, lineEnd: 2, side: 'old', text: 'Keep the retry behavior explicit.' }),
      ]);
      await second.close();
      await page.reload();
      await page.getByRole('button', { name: 'Restore', exact: true }).click();
      await page.screenshot({ path: join(proofDir, `agent-opening-${mobile ? 'phone' : 'desktop'}-${testInfo.project.name}.png`) });
      const sent = page.waitForRequest(request => request.url().endsWith('/api/feedback') && request.method() === 'POST');
      if (mobile) await page.getByRole('button', { name: 'Options', exact: true }).click();
      await page.getByRole('button', { name: /^Send feedback/i }).click();
      const payload = (await sent).postDataJSON();
      expect(payload.annotations).toHaveLength(1);
      expect(payload.annotations[0]).toMatchObject({ filePath: 'main.ts', side: 'old', text: 'Keep the retry behavior explicit.' });
      expect(payload.feedback).not.toMatch(/Agent finding|Explain further|Completed follow-up/);
      await expect.poll(session.output).toContain('Keep the retry behavior explicit.');
    } finally { await second.close(); await session.close(); }
  });
});

test('questions run separately while reviewing; only converted requests enter persisted final feedback', async ({ page }, testInfo) => {
  const session = await review(page);
  try {
    const main = page.locator('diffs-container').first();
    await selectLine(page, main, 2, 'deletions');
    await page.getByPlaceholder('Leave feedback...').fill('Why did the old call change?');
    let loseResponse = true;
    await page.route('**/api/review-discussions', async route => {
      if (route.request().method() === 'POST' && loseResponse) {
        loseResponse = false;
        await route.fetch(); // Accepted by the server; only its reply is lost.
        await route.abort();
      } else await route.continue();
    });
    await page.locator('.review-toolbar').getByRole('button', { name: 'Ask agent', exact: true }).click();
    await expect(page.locator('.review-toolbar [role="alert"]')).toBeVisible();
    await expect(page.getByPlaceholder('Leave feedback...')).toHaveValue('Why did the old call change?');
    await page.locator('.review-toolbar').getByRole('button', { name: 'Ask agent', exact: true }).click();
    await expect(page.locator('diffs-container [data-discussion-id]')).toContainText('Answering');
    await expect(page.locator('diffs-container').getByLabel('Follow-up question', { exact: true })).toBeVisible();
    await page.unroute('**/api/review-discussions');
    await expect(page.getByRole('heading', { name: 'Discussions', exact: true })).toHaveCount(0);
    await expect(page.getByTitle('Ask agent', { exact: true })).toHaveCount(0);
    await expect.poll(async () => (await snapshot(page)).threads.length).toBe(1);
    const questionBadge = page.locator('.file-tree-item').filter({ hasText: 'main.ts' }).getByLabel('1 unresolved question', { exact: true });
    await expect(questionBadge).toBeVisible();

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
    expect(JSON.stringify(await snapshot(page))).not.toMatch(/PRIVATE_PARTIAL_TEXT|PRIVATE_REASONING_TEXT/);
    await expect(page.locator('body')).not.toContainText('PRIVATE_');
    await expect.poll(async () => (await draft(page)).codeAnnotations?.length).toBe(1);
    await page.reload();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).threads.filter((thread: any) => thread.status === 'answering').length).toBe(2);
    expect(session.requests().filter(request => request.method === 'turn/start')).toHaveLength(2);

    session.release();
    await expect.poll(async () => (await snapshot(page)).threads.filter((thread: any) => thread.status === 'answered').length).toBe(2);
    const threads = (await snapshot(page)).threads;
    const old = threads.find((thread: any) => thread.anchor.filePath === 'main.ts');
    const helper = threads.find((thread: any) => thread.anchor.filePath === 'helper.ts');
    expect(old.anchor).toMatchObject({ lineStart: 2, lineEnd: 2, side: 'old' });
    expect(helper.anchor).toMatchObject({ lineStart: 2, lineEnd: 2, side: 'new' });
    const oldThread = page.locator(`[data-discussion-id="${old.id}"]`);
    await expandThread(oldThread);
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

    await expect(questionBadge).toBeVisible(); // An answer and follow-ups do not resolve the thread.
    await oldThread.getByRole('button', { name: 'Resolve', exact: true }).click();
    await expect(questionBadge).toHaveCount(0);
    await expect(oldThread).toHaveCount(0);
    await main.locator('[data-additions] [data-line="2"] [data-char]').filter({ hasText: /^widget$/ }).click({ modifiers: ['ControlOrMeta'] });
    const helperThread = page.locator(`[data-discussion-id="${helper.id}"]`);
    await expandThread(helperThread);
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
    await askOnLine(page, 'What should change here?');
    session.release();
    await expect.poll(async () => (await snapshot(page)).threads[0]?.status).toBe('answered');
    const id = (await snapshot(page)).threads[0].id;
    const thread = page.locator(`[data-discussion-id="${id}"]`);
    await expandThread(thread);
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
    await askOnLine(page, 'Can we clarify this review?');
    session.release();
    await expect.poll(async () => (await snapshot(page)).threads[0]?.status).toBe('answered');
    const id = (await snapshot(page)).threads[0].id;
    const thread = page.locator(`[data-discussion-id="${id}"]`);
    await expandThread(thread);
    await expect(thread.getByRole('button', { name: 'Request change', exact: true })).toBeDisabled();
    await expect(thread).toContainText(/reload before requesting changes/i);
    expect((await snapshot(page)).threads[0].status).toBe('answered');
    await page.unroute('**/api/draft');
    await page.reload();
    await expandThread(thread);
    await expect(thread.getByRole('button', { name: 'Request change', exact: true })).toBeEnabled();
    await thread.getByRole('button', { name: 'Request change', exact: true }).click();
    await thread.getByLabel('Change request', { exact: true }).fill('Only save once existing comments are loaded.');
    await thread.getByRole('button', { name: 'Save change request', exact: true }).click();
    await expect.poll(async () => (await draft(page)).codeAnnotations).toEqual([
      expect.objectContaining({ filePath: 'main.ts', scope: 'line', side: 'new', lineStart: 2, text: 'Only save once existing comments are loaded.' }),
    ]);
    await expect.poll(async () => (await snapshot(page)).threads[0].conversionSaved).toBe(true);
    expect(session.output()).toBe('');
  } finally { await session.close(); }
});


for (const failure of ['ended', 'disconnected'] as const) {
  test(`${failure} review retains initial and follow-up drafts and offers recovery`, async ({ page }) => {
    const session = await review(page);
    try {
      const main = page.locator('diffs-container').first();
      await selectLine(page, main, 2, 'deletions');
      await page.getByPlaceholder('Leave feedback...').fill('First question');
      await page.locator('.review-toolbar').getByRole('button', { name: 'Ask agent', exact: true }).click();
      const followUp = page.getByLabel('Follow-up question', { exact: true });
      await followUp.fill('Unsent follow-up');
      await selectLine(page, main, 2, 'additions');
      await page.locator('.review-toolbar').getByRole('button', { name: 'Ask agent', exact: true }).click();
      const input = page.getByPlaceholder('Ask about this code...');
      await input.fill('Unsent initial question');
      await page.route('**/api/review-discussions**', route => failure === 'ended'
        ? route.fulfill({ status: 410, contentType: 'text/plain', body: 'Review has ended or is unavailable' })
        : route.abort());
      await page.getByRole('button', { name: 'Ask', exact: true }).click();
      await expect(page.getByRole('alert').filter({ hasText: failure === 'ended' ? 'This review has ended' : 'Cannot reach this review' }).first()).toBeVisible();
      await expect(input).toHaveValue('Unsent initial question');
      await expect(followUp).toHaveValue('Unsent follow-up');
      const downloading = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download saved questions', exact: true }).click();
      const download = await downloading;
      const saved = JSON.parse(readFileSync((await download.path())!, 'utf8'));
      expect(JSON.stringify(saved)).toContain('Unsent initial question');
      expect(JSON.stringify(saved)).toContain('Unsent follow-up');
      expect(Object.values(saved.questions)).toEqual(expect.arrayContaining([
        expect.objectContaining({ anchor: expect.objectContaining({ filePath: 'main.ts', lineStart: 2, side: 'new' }) }),
      ]));
      expect(session.output()).toBe('');
    } finally { await session.close(); }
  });
}

for (const width of [390, 1440]) {
  test.describe(`discussion layout at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 }, hasTouch: width === 390 });
    test('long questions and answers fit the review pane while code scrolls locally', async ({ page }, testInfo) => {
      const prose = 'Explain how this change affects the remaining references. '.repeat(24);
      const token = 'very_long_identifier_'.repeat(40);
      const question = `${prose}\n\n${token}\n\n\`${token}\``;
      const answer = `${prose}\n\n[Detailed explanation ${token}](https://example.invalid)\n\n\`\`\`ts\nconst result = "${token}";\n\`\`\``;
      const session = await review(page, answer);
      try {
        const main = page.locator('diffs-container').first();
        await selectLine(page, main, 2, width === 390 ? 'unified' : 'additions');
        await page.getByPlaceholder('Leave feedback...').fill(question);
        await page.getByRole('button', { name: 'Ask agent', exact: true }).click();
        const thread = main.locator('[data-discussion-id]');
        await expect(thread.getByLabel('Follow-up question', { exact: true })).toBeVisible();
        const fits = () => thread.evaluate(el => ({
          overflow: el.scrollWidth - el.clientWidth,
          width: el.getBoundingClientRect().width,
          viewport: window.innerWidth,
        }));
        await expect.poll(async () => (await fits()).overflow).toBeLessThanOrEqual(1);
        expect((await fits()).width).toBeLessThan(width);
        session.release();
        await expect(thread).toContainText('Answered');
        await expect(thread.locator('.inline-code-block')).toBeVisible();
        await expect.poll(async () => (await fits()).overflow).toBeLessThanOrEqual(1);
        const code = thread.locator('.inline-code-block');
        expect(await code.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
        await code.evaluate(el => { el.scrollLeft = 80; });
        expect(await code.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
        await thread.getByLabel('Follow-up question', { exact: true }).fill('Keep this unsent follow-up.');
        await page.setViewportSize({ width: width === 390 ? 600 : 1000, height: 900 });
        await expect.poll(async () => (await fits()).overflow).toBeLessThanOrEqual(1);
        await expect(thread.getByLabel('Follow-up question', { exact: true })).toHaveValue('Keep this unsent follow-up.');
        await page.screenshot({ path: join(proofDir, `discussion-wrap-${width}-${testInfo.project.name}.png`) });
      } finally { await session.close(); }
    });
  });
}

test.describe('touch annotation actions', () => {
  test.use({ viewport: { width: 390, height: 900 }, hasTouch: true });
  test('comments can be edited, cancelled and deleted with visible touch controls', async ({ page }) => {
    const session = await review(page);
    try {
      const main = page.locator('diffs-container').first();
      await selectLine(page, main, 2, 'unified');
      await page.getByPlaceholder('Leave feedback...').fill('Original comment');
      await page.getByRole('button', { name: 'Add Comment', exact: true }).tap();
      const card = main.locator('[data-annotation-id]');
      await expect(card).toContainText('Original comment');
      const edit = card.getByTitle('Edit', { exact: true });
      // A transparent action is still technically clickable; assert it can be seen without hover.
      expect(await edit.evaluate(el => getComputedStyle(el.parentElement!).opacity)).toBe('1');
      const size = await edit.boundingBox();
      expect(size!.width).toBeGreaterThanOrEqual(44);
      expect(size!.height).toBeGreaterThanOrEqual(44);
      await edit.tap();
      await page.getByPlaceholder('Leave feedback...').fill('Discard this edit');
      await page.getByRole('button', { name: 'Cancel', exact: true }).tap();
      await expect(card).toContainText('Original comment');
      await edit.tap();
      await page.getByPlaceholder('Leave feedback...').fill('Updated comment');
      await page.getByRole('button', { name: 'Update', exact: true }).tap();
      await expect.poll(async () => (await draft(page)).codeAnnotations?.[0]?.text).toBe('Updated comment');
      await edit.tap();
      await page.getByRole('button', { name: 'Delete annotation', exact: true }).tap();
      await expect(card).toHaveCount(0);
      await expect(page.getByPlaceholder('Leave feedback...')).toHaveCount(0);
      await expect.poll(async () => (await draft(page)).codeAnnotations ?? []).toEqual([]);
    } finally { await session.close(); }
  });
});

test('guided review forks the launching session and keeps normal guide persistence and export', async ({ page }, testInfo) => {
  const guide = { title: 'Session context guide', intent: 'Explain the changed call', sections: [
    { title: 'Adjust widget input', overview: 'The conversation explains why the input changes.', diffs: [{ file: 'main.ts' }] },
  ], unplacedFiles: [] };
  const session = await review(page, JSON.stringify(guide));
  try {
    await page.getByRole('button', { name: 'Guide', exact: true }).click();
    await expect(page.getByText(/Uses a fork of your Codex/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Engine', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Generate guide', exact: true }).click();
    await expect.poll(() => session.requests().filter(r => r.method === 'thread/fork').length).toBe(1);
    const fork = session.requests().find(r => r.method === 'thread/fork');
    expect(fork.params.threadId).toBe(parentId);
    expect(session.requests().some(r => r.method === 'thread/start')).toBe(false);
    session.release();
    await expect(page.getByText('Adjust widget input').first()).toBeVisible();
    const completed = await page.evaluate(async () => (await fetch('/api/agents/jobs')).json());
    const job = completed.jobs.find((job: { provider: string }) => job.provider === 'guide');
    expect(job.status).toBe('done');
    const saved = await page.evaluate(async id => (await fetch(`/api/guide/${id}`)).json(), job.id);
    expect(saved.sections[0].diffs[0].file).toBe('main.ts');
    const exported = await page.evaluate(async id => {
      const response = await fetch(`/api/guide/${id}/export`);
      return { status: response.status, text: await response.text() };
    }, job.id);
    expect(exported.status).toBe(200);
    expect(exported.text).toContain('Session context guide');
    await page.screenshot({ path: join(proofDir, `guide-fork-${testInfo.project.name}.png`) });
    await page.reload();
    // Completed guides reopen automatically when the jobs snapshot arrives.
    await expect(page.getByText('Adjust widget input').first()).toBeVisible();
  } finally { await session.close(); }
});

test.describe('last-line touch comments', () => {
  test.use({ viewport: { width: 390, height: 700 }, hasTouch: true });
  for (const surface of ['all-files', 'file']) for (const side of ['old', 'new']) test(`the plus at the bottom opens a composer (${surface}, ${side})`, async ({ page, browserName }, testInfo) => {
    const session = await review(page, undefined, side === 'old' ? 'deleted' : true);
    try {
      if (surface === 'file') {
        const row = page.getByRole('button', { name: /^Mark as viewed M main.ts/ });
        if (!await row.isVisible()) await page.getByRole('button', { name: 'Open review navigation', exact: true }).tap();
        await row.tap();
      }
      const viewer = page.locator('diffs-container').first();
      await viewer.evaluate(el => {
        let viewport = el.parentElement;
        while (viewport && !(viewport.scrollHeight > viewport.clientHeight && /auto|scroll/.test(getComputedStyle(viewport).overflowY))) viewport = viewport.parentElement;
        if (!viewport) throw new Error('Missing diff scroller');
        viewport.scrollTop = viewport.scrollHeight;
      });
      const lines = page.locator('diffs-container [data-line="160"]');
      const line = side === 'new' ? lines.last() : lines.first();
      await expect(line).toBeVisible();
      const numbers = page.locator('diffs-container [data-column-number="160"]');
      const number = side === 'new' ? numbers.last() : numbers.first();
      const open = async () => {
        if (surface === 'all-files') await line.tap();
        await number.tap();
        if (!await page.getByPlaceholder('Leave feedback...').isVisible()) await number.locator('[data-utility-button]').tap();
      };
      await open();
      const composer = page.getByPlaceholder('Leave feedback...');
      await expect(composer).toBeVisible();
      await composer.fill('Comment on the very last line');
      // Firefox already ignores touch backdrop dismissal; Escape exercises draft retention there.
      if (browserName === 'firefox') await page.keyboard.press('Escape');
      else await page.touchscreen.tap(195, 690);
      await expect(composer).not.toBeVisible();
      if (surface === 'file') await line.tap();
      else await open();
      await expect(composer).toHaveValue('Comment on the very last line');
      await page.screenshot({ path: join(proofDir, `last-line-${surface}-${side}-${testInfo.project.name}.png`) });
      await page.getByRole('button', { name: 'Add Comment', exact: true }).tap();
      await expect.poll(async () => (await draft(page)).codeAnnotations?.map((a: any) => ({ filePath: a.filePath, lineStart: a.lineStart, lineEnd: a.lineEnd, side: a.side, text: a.text }))).toEqual([
        { filePath: 'main.ts', lineStart: 160, lineEnd: 160, side, text: 'Comment on the very last line' },
      ]);
    } finally { await session.close(); }
  });
});
