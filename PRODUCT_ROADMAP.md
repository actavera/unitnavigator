# Unit Navigator — Product Roadmap

Durable backlog of genuinely unfinished product features, audited against the current codebase. This file replaces stale entries as items ship — it is a decision tool, not a historical log. Completed features (dealer showroom, roles/permissions, paperwork, DocuSeal e-sign, single-vehicle description writer, internal pricing engine, CSV/SFTP import, VIN decode) are intentionally excluded.

## 1. AI Assistant — "Today's Priorities"
**Problem**: The alerts system (`routes/dashboard.js`) already detects stalled deals, aging units, and stale logins, but presents them as unranked counts with no summary or recommended action.
**Smallest first release**: A "Today's Priorities" view built entirely on the existing alert queries and dealership data — no new detection logic. Priorities are ranked deterministically (urgency, age, missing documents, deal status), not by an LLM. AI is used only to summarize each item's situation and suggest a next step in plain language. AI must never invent an alert, alter a record, contact a customer, change a price, or execute any action. Each recommendation links to an existing action already in the app (e.g., dismiss the alert, open the deal) — nothing new is added to act on it. No chatbot or free-form Q&A in this release.
**Dependencies**: None beyond existing alert data; an LLM call for the summary/recommendation text only.
**Risk/complexity**: Medium.
**Completion criteria**: Dealer can load one view showing every open alert deterministically ranked, each with an AI-written summary/next-step and a working link to the existing action for it. No AI-originated actions execute automatically.

## 2. AI Listing Suite Enhancements
**Problem**: The description writer (`services/vehicleDescription.js`) only generates one vehicle at a time, with a fixed tone/length and no channel targeting, and there is no check for listings missing required fields.
**Smallest first release**: Bulk generation across a selected set of vehicles, one channel-specific variant (e.g., shorter for Facebook), and a missing-info warning that flags a listing lacking price/mileage/photos before generation.
**Dependencies**: None new — extends the existing service.
**Risk/complexity**: Low for bulk generation and quality checks; Medium for channel-specific tone variants.
**Completion criteria**: Dealer can select multiple vehicles and generate descriptions in one action; at least one channel-specific variant exists; listings missing required fields are flagged before generation.

## 3. Import Retry and Import History
**Problem**: CSV/SFTP import already does VIN-based dedup and returns per-row errors, but a partially-failed import must be re-uploaded in full, and there's no persisted, re-visitable record of past import batches beyond per-unit activity-log entries.
**Smallest first release**: A retry endpoint/UI that re-submits only the previously-errored rows from the last import response, plus a minimal persisted import-batch record (timestamp, source, counts, error list).
**Dependencies**: None new — extends the existing import handlers in `routes/inventory.js`.
**Risk/complexity**: Low.
**Completion criteria**: After a partially-failed import, the dealer can retry just the failed rows without re-uploading the whole file, and can open a history view of past import batches with their outcomes.

## 4. AI Lead and Deal Follow-Up Drafts
**Problem**: Stalled deals are already detected, but nothing drafts outreach or summarizes the deal's history/missing information — the dealer must do both manually.
**Smallest first release**: For each stalled-deal alert, generate a text/email draft and a deal-history/missing-info summary for the dealer to copy or act on. Allowed actions: copy the draft, open the related customer/deal. No automated sending and no messaging integration in this release.
**Dependencies**: Item 1 (natural surface for these drafts).
**Risk/complexity**: Medium.
**Completion criteria**: Every stalled-deal alert can produce a draft message and a deal summary; the dealer must manually copy or send it — nothing is sent automatically.

## 5. Live Market Pricing and VIN Intelligence
**Problem**: Pricing suggestions only use the dealer's own sold history or a generic depreciation model; there is no local/regional market comparison, and no legitimate ZIP-based adjustment.
**Smallest first release**: A short evaluation of candidate data providers (coverage, licensing, cost, API limits, allowed display/storage terms) — no ZIP or local adjustment is built until a legitimate source is selected. No invented or coarse ZIP multiplier is used in the meantime. The existing internal comparable/fallback pricing remains unchanged and clearly labeled as its own source.
**Dependencies**: Provider evaluation outcome; a licensing/cost decision.
**Risk/complexity**: High.
**Completion criteria**: A documented provider evaluation exists with a go/no-go recommendation; if approved, a ZIP/local-adjusted estimate is added as a separately labeled figure alongside (not replacing) the existing internal estimate.

## 6. Meta Inventory Feed
**Problem**: No path to any external listing channel exists today — only a manual CSV export.
**Smallest first release**: A dealer-specific inventory feed formatted for Meta/Facebook Marketplace's official commerce feed spec, plus dealership footer/branding settings for listings. Direct Facebook Marketplace posting is deferred unless Meta provides a documented, supportable official API route.
**Dependencies**: Meta's published commerce feed spec; confirmation of whether an official direct-posting route exists before considering that separately.
**Risk/complexity**: Medium for the feed; direct posting is out of scope unless an official route is confirmed.
**Completion criteria**: A dealer can point Meta Commerce Manager at a generated feed URL and see their live inventory populate correctly, with dealer-configured footer/branding applied.

## 7. Premium Feature Packaging
**Problem**: No plan/tier/entitlement/usage-limit/billing code exists anywhere — every feature is available to every dealer today.
**Smallest first release**: A plan/tier table and entitlement checks (reusing the existing permission-check pattern in `middleware/auth.js`) distinguishing a base plan from an AI-features tier, plus usage/cost visibility. No billing automation in this release.
**Requirements carried from shipped AI features**: authenticated AI usage limits, entitlements, and metering must be designed once here and applied to every AI route, not added as per-route ad-hoc limiters. Today those routes are Today's Priorities AI guidance, single-vehicle description generation, and bulk listing-description suggestions. The design needs per-dealership and per-user limits, an entitlement check before any provider call, and metering of provider calls (counted per request, and per cache or in-flight reuse) so usage and cost are visible before billing exists. The present safeguards, the 10-unit batch cap, one provider call per request, a short cache, and in-flight request coalescing, bound cost per request but do not limit total usage.
**Dependencies**: A decision on which features (likely items 1, 2, 4, 5) are gated; no payment processor needed yet.
**Risk/complexity**: Medium.
**Completion criteria**: Dealers can be assigned a plan/tier; gated features return a clear "upgrade required" response when not entitled; usage counters are visible to the dealer and to admin, with no automated charge yet.
