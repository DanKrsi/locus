// Binary assets for the Aurora-3 sample: drawings (SVG → PNG), workbooks, decks and audio.
import ExcelJS from 'exceljs';
import pptxgen from 'pptxgenjs';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { meetingSegments } from './content.mjs';

const GREEN = '1F5C45';
const GOLD = 'C9A227';
const INK = '1F2328';

// ---------- Drawings ----------

export function bracketSvg(flangeMm) {
  const t = flangeMm * 9; // drawn thickness in px
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="520" viewBox="0 0 900 520" font-family="Segoe UI, Arial, sans-serif">
  <rect width="900" height="520" fill="#ffffff"/>
  <text x="30" y="44" font-size="26" font-weight="700" fill="#${GREEN}">Aurora-3 avionics bracket — concept</text>
  <text x="30" y="72" font-size="16" fill="#66706a">Side view, not to scale · 6061-T6 aluminium · 4 × #8-32 A286 fasteners</text>
  <!-- deck panel -->
  <rect x="60" y="420" width="560" height="26" fill="#d9ddd9" stroke="#98a19b"/>
  <text x="70" y="438" font-size="14" fill="#444">Spacecraft deck panel</text>
  <!-- L bracket: base flange on deck, vertical web -->
  <rect x="120" y="${420 - t}" width="420" height="${t}" fill="#${GREEN}"/>
  <rect x="${540 - t}" y="150" width="${t}" height="${270 - t}" fill="#${GREEN}"/>
  <!-- avionics box -->
  <rect x="210" y="${420 - t - 190}" width="${330 - t - 12}" height="180" fill="#e4efe8" stroke="#${GREEN}" stroke-width="2" rx="6"/>
  <text x="235" y="${420 - t - 100}" font-size="18" fill="#${GREEN}">Avionics box (1.62 kg)</text>
  <!-- bolts through base flange -->
  ${[170, 300].map((x) => `<rect x="${x}" y="${420 - t - 14}" width="12" height="${t + 40}" fill="#${GOLD}"/>`).join('')}
  ${[220, 330].map((y) => `<rect x="${540 - t - 14}" y="${y}" width="${t + 28}" height="10" fill="#${GOLD}"/>`).join('')}
  <!-- thickness callout -->
  <line x1="600" y1="${420 - t}" x2="700" y2="${420 - t}" stroke="#${INK}" stroke-dasharray="4 4"/>
  <line x1="600" y1="420" x2="700" y2="420" stroke="#${INK}" stroke-dasharray="4 4"/>
  <line x1="690" y1="${420 - t}" x2="690" y2="420" stroke="#${INK}" stroke-width="2"/>
  <text x="705" y="${424 - t / 2}" font-size="22" font-weight="700" fill="#${INK}">t = ${flangeMm.toFixed(1)} mm</text>
  <text x="705" y="${450 - t / 2}" font-size="15" fill="#66706a">mounting flange</text>
  <text x="560" y="140" font-size="15" fill="#66706a">web bolted to avionics box</text>
  <text x="60" y="490" font-size="14" fill="#${GOLD}">■ fasteners</text>
</svg>`;
}

export function vibePlotSvg() {
  // Log-log axes: 20–2000 Hz, 0.001–1 g²/Hz.
  const X = (f) => 90 + ((Math.log10(f) - Math.log10(20)) / 2) * 720;
  const Y = (a) => 440 - ((Math.log10(a) + 3) / 3) * 380;
  const profile = [
    [20, 0.026],
    [50, 0.16],
    [800, 0.16],
    [2000, 0.026],
  ];
  const resp = [];
  for (let f = 20; f <= 2000; f *= 1.04) {
    const r = f / 312;
    const h = 1 / Math.sqrt((1 - r * r) ** 2 + (r / 12) ** 2); // SDOF, Q = 12
    const base = f < 50 ? 0.026 * (f / 20) ** 2 : f < 800 ? 0.16 : 0.16 * (800 / f) ** 2;
    resp.push([f, Math.min(0.9, base * h * h * 0.35)]);
  }
  const path = (pts) => pts.map(([f, a], i) => `${i ? 'L' : 'M'}${X(f).toFixed(1)},${Y(a).toFixed(1)}`).join(' ');
  const grid = [20, 50, 100, 200, 500, 1000, 2000]
    .map((f) => `<line x1="${X(f)}" y1="60" x2="${X(f)}" y2="440" stroke="#e3e6e3"/><text x="${X(f)}" y="462" font-size="13" text-anchor="middle" fill="#66706a">${f}</text>`)
    .join('');
  const ygrid = [0.001, 0.01, 0.1, 1]
    .map((a) => `<line x1="90" y1="${Y(a)}" x2="810" y2="${Y(a)}" stroke="#e3e6e3"/><text x="82" y="${Y(a) + 4}" font-size="13" text-anchor="end" fill="#66706a">${a}</text>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="520" viewBox="0 0 900 520" font-family="Segoe UI, Arial, sans-serif">
  <rect width="900" height="520" fill="#ffffff"/>
  <text x="90" y="40" font-size="22" font-weight="700" fill="#${GREEN}">Protoflight random vibration, Z axis (run 6)</text>
  ${grid}${ygrid}
  <rect x="90" y="60" width="720" height="380" fill="none" stroke="#98a19b"/>
  <path d="${path(profile)}" fill="none" stroke="#${GREEN}" stroke-width="3"/>
  <path d="${path(resp)}" fill="none" stroke="#${GOLD}" stroke-width="2.5"/>
  <line x1="${X(312)}" y1="60" x2="${X(312)}" y2="440" stroke="#${GOLD}" stroke-dasharray="5 5"/>
  <text x="${X(312) + 8}" y="80" font-size="15" fill="#7a5e10">first mode 312 Hz</text>
  <text x="450" y="500" font-size="15" text-anchor="middle" fill="#444">Frequency (Hz)</text>
  <text x="26" y="250" font-size="15" fill="#444" transform="rotate(-90 26 250)" text-anchor="middle">ASD (g²/Hz)</text>
  <rect x="600" y="380" width="14" height="4" fill="#${GREEN}"/><text x="620" y="386" font-size="13" fill="#444">input (10 grms)</text>
  <rect x="600" y="400" width="14" height="4" fill="#${GOLD}"/><text x="620" y="406" font-size="13" fill="#444">box response</text>
</svg>`;
}

/** Renders SVGs to PNG files using the app's Electron (Chromium) as a renderer. */
export async function renderPngs(repo, items) {
  const { _electron: electron } = await import('playwright');
  const userData = join(repo, 'test-output', 'sample-render');
  await mkdir(userData, { recursive: true });
  const app = await electron.launch({ args: [repo], env: { ...process.env, LOCUS_USER_DATA: userData } });
  const win = await app.firstWindow();
  for (const { svg, file } of items) {
    await win.setContent(`<html><body style="margin:0;background:#fff">${svg}</body></html>`);
    await win.locator('svg').screenshot({ path: file });
  }
  await app.close();
}

// ---------- Workbooks ----------

const head = (row) => {
  row.font = { bold: true, color: { argb: 'FF1F5C45' } };
  row.eachCell((c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4EFE8' } };
    c.border = { bottom: { style: 'thin', color: { argb: 'FF98A19B' } } };
  });
};
const title = (ws, text) => {
  ws.getCell('A1').value = text;
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FF1F5C45' } };
};

/** loads.xlsx: version 1 (kickoff) and 2 (after PDR: thicker flange is heavier). */
export async function loadsWorkbook(version) {
  const wb = new ExcelJS.Workbook();
  const bracketKg = version === 1 ? 0.14 : 0.19;

  const mass = wb.addWorksheet('Mass properties', { properties: { tabColor: { argb: 'FF1F5C45' } } });
  mass.columns = [{ width: 26 }, { width: 12 }, { width: 34 }];
  title(mass, 'Mass properties');
  mass.getRow(3).values = ['Item', 'Mass (kg)', 'Note'];
  head(mass.getRow(3));
  const items = [
    ['Avionics box', 1.62, 'Supplier ICD rev C'],
    ['Bracket', bracketKg, version === 1 ? '2.0 mm flange' : '3.0 mm flange (PDR action)'],
    ['Fasteners (8)', 0.02, '#8-32 A286'],
    ['Harness clamp', 0.08, ''],
  ];
  items.forEach((r, i) => {
    mass.getRow(4 + i).values = r;
    mass.getCell(`B${4 + i}`).numFmt = '0.00';
  });
  mass.getCell('A8').value = 'Total';
  mass.getCell('A8').font = { bold: true };
  mass.getCell('B8').value = { formula: 'SUM(B4:B7)', result: items.reduce((s, r) => s + r[1], 0) };
  mass.getCell('B8').numFmt = '0.00';
  mass.getCell('B8').font = { bold: true };
  wb.definedNames.add("'Mass properties'!$A$3:$C$8", 'MassTable');

  const total = items.reduce((s, r) => s + r[1], 0);
  const qs = wb.addWorksheet('Quasi-static', { properties: { tabColor: { argb: 'FFC9A227' } } });
  qs.columns = [{ width: 14 }, { width: 16 }, { width: 18 }, { width: 30 }];
  title(qs, 'Quasi-static limit loads');
  qs.getRow(3).values = ['Axis', 'Load factor (g)', 'Limit force (N)', 'Source'];
  head(qs.getRow(3));
  [
    ['X', 12, 'Launch vehicle user guide, table 4-2'],
    ['Y', 12, 'Launch vehicle user guide, table 4-2'],
    ['Z', 18, 'Launch vehicle user guide, table 4-2'],
  ].forEach(([axis, g, src], i) => {
    const r = 4 + i;
    qs.getRow(r).values = [axis, g, null, src];
    qs.getCell(`C${r}`).value = { formula: `'Mass properties'!B8*9.80665*B${r}`, result: total * 9.80665 * g };
    qs.getCell(`C${r}`).numFmt = '#,##0.0';
  });
  wb.definedNames.add("'Quasi-static'!$A$3:$C$6", 'LimitLoads');

  const rv = wb.addWorksheet('Random vibe');
  rv.columns = [{ width: 16 }, { width: 16 }, { width: 34 }];
  title(rv, 'Protoflight random vibration input');
  rv.getRow(3).values = ['Frequency (Hz)', 'ASD (g²/Hz)', 'Note'];
  head(rv.getRow(3));
  [
    [20, 0.026, '+6 dB/oct'],
    [50, 0.16, ''],
    [800, 0.16, ''],
    [2000, 0.026, '-6 dB/oct'],
  ].forEach((r, i) => {
    rv.getRow(4 + i).values = r;
    rv.getCell(`B${4 + i}`).numFmt = '0.000';
  });
  rv.getCell('A9').value = 'Overall';
  rv.getCell('A9').font = { bold: true };
  rv.getCell('B9').value = 14.1;
  rv.getCell('C9').value = 'grms (protoflight)';
  wb.definedNames.add("'Random vibe'!$A$3:$B$7", 'VibeProfile');
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** margins.xlsx: version 1 (PDR) and 2 (after PDR: thicker flange, fitting factor, separation). */
export async function marginsWorkbook(version) {
  const wb = new ExcelJS.Workbook();
  const f = wb.addWorksheet('Factors', { properties: { tabColor: { argb: 'FF1F5C45' } } });
  f.columns = [{ width: 18 }, { width: 10 }, { width: 46 }];
  title(f, 'Design factors (protoflight)');
  f.getRow(3).values = ['Factor', 'Value', 'Source'];
  head(f.getRow(3));
  const factors = [
    ['Ultimate', 1.4, 'NASA-STD-5001B Table 1'],
    ['Yield', 1.25, 'NASA-STD-5001B Table 1'],
    ...(version === 2
      ? [
          ['Fitting', 1.15, 'NASA-STD-5020B 4.2.2'],
          ['Separation', 1.2, 'NASA-STD-5020B 4.2.3, Figure 1'],
        ]
      : []),
  ];
  factors.forEach((r, i) => (f.getRow(4 + i).values = r));
  wb.definedNames.add(`'Factors'!$A$3:$C$${3 + factors.length}`, 'DesignFactors');

  const m = wb.addWorksheet('Margins', { properties: { tabColor: { argb: 'FFC9A227' } } });
  m.columns = [{ width: 16 }, { width: 22 }, { width: 14 }, { width: 12 }, { width: 10 }, { width: 10 }, { width: 10 }];
  title(m, version === 1 ? 'Margins of safety — PDR (2.0 mm flange)' : 'Margins of safety — CDR (3.0 mm flange)');
  m.getRow(3).values = ['Part', 'Failure mode', 'Allowable', 'Limit', 'Factor', 'MS', 'Status'];
  head(m.getRow(3));
  const rows =
    version === 1
      ? [
          ['Flange', 'Bending, ultimate', 290, 168, 1.4],
          ['Flange', 'Bending, yield', 241, 168, 1.25],
          ['Bolt', 'Tension, ultimate', 5600, 2000, 1.4],
        ]
      : [
          ['Flange', 'Bending, ultimate', 290, 98, 1.4],
          ['Flange', 'Bending, yield', 241, 98, 1.25],
          ['Bolt', 'Tension, ultimate', 5600, 2000, 1.61],
          ['Joint', 'Separation', 3500, 1800, 1.38],
        ];
  rows.forEach((r, i) => {
    const n = 4 + i;
    m.getRow(n).values = r;
    const ms = r[2] / (r[3] * r[4]) - 1;
    m.getCell(`F${n}`).value = { formula: `C${n}/(D${n}*E${n})-1`, result: ms };
    m.getCell(`F${n}`).numFmt = '0.00';
    m.getCell(`G${n}`).value = { formula: `IF(F${n}<0.15,"Low","OK")`, result: ms < 0.15 ? 'Low' : 'OK' };
    if (ms < 0.15) m.getCell(`G${n}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFBF5E2' } };
  });
  wb.definedNames.add(`'Margins'!$A$3:$G$${3 + rows.length}`, 'MarginSummary');
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------- Decks ----------

function deckBase() {
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_16x9';
  return pptx;
}

function titleSlide(pptx, heading, sub) {
  const s = pptx.addSlide();
  s.background = { color: GREEN };
  s.addText(heading, { x: 0.6, y: 1.8, w: 8.8, h: 1, fontSize: 34, bold: true, color: 'FFFFFF' });
  s.addText(sub, { x: 0.6, y: 2.9, w: 8.8, h: 0.6, fontSize: 18, color: 'E4EFE8' });
}

function contentSlide(pptx, heading) {
  const s = pptx.addSlide();
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 10, h: 0.12, fill: { color: GOLD } });
  s.addText(heading, { x: 0.5, y: 0.3, w: 9, h: 0.7, fontSize: 26, bold: true, color: GREEN });
  return s;
}

const bullets = (s, lines, opts = {}) =>
  s.addText(
    lines.map((t) => ({ text: t, options: { bullet: true } })),
    { x: 0.5, y: 1.2, w: opts.w ?? 9, h: opts.h ?? 3.6, fontSize: 18, color: INK, valign: 'top', paraSpaceAfter: 8 },
  );

const table = (s, rows, opts = {}) =>
  s.addTable(
    rows.map((r, i) => r.map((c) => ({ text: String(c), options: i === 0 ? { bold: true, fill: { color: 'E4EFE8' }, color: GREEN } : {} }))),
    { x: 0.5, y: opts.y ?? 1.3, w: opts.w ?? 9, fontSize: 15, border: { type: 'solid', pt: 1, color: 'C5CCC4' } },
  );

export async function pdrDeck(file, conceptPng) {
  const pptx = deckBase();
  titleSlide(pptx, 'Aurora-3 Avionics Bracket — PDR', 'Preliminary design review · February 3, 2026');
  let s = contentSlide(pptx, 'Configuration');
  bullets(s, ['6061-T6 aluminium L-bracket', 'Mounting flange 2.0 mm thick', '4 × #8-32 A286 fasteners to deck', 'Avionics box 1.62 kg'], { w: 4.2 });
  s.addImage({ path: conceptPng, x: 4.8, y: 1.2, w: 4.9, h: 2.83 });
  s = contentSlide(pptx, 'Requirements: factors of safety');
  table(s, [['Factor', 'Value', 'Source'], ['Ultimate design', '1.4', 'NASA-STD-5001B Table 1'], ['Yield design', '1.25', 'NASA-STD-5001B Table 1'], ['Qualification test', '1.2', 'Protoflight approach']]);
  s = contentSlide(pptx, 'Quasi-static loads');
  table(s, [['Axis', 'Load factor', 'Limit force'], ['X', '12 g', '219 N'], ['Y', '12 g', '219 N'], ['Z', '18 g', '328 N']]);
  s = contentSlide(pptx, 'Margins of safety');
  table(s, [['Part', 'Mode', 'MS', 'Status'], ['Flange', 'Bending, ultimate', '0.23', 'OK'], ['Flange', 'Bending, yield', '0.15', 'Low'], ['Bolt', 'Tension, ultimate', '1.00', 'OK']]);
  s.addText('Flange yield margin is below the 0.15 project threshold → action PDR-1', { x: 0.5, y: 3.6, w: 9, h: 0.5, fontSize: 16, color: '7A5E10', bold: true });
  s = contentSlide(pptx, 'Open items');
  bullets(s, ['PDR-1: increase flange thickness or change material', 'PDR-2: apply fitting factor to fastener analysis (NASA-STD-5020B)', 'PDR-3: plan protoflight vibration test']);
  await pptx.writeFile({ fileName: file });
}

export async function cdrDeck(file, conceptPng, plotPng) {
  const pptx = deckBase();
  titleSlide(pptx, 'Aurora-3 Avionics Bracket — CDR', 'Critical design review · April 14, 2026');
  let s = contentSlide(pptx, 'Changes since PDR');
  bullets(s, ['PDR-1 closed: flange 2.0 → 3.0 mm', 'PDR-2 closed: fitting factor 1.15 applied to bolts', 'Separation check added for the connector-side joint', 'Factors now come from config/factors.yaml']);
  s = contentSlide(pptx, 'Configuration');
  bullets(s, ['6061-T6 aluminium L-bracket', 'Mounting flange 3.0 mm thick', '4 × #8-32 A286 fasteners to deck', 'Bracket mass 0.19 kg (+0.05 kg)'], { w: 4.2 });
  s.addImage({ path: conceptPng, x: 4.8, y: 1.2, w: 4.9, h: 2.83 });
  s = contentSlide(pptx, 'Requirements: factors of safety');
  table(s, [['Factor', 'Value', 'Source'], ['Ultimate design', '1.4', 'NASA-STD-5001B Table 1'], ['Yield design', '1.25', 'NASA-STD-5001B Table 1'], ['Fitting', '1.15', 'NASA-STD-5020B 4.2.2'], ['Separation', '1.2', 'NASA-STD-5020B Figure 1']]);
  s = contentSlide(pptx, 'Quasi-static loads');
  table(s, [['Axis', 'Load factor', 'Limit force'], ['X', '12 g', '225 N'], ['Y', '12 g', '225 N'], ['Z', '18 g', '337 N']]);
  s = contentSlide(pptx, 'Margins of safety');
  table(s, [['Part', 'Mode', 'MS', 'Status'], ['Flange', 'Bending, ultimate', '1.11', 'OK'], ['Flange', 'Bending, yield', '0.97', 'OK'], ['Bolt', 'Tension, ultimate (×1.15)', '0.74', 'OK'], ['Joint', 'Separation', '0.41', 'OK']]);
  s = contentSlide(pptx, 'Protoflight vibration test');
  s.addImage({ path: plotPng, x: 0.5, y: 1.1, w: 5.4, h: 3.12 });
  s.addText(
    [
      { text: 'All 7 runs passed', options: { bullet: true } },
      { text: 'First mode 312 Hz (Z)', options: { bullet: true } },
      { text: 'Post-test frequency shift < 5%', options: { bullet: true } },
    ],
    { x: 6.1, y: 1.3, w: 3.6, h: 2.5, fontSize: 16, color: INK, valign: 'top' },
  );
  s = contentSlide(pptx, 'Open items');
  bullets(s, ['CDR-1: confirm separation factor for the connector-side joint', 'CDR-2: update harness clamp mass after routing review']);
  await pptx.writeFile({ fileName: file });
}

// ---------- Audio ----------

/** Speaks each segment with Windows text-to-speech, joins them, and returns segment start times. */
export async function meetingAudio(file, tmp) {
  await mkdir(tmp, { recursive: true });
  const parts = [];
  meetingSegments.forEach((text, i) => parts.push({ text, wav: join(tmp, `seg${i}.wav`) }));
  const ps = `Add-Type -AssemblyName System.Speech
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo 16000, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = -1
${parts.map((p) => `$s.SetOutputToWaveFile('${p.wav.replace(/'/g, "''")}', $fmt); $s.Speak('${p.text.replace(/'/g, "''")}')`).join('\n')}
$s.Dispose()`;
  const script = join(tmp, 'speak.ps1');
  await writeFile(script, ps, 'utf8');
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: 'ignore' });

  const rate = 16000 * 2;
  const gap = Buffer.alloc(Math.round(rate * 0.7));
  const chunks = [];
  const starts = [];
  let t = 0;
  for (const p of parts) {
    const buf = await readFile(p.wav);
    const at = buf.indexOf(Buffer.from('data'));
    const data = buf.subarray(at + 8, at + 8 + buf.readUInt32LE(at + 4));
    starts.push(Math.floor(t));
    chunks.push(data, gap);
    t += (data.length + gap.length) / rate;
  }
  const pcm = Buffer.concat(chunks);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(rate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  await writeFile(file, Buffer.concat([header, pcm]));
  await rm(tmp, { recursive: true, force: true });
  return starts;
}
