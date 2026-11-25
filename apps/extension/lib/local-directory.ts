import { notifySubmissionReviewChanged } from './review-events';
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
export const directoryWritesLock = 'urlput-directory-writes';
const directoryName = 'URLPut-data-v1';
const workspaceFile = 'workspace.json';
export const activeUrlLock = 'urlput-active-url';
export const queueFilesLock = 'urlput-check-queue-files';

export async function read<T>(dir: Directory, name: string): Promise<T | undefined> {
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    // A first write can leave an empty placeholder if the stream never commits.
    return file.size ? JSON.parse(await file.text()) : undefined;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return undefined;
    throw error;
  }
}

const lastWrites = new WeakMap<Directory, number>();

export function directoryLastWrite(dir: Directory) {
  return lastWrites.get(dir);
}

export async function write(dir: Directory, name: string, value: unknown) {
  const text = JSON.stringify(value);
  const stream = await (await dir.getFileHandle(name, { create: true })).createWritable();
  try {
    await stream.write(text);
    await stream.close();
    lastWrites.set(dir, Date.now());
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
  const dir = await parent.getDirectoryHandle(directoryName).catch(error => {
    if (error instanceof DOMException && error.name === 'NotFoundError') {
      throw new Error('所选位置没有 URLPut 数据，请选择包含 URLPut-data-v1 的上级目录。');
    }
    throw error;
  });
  await workspaceFor(dir);
  return dir;
}

export async function prepareDirectory(parent: Directory) {
  const dir = await parent.getDirectoryHandle(directoryName, { create: true });
  await navigator.locks.request(directoryWritesLock, async () => {
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
    return navigator.locks.request(directoryWritesLock, () => navigator.locks.request(queueFilesLock, async () => {
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
      lastWrites.set(target, Date.now());
      return target;
    }));
  });
}

export async function addSite(dir: Directory, address: string) {
  const homepage = normalizeUrl(address);
  if (!homepage) throw new Error('请输入公开的 HTTP 或 HTTPS 官网地址。');
  return navigator.locks.request(directoryWritesLock, async () => {
    const workspace = await workspaceFor(dir);
    const host = new URL(homepage).hostname;
    const site = workspace.sites.find(item => item.homepage === homepage)
      ?? workspace.sites.find(item => new URL(item.homepage).hostname === host);
    if (site) {
      if (site.inactive) {
        delete site.inactive;
        site.homepage = homepage;
        await write(dir, workspaceFile, { version: 1, workspace });
      }
      return { workspace, site };
    }
    const created = { id: crypto.randomUUID(), name: host, homepage };
    workspace.sites.push(created);
    await write(dir, workspaceFile, { version: 1, workspace });
    return { workspace, site: created };
  });
}

export function updateLocalSite(dir: Directory, id: string, changes: { name: string; homepage: string } | { inactive: true }) {
  return navigator.locks.request(directoryWritesLock, async () => {
    const workspace = await workspaceFor(dir);
    const site = workspace.sites.find(item => item.id === id);
    if (!site || site.inactive) throw new Error('该推广站点已撤下或不存在。');
    if ('inactive' in changes) site.inactive = true;
    else {
      const homepage = normalizeUrl(changes.homepage);
      if (!homepage || !changes.name.trim()) throw new Error('请输入有效的站点名称及官网地址。');
      if (new URL(homepage).hostname !== new URL(site.homepage).hostname) throw new Error('请保留原域名，其他域名可作为新站点添加。');
      site.name = changes.name.trim();
      site.homepage = homepage;
    }
    await write(dir, workspaceFile, { version: 1, workspace });
    return workspace;
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
  let batch: Batch;
  if (stored) batch = restore(stored, site, id);
  else {
    const multi = await readMultiSiteBatch(dir, id);
    const savedSite = multi?.sites.find(item => item.id === site);
    if (!multi || !savedSite) throw new Error('找不到所选批次文件。');
    batch = restore({ site, createdAt: multi.createdAt, input: multi.input }, site, id);
    batch.snapshot = {
      site: savedSite, execution: multi.execution ? '分析后准备人工投稿' : '仅分析', sources: multi.sources,
    };
  }
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
  if (batch.snapshot?.execution === '分析后准备人工投稿') {
    const drafts = await read<Record<string, { source: string }>>(dir, `multi-drafts-${id}-${site}.json`) ?? {};
    const approved = new Map((await submissionApprovals(dir, site)).filter(item => item.batch === id).map(item => [item.sequence, item.draftSource]));
    const skipped = await skippedSubmissions(dir, site, id);
    for (const row of batch.rows) {
      row.draftSource = approved.get(row.sequence) ?? drafts[row.sequence]?.source;
      row.submissionSkippedAt = skipped[row.sequence];
    }
  }
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
  startedAt?: string | null;
  platform?: string;
  draftSource?: string;
};

export async function submissionApprovals(dir: Directory, site: string) {
  return await read<SubmissionApproval[]>(dir, site + '.submissions.json') ?? [];
}

export async function localAcceptedUrls(dir: Directory, site: string) {
  const candidates = new Set<string>();
  for (const { id } of await localHistory(dir, site)) {
    const receipts = await read<Record<string, ReviewReceipt>>(dir, site + '-' + id + '.reviews.json');
    if (!receipts || !Object.keys(receipts).length) continue;
    const batch = await localBatch(dir, site, id);
    for (const row of batch.rows) {
      if (row.review && row.normalizedUrl) candidates.add(row.normalizedUrl);
    }
  }
  return candidates;
}

async function requireUnrecordedReview(dir: Directory, site: string, batchId: string, source: string) {
  for (const { id } of await localHistory(dir, site)) {
    if (id === batchId) continue;
    const receipts = await read<Record<string, ReviewReceipt>>(dir, site + '-' + id + '.reviews.json');
    if (!receipts) continue;
    const batch = await localBatch(dir, site, id);
    if (batch.rows.some(row => row.review && row.normalizedUrl === source)) {
      throw new Error('此推广站点已有该网址的待审核回执，请核对原批次。');
    }
  }
}

function skippedSubmissionsFile(site: string, batch: string) {
  return `${site}-${batch}.submission-skips.json`;
}

export async function skippedSubmissions(dir: Directory, site: string, batch: string) {
  return await read<Record<string, string>>(dir, skippedSubmissionsFile(site, batch)) ?? {};
}

export function skipSubmission(dir: Directory, site: string, batchId: string, sequence: number) {
  return navigator.locks.request(directoryWritesLock, async () => {
    const batch = await localBatch(dir, site, batchId);
    const row = batch.rows.find(item => item.sequence === sequence);
    if (batch.snapshot?.execution !== '分析后准备人工投稿' || row?.disposition !== 'candidate') {
      throw new Error('请选择可审阅的人工投稿候选。');
    }
    const approvals = await submissionApprovals(dir, site);
    if (row.review || approvals.some(item => item.source === row.normalizedUrl)) {
      throw new Error('该候选已有投稿记录，请核对原批次。');
    }
    const skipped = await skippedSubmissions(dir, site, batchId);
    if (!skipped[sequence]) {
      skipped[sequence] = new Date().toISOString();
      await write(dir, skippedSubmissionsFile(site, batchId), skipped);
      notifySubmissionReviewChanged();
    }
    return skipped;
  });
}

export function approveSubmission(dir: Directory, site: string, id: string, sequence: number, draft: string,
  options?: { platform: string; draftSource?: string }) {
  const content = draft.trim();
  if (!content || content.length > 5000) throw new Error('请填写 1–5,000 字的投稿内容。');
  return navigator.locks.request(directoryWritesLock, async () => {
    const batch = await localBatch(dir, site, id);
    const row = batch.rows.find(item => item.sequence === sequence);
    if (row?.disposition !== 'candidate' || !row.normalizedUrl) throw new Error('请选择有效的候选记录。');
    if ((await skippedSubmissions(dir, site, id))[sequence]) throw new Error('该候选已在本批次跳过。');
    if (row.review) throw new Error('此条已有待审核回执。');
    const existing = await submissionApprovals(dir, site);
    const multi = await readMultiSiteBatch(dir, id);
    if (multi && !multi.execution) throw new Error('仅分析批次没有人工投稿流程。');
    const execution = multi?.execution;
    const platform = options?.platform.trim().toLowerCase();
    if (execution && (!platform || platform.length > 200)) throw new Error('请人工核对并填写平台标识。');
    if (platform && existing.some(item => item.platform === platform)) {
      throw new Error('该推广站点已为此平台保存投稿占位，请核对原批次。');
    }
    if (existing.some(item => item.source === row.normalizedUrl)) {
      throw new Error('此推广站点已有该网址的投稿占位，请核对原批次和平台状态。');
    }
    await requireUnrecordedReview(dir, site, id, row.normalizedUrl);
    const approval = {
      id: crypto.randomUUID(), batch: id, sequence, source: row.normalizedUrl,
      entry: row.normalizedEntry || row.normalizedUrl, draft: content, approvedAt: new Date().toISOString(), startedAt: null,
      ...(platform ? { platform, draftSource: options?.draftSource } : {}),
    };
    await write(dir, site + '.submissions.json', [...existing, approval]);
    notifySubmissionReviewChanged();
    return approval;
  });
}

export async function submissionQuota(dir: Directory, site: string, execution: NonNullable<MultiSiteBatch['execution']>,
  approvals: SubmissionApproval[], now = Date.now()) {
  const day = 86_400_000;
  const recent = approvals.flatMap(item => {
    const at = item.startedAt ? Date.parse(item.startedAt) : NaN;
    return at > now - day ? [{ batch: item.batch, at }] : [];
  }).sort((a, b) => a.at - b.at);
  const configs = await Promise.all([...new Set(recent.map(item => item.batch))].map(id => readMultiSiteBatch(dir, id)));
  const limits = [execution, ...configs.flatMap(batch => batch?.execution ? [batch.execution] : [])];
  const limit = Math.min(...limits.map(config => config.siteLimits[site] ?? config.dailyLimit));
  return { used: recent.length, limit, nextAt: recent.length >= limit ? recent[recent.length - limit].at + day : undefined };
}

export function startSubmission(dir: Directory, site: string, batchId: string, approvalId: string) {
  return navigator.locks.request(directoryWritesLock, async () => {
    const approvals = await submissionApprovals(dir, site);
    const index = approvals.findIndex(item => item.id === approvalId && item.batch === batchId);
    const approval = approvals[index];
    if (!approval) throw new Error('找不到此批次的投稿批准记录。');
    const batch = await localBatch(dir, site, batchId);
    const row = batch.rows.find(item => item.sequence === approval.sequence);
    if (row?.disposition !== 'candidate' || row.normalizedUrl !== approval.source) {
      throw new Error('投稿批准与来源记录不匹配。');
    }
    if (row.review) throw new Error('此条已有待审核回执，请核对平台状态。');
    if (approval.startedAt === undefined) throw new Error('旧版占位缺少开始状态，请先核对原平台。');
    if (approval.startedAt) throw new Error('此条已开始一次投稿，请核对原平台状态。');
    const entry = row.normalizedEntry || row.normalizedUrl;
    if (entry !== approval.entry) throw new Error('投稿入口与已批准记录不匹配。');
    const execution = (await readMultiSiteBatch(dir, batchId))?.execution;
    const now = Date.now();
    if (execution) {
      if (!approval.platform) throw new Error('请核对原记录的平台标识后再处理。');
      if (approvals.some(item => item.id !== approval.id && item.platform === approval.platform && item.startedAt)) {
        throw new Error('该平台已有一次投稿尝试，请核对原记录。');
      }
      const quota = await submissionQuota(dir, site, execution, approvals, now);
      if (quota.nextAt) throw new Error(`已使用滚动 24 小时额度：${quota.used} / ${quota.limit}。请稍后继续原记录。`);
    }
    const started = { ...approval, startedAt: new Date(now).toISOString() };
    approvals[index] = started;
    await write(dir, site + '.submissions.json', approvals);
    notifySubmissionReviewChanged();
    return started;
  });
}

export async function recordPendingReview(dir: Directory, site: string, id: string, sequence: number, evidence: string, submittedAt: string) {
  const time = Date.parse(submittedAt);
  if (!evidence.trim() || evidence.length > 1000 || !Number.isFinite(time) || time > Date.now()) {
    throw new Error('请填写平台的待审核提示或回执编号，以及实际提交时间。');
  }
  return navigator.locks.request(directoryWritesLock, async () => {
    const batch = await localBatch(dir, site, id);
    const row = batch.rows.find(item => item.sequence === sequence);
    if (row?.disposition !== 'candidate' || !row.normalizedUrl) throw new Error('请选择有效的候选记录。');
    if ((await skippedSubmissions(dir, site, id))[sequence]) throw new Error('该候选已在本批次跳过。');
    if (row.review) throw new Error('此条已有待审核回执。');
    const approval = (await submissionApprovals(dir, site)).find(item => item.source === row.normalizedUrl);
    if (approval && (approval.batch !== id || approval.sequence !== sequence)) {
      throw new Error(`请在原投稿批次 ${approval.batch} 的第 ${approval.sequence} 条登记回执。`);
    }
    if (batch.snapshot?.execution === '分析后准备人工投稿') {
      if (!approval?.startedAt) throw new Error('请从原记录开始手动投稿，取得平台回执后再登记。');
      if (time + 60_000 <= Date.parse(approval.startedAt)) throw new Error('实际提交时间须在本次投稿开始之后。');
    }
    await requireUnrecordedReview(dir, site, id, row.normalizedUrl);
    const filename = site + '-' + id + '.reviews.json';
    const receipts = Object.fromEntries(batch.rows.filter(item => item.review).map(item => [item.sequence, item.review]));
    row.review = { evidence: evidence.trim(), submittedAt: new Date(time).toISOString(), recordedAt: new Date().toISOString() };
    receipts[sequence] = row.review;
    await write(dir, filename, receipts);
    notifySubmissionReviewChanged();
    return batch;
  });
}

export async function saveLocalBatch(dir: Directory, site: string, input: ImportBatch, createdAt = new Date().toISOString()) {
  return navigator.locks.request(directoryWritesLock, async () => {
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
  return navigator.locks.request(directoryWritesLock, async () => {
    const workspace = await workspaceFor(dir);
    const existing = workspace.sites.find(item => item.id === site.id);
    if (existing && existing.homepage !== site.homepage) throw new Error('本机站点 ID 与原站点网址冲突。');
    if (!existing) {
      workspace.sites.push(site);
      await write(dir, workspaceFile, { version: 1, workspace });
    }
  });
}

export type MultiSiteBatch = {
  id: string;
  name: string;
  workspace: string;
  createdAt: string;
  sites: Workspace['sites'];
  listId: string;
  listName: string;
  input: ImportBatch;
  sources: import('./local-link-lists').LinkSource[][];
  scheduledAt?: string;
  execution?: import('./draft-config').DraftConfig;
};

export type MultiSiteSummary = Pick<MultiSiteBatch, 'id' | 'name' | 'createdAt' | 'listName'> & {
  sites: MultiSiteBatch['sites'];
  rowsPerSite: number;
};

const multiSiteIndexFile = 'multi-batch-index.json';

export async function multiSiteHistory(dir: Directory) {
  return await read<MultiSiteSummary[]>(dir, multiSiteIndexFile) ?? [];
}

const multiSiteFile = (id: string) => `multi-batch-${id}.json`;

export function readMultiSiteBatch(dir: Directory, id: string) {
  return read<MultiSiteBatch>(dir, multiSiteFile(id));
}

export function saveMultiSiteBatch(dir: Directory, batch: MultiSiteBatch) {
  return navigator.locks.request(directoryWritesLock, async () => {
    const existing = await readMultiSiteBatch(dir, batch.id);
    if (existing) {
      const { scheduledAt: _scheduled, ...saved } = existing;
      const { scheduledAt: _requested, ...requested } = batch;
      if (JSON.stringify(saved) !== JSON.stringify(requested)) throw new Error('启动编号已用于其他批次。');
    }
    if (!existing) {
      const workspace = await workspaceFor(dir);
      if (workspace.id !== batch.workspace || batch.sites.some(site => !workspace.sites.some(item => item.id === site.id && !item.inactive))) {
        throw new Error('工作空间或推广站点已变更，请返回确认区。');
      }
      await write(dir, multiSiteFile(batch.id), batch);
    }
    const multiHistory = await multiSiteHistory(dir);
    if (!multiHistory.some(item => item.id === batch.id)) {
      multiHistory.unshift({
        id: batch.id, name: batch.name, createdAt: batch.createdAt, listName: batch.listName,
        sites: batch.sites, rowsPerSite: batch.input.rows.length,
      });
      multiHistory.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      await write(dir, multiSiteIndexFile, multiHistory);
    }
    for (const site of batch.sites) {
      const history = await localHistory(dir, site.id);
      if (history.some(item => item.id === batch.id)) continue;
      history.unshift({
        id: batch.id, createdAt: batch.createdAt, filename: batch.name || batch.listName,
        source: batch.input.source, rowCount: batch.input.rows.length,
      });
      history.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
      await write(dir, site.id + '.index.json', history);
    }
  });
}

export async function pendingMultiSiteBatches(dir: Directory) {
  const batches: MultiSiteBatch[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file' || !/^multi-batch-[a-f0-9-]{36}\.json$/i.test(name)) continue;
    const batch = await read<MultiSiteBatch>(dir, name);
    if (batch && !batch.scheduledAt) batches.push(batch);
  }
  return batches;
}

export function markMultiSiteScheduled(dir: Directory, id: string) {
  return navigator.locks.request(directoryWritesLock, async () => {
    const batch = await readMultiSiteBatch(dir, id);
    if (!batch || batch.scheduledAt) return;
    await write(dir, multiSiteFile(id), { ...batch, scheduledAt: new Date().toISOString() });
  });
}
