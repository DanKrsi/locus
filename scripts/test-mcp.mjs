// Exercises every MCP tool over stdio against the test workspace, like Claude would.
// Usage: node scripts/build-mcp.mjs && node scripts/make-test-workspace.mjs && node scripts/test-mcp.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';

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

// Sources of the kinds a research workspace gets, and what Claude is told about each.
const src = resolve(repo, '..', 'locus-test-mcp-sources');
await rm(src, { recursive: true, force: true });
await mkdir(join(src, 'sources'), { recursive: true });
await mkdir(join(src, 'data'), { recursive: true });

// A report that says the same thing in its summary and in its body.
const rep = await PDFDocument.create();
const font = await rep.embedFont(StandardFonts.Helvetica);
for (const where of ['Summary', 'Body']) {
  const p = rep.addPage([612, 792]);
  p.drawText(where, { x: 60, y: 720, size: 18, font });
  p.drawText('Average asking rents rose 3.2 percent over the year.', { x: 60, y: 680, size: 12, font });
}
await writeFile(join(src, 'sources', 'report.pdf'), await rep.save());

// A scan: one page that is only a picture.
const scan = await PDFDocument.create();
const png = await scan.embedPng(await readFile(resolve(repo, 'build', 'icon.png')));
scan.addPage([612, 792]).drawImage(png, { x: 100, y: 300, width: 400, height: 400 });
await writeFile(join(src, 'sources', 'scan.pdf'), await scan.save());

// A data download, the way agencies publish it: values with thousands separators are quoted.
await writeFile(join(src, 'data', 'prices.csv'), 'place,price,rent\nToronto,"1,075,000",2310\nOttawa,"640,000",1890\n');

// A model written by a script: its formula has no stored value until a spreadsheet program calculates it.
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Model');
ws.addRow(['Price', 1000000]);
ws.getCell('B2').value = { formula: 'B1*0.2' };
await wb.xlsx.writeFile(join(src, 'data', 'model.xlsx'));

// A deck: slide text is searchable like any other text.
const deck = new JSZip();
deck.file('ppt/presentation.xml', '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>');
deck.file('ppt/_rels/presentation.xml.rels', '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>');
deck.file('ppt/slides/slide1.xml', '<p:sld><a:p><a:r><a:t>Vacancy fell to a three year low</a:t></a:r></a:p></p:sld>');
await writeFile(join(src, 'sources', 'deck.pptx'), await deck.generateAsync({ type: 'nodebuffer' }));

await call('init_workspace', { workspace: src }, /ready/);
const W = { workspace: src };
await call('read_file', { ...W, path: 'data/prices.csv' }, /A2=Toronto \| B2=1,075,000 \| C2=2310/);
await call('make_reference', { ...W, path: 'data/prices.csv', range: 'B2', label: 'Toronto price' }, /prices\.csv#B2&at=/);
await call('read_file', { ...W, path: 'data/model.xlsx' }, /B2=\(not calculated\)  \(=B1\*0\.2\)/);
await call('read_file', { ...W, path: 'sources/scan.pdf' }, /no text layer[\s\S]*OCR/);
const scanQuote = await client.callTool({ name: 'make_reference', arguments: { ...W, path: 'sources/scan.pdf', quote: 'average rent' } });
const scanOut = scanQuote.content.map((c) => c.text).join('\n');
console.log(`${scanQuote.isError && /no text layer/.test(scanOut) ? 'ok  ' : 'FAIL'} a quote in a scan says the PDF has no text, not that the quote is wrong`);
if (!(scanQuote.isError && /no text layer/.test(scanOut))) failures++;
await call(
  'make_reference',
  { ...W, path: 'sources/report.pdf', quote: 'Average asking rents rose 3.2 percent over the year.', highlight: true },
  /page=1&[\s\S]*note: This quote also appears on page 2; page 1 was cited\. Pass page/,
);
await call('make_reference', { ...W, path: 'sources/report.pdf', page: 2, quote: 'Average asking rents rose 3.2 percent over the year.' }, /page=2/);
await call('search_workspace', { ...W, query: 'three year low' }, /deck\.pptx\s+slide 1/);

await client.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
