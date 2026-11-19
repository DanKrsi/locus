// A note changed outside Locus (by Claude, say) while it has unsaved changes: Locus never writes
// over the file. Autosave pauses, a bar says what happened, and the user merges, keeps theirs or
// takes the file's. Typing alone never raises the bar, a note whose identity line has no line break
// before it saves normally, and a waiting note can't be closed, pushed out by the tab limit, or
// saved with Ctrl+S.
//
//   npm run build && node scripts/make-test-workspace.mjs && node scripts/test-outside-edits.mjs
import { _electron as electron } from 'playwright';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(repo, 'test-output-outside-edits');
const userData = join(out, 'user-data');
const workspace = resolve(repo, '..', 'locus-test-workspace');
await rm(out, { recursive: true, force: true });
await mkdir(userData, { recursive: true });
await writeFile(
  join(userData, 'settings.json'),
  JSON.stringify({ claudeOffered: 'skip', recentWorkspaces: [workspace], dark: 'light', autosave: true, editorTabLimit: 2 }),
);

const dir = join(workspace, 'notes', 'outside');
await mkdir(dir, { recursive: true });
const file = (name) => join(dir, name);
const BASE = '# Outside test\n\nalpha\nbeta\ngamma\ndelta\n';
await writeFile(file('a.md'), BASE);
await writeFile(file('b.md'), '# B\n\nbee\n');
await writeFile(file('c.md'), '# C\n\nsea\n');
// A note with an identity and no line break before it (as joinNoteId writes one).
await writeFile(file('id.md'), '# Id test\n\nline one\nline two\n<!-- locus-id: abcdefghijkl -->\n');

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

const disk = (name) => readFile(file(name), 'utf8');
const editor = () => win.locator('[data-pane="notes"] .editor-wrap:visible');
const noteText = () =>
  win.evaluate(() => {
    const w = [...document.querySelectorAll('[data-pane="notes"] .editor-wrap')].find((e) => e.style.display !== 'none');
    return w ? [...w.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\n') : '';
  });
const bar = () => win.locator('.conflict-notice');
const barShows = async (timeout = 6000) => {
  try {
    await bar().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
};
const toast = () => win.evaluate(() => document.querySelector('.toast')?.textContent ?? '');
const open = async (name) => {
  await win.keyboard.press('Control+O');
  await win.getByPlaceholder('Find a file by name').fill(`outside/${name}`);
  await win.locator('.tree-row', { hasText: name }).first().waitFor();
  await win.keyboard.press('Enter');
  await editor().locator('.cm-line').first().waitFor({ timeout: 10000 });
  await win.waitForTimeout(300);
};
/** Clicks the end of the line holding `text` and types there. */
const typeAt = async (text, typed) => {
  await editor().locator('.cm-line', { hasText: text }).first().click();
  await win.keyboard.press('End');
  await win.keyboard.type(typed);
};
const tab = (name) => win.locator('[data-pane="notes"] .tab', { hasText: name });

try {
  await win.getByText('Bracket project').first().waitFor({ timeout: 15000 });

  // Typing alone, through several autosaves, never raises the bar.
  await open('a.md');
  for (const ch of ' typing') {
    await typeAt('alpha', ch);
    await win.waitForTimeout(450);
  }
  await win.waitForTimeout(1500);
  check((await bar().count()) === 0 && (await disk('a.md')).includes('alpha typing'), 'typing through several autosaves saves without raising the bar');
  await writeFile(file('a.md'), BASE);
  await win.waitForTimeout(1500);
  check((await noteText()).includes('alpha') && !(await noteText()).includes('typing'), 'a note without unsaved changes shows an outside edit at once');

  // Different lines changed on each side: autosave pauses, and Merge keeps both.
  await typeAt('alpha', ' (mine)');
  await writeFile(file('a.md'), BASE.replace('delta', 'delta (theirs)'));
  check(await barShows(), 'an outside write to a note with unsaved changes raises the bar');
  await win.waitForTimeout(2500);
  let text = await disk('a.md');
  check(text.includes('delta (theirs)') && !text.includes('(mine)'), 'autosave does not write over the outside change');
  check((await tab('a.md').locator('.dot.conflict').count()) === 1, 'the tab is marked');
  check((await bar().getByRole('button', { name: 'Merge' }).count()) === 1, 'Merge is offered when the changes are to different lines');
  await win.screenshot({ path: join(out, 'bar.png') });
  await typeAt('alpha', ' more');
  await win.waitForTimeout(2000);
  check(!(await disk('a.md')).includes('(mine)'), 'typing more while the bar shows still saves nothing');
  await win.keyboard.press('Control+S');
  await win.waitForTimeout(400);
  check(/changed outside Locus/.test(await toast()) && !(await disk('a.md')).includes('(mine)'), 'Ctrl+S says why and saves nothing');
  // A second outside write while the bar shows is merged too.
  await writeFile(file('a.md'), BASE.replace('delta', 'delta (theirs)').replace('gamma', 'gamma (theirs 2)'));
  await win.waitForTimeout(1500);
  await bar().getByRole('button', { name: 'Merge' }).click();
  await win.waitForTimeout(800);
  text = await disk('a.md');
  check(
    text.includes('alpha (mine) more') && text.includes('gamma (theirs 2)') && text.includes('delta (theirs)'),
    'Merge saves both sides, including a later outside write',
  );
  check((await bar().count()) === 0 && (await tab('a.md').locator('.dot').count()) === 0, 'the bar and the mark go, and the note is saved');
  check((await noteText()).includes('gamma (theirs 2)'), 'the merged text is on screen');
  const merged = text;

  // The same line changed on both sides: no Merge; Keep mine writes what is on screen.
  await typeAt('beta', ' mine');
  await writeFile(file('a.md'), merged.replace('beta', 'beta theirs'));
  check(await barShows(), 'a clash on the same line raises the bar');
  check((await bar().getByRole('button', { name: 'Merge' }).count()) === 0 && /same lines/.test(await bar().textContent()), "it says the changes can't be merged and offers no Merge");
  await bar().getByRole('button', { name: 'Keep mine' }).click();
  await win.waitForTimeout(800);
  text = await disk('a.md');
  check(text.includes('beta mine') && !text.includes('beta theirs') && (await bar().count()) === 0, 'Keep mine writes what is on screen over the file');

  // Use the file's drops the unsaved changes, and Ctrl+Z brings them back.
  await typeAt('beta mine', ' again');
  await writeFile(file('a.md'), text.replace('beta mine', 'beta from the file'));
  check(await barShows(), 'another clash raises the bar');
  await bar().getByRole('button', { name: "Use the file's" }).click();
  await win.waitForTimeout(500);
  check((await noteText()).includes('beta from the file') && !(await noteText()).includes('again'), "Use the file's shows the file");
  check((await bar().count()) === 0 && (await tab('a.md').locator('.dot').count()) === 0, 'with nothing unsaved');
  await editor().locator('.cm-content').focus();
  await win.keyboard.press('Control+Z');
  await win.waitForTimeout(300);
  check((await noteText()).includes('beta mine again'), 'Ctrl+Z brings the dropped changes back');
  await win.waitForTimeout(1800);
  check((await disk('a.md')).includes('beta mine again'), '…and they save as usual');

  // A waiting note can't be closed, and the tab limit leaves it open.
  await typeAt('gamma', ' wait');
  await writeFile(file('a.md'), (await disk('a.md')).replace('delta', 'delta outside'));
  check(await barShows(), 'a clash for the close checks');
  await tab('a.md').click({ button: 'right' });
  await win.locator('.context-menu .menu-item', { hasText: /^Close$/ }).click();
  await win.waitForTimeout(500);
  check((await tab('a.md').count()) === 1 && /stays open/.test(await toast()), 'Close keeps a waiting note open and says why');
  await open('b.md');
  await open('c.md');
  await win.waitForTimeout(600);
  check((await tab('a.md').count()) === 1, 'the tab limit (2) does not close a waiting note');
  check((await tab('b.md').count()) === 0, '…it closes another one instead');
  await tab('a.md').click();
  check(await barShows(2000), 'the bar shows again on going back to the note');
  check(!(await disk('a.md')).includes('gamma wait'), 'nothing was written meanwhile');
  await bar().getByRole('button', { name: 'Merge' }).click();
  await win.waitForTimeout(800);
  text = await disk('a.md');
  check(text.includes('gamma (theirs 2) wait') && text.includes('delta outside'), 'Merge after switching tabs keeps both');

  // Typing back to exactly what the file now says settles it.
  await open('c.md');
  await typeAt('sea', ' x');
  await writeFile(file('c.md'), '# C\n\nsea xy\n');
  check(await barShows(), 'a clash on c.md');
  await typeAt('sea x', 'y');
  await win.waitForTimeout(900);
  check((await bar().count()) === 0 && (await tab('c.md').locator('.dot').count()) === 0, 'typing what the file now says settles it without asking');

  // A note with an identity line: saves as usual, no bar, and keeps the identity.
  await open('id.md');
  await typeAt('line two', ' edited');
  await win.waitForTimeout(2000);
  text = await disk('id.md');
  check((await bar().count()) === 0 && text.includes('line two edited') && text.includes('locus-id: abcdefghijkl'), 'a note with an identity line saves without a false alarm and keeps it');
  await typeAt('line two edited', ' twice');
  await win.waitForTimeout(2000);
  check((await bar().count()) === 0 && (await disk('id.md')).includes('edited twice'), '…and again');

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} catch (e) {
  failures++;
  console.log('FAIL', e);
  await win.screenshot({ path: join(out, 'failure.png') }).catch(() => undefined);
} finally {
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
