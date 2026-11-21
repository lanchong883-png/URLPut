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
  context = await chromium.launchPersistentContext(userData, {
    channel: 'chromium',
    ignoreDefaultArgs: ['--disable-extensions'],
    executablePath: process.env.CHROMIUM_PATH,
    args: webSmoke ? [] : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
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
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(`${origin}/sidepanel.html`);
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
  await page.getByLabel('导入批次').selectOption({ label: options[1] });
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
  console.log(`Chrome smoke passed${webSmoke ? ' (mock extension APIs)' : ''}: side panel at 320/392px, CSV and TXT export, site isolation, catalog search, scrolling and export, legacy workbench and two model profiles.`);
} finally {
  try {
    await context?.close();
  } finally {
    await api.close();
    await database.close();
    await rm(userData, { recursive: true, force: true });
  }
}
