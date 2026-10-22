import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLines } from './remap.ts';

test('no changes', () => {
  assert.deepEqual(mapLines([], 10, 20), { start: 10, end: 20, status: 'same' });
});

test('lines inserted above shift the range', () => {
  // 3 lines inserted after line 2.
  const hunks = [{ oldStart: 2, oldLines: 0, newStart: 3, newLines: 3 }];
  assert.deepEqual(mapLines(hunks, 10, 20), { start: 13, end: 23, status: 'moved' });
});

test('lines deleted above shift the range up', () => {
  const hunks = [{ oldStart: 3, oldLines: 2, newStart: 2, newLines: 0 }];
  assert.deepEqual(mapLines(hunks, 10, 20), { start: 8, end: 18, status: 'moved' });
});

test('edits below do not matter', () => {
  const hunks = [{ oldStart: 30, oldLines: 1, newStart: 30, newLines: 5 }];
  assert.deepEqual(mapLines(hunks, 10, 20), { start: 10, end: 20, status: 'same' });
});

test('an edit inside the range is reported', () => {
  const hunks = [
    { oldStart: 1, oldLines: 0, newStart: 2, newLines: 1 },
    { oldStart: 15, oldLines: 1, newStart: 16, newLines: 2 },
  ];
  assert.deepEqual(mapLines(hunks, 10, 20), { start: 11, end: 22, status: 'changed' });
});

test('a fully deleted range is gone', () => {
  const hunks = [{ oldStart: 10, oldLines: 11, newStart: 9, newLines: 0 }];
  assert.equal(mapLines(hunks, 10, 20).status, 'gone');
});
