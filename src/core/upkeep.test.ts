import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renumberLabel, updateLinks } from './upkeep.ts';

test('a label that names the old lines is renumbered; other text is left alone', () => {
  const from = { lines: { start: 20, end: 33 } };
  const to = { lines: { start: 24, end: 37 } };
  assert.equal(renumberLabel('client.py L20-33', from, to), 'client.py L24-37');
  assert.equal(renumberLabel('client.py L20–L33 (retry)', from, to), 'client.py L24-37 (retry)');
  assert.equal(renumberLabel('the backoff loop', from, to), 'the backoff loop');
  assert.equal(renumberLabel('client.py L20', { lines: { start: 20, end: 20 } }, { lines: { start: 22, end: 22 } }), 'client.py L22');
  // "L20" inside another range is not this link's place.
  assert.equal(renumberLabel('see L20-25', { lines: { start: 20, end: 20 } }, { lines: { start: 22, end: 22 } }), 'see L20-25');
});

test('pages, slides and ranges are renumbered only when the label names the old one', () => {
  assert.equal(renumberLabel('BDS p12', { page: 12 }, { page: 14 }), 'BDS p14');
  assert.equal(renumberLabel('BDS page 12, margins', { page: 12 }, { page: 14 }), 'BDS page 14, margins');
  assert.equal(renumberLabel('BDS p120', { page: 12 }, { page: 14 }), 'BDS p120');
  assert.equal(renumberLabel('Deck slide 4', { slide: 4 }, { slide: 6 }), 'Deck slide 6');
  assert.equal(renumberLabel('Loads B4:D12', { sheet: { sheet: 'Loads', range: 'B4:D12' } }, { sheet: { sheet: 'Loads', range: 'B6:D14' } }), 'Loads B6:D14');
});

test('updates the address of matching links and keeps titles, labels and brackets', () => {
  const md = 'See [loop](/src/a.py#L4-L9&at=aaaaaaaaaa "for x in y") and [BDS p5](</docs/B D.pdf#page=5&at=aaaaaaaaaa>).\n';
  const r = updateLinks('/notes/n.md', md, [
    { dest: '/src/a.py#L4-L9&at=aaaaaaaaaa', newDest: '/src/a.py#L6-L11&at=bbbbbbbbbb' },
    { dest: '/docs/B D.pdf#page=5&at=aaaaaaaaaa', newDest: '/docs/B D.pdf#page=7&at=bbbbbbbbbb', newLabel: 'BDS p7' },
  ]);
  assert.equal(r.count, 2);
  assert.equal(r.text, 'See [loop](/src/a.py#L6-L11&at=bbbbbbbbbb "for x in y") and [BDS p7](</docs/B D.pdf#page=7&at=bbbbbbbbbb>).\n');
});

test('links with other addresses, and links in code, are left alone', () => {
  const md = '[a](/x.py#L1&at=aaaaaaaaaa) `[a](/y.py#L1&at=aaaaaaaaaa)` [b](/z.py#L1)\r\n';
  const r = updateLinks('/n.md', md, [{ dest: '/y.py#L1&at=aaaaaaaaaa', newDest: '/y.py#L2&at=bbbbbbbbbb' }]);
  assert.deepEqual(r, { text: md, count: 0 });
});

test('flowchart boxes are updated too', () => {
  const canvas = JSON.stringify({ nodes: [{ id: 'a', type: 'text', text: 'Retry [loop](/src/a.py#L4&at=aaaaaaaaaa)', x: 0, y: 0, width: 100, height: 40 }], edges: [] });
  const r = updateLinks('/f.canvas', canvas, [{ dest: '/src/a.py#L4&at=aaaaaaaaaa', newDest: '/src/a.py#L6&at=bbbbbbbbbb' }]);
  assert.equal(r.count, 1);
  assert.match(r.text, /a\.py#L6&at=bbbbbbbbbb/);
});
