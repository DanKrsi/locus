// Connecting Locus to Claude: finds Claude Code and Claude Desktop on this computer and installs
// the Locus tools into them, so people never edit config files.
// - Claude Code: updates the Locus plugin if it was installed from the marketplace; otherwise
//   installs a plugin folder in ~/.claude/skills/locus whose server runs on Locus itself
//   (Electron as Node), so neither Node nor git needs to be installed.
// - Claude Desktop: opens the bundled locus.mcpb, and Claude asks the person to confirm.
import { app, shell } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeStatus } from '../shared/api';

const PLUGIN_NAME = 'locus';

/** Where the plugin, skill and server ship: unpacked beside the app, or the repo in development. */
function pluginSource(): string {
  return app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked', 'plugin') : join(app.getAppPath(), 'plugin');
}
function mcpbSource(): string {
  return app.isPackaged ? join(process.resourcesPath, 'claude', 'locus.mcpb') : join(app.getAppPath(), 'release', 'locus.mcpb');
}
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const desktopHome = () => process.env.LOCUS_CLAUDE_DESKTOP_DIR || join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude');

async function bundledVersion(): Promise<string> {
  const raw = JSON.parse(await fs.readFile(join(pluginSource(), '.claude-plugin', 'plugin.json'), 'utf8'));
  return raw.version as string;
}

function run(cmd: string, args: string[], timeout = 60000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    // .cmd shims (npm installs) need a shell on Windows.
    execFile(cmd, args, { timeout, windowsHide: true, shell: /\.cmd$/i.test(cmd), maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || stderr || err?.message || '') }),
    );
  });
}

/** The claude command, if Claude Code is installed. */
async function findClaudeCli(): Promise<string | null> {
  const where = await run('where', ['claude'], 10000);
  if (where.ok) {
    const first = where.out.split(/\r?\n/).map((l) => l.trim()).find((l) => /\.(exe|cmd)$/i.test(l));
    if (first) return first;
  }
  for (const p of [join(homedir(), '.local', 'bin', 'claude.exe'), join(process.env.APPDATA ?? '', 'npm', 'claude.cmd')]) if (existsSync(p)) return p;
  return null;
}

interface PluginEntry {
  id: string;
  version?: string;
  installPath?: string;
}

async function installedPlugins(cli: string): Promise<PluginEntry[]> {
  const r = await run(cli, ['plugin', 'list', '--json']);
  try {
    return JSON.parse(r.out.slice(r.out.indexOf('['))) as PluginEntry[];
  } catch {
    return [];
  }
}

/** The installed Locus extension in Claude Desktop, read from its extension folders. */
async function desktopExtension(): Promise<{ version: string } | null> {
  const dir = join(desktopHome(), 'Claude Extensions');
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  for (const e of entries) {
    const m = await fs.readFile(join(dir, e, 'manifest.json'), 'utf8').then(JSON.parse, () => null);
    if (m?.name === PLUGIN_NAME) return { version: String(m.version ?? '') };
  }
  return null;
}

export async function claudeStatus(): Promise<ClaudeStatus> {
  const current = await bundledVersion();
  const cli = await findClaudeCli();
  let code: ClaudeStatus['code'] = { found: !!cli || existsSync(claudeHome()), current };
  if (cli) {
    const p = (await installedPlugins(cli)).find((x) => x.id.split('@')[0] === PLUGIN_NAME);
    if (p) code = { ...code, installed: { version: p.version ?? '', source: p.id.endsWith('@skills-dir') ? 'app' : 'marketplace' } };
  }
  const desktopFound = existsSync(desktopHome());
  const ext = desktopFound ? await desktopExtension() : null;
  return { code, desktop: { found: desktopFound, current, ...(ext ? { installed: ext } : {}) } };
}

/** Writes the Locus plugin for Claude Code into ~/.claude/skills/locus (replacing an older copy). */
async function installSkillsDirPlugin(version: string): Promise<void> {
  const src = pluginSource();
  const dest = join(claudeHome(), 'skills', PLUGIN_NAME);
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(join(dest, '.claude-plugin'), { recursive: true });
  const manifest = JSON.parse(await fs.readFile(join(src, '.claude-plugin', 'plugin.json'), 'utf8'));
  await fs.writeFile(join(dest, '.claude-plugin', 'plugin.json'), JSON.stringify({ ...manifest, version, skills: ['./'] }, null, 2) + '\n');
  await fs.copyFile(join(src, 'skills', 'locus', 'SKILL.md'), join(dest, 'SKILL.md'));
  // The server runs on Locus itself; its bundled git sits beside the server in the app folder.
  const server = join(src, 'server', 'server.mjs');
  const mcp = { mcpServers: { locus: { command: process.execPath, args: [server], env: { ELECTRON_RUN_AS_NODE: '1' } } } };
  await fs.writeFile(join(dest, '.mcp.json'), JSON.stringify(mcp, null, 2) + '\n');
}

export async function connectClaude(target: 'code' | 'desktop'): Promise<{ ok: boolean; message: string }> {
  const version = await bundledVersion();
  if (target === 'desktop') {
    const file = mcpbSource();
    if (!existsSync(file)) return { ok: false, message: 'The Claude Desktop extension is missing from this copy of Locus.' };
    const err = await shell.openPath(file);
    return err ? { ok: false, message: `Couldn't open the extension: ${err}` } : { ok: true, message: 'Claude Desktop is asking you to install the Locus extension. Click Install there.' };
  }
  const cli = await findClaudeCli();
  const plugin = cli ? (await installedPlugins(cli)).find((x) => x.id.split('@')[0] === PLUGIN_NAME) : undefined;
  if (cli && plugin && !plugin.id.endsWith('@skills-dir')) {
    // Installed from the marketplace: update it there rather than adding a second copy.
    const marketplace = plugin.id.split('@')[1];
    await run(cli, ['plugin', 'marketplace', 'update', marketplace], 120000);
    const r = await run(cli, ['plugin', 'update', plugin.id], 120000);
    return r.ok
      ? { ok: true, message: 'Updated the Locus plugin in Claude Code. Start a new Claude Code session to use it.' }
      : { ok: false, message: `Couldn't update the Locus plugin: ${r.out.trim().split('\n').pop()}` };
  }
  await installSkillsDirPlugin(version);
  return { ok: true, message: 'Connected Claude Code. Start a new Claude Code session to use Locus there.' };
}
