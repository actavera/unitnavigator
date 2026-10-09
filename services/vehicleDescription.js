'use strict';

const https = require('https');

function clean(value) {
  return String(value ?? '').trim();
}

// Vehicle fields are short facts (a make, a trim level, a color), never
// free-form text. Capping length keeps a caller from turning this endpoint
// into an arbitrary-size, uncapped prompt to a paid AI API.
function cleanShort(value, maxLength = 60) {
  return clean(value).slice(0, maxLength);
}

function money(value) {
  const n = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && n > 0 ? `$${Math.round(n).toLocaleString()}` : '';
}

function miles(value) {
  const n = Number(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && n > 0 ? `${Math.round(n).toLocaleString()} miles` : '';
}

function vehicleFacts(unit) {
  return {
    year: cleanShort(unit.year, 8),
    make: cleanShort(unit.make),
    model: cleanShort(unit.model),
    trim: cleanShort(unit.trim),
    body_style: cleanShort(unit.body_style),
    color: cleanShort(unit.color),
    mileage: miles(unit.mileage),
    price: money(unit.asking_price),
  };
}

// `standard` is the original single-vehicle description and its wording must
// not change. `facebook` is a shorter, plainer variant for a Marketplace-style
// post. Both carry the same factual-safety rules.
const VARIANTS = {
  standard: { maxChars: 700, maxOutputTokens: 3000 },
  facebook: { maxChars: 300, maxOutputTokens: 1500 },
};

const VARIANT_LENGTH_RULES = {
  standard: [
    'Write a short used-car listing description for a dealership.',
    'Style: catchy, confident, plain-spoken, and sales-friendly. Keep it punchy, not too wordy.',
    'Length: 55 to 90 words.',
  ],
  facebook: [
    'Write a short used-car listing description for a dealership, suited to a Facebook Marketplace post.',
    'Style: friendly, plain-spoken, and easy to skim. No headings or bullet points.',
    'Length: 20 to 40 words, in two or three short sentences.',
  ],
};

const SAFETY_RULES = [
  'Only use facts provided. Do not invent condition, accident history, title status, ownership history, warranty, service records, financing, discounts, or availability.',
  'Do not include contact information, phone numbers, email, address, hashtags, emoji, or generic obvious features like seatbelts.',
  'Focus on useful differentiators from trim, body style, mileage, color, and price when available.',
];

function promptFor(unit, variant = 'standard') {
  const facts = vehicleFacts(unit);
  const rules = Object.prototype.hasOwnProperty.call(VARIANT_LENGTH_RULES, variant) ? VARIANT_LENGTH_RULES[variant] : VARIANT_LENGTH_RULES.standard;
  const [intro, ...rest] = rules;
  return [
    intro,
    ...rest,
    ...SAFETY_RULES,
    'Return only the description text.',
    '',
    `Vehicle facts: ${JSON.stringify(facts)}`,
  ].join('\n');
}

function requestJson(options, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch {}
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const message = parsed?.error?.message || raw || `OpenAI request failed with ${res.statusCode}`;
          reject(new Error(message));
          return;
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('OpenAI request timed out'), { code: 'ETIMEDOUT' })));
    req.write(JSON.stringify(body));
    req.end();
  });
}

function responseText(response) {
  if (response?.output_text) return clean(response.output_text);
  const chunks = [];
  for (const item of response?.output || []) {
    for (const part of item.content || []) {
      if (part.type === 'output_text' && part.text) chunks.push(part.text);
      if (part.type === 'text' && part.text) chunks.push(part.text);
    }
  }
  return clean(chunks.join('\n'));
}

async function generateVehicleDescription(unit) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error('AI descriptions are not configured yet. Add OPENAI_API_KEY on the server first.');
    err.code = 'missing_openai_key';
    throw err;
  }

  const model = process.env.OPENAI_DESCRIPTION_MODEL || 'gpt-5-mini';
  const response = await requestJson({
    hostname: 'api.openai.com',
    path: '/v1/responses',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  }, {
    model,
    input: promptFor(unit),
    reasoning: { effort: 'minimal' },
    max_output_tokens: 1200,
  });

  const description = responseText(response)
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!description) throw new Error('AI returned an empty description. Try again.');
  return description;
}

const BATCH_TIMEOUT_MS = Number(process.env.UNITNAV_PROVIDER_TIMEOUT_MS) || 20000;

function batchPrompt(units, variant) {
  const [, ...rest] = VARIANT_LENGTH_RULES[variant];
  // Opaque per-request refs (v1, v2, ...) — no database ids are ever sent.
  const vehicles = units.map((unit, i) => ({ ref: `v${i + 1}`, facts: vehicleFacts(unit) }));
  const intro = variant === 'facebook'
    ? 'Write a separate short used-car listing description for each vehicle below, for a dealership, suited to a Facebook Marketplace post.'
    : 'Write a separate short used-car listing description for each vehicle below, for a dealership.';
  return [
    intro,
    ...rest,
    ...SAFETY_RULES,
    'Return ONLY a JSON array with one object per vehicle, in exactly this shape: [{"ref":"<same ref as given>","description":"<the description text>"}]',
    'Copy each "ref" exactly from the vehicles below. Never invent, add, or omit refs. No prose and no markdown fences.',
    '',
    `Vehicles: ${JSON.stringify(vehicles)}`,
  ].join('\n');
}

function stripCodeFences(text) {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : text.trim();
}

function cleanDescription(value, maxChars) {
  let text = clean(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/^["']|["']$/g, '')
    .trim();
  if (text.length > maxChars) {
    const cut = text.slice(0, maxChars);
    const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    text = sentenceEnd > maxChars * 0.5 ? cut.slice(0, sentenceEnd + 1) : cut.slice(0, cut.lastIndexOf(' ')).trim();
  }
  return text;
}

// Accepts only refs that were actually requested; anything else in the
// provider's response is ignored. Returns an array aligned to the input
// units: a description string, or null when the provider gave nothing usable
// for that unit.
function validateBatch(parsed, count, maxChars) {
  if (!Array.isArray(parsed)) throw new Error('AI response was not a JSON array');
  const results = new Array(count).fill(null);
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || typeof item.ref !== 'string') continue;
    const match = /^v(\d+)$/.exec(item.ref);
    const index = match ? Number(match[1]) - 1 : -1;
    if (index < 0 || index >= count || results[index] !== null) continue;
    const description = typeof item.description === 'string' ? cleanDescription(item.description, maxChars) : '';
    if (description) results[index] = description;
  }
  return results;
}

// ONE provider request for the whole batch. `requestOverride` replaces the
// HTTPS transport so tests never contact the provider.
async function generateBatchDescriptions(units, { variant = 'standard', requestOverride } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error('AI descriptions are not configured yet. Add OPENAI_API_KEY on the server first.');
    err.code = 'missing_openai_key';
    throw err;
  }
  if (!Object.prototype.hasOwnProperty.call(VARIANTS, variant)) throw new Error(`Unknown description variant: ${variant}`);
  if (!units.length) return [];

  const model = process.env.OPENAI_DESCRIPTION_MODEL || 'gpt-5-mini';
  const send = requestOverride || requestJson;
  const response = await send({
    hostname: 'api.openai.com',
    path: '/v1/responses',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  }, {
    model,
    input: batchPrompt(units, variant),
    reasoning: { effort: 'minimal' },
    max_output_tokens: VARIANTS[variant].maxOutputTokens,
  }, BATCH_TIMEOUT_MS);

  let parsed;
  try {
    parsed = JSON.parse(stripCodeFences(responseText(response)));
  } catch {
    throw new Error('AI response was not valid JSON');
  }
  return validateBatch(parsed, units.length, VARIANTS[variant].maxChars);
}

module.exports = {
  generateVehicleDescription, generateBatchDescriptions, vehicleFacts, promptFor, batchPrompt, validateBatch, VARIANTS,
};
