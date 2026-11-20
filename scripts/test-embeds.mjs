// Embedded views: a picture of a PDF page, a box on a page or a slide, and a table of cells, shown in
// the note. Live views follow the file when it changes on disk; pinned ones don't. Clicking opens
// the file, the corner resizes, the tools change the area or cells, turn it back into a link, or
// pin it. Views that can't be drawn say why, big ranges are cut short, and exports carry them.
//
//   npm run build && node scripts/make-test-workspace.mjs && node scripts/test-embeds.mjs
import { _electron as electron } from 'playwright';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deck, workbook } from './embed-fixtures.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(repo, 'test-output-embeds');
const userData = join(out, 'user-data');
const workspace = resolve(repo, '..', 'locus-test-workspace');
await rm(out, { recursive: true, force: true });
await mkdir(userData, { recursive: true });
await writeFile(join(userData, 'settings.json'), JSON.stringify({ claudeOffered: 'skip', recentWorkspaces: [workspace], dark: 'light', autosave: true }));

const dir = join(workspace, 'embeds');
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
await writeFile(join(dir, 'embed-deck.pptx'), await deck(1));
await writeFile(join(dir, 'embed-loads.xlsx'), await workbook(1));
const notePath = join(workspace, 'notes', 'embeds.md');
await writeFile(notePath, '# Embeds\n\n');

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
const embeds = () => win.locator('[data-pane="notes"] .cm-scroller:visible .cm-embed');
const toast = () => win.evaluate(() => document.querySelector('.toast')?.textContent ?? '');
const shot = (name) => win.screenshot({ path: join(out, `${name}.png`) });
const openNote = async () => {
  await win.keyboard.press('Control+O');
  await win.getByPlaceholder('Find a file by name').fill('embeds.md');
  await win.locator('.tree-row', { hasText: 'embeds.md' }).first().waitFor();
  await win.keyboard.press('Enter');
  await win.locator('[data-pane="notes"] .cm-content:visible', { hasText: 'Embeds' }).first().waitFor({ timeout: 10000 });
};
const openDoc = async (query, name) => {
  await win.keyboard.press('Control+P');
  await win.getByPlaceholder('Find a file by name').fill(query);
  await win.locator('.tree-row', { hasText: name }).first().waitFor();
  await win.keyboard.press('Enter');
};
/** Puts the cursor at the end of the note. */
const toEnd = async () => {
  await win.locator('[data-pane="notes"] .cm-content').click({ position: { x: 5, y: 5 } });
  await win.keyboard.press('Control+End');
};
/** Pictures drawn (loaded with a size) and tables shown in the note. */
const drawn = () =>
  win.evaluate(() =>
    [...document.querySelectorAll('[data-pane="notes"] .cm-embed')].filter((e) => e.offsetParent).map((e) => {
      const img = e.querySelector('img');
      const table = e.querySelector('table');
      return {
        kind: e.classList.contains('picture') ? 'picture' : e.classList.contains('table') ? 'table' : e.classList.contains('error') ? 'error' : 'loading',
        w: img?.naturalWidth ?? 0,
        h: img?.naturalHeight ?? 0,
        src: img?.src ?? '',
        text: (table ?? e.querySelector('.cm-embed-frame'))?.textContent ?? '',
        caption: e.querySelector('.cm-embed-caption')?.textContent ?? '',
        note: e.querySelector('.cm-embed-note')?.textContent ?? '',
        cells: table ? [...table.querySelectorAll('td')].map((td) => ({ t: td.textContent, span: td.colSpan })) : [],
        rows: table ? table.querySelectorAll('tr').length : 0,
      };
    }),
  );
const waitFor = async (pred, timeout = 10000) => {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) return v;
    await win.waitForTimeout(150);
  }
};
/** The picture's pixels, to tell whether it changed. */
const pixels = (i) =>
  win.evaluate(async (i) => {
    const img = [...document.querySelectorAll('[data-pane="notes"] .cm-embed')].filter((e) => e.offsetParent)[i]?.querySelector('img');
    if (!img) return '';
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 36;
    c.getContext('2d').drawImage(img, 0, 0, 64, 36);
    return c.toDataURL();
  }, i);
/** Waits for the name box over a new view's caption, and keeps the name it suggests. */
const named = async () => {
  await win.locator('[data-pane="notes"] .cm-renaming').waitFor({ timeout: 10000 });
  await win.keyboard.press('Enter');
};
const hoverTool = async (i, name) => {
  const e = embeds().nth(i);
  await e.hover();
  await e.locator('.cm-embed-tool', { hasText: name }).click();
};

try {
  await win.getByText('Bracket project').first().waitFor({ timeout: 15000 });
  await openNote();

  // ---- A picture of a whole PDF page ----
  await openDoc('BDS-100', 'BDS-100 Bracket Design Standard.pdf');
  await win.locator('.pdf-page canvas').first().waitFor({ timeout: 15000 });
  await toEnd();
  await win.getByRole('button', { name: 'Insert picture' }).click();
  await named();
  let d = await waitFor(async () => ((await drawn())[0]?.w > 0 ? drawn() : null));
  check(d?.[0]?.kind === 'picture' && d[0].w > 0, 'Insert picture on a PDF puts a picture of the page in the note');
  check(d?.[0] && Math.abs(d[0].h / d[0].w - 11 / 8.5) < 0.05, '…of the whole page (its shape is the page’s)');
  check(/Live/.test(d?.[0]?.caption ?? ''), '…marked Live under it');
  await win.waitForTimeout(1500);
  let text = await note();
  check(/!\[BDS-100 Bracket Design Standard p1\]\(<?\/docs\/BDS-100 Bracket Design Standard\.pdf#page=1&at=[0-9a-f]+>?\)/.test(text), 'the note holds a "!" reference with page and version');

  // ---- A box on the page ----
  await win.getByRole('button', { name: 'Area', exact: true }).click();
  const page = win.locator('.pdf-page').first();
  const pb = await page.boundingBox();
  await win.mouse.move(pb.x + pb.width * 0.15, pb.y + pb.height * 0.1);
  await win.mouse.down();
  await win.mouse.move(pb.x + pb.width * 0.6, pb.y + pb.height * 0.25, { steps: 6 });
  await win.mouse.up();
  await toEnd();
  await win.keyboard.press('Control+Shift+E');
  await named();
  d = await waitFor(async () => ((await drawn())[1]?.w > 0 ? drawn() : null));
  check(d?.[1]?.kind === 'picture', 'Ctrl+Shift+E with a box drawn puts a picture of the box in the note');
  check(d?.[1] && Math.abs(d[1].w / d[1].h - (0.45 * pb.width) / (0.15 * pb.height)) < 0.3, `…shaped like the box (${d?.[1]?.w}x${d?.[1]?.h} vs ${Math.round(0.45 * pb.width)}x${Math.round(0.15 * pb.height)})`);
  await win.waitForTimeout(1200);
  text = await note();
  check(/page=1&viewrect=\d+,\d+,\d+,\d+/.test(text), '…written with the box (viewrect)');

  // ---- Slides ----
  await openDoc('embed-deck', 'embed-deck.pptx');
  await win.waitForSelector('.pptx-preview-slide-wrapper', { timeout: 15000 });
  await waitFor(async () => (await win.locator('[data-pane="docs"] .viewer:not(.hidden) .pptx-preview-slide-wrapper').count()) >= 4, 15000);
  await win.waitForTimeout(1500);
  const slideInput = win.locator('[data-pane="docs"] .viewer:not(.hidden) .toolbar .page-input').last();
  await slideInput.fill('2');
  await slideInput.press('Enter');
  await win.waitForTimeout(800);
  await toEnd();
  await win.getByRole('button', { name: 'Insert picture' }).click();
  await named();
  d = await waitFor(async () => ((await drawn())[2]?.w > 0 ? drawn() : null), 15000);
  check(d?.[2]?.kind === 'picture' && Math.abs(d[2].w / d[2].h - 16 / 9) < 0.05, 'Insert picture on a deck puts a picture of the slide in the note');
  const slideBefore = await pixels(2);
  check(slideBefore.length > 100, '…drawn');
  await win.waitForTimeout(1200);
  text = await note();
  check(/!\[embed-deck slide 2\]\(\/embeds\/embed-deck\.pptx#slide=2&at=/.test(text), '…as a "!" reference to the slide');

  // ---- A table of cells ----
  await openDoc('embed-loads', 'embed-loads.xlsx');
  await win.locator('.name-box').waitFor({ timeout: 15000 });
  await win.locator('[data-pane="docs"]', { hasText: 'Quasi-static loads' }).waitFor({ timeout: 15000 });
  await win.waitForTimeout(500);
  await win.locator('.name-box').fill('A1:C6');
  await win.locator('.name-box').press('Enter');
  await win.waitForTimeout(300);
  await toEnd();
  await win.getByRole('button', { name: 'Insert table' }).click();
  await named();
  d = await waitFor(async () => ((await drawn())[3]?.kind === 'table' ? drawn() : null));
  const t = d?.[3];
  check(t?.kind === 'table', 'Insert table puts the cells in the note as a table');
  check(t && t.rows === 6 && t.cells.some((c) => c.t === 'Quasi-static loads' && c.span === 3), '…six rows, the merged title across three columns');
  check(t && t.cells.some((c) => c.t === '218.4') && t.cells.some((c) => c.t === 'Total'), '…with the values of formulas');
  check(
    await embeds().nth(3).evaluate((e) => !e.querySelector('[contenteditable="true"], input, textarea') && e.closest('[contenteditable="false"]') !== null),
    'the table has nothing to edit',
  );
  await shot('inserted');

  // ---- Live: the files change on disk ----
  await writeFile(join(dir, 'embed-loads.xlsx'), await workbook(2));
  d = await waitFor(async () => ((await drawn())[3]?.cells.some((c) => c.t === '254.8') ? drawn() : null));
  check(!!d, 'a live table shows the new values when the workbook changes on disk');
  await writeFile(join(dir, 'embed-deck.pptx'), await deck(2));
  const changed = await waitFor(async () => {
    const p = await pixels(2);
    return p && p !== slideBefore ? p : null;
  }, 15000);
  check(!!changed, 'a live slide picture is drawn again when the deck changes');

  // ---- Pin: the table goes back to the version it was cited from, and stays ----
  await hoverTool(3, '…');
  await win.locator('.cm-embed-popover button', { hasText: /^Pin to/ }).click();
  d = await waitFor(async () => ((await drawn())[3]?.cells.some((c) => c.t === '218.4') ? drawn() : null));
  check(!!d && /Pinned/.test(d[3].caption), 'Pin shows the cited version, marked Pinned');
  await win.waitForTimeout(1200);
  check(/!\[embed-loads Loads!A1:C6\]/.test(await note()) && /rev=/.test(await note()), '…and stays an embedded view, now pinned');
  await win.locator('[data-pane="notes"] .cm-line', { hasText: 'Embeds' }).first().click();
  await win.keyboard.press('Control+Z');
  await win.waitForTimeout(1200);
  check(/embed-loads\.xlsx#Loads!A1:C6&at=/.test(await note()), 'Ctrl+Z makes the pinned view live again');
  await win.keyboard.press('Control+Y');
  await win.waitForTimeout(1200);
  check(/embed-loads\.xlsx#Loads!A1:C6&rev=/.test(await note()), '…and Ctrl+Y pins it again');
  await writeFile(join(dir, 'embed-loads.xlsx'), await workbook(3));
  await win.waitForTimeout(2000);
  d = await drawn();
  check(d[3]?.cells.some((c) => c.t === '218.4'), 'a pinned table does not change when the workbook does');

  // ---- Click opens the file at the place ----
  await win.locator('[data-pane="docs"] .tab', { hasText: 'BDS-100' }).waitFor();
  await embeds().nth(1).locator('.cm-embed-frame').click();
  await win.waitForTimeout(800);
  const activeTab = await win.evaluate(() => document.querySelector('[data-pane="docs"] .tab.active')?.textContent ?? '');
  check(/BDS-100/.test(activeTab), 'clicking a picture opens its file on the right');

  // ---- Resize ----
  const e0 = embeds().nth(0);
  await e0.locator('.cm-image-handle').scrollIntoViewIfNeeded();
  await e0.hover();
  const hb = await e0.locator('.cm-image-handle').boundingBox();
  const frameW = (await e0.locator('.cm-embed-frame').boundingBox()).width;
  await win.mouse.move(hb.x + 5, hb.y + 5);
  await win.mouse.down();
  await win.mouse.move(hb.x - 150, hb.y + 5, { steps: 5 });
  await win.mouse.up();
  await win.waitForTimeout(1200);
  const newW = (await embeds().nth(0).locator('.cm-embed-frame').boundingBox()).width;
  check(newW < frameW - 100 && /page=1&at=[0-9a-f]+&w=\d+/.test(await note()), 'dragging the corner makes it smaller and records the width');
  await win.locator('[data-pane="notes"] .cm-line', { hasText: 'Embeds' }).first().click();
  await win.keyboard.press('Control+Z');
  await win.waitForTimeout(1200);
  check(!/page=1&at=[0-9a-f]+&w=/.test(await note()), 'Ctrl+Z undoes the resize');
  await win.keyboard.press('Control+Y');
  await win.waitForTimeout(1200);
  check(/page=1&at=[0-9a-f]+&w=\d+/.test(await note()), '…and Ctrl+Y redoes it');

  // ---- Show as link, and undo ----
  await hoverTool(0, 'Show as link');
  await win.waitForTimeout(300);
  check((await embeds().count()) === 3, 'Show as link turns the view into a link');
  await win.keyboard.press('Control+Z');
  await win.waitForTimeout(300);
  check((await embeds().count()) === 4, 'Ctrl+Z brings it back');

  // ---- Change cells ----
  await hoverTool(3, 'Change cells');
  await win.locator('.notice', { hasText: 'Select the cells' }).waitFor();
  await win.locator('.name-box:visible').fill('A2:B5');
  await win.locator('.name-box:visible').press('Enter');
  await win.getByRole('button', { name: 'Use these cells' }).click();
  d = await waitFor(async () => ((await drawn())[3]?.rows === 4 ? drawn() : null));
  check(!!d && /Pinned/.test(d[3].caption), 'Change cells shows the new cells, still pinned');
  await win.waitForTimeout(1200);
  check(/A2:B5&rev=/.test(await note()), '…and writes them into the view');
  check(/!\[embed-loads Loads!A2:B5\]/.test(await note()), '…and the name Locus suggested follows the new cells');

  await shot('after-tools');

  // ---- A box on a slide, then a different box with Change area ----
  await openDoc('embed-deck', 'embed-deck.pptx');
  await win.waitForTimeout(800);
  await slideInput.fill('2');
  await slideInput.press('Enter');
  await win.waitForTimeout(800);
  const slideEl = async () => {
    for (const el of await win.locator('[data-pane="docs"] .viewer:not(.hidden) .pptx-preview-slide-wrapper').all()) {
      const b = await el.boundingBox();
      if (b && b.height > 50 && b.y > 100 && b.y < 600) return b;
    }
    return (await win.locator('[data-pane="docs"] .viewer:not(.hidden) .pptx-preview-slide-wrapper').nth(1).boundingBox());
  };
  const drag = async (b, x0, y0, x1, y1) => {
    await win.mouse.move(b.x + b.width * x0, b.y + b.height * y0);
    await win.mouse.down();
    await win.mouse.move(b.x + b.width * x1, b.y + b.height * y1, { steps: 6 });
    await win.mouse.up();
  };
  await win.locator('[data-pane="docs"] .viewer:not(.hidden)').getByRole('button', { name: 'Area', exact: true }).click();
  let sb = await slideEl();
  await drag(sb, 0.1, 0.2, 0.6, 0.5);
  await toEnd();
  await win.keyboard.press('Control+Shift+E');
  await win.locator('[data-pane="notes"] .cm-renaming').waitFor({ timeout: 10000 });
  await win.keyboard.type('slide box');
  await win.keyboard.press('Enter');
  const slideBox = () => embeds().filter({ has: win.locator('.cm-embed-label:text-is("slide box")') }).first();
  const shape = () => slideBox().evaluate((e) => { const i = e.querySelector('img'); return i && i.naturalWidth ? i.naturalWidth / i.naturalHeight : 0; });
  let ratio = await waitFor(shape, 15000);
  check(Math.abs(ratio - (0.5 * 16) / (0.3 * 9)) < 0.25, `a box drawn on a slide becomes a picture of the box (shape ${ratio.toFixed(2)})`);
  await win.waitForTimeout(1200);
  check(/!\[slide box\]\(\/embeds\/embed-deck\.pptx#(slide=2&viewrect=\d+,\d+,\d+,\d+|viewrect=\d+,\d+,\d+,\d+&slide=2)&at=/.test(await note()), '…written with the slide and the box');
  await slideBox().hover();
  await slideBox().locator('.cm-embed-tool', { hasText: 'Change area' }).click();
  await win.locator('.notice', { hasText: 'Draw a box' }).waitFor();
  await win.waitForTimeout(800);
  sb = await slideEl();
  await drag(sb, 0.2, 0.2, 0.4, 0.8);
  await win.getByRole('button', { name: 'Use this box' }).click();
  ratio = await waitFor(async () => { const r = await shape(); return r && r < 1.5 ? r : 0; }, 15000);
  check(Math.abs(ratio - (0.2 * 16) / (0.6 * 9)) < 0.15, `Change area on a slide shows the new box (shape ${ratio.toFixed(2)})`);
  await win.waitForTimeout(1200);
  check(/!\[slide box\]/.test(await note()), '…keeping the name the user gave it');

  // ---- Trying to break it: references a person might write by hand, or that went stale ----
  const pdf = '/docs/BDS-100 Bracket Design Standard.pdf';
  const breakPath = join(workspace, 'notes', 'embeds-break.md');
  await writeFile(join(dir, 'small.csv'), 'Part,MS\nFlange,0.23\nBolt,1.00\n');
  await writeFile(
    breakPath,
    [
      '# Break',
      '',
      `Past the end ![p999](<${pdf}#page=999>)`,
      '',
      `![off page](<${pdf}#page=1&viewrect=5000,5000,100,100>)`,
      '',
      '![no sheet](/embeds/embed-loads.xlsx#Nope!A1:B2)',
      '',
      '![missing](/embeds/not-here.pdf#page=1)',
      '',
      '![bad pin](/embeds/embed-loads.xlsx#Loads!A1:C6&rev=deadbeefde)',
      '',
      "![long](</embeds/embed-loads.xlsx#'Long sheet'!A:C>)",
      '',
      '![slide 99](/embeds/embed-deck.pptx#slide=99)',
      '',
      '- in a list ![l](/embeds/embed-loads.xlsx#Loads!A1:B3)',
      '',
      '> in a quote ![q](/embeds/embed-loads.xlsx#Loads!A1:B3)',
      '',
      '![one](/embeds/embed-loads.xlsx#Loads!B3)',
      '',
      '![named](/embeds/embed-loads.xlsx#LoadTable)',
      '',
      '![csv](/embeds/small.csv#A1:B3)',
      '',
      '![totals](/embeds/embed-loads.xlsx#Loads!A1:C6)',
      '',
      '| view | note |',
      '| --- | --- |',
      '| ![cell](/embeds/embed-loads.xlsx#Loads!A1:B3) | in a table |',
      '',
      '![twice](/embeds/embed-deck.pptx#slide=3)',
      '',
      '![twice too](/embeds/embed-deck.pptx#slide=3)',
      '',
      'The end.',
      '',
    ].join('\n'),
  );
  await win.keyboard.press('Control+O');
  await win.getByPlaceholder('Find a file by name').fill('embeds-break.md');
  await win.locator('.tree-row', { hasText: 'embeds-break.md' }).first().waitFor();
  await win.keyboard.press('Enter');
  await win.locator('[data-pane="notes"] .cm-content', { hasText: 'Break' }).waitFor({ timeout: 10000 });
  await win.waitForTimeout(1500);
  // The editor only draws what is on screen, so each view is found by scrolling to it.
  const scroller = win.locator('[data-pane="notes"] .cm-scroller:visible');
  const byLabel = (name) => win.locator('[data-pane="notes"] .cm-scroller:visible .cm-embed', { has: win.locator(`.cm-embed-label:text-is("${name}")`) });
  /** Scrolls until the view is drawn, brings it on screen, and reads it once it has settled. */
  const find = async (name) => {
    if (await byLabel(name).count()) return true;
    await scroller.evaluate((s) => (s.scrollTop = 0));
    await win.waitForTimeout(100);
    for (let i = 0, still = 0; i < 200 && still < 4; i++) {
      if (await byLabel(name).count()) return true;
      const moved = await scroller.evaluate((s) => {
        const was = s.scrollTop;
        s.scrollTop += 250;
        return s.scrollTop !== was;
      });
      still = moved ? 0 : still + 1;
      await win.waitForTimeout(80);
    }
    return (await byLabel(name).count()) > 0;
  };
  const settle = async (name) => {
    const read = (x) => ({
      kind: ['picture', 'table', 'error'].find((k) => x.classList.contains(k)) ?? 'loading',
      msg: x.querySelector('.cm-embed-msg')?.textContent ?? '',
      help: x.querySelector('.cm-embed-help')?.textContent ?? '',
      cut: x.querySelector('.cm-embed-cut')?.textContent ?? '',
      rows: x.querySelectorAll('tr').length,
      w: x.querySelector('img')?.naturalWidth ?? 0,
    });
    const end = Date.now() + 20000;
    let last = { kind: 'missing' };
    while (Date.now() < end) {
      if (!(await find(name))) break;
      // The editor drops lines that scroll off screen (views above it may still be growing), so
      // a view that went away is simply looked for again.
      const r = await byLabel(name).first().evaluate((x) => (x.scrollIntoView({ block: 'center' }), true), null, { timeout: 2000 }).catch(() => false);
      if (r) {
        await win.waitForTimeout(250);
        last = await byLabel(name).first().evaluate(read, null, { timeout: 2000 }).catch(() => last);
        if (last.kind !== 'loading' && last.kind !== 'missing') return last;
      }
      await win.waitForTimeout(200);
    }
    console.log(`     (view "${name}" not settled: ${last.kind})`);
    return last;
  };
  const expectError = async (name, msg, what) => {
    const r = await settle(name);
    check(r.kind === 'error' && msg.test(r.msg) && r.help.length > 10, `${what}: says "${r.msg}" with a help line`);
  };
  await expectError('p999', /page 999/i, 'a page past the end');
  await expectError('off page', /outside/i, 'a box outside the page');
  await expectError('no sheet', /Nope/i, 'a sheet that does not exist');
  await expectError('missing', /not-here/i, 'a file that does not exist');
  await expectError('bad pin', /version/i, 'a pinned version that does not exist');
  const long = await settle('long');
  check(long.kind === 'table' && long.rows <= 201 && /\d/.test(long.cut), `a 400-row range is cut short and says so ("${long.cut}", ${long.rows} rows)`);
  await expectError('slide 99', /slide 99/i, 'a slide past the end');
  check((await settle('l')).kind === 'table' && (await settle('q')).kind === 'table', 'views inside a list and a quote are drawn');
  const one = await settle('one');
  check(one.kind === 'table' && one.rows === 1, 'a single cell is a one-cell table');
  const namedRange = await settle('named');
  check(namedRange.kind === 'table' && namedRange.rows > 1, 'a named range is drawn as its cells');
  const csv = await settle('csv');
  check(csv.kind === 'table' && csv.rows === 3, 'a CSV range is drawn as a table');
  const inTable = await win.evaluate(() => {
    const s = [...document.querySelectorAll('[data-pane="notes"] .cm-scroller')].find((x) => x.offsetParent);
    const cell = [...s.querySelectorAll('td, .cm-table-cell, [class*="table"]')].find((e) => /in a table/.test(e.textContent ?? ''));
    return cell ? (cell.closest('table, [class*="table"]')?.textContent ?? '').slice(0, 200) : 'no table';
  });
  console.log(`     note table with a view: ${JSON.stringify(inTable)}`);
  check(!/!\[cell\]\(/.test(inTable) || /cell/.test(inTable), 'a view in a note table cell does not break the table');
  const tw = await settle('twice');
  const tw2 = await settle('twice too');
  check(tw.kind === 'picture' && tw2.kind === 'picture' && tw.w > 0 && tw2.w > 0, 'the same view twice is drawn twice');
  const sideways = await win.evaluate(() => {
    const s = [...document.querySelectorAll('[data-pane="notes"] .cm-scroller')].find((x) => x.offsetParent);
    return s.scrollWidth - s.clientWidth;
  });
  check(sideways <= 1, `the note never scrolls sideways (${sideways}px)`);

  // Backspace after a view takes it away whole, and Ctrl+Z brings it back.
  const breakText = () => readFile(breakPath, 'utf8');
  const original = await breakText();
  await win.locator('[data-pane="notes"] .cm-line', { hasText: 'The end.' }).click();
  await win.keyboard.press('Home');
  await win.keyboard.press('ArrowUp');
  await win.keyboard.press('ArrowUp');
  await win.keyboard.press('End');
  await win.keyboard.press('Backspace');
  await win.waitForTimeout(1500);
  check(!(await breakText()).includes('![twice too]'), 'Backspace after a view removes the whole view');
  await win.keyboard.press('Control+Z');
  await win.waitForTimeout(1500);
  check((await breakText()) === original, '…and Ctrl+Z puts it back as it was');

  // Typing next to a view, and arrowing across it, doesn't get into its text.
  await win.keyboard.press('End');
  await win.keyboard.type(' after');
  await win.waitForTimeout(1200);
  check(/slide=3\) after\n/.test(await breakText()), 'typing after a view goes after it, not into it');
  await win.keyboard.press('Control+Z');

  // Record gives hand-written views a version, and they stay views.
  await win.getByRole('button', { name: 'Record' }).click();
  const recorded = await waitFor(async () => {
    const t = await breakText();
    return /!\[twice\]\([^)]*&at=/.test(t) ? t : '';
  }, 10000);
  check(/!\[twice\]\(\/embeds\/embed-deck\.pptx#slide=3&at=[0-9a-f]+\)/.test(recorded) && /!\[csv\]\(\/embeds\/small\.csv#A1:B3&at=/.test(recorded), 'Record gives hand-written views a version and keeps them views');

  // Dark
  await win.locator('button[title="Switch to dark mode"]').click();
  await win.waitForTimeout(600);
  await shot('break-dark');
  await settle('totals');
  const worst = await byLabel('totals').first().evaluate((e) => {
    const rgb = (c) => (c.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
    const lum = ([r, g, b]) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const frameBg = rgb(getComputedStyle(e.querySelector('.cm-embed-frame')).backgroundColor);
    let worst = { ratio: 99, text: '' };
    for (const td of e.querySelectorAll('td')) {
      if (!td.textContent.trim()) continue;
      const cs = getComputedStyle(td);
      const bgc = rgb(cs.backgroundColor);
      const bg = bgc.length === 4 && bgc[3] === 0 ? frameBg : bgc;
      const a = lum(rgb(cs.color)), b = lum(bg);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < worst.ratio) worst = { ratio: Math.round(ratio * 10) / 10, text: td.textContent };
    }
    return worst;
  });
  check(worst.ratio >= 3, `in dark mode every cell of a table reads (lowest contrast ${worst.ratio}:1, "${worst.text}")`);
  await win.locator('button[title="Switch to light mode"]').click();

  // ---- Export: pictures go in as pictures, tables as tables, broken ones as links ----
  const exportFile = join(out, 'break.html');
  await app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: f });
  }, exportFile);
  await win.locator('[data-pane="notes"] .tab', { hasText: 'embeds-break.md' }).click({ button: 'right' });
  await win.getByText('Export as a web page…').click();
  const html = await waitFor(() => readFile(exportFile, 'utf8').catch(() => ''), 20000);
  check(/<img src="data:image\/png;base64,/.test(html), 'an exported page carries the pictures inside it');
  check(/<table class="embed-table/.test(html) && /Axis/.test(html), '…and the tables as tables');
  check(/<a [^>]*href="[^"]*not-here\.pdf[^"]*"[^>]*>missing<\/a>/.test(html), '…and a view it can’t draw as a link');

  // ---- Many views in one note, and one of a file outside the workspace ----
  const outsidePdf = join(out, 'outside copy.pdf');
  await writeFile(outsidePdf, await readFile(join(workspace, 'docs', 'BDS-100 Bracket Design Standard.pdf')));
  const many = ['# Many', '', `![outside](<file:///${outsidePdf.replace(/\\/g, '/')}#page=2>)`, ''];
  for (let i = 0; i < 48; i++) {
    many.push(i % 3 === 2 ? `![cells ${i}](/embeds/embed-loads.xlsx#Loads!A1:C${2 + (i % 5)})` : `![page ${i}](<${pdf}#page=${1 + (i % 8)}&viewrect=50,${40 + i},300,120>)`, '');
  }
  many.push('Last line.', '');
  await writeFile(join(workspace, 'notes', 'embeds-many.md'), many.join('\n'));
  const t0 = Date.now();
  await win.keyboard.press('Control+O');
  await win.getByPlaceholder('Find a file by name').fill('embeds-many.md');
  await win.locator('.tree-row', { hasText: 'embeds-many.md' }).first().waitFor();
  await win.keyboard.press('Enter');
  await win.locator('[data-pane="notes"] .cm-content', { hasText: 'Many' }).waitFor({ timeout: 10000 });
  const outside = await settle('outside');
  const still = await byLabel('outside').first().evaluate(async (e) => {
    let changes = 0;
    const mo = new MutationObserver((ms) => (changes += ms.length));
    mo.observe(e.parentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'class'] });
    const tops = [];
    for (let i = 0; i < 10; i++) {
      tops.push(Math.round(e.getBoundingClientRect().top));
      await new Promise((r) => setTimeout(r, 150));
    }
    mo.disconnect();
    return { changes, moved: new Set(tops).size > 1, tops, connected: e.isConnected };
  });
  check(still.changes === 0 && !still.moved && still.connected, `a view outside the workspace holds still once drawn (${JSON.stringify(still)})`);
  check(outside.kind === 'picture' && outside.w > 0, 'a view of a PDF outside the workspace is drawn');
  check(/Outside/.test(await byLabel('outside').first().locator('.cm-embed-caption').textContent()), '…marked Outside');
  const firstScreen = Date.now() - t0;
  const last = await settle('cells 47');
  const lastPage = await settle('page 46');
  const allTime = Date.now() - t0;
  check(last.kind === 'table' && lastPage.kind === 'picture', `fifty views in one note are all drawn (first screen ${firstScreen} ms, scrolled to the end ${allTime} ms)`);
  check(allTime < 30000, '…in reasonable time');

  // ---- A note shown read-only on the right shows its views, without the tools that change it ----
  await win.keyboard.press('Control+P');
  await win.getByPlaceholder('Find a file by name').fill('embeds-break.md');
  await win.locator('.tree-row', { hasText: 'embeds-break.md' }).first().waitFor();
  await win.keyboard.press('Enter');
  const right = win.locator('[data-pane="docs"] .viewer:not(.hidden) .cm-embed');
  const shown = await waitFor(async () => ((await right.count()) > 0 ? right.count() : 0), 10000);
  if (shown) {
    await right.first().hover();
    const tools = await right.first().locator('.cm-embed-tool').allTextContents();
    const handle = await right.first().locator('.cm-image-handle').count();
    check(!tools.some((t) => /Change|Show as link/.test(t)) && handle === 0, `the read-only note on the right shows its views with only Open and … (${tools.join(', ')})`);
  } else check(false, 'the note opened on the right shows its views');

  // ---- A view in a flowchart box ----
  await writeFile(
    join(workspace, 'notes', 'embeds-flow.canvas'),
    JSON.stringify({
      nodes: [
        { id: 'a', type: 'text', text: 'Loads\n![box table](/embeds/embed-loads.xlsx#Loads!A1:B3)', x: 0, y: 0, width: 260, height: 160 },
        { id: 'b', type: 'text', text: 'Next', x: 0, y: 260, width: 160, height: 60 },
      ],
      edges: [{ id: 'e', fromNode: 'a', toNode: 'b', fromSide: 'bottom', toSide: 'top' }],
    }),
  );
  await win.keyboard.press('Control+O');
  await win.getByPlaceholder('Find a file by name').fill('embeds-flow');
  await win.locator('.tree-row', { hasText: 'embeds-flow' }).first().waitFor();
  await win.keyboard.press('Enter');
  await win.locator('.flow-box', { hasText: 'Next' }).waitFor({ timeout: 10000 });
  await win.waitForTimeout(2500);
  const box = await win.locator('.flow-box', { hasText: 'Loads' }).first().evaluate((b) => ({
    embed: b.querySelector('.cm-embed')?.className ?? '',
    rows: b.querySelectorAll('.cm-embed tr').length,
    overflow: b.scrollWidth > b.clientWidth + 2,
    text: b.textContent.slice(0, 80),
  }));
  await shot('flow-embed');
  // A box is small: a view in it shows as a link to the cells, which opens them.
  const chip = win.locator('.flow-box .cm-ref', { hasText: 'box table' });
  check(!box.embed && (await chip.count()) === 1 && !(await win.locator('.flow-box img').count()), `a view in a flowchart box shows as a link, not a broken picture (${JSON.stringify(box)})`);

  // ---- Export for someone without Locus: a view goes as a link, and its file goes with it ----
  const folderOut = join(out, 'folder-export');
  await mkdir(folderOut, { recursive: true });
  const done = await win.evaluate(
    ([md, dest]) => window.api.writeExport('/notes/embeds-break.md', md, 'linked', dest),
    [await breakText(), folderOut],
  );
  const listAll = async (d) => {
    const { readdir } = await import('node:fs/promises');
    const found = [];
    for (const e of await readdir(d, { withFileTypes: true })) {
      if (e.isDirectory()) found.push(...(await listAll(join(d, e.name))));
      else found.push(e.name);
    }
    return found;
  };
  const exported = done?.folder ? await listAll(done.folder) : [];
  check(exported.some((n) => n === 'embed-loads.xlsx') && exported.some((n) => n === 'embed-deck.pptx'), `a folder export carries the files its views show (${exported.filter((n) => /embed|csv/.test(n)).join(', ')})`);

  // ---- A live view of a file that was deleted shows the version it was cited from ----
  await openNote();
  await rm(join(dir, 'embed-deck.pptx'));
  d = await waitFor(async () => {
    const all = await drawn();
    return all[2]?.kind === 'picture' && /no longer in the workspace/.test(all[2].note) ? all : null;
  }, 15000);
  check(!!d, `a live slide whose deck was deleted shows the cited version, and says so ("${(await drawn())[2]?.note}")`);
  await shot('deleted');
  const wide = await win.evaluate(() => {
    const s = [...document.querySelectorAll('[data-pane="notes"] .cm-scroller')].find((x) => x.offsetParent);
    const right = s.getBoundingClientRect().right;
    const over = [...s.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > right + 1).slice(0, 4).map((e) => `${e.className} ${Math.round(e.getBoundingClientRect().right - right)}`);
    const shifted = [];
    for (let e = s; e; e = e.parentElement) if (e.scrollLeft) shifted.push(`${e.tagName}.${e.className} ${e.scrollLeft}`);
    for (const e of s.querySelectorAll('*')) if (e.scrollLeft) shifted.push(`${e.tagName}.${e.className} ${e.scrollLeft}`);
    return { by: s.scrollWidth - s.clientWidth, left: s.scrollLeft, over, shifted };
  });
  check(wide.by <= 1 && wide.left === 0 && !wide.shifted.length, `the note with views never scrolls sideways (${JSON.stringify(wide)})`);
} catch (e) {
  failures++;
  console.log('FAIL', e);
  await shot('failure').catch(() => undefined);
} finally {
  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.slice(0, 5).join(' | ')}` : ''}`);
  await app.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
