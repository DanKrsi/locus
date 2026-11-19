// What the Claude in the Claude panel sees of Locus (UI spec §6.3): a small MCP server inside the
// app, given only to that Claude through --mcp-config, with tools to read what the user is looking
// at and to open a place for them. It listens on 127.0.0.1 only, on a port chosen at random, and
// answers only requests carrying this run's token, from no web page (no Origin) and addressed to
// 127.0.0.1 (no DNS rebinding).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

/** The window's side of it: what is in view, and opening a place. */
export interface LivePage {
  view(): Promise<unknown>;
  show(dest: string): Promise<string>;
}

let page: LivePage | null = null;

export function setLivePage(p: LivePage | null) {
  page = p;
}

let started: Promise<{ url: string; token: string; port: number }> | null = null;

function start() {
  started ??= new Promise((resolve, reject) => {
    const token = randomBytes(32).toString('hex');
    const server = createServer((req, res) => void handle(req, res, token, port()).catch(() => fail(res, 500, 'Server error')));
    const port = () => {
      const a = server.address();
      return a && typeof a === 'object' ? a.port : 0;
    };
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${port()}/mcp`, token, port: port() }));
  });
  return started;
}

/** The --mcp-config for the panel's Claude Code. */
export async function liveConfig() {
  const { url, token } = await start();
  return { mcpServers: { 'locus-live': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } };
}

function fail(res: ServerResponse, status: number, message: string) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

const sameToken = (given: string, token: string) => {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error('too large');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
}

async function handle(req: IncomingMessage, res: ServerResponse, token: string, port: number) {
  if (req.headers.origin) return fail(res, 403, 'Not available to web pages');
  if (req.headers.host !== `127.0.0.1:${port}`) return fail(res, 403, 'Wrong host');
  const auth = String(req.headers.authorization ?? '');
  if (!auth.startsWith('Bearer ') || !sameToken(auth.slice(7), token)) return fail(res, 401, 'Unauthorized');
  if ((req.url ?? '').split('?')[0] !== '/mcp') return fail(res, 404, 'Not found');
  if (req.method !== 'POST') return fail(res, 405, 'Method not allowed');
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    return fail(res, 400, 'Bad request');
  }
  // Stateless: a fresh server and transport for each request.
  const server = tools();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

function tools() {
  const server = new McpServer(
    { name: 'locus-live', version: '1' },
    {
      instructions:
        'Live view of the Locus window this Claude Code runs in. current_view says which note and document the user has open, where their cursor is and what they have selected, each as a Locus reference link. show opens a place in Locus for the user.',
    },
  );
  server.registerTool(
    'current_view',
    {
      title: 'What the user is looking at',
      description:
        'What the user has in front of them in Locus right now: the workspace, the note being edited (path, cursor line, selected text), the document open on the right (path, kind, version, the part in view or selected as a Locus reference link with the quoted text), and the other open tabs. Call it whenever the user says "this", "here", "the selection", "this page/cell/slide" or refers to what they are looking at.',
      inputSchema: {},
    },
    async () => {
      if (!page) return text('Locus has no window open.');
      return text((await page.view()) ?? 'No workspace is open in Locus.');
    },
  );
  server.registerTool(
    'show',
    {
      title: 'Show a place in Locus',
      description:
        'Opens a place in Locus for the user, as clicking a link in a note would: a document at a page, area, lines, cells or slide, a note at a heading or lines, or a past version. Pass a Locus reference link (as make_reference returns or a note contains) or just its destination.',
      inputSchema: {
        link: z.string().describe('A Locus reference link "[label](</path#loc>)" or its destination "/path#loc"'),
      },
    },
    async ({ link }) => {
      if (!page) return text('Locus has no window open.');
      return text(await page.show(link));
    },
  );
  return server;
}
