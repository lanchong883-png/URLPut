import { useEffect, useState } from 'react';
import { draftTemplates, saveDraftTemplate, type DraftTemplate } from '../lib/draft-config';

export function DraftTemplates({ dir }: { dir: FileSystemDirectoryHandle }) {
  const [templates, setTemplates] = useState<DraftTemplate[]>([]);
  const [editing, setEditing] = useState<DraftTemplate>();
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void draftTemplates(dir).then(items => { if (active) setTemplates(items); })
      .catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [dir]);

  return <section className="card stack">
    <h2>本机内容模板</h2>
    {error && <p role="alert">{error}</p>}
    {status && <p role="status">{status}</p>}
    <label>选择要编辑的模板<select disabled={busy} value={editing?.id ?? ''} onChange={event =>
      setEditing(templates.find(item => item.id === event.target.value))}>
      <option value="">请选择</option>
      {templates.map(item => <option key={item.id} value={item.id}>{item.category} · {item.name}</option>)}
    </select></label>
    <button type="button" className="secondary" disabled={busy} onClick={() => {
      setEditing({ id: crypto.randomUUID(), revision: 0, category: '通用文案', name: '', body: '' });
      setStatus('');
      setError('');
    }}>新增内容模板</button>
    {editing && <form className="stack" onSubmit={async event => {
      event.preventDefault();
      setBusy(true);
      setError('');
      setStatus('');
      try {
        const updated = await saveDraftTemplate(dir, editing);
        setTemplates(updated);
        setEditing(updated.find(item => item.id === editing.id));
        setStatus('模板新版本已保存。');
      } catch (failure) { setError(String(failure)); }
      finally { setBusy(false); }
    }}>
      <label>分类<input required maxLength={80} value={editing.category} onChange={event => setEditing({ ...editing, category: event.target.value })} /></label>
      <label>模板名称<input required maxLength={120} value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })} /></label>
      <label>模板内容<textarea required maxLength={5000} value={editing.body} onChange={event => setEditing({ ...editing, body: event.target.value })} /></label>
      <p>可用变量 {'{{站点名称}}'}、{'{{站点网址}}'}。</p>
      <button disabled={busy}>保存模板版本</button>
    </form>}
  </section>;
}
