// Calls one MCP tool from the command line, for development.
// Usage: node scripts/mcp-call.mjs <workspace> <tool> '<json args>'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [workspace, tool, json = '{}'] = process.argv.slice(2);
const args = json.startsWith('@') ? JSON.parse(readFileSync(json.slice(1), 'utf8')) : JSON.parse(json);
const client = new Client({ name: 'cli', version: '1' });
await client.connect(
  new StdioClientTransport({ command: process.execPath, args: [resolve(import.meta.dirname, '..', 'dist/mcp/server.mjs'), workspace] }),
);
const r = await client.callTool({ name: tool, arguments: args });
console.log(r.content.map((c) => c.text).join('\n'));
await client.close();
process.exit(r.isError ? 1 : 0);
