import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findSlide } from './slides.ts';

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
