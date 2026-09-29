# DocuSeal / Stirling controlled integration-test runbook

This is a manual, human-supervised test of the real e-sign flow against
**Unit Navigator's own DocuSeal test/sandbox account** and a real (but
isolated, throwaway) Stirling instance. It is not automated end-to-end —
several steps below are explicitly marked as **manual, Robert-only** steps,
and there is exactly one point (Section D) where execution stops for
explicit confirmation before anything is sent to a real provider.

Nothing in this runbook touches `main`, the production droplet, or the
repository's own `data/` directory. Every command below writes only to a
disposable directory under the OS temp directory.

## 0. What this actually exercises — and the one important correction

**`POST /api/paperwork/official-packet` does not contact Stirling.** It only
calls `buildOfficialPacket()`, which runs entirely locally (pdf-lib,
in-process). Stirling is never involved in that request.

**`POST /api/paperwork/esign` performs Stirling flattening AND DocuSeal
submission creation in the same request**, back to back
(`preparePacketWithStirling()` immediately followed by
`createDocusealSubmission()` — see `routes/paperwork.js`). There is **no
natural pause point between them in the running application** — by the time
Stirling has responded, the very same request is already about to call
DocuSeal.

Because of that, this runbook verifies Stirling flattening **separately**,
*before* ever calling `/esign`, using a new narrowly-scoped CLI script
(`scripts/stirling-smoke.js`, Section C.2). Precisely: its own code never
invokes a DocuSeal function and never references any `DOCUSEAL_*`
configuration (requiring `routes/paperwork.js` does load the whole module,
which also *defines* DocuSeal-related functions — but this script never
calls them). The stronger guarantee is behavioral, not just textual:
`test/stirling-smoke-test.test.js` intercepts every outbound request during
a real run and asserts each one's origin exactly matches the Stirling
endpoint, nothing else. Only once that smoke test has passed, and only
after your explicit confirmation, does this runbook call the real `/esign`
endpoint — which is the first and only point that contacts DocuSeal for
real.

## 1. Configuration

### 1.1 Secrets — how to supply them safely

**Never** put `DOCUSEAL_API_KEY` or any other secret in:
- a tracked file (nothing under version control, ever),
- a shell command you type directly (it lands in shell history and any
  terminal-recording/transcript),
- chat with me.

Instead, use a local, **untracked**, `chmod 600` env file *outside the
repository* — e.g. `~/unitnav-esign-test.env` (not `.env` inside the repo,
even though that's gitignored, to keep it away from any tooling that scans
the repo directory) — and source it into your shell right before starting
the app:

```bash
# One-time setup, outside the repo:
cat > ~/unitnav-esign-test.env <<'EOF'
export DOCUSEAL_API_KEY="<your Unit Navigator DocuSeal test key>"
export DOCUSEAL_BASE_URL="https://api.docuseal.com"   # omit if using the default
export STIRLING_PDF_URL="http://127.0.0.1:8085"        # your real reachable Stirling instance
# export STIRLING_PDF_API_KEY="..."                     # only if your Stirling requires auth
EOF
chmod 600 ~/unitnav-esign-test.env

# Each time you run the test:
source ~/unitnav-esign-test.env
```

If you use a password manager or secret-injection tool (1Password CLI,
`direnv` with an encrypted store, etc.) instead of a plain env file, that's
equally acceptable — the requirement is just: never in a tracked file, never
typed as a bare literal in a command, never pasted in chat.

### 1.2 The isolated test directory

```bash
export UNITNAV_DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/unitnav-esign-test-XXXXXX")"
echo "Test data directory: $UNITNAV_DATA_DIR"
```

Every script in this runbook (`preflight-esign.js`, `stirling-smoke.js`,
`cleanup-esign-test-dir.js`) refuses to run — before ever loading
`database.js` — unless `UNITNAV_DATA_DIR` resolves to a uniquely-named
directory under the OS temp directory, and is not the repository, the
repository's `data/` directory, `/var/www/unitnavigator`, a home directory,
or the filesystem root. See `scripts/lib/isolatedDataDir.js`.

### 1.3 Run mode — a real local development server, not a unit test

Run the actual app (`node server.js`), on a **unique, non-default port**,
against the isolated data directory:

```bash
export PORT=4931   # any free port that isn't 3001 (the documented default)
export JWT_SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
export NODE_ENV=development
node server.js
```

**`NODE_ENV=test` is not used here, and is not equivalent to production
behavior.** In this codebase, `NODE_ENV` affects exactly one thing:
`middleware/auth.js` refuses to boot with the default JWT signing secret
when `NODE_ENV=production` and `JWT_SECRET` is unset. It has no other effect
anywhere in the app — no route, no timeout, no validation logic branches on
it. `NODE_ENV=test` is used only by the automated test suite as a
convention; running the live app for this integration test uses
`development` (or simply leaves `NODE_ENV` unset) and always sets a real,
random `JWT_SECRET` explicitly, exactly as shown above — never relying on
the insecure dev fallback, even for a throwaway test run.

## 2. Preflight

```bash
node scripts/preflight-esign.js
```

This is not read-only or zero-write — loading `database.js` creates the
isolated SQLite database and runs migrations, and the writability check
creates `esign-archives/` and writes/deletes a probe file. What it does
guarantee: no network requests, no provider contact, no DocuSeal submission,
and every filesystem write is confined to the validated isolated test
directory. It never prints a secret value. It confirms:
- `UNITNAV_DATA_DIR` is a valid isolated test directory — a real, existing,
  non-symlink directory, canonicalized and checked against the repository,
  production directory, home directory, and filesystem root (see
  `scripts/lib/isolatedDataDir.js`)
- the `audit_log_path` and `representative_email` migrations are present
- `esign-archives/` under that directory is writable
- `DOCUSEAL_API_KEY` is set (presence only)
- `DOCUSEAL_BASE_URL` / `STIRLING_PDF_URL`, if set, are valid **http(s)**
  URLs specifically — `file:`, `ftp:`, and other schemes are rejected, not
  just "parses as *some* URL"
- `STIRLING_PDF_API_KEY` presence
- `UNITNAV_PROVIDER_TIMEOUT_MS`, if set, is a positive number
- `JWT_SECRET` is set (presence only) — **required** for this workflow and
  fails preflight if missing, even though the app itself has an insecure
  development fallback (see Section 1.3)

Must exit 0 before continuing.

## 3. Fixtures — a test dealership, representative, customer, and deal

All fixture data in this runbook is **unmistakably labeled as test data** —
names, dealership names, and email addresses all say so, so nothing here
could ever be confused with a real dealer or customer if the isolated
database were ever inspected by someone else.

```bash
BASE="http://127.0.0.1:$PORT"

# 3.1 Create a test dealership + admin user.
DEMO=$(curl -s -X POST "$BASE/api/auth/demo-login")
TOKEN=$(echo "$DEMO" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).token')
echo "Demo dealership created. Token acquired (not printed)."

# 3.2 Set the representative — THIS is the e-sign countersigner, and must be
# an inbox YOU control. Use the second of your two test inboxes here.
DEALERSHIP_ID=$(curl -s "$BASE/api/auth/me" -H "Authorization: Bearer $TOKEN" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).user.dealership_id')
curl -s -X PUT "$BASE/api/admin/dealership-settings" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"dealership_id\": $DEALERSHIP_ID, \"name\": \"UNIT NAVIGATOR TEST DEALERSHIP (integration test — not real)\", \"representative_name\": \"Robert Rees (TEST representative)\", \"representative_email\": \"<your representative test inbox>\"}"

# 3.3 Create a test unit and a test deal — customer.email is your FIRST test
# inbox (the buyer/signer).
UNIT=$(curl -s -X POST "$BASE/api/inventory" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"vin":"TESTVIN0000000001","year":2020,"make":"TEST","model":"INTEGRATION","acquisition_cost":1}')
UNIT_ID=$(echo "$UNIT" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).unit.id')
DEAL=$(curl -s -X POST "$BASE/api/deals" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"deal_type\":\"cash\",\"unit_id\": $UNIT_ID, \"customer\": {\"name\": \"TEST CUSTOMER (integration test)\", \"email\": \"<your buyer test inbox>\", \"phone\": \"555-0100\"}}")
echo "$DEAL" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).deal'
```

Never use a real Blue Rhino credential, a real customer, or a real deal here
— this section exists specifically to avoid that.

## 4. Packet generation (no Stirling contact)

```bash
curl -s -X POST "$BASE/api/paperwork/official-packet" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"packetType":"cash","customer":{"name":"TEST CUSTOMER (integration test)"},"vehicle":{"year":2020,"make":"TEST","model":"INTEGRATION","vin":"TESTVIN0000000001"},"pricing":{"salePrice":1,"total":1,"amountFinanced":0}}' \
  --output "$UNITNAV_DATA_DIR/official-packet.pdf"
open "$UNITNAV_DATA_DIR/official-packet.pdf"   # (or your platform's equivalent) — visually confirm it looks right
```

This is entirely local — no Stirling, no DocuSeal, nothing sent anywhere.

## C. Stirling flattening — verified separately, before DocuSeal is ever touched

### C.1 Why a separate script

As established in Section 0, the running app has no pause point between
Stirling and DocuSeal inside `/esign`. To verify Stirling in isolation, use:

### C.2 The Stirling smoke-test script

```bash
node scripts/stirling-smoke.js
```

This script:
- generates its own local test packet for its own test dealership (it does
  **not** use the fixtures from Section 3 — it's fully self-contained),
- sends it to Stirling for flattening,
- writes the flattened result to `$UNITNAV_DATA_DIR/stirling-smoke-test-output.pdf`,
- **does not invoke any DocuSeal function and does not require any
  DocuSeal configuration** — it only destructures and calls
  `buildOfficialPacket` and `preparePacketWithStirling` from
  `routes/paperwork.js` (requiring that module does load DocuSeal-related
  function *definitions* too, since it's the same module — but this script
  never calls them). The stronger, behavioral guarantee is proven by
  `test/stirling-smoke-test.test.js`, which intercepts every outbound
  request during a real run and asserts each one's origin exactly matches
  the Stirling endpoint, nothing else.

Confirm it exits 0, open the output PDF, and confirm it looks like a
flattened (non-editable) version of the packet.

## D. STOP — confirmation gate

Everything above this point is local generation, local fixtures, and a
Stirling-only network call. **Nothing has been sent to DocuSeal, and no
email has gone out, yet.**

The next command — `POST /api/paperwork/esign` — will, in a single request:
1. Regenerate the packet and send it to Stirling for flattening (a second,
   real Stirling call, separate from the smoke test above), **and**
2. **Create a real DocuSeal submission and email your buyer test inbox.**

**Do not run the command in Section E until you have explicitly told me, in
this conversation, that you want it sent.** I will not issue it
unprompted.

## E. Send for signature (after your confirmation)

```bash
RESPONSE=$(curl -s -X POST "$BASE/api/paperwork/esign" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"dealId\": <deal id from 3.3>, \"packetType\":\"cash\",\"customer\":{\"name\":\"TEST CUSTOMER (integration test)\",\"email\":\"<your buyer test inbox>\"},\"vehicle\":{\"year\":2020,\"make\":\"TEST\",\"model\":\"INTEGRATION\",\"vin\":\"TESTVIN0000000001\"},\"pricing\":{\"salePrice\":1,\"total\":1,\"amountFinanced\":0}}")
echo "$RESPONSE"
ENVELOPE_ID=$(echo "$RESPONSE" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).envelope_id')
```

Record: `envelope_id`, `provider_submission_id`, and the one-time
`signing_url` (shown only in this response — it is never persisted, see
Section G).

Confirm the request body actually sent to DocuSeal had `order: "preserved"`
and submitters `[Buyer, Dealer]` in that order — either from your own
network capture if you have one in front of the app, or from the DocuSeal
dashboard's own submission detail view once it exists (Section E.1).

### E.1 Manual step — Robert only: the buyer test inbox

Open the buyer test inbox. A DocuSeal signing email should have arrived.

- Open it, review the document, sign as the buyer.
- **Before signing**, check the dealer/representative test inbox and
  confirm it has received **nothing** yet.

### E.2 Manual step — Robert only: the representative test inbox

After the buyer completes:
- Confirm the representative test inbox **now** receives its signing email
  (this is the "customer-first" behavior under test).
- Open it, review, sign as the representative.

I do not automate or perform either signature — these two steps are yours.

## F. Completion, archival, and verification

```bash
# Poll until status is "completed".
curl -s "$BASE/api/paperwork/esign/$ENVELOPE_ID/status" -H "Authorization: Bearer $TOKEN" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8"))'
```

Verify:
- `archive_path` / `audit_log_path` in the response are local relative
  paths (e.g. `data/esign-archives/<id>.pdf`) — **never** a `docuseal.com`
  (or your self-hosted DocuSeal host) URL.
- The actual files exist under `$UNITNAV_DATA_DIR/esign-archives/`; open
  both — the signed PDF should show both signatures, the audit log should
  show the full completion trail with correct order and timestamps.

### F.1 Database inspection

```bash
sqlite3 "$UNITNAV_DATA_DIR/unitnavigator.db" \
  "SELECT status, provider, signing_url, provider_response, archive_path, audit_log_path, completed_at, archived_at FROM esign_envelopes WHERE id = $ENVELOPE_ID;"
```

Confirm:
- `signing_url` is `NULL`.
- `provider_response` contains no `http://`/`https://` substrings, no
  `embed_src`, no `slug` — only the sanitized fields
  (`sanitizeDocusealResponseForStorage`'s allowlist: id, status,
  timestamps, submitter roles/statuses).
- `archive_path` / `audit_log_path` are the same local paths as above.

### F.2 Log inspection

Grep the app's stdout/stderr from this run for anything unexpected:

```bash
grep -iE "docuseal\.com|X-Auth-Token|signing_url|embed_src" <captured server log>
```

Expect **zero** matches beyond the deliberate one-time `signing_url` field
in the immediate HTTP response to the CLI (Section E), which is not a log —
if it appears in server-side logs at all, that's a finding to fix, not
something to wave through.

## G. Failure-mode checks

Each of these is a **separate, isolated attempt** — do not reuse state from
a prior successful attempt for these, since that would conflate "did this
specific attempt behave correctly" with leftover state from an earlier one.

### G.1 Idempotency (on the already-completed submission from Section F)

```bash
sha256sum "$UNITNAV_DATA_DIR/esign-archives/"*.pdf > /tmp/before.sha256
curl -s "$BASE/api/paperwork/esign/$ENVELOPE_ID/status" -H "Authorization: Bearer $TOKEN" > /dev/null
sha256sum "$UNITNAV_DATA_DIR/esign-archives/"*.pdf > /tmp/after.sha256
diff /tmp/before.sha256 /tmp/after.sha256 && echo "IDENTICAL — idempotency holds"
```

This proves the archive files are byte-identical before and after a second
status check — it does **not**, by itself, prove no re-download happened
(the bytes could coincidentally match, or DocuSeal could re-serve identical
bytes). If you want to prove "no re-download" specifically, capture request
logs on the DocuSeal side (their dashboard/API activity log, if available)
or run the app with request logging enabled and confirm no second
`combined_document_url`/`audit_log_url` fetch occurs.

### G.2 Cancellation (requires a NEW, separate, not-yet-completed submission)

Create a second test deal and a second `/esign` call (after a fresh
confirmation from you — this is a real submission too), then cancel/decline
it from the DocuSeal signing UI or dashboard before either signature
completes. Confirm:
- the status endpoint reflects the cancelled/declined state,
- nothing gets archived,
- the DB row's `status`/`archived_at` are not falsely marked complete.

### G.3 Bad-key retry (a separate, isolated attempt)

In a **separate** isolated data directory (a fresh `UNITNAV_DATA_DIR`):
1. Set `DOCUSEAL_API_KEY` to an intentionally wrong value.
2. Attempt `/esign` on a fresh test deal. Confirm it fails cleanly (401/502
   from `createDocusealSubmission`).
3. Check the DocuSeal dashboard (if you have access) to confirm **no
   submission was created** on the provider side for this attempt — record
   whether you could verify this or only infer it from the local error.
4. Restore the correct key and retry with a fresh `/esign` call on the same
   or a new test deal; confirm it now succeeds.

### G.4 Timeout (a separate, isolated attempt)

1. Set `STIRLING_PDF_URL` to an unreachable host (or `UNITNAV_PROVIDER_TIMEOUT_MS`
   to a short value like `2000` against a deliberately slow/stalled target).
2. Attempt `/esign`. Confirm it fails within the configured timeout window
   with a clear "did not respond in time" error — not a hang.
3. Confirm no DocuSeal submission was created (Stirling fails first in the
   normal flow, so this should be verifiable purely from the fact that
   `createDocusealSubmission` is never reached — but note this explicitly
   rather than assuming it).

### G.5 Duplicate-status checks

Already covered by G.1 above; repeat it 2-3 times in a row for extra
confidence.

## H. Evidence to capture

At minimum, for the primary successful run (Section F):
- Screenshot: buyer's DocuSeal signing UI, mid-signature.
- Screenshot: confirmation that the representative inbox was empty before
  the buyer signed.
- Screenshot: representative's DocuSeal signing UI.
- Screenshot: the completed submission in the DocuSeal dashboard.
- The final signed PDF (both signatures visible) and the audit log PDF,
  saved somewhere you control (not the repo).
- The `esign_envelopes` row (Section F.1 output).
- Confirmation of signing order from the DocuSeal dashboard's own event
  timeline.
- Server log excerpt showing no secret/URL leakage (Section F.2).
- For each failure-mode check (Section G): the exact command/config used,
  the observed error message, and whether provider-side state was
  confirmed absent or only inferred.

## I. Cleanup

**Do not run a broad `rm -rf`.** Use the dedicated cleanup script, which
refuses to run against anything that isn't the exact, validated, isolated
test directory:

```bash
node scripts/cleanup-esign-test-dir.js
```

This deletes exactly `$UNITNAV_DATA_DIR` and nothing else — the same
`scripts/lib/isolatedDataDir.js` guard used by preflight and the smoke test
applies here too, so it refuses if the path is missing, too broad, inside
the repository, or production-related.

Also unset the env vars from your shell session:

```bash
unset DOCUSEAL_API_KEY DOCUSEAL_BASE_URL STIRLING_PDF_URL STIRLING_PDF_API_KEY UNITNAV_DATA_DIR JWT_SECRET
```

**DocuSeal-side cleanup is optional** for this pass — treat "delete the test
submission from the DocuSeal dashboard/API" as a nice-to-have, not a
required step, until you've confirmed (by trying it once) that your
DocuSeal account's dashboard or API actually supports deleting a completed
submission. If it does, do it for hygiene; if not, that's fine — it's a
sandbox/test account, and DocuSeal's own retention policy applies.

Finally, confirm nothing leaked into the real repository:

```bash
cd /path/to/unitnavigator && git status --short   # must be empty / unchanged
ls data/esign-archives 2>&1   # must NOT exist, or must be unchanged from before this test
```
