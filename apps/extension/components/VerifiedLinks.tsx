import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { encodeCsv, normalizeUrl } from '@urlput/import';
import { publicRequest } from '../lib/check-queue';
import { findCommentLink, htmlChunks, type Evidence } from '../lib/comment-evidence';
import { read, write } from '../lib/local-directory';
import { downloadCsv, type ReportSite } from '../lib/report';

export function VerifiedLinks({ dir, site }: { dir: FileSystemDirectoryHandle; site: ReportSite & { id: string } }) {
  const [items, setItems] = useState<Evidence[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const file = site.id + '.verified.json';
  useEffect(() => {
    let active = true;
    void read<Evidence[]>(dir, file).then(rows => { if (active) setItems(rows ?? []); })
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
        const response = await publicRequest(source, 'GET');
        const result = await findCommentLink(htmlChunks(response), page, target.href);
        const existing = await read<Evidence[]>(dir, file) ?? [];
        const next = [result, ...existing.filter(item => item.page !== result.page || item.target !== result.target)];
        await write(dir, file, next);
        setItems(next);
      });
      setStatus('已核验并保存。');
    } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  function exportLinks() {
    const csv = encodeCsv(['推广站点', '公开记录', '实际目标', '链接属性', '锚文本', '核验时间', '结论'],
      items.map(item => [site.name, item.page, item.target, item.rel, item.anchor, item.checkedAt, '有效外链']));
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
    {items.length > 0 && <button onClick={exportLinks}>导出已核验外链 CSV</button>}
    {items.slice(0, 20).map(item => <p key={JSON.stringify([item.page, item.target])}>{item.page} → {item.target} · {item.rel || '无 rel 属性'} · {item.checkedAt}</p>)}
  </details>;
}
