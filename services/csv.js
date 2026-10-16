'use strict';
// CSV cell writer for exports.
//
// Spreadsheet programs run a cell as a formula when its text starts with
// = + - @ (or a tab, carriage return, or newline), even after leading
// whitespace. Exports carry user-controlled text (makes, models, notes, stock
// numbers), so such a cell is prefixed with an apostrophe: it is shown as text
// and its content stays readable. Real numbers are exempt, so a legitimate
// negative amount is not altered. Cells that need it are quoted, with embedded
// quotes doubled.

function csvCell(value) {
  const isNumber = typeof value === 'number' && Number.isFinite(value);
  let text = Array.isArray(value) ? value.join('\n') : String(value ?? '');
  if (!isNumber && (/^[\t\r\n]/.test(text) || /^\s*[=+\-@]/.test(text))) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

module.exports = { csvCell };
