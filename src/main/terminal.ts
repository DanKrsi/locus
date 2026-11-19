// The Claude panel's terminal (UI spec §6.3): Claude Code, or a plain shell, running in the
// workspace folder in a real terminal. Main decides what runs; the page only asks for "claude" or
// "shell", never a command, since notes from shared workspaces are drawn there. One session at a
// time, kept alive while the panel is hidden, and ended when the workspace closes or Locus quits.
import type { IPty } from 'node-pty';
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import type { TerminalKind, TerminalStart } from '../shared/api';
import { findClaudeCli } from './claude';
import { liveConfig } from './live';

let pty: IPty | null = null;
let current: { kind: TerminalKind; cwd: string } | null = null;
let send: (channel: string, payload: unknown) => void = () => undefined;

export function onTerminalOutput(fn: (channel: string, payload: unknown) => void) {
  send = fn;
}

/** What Claude is told about running inside Locus (kept free of characters cmd.exe treats specially). */
const PROMPT = [
  'You are running in the Claude panel inside Locus, a notes app whose markdown links point at exact places in files.',
  'The locus-live tools see what the user sees: call current_view whenever they say this, here, the selected text, the open file or what they are looking at, and use show to open a place for them.',
  'Links the user pastes in angle brackets are Locus references to exact places.',
  'The user watches the notes as you change them, so keep edits focused.',
].join(' ');

/** Environment for the session: the user's own, without what only matters to Locus itself or to a Claude Code that started Locus. */
function environment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of ['ELECTRON_RUN_AS_NODE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_AGENT_SDK_VERSION', 'LOCUS_TERMINAL_CMD']) delete env[k];
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

/** The full path of a program named without one, found on PATH as Windows would (the terminal needs it spelled out). */
async function onPath(file: string): Promise<string> {
  if (isAbsolute(file) || file.includes('/') || file.includes('\\')) return file;
  const exts = /\.[a-z0-9]+$/i.test(file) ? [''] : ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase())];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const full = join(dir, file + ext);
      if (await fs.stat(full).then((s) => s.isFile(), () => false)) return full;
    }
  }
  return file;
}

/** One argument as Windows programs read their command line (quoted when it has spaces or quotes). */
const quoteArg = (a: string) => (a && !/[\s"]/.test(a) ? a : `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`);

/**
 * Runs a program, through cmd.exe when it is a .cmd or .bat script (as npm installs). cmd.exe gets
 * the whole line as one quoted string with /s, which keeps quoted paths with spaces intact (with
 * plain /c it strips the first and last quote of the line, so "C:\Users\A B\claude.cmd" breaks).
 */
async function program(file: string, args: string[]): Promise<{ file: string; args: string[] | string }> {
  const full = await onPath(file);
  if (/\.(cmd|bat)$/i.test(full)) return { file: await onPath('cmd.exe'), args: `/d /s /c "${[full, ...args].map(quoteArg).join(' ')}"` };
  return { file: full, args };
}

/** What to run: Claude Code with the live tools, or the user's shell. Tests swap Claude for a stand-in. */
async function command(kind: TerminalKind): Promise<{ file: string; args: string[] | string } | null> {
  if (kind === 'shell') return program('powershell.exe', ['-NoLogo']);
  const override = process.env.LOCUS_TERMINAL_CMD;
  const live = await liveConfig();
  const configFile = join(app.getPath('userData'), 'claude-panel-mcp.json');
  await fs.writeFile(configFile, JSON.stringify(live, null, 2), { mode: 0o600 });
  const claudeArgs = ['--mcp-config', configFile, '--append-system-prompt', PROMPT];
  if (override) {
    const [file, ...rest] = JSON.parse(override) as string[];
    return program(file, [...rest, ...claudeArgs]);
  }
  const cli = await findClaudeCli();
  return cli ? program(cli, claudeArgs) : null;
}

export async function startTerminal(kind: TerminalKind, cwd: string, cols: number, rows: number): Promise<TerminalStart> {
  stopTerminal();
  const cmd = await command(kind);
  if (!cmd) return { ok: false, reason: 'no-claude' };
  const { spawn } = await import('node-pty');
  try {
    const p = spawn(cmd.file, cmd.args, {
      name: 'xterm-256color',
      cols: Math.max(20, cols),
      rows: Math.max(5, rows),
      cwd,
      env: environment(),
      useConpty: true,
    });
    pty = p;
    current = { kind, cwd };
    p.onData((data) => {
      if (pty === p) send('terminal-data', data);
    });
    p.onExit(({ exitCode }) => {
      if (pty !== p) return;
      pty = null;
      current = null;
      send('terminal-exit', { code: exitCode });
    });
    return { ok: true, kind };
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: 'failed', message: `${cmd.file} couldn't be run (${why.trim()}).` };
  }
}

export function terminalRunning(): { kind: TerminalKind; cwd: string } | null {
  return current;
}

export function writeTerminal(data: string) {
  pty?.write(data);
}

export function resizeTerminal(cols: number, rows: number) {
  if (pty && cols >= 2 && rows >= 2) {
    try {
      pty.resize(cols, rows);
    } catch {
      /* the session may have just ended */
    }
  }
}

/** Ends the session; `tell` lets the page know (when it ended for a reason other than the page asking). */
export function stopTerminal(tell = false) {
  const p = pty;
  pty = null;
  current = null;
  if (!p) return;
  if (tell) send('terminal-exit', { code: -1 });
  try {
    p.kill();
  } catch {
    /* already gone */
  }
}
