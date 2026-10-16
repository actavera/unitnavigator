'use strict';
// The shared OpenAI helper, without any network use.
const test = require('node:test');
const assert = require('node:assert/strict');
const { completeText, responseText, stripCodeFences, providerConfig } = require('../services/openaiClient');

function withEnv(env, fn) {
  return async () => {
    const saved = {};
    for (const key of Object.keys(env)) { saved[key] = process.env[key]; if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
    try { await fn(); } finally {
      for (const key of Object.keys(env)) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    }
  };
}

test('without a key it throws missing_openai_key before using the transport at all', withEnv({ OPENAI_API_KEY: undefined }, async () => {
  let used = false;
  await assert.rejects(() => completeText({ input: 'x', requestOverride: async () => { used = true; return {}; } }), err => err.code === 'missing_openai_key');
  assert.equal(used, false);
}));

test('it sends one request with the configured model and timeout, and returns the text', withEnv({ OPENAI_API_KEY: 'test-key', OPENAI_DESCRIPTION_MODEL: 'test-model', UNITNAV_PROVIDER_TIMEOUT_MS: '1234' }, async () => {
  const seen = [];
  const text = await completeText({ input: 'hello', maxOutputTokens: 55, requestOverride: async (options, body, timeoutMs) => { seen.push({ options, body, timeoutMs }); return { output_text: '  answer  ' }; } });
  assert.equal(text, 'answer');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].options.hostname, 'api.openai.com');
  assert.equal(seen[0].options.path, '/v1/responses');
  assert.equal(seen[0].body.model, 'test-model');
  assert.equal(seen[0].body.input, 'hello');
  assert.equal(seen[0].body.max_output_tokens, 55);
  assert.equal(seen[0].timeoutMs, 1234);
  assert.equal(providerConfig().timeoutMs, 1234);
}));

test('the default model and timeout apply when nothing is configured', withEnv({ OPENAI_API_KEY: 'k', OPENAI_DESCRIPTION_MODEL: undefined, UNITNAV_PROVIDER_TIMEOUT_MS: undefined }, async () => {
  const config = providerConfig();
  assert.equal(config.model, 'gpt-5-mini');
  assert.equal(config.timeoutMs, 20000);
}));

test('responses are read from output_text or from structured output, and code fences are stripped', () => {
  assert.equal(responseText({ output_text: ' a ' }), 'a');
  assert.equal(responseText({ output: [{ content: [{ type: 'output_text', text: 'one' }, { type: 'text', text: 'two' }, { type: 'other', text: 'no' }] }] }), 'one\ntwo');
  assert.equal(responseText(null), '');
  assert.equal(stripCodeFences('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(stripCodeFences('plain'), 'plain');
});

test('transport failures and timeouts propagate for the caller to handle', withEnv({ OPENAI_API_KEY: 'k' }, async () => {
  await assert.rejects(() => completeText({ input: 'x', requestOverride: async () => { throw new Error('boom'); } }), /boom/);
  await assert.rejects(() => completeText({ input: 'x', requestOverride: async () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }); } }), err => err.code === 'ETIMEDOUT');
}));
