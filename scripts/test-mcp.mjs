// Exercises every MCP tool over stdio against the test workspace, like Claude would.
// Usage: node scripts/build-mcp.mjs && node scripts/make-test-workspace.mjs && node scripts/test-mcp.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const workspace = resolve(repo, '..', 'locus-test-workspace');
const client = new Client({ name: 'test', version: '1' });
// LOCUS_RUNTIME runs the server the way the app installs it for Claude Code: on Locus itself (Electron as Node).
const runtime = process.env.LOCUS_RUNTIME;
await client.connect(
  new StdioClientTransport({
    command: runtime ?? process.execPath,
    args: [process.env.LOCUS_SERVER ?? resolve(repo, 'dist/mcp/server.mjs'), workspace],
    ...(runtime ? { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } : {}),
  }),
);

let failures = 0;
async function call(name, args, expect) {
  const r = await client.callTool({ name, arguments: args });
  const out = r.content.map((c) => c.text).join('\n');
  const ok = !r.isError && (!expect || expect.test(out));
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${JSON.stringify(args).slice(0, 90)}`);
  if (!ok || process.env.VERBOSE) console.log('     ' + out.slice(0, 1500).replace(/\n/g, '\n     '));
  return out;
}

const { tools } = await client.listTools();
console.log(`tools: ${tools.map((t) => t.name).join(', ')}`);

await call('workspace_overview', {}, /Bracket project[\s\S]*client\.py[\s\S]*Log failed attempts/);
await call('read_file', { path: 'src/net/client.py', start_line: 15, end_line: 22 }, /21 \| def fetch\(url\):/);
await call('read_file', { path: 'docs/BDS-100 Bracket Design Standard.pdf', pages: [5, 5] }, /=== page 5 ===[\s\S]*Table 5/);
await call('read_file', { path: 'data/Bracket loads.xlsx' }, /LoadTable[\s\S]*A4=Launch axial/);
await call('read_file', { path: 'src/net/client.py', version: 'HEAD~4' }, /RETRIES = 3/);
await call('search_workspace', { query: 'exceed three' }, /page 5/);
await call('search_workspace', { query: 'Landing' }, /Load cases!A6/);
await call('make_reference', { path: 'src/net/client.py', quote: 'def backoff(attempt):', label: 'backoff' }, /\[backoff\]\(\/src\/net\/client\.py#L15&at=/);
await call('make_reference', { path: 'src/net/client.py', lines: [21, 32], label: 'fetch loop' }, /#L21-L32&at=/);
await call(
  'make_reference',
  { path: 'docs/BDS-100 Bracket Design Standard.pdf', quote: 'Retries of a failed proof test shall not exceed three attempts', highlight: true },
  /page=5&viewrect=\d+,\d+,\d+,\d+&at=/,
);
await call('make_reference', { path: 'data/Bracket loads.xlsx', range: 'Margins!B2:C6', label: 'margins' }, /Margins!B2:C6&at=/);
await call('make_reference', { path: 'data/Bracket loads.xlsx', range: 'LoadTable' }, /#LoadTable&at=/);
await call('make_reference', { path: 'src/net/client.py', lines: [9, 18], version: 'HEAD~4', label: 'old fetch' }, /&rev=[0-9a-f]{10}/);
await call('make_reference', { path: 'notes/design-basis.md', heading: 'Factors of safety' }, /design-basis\.md#factors-of-safety/);
const bad = await client.callTool({ name: 'make_reference', arguments: { path: 'docs/BDS-100 Bracket Design Standard.pdf', quote: 'this sentence is not in the pdf' } });
console.log(`${bad.isError ? 'ok  ' : 'FAIL'} make_reference rejects a quote that isn't there`);
if (!bad.isError) failures++;
await call('validate_note', { path: 'notes/review.md' }, /BROKEN[\s\S]*old analysis[\s\S]*MOVED[\s\S]*backoff\(\)|MOVED[\s\S]*BROKEN/);
await call('file_history', { path: 'src/net/client.py' }, /Retry refactor/);
await call(
  'write_note',
  { path: 'notes/mcp-test.md', content: '# Test\n\n[bad page](</docs/BDS-100 Bracket Design Standard.pdf#page=99>)\n' },
  /BROKEN[\s\S]*Page 99/,
);

// Flowcharts: drafted from boxes, loops and arrows, with citations made like make_reference.
const flow = {
  path: 'notes/mcp-flow.canvas',
  loops: [{ id: 'attempts', label: 'for attempt in range(RETRIES)' }],
  boxes: [
    { id: 'start', shape: 'terminal', text: 'fetch(url)' },
    { id: 'open', text: 'Open the URL', loop: 'attempts', cite: [{ path: 'src/net/client.py', label: 'urlopen', quote: 'with urllib.request.urlopen(url, timeout=TIMEOUT_S) as resp:' }] },
    { id: 'ok', shape: 'decision', text: 'Succeeded?', loop: 'attempts' },
    { id: 'wait', text: 'Wait with backoff', loop: 'attempts', cite: [{ path: 'src/net/client.py', label: 'backoff()', quote: 'def backoff(attempt):' }] },
    { id: 'done', shape: 'terminal', text: 'Return the body' },
  ],
  arrows: [
    { from: 'start', to: 'open' },
    { from: 'open', to: 'ok' },
    { from: 'ok', to: 'done', label: 'yes' },
    { from: 'ok', to: 'wait', label: 'no' },
    { from: 'wait', to: 'open', label: 'next attempt' },
  ],
};
await call('write_flowchart', flow, /Saved \/notes\/mcp-flow\.canvas: 5 boxes, 1 loop, 5 arrows[\s\S]*All 2 references resolve/);
await call('read_file', { path: 'notes/mcp-flow.canvas' }, /open \[process\] \(in attempts\): Open the URL \/ \[urlopen\]\(\/src\/net\/client\.py#L26[\s\S]*wait → open "next attempt" \(dashed\)/);
await call('validate_note', { path: 'notes/mcp-flow.canvas' }, /OK\s+line \d+\s+\[box "wait": backoff\(\)\]/);
const badFlow = await client.callTool({ name: 'write_flowchart', arguments: { ...flow, path: 'notes/bad.canvas', arrows: [{ from: 'start', to: 'nowhere' }] } });
console.log(`${badFlow.isError ? 'ok  ' : 'FAIL'} write_flowchart rejects an arrow to a missing box`);
if (!badFlow.isError) failures++;
const badCite = await client.callTool({ name: 'write_flowchart', arguments: { ...flow, path: 'notes/bad.canvas', boxes: [{ id: 'start', text: 'x', cite: [{ path: 'src/net/client.py', quote: 'not in the file' }] }], loops: [], arrows: [] } });
console.log(`${badCite.isError && /Box "start"/.test(badCite.content[0].text) ? 'ok  ' : 'FAIL'} write_flowchart names the box with a bad citation`);
if (!(badCite.isError && /Box "start"/.test(badCite.content[0].text))) failures++;

await client.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
