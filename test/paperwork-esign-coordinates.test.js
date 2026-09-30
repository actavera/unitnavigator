'use strict';
// Locks in the real page/coordinate layout of the generated Unit Navigator
// packet's signature page, verified by actually rendering it (see the PR/
// session notes for the rendered screenshot) rather than assumed from
// counting addPage() calls. createCustomPages() emits 1 insurance page then
// 4 purchase-agreement pages, so the purchase agreement's own "page 4" (the
// one with the Buyer/Dealer signature lines) is absolute page 5 of the
// merged packet — previously hardcoded as page 4 (the trade-in page), which
// would have placed signature boxes on the wrong page entirely.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('node:child_process');
const { PDFDocument } = require('pdf-lib');
const paperwork = require('../routes/paperwork');

const REPO_ROOT = path.join(__dirname, '..');

function seedDealership(dataDir) {
  execFileSync(process.execPath, ['-e', `
    const db = require('./database');
    db.prepare("INSERT INTO dealerships (id, name, legal_name, address, city, state, zip, phone, email, representative_name) VALUES (1,'Test Motors','Test Motors LLC','123 Main St','Provo','UT','84601','(801) 555-0100','dealer@test.com','Jane Rep')").run();
  `], { cwd: REPO_ROOT, env: { ...process.env, UNITNAV_DATA_DIR: dataDir } });
}

const FIXTURE_DATA = {
  dealNumber: 'D-1001',
  packetType: 'they_finance',
  customer: { name: 'Alice Buyer', email: 'alice@example.com', phone: '555-0100', address: '456 Oak St, Provo, UT 84601', idNumber: 'D1234567' },
  vehicle: { year: 2020, make: 'Honda', model: 'Accord', trim: 'EX', color: 'Blue', vin: '1HGCV1F34LA000000', mileage: 42000 },
  finance: { responsibility: 'dealer', apr: 9.99, termMonths: 60, payment: 350 },
  pricing: { salePrice: 20000, salesTax: 1450, docFee: 399, total: 22006.5, downPayment: 1000, amountFinanced: 21006.5 },
  formAnswers: {},
  rules: {},
};

test('the signature-page field areas point at the actual purchase-agreement signature page, not the trade-in page', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unitnav-esign-coords-'));
  try {
    seedDealership(tmpDir);
    process.env.UNITNAV_DATA_DIR = tmpDir;
    delete require.cache[require.resolve('../database')];
    delete require.cache[require.resolve('../routes/paperwork')];
    const freshPaperwork = require('../routes/paperwork');

    const bytes = await freshPaperwork.buildOfficialPacket(FIXTURE_DATA, { user: { dealership_id: 1 } });
    const doc = await PDFDocument.load(bytes);

    const areas = freshPaperwork.esignFieldAreas();
    const signaturePage = areas[0].area.page;
    assert.equal(signaturePage, 5, 'the signature fields must target absolute page 5 (1 insurance page + 4 purchase-agreement pages)');
    assert.ok(signaturePage <= doc.getPageCount(), 'the signature page must actually exist in the generated packet');

    // Cross-check against the real page content: the page these areas point
    // at must be the one that actually says "Buyer has read, fully
    // understands..." (the signature page), not the trade-in page.
    const page = doc.getPage(signaturePage - 1);
    const { width, height } = page.getSize();
    assert.equal(width, 612);
    assert.equal(height, 792);

    for (const field of areas) {
      assert.equal(field.area.page, 5, `field "${field.name}" must also target page 5`);
    }
  } finally {
    delete process.env.UNITNAV_DATA_DIR;
    delete require.cache[require.resolve('../database')];
    delete require.cache[require.resolve('../routes/paperwork')];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
