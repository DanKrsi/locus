// Launches the packaged app (release/win-unpacked) with no system git on the PATH and checks
// the parts that depend on packaging: bundled git, viewers, citing, packages.
// Usage: npm run dist && node scripts/make-test-workspace.mjs && node scripts/test-packaged.mjs
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const exe = join(repo, 'release', 'win-unpacked', 'Locus.exe');
const workspace = resolve(repo, '..', 'locus-test-workspace');
const out = join(repo, 'test-output', 'packaged');
await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'user-data'), { recursive: true });
await writeFile(join(out, 'user-data', 'settings.json'), JSON.stringify({ claudeOffered: 'skip', recentWorkspaces: [workspace], dark: 'light' }));

const env = { ...process.env, LOCUS_USER_DATA: join(out, 'user-data'), PATH: dirname(exe), Path: dirname(exe) };
const app = await electron.launch({ executablePath: exe, env });
const win = await app.firstWindow();
await win.setViewportSize({ width: 1500, height: 900 });
let failures = 0;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.log(`FAIL ${name}: ${String(e.message).split('\n')[0]}`);
    await win.screenshot({ path: join(out, `fail-${name.replace(/\W+/g, '-')}.png`) }).catch(() => undefined);
  }
};
const callApi = (m, ...a) => win.evaluate(([m, a]) => window.api[m](...a), [m, a]);

await step('opens the workspace', () => win.locator('.header .ws-name').waitFor({ timeout: 20000 }));
await step('bundled git reads version history', async () => {
  const v = await callApi('versions');
  if (v.length < 5) throw new Error(`only ${v.length} versions`);
});
await step('note, PDF viewer and a reference', async () => {
  await win.keyboard.press('Control+O');
  await win.getByPlaceholder('Find a note by name').fill('review');
  await win.locator('.tree-row', { hasText: 'review.md' }).waitFor();
  await win.keyboard.press('Enter');
  await win.locator('.cm-ref', { hasText: 'Table 5' }).click();
  await win.locator('.area-box.cited').waitFor({ timeout: 20000 });
});
await step('spreadsheet viewer', async () => {
  await win.locator('.cm-ref', { hasText: 'LoadTable' }).click();
  await win.locator('.cited-box').waitFor({ timeout: 20000 });
});
await step('citing saves an automatic version with bundled git', async () => {
  await callApi('writeText', '/src/solver.py', '# edited\n' + (await callApi('readText', '/src/solver.py')));
  const sha = await callApi('ensureVersion', '/src/solver.py');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`no version: ${sha}`);
});
await step('share as a file', async () => {
  const file = join(out, 'packaged-test.locus');
  await callApi('exportPackage', file);
  if (!existsSync(file)) throw new Error('package not written');
});
await win.screenshot({ path: join(out, 'packaged.png') });
await app.close();

// The Claude Code setup runs the bundled MCP server on Locus itself, with only the bundled git.
const unpacked = join(repo, 'release', 'win-unpacked', 'resources');
await step('Claude files are packaged', async () => {
  for (const p of ['app.asar.unpacked/plugin/server/server.mjs', 'app.asar.unpacked/plugin/skills/locus/SKILL.md'])
    if (!existsSync(join(unpacked, p))) throw new Error(`missing ${p}`);
});
await step('MCP server runs on Locus.exe without system git', async () => {
  execFileSync(process.execPath, [join(repo, 'scripts', 'make-test-workspace.mjs')], { stdio: 'ignore' });
  const res = execFileSync(process.execPath, [join(repo, 'scripts', 'test-mcp.mjs')], {
    env: { ...process.env, LOCUS_RUNTIME: exe, LOCUS_SERVER: join(unpacked, 'app.asar.unpacked', 'plugin', 'server', 'server.mjs'), PATH: dirname(exe), Path: dirname(exe) },
    encoding: 'utf8',
  });
  if (!/all passed/.test(res)) throw new Error(res.split('\n').filter((l) => l.startsWith('FAIL')).join('; '));
});
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
