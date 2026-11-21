import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from '../lib/api';

type LinkRecord = { url: string; observedAt: string };
type CatalogPage = { links: LinkRecord[]; nextOffset: number | null };
const pageSize = 5;

export function LinkCatalog({ workspaceId }: { workspaceId: string }) {
  const [search, setSearch] = useState('');
  return <section className="card stack">
    <h2>活跃外链</h2>
    <label>搜索网址或域名
      <input type="search" value={search} maxLength={200} onChange={event => setSearch(event.target.value)} />
    </label>
    <CatalogResults key={search.trim()} workspaceId={workspaceId} query={search.trim()} />
  </section>;
}

function CatalogResults({ workspaceId, query }: { workspaceId: string; query: string }) {
  const [links, setLinks] = useState<LinkRecord[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestInFlight = useRef<AbortController | null>(null);
  const fetchPage = useCallback(async (offset: number) => {
    if (requestInFlight.current) return;
    const controller = new AbortController();
    requestInFlight.current = controller;
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ q: query, limit: String(pageSize), offset: String(offset) });
    try {
      const page = await request<CatalogPage>(`/workspaces/${workspaceId}/link-catalog?${params}`, undefined, controller.signal);
      if (controller.signal.aborted) return;
      setLinks(previous => {
        const urls = new Set(previous.map(link => link.url));
        return previous.concat(page.links.filter(link => !urls.has(link.url)));
      });
      setNextOffset(page.nextOffset);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '无法读取外链清单。');
    } finally {
      requestInFlight.current = null;
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [workspaceId, query]);

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchPage(0), query ? 250 : 0);
    return () => {
      window.clearTimeout(timer);
      requestInFlight.current?.abort();
    };
  }, [fetchPage, query]);

  function loadMore() {
    if (nextOffset !== null) void fetchPage(nextOffset);
  }

  return <>
    <div className="catalog-scroll" aria-label="活跃外链列表" role="region" tabIndex={0}
      onScroll={event => {
        const area = event.currentTarget;
        if (!error && nextOffset !== null && nextOffset > 0 && area.scrollHeight - area.scrollTop - area.clientHeight <= 12) loadMore();
      }}>
      <ul className="catalog-list">
        {links.map(link => <li key={link.url}>
          <strong>{new URL(link.url).hostname}</strong>
          <span>{link.url}</span>
          <time dateTime={link.observedAt}>最近核验 {new Date(link.observedAt).toLocaleDateString()}</time>
        </li>)}
      </ul>
    </div>
    {loading && <p role="status">正在读取外链…</p>}
    {!links.length && !loading && nextOffset === null && <p>{query ? '没有匹配的活跃外链。' : '当前工作空间暂无活跃外链。'}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    {nextOffset !== null && (nextOffset > 0 || error) &&
      <button type="button" className="secondary" disabled={loading} onClick={loadMore}>
        {error ? '重试读取' : '加载更多'}
      </button>}
  </>;
}
