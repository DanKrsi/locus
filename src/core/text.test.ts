import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readText, withEol } from './text.ts';

test('a Unix file reads as it is and is written back unchanged', () => {
  const { text, eol } = readText('# Note\n\nA line.\n');
  assert.equal(text, '# Note\n\nA line.\n');
  assert.equal(eol, '\n');
  assert.equal(withEol(text, eol), '# Note\n\nA line.\n');
});

test('a Windows file reads as plain lines and is written back with its endings', () => {
  const { text, eol } = readText('# Note\r\n\r\nA line.\r\n');
  assert.equal(text, '# Note\n\nA line.\n');
  assert.equal(eol, '\r\n');
  assert.equal(withEol(text, eol), '# Note\r\n\r\nA line.\r\n');
});

test('one Windows ending among Unix ones does not make the file a single line', () => {
  const raw = '# Note\n\n## Part\n\nEdited elsewhere.\r\n';
  const { text, eol } = readText(raw);
  assert.equal(text.split('\n').length, 6);
  assert.equal(text.includes('\r'), false);
  assert.equal(eol, '\n'); // still mostly a Unix file, so it is written back as one
});

test('mostly Windows endings win', () => {
  const { eol } = readText('a\r\nb\r\nc\nd\r\n');
  assert.equal(eol, '\r\n');
});

test('old Mac endings are lines too', () => {
  const { text } = readText('a\rb\rc');
  assert.deepEqual(text.split('\n'), ['a', 'b', 'c']);
});

test('writing back a file that still holds stray returns normalises them', () => {
  assert.equal(withEol('a\nb\r\nc', '\r\n'), 'a\r\nb\r\nc');
});
