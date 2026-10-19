# Unit Navigator — Product Roadmap

Durable backlog of genuinely unfinished work, in priority order. Shipped features are removed, not kept as history; see `CURRENT_WORK.md` for current state. Entries describe intent and scope, not committed delivery dates.

## Commercial model

- **Base product: $500 per dealership per month.** Includes the normal 700Credit subscription, all existing AI features (Today's Priorities, AI Listing Suite, AI Follow-Up Drafts), the simple dealer showroom, contracts and e-sign, and base operational automation.
- **Custom dealer websites** are referred to Adz Solutions; Unit Navigator does not build them.
- **Potential paid add-ons**: social publishing, additional 700Credit products, live market pricing, and BHPH servicing.
- **General inventory syndication** is deferred until demand is proven.
- Billing is manual until a separate billing decision is made; nothing here implies automated charging.

## 1. Base Operations Completion
Finish the operational core that the $500 base product promises.
- **Deal document checklist**: turn the existing `documents` records and incomplete-paperwork reporting into a usable per-deal checklist.
- **Communications foundation**: a shared email/SMS layer for the product, with consent tracking (opt-in and opt-out records) and compliance review required before any automated customer email or SMS is sent. Follow-up drafts stay manual until this exists.
- **Operational reminders**: connect automated reminders to the existing inventory, pending-deal, and document-status alerts, using the communications foundation.

Start with the deal document checklist.

## 2. Title, Plate, and Registration Tracking
Post-sale obligations tracking, intended for the $500 base product.
- Title status: received, needed, submitted, completed.
- Temporary-tag and registration deadlines.
- Plate status.
- Required-item checklist.
- Assigned employee, due dates, overdue alerts, and manager escalation.
- Post-sale obligations dashboard.

## 3. Add-On Entitlements and Usage Controls
Control which dealerships can use which paid features, without automated billing.
- Current AI features, the simple showroom, and basic operations stay in the $500 base product; entitlements gate the paid add-ons listed above.
- Internal usage visibility for AI and messaging (counted per provider request; no prompt, output, or customer content stored), designed once and applied to every AI route.
- Entitlements by dealership and feature, checked before any provider call, with per-user permissions still applying inside an entitled dealership.
- A dedicated bulk-contact-export permission (the contacts export currently needs only `reports_view`, which default staff roles have) and an export audit history covering the contacts export, the inventory export, and future exports.
- No automated purchasing, charging, or invoicing.

## 4. 700Credit Product Add-Ons
Begin with an audit of 700Credit's provider documentation and authorization requirements before any implementation. Then add products incrementally, each separately authorized and tested: identity/fraud, compliance, DL/DMV verification, income, prescreen/prequalification, and monthly products.

## 5. Social Selling Suite
Facebook Page and Instagram publishing first. Direct Marketplace posting only if an official, supported route is confirmed.

## 6. Live Market Pricing Intelligence
Provider evaluation first (coverage, licensing, cost, API limits, allowed display and storage terms). No ZIP or local adjustment is built until a legitimate source is selected; the existing internal pricing estimate stays separately labeled.

## 7. BHPH Servicing
Buy-here-pay-here account servicing (potential paid add-on).
- Account balance and payment schedule.
- Payment history and receipts.
- Delinquency and promise-to-pay tracking.
- Customer reminders with consent controls.
- Payoff quotes, fees, adjustments, notes, permissions, reporting, and complete audit history.
- Payment processing, provider selection, detailed compliance requirements, and pricing are decisions for this workstream.
- BHPH financial data must pass the final security audit (item 8) before launch.

## 8. Final Security and Production-Readiness Audit
Covers: auth/session security, tenant isolation, permissions, PII and credit data, messaging consent, BHPH financial data, XSS/CSRF, uploads, SSRF, rate limiting, headers/CSP, secrets, database and document permissions, sensitive logging, dependencies, backups and restore, PM2 boot recovery, monitoring, and security regression tests.

Deliverable: a final report ranking findings Critical, High, Medium, and Low. Critical and High findings must be resolved before the roadmap is considered complete.
