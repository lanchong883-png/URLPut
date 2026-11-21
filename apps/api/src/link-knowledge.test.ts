import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { createApp } from './app.ts';
import { embeddedDatabase, localIdentity, migrate, seedLocal } from './database.ts';

test('reuses form templates across paths and keeps the active catalog current', async t => {
  const db = embeddedDatabase();
  await migrate(db);
  await migrate(db);
  await seedLocal(db);
  const otherWorkspace = randomUUID();
  await db.query(sql`INSERT INTO workspaces VALUES (${otherWorkspace}, 'Other')`);
  await db.query(sql`INSERT INTO workspace_members VALUES (${otherWorkspace}, ${localIdentity.subject})`);
  const app = createApp(db, async request => request.headers['x-test-subject'] as string | undefined);
  t.after(async () => {
    await app.close();
    await db.close();
  });
  const base = `/api/workspaces/${localIdentity.workspace}`;
  const headers = { 'x-test-subject': localIdentity.subject };
  const outsider = { 'x-test-subject': randomUUID() };
  const post = (path: string, payload: string | object, actor = headers) =>
    app.inject({ url: path, method: 'POST', headers: actor, payload });

  const templateRoute = `${base}/form-templates`;
  const lookup = `${templateRoute}/lookup`;
  const template = {
    pageUrl: 'https://directory.example/products/one',
    entryType: 'directory',
    locale: 'en-us',
    form: {
      actionUrl: 'https://directory.example/products/one/submit',
      method: 'post',
      fields: [
        { name: 'name', type: 'text', required: true, label: 'Product name' },
        { name: 'homepage', type: 'url', required: true },
        { name: 'section', type: 'select', required: false, options: ['a', 'b'] },
      ],
    },
    bindings: [{ field: 'name', source: 'siteName' }, { field: 'homepage', source: 'siteUrl' }],
  };

  assert.deepEqual((await post(lookup, template)).json(), { template: null });
  const reordered = { ...template, bindings: [...template.bindings].reverse() };
  const [saved, retry] = await Promise.all([post(templateRoute, template), post(templateRoute, reordered)]);
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.deepEqual(retry.json(), saved.json());
  const firstVersion = saved.json().template.version;
  const otherPath = {
    ...template, pageUrl: 'https://DIRECTORY.example/another/entry?x=1#form', locale: 'en-US',
    form: {
      ...template.form, actionUrl: 'https://directory.example/another/entry/post',
      fields: [...template.form.fields].reverse().map(field =>
        field.options ? { ...field, options: [...field.options].reverse() } : field),
    },
  };
  assert.deepEqual((await post(lookup, otherPath)).json(), saved.json());
  assert.deepEqual((await post(lookup.replace(localIdentity.workspace, otherWorkspace), otherPath)).json(), { template: null });
  for (const changed of [
    { ...template, pageUrl: 'https://sub.directory.example/entry' },
    { ...template, locale: 'fr-FR' },
    { ...template, entryType: 'profile' },
    { ...template, form: { ...template.form, actionUrl: 'https://other.example/post' } },
    { ...template, form: { ...template.form, fields: template.form.fields.map(field => ({ ...field, required: true })) } },
  ]) {
    assert.deepEqual((await post(lookup, changed)).json(), { template: null });
  }
  assert.equal((await post(lookup, template, outsider)).statusCode, 404);
  assert.equal((await post(templateRoute, template, outsider)).statusCode, 404);
  assert.equal((await post(templateRoute, { ...template, bindings: [template.bindings[0]] })).statusCode, 400);

  const revised = await post(templateRoute, {
    ...template, bindings: [{ field: 'name', source: 'title' }, template.bindings[1]],
  });
  assert.equal(revised.statusCode, 200, revised.body);
  assert.notEqual(revised.json().template.version, firstVersion);
  assert.equal((await post(templateRoute, template)).json().template.version, firstVersion);
  assert.deepEqual((await post(lookup, otherPath)).json(), revised.json());

  const catalog = `${base}/link-catalog`;
  const check = `${catalog}/observations`;
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const url = 'https://directory.example/products/one';
  const active = { url: url + '#form', status: 'active', observedAt: at(10) };
  assert.equal((await post(check, active, outsider)).statusCode, 404);
  assert.deepEqual((await post(check, active)).json(), { saved: true });
  assert.deepEqual((await post(check, { ...active, status: 'inactive', observedAt: at(11) })).json(), { saved: false });

  const load = (path = catalog, actor = headers) => app.inject({ url: path, headers: actor });
  const listing = await load();
  assert.equal(listing.statusCode, 200, listing.body);
  assert.deepEqual(listing.json().links.map((record: { url: string }) => record.url), [url]);
  assert.equal((await load(`${catalog}/recheck`)).json().links.length, 1);
  assert.equal((await load(catalog, outsider)).statusCode, 404);
  assert.deepEqual((await load(catalog.replace(localIdentity.workspace, otherWorkspace))).json().links, []);

  assert.deepEqual((await post(check, { ...active, status: 'inactive', reason: '入口已关闭' })).json(), { saved: true });
  assert.deepEqual((await post(check, active)).json(), { saved: false });
  assert.deepEqual((await load()).json().links, []);
  assert.equal((await load(`${catalog}/recheck`)).json().links[0].status, 'inactive');
  assert.deepEqual((await post(check, { ...active, observedAt: at(1) })).json(), { saved: true });
  assert.deepEqual((await post(check, { ...active, url: 'https://expired.example/', observedAt: at(31) })).json(), { saved: true });
  assert.deepEqual((await post(check, { ...active, url: 'https://second.example/', observedAt: at(2) })).json(), { saved: true });
  assert.equal((await post(check, { ...active, url: 'http://127.0.0.1/' })).statusCode, 400);
  const first = (await load(catalog + '?limit=1')).json();
  assert.deepEqual(first.links.map((record: { url: string }) => record.url), [url]);
  assert.equal(first.nextOffset, 1);
  const second = (await load(catalog + '?limit=1&offset=1')).json();
  assert.deepEqual(second.links.map((record: { url: string }) => record.url), ['https://second.example/']);
  assert.equal(second.nextOffset, null);
  assert.deepEqual((await load(catalog + '?q=SECOND.EXAMPLE&limit=1')).json(), {
    links: second.links, nextOffset: null,
  });
  assert.deepEqual((await load(catalog + '?q=expired')).json().links, []);
  assert.deepEqual((await load(catalog + '?q=%25')).json().links, []);
  assert.equal((await load(catalog + '?q=' + 'x'.repeat(201))).statusCode, 400);
  const exportPath = catalog + '/export.csv';
  const csv = await load(exportPath + '?limit=1');
  assert.equal(csv.statusCode, 200);
  assert.match(csv.headers['content-type'] ?? '', /^text\/csv/);
  assert.equal(csv.body[0], '\uFEFF');
  assert.match(csv.body, /"外链 URL","网站域名","最近核验时间"/);
  assert.match(csv.body, /directory\.example/);
  assert.match(csv.body, /second\.example/);
  assert.doesNotMatch(csv.body, /expired\.example/);
  const filteredCsv = await load(exportPath + '?q=SECOND.EXAMPLE');
  assert.match(filteredCsv.body, /second\.example/);
  assert.doesNotMatch(filteredCsv.body, /directory\.example/);
  assert.equal((await load(exportPath, outsider)).statusCode, 404);
  assert.equal((await load(exportPath.replace(localIdentity.workspace, otherWorkspace))).body.trim().split('\r\n').length, 1);
  assert.deepEqual((await load(`${catalog}/recheck`)).json().links.map((record: { url: string }) => record.url), ['https://expired.example/']);
});
