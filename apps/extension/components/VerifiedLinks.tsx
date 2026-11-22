import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { encodeCsv, normalizeUrl } from '@urlput/import';
import { publicRequest, PublicHttpError } from '../lib/check-queue';
import { findCommentLink, htmlChunks, type Evidence } from '../lib/comment-evidence';
import { read, write } from '../lib/local-directory';
import { downloadCsv, type ReportSite } from '../lib/report';

type LinkRecord = Evidence & { firstVerifiedAt?: string; lastValidAt?: string; missingStatus?: number };

export function VerifiedLinks({ dir, site }: { dir: FileSystemDirectoryHandle; site: ReportSite & { id: string } }) {
  const [items, setItems] = useState<LinkRecord[]>([]);
  const [status, setStatus] = useState('');
  const [filter, setFilter] = useState('all');
  const [offset, setOffset] = useState(0);
  const filtered = items.filter(item => filter === 'all' || (filter === 'missing') === Boolean(item.missingStatus));
  const [busy, setBusy] = useState(false);
  const file = site.id + '.verified.json';
  useEffect(() => {
    let active = true;
    void read<LinkRecord[]>(dir, file).then(rows => { if (active) setItems(rows ?? []); })
      .catch(err => { if (active) setStatus(String(err)); });
    return () => { active = false; };
  }, [dir, file]);

  async function verify(data: FormData) {
    setBusy(true);
    setStatus('');
    try {
      const page = new URL(String(data.get('page')));
      const target = new URL(String(data.get('target')));
      const source = normalizeUrl(page.href);
      if (!source || !page.hash || !normalizeUrl(target.href)) throw new Error('请填写公开评论定位链接和有效的预期目标网址。');
      if (!await browser.permissions.request({ origins: [`${page.protocol}//${page.hostname}/*`] })) throw new Error('需要读取该公开页面的授权。');
      await navigator.locks.request('urlput-active-url', async () => {
        const existing = await read<LinkRecord[]>(dir, file) ?? [];
        const previous = existing.find(item => item.page === page.href && item.target === target.href);
        let result: LinkRecord;
        try {
          const response = await publicRequest(source, 'GET');
          result = await findCommentLink(htmlChunks(response), page, target.href);
          result.firstVerifiedAt = previous?.firstVerifiedAt ?? previous?.checkedAt ?? result.checkedAt;
          result.lastValidAt = result.checkedAt;
        } catch (error) {
          if (!previous || !(error instanceof PublicHttpError) || ![404, 410].includes(error.status)) throw error;
          result = { ...previous, firstVerifiedAt: previous.firstVerifiedAt ?? previous.checkedAt,
            lastValidAt: previous.lastValidAt ?? previous.checkedAt, checkedAt: new Date().toISOString(), missingStatus: error.status };
        }
        const next = [result, ...existing.filter(item => item.page !== result.page || item.target !== result.target)];
        await write(dir, file, next);
        setItems(next);
        setOffset(0);
      });
      setStatus('已核验并保存。');
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  function exportLinks() {
    const csv = encodeCsv(['推广站点', '公开记录', '实际目标', '链接属性', '锚文本', '核验时间', '结论', '首次核验时间', '最近有效时间', '回访 HTTP 状态'],
      filtered.map(item => [site.name, item.page, item.target, item.rel, item.anchor, item.checkedAt, item.missingStatus ? '公开页失效' : '有效外链',
        item.firstVerifiedAt ?? item.checkedAt, item.lastValidAt ?? item.checkedAt, item.missingStatus ?? '']));
    downloadCsv(new Blob([csv], { type: 'text/csv;charset=utf-8' }), 'URLPut-已核验外链.csv');
  }

  return <details className="card">
    <summary>已核验外链台账（{items.length}）</summary>
    <form className="stack" onSubmit={event => { event.preventDefault(); void verify(new FormData(event.currentTarget)); }}>
      <label>公开评论定位链接<input type="url" required name="page" placeholder="https://example.org/article#comment123" /></label>
      <label>预期目标网址<input type="url" required name="target" defaultValue={site.homepage} /></label>
      <button disabled={busy}>{busy ? '正在核验…' : '只读核验并保存'}</button>
    </form>
    {status && <p role="status">{status}</p>}
    {items.length > 0 && <label>核验结论<select value={filter} onChange={event => { setFilter(event.target.value); setOffset(0); }}>
      <option value="all">全部</option><option value="valid">有效外链</option><option value="missing">公开页失效</option>
    </select></label>}
    {filtered.length > 0 && <button onClick={exportLinks}>导出已核验外链 CSV</button>}
    {filtered.slice(offset, offset + 20).map(item => <p key={JSON.stringify([item.page, item.target])}>{item.missingStatus ? `公开页失效（HTTP ${item.missingStatus}）` : '有效外链'} · {item.page} → {item.target} · {item.rel || '无 rel 属性'} · {item.checkedAt}</p>)}
    {filtered.length > 20 && <div className="controls">
      <button disabled={!offset} onClick={() => setOffset(offset - 20)}>上一页</button>
      <button disabled={offset + 20 >= filtered.length} onClick={() => setOffset(offset + 20)}>下一页</button>
    </div>}
  </details>;
}
