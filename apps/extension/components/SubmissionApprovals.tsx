import { useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { normalizeUrl } from '@urlput/import';
import { batchDrafts, prepareBatchDraft } from '../lib/draft-config';
import type { Batch } from '../lib/api';
import { approveSubmission, readMultiSiteBatch, skipSubmission, skippedSubmissions, startSubmission, submissionApprovals, submissionQuota, type MultiSiteBatch, type SubmissionApproval } from '../lib/local-directory';

export function SubmissionApprovals({ dir, site, batch, initialSequence, onUpdate, onRegisterReceipt }: {
  dir: FileSystemDirectoryHandle; site: string; batch: Batch; initialSequence?: number; onUpdate?: () => Promise<void>; onRegisterReceipt?: (sequence: number) => void;
}) {
  const [open, setOpen] = useState(initialSequence !== undefined);
  const [approvals, setApprovals] = useState<SubmissionApproval[]>([]);
  const [selected, setSelected] = useState(initialSequence === undefined ? '' : String(initialSequence));
  const candidateSelect = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (initialSequence !== undefined) candidateSelect.current?.focus();
  }, [initialSequence]);
  const [draft, setDraft] = useState('');
  const [skipped, setSkipped] = useState<Record<string, string>>({});
  const [execution, setExecution] = useState<MultiSiteBatch>();
  const [draftSource, setDraftSource] = useState('');
  const [platform, setPlatform] = useState('');
  const [quota, setQuota] = useState<Awaited<ReturnType<typeof submissionQuota>>>();
  const [quotaRevision, setQuotaRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const row = batch.rows.find(item => item.sequence === Number(selected));
  const saved = approvals.find(item => item.source === row?.normalizedUrl);
  const recoveryEntry = saved?.startedAt && saved.batch === batch.id && saved.sequence === row?.sequence &&
    saved.entry === (row?.normalizedEntry || row?.normalizedUrl) && normalizeUrl(saved.entry) === saved.entry ? saved.entry : undefined;

  useEffect(() => {
    if (!open) return;
    let active = true;
    void Promise.all([submissionApprovals(dir, site), readMultiSiteBatch(dir, batch.id), skippedSubmissions(dir, site, batch.id)]).then(([items, snapshot, decisions]) => {
      if (active) { setApprovals(items); setExecution(snapshot); setSkipped(decisions); }
    }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [dir, site, open, batch.id]);

  useEffect(() => {
    if (!execution?.execution || !selected) return;
    let active = true;
    void batchDrafts(dir, batch.id, site).then(data => {
      const existing = data[selected];
      if (active && existing) {
        setDraft(current => current || existing.body);
        setDraftSource(existing.source);
      }
    }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [dir, batch.id, site, selected, execution]);

  useEffect(() => {
    const config = execution?.execution;
    if (!open || !config) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void submissionApprovals(dir, site).then(items => submissionQuota(dir, site, config, items)).then(result => {
      if (!active) return;
      setQuota(result);
      if (config.automaticNextRound && result.nextAt) {
        timer = setTimeout(() => setQuotaRevision(value => value + 1), Math.max(1, result.nextAt - Date.now()));
      }
    }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; clearTimeout(timer); };
  }, [dir, site, open, execution, approvals, quotaRevision]);

  async function start(approval: SubmissionApproval) {
    setBusy(true);
    setError('');
    try {
      const started = await startSubmission(dir, site, batch.id, approval.id);
      setApprovals(items => items.map(item => item.id === started.id ? started : item));
      await browser.tabs.create({ url: started.entry });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      try { setApprovals(await submissionApprovals(dir, site)); } catch { /* Preserve the original error. */ }
    } finally { setBusy(false); }
  }

  return <details className="card" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>逐条批准手动投稿</summary>
    {open && <form className="stack" onSubmit={async event => {
      event.preventDefault();
      if (!row || saved || skipped[row.sequence]) return;
      setBusy(true);
      setError('');
      try {
        const approval = await approveSubmission(dir, site, batch.id, row.sequence, draft,
          execution?.execution ? { platform, draftSource } : undefined);
        setApprovals(items => [...items, approval]);
        setDraft('');
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally { setBusy(false); }
    }}>
      <label>投稿候选<select ref={candidateSelect} value={selected} disabled={busy} required onChange={event => {
        setSelected(event.target.value);
        setDraft('');
        setDraftSource('');
        setPlatform('');
        setError('');
      }}>
        <option value="">请选择一条候选记录</option>
        {batch.rows.filter(item => item.disposition === 'candidate').map(item =>
          <option key={item.sequence} value={item.sequence}>第 {item.sequence} 条 · {item.url}</option>)}
      </select></label>
      {row && <p>投稿入口 · {row.normalizedEntry || row.normalizedUrl}</p>}
      {row && skipped[row.sequence] && <p role="status">此条已在本批次跳过投稿。</p>}
      {row && !saved && !row.review && !skipped[row.sequence] && <>
        {execution?.execution && <button type="button" className="secondary" disabled={busy} onClick={async () => {
          setBusy(true);
          setError('');
          try {
            const prepared = await prepareBatchDraft(dir, execution, site, row.sequence);
            setDraft(prepared.body);
            setDraftSource(prepared.source);
          } catch (failure) { setError(String(failure)); }
          finally { setBusy(false); }
        }}>准备并保存此条草稿</button>}
        {draftSource && <p role="status">草稿来源：{draftSource}</p>}
        {execution?.execution && <label>核对后的平台标识<input required maxLength={200} value={platform} disabled={busy}
          onChange={event => setPlatform(event.target.value)} placeholder="同一平台请使用同一标识" /></label>}
        <label>投稿内容<textarea disabled={busy} required maxLength={5000} value={draft} onChange={event => setDraft(event.target.value)} /></label>
        <button disabled={busy}>批准此条并保存投稿占位</button>
        {execution?.execution && <button type="button" className="secondary" disabled={busy} onClick={async () => {
          setBusy(true);
          setError('');
          try {
            setSkipped(await skipSubmission(dir, site, batch.id, row.sequence));
            await onUpdate?.();
          } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
          finally { setBusy(false); }
        }}>跳过此条投稿</button>}
      </>}
      {saved && <p role="status">已批准并保存投稿占位。来源批次 {saved.batch} · 第 {saved.sequence} 条。</p>}
      {saved?.batch === batch.id && !row?.review && <>
        <label>已批准内容<textarea readOnly value={saved.draft} /></label>
        {saved.draftSource && <p>草稿来源：{saved.draftSource}</p>}
        {saved.startedAt === null && quota && <p role="status">24 小时额度：{quota.used} / {quota.limit}
          {quota.nextAt ? ` · 可在 ${new Date(quota.nextAt).toLocaleString()} 后继续` : ''}</p>}
        {saved.startedAt === null && quota?.nextAt && !execution?.execution?.automaticNextRound &&
          <button type="button" className="secondary" onClick={() => setQuotaRevision(value => value + 1)}>检查下一轮额度</button>}
        {saved.startedAt === null && <button type="button" disabled={busy || Boolean(quota?.nextAt)} onClick={() => void start(saved)}>开始单次手动投稿</button>}
        {saved.startedAt && <p role="status">已开始一次投稿。请核对原平台状态，取得回执后在本批次登记。</p>}
        {recoveryEntry && <a href={recoveryEntry} target="_blank" rel="noopener noreferrer">打开原平台核对回执</a>}
        {saved.startedAt && saved.sequence === row?.sequence && onRegisterReceipt &&
          <button type="button" className="secondary" disabled={busy} onClick={() => onRegisterReceipt(saved.sequence)}>
            登记此条回执
          </button>}
        {saved.startedAt === undefined && <p role="status">旧版占位缺少开始状态，请先核对原平台。</p>}
      </>}
      {row?.review && <p>此条已有待审核回执。</p>}
      {error && <p role="alert">{error}</p>}
    </form>}
  </details>;
}
