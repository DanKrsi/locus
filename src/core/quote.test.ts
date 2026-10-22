import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findQuote, type TextRun } from './quote.ts';

const runs: TextRun[] = [
  { str: 'The ultimate factor of safety shall be 1.4 for all', x: 72, y: 100, w: 300, h: 11 },
  { str: 'metallic brackets. Retries of a failed proof test', x: 72, y: 116, w: 290, h: 11 },
  { str: 'shall not exceed three attempts.', x: 72, y: 132, w: 200, h: 11 },
];

test('finds a quote spanning lines and returns a box around it', () => {
  const m = findQuote(runs, 'Retries of a failed proof test shall not exceed three attempts', 0)!;
  assert.deepEqual(m.runs, [1, 2]);
  assert.ok(m.rect.y >= 116 && m.rect.y < 117);
  assert.ok(Math.abs(m.rect.y + m.rect.h - 143) < 0.01);
  assert.equal(m.rect.x, 72, 'a multi-line quote spans from the left margin');
});

test('a quote inside one run gets a box only around that part', () => {
  const m = findQuote(runs, 'Retries of a failed', 0)!;
  assert.ok(m.rect.x > 72 + 100 && m.rect.x + m.rect.w < 72 + 290);
});

test('ignores case, curly quotes and spacing', () => {
  assert.ok(findQuote(runs, 'FACTOR  of\nsafety shall be 1.4'));
});

test('handles hyphenated line breaks', () => {
  const hy: TextRun[] = [
    { str: 'verifi-', x: 0, y: 0, w: 40, h: 10 },
    { str: 'cation by test', x: 0, y: 12, w: 80, h: 10 },
  ];
  assert.ok(findQuote(hy, 'verification by test'));
});

test('returns null when absent', () => {
  assert.equal(findQuote(runs, 'not in the text'), null);
});
