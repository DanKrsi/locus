// Drives the real app against the test workspace and saves screenshots to test-output/.
// Usage: npm run build && node scripts/make-test-workspace.mjs && node scripts/smoke.mjs
import { _electron as electron } from 'playwright';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const out = join(repo, 'test-output');
const userData = join(out, 'user-data');
const workspace = resolve(repo, '..', 'locus-test-workspace');

await rm(out, { recursive: true, force: true });
await mkdir(userData, { recursive: true });
await writeFile(join(userData, 'settings.json'), JSON.stringify({ recentWorkspaces: [workspace], dark: 'light' }));

const app = await electron.launch({ args: [repo], env: { ...process.env, LOCUS_USER_DATA: userData } });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1500, height: 900 });
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

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
    console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`);
    await shot(`fail-${name.replace(/\W+/g, '-')}`);
  }
};

await step('workspace opens', async () => {
  await win.getByText('Bracket project').first().waitFor({ timeout: 15000 });
  await shot('workspace');
});

await step('quick open a note', async () => {
  await win.keyboard.press('Control+P');
  await win.getByPlaceholder('Find a file by name').fill('review');
  await win.locator('.tree-row', { hasText: 'review.md' }).waitFor();
  await win.keyboard.press('Enter');
  await win.locator('.cm-ref').first().waitFor({ timeout: 10000 });
  await shot('note');
});

await step('follow a PDF area reference', async () => {
  await win.locator('.cm-ref', { hasText: 'Table 5' }).click();
  await win.locator('.pdf-page canvas').first().waitFor({ timeout: 15000 });
  await win.locator('.area-box.cited').waitFor({ timeout: 10000 });
  await shot('pdf-area');
});

await step('follow a live code reference (remapped lines)', async () => {
  await win.locator('.cm-ref', { hasText: 'the backoff loop' }).click();
  await win.locator('.cm-cited-line').first().waitFor({ timeout: 10000 });
  const first = await win.locator('.code-viewer .cm-activeLineGutter').textContent();
  console.log(`     cursor gutter line: ${first?.trim()} (expected 21)`);
  await shot('code-live');
});

await step('follow a pinned code reference', async () => {
  await win.locator('.cm-ref', { hasText: 'a fixed sleep' }).click();
  await win.locator('.tab.active .badge.mark').waitFor({ timeout: 10000 });
  await shot('code-pinned');
});

await step('follow a spreadsheet named range', async () => {
  await win.locator('.cm-ref', { hasText: 'LoadTable' }).click();
  await win.locator('.cited-box').waitFor({ timeout: 15000 });
  await shot('sheet-named');
});

await step('hover card', async () => {
  // CodeMirror opens hover cards on mouse movement, so move onto the link in a few steps.
  const box = await win.locator('.cm-ref', { hasText: 'BDS-100 p5' }).boundingBox();
  await win.mouse.move(box.x - 40, box.y + box.height / 2);
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await win.locator('.hover-card').waitFor({ timeout: 5000 });
  await win.waitForTimeout(800);
  await shot('hover-card');
  await win.mouse.move(5, 500);
});

await step('broken link is marked', async () => {
  await win.locator('.cm-ref.broken', { hasText: 'old analysis' }).waitFor({ timeout: 5000 });
});

await step('cite a PDF page with the rename box', async () => {
  await win.locator('.tab', { hasText: 'BDS-100' }).click();
  // Put the cursor at the end of the note.
  await win.locator('.editor-wrap .cm-content').click();
  await win.keyboard.press('Control+End');
  await win.keyboard.type('\n\nNew citation: ');
  await win.getByRole('button', { name: /Cite (page|area)/ }).click();
  await win.locator('.cm-renaming').waitFor({ timeout: 10000 });
  await shot('rename-box');
  await win.keyboard.type('Scope section');
  await win.keyboard.press('Enter');
  await win.locator('.cm-ref', { hasText: 'Scope section' }).waitFor({ timeout: 5000 });
  await shot('cited');
});

await step('version picker and file browser', async () => {
  await win.locator('.version-pill').click();
  await win.getByRole('button', { name: /Before retry refactor/ }).click();
  await win.getByText('deleted later').first().waitFor({ timeout: 10000 }).catch(() => undefined);
  await shot('browser-old-version');
  await win.keyboard.press('Escape');
  await win.locator('.backdrop').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
});

await step('git terminology', async () => {
  await win.getByTitle('Settings').click();
  await win.getByText('Git', { exact: true }).click();
  await win.getByRole('button', { name: 'Done' }).click();
  await shot('git-terms');
});

await step('dark mode', async () => {
  await win.getByTitle('Settings').click();
  await win.locator('select').last().selectOption('dark');
  await win.getByRole('button', { name: 'Done' }).click();
  await shot('dark');
});

const noteText = await win.evaluate(() => window.api.readText('/notes/review.md'));
const citedLine = noteText.split('\n').find((l) => l.includes('Scope section'));
console.log('     inserted:', citedLine);
if (errors.length) console.log('Console errors:\n  ' + errors.slice(0, 10).join('\n  '));
await app.close();
