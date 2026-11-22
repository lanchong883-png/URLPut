import { Parser } from 'htmlparser2';
import { hidesContent, PageSignals } from './page-signals.ts';

export type Evidence = { page: string; target: string; rel: string; anchor: string; checkedAt: string };

export type LinkRecord = Evidence & {
  firstVerifiedAt?: string;
  lastValidAt?: string;
  missingStatus?: number;
  pendingReason?: string;
  revisitError?: { at: string; reason: string };
  receipts?: { batch: string; sequence: number }[];
};

export type Conclusion = 'valid' | 'missing' | 'pending';

export function conclusion(item: LinkRecord): Conclusion {
  if (item.missingStatus) return 'missing';
  return item.pendingReason ? 'pending' : 'valid';
}

export const conclusionLabels = { valid: '有效外链', missing: '公开页失效', pending: '待核实' };

export class CommentLinkUnconfirmed extends Error {}

type Scope = { fragment: boolean; link?: { rel: string; anchor: string } };
type Frame = { scope?: Scope; owner: boolean; hidden: boolean; link?: Scope['link'] };

// A fragment can be an empty marker immediately before the comment body.
export async function findCommentLink(chunks: AsyncIterable<string>, page: URL, target: string): Promise<Evidence> {
  const fragment = decodeURIComponent(page.hash.slice(1));
  if (!fragment) throw new Error('请提供含评论定位标记（#…）的公开链接。');
  const stack: Frame[] = [];
  const signals = new PageSignals();
  let matches = 0;
  let evidence: Scope['link'];
  let base = page.href;
  let baseSet = false;
  const parser = new Parser({
    onopentag(tag, attrs) {
      if (stack.length >= 512) throw new Error('网页嵌套过深，需人工核验。');
      const parent = stack.at(-1);
      const hidden = Boolean(parent?.hidden || hidesContent(tag, attrs));
      if (!hidden) signals.element(tag, attrs);
      const marker = !hidden && (attrs.id === fragment || (tag === 'a' && attrs.name === fragment));
      if (marker) matches++;
      const classes = (attrs.class ?? '').split(/\s+/);
      const comment = classes.some(value => ['comment', 'comment-item', 'comment-body', 'forum-message'].includes(value));
      // comment-body belongs to its parent record; nested comment records own their links.
      const owner = !hidden && ((comment && !(classes.includes('comment-body') && parent?.scope))
        || (marker && !parent?.scope));
      const scope = owner ? { fragment: false } as Scope : parent?.scope;
      if (marker && scope) scope.fragment = true;
      const frame: Frame = { scope, owner, hidden, link: parent?.link };
      if (!hidden && tag === 'base' && attrs.href && !baseSet) {
        baseSet = true;
        try { base = new URL(attrs.href, page).href; } catch { /* Use document URL. */ }
      }
      if (!hidden && scope && tag === 'a' && attrs.href) {
        try {
          if (new URL(attrs.href, base).href === target) {
            scope.link = { rel: (attrs.rel ?? '').slice(0, 256), anchor: '' };
            frame.link = scope.link;
          }
        } catch { /* Ignore malformed unrelated links. */ }
      }
      stack.push(frame);
    },
    ontext(text) {
      const top = stack.at(-1);
      if (top && !top.hidden) signals.visibleText(text);
      if (top?.link && !top.hidden) top.link.anchor = (top.link.anchor + text).slice(0, 256);
    },
    onclosetag() {
      const frame = stack.pop();
      if (frame?.owner && frame.scope?.fragment && frame.scope.link) evidence = frame.scope.link;
    },
  });
  for await (const chunk of chunks) parser.write(chunk);
  parser.end();
  if (matches !== 1 || !evidence) {
    const reason = ['未能在唯一定位的公开记录中确认目标链接', ...signals.evidence].join('；');
    throw new CommentLinkUnconfirmed(reason + '。');
  }
  return { page: page.href, target, ...evidence, checkedAt: new Date().toISOString() };
}

export async function* htmlChunks(response: Response) {
  if (!response.headers.get('content-type')?.toLowerCase().includes('text/html') || !response.body) {
    await response.body?.cancel();
    throw new Error('未取得公开 HTML 页面。');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 16 * 1024 * 1024) throw new Error('页面超过 16 MiB，需人工核验。');
      yield decoder.decode(value, { stream: true });
    }
    yield decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
