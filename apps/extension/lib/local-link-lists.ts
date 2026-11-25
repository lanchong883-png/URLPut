import { importBatchSchema, type ImportBatch } from '@urlput/contracts';
import { buildLedger, mapRows, readTable, readTextRows, type LedgerRow } from '@urlput/import';
import { activeUrlLock, directoryWritesLock, read, write } from './local-directory';
import { publicRequest } from './check-queue';

type Source = Pick<ImportBatch, 'source' | 'filename'>;
export type LinkSource = Source & { row: LedgerRow };
type LinkAttributes = {
  type?: string;
  price?: string;
  rel?: string;
  dr?: { value: number; source: string; observedAt: string };
};
type LinkImport = ImportBatch & { attributes: Record<number, LinkAttributes> };
export type LocalLink = LinkAttributes & {
  url: string;
  entry?: string;
  sources: LinkSource[];
  check?: { at: string; ok: boolean; message: string };
};
export type LocalLinkList = { id: string; name: string; links: LocalLink[]; problems: LinkSource[] };

const file = 'local-link-lists.json';
const activeFor = 30 * 86_400_000;

export function isActiveLink(link: LocalLink, now = Date.now()) {
  return Boolean(link.check?.ok && now - Date.parse(link.check.at) <= activeFor);
}

export async function localLinkLists(dir: FileSystemDirectoryHandle) {
  return (await read<{ version: 1; lists: LocalLinkList[] }>(dir, file))?.lists ?? [];
}

export function parseLinkList(text: string, filename?: string) {
  const first = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/, 1)[0];
  const header = /(?:^|[,;\t])\s*"?\s*(?:url|网址|外链网址|链接)\s*"?\s*(?=[,;\t]|$)/i.test(first);
  const isTable = /\.csv$/i.test(filename ?? '') || (!/\.txt$/i.test(filename ?? '') && (header || first.includes('\t')));
  const delimiter = first.includes('\t') ? '\t' : first.includes(';') ? ';' : ',';
  const table = isTable ? readTable(text, delimiter) : [];
  const columns = header ? table[0]?.cells.map(value => value.trim().toLowerCase()) ?? [] : [];
  const index = (...labels: string[]) => columns.findIndex(value => labels.includes(value));
  const urlIndex = index('url', '网址', '外链网址', '链接');
  const entry = index('投稿入口', 'entry');
  const notes = index('备注', '描述', 'notes');
  const rows = isTable ? mapRows(table, {
    url: Math.max(0, urlIndex), entry: entry < 0 ? undefined : entry, notes: notes < 0 ? undefined : notes,
  }, header) : readTextRows(text);
  const attributes: LinkImport['attributes'] = {};
  const typeIndex = index('网站类型', '类型', 'type');
  const priceIndex = index('价格', 'price');
  const relIndex = index('样本链接属性', '链接属性', 'rel');
  const drIndex = index('dr', 'ahrefs dr');
  const observedIndex = index('评分日期', 'dr date');
  const sourceIndex = index('评分来源', 'dr source');
  if (header) for (const row of table.slice(1)) {
    const value = row.cells[drIndex]?.trim();
    const providedSource = row.cells[sourceIndex]?.trim();
    const observedAt = row.cells[observedIndex]?.trim();
    const rating = value ? Number(value) : NaN;
    attributes[row.sourceLine] = {
      type: row.cells[typeIndex]?.trim() || undefined,
      price: row.cells[priceIndex]?.trim() || undefined,
      rel: row.cells[relIndex]?.trim().toLowerCase() || undefined,
      dr: Number.isFinite(rating) && rating >= 0 && rating <= 100 && providedSource && observedAt && Number.isFinite(Date.parse(observedAt))
        ? { value: rating, source: providedSource, observedAt } : undefined,
    };
  }
  return { ...importBatchSchema.parse({
    requestId: crypto.randomUUID(),
    source: filename ? isTable ? 'csv' : 'txt' : 'paste',
    filename,
    rows,
  }), attributes };
}

export function saveLinkSources(dir: FileSystemDirectoryHandle, input: LinkImport, id?: string, name?: string) {
  return navigator.locks.request(directoryWritesLock, async () => {
    const lists = await localLinkLists(dir);
    const list = id
      ? lists.find(item => item.id === id)
      : { id: input.requestId, name: name?.trim() || input.filename || `外链清单 ${lists.length + 1}`, links: [], problems: [] } satisfies LocalLinkList;
    if (!list) throw new Error('找不到所选外链清单。');
    if (!id && lists.some(item => item.id === list.id)) throw new Error('本次导入已保存，请重新选择清单。');
    const byUrl = new Map(list.links.map(link => [link.url, link]));
    const seen = new Set<string>();
    const count = { added: 0, existing: 0, duplicate: 0, invalid: 0 };
    for (const row of buildLedger(input.rows)) {
      const source = { source: input.source, filename: input.filename, row };
      if (!row.normalizedUrl || row.disposition === 'invalid') {
        list.problems.push(source);
        count.invalid++;
        continue;
      }
      const existing = byUrl.get(row.normalizedUrl);
      if (existing) {
        if (seen.has(existing.url)) count.duplicate++;
        else count.existing++;
        existing.sources.push(source);
        const attributes = input.attributes[row.sourceLine];
        if (attributes) {
          existing.type = attributes.type ?? existing.type;
          existing.price = attributes.price ?? existing.price;
          existing.rel = attributes.rel ?? existing.rel;
          if (attributes.dr && (!existing.dr || Date.parse(attributes.dr.observedAt) >= Date.parse(existing.dr.observedAt))) existing.dr = attributes.dr;
        }
      } else {
        const link = { ...input.attributes[row.sourceLine], url: row.normalizedUrl, entry: row.normalizedEntry, sources: [source] };
        list.links.push(link);
        byUrl.set(link.url, link);
        count.added++;
      }
      seen.add(row.normalizedUrl);
    }
    if (!id) lists.push(list);
    await write(dir, file, { version: 1, lists });
    return { lists, list, count };
  });
}

export function renameLinkList(dir: FileSystemDirectoryHandle, id: string, name: string) {
  return navigator.locks.request(directoryWritesLock, async () => {
    const lists = await localLinkLists(dir);
    const list = lists.find(item => item.id === id);
    if (!list || !name.trim()) throw new Error('请输入有效的清单名称。');
    list.name = name.trim();
    await write(dir, file, { version: 1, lists });
    return lists;
  });
}

export function checkLocalLink(dir: FileSystemDirectoryHandle, id: string, url: string) {
  return navigator.locks.request(activeUrlLock, { ifAvailable: true }, async active => {
    if (!active) throw new Error('已有只读任务正在运行，请稍后重试。');
    const candidate = (await localLinkLists(dir)).find(list => list.id === id)?.links.find(link => link.url === url);
    if (!candidate) throw new Error('找不到所选外链。');
    let check: NonNullable<LocalLink['check']>;
    try {
      const { response } = await publicRequest(candidate.entry ?? candidate.url, 'HEAD');
      check = { at: new Date().toISOString(), ok: true, message: `HTTP ${response.status}` };
    } catch (error) {
      check = { at: new Date().toISOString(), ok: false, message: error instanceof Error ? error.message : '检查失败' };
    }
    return navigator.locks.request(directoryWritesLock, async () => {
      const lists = await localLinkLists(dir);
      const link = lists.find(list => list.id === id)?.links.find(item => item.url === url);
      if (!link) throw new Error('找不到所选外链。');
      link.check = check;
      await write(dir, file, { version: 1, lists });
      return lists;
    });
  });
}
