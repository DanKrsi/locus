// Connecting Locus to Claude: finds Claude Code and Claude Desktop on this computer and installs
// the Locus tools into them, so people never edit config files. Both run the MCP server that ships
// inside Locus, on Locus itself (Electron as Node) with its bundled git, so updating Locus updates
// what Claude uses and neither Node nor git needs installing.
// - Claude Code: a plugin folder in ~/.claude/skills/locus (a plugin installed from the
//   marketplace is updated there instead of adding a second copy).
// - Claude Desktop: a "locus" entry in claude_desktop_config.json.
import { app } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ClaudeStatus } from '../shared/api';

const NAME = 'locus';

/** Where the plugin, skill and server ship: unpacked beside the app, or the repo in development. */
function pluginSource(): string {
  return app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked', 'plugin') : join(app.getAppPath(), 'plugin');
}
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const desktopHome = () => process.env.LOCUS_CLAUDE_DESKTOP_DIR || join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Claude');
const desktopConfig = () => join(desktopHome(), 'claude_desktop_config.json');
const skillsDir = () => join(claudeHome(), 'skills', NAME);

/** How Claude starts the server: Locus.exe as Node, running the server inside this install. */
function serverEntry() {
  return { command: process.execPath, args: [join(pluginSource(), 'server', 'server.mjs')], env: { ELECTRON_RUN_AS_NODE: '1' } };
}
const sameEntry = (e: unknown) => {
  const want = serverEntry();
  const got = e as { command?: string; args?: string[] } | undefined;
  return !!got && got.command?.toLowerCase() === want.command.toLowerCase() && got.args?.[0]?.toLowerCase() === want.args[0].toLowerCase();
};

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
}

async function installedPlugins(cli: string): Promise<PluginEntry[]> {
  const r = await run(cli, ['plugin', 'list', '--json']);
  try {
    return JSON.parse(r.out.slice(r.out.indexOf('['))) as PluginEntry[];
  } catch {
    return [];
  }
}

/** The Locus plugin folder written by Locus, if it points at this install: its version. */
async function skillsDirVersion(): Promise<string | null> {
  const manifest = await fs.readFile(join(skillsDir(), '.claude-plugin', 'plugin.json'), 'utf8').then(JSON.parse, () => null);
  if (!manifest) return null;
  const mcp = await fs.readFile(join(skillsDir(), '.mcp.json'), 'utf8').then(JSON.parse, () => null);
  // Pointing at another copy of Locus (moved, or a development build) counts as out of date.
  return sameEntry(mcp?.mcpServers?.[NAME]) ? String(manifest.version) : '';
}

async function readDesktopConfig(): Promise<Record<string, unknown> | null> {
  const text = await fs.readFile(desktopConfig(), 'utf8').catch(() => null);
  if (text === null) return {};
  try {
    return JSON.parse(text);
  } catch {
    return null; // Not valid JSON: leave it alone.
  }
}

export async function claudeStatus(): Promise<ClaudeStatus> {
  const current = await bundledVersion();
  const cli = await findClaudeCli();
  let code: ClaudeStatus['code'] = { found: !!cli || existsSync(claudeHome()), current };
  const own = await skillsDirVersion();
  const market = cli ? (await installedPlugins(cli)).find((x) => x.id.split('@')[0] === NAME && !x.id.endsWith('@skills-dir')) : undefined;
  if (market) code = { ...code, installed: { version: market.version ?? '', source: 'marketplace' } };
  else if (own !== null) code = { ...code, installed: { version: own, source: 'app' } };
  const desktopFound = existsSync(desktopHome());
  const cfg = desktopFound ? await readDesktopConfig() : null;
  const entry = (cfg?.mcpServers as Record<string, unknown> | undefined)?.[NAME];
  // The Desktop entry runs this install's server, so it is as current as Locus itself.
  const desktop: ClaudeStatus['desktop'] = { found: desktopFound, current, ...(entry ? { installed: { version: sameEntry(entry) ? current : '' } } : {}) };
  return { code, desktop };
}

/** Writes the Locus plugin for Claude Code into ~/.claude/skills/locus (replacing an older copy). */
async function installSkillsDirPlugin(version: string): Promise<void> {
  const src = pluginSource();
  const dest = skillsDir();
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(join(dest, '.claude-plugin'), { recursive: true });
  const manifest = JSON.parse(await fs.readFile(join(src, '.claude-plugin', 'plugin.json'), 'utf8'));
  await fs.writeFile(join(dest, '.claude-plugin', 'plugin.json'), JSON.stringify({ ...manifest, version, skills: ['./'] }, null, 2) + '\n');
  await fs.copyFile(join(src, 'skills', 'locus', 'SKILL.md'), join(dest, 'SKILL.md'));
  await fs.writeFile(join(dest, '.mcp.json'), JSON.stringify({ mcpServers: { [NAME]: serverEntry() } }, null, 2) + '\n');
}

/** Adds (or repoints) the Locus entry in Claude Desktop's config, keeping everything else as it was. */
async function writeDesktopEntry(): Promise<void> {
  const cfg = await readDesktopConfig();
  if (cfg === null) throw new Error("Claude Desktop's settings file isn't valid JSON, so Locus left it alone.");
  const file = desktopConfig();
  // Keep a copy of the original the first time Locus touches it.
  if (existsSync(file) && !existsSync(file + '.before-locus')) await fs.copyFile(file, file + '.before-locus');
  const servers = { ...((cfg.mcpServers as Record<string, unknown>) ?? {}), [NAME]: serverEntry() };
  await fs.mkdir(desktopHome(), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ ...cfg, mcpServers: servers }, null, 2) + '\n');
}

export async function connectClaude(target: 'code' | 'desktop'): Promise<{ ok: boolean; message: string }> {
  if (target === 'desktop') {
    try {
      await writeDesktopEntry();
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    return { ok: true, message: 'Added Locus to Claude Desktop. Quit and reopen Claude Desktop to use it.' };
  }
  const cli = await findClaudeCli();
  const market = cli ? (await installedPlugins(cli)).find((x) => x.id.split('@')[0] === NAME && !x.id.endsWith('@skills-dir')) : undefined;
  if (cli && market) {
    // Installed from the marketplace: update it there rather than adding a second copy.
    await run(cli, ['plugin', 'marketplace', 'update', market.id.split('@')[1]], 120000);
    const r = await run(cli, ['plugin', 'update', market.id], 120000);
    return r.ok
      ? { ok: true, message: 'Updated the Locus plugin in Claude Code. Start a new Claude Code session to use it.' }
      : { ok: false, message: `Couldn't update the Locus plugin: ${r.out.trim().split('\n').pop()}` };
  }
  await installSkillsDirPlugin(await bundledVersion());
  return { ok: true, message: 'Connected Claude Code. Start a new Claude Code session to use Locus there.' };
}

/**
 * On startup: where Locus set Claude up before, bring that setup up to date with this install
 * (a newer skill, or a moved Locus) without asking. Only touches what Locus itself wrote.
 */
export async function refreshClaude(): Promise<void> {
  const version = await bundledVersion();
  const own = await skillsDirVersion();
  if (own !== null && own !== version) await installSkillsDirPlugin(version);
  const cfg = existsSync(desktopConfig()) ? await readDesktopConfig() : null;
  const entry = (cfg?.mcpServers as Record<string, unknown> | undefined)?.[NAME];
  if (entry && !sameEntry(entry)) await writeDesktopEntry();
}

/** Removes what Locus added to Claude (run by the uninstaller). */
export async function removeClaude(): Promise<void> {
  const manifest = await fs.readFile(join(skillsDir(), '.claude-plugin', 'plugin.json'), 'utf8').then(JSON.parse, () => null);
  if (manifest?.name === NAME) await fs.rm(skillsDir(), { recursive: true, force: true });
  const cfg = existsSync(desktopConfig()) ? await readDesktopConfig() : null;
  const servers = cfg?.mcpServers as Record<string, unknown> | undefined;
  if (cfg && servers?.[NAME]) {
    delete servers[NAME];
    await fs.writeFile(desktopConfig(), JSON.stringify(cfg, null, 2) + '\n');
  }
}
