// The Claude panel's chat (UI spec §6.3): the user's own Claude Code, run in the background in the
// workspace folder and spoken to over its stream-json protocol (claude -p --input-format
// stream-json). Locus never signs in to anything: Claude Code uses whatever sign-in the user gave
// it. Main owns the conversation, so hiding the panel or reloading the window loses nothing.
//
// Approvals: the locus-live tools that only look (and open places) run without asking; anything
// else Claude Code would ask about comes here as a can_use_tool request, and the page shows
// Allow / Allow for this chat / Deny. A note open in Locus is never written behind the editor's
// back: file writes to it are refused, pointing Claude at edit_note, which changes the editor
// itself (undoable, never over unsaved typing).
import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { ChatAnswer, ChatEvent, ChatItem, ChatStart } from '../shared/api';
import { claudeStatus, findClaudeCli, serverEntry } from './claude';
import { LOOK_TOOLS, liveConfig, livePageCall } from './live';
import { environment, program } from './terminal';

/** What Claude is told about working inside Locus. */
const PROMPT = [
  'You are working inside Locus, a notes app whose markdown links point at exact places in files (PDF pages and boxed areas, spreadsheet cells, slides, code lines, note headings, past versions).',
  'The user is talking to you in a narrow chat panel at the right of the window, beside the note they are writing (left) and the document viewer (middle). Keep replies short and plain.',
  'The locus-live tools see and work the app: current_view says what is open and selected; read_note reads a note as it is on screen, unsaved typing included, with line numbers; screenshot shows you the window or one pane; show opens a place for the user (a page, area, cells, slide, lines or heading).',
  'To change a note, use edit_note (exact text replacements) or insert_text, never Write, Edit or write_note on a note that is open in Locus: those land behind the editor, while edit_note changes it in front of the user, highlighted and undoable. Read the note with read_note first so your old_text matches exactly.',
  'To cite what the user has selected or in view in the document viewer, use cite_selection: it goes through Locus\'s own Cite, which records the version. For any other place, get the link from make_reference (never hand-write reference links) and put it in with edit_note or insert_text.',
  'When you mention a place, write it as a Locus reference link so the user can click it. Changing things asks the user first; if they deny, do not try another way round.',
].join(' ');

let proc: ChildProcess | null = null;
let procCwd: string | null = null;
let items: ChatItem[] = [];
let busy = false;
let partial = '';
let model: string | undefined;
/** Claude Code's id for this conversation, so a restarted process picks it back up. */
let sessionId: string | undefined;
let stoppedTurn = false;
let stderrTail = '';
let started = false;
let seq = 0;
/** Tools the user said yes to for the rest of this chat. */
let always = new Set<string>();
/** Approvals waiting on the user: request id → how to answer Claude Code. */
const pending = new Map<string, { tool: string; input: Record<string, unknown> }>();
let send: (channel: string, payload: unknown) => void = () => undefined;

export function onChatEvent(fn: (channel: string, payload: unknown) => void) {
  send = fn;
}

const nextId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

function emit(ev: ChatEvent) {
  send('chat-event', ev);
}

function upsert(item: ChatItem) {
  const i = items.findIndex((x) => x.id === item.id);
  if (i >= 0) items[i] = item;
  else {
    items.push(item);
    if (items.length > 1500) items = items.slice(-1200);
  }
  emit({ upsert: item });
}

function setBusy(b: boolean) {
  busy = b;
  if (!b) partial = '';
  emit({ busy, partial });
}

export function chatState(cwd: string | null): ChatEvent {
  const mine = !!cwd && procCwd === cwd;
  return { reset: true, items: mine ? items : [], busy: mine && busy, partial: mine ? partial : '', model: mine ? model : undefined };
}

function write(o: unknown) {
  if (!proc?.stdin?.writable) return false;
  proc.stdin.write(JSON.stringify(o) + '\n');
  return true;
}

function respond(requestId: string, response: unknown) {
  write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
}

/** The workspace path ("/notes/a.md") of a file Claude names by an absolute or relative path. */
function wsPathOf(file: unknown): string | null {
  if (typeof file !== 'string' || !file || !procCwd) return null;
  const rel = relative(procCwd, isAbsolute(file) ? file : join(procCwd, file));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return '/' + rel.replace(/\\/g, '/');
}

/** A file write that would land behind a note open in the editor: the reason it is refused, or null. */
async function writesOpenNote(tool: string, input: Record<string, unknown>): Promise<string | null> {
  let target: string | null = null;
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) target = wsPathOf(input.file_path ?? input.notebook_path);
  else if (/__write_note$/.test(tool) || /__write_flowchart$/.test(tool)) target = typeof input.path === 'string' ? '/' + input.path.replace(/\\/g, '/').replace(/^\/+/, '') : null;
  if (!target) return null;
  const open = (await livePageCall('openNotes', {}).catch(() => [])) as string[];
  const hit = Array.isArray(open) && open.find((p) => p.toLowerCase() === target!.toLowerCase());
  if (!hit) return null;
  return `${hit} is open in Locus, so writing the file would land behind the editor. Use the locus-live tool edit_note (or insert_text) instead: it changes the note on screen, where the user sees it and can undo it.`;
}

async function onPermission(requestId: string, req: Record<string, unknown>) {
  const tool = String(req.tool_name ?? '');
  const input = (req.input && typeof req.input === 'object' ? req.input : {}) as Record<string, unknown>;
  const refused = await writesOpenNote(tool, input);
  if (refused) {
    respond(requestId, { behavior: 'deny', message: refused });
    return;
  }
  if (always.has(tool)) {
    respond(requestId, { behavior: 'allow', updatedInput: input });
    return;
  }
  pending.set(requestId, { tool, input });
  upsert({
    t: 'ask',
    id: requestId,
    tool,
    title: String(req.display_name ?? req.title ?? tool),
    description: typeof req.description === 'string' ? req.description : undefined,
    input,
  });
}

export function chatAnswer(id: string, answer: ChatAnswer) {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (answer === 'always') always.add(p.tool);
  respond(id, answer === 'deny' ? { behavior: 'deny', message: 'The user said no to this.' } : { behavior: 'allow', updatedInput: p.input });
  const item = items.find((x) => x.id === id);
  if (item?.t === 'ask') upsert({ ...item, answer });
}

/** Answers every waiting approval with no (on Stop, a new chat, or the session ending). */
function cancelPending(message: string) {
  for (const [id] of pending) {
    respond(id, { behavior: 'deny', message, interrupt: true });
    const item = items.find((x) => x.id === id);
    if (item?.t === 'ask') upsert({ ...item, answer: 'cancelled' });
  }
  pending.clear();
}

const short = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

/** A tool result as a line of text for the activity row. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return short(content, 1200);
  if (Array.isArray(content))
    return short(
      content
        .map((b) => (b && typeof b === 'object' ? ((b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : (b as { type?: string }).type === 'image' ? '[picture]' : '') : ''))
        .filter(Boolean)
        .join('\n'),
      1200,
    );
  return '';
}

const signInWords = /not logged in|log ?in|\/login|sign ?in|authenticat|oauth|api key|credit balance|subscription/i;

function onMessage(m: Record<string, unknown>) {
  const type = m.type;
  if (type === 'control_request') {
    const req = (m.request ?? {}) as Record<string, unknown>;
    const id = String(m.request_id ?? '');
    if (req.subtype === 'can_use_tool') void onPermission(id, req);
    else write({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'Locus does not handle this request.' } });
    return;
  }
  if (type === 'control_response' || type === 'rate_limit_event' || type === 'keep_alive') return;
  if (type === 'system') {
    if (m.subtype === 'init') {
      started = true;
      if (typeof m.session_id === 'string') sessionId = m.session_id;
      if (typeof m.model === 'string' && m.model !== model) {
        model = m.model;
        emit({ model });
      }
    }
    return;
  }
  // What a subagent does inside a task stays inside it.
  if (m.parent_tool_use_id) return;
  if (type === 'stream_event') {
    const ev = (m.event ?? {}) as { type?: string; delta?: { type?: string; text?: string } };
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
      partial += ev.delta.text;
      emit({ partial });
    } else if (ev.type === 'content_block_start' || ev.type === 'message_start') {
      if (partial) emit({ partial: (partial = '') });
    }
    return;
  }
  if (type === 'assistant') {
    const msg = (m.message ?? {}) as { id?: string; content?: unknown[] };
    for (const [i, raw] of (msg.content ?? []).entries()) {
      const b = raw as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
      if (b.type === 'text' && b.text?.trim()) upsert({ t: 'text', id: `${String(m.uuid ?? msg.id ?? nextId('a'))}:${i}`, text: b.text });
      else if (b.type === 'tool_use' && b.id) upsert({ t: 'tool', id: b.id, name: String(b.name ?? ''), input: b.input ?? {} });
    }
    if (partial) emit({ partial: (partial = '') });
    return;
  }
  if (type === 'user') {
    const content = ((m.message ?? {}) as { content?: unknown }).content;
    if (!Array.isArray(content)) return;
    for (const raw of content) {
      const b = raw as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown; text?: string };
      if (b.type === 'tool_result' && b.tool_use_id) {
        const item = items.find((x) => x.id === b.tool_use_id);
        if (item?.t === 'tool') upsert({ ...item, result: { ok: !b.is_error, text: resultText(b.content) } });
      } else if (b.type === 'text' && /^\[Request interrupted/.test(b.text ?? '')) stoppedTurn = true;
    }
    return;
  }
  if (type === 'result') {
    const errored = m.is_error === true || (typeof m.subtype === 'string' && m.subtype !== 'success');
    if (stoppedTurn) upsert({ t: 'note', id: nextId('n'), kind: 'stopped', text: 'Stopped.' });
    else if (errored) {
      const errs = Array.isArray(m.errors) ? (m.errors as unknown[]).map(String).join('\n') : '';
      const text = String((typeof m.result === 'string' && m.result) || errs || 'Claude Code ran into a problem with that request.');
      upsert({ t: 'note', id: nextId('n'), kind: signInWords.test(text) ? 'signin' : 'error', text: short(text, 1500) });
    }
    stoppedTurn = false;
    cancelPending('The turn ended.');
    setBusy(false);
  }
}

/** Whether Claude Code has the Locus tools (asking it is slow, so the answer is kept a while). */
let hasLocusTools: { at: number; yes: boolean } | null = null;
async function claudeHasLocusTools(): Promise<boolean> {
  if (hasLocusTools && Date.now() - hasLocusTools.at < 10 * 60_000) return hasLocusTools.yes;
  const status = await claudeStatus().catch(() => null);
  hasLocusTools = { at: Date.now(), yes: !!status?.code.installed };
  return hasLocusTools.yes;
}

/** After Set up adds the Locus tools to Claude Code, ask again next time. */
export function forgetClaudeTools() {
  hasLocusTools = null;
}

/** The --mcp-config for the chat: the live tools, and the Locus tools when Claude Code doesn't have them yet. */
async function mcpConfig(): Promise<string> {
  const config = (await liveConfig()) as { mcpServers: Record<string, unknown> };
  if (!(await claudeHasLocusTools())) config.mcpServers.locus = { type: 'stdio', ...serverEntry() };
  const file = join(app.getPath('userData'), 'claude-chat-mcp.json');
  await fs.writeFile(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  return file;
}

async function command(resume?: string): Promise<{ file: string; args: string[] | string } | null> {
  const args = [
    ...(resume ? ['--resume', resume] : []),
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-prompt-tool', 'stdio',
    // Locus asks before changes whatever mode the user runs Claude Code in elsewhere.
    '--permission-mode', 'default',
    '--mcp-config', await mcpConfig(),
    '--allowedTools', LOOK_TOOLS.map((t) => `mcp__locus-live__${t}`).join(','),
    // Its multiple-choice question box has nowhere to show here: Claude asks in words instead.
    '--disallowedTools', 'AskUserQuestion',
    '--append-system-prompt', PROMPT,
  ];
  const override = process.env.LOCUS_CHAT_CMD;
  if (override) {
    const [file, ...rest] = JSON.parse(override) as string[];
    return program(file, [...rest, ...args]);
  }
  const cli = await findClaudeCli();
  return cli ? program(cli, args) : null;
}

async function startProcess(cwd: string, resume?: string): Promise<ChatStart> {
  const cmd = await command(resume);
  if (!cmd) return { ok: false, reason: 'no-claude' };
  const verbatim = typeof cmd.args === 'string';
  let p: ChildProcess;
  try {
    p = spawn(cmd.file, verbatim ? [cmd.args as string] : (cmd.args as string[]), {
      cwd,
      env: environment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
    });
  } catch (e) {
    return { ok: false, reason: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
  proc = p;
  procCwd = cwd;
  started = false;
  stderrTail = '';
  let buf = '';
  p.stdout?.setEncoding('utf8');
  p.stdout?.on('data', (d: string) => {
    if (proc !== p) return;
    buf += d;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        /* a line that isn't a message */
      }
    }
  });
  p.stderr?.setEncoding('utf8');
  p.stderr?.on('data', (d: string) => {
    stderrTail = (stderrTail + d).slice(-4000);
  });
  p.stdin?.on('error', () => undefined);
  const failed = new Promise<ChatStart>((resolve) => {
    p.once('error', (e) => resolve({ ok: false, reason: 'failed', message: `${cmd.file} couldn't be run (${e.message}).` }));
  });
  p.on('exit', (code) => {
    if (proc !== p) return;
    proc = null;
    pending.clear();
    const wasBusy = busy;
    if (wasBusy || !started) {
      const why = stderrTail.split(/\r?\n/).filter((l) => l.trim() && !/^\[mcp-sdk\]/.test(l)).slice(-6).join('\n').trim();
      const text = why || `Claude Code stopped (exit code ${code ?? '?'}).`;
      upsert({ t: 'note', id: nextId('n'), kind: signInWords.test(text) ? 'signin' : 'error', text: short(text, 1500) });
    }
    setBusy(false);
  });
  // A program that can't start fails at once; one that starts keeps running until stdin closes.
  const ok = await Promise.race([failed, new Promise<ChatStart>((r) => setTimeout(() => r({ ok: true }), 150))]);
  if (!ok.ok) {
    proc = null;
    return ok;
  }
  return { ok: true };
}

/** Sends what the user typed, starting Claude Code first if it isn't running. */
export async function chatSend(cwd: string, text: string): Promise<ChatStart> {
  const t = text.trim();
  if (!t) return { ok: true };
  if (proc && procCwd !== cwd) chatStop(true);
  if (procCwd !== cwd) {
    items = [];
    always = new Set();
    model = undefined;
    sessionId = undefined;
  }
  // The message shows straight away; starting Claude Code can take a few seconds.
  const resume = items.length ? sessionId : undefined;
  const mine: ChatItem = { t: 'user', id: nextId('u'), text: t };
  upsert(mine);
  stoppedTurn = false;
  setBusy(true);
  if (!proc) {
    const r = await startProcess(cwd, resume);
    if (!r.ok) {
      items = items.filter((x) => x.id !== mine.id);
      emit({ reset: true, items, busy: false, partial: '' });
      busy = false;
      return r;
    }
  }
  write({ type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null });
  return { ok: true };
}

/** Stops what Claude is doing now (Esc in the terminal); the chat goes on. */
export function chatInterrupt() {
  if (!proc || !busy) return;
  cancelPending('The user pressed Stop.');
  write({ type: 'control_request', request_id: nextId('int'), request: { subtype: 'interrupt' } });
}

/** Ends the session; with `clear` the conversation goes too (New chat, or another workspace). */
export function chatStop(clear = false) {
  const p = proc;
  proc = null;
  pending.clear();
  if (p) {
    try {
      p.stdin?.end();
    } catch {
      /* already closed */
    }
    // Only this process and what it started: taskkill /t on its own pid.
    const pid = p.pid;
    setTimeout(() => {
      if (p.exitCode !== null || !pid) return;
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
      else p.kill();
    }, 1500);
  }
  if (busy) setBusy(false);
  if (clear) {
    items = [];
    always = new Set();
    model = undefined;
    sessionId = undefined;
    procCwd = null;
    emit({ reset: true, items: [], busy: false, partial: '' });
  }
}
