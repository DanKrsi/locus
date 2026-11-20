// Stands in for Claude Code behind the Claude panel's chat (LOCUS_CHAT_CMD): speaks the stream-json
// protocol Locus drives `claude -p` with (user lines in; init, stream_event, assistant, user and
// result lines out; can_use_tool control requests for approvals; interrupt), and does what each
// message asks by calling the locus-live tools, as Claude would. Messages it understands:
//   hello                 -> a streamed reply with a Locus link
//   view | shot | read [path]          -> current_view / screenshot / read_note (pre-approved)
//   edit <old> => <new>   -> edit_note (asks first); edit-json sends the edits as JSON text
//   insert <text>         -> insert_text at the end (asks first)
//   cite [embed]          -> cite_selection (asks first)
//   save <name>           -> save_version (asks first)
//   write <path> <text>   -> the built-in Write tool on a file (asks first, unless Locus refuses)
//   slow                  -> streams for a long time (for Stop)
//   signin | limit | crash | askcrash -> a "not logged in" result / a usage-limit result / dies at once / dies while asking
// Everything it does goes to LOCUS_STUB_OUT (JSON lines) for the test to read.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
const out = process.env.LOCUS_STUB_OUT;
const record = (o) => out && appendFileSync(out, JSON.stringify(o) + '\n');
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const config = JSON.parse(readFileSync(flag('--mcp-config'), 'utf8'));
const allowed = (flag('--allowedTools') ?? '').split(',').filter(Boolean);
const session = flag('--resume') ?? randomUUID();
record({ event: 'start', pid: process.pid, args, cwd: process.cwd(), resume: flag('--resume') ?? null, servers: Object.keys(config.mcpServers) });

const live = config.mcpServers['locus-live'];
const client = new Client({ name: 'chat-stub', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(live.url), { requestInit: { headers: live.headers } }));

const emit = (o) => process.stdout.write(JSON.stringify({ session_id: session, ...o }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let interrupted = false;
const answers = new Map();

async function say(text, chunk = 12, delay = 15) {
  emit({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  for (let i = 0; i < text.length && !interrupted; i += chunk) {
    emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(i, i + chunk) } } });
    await sleep(delay);
  }
  if (interrupted) return;
  emit({ type: 'assistant', uuid: randomUUID(), message: { id: 'msg_' + randomUUID(), role: 'assistant', content: [{ type: 'text', text }] }, parent_tool_use_id: null });
}

/** A tool use, with approval when Claude Code would ask, then its result. */
async function use(name, input, run) {
  const id = 'toolu_' + randomUUID().replace(/-/g, '');
  emit({ type: 'assistant', uuid: randomUUID(), message: { id: 'msg_' + randomUUID(), role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, parent_tool_use_id: null });
  let finalInput = input;
  if (!allowed.includes(name)) {
    const requestId = randomUUID();
    const answer = new Promise((resolve) => answers.set(requestId, resolve));
    emit({ type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: name, display_name: name.split('__').pop(), input, tool_use_id: id } });
    const r = await answer;
    record({ event: 'answer', tool: name, response: r });
    if (r.behavior !== 'allow') {
      emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: r.message }] }, parent_tool_use_id: null });
      return { ok: false, text: r.message };
    }
    finalInput = r.updatedInput ?? input;
  }
  let res;
  try {
    res = await run(finalInput);
  } catch (e) {
    res = { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] };
  }
  const text = (res.content ?? []).map((c) => (c.type === 'text' ? c.text : `[${c.type} ${c.mimeType ?? ''} ${c.data?.length ?? 0}]`)).join('\n');
  record({ event: 'tool', name, input: finalInput, ok: !res.isError, text, content: (res.content ?? []).map((c) => ({ type: c.type, mimeType: c.mimeType, bytes: c.data?.length })) });
  emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: !!res.isError, content: res.content }] }, parent_tool_use_id: null });
  return { ok: !res.isError, text };
}
const liveTool = (name, input) => use(`mcp__locus-live__${name}`, input, (i) => client.callTool({ name, arguments: i }));

async function turn(text) {
  interrupted = false;
  emit({ type: 'system', subtype: 'init', model: 'stub-model', tools: [], mcp_servers: [], permissionMode: 'default' });
  const t = text.trim();
  if (t === 'crash') {
    process.stderr.write('Something broke inside the stand-in.\n');
    process.exit(3);
  }
  if (t === 'askcrash') {
    // Asks to change something, then dies before the answer.
    emit({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input: { command: 'echo hi', description: 'Say hi' } } });
    await sleep(400);
    process.stderr.write('The stand-in died while asking.\n');
    process.exit(4);
  }
  if (t === 'limit') {
    emit({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your usage limit for your subscription. It resets at 5pm.", total_cost_usd: 0 });
    return;
  }
  if (t === 'signin') {
    emit({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', total_cost_usd: 0 });
    return;
  }
  if (t === 'hello') await say('Hello from the stand-in. See [the bracket standard](</docs/BDS-100 Bracket Design Standard.pdf#page=2>) and `code`, **bold**.\n\n- one\n- two');
  else if (t === 'view') {
    const r = await liveTool('current_view', {});
    let v = null;
    try {
      v = JSON.parse(r.text);
    } catch {
      /* a message */
    }
    await say(v ? `You have ${v.note?.path ?? 'no note'} and ${v.document?.path ?? 'no document'} open.` : r.text);
  } else if (t === 'shot') {
    const r = await liveTool('screenshot', {});
    await say(`Saw ${r.text}`);
  } else if (t.startsWith('read')) {
    const path = t.slice(4).trim() || undefined;
    const r = await liveTool('read_note', path ? { path } : {});
    await say(r.ok ? `Read it: ${r.text.split('\n')[0]}` : `Couldn't: ${r.text}`);
  } else if (t.startsWith('edit-json ')) {
    const [oldText, newText] = t.slice(10).split(' => ');
    const r = await liveTool('edit_note', { edits: JSON.stringify([{ old_text: oldText, new_text: newText ?? '' }]) });
    await say(r.ok ? 'Changed it.' : `Didn't change it: ${r.text}`);
  } else if (t.startsWith('edit ')) {
    const [oldText, newText] = t.slice(5).split(' => ');
    const r = await liveTool('edit_note', { edits: [{ old_text: oldText, new_text: newText ?? '' }] });
    await say(r.ok ? 'Changed it.' : `Didn't change it: ${r.text}`);
  } else if (t.startsWith('insert ')) {
    const r = await liveTool('insert_text', { text: t.slice(7) });
    await say(r.ok ? 'Added it.' : `Didn't: ${r.text}`);
  } else if (t.startsWith('cite')) {
    const r = await liveTool('cite_selection', t.includes('embed') ? { embed: true } : {});
    await say(r.ok ? 'Cited it.' : `Didn't: ${r.text}`);
  } else if (t.startsWith('save ')) {
    const r = await liveTool('save_version', { name: t.slice(5) });
    await say(r.ok ? r.text : `Didn't: ${r.text}`);
  } else if (t.startsWith('write ')) {
    const [, path, ...rest] = t.split(' ');
    const file = isAbsolute(path) ? path : join(process.cwd(), path);
    const r = await use('Write', { file_path: file, content: rest.join(' ') + '\n' }, async (i) => {
      mkdirSync(dirname(i.file_path), { recursive: true });
      writeFileSync(i.file_path, i.content);
      return { content: [{ type: 'text', text: `File created successfully at: ${i.file_path}` }] };
    });
    await say(r.ok ? 'Wrote it.' : `Didn't write it: ${r.text}`);
  } else if (t === 'slow') {
    await say('Counting slowly: ' + Array.from({ length: 400 }, (_, i) => i + 1).join(', '), 4, 60);
  } else await say(`GOT: ${t}`);
  if (interrupted) {
    emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null });
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 0 });
  } else emit({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0 });
}

let queue = Promise.resolve();
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  record({ event: 'in', message: m });
  if (m.type === 'control_response') {
    const resolve = answers.get(m.response?.request_id);
    if (resolve) {
      answers.delete(m.response.request_id);
      resolve(m.response.response ?? { behavior: 'deny', message: m.response.error });
    }
    return;
  }
  if (m.type === 'control_request' && m.request?.subtype === 'interrupt') {
    interrupted = true;
    emit({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { still_queued: [] } } });
    return;
  }
  if (m.type === 'user') {
    const content = m.message?.content;
    const text = typeof content === 'string' ? content : (content ?? []).map((c) => c.text ?? '').join('');
    queue = queue.then(() => turn(text));
  }
});
rl.on('close', () => {
  record({ event: 'end' });
  queue.then(() => process.exit(0));
});
