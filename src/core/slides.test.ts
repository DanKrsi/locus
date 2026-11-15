import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findSlide, showFallbacks } from './slides.ts';

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
