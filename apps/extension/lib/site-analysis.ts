import { Parser } from 'htmlparser2';
import { normalizeUrl } from '@urlput/import';

export type Analysis = {
  title: string; category: string; entry: string; required: string[];
  login: string; fee: string; limitations: string; evidence: string;
};

export async function analyzeHtml(chunks: AsyncIterable<string>, url: string): Promise<Analysis> {
  let title = '';
  let titleDepth = 0;
  let ignored = 0;
  let formCount = 0;
  let password = false;
  let article = false;
  let comment = false;
  let entry = '';
  let action = '';
  let base = url;
  const required = new Set<string>();
  const parser = new Parser({
    onopentag(tag, attrs) {
      if (['script', 'style', 'template', 'noscript'].includes(tag)) ignored++;
      if (ignored) return;
      if (tag === 'title') titleDepth++;
      if (tag === 'article') article = true;
      if (/(^|\s)(fb-comments|comment-item|comment-list)(\s|$)/.test(attrs.class ?? '') ||
          attrs['data-hook'] === 'comments-section-placeholder') comment = true;
      if (tag === 'base' && attrs.href) {
        try { base = new URL(attrs.href, url).href; } catch { /* Malformed base. */ }
      }
      if (tag === 'form') {
        formCount++;
        try { action = normalizeUrl(new URL(attrs.action || url, base).href) ?? ''; } catch { action = ''; }
      }
      if (formCount && ['input', 'select', 'textarea'].includes(tag)) {
        if (attrs.type === 'password') password = true;
        if ('required' in attrs && attrs.type !== 'hidden' && required.size < 40) {
          required.add((attrs['aria-label'] || attrs.name || attrs.id || tag).slice(0, 100));
        }
        if (tag === 'textarea' && /comment|message|texte/i.test(attrs.name ?? '')) entry = action;
      }
    },
    ontext(value) { if (!ignored && titleDepth) title = (title + value).slice(0, 300); },
    onclosetag(tag) {
      if (['script', 'style', 'template', 'noscript'].includes(tag)) ignored--;
      else if (!ignored && tag === 'title') titleDepth--;
      else if (!ignored && tag === 'form') formCount = Math.max(0, formCount - 1);
    },
  });
  for await (const chunk of chunks) parser.write(chunk);
  parser.end();
  return {
    title: title.trim(), category: article ? '文章页面' : '未识别', entry: entry || '未知', required: [...required],
    login: password ? '页面含密码字段；投稿是否须登录待确认' : '未知', fee: '未知',
    limitations: '公开静态 HTML，动态表单和审核条件待确认',
    evidence: [title.trim(), article && 'article 元素', comment && '评论区标记', entry && '评论表单文本域'].filter(Boolean).join(' · ') || '取得公开 HTML',
  };
}
