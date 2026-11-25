import { useEffect, useState } from 'react';
import { checkSummary, dispatchMultiSiteQueue, multiSiteExecution, multiSiteProgress, observeChecks, setMultiSiteExecution, type MultiSiteExecution } from '../lib/check-queue';
import { downloadMultiSiteReport, type MultiSiteReportScope } from '../lib/report';
import { multiSiteEvidenceCounts } from '../lib/local-review-queue';
import { multiSiteHistory, type MultiSiteSummary } from '../lib/local-directory';

export function MultiSiteHistory({ dir, onOpen }: {
  dir: FileSystemDirectoryHandle;
  onOpen: (id: string, site: string) => Promise<void>;
}) {
  const [history, setHistory] = useState<MultiSiteSummary[]>([]);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [statuses, setStatuses] = useState<Record<string, MultiSiteExecution | 'done'>>({});
  const [countScope, setCountScope] = useState('');
  const [exportScope, setExportScope] = useState<MultiSiteReportScope>('all');
  const [counts, setCounts] = useState<{ processed: number; accepted: number; valid: number }>();
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string>();
  const [site, setSite] = useState('');
  const [runState, setRunState] = useState<MultiSiteExecution>('running');
  const [completedSites, setCompletedSites] = useState(0);
  const [revision, setRevision] = useState(0);
  const matches = history.filter(item => (!statusFilter || statuses[item.id] === statusFilter) &&
    `${item.name} ${item.listName} ${item.id}`.toLowerCase().includes(query.trim().toLowerCase()));
  const pageSize = 5;
  const current = Math.min(page, Math.max(0, Math.ceil(matches.length / pageSize) - 1));
  const batch = history.find(item => item.id === selected);

  useEffect(() => {
    let active = true;
    let version = 0;
    function refresh() {
      const expected = ++version;
      void multiSiteHistory(dir).then(data => {
        if (active && expected === version) setHistory(data);
      }).catch(failure => {
        if (active && expected === version) setError(String(failure));
      }).finally(() => {
        if (active && expected === version) setLoading(false);
      });
    }
    const unsubscribe = observeChecks(() => {
      refresh();
      setRevision(value => value + 1);
    });
    refresh();
    return () => { active = false; unsubscribe(); };
  }, [dir]);

  useEffect(() => {
    if (!statusFilter) return;
    let active = true;
    void (async () => {
      const entries: Array<[string, MultiSiteExecution | 'done']> = [];
      for (const item of history) {
        if (!active) return;
        const state = await multiSiteExecution(dir, item.id);
        const jobs = await Promise.all(item.sites.map(site => checkSummary(dir, { site: site.id, batch: item.id, analysis: true })));
        entries.push([item.id, jobs.every(Boolean) ? 'done' : state?.state ?? 'running']);
      }
      if (active) setStatuses(Object.fromEntries(entries));
    })().catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [dir, history, revision, statusFilter]);

  useEffect(() => {
    if (!batch) return;
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      const state = await multiSiteExecution(dir, batch.id);
      const ids = batch.sites.map(item => item.id);
      const progress = await multiSiteProgress(dir, batch.id, ids, batch.rowsPerSite, signal);
      const evidence = await multiSiteEvidenceCounts(dir,
        countScope ? { ...batch, sites: batch.sites.filter(item => item.id === countScope) } : batch, signal);
      if (signal.aborted) return;
      const selectedIds = countScope ? [countScope] : ids;
      setRunState(state?.state ?? 'running');
      setCompletedSites([...progress.values()].filter(item => item.done).length);
      setCounts(selectedIds.reduce((sum, id) => ({
        processed: sum.processed + (progress.get(id)?.processed ?? 0),
        accepted: sum.accepted + (evidence.get(id)?.accepted ?? 0),
        valid: sum.valid + (evidence.get(id)?.valid ?? 0),
      }), { processed: 0, accepted: 0, valid: 0 }));
    })().catch(failure => { if (!signal.aborted) setError(String(failure)); });
    return () => controller.abort();
  }, [dir, batch, revision, countScope]);

  async function control(id: string, state: MultiSiteExecution) {
    setBusy(true);
    setError('');
    try {
      await setMultiSiteExecution(dir, id, state);
      if (state === 'running') await dispatchMultiSiteQueue(dir, id);
    } catch (failure) { setError(String(failure)); }
    finally { setBusy(false); }
  }

  if (!loading && !error && !history.length) return null;

  return <section className="card stack">
    <h2>多站批次历史</h2>
    {loading && <p role="status">正在读取多站批次…</p>}
    {error && <p role="alert">{error}</p>}
    <label>按批次名称或编号搜索<input value={query} onChange={event => {
      setQuery(event.target.value);
      setPage(0);
    }} /></label>
    <label>批次状态<select value={statusFilter} onChange={event => { setStatusFilter(event.target.value); setPage(0); }}>
      <option value="">全部状态</option><option value="running">可执行</option><option value="done">已完成</option>
      <option value="paused">已暂停</option><option value="interrupted">已中断</option><option value="stopped">已停止</option>
    </select></label>
    {!matches.length && !loading && <p>暂无匹配批次。</p>}
    <ul className="catalog-list">
      {matches.slice(current * pageSize, (current + 1) * pageSize).map(item => <li key={item.id}>
        <button className="secondary" disabled={busy} aria-pressed={selected === item.id} onClick={() => {
          setSelected(item.id);
          setCountScope('');
          setCounts(undefined);
          setCompletedSites(0);
          setRunState('running');
          setSite(item.sites[0]?.id ?? '');
        }}>{item.name || item.listName}</button>
        <span>{new Date(item.createdAt).toLocaleString()} · {item.sites.length} 站 · {item.sites.length * item.rowsPerSite} 组合</span>
        <span>{item.id}</span>
      </li>)}
    </ul>
    {matches.length > pageSize && <div className="controls">
      <button className="secondary" disabled={current === 0} onClick={() => setPage(current - 1)}>上一页批次</button>
      <button className="secondary" disabled={(current + 1) * pageSize >= matches.length} onClick={() => setPage(current + 1)}>下一页批次</button>
    </div>}
    {batch && <>
      <p role="status">完成 {completedSites} / {batch.sites.length} 站
        · {completedSites === batch.sites.length ? '已完成' : { running: '可执行', paused: '已暂停', interrupted: '已中断', stopped: '已停止' }[runState]}</p>
      {completedSites < batch.sites.length && <div className="controls">
        <button className="secondary" disabled={busy || runState === 'paused'} onClick={() => void control(batch.id, 'paused')}>暂停调度</button>
        <button className="secondary" disabled={busy || runState === 'interrupted'} onClick={() => void control(batch.id, 'interrupted')}>中断批次</button>
        <button className="secondary" disabled={busy || runState === 'stopped'} onClick={() => void control(batch.id, 'stopped')}>停止自动执行</button>
        <button disabled={busy} onClick={() => void control(batch.id, 'running')}>继续批次</button>
      </div>}
      <label>进度范围<select value={countScope} onChange={event => { setCounts(undefined); setCountScope(event.target.value); }}>
        <option value="">全批</option>
        {batch.sites.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      {counts ? <p role="status">候选 {batch.rowsPerSite * (countScope ? 1 : batch.sites.length)} · 已处理 {counts.processed}
        {' · 待处理 '}{batch.rowsPerSite * (countScope ? 1 : batch.sites.length) - counts.processed}
        {' · 已接收 '}{counts.accepted}{' · 有效 '}{counts.valid}</p>
        : <p role="status">正在读取批次进度…</p>}
      <button className="secondary" onClick={() => setRevision(value => value + 1)}>刷新批次进度</button>
      <label>导出结果状态<select value={exportScope} onChange={event => setExportScope(event.target.value as MultiSiteReportScope)}>
        <option value="all">全部记录</option><option value="accepted">已接收</option><option value="valid">有效</option>
        <option value="missing">失效</option><option value="pending">待公开或待核实</option>
      </select></label>
      <button className="secondary" disabled={busy} onClick={async () => {
        setBusy(true);
        setError('');
        try { await downloadMultiSiteReport(dir, batch, countScope, exportScope); }
        catch (failure) { setError(String(failure)); }
        finally { setBusy(false); }
      }}>导出当前范围 CSV</button>
      <label>查看批次内站点<select value={site} disabled={busy} onChange={event => setSite(event.target.value)}>
        {batch.sites.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <button disabled={!site || busy} onClick={async () => {
        setBusy(true);
        setError('');
        try { await onOpen(batch.id, site); }
        catch (failure) { setError(String(failure)); }
        finally { setBusy(false); }
      }}>打开该站结果</button>
    </>}
  </section>;
}
