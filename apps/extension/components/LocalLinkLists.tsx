import { useEffect, useState } from 'react';
import { MAX_IMPORT_BYTES } from '@urlput/contracts';
import { encodeCsv } from '@urlput/import';
import { browser } from 'wxt/browser';
import { checkLocalLink, isActiveLink, localLinkLists, parseLinkList, renameLinkList, saveLinkSources, type LocalLinkList } from '../lib/local-link-lists';
import { downloadCsv } from '../lib/report';

export function LocalLinkLists({ dir }: { dir: FileSystemDirectoryHandle }) {
  const [lists, setLists] = useState<LocalLinkList[]>([]);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [filename, setFilename] = useState<string>();
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(5);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const list = lists.find(item => item.id === selected);
  const matches = list?.links.filter(link => link.url.toLowerCase().includes(query.trim().toLowerCase())) ?? [];

  useEffect(() => {
    let current = true;
    void localLinkLists(dir).then(data => {
      if (current) setLists(data);
    }).catch(failure => {
      if (current) setError(String(failure));
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [dir]);

  function select(id: string, data = lists) {
    setSelected(id);
    setName(data.find(item => item.id === id)?.name ?? '');
    setQuery('');
    setLimit(5);
  }

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setStatus('');
    try { await action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }

  function exportRows(headings: string[], rows: Array<Array<string | number>>, title: string) {
    downloadCsv(new Blob([encodeCsv(headings, rows)], { type: 'text/csv;charset=utf-8' }), title);
  }

  function exportActive(data: LocalLinkList[]) {
    exportRows(['清单', '来源文件', '来源类型', '来源行', '外链 URL', '域名', '网站类型'],
      data.flatMap(item => item.links.filter(link => isActiveLink(link)).flatMap(link => link.sources.map(source =>
        [item.name, source.filename ?? '', source.source, source.row.sourceLine, link.url, new URL(link.url).hostname, link.type ?? '未识别']))),
      'URLPut-活跃外链.csv');
  }

  return <section className="card stack">
    <h2>本机外链清单</h2>
    {loading && <p role="status">正在读取清单…</p>}
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    <label>选择已保存清单<select value={selected} disabled={loading || busy} onChange={event => select(event.target.value)}>
      <option value="">新建清单</option>
      {lists.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select></label>
    <label>清单名称<input maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
    {list && <button className="secondary" disabled={busy || !name.trim()} onClick={() => void perform(async () => {
      setLists(await renameLinkList(dir, list.id, name));
      setStatus('清单名称已保存。');
    })}>保存名称</button>}
    <label>导入清单文件<input type="file" accept=".csv,.txt" disabled={busy} onChange={event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      void perform(async () => {
        if (file.size > MAX_IMPORT_BYTES) throw new Error('文件过大，请拆分后导入。');
        setText(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()));
        setFilename(file.name);
      });
    }} /></label>
    <label>粘贴外链或表格<textarea rows={4} value={text} disabled={busy} onChange={event => {
      setText(event.target.value);
      setFilename(undefined);
    }} /></label>
    {filename && <p>{filename}</p>}
    <button disabled={loading || busy || !text.trim()} onClick={() => void perform(async () => {
      const result = await saveLinkSources(dir, parseLinkList(text, filename), list?.id, name);
      setLists(result.lists);
      select(result.list.id, result.lists);
      setText('');
      setFilename(undefined);
      const { added, existing, duplicate, invalid } = result.count;
      setStatus(`新增 ${added}，已有 ${existing}，重复 ${duplicate}，问题 ${invalid}。`);
    })}>{list ? '追加到清单' : '保存新清单'}</button>
    <button className="secondary" disabled={busy || !lists.some(item => item.links.some(link => isActiveLink(link)))}
      onClick={() => exportActive(lists)}>导出全部活跃外链</button>
    {list && <>
      <label>搜索清单网址<input value={query} onChange={event => { setQuery(event.target.value); setLimit(5); }} /></label>
      {!matches.length && <p>暂无匹配外链。</p>}
      <ul className="catalog-list">
        {matches.slice(0, limit).map(link => <li key={link.url}>
          <strong>{link.url}</strong>
          <span>{isActiveLink(link) ? '活跃' : link.check?.ok ? '检查已过期' : link.check?.message ?? '已解析，待检查'}</span>
          <span>{link.sources.length} 条来源</span>
          <button className="secondary" disabled={busy} onClick={() => void perform(async () => {
            const target = new URL(link.entry ?? link.url);
            if (!await browser.permissions.request({ origins: [`${target.protocol}//${target.hostname}/*`] })) {
              throw new Error('请授权访问该入口后重试。');
            }
            setLists(await checkLocalLink(dir, list.id, link.url));
          })}>检查入口</button>
        </li>)}
      </ul>
      {matches.length > limit && <button className="secondary" onClick={() => setLimit(count => count + 5)}>显示更多外链</button>}
      <button className="secondary" disabled={busy || !list.links.some(link => isActiveLink(link))}
        onClick={() => exportActive([list])}>导出当前清单活跃外链</button>
      <button className="secondary" disabled={busy || !list.problems.length} onClick={() =>
        exportRows(['来源文件', '原始行号', '原值', '原因'],
          list.problems.map(source => [source.filename ?? '', source.row.sourceLine, source.row.sourceText ?? source.row.url, source.row.reason]),
          'URLPut-外链问题行.csv')}>导出问题行</button>
    </>}
  </section>;
}
