import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from './csv.ts';

test('a quoted value with commas in it is one cell', () => {
  assert.deepEqual(parseCsv('place,price\nToronto,"1,075,000"\n', ','), [['place', 'price'], ['Toronto', '1,075,000']]);
});

test('quotes inside a quoted value, and a value that runs over lines', () => {
  assert.deepEqual(parseCsv('a,b\n"say ""hi""","one\ntwo"\n', ','), [['a', 'b'], ['say "hi"', 'one\ntwo']]);
});

test('Windows line endings, and tabs as the separator', () => {
  assert.deepEqual(parseCsv('a\tb\r\n1\t2\r\n', '\t'), [['a', 'b'], ['1', '2']]);
});

test('empty cells keep their place', () => {
  assert.deepEqual(parseCsv('a,,c\n', ','), [['a', '', 'c']]);
});
