// Drives the real app against the test workspace and saves screenshots to test-output/.
// Usage: npm run build && node scripts/make-test-workspace.mjs && node scripts/smoke.mjs
import { _electron as electron } from 'playwright';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { demoFlowText } from './flow-demo.mjs';

const repo = resolve(import.meta.dirname, '..');
// LOCUS_TEST_OUT puts this run's screenshots and user data somewhere else (a second run, or when
// a leftover app still holds the usual folder).
const out = process.env.LOCUS_TEST_OUT ? resolve(process.env.LOCUS_TEST_OUT) : join(repo, 'test-output');
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
if (process.env.PAGELOG) win.on('console', (m) => console.log('[page]', m.text()));

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
  await win.getByPlaceholder('Find a file by name').fill('review');
  await win.locator('.tree-row', { hasText: 'review.md' }).waitFor();
  await win.keyboard.press('Enter');
  await win.locator('.editor-wrap .cm-ref').first().waitFor({ timeout: 10000 });
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
  await win.locator('[data-pane="notes"] .toolbar button[title^="Table"]').click();
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

await step('each pane has its own Open: the left lists only notes and flowcharts', async () => {
  if (await win.locator('.header').getByRole('button', { name: 'Open', exact: true }).count()) throw new Error('the header still has an Open');
  // Left: notes and flowcharts only, every folder folded, at the latest version.
  await win.locator('[data-pane="notes"] .tabs .tab-add', { hasText: 'Open' }).click();
  const dlg = win.locator('.locus-dialog');
  // Files at the top of the workspace have no folder to fold into; count only those inside one.
  const nested = () => dlg.locator('.tree-row:not(.folder)').evaluateAll((rows) => rows.filter((r) => r.style.paddingLeft !== '8px').length);
  await dlg.getByRole('heading', { name: 'Open a note or flowchart' }).waitFor({ timeout: 5000 });
  await dlg.locator('.tree-row.folder').first().waitFor({ timeout: 5000 });
  if (await nested()) throw new Error('the left Open did not start with its folders folded');
  if (await dlg.locator('select').count()) throw new Error('the left Open offers old versions');
  await dlg.getByRole('button', { name: 'Expand all' }).click();
  const names = await dlg.locator('.tree-row:not(.folder) .name').allInnerTexts();
  if (!names.some((n) => n.endsWith('.md')) || !names.some((n) => n.endsWith('.canvas'))) throw new Error(`left Open lists: ${names.join(', ')}`);
  if (names.some((n) => !/\.(md|canvas)$/.test(n))) throw new Error(`left Open lists other files: ${names.join(', ')}`);
  await dlg.getByRole('button', { name: 'Collapse all' }).click();
  if (await nested()) throw new Error('files still listed after Collapse all');
  await shot('open-left');
  await win.keyboard.press('Escape');
  // Right: everything, folded too; a note picked there opens read-only.
  await win.locator('[data-pane="docs"] .tabs .tab-add', { hasText: 'Open' }).click();
  await dlg.getByRole('heading', { name: 'Open a document' }).waitFor({ timeout: 5000 });
  await dlg.locator('.tree-row.folder').first().waitFor({ timeout: 5000 });
  if (await nested()) throw new Error('the right Open did not start with its folders folded');
  await dlg.getByRole('button', { name: 'Expand all' }).click();
  const all = await dlg.locator('.tree-row:not(.folder) .name').allInnerTexts();
  if (!all.some((n) => n.endsWith('.pdf')) || !all.some((n) => n.endsWith('.md'))) throw new Error(`right Open lists: ${all.join(', ')}`);
  await win.getByPlaceholder('Find a file by name').fill('design-basis');
  await win.locator('.tree-row', { hasText: 'design-basis.md' }).first().click();
  const view = win.locator('[data-pane="docs"] .viewer:not(.hidden)');
  await view.locator('.note-view .cm-line').first().waitFor({ timeout: 10000 });
  if (!(await view.locator('.note-view .cm-content').evaluate((el) => el.closest('.cm-editor').querySelector('.cm-content').getAttribute('contenteditable') !== null)))
    throw new Error('no note view');
  // Read-only: typing changes nothing.
  const before = await view.locator('.note-view .cm-content').innerText();
  await view.locator('.note-view .cm-line').first().click();
  await win.keyboard.type('xyz');
  if ((await view.locator('.note-view .cm-content').innerText()) !== before) throw new Error('the viewed note changed');
  await shot('note-view');
  await view.getByRole('button', { name: 'Edit' }).click();
  await win.locator('[data-pane="notes"] .tab.active', { hasText: 'design-basis.md' }).waitFor({ timeout: 10000 });
  // Close both copies and go back to the review note for the steps that follow.
  await win.locator('[data-pane="docs"] .tab', { hasText: 'design-basis.md' }).locator('.close').dispatchEvent('mousedown');
  await win.locator('[data-pane="notes"] .tab', { hasText: 'design-basis.md' }).locator('.close').dispatchEvent('mousedown');
  await win.locator('[data-pane="notes"] .tab', { hasText: 'review.md' }).click();
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

await step('moving within a document glides; another version slides in with a chip', async () => {
  // Back from the pinned version to the latest: the same file in another version.
  await win.locator('.cm-ref', { hasText: 'the backoff loop' }).click();
  await win.locator('.viewer:not(.hidden) .version-chip').waitFor({ timeout: 5000 });
  await win.waitForTimeout(800);
  // Another place in a file that fits on screen: nothing travels, the cited lines pulse.
  await win.locator('.cm-ref', { hasText: 'backoff()' }).first().click();
  await win.locator('.viewer:not(.hidden) .cite-pulse').waitFor({ timeout: 5000 });
  if (await win.locator('.viewer:not(.hidden) .travel-rail').count()) throw new Error('travel rail shown with nothing to scroll');
  // A place further down a long document: the travel rail shows where it went.
  await win.locator('.cm-ref', { hasText: 'Table 5' }).first().click();
  await win.locator('.viewer:not(.hidden) .area-box.cited').waitFor({ timeout: 20000 });
  await win.waitForTimeout(800);
  await win.evaluate(() => (document.querySelector('.viewer:not(.hidden) .pdf-scroll').scrollTop = 0));
  await win.waitForTimeout(300);
  await win.locator('.cm-ref', { hasText: 'Table 5' }).first().click();
  await win.locator('.viewer:not(.hidden) .travel-rail .travel-label', { hasText: /^p / }).waitFor({ timeout: 5000 });
  await shot('travel');
});

await step('a link always lands the same way: the cited area centred', async () => {
  const centre = () =>
    win.evaluate(() => {
      const box = document.querySelector('.viewer:not(.hidden) .area-box.cited').getBoundingClientRect();
      const view = document.querySelector('.viewer:not(.hidden) .pdf-scroll').getBoundingClientRect();
      return ((box.top + box.bottom) / 2 - view.top) / view.height;
    });
  const follow = async (label) => {
    await win.locator('.cm-ref', { hasText: label }).first().click();
    await win.waitForTimeout(1600);
  };
  await follow('Table 5');
  const first = await centre();
  await follow('the backoff loop');
  await follow('Table 5');
  const again = await centre();
  if (Math.abs(first - 0.5) > 0.05 || Math.abs(again - first) > 0.02) throw new Error(`area at ${first.toFixed(3)} then ${again.toFixed(3)} of the view`);
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

await step('a picture anchored in a sheet is drawn over the cells', async () => {
  const sheet = win.locator('.viewer:not(.hidden)').first();
  const picture = sheet.locator('img.sheet-image').first();
  await picture.waitFor({ timeout: 15000 });
  const box = await picture.boundingBox();
  if (!box || box.width < 20 || box.height < 20) throw new Error(`the picture came out ${JSON.stringify(box)}`);
  // It sits over the cells it is anchored to, and does not take their clicks.
  const grid = await sheet.locator('.grid-scroll').first().boundingBox();
  if (box.x < grid.x || box.y < grid.y) throw new Error('the picture is outside the grid');
  await shot('sheet-picture');
});

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
  const lineBecomes = async (re, what) => {
    for (let i = 0; i < 40; i++) {
      if (re.test(await lineOf())) return;
      await win.waitForTimeout(250);
    }
    throw new Error(`${what}: ${await lineOf()}`);
  };
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
  await lineBecomes(/&rev=[0-9a-f]{10}/, 'not pinned');
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
  await lineBecomes(/&at=[0-9a-f]{10}/, 'not made live');
  if (/rev=/.test(await lineOf())) throw new Error('still pinned: ' + (await lineOf()));
  await hoverLink('Pinned p5');
  await win.locator('.hover-card .link-kind', { hasText: 'Live' }).waitFor({ timeout: 5000 });
  await win.locator('.hover-card').getByRole('button', { name: 'Pin to this version' }).click();
  await win.mouse.move(5, 500);
  await win.locator('.editor-wrap .cm-content').first().focus();
  await win.keyboard.press('Control+S');
  await lineBecomes(/&rev=[0-9a-f]{10}/, 'not pinned again');
});

await step('a live link whose file changed says so in its hover card and when opened', async () => {
  // Someone adds a cover page outside the app: everything moves down a page.
  const file = join(workspace, 'docs', 'BDS-100 Bracket Design Standard.pdf');
  const current = await readFile(file);
  const doc = await PDFDocument.load(current);
  doc.insertPage(0);
  await writeFile(file, await doc.save());
  try {
    await win.evaluate(() => window.dispatchEvent(new Event('focus')));
    // Nothing is written beside the link; its hover card says what happened.
    const line = win.locator('.cm-line', { hasText: 'verification methods' });
    await win.waitForTimeout(1500);
    if (await line.locator('.badge').count()) throw new Error('a badge is shown beside a link');
    await win.locator('.cm-ref', { hasText: 'Table 5' }).scrollIntoViewIfNeeded();
    await hoverLink('Table 5');
    await win.locator('.hover-card .link-changed').waitFor({ timeout: 15000 });
    await win.locator('.hover-card').getByRole('button', { name: 'Update link to latest' }).waitFor();
    await shot('changed-card');
    await win.mouse.move(5, 500);
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

await step('compare: pick the version on each side, and swap', async () => {
  const bar = win.locator('.viewer:not(.hidden) .compare-head');
  const left = bar.getByLabel('Version on the left');
  const right = bar.getByLabel('Version on the right');
  if ((await right.inputValue()) !== '') throw new Error('right side should start on Latest');
  // The oldest version on the left, then the current file on both sides: no differences.
  await win.waitForFunction(() => document.querySelectorAll('.viewer:not(.hidden) .compare-head select')[0]?.options.length > 3, null, { timeout: 10000 });
  const options = await left.locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
  await left.selectOption(options[options.length - 1]);
  await win.locator('.cm-changedLine').first().waitFor({ timeout: 10000 });
  await left.selectOption('');
  await win.waitForFunction(() => !document.querySelector('.viewer:not(.hidden) .cm-changedLine'), null, { timeout: 10000 });
  // A past version on the right, then swap the sides.
  await right.selectOption(options[options.length - 1]);
  await win.locator('.cm-changedLine').first().waitFor({ timeout: 10000 });
  await bar.getByRole('button', { name: 'Swap sides' }).click();
  await win.waitForFunction(() => {
    const s = [...document.querySelectorAll('.viewer:not(.hidden) .compare-head select')];
    return s.length === 2 && s[0].value !== '' && s[1].value === '';
  }, null, { timeout: 5000 });
  if ((await left.inputValue()) !== options[options.length - 1]) throw new Error('swap did not move the right version to the left');
  await shot('compare-pickers');
  await bar.getByRole('button', { name: 'Stop comparing' }).click();
});

await step('compare two PDF versions side by side', async () => {
  await win.locator('.cm-ref', { hasText: 'Table 5' }).click();
  await win.locator('.tab.active', { hasText: 'BDS-100' }).waitFor({ timeout: 10000 });
  await win.locator('.viewer:not(.hidden) .strip-btn', { hasText: 'Compare' }).filter({ visible: true }).click();
  await win.locator('.compare-split .pdf-page').first().waitFor({ timeout: 15000 });
  // Both sides open at the same page as the citation (page 5).
  const pages = () => win.locator('.viewer:not(.hidden) .compare-split .side .toolbar input').evaluateAll((els) => els.map((e) => e.value));
  await win.waitForFunction(() => [...document.querySelectorAll('.viewer:not(.hidden) .compare-split .side .toolbar input')].every((e) => e.value === '5'), null, { timeout: 10000 }).catch(() => undefined);
  if ((await pages()).join() !== '5,5') throw new Error('sides not on the same page: ' + (await pages()).join());
  await shot('compare-pdf');
  await win.getByRole('button', { name: 'Stop comparing' }).click();
});

await step('compare a spreadsheet: both sides open at the same cells', async () => {
  await win.locator('.cm-ref', { hasText: 'Load cases (Mar 3)' }).click();
  await win.locator('.viewer:not(.hidden) .cited-box').waitFor({ timeout: 15000 });
  await win.waitForTimeout(400);
  // Scroll away from the citation: the comparison should open where the reader is now.
  await win.locator('.viewer:not(.hidden) .grid-scroll').evaluate((el) => (el.scrollTop = 200));
  await win.waitForTimeout(400);
  await win.locator('.viewer:not(.hidden) .strip-btn', { hasText: 'Compare' }).filter({ visible: true }).click();
  await win.locator('.viewer:not(.hidden) .compare-split .grid-scroll').nth(1).waitFor({ timeout: 15000 });
  const tops = () => win.locator('.viewer:not(.hidden) .compare-split .grid-scroll').evaluateAll((els) => els.map((e) => `${e.scrollTop},${e.scrollLeft}`));
  await win.waitForTimeout(800);
  const [l, r] = await tops();
  if (l !== r || l.startsWith('0,')) throw new Error(`grids not at the reader's place: ${l} vs ${r}`);
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

await step('tour mode: a stop in another note shows it on the right and the tour goes on', async () => {
  const touring = await win.locator('[data-pane="notes"] .tab.active').innerText();
  await win.getByRole('button', { name: 'Tour' }).click();
  await win.locator('.tour-bar', { hasText: 'stop 1 of' }).waitFor({ timeout: 5000 });
  const label = () => win.locator('.tour-bar .label').innerText();
  for (let i = 0; i < 40 && (await label()) !== 'factors of safety'; i++) {
    await win.keyboard.press('ArrowRight');
    await win.waitForTimeout(150);
  }
  if ((await label()) !== 'factors of safety') throw new Error('never reached the link to the design basis note');
  await win.locator('.viewer:not(.hidden) .cm-content', { hasText: 'Ultimate factor 1.4' }).waitFor({ timeout: 10000 });
  await win.waitForTimeout(500);
  if (!(await win.locator('.tour-bar').isVisible())) throw new Error('the tour ended');
  const now = await win.locator('[data-pane="notes"] .tab.active').innerText();
  if (now !== touring) throw new Error(`the note in front changed from ${touring} to ${now}`);
  const stop = await win.locator('.tour-bar').innerText();
  await win.keyboard.press('ArrowLeft');
  await win.waitForFunction((s) => document.querySelector('.tour-bar')?.textContent !== s, stop, { timeout: 5000 });
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
  await win.getByPlaceholder('Find a file by name').fill('retry-flow');
  await win.locator('.tree-row', { hasText: 'retry-flow' }).first().waitFor();
  await win.keyboard.press('Enter');
  await win.locator('.flow-box', { hasText: 'wait backoff' }).waitFor({ timeout: 10000 });
  if ((await win.locator('.flow-frame').count()) !== 2) throw new Error('loop frames missing');
  // The arrows draw a moment after the boxes: count them once the number holds still.
  let edges0 = -1;
  for (let same = 0; same < 4; await win.waitForTimeout(150)) {
    const n = await win.locator('.flow-editor .react-flow__edge').count();
    same = n === edges0 && n > 0 ? same + 1 : 0;
    edges0 = n;
  }
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
  await win.keyboard.press('Control+P');
  await win.locator('.locus-dialog').getByRole('button', { name: 'Version history' }).click();
  await win.locator('.history-item', { hasText: 'Retry refactor: exponential' }).click();
  await win.locator('.history-detail .tree-row', { hasText: 'sleep_util.py' }).waitFor({ timeout: 10000 });
  await win.locator('.history-detail .tree-row', { hasText: 'client.py' }).waitFor();
  await shot('history');
  await win.locator('.history-detail .tree-row', { hasText: 'client.py' }).click();
  await win.locator('.tab.active .badge.mark').waitFor({ timeout: 10000 });
  await win.keyboard.press('Control+P');
  await win.locator('.locus-dialog').getByRole('button', { name: 'Version history' }).click();
  await win.locator('.history-item', { hasText: 'Before retry refactor' }).click();
  await win.getByRole('button', { name: 'Browse all files from this version' }).click();
  // Folders start folded; open them to see what was deleted later.
  await win.getByRole('button', { name: 'Expand all' }).click();
  await win.getByText('deleted later').first().waitFor({ timeout: 10000 });
  await shot('browser-old-version');
  // Version history from the browser opens on the version being shown; Back returns to it.
  await win.locator('.locus-dialog').getByRole('button', { name: 'Version history' }).click();
  await win.locator('.history-item.selected', { hasText: 'Before retry refactor' }).waitFor({ timeout: 5000 });
  await win.getByRole('button', { name: 'Back to files' }).click();
  await win.getByRole('button', { name: 'Expand all' }).click();
  await win.getByText('deleted later').first().waitFor({ timeout: 10000 });
  await win.keyboard.press('Escape');
  // Opening the browser again starts at the latest version.
  await win.keyboard.press('Control+P');
  const shown = await win.locator('.locus-dialog select').inputValue();
  if (shown !== '') throw new Error('file browser should reset to the latest version');
  await win.keyboard.press('Escape');
});

await step('restore a file as it was in an older version, and undo it', async () => {
  // The client was refactored over the versions, so an older one really is different.
  const file = '/src/http/client.py';
  const now = await win.evaluate((p) => window.api.readText(p), file);
  await win.keyboard.press('Control+P');
  await win.getByPlaceholder('Find a file by name').fill('client.py');
  await win.locator('.tree-row', { hasText: 'client.py' }).first().waitFor({ timeout: 8000 });
  await win.keyboard.press('Enter');
  const viewer = win.locator('.viewer:not(.hidden)').first();
  await viewer.locator('.cm-content').first().waitFor({ timeout: 15000 });
  const strip = viewer.locator('.vstrip').first(); // the hidden tabs have strips of their own
  await strip.locator('.vdot').first().click();
  await win.waitForTimeout(1200);
  await strip.getByRole('button', { name: /Restore this version/ }).click();
  await win.locator('.confirm-dialog').waitFor({ timeout: 5000 });
  await win.locator('.confirm-dialog').getByRole('button', { name: 'Restore' }).click();
  await win.locator('.notice', { hasText: 'back as it was' }).waitFor({ timeout: 15000 });
  const back = await win.evaluate((p) => window.api.readText(p), file);
  if (back === now) throw new Error('the file was not put back');
  if (!/sleep/.test(back)) throw new Error(`restored the wrong thing: ${back.slice(0, 120)}`);
  await shot('restored');
  // The notice puts it back the way it was.
  await win.locator('.notice', { hasText: 'back as it was' }).getByRole('button', { name: 'Undo' }).click();
  await win.waitForFunction(
    ([p, before]) => window.api.readText(p).then((t) => t === before),
    [file, now],
    { timeout: 15000 },
  );
  await win.locator('.notice .icon').last().click().catch(() => undefined);
});

await step('a file saved by another program shows without a click', async () => {
  // The code is open on the right; something else writes to it while Locus is not touched.
  await win.keyboard.press('Control+P');
  await win.getByPlaceholder('Find a file by name').fill('solver.py');
  await win.locator('.tree-row', { hasText: 'solver.py' }).first().waitFor({ timeout: 8000 });
  await win.keyboard.press('Enter');
  const viewer = win.locator('.viewer:not(.hidden)').first();
  await viewer.locator('.cm-content').first().waitFor({ timeout: 15000 });
  const mark = `# written from outside at ${Date.now()}`;
  await writeFile(join(workspace, 'src', 'solver.py'), mark + '\n' + (await readFile(join(workspace, 'src', 'solver.py'), 'utf8')), 'utf8');
  // No focus event, no click: the watch on the workspace is what brings it in.
  await viewer.locator('.cm-content').first().getByText('written from outside').waitFor({ timeout: 15000 });
  await shot('refreshed-from-disk');
});

await step('Open: folders fold and unfold; Motion setting', async () => {
  await win.keyboard.press('Control+O');
  const row = win.locator('.tree-row', { hasText: 'review.md' });
  await win.locator('.tree-row.folder', { hasText: 'notes' }).first().waitFor();
  if (await row.count()) throw new Error('files listed before their folder was opened');
  await win.locator('.tree-row.folder', { hasText: 'notes' }).first().click();
  await row.first().waitFor({ timeout: 3000 });
  await win.getByRole('button', { name: 'Expand all' }).click();
  await shot('open-folders');
  await win.keyboard.press('Escape');
  const motion = (m) => win.waitForFunction((m) => document.documentElement.dataset.motion === m, m, { timeout: 5000 });
  await win.getByTitle('Settings').click();
  await win.getByRole('radio', { name: 'Reduced' }).click();
  await motion('reduced');
  await win.getByRole('radio', { name: 'Full' }).click();
  await motion('full');
  await win.getByRole('button', { name: 'Done' }).click();
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

await step('toolbar shows what applies at the cursor; Tab nests a list item', async () => {
  await win.locator('[data-pane="notes"] .tabs > .tab', { hasText: 'review.md' }).first().click();
  await win.locator('.editor-wrap .cm-content').first().click();
  await win.keyboard.press('Control+End');
  await win.keyboard.press('Enter');
  await win.keyboard.press('Enter');
  const button = (title) => win.locator(`[data-pane="notes"] .toolbar button[title^="${title}"]`).first();
  const lit = async (title) => (await button(title).getAttribute('aria-pressed')) === 'true';
  if (await lit('Bold')) throw new Error('Bold lit on plain text');
  await win.keyboard.press('Control+B');
  await win.keyboard.type('strong');
  if (!(await lit('Bold'))) throw new Error('Bold not lit inside bold text');
  await win.keyboard.press('End');
  await win.keyboard.press('Enter');
  await win.keyboard.press('Enter');
  await win.keyboard.press('Control+Shift+}'); // what a real keyboard sends for Ctrl+Shift+]
  await win.keyboard.type('parent');
  if (!(await lit('Bulleted list'))) throw new Error('Bulleted list not lit');
  await win.keyboard.press('Enter');
  await win.keyboard.type('child');
  await win.keyboard.press('Tab');
  await win.waitForTimeout(1500);
  const text = await win.evaluate(() => window.api.readText('/notes/review.md'));
  if (!/\*\*strong\*\*/.test(text)) throw new Error('bold text not written');
  if (!/- parent\r?\n  - child/.test(text)) throw new Error('the item was not nested');
  if (await button('Redo').isEnabled()) throw new Error('Redo enabled with nothing to redo');
  await win.keyboard.press('Control+Z');
  if (!(await button('Redo').isEnabled())) throw new Error('Redo not enabled after undo');
  await win.keyboard.press('Control+Y');
  await win.keyboard.press('Enter');
  await win.keyboard.press('Enter');
  await win.keyboard.press('Enter');
});

await step('pictures: paste saves a file and shows it; drag the corner to resize', async () => {
  await win.locator('[data-pane="notes"] .tabs > .tab', { hasText: 'review.md' }).first().click();
  await win.locator('.editor-wrap .cm-content').first().click();
  await win.keyboard.press('Control+End');
  await win.keyboard.press('Enter');
  await win.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 300;
    c.height = 120;
    const g = c.getContext('2d');
    g.fillStyle = '#1f5c45';
    g.fillRect(0, 0, 300, 120);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const data = new DataTransfer();
    data.items.add(new File([blob], 'image.png', { type: 'image/png' }));
    document.activeElement.closest('.cm-content').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  const img = win.locator('.editor-wrap .cm-image-wrap img').last();
  await img.waitFor({ timeout: 10000 });
  const text = () => win.evaluate(() => document.activeElement.closest('.cm-editor') && window.api.readText('/notes/review.md'));
  await win.waitForTimeout(1500);
  const m = (await text()).match(/!\[\]\((\/images\/review\/pasted-[\d-]+\.png)\)/);
  if (!m) throw new Error('no picture link in the note');
  if (!(await win.evaluate((p) => window.api.exists(p), m[1]))) throw new Error('the picture file was not saved');
  // Resize from the corner handle.
  await img.scrollIntoViewIfNeeded();
  await img.hover();
  const h = await win.locator('.editor-wrap .cm-image-handle').last().boundingBox();
  await win.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await win.mouse.down();
  await win.mouse.move(h.x - 100, h.y + 10, { steps: 5 });
  await win.mouse.up();
  await win.waitForTimeout(1500);
  const w = (await text()).match(/pasted-[\d-]+\.png#w=(\d+)\)/);
  if (!w || Math.abs(+w[1] - 200) > 15) throw new Error(`width not recorded: ${w?.[1]}`);
  if (Math.abs((await img.boundingBox()).width - +w[1]) > 3) throw new Error('the picture is not drawn at its width');
  await shot('picture');
  // Double-click the handle: back to its own size.
  await img.hover();
  await win.locator('.editor-wrap .cm-image-handle').last().dblclick();
  await win.waitForTimeout(1500);
  if (/#w=/.test(await text())) throw new Error('width not cleared');
});

await step('tab menu: rename, save a copy, move, delete', async () => {
  const noteTabs = win.locator('[data-pane="notes"] .tabs > .tab');
  const pick = async (tabText, item) => {
    await noteTabs.filter({ hasText: tabText }).first().click({ button: 'right' });
    await win.locator('.context-menu').getByRole('menuitem', { name: item }).click();
  };
  const exists = (path) => win.evaluate((p) => window.api.exists(p), path);
  await win.locator('.tab-add[title^="New note"]').click();
  await noteTabs.filter({ hasText: 'Untitled.md' }).waitFor({ timeout: 5000 });
  await pick('Untitled.md', 'Rename…');
  await win.getByLabel('Name', { exact: true }).fill('Scratch');
  await win.keyboard.press('Enter');
  await noteTabs.filter({ hasText: 'Scratch.md' }).waitFor({ timeout: 5000 });
  if (await exists('/Untitled.md')) throw new Error('the old name is still there');
  await pick('Scratch.md', 'Save a copy…');
  await win.locator('.path-dialog').getByRole('button', { name: 'Save a copy' }).click();
  await win.waitForFunction(() => window.api.exists('/Scratch copy.md'), null, { timeout: 5000 });
  await pick('Scratch.md', 'Move to…');
  await win.getByLabel('Folder', { exact: true }).fill('/notes/drafts');
  await win.keyboard.press('Enter');
  await win.locator('[data-pane="notes"] .tab[title="/notes/drafts/Scratch.md"]').waitFor({ timeout: 5000 });
  await shot('tab-menu-moved');
  await pick('Scratch.md', 'Delete…');
  // Cancel is the default: Enter must not delete.
  await win.locator('.confirm-dialog').waitFor();
  await win.keyboard.press('Enter');
  if (!(await exists('/notes/drafts/Scratch.md'))) throw new Error('Enter deleted the note');
  await pick('Scratch.md', 'Delete…');
  await win.locator('.confirm-dialog').getByRole('button', { name: 'Delete' }).click();
  await win.waitForFunction(() => window.api.exists('/notes/drafts/Scratch.md').then((e) => !e), null, { timeout: 5000 });
  await noteTabs.filter({ hasText: 'Scratch.md' }).waitFor({ state: 'detached', timeout: 5000 });
  await win.evaluate(() => window.api.trashFile('/Scratch copy.md'));
  await noteTabs.filter({ hasText: 'review.md' }).first().click();
});

await step('the citation editor moves a link without showing markdown', async () => {
  await win.locator('[data-pane="notes"] .tabs > .tab', { hasText: 'review.md' }).first().click();
  await win.locator('.cm-ref', { hasText: 'Table 5' }).scrollIntoViewIfNeeded();
  await hoverLink('Table 5');
  await win.locator('.hover-card').getByRole('button', { name: 'Edit', exact: true }).click();
  const dlg = win.locator('.citation-editor');
  await dlg.waitFor({ timeout: 10000 });
  if ((await win.getByLabel('Points at').inputValue()) !== 'area') throw new Error('the editor did not open on the area');
  await shot('citation-editor');
  // Only files that can hold an area are offered.
  await dlg.getByRole('button', { name: 'Change…' }).click();
  await win.getByText('Choose a document').waitFor({ timeout: 5000 });
  await win.getByRole('button', { name: 'Expand all' }).click();
  if (await win.locator('.tree-row', { hasText: 'client.py' }).count()) throw new Error('a code file was offered for an area');
  await win.locator('.tree-row', { hasText: 'BDS-100' }).first().waitFor();
  await win.keyboard.press('Escape');
  await dlg.waitFor();
  // Switch to a plain page: the area and its quote go, and the preview follows.
  await win.getByLabel('Points at').selectOption('page');
  await win.getByLabel('Page', { exact: true }).fill('7');
  await win.locator('.ce-preview .pdf-thumb, .ce-preview canvas, .ce-preview img').first().waitFor({ timeout: 15000 });
  await dlg.getByRole('button', { name: 'Save' }).click();
  await dlg.waitFor({ state: 'detached', timeout: 5000 });
  await win.waitForFunction(() => window.api.readText('/notes/review.md').then((t) => /\[Table 5\]\(<?[^)>]*#page=7&at=[0-9a-f]{10}>?\)/.test(t)), null, { timeout: 10000 });
});

await step('Pick in the document: draw the area on the right', async () => {
  await win.locator('.cm-ref', { hasText: 'Table 5' }).scrollIntoViewIfNeeded();
  await hoverLink('Table 5');
  await win.locator('.hover-card').getByRole('button', { name: 'Edit', exact: true }).click();
  await win.locator('.citation-editor').waitFor({ timeout: 10000 });
  await win.getByRole('button', { name: 'Pick in the document' }).click();
  const bar = win.locator('.pick-bar');
  await bar.waitFor({ timeout: 10000 });
  if (await win.locator('.citation-editor').isVisible()) throw new Error('the editor stayed in the way');
  // The document glides to the link's place first; drawing before it settles would miss.
  await win.waitForTimeout(1500);
  // Draw a box with the Area tool.
  await win.locator('.viewer:not(.hidden) .pdf-page canvas').first().waitFor({ timeout: 20000 });
  await win.locator('.viewer:not(.hidden)').first().getByRole('button', { name: 'Area', exact: true }).click();
  // Drag inside the part of the page that is on screen.
  const view = await win.locator('.viewer:not(.hidden) .pdf-scroll').boundingBox();
  await win.mouse.move(view.x + 120, view.y + 140);
  await win.mouse.down();
  await win.mouse.move(view.x + 330, view.y + 250, { steps: 8 });
  await win.mouse.up();
  const cite = win.locator('.viewer:not(.hidden) button.cite').first();
  await cite.filter({ hasText: 'Cite area' }).waitFor({ timeout: 5000 });
  await bar.getByRole('button', { name: 'Use this place' }).click();
  const dlg = win.locator('.citation-editor');
  await dlg.waitFor({ timeout: 5000 });
  if ((await win.getByLabel('Points at').inputValue()) !== 'area') throw new Error('the picked area did not come back');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await win.waitForFunction(() => window.api.readText('/notes/review.md').then((t) => /\[Table 5\]\(<?[^)>]*#page=\d+&viewrect=[\d,]+&at=[0-9a-f]{10}>?\)/.test(t)), null, { timeout: 10000 });
});

await step('a box drawn by hand quotes what is inside it', async () => {
  await win.locator('[data-pane="docs"] .tab', { hasText: 'BDS-100' }).first().click();
  await win.locator('.viewer:not(.hidden) .pdf-page canvas').first().waitFor({ timeout: 20000 });
  // A side-by-side comparison puts two toolbars in one viewer: take the first of everything.
  const pdf = win.locator('.viewer:not(.hidden)').first();
  const bar = pdf.locator('.toolbar').first();
  await bar.getByRole('button', { name: 'Area', exact: true }).click(); // "Cite area" also contains "Area"
  const view = await pdf.locator('.pdf-scroll').first().boundingBox();
  await win.mouse.move(view.x + 120, view.y + 150);
  await win.mouse.down();
  await win.mouse.move(view.x + 420, view.y + 260, { steps: 8 });
  await win.mouse.up();
  await pdf.locator('button.cite').first().filter({ hasText: 'Cite area' }).waitFor({ timeout: 5000 });
  // The words inside the box are read before citing, so the link carries them.
  await win.locator('.editor-wrap .cm-content').first().click();
  await win.keyboard.press('Control+End');
  await win.keyboard.type('\n\nDrawn box: ');
  await bar.getByRole('button', { name: 'Cite area' }).click();
  await win.locator('.cm-renaming').waitFor({ timeout: 10000 });
  await win.keyboard.type('A drawn box');
  await win.keyboard.press('Enter');
  await win.keyboard.press('Control+S');
  await win.waitForFunction(
    () => window.api.readText('/notes/review.md').then((t) => /\[A drawn box\]\(<?[^)>]*viewrect=[\d,]+[^)>]*>? "[^"]+"\)/.test(t)),
    null,
    { timeout: 10000 },
  );
  await shot('drawn-box-quote');
});

await step('Link to a section, and the shortcuts list', async () => {
  await win.locator('.editor-wrap .cm-content').first().click();
  await win.keyboard.press('Control+End');
  await win.keyboard.type('\n\nSee ');
  await win.keyboard.press('Control+Alt+KeyL');
  await win.getByPlaceholder('Find a section by name').fill('Loads');
  await win.locator('.tree-row', { hasText: 'Loads' }).first().waitFor({ timeout: 5000 });
  await win.keyboard.press('Enter');
  await win.locator('.cm-renaming').waitFor({ timeout: 5000 });
  await win.keyboard.press('Enter');
  await win.keyboard.press('Control+S');
  await win.waitForFunction(() => window.api.readText('/notes/review.md').then((t) => /See \[Loads\]\(#loads\)/.test(t)), null, { timeout: 10000 });
  await win.keyboard.press('F1');
  await win.getByText('Keyboard shortcuts').waitFor({ timeout: 5000 });
  await shot('shortcuts');
  await win.keyboard.press('Escape');
});

await step('tab limits close the tab viewed longest ago', async () => {
  const docTabs = win.locator('[data-pane="docs"] .tabs > .tab');
  const noteTabs = win.locator('[data-pane="notes"] .tabs > .tab');
  const names = async (tabs) => (await tabs.allTextContents()).join(' | ');
  const setLimit = async (side, n) => {
    await win.getByTitle('Settings').click();
    await win.getByLabel(`${side} limit`).selectOption(n ? 'limit' : 'none');
    if (n) await win.getByLabel(`${side} tabs`).fill(String(n));
    await win.getByRole('button', { name: 'Done' }).click();
  };
  await noteTabs.filter({ hasText: 'review.md' }).first().click();
  await docTabs.filter({ hasText: 'client.py' }).first().click();
  await docTabs.filter({ hasText: 'BDS-100' }).first().click();
  await setLimit('Viewer (documents)', 2);
  await win.waitForFunction(() => document.querySelectorAll('[data-pane="docs"] .tabs > .tab').length === 2, null, { timeout: 5000 });
  let now = await names(docTabs);
  if (!/client\.py/.test(now) || !/BDS-100/.test(now)) throw new Error(`kept the wrong tabs: ${now}`);
  // Opening a third closes client.py, viewed before BDS-100.
  await win.locator('.cm-ref', { hasText: 'LoadTable' }).click();
  await win.locator('.cited-box').waitFor({ timeout: 15000 });
  await win.waitForTimeout(300);
  now = await names(docTabs);
  if ((await docTabs.count()) !== 2 || /client\.py/.test(now) || !/BDS-100/.test(now)) throw new Error(`after opening a third: ${now}`);
  // The editor keeps only the note in front.
  if ((await noteTabs.count()) < 2) throw new Error('expected several notes open');
  await setLimit('Editor (notes and flowcharts)', 1);
  await win.waitForFunction(() => document.querySelectorAll('[data-pane="notes"] .tabs > .tab').length === 1, null, { timeout: 5000 });
  if (!/review\.md/.test(await names(noteTabs))) throw new Error('closed the note in front');
  await setLimit('Viewer (documents)', 0);
  await setLimit('Editor (notes and flowcharts)', 0);
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
  await win.locator('[data-pane="docs"] .tabs > .tab').first().waitFor({ timeout: 20000 });
  const tabs = await win.locator('[data-pane="docs"] .tabs > .tab').count();
  if (tabs !== 1) throw new Error(`expected 1 restored document tab, got ${tabs}`);
  if (await win.getByText("Couldn't open").count()) throw new Error('a stale tab still shows an error');
});

await step('a note touched by a Windows tool still reads as lines', async () => {
  // One Windows line ending among Unix ones: a checkout, a script or another editor leaves these.
  await writeFile(join(workspace, 'notes', 'mixed.md'), '# Mixed\n\n## Part two\n\n- one\n- two\n\nEdited elsewhere.\r\n', 'utf8');
  await win.keyboard.press('Control+O');
  await win.getByPlaceholder('Find a file by name').fill('mixed');
  await win.locator('.tree-row', { hasText: 'mixed.md' }).first().waitFor({ timeout: 8000 });
  await win.keyboard.press('Enter');
  await win.locator('[data-pane="notes"] .tab.active', { hasText: 'mixed.md' }).waitFor({ timeout: 15000 });
  await win.waitForTimeout(600);
  const lines = await win.locator('.editor-wrap .cm-line').count();
  if (lines < 7) throw new Error(`the note collapsed into ${lines} line(s)`);
  if (await win.locator('.editor-wrap .cm-line', { hasText: '## Part two' }).count()) throw new Error('heading marks are showing as text');
  await shot('mixed-endings');
  // Typing and saving keeps the file as lines, and as the kind of file it was.
  await win.locator('.editor-wrap .cm-content:visible').first().click();
  await win.keyboard.press('Control+End');
  await win.keyboard.type('Another line.');
  await win.keyboard.press('Control+S');
  await win.waitForFunction(() => window.api.readText('/notes/mixed.md').then((t) => t.includes('Another line.')), null, { timeout: 20000 });
  const saved = await win.evaluate(() => window.api.readText('/notes/mixed.md'));
  if (!/# Mixed\n\n## Part two/.test(saved)) throw new Error('the note was rewritten with the wrong line endings');
});

await step('a CSV with quoted values shows them as the cells Claude cites', async () => {
  // Claude's reader and the viewer split a CSV into cells the same way, or an address means two things.
  await win.evaluate(() => window.api.writeText('/data/prices.csv', 'place,price,rent\nToronto,"1,075,000",2310\n'));
  await win.keyboard.press('Control+P');
  await win.getByPlaceholder('Find a file by name').fill('prices.csv');
  await win.locator('.tree-row', { hasText: 'prices.csv' }).first().waitFor({ timeout: 8000 });
  await win.keyboard.press('Enter');
  const viewer = win.locator('.viewer:not(.hidden)').first();
  await viewer.locator('.cell', { hasText: '1,075,000' }).first().waitFor({ timeout: 15000 });
  if (await viewer.locator('.cell', { hasText: /^075$/ }).count()) throw new Error('the quoted value was split into cells');
  await shot('csv-quoted-cells');
});

const noteText = await win.evaluate(() => window.api.readText('/notes/review.md'));
const citedLine = noteText.split('\n').find((l) => l.includes('New citation'));
console.log('     inserted:', citedLine);
if (errors.length) console.log('Console errors:\n  ' + errors.slice(0, 10).join('\n  '));
await app.close();
