'use strict';
// Outbound messaging adapters. Email goes through Postmark and SMS through
// Twilio, each only when its credentials are present in the environment. With
// no credentials a channel is "not configured" and nothing is ever sent.
//
// Every request goes through `transport`, which tests replace so they never
// contact a provider. Credentials are never logged or returned.
const https = require('https');
const crypto = require('crypto');

let transport = defaultTransport;

function defaultTransport({ hostname, path, method = 'POST', headers, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers }, res => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(Object.assign(new Error('Provider request timed out'), { code: 'ETIMEDOUT' })));
    req.end(body);
  });
}

function setTransport(fn) { transport = fn || defaultTransport; }

function emailConfig(env = process.env) {
  return env.POSTMARK_SERVER_TOKEN && env.REMINDER_EMAIL_FROM
    ? { token: env.POSTMARK_SERVER_TOKEN, from: env.REMINDER_EMAIL_FROM }
    : null;
}

function smsConfig(env = process.env) {
  return env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER
    ? { sid: env.TWILIO_ACCOUNT_SID, token: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM_NUMBER }
    : null;
}

function providerStatus(env = process.env) {
  return { email: Boolean(emailConfig(env)), sms: Boolean(smsConfig(env)) };
}

// US numbers to E.164; anything else is not sendable.
function normalizePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function normalizeEmail(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/.test(text) && !text.endsWith('.invalid') ? text : null;
}

function providerError(status, body) {
  let detail = '';
  try { const j = JSON.parse(body); detail = j.Message || j.message || ''; } catch { /* not json */ }
  return Object.assign(new Error(`Provider rejected the message (${status})${detail ? `: ${String(detail).slice(0, 160)}` : ''}`), { code: 'provider_rejected' });
}

async function sendEmail({ to, subject, text, unsubscribeUrl }, env = process.env) {
  const config = emailConfig(env);
  if (!config) throw Object.assign(new Error('Email is not configured'), { code: 'not_configured' });
  const res = await transport({
    hostname: 'api.postmarkapp.com',
    path: '/email',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Postmark-Server-Token': config.token },
    body: JSON.stringify({
      From: config.from, To: to, Subject: subject, TextBody: text, MessageStream: 'outbound',
      // One-click unsubscribe (RFC 8058) for mail clients that support it.
      ...(unsubscribeUrl ? { Headers: [{ Name: 'List-Unsubscribe', Value: `<${unsubscribeUrl}>` }, { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' }] } : {}),
    }),
  });
  if (res.status < 200 || res.status >= 300) throw providerError(res.status, res.body);
  let id = null;
  try { id = JSON.parse(res.body).MessageID || null; } catch { /* ignore */ }
  return { provider: 'postmark', provider_message_id: id };
}

async function sendSms({ to, text }, env = process.env) {
  const config = smsConfig(env);
  if (!config) throw Object.assign(new Error('SMS is not configured'), { code: 'not_configured' });
  const res = await transport({
    hostname: 'api.twilio.com',
    path: `/2010-04-01/Accounts/${encodeURIComponent(config.sid)}/Messages.json`,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${config.sid}:${config.token}`).toString('base64')}`,
    },
    body: new URLSearchParams({ To: to, From: config.from, Body: text }).toString(),
  });
  if (res.status < 200 || res.status >= 300) throw providerError(res.status, res.body);
  let id = null;
  try { id = JSON.parse(res.body).sid || null; } catch { /* ignore */ }
  return { provider: 'twilio', provider_message_id: id };
}

// Twilio request signature: base64 HMAC-SHA1 over the full URL followed by
// each POST parameter name and value, sorted by name.
function validTwilioSignature({ url, params, signature }, env = process.env) {
  const config = smsConfig(env);
  if (!config || !signature) return false;
  const data = url + Object.keys(params || {}).sort().map(k => `${k}${params[k]}`).join('');
  const expected = crypto.createHmac('sha1', config.token).update(data).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  setTransport, emailConfig, smsConfig, providerStatus, normalizePhone, normalizeEmail,
  sendEmail, sendSms, validTwilioSignature,
};
