'use strict';
// Page-level smoke checks for the inventory page's Listing Suite UI and the
// two single-vehicle pages it must not disturb. No browser is available in
// the test environment, so these assert syntax and the properties that matter
// for safety (escaping, explicit save, selection cap) directly on the source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = file => fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8');
const inventory = read('inventory.html');

function inlineScripts(html) {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]).filter(code => code.trim());
}

function functionBody(source, name) {
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

test('inventory.html: well-formed and every inline script is syntactically valid', () => {
  assert.match(inventory, /<!DOCTYPE html>/i);
  assert.equal((inventory.match(/<body[\s>]/gi) || []).length, 1);
  assert.equal((inventory.match(/<\/body>/gi) || []).length, 1);
  const scripts = inlineScripts(inventory);
  assert.ok(scripts.length >= 1);
  for (const code of scripts) assert.doesNotThrow(() => new Function(code));
});

test('the selection bar, modal and controls exist, and selection is capped at 10 on the client too', () => {
  for (const id of ['listingBar', 'listingModal', 'listingVariant', 'listingIncludeExisting', 'listingGenerateBtn', 'listingResults', 'listingStatus']) {
    assert.ok(inventory.includes(`id="${id}"`), `#${id} must exist`);
  }
  assert.match(inventory, /const MAX_LISTING_SELECTION = 10;/);
  assert.match(functionBody(inventory, 'toggleSelect'), /selectedIds\.size >= MAX_LISTING_SELECTION/);
  assert.match(inventory, /value="facebook"/);
});

test('suggestion and description text is never injected as HTML', () => {
  const render = functionBody(inventory, 'renderListingResults');
  assert.match(render, /area\.value = item\.suggestion/, 'the suggestion goes into a textarea via .value');
  assert.match(render, /current\.textContent = `Current description: \$\{item\.current_description\}`/);
  assert.match(render, /note\.textContent = \{/);
  // Every innerHTML/insertAdjacentHTML use in the renderer must escape what it interpolates.
  for (const line of render.split('\n').filter(l => /innerHTML|insertAdjacentHTML/.test(l))) {
    for (const interpolation of line.match(/\$\{[^}]+\}/g) || []) {
      assert.match(interpolation, /listingEsc\(/, `unescaped interpolation in: ${line.trim()}`);
    }
  }
  assert.ok(!/innerHTML[^;]*(suggestion|current_description)/.test(render));
});

test('generating never saves: only the explicit Save click performs a PUT, and only via the existing update route', () => {
  const generate = functionBody(inventory, 'generateListingSuggestions');
  assert.ok(!/'PUT'|"PUT"/.test(generate), 'generation must not call the update route');
  assert.match(generate, /'POST', '\/api\/inventory\/description-suggestions\/bulk'/);

  const save = functionBody(inventory, 'saveListingSuggestion');
  assert.match(save, /'PUT', `\/api\/inventory\/\$\{Number\(item\.id\)\}`, \{ notes: text \}/);
  assert.match(save, /confirm\('Replace the current description with this new one\?'\)/, 'overwriting an existing description asks first');

  const render = functionBody(inventory, 'renderListingResults');
  assert.match(render, /save\.addEventListener\('click', \(\) => saveListingSuggestion\(/, 'save is bound to an explicit click');
  assert.ok(!/saveListingSuggestion\(/.test(generate) && !/saveListingSuggestion\(/.test(functionBody(inventory, 'openListingSuite')));
});

test('each suggestion textarea has an accessible label', () => {
  assert.match(functionBody(inventory, 'renderListingResults'), /area\.setAttribute\('aria-label'/);
});

test('existing descriptions and gaps are shown clearly', () => {
  const render = functionBody(inventory, 'renderListingResults');
  assert.match(render, /Already has a description/);
  assert.match(render, /Missing: /);
  assert.match(render, /skipped_existing:/);
});

test('the Listing Suite is only offered to users who can edit inventory', () => {
  assert.match(functionBody(inventory, 'updateSelectionBar'), /UN\.can\('inventory_edit'\)/);
  assert.match(functionBody(inventory, 'openListingSuite'), /UN\.can\('inventory_edit'\)/);
  assert.ok((inventory.match(/UN\.can\('inventory_edit'\) \? `<(?:label class="select-box"|td class="list-select")/g) || []).length >= 2, 'both card and list checkboxes are permission-gated');
});

test('the existing single-vehicle flows and their confirmation prompts are preserved', () => {
  const create = read('inventory-new.html');
  const detail = read('inventory-detail.html');
  for (const [name, html] of [['inventory-new.html', create], ['inventory-detail.html', detail]]) {
    assert.ok(html.includes("confirm('Replace the current description with a new AI description?')"), `${name} keeps its confirmation`);
    assert.ok(html.includes('generateDescriptionBtn'), `${name} keeps its Generate Description button`);
    for (const code of inlineScripts(html)) assert.doesNotThrow(() => new Function(code), `${name} still parses`);
  }
  assert.ok(create.includes("'/api/inventory/description-suggestion'"));
  assert.ok(detail.includes('/description-suggestion`'));
  assert.ok(!create.includes('description-suggestions/bulk') && !detail.includes('description-suggestions/bulk'), 'the single-vehicle pages do not use the bulk route');
});
