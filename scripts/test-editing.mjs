// Tries to break the formatting of a note by editing it by hand: Backspace, Delete, Enter and
// typing at every place the cursor can stand, and over selections. After each edit the text as it
// is shown (with its bold, italic, code, strikethrough and links) must be the text before with just
// that edit made: nothing else may lose or gain formatting, and no markup may show as text.
// Usage: npm run build && node scripts/make-test-workspace.mjs && node scripts/test-editing.mjs [filter]
import { _electron as electron } from 'playwright';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const out = join(repo, 'test-output-editing', process.env.CLIP ? 'clip' : process.env.SHARD ? `shard-${process.env.SHARD.replace('/', '-')}` : 'run');
const userData = join(out, 'user-data');
const workspace = resolve(repo, '..', 'locus-test-workspace');
const filter = process.argv[2];
// SHARD=k/n runs every n-th sample starting at k, so several copies can run side by side.
const [shard, shards] = (process.env.SHARD ?? '0/1').split('/').map(Number);
// The clipboard is shared by every copy: cut and paste run only in one of their own (CLIP=1),
// or in a run that isn't split up.
const ONLY_CLIP = !!process.env.CLIP;
const NO_CLIP = !!process.env.SHARD && !ONLY_CLIP;

// Each is a small note; every reachable cursor place in it is tried.
const DOCS = [
  'one **bold** two',
  '**bold** at start',
  'ends **bold**',
  'one *italic* two',
  'one _italic_ two',
  'one __bold__ two',
  'one `code` two',
  'one ~~gone~~ two',
  '***both*** here',
  '**bold *inner* bold**',
  '*it **strong** it*',
  '**a** *b*',
  '**a** **b**',
  '*a* *b*',
  '`a` `b`',
  '**x**',
  'a **b** c',
  'see [the site](https://example.com) now',
  '[link](https://example.com) first',
  'a [**bold link**](https://example.com) b',
  '**bold `code` bold**',
  '# Heading **bold** end',
  '## *Italic* heading',
  '- item **bold** end\n- second *it*',
  '1. first **b**\n2. second',
  '- [ ] task **bold**',
  '> quote **bold** end',
  'line one **bold**\nline **two** end',
  'para one\n\n**para two** end',
  'x **bold\nacross** y',
  'mixed **b** and *i* and `c` and ~~s~~.',
  '**a b**',
  '*one two*',
  '[x **y**](https://example.com)',
  'a **b** *c* `d` e',
];

// Literal characters that are also markup: typed, they must show as typed and break nothing.
// (Other markup characters typed by hand still make formatting, as markdown does.)
const SYMBOLS = ['[', ']'];

await rm(out, { recursive: true, force: true });
await mkdir(userData, { recursive: true });
await writeFile(join(userData, 'settings.json'), JSON.stringify({ claudeOffered: 'skip', recentWorkspaces: [workspace], dark: 'light' }));
const labNote = `edit-lab-${ONLY_CLIP ? 'clip' : shard}`;
await writeFile(join(workspace, 'notes', `${labNote}.md`), 'Editing lab\n');

const app = await electron.launch({ args: [repo], env: { ...process.env, LOCUS_USER_DATA: userData } });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1500, height: 900 });
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));

await win.getByText('Bracket project').first().waitFor({ timeout: 15000 });
await win.keyboard.press('Control+O');
await win.getByPlaceholder('Find a file by name').fill(labNote);
await win.locator('.tree-row', { hasText: `${labNote}.md` }).waitFor();
await win.keyboard.press('Enter');
await win.locator('.editor-wrap .cm-line', { hasText: 'Editing lab' }).waitFor({ timeout: 10000 });

await win.evaluate(() => {
  const STYLE = { 'cm-strong': 'B', 'cm-em': 'I', 'cm-strike': 'S', 'cm-inline-code': 'C', 'cm-link-label': 'L' };
  const view = () => document.querySelector('.editor-wrap .cm-content').cmTile.root.view;
  // The characters as shown, in order: text of each line (widgets and list numbers left out), with
  // a newline between lines. Each has the formatting it is drawn with.
  const chars = () => {
    const v = view();
    const list = [];
    const lines = [...v.contentDOM.children].filter((el) => el.classList.contains('cm-line'));
    lines.forEach((line, i) => {
      if (i) list.push({ ch: '\n', node: line, at: 0 });
      const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT, {
        acceptNode: (t) => (t.parentElement.closest('[contenteditable=false], .cm-listmark') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      for (let t = walk.nextNode(); t; t = walk.nextNode()) {
        let style = '';
        for (let el = t.parentElement; el && el !== line; el = el.parentElement)
          for (const c of el.classList) if (STYLE[c] && !style.includes(STYLE[c])) style += STYLE[c];
        style = [...style].sort().join('');
        for (let k = 0; k < t.data.length; k++) list.push({ ch: t.data[k], style, node: t, at: k + 1 });
      }
    });
    return list;
  };
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  window.__lab = {
    async set(doc, anchor, head = anchor) {
      const v = view();
      // Not part of the history, so Ctrl+Z after an edit takes back only that edit.
      const Transaction = v.state.update({}).constructor;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: doc }, annotations: Transaction.addToHistory.of(false) });
      // A cursor move of its own also keeps the next edit from joining the last sample's in the history.
      v.dispatch({ selection: { anchor, head }, userEvent: 'select' });
      v.focus();
    },
    async shown() {
      await frame();
      const v = view();
      const list = chars();
      // Where the cursor is among the shown characters.
      const { node, offset } = v.domAtPos(v.state.selection.main.head);
      const r = document.createRange();
      r.setStart(node, offset);
      let cursor = 0;
      for (const c of list) if (r.comparePoint(c.node, c.at) <= 0) cursor++;
      return {
        text: list.map((c) => c.ch).join(''),
        styles: list.map((c) => c.style ?? ''),
        cursor,
        doc: v.state.doc.toString(),
        head: v.state.selection.main.head,
      };
    },
    head: () => view().state.selection.main.head,
    len: () => view().state.doc.length,
  };
});

const lab = {
  set: (doc, a, h) => win.evaluate(([d, x, y]) => window.__lab.set(d, x, y), [doc, a, h ?? a]),
  shown: () => win.evaluate(() => window.__lab.shown()),
  head: () => win.evaluate(() => window.__lab.head()),
};

/** Every place the cursor can stand, found by walking it with the arrow keys both ways. */
async function reachable(doc) {
  const seen = new Set();
  const len = doc.length;
  for (const [start, key] of [
    [0, 'ArrowRight'],
    [len, 'ArrowLeft'],
  ]) {
    await lab.set(doc, start);
    let prev = -1;
    for (let i = 0; i < len + 5; i++) {
      const h = await lab.head();
      seen.add(h);
      if (h === prev) break;
      prev = h;
      await win.keyboard.press(key);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

const show = (s) => s.text.replace(/\n/g, '⏎');
const styled = (s) =>
  [...s.text].map((c, i) => (s.styles[i] ? `${c === '\n' ? '⏎' : c}[${s.styles[i]}]` : c === '\n' ? '⏎' : c)).join('');

/**
 * Whether `after` is `before` with the shown characters [from, to) replaced by `insert`, every
 * other character keeping its formatting, and the cursor at `cursor`. A space's formatting can't
 * be seen, so it isn't compared; `loose` also lets spaces come and go (a list item's indent).
 */
function check(before, after, from, to, insert, cursor, loose = false) {
  let text = before.text.slice(0, from) + insert + before.text.slice(to);
  let styles = [...before.styles.slice(0, from), ...[...insert].map(() => null), ...before.styles.slice(to)];
  let got = after.text;
  let gotStyles = after.styles;
  if (loose) {
    const keep = (t) => [...t].map((c, i) => (c === ' ' ? -1 : i)).filter((i) => i >= 0);
    const [k1, k2] = [keep(text), keep(got)];
    [text, styles] = [k1.map((i) => text[i]).join(''), k1.map((i) => styles[i])];
    [got, gotStyles] = [k2.map((i) => got[i]).join(''), k2.map((i) => gotStyles[i])];
  }
  if (got !== text) return `shows "${show(after)}", expected "${text.replace(/\n/g, '⏎')}"`;
  for (let i = 0; i < text.length; i++) {
    if (styles[i] !== null && text[i] !== ' ' && styles[i] !== gotStyles[i])
      return `"${text[i] === '\n' ? '⏎' : text[i]}" at ${i} was ${styles[i] || 'plain'}, now ${gotStyles[i] || 'plain'}`;
  }
  if (cursor !== null && after.cursor !== cursor) return `cursor at ${after.cursor}, expected ${cursor}`;
  return null;
}

/**
 * A line break made at [from, to): Enter may also drop spaces right beside the cursor, as editors
 * do. `inserts` are the acceptable things put there ('' for a break taken back).
 */
function breakAt(before, after, from, to, inserts, loose = false) {
  const lead = before.text.slice(0, from).match(/[ \t]*$/)[0].length;
  const trail = before.text.slice(to).match(/^[ \t]*/)[0].length;
  let first = null;
  for (const insert of inserts) {
    for (const [a, b] of [
      [from, to],
      [from, to + trail],
      [from - lead, to],
      [from - lead, to + trail],
    ]) {
      // The new line may take the indent of the line it came from.
      let why = check(before, after, a, b, insert, null, loose);
      const cursor = a + insert.length;
      if (!why && !loose && (after.cursor < cursor || after.text.slice(cursor, after.cursor).trim())) why = `cursor at ${after.cursor}, expected ${cursor}`;
      if (!why) return null;
      first ??= why;
    }
  }
  return first;
}

const failures = [];
let tried = 0;
const fail = (doc, what, base, after, why) => {
  failures.push({ doc, what, why, before: styled(base), after: styled(after), md: after.doc, head: after.head });
};

/** Makes an edit, checks what it shows, then checks that Ctrl+Z gives back the note as it was. */
async function attempt(doc, anchor, head, what, keys, expect, undo = true) {
  await lab.set(doc, anchor, head);
  const base = await lab.shown();
  for (const k of keys) {
    if (k.type) await win.keyboard.type(k.type);
    else await win.keyboard.press(k);
  }
  const after = await lab.shown();
  tried++;
  const why = expect(base, after);
  if (why) fail(doc, what, base, after, why);
  if (undo && after.doc !== doc) {
    await win.keyboard.press('Control+Z');
    const back = await lab.shown();
    if (back.doc !== doc) fail(doc, `undo after ${what}`, base, back, `Ctrl+Z gave ${JSON.stringify(back.doc)}`);
  }
}

// Before any editing, every sample shows its formatting with no markup showing as text.
const MARKUP = /[*_`~[\]#>]/;

for (const [index, doc] of DOCS.entries()) {
  if ((filter && !doc.includes(filter)) || index % shards !== shard) continue;
  const places = await reachable(doc);
  await lab.set(doc, 0);
  const start = await lab.shown();
  tried++;
  if (MARKUP.test(start.text)) failures.push({ doc, what: 'shown before editing', why: 'markup shows as text', before: styled(start), after: '', md: doc });
  for (const p of ONLY_CLIP ? [] : places) {
    const at = `|${doc.slice(0, p)}‸${doc.slice(p)}|`.replace(/\n/g, '⏎');
    await attempt(doc, p, p, `Backspace at ${at}`, ['Backspace'], (b, a) => {
      const v = b.cursor;
      if (v === 0) return check(b, a, 0, 0, '', 0);
      // At the start of a line, Backspace may take away the line's formatting (heading, bullet).
      if (b.text[v - 1] === '\n' && a.text === b.text) return check(b, a, 0, 0, '', v);
      return check(b, a, v - 1, v, '', v - 1);
    });
    await attempt(doc, p, p, `Delete at ${at}`, ['Delete'], (b, a) => {
      const v = b.cursor;
      return v >= b.text.length ? check(b, a, v, v, '', v) : check(b, a, v, v + 1, '', v);
    });
    await attempt(doc, p, p, `Enter at ${at}`, ['Enter'], (b, a) => breakAt(b, a, b.cursor, b.cursor, ['\n']));
    await attempt(doc, p, p, `Enter twice at ${at}`, ['Enter', 'Enter'], (b, a) => breakAt(b, a, b.cursor, b.cursor, ['\n\n', '\n']), false);
    await attempt(doc, p, p, `type at ${at}`, [{ type: 'x' }], (b, a) => check(b, a, b.cursor, b.cursor, 'x', b.cursor + 1));
    await attempt(doc, p, p, `type a space at ${at}`, [{ type: ' ' }], (b, a) => check(b, a, b.cursor, b.cursor, ' ', b.cursor + 1));
    await attempt(doc, p, p, `Enter then Backspace at ${at}`, ['Enter', 'Backspace'], (b, a) => breakAt(b, a, b.cursor, b.cursor, ['', '\n'], true), false);
    await attempt(doc, p, p, `Ctrl+Backspace at ${at}`, ['Control+Backspace'], (b, a) => {
      const k = a.text.length - (b.text.length - b.cursor);
      return k < 0 || k > b.cursor ? `shows "${show(a)}"` : check(b, a, k, b.cursor, '', k);
    });
    await attempt(doc, p, p, `Ctrl+Delete at ${at}`, ['Control+Delete'], (b, a) => {
      const k = b.cursor + (b.text.length - a.text.length);
      return k < b.cursor ? `shows "${show(a)}"` : check(b, a, b.cursor, k, '', b.cursor);
    });
    for (const s of SYMBOLS)
      await attempt(doc, p, p, `type ${s} at ${at}`, [{ type: s }], (b, a) => check(b, a, b.cursor, b.cursor, s, b.cursor + 1));
  }
  // Selections between two places: delete them, type over them, break a line there. Short notes
  // try every pair; longer ones pairs a few places apart, and the whole note.
  const shownAt = new Map();
  for (const p of places) {
    await lab.set(doc, p);
    shownAt.set(p, (await lab.shown()).cursor);
  }
  const pairs = [];
  for (let i = 0; i < places.length; i++)
    for (let j = i + 1; j < places.length; j++)
      if (places.length <= 12 || [1, 2, 3, 5, 8].includes(j - i) || (i === 0 && j === places.length - 1)) pairs.push([places[i], places[j]]);
  for (const [p, q] of pairs) {
    const at = `|${doc.slice(0, p)}[${doc.slice(p, q)}]${doc.slice(q)}|`.replace(/\n/g, '⏎');
    const [va, vb] = [shownAt.get(p), shownAt.get(q)];
    if (va === vb) continue;
    if (!NO_CLIP) {
      await attempt(doc, p, q, `cut ${at}`, ['Control+X'], (b, a) => check(b, a, va, vb, '', va));
      await app.evaluate(({ clipboard }) => clipboard.writeText('P'));
      await attempt(doc, p, q, `paste over ${at}`, ['Control+V'], (b, a) => check(b, a, va, vb, 'P', va + 1));
    }
    if (ONLY_CLIP) continue;
    await attempt(doc, p, q, `Backspace over ${at}`, ['Backspace'], (b, a) => check(b, a, va, vb, '', va));
    await attempt(doc, p, q, `Delete over ${at}`, ['Delete'], (b, a) => check(b, a, va, vb, '', va));
    await attempt(doc, p, q, `type over ${at}`, [{ type: 'x' }], (b, a) => check(b, a, va, vb, 'x', va + 1));
    // Enter on a list item left empty ends the list instead of breaking the line.
    await attempt(doc, p, q, `Enter over ${at}`, ['Enter'], (b, a) => {
      const empty = (va === 0 || b.text[va - 1] === '\n') && (vb === b.text.length || b.text[vb] === '\n');
      return breakAt(b, a, va, vb, empty ? ['\n', ''] : ['\n']);
    });
  }
  process.stdout.write('.');
}

// Typing markdown by hand and the formatting buttons still work.
const positive = [
  ['a bullet typed by hand', '', [{ type: '- a' }], (d, s) => d === '- a' && s.text === 'a'],
  ['a heading typed by hand', '', [{ type: '# Title' }], (d, s) => d === '# Title' && s.text === 'Title'],
  ['a quote typed by hand', '', [{ type: '> q' }], (d, s) => d === '> q' && s.text === 'q'],
  ['a task typed by hand', '', [{ type: '- [ ] t' }], (d, s) => d === '- [ ] t' && s.text === 't'],
  ['a numbered list continues', '', [{ type: '1. a' }, 'Enter', { type: 'b' }], (d) => d === '1. a\n2. b'],
  ['a bullet list continues', '', [{ type: '- a' }, 'Enter', { type: 'b' }], (d) => d === '- a\n- b'],
  ['Enter on empty bullets ends the list', '', [{ type: '- a' }, 'Enter', 'Enter', 'Enter', { type: 'b' }], (d) => /\nb$/.test(d) && !d.includes('- b')],
  ['Ctrl+B then typing is bold', 'x ', ['End', 'Control+B', { type: 'bold' }], (d, s) => d === 'x **bold**' && s.styles.slice(2).every((st) => st === 'B')],
  ['Ctrl+I on a selected word', 'one two', ['End', 'Shift+Control+ArrowLeft', 'Control+I'], (d) => d === 'one *two*'],
];
for (const [name, doc, keys, ok] of shard === 0 && !ONLY_CLIP ? positive : []) {
  await lab.set(doc, 0);
  for (const k of keys) {
    if (k.type) await win.keyboard.type(k.type);
    else await win.keyboard.press(k);
  }
  const s = await lab.shown();
  tried++;
  if (!ok(s.doc, s)) failures.push({ doc, what: `still works: ${name}`, why: `text is ${JSON.stringify(s.doc)}`, before: '', after: styled(s), md: s.doc });
}

console.log(`\n${tried} edits tried, ${failures.length} broke something`);
const byOp = new Map();
for (const f of failures) {
  const op = f.what.replace(/ (at|over) \|.*$/, '');
  byOp.set(op, (byOp.get(op) ?? 0) + 1);
}
for (const [op, count] of byOp) console.log(`  ${String(count).padStart(5)}  ${op}`);
const byDoc = new Map();
for (const f of failures) byDoc.set(f.doc, [...(byDoc.get(f.doc) ?? []), f]);
for (const [doc, list] of byDoc) {
  console.log(`\n== ${doc.replace(/\n/g, '⏎')}  (${list.length})`);
  for (const f of list.slice(0, process.env.ALL ? 999 : 6)) {
    console.log(`  ${f.what}\n     ${f.why}\n     before ${f.before}\n     after  ${f.after}\n     md     ${JSON.stringify(f.md)}  (cursor at ${f.head})`);
  }
}
if (errors.length) console.log('Page errors:\n  ' + errors.slice(0, 10).join('\n  '));
await app.close();
process.exit(failures.length ? 1 : 0);
