// A Word document for the tests, built without Word: headings, a footnote, a list, a table, a
// picture, a link, a page break and enough text for several pages. Version 2 adds a paragraph near
// the top (so every paragraph after it is numbered one higher) and rewords one sentence.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  Document,
  ExternalHyperlink,
  FootnoteReferenceRun,
  HeadingLevel,
  ImageRun,
  PageBreak,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
} from 'docx';

const repo = join(import.meta.dirname, '..');

export const MEMO = {
  load: 'design load of 12 kN',
  fatigue: 'Fatigue was checked at two million cycles and passed with margin.',
  fatigueV2: 'Fatigue was checked at ten million cycles and passed with margin.',
  added: 'Revision B adds the fatigue check to the summary.',
};

const filler = (n) =>
  `Paragraph ${n} of the background. The bracket sits between the panel and the frame, and its bolts take the load in shear. ` +
  'Each case was run with the same mesh and the same material data, so the results can be compared directly.';

export async function memo(version = 1) {
  const icon = await readFile(join(repo, 'build', 'icon.png'));
  const body = [
    new Paragraph({ text: 'Bracket design memo', heading: HeadingLevel.TITLE }),
    new Paragraph({ text: 'Summary', heading: HeadingLevel.HEADING_1 }),
    ...(version >= 2 ? [new Paragraph(MEMO.added)] : []),
    new Paragraph({
      children: [new TextRun('The bracket carries a '), new TextRun({ text: MEMO.load, bold: true }), new TextRun(' with a safety factor of 1.5.'), new FootnoteReferenceRun(1)],
    }),
    new Paragraph(''),
    new Paragraph({ text: 'Bolts are checked in shear and bearing.', bullet: { level: 0 } }),
    new Paragraph({ text: 'The flange is checked in bending.', bullet: { level: 0 } }),
    new Table({
      rows: [
        new TableRow({ children: [new TableCell({ children: [new Paragraph('Case')] }), new TableCell({ children: [new Paragraph('Load (kN)')] })] }),
        new TableRow({ children: [new TableCell({ children: [new Paragraph('Static')] }), new TableCell({ children: [new Paragraph('12')] })] }),
        new TableRow({ children: [new TableCell({ children: [new Paragraph('Landing')] }), new TableCell({ children: [new Paragraph('18')] })] }),
      ],
    }),
    new Paragraph({ children: [new ImageRun({ type: 'png', data: icon, transformation: { width: 96, height: 96 } })] }),
    new Paragraph({ children: [new TextRun('The standard is online at '), new ExternalHyperlink({ link: 'https://example.com/bds-100', children: [new TextRun({ text: 'example.com', style: 'Hyperlink' })] }), new TextRun('.')] }),
    new Paragraph({ children: [new PageBreak()] }),
    new Paragraph({ text: 'Background', heading: HeadingLevel.HEADING_1 }),
    ...Array.from({ length: 14 }, (_, i) => new Paragraph(filler(i + 1))),
    new Paragraph({ text: 'Details', heading: HeadingLevel.HEADING_1 }),
    new Paragraph(version >= 2 ? MEMO.fatigueV2 : MEMO.fatigue),
    new Paragraph('The end.'),
  ];
  const doc = new Document({
    creator: 'Locus tests',
    footnotes: { 1: { children: [new Paragraph('Taken from the load table.')] } },
    sections: [{ children: body }],
  });
  return Packer.toBuffer(doc);
}
