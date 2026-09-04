'use strict';

function cleanText(value) {
  return String(value ?? '').trim();
}

function parseNumber(value) {
  const parsed = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalize(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, point) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * point;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function removeOutliers(values) {
  if (values.length < 6) return values;
  const q1 = percentile(values, 0.25);
  const q3 = percentile(values, 0.75);
  const iqr = q3 - q1;
  const low = Math.max(0, q1 - iqr * 1.5);
  const high = q3 + iqr * 1.5;
  return values.filter(value => value >= low && value <= high);
}

function roundToNearest(value, nearest = 50) {
  return Math.max(0, Math.round(value / nearest) * nearest);
}

function mileageAdjustedPrice(comp, targetMileage) {
  const price = parseNumber(comp.sold_price);
  if (!price) return 0;
  const compMileage = parseNumber(comp.mileage);
  const mileageDelta = targetMileage - compMileage;
  const adjustment = Math.max(-0.28, Math.min(0.28, (mileageDelta / 10000) * -0.035));
  return price * (1 + adjustment);
}

function confidenceFromCount(count, source) {
  if (source === 'free_model') return 'Low';
  if (count >= 12) return 'High';
  if (count >= 6) return 'Medium';
  return 'Low';
}

function comparableTier(row, request) {
  const makeOk = normalize(row.make) === normalize(request.make);
  const modelOk = normalize(row.model) === normalize(request.model);
  const yearOk = Math.abs(parseNumber(row.year) - parseNumber(request.year)) <= 1;
  if (!makeOk || !modelOk || !yearOk) return 0;

  const rowTrim = normalize(row.trim);
  const requestTrim = normalize(request.trim);
  if (requestTrim && rowTrim && rowTrim === requestTrim) return 1;
  return 2;
}

function internalComparableEstimate(db, request) {
  const make = normalize(request.make);
  const model = normalize(request.model);
  const year = parseNumber(request.year);
  if (!make || !model || !year) return null;

  const rows = db.prepare(`
    SELECT *
    FROM platform_sold_units
    WHERE sold_price IS NOT NULL
      AND sold_price > 500
      AND year BETWEEN ? AND ?
  `).all(year - 1, year + 1);

  const tiered = rows
    .map(row => ({ row, tier: comparableTier(row, request) }))
    .filter(item => item.tier > 0)
    .sort((a, b) => a.tier - b.tier);

  const bestTier = tiered.some(item => item.tier === 1) ? 1 : 2;
  const comps = tiered.filter(item => item.tier === bestTier).map(item => item.row);
  if (comps.length < 3) return null;

  const targetMileage = parseNumber(request.mileage);
  const prices = removeOutliers(comps.map(comp => mileageAdjustedPrice(comp, targetMileage)));
  if (prices.length < 3) return null;

  const target = roundToNearest(median(prices), 50);
  const low = roundToNearest(percentile(prices, 0.25), 50);
  const high = roundToNearest(percentile(prices, 0.75), 50);
  return {
    low: Math.min(low, target),
    high: Math.max(high, target),
    target,
    comparable_count: prices.length,
    confidence: confidenceFromCount(prices.length, 'internal_sold'),
    source: 'internal_sold',
    explanation: `Based on ${prices.length} similar Unit Navigator sale${prices.length === 1 ? '' : 's'}`,
  };
}

function baseRetailNewValue(request) {
  const make = normalize(request.make);
  const model = normalize(request.model);
  const body = normalize(request.body_style);
  const trim = normalize(request.trim);
  const text = `${make} ${model} ${body} ${trim}`;

  let base = 30000;
  if (/(truck|pickup|f150|f250|f350|silverado|sierra|ram|tundra|tacoma|frontier|colorado)/.test(text)) base = 43000;
  if (/(f250|f350|2500|3500|superduty|duramax|cummins|powerstroke)/.test(text)) base = 61000;
  if (/(suv|utility|expedition|suburban|tahoe|yukon|pilot|highlander|4runner|explorer|sorento)/.test(text)) base = 38000;
  if (/(van|minivan|sienna|odyssey|caravan|pacifica)/.test(text)) base = 35000;
  if (/(coupe|convertible|mustang|camaro|challenger|corvette)/.test(text)) base = 36000;
  if (/(hatchback|compact|versa|rio|fit|spark|aveo|yaris)/.test(text)) base = 23000;

  const premiumMakes = {
    audi: 1.35,
    bmw: 1.45,
    cadillac: 1.3,
    infiniti: 1.25,
    landrover: 1.75,
    lexus: 1.35,
    mercedesbenz: 1.55,
    porsche: 2.6,
    tesla: 1.5,
  };
  base *= premiumMakes[make] || 1;

  if (/(limited|platinum|denali|lariat|kingranch|premium|hse|prestige|turbo|diesel)/.test(text)) base *= 1.16;
  if (/(base|lx|se|s|work|fleet)/.test(text)) base *= 0.92;
  return base;
}

function freeDataEstimate(request, now = new Date()) {
  const year = parseNumber(request.year);
  const make = normalize(request.make);
  const model = normalize(request.model);
  if (!year || !make || !model) return null;

  const age = Math.max(0, now.getFullYear() - year);
  const base = baseRetailNewValue(request);
  const depreciation = Math.pow(0.84, Math.min(age, 5)) * Math.pow(0.91, Math.max(age - 5, 0));
  const expectedMileage = Math.max(12000, age * 12000);
  const actualMileage = parseNumber(request.mileage);
  const mileageDelta = actualMileage ? actualMileage - expectedMileage : 0;
  const mileageFactor = Math.max(0.55, Math.min(1.2, 1 - (mileageDelta / 10000) * 0.035));
  const target = Math.max(2500, roundToNearest(base * depreciation * mileageFactor, 50));
  return {
    low: roundToNearest(target * 0.84, 50),
    high: roundToNearest(target * 1.16, 50),
    target,
    comparable_count: 0,
    confidence: 'Low',
    source: 'free_model',
    explanation: 'Free-data estimate based on vehicle class, age, mileage, trim signals, and depreciation. Not live market comps.',
  };
}

function suggestedRetailPrice(db, request) {
  const internal = internalComparableEstimate(db, request);
  if (internal) return internal;
  const fallback = freeDataEstimate(request);
  if (fallback) return fallback;
  return {
    low: null,
    high: null,
    target: null,
    comparable_count: 0,
    confidence: 'Low',
    source: 'insufficient_data',
    explanation: 'Enter year, make, model, and mileage to see a suggested list price.',
  };
}

module.exports = { suggestedRetailPrice, internalComparableEstimate, freeDataEstimate };
