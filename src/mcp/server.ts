// MCP server that lets Claude read a Locus workspace and write notes whose links jump
// to exact places in files and versions. Run with: node dist/mcp/server.mjs [workspace-folder]
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { fileKind } from '../core/link';
import skillDoc from '../../plugin/skills/locus/SKILL.md';
import { renderForClaude, readWorkbook } from './reader';
import {
  git,
  initWorkspace,
  listFiles,
  makeReference,
  openWorkspace,
  pdfPages,
  readBytes,
  validateNote,
  writeNote,
  wsPath,
  type LinkCheck,
} from './workspace';

if (process.argv[2]) process.env.LOCUS_WORKSPACE = process.argv[2];

const INSTRUCTIONS = `Locus notes are markdown files whose links jump to exact places in a workspace:
PDF pages and highlighted areas, code lines, spreadsheet ranges, note headings, media times, and past versions of files.
Never hand-write reference links: get each one from make_reference, which verifies the target and records the version.
Before finishing a note, run validate_note and fix anything that is not "ok".`;

const server = new McpServer({ name: 'locus', version: '0.1.0' }, { instructions: INSTRUCTIONS });

const workspaceArg = z
  .string()
  .optional()
  .describe('Absolute path of the workspace folder (or any folder inside it). Defaults to the configured workspace or current directory.');

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${(e as Error).message}` }], isError: true });

function wrap<A>(fn: (args: A) => Promise<string>) {
  return async (args: A) => {
    try {
      return text(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };
}

server.registerTool(
  'workspace_overview',
  {
    title: 'Workspace overview',
    description: 'Start here. Shows the workspace root, its files, and recent versions (commits). Use it to plan a tour or find files to cite.',
    inputSchema: { workspace: workspaceArg },
  },
  wrap(async ({ workspace }) => {
    const ws = await openWorkspace(workspace);
    const files = await listFiles(ws);
    const versions = ws.isRepo ? await git.log(ws.root) : [];
    let out = `Workspace "${ws.name}" at ${ws.root}\n`;
    out += ws.isRepo ? `Version history: ${versions.length} versions, latest ${versions[0]?.sha.slice(0, 10) ?? 'none'}\n` : 'No version history yet (init_workspace sets it up; links will have no version until then).\n';
    out += `\nFiles (${files.length}${files.length > 400 ? ', first 400 shown' : ''}):\n`;
    out += files.slice(0, 400).map((f) => `  ${f}  [${fileKind(f)}]`).join('\n');
    if (versions.length) {
      out += `\n\nRecent versions (newest first):\n`;
      out += versions.slice(0, 25).map((v) => `  ${v.sha.slice(0, 10)}  ${v.date.slice(0, 16).replace('T', ' ')}  ${v.message}`).join('\n');
    }
    return out;
  }),
);

server.registerTool(
  'read_file',
  {
    title: 'Read a file',
    description:
      'Reads any workspace file as citable text: code/markdown with line numbers, PDFs page by page (file page numbers), spreadsheets as cells with addresses and named ranges. Pass version to read a past version.',
    inputSchema: {
      workspace: workspaceArg,
      path: z.string().describe('File path relative to the workspace root, e.g. "src/app.py" or "/docs/spec.pdf"'),
      version: z.string().optional().describe('A version (commit SHA) to read instead of the latest'),
      start_line: z.number().int().optional(),
      end_line: z.number().int().optional(),
      pages: z.tuple([z.number().int(), z.number().int()]).optional().describe('PDF page range [first, last]'),
      sheet: z.string().optional().describe('Only this sheet of a workbook'),
    },
  },
  wrap(async (a) => {
    const ws = await openWorkspace(a.workspace);
    const path = wsPath(ws, a.path);
    const data = await readBytes(ws, path, a.version);
    return renderForClaude(path, data, { startLine: a.start_line, endLine: a.end_line, pages: a.pages, sheet: a.sheet });
  }),
);

server.registerTool(
  'search_workspace',
  {
    title: 'Search the workspace',
    description: 'Finds text across code, notes, PDFs (by page) and spreadsheets (by cell). Returns where each hit is, ready to pass to make_reference.',
    inputSchema: {
      workspace: workspaceArg,
      query: z.string().describe('Text to find (case-insensitive)'),
      max_results: z.number().int().optional(),
    },
  },
  wrap(async ({ workspace, query, max_results }) => {
    const ws = await openWorkspace(workspace);
    const q = query.toLowerCase();
    const limit = max_results ?? 40;
    const hits: string[] = [];
    for (const path of await listFiles(ws)) {
      if (hits.length >= limit) break;
      const kind = fileKind(path);
      try {
        if (kind === 'code' || kind === 'markdown') {
          const st = await fs.stat(join(ws.root, path));
          if (st.size > 2_000_000) continue;
          const lines = new TextDecoder().decode(await readBytes(ws, path)).split(/\r?\n/);
          lines.forEach((l, i) => {
            if (hits.length < limit && l.toLowerCase().includes(q)) hits.push(`${path}  L${i + 1}: ${l.trim().slice(0, 160)}`);
          });
        } else if (kind === 'pdf') {
          for (const p of await pdfPages(ws, path)) {
            const t = p.text.replace(/\s+/g, ' ');
            const i = t.toLowerCase().indexOf(q);
            if (i >= 0 && hits.length < limit) hits.push(`${path}  page ${p.page}: …${t.slice(Math.max(0, i - 60), i + q.length + 60)}…`);
          }
        } else if (kind === 'sheet') {
          const wb = await readWorkbook(await readBytes(ws, path), path);
          for (const s of wb.sheets) {
            for (const [r, cells] of s.rows) {
              for (const [c, t] of cells) {
                if (hits.length < limit && t.toLowerCase().includes(q)) hits.push(`${path}  ${s.name}!${c}${r}: ${t.slice(0, 120)}`);
              }
            }
          }
        }
      } catch {
        /* unreadable file: skip */
      }
    }
    return hits.length ? hits.join('\n') : `No matches for "${query}".`;
  }),
);

server.registerTool(
  'make_reference',
  {
    title: 'Make a reference link',
    description: `Builds a verified markdown reference to an exact place in a file. Paste the returned markdown into the note unchanged.
- Code: give lines [start, end], or a quote of the code and the lines are found for you.
- PDF: give a quote (exact text from the page) and optionally page; set highlight=true to draw a box around the quoted passage. Without a quote, give page.
- Spreadsheet: give range, e.g. "'Load cases'!B4:D12", "Margins!B2:C6" or a named range.
- Markdown note: give heading.
- Audio/video: give time "m:ss".
version: omit for a live link to the latest file; pass a commit SHA to pin the link to that past version (use file_history to find SHAs).`,
    inputSchema: {
      workspace: workspaceArg,
      path: z.string(),
      label: z.string().optional().describe('Link text shown in the note. Defaults to a name like "spec p5" or "client.py L12-18".'),
      lines: z.tuple([z.number().int(), z.number().int()]).optional(),
      page: z.number().int().optional(),
      quote: z.string().optional().describe('Exact text from the cited spot; shown on hover and used to find the spot again'),
      highlight: z.boolean().optional().describe('PDF only: box the quoted passage'),
      range: z.string().optional(),
      heading: z.string().optional(),
      time: z.string().optional(),
      version: z.string().optional(),
    },
  },
  wrap(async (a) => {
    const ws = await openWorkspace(a.workspace);
    const r = await makeReference(ws, a);
    return [r.markdown, '', `→ ${r.location}; version: ${r.version}`, ...r.notes.map((n) => `note: ${n}`)].join('\n');
  }),
);

server.registerTool(
  'validate_note',
  {
    title: 'Check a note’s links',
    description: 'Checks every link in a note: files exist, pages/lines/ranges are valid, quotes are where the link says, and whether code has changed since it was cited. Pass path for a saved note or markdown for a draft.',
    inputSchema: {
      workspace: workspaceArg,
      path: z.string().describe('Where the note lives (or will live) in the workspace, e.g. "notes/tour.md"'),
      markdown: z.string().optional().describe('Draft content to check instead of the saved file'),
    },
  },
  wrap(async (a) => {
    const ws = await openWorkspace(a.workspace);
    const path = wsPath(ws, a.path);
    const md = a.markdown ?? new TextDecoder().decode(await readBytes(ws, path));
    const checks = await validateNote(ws, path, md);
    return formatChecks(checks);
  }),
);

server.registerTool(
  'file_history',
  {
    title: 'Version history',
    description: 'Lists the versions (commits) of one file, or of the whole workspace, newest first. Use the SHAs with read_file and make_reference to cite how something used to be.',
    inputSchema: { workspace: workspaceArg, path: z.string().optional(), limit: z.number().int().optional() },
  },
  wrap(async (a) => {
    const ws = await openWorkspace(a.workspace);
    if (!ws.isRepo) return 'This workspace has no version history yet.';
    const path = a.path ? wsPath(ws, a.path) : undefined;
    const versions = await git.log(ws.root, path);
    if (!versions.length) return 'No versions found.';
    return versions
      .slice(0, a.limit ?? 50)
      .map((v) => `${v.sha.slice(0, 10)}  ${v.date.slice(0, 16).replace('T', ' ')}  ${v.message}${v.auto ? '  (automatic)' : ''}`)
      .join('\n');
  }),
);

server.registerTool(
  'write_note',
  {
    title: 'Save a note',
    description: 'Writes a markdown note into the workspace (creating folders as needed) and returns the link check for it. Overwrites an existing note at that path.',
    inputSchema: { workspace: workspaceArg, path: z.string().describe('e.g. "notes/codebase-tour.md"'), content: z.string() },
  },
  wrap(async (a) => {
    const ws = await openWorkspace(a.workspace);
    const path = await writeNote(ws, a.path, a.content);
    const checks = await validateNote(ws, path, a.content);
    return `Saved ${path}.\n\n${formatChecks(checks)}`;
  }),
);

server.registerTool(
  'init_workspace',
  {
    title: 'Set up version history',
    description: 'Turns a plain folder into a workspace with version history, exactly as the app does when it opens a folder. Only needed when workspace_overview says there is no history.',
    inputSchema: { workspace: workspaceArg },
  },
  wrap(async ({ workspace }) => {
    const ws = await initWorkspace(workspace);
    return `Workspace "${ws.name}" ready at ${ws.root} (${ws.managed ? 'app-managed history' : 'existing repository'}).`;
  }),
);

// Claude Desktop has no skills, so the same guidance is offered as a prompt.
const skillBody = skillDoc.replace(/^---[sS]*?---s*/, '');

server.registerPrompt(
  'write_tour',
  {
    title: 'Write a tour',
    description: 'Write a guided tour of the workspace (or part of it) as a Locus note with exact references',
    argsSchema: { topic: z.string().optional().describe('What the tour should cover, e.g. "the retry logic" or "the whole codebase"') },
  },
  ({ topic }) => ({
    messages: [
      {
        role: 'user' as const,
        content: { type: 'text' as const, text: `${skillBody}

---

Write a tour of ${topic || 'this workspace'} following the guidance above, save it with write_note, and fix anything validate_note flags.` },
      },
    ],
  }),
);

function formatChecks(checks: LinkCheck[]): string {
  const refs = checks.filter((c) => c.status !== 'web');
  if (!refs.length) return 'No references found in the note.';
  const bad = refs.filter((c) => c.status === 'broken' || c.status === 'warning');
  const lines = refs.map((c) => `${c.status.toUpperCase().padEnd(8)} line ${c.line}  [${c.label}]${c.detail ? `  — ${c.detail}` : ''}`);
  const summary = bad.length ? `${bad.length} of ${refs.length} references need attention.` : `All ${refs.length} references resolve.`;
  return `${summary}\n${lines.join('\n')}`;
}


await server.connect(new StdioServerTransport());
