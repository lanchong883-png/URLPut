import { useEffect, useState } from 'react';
import { observeSubmissionReviews } from '../lib/review-events';
import { pendingSubmissionReviews, type ReviewQueueItem } from '../lib/local-review-queue';

export function PendingSubmissionReviews({ dir, onOpen }: {
  dir: FileSystemDirectoryHandle;
  onOpen: (batch: string, site: string, sequence: number) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ReviewQueueItem[]>([]);
  const [limit, setLimit] = useState(5);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    return observeSubmissionReviews(() => setRevision(value => value + 1));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void pendingSubmissionReviews(dir, controller.signal).then(data => {
      if (!controller.signal.aborted) setRows(data);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(String(failure));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [dir, open, revision]);

  return <details className="card" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>跨批投稿待确认</summary>
    {open && <div className="stack">
      {error && <p role="alert">{error}</p>}
      {loading ? <p role="status">正在核对投稿占位与回执…</p>
        : <p>共 {rows.length} 条待确认。</p>}
      <ul className="catalog-list">
        {rows.slice(0, limit).map(row => <li key={`${row.batch}-${row.site}-${row.sequence}`}>
          <strong>{row.siteName} · 第 {row.sequence} 条</strong>
          <span>{row.entry}</span><span>{row.reason}</span>
          <button className="secondary" onClick={() =>
            void onOpen(row.batch, row.site, row.sequence).catch(failure => setError(String(failure)))}>查看原批次</button>
        </li>)}
      </ul>
      {rows.length > limit && <button className="secondary" onClick={() => setLimit(value => value + 5)}>显示更多待确认</button>}
      <button className="secondary" disabled={loading} onClick={() => setRevision(value => value + 1)}>刷新待确认</button>
    </div>}
  </details>;
}
