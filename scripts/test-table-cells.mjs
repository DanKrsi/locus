// Editing a cell of a populated table: the cell keeps its width, long text wraps inside it, and the
// table never grows past the note.
//
//   npm run build && node scripts/make-test-workspace.mjs && node scripts/test-table-cells.mjs
import { _electron as electron } from 'playwright';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(repo, 'test-output-table');
const userData = join(out, 'user-data');
const workspace = resolve(repo, '..', 'locus-test-workspace');
await rm(out, { recursive: true, force: true });
await mkdir(userData, { recursive: true });
await writeFile(join(userData, 'settings.json'), JSON.stringify({ claudeOffered: 'skip', recentWorkspaces: [workspace], dark: 'light' }));

const note = 'table-cells';
const long = 'This cell has a long explanation that wraps over several lines in the table, as notes written by Claude often do, with **bold** and `code` in it';
const text = [
  '# Table cells',
  '',
  'A populated table:',
  '',
  '| Check | Finding | Status |',
  '| --- | --- | --- |',
  `| Retry cap | ${long}. | Open |`,
  `| Jitter | Short | ${long} too. |`,
  '| Logging | [BDS-100 p5](</docs/BDS-100 Bracket Design Standard.pdf#page=5>) is cited here | Done |',
  '',
  'After the table.',
  '',
].join('\n');
await writeFile(join(workspace, 'notes', `${note}.md`), text);

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

const app = await electron.launch({ args: [repo], env: { ...process.env, LOCUS_USER_DATA: userData } });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1500, height: 900 });
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));

/** The cell's box, the table's, the note's text column, and whether anything scrolls sideways. */
const measure = (row, col) =>
  win.evaluate(
    ([row, col]) => {
      const wrap = document.querySelector('[data-pane="notes"] .cm-md-table');
      const td = wrap.querySelector(`[data-row="${row}"][data-col="${col}"]`);
      const content = document.querySelector('[data-pane="notes"] .cm-content');
      const scroller = document.querySelector('[data-pane="notes"] .cm-scroller');
      const r = td.getBoundingClientRect();
      const t = wrap.querySelector('table').getBoundingClientRect();
      const c = content.getBoundingClientRect();
      return {
        width: Math.round(r.width),
        tableRight: Math.round(t.right),
        noteRight: Math.round(c.right),
        tableScrolls: wrap.scrollWidth > wrap.clientWidth + 1,
        noteScrolls: scroller.scrollWidth > scroller.clientWidth + 1,
      };
    },
    [row, col],
  );

try {
  await win.getByText('Bracket project').first().waitFor({ timeout: 15000 });
  await win.keyboard.press('Control+O');
  await win.getByPlaceholder('Find a file by name').fill(note);
  await win.locator('.tree-row', { hasText: `${note}.md` }).first().waitFor();
  await win.keyboard.press('Enter');
  const table = win.locator('[data-pane="notes"] .cm-md-table');
  await table.waitFor({ timeout: 10000 });
  await win.waitForTimeout(500);

  const cells = [
    [1, 1, 'long finding'],
    [2, 2, 'long status'],
    [1, 0, 'short check'],
    [3, 1, 'cell with a link'],
  ];
  for (const [row, col, what] of cells) {
    const before = await measure(row, col);
    // Click the cell's text but not a link in it.
    const td = table.locator(`[data-row="${row}"][data-col="${col}"]`);
    const box = await td.boundingBox();
    await win.mouse.click(box.x + box.width - 6, box.y + 6);
    await table.locator('.editing-cell .cm-content').waitFor({ timeout: 5000 });
    await win.waitForTimeout(200);
    const editing = await measure(row, col);
    check(Math.abs(editing.width - before.width) <= 2, `${what}: the cell keeps its width when editing starts (${before.width} → ${editing.width})`);
    check(editing.tableRight <= before.noteRight + 1 && editing.noteRight === before.noteRight && !editing.tableScrolls && !editing.noteScrolls, `${what}: the table stays inside the note (${editing.tableRight} ≤ ${before.noteRight})`);
    await win.keyboard.press('Control+End');
    await win.keyboard.type(' and then a great deal more typed text so the cell has to wrap again and again without ever widening');
    await win.waitForTimeout(150);
    const typed = await measure(row, col);
    check(Math.abs(typed.width - before.width) <= 2, `${what}: typing a lot wraps instead of widening (${before.width} → ${typed.width})`);
    check(typed.tableRight <= before.noteRight + 1 && typed.noteRight === before.noteRight && !typed.tableScrolls && !typed.noteScrolls, `${what}: after typing, the table stays inside the note`);
    await win.screenshot({ path: join(out, `${what.replace(/\W+/g, '-')}.png`) });
    await win.keyboard.press('Control+Z');
    await win.keyboard.press('Escape');
    await win.waitForTimeout(150);
  }
  await win.keyboard.press('Control+S');
  await win.waitForTimeout(500);
  const saved = await readFile(join(workspace, 'notes', `${note}.md`), 'utf8');
  check(saved === text, 'undoing the typing and leaving each cell leaves the note as it was');
} catch (e) {
  check(false, String(e).split('\n')[0]);
  await win.screenshot({ path: join(out, 'error.png') }).catch(() => undefined);
}
check(errors.length === 0, `no page errors${errors.length ? ` (${errors[0]})` : ''}`);
await app.close();
await rm(join(workspace, 'notes', `${note}.md`), { force: true });
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
