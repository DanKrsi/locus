// Drives the real app against the test workspace and saves screenshots to test-output/.
// Usage: npm run build && node scripts/make-test-workspace.mjs && node scripts/smoke.mjs
import { _electron as electron } from 'playwright';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { demoFlowText } from './flow-demo.mjs';

const repo = resolve(import.meta.dirname, '..');
const out = join(repo, 'test-output');
const userData = join(out, 'user-data');
const workspace = resolve(repo, '..', 'locus-test-workspace');

await rm(out, { recursive: true, force: true });
await mkdir(userData, { recursive: true });
await writeFile(join(userData, 'settings.json'), JSON.stringify({ claudeOffered: 'skip', recentWorkspaces: [workspace], dark: 'light' }));

await writeFile(join(workspace, 'notes', 'retry-flow.canvas'), demoFlowText());
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

const reviewText = () => win.evaluate(() => window.api.readText('/notes/review.md'));
const rawTableShown = () => win.locator('.cm-line', { hasText: '| ---' }).count();

await step('edit a table cell in place, add a row and a column', async () => {
  const table = win.locator('.cm-md-table', { hasText: 'Retry cap' });
  await table.locator('td', { hasText: 'TBD' }).click();
  await table.locator('.editing-cell .cm-content').waitFor({ timeout: 5000 });
  if (await rawTableShown()) throw new Error('table markdown shown while editing a cell');
  await win.keyboard.press('Control+A');
  await win.keyboard.type('Ana');
  // Tab saves the cell and moves on; Tab from the last cell adds a row.
  await win.keyboard.press('Tab');
  await win.keyboard.type('Backoff');
  await win.keyboard.press('Escape');
  await table.locator('td', { hasText: 'Backoff' }).waitFor({ timeout: 5000 });
  await table.locator('td', { hasText: 'Ana' }).click();
  await table.getByRole('button', { name: '→ Column' }).click();
  await table.locator('.editing-cell').waitFor({ timeout: 5000 });
  await win.keyboard.type('Due');
  await table.getByRole('button', { name: '↑ Row' }).click();
  await win.keyboard.press('Escape');
  await win.keyboard.press('Control+S');
  const text = await reviewText();
  const rows = text.split('\n').filter((l) => l.startsWith('|') && !l.startsWith('| ---'));
  const want = ['| Item | Owner |  |', '| Retry cap | Dan |  |', '|  |  |  |', '| Jitter | Ana | Due |', '| Backoff |  |  |'];
  const got = rows.slice(0, 5).map((r) => r.trim());
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error('table is now:\n' + got.join('\n'));
  if (await rawTableShown()) throw new Error('table markdown shown after editing');
  await shot('table-edited');
});

await step('insert a table: it is a table straight away', async () => {
  await win.locator('.editor-wrap .cm-line').first().click();
  await win.keyboard.press('Control+End');
  await win.getByTitle('Table', { exact: true }).click();
  await win.locator('.cm-md-table .editing-cell').waitFor({ timeout: 5000 });
  if (await rawTableShown()) throw new Error('new table shown as markdown');
  await win.keyboard.type('Name');
  await win.keyboard.press('Tab');
  await win.keyboard.type('Value');
  await win.keyboard.press('Enter');
  await win.keyboard.type('42');
  await win.keyboard.press('Escape');
  await win.keyboard.press('Control+S');
  const text = await reviewText();
  if (!text.includes('| Name | Value |\n| --- | --- |\n|  | 42 |')) throw new Error('new table saved as:\n' + text.slice(text.lastIndexOf('| Name') - 2));
});

await step('Open note lists notes only and opens on the left', async () => {
  await win.getByRole('button', { name: 'Open note' }).first().click();
  await win.locator('.locus-dialog h2', { hasText: 'Open note' }).waitFor();
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

// CodeMirror opens hover cards on mouse movement, so move onto the link in a few steps; a quick
// pass sometimes doesn't settle, so move off and back once if no card shows.
const hoverLink = async (label) => {
  for (let attempt = 0; ; attempt++) {
    const box = await win.locator('.cm-ref', { hasText: label }).boundingBox();
    await win.mouse.move(box.x - 40, box.y + box.height / 2);
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
    try {
      await win.locator('.hover-card').waitFor({ timeout: 3000 });
      return;
    } catch (e) {
      if (attempt) throw e;
      await win.mouse.move(5, 500);
    }
  }
};

await step('hover card', async () => {
  await hoverLink('BDS-100 p5');
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
  await win.locator('.editor-wrap .cm-line').first().click();
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

await step('editing keeps the formatted view: link labels edit as text', async () => {
  const line = win.locator('.cm-line', { hasText: 'New citation:' });
  // The cursor is after the new link: Backspace edits its label instead of exposing the markdown.
  await win.keyboard.press('Backspace');
  await win.keyboard.press('Backspace');
  await win.keyboard.press('Backspace');
  await win.locator('.cm-ref', { hasText: /^Scope sect$/ }).waitFor({ timeout: 5000 });
  if ((await line.textContent()).includes('](')) throw new Error('link markdown showed while editing');
  // Typing at the end of the label writes after the link, not into it.
  await win.keyboard.type(' and more');
  await win.keyboard.press('Control+S');
  const saved = await win.evaluate(() => window.api.readText('/notes/review.md'));
  if (!/New citation: \[Scope sect\]\([^)]*\) and more/.test(saved)) throw new Error('typing after a link changed the link: ' + saved.split('\n').find((l) => l.includes('New citation')));
  // Clicking a heading keeps it formatted; Backspace at its start turns it into plain text.
  const heading = win.locator('.cm-line.cm-h2', { hasText: 'Loads' });
  await heading.click();
  if ((await heading.textContent()).trim() !== 'Loads') throw new Error('heading markup showed while editing');
  await win.keyboard.press('Home');
  await win.keyboard.press('Backspace');
  await win.locator('.cm-line:not(.cm-h2)', { hasText: /^Loads$/ }).waitFor({ timeout: 5000 });
  await win.keyboard.press('Control+Z');
  await win.locator('.cm-line.cm-h2', { hasText: 'Loads' }).waitFor({ timeout: 5000 });
});

await step('live or pinned: choose when citing, switch from the hover card', async () => {
  const viewer = win.locator('.viewer:not(.hidden)');
  const lineOf = async () => (await reviewText()).split('\n').find((l) => l.includes('Pinned citation:')) ?? '';
  // Pick "Pinned" in the Cite button's menu, then cite.
  await viewer.locator('.cite-more').first().click();
  await win.locator('.cite-mode-menu .menu-item', { hasText: 'Pinned' }).click();
  await viewer.locator('.cite-kind.pinned').first().waitFor({ timeout: 5000 });
  await win.locator('.editor-wrap .cm-content').first().focus();
  await win.keyboard.press('Control+End');
  await win.keyboard.type('\n\nPinned citation: ');
  await viewer.locator('.cite-split > button.cite').first().click();
  await win.locator('.cm-renaming').waitFor({ timeout: 10000 });
  await win.keyboard.type('Pinned p5');
  await win.keyboard.press('Enter');
  await win.keyboard.press('Control+S');
  if (!/&rev=[0-9a-f]{10}/.test(await lineOf())) throw new Error('not pinned: ' + (await lineOf()));
  // Back to Live for the rest of the run.
  await viewer.locator('.cite-more').first().click();
  await win.locator('.cite-mode-menu .menu-item', { hasText: 'Live' }).click();
  await viewer.locator('.cite-kind.live').first().waitFor({ timeout: 5000 });
  // The hover card turns it live, and pins it again.
  await hoverLink('Pinned p5');
  await win.locator('.hover-card .link-kind', { hasText: 'Pinned' }).waitFor({ timeout: 5000 });
  await win.locator('.hover-card').getByRole('button', { name: 'Make live' }).click();
  await win.mouse.move(5, 500);
  await win.locator('.editor-wrap .cm-content').first().focus();
  await win.keyboard.press('Control+S');
  if (!/&at=[0-9a-f]{10}/.test(await lineOf()) || /rev=/.test(await lineOf())) throw new Error('not made live: ' + (await lineOf()));
  await hoverLink('Pinned p5');
  await win.locator('.hover-card .link-kind', { hasText: 'Live' }).waitFor({ timeout: 5000 });
  await win.locator('.hover-card').getByRole('button', { name: 'Pin to this version' }).click();
  await win.mouse.move(5, 500);
  await win.locator('.editor-wrap .cm-content').first().focus();
  await win.keyboard.press('Control+S');
  if (!/&rev=[0-9a-f]{10}/.test(await lineOf())) throw new Error('not pinned again: ' + (await lineOf()));
});

await step('a live link whose file changed is marked and warns when opened', async () => {
  // Someone adds a cover page outside the app: everything moves down a page.
  const file = join(workspace, 'docs', 'BDS-100 Bracket Design Standard.pdf');
  const current = await readFile(file);
  const doc = await PDFDocument.load(current);
  doc.insertPage(0);
  await writeFile(file, await doc.save());
  try {
    await win.evaluate(() => window.dispatchEvent(new Event('focus')));
    const line = win.locator('.cm-line', { hasText: 'verification methods' });
    await line.locator('.badge.warn').nth(1).waitFor({ timeout: 15000 });
    await shot('changed-badge');
    // The quoted passage is found on its new page.
    await win.locator('.cm-ref', { hasText: 'BDS-100 p5' }).click();
    await win.locator('.notice', { hasText: 'now on page 6' }).waitFor({ timeout: 15000 });
    await shot('changed-notice');
    // An area with no quote: the app says the file changed and offers a comparison.
    await win.locator('.cm-ref', { hasText: 'Table 5' }).click();
    await win.locator('.notice', { hasText: 'changed since you cited it' }).waitFor({ timeout: 10000 });
    await win.locator('.notice').getByRole('button', { name: 'Compare' }).waitFor();
  } finally {
    await writeFile(file, current);
    await win.evaluate(() => window.dispatchEvent(new Event('focus')));
    await win.locator('.notice .icon').click().catch(() => undefined);
  }
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
  await win.locator('.cite-list .menu-item', { hasText: 'backoff()' }).filter({ hasText: 'review.md' }).click();
  await win.locator('.cm-flash').first().waitFor({ timeout: 5000 });
});

await step('compare a pinned reference with latest (code diff)', async () => {
  await hoverLink('a fixed sleep');
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
  await win.locator('.cm-link-label.active').waitFor({ timeout: 5000 });
  await shot('tour');
  await win.keyboard.press('Escape');
  await win.locator('.tour-bar').waitFor({ state: 'detached', timeout: 5000 });
});

const flowText = () => win.evaluate(() => window.api.readText('/notes/retry-flow.canvas'));
const until = async (what, test, ms = 8000) => {
  // A read can catch the file mid-save; that just means "not yet".
  for (const end = Date.now() + ms; Date.now() < end; await win.waitForTimeout(150)) if (await test().catch(() => false)) return;
  throw new Error('timed out waiting for ' + what);
};

await step('flowchart: open, add a box, connect it, cite into it', async () => {
  await win.keyboard.press('Control+O');
  await win.getByPlaceholder(/Find a note/).fill('retry-flow');
  await win.locator('.tree-row', { hasText: 'retry-flow' }).first().waitFor();
  await win.keyboard.press('Enter');
  await win.locator('.flow-box', { hasText: 'wait backoff' }).waitFor({ timeout: 10000 });
  if ((await win.locator('.flow-frame').count()) !== 2) throw new Error('loop frames missing');
  const edges0 = await win.locator('.flow-editor .react-flow__edge').count();
  // A new decision box starts with its text selected, so typing replaces it.
  await win.locator('.flow-toolbar').getByTitle('Add a decision box').click();
  await win.locator('.flow-box-editor .cm-content').waitFor({ timeout: 5000 });
  await win.keyboard.type('Done?');
  await win.keyboard.press('Escape');
  const added = win.locator('.flow-box.shape-decision', { hasText: 'Done?' });
  await added.waitFor({ timeout: 5000 });
  // Drag the new box clear of the others, then connect "return results" to it.
  const box = await added.boundingBox();
  await win.mouse.move(box.x + box.width / 2, box.y + 12);
  await win.mouse.down();
  await win.mouse.move(box.x + box.width / 2 + 260, box.y + 12, { steps: 8 });
  await win.mouse.up();
  const end = win.locator('.react-flow__node', { hasText: 'return results' });
  await end.hover();
  const a = await end.locator('.react-flow__handle-right').boundingBox();
  await added.hover();
  const b = await added.locator('.react-flow__handle-left').boundingBox();
  await win.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await win.mouse.down();
  await win.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await win.mouse.up();
  await until('the new arrow', async () => (await win.locator('.flow-editor .react-flow__edge').count()) === edges0 + 1);
  // Cite code lines into the selected box.
  await win.locator('[data-pane="docs"] .tab:not(:has(.badge))', { hasText: 'client.py' }).first().click();
  await win.locator('.viewer:not(.hidden) .code-viewer .cm-line').nth(30).click();
  await added.click();
  await win.locator('.viewer:not(.hidden) .cite-split > button.cite').first().click();
  await win.locator('.flow-box .cm-renaming').waitFor({ timeout: 5000 });
  await win.keyboard.type('the sleep');
  await win.keyboard.press('Enter');
  await win.keyboard.press('Escape');
  await win.locator('.flow-box.shape-decision .cm-ref', { hasText: 'the sleep' }).waitFor({ timeout: 5000 });
  await until('the flowchart to save', async () => /Done\?\\n\[the sleep\]\(\/src\/net\/client\.py#L31/.test(await flowText()));
  const saved = JSON.parse(await flowText());
  const node = saved.nodes.find((n) => n.text?.startsWith('Done?'));
  if (node?.shape !== 'decision') throw new Error('decision box not saved: ' + JSON.stringify(node));
  if (!saved.edges.some((e) => e.toNode === node.id && e.fromNode === 'end')) throw new Error('arrow not saved');
  await shot('flowchart');
});

await step('flowchart: arrow style, undo, and Cited in', async () => {
  try {
    // Select the "no" arrow and make it curved; undo puts it back.
    await win.locator('.flow-toolbar').getByTitle('Fit the flowchart in view').click();
    await win.waitForTimeout(500);
    const arrow = await win.locator('[data-testid="rf__edge-e4"] .react-flow__edge-interaction').boundingBox();
    await win.mouse.click(arrow.x + arrow.width * 0.25, arrow.y + arrow.height / 2);
    await win.locator('.flow-toolbar').getByTitle('Curve arrow').click();
    await until('the curved arrow to save', async () => JSON.parse(await flowText()).edges.find((e) => e.id === 'e4').route === 'curve');
    await win.locator('.flow-toolbar').getByTitle('Undo (Ctrl+Z)').click();
    await until('undo to save', async () => JSON.parse(await flowText()).edges.find((e) => e.id === 'e4').route === 'elbow');
    // The code file lists the flowchart under "Cited in"; picking it shows the box.
    await win.locator('.viewer:not(.hidden) .strip-btn', { hasText: 'Cited in' }).click();
    await win.locator('.cite-list .menu-item', { hasText: 'retry-flow.canvas' }).first().click();
    await win.locator('.flow-box.selected').first().waitFor({ timeout: 5000 });
  } finally {
    // Back to the note for the steps that follow.
    await win.locator('[data-pane="notes"] .tab', { hasText: 'review.md' }).click();
  }
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
  const flow = await flowText();
  if (!flow.includes('[client.py L26](/src/http/client.py#L26') || flow.includes('/src/net/client.py')) throw new Error('flowchart links not updated');
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
  await win.locator('.header').getByRole('button', { name: 'Open', exact: true }).click();
  await win.locator('.locus-dialog').getByRole('button', { name: 'Version history' }).click();
  await win.locator('.history-item', { hasText: 'Retry refactor: exponential' }).click();
  await win.locator('.history-detail .tree-row', { hasText: 'sleep_util.py' }).waitFor({ timeout: 10000 });
  await win.locator('.history-detail .tree-row', { hasText: 'client.py' }).waitFor();
  await shot('history');
  await win.locator('.history-detail .tree-row', { hasText: 'client.py' }).click();
  await win.locator('.tab.active .badge.mark').waitFor({ timeout: 10000 });
  await win.locator('.header').getByRole('button', { name: 'Open', exact: true }).click();
  await win.locator('.locus-dialog').getByRole('button', { name: 'Version history' }).click();
  await win.locator('.history-item', { hasText: 'Before retry refactor' }).click();
  await win.getByRole('button', { name: 'Browse all files from this version' }).click();
  await win.getByText('deleted later').first().waitFor({ timeout: 10000 });
  await shot('browser-old-version');
  // Version history from the browser opens on the version being shown; Back returns to it.
  await win.locator('.locus-dialog').getByRole('button', { name: 'Version history' }).click();
  await win.locator('.history-item.selected', { hasText: 'Before retry refactor' }).waitFor({ timeout: 5000 });
  await win.getByRole('button', { name: 'Back to files' }).click();
  await win.getByText('deleted later').first().waitFor({ timeout: 10000 });
  await win.keyboard.press('Escape');
  // Opening the browser again starts at the latest version.
  await win.keyboard.press('Control+P');
  const shown = await win.locator('.locus-dialog select').inputValue();
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
  const mode = (m) => win.waitForFunction((m) => document.documentElement.dataset.mode === m, m, { timeout: 5000 });
  await win.getByTitle('Switch to dark mode').click();
  await mode('dark');
  await win.getByTitle('Settings').click();
  await win.getByRole('radio', { name: 'Light' }).click();
  await mode('light');
  await win.getByRole('radio', { name: 'Dark' }).click();
  await win.getByRole('button', { name: 'Done' }).click();
  await mode('dark');
  await shot('dark');
});

await step('notes and documents zoom independently', async () => {
  const px = (sel) => win.locator(sel).first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const windowZoom = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
  const notesPct = win.locator('[data-pane="notes"] .zoom-pct');
  const docsPct = () => win.locator('[data-pane="docs"] .viewer:not(.hidden) .zoom-pct');
  await win.locator('[data-pane="docs"] .tab', { hasText: 'client.py' }).first().click();
  await win.locator('.code-viewer .cm-content').first().waitFor({ timeout: 10000 });
  const note0 = await px('.editor-wrap .cm-scroller');
  const code0 = await px('.viewer:not(.hidden) .code-viewer .cm-scroller');
  // Keys zoom the pane being worked in.
  await win.locator('.editor-wrap .cm-content').first().focus();
  await win.keyboard.press('Control+=');
  await win.keyboard.press('Control+=');
  if ((await notesPct.textContent()) !== '125%') throw new Error('notes zoom shows ' + (await notesPct.textContent()));
  if (!((await px('.editor-wrap .cm-scroller')) > note0 * 1.2)) throw new Error('notes text did not grow');
  if ((await px('.viewer:not(.hidden) .code-viewer .cm-scroller')) !== code0) throw new Error('documents zoomed with the notes');
  await win.locator('.viewer:not(.hidden) .code-viewer .cm-content').first().click();
  await win.keyboard.press('Control+-');
  if ((await docsPct().textContent()) !== '90%') throw new Error('documents zoom shows ' + (await docsPct().textContent()));
  if (!((await px('.viewer:not(.hidden) .code-viewer .cm-scroller')) < code0)) throw new Error('code text did not shrink');
  if ((await notesPct.textContent()) !== '125%') throw new Error('notes zoom changed with the documents');
  // Ctrl+wheel zooms the pane under the pointer; the window itself never zooms.
  const box = await win.locator('.editor-wrap').first().boundingBox();
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await win.keyboard.down('Control');
  await win.mouse.wheel(0, -100);
  await win.keyboard.up('Control');
  await win.locator('[data-pane="notes"] .zoom-pct', { hasText: '150%' }).waitFor({ timeout: 3000 });
  if ((await windowZoom()) !== 1) throw new Error('the whole window zoomed');
  await shot('zoomed');
  // A PDF keeps its own zoom.
  await win.locator('[data-pane="docs"] .tab', { hasText: 'BDS-100' }).first().click();
  const pdfSel = win.locator('.viewer:not(.hidden) .toolbar select').first();
  await win.locator('.viewer:not(.hidden) .pdf-scroll').click({ position: { x: 5, y: 5 } });
  await win.keyboard.press('Control+=');
  if ((await pdfSel.inputValue()) === 'width') throw new Error('PDF did not zoom');
  // Clicking the percentage goes back to 100%.
  await notesPct.click();
  await win.locator('[data-pane="docs"] .tab', { hasText: 'client.py' }).first().click();
  await docsPct().click();
  if ((await notesPct.textContent()) !== '100%' || (await docsPct().textContent()) !== '100%') throw new Error('reset failed');
  if ((await px('.editor-wrap .cm-scroller')) !== note0) throw new Error('notes text not back to normal');
});

await step('restored tabs that no longer exist are dropped', async () => {
  await win.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('session:'));
    const s = JSON.parse(localStorage.getItem(key));
    s.docs = [
      { path: '/data/Gone.xlsx', external: false, rev: '70e39b4' },
      { path: '/src/solver.py', external: false, rev: 'deadbeef12' },
      { path: '/src/solver.py', external: false },
    ];
    s.activeDoc = 0;
    s.notes = ['/notes/gone.md', '/notes/review.md'];
    s.activeNote = '/notes/gone.md';
    localStorage.setItem(key, JSON.stringify(s));
  });
  await win.reload();
  await win.locator('.pane:has(.tab-add[title^="Open a document"]) .tabs > .tab').first().waitFor({ timeout: 20000 });
  const tabs = await win.locator('.pane:has(.tab-add[title^="Open a document"]) .tabs > .tab').count();
  if (tabs !== 1) throw new Error(`expected 1 restored document tab, got ${tabs}`);
  if (await win.getByText("Couldn't open").count()) throw new Error('a stale tab still shows an error');
});

const noteText = await win.evaluate(() => window.api.readText('/notes/review.md'));
const citedLine = noteText.split('\n').find((l) => l.includes('New citation'));
console.log('     inserted:', citedLine);
if (errors.length) console.log('Console errors:\n  ' + errors.slice(0, 10).join('\n  '));
await app.close();
