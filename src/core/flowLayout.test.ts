import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxSize, checkDraft, layoutDraft, type Draft } from './flowLayout.ts';

const draft: Draft = {
  loops: [
    { id: 'urls', label: 'for each url in urls' },
    { id: 'attempts', label: 'for attempt in range(RETRIES)', parent: 'urls' },
  ],
  boxes: [
    { id: 'start', text: 'fetch_all(urls)', shape: 'terminal' },
    { id: 'open', text: 'urlopen(url)\n[client.py L26](/src/net/client.py#L26-L27&at=abc1234567)', loop: 'attempts' },
    { id: 'failed', text: 'failed?', shape: 'decision', loop: 'attempts' },
    { id: 'wait', text: 'wait backoff(attempt)', loop: 'attempts' },
    { id: 'body', text: 'return body', loop: 'urls' },
    { id: 'end', text: 'return results', shape: 'terminal' },
  ],
  arrows: [
    { from: 'start', to: 'open' },
    { from: 'open', to: 'failed' },
    { from: 'failed', to: 'wait', label: 'yes' },
    { from: 'failed', to: 'body', label: 'no' },
    { from: 'wait', to: 'open', label: 'next attempt' },
    { from: 'urls', to: 'end', label: 'all done' },
  ],
};

const inside = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x >= b.x && a.y >= b.y && a.x + a.width <= b.x + b.width && a.y + a.height <= b.y + b.height;

test('lays out boxes inside their loops, loops inside their parents, without overlaps', async () => {
  const doc = await layoutDraft(draft);
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  assert.ok(inside(byId.get('attempts')!, byId.get('urls')!));
  for (const b of draft.boxes) {
    const n = byId.get(b.id)!;
    if (b.loop) assert.ok(inside(n, byId.get(b.loop)!), `${b.id} inside ${b.loop}`);
    else assert.ok(!inside(n, byId.get('urls')!), `${b.id} outside the loops`);
  }
  const boxes = doc.nodes.filter((n) => n.type === 'text');
  for (const a of boxes)
    for (const b of boxes)
      if (a !== b) assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y, `${a.id} overlaps ${b.id}`);
  assert.ok(byId.get('start')!.y < byId.get('open')!.y && byId.get('open')!.y < byId.get('failed')!.y);
});

test('routes loop-backs dashed up the side of their loop, and decisions out to the side', async () => {
  const doc = await layoutDraft(draft);
  const back = doc.edges.find((e) => e.fromNode === 'wait' && e.toNode === 'open')!;
  const loop = doc.nodes.find((n) => n.id === 'attempts')!;
  assert.equal(back.style, 'dashed');
  assert.equal(back.fromSide, back.toSide);
  assert.equal(back.points!.length, 2);
  assert.ok(back.points!.every((p) => p.x > loop.x && p.x < loop.x + loop.width), 'lane inside the loop frame');
  const yes = doc.edges.find((e) => e.label === 'yes')!;
  const no = doc.edges.find((e) => e.label === 'no')!;
  assert.equal(yes.fromSide === 'bottom' || no.fromSide === 'bottom', true);
  assert.equal(doc.edges.find((e) => e.fromNode === 'urls')!.fromSide, 'bottom');
});

test('sizes boxes to their text and rejects broken drafts', () => {
  assert.ok(boxSize('a much longer box label that wraps onto more lines').h > boxSize('short').h);
  assert.ok(boxSize('x?', 'decision').w > boxSize('x?').w);
  assert.throws(() => checkDraft({ boxes: [{ id: 'a', text: '' }], arrows: [{ from: 'a', to: 'b' }] }), /no box or loop has that id/);
  assert.throws(() => checkDraft({ boxes: [{ id: 'a', text: '', loop: 'x' }], arrows: [] }), /isn't defined/);
  assert.throws(() => checkDraft({ boxes: [{ id: 'a', text: '' }, { id: 'a', text: '' }], arrows: [] }), /Duplicate/);
});
