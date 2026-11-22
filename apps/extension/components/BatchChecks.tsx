import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { encodeCsv } from '@urlput/import';
import { downloadCsv } from '../lib/report';
import type { Batch } from '../lib/api';
import { checkPage, checkSummary, checkSegmentSize, dismissCheck, enqueue, runQueue, type Check } from '../lib/check-queue';

export function BatchChecks({ dir, site, batch }: { dir: FileSystemDirectoryHandle; site: string; batch: Batch }) {
  const [analysis, setAnalysis] = useState(false);
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [results, setResults] = useState<Check[]>([]);
  const [summary, setSummary] = useState<{ issues: number; problemPages: number[] }>();
  const [issuesOnly, setIssuesOnly] = useState(false);
  const visiblePage = issuesOnly ? summary?.problemPages[page] ?? 0 : page;
  const pages = issuesOnly ? summary?.problemPages.length ?? 0 : Math.ceil(batch.rows.length / checkSegmentSize);
  useEffect(() => {
    let active = true;
    void checkSummary(dir, { site, batch: batch.id, analysis }).then(data => {
      if (active) setSummary(data);
    }).catch(error => { if (active) setStatus(String(error)); });
    return () => { active = false; };
  }, [dir, site, batch.id, analysis, revision]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void checkPage(dir, { site, batch: batch.id, analysis }, visiblePage).then(items => {
      if (active) setResults(items);
    }).catch(error => { if (active) setStatus(String(error)); });
    return () => { active = false; };
  }, [dir, site, batch.id, analysis, visiblePage, revision]);

  async function start(retry?: number) {
    setBusy(true);
    try {
      const candidates = batch.rows.filter(row => row.disposition === 'candidate' && row.normalizedUrl && (retry === undefined || row.sequence === retry));
      if (!candidates.length) throw new Error('当前批次没有可检查的网址。');
      const origins = [...new Set(candidates.map(row => {
        const url = new URL(row.normalizedUrl!);
        return `${url.protocol}//${url.hostname}/*`;
      }))];
      if (!await browser.permissions.request({ origins })) throw new Error('请授权访问所选入口后再开始。');
      await enqueue(dir, { site, batch: batch.id, retry, analysis });
      setStatus('已排队，正在串行处理。');
      await runQueue(dir, () => setRevision(value => value + 1));
      setRevision(value => value + 1);
      setPage(0);
      setStatus('本轮结束。请查看各页检查结果和待处理项。');
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <section className="stack">
    <label>只读任务<select disabled={busy} value={analysis ? 'analysis' : 'check'} onChange={event => {
      setAnalysis(event.target.value === 'analysis'); setPage(0); setStatus(''); setResults([]); setSummary(undefined); setIssuesOnly(false);
    }}><option value="check">网址可访问性检查</option><option value="analysis">网站具体情况分析</option></select></label>
    <button disabled={busy} onClick={() => void start()}>加入只读检查队列</button>
    {analysis && summary && <button disabled={busy} onClick={async () => {
      setBusy(true);
      try {
        const rows: string[][] = [];
        for (let index = 0; index * checkSegmentSize < batch.rows.length; index++) {
          for (const item of await checkPage(dir, { site, batch: batch.id, analysis }, index)) {
            const data = item.analysis;
            if (item.ok && data) rows.push([item.url, data.title, data.category, data.entry, data.login, data.fee,
              data.required.join('、'), data.limitations, data.evidence, item.at]);
          }
        }
        const csv = encodeCsv(['网址', '标题', '页面分类', '入口', '登录', '费用', '必填字段', '限制', '证据', '分析时间'], rows);
        downloadCsv(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'URLPut-已完成网站分析.csv');
      } catch (error) { setStatus(String(error)); }
      finally { setBusy(false); }
    }}>导出已完成网站分析 CSV</button>}
    {status && <p role="status">{status}</p>}
    {summary && <label><input type="checkbox" checked={issuesOnly} onChange={event => {
      setIssuesOnly(event.target.checked); setPage(0);
    }} /> 只看待处理项（{summary.issues}）</label>}
    {results.filter(item => !issuesOnly || (!item.ok && !item.dismissed)).map(item => <div key={item.sequence}>
      <strong>{item.ok ? '已检查' : item.dismissed ? '已跳过' : '待处理'} · 第 {item.sequence} 条</strong>
      <p>{item.url}</p><p>{item.message}</p>
      {item.analysis && <dl>
        <dt>页面</dt><dd>{item.analysis.title || '无标题'} · {item.analysis.category}</dd>
        <dt>投稿入口</dt><dd>{item.analysis.entry}</dd>
        <dt>必填字段</dt><dd>{item.analysis.required.join('、') || '未观察到'}</dd>
        <dt>登录 / 费用</dt><dd>{item.analysis.login} / {item.analysis.fee}</dd>
        <dt>证据</dt><dd>{item.analysis.evidence}</dd><dt>限制</dt><dd>{item.analysis.limitations}</dd>
      </dl>}
      {!item.ok && !item.dismissed && <div className="controls"><button className="secondary" disabled={busy} onClick={() => void start(item.sequence)}>恢复此条</button>
        <button className="secondary" disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            await dismissCheck(dir, { site, batch: batch.id, analysis }, item.sequence, batch.rows.length);
            setPage(0);
            setRevision(value => value + 1);
          } catch (error) { setStatus(String(error)); }
          finally { setBusy(false); }
        }}>确认跳过</button></div>}
    </div>)}
    {pages > 1 && <div className="controls">
      <button disabled={!page} onClick={() => setPage(page - 1)}>上一组结果</button>
      <span>{page + 1} / {pages}</span>
      <button disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>下一组结果</button>
    </div>}
  </section>;
}
