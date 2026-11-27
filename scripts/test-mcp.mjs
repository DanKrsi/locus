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
await call('make_reference', { path: 'data/Bracket loads.xlsx', range: 'Margins!B2:C6', label: 'margins', embed: true }, /^!\[margins\]\(\/data\/Bracket loads\.xlsx#Margins!B2:C6&at=|^!\[margins\]\(<\/data\/Bracket loads\.xlsx#Margins!B2:C6&at=/);
await call('make_reference', { path: 'docs/BDS-100 Bracket Design Standard.pdf', page: 5, embed: true }, /^!\[BDS-100 Bracket Design Standard p5\]\(<\/docs\/BDS-100 Bracket Design Standard\.pdf#page=5&at=/);
for (const [args, what] of [
  [{ path: 'data/Bracket loads.xlsx', embed: true }, 'a table in the note without a range'],
  [{ path: 'src/net/client.py', lines: [1, 4], embed: true }, 'code shown in the note'],
]) {
  const r = await client.callTool({ name: 'make_reference', arguments: args });
  console.log(`${r.isError ? 'ok  ' : 'FAIL'} make_reference rejects ${what}: ${r.content[0].text.slice(0, 90)}`);
  if (!r.isError) failures++;
}
await call(
  'validate_note',
  { path: 'notes/embed-check.md', markdown: '# x\n\n![loads](</data/Bracket loads.xlsx#Margins!B2:C6>)\n\n![whole](</data/Bracket loads.xlsx>)\n' },
  /No version recorded[\s\S]*needs a range|needs a range[\s\S]*No version recorded/,
);
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

// Word: read paragraph by paragraph, cited by quote or paragraph numbers, checked; an old .doc is
// linked as a whole file and Claude is told why.
const { memo, MEMO } = await import('./word-fixtures.mjs');
await writeFile(join(src, 'sources', 'memo.docx'), await memo(1));
await writeFile(join(src, 'sources', 'old.doc'), Buffer.from('D0CF11E0A1B11AE1', 'hex'));
await call('init_workspace', { workspace: src }, /ready|already/);
await call(
  'read_file',
  { ...W, path: 'sources/memo.docx' },
  /Word document "memo\.docx", 33 paragraphs[\s\S]*\[1\] # Bracket design memo[\s\S]*\[3\] The bracket carries a design load of 12 kN[\s\S]*\[5\] • Bolts[\s\S]*\[7\] \(table\) Case[\s\S]*\[32\] Fatigue[\s\S]*Footnotes[\s\S]*Taken from the load table/,
);
const part = await call('read_file', { ...W, path: 'sources/memo.docx', paragraphs: [31, 33] }, /\[32\] Fatigue/);
console.log(`${!/\[3\] /.test(part) ? 'ok  ' : 'FAIL'} read_file with paragraphs reads only those`);
if (/\[3\] /.test(part)) failures++;
await call('search_workspace', { ...W, query: 'two million' }, /memo\.docx\s+paragraph 32/);
await call('make_reference', { ...W, path: 'sources/memo.docx', quote: MEMO.load }, /\[memo para 3\]\(\/sources\/memo\.docx#para=3&at=[0-9a-f]{10} "design load of 12 kN"\)/);
await call('make_reference', { ...W, path: 'sources/memo.docx', paragraphs: [5, 6], label: 'checks' }, /\[checks\]\(\/sources\/memo\.docx#para=5-6&at=/);
await call('make_reference', { ...W, path: 'sources/memo.docx', quote: 'shear and bearing. The flange is' }, /#para=5-6&at=/);
await call('make_reference', { ...W, path: 'sources/memo.docx', quote: MEMO.fatigue, embed: true }, /^!\[memo para 32\]\(\/sources\/memo\.docx#para=32&at=/);
await call('make_reference', { ...W, path: 'sources/memo.docx', paragraphs: [3, 3], quote: 'The end.' }, /note: The quote is in paragraph 33/);
await call('make_reference', { ...W, path: 'sources/old.doc', label: 'old memo' }, /\[old memo\]\(\/sources\/old\.doc&at=|\[old memo\]\(\/sources\/old\.doc#at=/);
await call('read_file', { ...W, path: 'sources/old.doc' }, /old binary Office format[\s\S]*Save As/);
for (const [args, what, why] of [
  [{ ...W, path: 'sources/memo.docx', quote: 'nobody wrote this' }, 'a Word quote that is not there', /Couldn't find the quote/],
  [{ ...W, path: 'sources/memo.docx', paragraphs: [30, 99] }, 'paragraphs past the end', /33 paragraphs/],
  [{ ...W, path: 'sources/old.doc', quote: 'anything' }, 'a place inside an old .doc', /old binary Office format/],
  [{ ...W, path: 'sources/memo.docx', embed: true }, 'a Word picture without paragraphs', /give paragraphs or a quote/],
]) {
  const r = await client.callTool({ name: 'make_reference', arguments: args });
  const ok = r.isError && why.test(r.content[0].text);
  console.log(`${ok ? 'ok  ' : 'FAIL'} make_reference rejects ${what}: ${r.content[0].text.slice(0, 90)}`);
  if (!ok) failures++;
}
await call(
  'validate_note',
  { ...W, path: 'notes/word-check.md', markdown: '# x\n\n[right](/sources/memo.docx#para=3 "design load of 12 kN")\n\n[wrong](/sources/memo.docx#para=4 "design load of 12 kN")\n\n[gone](/sources/memo.docx#para=99)\n' },
  /\[right\]  — No version recorded[\s\S]*\[wrong\]  — Quote is in paragraph 3, not paragraph 4[\s\S]*BROKEN[\s\S]*paragraph 99 doesn't exist/,
);

// PowerPoint: speaker notes read and searched, a quote found and boxed where its text box sits,
// a quote from the notes explained, a quote on another slide noted.
const { default: PptxGen } = await import('pptxgenjs');
const pres = new PptxGen();
pres.layout = 'LAYOUT_16x9'; // 10 x 5.625 in: 96 link points to the inch
let sl = pres.addSlide();
sl.addText('Rental market review', { x: 0.5, y: 0.5, w: 9, h: 1 });
sl = pres.addSlide();
sl.addText('Vacancy fell to a three year low', { x: 1, y: 2, w: 5, h: 1 });
sl.addNotes('Mention that the survey covered 1,200 units.');
sl = pres.addSlide();
sl.addText('Recap: vacancy fell to a three year low', { x: 0.5, y: 4, w: 8, h: 1 });
await writeFile(join(src, 'sources', 'review.pptx'), Buffer.from(await pres.write({ outputType: 'nodebuffer' })));
await call('init_workspace', { workspace: src }, /ready|already/);
await call('read_file', { ...W, path: 'sources/review.pptx' }, /3 slides[\s\S]*=== slide 2 ===\nVacancy fell to a three year low\n--- speaker notes ---\nMention that the survey covered 1,200 units\./);
const two = await call('read_file', { ...W, path: 'sources/review.pptx', slides: [2, 2] }, /=== slide 2 ===/);
console.log(`${/=== slide [13] ===/.test(two) ? 'FAIL' : 'ok  '} read_file with slides=[2, 2] reads only slide 2`);
if (/=== slide [13] ===/.test(two)) failures++;
await call('search_workspace', { ...W, query: 'survey covered' }, /review\.pptx\s+slide 2 \(speaker notes\)/);
await call(
  'make_reference',
  { ...W, path: 'sources/review.pptx', quote: 'three year low', highlight: true },
  /review\.pptx#viewrect=96,192,480,96&slide=2&at=[\s\S]*note: This quote also appears on slide 3/,
);
await call('make_reference', { ...W, path: 'sources/review.pptx', slide: 1, quote: 'Vacancy fell' }, /#slide=2&at=[\s\S]*note: The quote is on slide 2, not slide 1/);
await call('make_reference', { ...W, path: 'sources/review.pptx', slide: 3, highlight: true }, /#slide=3&at=[\s\S]*highlight needs a quote/);
{
  const r = await client.callTool({ name: 'make_reference', arguments: { ...W, path: 'sources/review.pptx', quote: 'the survey covered 1,200 units' } });
  const ok = r.isError && /speaker notes of slide 2/.test(r.content[0].text);
  console.log(`${ok ? 'ok  ' : 'FAIL'} make_reference explains a quote taken from speaker notes: ${r.content[0].text.slice(0, 90)}`);
  if (!ok) failures++;
}
await call(
  'validate_note',
  { ...W, path: 'notes/deck-check.md', markdown: '# x\n\n[wrong](/sources/review.pptx#slide=1 "Vacancy fell")\n\n[box](/sources/review.pptx#viewrect=10,10,400,100&slide=2 "low Vacancy three year")\n\n[gone](/sources/review.pptx#slide=9)\n' },
  /\[wrong\]  — Quote is on slide 2, not slide 1[\s\S]*\[box\]  — No version recorded[\s\S]*BROKEN[\s\S]*Slide 9 doesn't exist/,
);

await client.close();
console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
