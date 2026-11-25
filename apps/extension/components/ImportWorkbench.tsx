import { SubmissionApprovals } from './SubmissionApprovals';
import { AnalysisResults } from './AnalysisResults';
import { VerifiedLinks } from './VerifiedLinks';
import { enqueue, observeChecks, pendingCheckCount, runQueue, scheduleMultiSiteBatch } from '../lib/check-queue';
import { BatchChecks, requestCheckAccess } from './BatchChecks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { importBatchSchema, MAX_IMPORT_BYTES, MAX_IMPORT_REQUEST_BYTES, type ImportBatch, type Workspace } from '@urlput/contracts';
import { buildLedger, mapRows, readTable, readTextRows, type ColumnMapping, type Delimiter, type LedgerRow } from '@urlput/import';
import { remoteAuth, request, requestConfiguredAccess, type Batch, type BatchSummary } from '../lib/api';
import { LinkCatalog } from './LinkCatalog';
import { LocalLinkLists } from './LocalLinkLists';
import { LocalSites } from './LocalSites';
import { MultiSiteSetup } from './MultiSiteSetup';
import { DraftTemplates } from './DraftTemplates';
import { MultiSiteHistory } from './MultiSiteHistory';
import { PendingSubmissionReviews } from './PendingSubmissionReviews';
import { downloadLedger, reportCells, reportColumns, type ReportSite } from '../lib/report';

import { activeUrlLock, addSite, copyDirectory, directoryBinding, directoryPermission, localReportBatch, localHistory, openDirectory, pendingMultiSiteBatches, prepareDirectory, recordPendingReview, registerMigratedSite, saveLocalBatch, workspaceFor, directoryLastWrite } from '../lib/local-directory';

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
    void pendingMultiSiteBatches(dir).then(async batches => {
      for (const batch of batches) {
        if (!active) return;
        await scheduleMultiSiteBatch(dir, batch);
      }
    }).catch(error => { if (active) setStatus(message(error)); })
      .finally(() => { if (active) refresh(); });
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

type WorkbenchView = 'setup' | 'tasks' | 'library' | 'templates';

export function ImportWorkbench({ withCatalog = false, view, onBatchSaved, settings = false, onOpenSettings, onCloseSettings, onNavigate }: {
  withCatalog?: boolean;
  view?: WorkbenchView;
  onBatchSaved?: () => void;
  settings?: boolean;
  onOpenSettings?: () => void;
  onCloseSettings?: () => void;
  onNavigate?: (view: WorkbenchView) => void;
}) {
  const [legacy, setLegacy] = useState(() => sessionStorage.getItem('urlput-source') === 'legacy');
  const [binding, setBinding] = useState<FileSystemDirectoryHandle>();
  const [authorized, setAuthorized] = useState(false);
  const dir = authorized ? binding : undefined;
  const [label, setLabel] = useState('');
  const [loading, setLoading] = useState(true);
  const [lastWrite, setLastWrite] = useState<number>();
  const workbench = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<HTMLElement>(null);
  const [workbenchBusy, setWorkbenchBusy] = useState(false);
  const previousSettings = useRef(settings);

  function restoreFocus() {
    requestAnimationFrame(() => {
      const previous = lastFocus.current;
      if (previous?.isConnected && previous.getClientRects().length && !previous.matches(':disabled')) previous.focus();
      else {
        const heading = workbench.current?.querySelector<HTMLElement>('[data-draft-heading]');
        if (heading?.getClientRects().length) heading.focus();
      }
    });
  }

  useEffect(() => {
    if (previousSettings.current && !settings) restoreFocus();
    previousSettings.current = settings;
    if (settings && dir) setLastWrite(directoryLastWrite(dir));
  }, [settings, dir]);
  const [error, setError] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [directoryStatus, setDirectoryStatus] = useState('');
  const [backupSource, setBackupSource] = useState<FileSystemDirectoryHandle>();
  const revision = useRef(0);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const version = revision.current;
    let active = true;
    void directoryBinding().then(async value => {
      if (!value || !active || version !== revision.current) return;
      setBinding(value);
      const granted = await directoryPermission(value) === 'granted';
      const loaded = granted ? await workspaceFor(value) : undefined;
      if (active && version === revision.current) {
        setAuthorized(granted);
        setLabel(loaded?.name ?? '');
      }
    }).catch(err => {
      if (active && version === revision.current) setError(message(err));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!binding || choosing || legacy || workbenchBusy) return;
    const handle = binding;
    let active = true;
    async function checkPermission() {
      const version = revision.current;
      try {
        const current = await directoryBinding();
        if (current && !(await handle.isSameEntry(current))) {
          const granted = await directoryPermission(current) === 'granted';
          const loaded = granted ? await workspaceFor(current) : undefined;
          if (!active || version !== revision.current) return;
          revision.current++;
          setBinding(current);
          setAuthorized(granted);
          setLabel(loaded?.name ?? '');
          setError('');
          setGeneration(value => value + 1);
          return;
        }
        const permission = await directoryPermission(handle);
        if (permission === 'granted') await workspaceFor(handle);
        if (authorized && permission !== 'granted' && active && version === revision.current) {
          setAuthorized(false);
          setError('数据目录权限已失效，请重新授权原目录。');
        }
      } catch (failure) {
        if (active && version === revision.current) {
          setAuthorized(false);
          setError(message(failure));
        }
      }
    }
    window.addEventListener('focus', checkPermission);
    document.addEventListener('visibilitychange', checkPermission);
    return () => {
      active = false;
      window.removeEventListener('focus', checkPermission);
      document.removeEventListener('visibilitychange', checkPermission);
    };
  }, [authorized, binding, choosing, legacy, workbenchBusy]);

  async function authorize() {
    if (!binding) return;
    revision.current++;
    setChoosing(true);
    setError('');
    try {
      if (await directoryPermission(binding, true) !== 'granted') throw new Error('请允许读取和写入原数据目录。');
      const workspace = await workspaceFor(binding);
      setLabel(workspace.name);
      setAuthorized(true);
      if (settings) onCloseSettings?.();
      restoreFocus();
    } catch (err) { setAuthorized(false); setError(message(err)); }
    finally { setChoosing(false); }
  }

  async function bind(directory: FileSystemDirectoryHandle) {
    const workspace = await workspaceFor(directory);
    await directoryBinding(directory);
    setBinding(directory);
    setAuthorized(true);
    setLabel(workspace.name);
    if (onCloseSettings) { onCloseSettings(); restoreFocus(); }
    setGeneration(value => value + 1);
  }

  async function choose(operation: 'create' | 'bind' | 'backup' | 'source' | 'restore') {
    revision.current++;
    setChoosing(true);
    setError('');
    setDirectoryStatus('');
    if (operation === 'source') setBackupSource(undefined);
    try {
      const picker = window as Window & { showDirectoryPicker?(options: { mode: string }): Promise<FileSystemDirectoryHandle> };
      if (!picker.showDirectoryPicker) throw new Error('请在支持目录选择的桌面 Chrome 工作台中打开。');
      const parent = await picker.showDirectoryPicker({ mode: operation === 'source' ? 'read' : 'readwrite' });
      if (operation === 'create' || operation === 'bind') {
        await navigator.locks.request(activeUrlLock, { ifAvailable: true }, async active => {
          if (!active) throw new Error('有只读任务正在运行，请等当前操作结束后再切换数据目录。');
          await bind(await (operation === 'create' ? prepareDirectory(parent) : openDirectory(parent)));
        });
        setBackupSource(undefined);
      } else if (operation === 'source') {
        setBackupSource(await openDirectory(parent));
        setDirectoryStatus(`已选备份：${parent.name}。请选择恢复目标。`);
      } else if (operation === 'backup' && dir) {
        const target = await copyDirectory(dir, parent);
        setDirectoryStatus(`备份完成：${parent.name}/${target.name}。`);
      } else if (operation === 'restore' && backupSource) {
        await bind(await copyDirectory(backupSource, parent));
        setBackupSource(undefined);
        setDirectoryStatus(`已恢复并切换到：${parent.name}。`);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') setDirectoryStatus('已取消，可重新选择目录。');
      else setError(message(err));
    } finally { setChoosing(false); }
  }
  return <>
    <section className="card controls" hidden={Boolean(onOpenSettings && !settings)}>
      {onOpenSettings && <>
        <h2>数据目录</h2>
        <p>目录：{label || (binding ? '原数据目录' : '尚未绑定')}</p>
        <p>授权状态：{loading ? '检查中' : dir ? '可读写' : binding ? '需重新授权' : '未绑定'}</p>
        <p>本次会话最近写入：{lastWrite ? new Date(lastWrite).toLocaleString() : '暂无记录'}</p>
      </>}
      <label>数据来源<select disabled={choosing || workbenchBusy} value={legacy ? 'legacy' : 'local'} onChange={event => {
        sessionStorage.setItem('urlput-source', event.target.value);
        setLegacy(event.target.value === 'legacy');
      }}><option value="local">本机目录</option><option value="legacy">旧版服务工作空间</option></select></label>
      {!legacy && <button disabled={choosing || workbenchBusy || loading} onClick={() => void choose(binding ? 'bind' : 'create')}>{binding ? '重新选择数据目录' : onOpenSettings ? '初始化空数据目录' : '选择数据目录'}</button>}
      {onOpenSettings && !legacy && !binding && <button disabled={choosing || workbenchBusy || loading} onClick={() => void choose('bind')}>绑定已有数据目录</button>}
      {!legacy && binding && <button disabled={choosing || workbenchBusy || loading} onClick={() => void choose('create')}>初始化空数据目录</button>}
      {!legacy && binding && !authorized && <button disabled={choosing || workbenchBusy || loading} onClick={() => void authorize()}>重新授权原目录</button>}
      {!onOpenSettings && !legacy && dir && <span>{label}</span>}
      {!legacy && dir && <button disabled={choosing || workbenchBusy || loading} onClick={() => void choose('backup')}>备份数据目录</button>}
      {!legacy && <button disabled={choosing || workbenchBusy || loading} onClick={() => void choose('source')}>选择备份来源</button>}
      {!legacy && backupSource && <button disabled={choosing || workbenchBusy || loading} onClick={() => void choose('restore')}>选择恢复目标并恢复</button>}
      {!legacy && directoryStatus && <p role="status">{directoryStatus}</p>}
      {!legacy && !binding && <p>首次使用请选择空文件夹。已有数据时，选择包含 URLPut-data-v1 的上一级文件夹。</p>}
      {error && <p role="alert">{error}</p>}
    </section>
    {!legacy && dir && <div hidden={settings || Boolean(view && view !== 'tasks')}>
      <ResumeChecks key={`resume-${generation}`} dir={dir} />
    </div>}
    <div ref={workbench} hidden={settings} onFocusCapture={event => {
      if (!event.target.closest('[data-directory-recovery]')) lastFocus.current = event.target;
    }}>
      {onOpenSettings && !legacy && dir && directoryStatus.startsWith('已恢复并切换到') && <p role="status">{directoryStatus}</p>}
      {onOpenSettings && !legacy && !dir && <section className="card stack" data-directory-recovery>
        <p role={error ? 'alert' : 'status'}>{error || (loading ? '正在检查目录授权…' : binding ? '请重新授权原数据目录。' : '请先在设置中绑定数据目录。')}</p>
        {!loading && binding && <button disabled={choosing || workbenchBusy || loading} onClick={() => void authorize()}>重新授权原目录</button>}
        {!loading && <button className="secondary" onClick={onOpenSettings}>打开设置</button>}
      </section>}
      {(legacy || dir || onOpenSettings) && <Workbench key={legacy ? 'legacy' : onOpenSettings ? 'local' : `local-${generation}`}
        local={!legacy} generation={generation} onBusy={setWorkbenchBusy} directory={legacy ? undefined : dir}
        migrationDirectory={legacy ? dir : undefined} withCatalog={withCatalog && legacy} view={view} onBatchSaved={onBatchSaved} onNavigate={onNavigate} />}
    </div>
  </>;
}

function Workbench({ local, generation, onBusy, directory, migrationDirectory, withCatalog, view, onBatchSaved, onNavigate }: {
  generation: number;
  onBusy: (busy: boolean) => void;
  local: boolean;
  directory?: FileSystemDirectoryHandle;
  migrationDirectory?: FileSystemDirectoryHandle;
  withCatalog: boolean;
  view?: WorkbenchView;
  onBatchSaved?: () => void;
  onNavigate?: (view: WorkbenchView) => void;
}) {
  const auth = local ? undefined : remoteAuth();
  const [multiSite, setMultiSite] = useState(false);
  const [returnToBatch, setReturnToBatch] = useState(false);
  const [homepage, setHomepage] = useState('');
  const [libraryTab, setLibrary] = useState<'sites' | 'links'>('sites');
  const showLibrary = !view || view === 'library';
  const library = showLibrary ? libraryTab : 'sites';
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loadedDirectory, setLoadedDirectory] = useState<FileSystemDirectoryHandle>();
  const readyDirectory = directory && directory === loadedDirectory ? directory : undefined;
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
  const receiptDetails = useRef<HTMLDetailsElement>(null);
  const receiptSequence = useRef<HTMLInputElement>(null);
  const receiptEvidence = useRef<HTMLInputElement>(null);
  const [reviewJump, setReviewJump] = useState<{ batch: string; site: string; sequence: number; request: number }>();
  const [history, setHistory] = useState<BatchSummary[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  const [signedIn, setSignedIn] = useState(!auth);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [configured, setConfigured] = useState(!auth);
  const workspace = workspaces.find(item => item.id === workspaceId);
  const selectableSites = workspace?.sites.filter(item => !item.inactive || view === 'tasks') ?? [];
  const site = selectableSites.find(item => item.id === siteId);
  const path = workspaceId && site && (!local || readyDirectory) ? `/workspaces/${workspaceId}/sites/${siteId}/imports` : '';
  const ledger = useMemo(() => preview ? buildLedger(preview.rows) : [], [preview]);

  useEffect(() => {
    if (!signedIn || !configured || (local && !directory)) return;
    let active = true;
    const load = directory ? workspaceFor(directory).then(value => [value]) : request<Workspace[]>('/workspaces');
    void load.then(data => {
      if (!active) return;
      setWorkspaces(data);
      setLoadedDirectory(directory);
      setWorkspace(data[0]?.id ?? '');
      setSite(current => {
        if (local && data[0]?.sites.some(item => item.id === current)) return current;
        return local && current ? '' : data[0]?.sites.find(site => !site.inactive)?.id ?? '';
      });
    }).catch(error => { if (active) setError(message(error)); });
    return () => { active = false; };
  }, [signedIn, configured, local, directory]);

  useEffect(() => {
    setSaved(undefined);
    setHistory([]);
    setAnalysisBatch(undefined);
    setAnalysisStatus('');
  }, [generation]);

  useEffect(() => {
    if (!auth) return;
    const { data: { subscription } } = auth.auth.onAuthStateChange((_event, session) => setSignedIn(Boolean(session)));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!path) return;
    let active = true;
    void (readyDirectory ? localHistory(readyDirectory, siteId) : request<BatchSummary[]>(path)).then(items => { if (active) setHistory(items); })
      .catch(error => { if (active) setError(message(error)); });
    return () => { active = false; };
  }, [path, readyDirectory, siteId]);

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

  const pendingSave = useRef<{ requestId: string; directory: FileSystemDirectoryHandle; site: string } | null>(null);
  const [analysisBatch, setAnalysisBatch] = useState<string>();
  const [analysisStatus, setAnalysisStatus] = useState('');

  async function save(startAnalysis = false) {
    if (!preview || !path) return;
    setError('');
    setBusy(true);
    try {
      if (directory) {
        if (startAnalysis) await requestCheckAccess(ledger);
        const pending = pendingSave.current;
        if (pending?.requestId === preview.requestId &&
          (pending.site !== siteId || !(await pending.directory.isSameEntry(directory)))) {
          throw new Error('本次保存仍待确认。请回到原目录及推广站点重试，或重新预览后创建新批次。');
        }
        pendingSave.current = { requestId: preview.requestId, directory, site: siteId };
        const result = await saveLocalBatch(directory, siteId, preview);
        if (startAnalysis) await enqueue(directory, { site: siteId, batch: result.batch.id, analysis: true });
        pendingSave.current = null;
        setSaved(result.batch);
        setHistory(result.history);
        setPreview(undefined);
        if (startAnalysis) setAnalysisBatch(result.batch.id);
        if (onBatchSaved) { updateText(''); onBatchSaved(); }
        if (startAnalysis) {
          setAnalysisStatus('正在分析…');
          try {
            await runQueue(directory);
            setAnalysisStatus('本轮分析结束。');
          } catch (error) { setAnalysisStatus(message(error)); }
        }
        return;
      }
      const batch = await request<Batch>(path, preview);
      setSaved(batch);
      setPreview(undefined);
      if (onBatchSaved) { updateText(''); onBatchSaved(); }
      try { setHistory(await request<BatchSummary[]>(path)); }
      catch { setError('批次已保存，暂时无法刷新历史。'); }
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }

  async function openLocalResult(dir: FileSystemDirectoryHandle, id: string, selectedSite: string, sequence?: number) {
    const [report, summaries] = await Promise.all([
      localReportBatch(dir, selectedSite, id), localHistory(dir, selectedSite),
    ]);
    setSite(selectedSite);
    setSaved(report);
    setHistory(summaries);
    setAnalysisBatch(report.snapshot ? id : undefined);
    setReviewJump(current => sequence === undefined ? undefined :
      { batch: id, site: selectedSite, sequence, request: (current?.request ?? 0) + 1 });
  }

  async function openBatch(id: string) {
    if (!path) return;
    if (!id) { setSaved(undefined); return; }
    setBusy(true);
    setError('');
    setReviewJump(undefined);
    try {
      setSaved(directory ? await localReportBatch(directory, siteId, id) : await request<Batch>(`${path}/${id}`));
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
    {local && directory && !readyDirectory && !error && <p role="status">正在读取工作空间…</p>}
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
      {(withCatalog || (readyDirectory && view === 'library')) && showLibrary && <div className="library-tabs" role="group" aria-label="清单类型">
        <button type="button" aria-pressed={library === 'sites'} className={library === 'sites' ? '' : 'secondary'}
          onClick={() => setLibrary('sites')}>推广站点</button>
        <button type="button" aria-pressed={library === 'links'} className={library === 'links' ? '' : 'secondary'}
          onClick={() => setLibrary('links')}>外链清单</button>
      </div>}
      {view === 'setup' && readyDirectory && workspace && <section className="card controls">
        <button className="secondary" aria-pressed={multiSite} disabled={busy}
          onClick={() => setMultiSite(value => !value)}>{multiSite ? '返回单站导入' : '多站建批'}</button>
      </section>}
      {view === 'library' && returnToBatch && <button className="secondary" onClick={() => {
        setReturnToBatch(false);
        onNavigate?.('setup');
      }}>返回多站建批</button>}
      {multiSite && workspace && <div hidden={view !== 'setup'}>
        <MultiSiteSetup key={generation} dir={readyDirectory} workspace={workspace} visible={view === 'setup'}
          onOpenLibrary={onNavigate ? type => {
            setLibrary(type);
            setReturnToBatch(true);
            onNavigate('library');
          } : undefined} onBusy={setBusy} onStarted={async batch => {
            if (!readyDirectory) return;
            const first = batch.sites[0];
            const report = await localReportBatch(readyDirectory, first.id, batch.id);
            const history = await localHistory(readyDirectory, first.id);
            setSite(first.id);
            setSaved(report);
            setHistory(history);
            setAnalysisBatch(batch.id);
            setMultiSite(false);
            onBatchSaved?.();
          }} />
      </div>}
      {view === 'templates' && readyDirectory && <DraftTemplates key={generation} dir={readyDirectory} />}
      {view !== 'templates' && !(view === 'setup' && multiSite) && <>
      <section className="card controls">
        <label>工作空间<select value={workspaceId} disabled={busy} onChange={event => {
          if (workspaceId === event.target.value) return;
          resetSite();
          setWorkspace(event.target.value);
          setSite(workspaces.find(item => item.id === event.target.value)?.sites[0]?.id ?? '');
        }}>{!workspaces.length && <option value="">暂无工作空间</option>}{workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {library === 'sites' && <label>推广站点<select value={siteId} disabled={busy} onChange={event => {
          if (siteId === event.target.value) return;
          if (local) {
            setSaved(undefined);
            setHistory([]);
          } else resetSite();
          setSite(event.target.value);
        }}>
          {!site && <option value="">{selectableSites.length ? '请选择推广站点' : '暂无站点'}</option>}
          {selectableSites.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>}
        {auth && <button className="secondary" onClick={() => void auth?.auth.signOut().then(({ error }) => {
          if (error) { setError(message(error)); return; }
          resetSite(); setWorkspaces([]); setWorkspace(''); setSite(''); setCodeSent(false); setCode('');
        })}>退出登录</button>}
      </section>
      {showLibrary && migrationDirectory && site && <section className="card">
        <button disabled={busy} onClick={() => void migrateSite()}>将本站历史批次复制到本机目录</button>
        {migrationStatus && <p role="status">{migrationStatus}</p>}
      </section>}
      {readyDirectory && workspace && library === 'sites' && (showLibrary || !site) && <form className="card controls" onSubmit={async event => {
        event.preventDefault();
        setBusy(true);
        try {
          const result = await addSite(readyDirectory, homepage);
          resetSite();
          setWorkspaces([result.workspace]);
          setSite(result.site.id);
          if (result.site.id === siteId) setHistory(await localHistory(readyDirectory, siteId));
          setHomepage('');
        } catch (err) { setError(message(err)); }
        finally { setBusy(false); }
      }}>
        <label>官网地址<input type="url" required value={homepage} onChange={event => setHomepage(event.target.value)} /></label>
        <button disabled={busy}>添加推广站点</button>
      </form>}
      {view === 'library' && library === 'sites' && readyDirectory && workspace && <LocalSites key={generation}
        dir={readyDirectory} workspace={workspace} onChange={value => setWorkspaces([value])} />}
      {((showLibrary && library === 'sites') || view === 'tasks') && readyDirectory && site && <VerifiedLinks key={site.id} dir={readyDirectory} site={site} batch={saved} onUpdate={async () => {
        if (!saved) return;
        const refreshed = await localReportBatch(readyDirectory, siteId, saved.id);
        setSaved(current => current === saved ? refreshed : current);
      }} />}
      {library === 'links' && (local
        ? readyDirectory && <LocalLinkLists key={generation} dir={readyDirectory} />
        : workspaceId && <LinkCatalog key={workspaceId} workspaceId={workspaceId} />)}
      <div hidden={library !== 'sites'}>
        {showLibrary && readyDirectory && site && history.length > 0 && <AnalysisResults key={site.id} dir={readyDirectory} site={site.id} batches={history} />}
        <section className="card stack" hidden={Boolean(view && (view !== 'setup' || (!site && Boolean(directory) && !text && !preview)))}>
          <h2 data-draft-heading tabIndex={-1}>导入候选网址</h2>
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
        {preview && <section className="card stack" hidden={Boolean(view && view !== 'setup')}>
          <h2>导入预览</h2><p>共 {ledger.length} 行，其中 {ledger.filter(row => row.disposition === 'candidate').length} 条候选。</p>
          <RowTable key={preview.requestId} rows={ledger} />
          {view === 'setup' && local && <button disabled={busy || !path || !ledger.some(row => row.disposition === 'candidate')}
            onClick={() => void save(true)}>保存并开始分析</button>}
          <button disabled={busy || !path} onClick={() => void save()}>{busy ? '保存中…' : '确认并保存'}</button>
        </section>}
        {view === 'tasks' && readyDirectory && <>
          <MultiSiteHistory key={`history-${generation}`} dir={readyDirectory} onOpen={(id, selectedSite) =>
            openLocalResult(readyDirectory, id, selectedSite)} />
          <PendingSubmissionReviews key={`review-${generation}`} dir={readyDirectory} onOpen={(id, selectedSite, sequence) =>
            openLocalResult(readyDirectory, id, selectedSite, sequence)} />
        </>}
        <section className="card stack" hidden={Boolean(view && view !== 'tasks')}>
          <h2>逐行台账</h2>
          {history.length ? <label>导入批次<select value={saved?.id ?? ''} disabled={busy || !path} onChange={event => void openBatch(event.target.value)}>
            <option value="">选择历史批次</option>
            {history.map(item => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()} · {item.filename ?? '粘贴'} · {item.rowCount} 行</option>)}
          </select></label> : <p>当前站点暂无导入记录。</p>}
          {saved && site && <>
            <button className="secondary" type="button" onClick={() => downloadLedger(saved, site)}>导出 CSV</button>
            <RowTable key={saved.id} rows={saved.rows} site={saved.snapshot?.site ?? site} />
            {readyDirectory && <details key={`${siteId}-${saved.id}-receipt`} ref={receiptDetails}>
              <summary>登记待审核回执</summary>
              <form className="stack" onSubmit={async event => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                setBusy(true);
                try {
                  const batch = await recordPendingReview(readyDirectory, siteId, saved.id, Number(data.get('sequence')),
                    String(data.get('evidence')), String(data.get('submittedAt')));
                  setSaved(await localReportBatch(readyDirectory, siteId, batch.id));
                  setError('');
                } catch (err) { setError(message(err)); }
                finally { setBusy(false); }
              }}>
                <label>已提交记录的序号<input ref={receiptSequence} name="sequence" type="number" min="1" max={saved.rows.length} step="1" required /></label>
                <label>实际提交时间<input name="submittedAt" type="datetime-local" required /></label>
                <label>平台待审核提示或回执编号<input ref={receiptEvidence} name="evidence" maxLength={1000} required /></label>
                <button disabled={busy}>保存回执</button>
              </form>
            </details>}
            {readyDirectory && saved.snapshot?.execution !== '仅分析' && <SubmissionApprovals
              key={`${siteId}-${saved.id}-${reviewJump?.request ?? 0}`} dir={readyDirectory} site={siteId} batch={saved}
              onRegisterReceipt={sequence => {
                const details = receiptDetails.current;
                const field = receiptSequence.current;
                if (!details || !field) return;
                const evidence = receiptEvidence.current;
                if (field.value !== String(sequence)) {
                  if (field.value) details.querySelector('form')?.reset();
                  field.value = String(sequence);
                }
                details.open = true;
                evidence?.focus();
              }}
              onUpdate={async () => {
                const report = await localReportBatch(readyDirectory, siteId, saved.id);
                setSaved(current => current === saved ? report : current);
              }}
              initialSequence={reviewJump?.batch === saved.id && reviewJump.site === siteId ? reviewJump.sequence : undefined} />}
            {saved.id === analysisBatch && <p role="status">{analysisStatus}</p>}
            {readyDirectory && <BatchChecks key={saved.id} dir={readyDirectory} site={siteId} batch={saved} initiallyAnalysis={saved.id === analysisBatch} />}
          </>}
        </section>
      </div>
      </>}
    </>}
  </>;
}
