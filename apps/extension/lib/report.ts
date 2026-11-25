import type { Workspace } from '@urlput/contracts';
import { encodeCsv } from '@urlput/import';
import type { Batch, BatchRow } from './api';
import { checkPage, checkSegmentSize, type Check } from './check-queue';
import { localReportBatch, type MultiSiteSummary } from './local-directory';
import { conclusion, conclusionLabels } from './comment-evidence';

export type ReportSite = Pick<Workspace['sites'][number], 'name' | 'homepage'>;

const conclusions = { candidate: '待分析', duplicate: '已跳过', invalid: '输入无效' };

export const reportColumns = [
  '序号', '网站域名', '网站分类', 'URL', '结果类别', '结论', '原因与下一步',
  '推广站点', '推广站点网址', '来源行', '投稿入口', '名称', '备注',
];

export function reportCells(row: BatchRow, site: ReportSite) {
  const verified = row.verification;
  const outcome = verified ? conclusionLabels[conclusion(verified)] : row.review ? '待审核' : row.submissionSkippedAt ? '已跳过投稿' : conclusions[row.disposition];
  const evidence = verified ? `${verified.page} · ${verified.target} · ${verified.checkedAt} ${verified.pendingReason ?? ''}` : '';
  const receipt = row.review
    ? `平台回执：${row.review.evidence}（提交于 ${row.review.submittedAt}）` : '';
  const details = verified ? [evidence, receipt].filter(Boolean).join(' · ')
    : row.review ? `平台已接收，等待管理员审核。仅回访原记录。${receipt}` : row.submissionSkippedAt ? `人工跳过于 ${row.submissionSkippedAt}` : row.reason;
  return [
    row.sequence, row.normalizedUrl ? new URL(row.normalizedUrl).hostname : '—', '未识别',
    row.url, row.review ? '提交成功' : '未成功', outcome, details, site.name, site.homepage,
    row.sourceLine, row.entry, row.name, row.notes,
  ];
}

export function downloadLedger(batch: Batch, site: ReportSite) {
  const headings = [...reportColumns, '来源文件'];
  if (batch.source === 'txt') headings.push('原始文本');
  if (batch.snapshot) headings.push('执行方式', '本条文案来源', '关联原始行');
  const hasReceipts = batch.rows.some(row => row.review);
  if (hasReceipts) headings.push('提交时间', '审核回执', '回执登记时间');
  const rows = batch.rows.map(row => {
    const cells = [...reportCells(row, batch.snapshot?.site ?? site), batch.filename ?? ''];
    if (batch.source === 'txt') cells.push(row.sourceText ?? '');
    if (batch.snapshot) cells.push(batch.snapshot.execution, row.draftSource ?? '', JSON.stringify(
      batch.snapshot.sources[row.sequence - 1]?.map(source => ({
        file: source.filename, type: source.source, line: source.row.sourceLine, url: source.row.url,
      })) ?? []));
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

export type MultiSiteReportScope = 'all' | 'accepted' | 'valid' | 'missing' | 'pending';

export async function downloadMultiSiteReport(
  dir: FileSystemDirectoryHandle, snapshot: MultiSiteSummary, siteId: string, scope: MultiSiteReportScope,
) {
  const headings = [...reportColumns, '批次编号', '预期目标', '公开页', '实际目标', '核验时间', '审核回执', '回执登记时间', '本条文案来源', '分析时间', '分析来源批次'];
  const header = encodeCsv(headings, []);
  const data = [header];
  for (const site of snapshot.sites) {
    if (siteId && site.id !== siteId) continue;
    const batch = await localReportBatch(dir, site.id, snapshot.id);
    const rows = [];
    let loadedPage = -1;
    let checks = new Map<number, Check>();
    for (const row of batch.rows) {
      const link = row.verification;
      const status = link ? conclusion(link) : undefined;
      if (scope === 'accepted' && !row.review) continue;
      if (scope === 'pending' && (!row.review || (status && status !== 'pending'))) continue;
      if ((scope === 'valid' || scope === 'missing') && status !== scope) continue;
      const page = Math.floor((row.sequence - 1) / checkSegmentSize);
      if (loadedPage !== page) {
        checks = new Map((await checkPage(dir, { site: site.id, batch: snapshot.id, analysis: true }, page))
          .map(item => [item.sequence, item]));
        loadedPage = page;
      }
      const result = checks.get(row.sequence);
      const cells = reportCells(row, batch.snapshot?.site ?? site);
      if (result && !row.review && !link && !row.submissionSkippedAt) {
        cells[4] = '网站分析';
        cells[5] = result.ok ? '已完成' : result.dismissed ? '已跳过' : '待核对';
        cells[6] = result.message;
      }
      rows.push([
        ...cells, snapshot.id, site.homepage, link?.page ?? '', link?.target ?? '',
        link?.checkedAt ?? '', row.review?.evidence ?? '', row.review?.recordedAt ?? '', row.draftSource ?? '',
        result?.at ?? '', result?.reusedFrom ?? '',
      ]);
    }
    if (rows.length) data.push(encodeCsv(headings, rows).slice(header.length));
  }
  downloadCsv(new Blob(data, { type: 'text/csv;charset=utf-8' }), `URLPut-多站批次-${snapshot.id}.csv`);
}
