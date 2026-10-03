'use strict';
// Batched AI enhancement for the "Today's Priorities" list. The deterministic
// reason/next_step text (computed in routes/dashboard.js, never here) is
// always sufficient on its own — this module only ever rewrites that text
// into friendlier phrasing, in ONE request for the whole batch. It never
// decides ranking, priority level, links, actions, or ids: those come only
// from the server's own deterministic computation, and this module's output
// is validated against exactly the ids it was given before anything from it
// is used.
const https = require('https');

const REQUEST_TIMEOUT_MS = Number(process.env.UNITNAV_PROVIDER_TIMEOUT_MS) || 20000;
const MAX_TEXT_LENGTH = 400;

function clean(value) {
  return String(value ?? '').trim();
}

// Deliberately minimal and non-identifying: type/priority_level/age_days/
// status plus `ai_context` — a name-free restatement of the situation built
// specifically for this purpose in routes/dashboard.js (toPriority). Never
// the display `reason`/`next_step` (those can contain a customer or staff
// member's name), never a VIN, never a customer contact detail, never a user
// email or name.
function operationalFacts(priority) {
  return {
    id: priority.id,
    type: priority.type,
    priority_level: priority.priority_level,
    age_days: priority.age_days,
    status: priority.status,
    situation: priority.ai_context,
  };
}

function promptFor(priorities) {
  const items = priorities.map(operationalFacts);
  return [
    'You are helping a used-vehicle dealership staff member triage a prioritized worklist.',
    'For each item below, based on its "situation", write a short, plain-language "summary" of the situation, and a short, clear "recommendation" for what to do next.',
    'Use only the facts given in each item. Do not invent new facts, names, amounts, or details not present in the item.',
    'Do not change priority_level, type, or id — those are fixed and are not yours to alter.',
    'Return ONLY a JSON array, one object per input item, in exactly this shape: [{"id": "<same id as given>", "summary": "<rewritten reason>", "recommendation": "<rewritten next_step>"}]',
    'Every "id" in your response must be copied exactly from one of the items below. Never invent, omit un-requested items, or add extra ids.',
    'Return nothing except the JSON array — no prose, no markdown fences.',
    '',
    `Items: ${JSON.stringify(items)}`,
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
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('OpenAI request timed out'), { code: 'ETIMEDOUT' })));
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

// Strips markdown code fences a model sometimes wraps JSON in, without
// otherwise touching the content — the JSON.parse below is what actually
// validates the shape.
function stripCodeFences(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

// Validates the model's response against ONLY the ids it was given —
// anything else (an unrecognized id, a non-string field, an attempt to also
// send priority_level/link/actions/score) is silently dropped. This is the
// enforcement point that guarantees AI output can only ever rewrite text for
// priorities the caller already knows about, never introduce or relabel one.
function validateGuidance(parsed, knownIds) {
  if (!Array.isArray(parsed)) throw new Error('AI response was not a JSON array');
  const out = {};
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id : '';
    if (!knownIds.has(id)) continue;
    const summary = typeof item.summary === 'string' ? clean(item.summary).slice(0, MAX_TEXT_LENGTH) : '';
    const recommendation = typeof item.recommendation === 'string' ? clean(item.recommendation).slice(0, MAX_TEXT_LENGTH) : '';
    if (!summary && !recommendation) continue;
    out[id] = {};
    if (summary) out[id].summary = summary;
    if (recommendation) out[id].recommendation = recommendation;
  }
  return out;
}

// Single batched request for the whole list — never one request per
// priority. `requestOverride` exists solely so tests can inject a fake
// transport without ever contacting OpenAI.
async function generateBatchGuidance(priorities, { requestOverride } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const err = new Error('AI guidance is not configured yet. Add OPENAI_API_KEY on the server first.');
    err.code = 'missing_openai_key';
    throw err;
  }
  if (!Array.isArray(priorities) || priorities.length === 0) return {};

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
    input: promptFor(priorities),
    reasoning: { effort: 'minimal' },
    max_output_tokens: 4000,
  }, REQUEST_TIMEOUT_MS);

  const text = stripCodeFences(responseText(response));
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('AI response was not valid JSON');
  }

  const knownIds = new Set(priorities.map(p => p.id));
  return validateGuidance(parsed, knownIds);
}

module.exports = { generateBatchGuidance, operationalFacts, promptFor, validateGuidance };
