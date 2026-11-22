import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommentLinkUnconfirmed, findCommentLink, htmlChunks } from './comment-evidence.ts';

const page = new URL('https://discussion.example/posts/1#record-2');
const target = 'https://brand.example/';
async function* pieces(html: string) {
  for (let i = 0; i < html.length; i += 7) yield html.slice(i, i + 7);
}
test('attributes a link to the identified comment, preserving anchor text and rel', async () => {
  const html = '<div class="comment"><a id="record-2"></a><span class="comment-body"><a href="https://brand.example" rel="nofollow external">Brand &amp; Co</a></span></div>';
  const result = await findCommentLink(pieces(html), page, target);
  assert.equal(result.rel, 'nofollow external');
  assert.equal(result.anchor, 'Brand & Co');
  assert.equal(result.page, page.href);
});
test('keeps unrelated, hidden, nested, plain-text and ambiguous matches pending', async () => {
  const link = '<a href="https://brand.example/">Brand</a>';
  for (const body of [link + '<div id="record-2"></div>', '<div id="record-2">https://brand.example/</div>',
    '<div id="record-2"><div class="comment">' + link + '</div></div>',
    '<div id="record-2"><span hidden>' + link + '</span></div>',
    '<div id="record-2">' + link + '</div><div id="record-2"></div>']) {
    await assert.rejects(findCommentLink(pieces(body), page, target), CommentLinkUnconfirmed);
  }
});

test('explains dynamic comments and login prompts while preserving public link evidence', async () => {
  const shell = '<article><p>You must <b>log in</b> to view comments.</p><div id="disqus_thread"></div></article>';
  await assert.rejects(findCommentLink(pieces(shell), page, target), /页面正文提示登录.*动态评论组件标记/);
  const comment = '<div class="comment" id="record-2"><a href="https://brand.example/">Brand</a></div>';
  assert.equal((await findCommentLink(pieces(shell + comment), page, target)).anchor, 'Brand');
  await assert.rejects(findCommentLink(pieces('<template>' + shell + '</template>'), page, target),
    { message: '未能在唯一定位的公开记录中确认目标链接。' });
});

test('reports a response body abort using the request timeout reason', async () => {
  const abort = new AbortController();
  const timeout = new DOMException('deadline elapsed', 'TimeoutError');
  const body = new ReadableStream({
    pull(controller) {
      abort.abort(timeout);
      controller.error(new DOMException('body read aborted', 'AbortError'));
    },
  });
  const response = new Response(body, { headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(htmlChunks(response, abort.signal).next(), error => error === timeout);
});

test('bounds streamed HTML and cancels the source beyond 16 MiB', async () => {
  let cancelled = false;
  const chunk = new Uint8Array(1024 * 1024);
  const body = new ReadableStream({
    pull(controller) { controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  const response = new Response(body, { headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(async () => {
    for await (const _ of htmlChunks(response, new AbortController().signal)) { /* Consume the stream. */ }
  }, /页面超过 16 MiB/);
  assert.equal(cancelled, true);
});
