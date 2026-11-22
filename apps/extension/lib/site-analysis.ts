import { Parser } from 'htmlparser2';
import { normalizeUrl } from '@urlput/import';
import { hidesContent, PageSignals } from './page-signals.ts';

export type Analysis = {
  title: string; category: string; entry: string; required: string[];
  login: string; fee: string; limitations: string; evidence: string;
};

export async function analyzeHtml(chunks: AsyncIterable<string>, url: string): Promise<Analysis> {
  let title = '';
  let titleDepth = 0;
  const hidden: boolean[] = [];
  const signals = new PageSignals();
  let password = false;
  let article = false;
  let comment = false;
  let entry = '';
  let form: { action: string; comment: boolean; required: Set<string> } | undefined;
  let base = url;
  let required: string[] = [];
  const parser = new Parser({
    onopentag(tag, attrs) {
      if (hidden.length >= 512) throw new Error('网页嵌套过深，需人工分析。');
      const concealed = Boolean(hidden.at(-1) || hidesContent(tag, attrs));
      hidden.push(concealed);
      if (concealed) return;
      signals.element(tag, attrs);
      if (tag === 'title') titleDepth++;
      if (tag === 'article') article = true;
      if (/(^|\s)(fb-comments|comment-item|comment-list)(\s|$)/.test(attrs.class ?? '') ||
          attrs['data-hook'] === 'comments-section-placeholder') comment = true;
      if (tag === 'base' && attrs.href) {
        try { base = new URL(attrs.href, url).href; } catch { /* Malformed base. */ }
      }
      if (tag === 'form') {
        let action = '';
        try { action = normalizeUrl(new URL(attrs.action || url, base).href) ?? ''; } catch { /* Invalid form action. */ }
        form = { action, comment: false, required: new Set() };
      }
      if (form && ['input', 'select', 'textarea'].includes(tag)) {
        if (attrs.type === 'password') password = true;
        if ('required' in attrs && attrs.type !== 'hidden' && form.required.size < 40) {
          form.required.add((attrs['aria-label'] || attrs.name || attrs.id || tag).slice(0, 100));
        }
        if (tag === 'textarea' && /comment|message|texte/i.test(attrs.name ?? '')) form.comment = true;
      }
    },
    ontext(value) {
      if (hidden.at(-1)) return;
      if (titleDepth) title = (title + value).slice(0, 300);
      else signals.visibleText(value);
    },
    onclosetag(tag) {
      if (hidden.pop()) return;
      if (tag === 'title') titleDepth--;
      if (tag === 'form' && form) {
        if (!entry && form.comment && form.action) {
          entry = form.action;
          required = [...form.required];
        }
        form = undefined;
      }
    },
  });
  for await (const chunk of chunks) parser.write(chunk);
  parser.end();
  return {
    title: title.trim(), category: article ? '文章页面' : '未识别', entry: entry || '未知', required,
    login: signals.login ? '页面提示需登录，具体访问或投稿条件待确认' : password ? '页面含密码字段；投稿是否须登录待确认' : '未知', fee: '未知',
    limitations: signals.dynamicComments ? '动态评论内容和字段需在页面渲染后人工确认' : '公开静态 HTML，动态表单和审核条件待确认',
    evidence: [title.trim(), article && 'article 元素', comment && '评论区标记', entry && '评论表单文本域', ...signals.evidence].filter(Boolean).join(' · ') || '取得公开 HTML',
  };
}
