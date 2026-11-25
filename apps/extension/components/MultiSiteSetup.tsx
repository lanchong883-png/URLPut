import { useEffect, useRef, useState } from 'react';
import { importBatchSchema, MAX_ROWS, type Workspace } from '@urlput/contracts';
import { buildLedger } from '@urlput/import';
import { dispatchMultiSiteQueue, scheduleMultiSiteBatch } from '../lib/check-queue';
import { isActiveLink, localLinkLists, type LocalLinkList } from '../lib/local-link-lists';
import { localAcceptedUrls, type MultiSiteBatch } from '../lib/local-directory';
import { loadModels, validateProfile, type ModelProfile } from '../lib/models';
import { requestCheckAccess } from './BatchChecks';
import { BatchDraftSettings } from './BatchDraftSettings';
import { defaultDraftTemplates, draftTemplates, type DraftConfig, type DraftTemplate } from '../lib/draft-config';

export function MultiSiteSetup({ dir, workspace, visible, onOpenLibrary, onStarted, onBusy }: {
  dir?: FileSystemDirectoryHandle;
  visible: boolean;
  onOpenLibrary?: (type: 'sites' | 'links') => void;
  workspace: Workspace;
  onStarted: (batch: MultiSiteBatch) => Promise<void>;
  onBusy: (busy: boolean) => void;
}) {
  const [lists, setLists] = useState<LocalLinkList[]>([]);
  const [listId, setList] = useState('');
  const [siteIds, setSites] = useState<string[]>([]);
  const [linkIds, setLinks] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [cap, setCap] = useState('');
  const [execute, setExecute] = useState(false);
  const [templates, setTemplates] = useState<DraftTemplate[]>(defaultDraftTemplates);
  const [config, setConfig] = useState<DraftConfig>({
    strategy: 'template', templates: defaultDraftTemplates, dailyLimit: 5, siteLimits: {}, automaticNextRound: false,
  });
  const [siteQuery, setSiteQuery] = useState('');
  const [linkQuery, setLinkQuery] = useState('');
  const [type, setType] = useState('');
  const [price, setPrice] = useState('');
  const [rel, setRel] = useState('');
  const [minDr, setMinDr] = useState('');
  const [siteLimit, setSiteLimit] = useState(5);
  const [linkLimit, setLinkLimit] = useState(5);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [receiptError, setReceiptError] = useState('');
  const [receipts, setReceipts] = useState<{ selection: string[]; urls: Set<string>[] }>();
  const pending = useRef<MultiSiteBatch>(null);
  const returnFocus = useRef<HTMLButtonElement>(null);
  const siteLibrary = useRef<HTMLButtonElement>(null);
  const linkLibrary = useRef<HTMLButtonElement>(null);
  const list = lists.find(item => item.id === listId);
  const sites = workspace.sites.filter(site => !site.inactive);
  const chosenSites = new Set(siteIds);
  const selectedSites = sites.filter(site => chosenSites.has(site.id));
  const activeLinks = list?.links.filter(link => isActiveLink(link)) ?? [];
  const visibleLinks = activeLinks.filter(link =>
    [link.url, link.type, link.price, ...link.sources.map(source => source.row.notes)].some(value =>
      value?.toLowerCase().includes(linkQuery.trim().toLowerCase())) &&
    (!type || link.type === type) && (!price || link.price === price) && (!rel || link.rel === rel) &&
    (!minDr || (link.dr !== undefined && link.dr.value >= Number(minDr))));
  const linkFilters = [
    { label: '网站类型', field: 'type', value: type, setValue: setType },
    { label: '价格', field: 'price', value: price, setValue: setPrice },
    { label: '样本链接属性', field: 'rel', value: rel, setValue: setRel },
  ] as const;
  const visibleSites = sites.filter(site => `${site.name} ${site.homepage}`.toLowerCase().includes(siteQuery.trim().toLowerCase()));
  const validCap = !cap || (/^\d+$/.test(cap) && Number(cap) >= 1 && Number(cap) <= MAX_ROWS);
  const chosenLinks = new Set(linkIds);
  const selectedLinks = activeLinks.filter(link => chosenLinks.has(link.url));
  const candidates = selectedLinks.slice(0, cap && validCap ? Number(cap) : MAX_ROWS);
  const combinationCount = selectedSites.length * candidates.length;
  const validLimit = (value: number) => Number.isInteger(value) && value >= 1 && value <= MAX_ROWS;
  const validExecution = !execute || ((config.strategy === 'ai' || config.templates.length > 0) &&
    validLimit(config.dailyLimit) && Object.values(config.siteLimits).every(validLimit));

  const selectedCandidateUrls = new Set(candidates.map(link => link.url));
  const receiptReady = !siteIds.length || receipts?.selection === siteIds;
  const received = receipts?.selection === siteIds ? receipts.urls.reduce((sum, urls, index) =>
    sum + (selectedSites.some(site => site.id === siteIds[index])
      ? [...urls].filter(url => selectedCandidateUrls.has(url)).length : 0), 0) : 0;

  useEffect(() => {
    if (!dir || !visible || !siteIds.length) return;
    let active = true;
    setReceiptError('');
    void Promise.all(siteIds.map(id => localAcceptedUrls(dir, id))).then(urls => {
      if (active) setReceipts({ selection: siteIds, urls });
    }).catch(failure => { if (active) setReceiptError(String(failure)); });
    return () => { active = false; };
  }, [dir, siteIds, visible]);

  useEffect(() => {
    if (!visible) return;
    returnFocus.current?.focus();
    returnFocus.current = null;
    if (!dir) return;
    let active = true;
    setLoading(true);
    void Promise.all([localLinkLists(dir), draftTemplates(dir)]).then(([data, available]) => {
      if (!active) return;
      setLists(data);
      setTemplates(available);
      setConfig(current => ({
        ...current,
        templates: current.templates.flatMap(chosen => {
          const latest = available.find(item => item.id === chosen.id);
          return latest ? [latest] : [];
        }),
      }));
    })
      .catch(failure => { if (active) setError(String(failure)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [dir, visible]);

  function toggle(values: string[], id: string, apply: (values: string[]) => void) {
    apply(values.includes(id) ? values.filter(key => key !== id) : [...values, id]);
  }

  async function start() {
    if (!dir || !list || !combinationCount || busy || !validCap || !validExecution) return;
    setError('');
    setBusy(true);
    onBusy(true);
    try {
      const batch = pending.current ?? {
        id: crypto.randomUUID(), name: name.trim(), workspace: workspace.id, createdAt: new Date().toISOString(),
        sites: selectedSites, listId: list.id, listName: list.name,
        sources: candidates.map(link => link.sources),
        ...(execute ? { execution: config } : {}),
      };
      const input = pending.current?.input ?? importBatchSchema.parse({
        requestId: batch.id,
        source: 'paste',
        filename: list.name.slice(0, 255),
        rows: candidates.map(link => link.sources[0].row),
      });
      await requestCheckAccess(buildLedger(input.rows));
      let model: ModelProfile | undefined;
      if (!pending.current && execute && config.strategy !== 'template') {
        try {
          const { profiles, active } = await loadModels();
          if (profiles[active].writing) model = validateProfile(profiles[active]);
        } catch { /* An unavailable model becomes manual review. */ }
      }
      const snapshot = pending.current ?? {
        ...batch, input, ...(execute ? { execution: { ...config, model } } : {}),
      };
      pending.current = snapshot;
      await scheduleMultiSiteBatch(dir, snapshot);
      await dispatchMultiSiteQueue(dir, snapshot.id);
      await onStarted(snapshot);
      pending.current = null;
      setSites([]);
      setLinks([]);
      setList('');
      setName('');
      setCap('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally {
      setBusy(false);
      onBusy(false);
    }
  }

  return <>
    {error && <p role="alert">{error}</p>}
    <fieldset disabled={busy || Boolean(pending.current)} className="card stack">
      <legend>1 推广站点</legend>
      {onOpenLibrary && <button ref={siteLibrary} className="secondary" onClick={() => {
        returnFocus.current = siteLibrary.current;
        onOpenLibrary('sites');
      }}>去清单补充站点</button>}
      <label>筛选批次站点<input value={siteQuery} onChange={event => { setSiteQuery(event.target.value); setSiteLimit(5); }} /></label>
      {!visibleSites.length && <p>暂无可选推广站点，请在清单中添加。</p>}
      {visibleSites.slice(0, siteLimit).map(site => <label key={site.id} className="inline">
        <input type="checkbox" checked={siteIds.includes(site.id)} onChange={() => toggle(siteIds, site.id, setSites)} /> {site.name}
      </label>)}
      {visibleSites.length > siteLimit && <button className="secondary" onClick={() => setSiteLimit(value => value + 5)}>显示更多批次站点</button>}
      <div className="controls">
        <button className="secondary" onClick={() => setSites([...new Set([...siteIds, ...visibleSites.map(site => site.id)])])}>全选匹配站点</button>
        <button className="secondary" onClick={() => setSites([])}>清空站点</button>
      </div>
    </fieldset>
    <fieldset disabled={busy || Boolean(pending.current)} className="card stack">
      <legend>2 外链清单</legend>
      {onOpenLibrary && <button ref={linkLibrary} className="secondary" onClick={() => {
        returnFocus.current = linkLibrary.current;
        onOpenLibrary('links');
      }}>去管理外链清单</button>}
      {loading && <p role="status">正在读取外链清单…</p>}
      <label>批次使用的外链清单<select value={listId} disabled={loading} onChange={event => {
        const id = event.target.value;
        setList(id);
        setLinks(lists.find(item => item.id === id)?.links.filter(link => isActiveLink(link)).map(link => link.url) ?? []);
        setLinkQuery('');
        setType(''); setPrice(''); setRel(''); setMinDr('');
        setLinkLimit(5);
      }}>
        <option value="">选择已保存外链清单</option>
        {lists.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      {list && <>
        <label>筛选批次候选<input value={linkQuery} onChange={event => { setLinkQuery(event.target.value); setLinkLimit(5); }} /></label>
        <details>
          <summary>筛选条件</summary>
          <div className="controls">
            {linkFilters.map(filter => <label key={filter.field}>{filter.label}<select value={filter.value} onChange={event => {
              filter.setValue(event.target.value);
              setLinkLimit(5);
            }}>
              <option value="">不限</option>
              {[...new Set(activeLinks.flatMap(link => link[filter.field] ? [link[filter.field]] : []))].sort().map(value =>
                <option key={value} value={value}>{value}</option>)}
            </select></label>)}
            <label>最低 DR<input type="number" min={0} max={100} value={minDr} onChange={event => {
              setMinDr(event.target.value);
              setLinkLimit(5);
            }} /></label>
          </div>
        </details>
        {!visibleLinks.length && <p>暂无匹配的活跃外链。</p>}
        {visibleLinks.slice(0, linkLimit).map(link => <label key={link.url} className="inline">
          <input type="checkbox" checked={linkIds.includes(link.url)} onChange={() => toggle(linkIds, link.url, setLinks)} />
          <span>{link.url}<br />{link.dr ? `DR ${link.dr.value} · ${link.dr.source} · ${link.dr.observedAt}` : 'DR 未知'}</span>
        </label>)}
        {visibleLinks.length > linkLimit && <button className="secondary" onClick={() => setLinkLimit(value => value + 5)}>显示更多候选</button>}
        <div className="controls">
          <button className="secondary" onClick={() => setLinks(visibleLinks.map(link => link.url))}>只选筛选结果</button>
          <button className="secondary" onClick={() => setLinks([])}>清空外链选择</button>
        </div>
      </>}
    </fieldset>
    <fieldset className="card stack" disabled={busy || Boolean(pending.current)}>
      <legend>3 执行方式</legend>
      <label>执行方式<select value={execute ? 'execute' : 'analysis'} onChange={event => setExecute(event.target.value === 'execute')}>
        <option value="analysis">仅分析</option><option value="execute">分析后准备人工投稿</option>
      </select></label>
    </fieldset>
    {execute && <fieldset className="draft-sections" disabled={busy || Boolean(pending.current)} aria-label="人工投稿配置">
      <BatchDraftSettings config={config} templates={templates} sites={selectedSites} onChange={setConfig} />
    </fieldset>}
    <fieldset disabled={busy || Boolean(pending.current)} className="card stack">
      <legend>{execute ? 7 : 4} 批次设置</legend>
      <label>批次名称<input value={name} maxLength={120} onChange={event => setName(event.target.value)} /></label>
      <label>每站候选上限<input type="number" min={1} max={MAX_ROWS} value={cap} onChange={event => setCap(event.target.value)} /></label>
    </fieldset>
    <section className="card stack">
      <h2>{execute ? 8 : 5} 启动前确认</h2>
      <p>{selectedSites.length} 个站点，每站 {candidates.length} 条候选，共 {combinationCount.toLocaleString()} 个组合。</p>
      {receiptError ? <p role="alert">{receiptError}</p> : receiptReady
        ? <p>已接收 {received} · 待接收 {combinationCount - received}</p>
        : <p role="status">正在核对接收回执…</p>}
      <button disabled={busy || !dir || loading || !validCap || !combinationCount || !receiptReady || !validExecution} onClick={() => void start()}>
        {busy ? '正在启动…' : pending.current ? '重试启动原批次' : execute ? '启动分析并准备草稿' : '启动多站分析'}
      </button>
    </section>
  </>;
}
