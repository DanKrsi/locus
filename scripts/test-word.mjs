// Word documents: shown page by page, cited by paragraph (selected text or the paragraph being
// read), links land on their paragraphs highlighted, "Cited in" markers, live links that follow a
// paragraph that moved, a picture of paragraphs in the note, and old .doc files explained.
//
//   npm run build && node scripts/make-test-workspace.mjs && node scripts/test-word.mjs
import { _electron as electron } from 'playwright';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { memo, MEMO } from './word-fixtures.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(repo, 'test-output-word');
const userData = join(out, 'user-data');
const workspace = resolve(repo, '..', 'locus-test-workspace');
await rm(out, { recursive: true, force: true });
await mkdir(userData, { recursive: true });
await writeFile(join(userData, 'settings.json'), JSON.stringify({ claudeOffered: 'skip', recentWorkspaces: [workspace], dark: 'light', autosave: true }));

const dir = join(workspace, 'word');
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'Bracket memo.docx'), await memo(1));
await writeFile(join(dir, 'Old memo.doc'), Buffer.from('D0CF11E0A1B11AE1', 'hex'));
await writeFile(join(dir, 'Old deck.ppt'), Buffer.from('D0CF11E0A1B11AE1', 'hex'));
{
  const { default: PptxGen } = await import('pptxgenjs');
  const pres = new PptxGen();
  pres.layout = 'LAYOUT_16x9';
  pres.addSlide().addText('Rental market review', { x: 0.5, y: 0.5, w: 9, h: 1, fontSize: 32 });
  const s = pres.addSlide();
  s.addText('Vacancy fell to a three year low', { x: 1, y: 2, w: 6, h: 0.6, fontSize: 20 });
  s.addNotes('Mention that the survey covered 1,200 units.');
  await writeFile(join(dir, 'Review deck.pptx'), Buffer.from(await pres.write({ outputType: 'nodebuffer' })));
}
const notePath = join(workspace, 'notes', 'word.md');
await writeFile(notePath, '# Word\n\n');
const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8' }).trim();
git('add', '-A');
git('commit', '-q', '-m', 'Word files');

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

const app = await electron.launch({ args: [repo], env: { ...process.env, LOCUS_USER_DATA: userData } });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1500, height: 950 });
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
win.on('console', (m) => m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text()) && errors.push('console: ' + m.text()));

const note = () => readFile(notePath, 'utf8');
/** The note once it has what is wanted (it is saved a moment after a change), or as it is after a while. */
const noteWith = async (re, ms = 8000) => {
  for (const end = Date.now() + ms; ; ) {
    const t = await note();
    if (re.test(t) || Date.now() > end) return t;
    await new Promise((r) => setTimeout(r, 200));
  }
};
const shot = (name) => win.screenshot({ path: join(out, `${name}.png`) });
const open = async (query, name, key = 'Control+P') => {
  await win.keyboard.press(key);
  await win.getByPlaceholder('Find a file by name').fill(query);
  await win.locator('.tree-row', { hasText: name }).first().waitFor();
  await win.keyboard.press('Enter');
};
const toEnd = async () => {
  await win.locator('[data-pane="notes"] .cm-content:visible').click({ position: { x: 5, y: 5 } });
  await win.keyboard.press('Control+End');
};
const word = () => win.locator('[data-pane="docs"] .word-host:visible');

try {
  await win.getByText('Bracket project').first().waitFor({ timeout: 15000 });
  await open('word.md', 'word.md', 'Control+O');
  await win.locator('[data-pane="notes"] .cm-content:visible', { hasText: 'Word' }).first().waitFor({ timeout: 10000 });

  // ---------- Shown ----------
  await open('Bracket memo', 'Bracket memo.docx');
  await word().locator('section.docx').first().waitFor({ timeout: 15000 });
  await win.waitForTimeout(500);
  const shown = await win.evaluate(() => {
    const host = document.querySelector('[data-pane="docs"] .word-host');
    return {
      pages: host.querySelectorAll('section.docx').length,
      title: host.querySelector('article p')?.textContent,
      table: host.querySelectorAll('table td').length,
      img: [...host.querySelectorAll('img')].filter((i) => i.naturalWidth > 0).length,
      footnote: host.textContent.includes('Taken from the load table.'),
      toolbar: document.querySelector('[data-pane="docs"] .toolbar')?.textContent ?? '',
    };
  });
  await shot('01-shown');
  check(shown.pages >= 2, `the memo is shown on its pages (${shown.pages})`);
  check(shown.title === 'Bracket design memo', 'the title is the first paragraph');
  check(shown.table === 6, 'the table is drawn');
  check(shown.img === 1, 'the picture inside the document is drawn');
  check(shown.footnote, 'the footnote is drawn');
  check(/Page 1 of \d/.test(shown.toolbar), `the toolbar says which page (${shown.toolbar.match(/Page[^A-Z]*/)?.[0]})`);

  // A real drag selects text on the page (not only a selection made by script).
  const titleBox = await word().locator('article p').first().boundingBox();
  await win.mouse.move(titleBox.x + 2, titleBox.y + titleBox.height / 2);
  await win.mouse.down();
  await win.mouse.move(titleBox.x + titleBox.width * 0.5, titleBox.y + titleBox.height / 2, { steps: 8 });
  await win.mouse.up();
  const draggedWord = await win.evaluate(() => getSelection().toString());
  check(/^Bracket/.test(draggedWord), `text in the document can be selected with the mouse ("${draggedWord}")`);
  await win.evaluate(() => getSelection().removeAllRanges());

  // ---------- Cite selected text ----------
  const selectText = (text) =>
    win.evaluate((text) => {
      const host = document.querySelector('[data-pane="docs"] .word-host');
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = n.textContent.indexOf(text);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + text.length);
        n.parentElement.scrollIntoView({ block: 'center' });
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        return true;
      }
      return false;
    }, text);
  const citeButton = () => win.locator('[data-pane="docs"] .cite-split:visible .cite').first();
  const named = async () => {
    await win.locator('[data-pane="notes"] .cm-renaming').waitFor({ timeout: 10000 });
    await win.keyboard.press('Enter');
  };
  await toEnd();
  check(await selectText(MEMO.load), 'text in the document can be selected');
  await citeButton().click();
  await named();
  await win.waitForTimeout(1200);
  let text = await note();
  const cited = text.match(/\[([^\]]+)\]\((<[^>]+>|\S+)(?: "([^"]*)")?\)/);
  check(!!cited && /Bracket memo\.docx#para=3&at=[0-9a-f]{10}/.test(cited[2]), `citing the selection links its paragraph (${cited?.[2]})`);
  check(cited?.[3] === MEMO.load, `…and quotes it (${cited?.[3]})`);
  check(cited?.[1] === 'Bracket memo para 3', `…with a name to keep or change (${cited?.[1]})`);

  // Across paragraphs: the list's two items.
  await win.keyboard.press('End');
  await win.keyboard.type(' and ');
  await win.evaluate(() => {
    const ps = [...document.querySelectorAll('[data-pane="docs"] .word-host article p')];
    const a = ps.find((p) => p.textContent.startsWith('Bolts are'));
    const b = ps.find((p) => p.textContent.startsWith('The flange'));
    const r = document.createRange();
    r.setStart(a.firstChild, 0);
    r.setEnd(b.lastChild, b.lastChild.childNodes.length);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  });
  await citeButton().click();
  await named();
  await win.waitForTimeout(1200);
  text = await note();
  check(/#para=5-6&at=/.test(text), 'a selection across two paragraphs links both');

  // Nothing selected: the paragraph being read, quoting its first words.
  await win.keyboard.press('End');
  await win.keyboard.type(' and ');
  await win.evaluate(() => {
    // Leave the note first: emptying the page's selection while the note has the focus moves its cursor.
    document.activeElement?.blur();
    getSelection().removeAllRanges();
    const ps = [...document.querySelectorAll('[data-pane="docs"] .word-host article p')];
    const p = ps.find((x) => x.textContent.startsWith('Paragraph 3 of'));
    const scroller = document.querySelector('[data-pane="docs"] .word-scroll');
    scroller.scrollTop += p.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientHeight * 0.3 + 4;
  });
  await win.waitForTimeout(300);
  await citeButton().click();
  await named();
  await win.waitForTimeout(1200);
  text = await note();
  const reading = [...text.matchAll(/\]\((<[^>]+>|\S+)(?: "([^"]*)")?\)/g)].pop();
  check(/#para=19&at=/.test(reading?.[1] ?? '') && /^Paragraph 3 of the background\. The bracket sits/.test(reading?.[2] ?? ''), `with nothing selected, the paragraph being read is cited (${reading?.[1]} "${reading?.[2]}")`);
  const fatiguePara = Number(reading?.[1].match(/para=(\d+)/)?.[1]);
  await shot('02-cited');

  // ---------- Land on it ----------
  const scroller = () => win.evaluate(() => document.querySelector('[data-pane="docs"] .word-scroll').scrollTop);
  await win.evaluate(() => (document.querySelector('[data-pane="docs"] .word-scroll').scrollTop = 0));
  await win.locator('.cm-ref', { hasText: 'Bracket memo para ' + fatiguePara }).first().click();
  await win.waitForTimeout(1500);
  const landed = await win.evaluate(() => {
    const els = [...document.querySelectorAll('[data-pane="docs"] .word-host p.word-cited')];
    const s = document.querySelector('[data-pane="docs"] .word-scroll').getBoundingClientRect();
    const b = els[0]?.getBoundingClientRect();
    return { n: els.length, text: els.map((e) => e.textContent).join('|'), mid: b ? (b.top + b.bottom) / 2 - s.top : -1, h: s.height };
  });
  await shot('03-landed');
  check(landed.n === 1 && landed.text.startsWith('Paragraph 3 of'), `clicking the link highlights its paragraph (${landed.text})`);
  check(landed.mid > landed.h * 0.25 && landed.mid < landed.h * 0.75, `…in the middle of the view (${Math.round(landed.mid)} of ${Math.round(landed.h)})`);
  check((await scroller()) > 0, '…scrolled to it');
  await win.locator('.cm-ref', { hasText: 'Bracket memo para 5' }).first().click();
  await win.waitForTimeout(1500);
  const two = await win.evaluate(() => [...document.querySelectorAll('[data-pane="docs"] .word-host p.word-cited')].map((e) => e.textContent));
  check(two.length === 2 && two[0].startsWith('Bolts') && two[1].startsWith('The flange'), 'a link to two paragraphs highlights both');

  // ---------- Cited in ----------
  const flags = await win.evaluate(() => [...document.querySelectorAll('[data-pane="docs"] .cite-marker.word-flag')].filter((f) => f.offsetParent).length);
  check(flags >= 3, `"Cited in" flags sit beside the cited paragraphs (${flags})`);

  // ---------- A picture of paragraphs in the note ----------
  await toEnd();
  await win.keyboard.press('Enter');
  await win.keyboard.press('Enter');
  check(await selectText('Fatigue was checked'), 'the fatigue sentence can be selected');
  await win.keyboard.press('Control+Shift+E');
  await named();
  const embed = win.locator('[data-pane="notes"] .cm-scroller:visible .cm-embed').first();
  await embed.waitFor({ timeout: 15000 });
  await win.waitForFunction(() => {
    const img = document.querySelector('[data-pane="notes"] .cm-embed img');
    return img && img.complete && img.naturalWidth > 0;
  }, null, { timeout: 20000 });
  // Read the picture's pixels: a blank cut, or one that slipped onto the lines above or below,
  // would still have a size.
  const pic = await win.evaluate(async () => {
    const img = document.querySelector('[data-pane="notes"] .cm-embed img');
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const dark = (x, y) => {
      const i = (y * c.width + x) * 4;
      return data[i] + data[i + 1] + data[i + 2] < 384;
    };
    let ink = 0;
    let right = 0;
    const rowInk = (y) => {
      let n = 0;
      for (let x = 0; x < c.width; x++) if (dark(x, y)) n++;
      return n;
    };
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++)
        if (dark(x, y)) {
          ink++;
          right = Math.max(right, x);
        }
    return { w: c.width, h: c.height, ink, right: right / c.width, edges: rowInk(0) + rowInk(1) + rowInk(c.height - 1) + rowInk(c.height - 2) };
  });
  await embed.scrollIntoViewIfNeeded();
  await shot('04-picture');
  text = await noteWith(/!\[/);
  check(/!\[[^\]]*\]\(<?\/word\/Bracket memo\.docx#para=\d+&at=/.test(text), 'Ctrl+Shift+E with text selected puts a picture link in the note');
  check(pic.w > 400 && pic.h > 20 && pic.h < 160, `…drawn as a picture one line tall (${pic.w}×${pic.h})`);
  // The fatigue sentence is one line about two thirds of the text width; no line above or below is cut into.
  check(pic.ink > 500 && pic.right > 0.4 && pic.right < 0.85 && pic.edges === 0, `…showing the sentence, not the lines around it (ink ${pic.ink}, reaches ${Math.round(pic.right * 100)}% across, ${pic.edges} dark pixels on the edges)`);

  // ---------- Links follow edits ----------
  // Version 2 adds a paragraph near the top: every cited paragraph after it is one higher now.
  await win.waitForTimeout(1500);
  git('add', '-A');
  git('commit', '-q', '-m', 'Note with Word links');
  await writeFile(join(dir, 'Bracket memo.docx'), await memo(2));
  await win.keyboard.press('Control+Shift+S');
  await win.getByLabel('Version name').waitFor({ timeout: 5000 }).catch(() => undefined);
  await win.keyboard.press('Enter');
  const summary = win.locator('.upkeep-summary');
  const updated = win.locator('.notice', { hasText: /Updated \d+ links?/ });
  await Promise.race([summary.waitFor({ timeout: 20000 }), updated.waitFor({ timeout: 20000 })]);
  if (await summary.isVisible().catch(() => false)) {
    const said = await summary.innerText();
    check(/can follow by (itself|themselves)/.test(said), `the summary offers the links that moved (${said.split('\n').join(' | ')})`);
    await summary.getByRole('button', { name: /^Update the \d+/ }).click();
    await updated.waitFor({ timeout: 15000 }).catch(() => undefined);
    await win.locator('.review-bar').getByRole('button', { name: 'Stop reviewing' }).click({ timeout: 5000 }).catch(() => undefined);
  }
  text = await noteWith(/#para=20&at=/, 15000);
  check(/\[Bracket memo para 4\]\([^)]*#para=4&at=[^)]*"design load of 12 kN"\)/.test(text), `the quoted link follows its paragraph down one, name and all (${text.match(/\[[^\]]*\]\([^)]*design load[^)]*\)/)?.[0]})`);
  check(/#para=6-7&at=/.test(text), 'the link to two paragraphs follows them');
  check(/#para=20&at=/.test(text), 'the link to the paragraph being read follows it');
  await shot('05-followed');

  // ---------- Old .doc files ----------
  await open('Old memo', 'Old memo.doc');
  const old = win.locator('[data-pane="docs"] .viewer:not(.hidden)', { hasText: 'old .doc format' });
  await old.waitFor({ timeout: 10000 });
  const oldText = await old.innerText();
  check(/Save As/.test(oldText) && /\.docx/.test(oldText), 'an old .doc file says how to save it as .docx');
  check((await old.getByRole('button', { name: /Cite file/ }).count()) > 0, '…and can still be cited as a whole file');
  await shot('06-old-doc');

  // ---------- PowerPoint: speaker notes, citing selected words, old .ppt ----------
  await open('Review deck', 'Review deck.pptx');
  const slides = win.locator('[data-pane="docs"] .viewer:not(.hidden) .slides-host');
  await slides.locator('.pptx-preview-slide-wrapper').first().waitFor({ timeout: 15000 });
  await win.waitForTimeout(800);
  const notesShown = await win.evaluate(() => [...document.querySelectorAll('[data-pane="docs"] .viewer:not(.hidden) .slide-notes')].map((n) => n.textContent));
  check(notesShown.length === 1 && /slide 2/.test(notesShown[0]) && /survey covered 1,200 units/.test(notesShown[0]), `speaker notes show under their slide (${notesShown.join(' | ')})`);
  // The link review opened another note; back to this one.
  await win.locator('.notice .icon').click({ timeout: 2000 }).catch(() => undefined);
  await win.locator('[data-pane="notes"] .tabs > .tab', { hasText: 'word.md' }).click();
  await toEnd();
  await win.keyboard.press('Enter');
  await win.keyboard.type('Deck: ');
  // Where the words are on screen, then a real drag across them, the way a person selects.
  const span = await win.evaluate(() => {
    const host = document.querySelector('[data-pane="docs"] .viewer:not(.hidden) .slides-host');
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.textContent.indexOf('three year low');
      if (i < 0 || n.parentElement.closest('.slide-notes')) continue;
      n.parentElement.scrollIntoView({ block: 'center' });
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + 'three year low'.length);
      const b = r.getBoundingClientRect();
      return { x0: b.left + 1, x1: b.right - 1, y: (b.top + b.bottom) / 2 };
    }
    return null;
  });
  if (span) {
    await win.mouse.move(span.x0, span.y);
    await win.mouse.down();
    await win.mouse.move(span.x1, span.y, { steps: 8 });
    await win.mouse.up();
  }
  const dragged = await win.evaluate(() => getSelection().toString());
  check(/three year lo/.test(dragged), `words on a slide can be selected with the mouse ("${dragged}")`);
  await citeButton().click();
  await named();
  text = await noteWith(/Review deck\.pptx#[^)]*slide=2/);
  const deckLink = text.match(/\]\((<\/word\/Review deck\.pptx#[^>]+>) "([^"]*)"\)/);
  check(/viewrect=\d+,\d+,\d+,\d+/.test(deckLink?.[1] ?? '') && /slide=2/.test(deckLink?.[1] ?? ''), `citing selected words links the slide with a box around them (${deckLink?.[1]})`);
  check(/three year lo/.test(deckLink?.[2] ?? ''), `…and quotes them (${deckLink?.[2]})`);
  const box = deckLink?.[1].match(/viewrect=(\d+),(\d+),(\d+),(\d+)/)?.slice(1).map(Number) ?? [0, 0, 0, 0];
  // The words sit in a box 1 in from the left, 2 in down (96 points to the inch), one line tall.
  check(box[0] >= 90 && box[0] < 400 && box[1] >= 180 && box[1] < 290 && box[3] < 80, `…a box where the words are (${box.join(',')})`);
  await shot('07-deck');

  await open('Old deck', 'Old deck.ppt');
  const oldPpt = win.locator('[data-pane="docs"] .viewer:not(.hidden)', { hasText: 'old .ppt format' });
  await oldPpt.waitFor({ timeout: 10000 });
  check(/PowerPoint Presentation \(\*\.pptx\)/.test(await oldPpt.innerText()), 'an old .ppt file says how to save it as .pptx');

  // ---------- Exports ----------
  const api = (m, ...a) => win.evaluate(([m, a]) => window.api[m](...a), [m, a]);
  const md = await api('readText', '/notes/word.md');
  // Through the app's own menu: only the app can draw the pictures that go inside the page.
  const pageFile = join(out, 'word.html');
  await app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: f });
  }, pageFile);
  await win.locator('[data-pane="notes"] .tab', { hasText: 'word.md' }).click({ button: 'right' });
  await win.getByText('Export as a web page…').click();
  let page = '';
  for (const end = Date.now() + 20000; !page && Date.now() < end; await win.waitForTimeout(300)) page = await readFile(pageFile, 'utf8').catch(() => '');
  check(/<img src="data:image\/png;base64,[A-Za-z0-9+/=]{200,}"[^>]*alt="Bracket memo para 33"/.test(page), 'a web page of the note carries the Word picture inside it');
  const done = await api('writeExport', '/notes/word.md', md, 'linked', join(out, 'folder'));
  check(!done.failed.length, `the folder for someone without Locus is written (${done.failed.join(', ') || 'nothing failed'})`);

  console.log(errors.length ? errors.join('\n') : 'no page errors');
} catch (e) {
  console.error(e);
  failures++;
  await shot('zz-failure').catch(() => undefined);
} finally {
  await app.close();
}

// The exported folder, opened the way the recipient opens it: a page on a disk, in a plain browser.
try {
  const { chromium } = await import('playwright');
  const { readdir } = await import('node:fs/promises');
  const CHROME = process.env.LOCUS_CHROME ?? 'C:/Users/danie/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const problems = [];
  page.on('pageerror', (e) => problems.push(String(e)));
  const start = (await readdir(join(out, 'folder'))).find((n) => n.startsWith('START HERE'));
  await page.goto('file:///' + join(out, 'folder', start).replace(/\\/g, '/'));
  await page.locator('.note a', { hasText: 'Bracket memo para 4' }).click({ timeout: 20000 });
  await page.locator('[data-pane="docs"] .word-host p.word-cited').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  const lit = await page.evaluate(() => [...document.querySelectorAll('[data-pane="docs"] .word-host p.word-cited')].map((p) => p.textContent).join('|'));
  await page.screenshot({ path: join(out, '08-export-viewer.png') });
  check(/design load of 12 kN/.test(lit), `in the exported folder, a paragraph link opens the document with the paragraph highlighted (${lit.slice(0, 80)})`);
  check(!problems.length, `nothing in the exported viewer failed (${problems.slice(0, 2).join(' | ')})`);
  await browser.close();
} catch (e) {
  console.error(e);
  failures++;
}
console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
