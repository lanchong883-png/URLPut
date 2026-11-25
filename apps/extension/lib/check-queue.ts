import { browser } from 'wxt/browser';
import { htmlChunks } from './comment-evidence';
import { analyzeHtml, type Analysis } from './site-analysis';
import { normalizeUrl } from '@urlput/import';
import { activeUrlLock, localBatch, markMultiSiteScheduled, queueFilesLock, read, readMultiSiteBatch, saveMultiSiteBatch, write, type MultiSiteBatch } from './local-directory';

type Job = { site: string; batch: string; retry?: number; analysis?: boolean; multiSite?: true };
export type Check = { reusedFrom?: string; analysis?: Analysis; attempt?: string; dismissed?: boolean; sequence: number; url: string; ok: boolean; message: string; at: string };
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

async function changeQueue(dir: Directory, update: (jobs: QueuedJob[]) => QueuedJob[] | Promise<QueuedJob[]>) {
  return navigator.locks.request(queueFilesLock, async () => {
    const jobs = await read<QueuedJob[]>(dir, queueFile) ?? [];
    const next = await update(jobs);
    if (next === jobs) return;
    await write(dir, queueFile, next);
    notifyChecks();
  });
}

async function enqueueJobs(dir: Directory, candidates: Job[], skipCompleted = false) {
  if (!candidates.length) return;
  await changeQueue(dir, async jobs => {
    const next = [...jobs];
    for (const job of candidates) {
      if (next.some(item => sameJob(item, job))) continue;
      if (skipCompleted && await checkSummary(dir, job)) continue;
      next.push({ ...job, attempt: crypto.randomUUID() });
    }
    return next.length === jobs.length ? jobs : next;
  });
}

export function enqueue(dir: Directory, job: Job) {
  return enqueueJobs(dir, [job]);
}

export async function scheduleMultiSiteBatch(dir: Directory, batch: MultiSiteBatch) {
  await navigator.locks.request(`urlput-schedule-${batch.id}`, async () => {
    await saveMultiSiteBatch(dir, batch);
    if ((await readMultiSiteBatch(dir, batch.id))?.scheduledAt) return;
    const jobs: Job[] = batch.sites.map(site => ({ site: site.id, batch: batch.id, analysis: true, multiSite: true }));
    await enqueueJobs(dir, jobs, true);
    await markMultiSiteScheduled(dir, batch.id);
  });
}

export type MultiSiteExecution = 'running' | 'paused' | 'interrupted' | 'stopped';

export function multiSiteExecution(dir: Directory, id: string) {
  return read<{ state: MultiSiteExecution }>(dir, `multi-control-${id}.json`);
}

export async function setMultiSiteExecution(dir: Directory, id: string, state: MultiSiteExecution) {
  await navigator.locks.request(queueFilesLock, async () => {
    if (!await readMultiSiteBatch(dir, id)) throw new Error('找不到所选多站批次。');
    await write(dir, `multi-control-${id}.json`, { state });
  });
  notifyChecks();
}

export async function dispatchMultiSiteQueue(dir: Directory, id: string) {
  if (!browser.runtime.sendMessage) {
    void runQueue(dir).catch(console.error);
    return;
  }
  const result = await browser.runtime.sendMessage({ type: 'urlput-start-queue', batchId: id });
  if (!result?.ok) throw new Error(result?.error ?? '后台队列未启动，请重试。');
}

export async function checkPage(dir: Directory, job: Job, page: number) {
  return await read<Check[]>(dir, segmentFile(job, page)) ?? [];
}

export async function analysisSegments(dir: Directory, site: string, batchIds: string[], signal?: AbortSignal) {
  const pages = new Map(batchIds.map(id => [id, [] as number[]]));
  const prefix = `analysis-${site}-`;
  for await (const [filename, handle] of dir.entries()) {
    if (signal?.aborted) return pages;
    if (handle.kind !== 'file' || !filename.startsWith(prefix)) continue;
    const segment = /^(.*)-(0|[1-9]\d*)\.json$/.exec(filename.slice(prefix.length));
    if (segment) pages.get(segment[1])?.push(Number(segment[2]));
  }
  for (const segments of pages.values()) segments.sort((a, b) => a - b);
  return pages;
}

export class PublicHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(status === 401 ? 'HTTP 401，站点要求身份验证，公开访问未通过。' :
      `HTTP ${status}，请核对访问权限和入口地址。`);
    this.status = status;
  }
}

export async function publicRequest(url: string, method: 'HEAD' | 'GET', cancellation?: AbortSignal) {
  if (normalizeUrl(url) !== url) throw new Error('地址无效，请修正来源网址。');
  const target = new URL(url);
  const cooldown = 'urlput-check-cooldown:' + target.origin;
  if (Number(localStorage.getItem(cooldown)) > Date.now()) throw new Error('站点处于限流等待期，请稍后恢复。');
  // The global worker lock covers pacing across batches and browser windows.
  await delay(Math.max(0, Number(localStorage.getItem('urlput-last-check')) + 2000 - Date.now()));
  cancellation?.throwIfAborted();
  localStorage.setItem('urlput-last-check', String(Date.now()));
  const timeout = AbortSignal.timeout(15000);
  const signal = cancellation ? AbortSignal.any([cancellation, timeout]) : timeout;
  const response = await fetch(url, {
    method, credentials: 'omit', redirect: 'manual', cache: 'no-store',
    referrerPolicy: 'no-referrer', signal,
  }).catch(error => {
    signal.throwIfAborted();
    throw error;
  });
  if (response.type === 'opaqueredirect') throw new Error('入口发生跳转，请核对最终网址。');
  if (response.status === 429) {
    const value = response.headers.get('Retry-After')?.trim();
    const until = value && /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value ?? '');
    localStorage.setItem(cooldown, String(Number.isFinite(until) ? Math.max(until, Date.now() + 2000) : Date.now() + 60000));
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 429) throw new Error('HTTP 429，等待站点解除限流后恢复。');
    throw new PublicHttpError(response.status);
  }
  return { response, signal };
}

type SharedAnalysis = { batch: string; analysis: Analysis; at: string; message: string };
type SharedBucket = Record<string, SharedAnalysis>;

async function sharedAnalysisFile(site: string, url: string) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url)));
  const bucket = hash[0].toString(16).padStart(2, '0');
  return `shared-analysis-${site}-${bucket}.json`;
}

export async function runQueue(dir: Directory) {
  await navigator.locks.request(activeUrlLock, async () => {
    for (;;) {
      const jobs = await read<QueuedJob[]>(dir, queueFile) ?? [];
      let job: QueuedJob | undefined;
      for (const candidate of jobs) {
        const state = candidate.multiSite ? await multiSiteExecution(dir, candidate.batch) : undefined;
        if (!state || state.state === 'running') { job = candidate; break; }
      }
      if (!job) return;
      const batch = await localBatch(dir, job.site, job.batch);
      let suspended = false;
      for (let start = 0; start < batch.rows.length && !suspended; start += segmentSize) {
        if (job.retry !== undefined && Math.floor((job.retry - 1) / segmentSize) !== start / segmentSize) continue;
        const page = start / segmentSize;
        const results = await checkPage(dir, job, page);
        for (const row of batch.rows.slice(start, start + segmentSize)) {
          if (!row.normalizedUrl || row.disposition !== 'candidate') continue;
          const index = results.findIndex(item => item.sequence === row.sequence);
          if (job.retry !== undefined && row.sequence !== job.retry) continue;
          if (index >= 0 && (job.retry === undefined || results[index].ok || results[index].dismissed || results[index].attempt === job.attempt)) continue;
          const state = job.multiSite ? await multiSiteExecution(dir, job.batch) : undefined;
          if (state && state.state !== 'running') { suspended = true; break; }
          const url = row.normalizedUrl;
          const sharedFile = job.multiSite && job.analysis && job.retry === undefined
            ? await sharedAnalysisFile(job.site, url) : undefined;
          const bucket = sharedFile ? await read<SharedBucket>(dir, sharedFile) ?? {} : undefined;
          const shared = bucket?.[url];
          let ok = false;
          let analysis: Analysis | undefined;
          let message: string;
          if (shared) {
            analysis = shared.analysis;
            ok = true;
            message = `${shared.message} · 复用批次 ${shared.batch}`;
          } else {
            const controller = job.multiSite ? new AbortController() : undefined;
            const batchId = job.batch;
            const unsubscribe = controller && observeChecks(() => {
              void multiSiteExecution(dir, batchId).then(control => {
                if (control?.state === 'interrupted') controller.abort();
              }).catch(console.error);
            });
            try {
              const { response, signal } = await publicRequest(url, job.analysis ? 'GET' : 'HEAD', controller?.signal);
              if (job.analysis) analysis = await analyzeHtml(htmlChunks(response, signal), url);
              controller?.signal.throwIfAborted();
              message = `HTTP ${response.status}，入口可访问。`;
              ok = true;
            } catch (error) {
              if (controller?.signal.aborted) { suspended = true; break; }
              if (error instanceof DOMException && error.name === 'TimeoutError') message = '检查超时，请核对网址或网络后恢复。';
              else if (error instanceof TypeError) message = '无法连接，请核对网址、网络和访问授权后恢复。';
              else message = error instanceof Error ? error.message : '请求失败，请检查网络后恢复。';
            } finally { unsubscribe?.(); }
          }
          const at = shared?.at ?? new Date().toISOString();
          if (sharedFile && bucket && !shared && analysis && ok) {
            bucket[url] = { batch: job.batch, analysis, message, at };
            await write(dir, sharedFile, bucket);
          }
          const result = { analysis, attempt: job.attempt, sequence: row.sequence, url, ok, message, at, reusedFrom: shared?.batch };
          if (index < 0) results.push(result);
          else results[index] = result;
          await write(dir, segmentFile(job, page), results);
        }
        if (job.multiSite) notifyChecks();
      }
      if (suspended) continue;
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
  return navigator.locks.request(activeUrlLock, async () => {
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

export async function multiSiteProgress(dir: Directory, batch: string, sites: string[], rowsPerSite: number, signal?: AbortSignal) {
  const progress = new Map<string, { done: boolean; processed: number }>();
  for (const site of sites) {
    if (signal?.aborted) break;
    const job = { site, batch, analysis: true };
    if (await checkSummary(dir, job)) {
      progress.set(site, { done: true, processed: rowsPerSite });
      continue;
    }
    let processed = 0;
    for (let page = 0; page * segmentSize < rowsPerSite && !signal?.aborted; page++) {
      const results = await checkPage(dir, job, page);
      processed += results.length;
      if (results.length < segmentSize) break;
    }
    progress.set(site, { done: false, processed });
  }
  return progress;
}

export const checkSegmentSize = segmentSize;
