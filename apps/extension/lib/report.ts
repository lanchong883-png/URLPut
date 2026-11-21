import type { Workspace } from '@urlput/contracts';
import type { LedgerRow } from '@urlput/import';
import type { Batch } from './api';

export type ReportSite = Pick<Workspace['sites'][number], 'name' | 'homepage'>;

const conclusions = { candidate: '待分析', duplicate: '已跳过', invalid: '输入无效' };

export const reportColumns = [
  '序号', '网站域名', '网站分类', 'URL', '结果类别', '结论', '原因与下一步',
  '推广站点', '推广站点网址', '来源行', '投稿入口', '名称', '备注',
];

export function reportCells(row: LedgerRow, site: ReportSite) {
  return [
    row.sequence, row.normalizedUrl ? new URL(row.normalizedUrl).hostname : '—', '未识别',
    row.url, '未成功', conclusions[row.disposition], row.reason, site.name, site.homepage,
    row.sourceLine, row.entry, row.name, row.notes,
  ];
}

export function downloadLedger(batch: Batch, site: ReportSite) {
  const headings = [...reportColumns, '来源文件'];
  const rows = batch.rows.map(row => [...reportCells(row, site), batch.filename ?? '']);
  const csv = '\uFEFF' + [headings, ...rows].map(row => row.map(value => {
    const text = String(value);
    const safe = /^[\t\r\n]|^\s*[=+@-]/.test(text) ? "'" + text : text;
    return '"' + safe.replaceAll('"', '""') + '"';
  }).join(',')).join('\r\n') + '\r\n';

  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `URLPut-台账-${batch.id}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
