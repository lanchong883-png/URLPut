import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { encodeCsv, normalizeUrl } from '@urlput/import';
import { publicRequest, PublicHttpError } from '../lib/check-queue';
import { CommentLinkUnconfirmed, findCommentLink, htmlChunks, conclusion, conclusionLabels as labels, type Conclusion, type LinkRecord } from '../lib/comment-evidence';
import { activeUrlLock, localBatch, saveVerificationLedger, verificationLedger, type RevisitQueue } from '../lib/local-directory';
import { downloadCsv, type ReportSite } from '../lib/report';
import type { Batch } from '../lib/api';

function message(error: unknown) {
  if (error instanceof DOMException && error.name === 'TimeoutError') return '回访超时。';
  if (error instanceof TypeError) return '无法连接，请核对网址、网络和访问授权。';
  return error instanceof Error ? error.message : String(error);
}

function verificationInput(pageUrl: string, targetUrl: string) {
  const page = new URL(pageUrl);
  const target = new URL(targetUrl);
  const source = normalizeUrl(page.href);
  if (!source || !page.hash || !normalizeUrl(target.href)) throw new Error('请填写公开评论定位链接和有效的预期目标网址。');
  return { page, target, source, origin: `${page.protocol}//${page.hostname}/*` };
}

export function VerifiedLinks({ dir, site, batch, onUpdate }: {
  dir: FileSystemDirectoryHandle;
  site: ReportSite & { id: string };
  batch?: Batch;
  onUpdate: () => Promise<void>;
}) {
  const [items, setItems] = useState<LinkRecord[]>([]);
  const [status, setStatus] = useState('');
  const [filter, setFilter] = useState<Conclusion | 'all'>('all');
  const [offset, setOffset] = useState(0);
  const filtered = items.filter(item => filter === 'all' || filter === conclusion(item));
  const [busy, setBusy] = useState(false);
  const [revisit, setRevisit] = useState<RevisitQueue>();
  useEffect(() => {
    let active = true;
    void verificationLedger(dir, site.id).then(ledger => {
      if (!active) return;
      setItems(ledger.links);
      setRevisit(ledger.revisit);
    })
      .catch(err => { if (active) setStatus(String(err)); });
    return () => { active = false; };
  }, [dir, site.id]);

  async function saveVerification(page: URL, target: URL, source: string, sequence?: number, queue?: RevisitQueue) {
    return navigator.locks.request(activeUrlLock, async () => {
      const ledger = await verificationLedger(dir, site.id);
      const existing = ledger.links;
      const receipt = sequence === undefined || !batch ? undefined : { batch: batch.id, sequence };
      if (receipt) {
        const saved = await localBatch(dir, site.id, receipt.batch);
        const row = saved.rows.find(item => item.sequence === receipt.sequence);
        const rowHost = row?.normalizedUrl && new URL(row.normalizedUrl).hostname;
        const entryHost = row?.normalizedEntry && new URL(row.normalizedEntry).hostname;
        if (!row?.review || (page.hostname !== rowHost && page.hostname !== entryHost)) {
          throw new Error('请提供与所选待审核记录同站点的公开评论链接。');
        }
      }
      const previous = existing.find(item => item.page === page.href && item.target === target.href);
      let result: LinkRecord;
      try {
        const response = await publicRequest(source, 'GET');
        result = await findCommentLink(htmlChunks(response), page, target.href);
        result.firstVerifiedAt = previous?.firstVerifiedAt ?? previous?.checkedAt ?? result.checkedAt;
        result.lastValidAt = result.checkedAt;
      } catch (error) {
        if (!previous) throw error;
        const missingStatus = error instanceof PublicHttpError && [404, 410].includes(error.status) ? error.status : undefined;
        const pendingReason = error instanceof CommentLinkUnconfirmed ? error.message : undefined;
        result = missingStatus || pendingReason
          ? { ...previous, firstVerifiedAt: previous.firstVerifiedAt ?? previous.checkedAt,
            lastValidAt: previous.lastValidAt ?? previous.checkedAt, checkedAt: new Date().toISOString(),
            missingStatus, pendingReason, revisitError: undefined }
          : { ...previous, revisitError: { at: new Date().toISOString(), reason: message(error) } };
      }
      result.receipts = previous?.receipts;
      if (receipt && !result.revisitError && !result.receipts?.some(item => item.batch === receipt.batch && item.sequence === receipt.sequence)) {
        result.receipts = [...result.receipts ?? [], receipt];
      }
      const next = [result, ...existing
        .filter(item => item.page !== result.page || item.target !== result.target)
        .map(item => receipt && !result.revisitError && item.receipts?.some(link => link.batch === receipt.batch && link.sequence === receipt.sequence)
          ? { ...item, receipts: item.receipts.filter(link => link.batch !== receipt.batch || link.sequence !== receipt.sequence) }
          : item)];
      ledger.links = next;
      if (queue) {
        const nextIndex = queue.next + 1;
        const problems = queue.problems + Number(Boolean(result.revisitError));
        ledger.revisit = nextIndex < queue.entries.length ? { ...queue, next: nextIndex, problems } : undefined;
      }
      await saveVerificationLedger(dir, site.id, ledger);
      setItems(next);
      setRevisit(ledger.revisit);
      return { result, revisit: ledger.revisit };
    });
  }

  async function verify(pageUrl: string, targetUrl: string, sequence?: number) {
    setBusy(true);
    setStatus('');
    try {
      const { page, target, source, origin } = verificationInput(pageUrl, targetUrl);
      if (!await browser.permissions.request({ origins: [origin] })) throw new Error('需要读取该公开页面的授权。');
      const { result } = await saveVerification(page, target, source, sequence);
      setOffset(0);
      await onUpdate();
      if (result.revisitError) setStatus(`已保存本次回访问题：${result.revisitError.reason}`);
      else setStatus(result.pendingReason ? '已保存待核实结果及上次有效证据。' : '已核验并保存。');
    } catch (error) { setStatus(message(error)); }
    finally { setBusy(false); }
  }

  async function revisitFiltered(resume?: RevisitQueue) {
    setBusy(true);
    setStatus('');
    try {
      const entries = resume?.entries ?? filtered.map(({ page, target }) => ({ page, target }));
      const origins = [...new Set(entries.slice(resume?.next ?? 0).map(item => verificationInput(item.page, item.target).origin))];
      if (!await browser.permissions.request({ origins })) throw new Error('需要读取待回访的公开页面。');
      await navigator.locks.request('urlput-revisit-' + site.id, { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('此站点已有窗口正在批量回访。');
        let queue = await navigator.locks.request(activeUrlLock, async () => {
          const ledger = await verificationLedger(dir, site.id);
          setItems(ledger.links);
          setRevisit(ledger.revisit);
          if (ledger.revisit?.id !== resume?.id) throw new Error('回访进度已更新，请按当前队列继续。');
          if (ledger.revisit) return ledger.revisit;
          const started = { id: crypto.randomUUID(), entries, next: 0, problems: 0 };
          await saveVerificationLedger(dir, site.id, { ...ledger, revisit: started });
          setRevisit(started);
          return started;
        });
        const total = queue.entries.length;
        let problems = queue.problems;
        while (queue.next < total) {
          const entry = queue.entries[queue.next];
          setStatus(`正在回访第 ${queue.next + 1} / ${total} 条…`);
          const { page, target, source } = verificationInput(entry.page, entry.target);
          const saved = await saveVerification(page, target, source, undefined, queue);
          problems += Number(Boolean(saved.result.revisitError));
          if (!saved.revisit) break;
          queue = saved.revisit;
        }
        setOffset(0);
        await onUpdate();
        setStatus(`已回访 ${total} 条，${problems} 条遇到访问问题。`);
      });
    } catch (error) { setStatus(message(error)); }
    finally { setBusy(false); }
  }

  function exportLinks() {
    const csv = encodeCsv(['推广站点', '公开记录', '实际目标', '链接属性', '锚文本', '核验时间', '结论', '首次核验时间', '最近有效时间', '回访 HTTP 状态', '待核实原因', '访问问题时间', '访问问题原因'],
      filtered.map(item => [site.name, item.page, item.target, item.rel, item.anchor, item.checkedAt, labels[conclusion(item)],
        item.firstVerifiedAt ?? item.checkedAt, item.lastValidAt ?? item.checkedAt, item.missingStatus ?? '', item.pendingReason ?? '', item.revisitError?.at ?? '', item.revisitError?.reason ?? '']));
    downloadCsv(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'URLPut-已核验外链.csv');
  }

  return <details className="card">
    <summary>已核验外链台账（{items.length}）</summary>
    <form className="stack" onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const selected = data.get('review');
      void verify(String(data.get('page')), String(data.get('target')), selected ? Number(selected) : undefined);
    }}>
      <label>公开评论定位链接<input type="url" required name="page" placeholder="https://example.org/article#comment123" /></label>
      <label>预期目标网址<input type="url" required name="target" defaultValue={site.homepage} /></label>
      {batch?.rows.some(row => row.review) && <label>关联当前批次回执<select key={batch.id} name="review">
        <option value="">独立核验</option>
        {batch.rows.filter(row => row.review).map(row =>
          <option key={row.sequence} value={row.sequence}>第 {row.sequence} 条 · {row.url}</option>)}
      </select></label>}
      <button disabled={busy}>{busy ? '正在核验…' : '只读核验并保存'}</button>
    </form>
    {status && <p role="status">{status}</p>}
    {items.length > 0 && <label>核验结论<select value={filter} onChange={event => { setFilter(event.target.value as Conclusion | 'all'); setOffset(0); }}>
      <option value="all">全部</option><option value="valid">有效外链</option><option value="missing">公开页失效</option><option value="pending">待核实</option>
    </select></label>}
    {revisit && <button disabled={busy} onClick={() => void revisitFiltered(revisit)}>
      继续批量回访（已完成 {revisit.next} / {revisit.entries.length} 条）
    </button>}
    {filtered.length > 0 && <div className="controls">
      <button onClick={exportLinks}>导出已核验外链 CSV</button>
      <button disabled={busy || Boolean(revisit)} onClick={() => void revisitFiltered()}>回访筛选结果（{filtered.length}）</button>
    </div>}
    {filtered.slice(offset, offset + 20).map(item => <div key={JSON.stringify([item.page, item.target])}>
      <p>{labels[conclusion(item)]}{item.missingStatus ? `（HTTP ${item.missingStatus}）` : ''} · {item.page} → {item.target}
        {' · '}{item.rel || '无 rel 属性'} · {item.checkedAt}</p>
      {item.pendingReason && <p>{item.pendingReason} 最近确认有效于 {item.lastValidAt}。</p>}
      {item.revisitError && <p>最近访问问题 · {item.revisitError.reason} · {item.revisitError.at}</p>}
      <button type="button" disabled={busy} onClick={() => void verify(item.page, item.target)}>回访此条</button>
    </div>)}
    {filtered.length > 20 && <div className="controls">
      <button disabled={!offset} onClick={() => setOffset(offset - 20)}>上一页</button>
      <button disabled={offset + 20 >= filtered.length} onClick={() => setOffset(offset + 20)}>下一页</button>
    </div>}
  </details>;
}
