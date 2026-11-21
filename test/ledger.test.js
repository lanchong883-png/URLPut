import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportCsv, headings, importRows, normalizeUrl, parseCsv } from '../extension/ledger.js';

test('parses BOM, separators, quoted newlines and escaped quotes', () => {
  assert.deepEqual(parseCsv('\uFEFFURL;备注\r\nhttps://a.example;"第一行\r\n""第二行"""\r\n', ';'),
    [['URL', '备注'], ['https://a.example', '第一行\r\n"第二行"']]);
  assert.deepEqual(parseCsv('https://a.example\t', '\t'), [['https://a.example', '']]);
  assert.throws(() => parseCsv('"unfinished'), /未闭合/);
});

test('normalizes only HTTP(S) URLs without credentials', () => {
  assert.equal(normalizeUrl(' HTTPS://A.EXAMPLE:443/#top ').href, 'https://a.example/');
  assert.throws(() => normalizeUrl('file:///tmp/report'));
  assert.throws(() => normalizeUrl('https://user:pass@a.example'));
});

test('retains order, source records, invalid inputs and duplicates within and across batches', () => {
  const first = importRows([['URL'], ['https://a.example'], ['bad'], ['https://A.example/#top']], 0, true, [], 'first.csv');
  const next = importRows([['note', 'https://a.example/']], 1, false, first, 'next.csv');
  assert.deepEqual([...first, ...next].map(({ number, sourceRow, conclusion }) => [number, sourceRow, conclusion]),
    [[1, 2, '待分析'], [2, 3, '输入无效'], [3, 4, '已跳过'], [4, 1, '已跳过']]);
  assert.match(next[0].reason, /序号 1/);
  assert.equal(next[0].filename, 'next.csv');
});

test('exports the required seven leading columns and escapes untrusted spreadsheet cells', () => {
  const rows = importRows([['=1+1'], ['https://a.example/?q="one"']], 0, false, [], '@batch.csv');
  const [header, first, second] = parseCsv(exportCsv(rows));
  assert.deepEqual(header.slice(0, 7), headings);
  assert.deepEqual(first.slice(0, 7), ['1', '—', '未识别', "'=1+1", '未成功', '输入无效', '请修正原始 HTTP 或 HTTPS 地址。']);
  assert.equal(first[7], "'@batch.csv");
  assert.equal(second[3], rows[1].raw);
});
