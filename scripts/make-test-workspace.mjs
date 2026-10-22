// Builds a throwaway workspace with real version history for manual and automated testing.
// Usage: node scripts/make-test-workspace.mjs [target-dir]   (default: ../sdl-test-workspace)
import { exec } from 'dugite';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { formatReference } from '../src/core/link.ts';

const root = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', 'sdl-test-workspace'));

async function git(args, env = {}) {
  const r = await exec(args, root, { env: { ...process.env, ...env } });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

async function put(path, content) {
  const full = join(root, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content);
}

async function commit(message, date) {
  await git(['add', '-A']);
  await git(['commit', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(['rev-parse', 'HEAD']);
}

// ---------- Content ----------

const clientV1 = `"""HTTP client used by the solver to fetch load tables."""
import time
import urllib.request

TIMEOUT_S = 10
RETRIES = 3


def fetch(url):
    """Fetch a URL, retrying a fixed number of times."""
    last_error = None
    for attempt in range(RETRIES):
        try:
            with urllib.request.urlopen(url, timeout=TIMEOUT_S) as resp:
                return resp.read()
        except OSError as err:
            last_error = err
            time.sleep(2)  # fixed sleep between attempts
    raise last_error
`;

const clientV2 = `"""HTTP client used by the solver to fetch load tables."""
import random
import time
import urllib.request

TIMEOUT_S = 10
RETRIES = 5
BASE_DELAY_S = 0.5
MAX_DELAY_S = 8.0


def backoff(attempt):
    """Exponential backoff with full jitter."""
    ceiling = min(MAX_DELAY_S, BASE_DELAY_S * 2 ** attempt)
    return random.uniform(0, ceiling)


def fetch(url):
    """Fetch a URL, backing off between attempts."""
    last_error = None
    for attempt in range(RETRIES):
        try:
            with urllib.request.urlopen(url, timeout=TIMEOUT_S) as resp:
                return resp.read()
        except OSError as err:
            last_error = err
            time.sleep(backoff(attempt))
    raise last_error
`;

const clientV3 = clientV2.replace(
  'import urllib.request\n',
  'import logging\nimport urllib.request\n\nlog = logging.getLogger(__name__)\n',
).replace('            last_error = err\n', '            last_error = err\n            log.warning("attempt %d failed: %s", attempt + 1, err)\n');

const solver = `"""Bracket margin solver."""
from dataclasses import dataclass

from net.client import fetch


@dataclass
class LoadCase:
    name: str
    fx: float
    fy: float
    fz: float


def margin(allowable, applied, factor=1.4):
    """Margin of safety per the design standard (section 4.2)."""
    return allowable / (applied * factor) - 1


def solve(cases, allowable):
    results = {}
    for case in cases:
        applied = max(abs(case.fx), abs(case.fy), abs(case.fz))
        results[case.name] = margin(allowable, applied)
    return results
`;

async function makePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const sections = [
    ['1 Scope', 'This standard sets the structural design and test requirements for brackets that carry flight loads. It applies to metallic brackets in primary and secondary structure.'],
    ['2 Applicable documents', 'The documents listed in this section form part of this standard to the extent specified herein. Where conflicts arise, this standard takes precedence.'],
    ['3 Definitions', 'Limit load is the maximum load expected in service. Ultimate load is the limit load multiplied by the ultimate factor of safety. Margin of safety is defined in section 4.2.'],
    ['4 Requirements', 'Brackets shall be designed so that no detrimental yielding occurs at limit load and no failure occurs at ultimate load.'],
    ['4.2 Factors of safety', 'The ultimate factor of safety shall be 1.4 for all metallic brackets. Retries of a failed proof test shall not exceed three attempts without engineering review.'],
    ['5 Verification', 'Each requirement shall be verified by analysis, test, or both. Table 5 lists the minimum verification method for each bracket class.'],
  ];
  for (let i = 0; i < 8; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText('BRACKET DESIGN STANDARD  ·  BDS-100 Rev C', { x: 72, y: 750, size: 9, font, color: rgb(0.4, 0.4, 0.4) });
    page.drawText(`Page ${i + 1}`, { x: 520, y: 40, size: 9, font, color: rgb(0.4, 0.4, 0.4) });
    let y = 700;
    const [title, body] = sections[i % sections.length];
    page.drawText(title, { x: 72, y, size: 16, font: bold });
    y -= 28;
    const words = (body + ' ' + body).split(' ');
    let line = '';
    for (const w of words) {
      if (font.widthOfTextAtSize(line + w, 11) > 460) {
        page.drawText(line, { x: 72, y, size: 11, font });
        y -= 16;
        line = '';
      }
      line += w + ' ';
    }
    page.drawText(line, { x: 72, y, size: 11, font });
    if (i === 4) {
      // A table to highlight with the Area tool.
      y -= 50;
      page.drawText('Table 5 — Minimum verification method', { x: 72, y, size: 11, font: bold });
      y -= 10;
      const rows = [['Class', 'Load path', 'Method'], ['A', 'Primary', 'Test'], ['B', 'Primary', 'Analysis + test'], ['C', 'Secondary', 'Analysis']];
      rows.forEach((r, ri) => {
        const ry = y - 22 * (ri + 1);
        page.drawRectangle({ x: 72, y: ry, width: 420, height: 22, borderColor: rgb(0.5, 0.5, 0.5), borderWidth: 0.7, color: ri === 0 ? rgb(0.92, 0.94, 0.92) : undefined });
        r.forEach((c, ci) => page.drawText(c, { x: 80 + ci * 140, y: ry + 7, size: 10, font: ri === 0 ? bold : font }));
      });
    }
  }
  return doc.save();
}

async function makeWorkbook(withQ3) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Load cases', { properties: { tabColor: { argb: 'FF1F5C45' } } });
  ws.columns = [{ width: 18 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 }];
  ws.mergeCells('A1:E1');
  ws.getCell('A1').value = 'Bracket load cases (N)';
  ws.getCell('A1').font = { bold: true, size: 13 };
  const header = ['Case', 'Fx', 'Fy', 'Fz', 'Resultant'];
  ws.getRow(3).values = header;
  ws.getRow(3).font = { bold: true };
  ws.getRow(3).eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4EFE8' } }));
  const cases = [
    ['Launch axial', 1850, 220, 140],
    ['Launch lateral', 410, 1620, 300],
    ['Landing', 2210, 380, 950],
    ['Ground handling', 520, 480, 610],
  ];
  if (withQ3) cases.push(['Q3 transport', 980, 1110, 720]);
  cases.forEach((row, i) => {
    const r = 4 + i;
    ws.getRow(r).values = row;
    ws.getCell(`E${r}`).value = { formula: `SQRT(B${r}^2+C${r}^2+D${r}^2)`, result: Math.hypot(row[1], row[2], row[3]) };
    for (const col of 'BCDE') ws.getCell(`${col}${r}`).numFmt = '#,##0.00';
  });
  const last = 3 + cases.length;
  wb.definedNames.add(`'Load cases'!$A$3:$E$${last}`, 'LoadTable');

  const m = wb.addWorksheet('Margins', { properties: { tabColor: { argb: 'FFC9A227' } } });
  m.columns = [{ width: 18 }, { width: 14 }, { width: 14 }];
  m.getRow(1).values = ['Case', 'Margin', 'Status'];
  m.getRow(1).font = { bold: true };
  cases.forEach((row, i) => {
    const margin = 0.12 + i * 0.07;
    m.getRow(2 + i).values = [row[0], margin, margin > 0.2 ? 'OK' : 'Review'];
    m.getCell(`B${2 + i}`).numFmt = '0.0%';
    if (margin <= 0.2) m.getCell(`C${2 + i}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFBF5E2' } };
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------- Build ----------

await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
await git(['init', '-b', 'main']);
await git(['config', 'user.name', 'Test Author']);
await git(['config', 'user.email', 'test@example.com']);
await put('.smartdoc/workspace.json', JSON.stringify({ format: 1, name: 'Bracket project', managed: true }, null, 2) + '\n');
await put('.smartdoc/.gitignore', 'cache/\n');

await put('src/net/client.py', clientV1);
await put('src/solver.py', solver);
await put('docs/BDS-100 Bracket Design Standard.pdf', await makePdf());
await put('data/Bracket loads.xlsx', await makeWorkbook(false));
await put('notes/design-basis.md', '# Design basis\n\n## Loads\n\nLoads come from the launch and landing environments.\n\n## Factors of safety\n\nUltimate factor 1.4 on all metallic parts.\n');
await put('README.md', '# Bracket project\n\nTest workspace for Smart Doc Link.\n');
const v1 = await commit('First draft', '2026-02-20T10:00:00');
await put('src/net/client.py', clientV1.replace('RETRIES = 3', 'RETRIES = 3  # per BDS-100 4.2'));
const v2 = await commit('Before retry refactor', '2026-03-03T16:30:00');
await put('src/net/client.py', clientV2);
await put('src/sleep_util.py', 'import time\n\n\ndef pause(s):\n    time.sleep(s)\n');
const v3 = await commit('Retry refactor: exponential backoff', '2026-03-10T11:15:00');
await rm(join(root, 'src/sleep_util.py'));
await put('data/Bracket loads.xlsx', await makeWorkbook(true));
const v4 = await commit('Added Q3 data', '2026-03-18T09:45:00');
// Lines inserted above the backoff loop, so live links must be remapped.
await put('src/net/client.py', clientV3);
const v5 = await commit('Log failed attempts', '2026-04-02T14:05:00');

const short = (s) => s.slice(0, 10);
const ref = (label, path, loc, extra = {}, quote) =>
  formatReference(label, { path, pathKind: 'root', loc, extra: [], ...extra }, quote);
const pdf = '/docs/BDS-100 Bracket Design Standard.pdf';

const review = `# Retry handling review

A walkthrough of how the HTTP client retries, and why.

## The standard

Retries are capped by ${ref('BDS-100 p5', pdf, { page: 5 }, { at: short(v5) }, 'Retries of a failed proof test shall not exceed three attempts without engineering review.')}, and verification methods are in ${ref('Table 5', pdf, { page: 5, viewrect: { x: 66, y: 208, w: 432, h: 112 } }, { at: short(v5) })}.

## Before the refactor

The old client used ${ref('a fixed sleep', '/src/net/client.py', { lines: { start: 12, end: 18 } }, { rev: short(v2) }, 'time.sleep(2)  # fixed sleep between attempts')} between attempts, via a helper that was later deleted: ${ref('sleep_util.py', '/src/sleep_util.py', { lines: { start: 4, end: 5 } }, { rev: short(v3) })}.

## After the refactor

Now ${ref('the backoff loop', '/src/net/client.py', { lines: { start: 18, end: 28 } }, { at: short(v3) }, 'def fetch(url):')} calls ${ref('backoff()', '/src/net/client.py', { lines: { start: 12, end: 15 } }, { at: short(v3) })}. Both links were made before logging was added, so the app maps them to the new line numbers.

## Loads

- The governing case is in ${ref('Bracket loads LoadTable', '/data/Bracket loads.xlsx', { sheet: { range: 'LoadTable' } }, { at: short(v5) })}.
- Margins: ${ref("Bracket loads Margins!B2:C6", '/data/Bracket loads.xlsx', { sheet: { sheet: 'Margins', range: 'B2:C6' } }, { at: short(v5) }, 'Case | Margin | Status')}
- Before Q3 data: ${ref("Load cases (Mar 3)", '/data/Bracket loads.xlsx', { sheet: { sheet: 'Load cases', range: 'A3:E7' } }, { rev: short(v2) })}
- Design basis: [factors of safety](/notes/design-basis.md#factors-of-safety)

## Open items

- [x] Check the cap against the standard
- [ ] Confirm jitter is acceptable for proof tests
- [ ] This link is deliberately broken: ${ref('old analysis', '/docs/old-analysis.pdf', { page: 2 })}

| Item | Owner |
| --- | --- |
| Retry cap | Dan |
| Jitter | TBD |

See also [the Python docs](https://docs.python.org/3/library/random.html).
`;
await put('notes/review.md', review);
await commit('Review notes', '2026-04-03T08:00:00');

console.log(`Test workspace ready: ${root}`);
console.log({ v1, v2, v3, v4, v5 });
