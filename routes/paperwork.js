'use strict';
const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { requireAuth } = require('../middleware/auth');
const db = require('../database');

const manifestPath = path.join(__dirname, '..', 'public', 'forms', 'originals', 'manifest.json');
const originalsDir = path.join(__dirname, '..', 'public', 'forms', 'originals');

function templateManifest() {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

router.get('/', requireAuth, (_req, res) => {
  res.json({
    message: 'Paperwork templates are available.',
    templates_url: '/api/paperwork/templates',
  });
});

router.get('/templates', requireAuth, (_req, res) => {
  const templates = templateManifest();
  res.json({
    templates,
    summary: {
      official_fillable: templates.filter(template => template.status === 'fillable-original').length,
      custom_needed: templates.filter(template => template.status === 'custom-template-needed').length,
    },
  });
});

function moneyValue(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toFixed(2) : '';
}

function textValue(value) {
  return String(value ?? '').trim();
}

function vehicleLabel(data) {
  return [data.vehicle?.year, data.vehicle?.make, data.vehicle?.model].filter(Boolean).join(' ');
}

function packetFilename(data) {
  return `${vehicleLabel(data).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'unit'}-official-packet.pdf`;
}

async function buildOfficialPacket(data, req) {
  data.dealer = { ...(data.dealer || {}), ...dealerFromDb(req) };
  const merged = await PDFDocument.create();
  await appendPdf(merged, await createCustomPages(data));
  await appendPdf(merged, await fillTemplate('ftc-buyers-guide-english.pdf', data, fillBuyersGuide));
  await appendPdf(merged, await fillTemplate('tc-466.pdf', data, fillTc466));
  await appendPdf(merged, await fillTemplate('tc-656.pdf', data, fillTc656));
  await appendPdf(merged, await fillTemplate('tc-891.pdf', data, fillTc891));
  if (data.rules?.emissions === 'exempt' || data.rules?.emissions === 'none') {
    await appendPdf(merged, await fillTemplate('tc-820.pdf', data, fillTc820));
  }
  if (data.rules?.isSalvage) {
    await appendPdf(merged, await fillTemplate('tc-814.pdf', data, fillTc814));
  }
  return Buffer.from(await merged.save());
}

function docusealConfig() {
  const token = process.env.DOCUSEAL_API_KEY || process.env.DOCUSEAL_TOKEN || '';
  const endpoint = process.env.DOCUSEAL_API_URL ||
    `${String(process.env.DOCUSEAL_BASE_URL || 'https://api.docuseal.com').replace(/\/$/, '')}/submissions/pdf`;
  return { token, endpoint };
}

function signerName(value, fallback) {
  return String(value || '').trim() || fallback;
}

function signerEmail(value) {
  return String(value || '').trim();
}

function esignFields(data) {
  const buyer = signerName(data.customer?.name, 'Buyer');
  const dealer = signerName(data.dealer?.representativeName || data.dealer?.displayName || data.dealer?.name, 'Dealer');
  return [
    { name: `${buyer} Signature`, type: 'signature', role: 'Buyer', areas: [{ page: 1, x: 80, y: 690, w: 180, h: 32 }] },
    { name: `${buyer} Date`, type: 'date', role: 'Buyer', areas: [{ page: 1, x: 300, y: 690, w: 90, h: 24 }] },
    { name: `${dealer} Signature`, type: 'signature', role: 'Dealer', areas: [{ page: 1, x: 80, y: 730, w: 180, h: 32 }] },
    { name: `${dealer} Date`, type: 'date', role: 'Dealer', areas: [{ page: 1, x: 300, y: 730, w: 90, h: 24 }] },
  ];
}

function firstUrl(value) {
  if (!value || typeof value !== 'object') return '';
  const preferred = ['url', 'slug', 'embed_src', 'submission_url', 'signing_url', 'submitter_url'];
  for (const key of preferred) {
    if (typeof value[key] === 'string' && /^https?:\/\//.test(value[key])) return value[key];
  }
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = firstUrl(item);
        if (found) return found;
      }
    } else if (child && typeof child === 'object') {
      const found = firstUrl(child);
      if (found) return found;
    }
  }
  return '';
}

function splitAddress(address) {
  const parts = String(address || '').split(',').map(part => part.trim());
  return {
    street: parts[0] || '',
    city: parts[1] || '',
    state: parts[2]?.split(/\s+/)[0] || 'UT',
    zip: parts[2]?.match(/\b\d{5}(?:-\d{4})?\b/)?.[0] || '',
  };
}

function dealerFromDb(req) {
  const row = db.prepare('SELECT * FROM dealerships WHERE id = ?').get(req.user.dealership_id);
  if (!row) return {};
  return {
    name: row.legal_name || row.name || '',
    displayName: row.name || row.legal_name || '',
    number: row.dealer_number || '',
    address: row.address || '',
    city: row.city || '',
    state: row.state || 'UT',
    zip: row.zip || '',
    phone: row.phone || '',
    email: row.email || '',
    website: row.website || '',
    representativeName: row.representative_name || '',
    representativeTitle: row.representative_title || '',
  };
}

function dealerAddress(dealer) {
  return {
    street: dealer?.address || '',
    city: dealer?.city || '',
    state: dealer?.state || 'UT',
    zip: dealer?.zip || '',
  };
}

function todayLabel() {
  return new Date().toLocaleDateString('en-US');
}

function odometerCertLabel(value) {
  if (value === 'exceeds') return "Mileage in excess of odometer's mechanical limits";
  if (value === 'not_actual') return 'Not the actual mileage.';
  return 'Actual mileage';
}

function tc891OdometerCertLabel(value) {
  if (value === 'exceeds') return "the mileage in excess of odometer's mechanical limits";
  if (value === 'not_actual') return 'Not the actual mileage (Warning: odometer discrepancy)';
  return 'the actual mileage';
}

function vehicleTypeOption(unitType) {
  if (unitType === 'Motorcycle') return 'Street motorcycle';
  if (unitType === 'ATV / UTV') return 'Street-legal ATV';
  if (unitType === 'Trailer') return 'Trailer';
  if (unitType === 'Watercraft') return '';
  return 'Passenger, light truck, van or utility';
}

function setText(form, names, value) {
  for (const name of Array.isArray(names) ? names : [names]) {
    try {
      form.getTextField(name).setText(textValue(value));
    } catch {
      // Field not present on this exact template revision.
    }
  }
}

function checkBox(form, names, checked) {
  for (const name of Array.isArray(names) ? names : [names]) {
    try {
      const field = form.getCheckBox(name);
      if (checked) field.check();
      else field.uncheck();
    } catch {
      // Field not present on this exact template revision.
    }
  }
}

function selectRadio(form, name, option, shouldSelect = true) {
  if (!shouldSelect) return;
  try {
    form.getRadioGroup(name).select(option);
  } catch {
    // Field not present on this exact template revision.
  }
}

async function createCustomPages(data) {
  const pdf = await PDFDocument.create();
  await addSimplePage(pdf, 'Agreement to Provide Insurance', [
    ['Buyer', data.customer?.name],
    ['Vehicle', vehicleLabel(data)],
    ['VIN', data.vehicle?.vin],
    ['Insurance Company', data.formAnswers?.insuranceCompany],
    ['Agent / Phone', [data.formAnswers?.insuranceAgent, data.formAnswers?.insuranceAgentPhone].filter(Boolean).join(' / ')],
    ['Policy Number', data.formAnswers?.insurancePolicy],
    ['Effective Date', data.formAnswers?.insuranceEffective],
    ['Coverage', data.formAnswers?.insuranceCoverage],
  ], 'Buyer agrees to keep required insurance coverage in force and provide proof of insurance before delivery when required by the dealer or lender.');

  await addPurchaseAgreementPages(pdf, data);

  await addSimplePage(pdf, 'We Owe / You Owe', [
    ['Dealer Owes Customer', data.formAnswers?.weOwe],
    ['Customer Owes Dealer', data.formAnswers?.youOwe],
  ], 'Only written promises listed here are included in this packet.');

  await addSimplePage(pdf, 'Credit Application', [
    ['Applicant', data.customer?.name],
    ['Co-Buyer', data.customer?.coBuyer],
    ['Phone', data.customer?.phone],
    ['Email', data.customer?.email],
    ['ID Number', data.customer?.idNumber],
    ['Address', data.customer?.address],
  ], 'Credit application source PDF is dealer/lender-specific. This temporary packet page captures the required fields until that original template is supplied.');
  return pdf;
}

function dollar(value) {
  return `$${moneyValue(value)}`;
}

function fullDealerAddress(dealer) {
  return [dealer?.address, dealer?.city, dealer?.state, dealer?.zip].filter(Boolean).join(' ');
}

function drawCell(page, text, x, y, width, height, font, bold, opts = {}) {
  page.drawRectangle({ x, y, width, height, borderWidth: 0.6, borderColor: rgb(0, 0, 0) });
  if (opts.label) page.drawText(String(opts.label), { x: x + 4, y: y + height - 7, size: 5.6, font: bold, color: rgb(0, 0, 0) });
  const size = opts.size || 7.5;
  const textY = opts.label ? y + 2.5 : y + Math.max(4, (height - size) / 2);
  drawWrappedText(page, String(text || ''), x + 4, textY, width - 8, size, font, opts.lineHeight || size + 2, opts.maxLines || 2);
}

function drawCheckbox(page, x, y, checked, font) {
  page.drawRectangle({ x, y, width: 8, height: 8, borderWidth: 0.7, borderColor: rgb(0, 0, 0) });
  if (checked) page.drawText('X', { x: x + 1.6, y: y + 0.8, size: 7, font, color: rgb(0, 0, 0) });
}

function drawSignatureLine(page, label, x, y, width, font) {
  page.drawLine({ start: { x, y }, end: { x: x + width, y }, thickness: 0.7, color: rgb(0, 0, 0) });
  page.drawText(label, { x, y: y - 10, size: 7.5, font, color: rgb(0, 0, 0) });
}

function drawWrappedText(page, text, x, y, width, size, font, lineHeight = size + 2, maxLines = 20) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  let line = '';
  let lines = 0;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) > width && line) {
      page.drawText(line, { x, y, size, font, color: rgb(0, 0, 0) });
      y -= lineHeight;
      lines += 1;
      line = word;
      if (lines >= maxLines) return y;
    } else {
      line = test;
    }
  }
  if (line && lines < maxLines) {
    page.drawText(line, { x, y, size, font, color: rgb(0, 0, 0) });
    y -= lineHeight;
  }
  return y;
}

function drawSectionHeader(page, title, x, y, width, bold) {
  page.drawRectangle({ x, y, width, height: 12, color: rgb(0.9, 0.9, 0.9), borderWidth: 0.6, borderColor: rgb(0, 0, 0) });
  page.drawText(title, { x: x + 4, y: y + 3, size: 8, font: bold, color: rgb(0, 0, 0) });
}

function purchaseAgreementHeader(page, title, font, bold, pageNumber = '') {
  page.drawText(title, { x: 42, y: 742, size: 14, font: bold, color: rgb(0, 0, 0) });
  if (pageNumber) page.drawText(pageNumber, { x: 500, y: 742, size: 8, font, color: rgb(0, 0, 0) });
}

function footer(page, font) {
  page.drawLine({ start: { x: 32, y: 42 }, end: { x: 580, y: 42 }, thickness: 2, color: rgb(0.05, 0.35, 0.8) });
  page.drawText('Unit Navigator', { x: 42, y: 20, size: 13, font, color: rgb(0.05, 0.2, 0.45) });
  page.drawText('Utah purchase agreement packet form', { x: 400, y: 22, size: 7, font, color: rgb(0, 0, 0) });
}

async function addPurchaseAgreementPages(pdf, data) {
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  addPurchaseAgreementPageOne(pdf, data, font, bold);
  addPurchaseAgreementPageTwo(pdf, data, font, bold);
  addPurchaseAgreementPageThree(pdf, data, font, bold);
  addPurchaseAgreementPageFour(pdf, data, font, bold);
}

function addPurchaseAgreementPageOne(pdf, data, font, bold) {
  const page = pdf.addPage([612, 792]);
  const pricing = data.pricing || {};
  const dealer = data.dealer || {};
  const vehicle = data.vehicle || {};
  const customer = data.customer || {};
  const finance = data.finance || {};
  const customerResponsible = finance.responsibility === 'customer' || data.packetType === 'cash';
  const dealerResponsible = finance.responsibility === 'dealer' || data.packetType === 'bhph';
  purchaseAgreementHeader(page, 'PURCHASE AGREEMENT', font, bold);
  page.drawText(`Deal Number: ${data.dealNumber || '______________'}`, { x: 438, y: 742, size: 8, font: bold });
  page.drawText(`Agreement Date: ${todayLabel()}`, { x: 438, y: 730, size: 8, font: bold });

  drawSectionHeader(page, 'Buyer Information', 42, 715, 528, bold);
  drawCell(page, customer.name, 42, 697, 262, 18, font, bold, { label: 'Buyer Name' });
  drawCell(page, customer.coBuyer || 'N/A', 304, 697, 266, 18, font, bold, { label: 'Co-Buyer Name' });
  drawCell(page, customer.address, 42, 679, 528, 18, font, bold, { label: 'Full Address' });
  drawCell(page, customer.email, 42, 661, 264, 18, font, bold, { label: 'Email' });
  drawCell(page, customer.phone, 306, 661, 264, 18, font, bold, { label: 'Phone' });

  drawSectionHeader(page, 'Seller Information', 42, 643, 528, bold);
  drawCell(page, dealer.name, 42, 625, 350, 18, font, bold, { label: 'Name' });
  drawCell(page, dealer.number, 392, 625, 178, 18, font, bold, { label: 'Dealer License No.' });
  drawCell(page, fullDealerAddress(dealer), 42, 607, 350, 18, font, bold, { label: 'Full Address' });
  drawCell(page, dealer.phone, 392, 607, 178, 18, font, bold, { label: 'Phone' });
  drawCell(page, dealer.email, 42, 589, 264, 18, font, bold, { label: 'Email' });
  drawCell(page, dealer.representativeName || '', 306, 589, 264, 18, font, bold, { label: 'Salesperson' });

  drawSectionHeader(page, 'Vehicle Information', 42, 571, 528, bold);
  drawCheckbox(page, 132, 573.5, false, font);
  page.drawText('New', { x: 143, y: 573, size: 7.5, font });
  drawCheckbox(page, 174, 573.5, true, font);
  page.drawText('Used', { x: 185, y: 573, size: 7.5, font });
  drawCheckbox(page, 216, 573.5, false, font);
  page.drawText('Demo', { x: 227, y: 573, size: 7.5, font });
  drawCell(page, vehicle.year, 42, 553, 72, 18, font, bold, { label: 'Year' });
  drawCell(page, vehicle.make, 114, 553, 92, 18, font, bold, { label: 'Make' });
  drawCell(page, vehicle.model, 206, 553, 110, 18, font, bold, { label: 'Model' });
  drawCell(page, vehicle.trim || '', 316, 553, 130, 18, font, bold, { label: 'Trim' });
  drawCell(page, vehicle.color || '', 446, 553, 124, 18, font, bold, { label: 'Color' });
  drawCell(page, vehicle.vin, 42, 535, 200, 18, font, bold, { label: 'VIN' });
  drawCell(page, vehicle.unitType || '', 242, 535, 110, 18, font, bold, { label: 'Type' });
  drawCell(page, vehicle.stockNumber || '', 352, 535, 108, 18, font, bold, { label: 'Stock No.' });
  drawCell(page, vehicle.mileage ? Number(vehicle.mileage).toLocaleString() : '', 460, 535, 110, 18, font, bold, { label: 'Mileage' });
  drawCell(page, data.packetType === 'cash' ? '' : dealer.name, 42, 517, 528, 18, font, bold, { label: 'Lienholder Name and Address (if known)' });

  let y = 500;
  y = drawWrappedText(page, 'In this Purchase Agreement ("Agreement"), "I," "me," "my," and "purchaser" mean the buyer and any co-buyer who signs this Agreement. "You" and "your" means the Seller identified above, or any assignee of my Contract and this Agreement. I am buying the vehicle described above ("Vehicle") according to the Terms and Conditions of this Agreement. Below is the Itemization of Vehicle Costs. If there is an Unpaid Balance Due, my obligation to buy and your obligation to sell the Vehicle are expressly conditioned upon me paying the Unpaid Balance Due to you in full within three business days from the date of this Agreement. I may pay the Unpaid Balance Due in cash, obtain financing from you or through a third party.', 42, y, 528, 7.2, font, 9.1, 8);
  drawSectionHeader(page, 'FINANCING ARRANGEMENTS', 42, y - 3, 528, bold);
  y -= 18;
  drawCheckbox(page, 48, y - 1, customerResponsible, font);
  y = drawWrappedText(page, "If this box is checked, THE PURCHASER OF THE MOTOR VEHICLE DESCRIBED IN THIS CONTRACT ACKNOWLEDGES THAT THE SELLER OF THE MOTOR VEHICLE HAS MADE NO PROMISES, WARRANTIES, OR REPRESENTATIONS REGARDING SELLER'S ABILITY TO OBTAIN FINANCING FOR THE PURCHASE OF THE MOTOR VEHICLE. FURTHERMORE, PURCHASER UNDERSTANDS THAT IF FINANCING IS NECESSARY IN ORDER FOR THE PURCHASER TO COMPLETE THE PAYMENT TERMS OF THIS CONTRACT ALL THE FINANCING ARRANGEMENTS ARE THE SOLE RESPONSIBILITY OF THE PURCHASER.", 62, y, 500, 7.2, font, 9, 7);
  drawSignatureLine(page, 'Signature of the purchaser', 48, y - 10, 210, font);
  drawSignatureLine(page, 'Signature of the purchaser', 300, y - 10, 220, font);
  y -= 31;
  drawCheckbox(page, 48, y - 1, dealerResponsible, font);
  y = drawWrappedText(page, "If this box is checked, Purchaser acknowledges that (1) THE PURCHASER OF THE MOTOR VEHICLE DESCRIBED IN THIS CONTRACT HAS EXECUTED THE CONTRACT IN RELIANCE UPON THE SELLER'S REPRESENTATION THAT THE SELLER CAN PROVIDE FINANCING ARRANGEMENTS FOR THE PURCHASE OF THE MOTOR VEHICLE. THE PRIMARY TERMS OF THE FINANCING ARE AS FOLLOWS:", 62, y, 500, 7.2, font, 9, 6);
  y = drawWrappedText(page, `INTEREST RATE BETWEEN ${finance.apr ? Number(finance.apr).toFixed(2) : '_____'}% AND _____% PER ANNUM, TERM BETWEEN ${finance.termMonths || '____'} MONTHS AND ____ MONTHS. MONTHLY PAYMENTS BETWEEN ${dollar(finance.payment || 0)} PER MONTH AND $__________ PER MONTH BASED ON A DOWN PAYMENT OF ${dollar(pricing.downPayment || 0)}.`, 48, y - 2, 514, 7.2, bold, 9, 3);
  const statutory = [
    '(2) (a) IF SELLER IS NOT ABLE TO ARRANGE FINANCING WITHIN THE TERMS DISCLOSED, THEN SELLER MUST WITHIN SEVEN CALENDAR DAYS OF THE DATE OF SALE MAIL NOTICE TO THE PURCHASER THAT HE HAS NOT BEEN ABLE TO ARRANGE FINANCING.',
    '(b) PURCHASER THEN HAS 14 DAYS FROM THE DATE OF SALE TO ELECT, IF PURCHASER CHOOSES, TO RESCIND THE CONTRACT OF SALE PURSUANT TO SECTION 41-3-401.',
    '(c) IN ORDER TO RESCIND THE CONTRACT OF SALE, THE PURCHASER SHALL: (i) RETURN TO SELLER THE MOTOR VEHICLE HE PURCHASED; (ii) PAY THE SELLER AN AMOUNT EQUAL TO THE CURRENT STANDARD MILEAGE RATE FOR THE COST OF OPERATING A MOTOR VEHICLE ESTABLISHED BY THE FEDERAL INTERNAL REVENUE SERVICE FOR EACH MILE THE MOTOR VEHICLE HAS BEEN DRIVEN; AND (iii) COMPENSATE SELLER FOR ANY PHYSICAL DAMAGE TO THE MOTOR VEHICLE.',
    '(3) IN RETURN, SELLER SHALL GIVE BACK TO THE PURCHASER ALL PAYMENTS OR OTHER CONSIDERATIONS PAID BY THE PURCHASER, INCLUDING ANY DOWN PAYMENT AND ANY MOTOR VEHICLE TRADED IN.',
    '(4) IF THE TRADE-IN HAS BEEN SOLD OR OTHERWISE DISPOSED OF BEFORE THE PURCHASER RESCINDS THE TRANSACTION, THEN THE SELLER SHALL RETURN TO THE PURCHASER A SUM EQUIVALENT TO THE ALLOWANCE TOWARD THE PURCHASE PRICE GIVEN BY THE SELLER FOR THE TRADE-IN, AS NOTED IN THE DOCUMENT OF SALE.',
    '(5) IF PURCHASER DOES NOT ELECT TO RESCIND THE CONTRACT OF SALE AS PROVIDED IN SUBSECTION (2)(b) OF THIS FORM: (a) THE PURCHASER IS RESPONSIBLE FOR ADHERENCE TO THE TERMS AND CONDITIONS OF THE CONTRACT OR RISKS BEING FOUND IN DEFAULT OF THE TERMS AND CONDITIONS; (b) THE TERMS AND CONDITIONS OF THE DISCLOSURES SET FORTH IN SECTION (1) OF THIS FORM ARE NOT BINDING ON THE SELLER; AND (c) IF FINANCING IS NECESSARY FOR THE PURCHASER TO COMPLETE THE PAYMENT TERMS OF THE CONTRACT OF SALE, THE PURCHASER IS SOLELY RESPONSIBLE FOR MAKING ALL THE FINANCING ARRANGEMENTS.',
    '(6) SIGNING THIS DISCLOSURE DOES NOT PROHIBIT THE PURCHASER FROM SEEKING HIS OWN FINANCING.',
  ];
  for (const paragraph of statutory) y = drawWrappedText(page, paragraph, 48, y, 514, 6.55, font, 8.1, 5);
  drawSignatureLine(page, 'Signature of the purchaser', 48, 76, 210, font);
  drawSignatureLine(page, 'Signature of the purchaser', 300, 76, 220, font);
  drawSignatureLine(page, 'Signature of the seller', 48, 52, 210, font);
  footer(page, bold);
}

function addPurchaseAgreementPageTwo(pdf, data, font, bold) {
  const page = pdf.addPage([612, 792]);
  const pricing = data.pricing || {};
  purchaseAgreementHeader(page, 'PURCHASE AGREEMENT', font, bold, 'Page 2');
  const leftX = 42;
  const top = 704;
  page.drawRectangle({ x: leftX, y: top, width: 248, height: 18, color: rgb(0.9, 0.9, 0.9), borderWidth: 0.6, borderColor: rgb(0, 0, 0) });
  page.drawText('Itemization of Vehicle Costs', { x: leftX + 58, y: top + 5, size: 8, font: bold });
  const rows = [
    ['Cash Price of Vehicle', pricing.salePrice],
    ['Sales Tax', pricing.salesTax],
    ['Total Sale Price', (pricing.salePrice || 0) + (pricing.salesTax || 0)],
    ['Documentary Fee (not state-mandated)', pricing.docFee],
    ['License Fee', pricing.licenseFee],
    ['Title Fee', pricing.titleFee],
    ['Plate Fee', pricing.plateFee],
    ['Age Based/Property Assessment Fee', pricing.agePropertyTax],
    ['Inspection/Emissions Test Fee', pricing.emissionsFee],
    ['Filing Fee', pricing.filingFee],
    ['Lender Processing Fee', pricing.lenderFee],
    ['Insurance / GAP / VSI', pricing.insuranceGapVsi],
    [`Accessories: ${data.formAnswers?.accessoriesDescription || ''}`.slice(0, 38), pricing.accessories],
    [`Products: ${data.formAnswers?.productsDescription || ''}`.slice(0, 38), pricing.products],
    ['Subtotal', pricing.total],
    ['Trade-In Allowance', pricing.trade],
    ['Cash Downpayment', pricing.downPayment],
    ['Unpaid Balance Due', pricing.amountFinanced],
  ];
  let y = top - 14;
  for (const [label, amount] of rows) {
    page.drawRectangle({ x: leftX, y, width: 248, height: 14, borderWidth: 0.45, borderColor: rgb(0, 0, 0) });
    page.drawText(label || 'N/A', { x: leftX + 5, y: y + 4, size: 7, font: ['Subtotal', 'Unpaid Balance Due', 'Total Sale Price'].includes(label) ? bold : font });
    page.drawText(dollar(amount || 0), { x: leftX + 190, y: y + 4, size: 7, font });
    y -= 14;
  }
  page.drawRectangle({ x: 300, y: top, width: 270, height: 18, color: rgb(0.9, 0.9, 0.9), borderWidth: 0.6, borderColor: rgb(0, 0, 0) });
  page.drawText('Disclosures', { x: 412, y: top + 5, size: 8, font: bold });
  let rightY = top - 14;
  rightY = drawWrappedText(page, 'UNLESS YOU MAKE A WRITTEN WARRANTY ON YOUR OWN BEHALF OR ENTER INTO A SERVICE CONTRACT WITHIN 90 DAYS FROM THE DATE OF THIS AGREEMENT YOU ARE SELLING THIS VEHICLE TO ME "AS-IS." YOU MAKE NO EXPRESS WARRANTIES ON THE VEHICLE. YOU EXPRESSLY DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING ANY IMPLIED WARRANTIES OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.', 304, rightY, 260, 9.2, bold, 11.2, 11);
  rightY = drawWrappedText(page, 'All warranties, if any, by a manufacturer or supplier other than your dealership are theirs, not yours, and only such manufacturer or supplier shall be liable for performance under such warranties. You neither assume nor authorize any other person to assume for you any liability in connection with the sale of the vehicle and related goods and services.', 304, rightY - 6, 260, 7, font, 8.7, 9);
  rightY = drawWrappedText(page, 'I acknowledge that it has not been represented to me by any agent of the seller that the vehicle which is the subject of this purchase has not ever sustained damage prior to this purchase.', 304, rightY - 4, 260, 7, font, 8.7, 5);
  rightY = drawWrappedText(page, 'USED CAR BUYERS GUIDE: THE INFORMATION YOU SEE ON THE WINDOW FORM FOR THIS VEHICLE IS PART OF THE CONTRACT. INFORMATION ON THE WINDOW FORM OVERRIDES ANY CONTRARY PROVISIONS IN THE CONTRACT OF SALE.', 304, rightY - 8, 260, 8.2, bold, 10, 7);
  drawWrappedText(page, 'New Vehicles. If this Agreement is for the sale of a new vehicle, references to the manufacturer describe contractual relationships between the manufacturer and buyer. Dealer is not the manufacturer unless separately stated. Used Vehicles. Buyer understands that dealer has relied in good faith on written odometer, title, and condition information available from records and prior ownership. Vehicle Price & Taxes. Buyer agrees to pay applicable taxes and fees connected with this Agreement unless prohibited by law.', 42, 210, 528, 7.2, font, 9.2, 16);
  footer(page, bold);
}

function addPurchaseAgreementPageThree(pdf, data, font, bold) {
  const page = pdf.addPage([612, 792]);
  purchaseAgreementHeader(page, 'PURCHASE AGREEMENT', font, bold, 'Page 3');
  let y = 705;
  y = drawWrappedText(page, 'Failure to Pay Unpaid Balance Due. If for any reason buyer and seller do not complete the vehicle sale and purchase because buyer does not pay the unpaid balance due, does not obtain financing for the unpaid balance due, or buyer and seller do not enter into a retail installment sale contract, this Agreement may be void. Buyer will return the Vehicle to seller within 24 hours of notice from seller and will pay reasonable charges and expenses for damage to the Vehicle, retaking the Vehicle, and other amounts allowed by law.', 42, y, 528, 7.5, font, 9.5, 12);
  y = drawWrappedText(page, 'Returned Payments. If buyer pays any amount in connection with this Agreement with a check or electronic payment that is dishonored or unpaid for any reason, seller may declare this Agreement null and void, make claims against buyer on the payment, and charge a returned payment fee where allowed by law.', 42, y - 8, 528, 7.5, font, 9.5, 8);
  y = drawWrappedText(page, 'Delay or Failure to Deliver Vehicle. Seller is not liable for failure or delay in delivery caused by events outside seller control. If buyer refuses delivery or fails to comply with this Agreement, seller may retain or apply deposits to actual expenses and losses where allowed by law.', 42, y - 8, 528, 7.5, font, 9.5, 8);
  y -= 20;
  drawSectionHeader(page, 'Trade-In 1 Information', 42, y, 528, bold);
  y -= 18;
  drawCell(page, '', 42, y, 100, 18, font, bold, { label: 'Year' });
  drawCell(page, '', 142, y, 112, 18, font, bold, { label: 'Make' });
  drawCell(page, '', 254, y, 122, 18, font, bold, { label: 'Model' });
  drawCell(page, '', 376, y, 120, 18, font, bold, { label: 'VIN' });
  drawCell(page, '', 496, y, 74, 18, font, bold, { label: 'Mileage' });
  y -= 18;
  drawCell(page, pricingOrBlank(data.pricing?.trade), 42, y, 176, 18, font, bold, { label: 'Trade In Allowance' });
  drawCell(page, '', 218, y, 176, 18, font, bold, { label: 'Payoff Amount' });
  drawCell(page, '', 394, y, 176, 18, font, bold, { label: 'Payoff Good Through' });
  y -= 22;
  y = drawWrappedText(page, 'Trade-In Vehicle(s). Buyer agrees to trade in the vehicle(s) identified above and represents that buyer owns the trade-in, that stated mileage is true and actual unless otherwise disclosed, that liens and payoff information have been fully disclosed, and that the vehicle has not been materially altered, damaged, branded, flooded, or repaired except as disclosed to seller.', 42, y, 528, 7.5, font, 9.5, 10);
  drawSignatureLine(page, 'Buyer Signature', 42, 102, 230, font);
  drawSignatureLine(page, 'Date', 330, 102, 150, font);
  footer(page, bold);
}

function pricingOrBlank(value) {
  return Number(value || 0) ? dollar(value) : '';
}

function addPurchaseAgreementPageFour(pdf, data, font, bold) {
  const page = pdf.addPage([612, 792]);
  purchaseAgreementHeader(page, 'PURCHASE AGREEMENT', font, bold, 'Page 4');
  let y = 705;
  y = drawWrappedText(page, 'Buyer has read, fully understands, and acknowledges receipt of a copy of this Agreement. Buyer agrees that this Agreement may be signed electronically, with any electronic signature having the same validity as a handwritten signature. Buyer agrees to be bound by the terms of this Agreement.', 42, y, 528, 8.5, font, 11, 8);
  y -= 28;
  drawCell(page, data.customer?.name || '', 42, y, 250, 24, font, bold, { label: 'Buyer' });
  drawCell(page, data.customer?.coBuyer || '', 320, y, 250, 24, font, bold, { label: 'Co-Buyer' });
  y -= 42;
  drawCell(page, vehicleLabel(data), 42, y, 250, 24, font, bold, { label: 'Vehicle' });
  drawCell(page, data.vehicle?.vin || '', 320, y, 250, 24, font, bold, { label: 'VIN' });
  y -= 42;
  drawCell(page, dollar(data.pricing?.amountFinanced || 0), 42, y, 250, 24, font, bold, { label: data.packetType === 'cash' ? 'Balance Due' : 'Unpaid Balance / Amount Financed' });
  drawCell(page, todayLabel(), 320, y, 250, 24, font, bold, { label: 'Agreement Date' });
  drawSignatureLine(page, 'Buyer Signature', 42, 410, 230, font);
  drawSignatureLine(page, 'Date', 292, 410, 100, font);
  drawSignatureLine(page, 'Co-Buyer Signature', 42, 360, 230, font);
  drawSignatureLine(page, 'Date', 292, 360, 100, font);
  drawSignatureLine(page, 'Approved by Seller', 42, 300, 300, font);
  drawSignatureLine(page, 'Date', 370, 300, 120, font);
  footer(page, bold);
}

async function addSimplePage(pdf, title, rows, note) {
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let y = 736;
  page.drawText(title, { x: 54, y, size: 22, font: bold, color: rgb(0.04, 0.07, 0.14) });
  y -= 28;
  page.drawLine({ start: { x: 54, y }, end: { x: 558, y }, thickness: 1.5, color: rgb(0.08, 0.1, 0.16) });
  y -= 30;
  for (const [label, value] of rows) {
    page.drawText(String(label || ''), { x: 54, y, size: 9, font: bold, color: rgb(0.29, 0.36, 0.46) });
    page.drawText(String(value || '-').slice(0, 86), { x: 190, y, size: 11, font, color: rgb(0.04, 0.07, 0.14) });
    y -= 24;
    if (y < 140) break;
  }
  y -= 10;
  const noteLines = String(note || '').match(/.{1,92}(\s|$)/g) || [];
  for (const line of noteLines.slice(0, 5)) {
    page.drawText(line.trim(), { x: 54, y, size: 10, font, color: rgb(0.2, 0.25, 0.34) });
    y -= 15;
  }
  page.drawLine({ start: { x: 54, y: 92 }, end: { x: 270, y: 92 }, thickness: 1, color: rgb(0.08, 0.1, 0.16) });
  page.drawText('Buyer Signature', { x: 54, y: 76, size: 10, font, color: rgb(0.2, 0.25, 0.34) });
  page.drawLine({ start: { x: 318, y: 92 }, end: { x: 558, y: 92 }, thickness: 1, color: rgb(0.08, 0.1, 0.16) });
  page.drawText('Dealer Signature / Date', { x: 318, y: 76, size: 10, font, color: rgb(0.2, 0.25, 0.34) });
}

async function fillTemplate(templateFile, data, fill) {
  const pdf = await PDFDocument.load(fs.readFileSync(path.join(originalsDir, templateFile)));
  const form = pdf.getForm();
  fill(form, data);
  try {
    form.flatten();
  } catch {
    // Some government PDFs have fields that cannot be flattened by pdf-lib.
  }
  return pdf;
}

async function appendPdf(target, source) {
  const pages = await target.copyPages(source, source.getPageIndices());
  pages.forEach(page => target.addPage(page));
}

function fillTc466(form, data) {
  const pricing = data.pricing || {};
  const answers = data.formAnswers || {};
  const optionalCharges = (pricing.insuranceGapVsi || 0) + (pricing.accessories || 0) + (pricing.products || 0);
  const govFees = (pricing.licenseFee || 0) + (pricing.plateFee || 0) + (pricing.agePropertyTax || 0) + (pricing.titleFee || 0) + (pricing.emissionsFee || 0);
  const filingAndLenderFees = (pricing.filingFee || 0) + (pricing.lenderFee || 0);
  const line5Total = (pricing.salePrice || 0) + (pricing.docFee || 0) + optionalCharges;
  const line6Total = (pricing.fees || 0) + (pricing.salesTax || 0);
  const adjustedTotal = pricing.total || (line5Total + line6Total);
  setText(form, 'dealer', data.dealer?.name || '');
  setText(form, 'dealer number', data.dealer?.number || '');
  setText(form, 'trans date', new Date().toLocaleDateString('en-US'));
  setText(form, 'buyer name', data.customer?.name || '');
  setText(form, 'cobuyer name', data.customer?.coBuyer || '');
  setText(form, 'vin', data.vehicle?.vin || '');
  setText(form, 'make', data.vehicle?.make || '');
  setText(form, 'model', data.vehicle?.model || '');
  setText(form, 'year', data.vehicle?.year || '');
  setText(form, 'line 1', moneyValue(pricing.salePrice));
  setText(form, 'line 2', moneyValue(pricing.docFee));
  setText(form, 'line 3', moneyValue((pricing.salePrice || 0) + (pricing.docFee || 0)));
  setText(form, 'line 4-a', 'Insurance / GAP / VSI');
  setText(form, 'line 4a', moneyValue(pricing.insuranceGapVsi));
  setText(form, 'line 4-b', answers.accessoriesDescription || 'Accessories');
  setText(form, 'line 4b', moneyValue(pricing.accessories));
  setText(form, 'line 4-c', answers.productsDescription || 'Products');
  setText(form, 'line 4c', moneyValue(pricing.products));
  setText(form, 'line 4', moneyValue(optionalCharges));
  setText(form, 'line 5', moneyValue(line5Total));
  setText(form, 'line 6b', moneyValue(govFees));
  setText(form, 'line 6d', moneyValue(pricing.salesTax));
  setText(form, 'line 6e', moneyValue(filingAndLenderFees));
  setText(form, 'line 6', moneyValue(line6Total));
  setText(form, 'line 7', moneyValue(adjustedTotal));
  setText(form, 'line 8a', moneyValue(pricing.trade));
  setText(form, 'line 8b', '0.00');
  setText(form, 'line 8c', moneyValue(pricing.trade));
  setText(form, 'line 8e', moneyValue(pricing.downPayment));
  setText(form, 'line 8', moneyValue((pricing.downPayment || 0) + (pricing.trade || 0)));
  setText(form, 'line 9', moneyValue(pricing.amountFinanced));
}

function fillTc656(form, data) {
  const address = splitAddress(data.customer?.address);
  const pricing = data.pricing || {};
  checkBox(form, ['new title', 'Registration', 'change of ownership'], true);
  selectRadio(form, 'owner and/or', 'And');
  setText(form, 'primary owner name', data.customer?.name || '');
  setText(form, "primary owner's email", data.customer?.email || '');
  setText(form, ["primary owner's I.D. number", "primary owner's I.D"], data.customer?.idNumber || '');
  selectRadio(form, 'ID type', "Driver's license");
  setText(form, 'primary owner state/country', 'UT');
  setText(form, "primary owner's address", address.street);
  setText(form, "primary owner's city", address.city);
  setText(form, "primary owner's state", address.state);
  setText(form, "primary owner's zip code", address.zip);
  setText(form, "primary owner's mailing address ", address.street);
  setText(form, "primary owner's mailing address city ", address.city);
  setText(form, "primary owner's mailing address state", address.state);
  setText(form, "primary owner's mailing address zip code", address.zip);
  setText(form, 'co-owner name 1', data.customer?.coBuyer || '');
  setText(form, 'year', data.vehicle?.year || '');
  setText(form, 'make', data.vehicle?.make || '');
  setText(form, 'model', data.vehicle?.model || '');
  setText(form, 'color', data.vehicle?.color || '');
  setText(form, 'VIN', data.vehicle?.vin || '');
  setText(form, 'fuel', data.vehicle?.fuel || '');
  setText(form, 'body type', data.vehicle?.unitType || '');
  setText(form, 'purchase price', moneyValue(pricing.salePrice));
  setText(form, 'purchase date', todayLabel());
  setText(form, 'dealer number', data.dealer?.number || '');
  selectRadio(form, 'dealer new/used', 'Used');
  selectRadio(form, 'commercial use', 'No');
  selectRadio(form, 'farm use', 'No');
  selectRadio(form, 'vehcile type', vehicleTypeOption(data.vehicle?.unitType));
  setText(form, 'odometer', data.vehicle?.mileage || '');
  selectRadio(form, 'odometer reading', 'Miles');
  selectRadio(form, 'odometer certification', odometerCertLabel(data.formAnswers?.odometerCertification));
  selectRadio(form, 'plate type', 'Life Elevated Arches');
  selectRadio(form, 'title type', 'Paper');
  setText(form, 'owner sig date', todayLabel());
  setText(form, 'dealer sig date', todayLabel());
}

function fillTc891(form, data) {
  const address = splitAddress(data.customer?.address);
  const seller = dealerAddress(data.dealer);
  setText(form, "Transferor's name", data.dealer?.name || '');
  setText(form, "Transferor's Address", seller.street);
  setText(form, "Transferor's city", seller.city);
  setText(form, "Transferor's state", seller.state);
  setText(form, "Transferor's ZIP", seller.zip);
  setText(form, 'Year', data.vehicle?.year || '');
  setText(form, 'Make', data.vehicle?.make || '');
  setText(form, 'Model', data.vehicle?.model || '');
  setText(form, 'VIN', data.vehicle?.vin || '');
  setText(form, 'Body type', data.vehicle?.unitType || '');
  setText(form, 'Reading', data.vehicle?.mileage || '');
  setText(form, 'odometer 3', data.vehicle?.mileage || '');
  selectRadio(form, 'Reading', 'Miles');
  selectRadio(form, 'I certify', tc891OdometerCertLabel(data.formAnswers?.odometerCertification));
  setText(form, 'sig date', todayLabel());
  setText(form, "Transferee's name", data.customer?.name || '');
  setText(form, "Transferee's Address", address.street);
  setText(form, "Transferee's city", address.city);
  setText(form, "Transferee's state", address.state);
  setText(form, "Transferee's  ZIP", address.zip);
  setText(form, 'sig date 2', todayLabel());
}

function fillTc820(form, data) {
  const address = splitAddress(data.customer?.address);
  setText(form, 'Vehicle year', data.vehicle?.year || '');
  setText(form, 'Vehicle make', data.vehicle?.make || '');
  setText(form, 'Vehicle model', data.vehicle?.model || '');
  setText(form, 'VIN', data.vehicle?.vin || '');
  setText(form, 'Purchaser name', data.customer?.name || '');
  setText(form, 'Purchaser telephone', data.customer?.phone || '');
  setText(form, 'Purchaser street address', address.street);
  setText(form, 'Purchaser city', address.city);
  setText(form, 'Purchaser county', data.vehicle?.county || '');
  setText(form, 'Purchaser state', address.state);
  setText(form, 'Purchaser zip code', address.zip);
  setText(form, 'DA Dealer name', data.dealer?.name || '');
  setText(form, 'DA Dealer number', data.dealer?.number || '');
  checkBox(form, `PA ${data.vehicle?.county}`, true);
}

function fillTc814(form, data) {
  setText(form, 'Make', data.vehicle?.make || '');
  setText(form, 'Year', data.vehicle?.year || '');
  setText(form, 'VIN', data.vehicle?.vin || '');
  setText(form, 'color', data.vehicle?.color || '');
  setText(form, 'Model', data.vehicle?.model || '');
  setText(form, 'Body style', data.vehicle?.unitType || '');
}

function fillBuyersGuide(form, data) {
  const prefix = 'topmostSubform[0].BG-AsIs[0]';
  const answers = data.formAnswers || {};
  setText(form, `${prefix}.VehicleMake[0]`, data.vehicle?.make || '');
  setText(form, `${prefix}.Model[0]`, data.vehicle?.model || '');
  setText(form, `${prefix}.Year[0]`, data.vehicle?.year || '');
  setText(form, `${prefix}.VIN[0]`, data.vehicle?.vin || '');
  selectRadio(form, `${prefix}.Warranty[0]`, 'As Is', answers.buyersGuideSaleType === 'as_is');
  selectRadio(form, `${prefix}.Warranty[0]`, 'Dealer', answers.buyersGuideSaleType === 'dealer_warranty');
  selectRadio(form, `${prefix}.DealerWarranty[0]`, 'Limited', answers.buyersGuideSaleType === 'dealer_warranty');
  checkBox(form, `${prefix}.ServiceContract[0]`, answers.buyersGuideSaleType === 'service_contract');
  setText(form, `${prefix}.SystemsCovered1[0]`, answers.warrantySystems || '');
  setText(form, `${prefix}.Duration1[0]`, answers.warrantyDuration || '');
  setText(form, 'topmostSubform[0].BG-Back[0].DealerName[0]', data.dealer?.name || '');
  setText(form, 'topmostSubform[0].BG-Back[0].DealerEmail[0]', data.dealer?.email || '');
  setText(form, 'topmostSubform[0].BG-Back[0].DealerPhone[0]', data.dealer?.phone || '');
}

router.post('/official-packet', requireAuth, async (req, res) => {
  try {
    const data = req.body || {};
    const bytes = await buildOfficialPacket(data, req);
    const filename = packetFilename(data);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(bytes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Official PDF packet could not be generated yet.' });
  }
});

router.post('/esign', requireAuth, async (req, res) => {
  try {
    const { token, endpoint } = docusealConfig();
    if (!token) {
      return res.status(501).json({
        error: 'DocuSeal is not configured yet. Set DOCUSEAL_API_KEY on the server, then restart Unit Navigator.',
      });
    }

    const data = req.body || {};
    const buyerEmail = signerEmail(data.customer?.email);
    const dealerEmail = signerEmail(data.dealer?.email || dealerFromDb(req).email);
    if (!buyerEmail) return res.status(400).json({ error: 'Buyer email is required before sending for e-signature.' });
    if (!dealerEmail) return res.status(400).json({ error: 'Dealer email is required before sending for e-signature.' });

    const pdf = await buildOfficialPacket(data, req);
    const filename = packetFilename(data);
    const submitters = [
      { role: 'Buyer', name: signerName(data.customer?.name, 'Buyer'), email: buyerEmail },
      { role: 'Dealer', name: signerName(data.dealer?.representativeName || data.dealer?.displayName || data.dealer?.name, 'Dealer'), email: dealerEmail },
    ];
    const payload = {
      name: `${vehicleLabel(data) || 'Vehicle'} Deal Packet`,
      send_email: true,
      documents: [{
        name: filename,
        file: pdf.toString('base64'),
        fields: esignFields(data),
      }],
      submitters,
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': token,
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('DocuSeal error', response.status, body);
      return res.status(502).json({ error: body.error || body.message || `DocuSeal returned HTTP ${response.status}` });
    }

    res.status(201).json({
      message: 'E-sign packet sent through DocuSeal.',
      provider: 'docuseal',
      signing_url: firstUrl(body),
      response: body,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'E-sign packet could not be created.' });
  }
});

module.exports = router;
