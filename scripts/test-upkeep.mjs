// Drives the real app through the link check that follows Save version: the summary, updating
// links that only moved, reviewing one that changed, Undo, and keeping a link on its old version.
// Usage: npm run build && node scripts/make-test-workspace.mjs && node scripts/test-upkeep.mjs
import { _electron as electron } from 'playwright';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const out = join(repo, 'test-output', 'upkeep');
const userData = join(out, 'user-data');
const workspace = resolve(repo, '..', 'locus-test-workspace');

await rm(out, { recursive: true, force: true });
await mkdir(userData, { recursive: true });
await writeFile(join(userData, 'settings.json'), JSON.stringify({ claudeOffered: 'skip', recentWorkspaces: [workspace], dark: 'light' }));

const app = await electron.launch({ args: [repo], env: { ...process.env, LOCUS_USER_DATA: userData } });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1500, height: 900 });
let failures = 0;
let n = 0;
const shot = async (name) => {
  await win.waitForTimeout(400);
  await win.screenshot({ path: join(out, `${String(++n).padStart(2, '0')}-${name}.png`) });
};
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${process.env.VERBOSE ? e.message.slice(0, 1500) : e.message.split('\n')[0]}`);
    await shot(`fail-${name.replace(/\W+/g, '-')}`).catch(() => undefined);
  }
};
win.on('pageerror', (e) => console.log('     PAGE ERROR:', String(e).split('\n')[0]));
win.on('console', (m) => m.type() === 'error' && console.log('     CONSOLE:', m.text().slice(0, 200)));
const api = (m, ...a) => win.evaluate(([m, a]) => window.api[m](...a), [m, a]);
const note = () => api('readText', '/notes/review.md');
const link = (text, label) => text.match(new RegExp(`\\[${label.replace(/[()]/g, '\\$&')}\\]\\(([^) ]+)`))?.[1];

let before = '';
let head = '';

await step('opens the note', async () => {
  await win.getByText('Bracket project').first().waitFor({ timeout: 15000 });
  await win.keyboard.press('Control+O');
  await win.getByPlaceholder('Find a file by name').fill('review');
  await win.locator('.tree-row', { hasText: 'review.md' }).waitFor();
  await win.keyboard.press('Enter');
  await win.locator('.open-choice').waitFor({ timeout: 5000 });
  await win.keyboard.press('e');
  await win.locator('.editor-wrap .cm-ref').first().waitFor({ timeout: 10000 });
  before = await note();
  head = (await api('head')).slice(0, 10);
});

await step('Save version with nothing new still offers links left behind', async () => {
  await win.keyboard.press('Control+Shift+S');
  const dlg = win.locator('.upkeep-summary');
  await dlg.waitFor({ timeout: 15000 });
  const text = await dlg.innerText();
  if (!/1 link can follow by itself/.test(text)) throw new Error(`summary: ${text}`);
  if (!/1 link cites something that changed/.test(text)) throw new Error(`summary: ${text}`);
  await shot('summary');
  // Nothing is the default: Enter does nothing.
  await win.keyboard.press('Enter');
  await win.waitForTimeout(300);
  if (!(await dlg.isVisible())) throw new Error('Enter answered the summary');
});

await step('update the one that moved, review the one that changed', async () => {
  await win.getByRole('button', { name: 'Update the 1 and review the rest' }).click();
  const bar = win.locator('.review-bar');
  await bar.waitFor({ timeout: 10000 });
  const text = await bar.innerText();
  if (!/Link 1 of 1/.test(text) || !/the backoff loop/.test(text) || !/lines were edited/.test(text)) throw new Error(`bar: ${text}`);
  // Cited and latest versions are side by side on the right.
  await win.locator('[data-pane="docs"] .viewer:not(.hidden) .compare-wrap').waitFor({ timeout: 15000 });
  if ((await win.getByLabel('First line').inputValue()) !== '21') throw new Error(`proposed first line ${await win.getByLabel('First line').inputValue()}`);
  await shot('review');
  await bar.getByRole('button', { name: 'Update the link' }).click();
  await win.locator('.notice', { hasText: 'Updated 2 links' }).waitFor({ timeout: 15000 });
  if (await win.locator('.review-bar').count()) throw new Error('the review bar stayed');
  const now = await note();
  if (link(now, 'backoff()') !== `/src/net/client.py#L15-L18&at=${head}`) throw new Error(`backoff(): ${link(now, 'backoff()')}`);
  if (!new RegExp(`^/src/net/client\\.py#L21-L\\d+&at=${head}$`).test(link(now, 'the backoff loop'))) throw new Error(`loop: ${link(now, 'the backoff loop')}`);
  // The quote and the rest of the note are untouched.
  if (!now.includes(`&at=${head} "def fetch(url):")`)) throw new Error('the quote was lost');
  const versions = await api('versions');
  if (!/^Automatic version \(updated 2 links\)$/.test(versions[0].message)) throw new Error(`latest version: ${versions[0].message}`);
  // The open note shows the rewritten links without being marked unsaved.
  if (await win.locator('[data-pane="notes"] .tab.active .dot').count()) throw new Error('the note is marked unsaved');
});

await step('Undo puts the note back', async () => {
  await win.locator('.notice').getByRole('button', { name: 'Undo' }).click();
  await win.getByText('Links put back as they were').waitFor({ timeout: 10000 });
  if ((await note()) !== before) throw new Error('the note is not as it was');
  if ((await api('uncommitted')).length) throw new Error('the undo was not saved in a version');
});

await step('one by one: keep a link on its old version, then stop', async () => {
  await win.keyboard.press('Control+Shift+S');
  await win.locator('.upkeep-summary').waitFor({ timeout: 15000 });
  await win.getByRole('button', { name: 'Go through them one by one' }).click();
  const bar = win.locator('.review-bar');
  await bar.waitFor({ timeout: 10000 });
  if (!/Link 1 of 2/.test(await bar.innerText())) throw new Error(await bar.innerText());
  const first = /the backoff loop/.test(await bar.innerText()) ? 'the backoff loop' : 'backoff()';
  await bar.getByRole('button', { name: 'Keep the old version' }).click();
  await win.waitForFunction(() => /Link 2 of 2/.test(document.querySelector('.review-bar')?.textContent ?? ''), null, { timeout: 10000 });
  await bar.getByRole('button', { name: 'Stop reviewing' }).click();
  await win.locator('.notice', { hasText: 'Updated 1 link.' }).waitFor({ timeout: 15000 });
  const now = await note();
  const other = first === 'backoff()' ? 'the backoff loop' : 'backoff()';
  if (link(now, first) !== link(before, first).replace('&at=', '&rev=')) throw new Error(`${first}: ${link(now, first)}`);
  if (link(now, other) !== link(before, other)) throw new Error(`${other} changed: ${link(now, other)}`);
  // Only the review tabs were opened, and they are closed again.
  if (await win.locator('[data-pane="docs"] .tabs > .tab').count()) throw new Error('a review tab was left open');
});

await step('a pinned link is not asked about again; the one left over just follows', async () => {
  await win.locator('.notice .icon').click();
  await win.keyboard.press('Control+Shift+S');
  // Nothing to decide any more: the link that can follow is updated, with Undo, and no dialog.
  await win.locator('.notice', { hasText: 'Updated 1 link' }).waitFor({ timeout: 20000 });
  if (await win.locator('.upkeep-summary').count()) throw new Error('a summary asked about a link that could follow by itself');
  const text = await note();
  if (!/a fixed sleep\]\([^)]*&rev=/.test(text)) throw new Error('the pinned link lost its version');
  await win.locator('.notice .icon').click();
});

const openNote = async (name) => {
  // A notice in the way would cover the Open dialog.
  await win.locator('.notice .icon').click({ timeout: 2000 }).catch(() => undefined);
  await win.locator('.notice').waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined);
  await win.keyboard.press('Control+O');
  await win.getByPlaceholder('Find a file by name').fill(name);
  await win.locator('.tree-row', { hasText: name }).first().waitFor();
  await win.keyboard.press('Enter');
  await win.locator('.open-choice').waitFor({ timeout: 5000 });
  // Click rather than press "e": the dialog ignores keys for a turn, so a fast key is lost.
  await win.locator('.open-choice').getByText('Edit', { exact: true }).click();
  await win.locator('[data-pane="notes"] .tab.active', { hasText: name }).waitFor({ timeout: 10000 });
};

await step('a note that is linked to gets a hidden identity that survives editing', async () => {
  await win.locator('[data-pane="notes"] .tabs > .tab', { hasText: 'review.md' }).click({ button: 'right' });
  await win.locator('.context-menu').getByRole('menuitem', { name: 'Copy link to this note' }).click();
  await win.waitForFunction(() => window.api.readText('/notes/review.md').then((t) => /<!-- locus-id: [a-z0-9]{12} -->\r?\n?$/.test(t)), null, { timeout: 5000 });
  if (/locus-id/.test(await win.locator('.editor-wrap .cm-content').first().innerText())) throw new Error('the identity shows in the editor');
  const id = (await note()).match(/locus-id: ([a-z0-9]{12})/)[1];
  await win.locator('.editor-wrap .cm-content').first().click();
  await win.keyboard.press('Control+End');
  await win.keyboard.type(' more');
  await win.keyboard.press('Control+S');
  await win.waitForFunction(() => window.api.readText('/notes/review.md').then((t) => / more/.test(t)), null, { timeout: 5000 });
  const text = await note();
  if (!new RegExp(`more\r?\n<!-- locus-id: ${id} -->\r?\n?$`).test(text)) throw new Error(`identity lost or moved: ${JSON.stringify(text.slice(-80))}`);
});

await step('a link finds its note after the note is renamed outside the app', async () => {
  const id = await api('ensureNoteId', '/notes/design-basis.md');
  await api('writeText', '/notes/pointer.md', `# Pointer\n\nSee [the basis](/notes/design-basis.md#id=${id}).\n`);
  await rename(join(workspace, 'notes', 'design-basis.md'), join(workspace, 'notes', 'basis-renamed.md'));
  await openNote('pointer.md');
  const ref = win.locator('.editor-wrap .cm-ref', { hasText: 'the basis' });
  await ref.waitFor({ timeout: 10000 });
  await win.waitForTimeout(800);
  if (await win.locator('.editor-wrap .cm-ref.broken', { hasText: 'the basis' }).count()) throw new Error('the link is drawn as broken');
  await ref.click();
  await win.locator('[data-pane="notes"] .tab.active', { hasText: 'basis-renamed.md' }).waitFor({ timeout: 10000 });
});

await step('a cited file that moves is still read at the version it was cited from', async () => {
  // Moving a file rewrites the links to its new name, but they still point at a version from
  // before the move, where only the old name existed.
  const head = (await api('versions'))[0].sha.slice(0, 10);
  await api('writeText', '/notes/moved.md', `# Moved\n\nSee [the solver](/src/solver.py#L1-L2&at=${head}).\n`);
  const r = await api('renameFile', '/src/solver.py', '/src/core/solver.py');
  if (r.links < 1) throw new Error('the link was not rewritten to the new name');
  const dest = (await api('readText', '/notes/moved.md')).match(/\]\(([^)]+)\)/)[1];
  if (!dest.startsWith('/src/core/solver.py')) throw new Error(`link says ${dest}`);

  const was = await api('readText', '/src/core/solver.py', head);
  if (!was || !was.includes('def ')) throw new Error('the cited version could not be read under the new name');
  if (!(await api('exists', '/src/core/solver.py', head))) throw new Error('the cited version is reported missing');
  if (await api('fileChangedSince', '/src/core/solver.py', head)) throw new Error('a move alone is reported as a change');
  if ((await api('diffHunks', '/src/core/solver.py', head)).length) throw new Error('a move alone shows as edited lines');
});

await step('a moved file opens from its link without claiming it changed', async () => {
  await openNote('moved.md');
  await win.locator('.editor-wrap .cm-ref', { hasText: 'the solver' }).first().click();
  await win.locator('[data-pane="docs"] .tab.active', { hasText: 'solver.py' }).waitFor({ timeout: 10000 });
  await win.waitForTimeout(600);
  const notice = await win.locator('.notice', { hasText: 'cited' }).count();
  if (notice) throw new Error('a file that only moved is reported as changed since it was cited');
  await shot('moved-file-link');
  // Put it back, links and all, so the steps after this one find the file where they left it.
  await api('renameFile', '/src/core/solver.py', '/src/solver.py');
  if (!(await api('readText', '/notes/moved.md')).includes('(/src/solver.py#L1-L2')) throw new Error('moving it back did not bring the link back');
});

await step('Record: links made by hand get a version written into them', async () => {
  await api('writeText', '/notes/byhand.md', '# By hand\n\nSee [the solver](/src/solver.py#L1-L2).\n');
  await openNote('byhand.md');
  const notice = win.locator('.notice', { hasText: "doesn't record a version" });
  await notice.waitFor({ timeout: 10000 });
  // The banner says what Record will do, and can point at the link it means.
  await notice.locator('.notice-help', { hasText: 'Record writes' }).waitFor({ timeout: 5000 });
  await notice.getByRole('button', { name: 'Show me' }).click();
  await win.locator('.editor-wrap .cm-flash').first().waitFor({ timeout: 5000 });
  await shot('record-banner');
  await notice.waitFor({ timeout: 2000 }); // showing is not answering: the banner stays
  await notice.getByRole('button', { name: 'Record' }).click();
  await win.keyboard.press('Control+S');
  await win.waitForFunction(() => window.api.readText('/notes/byhand.md').then((t) => /solver\.py#L1-L2&at=[0-9a-f]{10}\)/.test(t)), null, { timeout: 10000 });
});

await step('a link to a deleted file still opens the version it cites, and is not drawn broken', async () => {
  const head = (await api('versions'))[0].sha.slice(0, 10);
  await api('writeText', '/notes/gone.md', `# Gone\n\nSee [the client](/src/net/client.py#L1-L3&at=${head}).\n`);
  await openNote('gone.md');
  await rm(join(workspace, 'src', 'net', 'client.py'));
  await win.evaluate(() => window.dispatchEvent(new Event('focus')));
  await win.waitForTimeout(2500);
  const ref = win.locator('.editor-wrap .cm-ref', { hasText: 'the client' }).first();
  await ref.waitFor({ timeout: 10000 });
  // The check behind the mark is asynchronous; it redraws the link when it knows.
  await win.locator('.editor-wrap .cm-ref.gone', { hasText: 'the client' }).first().waitFor({ timeout: 15000 });
  const classes = await ref.evaluate((el) => el.className);
  if (/broken/.test(classes)) throw new Error('a link whose cited version is still readable is drawn broken');
  await ref.click();
  await win.locator('[data-pane="docs"] .tab.active', { hasText: 'client.py' }).waitFor({ timeout: 10000 });
  const notice = await win.locator('.notice').first().innerText().catch(() => '');
  if (!/no longer in the workspace/i.test(notice)) throw new Error(`expected a word about the deleted file, got "${notice.trim()}"`);
  await shot('deleted-file-link');
});

await step('a file renamed and then rewritten is still readable at the version it was cited from', async () => {
  const head = (await api('versions'))[0].sha.slice(0, 10);
  await api('writeText', '/notes/twice.md', `# Twice\n\nSee [the solver](/src/solver.py#L1-L2&at=${head}).\n`);
  const before = (await api('versions')).length;
  await api('renameFile', '/src/solver.py', '/src/engine/solver.py');
  const versions = await api('versions');
  if (versions.length !== before + 1) throw new Error('the move was not recorded as a version of its own');
  if (!/moved src\/solver\.py to src\/engine\/solver\.py/.test(versions[0].message)) throw new Error(`version says: ${versions[0].message}`);
  // Now rewrite it completely, so the two versions no longer look like the same file.
  await api('writeText', '/src/engine/solver.py', '# rewritten\n' + 'x = 1\n'.repeat(60));
  await api('saveVersion', 'Rewrote the solver');
  const was = await api('readText', '/src/engine/solver.py', head);
  if (!was.includes('def ')) throw new Error('the cited version could not be read once the file was rewritten');
  if (!(await api('exists', '/src/engine/solver.py', head))) throw new Error('the cited version is reported missing');
});

await app.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
