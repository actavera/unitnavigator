'use strict';
const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { requireAuth, requirePermission } = require('../middleware/auth');
const db = require('../database');
const { safeFetch, readBodyWithLimit, releaseResponse } = require('../services/safeFetch');

const manifestPath = path.join(__dirname, '..', 'public', 'forms', 'originals', 'manifest.json');
const originalsDir = path.join(__dirname, '..', 'public', 'forms', 'originals');
const esignArchiveDir = path.join(db.dataDir, 'esign-archives');

// Applied to every request to our own configured Stirling/DocuSeal
// endpoints — an unreachable or hung provider must never hang the request
// that's waiting on it indefinitely. The timer must stay armed through full
// response-body consumption, not just until headers arrive: a provider that
// sends a 200 immediately and then stalls (or streams forever) is just as
// broken as one that never responds at all. Overridable via env var so
// tests can use a short timeout instead of waiting out the real one.
const PROVIDER_REQUEST_TIMEOUT_MS = Number(process.env.UNITNAV_PROVIDER_TIMEOUT_MS) || 20000;
// Provider JSON responses (submission create/status) should always be small;
// this bounds how much we'll ever buffer before parsing.
const MAX_PROVIDER_JSON_BYTES = 5 * 1024 * 1024;
// A flattened packet from Stirling is a real multi-page PDF with embedded
// government forms — allow generously more than the archive/photo caps.
const MAX_PROVIDER_PDF_BYTES = 50 * 1024 * 1024;

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

function isAbortError(err) {
  return err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
}

function parseJsonLoosely(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return {};
  }
}

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
  const token = process.env.DOCUSEAL_API_KEY || '';
  const baseUrl = String(process.env.DOCUSEAL_BASE_URL || 'https://api.docuseal.com').replace(/\/$/, '');
  return { token, baseUrl };
}

function requireDocusealConfig() {
  const config = docusealConfig();
  if (!config.token) {
    throw Object.assign(new Error('DocuSeal is not configured yet. Set DOCUSEAL_API_KEY on the server, then restart Unit Navigator.'), { statusCode: 501 });
  }
  return config;
}

function stirlingConfig() {
  return {
    baseUrl: String(process.env.STIRLING_PDF_URL || '').replace(/\/$/, ''),
    apiKey: process.env.STIRLING_PDF_API_KEY || '',
  };
}

async function preparePacketWithStirling(pdf, filename) {
  const { baseUrl, apiKey } = stirlingConfig();
  if (!baseUrl) {
    throw new Error('Stirling PDF is not configured. Set STIRLING_PDF_URL on the server.');
  }

  const form = new FormData();
  form.append('fileInput', new Blob([pdf], { type: 'application/pdf' }), filename);
  form.append('flattenOnlyForms', 'true');
  const headers = apiKey ? { 'X-API-KEY': apiKey } : {};
  const { signal, cancel } = withTimeout(PROVIDER_REQUEST_TIMEOUT_MS);
  // The timer stays armed for the entire call, including body consumption
  // below — cancel() only runs once in the outer finally, after everything
  // has either completed or thrown.
  try {
    const response = await fetch(`${baseUrl}/api/v1/misc/flatten`, {
      method: 'POST',
      headers,
      body: form,
      signal,
    });
    if (!response.ok) {
      const detailBuf = await readBodyWithLimit(response, MAX_PROVIDER_JSON_BYTES).catch(() => Buffer.alloc(0));
      const detail = detailBuf.toString('utf8');
      throw new Error(`Stirling PDF returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`);
    }
    return await readBodyWithLimit(response, MAX_PROVIDER_PDF_BYTES);
  } catch (err) {
    if (isAbortError(err)) throw new Error('Stirling PDF did not respond in time.');
    throw err;
  } finally {
    cancel();
  }
}

function signerName(value, fallback) {
  return String(value || '').trim() || fallback;
}

function signerEmail(value) {
  return String(value || '').trim();
}

// Coordinates (in PDF points, y measured from the bottom like pdf-lib) of the
// signature/date boxes on the official packet, positioned just above the
// hand-drawn signature lines on addPurchaseAgreementPageFour (paperwork.js).
// `page` is the ABSOLUTE 1-indexed page of the merged packet returned by
// buildOfficialPacket, not that sub-section's own "Page 4" label printed on
// the sheet: createCustomPages() emits, in order, 1 insurance page + 4
// purchase-agreement pages, so the purchase agreement's own "page 4" (the
// signature page) lands at absolute page 5. This was previously hardcoded
// as page 4, which is the trade-in page, not the signature page — verified
// against a rendered copy of the actual generated packet (see
// test/paperwork-esign-coordinates.test.js) rather than assumed.
const SIGNATURE_PAGE = 5;

function esignFieldAreas() {
  return [
    { name: 'Buyer Signature', type: 'signature', role: 'Buyer', area: { page: SIGNATURE_PAGE, x: 42, y: 410, w: 230, h: 24 } },
    { name: 'Buyer Date', type: 'date', role: 'Buyer', area: { page: SIGNATURE_PAGE, x: 292, y: 410, w: 100, h: 24 } },
    { name: 'Dealer Signature', type: 'signature', role: 'Dealer', area: { page: SIGNATURE_PAGE, x: 42, y: 300, w: 300, h: 24 } },
    { name: 'Dealer Date', type: 'date', role: 'Dealer', area: { page: SIGNATURE_PAGE, x: 370, y: 300, w: 120, h: 24 } },
  ];
}

// DocuSeal areas are fractions (0-1) of the page's own width/height, with
// page numbers 1-indexed — unlike Documenso's 0-100 percentages, but the
// same top-left-origin geometry, so only the scale changes.
function toDocusealArea(pageWidthPt, pageHeightPt, area) {
  const yTop = pageHeightPt - area.y - area.h;
  return {
    page: area.page,
    x: area.x / pageWidthPt,
    y: yTop / pageHeightPt,
    w: area.w / pageWidthPt,
    h: area.h / pageHeightPt,
  };
}

async function docusealFields(pdf) {
  const doc = await PDFDocument.load(pdf);
  return esignFieldAreas().map(field => {
    const page = doc.getPage(field.area.page - 1);
    const { width, height } = page.getSize();
    return {
      name: field.name,
      type: field.type,
      role: field.role,
      required: true,
      areas: [toDocusealArea(width, height, field.area)],
    };
  });
}

function firstUrl(value) {
  if (!value || typeof value !== 'object') return '';
  const preferred = ['signingUrl', 'signing_url', 'url', 'slug', 'embed_src', 'submission_url', 'submitter_url'];
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

function submissionIdFrom(value) {
  if (!value || typeof value !== 'object') return '';
  const id = value.id;
  return id !== undefined && id !== null ? String(id).trim() : '';
}

function dealIdFrom(data) {
  const id = Number(data.dealId || data.deal_id || data.deal?.id || 0);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function signerSummary(submitters) {
  return JSON.stringify(submitters.map(signer => ({
    role: signer.role,
    name: signer.name,
    email: signer.email,
  })));
}

// DocuSeal responses can carry document/audit/embed/signing URLs — some of
// them signing tokens in disguise (e.g. a submitter's `slug`, which alone
// grants access to sign). None of that belongs in permanent storage. This is
// a strict ALLOWLIST of durable, non-secret fields; anything not explicitly
// copied here — including the entire response, if its shape is unexpected —
// is dropped, never passed through.
function sanitizeSubmitterForStorage(submitter) {
  if (!submitter || typeof submitter !== 'object') return null;
  const out = {};
  if (typeof submitter.role === 'string') out.role = submitter.role;
  if (typeof submitter.status === 'string') out.status = submitter.status;
  for (const key of ['sent_at', 'opened_at', 'completed_at', 'declined_at']) {
    if (typeof submitter[key] === 'string') out[key] = submitter[key];
  }
  if (typeof submitter.decline_reason === 'string') out.decline_reason = submitter.decline_reason;
  return out;
}

function sanitizeDocusealResponseForStorage(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const out = {};
  if (typeof payload.id === 'number' || typeof payload.id === 'string') out.id = payload.id;
  if (typeof payload.status === 'string') out.status = payload.status;
  for (const key of ['created_at', 'completed_at', 'declined_at']) {
    if (typeof payload[key] === 'string') out[key] = payload[key];
  }
  if (typeof payload.decline_reason === 'string') out.decline_reason = payload.decline_reason;
  if (Array.isArray(payload.submitters)) {
    out.submitters = payload.submitters.map(sanitizeSubmitterForStorage).filter(Boolean);
  }
  return out;
}

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;

// dealerInfo must always be the server-side dealerFromDb(req) result — never
// anything sourced from the request body — so the countersigner's identity
// can't be spoofed by whoever calls this route.
async function createDocusealSubmission(pdf, filename, data, dealerInfo) {
  const { token, baseUrl } = requireDocusealConfig();

  const buyerEmail = signerEmail(data.customer?.email);
  const buyerName = signerName(data.customer?.name, 'Buyer');
  // The legal countersigner must be the dealership's designated
  // representative — never the dealership's general contact email/name, even
  // as a fallback. If the dealership hasn't configured a representative
  // name+email, this must fail loudly rather than silently sign as "Dealer"
  // via a generic mailbox.
  const dealerEmail = signerEmail(dealerInfo.representativeEmail);
  const dealerName = signerName(dealerInfo.representativeName, '');
  if (!buyerEmail) throw Object.assign(new Error('Buyer email is required before sending for e-signature.'), { statusCode: 400 });
  if (!dealerName || !dealerEmail) {
    throw Object.assign(new Error('Dealership does not have a representative name and email configured for e-signature. Set both in dealership settings.'), { statusCode: 400 });
  }

  const fields = await docusealFields(pdf);
  const title = `${vehicleLabel(data) || 'Vehicle'} Deal Packet`;

  const payload = {
    name: title,
    // "preserved": submitter order in the array below IS the signing order,
    // and DocuSeal withholds the next signer's notification until the
    // previous one completes — the customer (index 0) signs before the
    // dealership representative (index 1) is ever notified.
    order: 'preserved',
    send_email: true,
    documents: [
      {
        name: filename,
        file: pdf.toString('base64'),
        fields,
      },
    ],
    submitters: [
      { name: buyerName, email: buyerEmail, role: 'Buyer' },
      { name: dealerName, email: dealerEmail, role: 'Dealer' },
    ],
  };

  const { signal, cancel } = withTimeout(PROVIDER_REQUEST_TIMEOUT_MS);
  let created;
  try {
    const response = await fetch(`${baseUrl}/submissions/pdf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token },
      body: JSON.stringify(payload),
      signal,
    });
    const buf = await readBodyWithLimit(response, MAX_PROVIDER_JSON_BYTES);
    created = parseJsonLoosely(buf);
    if (!response.ok) {
      throw Object.assign(new Error(created.error || created.message || `DocuSeal returned HTTP ${response.status}`), { statusCode: 502, providerResponse: created });
    }
  } catch (err) {
    if (isAbortError(err)) throw Object.assign(new Error('DocuSeal did not respond in time.'), { statusCode: 504 });
    throw err;
  } finally {
    cancel();
  }

  const submissionId = submissionIdFrom(created);
  if (!submissionId) {
    throw Object.assign(new Error('DocuSeal did not return a submission id.'), { statusCode: 502, providerResponse: created });
  }

  return { title, submissionId, submitters: payload.submitters, created, signingUrl: firstUrl(created) };
}

async function docusealSubmissionStatus(submissionId) {
  const { token, baseUrl } = requireDocusealConfig();
  const { signal, cancel } = withTimeout(PROVIDER_REQUEST_TIMEOUT_MS);
  let body;
  try {
    const response = await fetch(`${baseUrl}/submissions/${encodeURIComponent(submissionId)}`, {
      headers: { 'X-Auth-Token': token },
      signal,
    });
    const buf = await readBodyWithLimit(response, MAX_PROVIDER_JSON_BYTES);
    body = parseJsonLoosely(buf);
    if (!response.ok) throw Object.assign(new Error(body.error || body.message || `DocuSeal returned HTTP ${response.status}`), { statusCode: 502, providerResponse: body });
  } catch (err) {
    if (isAbortError(err)) throw Object.assign(new Error('DocuSeal did not respond in time.'), { statusCode: 504 });
    throw err;
  } finally {
    cancel();
  }
  return body;
}

const DOWNLOAD_TIMEOUT_MS = Number(process.env.UNITNAV_PROVIDER_TIMEOUT_MS) || 20000;

// DocuSeal's document/audit-log URLs are provider-returned data, not our own
// configured endpoint — a compromised or malformed provider response must
// not be able to turn this into an SSRF vector. Routed through the same
// safeFetch/readBodyWithLimit guard used for arbitrary user-supplied URLs
// elsewhere (DNS-rebinding-safe, size-limited, redirect-revalidated).
async function downloadProviderFile(url, maxBytes) {
  const { signal, cancel } = withTimeout(DOWNLOAD_TIMEOUT_MS);
  let response;
  try {
    response = await safeFetch(url, { signal });
  } catch (err) {
    cancel();
    if (isAbortError(err)) throw new Error('Timed out downloading a file from DocuSeal.');
    throw err;
  }
  try {
    if (!response.ok) {
      throw new Error(`DocuSeal returned HTTP ${response.status} downloading a file`);
    }
    return await readBodyWithLimit(response, maxBytes);
  } catch (err) {
    if (!response.ok) await releaseResponse(response).catch(() => {});
    if (isAbortError(err)) throw new Error('Timed out downloading a file from DocuSeal.');
    throw err;
  } finally {
    cancel();
  }
}

// fs.existsSync is true for directories too; the idempotency check must
// only ever treat an actual, previously-written file as "already archived".
function isRegularFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function cleanupArchiveFiles(paths) {
  for (const p of paths) {
    if (!p) continue;
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch { /* best-effort cleanup */ }
  }
}

// All-or-nothing: a completed submission archives BOTH the signed document
// AND the audit log, or neither. Both are downloaded fully into memory
// first, written to temp files, then committed into their final location
// with a no-clobber fs.linkSync (never fs.renameSync, which would silently
// overwrite) only once both writes succeed — so a failure partway through
// never leaves a permanent archive with just one of the two files, and
// never overwrites a pre-existing or concurrently-created file. Never marks
// anything complete/archived on a provider failure: if the status check, either
// download, or either write throws, this function throws too, and the
// caller (the /esign/:id/status route) leaves the existing DB row untouched.
async function archiveDocusealSubmission(submissionId, dealershipId, { download = downloadProviderFile } = {}) {
  const submission = await docusealSubmissionStatus(submissionId);
  if (String(submission.status || '').toLowerCase() !== 'completed') return { submission };

  const safeId = String(submissionId).replace(/[^a-z0-9_-]+/gi, '-');
  const docFilename = `${dealershipId}-${safeId}.pdf`;
  const auditFilename = `${dealershipId}-${safeId}-audit.pdf`;
  const docFinalPath = path.join(esignArchiveDir, docFilename);
  const auditFinalPath = path.join(esignArchiveDir, auditFilename);
  const relativeArchivePath = path.join('data', 'esign-archives', docFilename);
  const relativeAuditLogPath = path.join('data', 'esign-archives', auditFilename);

  const docExists = isRegularFile(docFinalPath);
  const auditExists = isRegularFile(auditFinalPath);

  // Idempotent: a previous status check may have already archived this
  // submission. Never re-download or re-touch those files — hand back the
  // paths that are already there, byte-for-byte untouched.
  if (docExists && auditExists) {
    return { submission, archivePath: relativeArchivePath, auditLogPath: relativeAuditLogPath };
  }

  // Exactly one final file already exists: an inconsistent partial archive
  // left over from some prior attempt (e.g. a process killed mid-archive
  // before this idempotent-retry/no-clobber logic existed). Never guess at
  // "fixing" this automatically — that risks silently discarding whichever
  // half is actually the valid one. Leave both untouched, download nothing,
  // and surface a clear error for a human to resolve.
  if (docExists !== auditExists) {
    throw Object.assign(
      new Error(
        `This submission has an inconsistent partial archive on disk (the ${docExists ? 'signed document exists but the audit log is missing' : 'audit log exists but the signed document is missing'}). ` +
        'Automatic archival has stopped rather than risk overwriting or losing a file — this needs manual review of the esign-archives directory before it can proceed.',
      ),
      { statusCode: 409, retryable: false, needsManualRecovery: true },
    );
  }

  // Neither exists: proceed with a normal first-time archive.
  const documentUrl = submission.combined_document_url;
  const auditLogUrl = submission.audit_log_url;
  if (!documentUrl || !auditLogUrl) {
    throw Object.assign(
      new Error('DocuSeal reported this submission as completed but did not return both a signed-document URL and an audit-log URL. This is retryable — check status again shortly.'),
      { statusCode: 502, retryable: true },
    );
  }

  // Fetch fresh copies of both now; neither is ever stored anywhere as a URL
  // — only the bytes, written to our own local archive below.
  const docBuffer = await download(documentUrl, MAX_ARCHIVE_BYTES);
  const auditBuffer = await download(auditLogUrl, MAX_ARCHIVE_BYTES);

  fs.mkdirSync(esignArchiveDir, { recursive: true });
  const uniqueSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const docTempPath = `${docFinalPath}.tmp-${uniqueSuffix}`;
  const auditTempPath = `${auditFinalPath}.tmp-${uniqueSuffix}`;

  // fs.linkSync is a hard no-clobber commit: unlike fs.renameSync, it fails
  // (EEXIST) rather than silently overwriting if the final path already
  // exists — including if something raced to create it between the
  // existence check above and this attempt. The temp file is then unlinked,
  // leaving the final path as a second hard link to the same bytes (atomic
  // on the same filesystem, which esignArchiveDir always is here).
  let docLinked = false;
  let auditLinked = false;
  try {
    fs.writeFileSync(docTempPath, docBuffer);
    fs.writeFileSync(auditTempPath, auditBuffer);
    fs.linkSync(docTempPath, docFinalPath);
    docLinked = true;
    fs.unlinkSync(docTempPath);
    fs.linkSync(auditTempPath, auditFinalPath);
    auditLinked = true;
    fs.unlinkSync(auditTempPath);
  } catch (err) {
    // Remove only what THIS attempt created: docFinalPath only if we
    // ourselves just linked it, auditFinalPath only if we ourselves just
    // linked it (e.g. the final fs.unlinkSync(auditTempPath) can still
    // throw *after* the audit link already succeeded — that must not leave
    // an audit-only partial archive behind) — never a pre-existing file or
    // a concurrent collision winner (the no-clobber link above would have
    // thrown before either flag was set, had one already existed there),
    // plus any leftover temp files from this attempt, best-effort.
    if (docLinked) cleanupArchiveFiles([docFinalPath]);
    if (auditLinked) cleanupArchiveFiles([auditFinalPath]);
    cleanupArchiveFiles([docTempPath, auditTempPath]);
    throw Object.assign(
      new Error(`Could not write the signed document/audit log archive to disk: ${err.message}`),
      { statusCode: 500, retryable: true },
    );
  }

  return { submission, archivePath: relativeArchivePath, auditLogPath: relativeAuditLogPath };
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
    // Deliberately separate from `email` (the dealership's general contact
    // address): the e-sign countersigner must be a specific person the
    // dealership has designated for that role, never a generic mailbox.
    representativeEmail: row.representative_email || '',
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

router.post('/official-packet', ...requirePermission('contracts_manage'), async (req, res) => {
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

router.post('/esign', ...requirePermission('contracts_manage'), async (req, res) => {
  try {
    const data = req.body || {};
    // The countersigner's name/email come exclusively from the authenticated
    // dealership's own row in the database — dealerInfo is never derived from
    // req.body, so a request body attempting to override the dealer's name or
    // email for signing purposes has no effect. data.dealer is still merged
    // (dealerInfo last, so it always wins) purely for template rendering
    // fields like address/phone shown on the packet itself.
    const dealerInfo = dealerFromDb(req);
    data.dealer = { ...(data.dealer || {}), ...dealerInfo };
    requireDocusealConfig();

    const buyerEmail = signerEmail(data.customer?.email);
    if (!buyerEmail) return res.status(400).json({ error: 'Buyer email is required before sending for e-signature.' });
    if (!signerName(dealerInfo.representativeName, '') || !signerEmail(dealerInfo.representativeEmail)) {
      return res.status(400).json({ error: 'Dealership does not have a representative name and email configured for e-signature. Set both in dealership settings before sending for e-signature.' });
    }

    const unpreparedPdf = await buildOfficialPacket(data, req);
    const filename = packetFilename(data);
    const pdf = await preparePacketWithStirling(unpreparedPdf, filename);
    const submission = await createDocusealSubmission(pdf, filename, data, dealerInfo);
    const insert = db.prepare(`
      INSERT INTO esign_envelopes (
        dealership_id, deal_id, provider, provider_envelope_id, title, status,
        signer_summary, signing_url, provider_response, created_by
      ) VALUES (?, ?, 'docuseal', ?, ?, 'pending', ?, ?, ?, ?)
    `).run(
      req.user.dealership_id,
      dealIdFrom(data),
      submission.submissionId,
      submission.title,
      signerSummary(submission.submitters),
      // The DocuSeal embed/signing URL is a live signing token — never
      // persisted, here or anywhere else. It's returned once, below, in this
      // response only, for the "open signing link now" immediate UX.
      null,
      JSON.stringify({ created: sanitizeDocusealResponseForStorage(submission.created) }),
      req.user.id,
    );

    res.status(201).json({
      message: 'E-sign packet sent through DocuSeal.',
      provider: 'docuseal',
      envelope_id: insert.lastInsertRowid,
      provider_submission_id: submission.submissionId,
      signing_url: submission.signingUrl,
      response: { created: sanitizeDocusealResponseForStorage(submission.created) },
    });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || 'E-sign packet could not be created.' });
  }
});

router.get('/esign/:id/status', ...requirePermission('contracts_manage'), async (req, res) => {
  const row = db.prepare(`
    SELECT * FROM esign_envelopes
    WHERE id = ? AND dealership_id = ?
  `).get(req.params.id, req.user.dealership_id);
  if (!row) return res.status(404).json({ error: 'E-sign envelope not found.' });

  // This record predates the DocuSeal migration (or was created by some
  // other integration). Its provider_envelope_id is not a DocuSeal
  // submission id, so it must never be sent to the DocuSeal API.
  if (row.provider !== 'docuseal') {
    return res.status(409).json({
      error: `This e-sign record was created with a legacy provider ("${row.provider}") that Unit Navigator no longer integrates with. It must be checked or migrated separately.`,
      provider: row.provider,
    });
  }

  try {
    const archived = await archiveDocusealSubmission(row.provider_envelope_id, req.user.dealership_id);
    const providerStatus = String(archived.submission?.status || row.status || '').toLowerCase();
    const completedAt = archived.submission?.completed_at || row.completed_at;
    db.prepare(`
      UPDATE esign_envelopes
      SET status = ?,
          archive_path = COALESCE(?, archive_path),
          audit_log_path = COALESCE(?, audit_log_path),
          provider_response = ?,
          completed_at = COALESCE(?, completed_at),
          archived_at = CASE WHEN ? IS NOT NULL AND archived_at IS NULL THEN datetime('now') ELSE archived_at END
      WHERE id = ? AND dealership_id = ?
    `).run(
      providerStatus,
      archived.archivePath || null,
      archived.auditLogPath || null,
      JSON.stringify(sanitizeDocusealResponseForStorage(archived.submission)),
      completedAt || null,
      archived.archivePath || null,
      row.id,
      req.user.dealership_id,
    );

    res.json({
      id: row.id,
      provider: 'docuseal',
      provider_submission_id: row.provider_envelope_id,
      status: providerStatus,
      completed_at: completedAt || null,
      archived: Boolean(archived.archivePath || row.archive_path),
      archive_path: archived.archivePath || row.archive_path || null,
      audit_log_path: archived.auditLogPath || row.audit_log_path || null,
      response: sanitizeDocusealResponseForStorage(archived.submission),
    });
  } catch (err) {
    console.error(err);
    res.status(err.statusCode || 500).json({ error: err.message || 'E-sign status could not be checked.' });
  }
});

module.exports = router;
module.exports.preparePacketWithStirling = preparePacketWithStirling;
module.exports.toDocusealArea = toDocusealArea;
module.exports.createDocusealSubmission = createDocusealSubmission;
module.exports.buildOfficialPacket = buildOfficialPacket;
module.exports.esignFieldAreas = esignFieldAreas;
module.exports.archiveDocusealSubmission = archiveDocusealSubmission;
module.exports.downloadProviderFile = downloadProviderFile;
module.exports.sanitizeDocusealResponseForStorage = sanitizeDocusealResponseForStorage;
