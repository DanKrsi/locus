// Drives the real app through the link check that follows Save version: the summary, updating
// links that only moved, reviewing one that changed, Undo, and keeping a link on its old version.
// Usage: npm run build && node scripts/make-test-workspace.mjs && node scripts/test-upkeep.mjs
import { _electron as electron } from 'playwright';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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

await step('a pinned link is not asked about again; the other still is', async () => {
  await win.locator('.notice .icon').click();
  await win.keyboard.press('Control+Shift+S');
  const dlg = win.locator('.upkeep-summary');
  await dlg.waitFor({ timeout: 15000 });
  const text = await dlg.innerText();
  if ((text.match(/\b1 link\b/g) ?? []).length !== 1) throw new Error(`summary: ${text}`);
  await win.getByRole('button', { name: 'Not now' }).click();
});

await app.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
