import { importBatchSchema, workspaceSchema, type ImportBatch, type Workspace } from '@urlput/contracts';
import { buildLedger, normalizeUrl } from '@urlput/import';
import type { Batch, BatchSummary, ReviewReceipt } from './api';

type Directory = FileSystemDirectoryHandle;
const lock = 'urlput-directory-writes';

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
  await stream.write(text);
  await stream.close();
}

export async function workspaceFor(dir: Directory): Promise<Workspace> {
  const value = await read<{ version: number; workspace: unknown }>(dir, 'workspace.json');
  if (value?.version !== 1) throw new Error('无法识别本机工作空间格式。');
  return workspaceSchema.parse(value.workspace);
}

export async function prepareDirectory(parent: Directory) {
  const dir = await parent.getDirectoryHandle('URLPut-data-v1', { create: true });
  await navigator.locks.request(lock, async () => {
    if (await read(dir, 'workspace.json') !== undefined) await workspaceFor(dir);
    else await write(dir, 'workspace.json', { version: 1, workspace: { id: crypto.randomUUID(), name: parent.name, sites: [] } });
  });
  return dir;
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
      await write(dir, 'workspace.json', { version: 1, workspace });
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
      await write(dir, 'workspace.json', { version: 1, workspace });
    }
  });
}
