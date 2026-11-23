import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { sql } from 'drizzle-orm';
import { createApp } from '../apps/api/src/app.ts';
import { embeddedDatabase, localIdentity, migrate, seedLocal } from '../apps/api/src/database.ts';

const database = embeddedDatabase();
const api = createApp(database, async () => localIdentity.subject, /^chrome-extension:\/\/[a-p]{32}$/);
const userData = await mkdtemp(join(tmpdir(), 'urlput-chrome-'));
const calls = [];
const webSmoke = process.env.URLPUT_WEB_SMOKE === '1';
const measureLongQueue = process.env.URLPUT_LONG_QUEUE === '1';
api.post('/:provider/v1/chat/completions', async request => {
  calls.push({ url: request.url, authorization: request.headers.authorization, body: request.body });
  return { choices: [{ message: { content: 'OK' } }] };
});

let context;
try {
  await migrate(database);
  await seedLocal(database);
  await database.query(sql`
    INSERT INTO promotion_sites (id, workspace_id, name, homepage)
    VALUES (${crypto.randomUUID()}, ${localIdentity.workspace}, '第二站点', 'https://second.example')
  `);
  const catalogFixtures = [
    ...Array.from({ length: 6 }, (_, index) => ({
      url: `https://catalog${index + 1}.example/submit`,
      status: 'active',
      observedAt: new Date(Date.now() - (index + 1) * 1000).toISOString(),
    })),
    { url: 'https://inactive.example/', status: 'inactive', observedAt: new Date().toISOString() },
    { url: 'https://expired.example/', status: 'active', observedAt: new Date(Date.now() - 31 * 86_400_000).toISOString() },
  ];
  for (const payload of catalogFixtures) {
    const result = await api.inject({
      method: 'POST', url: `/api/workspaces/${localIdentity.workspace}/link-catalog/observations`, payload,
    });
    assert.equal(result.statusCode, 200, result.body);
  }
  await api.listen({ port: 4310, host: '127.0.0.1' });

  const extension = resolve('apps/extension/.output/chrome-mv3');
  async function launchWorkbench() {
    context = await chromium.launchPersistentContext(userData, {
      channel: 'chromium',
      ignoreDefaultArgs: ['--disable-extensions'],
      executablePath: process.env.CHROMIUM_PATH,
      args: webSmoke ? (measureLongQueue ? ['--enable-precise-memory-info'] : []) : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    let origin;
    if (webSmoke) {
      origin = 'http://127.0.0.1:4310';
      await context.route(/^http:\/\/127\.0\.0\.1:4310\/(?:sidepanel\.html|import\.html|(?:chunks|assets)\/[\w.-]+)$/, async route => {
        const pathname = new URL(route.request().url()).pathname;
        const contentType = pathname.endsWith('.css') ? 'text/css' :
          pathname.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8';
        await route.fulfill({ contentType, body: await readFile(join(extension, pathname)) });
      });
      await context.addInitScript(() => {
        const storage = destination => ({
          async get(keys) {
            return Object.fromEntries([keys].flat().map(key => [key, JSON.parse(destination.getItem(key))]));
          },
          async set(items) {
            for (const [key, value] of Object.entries(items)) destination.setItem(key, JSON.stringify(value));
          },
          async remove(key) { destination.removeItem(key); },
        });
        globalThis.browser = {
          runtime: { id: 'urlput-web-smoke' },
          storage: { local: storage(localStorage), session: storage(sessionStorage) },
          permissions: { async request() { return true; } },
          tabs: { async create({ url }) { window.open(url); } },
        };
      });
    } else {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 15_000 });
      origin = `chrome-extension://${new URL(worker.url()).host}`;
    }
    return origin;
  }
  async function createWorkbenchPage(prompt = false) {
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.addInitScript(prompt => {
      if (prompt && !sessionStorage.getItem('restart-permission-initialized')) {
        sessionStorage.setItem('restart-permission-initialized', '1');
        sessionStorage.setItem('directory-permission', 'prompt');
      }
      window.showDirectoryPicker = async () => {
        const count = Number(sessionStorage.getItem('directory-picker-count') ?? 0);
        sessionStorage.setItem('directory-picker-count', String(count + 1));
        return (await navigator.storage.getDirectory()).getDirectoryHandle(sessionStorage.getItem('directory-picker-target') ?? 'test-data', { create: true });
      };
      FileSystemDirectoryHandle.prototype.queryPermission = async () =>
        sessionStorage.getItem('directory-permission') ? 'prompt' : 'granted';
      FileSystemDirectoryHandle.prototype.requestPermission = async () => {
        if (sessionStorage.getItem('directory-permission') === 'deny') return 'denied';
        sessionStorage.removeItem('directory-permission');
        return 'granted';
      };
    }, prompt);
    return page;
  }
  const origin = await launchWorkbench();
  let page = await createWorkbenchPage();
  const apiCalls = [];
  const blockApi = route => { apiCalls.push(route.request().url()); return route.abort(); };
  await page.route('**/api/**', blockApi);
  await page.goto(`${origin}/sidepanel.html`);
  await page.getByRole('button', { name: '选择数据目录' }).click();
  await page.getByLabel('官网地址').fill('https://local.example');
  await page.getByRole('button', { name: '添加推广站点' }).click();
  await page.getByRole('option', { name: 'local.example' }).waitFor({ state: 'attached' });
  await page.getByLabel('或粘贴表格及网址').fill('https://offline.example\nhttps://ok-offline.example');
  await page.getByRole('button', { name: '预览导入' }).click();
  await page.getByRole('button', { name: '确认并保存' }).click();
  await page.getByRole('button', { name: '导出 CSV' }).waitFor();
  await page.evaluate(() => {
    sessionStorage.setItem('directory-permission', 'deny');
    window.dispatchEvent(new Event('focus'));
  });
  await page.getByRole('alert').filter({ hasText: '数据目录权限已失效' }).waitFor();
  assert.equal(await page.getByLabel('导入批次').count(), 0);
  const reauthorize = page.getByRole('button', { name: '重新授权原目录' });
  await reauthorize.click();
  await page.getByRole('alert').filter({ hasText: '请允许读取和写入原数据目录。' }).waitFor();
  assert.equal(await page.getByLabel('导入批次').count(), 0);
  await page.evaluate(() => sessionStorage.setItem('directory-permission', 'prompt'));
  await reauthorize.click();
  await page.getByRole('option', { name: 'test-data', exact: true }).waitFor({ state: 'attached' });
  assert.equal(await page.evaluate(() => sessionStorage.getItem('directory-picker-count')), '1');
  const history = page.getByLabel('导入批次');
  await history.selectOption({ index: 1 });
  await page.getByRole('cell', { name: 'https://offline.example', exact: true }).waitFor();
  await page.getByText('登记待审核回执', { exact: true }).click();
  await page.getByLabel('已提交记录的序号').fill('1');
  await page.getByLabel('实际提交时间').fill('2026-01-01T12:00');
  await page.getByLabel('平台待审核提示或回执编号').fill('Awaiting moderation #TEST-100');
  await page.getByRole('button', { name: '保存回执' }).click();
  await page.getByRole('cell', { name: '待审核', exact: true }).waitFor();
  await page.reload();
  await page.getByLabel('导入批次').selectOption({ index: 1 });
  await page.getByRole('cell', { name: '待审核', exact: true }).waitFor();
  const offlineDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV' }).click();
  const receiptCsv = await readFile(await (await offlineDownload).path(), 'utf8');
  assert.match(receiptCsv, /"https:\/\/offline.example","提交成功","待审核"/);
  assert.match(receiptCsv, /Awaiting moderation #TEST-100/);
  if (webSmoke) {
    const approvalPanel = await context.newPage();
    await approvalPanel.goto(`${origin}/sidepanel.html`);
    await approvalPanel.getByLabel('导入批次').selectOption({ index: 1 });
    for (const panel of [page, approvalPanel]) {
      await panel.getByText('逐条批准手动投稿', { exact: true }).click();
      await panel.getByLabel('投稿候选').selectOption('2');
      await panel.getByLabel('投稿内容', { exact: true }).fill('经人工审核的示例投稿');
      assert.equal(await panel.getByRole('button', { name: '开始单次手动投稿' }).count(), 0);
    }
    await Promise.all([page, approvalPanel].map(panel => panel.getByRole('button', { name: '批准此条并保存投稿占位' }).click()));
    await Promise.all([
      Promise.any([page, approvalPanel].map(panel => panel.getByText(/已批准并保存投稿占位/).waitFor())),
      Promise.any([page, approvalPanel].map(panel => panel.getByText(/已有该网址的投稿占位/).waitFor())),
    ]);
    await approvalPanel.close();
    await page.reload();
    await page.getByLabel('导入批次').selectOption({ index: 1 });
    await page.getByText('逐条批准手动投稿', { exact: true }).click();
    await page.getByLabel('投稿候选').selectOption('2');
    const entry = page.getByRole('button', { name: '开始单次手动投稿' });
    await entry.waitFor();
    assert.equal(await page.getByLabel('已批准内容').inputValue(), '经人工审核的示例投稿');
    const submissionUrl = 'https://ok-offline.example/';
    const receivedDrafts = [];
    const receipt = '样站审核回执 #MANUAL-201';
    await context.route(submissionUrl, async route => {
      if (route.request().method() === 'POST') {
        receivedDrafts.push(new URLSearchParams(route.request().postData()).get('draft'));
        await route.abort('connectionreset');
        return;
      }
      const body = receivedDrafts.length ? `<p>${receipt}</p>`
        : '<form method="post"><label>正文<textarea name="draft" required></textarea></label><button>提交审核</button></form>';
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body });
    });
    const secondStart = await context.newPage();
    await secondStart.goto(`${origin}/sidepanel.html`);
    await secondStart.getByLabel('导入批次').selectOption({ index: 1 });
    await secondStart.getByText('逐条批准手动投稿', { exact: true }).click();
    await secondStart.getByLabel('投稿候选').selectOption('2');
    const otherEntry = secondStart.getByRole('button', { name: '开始单次手动投稿' });
    await otherEntry.waitFor();
    const openedSubmission = context.waitForEvent('page');
    await Promise.all([entry.click(), otherEntry.click()]);
    const submission = await openedSubmission;
    await Promise.any([page, secondStart].map(panel => panel.getByRole('alert').filter({ hasText: '此条已开始一次投稿' }).waitFor()));
    await secondStart.close();
    await page.reload();
    await page.getByLabel('导入批次').selectOption({ index: 1 });
    await page.getByText('逐条批准手动投稿', { exact: true }).click();
    await page.getByLabel('投稿候选').selectOption('2');
    await page.getByText(/已开始一次投稿/).waitFor();
    assert.equal(await entry.count(), 0);
    await submission.getByLabel('正文').fill(await page.getByLabel('已批准内容').inputValue());
    const lostResponse = submission.waitForEvent('requestfailed');
    await submission.getByRole('button', { name: '提交审核' }).click();
    assert.equal((await lostResponse).method(), 'POST');
    await submission.close();
    const receiptPage = await context.newPage();
    await receiptPage.goto(submissionUrl);
    await receiptPage.getByText(receipt, { exact: true }).waitFor();
    assert.deepEqual(receivedDrafts, ['经人工审核的示例投稿']);
    await receiptPage.close();
    await context.unroute(submissionUrl);
    await page.getByText('登记待审核回执', { exact: true }).click();
    await page.getByLabel('已提交记录的序号').fill('2');
    await page.getByLabel('实际提交时间').fill('2026-01-01T12:00');
    await page.getByLabel('平台待审核提示或回执编号').fill(receipt);
    await page.getByRole('button', { name: '保存回执' }).click();
    await page.getByText('此条已有待审核回执。', { exact: true }).waitFor();
    assert.equal(await entry.count(), 0);
    const probes = [];
    let resolved = false;
    let removed = false;
    let hiddenComment = false;
    let failedRevisit = false;
    const revisitCalls = [];
    let interruptRevisit;
    let releaseRevisit;
    const revisitInterrupted = new Promise(resolve => { interruptRevisit = resolve; });
    const holdRevisit = new Promise(resolve => { releaseRevisit = resolve; });
    let pauseSecondRevisit = false;
    await context.route(/^https:\/\/(offline|ok-offline)\.example\//, async route => {
      if (route.request().method() === 'GET') {
        const host = new URL(route.request().url()).hostname;
        revisitCalls.push(host);
        if (pauseSecondRevisit && host === 'offline.example') {
          pauseSecondRevisit = false;
          interruptRevisit();
          await holdRevisit;
          return route.abort().catch(() => {});
        }
        return route.fulfill({ status: failedRevisit && host === 'ok-offline.example' ? 503 : removed ? 410 : 200, contentType: 'text/html', headers: { 'Access-Control-Allow-Origin': '*' },
          body: '<title>Example directory</title><article><form action="/submit"><textarea name="comment" required></textarea></form></article>' +
            (hiddenComment ? '<a href="https://local.example/">Unrelated link</a>'
              : '<div class="comment"><a id="forum12"></a><a rel="nofollow" href="https://local.example/">Local</a></div>') });
      }
      assert.equal(route.request().method(), 'HEAD');
      probes.push({ url: route.request().url(), at: Date.now() });
      await route.fulfill({ status: probes.length === 1 && !resolved ? 503 : 200, headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    const otherPanel = await context.newPage();
    await otherPanel.goto(`${origin}/sidepanel.html`);
    await otherPanel.getByLabel('导入批次').selectOption({ index: 1 });
    await Promise.all([page, otherPanel].map(panel => panel.getByRole('button', { name: '加入只读检查队列' }).click()));
    await otherPanel.getByText(/本轮结束。/).waitFor();
    await otherPanel.close();
    await page.getByText(/本轮结束。/).waitFor();
    assert.equal(probes.length, 2);
    assert.ok(probes[1].at - probes[0].at >= 1900);
    await page.reload();
    await page.getByLabel('导入批次').selectOption({ index: 1 });
    await page.getByLabel('只看待处理项（1）').check();
    await page.getByText('待处理 · 第 1 条').waitFor();
    resolved = true;
    await page.getByRole('button', { name: '恢复此条' }).click();
    await page.getByLabel('只看待处理项（0）').waitFor();
    assert.equal(probes.length, 3);
    assert.equal(probes[2].url, probes[0].url);
    await page.getByLabel('只读任务').selectOption('analysis');
    await page.getByRole('button', { name: '加入只读检查队列' }).click();
    await page.getByText(/本轮结束。/).waitFor();
    const analysisDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出已完成网站分析 CSV' }).click();
    const analysisCsv = await readFile(await (await analysisDownload).path(), 'utf8');
    assert.match(analysisCsv, /Example directory/);
    assert.match(analysisCsv, /https:\/\/offline.example\/submit/);
    await page.getByText('已核验外链台账（0）').click();
    await page.getByLabel('公开评论定位链接').fill('https://offline.example/#forum12');
    await page.getByLabel('关联当前批次回执').selectOption('1');
    await page.getByRole('button', {name: '只读核验并保存'}).click();
    await page.getByText('已核验并保存。').waitFor();
    await page.getByRole('cell', { name: '有效外链', exact: true }).waitFor();
    await page.reload();
    await page.getByLabel('导入批次').selectOption({ index: 1 });
    await page.getByRole('cell', { name: '有效外链', exact: true }).waitFor();
    const linkedDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 CSV', exact: true }).click();
    const linkedCsv = await readFile(await (await linkedDownload).path(), 'utf8');
    assert.match(linkedCsv, /"提交成功","有效外链"/);
    assert.match(linkedCsv, /Awaiting moderation #TEST-100/);
    assert.match(linkedCsv, /#forum12/);
    await page.getByText('已核验外链台账（1）').click();
    const evidenceDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出已核验外链 CSV' }).click();
    const evidenceCsv = await readFile(await (await evidenceDownload).path(), 'utf8');
    assert.match(evidenceCsv, /forum12/);
    assert.match(evidenceCsv, /"nofollow","Local"/);
    hiddenComment = true;
    await page.getByRole('button', { name: '回访此条' }).click();
    await page.getByText('已保存待核实结果及上次有效证据。').waitFor();
    await page.getByRole('cell', { name: '待核实', exact: true }).waitFor();
    await page.reload();
    await page.getByLabel('导入批次').selectOption({ index: 1 });
    await page.getByRole('cell', { name: '待核实', exact: true }).waitFor();
    await page.getByText('已核验外链台账（1）').click();
    await page.getByLabel('核验结论').selectOption('valid');
    assert.equal(await page.getByRole('button', { name: '导出已核验外链 CSV' }).count(), 0);
    await page.getByLabel('核验结论').selectOption('pending');
    const pendingDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出已核验外链 CSV' }).click();
    const pendingCsv = await readFile(await (await pendingDownload).path(), 'utf8');
    assert.match(pendingCsv, /"待核实"/);
    assert.match(pendingCsv, /"nofollow","Local"/);
    assert.match(pendingCsv, /未能在唯一定位的公开记录中确认目标链接/);
    hiddenComment = false;
    await page.getByRole('button', { name: '回访此条' }).click();
    await page.getByText('已核验并保存。', { exact: true }).waitFor();
    await page.getByLabel('核验结论').selectOption('valid');
    await page.getByRole('button', { name: '回访此条' }).waitFor();
    await page.getByLabel('核验结论').selectOption('all');
    removed = true;
    await page.getByLabel('公开评论定位链接').fill('https://offline.example/#forum12');
    await page.getByRole('button', {name: '只读核验并保存'}).click();
    await page.getByText(/公开页失效（HTTP 410）/).waitFor();
    await page.getByLabel('核验结论').selectOption('valid');
    assert.equal(await page.getByRole('button', { name: '导出已核验外链 CSV' }).count(), 0);
    await page.getByLabel('核验结论').selectOption('missing');
    const removedDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出已核验外链 CSV' }).click();
    assert.match(await readFile(await (await removedDownload).path(), 'utf8'), /"公开页失效"/);
    removed = false;
    await page.getByLabel('核验结论').selectOption('all');
    await page.getByLabel('公开评论定位链接').fill('https://ok-offline.example/#forum12');
    await page.getByLabel('关联当前批次回执').selectOption('2');
    await page.getByRole('button', { name: '只读核验并保存' }).click();
    await page.getByText('已核验外链台账（2）').waitFor();
    await page.getByText('已核验并保存。', { exact: true }).waitFor();
    const manualDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 CSV', exact: true }).click();
    const manualCsv = await readFile(await (await manualDownload).path(), 'utf8');
    assert.match(manualCsv, /"https:\/\/ok-offline\.example","提交成功","有效外链"/);
    assert.ok(manualCsv.includes(receipt));
    failedRevisit = true;
    revisitCalls.length = 0;
    const revisitPanel = await context.newPage();
    await revisitPanel.goto(`${origin}/sidepanel.html`);
    await revisitPanel.getByText('已核验外链台账（2）').click();
    pauseSecondRevisit = true;
    await revisitPanel.getByRole('button', { name: '回访筛选结果（2）' }).click();
    await Promise.race([
      revisitInterrupted,
      revisitPanel.waitForEvent('close', { timeout: 10000 }),
    ]);
    await revisitPanel.close();
    releaseRevisit();
    await page.reload();
    await page.getByLabel('导入批次').selectOption({ index: 1 });
    await page.getByText('已核验外链台账（2）').click();
    await page.getByRole('button', { name: '继续批量回访（已完成 1 / 2 条）' }).click();
    await page.getByText('已回访 2 条，1 条遇到访问问题。').waitFor();
    assert.deepEqual(revisitCalls, ['ok-offline.example', 'offline.example', 'offline.example']);
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'https://offline.example', exact: true }) })
      .getByRole('cell', { name: '有效外链', exact: true }).waitFor();
    await page.reload();
    await page.getByText('已核验外链台账（2）').click();
    await page.getByText(/最近访问问题 · HTTP 503/).waitFor();
    const revisitDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出已核验外链 CSV' }).click();
    assert.match(await readFile(await (await revisitDownload).path(), 'utf8'), /访问问题原因[\s\S]*HTTP 503/);
    const interrupted = await context.newPage();
    interrupted.setDefaultTimeout(10000);
    await interrupted.goto(`${origin}/sidepanel.html`);
    await interrupted.getByLabel('或粘贴表格及网址').fill('https://first-resume.example\nhttps://second-resume.example');
    await interrupted.getByRole('button', { name: '预览导入' }).click();
    await interrupted.getByRole('button', { name: '确认并保存' }).click();
    const visits = [];
    let signalInterrupted;
    const secondStarted = new Promise(resolve => { signalInterrupted = resolve; });
    let releaseFirstAttempt;
    const hold = new Promise(resolve => { releaseFirstAttempt = resolve; });
    const resumeFixture = /^https:\/\/(first|second)-resume\.example\//;
    const serveResume = async route => {
      const second = route.request().url().includes('second-resume');
      visits.push(second ? 'second' : 'first');
      if (second && visits.length === 2) {
        signalInterrupted();
        await hold;
        return route.abort().catch(() => {});
      }
      return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*' } });
    };
    await context.route(resumeFixture, serveResume);
    await interrupted.getByRole('button', { name: '加入只读检查队列' }).click();
    try {
      await Promise.race([secondStarted, interrupted.getByText('本轮结束。请查看各页检查结果和待处理项。').waitFor()
        .then(() => { throw new Error('未观察到中断前的第二个请求'); })]);
      await context.close();
    } finally { releaseFirstAttempt(); }
    assert.equal(await launchWorkbench(), origin);
    await context.route(resumeFixture, serveResume);
    page = await createWorkbenchPage(true);
    await page.route('**/api/**', blockApi);
    await page.goto(`${origin}/sidepanel.html`);
    await page.getByRole('button', { name: '重新授权原目录' }).click();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('directory-picker-count')), null);
    await page.getByRole('button', { name: '继续未完成队列（1）' }).click();
    await page.getByText('队列已处理完毕。').waitFor();
    assert.deepEqual(visits, ['first', 'second', 'second']);
    await page.getByLabel('导入批次').selectOption({ index: 1 });
    await page.getByText('已检查 · 第 2 条').waitFor();
    await context.route(/^https:\/\/(first|second)-resume\.example\//, route => route.fulfill({
      status: route.request().url().includes('second-resume') ? 401 : 200,
      contentType: 'text/html', headers: { 'Access-Control-Allow-Origin': '*' },
      body: '<article><title>Dynamic discussion</title><p>You must log in to view comments.</p><div id="disqus_thread"></div></article>',
    }));
    await page.getByLabel('只读任务').selectOption('analysis');
    await page.getByRole('button', { name: '加入只读检查队列' }).click();
    await page.getByText(/本轮结束。/).waitFor();
    // Use large historical batches with no analysis output to exercise sparse directory reads.
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await (await root.getDirectoryHandle('test-data')).getDirectoryHandle('URLPut-data-v1');
      const workspace = await (await (await dir.getFileHandle('workspace.json')).getFile()).text();
      const site = JSON.parse(workspace).workspace.sites[0].id;
      const index = await dir.getFileHandle(site + '.index.json');
      const history = JSON.parse(await (await index.getFile()).text());
      const synthetic = Array.from({ length: 20 }, (_, index) => ({
        id: crypto.randomUUID(), filename: `large-history-${index}.csv`,
        createdAt: '2020-01-01T00:00:00.000Z', rowCount: 5000, source: 'csv',
      }));
      const writer = await index.createWritable();
      await writer.write(JSON.stringify([...history, ...synthetic]));
      await writer.close();
    });
    await page.reload();
    await page.getByLabel('导入批次').getByRole('option', { name: /large-history-19/ }).waitFor({ state: 'attached' });
    await page.evaluate(() => {
      const getFileHandle = FileSystemDirectoryHandle.prototype.getFileHandle;
      window.analysisReads = [];
      FileSystemDirectoryHandle.prototype.getFileHandle = function (name, options) {
        if (/^analysis-.*-\d+\.json$/.test(name)) window.analysisReads.push(name);
        return getFileHandle.call(this, name, options);
      };
    });
    await page.getByText('跨批次网站分析', { exact: true }).click();
    const crossBatch = page.locator('details').filter({ has: page.getByText('跨批次网站分析', { exact: true }) });
    await crossBatch.getByText('已分析 · Dynamic discussion').waitFor();
    await crossBatch.getByText('已分析 · Example directory', { exact: true }).first().waitFor();
    assert.equal(await page.evaluate(() => window.analysisReads.length), 2);
    await page.getByLabel('分析批次').selectOption({ index: 1 });
    await crossBatch.getByText('已分析 · Example directory', { exact: true }).first().waitFor({ state: 'detached' });
    await page.getByLabel('分析结果').selectOption('issue');
    await crossBatch.getByText(/HTTP 401，站点要求身份验证/).waitFor();
    const filteredAnalysis = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出筛选后的网站分析 CSV' }).click();
    const filteredAnalysisCsv = await readFile(await (await filteredAnalysis).path(), 'utf8');
    assert.match(filteredAnalysisCsv, /second-resume\.example[\s\S]*HTTP 401/);
    assert.doesNotMatch(filteredAnalysisCsv, /first-resume\.example|offline\.example/);
    async function pickDirectory(name, button) {
      await page.evaluate(name => sessionStorage.setItem('directory-picker-target', name), name);
      await page.getByRole('button', { name: button, exact: true }).click();
    }
    await pickDirectory('backup-data', '备份数据目录');
    await page.getByText('备份完成：backup-data/URLPut-data-v1。').waitFor();
    await pickDirectory('test-data', '备份数据目录');
    await page.getByRole('alert').filter({ hasText: '目标已有 URLPut 数据' }).waitFor();
    await page.evaluate(async () => {
      const partial = await (await navigator.storage.getDirectory()).getDirectoryHandle('partial-data', { create: true });
      const data = await partial.getDirectoryHandle('URLPut-data-v1', { create: true });
      await data.getFileHandle('unfinished.json', { create: true });
    });
    await pickDirectory('partial-data', '初始化空数据目录');
    await page.getByRole('alert').filter({ hasText: '可能是未完成的副本' }).waitFor();
    await pickDirectory('backup-data', '选择备份来源');
    await page.getByText('已选备份：backup-data。请选择恢复目标。').waitFor();
    await pickDirectory('partial-data', '选择备份来源');
    await page.getByRole('alert').filter({ hasText: '无法识别本机工作空间格式' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '选择恢复目标并恢复' }).count(), 0);
    await pickDirectory('backup-data', '选择备份来源');
    await page.getByText('已选备份：backup-data。请选择恢复目标。').waitFor();
    await pickDirectory('restored-data', '选择恢复目标并恢复');
    await page.getByText('已恢复并切换到：restored-data。').waitFor();
    const snapshots = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      return Promise.all(['test-data', 'backup-data', 'restored-data'].map(async name => {
        const dir = await (await root.getDirectoryHandle(name)).getDirectoryHandle('URLPut-data-v1');
        const files = {};
        for await (const [file, handle] of dir.entries()) files[file] = await (await handle.getFile()).text();
        return files;
      }));
    });
    assert.ok(Object.keys(snapshots[0]).some(name => name.endsWith('.verified.json')));
    assert.ok(Object.keys(snapshots[0]).some(name => name.startsWith('analysis-')));
    assert.deepEqual(snapshots[1], snapshots[0]);
    assert.deepEqual(snapshots[2], snapshots[0]);
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const original = await root.getDirectoryHandle('restored-data');
      const target = await root.getDirectoryHandle('moved-data', { create: true });
      const input = await original.getDirectoryHandle('URLPut-data-v1');
      const output = await target.getDirectoryHandle('URLPut-data-v1', { create: true });
      for await (const [name, handle] of input.entries()) {
        const destination = await output.getFileHandle(name, { create: true });
        await (await handle.getFile()).stream().pipeTo(await destination.createWritable());
      }
      await root.removeEntry('restored-data', { recursive: true });
    });
    await page.reload();
    await page.getByRole('button', { name: '重新授权原目录' }).waitFor();
    assert.equal(await page.getByLabel('导入批次').count(), 0);
    await pickDirectory('empty-data', '重新选择数据目录');
    await page.getByRole('alert').filter({ hasText: '所选位置没有 URLPut 数据' }).waitFor();
    await pickDirectory('moved-data', '重新选择数据目录');
    await page.getByLabel('导入批次').waitFor();
    await page.reload();
    await page.getByLabel('导入批次').selectOption({ index: 2 });
    await page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'https://ok-offline.example', exact: true }) })
      .getByRole('cell', { name: '有效外链', exact: true }).waitFor();
    await page.getByLabel('官网地址').fill('https://restored-only.example');
    await page.getByRole('button', { name: '添加推广站点' }).click();
    await page.getByRole('option', { name: 'restored-only.example' }).waitFor({ state: 'attached' });
    assert.deepEqual(await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      return Promise.all(['test-data', 'backup-data', 'moved-data'].map(async name => {
        const dir = await (await root.getDirectoryHandle(name)).getDirectoryHandle('URLPut-data-v1');
        return (await (await dir.getFileHandle('workspace.json')).getFile()).text();
      }));
    }).then(files => files.map(content => content.includes('restored-only.example'))), [false, false, true]);
    const limitedRows = measureLongQueue ? 4998 : 33;
    const queueRequests = [];
    let releaseTimeoutRoute;
    const holdResponse = new Promise(resolve => { releaseTimeoutRoute = resolve; });
    await context.route(/^https:\/\/(limited|slow|healthy)-queue\.example\//, async route => {
      const url = new URL(route.request().url());
      queueRequests.push({ host: url.hostname, path: url.pathname, at: Date.now() });
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Retry-After' };
      if (url.hostname === 'slow-queue.example') {
        await holdResponse;
        return route.abort().catch(() => {});
      }
      if (queueRequests.length === 1) return route.fulfill({ status: 429, headers: { ...headers, 'Retry-After': measureLongQueue ? '600' : '8' } });
      return route.fulfill({ status: 200, headers });
    });
    const queueUrls = [
      ...Array.from({ length: limitedRows }, (_, index) => `https://limited-queue.example/${index}`),
      'https://slow-queue.example/',
      'https://healthy-queue.example/',
    ].join('\n');
    if (measureLongQueue) {
      await page.getByLabel('CSV 或 TXT 文件').setInputFiles({
        name: 'long-queue.csv', mimeType: 'text/csv', buffer: Buffer.from('URL\n' + queueUrls),
      });
      await page.getByText('来源文件：long-queue.csv').waitFor();
    } else await page.getByLabel('或粘贴表格及网址').fill(queueUrls);
    await page.getByRole('button', { name: '预览导入' }).click();
    await page.getByRole('button', { name: '确认并保存' }).click();
    if (measureLongQueue) await page.evaluate(() => {
      const stats = { resultReads: 0, resultWrites: 0, resultBytes: 0,
        initialHeap: performance.memory.usedJSHeapSize, peakHeap: 0 };
      const getFile = FileSystemFileHandle.prototype.getFile;
      const createWritable = FileSystemFileHandle.prototype.createWritable;
      const segment = /^checks-.*-\d+\.json$/;
      const sample = () => { stats.peakHeap = Math.max(stats.peakHeap, performance.memory.usedJSHeapSize); };
      const encoder = new TextEncoder();
      FileSystemFileHandle.prototype.getFile = function () {
        if (segment.test(this.name)) stats.resultReads++;
        return getFile.call(this);
      };
      FileSystemFileHandle.prototype.createWritable = async function (...args) {
        const stream = await createWritable.apply(this, args);
        if (segment.test(this.name)) {
          const write = stream.write.bind(stream);
          stream.write = value => {
            stats.resultWrites++;
            stats.resultBytes += encoder.encode(value).byteLength;
            sample();
            return write(value);
          };
        }
        return stream;
      };
      window.queueStats = stats;
    });
    try {
      const start = Date.now();
      await page.getByRole('button', { name: '加入只读检查队列' }).click();
      await page.getByText(/本轮结束。/).waitFor({ timeout: measureLongQueue ? 180000 : 35000 });
      assert.deepEqual(queueRequests.map(item => item.host), ['limited-queue.example', 'slow-queue.example', 'healthy-queue.example']);
      assert.ok(queueRequests[2].at - queueRequests[1].at >= 14900);
      await page.getByText(/HTTP 429，等待站点解除限流/).waitFor();
      assert.equal(await page.getByText(/站点处于限流等待期/).count(), 31);
      if (measureLongQueue) {
        await page.getByLabel('只看待处理项（4999）').waitFor();
        const stats = await page.evaluate(() => window.queueStats);
        assert.equal(stats.resultWrites, 5000);
        assert.ok(stats.resultReads >= Math.ceil(5000 / 32));
        console.log('Long queue metrics:', JSON.stringify({ rows: 5000, elapsedMs: Date.now() - start, ...stats }));
        await page.evaluate(() => localStorage.removeItem('urlput-check-cooldown:https://limited-queue.example'));
      } else {
        await page.getByRole('button', { name: '下一组结果' }).click();
        await page.getByText(/检查超时，请核对网址/).waitFor();
        await page.getByText('已检查 · 第 35 条').waitFor();
        await page.getByRole('button', { name: '上一组结果' }).click();
      }
      const retryStart = Date.now();
      await page.getByRole('button', { name: '恢复此条' }).first().click();
      await page.getByText('已检查 · 第 1 条', { exact: true }).waitFor();
      if (measureLongQueue) console.log('Long queue item retry ms:', Date.now() - retryStart);
      assert.equal(queueRequests.at(-1).path, '/0');
      assert.ok(queueRequests.at(-1).at - queueRequests[0].at >= 8000);
    } finally { releaseTimeoutRoute(); }
    await page.getByLabel('推广站点').selectOption({ label: 'local.example' });
    await page.getByLabel('或粘贴表格及网址').fill('https://OK-OFFLINE.example/#duplicate\nhttps://OFFLINE.example/#duplicate');
    await page.getByRole('button', { name: '预览导入' }).click();
    await page.getByRole('button', { name: '确认并保存' }).click();
    await page.getByText('逐条批准手动投稿', { exact: true }).click();
    await page.getByLabel('投稿候选').selectOption('1');
    await page.getByText(/已批准并保存投稿占位/).waitFor();
    assert.equal(await page.getByRole('button', { name: '批准此条并保存投稿占位' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '开始单次手动投稿' }).count(), 0);
    await page.getByText('登记待审核回执', { exact: true }).click();
    await page.getByLabel('实际提交时间').fill('2026-01-01T12:00');
    await page.getByLabel('平台待审核提示或回执编号').fill('重复登记测试');
    await page.getByLabel('已提交记录的序号').fill('1');
    await page.getByRole('button', { name: '保存回执' }).click();
    await page.getByRole('alert').filter({ hasText: '请在原投稿批次' }).waitFor();
    await page.getByLabel('已提交记录的序号').fill('2');
    await page.getByRole('button', { name: '保存回执' }).click();
    await page.getByRole('alert').filter({ hasText: '已有该网址的待审核回执' }).waitFor();
  }
  assert.deepEqual(apiCalls, []);
  await page.unroute('**/api/**', blockApi);
  await page.getByLabel('数据来源').selectOption('legacy');
  assert.equal(await page.getByRole('navigation', { name: '插件导航' }).getByRole('button').count(), 6);
  for (const width of [320, 392]) {
    await page.setViewportSize({ width, height: 760 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
  }
  await page.getByRole('heading', { name: '导入候选网址' }).waitFor();
  await page.getByText('示例站点', { exact: true }).waitFor({ state: 'attached' });
  await page.getByLabel('推广站点').selectOption({ label: '示例站点' });
  const paste = page.getByLabel('或粘贴表格及网址');
  await paste.fill('URL\nhttps://example.org\nhttps://EXAMPLE.org/#a\ninvalid');
  await page.getByRole('button', { name: '预览导入' }).click();
  await page.getByText('重复候选，关联第 1 条。').waitFor();
  await page.getByRole('button', { name: '确认并保存' }).click();
  await page.getByLabel('导入批次').waitFor();

  await page.getByLabel('CSV 或 TXT 文件').setInputFiles({
    name: 'candidates.csv', mimeType: 'text/csv', buffer: Buffer.from('URL;名称\nhttps://example.net;目录站\nhttps://EXAMPLE.net/#重复;重复\ninvalid;无效'),
  });
  await page.getByText('来源文件：candidates.csv').waitFor();
  await page.getByRole('button', { name: '预览导入' }).click();
  await page.getByRole('cell', { name: 'https://example.net', exact: true }).waitFor();
  await page.getByRole('button', { name: '确认并保存' }).click();
  await page.getByRole('option', { name: /candidates.csv/ }).waitFor({ state: 'attached' });
  await page.reload();
  await page.getByLabel('推广站点').selectOption({ label: '示例站点' });
  await page.getByRole('option', { name: /candidates.csv/ }).waitFor({ state: 'attached' });
  const options = await page.getByLabel('导入批次').locator('option').allTextContents();
  assert.equal(options.length, 3);
  await page.getByLabel('导入批次').selectOption({ label: options.find(label => label.includes('candidates.csv')) });
  await page.getByRole('cell', { name: 'https://example.net', exact: true }).waitFor();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV' }).click();
  const csv = await readFile(await (await download).path(), 'utf8');
  assert.match(csv, /"序号","网站域名","网站分类","URL","结果类别","结论","原因与下一步","推广站点","推广站点网址"/);
  assert.match(csv, /"2","example.net","未识别","https:\/\/EXAMPLE.net\/#重复","未成功","已跳过"/);
  assert.match(csv, /"3","—","未识别","invalid","未成功","输入无效"/);
  assert.match(csv, /"示例站点","https:\/\/example.com","3"/);
  assert.doesNotMatch(csv, /example.org|第二站点/);
  await page.getByRole('columnheader', { name: '推广站点网址' }).waitFor();
  for (const width of [320, 392]) {
    await page.setViewportSize({ width, height: 760 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
  }

  await page.getByLabel('推广站点').selectOption({ label: '第二站点' });
  await page.getByText('当前站点暂无导入记录。').waitFor();
  assert.equal(await page.getByRole('button', { name: '导出 CSV' }).count(), 0);
  await paste.fill('https://second-target.example/');
  await page.getByRole('button', { name: '预览导入' }).click();
  await page.getByRole('button', { name: '确认并保存' }).click();
  const secondDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV' }).click();
  const secondCsv = await readFile(await (await secondDownload).path(), 'utf8');
  assert.match(secondCsv, /second-target.example/);
  assert.match(secondCsv, /第二站点/);
  assert.doesNotMatch(secondCsv, /example.net|示例站点/);
  const originalText = '目录 https://txt-first.example/；备用 https://txt-second.example/';
  await page.getByLabel('CSV 或 TXT 文件').setInputFiles({
    name: 'links.TXT', mimeType: 'text/plain',
    buffer: Buffer.from(`\uFEFF${originalText}\r\n\r\n无效地址\rhttps://TXT-FIRST.example/#重复`),
  });
  await page.getByText('来源文件：links.TXT').waitFor();
  assert.equal(await page.getByLabel('分隔符').count(), 0);
  await page.getByRole('button', { name: '预览导入' }).click();
  await page.getByText('重复候选，关联第 1 条。').waitFor();
  await page.getByRole('button', { name: '确认并保存' }).click();
  await page.getByRole('option', { name: /links.TXT/ }).waitFor({ state: 'attached' });
  await page.reload();
  await page.getByLabel('推广站点').selectOption({ label: '第二站点' });
  const txtOption = page.getByRole('option', { name: /links.TXT/ });
  await txtOption.waitFor({ state: 'attached' });
  await page.getByLabel('导入批次').selectOption(await txtOption.getAttribute('value'));
  const txtDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV' }).click();
  const txtCsv = await readFile(await (await txtDownload).path(), 'utf8');
  assert.ok(txtCsv.includes(originalText));
  assert.match(txtCsv, /"3","—","未识别","无效地址","未成功","输入无效"/);
  assert.match(txtCsv, /"第二站点","https:\/\/second.example","3"/);
  assert.doesNotMatch(txtCsv, /second-target\.example/);
  await page.getByRole('button', { name: '外链清单' }).click();
  const catalog = page.getByRole('region', { name: '活跃外链列表' });
  await catalog.getByText('catalog5.example', { exact: true }).waitFor();
  assert.equal(await catalog.getByRole('listitem').count(), 5);
  const allLinksDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出全部 CSV' }).click();
  const allLinksCsv = await readFile(await (await allLinksDownload).path(), 'utf8');
  assert.match(allLinksCsv, /catalog1\.example/);
  assert.match(allLinksCsv, /catalog6\.example/);
  assert.doesNotMatch(allLinksCsv, /inactive\.example|expired\.example/);
  await catalog.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await catalog.getByText('catalog6.example', { exact: true }).waitFor();
  assert.equal(await catalog.getByRole('listitem').count(), 6);
  const search = page.getByLabel('搜索网址或域名');
  await search.fill('CATALOG6.EXAMPLE');
  await catalog.getByText('catalog6.example', { exact: true }).waitFor();
  assert.equal(await catalog.getByRole('listitem').count(), 1);
  const filteredLinksDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出搜索结果 CSV' }).click();
  const filteredLinksCsv = await readFile(await (await filteredLinksDownload).path(), 'utf8');
  assert.match(filteredLinksCsv, /catalog6\.example/);
  assert.doesNotMatch(filteredLinksCsv, /catalog1\.example/);
  for (const term of ['inactive', 'expired']) {
    await search.fill(term);
    await page.getByText('没有匹配的活跃外链。').waitFor();
    assert.equal(await catalog.getByRole('listitem').count(), 0);
  }
  await page.getByRole('button', { name: '推广站点' }).click();
  await page.getByRole('cell', { name: 'https://txt-first.example/', exact: true }).waitFor();
  await page.getByRole('button', { name: 'AI 模型' }).click();
  await page.getByLabel('服务类型').waitFor();
  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: '打开工作台' }).click();
  const workbench = await opened;
  await workbench.getByLabel('数据来源').selectOption('legacy');
  await workbench.getByRole('heading', { name: '导入候选网址' }).waitFor();
  await workbench.close();

  await page.getByRole('button', { name: 'AI 模型' }).click();
  const modelBase = 'http://127.0.0.1:4310';
  for (const [provider, token] of [['local', ''], ['custom', 'test-session-key']]) {
    await page.getByLabel('服务类型').selectOption(provider);
    await page.getByLabel('API 基础地址').fill(`${modelBase}/${provider}/v1`);
    await page.getByLabel('模型名称').fill(`${provider}-model`);
    await page.getByLabel('API 密钥').fill(token);
    await page.getByRole('button', { name: '测试连接' }).click();
    try {
      await page.getByText('连接成功。', { exact: false }).waitFor({ timeout: 7000 });
    } catch (error) {
      throw new Error(`模型连接验收失败（${provider}）：${await page.getByRole('status').textContent()}`, { cause: error });
    }
    await page.getByRole('button', { name: '保存设置' }).click();
    await page.getByText('模型设置已保存。', { exact: false }).waitFor();
  }
  await page.reload();
  await page.getByRole('button', { name: 'AI 模型' }).click();
  await page.getByLabel('服务类型').selectOption('local');
  assert.equal(await page.getByLabel('模型名称').inputValue(), 'local-model');
  assert.equal(await page.getByLabel('API 密钥').inputValue(), '');
  assert.deepEqual(calls.map(call => [call.url, call.authorization, call.body.model]), [
    ['/local/v1/chat/completions', undefined, 'local-model'],
    ['/custom/v1/chat/completions', 'Bearer test-session-key', 'custom-model'],
  ]);
  await page.getByRole('button', { name: '清单', exact: true }).click();
  await page.getByLabel('推广站点').selectOption({ label: '示例站点' });
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.getByRole('button', { name: '将本站历史批次复制到本机目录' }).click();
    await page.getByText('已核对并保存 2 个批次。').waitFor();
  }
  await page.getByLabel('数据来源').selectOption('local');
  await page.getByLabel('推广站点').selectOption({ label: '示例站点' });
  const migrated = page.getByLabel('导入批次');
  await migrated.getByRole('option', { name: /candidates.csv/ }).waitFor({ state: 'attached' });
  assert.equal(await migrated.locator('option').count(), 3);
  await migrated.selectOption(await migrated.getByRole('option', { name: /candidates.csv/ }).getAttribute('value'));
  await page.getByRole('cell', {name: 'https://example.net', exact: true}).waitFor();
  console.log(`Chrome smoke passed${webSmoke ? ' (mock extension APIs)' : ''}: side panel at 320/392px, CSV and TXT export, serial URL checks, Retry-After and request timeouts, browser restart queue recovery, directory reauthorization and backup/restore, linked moderation receipts, filtered backlink revisits, issue recovery, site isolation, catalog search, scrolling and export, legacy workbench and two model profiles.`);
} finally {
  try {
    await context?.close();
  } finally {
    await api.close();
    await database.close();
    await rm(userData, { recursive: true, force: true });
  }
}
