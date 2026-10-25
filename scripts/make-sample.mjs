// Builds the Locus demo workspace: the fewest files that show every feature. One note (also the
// tour) and one flowchart, over a PDF standard in two editions, a small code file in three
// versions, a workbook, a slide deck, an image and a short recording. Links are made by Locus's own
// MCP tools, so each is verified and records the version it was made from.
// Usage: npm run build && npm run build:mcp && node scripts/make-sample.mjs [dest]   (default C:\dev\locus-sample)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { exec } from 'dugite';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as A from './sample/assets.mjs';
import * as C from './sample/content.mjs';

const repo = resolve(import.meta.dirname, '..');
const dest = resolve(process.argv[2] ?? join(repo, '..', 'locus-sample'));
const cache = join(repo, '.sample-cache');
const work = join(repo, 'test-output', 'sample-assets');

// NASA-STD-5001B (public release), 2014 edition and the 2022 Change 3 edition.
const EDITIONS = {
  2014: ['https://standards.nasa.gov/sites/default/files/standards/NASA/B-w/CHANGE-2/2/Historical/nasa-std-5001b.pdf', 'NASA-STD-5001B-2014.pdf'],
  2022: ['https://standards.nasa.gov/sites/default/files/standards/NASA/B-w/CHANGE-3/3/2022-10-24-NASA-STD-5001B-w-Change-3-Approved.pdf', 'NASA-STD-5001B-Change3-2022.pdf'],
};
async function edition(year) {
  const [url, name] = EDITIONS[year];
  const file = join(cache, name);
  if (!existsSync(file)) {
    await mkdir(cache, { recursive: true });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
  }
  return file;
}

// ---------- Assets ----------

console.log('Preparing assets…');
await rm(work, { recursive: true, force: true });
await mkdir(work, { recursive: true });
const tmp = (n) => join(work, n);
await A.renderPngs(repo, [{ svg: A.bracketSvg(3.0), file: tmp('bracket.png') }]);
await A.pdrDeck(tmp('deck.pptx'), tmp('bracket.png'));
const audioStarts = await A.meetingAudio(tmp('review.wav'), join(work, 'tts'), C.audioLines);

// ---------- Workspace and history ----------

if (existsSync(dest)) {
  let backup = `${dest}-previous`;
  if (existsSync(backup)) backup = `${dest}-previous-${Date.now()}`;
  await rename(dest, backup);
  console.log(`Moved the existing folder to ${backup}`);
}
await mkdir(dest, { recursive: true });

const git = async (args, env = {}) => {
  const r = await exec(args, dest, { env: { ...process.env, ...env } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const put = async (path, content) => {
  await mkdir(dirname(join(dest, path)), { recursive: true });
  await writeFile(join(dest, path), content);
};
const putFile = async (path, from) => {
  await mkdir(dirname(join(dest, path)), { recursive: true });
  await copyFile(from, join(dest, path));
};
const commit = async (message, date) => {
  await git(['add', '-A']);
  const env = { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  await git(['commit', '-q', '-m', message], env);
  return git(['rev-parse', 'HEAD']);
};

await git(['init', '-q', '-b', 'main']);
await git(['config', 'user.name', 'Locus demo']);
await git(['config', 'user.email', 'demo@locus.local']);
await put('.locus/workspace.json', JSON.stringify({ format: 1, name: 'Locus demo', managed: true }, null, 2) + '\n');
await put('.locus/.gitignore', 'cache/\n');

const PDF = 'docs/standard.pdf';
const CODE = 'src/margins.py';
const XLSX = 'data/loads.xlsx';
const DECK = 'docs/review.pptx';
const IMG = 'images/bracket.png';
const WAV = 'media/review.wav';
const NOTE = 'notes/Start here.md';
const FLOW = 'notes/flow.canvas';

console.log('Writing history…');
await putFile(PDF, await edition(2014));
await put(CODE, C.codeV1);
await put(XLSX, await A.loadsWorkbook(1));
await putFile(DECK, tmp('deck.pptx'));
await putFile(IMG, tmp('bracket.png'));
await putFile(WAV, tmp('review.wav'));
const v1 = await commit('First draft', '2026-01-12T09:30:00');

await putFile(PDF, await edition(2022));
await put(CODE, C.codeV2);
await put(XLSX, await A.loadsWorkbook(2));
const v2 = await commit('Revision', '2026-02-24T11:15:00');

// ---------- Links through the MCP tools ----------

console.log('Making links with the Locus MCP tools…');
const client = new Client({ name: 'make-sample', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(repo, 'dist', 'mcp', 'server.mjs'), dest], stderr: 'ignore' }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${name} ${JSON.stringify(args).slice(0, 200)}: ${text}`);
  return text;
};
const ref = async (args) => (await call('make_reference', args)).split('\n')[0];
const at = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const TABLE1 =
  'Table 1—Minimum Design and Test Factors for Metallic Structures Verification Approach Ultimate Design Factor Yield Design Factor Qualification Test Factor Proof Test Factor Prototype 1.4 1.0* 1.4 N/A or 1.05** Protoflight 1.4 1.25 1.2 N/A or 1.05**';
const CHECK_V2 = 'def check(cases, parts):';
const R = {
  page: await ref({ path: PDF, label: 'the scope (page 6)', page: 6 }),
  table1: await ref({ path: PDF, label: 'Table 1', quote: TABLE1, highlight: true }),
  table1Old: await ref({ path: PDF, label: 'Table 1 in the 2014 edition', quote: TABLE1, highlight: true, version: v1 }),
  check: await ref({ path: CODE, label: 'check()', quote: CHECK_V2 }),
  margin: await ref({ path: CODE, label: 'margin()', quote: 'def margin(allowable, load, factor=FACTORS["ultimate"]):\n    """Margin of safety: allowable / (load x factor) - 1."""\n    return allowable / (load * factor) - 1' }),
  checkOld: await ref({ path: CODE, label: 'the first draft of check()', quote: CHECK_V2, version: v1 }),
  mass: await ref({ path: XLSX, label: 'the mass table', range: 'MassTable' }),
  bracket: await ref({ path: XLSX, label: 'bracket mass', range: "'Mass properties'!A5:C5" }),
  bracketOld: await ref({ path: XLSX, label: 'bracket mass at the first draft', range: "'Mass properties'!A5:C5", version: v1 }),
  slideMargins: await ref({ path: DECK, label: 'the margins slide', slide: 5 }),
  slideOpen: await ref({ path: DECK, label: 'open items', slide: 6 }),
  audioStart: await ref({ path: WAV, label: 'the start', time: at(audioStarts[0]) }),
  audioDecision: await ref({ path: WAV, label: 'the decision', time: at(audioStarts[1]) }),
  audioAction: await ref({ path: WAV, label: 'the action', time: at(audioStarts[2]) }),
  image: await ref({ path: IMG, label: 'the drawing' }),
};
const heading = (slug) => `/notes/Start%20here.md#${slug}`;

// ---------- The flowchart, drafted the way Claude would ----------

await call('write_flowchart', {
  path: FLOW,
  loops: [
    { id: 'cases', label: 'for case in cases' },
    { id: 'parts', label: 'for part in parts', parent: 'cases' },
  ],
  boxes: [
    { id: 'start', shape: 'terminal', text: 'check(cases, parts)', cite: [{ path: CODE, label: 'check()', quote: CHECK_V2 }] },
    { id: 'factor', text: 'Pick the factor', loop: 'parts', cite: [{ path: CODE, label: 'fitting for bolts', quote: '            factor = FACTORS["ultimate"] * (FITTING if part.is_bolt else 1)' }] },
    { id: 'ms', text: 'Compute the margin', loop: 'parts', cite: [{ path: CODE, label: 'margin()', quote: 'def margin(allowable, load, factor=FACTORS["ultimate"]):' }] },
    { id: 'ok', shape: 'decision', text: 'MS < 0?', loop: 'parts' },
    { id: 'flag', text: 'Add to the redesign list', loop: 'parts', cite: [{ path: CODE, label: 'failed.append', quote: '                failed.append((case.name, part.name, ms))' }] },
    { id: 'done', shape: 'terminal', text: 'Return the list', cite: [{ path: CODE, label: 'return', quote: '    return failed' }] },
  ],
  arrows: [
    { from: 'start', to: 'factor' },
    { from: 'factor', to: 'ms' },
    { from: 'ms', to: 'ok' },
    { from: 'ok', to: 'flag', label: 'yes' },
    { from: 'flag', to: 'factor', label: 'next part' },
    { from: 'ok', to: 'factor', label: 'no' },
    { from: 'cases', to: 'done', label: 'all cases checked' },
  ],
});

R.flow = await ref({ path: FLOW, label: 'The margin check' });

// ---------- The note (also the tour) ----------

await put(
  NOTE,
  `# Locus demo

One note, one flowchart and a few files, to show what Locus does. Click any green link to jump to the exact place it cites; hover one for a preview. Press **Tour** to step through every link in order.

## PDF

A page: ${R.page}. A highlighted passage: ${R.table1}. The same passage in the older edition: ${R.table1Old} (a pinned link, with a date badge). Open the PDF and press **Compare** on its history strip to see both editions side by side.

## Code

${R.check} is a live link: lines were added above it after this note was written, and Locus follows them. ${R.margin} shows **changed** because its lines were edited since. ${R.checkOld} is pinned to the first version; hover it and press **Compare with latest** for a diff.

## Spreadsheet

A named range: ${R.mass}. A cell range: ${R.bracket}, and the same cells in the first draft: ${R.bracketOld}.

## Slides, image and audio

Slides: ${R.slideMargins} and ${R.slideOpen}. The recording: ${R.audioStart}, ${R.audioDecision}, ${R.audioAction}.

![The bracket](/${IMG})

That's ${R.image} shown inside the note.

## Table

| Claim | Evidence |
| --- | --- |
| Ultimate factor is 1.4 | ${R.table1} |
| Bolts take a fitting factor | ${R.audioAction} |
| The bracket got heavier | ${R.bracketOld} → ${R.bracket} |

## Flowchart

${R.flow} is a flowchart of \`check()\`: a loop inside a loop, a decision, and code citations in its boxes.

## Try it

- [ ] Open a document on the right, select something, and press **Cite** to link it here.
- [ ] Hover a link, then **Pin** or **Make live**.
- [ ] Rename \`src/margins.py\` from Open (Ctrl+P): the live links here follow it.
- [ ] Open **Version history** from Open, and look at what each version changed.
- [ ] This link is deliberately broken: [old analysis](/docs/old-analysis.pdf#page=2). Back to the [top](${heading('locus-demo')}).
`,
);

// After the notes: the code changes, so live links follow moved lines and one shows "changed".
await put(CODE, C.codeV3);
const v3 = await commit('Notes added', '2026-03-10T14:40:00');

// ---------- Check every link ----------

console.log('Checking links…');
let problems = 0;
for (const path of [NOTE, FLOW]) {
  const text = await call('validate_note', { path });
  const lines = text.split('\n').filter((l) => /^(BROKEN|WARNING)/.test(l));
  // The one deliberate broken link is expected.
  problems += lines.filter((l) => !/old analysis/.test(l)).length;
  console.log(`  ${path}: ${text.split('\n')[0]}`);
  for (const l of text.split('\n').filter((l) => /^(BROKEN|WARNING|CHANGED|MOVED)/.test(l))) console.log(`    ${l}`);
}
await client.close();
console.log(`\nDemo ready: ${dest}`);
console.log({ v1, v2, v3 });
if (problems) {
  console.log(`${problems} unexpected link problem(s)`);
  process.exit(1);
}
