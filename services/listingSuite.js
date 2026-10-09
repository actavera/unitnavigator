'use strict';
// Bulk listing-description SUGGESTIONS. This module only reads units and asks
// the provider for text: it never writes to the database, and nothing it
// returns is saved anywhere. A dealer saves a suggestion explicitly, one unit
// at a time, through the existing PUT /api/inventory/:id path.
const crypto = require('crypto');
const { generateBatchDescriptions, vehicleFacts, VARIANTS } = require('./vehicleDescription');
const { listingWarnings } = require('./listingQuality');

const MAX_UNITS = 10;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;

class ListingSuiteError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

// Only these columns are ever loaded — no VIN, costs, minimum price, or
// tenant metadata is even read, so none of it can reach the provider.
const UNIT_COLUMNS = 'id, year, make, model, trim, body_style, color, mileage, asking_price, notes, photos';

// Cache entries are keyed by dealership, variant, and a fingerprint of the
// exact facts the provider would see. Changing any permitted fact (price,
// mileage, trim, ...) changes the fingerprint, so an edited unit can never be
// served a stale suggestion. Process-local and short-lived on purpose.
function createCache() {
  return new Map();
}
const defaultCache = createCache();

// Requests currently waiting on the provider, keyed exactly like the cache
// (dealership | variant | facts fingerprint). A second identical request that
// arrives before the first call finishes awaits the same promise instead of
// making another provider call. Entries are removed when the call settles —
// success or failure — and failures are never cached.
function createInflight() {
  return new Map();
}
const defaultInflight = createInflight();

function factsFingerprint(unit) {
  return crypto.createHash('sha256').update(JSON.stringify(vehicleFacts(unit))).digest('hex');
}

function cacheKey(dealershipId, variant, unit) {
  return `${dealershipId}|${variant}|${factsFingerprint(unit)}`;
}

function cacheGet(cache, key, now) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  return hit.description;
}

function cacheSet(cache, key, description, now) {
  while (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { description, expiresAt: now + CACHE_TTL_MS });
}

const MAX_RAW_IDS = 50; // reject absurd payloads before doing any per-id work

function isValidVariant(variant) {
  return typeof variant === 'string' && Object.prototype.hasOwnProperty.call(VARIANTS, variant);
}

function parseRequest(body) {
  const rawIds = body && body.unit_ids;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    throw new ListingSuiteError('Select at least one vehicle.');
  }
  if (rawIds.length > MAX_RAW_IDS) {
    throw new ListingSuiteError(`You can generate descriptions for up to ${MAX_UNITS} vehicles at a time.`);
  }
  const unique = new Set();
  for (const raw of rawIds) {
    // Whole numbers or digit-only strings; never booleans, arrays, or objects
    // that merely coerce to a number.
    const valid = (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0)
      || (typeof raw === 'string' && /^[1-9]\d{0,15}$/.test(raw));
    if (!valid) throw new ListingSuiteError('unit_ids must be positive whole numbers.');
    unique.add(Number(raw));
  }
  const unitIds = [...unique];
  if (unitIds.length > MAX_UNITS) {
    throw new ListingSuiteError(`You can generate descriptions for up to ${MAX_UNITS} vehicles at a time.`);
  }
  const variant = body.variant === undefined ? 'standard' : body.variant;
  if (!isValidVariant(variant)) {
    throw new ListingSuiteError(`variant must be one of: ${Object.keys(VARIANTS).join(', ')}.`);
  }
  return { unitIds, variant, includeExisting: body.include_existing === true };
}

function label(unit) {
  return [unit.year, unit.make, unit.model].filter(Boolean).join(' ') || 'Untitled vehicle';
}

const NOT_CONFIGURED_MESSAGE = 'AI descriptions are not configured yet. Add OPENAI_API_KEY on the server first. Listing warnings are still shown below.';
const UNAVAILABLE_MESSAGE = 'AI descriptions are unavailable right now. Try again shortly. Listing warnings are still shown below.';

async function runBulkSuggestions({ db, dealershipId, body, generate = generateBatchDescriptions, cache = defaultCache, inflight = defaultInflight, now = Date.now }) {
  const { unitIds, variant, includeExisting } = parseRequest(body || {});

  // Every unit is loaded by BOTH id and the authenticated dealership. An id
  // that belongs to another dealership (or doesn't exist) simply isn't in the
  // result — indistinguishable from a missing id, and never revealed.
  const placeholders = unitIds.map(() => '?').join(',');
  const rows = db.prepare(`SELECT ${UNIT_COLUMNS} FROM units WHERE dealership_id = ? AND id IN (${placeholders})`)
    .all(dealershipId, ...unitIds);
  const byId = new Map(rows.map(row => [row.id, row]));
  const units = unitIds.map(id => byId.get(id)).filter(Boolean);

  const results = units.map(unit => {
    const current = String(unit.notes ?? '').trim();
    return {
      unit,
      out: {
        id: unit.id,
        label: label(unit),
        has_description: current !== '',
        current_description: current,
        warnings: listingWarnings(unit),
        status: 'pending',
      },
    };
  });

  // Units that already have a description are identified and, by default,
  // left alone entirely: not sent to the provider and not replaced.
  const candidates = [];
  for (const r of results) {
    if (r.out.has_description && !includeExisting) {
      r.out.status = 'skipped_existing';
    } else {
      candidates.push(r);
    }
  }

  const time = now();
  const misses = [];
  for (const r of candidates) {
    const key = cacheKey(dealershipId, variant, r.unit);
    const hit = cacheGet(cache, key, time);
    if (hit !== null) {
      r.out.status = 'suggested';
      r.out.suggestion = hit;
      r.out.cached = true;
    } else {
      r.key = key;
      misses.push(r);
    }
  }

  let aiUnavailable = false;
  let reason;
  let message;
  if (misses.length) {
    // Everything from here to the in-flight registration is synchronous (no
    // await), so a concurrent identical request can never slip in between the
    // check and the registration.
    const owned = new Map(); // key -> the unit to send (one per distinct key)
    for (const r of misses) {
      if (!inflight.has(r.key) && !owned.has(r.key)) owned.set(r.key, r.unit);
    }

    if (owned.size) {
      const keys = [...owned.keys()];
      // The one and only provider call for the keys this request owns.
      const batch = (async () => generate([...owned.values()], { variant }))();
      const perKey = new Map();
      keys.forEach((key, i) => {
        const promise = batch.then(descriptions => (
          descriptions && typeof descriptions[i] === 'string' && descriptions[i] ? descriptions[i] : null
        ));
        perKey.set(key, promise);
        inflight.set(key, promise);
      });
      // Settle bookkeeping: cache successes, then drop every in-flight entry
      // this call created — on success and on failure alike. Failures are
      // never cached, so a later retry calls the provider again.
      batch.then(
        descriptions => {
          const settledAt = now();
          keys.forEach((key, i) => {
            const description = descriptions && typeof descriptions[i] === 'string' ? descriptions[i] : '';
            if (description) cacheSet(cache, key, description, settledAt);
          });
        },
        () => {},
      ).finally(() => {
        keys.forEach(key => { if (inflight.get(key) === perKey.get(key)) inflight.delete(key); });
      });
    }

    // Owners and joiners alike wait on the shared per-key promises.
    const waits = misses.map(r => ({ r, promise: inflight.get(r.key) }));
    const settled = await Promise.allSettled(waits.map(w => w.promise));
    waits.forEach((w, i) => {
      const outcome = settled[i];
      if (outcome.status === 'fulfilled') {
        if (outcome.value) {
          w.r.out.status = 'suggested';
          w.r.out.suggestion = outcome.value;
        } else {
          w.r.out.status = 'failed';
        }
      } else {
        w.r.out.status = 'unavailable';
        if (!aiUnavailable) {
          aiUnavailable = true;
          const err = outcome.reason;
          reason = err && err.code === 'missing_openai_key' ? 'not_configured' : 'unavailable';
          message = reason === 'not_configured' ? NOT_CONFIGURED_MESSAGE : UNAVAILABLE_MESSAGE;
        }
      }
    });
  }

  const response = { variant, max_units: MAX_UNITS, ai_unavailable: aiUnavailable, units: results.map(r => r.out) };
  if (aiUnavailable) {
    response.reason = reason;
    response.message = message;
  }
  return response;
}

module.exports = { runBulkSuggestions, parseRequest, ListingSuiteError, createCache, createInflight, factsFingerprint, MAX_UNITS, UNIT_COLUMNS };
