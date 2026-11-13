import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { formatState, nestList, setHeading, toggleLinePrefix, toggleWrap } from './format.ts';

/** A note with the selection marked by | (cursor) or « and ». Returns a stand-in for the editor. */
function note(marked: string) {
  const anchor = marked.search(/[|«]/);
  const cursor = marked[anchor] === '|';
  const doc = marked.replace(/[|«»]/g, '');
  const head = cursor ? anchor : marked.indexOf('»') - 1;
  const view = {
    state: EditorState.create({ doc, selection: EditorSelection.single(anchor, head), extensions: [markdown({ base: markdownLanguage })] }),
    dispatch(spec: TransactionSpec) {
      this.state = this.state.update(spec).state;
      ensureSyntaxTree(this.state, this.state.doc.length, 1000);
    },
    focus() {},
  };
  ensureSyntaxTree(view.state, doc.length, 1000);
  return view as unknown as EditorView & { state: EditorState };
}
const text = (v: EditorView) => v.state.doc.toString();

test('bold wraps a selection and unwraps it again', () => {
  const v = note('say «hello» there');
  toggleWrap(v, '**');
  assert.equal(text(v), 'say **hello** there');
  assert.equal(formatState(v.state).bold, true);
  toggleWrap(v, '**');
  assert.equal(text(v), 'say hello there');
});

test('italic on bold text keeps the bold', () => {
  const v = note('**«hello»**');
  toggleWrap(v, '*');
  assert.equal(text(v), '***hello***');
  const f = formatState(v.state);
  assert.deepEqual([f.bold, f.italic], [true, true]);
  toggleWrap(v, '*');
  assert.equal(text(v), '**hello**');
});

test('un-bolding part of a phrase leaves the rest bold', () => {
  const middle = note('**one «two» three**');
  toggleWrap(middle, '**');
  assert.equal(text(middle), '**one** two **three**');
  const start = note('**«one» two**');
  toggleWrap(start, '**');
  assert.equal(text(start), 'one **two**');
});

test('a cursor inside bold text removes the bold; elsewhere it opens a pair', () => {
  const inside = note('a **bo|ld** b');
  toggleWrap(inside, '**');
  assert.equal(text(inside), 'a bold b');
  const empty = note('a | b');
  toggleWrap(empty, '**');
  assert.equal(text(empty), 'a **** b');
  assert.equal(empty.state.selection.main.head, 4);
});

test('each line of a selection is formatted separately, after its bullet', () => {
  const v = note('«- one\n- two»');
  toggleWrap(v, '**');
  assert.equal(text(v), '- **one**\n- **two**');
});

test('the text of a link can be formatted without breaking the link', () => {
  const v = note('see [«spec»](/docs/spec.pdf#page=2) now');
  toggleWrap(v, '*');
  assert.equal(text(v), 'see [*spec*](/docs/spec.pdf#page=2) now');
});

test('lists change kind in place and the same button removes them', () => {
  const v = note('«one\ntwo»');
  toggleLinePrefix(v, '- ');
  assert.equal(text(v), '- one\n- two');
  toggleLinePrefix(v, '1. ');
  assert.equal(text(v), '1. one\n2. two');
  toggleLinePrefix(v, '- [ ] ');
  assert.equal(text(v), '- [ ] one\n- [ ] two');
  toggleLinePrefix(v, '- [ ] ');
  assert.equal(text(v), 'one\ntwo');
});

test('a nested item keeps its indent when its kind changes', () => {
  const v = note('- one\n  - t|wo');
  toggleLinePrefix(v, '1. ');
  assert.equal(text(v), '- one\n  1. two');
});

test('Tab nests a list item and Shift+Tab brings it back; not outside lists', () => {
  const v = note('- one\n- t|wo');
  assert.equal(nestList(v, 1), true);
  assert.equal(text(v), '- one\n  - two');
  nestList(v, -1);
  assert.equal(text(v), '- one\n- two');
  assert.equal(nestList(note('plain| text'), 1), false);
});

test('a heading inside a quote or list keeps the quote or bullet', () => {
  const q = note('> quo|ted');
  setHeading(q, 2);
  assert.equal(text(q), '> ## quoted');
  assert.equal(formatState(q.state).heading, 2);
  setHeading(q, 0);
  assert.equal(text(q), '> quoted');
  const l = note('- it|em');
  setHeading(l, 3);
  assert.equal(text(l), '- ### item');
});

test('the toolbar state names the list kind and quote at the cursor', () => {
  assert.equal(formatState(note('- [ ] to|do').state).list, 'task');
  assert.equal(formatState(note('1. fi|rst').state).list, 'number');
  assert.equal(formatState(note('- bul|let').state).list, 'bullet');
  assert.equal(formatState(note('> quo|te').state).quote, true);
  assert.equal(formatState(note('pla|in').state).list, null);
});
