// Tour mode in a long note: every stop's link ends up near the middle of the note, the note stays at
// the link when the link points to a section of the same note (that section opens on the right),
// and pictures that load after the jump don't push the link off screen.
//
//   npm run build && node scripts/make-test-workspace.mjs && node scripts/test-tour.mjs
import { _electron as electron } from 'playwright';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(repo, 'test-output-tour');
const userData = join(out, 'user-data');
const workspace = resolve(repo, '..', 'locus-test-workspace');
await rm(out, { recursive: true, force: true });
await mkdir(userData, { recursive: true });
await writeFile(join(userData, 'settings.json'), JSON.stringify({ claudeOffered: 'skip', recentWorkspaces: [workspace], dark: 'light' }));

// A long note: the review note's links, with paragraphs, pictures, a code block, the review's table
// and a link back to the previous part between them.
const note = 'tour-long';
const pictures = ['tour-pic0.png', 'tour-pic1.png'];
for (const p of pictures) await copyFile(join(repo, 'build', 'icon.png'), join(workspace, 'docs', p));
const review = await readFile(join(workspace, 'notes', 'review.md'), 'utf8');
const filler = Array.from({ length: 5 }, (_, i) => `Paragraph ${i} of filler that wraps across the note, so lines have different heights. `.repeat(3)).join('\n\n');
const code = '```python\n' + Array.from({ length: 20 }, (_, i) => `line_${i} = ${i}`).join('\n') + '\n```';
const body = review.replace(/^# .*\n/, '');
const parts = [1, 2, 3];
const back = (n) => (n === 1 ? parts.length : n - 1);
const text = `# Long tour\n\n${parts
  .map((n) => `## Part ${n}\n\n![picture](/docs/${pictures[n % 2]})\n\n${filler}\n\nBack to [part ${back(n)}](#part-${back(n)}).\n\n![picture](/docs/${pictures[(n + 1) % 2]})\n\n${code}\n\n${body}`)
  .join('\n\n')}\n`;
await writeFile(join(workspace, 'notes', `${note}.md`), text);

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

const app = await electron.launch({ args: [repo], env: { ...process.env, LOCUS_USER_DATA: userData } });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1500, height: 900 });
const errors = [];
win.on('pageerror', (e) => errors.push(String(e)));
try {
  await win.getByText('Bracket project').first().waitFor({ timeout: 15000 });
  await win.keyboard.press('Control+O');
  await win.getByPlaceholder('Find a file by name').fill(note);
  await win.locator('.tree-row', { hasText: `${note}.md` }).first().waitFor();
  await win.keyboard.press('Enter');
  await win.locator('[data-pane="notes"] .cm-content', { hasText: 'Long tour' }).waitFor({ timeout: 10000 });
  await win.getByRole('button', { name: 'Tour' }).click();
  await win.locator('.tour-bar').waitFor();

  /** Where the tour's link is, from the top (0) to the bottom (100) of the note's visible area. */
  const where = () =>
    win.evaluate(() => {
      const scroller = document.querySelector('[data-pane="notes"] .cm-scroller');
      const active = document.querySelector('[data-pane="notes"] .cm-link-label.active');
      const label = document.querySelector('.tour-bar .label')?.textContent ?? '';
      if (!scroller || !active) return { label, rel: null };
      const s = scroller.getBoundingClientRect();
      const a = active.getBoundingClientRect();
      return { label, rel: Math.round(((a.top + a.height / 2 - s.top) / s.height) * 100) };
    });

  const count = Number((await win.locator('.tour-bar').innerText()).match(/of (\d+)/)[1]);
  const off = [];
  const tab = await win.locator('[data-pane="notes"] .tab.active').innerText();
  for (let i = 0; i < count; i++) {
    await win.waitForTimeout(700);
    const w = await where();
    if (w.rel === null || w.rel < 30 || w.rel > 70) {
      off.push(`stop ${i + 1} (${w.label}) at ${w.rel ?? 'not shown'}`);
      await win.screenshot({ path: join(out, `off-${i + 1}.png`) });
    }
    if (w.label.startsWith('part ')) {
      const heading = `Part ${w.label.slice(5)}`;
      const shown = await win.locator('.viewer:not(.hidden) .cm-content', { hasText: heading }).count();
      check(shown > 0, `stop ${i + 1}: the section "${heading}" opens on the right`);
    }
    if (i + 1 < count) await win.keyboard.press('ArrowRight');
  }
  check(off.length === 0, `all ${count} stops show their link near the middle of the note${off.length ? `: ${off.join('; ')}` : ''}`);
  check((await win.locator('[data-pane="notes"] .tab.active').innerText()) === tab, 'the toured note stays in front');
  check(await win.locator('.tour-bar').isVisible(), 'the tour is still going at the last stop');

  // Back again, quickly: each stop still lands on its own link.
  for (let i = 0; i < count - 1; i++) await win.keyboard.press('ArrowLeft');
  await win.waitForTimeout(1200);
  const first = await where();
  check(first.rel !== null && first.rel >= 30 && first.rel <= 70, `back at stop 1 after stepping quickly, its link is near the middle (${first.rel})`);
} catch (e) {
  check(false, String(e).split('\n')[0]);
  await win.screenshot({ path: join(out, 'error.png') }).catch(() => undefined);
}
check(errors.length === 0, `no page errors${errors.length ? ` (${errors[0]})` : ''}`);
await app.close();
await rm(join(workspace, 'notes', `${note}.md`), { force: true });
for (const p of pictures) await rm(join(workspace, 'docs', p), { force: true });
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
