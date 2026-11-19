// Stands in for Claude Code in the Claude panel tests (LOCUS_TERMINAL_CMD): reads the --mcp-config
// Locus passes, and answers typed lines by calling the locus-live tools, as Claude would.
//   view          -> current_view
//   show <link>   -> show
//   anything else -> echoed back as "GOT: ..."
// Full results go to LOCUS_STUB_OUT (JSON lines) for the test to read.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2);
const out = process.env.LOCUS_STUB_OUT;
const record = (o) => out && appendFileSync(out, JSON.stringify(o) + '\n');
const configFile = args[args.indexOf('--mcp-config') + 1];
const config = JSON.parse(readFileSync(configFile, 'utf8'));
const server = config.mcpServers['locus-live'];
record({ event: 'start', args, cwd: process.cwd(), hasPrompt: args.includes('--append-system-prompt'), server: { type: server.type, url: server.url } });

const client = new Client({ name: 'stub', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
const tools = (await client.listTools()).tools.map((t) => t.name);
record({ event: 'tools', tools });
console.log(`STUB READY tools=${tools.join(',')}`);

const rl = createInterface({ input: process.stdin });
rl.on('line', async (raw) => {
  const line = raw.replace(/\x1b\[20[01]~/g, '').trim();
  if (line === 'view') {
    const r = await client.callTool({ name: 'current_view', arguments: {} });
    const text = r.content[0].text;
    record({ event: 'view', text });
    let v = null;
    try {
      v = JSON.parse(text);
    } catch {
      /* a message */
    }
    console.log(v ? `VIEW note=${v.note?.path} sel=${v.note?.selection ? 'yes' : 'no'} doc=${v.document?.path ?? '-'}` : `VIEW ${text}`);
  } else if (line.startsWith('show ')) {
    const r = await client.callTool({ name: 'show', arguments: { link: line.slice(5) } });
    record({ event: 'show', text: r.content[0].text });
    console.log(`SHOWN ${r.content[0].text}`);
  } else if (line) {
    record({ event: 'got', line });
    console.log(`GOT: ${line}`);
  }
});
