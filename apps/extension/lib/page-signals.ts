const loginMessage = /\b(?:you must (?:log|sign) in|(?:log|sign) in required|please (?:log|sign) in) to (?:view|read|post|leave|write) (?:the |this |a )?(?:comments?|repl(?:y|ies)|content|article)\b|(?:请先登录(?:后(?:才能|可以?|方可)?)?|登录后(?:才能|可以?|方可)?)\s*(?:查看|阅读|发表|发布|回复|评论)(?:\s*(?:评论|文章|内容|留言|回复)|(?=[。！!]|$))/iu;

export class PageSignals {
  login = false;
  dynamicComments = false;
  private text = '';

  element(tag: string, attrs: Record<string, string>) {
    if ((attrs.class ?? '').split(/\s+/).includes('fb-comments') ||
        ['disqus_thread', 'giscus'].includes(attrs.id ?? '') ||
        attrs['data-hook'] === 'comments-section-placeholder' ||
        (tag === 'iframe' && /^https:\/\/(?:giscus\.app\/|utteranc\.es\/|disqus\.com\/)/i.test(attrs.src ?? ''))) {
      this.dynamicComments = true;
    }
  }

  visibleText(value: string) {
    if (this.login) return;
    const combined = this.text + value.replace(/\s+/gu, ' ');
    this.login = loginMessage.test(combined);
    this.text = combined.slice(-160);
  }

  get evidence() {
    return [
      this.login ? '页面正文提示登录后才能查看内容或参与评论' : '',
      this.dynamicComments ? '静态页面含动态评论组件标记' : '',
    ].filter(Boolean);
  }
}

export function hidesContent(tag: string, attrs: Record<string, string>) {
  return ['script', 'style', 'template', 'noscript'].includes(tag) ||
    'hidden' in attrs || attrs['aria-hidden'] === 'true';
}
