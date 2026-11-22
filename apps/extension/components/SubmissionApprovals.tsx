import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type { Batch } from '../lib/api';
import { approveSubmission, startSubmission, submissionApprovals, type SubmissionApproval } from '../lib/local-directory';

export function SubmissionApprovals({ dir, site, batch }: { dir: FileSystemDirectoryHandle; site: string; batch: Batch }) {
  const [open, setOpen] = useState(false);
  const [approvals, setApprovals] = useState<SubmissionApproval[]>([]);
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const row = batch.rows.find(item => item.sequence === Number(selected));
  const saved = approvals.find(item => item.source === row?.normalizedUrl);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void submissionApprovals(dir, site).then(items => {
      if (active) setApprovals(items);
    }).catch(failure => { if (active) setError(String(failure)); });
    return () => { active = false; };
  }, [dir, site, open]);

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

  return <details className="card" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>逐条批准手动投稿</summary>
    {open && <form className="stack" onSubmit={async event => {
      event.preventDefault();
      if (!row || saved) return;
      setBusy(true);
      setError('');
      try {
        const approval = await approveSubmission(dir, site, batch.id, row.sequence, draft);
        setApprovals(items => [...items, approval]);
        setDraft('');
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      } finally { setBusy(false); }
    }}>
      <label>投稿候选<select value={selected} disabled={busy} required onChange={event => {
        setSelected(event.target.value);
        setDraft('');
        setError('');
      }}>
        <option value="">请选择一条候选记录</option>
        {batch.rows.filter(item => item.disposition === 'candidate').map(item =>
          <option key={item.sequence} value={item.sequence}>第 {item.sequence} 条 · {item.url}</option>)}
      </select></label>
      {row && <p>投稿入口 · {row.normalizedEntry || row.normalizedUrl}</p>}
      {row && !saved && !row.review && <>
        <label>投稿内容<textarea required maxLength={5000} value={draft} onChange={event => setDraft(event.target.value)} /></label>
        <button disabled={busy}>批准此条并保存投稿占位</button>
      </>}
      {saved && <p role="status">已批准并保存投稿占位。来源批次 {saved.batch} · 第 {saved.sequence} 条。</p>}
      {saved?.batch === batch.id && !row?.review && <>
        <label>已批准内容<textarea readOnly value={saved.draft} /></label>
        {saved.startedAt === null && <button type="button" disabled={busy} onClick={() => void start(saved)}>开始单次手动投稿</button>}
        {saved.startedAt && <p role="status">已开始一次投稿。请核对原平台状态，取得回执后在本批次登记。</p>}
        {saved.startedAt === undefined && <p role="status">旧版占位缺少开始状态，请先核对原平台。</p>}
      </>}
      {row?.review && <p>此条已有待审核回执。</p>}
      {error && <p role="alert">{error}</p>}
    </form>}
  </details>;
}
