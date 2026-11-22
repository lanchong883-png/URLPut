import { useEffect, useState } from 'react';
import { encodeCsv } from '@urlput/import';
import type { BatchSummary } from '../lib/api';
import { checkPage, checkSegmentSize, observeChecks, type Check } from '../lib/check-queue';
import { downloadCsv } from '../lib/report';

const pageSize = 20;
const labels = { completed: '已分析', issue: '待处理', dismissed: '已跳过' };
type ResultStatus = keyof typeof labels;
type Result = { item: Check; batch: BatchSummary };

function resultStatus(item: Check): ResultStatus {
  return item.ok ? 'completed' : item.dismissed ? 'dismissed' : 'issue';
}

function batchLabel(batch: BatchSummary) {
  return `${new Date(batch.createdAt).toLocaleString()} · ${batch.filename ?? '粘贴'}`;
}

async function* readResults(
  dir: FileSystemDirectoryHandle, site: string, batches: BatchSummary[],
  batchId: string, filter: ResultStatus | 'all', signal?: AbortSignal,
): AsyncGenerator<Result> {
  for (const batch of batches) {
    if (batchId && batch.id !== batchId) continue;
    for (let page = 0; page * checkSegmentSize < batch.rowCount; page++) {
      if (signal?.aborted) return;
      const items = await checkPage(dir, { site, batch: batch.id, analysis: true }, page);
      if (signal?.aborted) return;
      for (const item of items) {
        if (filter === 'all' || resultStatus(item) === filter) yield { item, batch };
      }
    }
  }
}

export function AnalysisResults({ dir, site, batches }: {
  dir: FileSystemDirectoryHandle;
  site: string;
  batches: BatchSummary[];
}) {
  const [open, setOpen] = useState(false);
  const [batchId, setBatchId] = useState('');
  const [filter, setFilter] = useState<ResultStatus | 'all'>('all');
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [rows, setRows] = useState<Result[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => observeChecks(() => setRevision(value => value + 1)), []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError('');
      try {
        const results: Result[] = [];
        let remaining = page * pageSize;
        for await (const result of readResults(dir, site, batches, batchId, filter, controller.signal)) {
          if (remaining > 0) { remaining--; continue; }
          results.push(result);
          if (results.length > pageSize) break;
        }
        if (!controller.signal.aborted) setRows(results);
      } catch (failure) {
        if (!controller.signal.aborted) { setRows([]); setError(String(failure)); }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [open, dir, site, batches, batchId, filter, page, revision]);

  async function exportResults() {
    setExporting(true);
    setError('');
    try {
      const data: (string | number)[][] = [];
      for await (const { item, batch } of readResults(dir, site, batches, batchId, filter)) {
        const analysis = item.analysis;
        data.push([batch.id, batch.filename ?? '粘贴', item.sequence, item.url, labels[resultStatus(item)], item.message,
          analysis?.title ?? '', analysis?.category ?? '未知', analysis?.entry ?? '未知', analysis?.login ?? '未知',
          analysis?.fee ?? '未知', analysis?.required.join('、') || '未知', analysis?.limitations ?? '', analysis?.evidence ?? '', item.at]);
      }
      const csv = encodeCsv(['批次编号', '批次来源', '批次内序号', '网址', '结果', '说明', '标题', '页面分类',
        '入口', '登录', '费用', '必填字段', '限制', '证据', '分析时间'], data);
      downloadCsv(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'URLPut-跨批次网站分析.csv');
    } catch (failure) { setError(String(failure)); }
    finally { setExporting(false); }
  }

  return <details className="card" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>跨批次网站分析</summary>
    <label>分析批次<select value={batchId} onChange={event => { setBatchId(event.target.value); setPage(0); }}>
      <option value="">当前站点的全部批次</option>
      {batches.map(batch => <option key={batch.id} value={batch.id}>{batchLabel(batch)}</option>)}
    </select></label>
    <label>分析结果<select value={filter} onChange={event => {
      setFilter(event.target.value as ResultStatus | 'all'); setPage(0);
    }}>
      <option value="all">全部</option>
      {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    <button disabled={loading || exporting || rows.length === 0} onClick={() => void exportResults()}>导出筛选后的网站分析 CSV</button>
    {error && <p role="alert">{error}</p>}
    {loading ? <p role="status">正在读取分析结果…</p> : <>
      {!rows.length && !error && <p>没有符合条件的分析结果。</p>}
      {rows.slice(0, pageSize).map(({ item, batch }) => <div key={`${batch.id}-${item.sequence}`}>
        <strong>{labels[resultStatus(item)]} · {item.analysis?.title || item.url}</strong>
        <p>{batchLabel(batch)} · 第 {item.sequence} 条 · {item.url}</p>
        <p>{item.message}</p>
        {item.analysis && <dl>
          <dt>页面分类</dt><dd>{item.analysis.category}</dd>
          <dt>投稿入口</dt><dd>{item.analysis.entry}</dd>
          <dt>必填字段</dt><dd>{item.analysis.required.join('、') || '未知'}</dd>
          <dt>登录 / 费用</dt><dd>{item.analysis.login} / {item.analysis.fee}</dd>
          <dt>证据</dt><dd>{item.analysis.evidence}</dd>
          <dt>限制</dt><dd>{item.analysis.limitations}</dd>
        </dl>}
      </div>)}
      {(page > 0 || rows.length > pageSize) && <div className="controls">
        <button disabled={page === 0} onClick={() => setPage(page - 1)}>上一页分析</button>
        <button disabled={rows.length <= pageSize} onClick={() => setPage(page + 1)}>下一页分析</button>
      </div>}
    </>}
  </details>;
}
