# CURRENT_WORK.md

This file holds current, durable state only. It replaces stale entries rather than accumulating a diary. **Never store credentials, customer data, signing links, or temporary tokens here.**

- **Current workstream**: Roadmap item 2 (AI Listing Suite) is merged to `main` (PR #5, merge commit `9d3e84211f239546d56c084e6bd30530fa126648`) but **not deployed**. A live-provider validation must pass before deploying. Next roadmap items, in order: Import Retry and Import History, AI Follow-Up Drafts, Premium Feature Packaging (entitlements, usage limits, metering).
- **What it does**: select up to 10 units on the inventory page, then `POST /api/inventory/description-suggestions/bulk` (requires `inventory_edit`) returns suggestions in one batched provider call. Two variants: standard and a shorter Facebook-style one. Missing price, mileage, photos, year, make or model produce non-blocking warnings. Units that already have a description are identified and skipped by default (not sent to the provider); replacement suggestions need an explicit opt-in. Nothing is saved by generation. The dealer reviews, edits, and saves each unit through the existing `PUT /api/inventory/:id`, with a confirmation before replacing a description. Without `OPENAI_API_KEY` the page shows the warnings and a clear not-configured message. The existing single-vehicle routes, buttons, and confirmations are unchanged.
- **Safeguards**: units are loaded by id and the authenticated dealership only (foreign ids are silently dropped); only year, make, model, trim, body style, color, mileage and price are sent, under opaque `v1..vN` refs (no VIN, notes, costs, minimum price, or ids); provider refs that were not requested are ignored; output is length-capped per variant and escaped in the UI; the cache is keyed by dealership, variant and a fingerprint of the exact facts sent, expires after 5 minutes, and holds at most 500 entries. Identical requests that arrive while a provider call is still running share that one call (in-flight coalescing, same key); the in-flight entry is removed on success or failure and failures are never cached. Units with identical facts inside one request are sent once.
- **Files**: `services/listingQuality.js`, `services/listingSuite.js` (new); `services/vehicleDescription.js`, `routes/inventory.js`, `public/inventory.html` (changed); tests `listing-quality`, `listing-suite`, `listing-suite-route`, `inventory-page-listing`.
- **Branch**: `claude/listing-live-validation` (off `main` at `9d3e8421`). Adds `scripts/live-listing-validation.js` and its test, uncommitted.
- **Closed workstreams** (merged to `main` and deployed to production):
  - DocuSeal e-sign migration, integration-test scaffolding, and the single-document archival fix (PR #1)
  - Today's Priorities, roadmap item 1 (PR #2)
  - Public showroom hardening: explicit field allowlist, no dealership or non-ready-inventory fallback, showrooms off by default for new dealerships (PR #3)
  - Private data directory and database file permissions, enforced on every start and checked before the server accepts traffic (PR #4)
- **Production**: running `main` at `16136921` (before PR #5). `OPENAI_API_KEY` and `OPENAI_DESCRIPTION_MODEL` are set in root's PM2 environment (presence verified; values never read). `data/` and the database files are private to root. No AI suggestions have been generated in production.
- **Operational notes**: the app runs as `unitnavigator` in root's PM2 on the droplet. Deploy with the runbook in `DEPLOY_DIGITALOCEAN.md`: JWT_SECRET pre-check, `git pull`, `npm ci --omit=dev` when dependencies change, `pm2 restart unitnavigator`, then check logs and smoke-test.
- **Open items (not part of item 2)**:
  - Root's PM2 has no systemd boot unit (`pm2-root` not found), so the app may not return after a reboot.
  - No database backups exist on the droplet; a private backup procedure is documented but not scheduled.
  - Password rotation is an open owner decision because the database was readable by other local accounts before the fix.
  - Unit ids and numeric `?dealer=<id>` lookup are still sequential and enumerable; numeric lookup is kept temporarily.
- **Deliberately not built**: any per-route AI rate limiter. Authenticated AI usage limits, entitlements, and metering are recorded as requirements in `PRODUCT_ROADMAP.md` item 7 (Premium Feature Packaging) to be designed once for all AI routes.
- **Next action**: run `scripts/live-listing-validation.js` as root on the droplet (it reads the key from root's PM2 and uses a throwaway data directory and 2 synthetic vehicles, at most 2 provider requests), then deploy PR #5 if it passes.
- **Known manual dependency**: a human must complete both test signatures for any future live e-sign test run.
