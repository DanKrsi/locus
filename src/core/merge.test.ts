import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchLines, merge3 } from './merge.ts';
import { joinNoteId, splitNoteId } from './noteid.ts';

/** Length of a longest common subsequence, the slow and sure way. */
function lcs(a: string[], b: string[]): number {
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  return t[0][0];
}

test('matched lines are equal, in order, and as many as a longest common run', () => {
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
  for (let round = 0; round < 400; round++) {
    const a = Array.from({ length: rand(14) }, () => 'abcd'[rand(4)]);
    const b = Array.from({ length: rand(14) }, () => 'abcd'[rand(4)]);
    const pairs = matchLines(a, b);
    for (let p = 0; p < pairs.length; p++) {
      const [i, j] = pairs[p];
      assert.equal(a[i], b[j]);
      if (p) assert.ok(i > pairs[p - 1][0] && j > pairs[p - 1][1]);
    }
    assert.equal(pairs.length, lcs(a, b), `${a.join('')} / ${b.join('')}`);
  }
});

const base = ['# Title', '', 'one', 'two', 'three', 'four', 'five', ''].join('\n');

test('changes to different lines merge', () => {
  const mine = base.replace('two', 'TWO (mine)');
  const theirs = base.replace('five', 'five (theirs)');
  const r = merge3(base, mine, theirs);
  assert.equal(r.clean, true);
  assert.equal(r.text, base.replace('two', 'TWO (mine)').replace('five', 'five (theirs)'));
});

test('insertions on both sides in different places merge', () => {
  const mine = base.replace('one', 'zero\none');
  const theirs = base + 'six\n';
  const r = merge3(base, mine, theirs);
  assert.equal(r.clean, true);
  assert.equal(r.text, base.replace('one', 'zero\none') + 'six\n');
});

test('the same change on both sides is taken once', () => {
  const both = base.replace('three', '3');
  const r = merge3(base, both, both);
  assert.deepEqual(r, { clean: true, text: both, overlaps: 0 });
});

test('different changes to the same line do not merge', () => {
  const r = merge3(base, base.replace('three', 'mine'), base.replace('three', 'theirs'));
  assert.equal(r.clean, false);
  assert.equal(r.overlaps, 1);
});

test('one side deleting lines the other left alone', () => {
  const mine = base.replace('three\nfour\n', '');
  const theirs = base.replace('# Title', '# New title');
  const r = merge3(base, mine, theirs);
  assert.equal(r.clean, true);
  assert.equal(r.text, mine.replace('# Title', '# New title'));
});

test('only one side changed', () => {
  const theirs = base.replace('four', 'four!');
  assert.deepEqual(merge3(base, base, theirs), { clean: true, text: theirs, overlaps: 0 });
  assert.deepEqual(merge3(base, theirs, base), { clean: true, text: theirs, overlaps: 0 });
});

test('changes to next-door lines merge', () => {
  const r = merge3(base, base.replace('gamma', 'gamma mine'), base.replace('delta', 'delta theirs'));
  assert.equal(r.clean, true);
  assert.equal(r.text, base.replace('gamma', 'gamma mine').replace('delta', 'delta theirs'));
});

test('an insertion just before a line the other side changed merges', () => {
  const r = merge3(base, base.replace('three', 'new\nthree'), base.replace('three', 'THREE'));
  assert.equal(r.clean, true);
  assert.equal(r.text, base.replace('three', 'new\nTHREE'));
});

test('insertions at the same spot do not merge', () => {
  assert.equal(merge3(base, base.replace('two', 'two\nmine'), base.replace('two', 'two\ntheirs')).clean, false);
});

test('each side editing its own lines always merges to both', () => {
  let seed = 11;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
  for (let round = 0; round < 300; round++) {
    const n = 1 + rand(12);
    const lines = Array.from({ length: n }, (_, i) => `L${i}`);
    const owner = lines.map(() => rand(3)); // 0 untouched, 1 mine, 2 theirs
    const mine = lines.map((l, i) => (owner[i] === 1 ? `${l} mine` : l));
    const theirs = lines.map((l, i) => (owner[i] === 2 ? `${l} theirs` : l));
    const want = lines.map((l, i) => (owner[i] === 1 ? `${l} mine` : owner[i] === 2 ? `${l} theirs` : l));
    const r = merge3(lines.join('\n'), mine.join('\n'), theirs.join('\n'));
    assert.equal(r.clean, true, owner.join(''));
    assert.equal(r.text, want.join('\n'), owner.join(''));
  }
});

test('an empty starting point with additions on both sides is an overlap', () => {
  assert.equal(merge3('', 'a', 'b').clean, false);
});

test('a note identity survives being written and read back', () => {
  for (const body of ['# A\n\ntext\n', '# A\n\ntext', '', 'x']) {
    const back = splitNoteId(joinNoteId(body, 'abcdefghijkl', '\n')).body;
    // A body without a final line break gets one, as the identity goes on its own line.
    assert.equal(back.replace(/\n$/, ''), body.replace(/\n$/, ''));
  }
});
