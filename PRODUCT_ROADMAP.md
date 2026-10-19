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
- **Communications foundation**: a shared email/SMS layer for the product, with consent tracking (opt-in and opt-out records) and compliance review required before any automated customer email or SMS is sent. Follow-up drafts stay manual until this exists.
- **Operational reminders**: connect automated reminders to the existing inventory, pending-deal, and document-status alerts, using the communications foundation.

Communications foundation and missing-document reminders are built; they start sending once provider credentials are configured.

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
- BHPH financial data needs its own security review before launch.
