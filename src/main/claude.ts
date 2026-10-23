// Connecting Locus to Claude: finds Claude Code and Claude Desktop on this computer and installs
// the Locus tools into them, so people never edit config files. Both run the MCP server that ships
// inside Locus, on Locus itself (Electron as Node) with its bundled git, so updating Locus updates
// what Claude uses and neither Node nor git needs installing.
// - Claude Code: a plugin folder in ~/.claude/skills/locus (a plugin installed from the
//   marketplace is updated there instead of adding a second copy).
// - Claude Desktop: a "locus" entry in claude_desktop_config.json.
import { app } from 'electron';
import { execFile, spawn } from 'node:child_process';
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
  const desktop: ClaudeStatus['desktop'] = {
    found: desktopFound,
    current,
    running: desktopFound ? await desktopRunning() : false,
    ...(entry ? { installed: { version: sameEntry(entry) ? current : '' } } : {}),
  };
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

// ---------- Restarting Claude Desktop ----------

// Claude Desktop's main process: its claude.exe (Store or classic install) without Electron's
// --type= flag. Claude Code's command-line tool is also claude.exe but lives elsewhere. Tests point
// this at a stand-in program.
const DESKTOP_EXE = () => process.env.LOCUS_CLAUDE_DESKTOP_PATTERN || String.raw`\\(WindowsApps\\Claude_[^\\]+\\app|AnthropicClaude\\app-[^\\]+)\\claude\.exe$`;

function powershell(script: string, timeout = 20000): Promise<string> {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], timeout).then((r) => r.out.trim());
}

async function desktopProcess(): Promise<{ pid: number; path: string } | null> {
  const out = await powershell(
    `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -match '${DESKTOP_EXE().replace(/'/g, "''")}' -and $_.CommandLine -notmatch '--type=' } | Select-Object -First 1 ProcessId, ExecutablePath | ConvertTo-Json -Compress`,
  );
  try {
    const p = JSON.parse(out) as { ProcessId: number; ExecutablePath: string };
    return { pid: p.ProcessId, path: p.ExecutablePath };
  } catch {
    return null;
  }
}

export async function desktopRunning(): Promise<boolean> {
  return !!(await desktopProcess());
}

/** Quits Claude Desktop (it stays in the tray when its window closes, so the process is ended) and opens it again. */
export async function restartClaudeDesktop(): Promise<{ ok: boolean; message: string }> {
  const proc = await desktopProcess();
  if (proc) {
    await run('taskkill', ['/PID', String(proc.pid), '/T', '/F'], 20000);
    for (let i = 0; i < 40 && (await desktopProcess()); i++) await new Promise((r) => setTimeout(r, 250));
    if (await desktopProcess()) return { ok: false, message: "Claude Desktop didn't close. Quit it from the tray icon and open it again." };
  }
  // Open it the way the Start menu does (works for the Store version too), else from its program file.
  const launch = process.env.LOCUS_CLAUDE_DESKTOP_LAUNCH;
  const appId = launch ? '' : await powershell(`(Get-StartApps | Where-Object { $_.Name -eq 'Claude' } | Select-Object -First 1).AppID`);
  // (Tests set LOCUS_CLAUDE_DESKTOP_LAUNCH to a JSON [command, ...args] for a stand-in.)
  const [cmd, args] = launch ? [JSON.parse(launch)[0], JSON.parse(launch).slice(1)] : appId ? ['explorer.exe', [`shell:AppsFolder\\${appId}`]] : proc ? [proc.path, []] : [null, []];
  if (!cmd) return { ok: false, message: "Couldn't find Claude Desktop to open it. Open it from the Start menu." };
  spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return { ok: true, message: proc ? 'Restarted Claude Desktop. Locus is ready there.' : 'Opened Claude Desktop. Locus is ready there.' };
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
