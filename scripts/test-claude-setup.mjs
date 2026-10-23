// Connects, refreshes and removes the Claude setup against throwaway Claude folders (never the
// real ones): Claude Code's plugin folder and Claude Desktop's config, keeping other servers.
// Usage: npm run build && npm run build:plugin && node scripts/test-claude-setup.mjs
import { _electron as electron } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const out = join(repo, 'test-output', 'claude-setup');
const codeHome = join(out, 'claude-code');
const deskHome = join(out, 'claude-desktop');
const userData = join(out, 'user-data');
await rm(out, { recursive: true, force: true });
for (const d of [codeHome, deskHome, userData]) await mkdir(d, { recursive: true });
await writeFile(join(userData, 'settings.json'), JSON.stringify({ claudeOffered: 'skip', recentWorkspaces: [] }));
const deskCfg = join(deskHome, 'claude_desktop_config.json');
const otherServer = { command: 'npx', args: ['-y', 'mcp-remote', 'https://example.com/mcp'] };
await writeFile(deskCfg, JSON.stringify({ mcpServers: { other: otherServer }, preferences: { keep: true } }, null, 2));
const env = { ...process.env, LOCUS_USER_DATA: userData, CLAUDE_CONFIG_DIR: codeHome, LOCUS_CLAUDE_DESKTOP_DIR: deskHome };
const plugin = join(codeHome, 'skills', 'locus');

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`);
  if (!ok) failures++;
};
const json = async (p) => JSON.parse(await readFile(p, 'utf8'));
const launch = async (extraEnv = {}) => {
  const app = await electron.launch({ args: [repo], env: { ...env, ...extraEnv } });
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  return { app, win };
};

// 1. Connect both.
{
  const { app, win } = await launch();
  const before = await win.evaluate(() => window.api.claudeStatus());
  check('finds both apps, nothing connected yet', before.code.found && before.desktop.found && !before.code.installed && !before.desktop.installed, JSON.stringify(before));
  const code = await win.evaluate(() => window.api.connectClaude('code'));
  const desk = await win.evaluate(() => window.api.connectClaude('desktop'));
  check('connects Claude Code and Claude Desktop', code.ok && desk.ok, JSON.stringify([code, desk]));
  const after = await win.evaluate(() => window.api.claudeStatus());
  check('both show as connected and current', after.code.installed?.version === after.code.current && after.desktop.installed?.version === after.desktop.current, JSON.stringify(after));
  await app.close();
}
const cfg = await json(deskCfg);
check("Desktop config keeps the other server and settings", JSON.stringify(cfg.mcpServers.other) === JSON.stringify(otherServer) && cfg.preferences?.keep === true);
check('Desktop entry runs the server on Locus itself', cfg.mcpServers.locus?.env?.ELECTRON_RUN_AS_NODE === '1' && /server\.mjs$/.test(cfg.mcpServers.locus.args[0]));
check('the original Desktop config is backed up', existsSync(deskCfg + '.before-locus'));
check('Claude Code plugin folder written', existsSync(join(plugin, 'SKILL.md')) && existsSync(join(plugin, '.mcp.json')));
try {
  const list = execFileSync('claude', ['plugin', 'list', '--json'], { env, encoding: 'utf8' });
  check('Claude Code lists locus@skills-dir', JSON.parse(list.slice(list.indexOf('['))).some((p) => p.id === 'locus@skills-dir'));
} catch {
  console.log('skip Claude Code CLI not installed');
}

// 2. An older skill and a moved Locus get refreshed on startup, without asking.
const manifest = await json(join(plugin, '.claude-plugin', 'plugin.json'));
await writeFile(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ ...manifest, version: '0.0.1' }));
cfg.mcpServers.locus.command = 'C:\\Old place\\Locus.exe';
await writeFile(deskCfg, JSON.stringify(cfg, null, 2));
{
  const { app } = await launch({ LOCUS_CLAUDE_REFRESH: '1' });
  for (let i = 0; i < 40; i++) {
    const v = (await json(join(plugin, '.claude-plugin', 'plugin.json'))).version;
    const c = (await json(deskCfg)).mcpServers.locus.command;
    if (v === manifest.version && !c.startsWith('C:\\Old')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await app.close();
}
check('startup refreshes an older Claude Code plugin', (await json(join(plugin, '.claude-plugin', 'plugin.json'))).version === manifest.version);
check('startup repoints the Desktop entry at this install', !(await json(deskCfg)).mcpServers.locus.command.startsWith('C:\\Old'));

// 3. Restart Claude Desktop from the dialog, with a stand-in for Claude Desktop: a copy of node
// named claude.exe that just waits (so the real Claude is never touched).
// Start from not connected, as on first setup.
{
  const c = await json(deskCfg);
  delete c.mcpServers.locus;
  await writeFile(deskCfg, JSON.stringify(c, null, 2));
}
const fakeDir = join(out, 'fake-claude-desktop');
await mkdir(fakeDir, { recursive: true });
const fakeExe = join(fakeDir, 'claude.exe');
await copyFile(process.execPath, fakeExe);
const waitForever = ['-e', 'setInterval(() => {}, 1e9)'];
const fake = spawn(fakeExe, waitForever, { detached: true, stdio: 'ignore' });
fake.unref();
const fakeEnv = {
  LOCUS_CLAUDE_DESKTOP_PATTERN: String.raw`\\fake-claude-desktop\\claude\.exe$`,
  LOCUS_CLAUDE_DESKTOP_LAUNCH: JSON.stringify([fakeExe, ...waitForever]),
};
const fakePids = () =>
  execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Where-Object { $_.ExecutablePath -like '*fake-claude-desktop*' } | ForEach-Object { $_.ProcessId }"], { encoding: 'utf8' })
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
let after = [];
{
  const { app, win } = await launch(fakeEnv);
  await win.getByTitle('Settings').waitFor({ timeout: 15000 });
  await win.getByTitle('Settings').click();
  await win.getByRole('button', { name: 'Set up Claude…' }).click();
  const desk = win.locator('.claude-row', { hasText: 'Claude Desktop' });
  await desk.getByRole('button', { name: 'Connect' }).click();
  await desk.getByRole('button', { name: 'Restart Claude Desktop' }).click({ timeout: 15000 });
  await desk.getByText('Chats in progress stop').waitFor();
  await desk.getByRole('button', { name: 'Restart now' }).click();
  await desk.getByText('Restarted Claude Desktop').waitFor({ timeout: 20000 });
  await win.screenshot({ path: join(out, 'restart.png') });
  // Check and stop the stand-in before closing: it inherited the test harness's pipes to the app.
  after = fakePids();
  for (const pid of after) execFileSync('taskkill', ['/PID', String(pid), '/F']);
  await app.close();
}
check('restart closes Claude Desktop and opens it again', after.length === 1 && after[0] !== fake.pid, `before ${fake.pid}, after ${after}`);

// 4. Uninstalling removes only what Locus added.
execFileSync(join(repo, 'node_modules', 'electron', 'dist', 'electron.exe'), [repo, '--remove-claude'], { env, timeout: 60000 });
const last = await json(deskCfg);
check('remove takes out the Claude Code plugin folder', !existsSync(plugin));
check('remove takes out only the Locus Desktop entry', !last.mcpServers.locus && JSON.stringify(last.mcpServers.other) === JSON.stringify(otherServer) && last.preferences?.keep === true);

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
