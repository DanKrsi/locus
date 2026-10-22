import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultLabel,
  formatReference,
  parseA1Range,
  parseDestination,
  parseSheetRef,
  resolvePath,
  splitLinkTarget,
} from './link.ts';

test('code lines with a recorded version', () => {
  const ref = parseDestination('/src/net/client.py#L40-L72&at=3f2a9c1e08')!;
  assert.equal(ref.pathKind, 'root');
  assert.deepEqual(ref.loc.lines, { start: 40, end: 72 });
  assert.equal(ref.at, '3f2a9c1e08');
  assert.equal(ref.rev, undefined);
});

test('pdf area, pinned', () => {
  const ref = parseDestination('/docs/spec.pdf#page=12&viewrect=72,140,300,95&rev=abcdef1234')!;
  assert.equal(ref.loc.page, 12);
  assert.deepEqual(ref.loc.viewrect, { x: 72, y: 140, w: 300, h: 95 });
  assert.equal(ref.rev, 'abcdef1234');
});

test('quoted sheet names survive & and quotes', () => {
  assert.deepEqual(parseSheetRef("'Load cases'!B4:D12"), { sheet: 'Load cases', range: 'B4:D12' });
  assert.deepEqual(parseSheetRef("'Bob''s & co'!A1"), { sheet: "Bob's & co", range: 'A1' });
  const ref = parseDestination("/data/Loads.xlsx#'R&D'!B4:D12&at=1234567")!;
  assert.deepEqual(ref.loc.sheet, { sheet: 'R&D', range: 'B4:D12' });
  assert.equal(ref.at, '1234567');
});

test('named range and A1 parsing', () => {
  assert.deepEqual(parseDestination('/x.xlsx#LoadTable')!.loc.sheet, { range: 'LoadTable' });
  assert.deepEqual(parseA1Range('B4:D12'), { top: 4, left: 2, bottom: 12, right: 4 });
  assert.equal(parseA1Range('4:12')!.top, 4);
  assert.equal(parseA1Range('LoadTable'), undefined);
});

test('relative paths resolve against the note folder', () => {
  const ref = parseDestination('../pdfs/Spec.pdf#page=3')!;
  assert.equal(ref.pathKind, 'relative');
  assert.equal(resolvePath(ref, '/notes/review.md'), '/pdfs/Spec.pdf');
});

test('round trip with spaces, title and unknown parts', () => {
  const text = formatReference('Loads [B4]', parseDestination("/data/Bracket loads.xlsx#'Load cases'!B4:D12&zoom=2&at=1234567abc")!, 'say "hi"');
  assert.equal(text, `[Loads \\[B4\\]](</data/Bracket loads.xlsx#'Load cases'!B4:D12&at=1234567abc&zoom=2> "say \\"hi\\"")`);
  const inner = text.slice(text.indexOf('](') + 2, -1);
  const { dest, title } = splitLinkTarget(inner);
  assert.equal(title, 'say "hi"');
  assert.deepEqual(parseDestination(dest)!.loc.sheet, { sheet: 'Load cases', range: 'B4:D12' });
});

test('default labels', () => {
  assert.equal(defaultLabel('/docs/NASA-STD.pdf', { page: 18 }), 'NASA-STD p18');
  assert.equal(defaultLabel('/src/solver.py', { lines: { start: 12, end: 18 } }), 'solver.py L12-18');
  assert.equal(defaultLabel('/data/Loads.xlsx', { sheet: { sheet: 'Load cases', range: 'B4:D12' } }), "Loads 'Load cases'!B4:D12");
});

test('web links are left alone', () => {
  assert.equal(parseDestination('https://example.com/a#b')!.pathKind, 'web');
});
