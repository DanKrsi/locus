import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { alignParagraphs, findParagraphs, headingStyles, quoteIn, wordNotes, wordParagraphs } from './word.ts';

const styles =
  '<w:styles>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="MyHeading"><w:name w:val="My heading"/><w:basedOn w:val="berschrift1"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
  '<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/></w:style>' +
  '</w:styles>';

const p = (inner: string, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${inner}</w:p>`;
const r = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const doc = (body: string) => `<w:document><w:body>${body}<w:sectPr/></w:body></w:document>`;

test('heading styles are found by name, outline level, or the style they are based on', () => {
  const h = headingStyles(styles);
  assert.equal(h.get('Title'), 1);
  assert.equal(h.get('berschrift1'), 1);
  assert.equal(h.get('MyHeading'), 1);
  assert.equal(h.has('Normal'), false);
  assert.equal(h.has('Strong'), false);
});

test('paragraphs are numbered in order, runs joined, headings and tables marked', () => {
  const xml = doc(
    p(r('Bracket memo'), '<w:pStyle w:val="Title"/>') +
      p(r('The bracket carries a ') + r('design load of 12 kN') + r('.')) +
      `<w:tbl><w:tr><w:tc>${p(r('Case'))}</w:tc><w:tc>${p(r('Load'))}</w:tc></w:tr></w:tbl>` +
      '<w:p/>' +
      p(r('Item'), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
  );
  const paras = wordParagraphs(xml, styles);
  assert.deepEqual(
    paras.map((x) => [x.n, x.text, x.heading ?? 0, !!x.table, !!x.list]),
    [
      [1, 'Bracket memo', 1, false, false],
      [2, 'The bracket carries a design load of 12 kN.', 0, false, false],
      [3, 'Case', 0, true, false],
      [4, 'Load', 0, true, false],
      [5, '', 0, false, false],
      [6, 'Item', 0, false, true],
    ],
  );
});

test('tab stops in settings are not tabs; tabs, breaks and entities in text are', () => {
  const xml = doc(p(`<w:r><w:t>A</w:t><w:tab/><w:t>B &amp; C</w:t><w:br/><w:t>D&#x2013;E</w:t></w:r>`, '<w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs>'));
  assert.equal(wordParagraphs(xml)[0].text, 'A\tB & C\nD–E');
});

test('deleted text, field codes and a drawing’s old copy are not read', () => {
  const xml = doc(
    p(
      r('Kept ') +
        '<w:del><w:r><w:delText>gone </w:delText></w:r></w:del>' +
        '<w:r><w:instrText> PAGE </w:instrText></w:r>' +
        '<mc:AlternateContent><mc:Choice><w:drawing><w:txbxContent>' + p(r('In a box')) + '</w:txbxContent></w:drawing></mc:Choice>' +
        '<mc:Fallback><w:pict><w:txbxContent>' + p(r('In a box')) + '</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent>',
    ),
  );
  const paras = wordParagraphs(xml);
  // The box's paragraph sits inside the one holding it, and comes right after it.
  assert.deepEqual(paras.map((x) => x.text), ['Kept ', 'In a box']);
});

test('footnotes are read without their separators', () => {
  const xml =
    '<w:footnotes><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>' +
    `<w:footnote w:id="1">${p(r('A note.'))}</w:footnote></w:footnotes>`;
  assert.deepEqual(wordNotes(xml), ['A note.']);
});

const paras = ['Summary', 'The bracket carries a design load of 12 kN.', 'It was checked.', 'Summary', 'Details follow.'].map((text) => ({ text }));

test('a quote is found in its paragraph, across paragraphs, and nearest where it was cited', () => {
  assert.deepEqual(findParagraphs(paras, 'design load of 12 kN'), { start: 2, end: 2 });
  assert.deepEqual(findParagraphs(paras, '12 kN. It was'), { start: 2, end: 3 });
  assert.deepEqual(findParagraphs(paras, 'summary', 5), { start: 4, end: 4 });
  assert.deepEqual(findParagraphs(paras, 'summary', 1), { start: 1, end: 1 });
  assert.equal(findParagraphs(paras, 'words nobody wrote'), null);
  assert.equal(findParagraphs(paras, '  '), null);
});

test('quoteIn checks a range', () => {
  assert.equal(quoteIn(paras, { start: 2, end: 3 }, 'kN. It was'), true);
  assert.equal(quoteIn(paras, { start: 3, end: 3 }, 'design load'), false);
});

test('drawn paragraphs line up one to one', () => {
  assert.deepEqual(alignParagraphs(['A b', '', 'C'], ['A b', '', 'C']), [[0], [1], [2]]);
});

test('a paragraph split where a page breaks gets both pieces', () => {
  assert.deepEqual(alignParagraphs(['One', 'Two long paragraph', 'Three'], ['One', 'Two long', 'paragraph', 'Three']), [[0], [1, 2], [3]]);
});

test('a footnote number after the text still matches', () => {
  assert.deepEqual(alignParagraphs(['Safety factor 1.5.', 'Next'], ['Safety factor 1.5.1', 'Next']), [[0], [1]]);
});

test('an empty paragraph the drawing left out takes no element', () => {
  assert.deepEqual(alignParagraphs(['A', '', 'B'], ['A', 'B']), [[0], [], [1]]);
});

test('something drawn that the file has no paragraph for is skipped', () => {
  assert.deepEqual(alignParagraphs(['A', 'B'], ['A', 'extra', 'B']), [[0], [2]]);
});
