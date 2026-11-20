// Files for the embedded-view tests: a slide deck with a picture, a chart and a table, and a
// workbook with merged cells, formulas, a long column and a second sheet. Small and made fresh, so
// a test can rewrite them on disk and watch the embeds follow.
import ExcelJS from 'exceljs';
import pptxgen from 'pptxgenjs';
import { crc32, deflateSync } from 'node:zlib';

/** A solid-colour PNG, w x h. */
export function png(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG_RED = png(64, 64, [220, 30, 30]).toString('base64');

/** A deck: 1 title, 2 a red square and words, 3 a bar chart, 4 a table. `variant` changes the words and the chart. */
export async function deck(variant = 1) {
  const p = new pptxgen();
  p.layout = 'LAYOUT_16x9';
  let s = p.addSlide();
  s.addText(variant === 1 ? 'Embed test deck' : 'Embed test deck (edited)', { x: 0.5, y: 2, w: 9, h: 1, fontSize: 36, bold: true, color: '1F2328' });
  s = p.addSlide();
  s.addText(variant === 1 ? 'Red square on the right' : 'Blue words, square moved', { x: 0.4, y: 0.3, w: 5, h: 0.8, fontSize: 24, color: variant === 1 ? '1F2328' : '1F4FC9' });
  s.addImage({ data: `image/png;base64,${PNG_RED}`, x: variant === 1 ? 6 : 1, y: 1.5, w: 3, h: 3 });
  s = p.addSlide();
  s.addText('Loads by axis', { x: 0.4, y: 0.2, w: 6, h: 0.6, fontSize: 22 });
  s.addChart(p.ChartType.bar, [{ name: 'Load', labels: ['X', 'Y', 'Z'], values: variant === 1 ? [12, 12, 18] : [5, 20, 30] }], { x: 0.5, y: 1, w: 8, h: 4 });
  s = p.addSlide();
  s.addTable(
    [
      [{ text: 'Part' }, { text: 'MS' }],
      [{ text: 'Flange' }, { text: variant === 1 ? '0.23' : '0.31' }],
      [{ text: 'Bolt' }, { text: '1.00' }],
    ],
    { x: 1, y: 1, w: 6, fontSize: 18, border: { type: 'solid', color: '888888', pt: 1 } },
  );
  return Buffer.from(await p.write({ outputType: 'nodebuffer' }));
}

/** A workbook: "Loads" with a header, numbers, a formula and a merged title; "Long" with 400 rows. */
export async function workbook(variant = 1) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Loads');
  ws.mergeCells('A1:C1');
  ws.getCell('A1').value = 'Quasi-static loads';
  ws.getCell('A1').font = { bold: true };
  ws.getRow(2).values = ['Axis', 'g', 'Force N'];
  ws.getRow(2).font = { bold: true };
  const g = variant === 1 ? [12, 12, 18] : [14, 12, 25];
  ['X', 'Y', 'Z'].forEach((axis, i) => {
    const r = 3 + i;
    ws.getCell(`A${r}`).value = axis;
    ws.getCell(`B${r}`).value = g[i];
    ws.getCell(`C${r}`).value = { formula: `B${r}*18.2`, result: Math.round(g[i] * 18.2 * 10) / 10 };
  });
  ws.getCell('A6').value = 'Total';
  ws.getCell('C6').value = { formula: 'SUM(C3:C5)', result: Math.round(g.reduce((a, b) => a + b, 0) * 18.2 * 10) / 10 };
  ws.getCell('C6').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
  ws.getColumn(1).width = 14;
  const long = wb.addWorksheet('Long sheet');
  for (let r = 1; r <= 400; r++) long.getRow(r).values = [r, `row ${r}`, r * 2];
  wb.definedNames.add("'Loads'!$A$2:$C$5", 'LoadTable');
  return Buffer.from(await wb.xlsx.writeBuffer());
}
