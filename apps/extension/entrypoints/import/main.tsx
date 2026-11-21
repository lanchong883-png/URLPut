import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { importBatchSchema, MAX_IMPORT_BYTES, type ImportBatch, type Workspace } from '@urlput/contracts';
import { buildLedger, mapRows, readTable, type ColumnMapping, type Delimiter, type LedgerRow } from '@urlput/import';
import { auth, request, requestConfiguredAccess, type Batch, type BatchSummary } from '../../lib/api';
import { ModelSettings } from './ModelSettings';
import './style.css';

const fields: Record<keyof ColumnMapping, string> = { url: '候选网址', entry: '投稿入口', name: '名称', notes: '备注' };
const defaultMapping: ColumnMapping = { url: 0 };
const displayLimit = 200;
const label = { candidate: '候选', duplicate: '重复', invalid: '无效' };

function message(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请重试。';
}

function RowTable({ rows }: { rows: LedgerRow[] }) {
  const [page, setPage] = useState(0);
  const current = Math.min(page, Math.max(0, Math.ceil(rows.length / displayLimit) - 1));
  const start = current * displayLimit;
  const end = Math.min(start + displayLimit, rows.length);
  if (!rows.length) return null;
  return <>
    <div className="table"><table>
      <thead><tr><th>序号</th><th>来源行</th><th>候选网址</th><th>投稿入口</th><th>状态</th><th>原因</th></tr></thead>
      <tbody>{rows.slice(start, end).map(row => <tr key={row.sequence}>
        <td>{row.sequence}</td><td>{row.sourceLine}</td><td>{row.url || '—'}</td><td>{row.entry || '—'}</td>
        <td><span className={`status ${row.disposition}`}>{label[row.disposition]}</span></td><td>{row.reason}</td>
      </tr>)}</tbody>
    </table></div>
    {rows.length > displayLimit && <div className="controls">
      <button className="secondary" disabled={!current} onClick={() => setPage(current - 1)}>上一页</button>
      <span>{start + 1}–{end} / {rows.length}</span>
      <button className="secondary" disabled={end >= rows.length} onClick={() => setPage(current + 1)}>下一页</button>
    </div>}
  </>;
}

function App() {
  const [view, setView] = useState<'import' | 'models'>('import');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspace] = useState('');
  const [siteId, setSite] = useState('');
  const [text, setText] = useState('');
  const [filename, setFilename] = useState<string>();
  const [delimiter, setDelimiter] = useState<Delimiter>(',');
  const [header, setHeader] = useState(true);
  const [mapping, setMapping] = useState<ColumnMapping>(defaultMapping);
  const [preview, setPreview] = useState<ImportBatch>();
  const [saved, setSaved] = useState<Batch>();
  const [history, setHistory] = useState<BatchSummary[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(!auth);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [configured, setConfigured] = useState(!auth);
  const workspace = workspaces.find(item => item.id === workspaceId);
  const path = workspaceId && siteId ? `/workspaces/${workspaceId}/sites/${siteId}/imports` : '';
  const ledger = useMemo(() => preview ? buildLedger(preview.rows) : [], [preview]);

  const loadWorkspaces = useCallback(async () => {
    try {
      const data = await request<Workspace[]>('/workspaces');
      setWorkspaces(data);
      setWorkspace(data[0]?.id ?? '');
      setSite(data[0]?.sites[0]?.id ?? '');
    } catch (error) { setError(message(error)); }
  }, []);

  useEffect(() => {
    if (!auth) return;
    const { data: { subscription } } = auth.auth.onAuthStateChange((_event, session) => setSignedIn(Boolean(session)));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (signedIn && configured) void loadWorkspaces();
  }, [signedIn, configured, loadWorkspaces]);

  useEffect(() => {
    if (!path) return;
    let active = true;
    void request<BatchSummary[]>(path).then(items => { if (active) setHistory(items); })
      .catch(error => { if (active) setError(message(error)); });
    return () => { active = false; };
  }, [path]);

  const parsed = useMemo(() => {
    try { return { table: readTable(text, delimiter), error: '' }; }
    catch (error) { return { table: [], error: message(error) }; }
  }, [text, delimiter]);

  const columns = useMemo(() => {
    const width = parsed.table.reduce((max, row) => Math.max(max, row.cells.length), 0);
    return Array.from({ length: width }, (_, index) => header
      ? parsed.table[0]?.cells[index]?.trim() || `第 ${index + 1} 列` : `第 ${index + 1} 列`);
  }, [parsed.table, header]);

  function updateText(value: string, source?: string) {
    setText(value);
    setFilename(source);
    if (source !== filename) setMapping(defaultMapping);
    setPreview(undefined);
    setError('');
    const first = value.split(/\r?\n/, 1)[0] ?? '';
    setDelimiter(first.includes('\t') ? '\t' : first.includes(';') && !first.includes(',') ? ';' : ',');
    setHeader(/(?:^|[,;\t])\s*"?(?:url|网址|候选网址|链接|website)"?\s*(?:[,;\t]|$)/i.test(first));
  }

  function createPreview() {
    const result = importBatchSchema.safeParse({
      requestId: crypto.randomUUID(), source: filename ? 'csv' : 'paste', filename,
      rows: mapRows(parsed.table, mapping, header),
    });
    if (!result.success) {
      setError('请输入至少一条数据，每批最多 5,000 行。请检查是否选择了正确的表头和列。');
      return;
    }
    setError('');
    setPreview(result.data);
    setSaved(undefined);
  }

  function resetSite() {
    setSaved(undefined);
    setPreview(undefined);
    setHistory([]);
    setError('');
  }

  async function save() {
    if (!preview || !path) return;
    setError('');
    setBusy(true);
    try {
      const batch = await request<Batch>(path, preview);
      setSaved(batch);
      setPreview(undefined);
      try { setHistory(await request<BatchSummary[]>(path)); }
      catch { setError('批次已保存，暂时无法刷新历史。'); }
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  async function openBatch(id: string) {
    if (!id) return;
    setBusy(true);
    setError('');
    try {
      setSaved(await request<Batch>(`${path}/${id}`));
      setPreview(undefined);
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  async function signIn() {
    if (!auth) return;
    setBusy(true);
    setError('');
    try {
      if (!configured) {
        if (!(await requestConfiguredAccess())) throw new Error('请允许访问工作台 API 和登录服务。');
        setConfigured(true);
      }
      const result = codeSent
        ? await auth.auth.verifyOtp({ email, token: code.trim(), type: 'email' })
        : await auth.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
      if (result.error) throw result.error;
      if (!codeSent) setCodeSent(true);
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  return <main className="shell">
    <header className="top">
      <div><div className="brand">URLPut</div><h1>外链工作台</h1></div>
      <nav className="controls">
        <button className={view === 'import' ? '' : 'secondary'} onClick={() => setView('import')}>导入与台账</button>
        <button className={view === 'models' ? '' : 'secondary'} onClick={() => setView('models')}>AI 设置</button>
      </nav>
    </header>

    {view === 'models' ? <ModelSettings /> : <>
      {error && <div className="error" role="alert">{error}</div>}
      {auth && !signedIn && <section className="card stack">
        <h2>登录</h2>
        <label>电子邮箱<input type="email" value={email} disabled={codeSent} onChange={event => setEmail(event.target.value)} /></label>
        {codeSent && <label>邮箱验证码<input inputMode="numeric" value={code} onChange={event => setCode(event.target.value)} /></label>}
        <button disabled={busy || !email || (codeSent && !code)} onClick={() => void signIn()}>{codeSent ? '验证并登录' : '发送验证码'}</button>
      </section>}
      {signedIn && <>
        {!configured && <section className="card"><button onClick={() => void requestConfiguredAccess()
          .then(granted => { if (granted) setConfigured(true); else setError('请授权工作台 API。'); })
          .catch(error => setError(message(error)))}>连接工作台</button></section>}
        <section className="card controls">
          <label>工作空间<select value={workspaceId} disabled={busy} onChange={event => {
            resetSite();
            setWorkspace(event.target.value);
            setSite(workspaces.find(item => item.id === event.target.value)?.sites[0]?.id ?? '');
          }}>{!workspaces.length && <option value="">暂无工作空间</option>}{workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>推广站点<select value={siteId} disabled={busy} onChange={event => { resetSite(); setSite(event.target.value); }}>
            {!workspace?.sites.length && <option value="">暂无站点</option>}
            {workspace?.sites.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          {auth && <button className="secondary" onClick={() => void auth?.auth.signOut().then(({ error }) => {
            if (error) { setError(message(error)); return; }
            resetSite(); setWorkspaces([]); setWorkspace(''); setSite(''); setCodeSent(false); setCode('');
          })}>退出登录</button>}
        </section>
        <section className="card stack">
          <h2>导入候选网址</h2>
          <label>CSV 文件<input type="file" accept=".csv,text/csv" disabled={busy} onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            if (file.size > MAX_IMPORT_BYTES) { setError('文件超过 2 MB，请拆分后导入。'); return; }
            void file.text().then(value => updateText(value, file.name)).catch(error => setError(message(error)));
          }} /></label>
          {filename && <div>来源文件：{filename}</div>}
          <label>或粘贴表格及网址<textarea value={text} disabled={busy} rows={5} placeholder={'URL,投稿入口\nhttps://example.org'} onChange={event => updateText(event.target.value)} /></label>
          <div className="controls">
            <label>分隔符<select value={delimiter} disabled={busy} onChange={event => { setDelimiter(event.target.value as Delimiter); setPreview(undefined); }}>
              <option value=",">逗号</option><option value=";">分号</option><option value={'\t'}>制表符</option>
            </select></label>
            <label className="inline"><input type="checkbox" checked={header} disabled={busy} onChange={event => { setHeader(event.target.checked); setPreview(undefined); }} /> 首行是表头</label>
          </div>
          {parsed.error && <div className="error" role="alert">{parsed.error}</div>}
          {!!columns.length && <div className="controls">
            {(Object.keys(fields) as Array<keyof ColumnMapping>).map(field => <label key={field}>{fields[field]}
              <select value={mapping[field] ?? ''} disabled={busy} onChange={event => {
                const value = event.target.value === '' ? undefined : Number(event.target.value);
                setMapping({ ...mapping, [field]: value });
                setPreview(undefined);
              }}>
                {field !== 'url' && <option value="">无</option>}
                {columns.map((column, index) => <option key={index} value={index}>{column}</option>)}
              </select>
            </label>)}
          </div>}
          <button disabled={busy || !parsed.table.length || !columns[mapping.url]} onClick={createPreview}>预览导入</button>
        </section>
        {preview && <section className="card stack">
          <h2>导入预览</h2><p>共 {ledger.length} 行，其中 {ledger.filter(row => row.disposition === 'candidate').length} 条候选。</p>
          <RowTable key={preview.requestId} rows={ledger} />
          <button disabled={busy || !path} onClick={() => void save()}>{busy ? '保存中…' : '确认并保存'}</button>
        </section>}
        <section className="card stack">
          <h2>逐行台账</h2>
          {history.length ? <label>导入批次<select value={saved?.id ?? ''} disabled={busy} onChange={event => void openBatch(event.target.value)}>
            <option value="">选择历史批次</option>
            {history.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.filename ?? '粘贴'} · {item.rowCount} 行</option>)}
          </select></label> : <p>当前站点暂无导入记录。</p>}
          {saved && <RowTable key={saved.id} rows={saved.rows} />}
        </section>
      </>}
    </>}
  </main>;
}

createRoot(document.getElementById('app')!).render(<App />);
