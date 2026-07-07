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

  await addSimplePage(pdf, 'Retail Purchase Agreement', [
    ['Buyer', data.customer?.name],
    ['Vehicle', vehicleLabel(data)],
    ['VIN', data.vehicle?.vin],
    ['Sale Price', `$${moneyValue(data.pricing?.salePrice)}`],
    ['Fees', `$${moneyValue(data.pricing?.fees)}`],
    ['Insurance / GAP / VSI', `$${moneyValue(data.pricing?.insuranceGapVsi)}`],
    ['Accessories', `${data.formAnswers?.accessoriesDescription || '-'} $${moneyValue(data.pricing?.accessories)}`],
    ['Products', `${data.formAnswers?.productsDescription || '-'} $${moneyValue(data.pricing?.products)}`],
    ['Tax', `$${moneyValue(data.pricing?.salesTax)}`],
    ['Down Payment', `$${moneyValue(data.pricing?.downPayment)}`],
    ['Trade-In', `$${moneyValue(data.pricing?.trade)}`],
    ['Balance / Amount Financed', `$${moneyValue(data.pricing?.amountFinanced)}`],
    ['Payment Type', data.packetType],
  ], 'Purchase agreement language and final dealer-approved terms should be reviewed before live use. This page is a dealer packet template until the dealer-specific original PDF is supplied.');

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
    const bytes = await merged.save();
    const filename = `${vehicleLabel(data).replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'unit'}-official-packet.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(bytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Official PDF packet could not be generated yet.' });
  }
});

module.exports = router;
