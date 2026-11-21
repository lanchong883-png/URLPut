import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from './app.ts';
import { embeddedDatabase, localIdentity, migrate, seedLocal } from './database.ts';

test('keeps one persistent ledger per confirmation and enforces membership', async t => {
  const database = embeddedDatabase();
  t.after(() => database.close());
  await migrate(database);
  await seedLocal(database);
  const app = createApp(database, async request => request.headers['x-test-subject'] as string | undefined);
  t.after(() => app.close());

  const path = `/api/workspaces/${localIdentity.workspace}/sites/${localIdentity.site}/imports`;
  const headers = { 'x-test-subject': localIdentity.subject };
  const outsider = { 'x-test-subject': randomUUID() };
  const row = { sourceLine: 2, url: 'https://example.org', entry: '', notes: '', name: '' };
  const payload = {
    requestId: randomUUID(),
    source: 'paste',
    rows: [row, { ...row, sourceLine: 3, url: 'https://EXAMPLE.org/#section' }, { ...row, sourceLine: 4, url: 'invalid' }],
  };
  assert.equal((await app.inject('/api/workspaces')).statusCode, 401);
  assert.deepEqual((await app.inject({ url: '/api/workspaces', headers: outsider })).json(), []);
  assert.equal((await app.inject({ method: 'POST', url: path, headers: outsider, payload })).statusCode, 404);

  const save = () => app.inject({ method: 'POST', url: path, headers, payload });
  const [first, retry] = await Promise.all([save(), save()]);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(retry.statusCode, 200, retry.body);
  const batch = first.json();
  assert.equal(batch.id, retry.json().id);
  assert.deepEqual(batch.rows.map((item: { disposition: string }) => item.disposition), ['candidate', 'duplicate', 'invalid']);
  assert.equal(batch.rows[1].duplicateOf, 1);

  const changed = await app.inject({
    method: 'POST', url: path, headers, payload: { ...payload, rows: [row] },
  });
  assert.equal(changed.statusCode, 409);
  const list = await app.inject({ url: path, headers });
  assert.equal(list.json().length, 1);
  assert.equal(list.json()[0].rowCount, 3);
  assert.deepEqual((await app.inject({ url: `${path}/${batch.id}`, headers })).json(), batch);
  assert.equal((await app.inject({ url: `${path}/${batch.id}`, headers: outsider })).statusCode, 404);

  await migrate(database);
  const sourceText = '目录 https://example.org；备用 https://example.net';
  const txt = await app.inject({
    method: 'POST', url: path, headers, payload: {
      ...payload, requestId: randomUUID(), source: 'txt', filename: '目录.txt',
      rows: [{ ...row, sourceText }, { ...row, url: 'https://example.net', sourceText }],
    },
  });
  assert.equal(txt.statusCode, 200, txt.body);
  const textBatch = txt.json();
  assert.equal(textBatch.source, 'txt');
  assert.equal(textBatch.filename, '目录.txt');
  assert.deepEqual(textBatch.rows.map((item: typeof row & { sourceText: string }) => [item.sourceLine, item.sourceText]),
    [[2, sourceText], [2, sourceText]]);
  assert.deepEqual((await app.inject({ url: `${path}/${textBatch.id}`, headers })).json(), textBatch);
  assert.deepEqual((await app.inject({ url: `${path}/${batch.id}`, headers })).json(), batch);
});
