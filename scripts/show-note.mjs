// Opens a note in the app and screenshots it after clicking each named reference.
// Usage: node scripts/show-note.mjs <workspace> <note path> [reference label ...]
import { _electron as electron } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const [workspace, note, ...labels] = process.argv.slice(2);
const repo = resolve(import.meta.dirname, '..');
const out = join(repo, 'test-output', 'show');
const userData = join(out, 'user-data');
await mkdir(userData, { recursive: true });
await writeFile(join(userData, 'settings.json'), JSON.stringify({ claudeOffered: 'skip', recentWorkspaces: [resolve(workspace)], dark: process.env.DARK ? 'dark' : 'light' }));
const app = await electron.launch({ args: [repo], env: { ...process.env, LOCUS_USER_DATA: userData } });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1500, height: 900 });
await win.locator('.header .ws-name').waitFor({ timeout: 15000 });
await win.evaluate(() => localStorage.clear());
await win.keyboard.press('Control+O');
await win.getByPlaceholder('Find a note by name').fill(note);
await win.locator('.tree-row').first().waitFor();
await win.keyboard.press('Enter');
await win.locator('.cm-ref:visible').first().waitFor({ timeout: 10000 });
await win.waitForTimeout(800);
await win.screenshot({ path: join(out, '0-note.png') });
if (process.env.EDIT) {
  // Puts the cursor at the end of the first line with a link and screenshots the editor while editing.
  const line = win.locator('.cm-line:visible:has(.cm-link-label)').first();
  const box = await line.boundingBox();
  await win.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
  await win.waitForTimeout(300);
  await win.screenshot({ path: join(out, 'edit-cursor.png'), clip: { x: 0, y: Math.max(0, box.y - 120), width: 750, height: 300 } });
}
let i = 1;
for (const label of labels) {
  await win.locator('.cm-ref:visible', { hasText: label }).first().click();
  await win.waitForTimeout(1800);
  await win.screenshot({ path: join(out, `${i++}-${label.replace(/\W+/g, '-')}.png`) });
}
if (process.env.SETTINGS) {
  await win.getByTitle('Settings').click();
  await win.waitForTimeout(500);
  await win.screenshot({ path: join(out, 'settings.png') });
}
await app.close();
console.log(`screenshots in ${out}`);
