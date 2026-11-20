// What the Claude in the Claude panel sees and does in Locus (UI spec §6.3): a small MCP server
// inside the app, given only to that Claude through --mcp-config. Tools that only look or open a
// place (LOOK_TOOLS) run without asking; the ones that change notes or save a version ask the
// user first (Claude Code's own approval, answered in the chat or the terminal). It listens on 127.0.0.1 only, on a port chosen at random, and
// answers only requests carrying this run's token, from no web page (no Origin) and addressed to
// 127.0.0.1 (no DNS rebinding).
import type { NativeImage } from 'electron';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

/** The window's side of it: what is in view, opening a place, and the page's other tools. */
export interface LivePage {
  view(): Promise<unknown>;
  show(dest: string): Promise<string>;
  /** One of the page's tools (window.__locusLive.call): a result, or { error }. */
  call(name: string, args: unknown): Promise<unknown>;
  /** A picture of the window, or of part of it (CSS pixels). */
  capture(rect: { x: number; y: number; width: number; height: number } | null): Promise<NativeImage | null>;
}

/** The tools that only look at Locus or open a place in it: they never ask. */
export const LOOK_TOOLS = ['current_view', 'read_note', 'screenshot', 'show'];

/** Asks the page directly (the chat uses it to know which notes are open). */
export async function livePageCall(name: string, args: unknown): Promise<unknown> {
  if (!page) throw new Error('Locus has no window open.');
  return page.call(name, args);
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

/** A page tool's answer as a tool result: its text, or an error Claude can act on. */
async function pageTool(name: string, args: unknown) {
  if (!page) return { ...text('Locus has no window open.'), isError: true };
  const r = (await page.call(name, args).catch((e) => ({ error: e instanceof Error ? e.message : String(e) }))) as { error?: string } | string | null;
  if (r && typeof r === 'object' && typeof r.error === 'string') return { ...text(r.error), isError: true };
  return text(r ?? 'Done.');
}

/** A value sent as JSON text, read as what it says (anything else is left as it is). */
const parseJsonText = (v: unknown) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

const where = {
  path: z.string().optional().describe('The note, as a workspace path like "/notes/plan.md". Leave out for the note the user has open.'),
};

function tools() {
  const server = new McpServer(
    { name: 'locus-live', version: '1' },
    {
      instructions:
        'Live view of the Locus window this Claude Code runs in, and hands on it. current_view says which note and document the user has open, where their cursor is and what they have selected, each as a Locus reference link. read_note reads a note as it is on screen; screenshot shows the window. show opens a place in Locus for the user. edit_note and insert_text change a note in the editor in front of the user (highlighted, undoable); cite_selection cites what the user has selected in the document viewer; save_version records a version.',
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
  server.registerTool(
    'read_note',
    {
      title: 'Read a note as it is on screen',
      description:
        'The text of a note as the user sees it in Locus, unsaved typing included, each line numbered ("12| text"). Use it before edit_note, so the text you replace matches exactly. Notes that are not open are read from disk.',
      inputSchema: {
        ...where,
        from_line: z.number().int().positive().optional().describe('First line to return (default 1)'),
        to_line: z.number().int().positive().optional().describe('Last line to return (default: the end, up to 2000 lines)'),
      },
    },
    async (args) => pageTool('readNote', args),
  );
  server.registerTool(
    'screenshot',
    {
      title: 'Picture of the Locus window',
      description:
        'A picture of what the user sees in Locus: the whole window, or one part of it. Use it to see a page, slide, chart or layout that text alone does not show.',
      inputSchema: {
        part: z.enum(['window', 'notes', 'document']).optional().describe('window (default), notes (the note pane on the left) or document (the viewer on the right)'),
      },
    },
    async ({ part }) => {
      if (!page) return { ...text('Locus has no window open.'), isError: true };
      const rect = (await page.call('rect', { part: part ?? 'window' }).catch(() => null)) as { x: number; y: number; width: number; height: number } | null;
      if (part && part !== 'window' && !rect) return { ...text(`The ${part} pane isn't showing.`), isError: true };
      let img = await page.capture(part && part !== 'window' ? rect : null);
      if (!img || img.isEmpty()) return { ...text("Couldn't take a picture of the window."), isError: true };
      if (img.getSize().width > 1600) img = img.resize({ width: 1600, quality: 'good' });
      return { content: [{ type: 'image' as const, data: img.toJPEG(82).toString('base64'), mimeType: 'image/jpeg' }] };
    },
  );
  server.registerTool(
    'edit_note',
    {
      title: 'Change a note in the editor',
      description:
        'Changes a note in the Locus editor, in front of the user: each old_text (which must appear exactly once in the note as it is on screen) becomes new_text. The changes are highlighted, can be undone with Ctrl+Z as one step, and never overwrite what the user is typing. Opens the note if it is not open. Read it first with read_note. Notes only; not flowcharts or past versions.',
      inputSchema: {
        ...where,
        // Some callers send the list as JSON text; it is read either way.
        edits: z
          .preprocess(
            parseJsonText,
            z.array(z.object({ old_text: z.string().min(1).describe('Text in the note now, exactly, including line breaks'), new_text: z.string().describe('What it becomes ("" deletes it)') })).min(1),
          )
          .describe('The replacements, applied together'),
      },
    },
    async (args) => pageTool('editNote', args),
  );
  server.registerTool(
    'insert_text',
    {
      title: 'Add text to a note in the editor',
      description:
        'Adds markdown to a note in the Locus editor, in front of the user (highlighted, undoable with Ctrl+Z). Put it at the cursor, the start or end, after a line, or at the end of a section (after_heading). Opens the note if it is not open; creates it when create is true and it does not exist.',
      inputSchema: {
        ...where,
        text: z.string().min(1).describe('The markdown to add'),
        at: z.enum(['cursor', 'end', 'start']).optional().describe('Where, when after_line and after_heading are left out (default end)'),
        after_line: z.number().int().nonnegative().optional().describe('Put it after this line (0 = before the first line)'),
        after_heading: z.string().optional().describe('Put it at the end of the section under this heading (its text, without the #s)'),
        create: z.boolean().optional().describe('Create the note if it does not exist yet'),
      },
    },
    async (args) => pageTool('insertText', args),
  );
  server.registerTool(
    'cite_selection',
    {
      title: 'Cite what the user selected in the document viewer',
      description:
        "Puts a reference link to what the user has selected (or has in view) in the document viewer into a note, through Locus's own Cite: the version is recorded, and the label is the one Locus suggests unless you give one. With embed, it goes in as an embedded view instead: a picture of the page, slide or box, or a table of the selected cells. Goes at the note's cursor unless after_line or at says otherwise.",
      inputSchema: {
        ...where,
        embed: z.boolean().optional().describe('Show it in the note as a picture or table instead of a link'),
        label: z.string().optional().describe("The link's words (default: Locus's suggestion)"),
        after_line: z.number().int().nonnegative().optional().describe('Put it on a new line after this line'),
        at: z.enum(['cursor', 'end']).optional().describe('cursor (default) or end of the note'),
      },
    },
    async (args) => pageTool('citeSelection', args),
  );
  server.registerTool(
    'save_version',
    {
      title: 'Save a version',
      description: 'Saves every open note and records a version of the workspace (a git commit), as the Save version button does. Afterwards Locus checks links to files that changed.',
      inputSchema: { name: z.string().min(1).describe('What changed, in a few words') },
    },
    async (args) => pageTool('saveVersion', args),
  );
  return server;
}
