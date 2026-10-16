'use strict';
// Page-level smoke checks for the import page and the new history page: valid
// scripts, escaped output, and the retry/redirect behavior that matters.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = file => fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
const importPage = read('inventory-import.html');
const historyPage = read('import-history.html');
const scripts = html => [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]).filter(c => c.trim());

function body(source, name) {
  const start = source.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  assert.ok(start >= 0, `function ${name} must exist`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(open, i + 1); }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

test('both pages are well formed and every inline script parses', () => {
  for (const [name, html] of [['inventory-import.html', importPage], ['import-history.html', historyPage]]) {
    assert.match(html, /<!DOCTYPE html>/i, name);
    assert.equal((html.match(/<\/body>/gi) || []).length, 1, name);
    assert.ok(scripts(html).length >= 1, name);
    for (const code of scripts(html)) assert.doesNotThrow(() => new Function(code), name);
  }
});

test('import page: results with issues stay on screen with errors, retry, report, and history; clean imports still redirect', () => {
  const handler = body(importPage, 'handleImportResult');
  assert.match(handler, /if \(!issues\.length && !result\.skipped\)/, 'only a fully clean import redirects');
  assert.match(handler, /location\.href = '\/inventory'/);
  assert.match(handler, /renderRetryPanel\(\)/);
  assert.ok(importPage.includes('href="/inventory/import/history"'));
  assert.ok(importPage.includes('downloadIssueReport'));
});

test('import page: retry resubmits only the skipped rows, linked to the original batch', () => {
  const retry = body(importPage, 'retrySkippedRows');
  assert.match(retry, /retryDrafts\.map\(draft => draft\.row\)/);
  assert.match(retry, /body\.retry_of = lastBatch\.id/);
  assert.match(retry, /'\/api\/inventory\/import'/);
  const panel = body(importPage, 'renderRetryPanel');
  assert.match(panel, /issue\.severity === 'error'/, 'warnings are not offered for retry');
});

test('import page: every value interpolated into the result and retry markup is escaped or numeric', () => {
  for (const name of ['handleImportResult', 'renderRetryPanel']) {
    for (const line of body(importPage, name).split('\n').filter(l => l.includes('${'))) {
      for (const expr of line.match(/\$\{[^}]+\}/g) || []) {
        const safe = /escapeHtml\(|Number\(|\.length|\.map\(|\.join\(|\.severity|data-|index|i\b|issues\.length|result\.batch_id|field\.replace|draft\.rowNumber|\?\s*'|:\s*'|`/.test(expr);
        assert.ok(safe, `unescaped interpolation: ${expr} in ${name}`);
      }
    }
  }
});

test('history page: read-only, gated on inventory_import, and escapes everything it renders', () => {
  assert.match(historyPage, /UN\.can\('inventory_import'\)/);
  assert.ok(!/'(?:POST|PUT|PATCH|DELETE)'/.test(historyPage), 'the history page performs no writes');
  assert.match(historyPage, /\/api\/inventory\/import\/batches/);
  for (const name of ['loadBatches', 'openBatch']) {
    for (const expr of (body(historyPage, name).match(/\$\{[^}]+\}/g) || [])) {
      const safe = /esc\(|Number\(|statusPill\(|kindLabel\(|\.map\(|\.join\(|issues\.length|issue\.severity|batch\.retry_of|batch\.issues_truncated|batch\.failure_message|batch\.file_name|batch\.imported_by|batch\.id|batches\./.test(expr);
      assert.ok(safe, `unescaped interpolation: ${expr} in ${name}`);
    }
  }
});

test('import page: the DealerCenter feed flow also stays put when there are issues to review', () => {
  const feed = body(importPage, 'importDealerCenterSftp');
  assert.match(feed, /if \(!\(result\.issues \|\| \[\]\)\.length && !result\.skipped\)/);
  assert.match(feed, /location\.href = '\/inventory'/);
});
