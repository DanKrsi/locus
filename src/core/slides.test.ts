import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import JSZip from 'jszip';
import { findShape, findSlide, readDeck, showFallbacks } from './slides.ts';

const deck = ['Title slide', 'Margins of safety\nUltimate 1.4', 'Open items\nCheck the cap', 'Margins of safety again'];

test('a quote is found on the slide it was cited from', () => {
  assert.equal(findSlide(deck, 'Ultimate 1.4', 2), 2);
});

test('a quote that moved to another slide is found there', () => {
  assert.equal(findSlide(deck, 'Check the cap', 2), 3);
});

test('the nearest slide wins when the words appear twice', () => {
  assert.equal(findSlide(deck, 'Margins of safety', 4), 4);
  assert.equal(findSlide(deck, 'Margins of safety', 1), 2);
});

test('line breaks, case and punctuation do not decide a match', () => {
  assert.equal(findSlide(deck, 'margins  of\nsafety:', 2), 2);
});

test('words that are gone give nothing rather than a guess', () => {
  assert.equal(findSlide(deck, 'a passage nobody wrote', 1), null);
});

test('an equation with a picture to fall back on keeps the picture', () => {
  const xml =
    '<p:spTree><mc:AlternateContent xmlns:mc="x"><mc:Choice Requires="a14"><p:sp>math</p:sp></mc:Choice>' +
    '<mc:Fallback><p:pic>picture of the equation</p:pic></mc:Fallback></mc:AlternateContent></p:spTree>';
  const out = showFallbacks(xml);
  assert.equal(out.includes('picture of the equation'), true);
  assert.equal(out.includes('AlternateContent'), false);
  assert.equal(out.includes('<p:sp>math</p:sp>'), false);
});

test('an equation with no picture leaves its characters behind, as a run in its paragraph', () => {
  const xml =
    '<p:txBody><a:p><a:r><a:t>Margin: </a:t></a:r>' +
    '<mc:AlternateContent><mc:Choice><m:oMath><m:r><m:t>MS = 1.4</m:t></m:r></m:oMath></mc:Choice></mc:AlternateContent>' +
    '</a:p></p:txBody>';
  const out = showFallbacks(xml);
  assert.equal(out, '<p:txBody><a:p><a:r><a:t>Margin: </a:t></a:r><a:r><a:t>MS = 1.4</a:t></a:r></a:p></p:txBody>');
});

test('a slide with nothing modern in it is left alone', () => {
  const xml = '<p:spTree><p:sp><a:t>Plain</a:t></p:sp></p:spTree>';
  assert.equal(showFallbacks(xml), xml);
});

test('two equations on one slide are both replaced', () => {
  const one = '<mc:AlternateContent><mc:Fallback><p:pic>A</p:pic></mc:Fallback></mc:AlternateContent>';
  const two = '<mc:AlternateContent><mc:Fallback><p:pic>B</p:pic></mc:Fallback></mc:AlternateContent>';
  const out = showFallbacks(`<p:spTree>${one}<p:sp/>${two}</p:spTree>`);
  assert.equal(out, '<p:spTree><p:pic>A</p:pic><p:sp/><p:pic>B</p:pic></p:spTree>');
});

// ---------- Reading a deck: text, speaker notes, where the text sits ----------

const sp = (text: string, xfrm = '', ph = '') =>
  `<p:sp><p:nvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${xfrm}</p:spPr><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
const at = (x: number, y: number, cx: number, cy: number) => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
const rel = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="http://x/${type}" Target="${target}"/>`;

async function testDeck() {
  const zip = new JSZip();
  // A 4:3 slide (9144000 x 6858000 EMU), so the conversion to 960 x 540 is not the identity.
  zip.file('ppt/presentation.xml', '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>');
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships>${rel('rId2', 'slide', 'slides/slide1.xml')}</Relationships>`);
  zip.file(
    'ppt/slides/slide1.xml',
    `<p:sld><p:cSld><p:spTree>${sp('Rents rose', '', '<p:ph type="title"/>')}${sp('Vacancy fell to a three year low', at(914400, 3429000, 4572000, 685800))}</p:spTree></p:cSld></p:sld>`,
  );
  zip.file('ppt/slides/_rels/slide1.xml.rels', `<Relationships>${rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml')}${rel('rId3', 'notesSlide', '../notesSlides/notesSlide1.xml')}</Relationships>`);
  // The title takes its place from the layout (a centred title there).
  zip.file('ppt/slideLayouts/slideLayout1.xml', `<p:sldLayout><p:cSld><p:spTree>${sp('', at(0, 0, 9144000, 1371600), '<p:ph type="ctrTitle"/>')}</p:spTree></p:cSld></p:sldLayout>`);
  zip.file('ppt/notesSlides/notesSlide1.xml', `<p:notes><p:cSld><p:spTree>${sp('', '', '<p:ph type="sldImg"/>')}${sp('Say the survey covered 1,200 units.', '', '<p:ph type="body" idx="1"/>')}${sp('1', '', '<p:ph type="sldNum"/>')}</p:spTree></p:cSld></p:notes>`);
  return zip.generateAsync({ type: 'uint8array' });
}

test('a deck is read with its speaker notes and where each text sits, in points of a 960 x 540 slide', async () => {
  const [slide] = await readDeck(await testDeck());
  assert.equal(slide.text, 'Rents rose\nVacancy fell to a three year low');
  assert.equal(slide.notes, 'Say the survey covered 1,200 units.');
  const words = slide.shapes.find((s) => s.text.startsWith('Vacancy'));
  assert.deepEqual(words?.box, { x: 96, y: 270, w: 480, h: 54 });
  // A placeholder with no place of its own sits where its layout puts it.
  assert.deepEqual(slide.shapes.find((s) => s.text === 'Rents rose')?.box, { x: 0, y: 0, w: 960, h: 108 });
});

test('the box for a quote is the smallest text box holding it', async () => {
  const [slide] = await readDeck(await testDeck());
  assert.deepEqual(findShape(slide, 'three-year low')?.box, { x: 96, y: 270, w: 480, h: 54 });
  assert.equal(findShape(slide, 'not on the slide'), null);
  assert.equal(findShape(slide, '1,200 units'), null, 'speaker notes are not on the slide');
});
test('text in a group of shapes gets no box (its place is in the group, not on the slide)', async () => {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>');
  zip.file('ppt/_rels/presentation.xml.rels', `<Relationships>${rel('rId2', 'slide', 'slides/slide1.xml')}</Relationships>`);
  zip.file('ppt/slides/slide1.xml', `<p:sld><p:cSld><p:spTree><p:grpSp><p:grpSpPr/>${sp('In a group', at(0, 0, 100, 100))}</p:grpSp>${sp('On its own', at(0, 0, 12192000, 6858000))}</p:spTree></p:cSld></p:sld>`);
  const [slide] = await readDeck(await zip.generateAsync({ type: 'uint8array' }));
  assert.equal(slide.shapes.find((s) => s.text === 'In a group')?.box, undefined);
  assert.deepEqual(slide.shapes.find((s) => s.text === 'On its own')?.box, { x: 0, y: 0, w: 960, h: 540 });
  assert.equal(findShape(slide, 'In a group'), null);
});