'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { listingWarnings } = require('../services/listingQuality');

const COMPLETE = { year: 2020, make: 'Honda', model: 'Accord', asking_price: 15995, mileage: 41000, photos: '["/uploads/units/a.jpg"]' };
const fields = unit => listingWarnings(unit).map(w => w.field);

test('a complete listing has no warnings', () => {
  assert.deepEqual(listingWarnings(COMPLETE), []);
});

test('each of price, mileage, photos, year, make and model is flagged when missing', () => {
  assert.deepEqual(fields({ ...COMPLETE, asking_price: null }), ['asking_price']);
  assert.deepEqual(fields({ ...COMPLETE, mileage: null }), ['mileage']);
  assert.deepEqual(fields({ ...COMPLETE, photos: '[]' }), ['photos']);
  assert.deepEqual(fields({ ...COMPLETE, year: null }), ['year']);
  assert.deepEqual(fields({ ...COMPLETE, make: '' }), ['make']);
  assert.deepEqual(fields({ ...COMPLETE, model: '   ' }), ['model']);
});

test('zero, blank, and non-numeric values count as missing for price and mileage', () => {
  assert.deepEqual(fields({ ...COMPLETE, asking_price: 0, mileage: 0 }).sort(), ['asking_price', 'mileage']);
  assert.deepEqual(fields({ ...COMPLETE, asking_price: '', mileage: 'n/a' }).sort(), ['asking_price', 'mileage']);
});

test('photos accepts an array, a JSON string, and tolerates garbage', () => {
  assert.deepEqual(fields({ ...COMPLETE, photos: ['/a.jpg'] }), []);
  assert.deepEqual(fields({ ...COMPLETE, photos: 'not json' }), ['photos']);
  assert.deepEqual(fields({ ...COMPLETE, photos: undefined }), ['photos']);
});

test('an empty unit reports every gap, in a stable order, each with a label and message', () => {
  const warnings = listingWarnings({});
  assert.deepEqual(warnings.map(w => w.field), ['year', 'make', 'model', 'asking_price', 'mileage', 'photos']);
  for (const w of warnings) {
    assert.ok(w.label && w.message, `${w.field} needs a label and message`);
  }
});
