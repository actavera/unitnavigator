# CURRENT_WORK.md

This file holds current, durable state only. It replaces stale entries rather than accumulating a diary. **Never store credentials, customer data, signing links, or temporary tokens here.**

- **Current workstream**: Roadmap item 2 — AI Listing Suite Enhancements (see `PRODUCT_ROADMAP.md`). Planning only: implementation plan delivered for review, no item 2 code written. `DEPLOY_DIGITALOCEAN.md` now documents the production `JWT_SECRET` requirement and a pre-restart check (uncommitted).
- **Branch**: `claude/ai-listing-suite` (from `main` at `b15dd699f997de502b5e6d6d9ec676e738f3cb91`)
- **Closed workstreams** (merged to `main` and deployed to production):
  - DocuSeal e-sign migration, integration-test scaffolding, and the single-document archival fix (PR #1)
  - Today's Priorities, roadmap item 1 (PR #2, merge commit `b15dd699f997de502b5e6d6d9ec676e738f3cb91`)
- **Production**: running `main` at `b15dd699`. The deploy initially crashed because `JWT_SECRET` was unset in production; it is now set in root's PM2 environment (outside the repo) and the app is stable. No AI guidance has been generated in production.
- **Operational notes**: the app runs as `unitnavigator` in root's PM2 on the droplet. Deploy steps are `git pull`, `npm ci --omit=dev`, `pm2 restart unitnavigator --update-env`, then check logs and smoke-test. `DEPLOY_DIGITALOCEAN.md` was updated to match.
- **Open issue found during planning (not yet fixed)**: the public showroom API (`routes/public.js`, `mapUnit`) spreads the whole unit row into its response, so it returns `minimum_price` and `vin` along with `notes` to anyone. `minimum_price` is the dealer's private floor price. This predates item 2 and needs its own fix.
- **Next action**: approve or adjust the item 2 plan, decide how to handle the `minimum_price` exposure, then implement.
- **Known manual dependency**: a human must complete both test signatures for any future live e-sign test run.
