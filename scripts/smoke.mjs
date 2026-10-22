// Drives the real app against the test workspace and saves screenshots to test-output/.
// Usage: npm run build && node scripts/make-test-workspace.mjs && node scripts/smoke.mjs
import { _electron as electron } from 'playwright';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
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
    console.log(`FAIL ${name}: ${process.env.VERBOSE ? e.message.slice(0, 1500) : e.message.split('\n')[0]}`);
    await shot(`fail-${name.replace(/\W+/g, '-')}`);
  }
};

await step('workspace opens', async () => {
  await win.getByText('Bracket project').first().waitFor({ timeout: 15000 });
  await shot('workspace');
});

await step('quick open a note', async () => {
  await win.keyboard.press('Control+O');
  await win.getByPlaceholder('Find a note by name').fill('review');
  await win.locator('.tree-row', { hasText: 'review.md' }).waitFor();
  await win.keyboard.press('Enter');
  await win.locator('.cm-ref').first().waitFor({ timeout: 10000 });
  await shot('note');
});

await step('markdown tables render as tables', async () => {
  await win.locator('.cm-md-table table').waitFor({ timeout: 5000 });
});

await step('Open note lists notes only and opens on the left', async () => {
  await win.getByRole('button', { name: 'Open note' }).first().click();
  await win.locator('.dialog h2', { hasText: 'Open note' }).waitFor();
  if (await win.locator('.tree-row', { hasText: '.pdf' }).count()) throw new Error('PDFs listed in Open note');
  await win.keyboard.press('Escape');
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
  const first = await win.locator('.code-viewer .cm-lineNumbers .cm-activeLineGutter').textContent();
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

await step('cited-in markers and list', async () => {
  await win.locator('.cm-ref', { hasText: 'the backoff loop' }).click();
  await win.locator('.code-viewer .cm-cite-mark').first().waitFor({ timeout: 10000 });
  // Live links were cited at L12 and L18; after later edits their lines are 15 and 21.
  const markedLines = await win.evaluate(() => {
    const viewer = [...document.querySelectorAll('.viewer:not(.hidden) .code-viewer')].find((v) => v.offsetParent);
    const numbers = [...viewer.querySelectorAll('.cm-lineNumbers .cm-gutterElement')];
    return [...viewer.querySelectorAll('.cm-cite-mark')].map((m) => {
      const top = m.closest('.cm-gutterElement').getBoundingClientRect().top;
      return numbers.find((n) => Math.abs(n.getBoundingClientRect().top - top) < 2)?.textContent;
    });
  });
  if (markedLines.join(',') !== '15,21') throw new Error(`markers on lines ${markedLines}, expected 15,21`);
  await win.locator('.viewer:not(.hidden) .strip-btn', { hasText: 'Cited in' }).click();
  await win.locator('.cite-list .menu-item').first().waitFor({ timeout: 5000 });
  await shot('cited-in');
  await win.locator('.cite-list .menu-item', { hasText: 'backoff()' }).click();
  await win.locator('.cm-flash').first().waitFor({ timeout: 5000 });
});

await step('compare a pinned reference with latest (code diff)', async () => {
  const box = await win.locator('.cm-ref', { hasText: 'a fixed sleep' }).boundingBox();
  await win.mouse.move(box.x - 40, box.y + box.height / 2);
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
  await win.getByRole('button', { name: 'Compare with latest' }).click();
  await win.locator('.cm-mergeView').waitFor({ timeout: 10000 });
  await win.locator('.cm-changedLine').first().waitFor({ timeout: 5000 });
  await shot('compare-code');
  await win.mouse.move(5, 500);
});

await step('compare two PDF versions side by side', async () => {
  await win.locator('.cm-ref', { hasText: 'Table 5' }).click();
  await win.locator('.tab.active', { hasText: 'BDS-100' }).waitFor({ timeout: 10000 });
  await win.locator('.viewer:not(.hidden) .strip-btn', { hasText: 'Compare' }).filter({ visible: true }).click();
  await win.locator('.compare-split .pdf-page').first().waitFor({ timeout: 15000 });
  await shot('compare-pdf');
  await win.getByRole('button', { name: 'Stop comparing' }).click();
});

await step('tour mode', async () => {
  await win.getByRole('button', { name: 'Tour' }).click();
  await win.locator('.tour-bar', { hasText: 'stop 1 of' }).waitFor({ timeout: 5000 });
  await win.keyboard.press('ArrowRight');
  await win.keyboard.press('ArrowRight');
  await win.locator('.tour-bar', { hasText: 'stop 3 of' }).waitFor({ timeout: 5000 });
  await win.locator('.cm-ref.active').waitFor({ timeout: 5000 });
  await shot('tour');
  await win.keyboard.press('Escape');
  await win.locator('.tour-bar').waitFor({ state: 'detached', timeout: 5000 });
});

await step('rename a file in the app updates live links only', async () => {
  await win.keyboard.press('Control+P');
  await win.getByPlaceholder('Find a file by name').fill('client.py');
  const row = win.locator('.tree-row', { hasText: 'client.py' }).first();
  await row.hover();
  await row.locator('.row-action').click();
  await win.locator('input.rename').fill('src/http/client.py');
  await win.locator('input.rename').press('Enter');
  await win.locator('.toast', { hasText: 'Updated' }).waitFor({ timeout: 10000 });
  await win.keyboard.press('Escape');
  const text = await win.evaluate(() => window.api.readText('/notes/review.md'));
  if (!text.includes('[the backoff loop](/src/http/client.py#')) throw new Error('live link not updated');
  if (!text.includes('[a fixed sleep](/src/net/client.py#')) throw new Error('pinned link should keep its path');
});

await step('file moved outside the app offers Fix links', async () => {
  await mkdir(join(workspace, 'data', 'archive'), { recursive: true });
  await rename(join(workspace, 'data', 'Bracket loads.xlsx'), join(workspace, 'data', 'archive', 'Bracket loads.xlsx'));
  await win.evaluate(() => window.dispatchEvent(new Event('focus')));
  await win.locator('.notice', { hasText: 'moved' }).waitFor({ timeout: 15000 });
  await shot('fix-links');
  await win.getByRole('button', { name: 'Fix links' }).click();
  await win.locator('.toast', { hasText: 'Fixed' }).waitFor({ timeout: 5000 });
  await win.waitForTimeout(1500);
  const text = await win.evaluate(() => window.api.readText('/notes/review.md'));
  if (!text.includes('/data/archive/Bracket loads.xlsx#LoadTable')) throw new Error('link not fixed');
});

await step('history: what changed, open a file as it was, browse a version', async () => {
  await win.locator('.header').getByRole('button', { name: 'History' }).click();
  await win.locator('.history-item', { hasText: 'Retry refactor: exponential' }).click();
  await win.locator('.history-detail .tree-row', { hasText: 'sleep_util.py' }).waitFor({ timeout: 10000 });
  await win.locator('.history-detail .tree-row', { hasText: 'client.py' }).waitFor();
  await shot('history');
  await win.locator('.history-detail .tree-row', { hasText: 'client.py' }).click();
  await win.locator('.tab.active .badge.mark').waitFor({ timeout: 10000 });
  await win.locator('.header').getByRole('button', { name: 'History' }).click();
  await win.locator('.history-item', { hasText: 'Before retry refactor' }).click();
  await win.getByRole('button', { name: 'Browse all files from this version' }).click();
  await win.getByText('deleted later').first().waitFor({ timeout: 10000 });
  await shot('browser-old-version');
  await win.keyboard.press('Escape');
  // Opening the browser again starts at the latest version.
  await win.keyboard.press('Control+P');
  const shown = await win.locator('.dialog select').inputValue();
  if (shown !== '') throw new Error('file browser should reset to the latest version');
  await win.keyboard.press('Escape');
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
