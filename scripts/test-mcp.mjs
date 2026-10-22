// Exercises every MCP tool over stdio against the test workspace, like Claude would.
// Usage: node scripts/build-mcp.mjs && node scripts/make-test-workspace.mjs && node scripts/test-mcp.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const workspace = resolve(repo, '..', 'sdl-test-workspace');
const client = new Client({ name: 'test', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [process.env.SDL_SERVER ?? resolve(repo, 'dist/mcp/server.mjs'), workspace] }));

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

await client.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
