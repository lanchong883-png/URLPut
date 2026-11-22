import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeHtml } from './site-analysis.ts';

async function* chunks(html: string) {
  for (let index = 0; index < html.length; index += 7) yield html.slice(index, index + 7);
}

const url = 'https://discussion.example/post';

test('detects a dynamic comment shell and a visible login prompt, leaving missing fields unknown', async () => {
  const result = await analyzeHtml(chunks('<article><p>请先登录后查看评论。</p><div id="disqus_thread"></div></article>'), url);
  assert.match(result.login, /页面提示需登录/);
  assert.match(result.limitations, /动态评论/);
  assert.match(result.evidence, /动态评论组件标记/);
  assert.equal(result.entry, '未知');
  assert.equal(result.fee, '未知');
  assert.deepEqual(result.required, []);
});

test('collects required fields only from the visible comment form', async () => {
  const result = await analyzeHtml(chunks(
    '<div hidden><p>请先登录后查看评论。</p><div id="disqus_thread"></div></div>' +
    '<form action="/search"><input name="query" required></form>' +
    '<form action="/comment"><input hidden required name="secret"><textarea name="comment" required></textarea></form>',
  ), url);
  assert.equal(result.entry, 'https://discussion.example/comment');
  assert.equal(result.login, '未知');
  assert.doesNotMatch(result.evidence, /动态评论/);
  assert.deepEqual(result.required, ['comment']);
});
