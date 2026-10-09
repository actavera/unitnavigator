'use strict';
// Non-blocking completeness check for a listing. Warnings only — a unit with
// gaps can still be sent for suggestions; the dealer just sees what's missing.

function filled(value) {
  return String(value ?? '').trim() !== '';
}

function positive(value) {
  const n = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && n > 0;
}

function hasPhotos(photos) {
  if (Array.isArray(photos)) return photos.length > 0;
  try {
    const parsed = JSON.parse(photos || '[]');
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

function listingWarnings(unit) {
  const warnings = [];
  const add = (field, label, message) => warnings.push({ field, label, message });
  if (!positive(unit.year)) add('year', 'Year', 'No year set.');
  if (!filled(unit.make)) add('make', 'Make', 'No make set.');
  if (!filled(unit.model)) add('model', 'Model', 'No model set.');
  if (!positive(unit.asking_price)) add('asking_price', 'Price', 'No asking price set.');
  if (!positive(unit.mileage)) add('mileage', 'Mileage', 'No mileage set.');
  if (!hasPhotos(unit.photos)) add('photos', 'Photos', 'No photos added.');
  return warnings;
}

module.exports = { listingWarnings };
