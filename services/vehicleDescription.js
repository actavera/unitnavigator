'use strict';

const https = require('https');

function clean(value) {
  return String(value ?? '').trim();
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
    year: clean(unit.year),
    make: clean(unit.make),
    model: clean(unit.model),
    trim: clean(unit.trim),
    body_style: clean(unit.body_style),
    color: clean(unit.color),
    mileage: miles(unit.mileage),
    price: money(unit.asking_price),
  };
}

function promptFor(unit) {
  const facts = vehicleFacts(unit);
  return [
    'Write a short used-car listing description for a dealership.',
    'Style: catchy, confident, plain-spoken, and sales-friendly. Keep it punchy, not too wordy.',
    'Length: 55 to 90 words.',
    'Only use facts provided. Do not invent condition, accident history, title status, ownership history, warranty, service records, financing, discounts, or availability.',
    'Do not include contact information, phone numbers, email, address, hashtags, emoji, or generic obvious features like seatbelts.',
    'Focus on useful differentiators from trim, body style, mileage, color, and price when available.',
    'Return only the description text.',
    '',
    `Vehicle facts: ${JSON.stringify(facts)}`,
  ].join('\n');
}

function requestJson(options, body) {
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
    max_output_tokens: 220,
  });

  const description = responseText(response)
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!description) throw new Error('AI returned an empty description. Try again.');
  return description;
}

module.exports = { generateVehicleDescription, vehicleFacts };
