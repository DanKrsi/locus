import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from './render.ts';
import { slugify } from './link.ts';

const opts = {
  href: (dest: string) => (dest.startsWith('#') ? dest : `F:${dest}`),
  img: (dest: string) => `I:${dest}`,
  headingId: slugify,
};
const html = (md: string) => renderMarkdown(md, opts);

test('headings carry the slug a section link points at', () => {
  assert.equal(html('# Retry handling'), '<h1 id="retry-handling">Retry handling</h1>');
  assert.equal(html('### Loads & forces ###'), '<h3 id="loads--forces">Loads &amp; forces</h3>');
  assert.match(html('Title\n====\n'), /^<h1 id="title">Title<\/h1>$/);
});

test('inline formatting comes out as it looked', () => {
  assert.equal(html('a *b* **c** `d` ~~e~~'), '<p>a <em>b</em> <strong>c</strong> <code>d</code> <del>e</del></p>');
  assert.equal(html('***both***'), '<p><em><strong>both</strong></em></p>');
  assert.equal(html('5 < 6 & "x"'), '<p>5 &lt; 6 &amp; &quot;x&quot;</p>');
  assert.equal(html('a \\* b'), '<p>a * b</p>');
});

test('references become links, with the quote as the tooltip', () => {
  assert.equal(
    html('See [the loop](/src/a.py#L4-L9&at=aaaaaaaaaa "for x in y").'),
    '<p>See <a href="F:/src/a.py#L4-L9&amp;at=aaaaaaaaaa" title="for x in y">the loop</a>.</p>',
  );
  // A link inside angle brackets, and formatting inside a label.
  assert.equal(html('[*BDS* p5](</docs/B D.pdf#page=5>)'), '<p><a href="F:/docs/B D.pdf#page=5"><em>BDS</em> p5</a></p>');
  assert.equal(html('[here](#loads)'), '<p><a href="#loads">here</a></p>');
});

test('pictures keep the width the note gave them', () => {
  assert.equal(html('![a shot](/images/n/x.png#w=320)'), '<p><img src="I:/images/n/x.png#w=320" alt="a shot" width="320"></p>');
  assert.equal(renderMarkdown('![x](/p.png)', { ...opts, img: () => null }), '<p></p>');
});

test('lists, tasks and quotes', () => {
  assert.equal(html('- one\n- two'), '<ul><li>one</li>\n<li>two</li></ul>');
  assert.equal(html('3. three\n4. four'), '<ol start="3"><li>three</li>\n<li>four</li></ol>');
  assert.equal(
    html('- [x] done\n- [ ] not'),
    '<ul><li class="task"><input type="checkbox" disabled checked> done</li>\n<li class="task"><input type="checkbox" disabled> not</li></ul>',
  );
  assert.equal(html('> quoted *text*'), '<blockquote><p>quoted <em>text</em></p></blockquote>');
});

test('tables keep their column alignment', () => {
  assert.equal(
    html('| Item | Load |\n|---|--:|\n| Bracket | 12 |'),
    '<table><thead><tr><th>Item</th><th style="text-align:right">Load</th></tr></thead>' +
      '<tbody><tr><td>Bracket</td><td style="text-align:right">12</td></tr></tbody></table>',
  );
});

test('code blocks are not run through the formatter', () => {
  assert.equal(html('```py\nx = *1*\n```'), '<pre><code class="language-py">x = *1*</code></pre>');
  assert.equal(html('---'), '<hr>');
});

test('raw HTML in a note is dropped, not passed through', () => {
  assert.equal(html('<script>alert(1)</script>'), '');
  assert.equal(html('a <b>bold</b> tag'), '<p>a &lt;b&gt;bold&lt;/b&gt; tag</p>');
  assert.equal(html('[x](javascript:alert(1))'), '<p><a href="F:javascript:alert(1)">x</a></p>');
});
