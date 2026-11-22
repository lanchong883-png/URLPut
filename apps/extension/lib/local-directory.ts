import { importBatchSchema, workspaceSchema, type ImportBatch, type Workspace } from '@urlput/contracts';
import { buildLedger, normalizeUrl } from '@urlput/import';
import type { Batch, BatchSummary, ReviewReceipt } from './api';
import type { LinkRecord } from './comment-evidence';

type Directory = FileSystemDirectoryHandle;
type DirectoryPermission = Directory & {
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
};

export function directoryPermission(dir: Directory, request = false) {
  const handle = dir as DirectoryPermission;
  return request ? handle.requestPermission({ mode: 'readwrite' }) : handle.queryPermission({ mode: 'readwrite' });
}
const lock = 'urlput-directory-writes';
const directoryName = 'URLPut-data-v1';
const workspaceFile = 'workspace.json';
export const activeUrlLock = 'urlput-active-url';
export const queueFilesLock = 'urlput-check-queue-files';

export async function read<T>(dir: Directory, name: string): Promise<T | undefined> {
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    return JSON.parse(await file.text());
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return undefined;
    throw error;
  }
}

export async function write(dir: Directory, name: string, value: unknown) {
  const text = JSON.stringify(value);
  const stream = await (await dir.getFileHandle(name, { create: true })).createWritable();
  try {
    await stream.write(text);
    await stream.close();
  } catch (error) {
    await stream.abort().catch(() => {});
    throw error;
  }
}

export async function workspaceFor(dir: Directory): Promise<Workspace> {
  const value = await read<{ version: number; workspace: unknown }>(dir, workspaceFile);
  if (value?.version !== 1) throw new Error('无法识别本机工作空间格式。');
  return workspaceSchema.parse(value.workspace);
}

async function requireEmpty(dir: Directory, error: string) {
  for await (const _ of dir.keys()) throw new Error(error);
}

export async function openDirectory(parent: Directory) {
  const dir = await parent.getDirectoryHandle(directoryName);
  await workspaceFor(dir);
  return dir;
}

export async function prepareDirectory(parent: Directory) {
  const dir = await parent.getDirectoryHandle(directoryName, { create: true });
  await navigator.locks.request(lock, async () => {
    if (await read(dir, workspaceFile) !== undefined) {
      await workspaceFor(dir);
    } else {
      await requireEmpty(dir, '此数据目录缺少工作空间文件，可能是未完成的副本。请选择完整备份或其他目录。');
      await write(dir, workspaceFile, { version: 1, workspace: { id: crypto.randomUUID(), name: parent.name, sites: [] } });
    }
  });
  return dir;
}

export function copyDirectory(source: Directory, parent: Directory) {
  return navigator.locks.request(activeUrlLock, { ifAvailable: true }, async active => {
    if (!active) throw new Error('有只读任务正在运行，请等当前操作结束后再复制数据目录。');
    return navigator.locks.request(lock, () => navigator.locks.request(queueFilesLock, async () => {
      await workspaceFor(source);
      if (await source.resolve(parent)) throw new Error('请选择源数据目录之外的目标文件夹。');
      const target = await parent.getDirectoryHandle(directoryName, { create: true });
      await requireEmpty(target, '目标已有 URLPut 数据或未完成的副本。请选择另一个空目标。');
      async function copy(handle: FileSystemFileHandle) {
        const file = await handle.getFile();
        const destination = await target.getFileHandle(handle.name, { create: true });
        await file.stream().pipeTo(await destination.createWritable());
      }
      for await (const [name, handle] of source.entries()) {
        if (name !== workspaceFile && handle.kind === 'file' && name.endsWith('.json')) {
          await copy(handle as FileSystemFileHandle);
        }
      }
      // Publish the workspace only after its data files have been committed.
      await copy(await source.getFileHandle(workspaceFile));
      return target;
    }));
  });
}

export async function addSite(dir: Directory, address: string) {
  const homepage = normalizeUrl(address);
  if (!homepage) throw new Error('请输入公开的 HTTP 或 HTTPS 官网地址。');
  return navigator.locks.request(lock, async () => {
    const workspace = await workspaceFor(dir);
    const site = workspace.sites.find(item => item.homepage === homepage)
      ?? { id: crypto.randomUUID(), name: new URL(homepage).hostname, homepage };
    if (!workspace.sites.some(item => item.id === site.id)) {
      workspace.sites.push(site);
      await write(dir, workspaceFile, { version: 1, workspace });
    }
    return { workspace, site };
  });
}

export async function localHistory(dir: Directory, site: string) {
  return await read<BatchSummary[]>(dir, site + '.index.json') ?? [];
}

type StoredBatch = { site: string; createdAt: string; input: ImportBatch };

function restore(stored: StoredBatch, site: string, id: string): Batch {
  const input = importBatchSchema.parse(stored.input);
  if (stored.site !== site || input.requestId !== id) throw new Error('批次与所选站点不匹配。');
  return { id, source: input.source, filename: input.filename ?? null, createdAt: stored.createdAt, rows: buildLedger(input.rows) };
}

export async function localBatch(dir: Directory, site: string, id: string) {
  const stored = await read<StoredBatch>(dir, site + '-' + id + '.json');
  if (!stored) throw new Error('找不到所选批次文件。');
  const batch = restore(stored, site, id);
  const receipts = await read<Record<string, ReviewReceipt>>(dir, site + '-' + id + '.reviews.json');
  if (receipts) {
    for (const row of batch.rows) row.review = receipts[row.sequence];
  }
  return batch;
}

export type RevisitQueue = {
  id: string;
  entries: Pick<LinkRecord, 'page' | 'target'>[];
  next: number;
  problems: number;
};

type VerificationLedger = { links: LinkRecord[]; revisit?: RevisitQueue };

export async function verificationLedger(dir: Directory, site: string): Promise<VerificationLedger> {
  const saved = await read<LinkRecord[] | VerificationLedger>(dir, site + '.verified.json');
  return Array.isArray(saved) ? { links: saved } : saved ?? { links: [] };
}

export function saveVerificationLedger(dir: Directory, site: string, ledger: VerificationLedger) {
  return write(dir, site + '.verified.json', ledger);
}

export async function localReportBatch(dir: Directory, site: string, id: string) {
  const batch = await localBatch(dir, site, id);
  if (!batch.rows.some(row => row.review)) return batch;
  const { links } = await verificationLedger(dir, site);
  const byRow = new Map<number, LinkRecord>();
  for (const link of links) {
    for (const receipt of link.receipts ?? []) {
      if (receipt.batch === id && !byRow.has(receipt.sequence)) byRow.set(receipt.sequence, link);
    }
  }
  for (const row of batch.rows) {
    if (row.review) row.verification = byRow.get(row.sequence);
  }
  return batch;
}

export type SubmissionApproval = {
  id: string;
  batch: string;
  sequence: number;
  source: string;
  entry: string;
  draft: string;
  approvedAt: string;
};

export async function submissionApprovals(dir: Directory, site: string) {
  return await read<SubmissionApproval[]>(dir, site + '.submissions.json') ?? [];
}

export function approveSubmission(dir: Directory, site: string, id: string, sequence: number, draft: string) {
  const content = draft.trim();
  if (!content || content.length > 5000) throw new Error('请填写 1–5,000 字的投稿内容。');
  return navigator.locks.request(lock, async () => {
    const batch = await localBatch(dir, site, id);
    const row = batch.rows.find(item => item.sequence === sequence);
    if (row?.disposition !== 'candidate' || !row.normalizedUrl) throw new Error('请选择有效的候选记录。');
    if (row.review) throw new Error('此条已有待审核回执。');
    const existing = await submissionApprovals(dir, site);
    if (existing.some(item => item.source === row.normalizedUrl)) {
      throw new Error('此推广站点已有该网址的投稿占位，请核对原批次和平台状态。');
    }
    for (const batch of await localHistory(dir, site)) {
      const receipts = await read<Record<string, ReviewReceipt>>(dir, site + '-' + batch.id + '.reviews.json');
      if (!receipts) continue;
      const stored = await localBatch(dir, site, batch.id);
      if (stored.rows.some(item => item.review && item.normalizedUrl === row.normalizedUrl)) {
        throw new Error('此推广站点已有该网址的待审核回执，请核对原批次。');
      }
    }
    const approval = {
      id: crypto.randomUUID(), batch: id, sequence, source: row.normalizedUrl,
      entry: row.normalizedEntry || row.normalizedUrl, draft: content, approvedAt: new Date().toISOString(),
    };
    await write(dir, site + '.submissions.json', [...existing, approval]);
    return approval;
  });
}

export async function recordPendingReview(dir: Directory, site: string, id: string, sequence: number, evidence: string, submittedAt: string) {
  const time = Date.parse(submittedAt);
  if (!evidence.trim() || evidence.length > 1000 || !Number.isFinite(time) || time > Date.now()) {
    throw new Error('请填写平台的待审核提示或回执编号，以及实际提交时间。');
  }
  return navigator.locks.request(lock, async () => {
    const batch = await localBatch(dir, site, id);
    const row = batch.rows.find(item => item.sequence === sequence);
    if (!row || row.disposition !== 'candidate') throw new Error('请选择有效的候选记录。');
    if (row.review) throw new Error('此条已有待审核回执。');
    const filename = site + '-' + id + '.reviews.json';
    const receipts = Object.fromEntries(batch.rows.filter(item => item.review).map(item => [item.sequence, item.review]));
    row.review = { evidence: evidence.trim(), submittedAt: new Date(time).toISOString(), recordedAt: new Date().toISOString() };
    receipts[sequence] = row.review;
    await write(dir, filename, receipts);
    return batch;
  });
}

export async function saveLocalBatch(dir: Directory, site: string, input: ImportBatch, createdAt = new Date().toISOString()) {
  return navigator.locks.request(lock, async () => {
    const filename = site + '-' + input.requestId + '.json';
    const existing = await read<StoredBatch>(dir, filename);
    const stored = existing ?? { site, createdAt, input };
    if (existing && JSON.stringify(existing.input) !== JSON.stringify(input)) throw new Error('该批次编号已被使用。');
    const batch = restore(stored, site, input.requestId);
    const history = await localHistory(dir, site);
    if (!existing) await write(dir, filename, stored);
    if (!history.some(item => item.id === batch.id)) {
      const { rows, ...summary } = batch;
      history.push({ ...summary, rowCount: rows.length });
      history.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      await write(dir, site + '.index.json', history);
    }
    return { batch, history };
  });
}

export async function directoryBinding(handle?: Directory): Promise<Directory | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('urlput-directory-settings', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('settings');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('settings', handle ? 'readwrite' : 'readonly');
      const store = tx.objectStore('settings');
      const op = handle ? store.put(handle, 'directory') : store.get('directory');
      tx.oncomplete = () => { db.close(); resolve(handle ?? op.result); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

export async function registerMigratedSite(dir: Directory, site: Workspace['sites'][number]) {
  return navigator.locks.request(lock, async () => {
    const workspace = await workspaceFor(dir);
    const existing = workspace.sites.find(item => item.id === site.id);
    if (existing && existing.homepage !== site.homepage) throw new Error('本机站点 ID 与原站点网址冲突。');
    if (!existing) {
      workspace.sites.push(site);
      await write(dir, workspaceFile, { version: 1, workspace });
    }
  });
}
