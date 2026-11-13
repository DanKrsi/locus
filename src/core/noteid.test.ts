import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addNoteId, joinNoteId, linkNoteId, newNoteId, readNoteId, splitNoteId, withLinkNoteId } from './noteid.ts';
import { formatDestination, parseDestination } from './link.ts';

test('an identity is twelve lowercase letters and digits', () => {
  assert.match(newNoteId(), /^[a-z0-9]{12}$/);
  assert.notEqual(newNoteId(), newNoteId());
});

test('the identity is split off for the editor and put back exactly', () => {
  for (const file of ['# Title\n\nText\n<!-- locus-id: abc123def456 -->\n', '# Title\r\n\r\nText\r\n<!-- locus-id: abc123def456 -->\r\n', 'no newline at end\n<!-- locus-id: abc123def456 -->']) {
    const { body, id } = splitNoteId(file);
    assert.equal(id, 'abc123def456');
    assert.ok(!body.includes('locus-id'));
    const eol = file.includes('\r\n') ? '\r\n' : '\n';
    assert.equal(joinNoteId(body, id, eol).trimEnd(), file.trimEnd());
  }
  assert.deepEqual(splitNoteId('plain\n'), { body: 'plain\n' });
  // A comment that isn't the last line is ordinary text.
  assert.equal(splitNoteId('<!-- locus-id: abc123def456 -->\nmore\n').id, undefined);
});

test('adding an identity keeps the text, and never replaces one', () => {
  const md = addNoteId('/n.md', '# A\n\ntext', 'abc123def456');
  assert.equal(md, '# A\n\ntext\n<!-- locus-id: abc123def456 -->\n');
  assert.equal(addNoteId('/n.md', md, 'zzzzzzzzzzzz'), md);
  assert.equal(readNoteId('/n.md', md), 'abc123def456');
});

test('a flowchart keeps its identity in a key other apps ignore', () => {
  const canvas = '{\n\t"nodes":[\n\t\t{"id":"a","type":"text","text":"x","x":0,"y":0,"width":10,"height":10}\n\t],\n\t"edges":[]\n}\n';
  const withId = addNoteId('/f.canvas', canvas, 'abc123def456');
  assert.equal(readNoteId('/f.canvas', withId), 'abc123def456');
  assert.ok(withId.startsWith(canvas.slice(0, canvas.indexOf('"edges"'))));
  assert.equal(readNoteId('/f.canvas', canvas), undefined);
});

test('a link records the note it points at and survives a round trip', () => {
  const ref = parseDestination('/notes/design.md#loads&id=abc123def456')!;
  assert.equal(ref.loc.heading, 'loads');
  assert.equal(linkNoteId(ref.extra), 'abc123def456');
  assert.equal(formatDestination(ref), '/notes/design.md#loads&id=abc123def456');
  const plain = parseDestination('/notes/design.md')!;
  assert.equal(formatDestination({ ...plain, extra: withLinkNoteId(plain.extra, 'abc123def456') }), '/notes/design.md#id=abc123def456');
});
