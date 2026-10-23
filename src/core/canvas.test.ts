import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canvasLinks, parseCanvas, rewriteCanvas, serializeCanvas, type CanvasDoc } from './canvas.ts';
import { rewriteLinks } from './rewrite.ts';

const doc: CanvasDoc = {
  nodes: [
    { id: 'a', type: 'text', shape: 'process', text: 'Open [client.py L26](/src/client.py#L26&at=abc1234567)', x: 0, y: 0, width: 160, height: 60 },
    { id: 'loop', type: 'group', label: 'for each url', x: -20, y: -40, width: 300, height: 200 },
    { id: 'b', type: 'text', shape: 'decision', text: 'Failed?\n[backoff](/src/client.py#L15-L17 "def backoff")', x: 0, y: 100, width: 140, height: 90 },
  ],
  edges: [{ id: 'e', fromNode: 'a', fromSide: 'bottom', toNode: 'b', toSide: 'top', route: 'elbow', points: [{ x: 80, y: 80 }] }],
};

test('round-trips one node or edge per line, keeping extra fields', () => {
  const text = serializeCanvas({ ...doc, custom: { keep: true } });
  assert.deepEqual(parseCanvas(text), { ...doc, custom: { keep: true } });
  const lines = text.split('\n');
  assert.equal(lines[0], '{');
  assert.equal(lines[1], '\t"nodes":[');
  assert.ok(lines[2].startsWith('\t\t{"id":"a"'));
  assert.ok(lines.some((l) => l.startsWith('\t\t{"id":"e","fromNode":"a"')));
});

test('an empty file is an empty flowchart', () => {
  assert.deepEqual(parseCanvas(''), { nodes: [], edges: [] });
  assert.equal(serializeCanvas({ nodes: [], edges: [] }), '{\n\t"nodes":[],\n\t"edges":[]\n}\n');
});

test('finds the links in boxes with the line of each box', () => {
  const links = canvasLinks(serializeCanvas(doc));
  assert.deepEqual(
    links.map((l) => [l.nodeId, l.nodeLine, l.label, l.dest, l.title]),
    [
      ['a', 3, 'client.py L26', '/src/client.py#L26&at=abc1234567', undefined],
      ['b', 5, 'backoff', '/src/client.py#L15-L17', 'def backoff'],
    ],
  );
});

test('rewrites links in boxes when a file moves', () => {
  const r = rewriteCanvas(serializeCanvas(doc), (md) => rewriteLinks(md, '/flows/a.canvas', '/flows/a.canvas', [{ from: '/src/client.py', to: '/src/net/client.py' }]));
  assert.ok(r);
  assert.equal(r.count, 2);
  const after = parseCanvas(r.text);
  assert.match(after.nodes[0].text!, /\/src\/net\/client\.py#L26/);
  assert.match(after.nodes[2].text!, /\/src\/net\/client\.py#L15-L17/);
  assert.equal(rewriteCanvas(r.text, (md) => ({ text: md, count: 0 })), null);
});
