# CURRENT_WORK.md

This file holds current, durable state only. It replaces stale entries rather than accumulating a diary. **Never store credentials, customer data, signing links, or temporary tokens here.**

- **Current workstream**: none in progress. **Next**: Base Operations Completion (`PRODUCT_ROADMAP.md` item 1), starting with structured inventory disposition and assignment. Roadmap order and the commercial model ($500/month base) are in `PRODUCT_ROADMAP.md`.
- **Production**: commit `49d457679f1b5e730d7da82423b7594273e580eb` is deployed (includes the live $500/month outcome-focused pricing section on the public homepage) and online under root's PM2. `JWT_SECRET`, `OPENAI_API_KEY`, and `OPENAI_DESCRIPTION_MODEL` are set in root's PM2 environment. `data/` and the database files are private to root.
- **Shipped and deployed**: Today's Priorities; AI Listing Suite (bulk and Facebook-format suggestions); Import Retry and Import History; AI Follow-Up Drafts; inventory aging alerts at recurring 30-day milestones; pending-deal follow-up alerts; inventory activity history and stage-change logging; basic `documents` records and incomplete-paperwork reporting; contracts and DocuSeal e-sign; public dealer showroom (hardened field allowlist, off by default for new dealerships); customer permission tiers; import and CSV export hardening; private data-directory permissions enforced on every start.
- **AI Follow-Up Drafts** (PR #12, deployed): template draft first, optional "Rewrite with AI" (one provider call, names kept local via placeholders), draft only (nothing sent, saved, or logged; email opens only via a user-pressed `mailto:`). Live provider validation passed 36/36 on throwaway data; production smoke test after deploy passed 18/18 with no AI request.
- **Operational notes**: deploy with `DEPLOY_DIGITALOCEAN.md` (JWT_SECRET pre-check, `git pull`, `npm ci --omit=dev` only when dependencies change, `pm2 restart unitnavigator`, check logs, smoke-test). Live provider validations run as root on the droplet from a `/tmp` clone with `--key-from-pm2`.
- **Open items** (to be closed by roadmap item 8 at the latest):
  - Root's PM2 has no systemd boot unit (`pm2-root` not found), so the app may not return after a reboot.
  - No scheduled database backups; a private backup procedure is documented but not scheduled.
  - Password rotation is an open owner decision (the database was readable by other local accounts before the permissions fix).
  - Unit ids and numeric `?dealer=<id>` lookup are sequential and enumerable.
  - Contacts export needs only `reports_view` (default staff have it) and has no audit history; addressed in roadmap item 3.
  - AI routes have no usage limits, entitlements, or metering; addressed in roadmap item 3.
  - Two rows with the same VIN in one import count as an update; VIN-less rows with no stock number duplicate on re-import (warned).
- **Known manual dependency**: a human must complete both test signatures for any future live e-sign test run.
