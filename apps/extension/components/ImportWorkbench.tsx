import { VerifiedLinks } from './VerifiedLinks';
import { observeChecks, pendingCheckCount, runQueue } from '../lib/check-queue';
import { BatchChecks } from './BatchChecks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { importBatchSchema, MAX_IMPORT_BYTES, MAX_IMPORT_REQUEST_BYTES, type ImportBatch, type Workspace } from '@urlput/contracts';
import { buildLedger, mapRows, readTable, readTextRows, type ColumnMapping, type Delimiter, type LedgerRow } from '@urlput/import';
import { remoteAuth, request, requestConfiguredAccess, type Batch, type BatchSummary } from '../lib/api';
import { LinkCatalog } from './LinkCatalog';
import { downloadLedger, reportCells, reportColumns, type ReportSite } from '../lib/report';

import { addSite, directoryBinding, localBatch, localHistory, prepareDirectory, recordPendingReview, registerMigratedSite, saveLocalBatch, workspaceFor } from '../lib/local-directory';

const fields: Record<keyof ColumnMapping, string> = { url: '候选网址', entry: '投稿入口', name: '名称', notes: '备注' };
const defaultMapping: ColumnMapping = { url: 0 };
const displayLimit = 200;
const label = { candidate: '候选', duplicate: '重复', invalid: '无效' };

function message(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请重试。';
}

function RowTable({ rows, site }: { rows: LedgerRow[]; site?: ReportSite }) {
  const [page, setPage] = useState(0);
  const current = Math.min(page, Math.max(0, Math.ceil(rows.length / displayLimit) - 1));
  const start = current * displayLimit;
  const end = Math.min(start + displayLimit, rows.length);
  if (!rows.length) return null;
  return <>
    <div className="table"><table>
      <thead><tr>{(site ? reportColumns : ['序号', '来源行', '候选网址', '投稿入口', '状态', '原因'])
        .map(column => <th key={column} scope="col">{column}</th>)}</tr></thead>
      <tbody>{rows.slice(start, end).map(row => <tr key={row.sequence}>
        {site ? reportCells(row, site).map((value, index) => <td key={reportColumns[index]}>{value || '—'}</td>) : <>
          <td>{row.sequence}</td><td>{row.sourceLine}</td><td>{row.url || '—'}</td><td>{row.entry || '—'}</td>
          <td><span className={`status ${row.disposition}`}>{label[row.disposition]}</span></td><td>{row.reason}</td>
        </>}
      </tr>)}</tbody>
    </table></div>
    {rows.length > displayLimit && <div className="controls">
      <button className="secondary" disabled={!current} onClick={() => setPage(current - 1)}>上一页</button>
      <span>{start + 1}–{end} / {rows.length}</span>
      <button className="secondary" disabled={end >= rows.length} onClick={() => setPage(current + 1)}>下一页</button>
    </div>}
  </>;
}

function ResumeChecks({ dir }: { dir: FileSystemDirectoryHandle }) {
  const [pending, setPending] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  useEffect(() => {
    let active = true;
    let revision = 0;
    function refresh() {
      const current = ++revision;
      void pendingCheckCount(dir).then(count => {
        if (active && revision === current) setPending(count);
      }).catch(error => { if (active && revision === current) setStatus(message(error)); });
    }
    const unsubscribe = observeChecks(refresh);
    refresh();
    return () => { active = false; unsubscribe(); };
  }, [dir]);
  if (!pending && !status) return null;
  return <section className="card controls">
    {pending > 0 && <button disabled={busy} onClick={async () => {
      setBusy(true);
      setStatus('正在继续队列…');
      try {
        await runQueue(dir);
        setStatus('队列已处理完毕。');
      } catch (error) { setStatus(message(error)); }
      finally { setBusy(false); }
    }}>继续未完成队列（{pending}）</button>}
    {status && <p role="status">{status}</p>}
  </section>;
}

export function ImportWorkbench({ withCatalog = false }: { withCatalog?: boolean }) {
  const [legacy, setLegacy] = useState(() => sessionStorage.getItem('urlput-source') === 'legacy');
  const [dir, setDir] = useState<FileSystemDirectoryHandle>();
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const [choosing, setChoosing] = useState(false);
  const revision = useRef(0);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const version = revision.current;
    void directoryBinding().then(value => {
      if (value && version === revision.current) { setDir(value); setLabel(value.name); }
    }).catch(err => setError(message(err)));
  }, []);
  async function choose() {
    revision.current++;
    setChoosing(true);
    setError('');
    try {
      const picker = window as Window & { showDirectoryPicker?(options: { mode: string }): Promise<FileSystemDirectoryHandle> };
      if (!picker.showDirectoryPicker) throw new Error('请在支持目录选择的桌面 Chrome 工作台中打开。');
      const parent = await picker.showDirectoryPicker({ mode: 'readwrite' });
      const directory = await prepareDirectory(parent);
      await directoryBinding(directory);
      setDir(directory);
      setLabel(parent.name);
      setGeneration(value => value + 1);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) setError(message(err));
    } finally { setChoosing(false); }
  }
  return <>
    <section className="card controls">
      <label>数据来源<select value={legacy ? 'legacy' : 'local'} onChange={event => {
        sessionStorage.setItem('urlput-source', event.target.value);
        setLegacy(event.target.value === 'legacy');
      }}><option value="local">本机目录</option><option value="legacy">旧版服务工作空间</option></select></label>
      {!legacy && <button disabled={choosing} onClick={() => void choose()}>{dir ? '重新选择数据目录' : '选择数据目录'}</button>}
      {!legacy && dir && <span>{label}</span>}
      {error && <p role="alert">{error}</p>}
    </section>
    {!legacy && dir && <ResumeChecks key={generation} dir={dir} />}
    {(legacy || dir) && <Workbench key={legacy ? 'legacy' : generation}
      directory={legacy ? undefined : dir} migrationDirectory={legacy ? dir : undefined} withCatalog={withCatalog && legacy} />}
  </>;
}

function Workbench({ directory, migrationDirectory, withCatalog }: { directory?: FileSystemDirectoryHandle; migrationDirectory?: FileSystemDirectoryHandle; withCatalog: boolean }) {
  const auth = directory ? undefined : remoteAuth();
  const [homepage, setHomepage] = useState('');
  const [library, setLibrary] = useState<'sites' | 'links'>('sites');
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspace] = useState('');
  const [siteId, setSite] = useState('');
  const [text, setText] = useState('');
  const [filename, setFilename] = useState<string>();
  const fileRevision = useRef(0);
  const [readingFile, setReadingFile] = useState(false);
  const plainText = filename?.toLowerCase().endsWith('.txt') ?? false;
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
  const site = workspace?.sites.find(item => item.id === siteId);
  const path = workspaceId && siteId ? `/workspaces/${workspaceId}/sites/${siteId}/imports` : '';
  const ledger = useMemo(() => preview ? buildLedger(preview.rows) : [], [preview]);

  const loadWorkspaces = useCallback(async () => {
    try {
      const data = directory ? [await workspaceFor(directory)] : await request<Workspace[]>('/workspaces');
      setWorkspaces(data);
      setWorkspace(data[0]?.id ?? '');
      setSite(data[0]?.sites[0]?.id ?? '');
    } catch (error) { setError(message(error)); }
  }, [directory]);

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
    void (directory ? localHistory(directory, siteId) : request<BatchSummary[]>(path)).then(items => { if (active) setHistory(items); })
      .catch(error => { if (active) setError(message(error)); });
    return () => { active = false; };
  }, [path, directory, siteId]);

  const parsed = useMemo(() => {
    try {
      return plainText ? { table: [], textRows: readTextRows(text), error: '' }
        : { table: readTable(text, delimiter), error: '' };
    } catch (error) { return { table: [], error: message(error) }; }
  }, [text, delimiter, plainText]);

  const columns = useMemo(() => {
    const width = parsed.table.reduce((max, row) => Math.max(max, row.cells.length), 0);
    return Array.from({ length: width }, (_, index) => header
      ? parsed.table[0]?.cells[index]?.trim() || `第 ${index + 1} 列` : `第 ${index + 1} 列`);
  }, [parsed.table, header]);

  function updateText(value: string, source?: string) {
    fileRevision.current++;
    setReadingFile(false);
    setText(value);
    setFilename(source);
    if (source !== filename) setMapping(defaultMapping);
    setPreview(undefined);
    setError('');
    const first = value.split(/\r?\n/, 1)[0] ?? '';
    setDelimiter(first.includes('\t') ? '\t' : first.includes(';') && !first.includes(',') ? ';' : ',');
    setHeader(/(?:^|[,;\t])\s*"?(?:url|网址|候选网址|链接|website)"?\s*(?:[,;\t]|$)/i.test(first));
  }

  async function readFile(file: File) {
    const revision = ++fileRevision.current;
    setPreview(undefined);
    setError('');
    setReadingFile(true);
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error('文件超过 2 MB，请拆分后导入。');
      const value = file.name.toLowerCase().endsWith('.txt')
        ? new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
        : await file.text();
      if (revision === fileRevision.current) updateText(value, file.name);
    } catch (error) {
      if (revision === fileRevision.current) {
        updateText('');
        setError(error instanceof TypeError ? '文件不是有效的 UTF-8 文本，请转换后重试。' : message(error));
      }
    }
  }

  function createPreview() {
    const result = importBatchSchema.safeParse({
      requestId: crypto.randomUUID(), source: plainText ? 'txt' : filename ? 'csv' : 'paste', filename,
      rows: parsed.textRows ?? mapRows(parsed.table, mapping, header),
    });
    if (!result.success) {
      setError('请输入至少一条数据，每批最多 5,000 行。请检查是否选择了正确的表头和列。');
      return;
    }
    if (new TextEncoder().encode(JSON.stringify(result.data)).length > MAX_IMPORT_REQUEST_BYTES) {
      setError('导入记录超过请求大小限制，请拆分后导入。');
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
      if (directory) {
        const result = await saveLocalBatch(directory, siteId, preview);
        setSaved(result.batch);
        setHistory(result.history);
        setPreview(undefined);
        return;
      }
      const batch = await request<Batch>(path, preview);
      setSaved(batch);
      setPreview(undefined);
      try { setHistory(await request<BatchSummary[]>(path)); }
      catch { setError('批次已保存，暂时无法刷新历史。'); }
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  async function openBatch(id: string) {
    if (!id) { setSaved(undefined); return; }
    setBusy(true);
    setError('');
    try {
      setSaved(directory ? await localBatch(directory, siteId, id) : await request<Batch>(`${path}/${id}`));
      setPreview(undefined);
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  const [migrationStatus, setMigrationStatus] = useState('');
  async function migrateSite() {
    if (!migrationDirectory || !site || !path) return;
    setBusy(true);
    let copied = 0;
    setMigrationStatus('正在迁移…');
    try {
      await registerMigratedSite(migrationDirectory, site);
      const seen = new Set<string>();
      let before = '';
      for (;;) {
        const page = await request<BatchSummary[]>(before ? path + '?before=' + encodeURIComponent(before) : path);
        if (!page.length) break;
        for (const summary of page) {
          if (seen.has(summary.id)) throw new Error('旧服务未返回下一页，请更新服务后重试。');
          seen.add(summary.id);
          const batch = await request<Batch>(path + '/' + summary.id);
          const input = importBatchSchema.parse({ requestId: batch.id, source: batch.source, filename: batch.filename ?? undefined, rows: batch.rows });
          await saveLocalBatch(migrationDirectory, site.id, input, batch.createdAt);
          copied++;
        }
        if (page.length < 50) break;
        before = page[page.length - 1].id;
      }
      setMigrationStatus(`已核对并保存 ${copied} 个批次。`);
    } catch (err) { setMigrationStatus(`已保存 ${copied} 个批次。${message(err)} 可再次迁移。`); }
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

  return <>
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
      {withCatalog && <div className="library-tabs" role="group" aria-label="清单类型">
        <button type="button" aria-pressed={library === 'sites'} className={library === 'sites' ? '' : 'secondary'}
          onClick={() => setLibrary('sites')}>推广站点</button>
        <button type="button" aria-pressed={library === 'links'} className={library === 'links' ? '' : 'secondary'}
          onClick={() => setLibrary('links')}>外链清单</button>
      </div>}
      <section className="card controls">
        <label>工作空间<select value={workspaceId} disabled={busy} onChange={event => {
          if (workspaceId === event.target.value) return;
          resetSite();
          setWorkspace(event.target.value);
          setSite(workspaces.find(item => item.id === event.target.value)?.sites[0]?.id ?? '');
        }}>{!workspaces.length && <option value="">暂无工作空间</option>}{workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {library === 'sites' && <label>推广站点<select value={siteId} disabled={busy} onChange={event => {
          if (siteId === event.target.value) return;
          resetSite();
          setSite(event.target.value);
        }}>
          {!workspace?.sites.length && <option value="">暂无站点</option>}
          {workspace?.sites.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>}
        {auth && <button className="secondary" onClick={() => void auth?.auth.signOut().then(({ error }) => {
          if (error) { setError(message(error)); return; }
          resetSite(); setWorkspaces([]); setWorkspace(''); setSite(''); setCodeSent(false); setCode('');
        })}>退出登录</button>}
      </section>
      {migrationDirectory && site && <section className="card">
        <button disabled={busy} onClick={() => void migrateSite()}>将本站历史批次复制到本机目录</button>
        {migrationStatus && <p role="status">{migrationStatus}</p>}
      </section>}
      {directory && workspace && <form className="card controls" onSubmit={async event => {
        event.preventDefault();
        setBusy(true);
        try {
          const result = await addSite(directory, homepage);
          resetSite();
          setWorkspaces([result.workspace]);
          setSite(result.site.id);
          if (result.site.id === siteId) setHistory(await localHistory(directory, siteId));
          setHomepage('');
        } catch (err) { setError(message(err)); }
        finally { setBusy(false); }
      }}>
        <label>官网地址<input type="url" required value={homepage} onChange={event => setHomepage(event.target.value)} /></label>
        <button disabled={busy}>添加推广站点</button>
      </form>}
      {directory && site && <VerifiedLinks key={site.id} dir={directory} site={site} />}
      {library === 'links' && workspaceId && <LinkCatalog key={workspaceId} workspaceId={workspaceId} />}
      <div hidden={library !== 'sites'}>
        <section className="card stack">
          <h2>导入候选网址</h2>
          <label>CSV 或 TXT 文件<input type="file" accept=".csv,.txt,text/csv,text/plain" disabled={busy} onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void readFile(file);
          }} /></label>
          {readingFile && <p role="status">正在读取文件…</p>}
          {filename && <div>来源文件：{filename}</div>}
          <label>或粘贴表格及网址<textarea value={text} disabled={busy} rows={5} placeholder={'URL,投稿入口\nhttps://example.org'} onChange={event => updateText(event.target.value)} /></label>
          {!plainText && <div className="controls">
            <label>分隔符<select value={delimiter} disabled={busy} onChange={event => { setDelimiter(event.target.value as Delimiter); setPreview(undefined); }}>
              <option value=",">逗号</option><option value=";">分号</option><option value={'\t'}>制表符</option>
            </select></label>
            <label className="inline"><input type="checkbox" checked={header} disabled={busy} onChange={event => { setHeader(event.target.checked); setPreview(undefined); }} /> 首行是表头</label>
          </div>}
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
          <button disabled={busy || readingFile || !(plainText ? parsed.textRows?.length : columns[mapping.url])} onClick={createPreview}>预览导入</button>
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
          {saved && site && <>
            <button className="secondary" type="button" onClick={() => downloadLedger(saved, site)}>导出 CSV</button>
            <RowTable key={saved.id} rows={saved.rows} site={site} />
            {directory && <details key={saved.id + '-receipt'}>
              <summary>登记待审核回执</summary>
              <form className="stack" onSubmit={async event => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                setBusy(true);
                try {
                  const batch = await recordPendingReview(directory, siteId, saved.id, Number(data.get('sequence')),
                    String(data.get('evidence')), String(data.get('submittedAt')));
                  setSaved(batch);
                  setError('');
                } catch (err) { setError(message(err)); }
                finally { setBusy(false); }
              }}>
                <label>已提交记录的序号<input name="sequence" type="number" min="1" max={saved.rows.length} step="1" required /></label>
                <label>实际提交时间<input name="submittedAt" type="datetime-local" required /></label>
                <label>平台待审核提示或回执编号<input name="evidence" maxLength={1000} required /></label>
                <button disabled={busy}>保存回执</button>
              </form>
            </details>}
            {directory && <BatchChecks key={saved.id} dir={directory} site={siteId} batch={saved} />}
          </>}
        </section>
      </div>
    </>}
  </>;
}
