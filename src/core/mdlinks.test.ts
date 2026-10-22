import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLinks } from './mdlinks.ts';

test('finds references with angle brackets, titles and escaped labels', () => {
  const md = [
    '# Title',
    'See [BDS p5](</docs/BDS 100.pdf#page=5&at=abcdef1234> "a \\"quoted\\" bit") and [a \\[x\\]](/src/a.py#L1-L2).',
    '',
    '```',
    '[not a link](/x.py)',
    '```',
    'Inline `[nope](/y.py)` and ![img](/pic.png).',
  ].join('\n');
  const links = extractLinks(md);
  assert.equal(links.length, 3);
  assert.deepEqual([links[0].label, links[0].dest, links[0].title, links[0].line], ['BDS p5', '/docs/BDS 100.pdf#page=5&at=abcdef1234', 'a "quoted" bit', 2]);
  assert.equal(links[1].label, 'a [x]');
  assert.equal(links[1].dest, '/src/a.py#L1-L2');
  assert.equal(links[2].image, true);
  assert.equal(links[2].line, 7);
});
