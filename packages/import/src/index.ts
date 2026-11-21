import { parse } from 'csv-parse/browser/esm/sync';
import ipaddr from 'ipaddr.js';
import { MAX_IMPORT_BYTES, MAX_ROWS, type ImportBatch } from '@urlput/contracts';

export type Delimiter = ',' | ';' | '\t';
export type ColumnMapping = { url: number; entry?: number; name?: number; notes?: number };

type RawRecord = { record: string[]; raw: string };

export function readTable(text: string, delimiter: Delimiter) {
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) {
    throw new Error('输入超过 2 MB，请拆分后导入。');
  }
  const records = parse(text, {
    bom: true,
    delimiter,
    raw: true,
    relax_column_count: true,
    max_record_size: 65_536,
    to: MAX_ROWS + 2,
  }) as unknown as RawRecord[];
  if (records.length > MAX_ROWS + 1) throw new Error('每批最多导入 5,000 行数据。');

  let sourceLine = 1;
  return records.map(({ record, raw }) => {
    const row = { cells: record, sourceLine };
    sourceLine += [...raw.matchAll(/\r\n|\r|\n/g)].length;
    return row;
  }).filter(({ cells }) => cells.some(cell => cell.trim()));
}

export function mapRows(table: ReturnType<typeof readTable>, mapping: ColumnMapping, header: boolean): ImportBatch['rows'] {
  return table.slice(header ? 1 : 0).map(({ cells, sourceLine }) => ({
    sourceLine,
    url: cells[mapping.url] ?? '',
    entry: mapping.entry === undefined ? '' : cells[mapping.entry] ?? '',
    name: mapping.name === undefined ? '' : cells[mapping.name] ?? '',
    notes: mapping.notes === undefined ? '' : cells[mapping.notes] ?? '',
  }));
}

export function normalizeUrl(raw: string): string | undefined {
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value)) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;

  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (ipaddr.isValid(host)) {
    if (ipaddr.process(host).range() !== 'unicast') return;
  } else if (!host.includes('.') || /\.(?:localhost|local|internal|home\.arpa)$/.test(host)) {
    return;
  } else {
    url.hostname = host;
  }
  url.hash = '';
  return url.href;
}

export type LedgerRow = ImportBatch['rows'][number] & {
  sequence: number;
  normalizedUrl?: string;
  normalizedEntry?: string;
  disposition: 'candidate' | 'duplicate' | 'invalid';
  duplicateOf?: number;
  reason: string;
};

export function buildLedger(rows: ImportBatch['rows']): LedgerRow[] {
  const firstOccurrences = new Map<string, number>();
  return rows.map((row, index) => {
    const sequence = index + 1;
    const normalizedUrl = normalizeUrl(row.url);
    const normalizedEntry = row.entry.trim() ? normalizeUrl(row.entry) : undefined;
    const base = { ...row, sequence, normalizedUrl, normalizedEntry };
    if (!normalizedUrl || (row.entry.trim() && !normalizedEntry)) {
      return {
        ...base,
        disposition: 'invalid',
        reason: normalizedUrl ? '投稿入口不是可用的 HTTP/HTTPS 地址。' : '请输入可用的 HTTP/HTTPS 地址。',
      };
    }
    const key = JSON.stringify([normalizedUrl, normalizedEntry]);
    const duplicateOf = firstOccurrences.get(key);
    if (duplicateOf !== undefined) {
      return { ...base, disposition: 'duplicate', duplicateOf, reason: `重复候选，关联第 ${duplicateOf} 条。` };
    }
    firstOccurrences.set(key, sequence);
    return { ...base, disposition: 'candidate', reason: '待分析' };
  });
}
