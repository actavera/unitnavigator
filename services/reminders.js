'use strict';
// Missing-document reminders, the first user of the communications
// foundation. A reminder goes to a customer only when ALL of these hold:
//   - the deal is pending and has outstanding checklist items;
//   - the dealership has enabled that channel;
//   - the channel's provider is configured on the server;
//   - the customer's latest consent for that channel is an explicit opt-in;
//   - the customer has a sendable address for it;
//   - it is within the send window in the dealership's time zone;
//   - the dealership's timing rules say a reminder is due.
// Messages name only the outstanding items' labels: never notes, reasons,
// amounts, or document contents. Every attempt is recorded. After the
// configured number of attempts the deal is escalated to dealership staff and
// no more reminders go out for it.
const crypto = require('crypto');
const messaging = require('./messaging');
const dealChecklist = require('./dealChecklist');

const CHANNELS = ['email', 'sms'];
const SEND_WINDOW = { startHour: 9, endHour: 18 };
const DEFAULTS = { first_after_days: 2, interval_days: 3, max_attempts: 3, timezone: 'America/Denver' };
const LIMITS = { first_after_days: [0, 30], interval_days: [1, 30], max_attempts: [1, 10] };
const OPT_OUT_WORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke', 'optout']);
const OPT_IN_WORDS = new Set(['start', 'unstop', 'yes']);

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS communication_consents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealership_id INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    channel TEXT NOT NULL CHECK(channel IN ('email','sms')),
    status TEXT NOT NULL CHECK(status IN ('opted_in','opted_out')),
    source TEXT NOT NULL,
    actor_user_id INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_communication_consents_customer ON communication_consents (dealership_id, customer_id, channel);

  CREATE TABLE IF NOT EXISTS communication_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dealership_id INTEGER NOT NULL,
    deal_id INTEGER,
    customer_id INTEGER NOT NULL,
    channel TEXT NOT NULL CHECK(channel IN ('email','sms')),
    purpose TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('sending','sent','failed')),
    to_address TEXT NOT NULL,
    subject TEXT,
    body TEXT NOT NULL,
    provider TEXT,
    provider_message_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_communication_messages_deal ON communication_messages (dealership_id, deal_id);

  CREATE TABLE IF NOT EXISTS deal_reminder_state (
    dealership_id INTEGER NOT NULL,
    deal_id INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    escalated_at TEXT,
    PRIMARY KEY (dealership_id, deal_id)
  );
`;

class ReminderError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function clampInt(value, [min, max]) {
  const n = Number(value);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function settingsFor(dealership) {
  return {
    email_enabled: Number(dealership.reminders_email_enabled) === 1,
    sms_enabled: Number(dealership.reminders_sms_enabled) === 1,
    first_after_days: clampInt(dealership.reminder_first_after_days, LIMITS.first_after_days) ?? DEFAULTS.first_after_days,
    interval_days: clampInt(dealership.reminder_interval_days, LIMITS.interval_days) ?? DEFAULTS.interval_days,
    max_attempts: clampInt(dealership.reminder_max_attempts, LIMITS.max_attempts) ?? DEFAULTS.max_attempts,
    timezone: validTimezone(dealership.timezone) ? dealership.timezone : DEFAULTS.timezone,
  };
}

function localHour(now, timezone) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(now)));
}

function parseTime(value) {
  const text = String(value || '');
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? `${text.replace(' ', 'T')}Z` : text);
}

// ── Consent ────────────────────────────────────────────────────────────────

function latestConsent(db, dealershipId, customerId, channel) {
  return db.prepare(`SELECT status, source, created_at FROM communication_consents
    WHERE dealership_id = ? AND customer_id = ? AND channel = ? ORDER BY id DESC LIMIT 1`).get(dealershipId, customerId, channel) || null;
}

function recordConsent(db, { dealershipId, customerId, channel, status, source, actorId = null, now = Date.now() }) {
  if (!CHANNELS.includes(channel)) throw new ReminderError('Choose email or text.');
  if (!['opted_in', 'opted_out'].includes(status)) throw new ReminderError('Choose opted in or opted out.');
  db.prepare(`INSERT INTO communication_consents (dealership_id, customer_id, channel, status, source, actor_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(dealershipId, customerId, channel, status, source, actorId, new Date(now).toISOString());
}

// Dealer-recorded consent for the deal's customer. Opting in requires the
// dealer to attest that the customer agreed; opting out never does.
function setDealConsent(db, { dealershipId, dealId, actorId, body = {}, now = Date.now() }) {
  const deal = db.prepare('SELECT id, customer_id FROM deals WHERE id = ? AND dealership_id = ?').get(Number(dealId), dealershipId);
  if (!deal || !deal.customer_id) throw new ReminderError('Deal not found', 404);
  const status = body.status;
  if (status === 'opted_in' && body.attested !== true) {
    throw new ReminderError('Confirm the customer agreed to receive these reminders before opting them in.');
  }
  db.transaction(() => {
    recordConsent(db, { dealershipId, customerId: deal.customer_id, channel: body.channel, status, source: 'dealer_recorded', actorId, now });
    db.prepare(`INSERT INTO activity_logs (dealership_id, entity_type, entity_id, action, note, user_id) VALUES (?, 'deal', ?, ?, ?, ?)`)
      .run(dealershipId, deal.id, 'Reminder consent updated', `${body.channel === 'sms' ? 'Text' : 'Email'}: ${status === 'opted_in' ? 'opted in' : 'opted out'}`, actorId);
  })();
}

// Inbound SMS keywords (STOP, START, ...) from the provider webhook. The
// platform uses one sending number, so an opt-out applies to every customer
// record with that phone number. Returns the reply text, if any.
function handleInboundSms(db, { from, body, now = Date.now() }) {
  const phone = messaging.normalizePhone(from);
  const word = String(body || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (!phone) return null;
  const status = OPT_OUT_WORDS.has(word) ? 'opted_out' : OPT_IN_WORDS.has(word) ? 'opted_in' : null;
  if (!status) return null;
  const customers = db.prepare('SELECT id, dealership_id, phone FROM customers WHERE phone IS NOT NULL AND phone != \'\'').all()
    .filter(c => messaging.normalizePhone(c.phone) === phone);
  // START only restores customers who previously opted in and then texted
  // STOP; it never opts in someone the dealer did not record consent for.
  db.transaction(() => {
    for (const c of customers) {
      if (status === 'opted_in') {
        const history = db.prepare("SELECT 1 FROM communication_consents WHERE dealership_id = ? AND customer_id = ? AND channel = 'sms' AND status = 'opted_in' LIMIT 1").get(c.dealership_id, c.id);
        if (!history) continue;
      }
      recordConsent(db, { dealershipId: c.dealership_id, customerId: c.id, channel: 'sms', status, source: status === 'opted_out' ? 'sms_stop' : 'sms_start', now });
    }
  })();
  return status === 'opted_out'
    ? 'You have been unsubscribed and will not receive more texts. Reply START to resubscribe.'
    : 'You have been resubscribed. Reply STOP to opt out.';
}

// Signed one-click email unsubscribe link parameters.
function unsubscribeToken(secret, dealershipId, customerId) {
  return crypto.createHmac('sha256', secret).update(`unsubscribe:${dealershipId}:${customerId}:email`).digest('base64url');
}

function validUnsubscribeToken(secret, dealershipId, customerId, token) {
  const expected = Buffer.from(unsubscribeToken(secret, dealershipId, customerId));
  const given = Buffer.from(String(token || ''));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// ── Content (template only; no AI) ────────────────────────────────────────

function listText(labels) {
  if (labels.length <= 1) return labels[0] || '';
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function buildMessage({ channel, customer, dealership, labels, unsubscribeUrl }) {
  const first = String(customer.first_name || '').trim().split(/\s+/)[0];
  const greeting = first && first !== 'New' ? `Hi ${first},` : 'Hi,';
  const name = dealership.legal_name || dealership.name;
  const contact = dealership.phone ? ` Questions? Call ${dealership.phone}.` : '';
  if (channel === 'sms') {
    const text = `${greeting} this is ${name}. To finish your vehicle paperwork we still need: ${listText(labels)}.${contact} Reply STOP to opt out.`;
    return { text: text.length > 480 ? `${greeting} this is ${name}. We still need ${labels.length} items to finish your vehicle paperwork.${contact} Reply STOP to opt out.` : text };
  }
  const address = [dealership.address, dealership.city, dealership.state, dealership.zip].filter(Boolean).join(', ');
  return {
    subject: `Items needed to finish your paperwork with ${name}`,
    text: [
      greeting,
      '',
      `This is ${name}. To finish your vehicle paperwork we still need:`,
      ...labels.map(l => `- ${l}`),
      '',
      `Please bring or send these at your convenience.${contact}`,
      '',
      name,
      address,
      '',
      `To stop these reminders: ${unsubscribeUrl}`,
    ].filter(line => line !== undefined).join('\n'),
  };
}

// ── Runner ─────────────────────────────────────────────────────────────────

function outstandingLabels(db, dealershipId, dealId) {
  return dealChecklist.listChecklist(db, { dealershipId, dealId, canSeeSensitive: false }).items
    .filter(i => i.effective_status === 'required' || i.effective_status === 'rejected')
    .map(i => i.label);
}

function firstOutstandingAt(db, dealershipId, dealId) {
  return db.prepare(`SELECT MIN(created_at) AS t FROM deal_checklist_items
    WHERE dealership_id = ? AND deal_id = ? AND removed_at IS NULL AND status IN ('required','rejected')`).get(dealershipId, dealId).t;
}

// One pass over every dealership. `send` maps channel -> async fn; defaults to
// the real adapters. Returns a summary for logging and tests.
async function runReminders(db, { now = Date.now(), env = process.env, secret, baseUrl = 'https://unitnavigator.com', send } = {}) {
  const senders = send || { email: msg => messaging.sendEmail(msg, env), sms: msg => messaging.sendSms(msg, env) };
  const configured = messaging.providerStatus(env);
  const summary = { sent: 0, failed: 0, escalated: 0, skipped: 0 };
  const dealerships = db.prepare("SELECT * FROM dealerships WHERE status = 'active' AND (reminders_email_enabled = 1 OR reminders_sms_enabled = 1)").all();
  for (const dealership of dealerships) {
    const settings = settingsFor(dealership);
    const channels = CHANNELS.filter(ch => settings[`${ch}_enabled`] && configured[ch]);
    if (!channels.length) continue;
    const hour = localHour(now, settings.timezone);
    if (hour < SEND_WINDOW.startHour || hour >= SEND_WINDOW.endHour) continue;

    const deals = db.prepare(`
      SELECT d.id, d.customer_id, c.first_name, c.email, c.phone, ${dealChecklist.OUTSTANDING_COUNT_SQL} AS outstanding
      FROM deals d JOIN customers c ON c.id = d.customer_id AND c.dealership_id = d.dealership_id
      WHERE d.dealership_id = ? AND d.status = 'pending'
    `).all(dealership.id).filter(d => d.outstanding > 0);

    for (const deal of deals) {
      const state = db.prepare('SELECT * FROM deal_reminder_state WHERE dealership_id = ? AND deal_id = ?').get(dealership.id, deal.id)
        || { attempts: 0, last_attempt_at: null, escalated_at: null };
      if (state.escalated_at) continue;
      const since = parseTime(firstOutstandingAt(db, dealership.id, deal.id));
      if (!Number.isFinite(since) || now - since < settings.first_after_days * 86400000) continue;
      if (state.last_attempt_at && now - parseTime(state.last_attempt_at) < settings.interval_days * 86400000) continue;

      if (state.attempts >= settings.max_attempts) {
        db.transaction(() => {
          db.prepare(`INSERT INTO deal_reminder_state (dealership_id, deal_id, attempts, last_attempt_at, escalated_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(dealership_id, deal_id) DO UPDATE SET escalated_at = excluded.escalated_at`)
            .run(dealership.id, deal.id, state.attempts, state.last_attempt_at, new Date(now).toISOString());
          db.prepare(`INSERT INTO activity_logs (dealership_id, entity_type, entity_id, action, note, user_id) VALUES (?, 'deal', ?, ?, ?, NULL)`)
            .run(dealership.id, deal.id, 'Reminders escalated to staff', `${state.attempts} reminder attempts; items still outstanding`);
        })();
        summary.escalated += 1;
        continue;
      }

      const targets = channels.map(channel => {
        const consent = latestConsent(db, dealership.id, deal.customer_id, channel);
        const to = channel === 'email' ? messaging.normalizeEmail(deal.email) : messaging.normalizePhone(deal.phone);
        return consent && consent.status === 'opted_in' && to ? { channel, to } : null;
      }).filter(Boolean);
      if (!targets.length) { summary.skipped += 1; continue; }

      const labels = outstandingLabels(db, dealership.id, deal.id);
      const unsubscribeUrl = `${baseUrl}/api/public/unsubscribe?d=${dealership.id}&c=${deal.customer_id}&t=${unsubscribeToken(secret, dealership.id, deal.customer_id)}`;
      for (const { channel, to } of targets) {
        const content = buildMessage({ channel, customer: deal, dealership, labels, unsubscribeUrl });
        const stamp = new Date(now).toISOString();
        const id = Number(db.prepare(`INSERT INTO communication_messages
          (dealership_id, deal_id, customer_id, channel, purpose, status, to_address, subject, body, created_at)
          VALUES (?, ?, ?, ?, 'missing_documents', 'sending', ?, ?, ?, ?)`)
          .run(dealership.id, deal.id, deal.customer_id, channel, to, content.subject || null, content.text, stamp).lastInsertRowid);
        try {
          const result = await senders[channel]({ to, subject: content.subject, text: content.text });
          db.prepare("UPDATE communication_messages SET status = 'sent', provider = ?, provider_message_id = ?, completed_at = ? WHERE id = ?")
            .run(result.provider || null, result.provider_message_id || null, new Date().toISOString(), id);
          summary.sent += 1;
        } catch (err) {
          db.prepare("UPDATE communication_messages SET status = 'failed', error = ?, completed_at = ? WHERE id = ?")
            .run(String(err.message || 'Send failed').slice(0, 300), new Date().toISOString(), id);
          summary.failed += 1;
        }
      }
      // One attempt per run, whether it succeeded or failed; failures are
      // retried on the next interval until the attempt limit escalates.
      db.prepare(`INSERT INTO deal_reminder_state (dealership_id, deal_id, attempts, last_attempt_at) VALUES (?, ?, 1, ?)
        ON CONFLICT(dealership_id, deal_id) DO UPDATE SET attempts = attempts + 1, last_attempt_at = excluded.last_attempt_at`)
        .run(dealership.id, deal.id, new Date(now).toISOString());
    }
  }
  return summary;
}

function maskAddress(channel, value) {
  const text = String(value || '');
  if (channel === 'sms') return text.length > 4 ? `•••${text.slice(-4)}` : '•••';
  const [user, domain] = text.split('@');
  return domain ? `${user.slice(0, 1)}•••@${domain}` : '•••';
}

// What the deal modal shows: consent per channel, reminder state, and recent
// attempts (addresses masked, bodies omitted).
function dealCommunications(db, { dealershipId, dealId, env = process.env }) {
  const deal = db.prepare('SELECT d.id, d.customer_id, c.email, c.phone FROM deals d LEFT JOIN customers c ON c.id = d.customer_id AND c.dealership_id = d.dealership_id WHERE d.id = ? AND d.dealership_id = ?')
    .get(Number(dealId), dealershipId);
  if (!deal) throw new ReminderError('Deal not found', 404);
  const dealership = db.prepare('SELECT * FROM dealerships WHERE id = ?').get(dealershipId);
  const settings = settingsFor(dealership);
  const configured = messaging.providerStatus(env);
  const consent = Object.fromEntries(CHANNELS.map(ch => [ch, deal.customer_id ? latestConsent(db, dealershipId, deal.customer_id, ch) : null]));
  const state = db.prepare('SELECT attempts, last_attempt_at, escalated_at FROM deal_reminder_state WHERE dealership_id = ? AND deal_id = ?').get(dealershipId, deal.id) || { attempts: 0, last_attempt_at: null, escalated_at: null };
  const messages = db.prepare(`SELECT id, channel, status, to_address, error, created_at, completed_at FROM communication_messages
    WHERE dealership_id = ? AND deal_id = ? ORDER BY id DESC LIMIT 20`).all(dealershipId, deal.id)
    .map(m => ({ ...m, to_address: maskAddress(m.channel, m.to_address) }));
  return {
    channels: CHANNELS.map(ch => ({
      channel: ch,
      dealership_enabled: settings[`${ch}_enabled`],
      provider_configured: configured[ch],
      has_address: Boolean(ch === 'email' ? messaging.normalizeEmail(deal.email) : messaging.normalizePhone(deal.phone)),
      consent: consent[ch] ? consent[ch].status : 'none',
      consent_source: consent[ch] ? consent[ch].source : null,
    })),
    state,
    messages,
  };
}

function deleteForDeals(db, dealershipId, dealIds) {
  const msgs = db.prepare('DELETE FROM communication_messages WHERE dealership_id = ? AND deal_id = ?');
  const st = db.prepare('DELETE FROM deal_reminder_state WHERE dealership_id = ? AND deal_id = ?');
  dealIds.forEach(id => { msgs.run(dealershipId, id); st.run(dealershipId, id); });
}

function deleteForCustomer(db, dealershipId, customerId) {
  db.prepare('DELETE FROM communication_messages WHERE dealership_id = ? AND customer_id = ?').run(dealershipId, customerId);
  db.prepare('DELETE FROM communication_consents WHERE dealership_id = ? AND customer_id = ?').run(dealershipId, customerId);
}

function deleteForDealership(db, dealershipId) {
  for (const t of ['communication_messages', 'communication_consents', 'deal_reminder_state']) {
    db.prepare(`DELETE FROM ${t} WHERE dealership_id = ?`).run(dealershipId);
  }
}

module.exports = {
  SCHEMA_SQL, CHANNELS, DEFAULTS, LIMITS, SEND_WINDOW, ReminderError,
  settingsFor, validTimezone, latestConsent, recordConsent, setDealConsent, handleInboundSms,
  unsubscribeToken, validUnsubscribeToken, buildMessage, runReminders, dealCommunications,
  deleteForDeals, deleteForCustomer, deleteForDealership,
};
