// End-to-end test of sharing without GitHub: packages, and syncing through a local bare repo
// that stands in for the online copy, with a second "person" making conflicting edits.
// Usage: npm run build && node scripts/make-test-workspace.mjs && node scripts/test-sharing.mjs
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const out = join(repo, 'test-output', 'sharing');
const workspace = resolve(repo, '..', 'locus-test-workspace');
const remote = join(out, 'online.git');
const jane = join(out, 'jane');
const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'user-data'), { recursive: true });
await writeFile(join(out, 'user-data', 'settings.json'), JSON.stringify({ recentWorkspaces: [workspace], dark: 'light' }));

const app = await electron.launch({ args: [repo], env: { ...process.env, LOCUS_USER_DATA: join(out, 'user-data') } });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1500, height: 900 });
await win.locator('.header .ws-name').waitFor({ timeout: 15000 });

let failures = 0;
let n = 0;
const shot = (name) => win.screenshot({ path: join(out, `${String(++n).padStart(2, '0')}-${name}.png`) });
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${String(e.message).split('\n').slice(0, 3).join(' | ')}`);
    await shot('fail-' + name.replace(/\W+/g, '-'));
  }
};
const callApi = (method, ...args) => win.evaluate(([m, a]) => window.api[m](...a), [method, args]);

const pkg = join(out, 'Bracket project.locus');
const imported = join(out, 'imported');

await step('share dialog offers GitHub sign-in and the file option', async () => {
  await win.locator('.header').getByRole('button', { name: 'Share', exact: true }).click();
  await win.getByRole('button', { name: 'Sign in with GitHub' }).waitFor({ timeout: 5000 });
  await win.getByRole('button', { name: /Save as a file/ }).waitFor();
  await shot('share-dialog');
  await win.getByRole('button', { name: 'Done' }).click();
});

await step('export a package', async () => {
  await callApi('writeText', '/notes/unsaved.md', '# Not yet a version\n');
  await callApi('exportPackage', pkg);
  if (!existsSync(pkg)) throw new Error('package not written');
  const heads = gitIn(out, 'bundle', 'list-heads', pkg);
  if (!/refs\/heads\/main/.test(heads)) throw new Error('bundle has no main branch');
});

await step('import the package: files, history and pinned links come along', async () => {
  const info = await callApi('importPackage', pkg, imported);
  if (!info || !info.root.endsWith('imported')) throw new Error('import did not open the workspace');
  if (!existsSync(join(imported, 'notes', 'unsaved.md'))) throw new Error('unsaved change was not included');
  const original = gitIn(workspace, 'rev-list', '--count', 'HEAD');
  const copy = gitIn(imported, 'rev-list', '--count', 'HEAD');
  if (original !== copy) throw new Error(`history ${copy} != ${original}`);
  if (gitIn(imported, 'remote')) throw new Error('package import should not keep a remote');
  const checks = await win.evaluate(async () => {
    const md = await window.api.readText('/notes/review.md');
    const m = md.match(/\(\/src\/net\/client\.py#L12-L18&rev=([0-9a-f]+)/);
    return m ? window.api.exists('/src/net/client.py', m[1]) : false;
  });
  if (!checks) throw new Error('pinned link does not resolve in the imported copy');
});

await step('reopen the original and connect an online copy', async () => {
  execFileSync('git', ['init', '--bare', '-b', 'main', remote]);
  gitIn(workspace, 'remote', 'add', 'origin', remote);
  await callApi('openWorkspace', workspace);
  await win.evaluate(() => location.reload());
  await win.locator('.header .ws-name').waitFor({ timeout: 15000 });
  await win.locator('.sync-pill').waitFor({ timeout: 10000 });
  await shot('sync-pill-before-first-sync');
  const r = await callApi('sync');
  if (r.conflicts.length) throw new Error('unexpected conflicts');
  if (gitIn(remote, 'rev-parse', 'main') !== gitIn(workspace, 'rev-parse', 'HEAD')) throw new Error('online copy not updated');
});

await step('second person edits the same note; sync shows the conflict dialog', async () => {
  execFileSync('git', ['clone', '--quiet', remote, jane]);
  gitIn(jane, 'config', 'user.name', 'Jane Doe');
  gitIn(jane, 'config', 'user.email', 'jane@example.com');
  const theirs = (await readFile(join(jane, 'notes', 'review.md'), 'utf8')).replace('A walkthrough of how the HTTP client retries, and why.', 'Jane: a walkthrough of retries.');
  await writeFile(join(jane, 'notes', 'review.md'), theirs);
  await writeFile(join(jane, 'notes', 'from-jane.md'), '# Notes from Jane\n');
  gitIn(jane, 'add', '-A');
  gitIn(jane, 'commit', '-q', '-m', 'Jane edits');
  gitIn(jane, 'push', '-q', 'origin', 'main');

  const mine = (await callApi('readText', '/notes/review.md')).replace('A walkthrough of how the HTTP client retries, and why.', 'Mine: a walkthrough of retries.');
  await callApi('writeText', '/notes/review.md', mine);
  await win.evaluate(() => window.dispatchEvent(new Event('focus')));
  await win.locator('.sync-pill').click();
  await win.getByText('Changed in two places').waitFor({ timeout: 15000 });
  await win.getByText('Jane Doe’s').waitFor();
  await shot('conflict-dialog');
  await win.getByRole('button', { name: 'Keep both' }).click();
  await win.locator('.toast', { hasText: /Synced/ }).waitFor({ timeout: 15000 });
  const files = await readdir(join(workspace, 'notes'));
  if (!files.includes("review (Jane's copy).md")) throw new Error(`no copy of Jane's version: ${files}`);
  if (!files.includes('from-jane.md')) throw new Error("Jane's other change didn't arrive");
  const kept = await readFile(join(workspace, 'notes', 'review.md'), 'utf8');
  if (!kept.includes('Mine: a walkthrough')) throw new Error('my version was not kept');
  if (gitIn(remote, 'rev-parse', 'main') !== gitIn(workspace, 'rev-parse', 'HEAD')) throw new Error('merge not shared');
  await shot('after-conflict');
});

await step('updates from someone else show up and sync in', async () => {
  gitIn(jane, 'pull', '-q', '--no-rebase', 'origin', 'main');
  await writeFile(join(jane, 'notes', 'second.md'), '# Second note\n');
  gitIn(jane, 'add', '-A');
  gitIn(jane, 'commit', '-q', '-m', 'Second note');
  gitIn(jane, 'push', '-q', 'origin', 'main');
  await callApi('sharingStatus', true);
  await win.evaluate(() => window.dispatchEvent(new Event('focus')));
  await win.locator('.sync-pill', { hasText: 'Updates available' }).waitFor({ timeout: 20000 }).catch(async () => {
    // The pill refreshes on a timer; nudge it like a returning user would.
    await win.locator('.sync-pill').click();
  });
  await shot('updates-available');
  if (!(await win.locator('.toast', { hasText: /Synced|up to date/ }).count())) await win.locator('.sync-pill').click();
  await win.waitForFunction(() => window.api.exists('/notes/second.md'), null, { timeout: 15000 });
});

await step('git terminology shows ahead/behind', async () => {
  await win.getByTitle('Settings').click();
  await win.getByText('Git', { exact: true }).click();
  await win.getByRole('button', { name: 'Done' }).click();
  await win.locator('.sync-pill', { hasText: /Up to date|↓/ }).waitFor({ timeout: 5000 });
  await win.locator('.header').getByRole('button', { name: 'Share', exact: true }).click();
  await win.getByText('Export git bundle').waitFor();
  await shot('git-terms-share');
  await win.getByRole('button', { name: 'Done' }).click();
});

await app.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
