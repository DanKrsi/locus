// A user having a messy week in the demo workspace: renaming, moving, editing, duplicating,
// deleting and replacing files, saving versions sometimes and not others, and seeing whether
// Locus keeps every link pointing where it should.
// It is a read of how the app behaves, not a pass/fail suite: it prints what the app said at each
// step and lists anything a user would call a broken link.
// Usage: npm run build && node scripts/test-chaos.mjs [first-scene] [last-scene]
import { _electron as electron } from 'playwright';
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const out = join(repo, 'test-output', 'chaos');
const ws = join(out, 'Locus demo');
const first = Number(process.argv[2] ?? 1);
const last = Number(process.argv[3] ?? 99);

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'user-data'), { recursive: true });
await writeFile(join(out, 'user-data', 'settings.json'), JSON.stringify({ claudeOffered: 'skip', recentWorkspaces: [], dark: 'light' }));

let app = await electron.launch({ args: [repo], env: { ...process.env, LOCUS_USER_DATA: join(out, 'user-data') } });
let win = await app.firstWindow();
const watch = () => {
  win.on('pageerror', (e) => note('PAGE ERROR: ' + String(e).split('\n')[0]));
  win.on('console', (m) => m.type() === 'error' && note('CONSOLE: ' + m.text().slice(0, 160)));
};
const restart = (a, w) => {
  app = a;
  win = w;
  watch();
};
await win.setViewportSize({ width: 1500, height: 950 });
watch();
app.process().stderr?.on('data', (d) => {
  const t = String(d).trim();
  if (t) console.log('     MAIN: ' + t.slice(0, 400));
});
app.process().on('exit', (code) => code && console.log(`     *** the app exited with code ${code} ***`));

const api = (m, ...a) => win.evaluate(([m, a]) => window.api[m](...a), [m, a]);
let shots = 0;
const shot = async (name) => {
  await win.waitForTimeout(350);
  await win.screenshot({ path: join(out, `${String(++shots).padStart(2, '0')}-${name}.png`) });
};
const findings = [];
const note = (s) => console.log(`     ${s}`);
const problem = (s) => {
  findings.push(s);
  console.log(`  !! ${s}`);
};

/** Every link in every note, with whether its file is there now and in the version it cites. */
const links = () =>
  win.evaluate(async () => {
    const files = await window.api.listFiles();
    const rows = [];
    for (const n of files.filter((f) => /\.(md|canvas)$/i.test(f))) {
      const text = await window.api.readText(n).catch(() => '');
      for (const m of text.matchAll(/\[([^\]\n]*)\]\(<?(\/[^)\s>]+)(?:\s+"[^"]*")?>?\)/g)) {
        const [p, frag = ''] = m[2].split('#');
        const path = decodeURIComponent(p);
        const rev = /(?:^|&)rev=([0-9a-f]+)/.exec(frag)?.[1];
        const at = /(?:^|&)at=([0-9a-f]+)/.exec(frag)?.[1];
        rows.push({
          note: n,
          label: m[1],
          path,
          frag,
          at,
          rev,
          now: await window.api.exists(path).catch(() => false),
          then: rev || at ? await window.api.exists(path, rev ?? at).catch(() => false) : null,
        });
      }
    }
    return rows;
  });

/**
 * Prints the state of every link. A link is only a problem when nothing can be shown for it:
 * a file that has left the workspace is fine as long as the version it cites can still be read,
 * because that is what the link opens.
 */
async function report(label) {
  const rows = await links();
  // The demo ships one deliberately broken link, to show what one looks like.
  const real = rows.filter((r) => !r.path.includes('old-analysis'));
  const bad = real.filter((r) => !r.now && !r.then);
  const stale = real.filter((r) => r.at && r.now && !r.then);
  const past = real.filter((r) => !r.now && r.then);
  console.log(`  links: ${rows.length}, nothing to show: ${bad.length}, cited version unreadable: ${stale.length}, opens the past: ${past.length}`);
  for (const r of bad) problem(`${label}: "${r.label}" in ${r.note} → ${r.path}${r.frag ? '#' + r.frag : ''} has nothing behind it`);
  for (const r of stale) problem(`${label}: "${r.label}" in ${r.note} → cannot read ${r.path} at ${r.at}`);
  const broken = await win.locator('.editor-wrap .cm-ref.broken').count();
  if (broken) note(`the open note draws ${broken} link(s) as broken`);
  return rows;
}

const scenes = [];
const scene = (title, fn) => scenes.push({ title, fn });

/** Dismisses any notice bar that is in the way, returning what it said. */
async function clearNotice() {
  const bar = win.locator('.notice').first();
  if (!(await bar.count())) return null;
  const text = await bar.innerText().catch(() => '');
  await bar.locator('.icon').last().click().catch(() => undefined);
  await win.waitForTimeout(200);
  return text.replace(/\s+/g, ' ').trim();
}

const openNote = async (name) => {
  await clearNotice();
  await win.keyboard.press('Control+O');
  await win.getByPlaceholder('Find a file by name').fill(name);
  await win.locator('.tree-row', { hasText: name }).first().waitFor({ timeout: 15000 });
  await win.keyboard.press('Enter');
  // Click rather than press "e": the dialog ignores keys for a turn, so a fast key is lost.
  const choice = win.locator('.open-choice');
  await choice.waitFor({ timeout: 8000 }).catch(() => undefined);
  if (await choice.count()) await choice.getByText('Edit', { exact: true }).click();
  await win.locator('[data-pane="notes"] .tab.active', { hasText: name.split('/').pop() }).waitFor({ timeout: 15000 });
};

/** Saves a version the way a user does, and says what the link check made of it. */
async function saveVersion(message, answer = 'later') {
  await clearNotice();
  const started = Date.now();
  await win.locator('.header').getByRole('button', { name: /Save version/ }).click();
  const box = win.locator('.popover input').first();
  await box.waitFor({ timeout: 8000 }).catch(() => undefined);
  if (await box.count()) {
    await box.fill(message);
    await box.press('Enter');
  }
  // Wait for the link check to have its say: a summary, or the notice that links followed.
  await Promise.race([
    win.locator('.upkeep-summary').waitFor({ timeout: 30000 }),
    win.locator('.notice', { hasText: /Updated \d+ link/ }).waitFor({ timeout: 30000 }),
  ]).catch(() => undefined);
  note(`the link check answered after ${((Date.now() - started) / 1000).toFixed(1)}s`);
  const summary = win.locator('.upkeep-summary').first();
  const followed = win.locator('.notice', { hasText: /Updated \d+ link/ });
  const text = (await summary.count())
    ? 'summary: ' + (await summary.innerText()).replace(/\s+/g, ' ').trim()
    : (await followed.count())
      ? 'no dialog, just: ' + (await followed.innerText()).replace(/\s+/g, ' ').trim()
      : `nothing; toast said "${(await win.locator('.toast').innerText().catch(() => '')).trim()}"`;
  note(`after saving: ${text.slice(0, 300)}`);
  if (answer !== 'keep' && (await summary.count())) {
    const button = answer === 'each' ? /one by one/ : answer === 'update' ? /^Update/ : /Not now/;
    await summary.getByRole('button', { name: button }).first().click();
    await win.waitForTimeout(1200);
  }
  return text;
}

/** Whatever is on screen from the last scene: a dialog, a notice, a dangling dropdown. */
async function settle() {
  const summary = win.locator('.upkeep-summary');
  if (await summary.count()) {
    await summary.getByRole('button', { name: /Not now/ }).first().click().catch(() => undefined);
    await win.waitForTimeout(500);
  }
  const bar = win.locator('.review-bar');
  if (await bar.count()) {
    await bar.getByRole('button', { name: /Stop reviewing/ }).first().click().catch(() => undefined);
    await win.waitForTimeout(800);
  }
  await win.keyboard.press('Escape').catch(() => undefined);
  await clearNotice();
}

// ---------------------------------------------------------------- scenes

scene('a new workspace, a first look around', async () => {
  const info = await api('createDemo', ws);
  if (!info) throw new Error('the demo was not created');
  await win.evaluate(() => location.reload());
  await win.locator('.header .ws-name').waitFor({ timeout: 25000 });
  await win.waitForTimeout(1200);
  await openNote('Start here');
  const rows = await report('fresh');
  note(`${rows.length} links across ${new Set(rows.map((r) => r.note)).size} notes`);
  await shot('fresh');
});

scene('rename a document from the file browser, as a tidy person does', async () => {
  await clearNotice();
  await win.keyboard.press('Control+P');
  await win.getByPlaceholder('Find a file by name').fill('standard.pdf');
  const row = win.locator('.tree-row', { hasText: 'standard.pdf' }).first();
  await row.hover();
  await row.locator('.row-action').click();
  const box = win.locator('input.rename');
  await box.fill('docs/NASA-STD-5001B.pdf');
  await box.press('Enter');
  await win.waitForTimeout(1500);
  await win.keyboard.press('Escape');
  note(`toast: ${(await win.locator('.toast').innerText().catch(() => 'none')).trim()}`);
  note(`notice: ${(await clearNotice()) ?? 'none'}`);
  await report('after renaming the PDF');
  await shot('renamed-pdf');
});

scene('move the documents into a folder of their own', async () => {
  await clearNotice();
  await win.keyboard.press('Control+P');
  await win.getByPlaceholder('Find a file by name').fill('NASA-STD');
  const row = win.locator('.tree-row', { hasText: 'NASA-STD' }).first();
  await row.hover();
  await row.locator('.row-action').click();
  const box = win.locator('input.rename');
  await box.fill('reference/standards/NASA-STD-5001B.pdf');
  await box.press('Enter');
  await win.waitForTimeout(1500);
  await win.keyboard.press('Escape');
  note(`toast: ${(await win.locator('.toast').innerText().catch(() => 'none')).trim()}`);
  await report('after moving the PDF two folders deep');
  await shot('moved-pdf');
});

scene('click the links to see they still land somewhere', async () => {
  await openNote('Start here');
  for (const label of ['the scope (page 6)', 'Table 1', 'check()', 'the mass table']) {
    const ref = win.locator('.editor-wrap .cm-ref', { hasText: label }).first();
    if (!(await ref.count())) {
      problem(`the link "${label}" is no longer in the note`);
      continue;
    }
    await ref.click();
    await win.waitForTimeout(1800);
    const failed = await win.locator("text=Couldn't open").count();
    const tab = await win.locator('[data-pane="docs"] .tab.active').innerText().catch(() => '(none)');
    note(`"${label}" → ${tab.trim()}${failed ? '  ← FAILED TO OPEN' : ''}`);
    if (failed) problem(`clicking "${label}" shows "Couldn't open"`);
    const toast = (await win.locator('.toast').innerText().catch(() => '')).trim();
    if (toast) note(`   toast: ${toast.slice(0, 160)}`);
    const notice = await clearNotice();
    if (notice) note(`   notice: ${notice.slice(0, 160)}`);
  }
  await shot('clicked-through');
});

scene('save a version after all that moving', async () => {
  await saveVersion('Tidied the documents away');
  await shot('saved-after-moves');
  await report('after saving the moves');
});

scene('edit the code the way work actually goes, without saving a version', async () => {
  const code = await api('readText', '/src/margins.py');
  await api('writeText', '/src/margins.py', '"""Bracket margins."""\nimport math\nfrom typing import Iterable\n\n' + code.replace('"""Bracket margins."""\n', ''));
  await win.waitForTimeout(600);
  await openNote('Start here');
  const ref = win.locator('.editor-wrap .cm-ref', { hasText: 'check()' }).first();
  await ref.click();
  await win.waitForTimeout(1500);
  note(`notice: ${(await clearNotice()) ?? 'none'}`);
  await shot('code-edited-unsaved');
  await report('after editing code without saving a version');
});


scene('duplicate a document, the way people keep a copy before meddling', async () => {
  await copyFile(join(ws, 'data', 'loads.xlsx'), join(ws, 'data', 'loads (copy).xlsx'));
  await win.evaluate(() => window.dispatchEvent(new Event('focus')));
  await win.waitForTimeout(1500);
  note(`notice: ${(await clearNotice()) ?? 'none'}`);
  await report('after duplicating the workbook');
});

scene('replace a document with another edition, keeping the name', async () => {
  // Another edition of the same standard, from the cache the demo was built from.
  const older = join(repo, '.sample-cache', 'NASA-STD-5001B-2014.pdf');
  if (!existsSync(older)) return note('skipped: run npm run sample once to fetch the other edition');
  await copyFile(older, join(ws, 'reference', 'standards', 'NASA-STD-5001B.pdf'));
  await win.evaluate(() => window.dispatchEvent(new Event('focus')));
  await win.waitForTimeout(1200);
  await openNote('Start here');
  for (const label of ['the scope (page 6)', 'Table 1']) {
    await win.locator('.editor-wrap .cm-ref', { hasText: label }).first().click();
    await win.waitForTimeout(2500);
    const failed = await win.locator("text=Couldn't open").count();
    if (failed) problem(`after the swap, "${label}" shows "Couldn't open"`);
    note(`"${label}": ${(await clearNotice()) ?? 'no notice'}`);
  }
  await shot('swapped-pdf');
  await report('after swapping the PDF for another edition');
});

scene('save a version, and deal with whatever the link check asks', async () => {
  await saveVersion('Swapped in the 2014 edition', 'keep');
  await shot('upkeep-summary');
  const summary = win.locator('.upkeep-summary');
  if (await summary.count()) {
    const buttons = await summary.getByRole('button').allInnerTexts();
    note(`the summary offers: ${buttons.join(' | ')}`);
    await summary.getByRole('button', { name: /one by one/ }).first().click();
    for (let i = 0; i < 6; i++) {
      const bar = win.locator('.review-bar');
      if (!(await bar.count())) break;
      const what = (await bar.innerText()).replace(/\s+/g, ' ').trim();
      note(`review ${i + 1}: ${what.slice(0, 200)}`);
      if (await win.locator("text=Couldn't open").count()) problem(`the review pane cannot open the file: ${what.slice(0, 80)}`);
      await shot(`review-${i + 1}`);
      await bar.getByRole('button', { name: /Update the link/ }).first().click();
      await win.waitForTimeout(1500);
    }
  }
  await report('after dealing with the link check');
});

scene('delete a document that notes cite', async () => {
  await rm(join(ws, 'media', 'review.wav'));
  await win.evaluate(() => window.dispatchEvent(new Event('focus')));
  await win.waitForTimeout(1500);
  note(`notice: ${(await clearNotice()) ?? 'none'}`);
  await openNote('Start here');
  const ref = win.locator('.editor-wrap .cm-ref', { hasText: 'the summary' }).first();
  if (await ref.count()) {
    await ref.click();
    await win.waitForTimeout(1500);
    note(`clicking a deleted file: ${(await clearNotice()) ?? 'no notice'}`);
    note(`drawn broken: ${(await win.locator('.editor-wrap .cm-ref.broken').count()) > 0}`);
  }
  await shot('deleted-file');
  await saveVersion('Dropped the recording');
  await shot('after-deleting');
  await report('after deleting a cited recording');
});

scene('move a whole folder with Explorer, behind the back of the app', async () => {
  await mkdir(join(ws, 'code'), { recursive: true });
  await rename(join(ws, 'src', 'margins.py'), join(ws, 'code', 'margins.py'));
  await win.evaluate(() => window.dispatchEvent(new Event('focus')));
  const notice = win.locator('.notice', { hasText: /moved/i });
  // Chasing a lost file costs a few git calls each; the offer comes up once they are done.
  await notice.waitFor({ timeout: 15000 }).catch(() => undefined);
  if (!(await notice.count())) problem('a file moved outside the app was not noticed');
  else {
    note(`notice: ${(await notice.innerText()).replace(/\s+/g, ' ').trim().slice(0, 200)}`);
    await shot('fix-links-offered');
    await notice.getByRole('button', { name: 'Fix links' }).click();
    await win.waitForTimeout(2000);
    note(`toast: ${(await win.locator('.toast').innerText().catch(() => 'none')).trim()}`);
  }
  await report('after moving code outside the app');
});

scene('rename the note everything points at', async () => {
  await clearNotice();
  await win.keyboard.press('Control+P');
  await win.getByPlaceholder('Find a file by name').fill('Start here');
  const row = win.locator('.tree-row', { hasText: 'Start here' }).first();
  await row.hover();
  await row.locator('.row-action').click();
  const box = win.locator('input.rename');
  await box.fill('notes/Overview.md');
  await box.press('Enter');
  await win.waitForTimeout(1500);
  await win.keyboard.press('Escape');
  note(`toast: ${(await win.locator('.toast').innerText().catch(() => 'none')).trim()}`);
  const flow = await api('readText', '/notes/flow.canvas');
  const stale = (flow.match(/Start here/g) ?? []).length;
  if (stale) note(`the flowchart still writes "Start here" ${stale} time(s) - fine if it finds the note by its identity`);
  await report('after renaming the note');
});

scene('type into a note, leave it, and restart the app', async () => {
  await openNote('Overview');
  await win.locator('.editor-wrap .cm-content').click();
  await win.keyboard.press('Control+End');
  await win.keyboard.type('\n\nA thought I had on the train.\n');
  await win.waitForTimeout(1500);
  const before = await api('readText', '/notes/Overview.md');
  note(`autosaved to disk: ${before.includes('on the train')}`);
  await app.close();
  const app2 = await electron.launch({ args: [repo], env: { ...process.env, LOCUS_USER_DATA: join(out, 'user-data') } });
  restart(app2, await app2.firstWindow());
  await win.setViewportSize({ width: 1500, height: 950 });
  await win.locator('.header .ws-name').waitFor({ timeout: 25000 });
  await win.waitForTimeout(1500);
  const after = await api('readText', '/notes/Overview.md');
  if (!after.includes('on the train')) problem('what was typed before the restart is gone');
  const tabs = await win.locator('[data-pane="notes"] .tab').allInnerTexts();
  note(`notes reopened: ${tabs.map((t) => t.trim()).join(', ') || 'none'}`);
  await shot('after-restart');
  await report('after a restart');
});

scene('a last walk through every link', async () => {
  await openNote('Overview');
  const refs = win.locator('.editor-wrap .cm-ref');
  const n = await refs.count();
  note(`${n} links in the note`);
  for (let i = 0; i < n; i++) {
    const ref = refs.nth(i);
    const label = (await ref.innerText()).trim();
    const broken = await ref.evaluate((el) => el.classList.contains('broken')).catch(() => false);
    await ref.click();
    await win.waitForTimeout(1600);
    const failed = await win.locator("text=Couldn't open").count();
    const where = (await win.locator('[data-pane="docs"] .tab.active').innerText().catch(() => '')).trim();
    note(`${broken ? 'broken ' : ''}"${label}" -> ${where || '(nothing opened)'}${failed ? '  <= FAILED' : ''}`);
    if (failed) problem(`"${label}" cannot be opened at the end of the week`);
    await clearNotice();
  }
  await shot('final-walk');
  await report('the end of the week');
});

// ---------------------------------------------------------------- run

let failed = 0;
for (const [i, s] of scenes.entries()) {
  const n = i + 1;
  if (n < first || n > last) continue;
  console.log(`\n== ${n}. ${s.title}`);
  try {
    await settle();
    await s.fn();
  } catch (e) {
    failed++;
    console.log(`  xx the scene itself fell over: ${String(e.message).split('\n')[0]}`);
    await shot(`fell-over-${n}`);
  }
}

console.log(`\n${findings.length} finding(s)${failed ? `, ${failed} scene(s) fell over` : ''}`);
for (const f of findings) console.log(` - ${f}`);
await app.close();
