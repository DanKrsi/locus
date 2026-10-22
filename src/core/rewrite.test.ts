import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteLinks } from './rewrite.ts';

const note = [
  'Live [loop](/src/net/client.py#L21-L32&at=abcdef1234 "fetch") and',
  'pinned [old](/src/net/client.py#L9-L18&rev=1234567890).',
  'Folder [spec](</docs/BDS 100.pdf#page=5>) and relative [basis](design-basis.md#loads).',
  '`[code](/src/net/client.py)` and [web](https://x.y/src/net/client.py).',
].join('\n');

test('live links follow a moved file; pinned links keep the path from their version', () => {
  const { text, count } = rewriteLinks(note, '/notes/review.md', '/notes/review.md', [{ from: '/src/net/client.py', to: '/src/http/client.py' }]);
  assert.equal(count, 1);
  assert.match(text, /\[loop\]\(\/src\/http\/client\.py#L21-L32&at=abcdef1234 "fetch"\)/);
  assert.match(text, /\[old\]\(\/src\/net\/client\.py#L9-L18&rev=1234567890\)/);
  assert.match(text, /`\[code\]\(\/src\/net\/client\.py\)`/, 'code spans are untouched');
});

test('folder moves apply to everything inside', () => {
  const { text } = rewriteLinks(note, '/notes/review.md', '/notes/review.md', [{ from: '/docs', to: '/standards' }]);
  assert.match(text, /\(<\/standards\/BDS 100\.pdf#page=5>\)/);
});

test('moving a note makes its relative links root-relative', () => {
  const { text, count } = rewriteLinks(note, '/notes/review.md', '/archive/2026/review.md', []);
  assert.equal(count, 1);
  assert.match(text, /\[basis\]\(\/notes\/design-basis\.md#loads\)/);
});
