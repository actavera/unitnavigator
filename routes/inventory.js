'use strict';
const router = require('express').Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('../database');
const { requireAuth, requireRole, requirePermission, hasPermission } = require('../middleware/auth');
const { suggestedRetailPrice } = require('../services/pricing');
const { generateVehicleDescription } = require('../services/vehicleDescription');
const { runBulkSuggestions, ListingSuiteError } = require('../services/listingSuite');
const importHistory = require('../services/importHistory');
const inventoryTruth = require('../services/inventoryTruth');
const { csvCell } = require('../services/csv');
const { safeFetch, readBodyWithLimit, releaseResponse } = require('../services/safeFetch');
const { resolveUploadPath } = require('../services/uploads');
const { finalizeUploadedImages } = require('../services/imageSignature');

const uploadDir = path.join(__dirname, '../public/uploads/units');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const dealerCenterSftpRoot = process.env.DEALERCENTER_SFTP_ROOT || '/sftp';

const storage = multer.diskStorage({
  destination: uploadDir,
  // A neutral, server-generated temp name: the caller's original filename
  // (and its extension) is never trusted or retained. Once the real content
  // is inspected, finalizeUploadedImages() renames this to its permanent
  // name with an extension taken solely from the detected image type.
  filename: (_req, _file, cb) => cb(null, `tmp-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.upload`),
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)) return cb(null, true);
    cb(new Error('Photos must be a PNG, JPG, WEBP, or GIF image'));
  },
});

const REPAIR_STATUSES = new Set(['searching','ordered','working','completed']);
const PRICING_FIELDS = new Set([
  'acquisition_cost',
  'transport_cost',
  'repair_cost',
  'repair_items',
  'detail_cost',
  'other_cost',
  'asking_price',
  'minimum_price',
  'sold_price',
]);

function parseRepairItems(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const cleaned = String(value ?? '').replace(/[^0-9.-]/g, '');
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseInteger(value) {
  const parsed = Number(String(value ?? '').replace(/[^0-9-]/g, ''));
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function normalizeVin(value) {
  return cleanText(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizePhotos(value) {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  const text = cleanText(value);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(cleanText).filter(Boolean);
  } catch {}
  return text.split(/[\n;,|]+/).map(cleanText).filter(Boolean);
}

const STAGE_MAP = {
  acquired: 'acquired',
  atauction: 'acquired',
  auction: 'acquired',
  transport: 'transport',
  transported: 'transport',
  beingtransported: 'transport',
  screening: 'screening',
  needsscreening: 'screening',
  recon: 'recon',
  reconditioning: 'recon',
  ready: 'ready',
  readytosell: 'ready',
  available: 'ready',
  active: 'ready',
  pending: 'pending',
  sold: 'sold',
  archived: 'archived',
};
// '' when the status is blank or not one we recognize. Imports use this so an
// unknown feed status never changes the stage of a unit that already exists.
function recognizeStage(value) {
  const compact = cleanText(value).toLowerCase().replace(/[^a-z0-9]/g, '');
  return STAGE_MAP[compact] || '';
}
function normalizeStage(value) {
  return recognizeStage(value) || 'ready';
}

function normalizeRepairItems(value) {
  return parseRepairItems(value).map(item => {
    const description = String(item.description || item.repair_needed || item.name || '').trim();
    const cost = parseMoney(item.cost);
    const status = REPAIR_STATUSES.has(item.status) ? item.status : 'searching';
    return { description, cost: Math.max(0, cost), status };
  }).filter(item => item.description || item.cost);
}

function repairItemsTotal(items) {
  return items.reduce((sum, item) => sum + parseMoney(item.cost), 0);
}

function totalCost(u) {
  const repairItems = parseRepairItems(u.repair_items);
  const repairCost = repairItems.length ? repairItemsTotal(repairItems) : (u.repair_cost || 0);
  return (u.acquisition_cost || 0) + (u.transport_cost || 0) +
    repairCost + (u.detail_cost || 0) + (u.other_cost || 0);
}

function enrichUnit(u) {
  const tc = totalCost(u);
  const repairItems = parseRepairItems(u.repair_items);
  const repairCost = repairItems.length ? repairItemsTotal(repairItems) : (u.repair_cost || 0);
  return {
    ...u,
    photos: JSON.parse(u.photos || '[]'),
    repair_items: repairItems,
    repair_cost: repairCost,
    total_cost: tc,
    estimated_gross: u.asking_price != null ? u.asking_price - tc : null,
    actual_gross: u.sold_price != null ? u.sold_price - tc : null,
  };
}

function logActivity(dealership_id, entity_id, action, note, user_id) {
  db.prepare(`INSERT INTO activity_logs (dealership_id, entity_type, entity_id, action, note, user_id)
    VALUES (?, 'unit', ?, ?, ?, ?)`).run(dealership_id, entity_id, action, note, user_id);
}

function capturePlatformSoldUnit(unit) {
  inventoryTruth.capturePlatformSoldUnit(db, unit);
}

const VALID_STAGES = ['acquired','transport','screening','recon','ready','pending','sold','archived'];
// Sold and archived are reached only by recording a structured disposition
// (POST /api/inventory/:id/disposition), never by setting the stage directly.
const DISPOSITION_REQUIRED = {
  error: 'Record a disposition to mark a vehicle sold or remove it from inventory.',
  code: 'disposition_required',
};
const STAGE_LABELS = {
  acquired: 'At Auction',
  transport: 'Being Transported',
  screening: 'Needs Screening',
  recon: 'Recon',
  ready: 'Ready',
  pending: 'Pending',
  sold: 'Sold',
  archived: 'Archived',
};

const DEFAULT_FETCH_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

function absoluteUrl(value, baseUrl) {
  const text = cleanText(value);
  if (!text || text.startsWith('data:') || text.startsWith('blob:')) return '';
  try {
    return new URL(text, baseUrl).href;
  } catch {
    return '';
  }
}

function isUnsafeFetchHost(hostname) {
  const host = cleanText(hostname).toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0' || host === '127.0.0.1' || host === '::1') return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [, a, b] = ipv4.map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

function normalizeMatchValue(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function decodeHtmlEntities(value) {
  return cleanText(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function likelyVehicleImage(url) {
  const text = cleanText(url).toLowerCase();
  if (!/^https?:\/\//.test(text)) return false;
  if (!/\.(jpe?g|png|webp)(\?|#|$)/.test(text) && !/(image|photo|inventory|vehicle|cdn|cloudfront|dealercenter)/.test(text)) return false;
  return !/(logo|favicon|sprite|icon|placeholder|noimage|transparent|blank|avatar|ads?|banner)/.test(text);
}

function extractImageUrls(html, pageUrl) {
  const urls = new Set();
  const attrPattern = /\b(?:src|data-src|data-original|data-lazy|data-full|data-image|data-url|content)=["']([^"']+)["']/gi;
  let match;
  while ((match = attrPattern.exec(html))) {
    const url = absoluteUrl(decodeHtmlEntities(match[1]), pageUrl);
    if (likelyVehicleImage(url)) urls.add(url);
  }

  const srcsetPattern = /\b(?:srcset|data-srcset)=["']([^"']+)["']/gi;
  while ((match = srcsetPattern.exec(html))) {
    decodeHtmlEntities(match[1]).split(',').forEach(part => {
      const url = absoluteUrl(part.trim().split(/\s+/)[0], pageUrl);
      if (likelyVehicleImage(url)) urls.add(url);
    });
  }

  return [...urls];
}

function extractPageLinks(html, pageUrl, origin) {
  const links = new Set();
  const pattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const url = absoluteUrl(decodeHtmlEntities(match[1]), pageUrl);
    if (!url) continue;
    const parsed = new URL(url);
    if (parsed.origin !== origin) continue;
    const text = parsed.href.toLowerCase();
    if (/(inventory|vehicle|details|autos?|cars?|stock|vin)/.test(text)) links.add(parsed.href);
  }
  return [...links];
}

function extractVehicleCandidate(html, pageUrl) {
  const plain = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const decoded = decodeHtmlEntities(plain).replace(/\s+/g, ' ');
  const vin = (decoded.match(/\b[A-HJ-NPR-Z0-9]{17}\b/i) || [])[0] || '';
  const stock = (
    decoded.match(/\b(?:stock|stk|stock\s*#)\s*[:#]?\s*([A-Z0-9-]{3,24})\b/i) || []
  )[1] || '';
  const title = (
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || []
  )[1] || '';
  const images = extractImageUrls(html, pageUrl);
  return {
    page_url: pageUrl,
    vin: normalizeVin(vin),
    stock_number: cleanText(stock),
    title: decodeHtmlEntities(title),
    images,
  };
}

const MAX_CRAWL_HTML_BYTES = 5 * 1024 * 1024;
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 14000);
  try {
    const response = await safeFetch(url, {
      headers: DEFAULT_FETCH_HEADERS,
      signal: controller.signal,
    });
    let text = '';
    try {
      text = (await readBodyWithLimit(response, MAX_CRAWL_HTML_BYTES)).toString('utf8');
    } catch {
      text = '';
    }
    return { ok: response.ok, status: response.status, url: response.url || url, text };
  } finally {
    clearTimeout(timeout);
  }
}

function safeImageExtension(contentType, sourceUrl) {
  const type = cleanText(contentType).toLowerCase();
  if (type.includes('png')) return '.png';
  if (type.includes('webp')) return '.webp';
  if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';
  const pathname = (() => {
    try { return new URL(sourceUrl).pathname.toLowerCase(); } catch { return ''; }
  })();
  const ext = path.extname(pathname);
  return ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.jpg';
}

async function saveRemotePhoto(photoUrl, index) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await safeFetch(photoUrl, {
      headers: DEFAULT_FETCH_HEADERS,
      signal: controller.signal,
    });
    if (!response.ok) {
      await releaseResponse(response);
      return '';
    }
    const contentType = response.headers.get('content-type') || '';
    if (contentType && !contentType.toLowerCase().startsWith('image/')) {
      await releaseResponse(response);
      return '';
    }
    let buffer;
    try {
      buffer = await readBodyWithLimit(response, MAX_PHOTO_BYTES);
    } catch {
      return '';
    }
    if (!buffer.length) return '';
    const filename = `${Date.now()}-${index}-${Math.random().toString(16).slice(2)}${safeImageExtension(contentType, response.url || photoUrl)}`;
    fs.writeFileSync(path.join(uploadDir, filename), buffer);
    return `/uploads/units/${filename}`;
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

// `failures`, when given, receives one entry per photo that could not be
// downloaded and so still points at the source site.
async function localizePhotoUrls(photoUrls, failures = null) {
  const urls = normalizePhotos(photoUrls).slice(0, 30);
  const saved = [];
  for (let i = 0; i < urls.length; i += 1) {
    const url = urls[i];
    if (url.startsWith('/uploads/units/')) {
      saved.push(url);
      continue;
    }
    try {
      const localUrl = await saveRemotePhoto(url, i);
      if (!localUrl && failures) failures.push(i);
      saved.push(localUrl || url);
    } catch {
      if (failures) failures.push(i);
      saved.push(url);
    }
  }
  return saved;
}

function scoreCandidateForRow(candidate, row) {
  const vin = normalizeVin(row.vin || row.VIN || row[' Vin']);
  if (vin && candidate.vin === vin) return 100;

  const stock = normalizeMatchValue(row.stock_number || row.stock || row.StockNumber || row[' StockNumber']);
  if (stock && normalizeMatchValue(candidate.stock_number) === stock) return 90;

  const rowText = normalizeMatchValue([
    row.year || row.Year,
    row.make || row.Make,
    row.model || row.Model,
    row.trim || row.Trim,
    row.VehicleInfo || row.vehicle_info,
  ].filter(Boolean).join(' '));
  const candidateText = normalizeMatchValue(candidate.title + ' ' + candidate.page_url);
  if (rowText && candidateText.includes(rowText.slice(0, Math.min(rowText.length, 26)))) return 45;

  return 0;
}

function attachWebsitePhotos(rows, candidates) {
  return rows.map(row => {
    const best = candidates
      .map(candidate => ({ candidate, score: scoreCandidateForRow(candidate, row) }))
      .filter(item => item.score > 0 && item.candidate.images.length)
      .sort((a, b) => b.score - a.score)[0];
    if (!best) return { ...row, website_photo_count: 0, website_match_url: '' };
    return {
      ...row,
      photos: best.candidate.images,
      photo_urls: best.candidate.images.join('\n'),
      website_photo_count: best.candidate.images.length,
      website_match_url: best.candidate.page_url,
    };
  });
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        value += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(value);
      value = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(value);
      if (row.some(cell => cleanText(cell))) rows.push(row);
      row = [];
      value = '';
      continue;
    }

    value += char;
  }

  row.push(value);
  if (row.some(cell => cleanText(cell))) rows.push(row);
  return rows;
}

function csvToObjects(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const headers = rows[0].map(header => cleanText(header).replace(/^\uFEFF/, ''));
  return rows.slice(1).map(row => {
    const object = {};
    headers.forEach((header, index) => {
      object[header] = cleanText(row[index]);
    });
    return object;
  });
}

function firstValue(row, keys) {
  for (const key of keys) {
    if (row[key] != null && cleanText(row[key])) return row[key];
  }
  return '';
}

function splitDealerCenterVehicleInfo(value) {
  const text = cleanText(value);
  const match = text.match(/^(\d{4})\s+([A-Za-z]+)\s+(.+)$/);
  if (!match) return {};
  const [, year, make, rest] = match;
  const parts = rest.split(/\s{2,}| - | \| /).map(cleanText).filter(Boolean);
  const modelTrim = parts[0] || rest;
  const [model, ...trimParts] = modelTrim.split(/\s+/);
  return { year, make, model, trim: trimParts.join(' ') };
}

function mapDealerCenterRow(row) {
  const parsedVehicle = splitDealerCenterVehicleInfo(firstValue(row, ['VehicleInfo', 'Vehicle Info', 'Vehicle']));
  const inventoryStatus = firstValue(row, ['InventoryStatus', 'Inventory Status', 'Status']);
  const saleType = firstValue(row, ['VehicleSaleType', 'Vehicle Sale Type']);
  const notes = [
    saleType && `Sale type: ${saleType}`,
    firstValue(row, ['VDPUrl', 'VDP URL']) && `DealerCenter VDP: ${firstValue(row, ['VDPUrl', 'VDP URL'])}`,
  ].filter(Boolean).join('\n');

  return {
    vin: normalizeVin(firstValue(row, ['VIN', 'Vin', ' Vin'])),
    stock_number: firstValue(row, ['StockNumber', 'Stock Number', 'Stock #', ' StockNumber']),
    year: firstValue(row, ['Year', 'ModelYear']) || parsedVehicle.year,
    make: firstValue(row, ['Make']) || parsedVehicle.make,
    model: firstValue(row, ['Model']) || parsedVehicle.model,
    trim: firstValue(row, ['Trim']) || parsedVehicle.trim,
    body_style: firstValue(row, ['BodyStyle', 'Body Style', 'VehicleType']),
    color: firstValue(row, ['Color', 'ExteriorColor', 'Exterior Color']),
    mileage: firstValue(row, ['Mileage', 'Odometer', 'Miles']),
    stage: recognizeStage(inventoryStatus),
    asking_price: firstValue(row, ['SpecialPrice', 'Special Price', 'AskingPrice', 'Asking Price', 'VehiclePrice', 'Vehicle Price', 'Price']),
    acquisition_cost: firstValue(row, ['Cost', 'VehicleCost', 'Vehicle Cost', 'InventoryCost', 'Inventory Cost']),
    acquisition_source: 'DealerCenter SFTP',
    acquisition_date: firstValue(row, ['DateInStock', 'Date In Stock']),
    notes,
    photos: firstValue(row, ['PhotoURLs', 'Photo URLs', 'PhotoUrls', 'Photos']),
  };
}

function targetDealershipId(req) {
  if (req.user.role === 'super_admin' && req.body.dealership_id) {
    return parseInteger(req.body.dealership_id);
  }
  return req.user.dealership_id;
}

function dealerCenterSftpUsername(dealership) {
  if (cleanText(dealership.dealercenter_sftp_username)) return cleanText(dealership.dealercenter_sftp_username);
  if (dealership.public_slug === 'new-era-auto-sales' || dealership.public_domain === 'utahautoplug.com') return 'dc_newera';
  const slug = cleanText(dealership.public_slug || dealership.name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return slug ? `dc_${slug}` : '';
}

function latestDealerCenterFile(username) {
  if (!username || !/^[a-z0-9_-]+$/i.test(username)) return null;
  const incomingDir = path.join(dealerCenterSftpRoot, username, 'incoming');
  let entries = [];
  try {
    entries = fs.readdirSync(incomingDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && /\.(csv|txt)$/i.test(entry.name))
      .map(entry => {
        const fullPath = path.join(incomingDir, entry.name);
        const stat = fs.statSync(fullPath);
        return { path: fullPath, name: entry.name, size: stat.size, modified_at: stat.mtime.toISOString() };
      })
      .sort((a, b) => new Date(b.modified_at) - new Date(a.modified_at));
  } catch {
    return null;
  }
  return entries[0] || null;
}

function rowIdentity(row, index) {
  const vin = normalizeVin(row.vin || row.VIN || row.vehicle_vin);
  const year = parseInteger(row.year || row.Year || row.model_year);
  return {
    row_number: index + 1,
    stock_number: cleanText(row.stock_number || row.stock || row['Stock #'] || row.stock_no || row.unit_number),
    vin_tail: importHistory.vinTail(vin),
    vehicle: [year || '', cleanText(row.make || row.Make), cleanText(row.model || row.Model)].filter(Boolean).join(' '),
  };
}

// Upserts import rows inside one transaction. Re-importing is deliberately
// conservative about data a dealer may have edited since:
//   - an existing, non-empty description (notes) is never overwritten;
//   - an existing unit's stage only changes for a RECOGNIZED feed status;
//   - a row without a VIN is matched on a unique stock number within the
//     dealership (one match updates it, several are skipped as ambiguous);
//   - a row with neither a VIN nor a stock number cannot be matched, so it is
//     created and a warning explains that re-importing will duplicate it.
// Everything reportable is returned in `errors` (existing shape) and in
// `issues` (structured, with severity and a minimal row identifier).
function persistImportRows(rows, req, dealershipId, source, options = {}) {
  const results = { created: 0, updated: 0, skipped: 0, errors: [], issues: [] };
  const skip = (index, code, message) => {
    results.skipped += 1;
    results.errors.push({ row: index + 1, error: message });
    results.issues.push({ ...rowIdentity(rows[index], index), severity: 'error', code, message });
  };
  const tx = db.transaction(() => {
    rows.forEach((row, index) => {
      const vin = normalizeVin(row.vin || row.VIN || row.vehicle_vin);
      const year = parseInteger(row.year || row.Year || row.model_year);
      const make = cleanText(row.make || row.Make);
      const model = cleanText(row.model || row.Model);
      const trim = cleanText(row.trim || row.Trim);
      const stockNumber = cleanText(row.stock_number || row.stock || row['Stock #'] || row.stock_no || row.unit_number);

      if (!vin && (!year || !make || !model)) {
        skip(index, 'missing_identity', 'Missing VIN or year/make/model');
        return;
      }

      const feedStage = recognizeStage(row.stage || row.status || row.Status);
      const unit = {
        vin,
        stock_number: stockNumber,
        year: year || null,
        make,
        model,
        trim,
        body_style: cleanText(row.body_style || row.body || row.Body || row.vehicle_type),
        color: cleanText(row.color || row.Color || row.exterior_color),
        mileage: parseInteger(row.mileage || row.miles || row.odometer || row.Odometer),
        stage: feedStage || 'ready',
        acquisition_cost: parseMoney(row.acquisition_cost || row.cost || row.Cost || row.inventory_cost || row.purchase_price),
        asking_price: parseMoney(row.asking_price || row.price || row.Price || row.retail_price || row.internet_price),
        minimum_price: parseMoney(row.minimum_price || row.min_price || row.floor_price),
        acquisition_source: cleanText(row.acquisition_source || row.source || source),
        acquisition_date: cleanText(row.acquisition_date || row.date_acquired || row.purchase_date),
        notes: cleanText(row.notes || row.Notes),
        photos: normalizePhotos(row.photos || row.photo_urls || row.images || row.image_urls),
      };

      let existing = null;
      if (vin) {
        existing = db.prepare(`
          SELECT id, stage FROM units
          WHERE dealership_id = ? AND vin = ? AND archived_at IS NULL
        `).get(dealershipId, vin);
      } else if (stockNumber) {
        const matches = db.prepare(`
          SELECT id, stage FROM units
          WHERE dealership_id = ? AND archived_at IS NULL AND lower(trim(stock_number)) = lower(?)
          LIMIT 2
        `).all(dealershipId, stockNumber);
        if (matches.length > 1) {
          skip(index, 'ambiguous_stock_match', `More than one vehicle already has stock number ${stockNumber}. Add a VIN so this row can be matched.`);
          return;
        }
        existing = matches[0] || null;
      }

      // Imports never move a vehicle into or out of sold/archived: those
      // transitions belong to the structured disposition workflow.
      const terminalFeed = inventoryTruth.TERMINAL_STAGES.has(feedStage);
      if (!existing && terminalFeed) {
        skip(index, 'terminal_status_not_imported', `Status "${feedStage}" was not imported as a new vehicle. Add it, then record its disposition in Unit Navigator.`);
        return;
      }

      if (existing) {
        const keepStage = terminalFeed || inventoryTruth.TERMINAL_STAGES.has(existing.stage);
        if (keepStage && feedStage && feedStage !== existing.stage) {
          results.issues.push({
            ...rowIdentity(row, index), severity: 'warning', code: 'terminal_stage_unchanged',
            message: 'The feed status was not applied because sold and archived changes are recorded as a disposition in Unit Navigator.',
          });
        }
        db.prepare(`
          UPDATE units
          SET stock_number = ?, year = ?, make = ?, model = ?, trim = ?, body_style = ?, color = ?, mileage = ?,
              stage = COALESCE(NULLIF(?, ''), stage),
              acquisition_cost = ?, asking_price = ?, minimum_price = ?, acquisition_source = ?,
              acquisition_date = ?,
              notes = CASE WHEN notes IS NULL OR TRIM(notes) = '' THEN ? ELSE notes END,
              photos = CASE WHEN ? != '[]' THEN ? ELSE photos END
          WHERE id = ? AND dealership_id = ?
        `).run(
          unit.stock_number, unit.year, unit.make, unit.model, unit.trim, unit.body_style, unit.color, unit.mileage,
          keepStage ? '' : feedStage, unit.acquisition_cost, unit.asking_price || null, unit.minimum_price || null, unit.acquisition_source,
          unit.acquisition_date || null, unit.notes || null, JSON.stringify(unit.photos), JSON.stringify(unit.photos),
          existing.id, dealershipId,
        );
        logActivity(dealershipId, existing.id, 'Unit imported', `Updated from ${source}`, req.user.id);
        results.updated += 1;
      } else {
        const info = db.prepare(`
          INSERT INTO units (dealership_id, vin, stock_number, year, make, model, trim, body_style, color, mileage, stage,
            acquisition_cost, asking_price, minimum_price, acquisition_source, acquisition_date, notes, photos)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          dealershipId, vin, unit.stock_number, unit.year, unit.make, unit.model, unit.trim, unit.body_style,
          unit.color, unit.mileage, unit.stage, unit.acquisition_cost, unit.asking_price || null, unit.minimum_price || null,
          unit.acquisition_source, unit.acquisition_date || null, unit.notes || null, JSON.stringify(unit.photos),
        );
        logActivity(dealershipId, info.lastInsertRowid, 'Unit imported', `${unit.year || ''} ${unit.make} ${unit.model} imported from ${source}`.trim(), req.user.id);
        results.created += 1;
        if (!vin && !stockNumber) {
          results.issues.push({
            ...rowIdentity(row, index), severity: 'warning', code: 'no_vin_no_stock',
            message: 'Imported without a VIN or stock number, so it cannot be matched on a later import and will be duplicated if this file is imported again.',
          });
        }
      }
    });
  });

  tx();
  return options.includeRows ? { ...results, rows } : results;
}

function exportFilename(dealershipId) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `unitnavigator-inventory-${dealershipId}-${stamp}.csv`;
}

// ── VIN decode (NHTSA, no key required) ────────────────────────────────────
router.get('/decode-vin/:vin', requireAuth, async (req, res) => {
  const { vin } = req.params;
  if (vin.length !== 17) return res.status(400).json({ error: 'VIN must be 17 characters' });
  try {
    const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/${vin}?format=json`);
    const data = await r.json();
    const result = data.Results?.[0];
    if (!result || result.ErrorCode !== '0') {
      return res.status(422).json({ error: 'VIN not found or invalid' });
    }
    res.json({
      year: parseInt(result.ModelYear) || null,
      make: result.Make || null,
      model: result.Model || null,
      trim: result.Trim || null,
      body_style: result.BodyClass || null,
    });
  } catch {
    res.status(502).json({ error: 'VIN decode service unavailable' });
  }
});

// ── List units ──────────────────────────────────────────────────────────────
router.get('/', ...requirePermission('inventory_view'), (req, res) => {
  const { stage, search } = req.query;
  let sql = 'SELECT * FROM units WHERE dealership_id = ?';
  const params = [req.user.dealership_id];

  if (stage && stage !== 'all') {
    sql += ' AND stage = ?';
    params.push(stage);
  }
  if (search) {
    sql += ' AND (make LIKE ? OR model LIKE ? OR vin LIKE ? OR stock_number LIKE ? OR CAST(year AS TEXT) LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s, s, s);
  }
  sql += ' ORDER BY created_at DESC';

  const units = db.prepare(sql).all(...params).map(enrichUnit);
  res.json({ units });
});

router.get('/export', requireAuth, (req, res) => {
  if (!hasPermission(req.user, 'inventory_export')) return res.status(403).json({ error: 'You do not have access to export inventory' });
  const { stage, search, ids } = req.query;
  let sql = 'SELECT * FROM units WHERE dealership_id = ?';
  const params = [req.user.dealership_id];

  if (stage && stage !== 'all') {
    sql += ' AND stage = ?';
    params.push(stage);
  }
  if (search) {
    sql += ' AND (make LIKE ? OR model LIKE ? OR vin LIKE ? OR stock_number LIKE ? OR CAST(year AS TEXT) LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s, s, s);
  }
  const selectedIds = String(ids || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => Number(value))
    .filter(Number.isFinite);
  if (selectedIds.length) {
    sql += ` AND id IN (${selectedIds.map(() => '?').join(',')})`;
    params.push(...selectedIds);
  }
  sql += ' ORDER BY created_at DESC';

  const headers = [
    'vin', 'stock_number', 'year', 'make', 'model', 'trim', 'body_style', 'color', 'mileage', 'stage',
    'acquisition_cost', 'transport_cost', 'repair_cost', 'detail_cost', 'other_cost', 'asking_price',
    'minimum_price', 'sold_price', 'acquisition_source', 'acquisition_date', 'notes', 'photos',
  ];
  const rows = db.prepare(sql).all(...params).map(row => ({
    ...row,
    photos: normalizePhotos(row.photos).join('\n'),
  }));
  const csv = [
    headers.join(','),
    ...rows.map(row => headers.map(header => csvCell(row[header])).join(',')),
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(req.user.dealership_id)}"`);
  res.send(`\uFEFF${csv}`);
});

// ── Import history helpers ─────────────────────────────────────────────────
const IMPORT_FAILURE_MESSAGE = 'The import could not be completed and no vehicles were changed. Please try again.';

// Validates an optional `retry_of` batch id: it must be a batch of the SAME
// dealership the rows are being imported into.
function parseRetryOf(req, dealershipId) {
  const raw = req.body && req.body.retry_of;
  if (raw === undefined || raw === null || raw === '') return { retryOf: null };
  if (!importHistory.batchExists(db, dealershipId, raw)) return { error: 'The import you are retrying was not found.' };
  return { retryOf: Number(raw) };
}

// Persists the rows and records the batch. Never throws and always answers
// with JSON. If the rows cannot be written the transaction has already rolled
// back, so nothing changed; that is recorded as a failed batch.
function runImport({ req, res, dealershipId, kind, source, fileName = '', rows, photoIssues = [], retryOf = null, extra = {} }) {
  let results;
  try {
    results = persistImportRows(rows, req, dealershipId, source);
  } catch (err) {
    console.error('[import] persist failed:', err.message);
    let batchId = null;
    try {
      batchId = importHistory.recordBatch(db, {
        dealershipId, userId: req.user.id, kind, source, fileName, status: 'failed',
        totalRows: rows.length, retryOf, failureMessage: IMPORT_FAILURE_MESSAGE,
      });
    } catch (recordErr) {
      console.error('[import] could not record failed batch:', recordErr.message);
    }
    return res.status(500).json({ error: IMPORT_FAILURE_MESSAGE, batch_id: batchId });
  }

  const issues = [...results.issues, ...photoIssues];
  const hasErrors = issues.some(issue => issue.severity === 'error');
  let batchId = null;
  try {
    batchId = importHistory.recordBatch(db, {
      dealershipId, userId: req.user.id, kind, source, fileName,
      status: hasErrors ? 'completed_with_errors' : 'completed',
      totalRows: rows.length, created: results.created, updated: results.updated, skipped: results.skipped,
      issues, retryOf,
    });
  } catch (recordErr) {
    // The vehicles are already saved; losing the history record must not
    // turn a successful import into a failure.
    console.error('[import] could not record batch:', recordErr.message);
  }
  const { issues: _structured, ...publicResults } = results;
  return res.status(201).json({
    ...publicResults,
    ...extra,
    batch_id: batchId,
    issues: importHistory.capIssues(issues),
    error_count: issues.filter(issue => issue.severity === 'error').length,
    warning_count: issues.filter(issue => issue.severity === 'warning').length,
  });
}

// ── Bulk import units from CSV/other systems ───────────────────────────────
router.post('/import', ...requirePermission('inventory_import'), async (req, res) => {
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'No import rows received' });
    if (rows.length > 500) return res.status(400).json({ error: 'Import is limited to 500 units at a time' });

    const dealershipId = req.user.dealership_id;
    const retry = parseRetryOf(req, dealershipId);
    if (retry.error) return res.status(400).json({ error: retry.error });

    const source = cleanText(req.body.source || 'Inventory import');
    const rowsWithLocalPhotos = [];
    const photoIssues = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const failures = [];
      const photos = await localizePhotoUrls(row.photos || row.photo_urls || row.images || row.image_urls, failures);
      rowsWithLocalPhotos.push({ ...row, photos });
      if (failures.length) {
        photoIssues.push({
          ...rowIdentity(row, index), severity: 'warning', code: 'photo_not_localized',
          message: `${failures.length} photo${failures.length === 1 ? '' : 's'} could not be downloaded and still point${failures.length === 1 ? 's' : ''} to the source site.`,
        });
      }
    }

    return runImport({ req, res, dealershipId, kind: 'csv', source, rows: rowsWithLocalPhotos, photoIssues, retryOf: retry.retryOf });
  } catch (err) {
    console.error('[import] unexpected error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: IMPORT_FAILURE_MESSAGE });
  }
});

router.post('/import/dealercenter-sftp/preview', ...requirePermission('inventory_import'), (req, res) => {
  const dealershipId = targetDealershipId(req);
  const dealership = db.prepare('SELECT * FROM dealerships WHERE id = ?').get(dealershipId);
  if (!dealership) return res.status(404).json({ error: 'Dealership not found' });

  const username = dealerCenterSftpUsername(dealership);
  const latest = latestDealerCenterFile(username);
  if (!latest) {
    return res.status(404).json({ error: `No DealerCenter CSV found in /incoming for ${username || 'this dealership'}` });
  }

  const rawRows = csvToObjects(fs.readFileSync(latest.path, 'utf8'));
  const rows = rawRows.map(mapDealerCenterRow).filter(row => row.vin || (row.year && row.make && row.model));
  const photoRows = rows.filter(row => normalizePhotos(row.photos).length).length;
  res.json({
    file: { name: latest.name, size: latest.size, modified_at: latest.modified_at, sftp_username: username },
    summary: { raw_rows: rawRows.length, importable_rows: rows.length, rows_with_photos: photoRows },
    rows: rows.slice(0, 20),
  });
});

router.post('/import/dealercenter-sftp/import', ...requirePermission('inventory_import'), (req, res) => {
  try {
    const dealershipId = targetDealershipId(req);
    const dealership = db.prepare('SELECT * FROM dealerships WHERE id = ?').get(dealershipId);
    if (!dealership) return res.status(404).json({ error: 'Dealership not found' });

    const retry = parseRetryOf(req, dealershipId);
    if (retry.error) return res.status(400).json({ error: retry.error });

    const username = dealerCenterSftpUsername(dealership);
    const latest = latestDealerCenterFile(username);
    if (!latest) {
      return res.status(404).json({ error: `No DealerCenter CSV found in /incoming for ${username || 'this dealership'}` });
    }

    const rawRows = csvToObjects(fs.readFileSync(latest.path, 'utf8'));
    const rows = rawRows.map(mapDealerCenterRow).filter(row => row.vin || (row.year && row.make && row.model));
    if (!rows.length) return res.status(400).json({ error: 'DealerCenter feed did not contain importable vehicles' });
    if (rows.length > 500) return res.status(400).json({ error: 'Import is limited to 500 units at a time' });

    return runImport({
      req, res, dealershipId, kind: 'dealercenter_sftp', source: `DealerCenter SFTP ${latest.name}`,
      fileName: latest.name, rows, retryOf: retry.retryOf,
      extra: {
        file: { name: latest.name, size: latest.size, modified_at: latest.modified_at, sftp_username: username },
        rows_with_photos: rows.filter(row => normalizePhotos(row.photos).length).length,
      },
    });
  } catch (err) {
    console.error('[import] sftp import error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: IMPORT_FAILURE_MESSAGE });
  }
});

// ── Import history (read-only) ─────────────────────────────────────────────
function historyDealershipId(req) {
  if (req.user.role === 'super_admin' && req.query.dealership_id) {
    const id = parseInteger(req.query.dealership_id);
    if (id) return id;
  }
  return req.user.dealership_id;
}

router.get('/import/batches', ...requirePermission('inventory_import'), (req, res) => {
  res.json({
    batches: importHistory.listBatches(db, historyDealershipId(req), { limit: req.query.limit, before: req.query.before }),
    retention_days: importHistory.RETENTION_DAYS,
  });
});

router.get('/import/batches/:id', ...requirePermission('inventory_import'), (req, res) => {
  const batch = importHistory.getBatch(db, historyDealershipId(req), req.params.id);
  if (!batch) return res.status(404).json({ error: 'Import not found' });
  res.json({ batch, retention_days: importHistory.RETENTION_DAYS });
});

// ── Match public website photos to CSV/import rows ─────────────────────────
router.post('/import/website-photos', ...requirePermission('inventory_import'), async (req, res) => {
  const websiteUrl = cleanText(req.body.website_url || req.body.websiteUrl);
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!websiteUrl) return res.status(400).json({ error: 'Dealer website URL is required' });
  if (!rows.length) return res.status(400).json({ error: 'Import rows are required before matching photos' });
  if (rows.length > 500) return res.status(400).json({ error: 'Photo matching is limited to 500 rows at a time' });

  let startUrl;
  try {
    startUrl = new URL(websiteUrl);
  } catch {
    return res.status(400).json({ error: 'Enter a valid inventory website URL' });
  }
  if (!['http:', 'https:'].includes(startUrl.protocol) || isUnsafeFetchHost(startUrl.hostname)) {
    return res.status(400).json({ error: 'Enter a public dealer website URL' });
  }

  const visited = new Set();
  const queue = [startUrl.href];
  const candidates = [];
  const errors = [];
  const origin = startUrl.origin;
  const maxPages = Math.min(80, Math.max(20, rows.length * 3));

  while (queue.length && visited.size < maxPages) {
    const url = queue.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);
    try {
      const page = await fetchText(url);
      if (!page.ok) {
        errors.push({ url, status: page.status, error: `Website returned ${page.status}` });
        continue;
      }
      const candidate = extractVehicleCandidate(page.text, page.url);
      if (candidate.images.length || candidate.vin || candidate.stock_number) candidates.push(candidate);
      extractPageLinks(page.text, page.url, origin).forEach(link => {
        if (!visited.has(link) && queue.length < maxPages * 2) queue.push(link);
      });
    } catch (err) {
      errors.push({ url, error: err.name === 'AbortError' ? 'Website request timed out' : err.message });
    }
  }

  const enriched = attachWebsitePhotos(rows, candidates);
  const matched = enriched.filter(row => parseInteger(row.website_photo_count) > 0).length;
  const blocked = errors.some(err => err.status === 403 || err.status === 429);

  res.json({
    rows: enriched,
    summary: {
      scanned_pages: visited.size,
      vehicle_candidates: candidates.length,
      matched_rows: matched,
      blocked,
      message: blocked
        ? 'The website blocked automated access. CSV rows are still ready, but photos may need a vendor feed, exported image ZIP, or manual upload.'
        : `Matched photos for ${matched} of ${rows.length} row(s).`,
    },
    errors: errors.slice(0, 12),
  });
});

router.get('/price-suggestion', ...requirePermission('inventory_pricing'), (req, res) => {
  const suggestion = suggestedRetailPrice(db, {
    dealership_id: req.user.dealership_id,
    year: req.query.year,
    make: req.query.make,
    model: req.query.model,
    trim: req.query.trim,
    mileage: req.query.mileage,
    body_style: req.query.body_style,
    zip: req.query.zip,
  });
  res.json({
    suggestion,
    disclaimer: 'Suggested prices are estimates based on available comparable sales, vehicle details, mileage, location, and data recency. Verify pricing against your own market research and actual purchase and sales results.',
  });
});

router.post('/description-suggestion', ...requirePermission('inventory_edit'), async (req, res) => {
  try {
    const description = await generateVehicleDescription({
      year: req.body.year,
      make: req.body.make,
      model: req.body.model,
      trim: req.body.trim,
      body_style: req.body.body_style,
      color: req.body.color,
      mileage: req.body.mileage,
      asking_price: req.body.asking_price,
    });
    res.json({ description });
  } catch (err) {
    res.status(err.code === 'missing_openai_key' ? 503 : 502).json({ error: err.message || 'Could not generate description' });
  }
});

// Bulk SUGGESTIONS only (up to 10 units, one provider call): nothing is saved
// here. The dealer saves each reviewed suggestion explicitly through the
// existing PUT /api/inventory/:id update path.
router.post('/description-suggestions/bulk', ...requirePermission('inventory_edit'), async (req, res) => {
  try {
    res.json(await runBulkSuggestions({ db, dealershipId: req.user.dealership_id, body: req.body }));
  } catch (err) {
    if (err instanceof ListingSuiteError) return res.status(err.statusCode).json({ error: err.message });
    res.status(500).json({ error: 'Could not generate description suggestions' });
  }
});

router.post('/:id/description-suggestion', ...requirePermission('inventory_edit'), async (req, res) => {
  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });

  try {
    const description = await generateVehicleDescription(unit);
    res.json({ description });
  } catch (err) {
    res.status(err.code === 'missing_openai_key' ? 503 : 502).json({ error: err.message || 'Could not generate description' });
  }
});

// ── Get single unit ─────────────────────────────────────────────────────────
// Active employees of this dealership who can be made responsible for a unit.
router.get('/assignees', ...requirePermission('inventory_edit'), (req, res) => {
  res.json({ users: inventoryTruth.assignableUsers(db, req.user.dealership_id) });
});

router.get('/:id', ...requirePermission('inventory_view'), (req, res) => {
  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });

  const activity = db.prepare(
    `SELECT a.*, u.name as user_name FROM activity_logs a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE a.entity_type = 'unit' AND a.entity_id = ? AND a.dealership_id = ?
     ORDER BY a.created_at DESC, a.id DESC LIMIT 50`
  ).all(unit.id, req.user.dealership_id);

  const deal = db.prepare(
    `SELECT d.*, c.first_name, c.last_name FROM deals d
     LEFT JOIN customers c ON c.id = d.customer_id
     WHERE d.unit_id = ? AND d.dealership_id = ? AND d.status NOT IN ('dead') ORDER BY d.created_at DESC LIMIT 1`
  ).get(unit.id, req.user.dealership_id);

  const assignee = unit.assigned_user_id
    ? db.prepare('SELECT id, name, status FROM users WHERE id = ? AND dealership_id = ?').get(unit.assigned_user_id, req.user.dealership_id)
    : null;
  const history = inventoryTruth.unitHistory(db, {
    dealershipId: req.user.dealership_id,
    unitId: unit.id,
    canPrice: hasPermission(req.user, 'inventory_pricing'),
  });

  res.json({
    unit: enrichUnit(unit),
    activity,
    deal,
    assignment: assignee ? { user_id: assignee.id, name: assignee.name, active: assignee.status === 'active' } : null,
    review: inventoryTruth.reviewState(unit, inventoryTruth.reviewInterval(db, req.user.dealership_id)),
    dispositions: history.dispositions,
    assignment_history: history.assignments,
  });
});

function sendTruthError(res, err, fallback) {
  if (err instanceof inventoryTruth.InventoryTruthError) return res.status(err.statusCode).json({ error: err.message });
  console.error(fallback, err);
  return res.status(500).json({ error: fallback });
}

// Assign (or with user_id null, unassign) the responsible employee.
router.put('/:id/assignment', ...requirePermission('inventory_edit'), (req, res) => {
  try {
    const result = inventoryTruth.assignUnit(db, {
      dealershipId: req.user.dealership_id,
      unitId: req.params.id,
      userId: req.body ? req.body.user_id : undefined,
      actorId: req.user.id,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    sendTruthError(res, err, 'Could not update the assignment');
  }
});

// Confirm the unit's current status; resets the review clock.
router.post('/:id/verify', ...requirePermission('inventory_edit'), (req, res) => {
  try {
    res.json({ ok: true, ...inventoryTruth.verifyUnit(db, {
      dealershipId: req.user.dealership_id,
      unitId: req.params.id,
      actorId: req.user.id,
      stageLabel: stage => STAGE_LABELS[stage] || stage,
    }) });
  } catch (err) {
    sendTruthError(res, err, 'Could not record the review');
  }
});

// Record (or correct) what ultimately happened to the unit. Never deletes it.
router.post('/:id/disposition', ...requirePermission('inventory_edit'), (req, res) => {
  try {
    const result = inventoryTruth.recordDisposition(db, {
      dealershipId: req.user.dealership_id,
      unitId: req.params.id,
      actorId: req.user.id,
      body: req.body || {},
      canPrice: hasPermission(req.user, 'inventory_pricing'),
    });
    const updated = db.prepare('SELECT * FROM units WHERE id = ? AND dealership_id = ?').get(req.params.id, req.user.dealership_id);
    res.status(201).json({ ok: true, ...result, unit: enrichUnit(updated) });
  } catch (err) {
    sendTruthError(res, err, 'Could not record the disposition');
  }
});

// ── Create unit ─────────────────────────────────────────────────────────────
router.post('/', ...requirePermission('inventory_add'), (req, res) => {
  const restrictedCreatePricingFields = new Set([...PRICING_FIELDS].filter(key => key !== 'acquisition_cost'));
  const includesPricing = Object.keys(req.body || {}).some(key => restrictedCreatePricingFields.has(key) && req.body[key] !== undefined && req.body[key] !== null && req.body[key] !== '');
  if (includesPricing && !hasPermission(req.user, 'inventory_pricing')) {
    return res.status(403).json({ error: 'You do not have access to add or change inventory pricing' });
  }

  const {
    vin, stock_number, year, make, model, trim, body_style, color, mileage,
    acquisition_cost, transport_cost, repair_cost, detail_cost, other_cost,
    asking_price, minimum_price, acquisition_source, acquisition_date, notes, stage,
    repair_items,
  } = req.body;

  const vinClean = vin ? vin.toUpperCase().trim() : '';
  const acquisitionCostNum = Number(acquisition_cost);

  if (acquisition_cost === undefined || acquisition_cost === null || acquisition_cost === '' || Number.isNaN(acquisitionCostNum) || acquisitionCostNum < 0) {
    return res.status(400).json({ error: 'Acquisition cost is required' });
  }
  const initialStage = stage || 'acquired';
  if (!VALID_STAGES.includes(initialStage)) return res.status(400).json({ error: 'Invalid stage' });
  if (inventoryTruth.TERMINAL_STAGES.has(initialStage)) return res.status(409).json(DISPOSITION_REQUIRED);

  if (vinClean) {
    const existing = db.prepare('SELECT id FROM units WHERE vin = ? AND dealership_id = ? AND archived_at IS NULL')
      .get(vinClean, req.user.dealership_id);
    if (existing) return res.status(409).json({ error: 'A unit with this VIN already exists in your inventory' });
  }

  const repairItems = normalizeRepairItems(repair_items);
  const repairCostNum = repairItems.length ? repairItemsTotal(repairItems) : parseMoney(repair_cost);

  const info = db.prepare(`
    INSERT INTO units (dealership_id, vin, stock_number, year, make, model, trim, body_style, color, mileage, stage,
      acquisition_cost, transport_cost, repair_cost, repair_items, detail_cost, other_cost,
      asking_price, minimum_price, acquisition_source, acquisition_date, notes)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    req.user.dealership_id, vinClean, stock_number || null, year, make, model, trim, body_style, color,
    mileage || 0, initialStage,
    acquisitionCostNum, transport_cost || 0, repairCostNum, JSON.stringify(repairItems), detail_cost || 0, other_cost || 0,
    asking_price || null, minimum_price || null, acquisition_source || null, acquisition_date || null, notes || null,
  );

  logActivity(req.user.dealership_id, info.lastInsertRowid, 'Unit created', `${year} ${make} ${model} added to ${STAGE_LABELS[initialStage]}`, req.user.id);

  const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ unit: enrichUnit(unit) });
});

// ── Update unit ─────────────────────────────────────────────────────────────
router.put('/:id', requireAuth, (req, res) => {
  const keys = Object.keys(req.body || {});
  const touchesPricing = keys.some(key => PRICING_FIELDS.has(key));
  const touchesDetails = keys.some(key => !PRICING_FIELDS.has(key));
  if (touchesPricing && !hasPermission(req.user, 'inventory_pricing')) {
    return res.status(403).json({ error: 'You do not have access to add or change inventory pricing' });
  }
  if (touchesDetails && !hasPermission(req.user, 'inventory_edit')) {
    return res.status(403).json({ error: 'You do not have access to edit inventory details' });
  }

  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });

  // Once a structured disposition exists, the sale price comes only from it.
  if ('sold_price' in (req.body || {}) && inventoryTruth.activeDisposition(db, req.user.dealership_id, unit.id)) {
    return res.status(409).json({ error: 'Correct the disposition to change the sale price.', code: 'disposition_required' });
  }

  const fields = [
    'stock_number','year','make','model','trim','body_style','color','mileage',
    'acquisition_cost','transport_cost','repair_cost','detail_cost','other_cost',
    'asking_price','minimum_price','sold_price','acquisition_source','acquisition_date','notes',
  ];
  const updates = [];
  const vals = [];
  fields.forEach(f => {
    if (f === 'repair_cost' && 'repair_items' in req.body) return;
    if (f in req.body) { updates.push(`${f} = ?`); vals.push(req.body[f]); }
  });
  if ('repair_items' in req.body) {
    const repairItems = normalizeRepairItems(req.body.repair_items);
    updates.push('repair_items = ?', 'repair_cost = ?');
    vals.push(JSON.stringify(repairItems), repairItemsTotal(repairItems));
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  vals.push(req.params.id, req.user.dealership_id);
  db.prepare(`UPDATE units SET ${updates.join(', ')} WHERE id = ? AND dealership_id = ?`).run(...vals);

  logActivity(req.user.dealership_id, req.params.id, 'Unit updated', 'Details updated', req.user.id);
  const updated = db.prepare('SELECT * FROM units WHERE id = ?').get(req.params.id);
  capturePlatformSoldUnit(updated);
  res.json({ unit: enrichUnit(updated) });
});

// ── Update stage ────────────────────────────────────────────────────────────
router.patch('/:id/stage', requireAuth, (req, res) => {
  if (!hasPermission(req.user, 'inventory_edit')) {
    return res.status(403).json({ error: 'You do not have access to move inventory stages' });
  }

  const { stage } = req.body || {};
  if (!VALID_STAGES.includes(stage)) return res.status(400).json({ error: 'Invalid stage' });

  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });
  if (inventoryTruth.TERMINAL_STAGES.has(stage)) return res.status(409).json(DISPOSITION_REQUIRED);
  // Reopening a sold vehicle undoes a sale, which stays behind the pricing permission.
  if (unit.stage === 'sold' && !hasPermission(req.user, 'inventory_pricing')) {
    return res.status(403).json({ error: 'You do not have access to change a sale' });
  }

  db.transaction(() => {
    if (inventoryTruth.TERMINAL_STAGES.has(unit.stage)) {
      inventoryTruth.reverseDisposition(db, { dealershipId: req.user.dealership_id, unitId: unit.id, actorId: req.user.id });
    }
    db.prepare('UPDATE units SET stage = ? WHERE id = ? AND dealership_id = ?').run(stage, unit.id, req.user.dealership_id);
    logActivity(req.user.dealership_id, unit.id, 'Stage changed', `${STAGE_LABELS[unit.stage] || unit.stage} → ${STAGE_LABELS[stage] || stage}`, req.user.id);
  })();
  const updated = db.prepare('SELECT * FROM units WHERE id = ? AND dealership_id = ?').get(unit.id, req.user.dealership_id);
  res.json({ unit: enrichUnit(updated) });
});

// ── Permanently delete unit ────────────────────────────────────────────────
router.delete('/:id', ...requirePermission('inventory_delete'), (req, res) => {
  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });
  // Assignment and disposition history is an audit record; a unit that has
  // any is kept. Record or correct its disposition instead.
  if (inventoryTruth.hasTruthHistory(db, req.user.dealership_id, unit.id)) {
    return res.status(409).json({
      error: 'This vehicle has assignment or disposition history, so it cannot be permanently deleted. Record or correct its disposition instead.',
      code: 'truth_history_exists',
    });
  }

  const photos = JSON.parse(unit.photos || '[]');
  photos.forEach(url => {
    const filePath = resolveUploadPath(url);
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  });

  db.prepare('UPDATE deals SET unit_id = NULL WHERE unit_id = ? AND dealership_id = ?')
    .run(req.params.id, req.user.dealership_id);
  db.prepare('DELETE FROM activity_logs WHERE entity_type = ? AND entity_id = ? AND dealership_id = ?')
    .run('unit', req.params.id, req.user.dealership_id);
  db.prepare('DELETE FROM units WHERE id = ? AND dealership_id = ?')
    .run(req.params.id, req.user.dealership_id);

  res.json({ ok: true });
});

// ── Upload photos ───────────────────────────────────────────────────────────
router.post('/:id/photos', ...requirePermission('inventory_edit'), upload.array('photos', 20), (req, res) => {
  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!unit) {
    (req.files || []).forEach(f => { try { fs.unlinkSync(f.path); } catch { /* already gone */ } });
    return res.status(404).json({ error: 'Unit not found' });
  }

  const { valid, rejected } = finalizeUploadedImages(req.files || []);
  if (!valid.length && rejected.length) {
    return res.status(400).json({ error: 'None of the uploaded files were valid images' });
  }

  const existing = JSON.parse(unit.photos || '[]');
  const newUrls = valid.map(f => `/uploads/units/${f.filename}`);
  const merged = [...existing, ...newUrls];

  db.prepare('UPDATE units SET photos = ? WHERE id = ?').run(JSON.stringify(merged), req.params.id);
  logActivity(req.user.dealership_id, req.params.id, 'Photos added', `${newUrls.length} photo(s) uploaded`, req.user.id);
  res.json({ photos: merged, rejected: rejected.length });
});

// ── Delete a photo ──────────────────────────────────────────────────────────
router.delete('/:id/photos', ...requirePermission('inventory_edit'), (req, res) => {
  const { url } = req.body;
  const unit = db.prepare('SELECT * FROM units WHERE id = ? AND dealership_id = ?')
    .get(req.params.id, req.user.dealership_id);
  if (!unit) return res.status(404).json({ error: 'Unit not found' });

  const photos = JSON.parse(unit.photos || '[]').filter(p => p !== url);
  db.prepare('UPDATE units SET photos = ? WHERE id = ?').run(JSON.stringify(photos), req.params.id);

  const filePath = resolveUploadPath(url);
  if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ photos });
});

module.exports = router;
