import { useEffect, useState } from 'react';
import type { Batch } from '../lib/api';
import { approveSubmission, submissionApprovals, type SubmissionApproval } from '../lib/local-directory';

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
        <p>发布前请在平台核对是否已有记录。平台接收后，在本批次登记待审核回执。</p>
        <a href={saved.entry} target="_blank" rel="noopener noreferrer">打开投稿入口</a>
      </>}
      {row?.review && <p>此条已有待审核回执。</p>}
      {error && <p role="alert">{error}</p>}
    </form>}
  </details>;
}
