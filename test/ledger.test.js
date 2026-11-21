import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportCsv, headings, importRows, normalizeUrl, parseCsv, parseText } from '../extension/ledger.js';

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

test('extracts multiple links from text and retains original line numbers and notes', () => {
  const text = '\uFEFF来源 https://a.example/path?q=a,b；备用 https://b.example/。\r\n\r\n无效地址\rhttps://A.example/path?q=a,b#copy';
  const rows = importRows(parseText(text), 0, false, [], '来源.txt');
  assert.deepEqual(rows.map(({ raw, sourceRow, conclusion }) => [raw, sourceRow, conclusion]), [
    ['https://a.example/path?q=a,b', 1, '待分析'],
    ['https://b.example/', 1, '待分析'],
    ['无效地址', 3, '输入无效'],
    ['https://A.example/path?q=a,b#copy', 4, '已跳过']
  ]);
  const [header, first] = parseCsv(exportCsv(rows));
  assert.deepEqual(header.slice(0, 7), headings);
  assert.deepEqual(first.slice(-3), ['来源.txt', '1', '来源 https://a.example/path?q=a,b；备用 https://b.example/。']);
});

test('pasted text and mapped spreadsheet columns share the CSV duplicate history', () => {
  const existing = importRows(parseCsv('URL\nhttps://a.example/'), 0, true, [], 'existing.csv');
  const pasted = importRows(parseText('https://b.example'), 0, false, existing, '粘贴');
  const table = importRows(parseCsv('备注\t网址\n重复\thttps://B.example/#copy', '\t'), 1, true, [...existing, ...pasted], '粘贴');
  assert.equal(table[0].number, 3);
  assert.equal(table[0].sourceRow, 2);
  assert.equal(table[0].conclusion, '已跳过');
  assert.match(table[0].reason, /序号 2/);
});
