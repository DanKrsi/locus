import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { compareVersions } from './version.ts';

test('older, the same and newer', () => {
  assert.ok(compareVersions('0.6.13', '0.6.14') < 0);
  assert.equal(compareVersions('0.6.14', '0.6.14'), 0);
  assert.ok(compareVersions('0.6.14', '0.6.13') > 0);
});

test('numbers are compared as numbers, not as text', () => {
  assert.ok(compareVersions('0.6.10', '0.6.9') > 0);
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
});

test('a missing part counts as zero', () => {
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.ok(compareVersions('1.2.1', '1.2') > 0);
});
