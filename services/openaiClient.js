'use strict';
// Minimal shared OpenAI Responses API client. Used by the follow-up draft
// service; the existing description and priorities services keep their own
// copies for now and are intentionally untouched.
//
// One request per call, a hard timeout, and no logging of prompts or keys.
// `requestOverride` replaces the HTTPS transport so tests never contact the
// provider.
const https = require('https');

const DEFAULT_MODEL = 'gpt-5-mini';

function providerConfig() {
  return {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_DESCRIPTION_MODEL || DEFAULT_MODEL,
    timeoutMs: Number(process.env.UNITNAV_PROVIDER_TIMEOUT_MS) || 20000,
  };
}

function requestJson(options, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = raw ? JSON.parse(raw) : null; } catch { /* not json */ }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(parsed?.error?.message || `OpenAI request failed with ${res.statusCode}`));
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
  if (response?.output_text) return String(response.output_text).trim();
  const chunks = [];
  for (const item of response?.output || []) {
    for (const part of item.content || []) {
      if ((part.type === 'output_text' || part.type === 'text') && part.text) chunks.push(part.text);
    }
  }
  return chunks.join('\n').trim();
}

function stripCodeFences(text) {
  const fenced = String(text).trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : String(text).trim();
}

// Returns the model's text. Throws an error with code `missing_openai_key`
// when no key is configured (before any network use).
async function completeText({ input, maxOutputTokens = 800, requestOverride } = {}) {
  const { apiKey, model, timeoutMs } = providerConfig();
  if (!apiKey) {
    const err = new Error('AI is not configured yet. Add OPENAI_API_KEY on the server first.');
    err.code = 'missing_openai_key';
    throw err;
  }
  const send = requestOverride || requestJson;
  const response = await send({
    hostname: 'api.openai.com',
    path: '/v1/responses',
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  }, {
    model,
    input,
    reasoning: { effort: 'minimal' },
    max_output_tokens: maxOutputTokens,
  }, timeoutMs);
  return stripCodeFences(responseText(response));
}

module.exports = { providerConfig, requestJson, responseText, stripCodeFences, completeText };
