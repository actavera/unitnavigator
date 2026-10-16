'use strict';
// CSV cell writers for exports.
//
// Spreadsheet programs run a cell as a formula when its text starts with
// = + - @ (or a tab, carriage return, or newline), even after leading
// whitespace. Exports carry user-controlled text (names, emails, notes, stock
// numbers, ...), so such a cell is prefixed with an apostrophe: it is shown as
// text and its content stays readable. Real numbers are exempt, so a
// legitimate negative amount is not altered.

function startsLikeFormula(text) {
  return /^[\t\r\n]/.test(text) || /^\s*[=+\-@]/.test(text);
}

// Neutralization only (no quoting), for callers that format cells themselves.
function safeText(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const text = Array.isArray(value) ? value.join('\n') : String(value ?? '');
  return startsLikeFormula(text) ? `'${text}` : text;
}

// An international phone number legitimately starts with "+". It is kept
// unchanged only when the WHOLE value is a "+", a digit, and then nothing but
// digits, spaces, parentheses, dots and hyphens. That set has no letters and
// none of | ! = @ , so it cannot call a function or run a command; anything
// else, including "+SUM(1,2)", "+cmd|...", or "+1+1", is neutralized like any
// other text.
const INTERNATIONAL_PHONE = /^\+[0-9][0-9 ().-]{5,24}$/;

function safePhone(value) {
  const text = String(value ?? '');
  return INTERNATIONAL_PHONE.test(text) ? text : safeText(text);
}

// Neutralizes, then quotes only when the cell needs it, with embedded quotes doubled.
function csvCell(value) {
  const text = safeText(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

module.exports = { csvCell, safeText, safePhone };
