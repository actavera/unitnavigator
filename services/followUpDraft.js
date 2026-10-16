'use strict';
// Follow-up DRAFTS for a pending deal. This module only reads data and
// produces text: it never writes to the database, sends anything, or changes
// a deal, customer, price, task, or workflow state. Nothing it returns is
// stored; the user reviews, edits, and sends (or copies) the text themselves.
//
// A deterministic template draft is always available. AI only rewrites that
// wording, on an explicit request, and it never sees a customer, sender, or
// dealership name: the prompt uses placeholders that this module fills in
// locally afterwards. If AI is unavailable or its output is unusable, the
// template draft is returned instead.
const { completeText } = require('./openaiClient');

const CHANNELS = ['email', 'text'];
const LIMITS = {
  email: { subject: 90, body: 900 },
  text: { body: 320 },
};
const PLACEHOLDERS = ['customer_first_name', 'sender_name', 'dealership_name'];

class FollowUpError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function cleanShort(value, max = 60) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Names go into the final text only (never to the provider). Stripping the
// placeholder delimiters keeps a name from being mistaken for a placeholder.
function cleanName(value) {
  return cleanShort(value, 40).replace(/[{}]/g, '');
}

function daysBetween(fromIso, now) {
  const t = new Date(String(fromIso || '').replace(' ', 'T') + (String(fromIso || '').includes('T') ? '' : 'Z')).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now - t) / 86400000));
}

// Reads everything needed for a draft, scoped to the dealership at every step.
function loadDraftContext(db, { dealershipId, userId, dealId, now = Date.now() }) {
  const id = Number(dealId);
  if (!Number.isInteger(id) || id <= 0) throw new FollowUpError('Deal not found', 404);
  const deal = db.prepare('SELECT id, customer_id, unit_id, status, next_follow_up_at, created_at FROM deals WHERE id = ? AND dealership_id = ?')
    .get(id, dealershipId);
  if (!deal) throw new FollowUpError('Deal not found', 404);
  if (deal.status !== 'pending') throw new FollowUpError('Follow-up drafts are only available for pending deals.', 409);

  const customer = deal.customer_id
    ? db.prepare('SELECT first_name, last_name FROM customers WHERE id = ? AND dealership_id = ?').get(deal.customer_id, dealershipId)
    : null;
  const unit = deal.unit_id
    ? db.prepare('SELECT year, make, model FROM units WHERE id = ? AND dealership_id = ?').get(deal.unit_id, dealershipId)
    : null;
  const sender = userId ? db.prepare('SELECT name FROM users WHERE id = ? AND dealership_id = ?').get(userId, dealershipId) : null;
  const dealership = db.prepare('SELECT name FROM dealerships WHERE id = ?').get(dealershipId);

  // The importer's placeholder for an unnamed customer is "New Customer".
  const unnamed = !customer || !customer.first_name || (customer.first_name === 'New' && customer.last_name === 'Customer');
  const vehicle = unit ? cleanShort([unit.year, unit.make, unit.model].filter(Boolean).join(' ')) : '';
  const overdue = Boolean(deal.next_follow_up_at) && new Date(String(deal.next_follow_up_at).slice(0, 10) + 'T23:59:59').getTime() < now;

  return {
    names: {
      customer_first_name: unnamed ? 'there' : cleanName(customer.first_name.split(/\s+/)[0]),
      sender_name: cleanName(sender && sender.name) || 'Your sales team',
      dealership_name: cleanName(dealership && dealership.name) || 'our dealership',
    },
    facts: {
      purpose: overdue ? 'overdue_follow_up' : 'check_in',
      vehicle,
      days_since_started: daysBetween(deal.created_at, now),
    },
  };
}

// ---- deterministic template drafts (placeholders are filled in locally) ----

function templateDraft(channel, facts) {
  const vehicle = facts.vehicle;
  const aboutVehicle = vehicle ? `the ${vehicle}` : 'the vehicle you were looking at';
  const overdue = facts.purpose === 'overdue_follow_up';
  if (channel === 'text') {
    const body = overdue
      ? `Hi {{customer_first_name}}, it's {{sender_name}} from {{dealership_name}}. I'm following up on ${aboutVehicle}. Are you still interested? Happy to help whenever you're ready.`
      : `Hi {{customer_first_name}}, it's {{sender_name}} at {{dealership_name}}. Just checking in on ${aboutVehicle}. Any questions I can help with?`;
    return { body };
  }
  const subject = vehicle ? `Following up on the ${vehicle}` : 'Following up on your vehicle search';
  const opening = overdue
    ? `I'm following up on our recent conversation about ${aboutVehicle}. I know it has been a little while, and I wanted to see where things stand.`
    : `I wanted to check in and see if you have any questions about ${aboutVehicle}.`;
  const body = [
    'Hi {{customer_first_name}},',
    '',
    `This is {{sender_name}} at {{dealership_name}}. ${opening} I'm happy to answer questions or set up a time for you to come in.`,
    '',
    'Thank you,',
    '{{sender_name}}',
    '{{dealership_name}}',
  ].join('\n');
  return { subject, body };
}

function fillPlaceholders(text, names) {
  return String(text).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_match, key) => (key in names ? names[key] : ''));
}

function renderDraft(draft, names) {
  const out = { body: fillPlaceholders(draft.body, names) };
  if (draft.subject !== undefined) out.subject = fillPlaceholders(draft.subject, names);
  return out;
}

// ---- AI rewrite ----

function promptFor(channel, facts) {
  const limits = LIMITS[channel];
  return [
    `Write a short, friendly, professional ${channel === 'email' ? 'email' : 'text message'} from a car salesperson to a customer, following up on a deal.`,
    'Use these placeholders exactly, in double curly braces, and nowhere else: {{customer_first_name}}, {{sender_name}}, {{dealership_name}}.',
    'Greet the customer with {{customer_first_name}} and sign off with {{sender_name}} and {{dealership_name}}. Never write a real name.',
    'Only use the facts provided. Do not invent anything. Do not mention prices, payments, discounts, financing, rates, trade-in values, availability, or deadlines, and make no promises.',
    'Do not include phone numbers, email addresses, links, emoji, hashtags, or formatting characters.',
    channel === 'email'
      ? `Return ONLY a JSON object: {"subject": "<up to ${limits.subject} characters>", "body": "<up to ${limits.body} characters>"}`
      : `Return ONLY a JSON object: {"body": "<up to ${limits.body} characters, one or two short sentences>"}`,
    'No markdown fences and no extra text.',
    '',
    `Facts: ${JSON.stringify({ channel, purpose: facts.purpose, vehicle: facts.vehicle || null, days_since_started: facts.days_since_started })}`,
  ].join('\n');
}

const FORBIDDEN = [
  [/https?:\/\/|www\./i, 'a link'],
  [/[^\s@]+@[^\s@]+\.[^\s@]+/, 'an email address'],
  [/\+?\d[\d\s().-]{6,}\d/, 'a phone number'],
  [/[$€£]|%/, 'a price or rate'],
  [/\b(apr|discount|rebate|guarantee[ds]?|out[- ]the[- ]door)\b/i, 'a pricing or promise term'],
  [/[<>]/, 'markup'],
];

// AI output is untrusted text. It must be the expected JSON shape, within the
// length limits, use only the known placeholders, and contain nothing that
// could be a link, contact detail, price, or promise.
function validateAiDraft(raw, channel) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('AI response was not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('AI response was not a JSON object');
  const limits = LIMITS[channel];
  const body = typeof parsed.body === 'string' ? parsed.body.replace(/\r\n/g, '\n').trim() : '';
  if (!body) throw new Error('AI response had no body');
  if (body.length > limits.body) throw new Error('AI body was too long');
  const draft = { body };
  if (channel === 'email') {
    const subject = typeof parsed.subject === 'string' ? parsed.subject.replace(/\s+/g, ' ').trim() : '';
    if (!subject) throw new Error('AI response had no subject');
    if (subject.length > limits.subject) throw new Error('AI subject was too long');
    draft.subject = subject;
  }
  for (const text of [draft.subject, draft.body].filter(Boolean)) {
    for (const [pattern, label] of FORBIDDEN) {
      if (pattern.test(text)) throw new Error(`AI draft contained ${label}`);
    }
    for (const [, key] of text.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
      if (!PLACEHOLDERS.includes(key)) throw new Error('AI draft used an unknown placeholder');
    }
    if (/\{\{|\}\}/.test(text.replace(/\{\{\s*[a-z_]+\s*\}\}/g, ''))) throw new Error('AI draft had a malformed placeholder');
  }
  // The model never sees real names, so a draft that greets someone without
  // the placeholder has invented a name. Require the greeting and sender
  // placeholders so every real name comes from this module, not the model.
  for (const required of ['customer_first_name', 'sender_name']) {
    if (!new RegExp(`\\{\\{\\s*${required}\\s*\\}\\}`).test(draft.body)) throw new Error(`AI draft did not use the ${required} placeholder`);
  }
  return draft;
}

async function generateAiDraft(channel, facts, { requestOverride } = {}) {
  const text = await completeText({ input: promptFor(channel, facts), maxOutputTokens: 800, requestOverride });
  return validateAiDraft(text, channel);
}

const MESSAGES = {
  not_configured: 'AI rewriting is not configured yet. Showing the standard draft.',
  timeout: 'AI rewriting timed out. Showing the standard draft.',
  unusable_response: 'The AI response could not be used. Showing the standard draft.',
  unavailable: 'AI rewriting is unavailable right now. Showing the standard draft.',
};

function failureReason(err) {
  if (err && err.code === 'missing_openai_key') return 'not_configured';
  if (err && err.code === 'ETIMEDOUT') return 'timeout';
  if (err && /^AI (response|draft|body|subject)/.test(err.message || '')) return 'unusable_response';
  return 'unavailable';
}

// Returns { draft: { channel, purpose, source, subject?, body }, ai_unavailable?, reason?, message? }.
async function buildFollowUpDraft({ db, dealershipId, userId, dealId, channel, useAi = false, generate = generateAiDraft, now = Date.now() }) {
  if (!CHANNELS.includes(channel)) throw new FollowUpError(`channel must be one of: ${CHANNELS.join(', ')}.`, 400);
  const { names, facts } = loadDraftContext(db, { dealershipId, userId, dealId, now });
  const template = templateDraft(channel, facts);
  const base = { channel, purpose: facts.purpose };

  if (!useAi) {
    return { draft: { ...base, source: 'template', ...renderDraft(template, names) } };
  }
  try {
    // The one and only provider call for this request.
    const ai = await generate(channel, facts);
    return { draft: { ...base, source: 'ai', ...renderDraft(ai, names) } };
  } catch (err) {
    const reason = failureReason(err);
    return {
      draft: { ...base, source: 'template', ...renderDraft(template, names) },
      ai_unavailable: true,
      reason,
      message: MESSAGES[reason],
    };
  }
}

module.exports = {
  CHANNELS, LIMITS, PLACEHOLDERS, FollowUpError,
  loadDraftContext, templateDraft, renderDraft, promptFor, validateAiDraft, generateAiDraft, buildFollowUpDraft,
};
