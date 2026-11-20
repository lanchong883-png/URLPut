import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
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
  const panel = await context.newPage();
  await panel.goto(`${origin}/sidepanel.html`);
  const opened = context.waitForEvent('page');
  await panel.getByRole('button', { name: '打开工作台' }).click();
  const page = await opened;
  await page.getByRole('heading', { name: '导入候选网址' }).waitFor();
  await page.getByText('示例站点', { exact: true }).waitFor({ state: 'attached' });
  const paste = page.getByLabel('或粘贴表格及网址');
  await paste.fill('URL\nhttps://example.org\nhttps://EXAMPLE.org/#a\ninvalid');
  await page.getByRole('button', { name: '预览导入' }).click();
  await page.getByText('重复候选，关联第 1 条。').waitFor();
  await page.getByRole('button', { name: '确认并保存' }).click();
  await page.getByLabel('导入批次').waitFor();

  await page.getByLabel('CSV 文件').setInputFiles({
    name: 'candidates.csv', mimeType: 'text/csv', buffer: Buffer.from('URL;名称\nhttps://example.net;目录站'),
  });
  await page.getByText('来源文件：candidates.csv').waitFor();
  await page.getByRole('button', { name: '预览导入' }).click();
  await page.getByRole('cell', { name: 'https://example.net' }).waitFor();
  await page.getByRole('button', { name: '确认并保存' }).click();
  await page.getByRole('option', { name: /candidates.csv/ }).waitFor({ state: 'attached' });
  await page.reload();
  await page.getByLabel('导入批次').waitFor();
  const options = await page.getByLabel('导入批次').locator('option').allTextContents();
  assert.equal(options.length, 3);
  await page.getByLabel('导入批次').selectOption({ label: options[1] });
  await page.getByRole('cell', { name: 'https://example.net' }).waitFor();

  await page.getByRole('button', { name: 'AI 设置' }).click();
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
  await page.getByRole('button', { name: 'AI 设置' }).click();
  await page.getByLabel('服务类型').selectOption('local');
  assert.equal(await page.getByLabel('模型名称').inputValue(), 'local-model');
  assert.equal(await page.getByLabel('API 密钥').inputValue(), '');
  assert.deepEqual(calls.map(call => [call.url, call.authorization, call.body.model]), [
    ['/local/v1/chat/completions', undefined, 'local-model'],
    ['/custom/v1/chat/completions', 'Bearer test-session-key', 'custom-model'],
  ]);
  console.log(`Chrome smoke passed${webSmoke ? ' (mock extension APIs)' : ''}: CSV, paste, history and two model profiles.`);
} finally {
  try {
    await context?.close();
  } finally {
    await api.close();
    await database.close();
    await rm(userData, { recursive: true, force: true });
  }
}
