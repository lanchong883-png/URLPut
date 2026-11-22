import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type { Batch } from '../lib/api';
import { checkPage, checkSummary, checkSegmentSize, dismissCheck, enqueue, runQueue, type Check } from '../lib/check-queue';

export function BatchChecks({ dir, site, batch }: { dir: FileSystemDirectoryHandle; site: string; batch: Batch }) {
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [results, setResults] = useState<Check[]>([]);
  const [summary, setSummary] = useState<{ issues: number; problemPages: number[] }>();
  const [issuesOnly, setIssuesOnly] = useState(false);
  const visiblePage = issuesOnly ? summary?.problemPages[page] ?? 0 : page;
  const pages = issuesOnly ? summary?.problemPages.length ?? 0 : Math.ceil(batch.rows.length / checkSegmentSize);
  useEffect(() => {
    let active = true;
    void checkSummary(dir, { site, batch: batch.id }).then(data => {
      if (active) setSummary(data);
    }).catch(error => { if (active) setStatus(String(error)); });
    return () => { active = false; };
  }, [dir, site, batch.id, revision]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void checkPage(dir, { site, batch: batch.id }, visiblePage).then(items => {
      if (active) setResults(items);
    }).catch(error => { if (active) setStatus(String(error)); });
    return () => { active = false; };
  }, [dir, site, batch.id, visiblePage, revision]);

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
      await enqueue(dir, { site, batch: batch.id, retry });
      setStatus('已排队，正在串行处理。');
      await runQueue(dir, () => setRevision(value => value + 1));
      setRevision(value => value + 1);
      setPage(0);
      setStatus('本轮结束。请查看各页检查结果和待处理项。');
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  return <section className="stack">
    <h2>网址可访问性检查</h2>
    <button disabled={busy} onClick={() => void start()}>加入只读检查队列</button>
    {status && <p role="status">{status}</p>}
    {summary && <label><input type="checkbox" checked={issuesOnly} onChange={event => {
      setIssuesOnly(event.target.checked); setPage(0);
    }} /> 只看待处理项（{summary.issues}）</label>}
    {results.filter(item => !issuesOnly || (!item.ok && !item.dismissed)).map(item => <div key={item.sequence}>
      <strong>{item.ok ? '已检查' : item.dismissed ? '已跳过' : '待处理'} · 第 {item.sequence} 条</strong>
      <p>{item.url}</p><p>{item.message}</p>
      {!item.ok && !item.dismissed && <div className="controls"><button className="secondary" disabled={busy} onClick={() => void start(item.sequence)}>恢复此条</button>
        <button className="secondary" disabled={busy} onClick={async () => {
          setBusy(true);
          try {
            await dismissCheck(dir, { site, batch: batch.id }, item.sequence, batch.rows.length);
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
