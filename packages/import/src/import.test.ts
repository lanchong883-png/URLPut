import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildLedger, mapRows, normalizeUrl, readTable, readTextRows } from './index.ts';

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

test('extracts TXT URLs and retains the original source line, including invalid rows', () => {
  const sourceText = '目录 https://example.org/path?q=a,b；备用 https://second.example/';
  const rows = readTextRows(`\uFEFF${sourceText}\r\n\r\n无效地址\rHTTPS://EXAMPLE.org/path?q=a,b#duplicate`);
  assert.deepEqual(rows.map(row => [row.sourceLine, row.url]), [
    [1, 'https://example.org/path?q=a,b'], [1, 'https://second.example/'],
    [3, '无效地址'], [4, 'HTTPS://EXAMPLE.org/path?q=a,b#duplicate'],
  ]);
  assert.equal(rows[0].sourceText, sourceText);
  assert.equal(rows[1].sourceText, sourceText);
  assert.deepEqual(buildLedger(rows).map(row => row.disposition), ['candidate', 'candidate', 'invalid', 'duplicate']);
  assert.deepEqual(readTextRows(' \r\n\n'), []);
  assert.throws(() => readTextRows('a'.repeat(8193)), /8,192/);
  assert.throws(() => readTextRows('https://example.org\n'.repeat(5001)), /5,000/);
});
