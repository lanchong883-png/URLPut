import { htmlChunks } from './comment-evidence';
import { analyzeHtml, type Analysis } from './site-analysis';
import { normalizeUrl } from '@urlput/import';
import { localBatch, read, write } from './local-directory';

type Job = { site: string; batch: string; retry?: number; analysis?: boolean };
export type Check = { analysis?: Analysis; attempt?: string; dismissed?: boolean; sequence: number; url: string; ok: boolean; message: string; at: string };
type Directory = FileSystemDirectoryHandle;
type QueuedJob = Job & { attempt: string };
const queueFile = 'url-check-queue.json';
const queueEvent = 'urlput-check-queue-change';

export async function pendingCheckCount(dir: Directory) {
  return (await read<QueuedJob[]>(dir, queueFile))?.length ?? 0;
}

export function observeChecks(update: () => void) {
  const channel = new BroadcastChannel(queueEvent);
  channel.onmessage = update;
  window.addEventListener(queueEvent, update);
  return () => {
    channel.close();
    window.removeEventListener(queueEvent, update);
  };
}

function notifyChecks() {
  window.dispatchEvent(new Event(queueEvent));
  const channel = new BroadcastChannel(queueEvent);
  channel.postMessage(null);
  channel.close();
}
const segmentSize = 32;
const segmentFile = (job: Job, page: number) => `${job.analysis ? 'analysis' : 'checks'}-${job.site}-${job.batch}-${page}.json`;
const sameJob = (a: Job, b: Job) => a.batch === b.batch && a.site === b.site && a.retry === b.retry && Boolean(a.analysis) === Boolean(b.analysis);
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function changeQueue(dir: Directory, update: (jobs: QueuedJob[]) => QueuedJob[]) {
  return navigator.locks.request('urlput-check-queue-files', async () => {
    const jobs = await read<QueuedJob[]>(dir, queueFile) ?? [];
    const next = update(jobs);
    if (next === jobs) return;
    await write(dir, queueFile, next);
    notifyChecks();
  });
}

export async function enqueue(dir: Directory, job: Job) {
  await changeQueue(dir, jobs => jobs.some(item => sameJob(item, job)) ? jobs : [...jobs, { ...job, attempt: crypto.randomUUID() }]);
}

export async function checkPage(dir: Directory, job: Job, page: number) {
  return await read<Check[]>(dir, segmentFile(job, page)) ?? [];
}

export class PublicHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(status === 401 ? 'HTTP 401，站点要求身份验证，公开访问未通过。' :
      `HTTP ${status}，请核对访问权限和入口地址。`);
    this.status = status;
  }
}

export async function publicRequest(url: string, method: 'HEAD' | 'GET') {
  if (normalizeUrl(url) !== url) throw new Error('地址无效，请修正来源网址。');
  const target = new URL(url);
  const cooldown = 'urlput-check-cooldown:' + target.origin;
  if (Number(localStorage.getItem(cooldown)) > Date.now()) throw new Error('站点处于限流等待期，请稍后恢复。');
  // The global worker lock covers pacing across batches and browser windows.
  await delay(Math.max(0, Number(localStorage.getItem('urlput-last-check')) + 2000 - Date.now()));
  localStorage.setItem('urlput-last-check', String(Date.now()));
  const response = await fetch(url, {
    method, credentials: 'omit', redirect: 'manual', cache: 'no-store',
    referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000),
  });
  if (response.type === 'opaqueredirect') throw new Error('入口发生跳转，请核对最终网址。');
  if (!response.ok) await response.body?.cancel();
  if (response.status === 429) {
    const value = response.headers.get('Retry-After')?.trim();
    const until = value && /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value ?? '');
    localStorage.setItem(cooldown, String(Number.isFinite(until) ? Math.max(until, Date.now() + 2000) : Date.now() + 60000));
    throw new Error('HTTP 429，等待站点解除限流后恢复。');
  }
  if (!response.ok) throw new PublicHttpError(response.status);
  return response;
}

export async function runQueue(dir: Directory) {
  await navigator.locks.request('urlput-active-url', async () => {
    for (;;) {
      const [job] = await read<QueuedJob[]>(dir, queueFile) ?? [];
      if (!job) return;
      const batch = await localBatch(dir, job.site, job.batch);
      for (let start = 0; start < batch.rows.length; start += segmentSize) {
        if (job.retry !== undefined && Math.floor((job.retry - 1) / segmentSize) !== start / segmentSize) continue;
        const page = start / segmentSize;
        const results = await checkPage(dir, job, page);
        for (const row of batch.rows.slice(start, start + segmentSize)) {
          if (!row.normalizedUrl || row.disposition !== 'candidate') continue;
          const index = results.findIndex(item => item.sequence === row.sequence);
          if (job.retry !== undefined && row.sequence !== job.retry) continue;
          if (index >= 0 && (job.retry === undefined || results[index].ok || results[index].dismissed || results[index].attempt === job.attempt)) continue;
          const url = row.normalizedUrl;
          let ok = false;
          let analysis: Analysis | undefined;
          let message: string;
          try {
            const response = await publicRequest(url, job.analysis ? 'GET' : 'HEAD');
            if (job.analysis) analysis = await analyzeHtml(htmlChunks(response), url);
            message = `HTTP ${response.status}，入口可访问。`;
            ok = true;
          } catch (error) {
            if (error instanceof DOMException && error.name === 'TimeoutError') message = '检查超时，请核对网址或网络后恢复。';
            else if (error instanceof TypeError) message = '无法连接，请核对网址、网络和访问授权后恢复。';
            else message = error instanceof Error ? error.message : '请求失败，请检查网络后恢复。';
          }
          const result = { analysis, attempt: job.attempt, sequence: row.sequence, url, ok, message, at: new Date().toISOString() };
          if (index < 0) results.push(result);
          else results[index] = result;
          await write(dir, segmentFile(job, page), results);
        }
      }
      await summarize(dir, job, batch.rows.length);
      await changeQueue(dir, jobs => jobs.filter(item => !sameJob(item, job)));
    }
  });
}

async function summarize(dir: Directory, job: Job, rowCount: number) {
  const problemPages: number[] = [];
  let issues = 0;
  for (let page = 0; page * segmentSize < rowCount; page++) {
    const items = await checkPage(dir, job, page);
    const count = items.filter(item => !item.ok && !item.dismissed).length;
    if (count) problemPages.push(page);
    issues += count;
  }
  await write(dir, summaryFile(job), { issues, problemPages });
}

export function dismissCheck(dir: Directory, job: Job, sequence: number, rowCount: number) {
  return navigator.locks.request('urlput-active-url', async () => {
    const page = Math.floor((sequence - 1) / segmentSize);
    const results = await checkPage(dir, job, page);
    const result = results.find(item => item.sequence === sequence);
    if (!result || result.ok) return;
    result.dismissed = true;
    await write(dir, segmentFile(job, page), results);
    await summarize(dir, job, rowCount);
  });
}

const summaryFile = (job: Job) => `${job.analysis ? 'analysis' : 'checks'}-${job.site}-${job.batch}-summary.json`;
export function checkSummary(dir: Directory, job: Job) {
  return read<{ issues: number; problemPages: number[] }>(dir, summaryFile(job));
}

export const checkSegmentSize = segmentSize;
