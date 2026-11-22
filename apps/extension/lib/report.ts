import type { Workspace } from '@urlput/contracts';
import { encodeCsv } from '@urlput/import';
import type { Batch, BatchRow } from './api';

export type ReportSite = Pick<Workspace['sites'][number], 'name' | 'homepage'>;

const conclusions = { candidate: '待分析', duplicate: '已跳过', invalid: '输入无效' };

export const reportColumns = [
  '序号', '网站域名', '网站分类', 'URL', '结果类别', '结论', '原因与下一步',
  '推广站点', '推广站点网址', '来源行', '投稿入口', '名称', '备注',
];

export function reportCells(row: BatchRow, site: ReportSite) {
  return [
    row.sequence, row.normalizedUrl ? new URL(row.normalizedUrl).hostname : '—', '未识别',
    row.url, row.review ? '提交成功' : '未成功', row.review ? '待审核' : conclusions[row.disposition],
    row.review ? `平台已接收，等待管理员审核。仅回访原记录。回执：${row.review.evidence}（提交于 ${row.review.submittedAt}）` : row.reason, site.name, site.homepage,
    row.sourceLine, row.entry, row.name, row.notes,
  ];
}

export function downloadLedger(batch: Batch, site: ReportSite) {
  const headings = [...reportColumns, '来源文件'];
  if (batch.source === 'txt') headings.push('原始文本');
  const hasReceipts = batch.rows.some(row => row.review);
  if (hasReceipts) headings.push('提交时间', '审核回执', '回执登记时间');
  const rows = batch.rows.map(row => {
    const cells = [...reportCells(row, site), batch.filename ?? ''];
    if (batch.source === 'txt') cells.push(row.sourceText ?? '');
    if (hasReceipts) cells.push(row.review?.submittedAt ?? '', row.review?.evidence ?? '', row.review?.recordedAt ?? '');
    return cells;
  });
  const csv = encodeCsv(headings, rows);
  downloadCsv(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `URLPut-台账-${batch.id}.csv`);
}

export function downloadCsv(file: Blob, filename: string) {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
