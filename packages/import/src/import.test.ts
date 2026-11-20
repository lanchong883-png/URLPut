import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLedger, mapRows, normalizeUrl, readTable } from './index.ts';

test('maps semicolon, quoted newlines, blank rows and BOM while keeping source lines', () => {
  const table = readTable('\uFEFFURL;名称;备注\r\nhttps://example.org;首页;"一行\r\n二行"\r\n\r\nhttps://example.net;目录;', ';');
  const rows = mapRows(table, { url: 0, name: 1, notes: 2 }, true);
  assert.deepEqual(rows.map(row => row.sourceLine), [2, 5]);
  assert.match(rows[0].notes, /一行\r?\n二行/);
  assert.equal(rows[1].name, '目录');
});

test('pasted tabular data and CSV agree after column mapping', () => {
  const values = ['网址', 'https://example.org', 'HTTPS://EXAMPLE.org/#intro', 'ftp://example.org'];
  const makeInput = (delimiter: ',' | '\t') => values.map(value => [value, '说明'].join(delimiter)).join('\n');
  const makeLedger = (delimiter: ',' | '\t') =>
    buildLedger(mapRows(readTable(makeInput(delimiter), delimiter), { url: 0, notes: 1 }, true));
  assert.deepEqual(makeLedger(','), makeLedger('\t'));
  assert.equal(makeLedger(',')[1].duplicateOf, 1);
  assert.equal(makeLedger(',')[2].disposition, 'invalid');
});

test('blocks private, embedded credential and malformed URL inputs', () => {
  for (const input of ['http://localhost', 'https://127.0.0.1', 'http://[::ffff:127.0.0.1]', 'http://10.0.0.1', 'https://a:b@example.org', 'https:example.org']) {
    assert.equal(normalizeUrl(input), undefined, input);
  }
  assert.equal(normalizeUrl('https://例子.中国/path#top'), 'https://xn--fsqu00a.xn--fiqs8s/path');
  assert.throws(() => mapRows(readTable(Array(5003).fill('https://example.org').join('\n'), ','), { url: 0 }, false));
});
