import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findCommentLink } from './comment-evidence.ts';

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
    await assert.rejects(findCommentLink(pieces(body), page, target), /待核实/);
  }
});
