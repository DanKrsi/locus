// Builds the Aurora-3 sample workspace: real NASA standards, code, workbooks, decks, images and
// audio with a dated version history, plus notes whose links are made by Locus's own MCP tools
// (so every link is verified and records the version it was made from).
// Usage: npm run build && npm run build:mcp && node scripts/make-sample.mjs [dest]   (default C:\dev\locus-sample)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { exec } from 'dugite';
import { existsSync } from 'node:fs';
import { marginCheckFlow } from './sample/flow.mjs';
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import * as A from './sample/assets.mjs';
import * as C from './sample/content.mjs';

const repo = resolve(import.meta.dirname, '..');
const dest = resolve(process.argv[2] ?? join(repo, '..', 'locus-sample'));
const cache = join(repo, '.sample-cache');
const work = join(repo, 'test-output', 'sample-assets');

const STANDARDS = {
  '5001B-2014': ['https://standards.nasa.gov/sites/default/files/standards/NASA/B-w/CHANGE-2/2/Historical/nasa-std-5001b.pdf', 'NASA-STD-5001B-2014.pdf'],
  '5001B-2022': ['https://standards.nasa.gov/sites/default/files/standards/NASA/B-w/CHANGE-3/3/2022-10-24-NASA-STD-5001B-w-Change-3-Approved.pdf', 'NASA-STD-5001B-Change3-2022.pdf'],
  '5020B': ['https://standards.nasa.gov/sites/default/files/standards/NASA/B/0/2021-08-06-nasa-std-5020b_final.pdf', 'NASA-STD-5020B-2021.pdf'],
};

async function standard(key) {
  const [url, name] = STANDARDS[key];
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
const png = (n) => join(work, n);
await A.renderPngs(repo, [
  { svg: A.bracketSvg(2.0), file: png('bracket-v1.png') },
  { svg: A.bracketSvg(3.0), file: png('bracket-v2.png') },
  { svg: A.vibePlotSvg(), file: png('vibe-test-z.png') },
]);
await A.pdrDeck(png('deck-pdr.pptx'), png('bracket-v1.png'));
await A.cdrDeck(png('deck-cdr.pptx'), png('bracket-v2.png'), png('vibe-test-z.png'));
const audioStarts = await A.meetingAudio(png('meeting.wav'), join(work, 'tts'));
console.log('  meeting segments start at', audioStarts.map((s) => `${s}s`).join(', '));

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
const PEOPLE = { priya: ['Priya Natarajan', 'priya@aurora3.example'], sam: ['Sam Okafor', 'sam@aurora3.example'] };
const commit = async (message, date, who) => {
  const [name, email] = PEOPLE[who];
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', message], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  });
  return git(['rev-parse', 'HEAD']);
};

await git(['init', '-q', '-b', 'main']);
await git(['config', 'user.name', 'Locus sample']);
await git(['config', 'user.email', 'sample@locus.local']);
await put('.locus/workspace.json', JSON.stringify({ format: 1, name: 'Aurora-3 bracket', managed: true }, null, 2) + '\n');
await put('.locus/.gitignore', 'cache/\n');

const PDF5001 = 'docs/standards/NASA-STD-5001B.pdf';
const PDF5020 = 'docs/standards/NASA-STD-5020B.pdf';
const DECK = 'docs/reviews/Aurora-3 bracket review.pptx';
const IMG = 'images/bracket-concept.png';

console.log('Writing history…');
await put('README.md', C.readme);
await putFile(PDF5001, await standard('5001B-2014'));
await putFile(PDF5020, await standard('5020B'));
await put('src/analysis/margins.py', C.marginsV1);
await put('src/analysis/legacy_units.py', C.legacyUnits);
await put('src/analysis/loads.py', C.loadsPy);
await put('data/loads.xlsx', await A.loadsWorkbook(1));
await putFile(IMG, png('bracket-v1.png'));
const v1 = await commit('Project kickoff: standards, first analysis and loads', '2026-01-12T09:30:00', 'priya');

await putFile(DECK, png('deck-pdr.pptx'));
await put('data/margins.xlsx', await A.marginsWorkbook(1));
const v2 = await commit('PDR package: review deck and margins', '2026-02-03T16:00:00', 'sam');

await put('data/loads.xlsx', await A.loadsWorkbook(2));
await put('data/margins.xlsx', await A.marginsWorkbook(2));
await putFile(IMG, png('bracket-v2.png'));
const v3 = await commit('PDR-1: thicker 3.0 mm flange; update mass and margins', '2026-02-24T11:15:00', 'priya');

await put('src/analysis/margins.py', C.marginsV2);
await put('config/factors.yaml', C.factorsV1);
await rm(join(dest, 'src/analysis/legacy_units.py'));
const v4 = await commit('PDR-2: factors from config, fitting factor on bolts (NASA-STD-5020B)', '2026-03-10T14:40:00', 'sam');

await put('data/vibe-test-log.csv', C.testLog);
await put('tests/test_margins.py', C.testMargins);
await putFile('images/vibe-test-z.png', png('vibe-test-z.png'));
const v5 = await commit('Protoflight vibration test results', '2026-03-31T17:20:00', 'priya');

await putFile(PDF5001, await standard('5001B-2022'));
await putFile(DECK, png('deck-cdr.pptx'));
await put('src/analysis/margins.py', C.marginsV3);
await put('config/factors.yaml', C.factorsV2);
const v6 = await commit('CDR: adopt NASA-STD-5001B Change 3, separation check, CDR deck', '2026-04-14T10:00:00', 'sam');

await putFile('media/design-review-2026-04-16.wav', png('meeting.wav'));
const v7 = await commit('Recording of the April 16 design review', '2026-04-16T15:30:00', 'priya');

// ---------- References through the MCP server ----------

console.log('Making references with the Locus MCP tools…');
const client = new Client({ name: 'make-sample', version: '1' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(repo, 'dist', 'mcp', 'server.mjs'), dest], stderr: 'ignore' }));
const ref = async (args) => {
  const r = await client.callTool({ name: 'make_reference', arguments: args });
  const text = r.content.map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`make_reference ${JSON.stringify(args)}: ${text}`);
  return text.split('\n')[0];
};

const s = (sha) => sha.slice(0, 10);
const TABLE1 =
  'Table 1—Minimum Design and Test Factors for Metallic Structures Verification Approach Ultimate Design Factor Yield Design Factor Qualification Test Factor Proof Test Factor Prototype 1.4 1.0* 1.4 N/A or 1.05** Protoflight 1.4 1.25 1.2 N/A or 1.05**';
const R = {
  table1: await ref({ path: PDF5001, label: 'NASA-STD-5001B Table 1', quote: TABLE1, highlight: true }),
  table1Old: await ref({ path: PDF5001, label: 'Table 1 in the 2014 edition', quote: TABLE1, highlight: true, version: v1 }),
  fsr24: await ref({ path: PDF5001, label: '[FSR 24]', quote: '[FSR 24] The minimum design and test factors of safety for metallic structures shall be as specified in Table 1', highlight: true }),
  msDef: await ref({ path: PDF5001, label: 'the margin of safety definition', quote: 'Margin of Safety (MS):', highlight: true }),
  fitting: await ref({ path: PDF5020, label: 'NASA-STD-5020B 4.2.2', quote: 'Ultimate strength analysis of threaded fastening systems should include a fitting factor of at least 1.15 as a multiplier of the required ultimate factor of safety.', highlight: true }),
  sepReq: await ref({ path: PDF5020, label: '[TFSR 4]', quote: '[TFSR 4] Threaded fastening system hardware shall be designed using the separation factor of safety (FSsep) specified by Figure 1', highlight: true }),
  sepPage: await ref({ path: PDF5020, label: 'Figure 1 (separation logic)', page: 20 }),

  marginFn: await ref({ path: 'src/analysis/margins.py', label: 'margin()', quote: 'def margin(allowable, limit, factor):\n    """MS = allowable / (limit x factor) - 1."""\n    return allowable / (limit * factor) - 1' }),
  loadFactors: await ref({ path: 'src/analysis/margins.py', label: 'load_factors()', quote: 'def load_factors(path="config/factors.yaml"):' }),
  boltNow: await ref({ path: 'src/analysis/margins.py', label: 'bolt_margins()', quote: 'def bolt_margins(limit_tension_n, allowable_n, f):\n    # NASA-STD-5020B 4.2.2: the fitting factor multiplies the factor of safety.\n    return {"ultimate": margin(allowable_n, limit_tension_n, f.ultimate * f.fitting)}' }),
  separation: await ref({ path: 'src/analysis/margins.py', label: 'separation_margin()', quote: 'def separation_margin(preload_min_n, limit_tension_n, f):\n    """Positive while the joint stays clamped (NASA-STD-5020B 4.2.3)."""\n    return preload_min_n / (limit_tension_n * f.separation * f.fitting) - 1' }),
  hardcoded: await ref({ path: 'src/analysis/margins.py', label: 'hard-coded factors', quote: 'ULTIMATE_FS = 1.4  # NASA-STD-5001B Table 1, protoflight\nYIELD_FS = 1.25', version: v1 }),
  boltOld: await ref({ path: 'src/analysis/margins.py', label: 'the old bolt_margins()', quote: 'def bolt_margins(limit_tension_n, allowable_n):\n    return {"ultimate": margin(allowable_n, limit_tension_n, ULTIMATE_FS)}', version: v1 }),
  legacy: await ref({ path: 'src/analysis/legacy_units.py', label: 'legacy_units.py', quote: 'def ksi_to_mpa(ksi):', version: v1 }),
  factorsYaml: await ref({ path: 'config/factors.yaml', label: 'config/factors.yaml', lines: [3, 7] }),
  fittingYaml: await ref({ path: 'config/factors.yaml', label: 'fitting: 1.15', quote: 'fitting: 1.15' }),
  miles: await ref({ path: 'src/analysis/loads.py', label: "Miles' equation", quote: 'def miles_grms(fn_hz, q, asd_g2_per_hz):' }),
  testFitting: await ref({ path: 'tests/test_margins.py', label: 'a test', quote: 'def test_fitting_factor_reduces_bolt_margin():' }),

  massNow: await ref({ path: 'data/loads.xlsx', label: 'mass properties', range: 'MassTable' }),
  massOld: await ref({ path: 'data/loads.xlsx', label: 'mass at kickoff', range: "'Mass properties'!A3:C8", version: v1 }),
  bracketMass: await ref({ path: 'data/loads.xlsx', label: 'bracket mass', range: "'Mass properties'!A5:C5" }),
  limitLoads: await ref({ path: 'data/loads.xlsx', label: 'limit loads', range: 'LimitLoads' }),
  vibeProfile: await ref({ path: 'data/loads.xlsx', label: 'vibration input', range: 'VibeProfile' }),
  marginSummary: await ref({ path: 'data/margins.xlsx', label: 'margin summary', range: 'MarginSummary' }),
  marginsPdr: await ref({ path: 'data/margins.xlsx', label: 'PDR margins', range: 'Margins!A3:G6', version: v2 }),
  flangeYieldPdr: await ref({ path: 'data/margins.xlsx', label: 'flange yield at PDR', range: 'Margins!A5:G5', version: v2 }),
  flangeYieldNow: await ref({ path: 'data/margins.xlsx', label: 'flange yield now', range: 'Margins!A5:G5' }),
  separationRow: await ref({ path: 'data/margins.xlsx', label: 'separation margin', range: 'Margins!A7:G7' }),
  factorsSheet: await ref({ path: 'data/margins.xlsx', label: 'design factors', range: 'DesignFactors' }),
  runZ: await ref({ path: 'data/vibe-test-log.csv', label: 'run 6 (Z, protoflight)', range: 'A7:H7' }),
  allRuns: await ref({ path: 'data/vibe-test-log.csv', label: 'test log', range: 'A1:H8' }),

  slideChanges: await ref({ path: DECK, label: 'CDR: changes since PDR', slide: 2 }),
  slideMarginsCdr: await ref({ path: DECK, label: 'CDR margins slide', slide: 6 }),
  slideTest: await ref({ path: DECK, label: 'CDR test slide', slide: 7 }),
  slideMarginsPdr: await ref({ path: DECK, label: 'PDR margins slide', slide: 5, version: v2 }),
  slideOpenPdr: await ref({ path: DECK, label: 'PDR open items', slide: 6, version: v2 }),

  audioFlange: await ref({ path: 'media/design-review-2026-04-16.wav', label: 'flange change', time: fmt(audioStarts[1]) }),
  audioFitting: await ref({ path: 'media/design-review-2026-04-16.wav', label: 'fitting factor', time: fmt(audioStarts[2]) }),
  audioTest: await ref({ path: 'media/design-review-2026-04-16.wav', label: 'test result', time: fmt(audioStarts[3]) }),
  audioAction: await ref({ path: 'media/design-review-2026-04-16.wav', label: 'the open action', time: fmt(audioStarts[4]) }),
  plot: await ref({ path: 'images/vibe-test-z.png', label: 'the Z-axis plot' }),
};
function fmt(sec) {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// ---------- Notes ----------

const n = (slug, heading) => `/notes/${slug}.md#${heading}`;
const notes = {
  'notes/00 Start here.md': `# Aurora-3 avionics bracket — start here

This is a small, made-up CubeSat project that shows everything Locus can do. The engineering is simplified, but the standards are real NASA documents, and the project has a version history from January to April.

![Concept drawing of the bracket](/${IMG})

## How to use this sample

Notes open on the **left** (Open note, Ctrl+O). Documents open on the **right** (Open document, Ctrl+P). Click any green link to jump to the exact spot it cites; hover a link to preview it.

| Note | What it shows |
| --- | --- |
| [Design review](${n('design-review', 'the-tour')}) | A guided tour: PDF areas, code, spreadsheets, slides, audio, images, tables |
| [Analysis history](${n('analysis-history', 'how-the-analysis-changed')}) | Past versions: old code vs new, two editions of a standard, before/after spreadsheets and slides |
| [Test plan](${n('test-plan', 'protoflight-vibration-test')}) | CSV data, a plot image, and timestamps in a meeting recording |
| [Decisions](${n('decisions', 'decision-log')}) | A decision log with links inside table cells |
| [Playground](${n('playground', 'try-it-yourself')}) | Somewhere to try citing, renaming and breaking things |
| [Margin check](/notes/margin-check.canvas) | A flowchart: loops, a decision, and citations inside boxes |

## Try these

- [ ] Open the [design review](/notes/design-review.md) and press **Tour** (Ctrl+Shift+T), then ← → to step through it.
- [ ] Hover ${R.table1} to see a preview, then click it.
- [ ] Click ${R.hardcoded} (a pinned link) and then use **Compare** on the history strip.
- [ ] Open **History** in the header and pick "PDR-1: thicker 3.0 mm flange" to see what changed.
- [ ] Open \`data/margins.xlsx\` and look at **Cited in** under its toolbar.

## What's in the folder

| Folder | Contents |
| --- | --- |
| \`docs/standards\` | NASA-STD-5001B (two editions in history) and NASA-STD-5020B, real public-release standards |
| \`docs/reviews\` | The review deck: PDR version in February, CDR version in April |
| \`src\`, \`config\`, \`tests\` | Python margin and load calculations |
| \`data\` | Loads and margins workbooks, vibration test CSV |
| \`images\`, \`media\` | Concept drawing, test plot, meeting recording |
`,

  'notes/design-review.md': `# Aurora-3 bracket — CDR design review

## The tour

Press **Tour** in the toolbar (or Ctrl+Shift+T) and use ← → to step through every link in this note in order. The viewer on the right follows along.

## Requirements

Factors of safety come from ${R.table1}. Under a protoflight approach the bracket needs an ultimate factor of 1.4 and a yield factor of 1.25. The current edition also numbers the requirement: ${R.fsr24}.

Margins use ${R.msDef}, which the code implements as ${R.marginFn}.

The bolts follow NASA-STD-5020B: ${R.fitting} adds a fitting factor of 1.15, and ${R.sepReq} sets the separation factor from ${R.sepPage}.

## Configuration

![Bracket concept, 3.0 mm flange](/${IMG})

After PDR the flange went from 2.0 to 3.0 mm (see ${R.slideChanges}). That raised the ${R.bracketMass} slightly; the full breakdown is in the ${R.massNow}.

## Loads

The ${R.limitLoads} come from the total mass and the launch vehicle load factors. Random vibration uses this ${R.vibeProfile}, and ${R.miles} estimates the response.

## Margins

All margins are positive. The numbers live in the ${R.marginSummary} and on the ${R.slideMarginsCdr}.

| Part | Mode | Margin | Where it's computed |
| --- | --- | ---: | --- |
| Flange | Bending, ultimate | 1.11 | ${R.marginSummary} |
| Flange | Bending, yield | 0.97 | ${R.flangeYieldNow} |
| Bolt | Tension, ultimate (× 1.15) | 0.74 | ${R.boltNow} |
| Joint | Separation | 0.41 | ${R.separationRow} via ${R.separation} |

Factors are read by ${R.loadFactors} from ${R.factorsYaml}, and ${R.testFitting} checks that the fitting factor is applied.

## Test

The protoflight vibration test passed: see ${R.runZ} and ${R.slideTest}. In the review meeting we discussed the ${R.audioTest}.

## Open items

- [x] PDR-1: thicker flange (${R.audioFlange} in the meeting)
- [x] PDR-2: fitting factor on bolts (${R.audioFitting})
- [ ] CDR-1: confirm the separation factor for the connector-side joint (${R.audioAction})
- [ ] CDR-2: update the harness clamp mass after routing review

How we got here is in [analysis history](/notes/analysis-history.md#how-the-analysis-changed).
`,

  'notes/analysis-history.md': `# How the analysis changed

## Reading this note

Links marked with a date badge are **pinned** to a past version; the others always show the latest. Hover any link to see which version it points to, and use **Compare** on the history strip to see two versions side by side.

## Code: hard-coded factors → config file

At kickoff the factors were ${R.hardcoded} in the code, and ${R.boltOld} ignored the fitting factor. Unit conversion came from ${R.legacy}, a file that was deleted in March but still opens because its link is pinned to January.

Today the factors are read by ${R.loadFactors} from ${R.factorsYaml}, and ${R.boltNow} multiplies the ultimate factor by the ${R.fittingYaml}.

To see the change: click ${R.hardcoded}, then press **Compare** on the history strip under the code.

## The standard got a new edition

The project started on the 2014 edition of NASA-STD-5001B and moved to Change 3 at CDR. ${R.table1Old} is on page 17; in the current edition ${R.table1} moved to page 18 and the requirement gained an ID, ${R.fsr24}.

## Spreadsheets before and after PDR

The ${R.marginsPdr} flagged the ${R.flangeYieldPdr} as low. After the thicker flange, the same cells read ${R.flangeYieldNow}. Mass went up too: compare the ${R.massOld} with today's ${R.massNow}.

## Slides before and after

The ${R.slideMarginsPdr} (February) and the ${R.slideMarginsCdr} (April) are the same deck file at two versions. The PDR deck listed the actions on ${R.slideOpenPdr}.

## Drawings before and after

The concept drawing is one file with two versions. Left is the PDR version (pinned to February), right is today's:

![Concept at PDR, 2.0 mm flange](/${IMG}#rev=${s(v2)})

![Concept now, 3.0 mm flange](/${IMG})
`,

  'notes/test-plan.md': `# Test plan and results

## Protoflight vibration test

The bracket and box were tested on a shaker in all three axes with the ${R.vibeProfile} (14.1 grms). The ${R.allRuns} has every run; the key one is ${R.runZ}.

![Z-axis random vibration response](/images/vibe-test-z.png)

The ${R.plot} shows the first mode at 312 Hz, which matches the CDR slide (${R.slideTest}).

## Pass criteria

| Check | Criterion | Result |
| --- | --- | --- |
| Frequency shift | < 5% between pre- and post-test sine | 0.3% (${R.runZ}) |
| Visual inspection | No cracks or loose fasteners | Pass |
| Margins | All positive at qualification level | ${R.marginSummary} |

## Meeting recording

The April 16 review is recorded. Jump to the ${R.audioTest}, or to ${R.audioAction} that is still open.
`,

  'notes/decisions.md': `# Decisions

## Decision log

| Date | Decision | Why | Evidence |
| --- | --- | --- | --- |
| Feb 24 | Flange 2.0 → 3.0 mm | Yield margin was low at PDR | ${R.flangeYieldPdr}, ${R.slideMarginsPdr} |
| Mar 10 | Fitting factor 1.15 on bolts | Required by the fastener standard | ${R.fitting}, ${R.boltNow} |
| Mar 10 | Factors in one config file | One reviewed source of truth | ${R.factorsYaml} |
| Apr 14 | Adopt 5001B Change 3 | Current edition at CDR | ${R.table1}, ${R.table1Old} |
| Apr 14 | Separation factor 1.2 | Connector-side joint is separation-critical | ${R.sepReq}, ${R.separation} |

See also the [CDR review](/notes/design-review.md#margins) and the [test results](/notes/test-plan.md#pass-criteria).
`,

  'notes/playground.md': `# Playground

## Try it yourself

Put the cursor at the end of this note, open any document on the right, and press **Cite** (Ctrl+Shift+L). Type a name and press Enter.

- In a PDF, click **Area** and drag a box around a table before citing.
- In code, select a few lines first.
- In a spreadsheet, drag across some cells.
- In the deck, scroll to a slide.
- In the recording, pause where you want to cite.

## Things that can go wrong

This link points to a file that was never added, so it shows as broken: [old analysis](/docs/old-analysis.pdf#page=2).

Rename \`src/analysis/loads.py\` from the file browser (the pencil icon) and watch ${R.miles} follow it. Or move \`data/loads.xlsx\` in File Explorer and come back to Locus to see **Fix links**.

Web links work too: [NASA Technical Standards System](https://standards.nasa.gov).

## Your notes

`,
};

for (const [path, text] of Object.entries(notes)) await put(path, text);
await put('notes/margin-check.canvas', marginCheckFlow(R));
const v8 = await commit('Design review notes', '2026-04-20T09:10:00', 'sam');

// After the notes: lines move in margins.py, so live links have to follow them.
await put('src/analysis/margins.py', C.marginsV4);
const v9 = await commit('Document the margin module inputs', '2026-04-22T13:05:00', 'priya');

// ---------- Check every note ----------

console.log('Checking links…');
let problems = 0;
for (const path of Object.keys(notes)) {
  const r = await client.callTool({ name: 'validate_note', arguments: { path } });
  const text = r.content.map((c) => c.text).join('\n');
  const lines = text.split('\n').filter((l) => /^(BROKEN|WARNING|CHANGED)/.test(l));
  const expected = lines.filter((l) => !/old analysis/.test(l));
  problems += expected.length;
  console.log(`  ${path}: ${text.split('\n')[0]}`);
  for (const l of lines) console.log(`    ${l}`);
}
await client.close();
console.log(`\nSample ready: ${dest}`);
console.log({ v1, v2, v3, v4, v5, v6, v7, v8, v9 });
if (problems) {
  console.log(`${problems} unexpected link problem(s)`);
  process.exit(1);
}
