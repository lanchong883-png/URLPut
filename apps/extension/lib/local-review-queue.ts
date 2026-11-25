import { draftBlockers } from './draft-config';
import { conclusion } from './comment-evidence';
import { read, skippedSubmissions, submissionApprovals, verificationLedger, workspaceFor, type MultiSiteSummary } from './local-directory';
import type { ReviewReceipt } from './api';

type Directory = FileSystemDirectoryHandle;

function batchReceipts(dir: Directory, site: string, batch: string) {
  return read<Record<string, ReviewReceipt>>(dir, `${site}-${batch}.reviews.json`);
}

export async function multiSiteEvidenceCounts(dir: Directory, batch: MultiSiteSummary, signal?: AbortSignal) {
  const counts = new Map<string, { accepted: number; valid: number }>();
  for (const site of batch.sites) {
    if (signal?.aborted) break;
    const receipts = await batchReceipts(dir, site.id, batch.id);
    if (!receipts) {
      counts.set(site.id, { accepted: 0, valid: 0 });
      continue;
    }
    const valid = new Set<number>();
    for (const link of (await verificationLedger(dir, site.id)).links) {
      if (conclusion(link) !== 'valid') continue;
      for (const receipt of link.receipts ?? []) {
        if (receipt.batch === batch.id && receipts[receipt.sequence]) valid.add(receipt.sequence);
      }
    }
    counts.set(site.id, { accepted: Object.keys(receipts).length, valid: valid.size });
  }
  return counts;
}

export type ReviewQueueItem = { batch: string; site: string; siteName: string; entry: string; sequence: number; reason: string };

export async function pendingSubmissionReviews(dir: Directory, signal?: AbortSignal) {
  const rows: ReviewQueueItem[] = [];
  for (const site of (await workspaceFor(dir)).sites) {
    if (signal?.aborted) break;
    const approvals = await submissionApprovals(dir, site.id);
    const receipts = new Map<string, Record<string, ReviewReceipt>>();
    async function hasReceipt(batch: string, sequence: number) {
      if (!receipts.has(batch)) receipts.set(batch, await batchReceipts(dir, site.id, batch) ?? {});
      return Boolean(receipts.get(batch)?.[sequence]);
    }
    const skippedByBatch = new Map<string, Record<string, string>>();
    const approved = new Set(approvals.map(item => `${item.batch}:${item.sequence}`));
    for (const [key, item] of Object.entries(await draftBlockers(dir, site.id))) {
      if (signal?.aborted) return rows;
      if (approved.has(key) || await hasReceipt(item.batch, item.sequence)) continue;
      if (!skippedByBatch.has(item.batch)) skippedByBatch.set(item.batch, await skippedSubmissions(dir, site.id, item.batch));
      if (skippedByBatch.get(item.batch)?.[item.sequence]) continue;
      rows.push({ ...item, site: site.id, siteName: site.name });
    }
    for (const item of approvals) {
      if (signal?.aborted) return rows;
      if (await hasReceipt(item.batch, item.sequence)) continue;
      rows.push({
        batch: item.batch, site: site.id, siteName: site.name, sequence: item.sequence, entry: item.entry,
        reason: item.startedAt === null ? '已批准，等待用户手动提交' : '投稿结果待核对，请检查原平台记录',
      });
    }
  }
  return rows;
}
