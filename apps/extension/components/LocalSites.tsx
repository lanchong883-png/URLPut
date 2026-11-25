import { useState } from 'react';
import type { Workspace } from '@urlput/contracts';
import { updateLocalSite } from '../lib/local-directory';

export function LocalSites({ dir, workspace, onChange }: {
  dir: FileSystemDirectoryHandle;
  workspace: Workspace;
  onChange: (workspace: Workspace) => void;
}) {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(5);
  const [editing, setEditing] = useState('');
  const [name, setName] = useState('');
  const [homepage, setHomepage] = useState('');
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const matches = workspace.sites.filter(site => !site.inactive &&
    `${site.name} ${site.homepage}`.toLowerCase().includes(query.trim().toLowerCase()));

  async function save(remove: boolean) {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      onChange(await updateLocalSite(dir, editing, remove ? { inactive: true } : { name, homepage }));
      setEditing('');
      setRemoving(false);
      setStatus(remove ? '站点已撤下，历史记录仍可在任务中查看。' : '推广站点已保存。');
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  }

  return <section className="card stack">
    <h2>管理本机推广站点</h2>
    <label>搜索推广站点<input value={query} onChange={event => { setQuery(event.target.value); setLimit(5); }} /></label>
    {status && <p role="status">{status}</p>}
    {error && <p role="alert">{error}</p>}
    {!matches.length && <p>暂无匹配站点。</p>}
    <ul className="catalog-list">
      {matches.slice(0, limit).map(site => <li key={site.id}>
        <strong>{site.name}</strong><span>{site.homepage}</span>
        <button className="secondary" disabled={busy} onClick={() => {
          setEditing(site.id);
          setName(site.name);
          setHomepage(site.homepage);
          setRemoving(false);
          setError('');
          setStatus('');
        }}>查看／编辑 {site.name}</button>
      </li>)}
    </ul>
    {matches.length > limit && <button className="secondary" onClick={() => setLimit(count => count + 5)}>显示更多站点</button>}
    {editing && <form className="stack" onSubmit={event => { event.preventDefault(); void save(false); }}>
      <label>站点名称<input required maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <label>站点网址<input required type="url" value={homepage} disabled={busy} onChange={event => setHomepage(event.target.value)} /></label>
      <button disabled={busy || removing}>保存站点修改</button>
      {removing ? <>
        <p>确认撤下「{name}」？现有批次与结果将保留。</p>
        <button type="button" disabled={busy} onClick={() => void save(true)}>确认撤下</button>
      </> : <button type="button" className="secondary" disabled={busy} onClick={() => setRemoving(true)}>撤下站点</button>}
      <button type="button" className="secondary" disabled={busy} onClick={() => setEditing('')}>取消编辑</button>
    </form>}
  </section>;
}
