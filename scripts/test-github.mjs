// Live test of GitHub sharing. Needs a person to approve the sign-in code in their browser.
// Creates a private repo named after the workspace on the signed-in account.
// Usage: npm run build && node scripts/test-github.mjs <workspace-folder>
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const workspace = resolve(process.argv[2]);
const out = join(repo, 'test-output', 'github');
const clone = join(out, 'downloaded');
const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'user-data'), { recursive: true });
await writeFile(join(out, 'user-data', 'settings.json'), JSON.stringify({ recentWorkspaces: [workspace], dark: 'light' }));

const app = await electron.launch({ args: [repo], env: { ...process.env, LOCUS_USER_DATA: join(out, 'user-data') } });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1500, height: 900 });
await win.locator('.header .ws-name').waitFor({ timeout: 15000 });
let n = 0;
const shot = (name) => win.screenshot({ path: join(out, `${String(++n).padStart(2, '0')}-${name}.png`) });
const callApi = (method, ...args) => win.evaluate(([m, a]) => window.api[m](...a), [method, args]);
const log = (msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`);

try {
  await win.locator('.header').getByRole('button', { name: 'Share', exact: true }).click();
  await win.getByRole('button', { name: 'Sign in with GitHub' }).click();
  const code = (await win.locator('.device-code').textContent({ timeout: 20000 })).trim();
  await shot('device-code');
  log(`CODE ${code}  (enter it at https://github.com/login/device)`);

  await win.getByRole('button', { name: /Create a private online copy/ }).waitFor({ timeout: 14 * 60 * 1000 });
  log('signed in');
  await shot('signed-in');

  await win.getByRole('button', { name: /Create a private online copy/ }).click();
  await win.getByText('Shared privately as').waitFor({ timeout: 120000 });
  const shared = await callApi('sharingStatus', true);
  log(`shared as ${shared.github.owner}/${shared.github.repo} (ahead ${shared.ahead}, behind ${shared.behind})`);
  await win.locator('.person').first().waitFor({ timeout: 15000 });
  await shot('shared');
  await win.getByRole('button', { name: 'Done' }).click();
  await win.locator('.sync-pill').waitFor();
  await shot('pill-after-share');

  const full = `${shared.github.owner}/${shared.github.repo}`;
  const { repos } = await callApi('githubRepos');
  if (!repos.some((r) => r.fullName === full && r.private)) throw new Error('new repo not listed as private');
  log('listed as a private repo');

  // A second copy, as if downloaded on another computer.
  const info = await callApi('githubClone', full, clone);
  if (!info || !existsSync(join(clone, '.locus', 'workspace.json'))) throw new Error('download failed');
  if (gitIn(clone, 'rev-list', '--count', 'HEAD') !== gitIn(workspace, 'rev-list', '--count', 'HEAD')) throw new Error('history differs');
  log('downloaded with full history');

  await callApi('writeText', '/notes/from-the-other-computer.md', '# Written on the other computer\n');
  const pushed = await callApi('sync');
  log(`second copy synced: pushed ${pushed.pushed}`);

  await callApi('openWorkspace', workspace);
  await win.evaluate(() => location.reload());
  await win.locator('.header .ws-name').waitFor({ timeout: 15000 });
  await win.locator('.sync-pill', { hasText: 'Updates available' }).waitFor({ timeout: 30000 });
  await shot('updates-available');
  await win.locator('.sync-pill').click();
  await win.waitForFunction(() => window.api.exists('/notes/from-the-other-computer.md'), null, { timeout: 30000 });
  await win.locator('.sync-pill', { hasText: /Synced/ }).waitFor({ timeout: 15000 });
  await shot('synced');
  log('original received the change');
  log('ALL PASSED');
} catch (e) {
  log(`FAILED: ${String(e.message).split('\n')[0]}`);
  await shot('failed');
  process.exitCode = 1;
} finally {
  // Forget the token from this test profile (the GitHub authorization itself stays until revoked).
  await callApi('githubSignOut').catch(() => undefined);
  await app.close();
}
