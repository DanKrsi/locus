// Exports from the real app and checks what comes out: a web page and a PDF of a note, and the
// folder for someone without Locus.
// Usage: npm run build && node scripts/make-test-workspace.mjs && node scripts/test-export.mjs
import { _electron as electron, chromium } from 'playwright';
import { readFile, readdir, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const out = join(repo, 'test-output', 'export');
const userData = join(out, 'user-data');
const workspace = resolve(repo, '..', 'locus-test-workspace');

await rm(out, { recursive: true, force: true });
await mkdir(userData, { recursive: true });
await writeFile(join(userData, 'settings.json'), JSON.stringify({ claudeOffered: 'skip', recentWorkspaces: [workspace], dark: 'light' }));

const app = await electron.launch({ args: [repo], env: { ...process.env, LOCUS_USER_DATA: userData } });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1500, height: 900 });
let failures = 0;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${process.env.VERBOSE ? e.message.slice(0, 1200) : e.message.split('\n')[0]}`);
  }
};
const api = (m, ...a) => win.evaluate(([m, a]) => window.api[m](...a), [m, a]);

await win.getByText('Bracket project').first().waitFor({ timeout: 15000 });
let html = '';

await step('a note exports as one web page', async () => {
  const md = await api('readText', '/notes/review.md');
  const file = join(out, 'review.html');
  const written = await api('exportNotePage', '/notes/review.md', md, 'html', file);
  if (written !== file) throw new Error(`wrote ${written}`);
  html = await readFile(file, 'utf8');
  // The note's own formatting.
  if (!/<h1 id="retry-handling-review">Retry handling review<\/h1>/.test(html)) throw new Error('no heading');
  if (!/<li class="task"><input type="checkbox" disabled checked>/.test(html)) throw new Error('no ticked task');
  if (!/<table>.*<th>Item<\/th>/s.test(html)) throw new Error('no table');
  // Nothing of the note's machinery leaks in.
  if (/locus-id|&at=|&rev=/.test(html.replace(/href="[^"]*"/g, ''))) throw new Error('link plumbing showed in the text');
});

await step('its links open the cited documents on this computer', async () => {
  const href = (label) => html.match(new RegExp(`<a href="([^"]+)"[^>]*>${label}`))?.[1];
  const pdf = href('BDS-100 p5');
  if (!pdf?.startsWith('file:///') || !pdf.endsWith('#page=5')) throw new Error(`PDF link: ${pdf}`);
  if (!pdf.includes('/docs/BDS-100%20Bracket%20Design%20Standard.pdf')) throw new Error(`PDF path: ${pdf}`);
  const code = href('the backoff loop');
  if (!code?.endsWith('/src/net/client.py')) throw new Error(`code link: ${code}`);
  // A quote becomes the tooltip, and a section link stays inside the page.
  if (!/title="Retries of a failed proof test/.test(html)) throw new Error('no quote tooltip');
  const section = href('factors of safety');
  if (!section?.endsWith('/notes/design-basis.md#factors-of-safety')) throw new Error(`section link: ${section}`);
});

await step('pictures are inside the file', async () => {
  // A small picture of our own, so the test doesn't depend on what the workspace holds.
  const png = await win.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 40;
    c.height = 30;
    const g = c.getContext('2d');
    g.fillStyle = '#1f5c45';
    g.fillRect(0, 0, 40, 30);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await api('writeNewFile', '/images/shot/bracket.png', Uint8Array.from(png));
  const md = '# Shot\n\n![a bracket](/images/shot/bracket.png#w=240)\n';
  await api('writeText', '/notes/shot.md', md);
  const file = join(out, 'shot.html');
  await api('exportNotePage', '/notes/shot.md', md, 'html', file);
  const page = await readFile(file, 'utf8');
  if (!/<img src="data:image\/png;base64,[A-Za-z0-9+/=]{40,}" alt="a bracket" width="240">/.test(page)) throw new Error('the picture is not embedded');
});

await step('a note exports as a PDF', async () => {
  const md = await api('readText', '/notes/review.md');
  const file = join(out, 'review.pdf');
  await api('exportNotePage', '/notes/review.md', md, 'pdf', file);
  const bytes = await readFile(file);
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('not a PDF');
  if (bytes.length < 20000) throw new Error(`suspiciously small: ${bytes.length} bytes`);
});

await step('the folder for someone without Locus is written', async () => {
  const md = await api('readText', '/notes/review.md');
  const summary = await api('planExport', '/notes/review.md', md, 'linked');
  if (summary.notes < 2) throw new Error(`expected the linked note too: ${JSON.stringify(summary)}`);
  if (summary.files < 3) throw new Error(`expected the cited files: ${JSON.stringify(summary)}`);
  if (!summary.versions) throw new Error('expected a link to an older version');
  const dest = join(out, 'folder');
  const done = await api('writeExport', '/notes/review.md', md, 'linked', dest);
  if (done.failed.length) throw new Error(`could not copy: ${done.failed.join(', ')}`);
  const names = await readdir(dest);
  if (!names.some((n) => n.startsWith('START HERE - review'))) throw new Error(`no start page: ${names.join(', ')}`);
  if (!names.includes('Locus viewer') || !names.includes('Original files')) throw new Error(names.join(', '));
  const copies = await readdir(join(dest, 'Original files'));
  if (!copies.some((n) => /^Bracket loads \(version .+\)\.xlsx$/.test(n))) throw new Error(`no version copy: ${copies.join(', ')}`);
  if (copies.some((n) => /\.(md|canvas)$/.test(n))) throw new Error('notes should not be in the plain copies');
});

await step('the dialog says what goes in before writing anything', async () => {
  await win.keyboard.press('Control+O');
  await win.getByPlaceholder('Find a file by name').fill('review');
  await win.locator('.tree-row', { hasText: 'review.md' }).first().waitFor();
  await win.keyboard.press('Enter');
  await win.locator('.open-choice').waitFor({ timeout: 5000 });
  await win.keyboard.press('e');
  await win.locator('[data-pane="notes"] .tab.active', { hasText: 'review.md' }).waitFor({ timeout: 10000 });
  await win.locator('[data-pane="notes"] .tabs > .tab', { hasText: 'review.md' }).first().click({ button: 'right' });
  await win.locator('.context-menu').getByRole('menuitem', { name: 'Export for someone without Locus…' }).click();
  const dlg = win.locator('.export-dialog');
  await dlg.waitFor({ timeout: 5000 });
  await dlg.locator('.export-summary li').first().waitFor({ timeout: 15000 });
  const text = await dlg.locator('.export-summary').innerText();
  if (!/notes/.test(text) || !/files the note cites/.test(text)) throw new Error(`summary: ${text}`);
  if (!/older version/.test(text)) throw new Error(`no older version mentioned: ${text}`);
  if (!/can't be found/.test(text)) throw new Error(`the broken link was not reported: ${text}`);
  await win.screenshot({ path: join(out, 'export-dialog.png') });
  // The other choice is worked out afresh.
  const linked = text.match(/About \d+ [KMG]B/)?.[0];
  await dlg.getByText('The whole workspace').click();
  await win.waitForTimeout(1500);
  const whole = (await dlg.locator('.export-summary').innerText()).match(/About \d+ [KMG]B/)?.[0];
  if (!linked || !whole) throw new Error(`sizes: ${linked} then ${whole}`);
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await dlg.waitFor({ state: 'detached' });
});

await app.close();

// The folder is opened the way the recipient opens it: a page on a disk, in a plain browser.
const CHROME = process.env.LOCUS_CHROME ?? 'C:/Users/danie/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const problems = [];
page.on('pageerror', (e) => problems.push(String(e)));
page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
const start = (await readdir(join(out, 'folder'))).find((n) => n.startsWith('START HERE'));
await page.goto('file:///' + join(out, 'folder', start).replace(/\\/g, '/'));

await step('the viewer opens the note with no server and no install', async () => {
  await page.locator('.note h1', { hasText: 'Retry handling review' }).waitFor({ timeout: 20000 });
  if (!(await page.locator('.note a[data-path]').count())) throw new Error('the links lost what they point at');
  await page.screenshot({ path: join(out, 'viewer-opened.png') });
});

await step('a link opens the PDF at the cited page', async () => {
  await page.locator('.note a', { hasText: 'BDS-100 p5' }).click();
  await page.locator('[data-pane="docs"] .pdf-page canvas').first().waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  const shown = await page.locator('[data-pane="docs"] .toolbar input').first().inputValue();
  if (shown !== '5') throw new Error(`the PDF opened at page ${shown}`);
  await page.screenshot({ path: join(out, 'viewer-pdf.png') });
});

await step('a code link opens the lines, and an older version is marked', async () => {
  await page.locator('.note a', { hasText: 'a fixed sleep' }).click();
  await page.locator('[data-pane="docs"] .cm-cited-line').first().waitFor({ timeout: 20000 });
  const tab = page.locator('[data-pane="docs"] .tab.active');
  if (!(await tab.locator('.badge').count())) throw new Error('no version badge on a pinned link');
  await page.screenshot({ path: join(out, 'viewer-code.png') });
});

await step('a spreadsheet link opens the cells', async () => {
  await page.locator('.note a', { hasText: 'Bracket loads Margins' }).click();
  await page.locator('[data-pane="docs"] .cell.cited, [data-pane="docs"] .cited-box').first().waitFor({ timeout: 20000 });
  await page.screenshot({ path: join(out, 'viewer-sheet.png') });
});

await step('nothing in the viewer failed', async () => {
  // The worker warning PDF.js prints when it falls back is not a failure.
  const real = problems.filter((p) => !/Warning|deprecat/i.test(p));
  if (real.length) throw new Error(real.slice(0, 3).join(' | '));
});

await browser.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
