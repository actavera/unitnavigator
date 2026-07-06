'use strict';
const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const { requireAuth } = require('../middleware/auth');

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
  setText(form, ['line 4-a', 'line 4a'], moneyValue(pricing.docFee));
  setText(form, 'line 5', moneyValue((pricing.salesTax || 0) + (pricing.fees || 0)));
  setText(form, 'line 8a', moneyValue(pricing.downPayment));
  setText(form, 'line 8b', moneyValue(pricing.trade));
  setText(form, 'line 9', moneyValue(pricing.amountFinanced));
}

function fillTc656(form, data) {
  const address = splitAddress(data.customer?.address);
  checkBox(form, ['new title', 'Registration', 'change of ownership'], true);
  setText(form, 'primary owner name', data.customer?.name || '');
  setText(form, "primary owner's email", data.customer?.email || '');
  setText(form, ["primary owner's I.D. number", "primary owner's I.D"], data.customer?.idNumber || '');
  setText(form, "primary owner's address", address.street);
  setText(form, "primary owner's city", address.city);
  setText(form, "primary owner's state", address.state);
  setText(form, "primary owner's zip code", address.zip);
  setText(form, 'co-owner name 1', data.customer?.coBuyer || '');
  setText(form, 'year', data.vehicle?.year || '');
  setText(form, 'make', data.vehicle?.make || '');
  setText(form, 'model', data.vehicle?.model || '');
  setText(form, 'color', data.vehicle?.color || '');
  setText(form, 'VIN', data.vehicle?.vin || '');
  setText(form, 'fuel', data.vehicle?.fuel || '');
  setText(form, 'body type', data.vehicle?.unitType || '');
}

function fillTc891(form, data) {
  const address = splitAddress(data.customer?.address);
  setText(form, 'Year', data.vehicle?.year || '');
  setText(form, 'Make', data.vehicle?.make || '');
  setText(form, 'Model', data.vehicle?.model || '');
  setText(form, 'VIN', data.vehicle?.vin || '');
  setText(form, 'Reading', data.vehicle?.mileage || '');
  setText(form, "Transferee's name", data.customer?.name || '');
  setText(form, "Transferee's Address", address.street);
  setText(form, "Transferee's city", address.city);
  setText(form, "Transferee's state", address.state);
  setText(form, "Transferee's  ZIP", address.zip);
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
}

router.post('/official-packet', requireAuth, async (req, res) => {
  try {
    const data = req.body || {};
    const merged = await PDFDocument.create();
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
