# Trouidees CRM Agent Plugin for Hermes

Lets Andrew browse eligible CRM leads, read contact details, assign unassigned
leads to himself, update approved follow-up fields, add internal notes, and
preserves every completed WhatsApp exchange verbatim with a separate factual
summary. Conversation records are synchronized to the Trouidees CRM at
`POST /api/agent/leads/:id/conversations`. See
`docs/superpowers/specs/2026-09-29-andrew-crm-writeback.md` for the full
design this implements.

This plugin never sends WhatsApp messages and never writes directly to
Neon/production CRM infrastructure — it only calls the scoped CRM agent API
over HTTPS with a bearer key.

## How it works

1. `on_session_finalize` (explicit close) and the 24-hour idle scanner each
   export a session through the supported `hermes sessions export` CLI,
   keep only contact-visible WhatsApp messages, and write them to a local
   SQLite outbox (`outbox.py`). Both paths are local-only: no network call,
   no LLM call.
2. The `crm-writeback` skill instructs the agent to call `crm_pending_syncs`
   after each conversation, write a separate factual summary, and call
   `crm_commit_sync(segment_id, lead_id, summary)` for leads it owns.
   The other CRM tools are `crm_search_leads` (bounded browse/search with
   explicit ambiguous-phone results), `crm_get_lead` (contact and business
   details), `crm_assign_self` (claim an unassigned lead),
   `crm_get_conversations` (read Andrew-owned history), `crm_add_note`
   (append an internal note), and `crm_update_lead` (update approved follow-up
   fields). All use the scoped CRM API and enforce its ownership checks.
3. `crm_commit_sync` submits the segment to the CRM with an idempotency key
   equal to the segment ID. It marks the segment `synced` only on a 2xx
   response. Transient failures (5xx, network, timeout) are queued for retry
   with exponential backoff; auth/validation 4xx failures are marked
   `failed` and left visible for an operator, without losing the transcript.
   Before making that first network request, `crm_commit_sync` durably binds
   the `lead_id` and `summary` it was given to the segment
   (`Outbox.prepare_sync_payload`). **Every subsequent call for that same
   segment_id — including a retry after a timeout — submits this exact bound
   `lead_id` + `summary`, plus the segment's original messages and its
   segment ID as the idempotency key, regardless of what `lead_id`/`summary`
   that later call happens to be given.** This matters because a timeout
   does not mean the CRM didn't receive/commit the write: if a retry
   resubmitted a *different* summary under the same idempotency key, the CRM
   could see it as a conflicting reuse of that key (a 409); if a retry
   resubmitted to a *different* lead_id, that changes the request URL
   entirely (`POST /api/agent/leads/:id/conversations`), so the CRM's
   per-lead idempotency store would never even recognize it as a duplicate
   of the first attempt — it would create a second, wrongly-owned
   conversation instead of detecting a replay. Binding once, before any
   network attempt, makes every retry a byte-identical replay of the first
   attempt's payload.
4. A segment's ID is a content hash of its session ID and ordered messages.
   An explicit close and an idle-timeout scan that observe the same messages
   collapse into one segment (idempotent); a message that arrives after a
   segment was queued starts a new segment.
5. Internally (outbox, extraction) this plugin uses `direction:
   "inbound"/"outbound"` and the sentinel timestamp `"unknown"`. The CRM's
   `POST /api/agent/leads/:id/conversations` validator instead requires
   `direction` to be exactly `"incoming"`/`"outgoing"` and `timestamp` to be
   a valid ISO string or `null`. `crm_client.py` is the single place that
   translates internal shape to that exact wire contract, right before the
   HTTP request — the outbox and extractor never need to know about it.
6. `hermes sessions export` always returns a session's *full* message
   history, not a delta. For a long-lived session that is captured more than
   once — idle timeout then idle timeout again, idle timeout then an
   explicit close, or an explicit close then an idle timeout — only messages
   after the highest `source_order` already recorded for that session are
   queued as the next segment. This is tracked durably in the outbox (a
   `session_boundaries` SQLite table, keyed by session ID) via
   `Outbox.queue_new_messages`, the single entry point both the idle scanner
   (`idle_scan.py`) and the explicit-close/manual path
   (`tools.queue_closed_session`, used by `on_session_finalize` and the
   `crm_queue_session` tool) queue through. The first capture for a session
   is queued whole; a capture with nothing new since the last queued segment
   queues nothing — so an idle scan and a later explicit close (or the
   reverse) that observe the same unchanged transcript are idempotent with
   each other, not just with themselves.

## Assumptions and risks (verify before production use)

The public Hermes docs describe `hermes sessions export`'s JSONL output only
at a metadata level and do not publish per-message key names, so this was
verified directly against a real, local `hermes sessions export` payload
(Hermes Agent v0.21.5+3635) rather than assumed. Two things the docs implied
turned out to be wrong and were corrected in code:

- The docs' plugin-directory description reads as "flat top-level modules",
  but `hermes plugins doctor` actually loads the plugin as a real Python
  package — sibling modules must use relative imports (`from . import
  outbox`). `__init__.py`, `tools.py`, and `idle_scan.py` all try the
  relative import first and fall back to a flat top-level import, so the
  same files work both under Hermes's real loader and under this repo's own
  unit tests (which load modules flat, since the directory name
  `hermes-crm-plugin` contains a hyphen and can't be a dotted package). This
  fallback was confirmed against the actual installed CLI: `hermes plugins
  doctor integrations/hermes-crm-plugin --ci` reports `OK` with the plugin tools and
  1 hook registered.
- A bulk `hermes sessions export <file>` record's session identifier field
  is `id`, not `session_id` (`session_id` does not exist on the record at
  all). `idle_scan.py` reads `id` first and falls back to `session_id` for
  safety.

Confirmed message/session shape from that real export:

- `role` is one of `system`, `user`, `assistant`, `tool`, `developer`.
  Tool-result messages carry `tool_call_id`; tool-invoking assistant turns
  carry a non-empty `tool_calls` list (their `content` was *not* empty in
  the observed session, so filtering is done on `tool_calls` presence, never
  on content emptiness).
- `content` was a plain string in every observed message. A list-of-parts
  shape (`[{"type": "text", "text": "..."}]`) is also accepted defensively
  since other providers commonly emit it, but was not observed locally.
- Both the per-message `timestamp` field and the session-level
  `last_activity_at`/`started_at`/`ended_at` fields are **Unix epoch
  floats**, not ISO strings (e.g. `1790688828.4747572`). `session_export.py`
  converts these to ISO 8601 UTC before they reach the outbox/CRM payload;
  `idle_scan.py` parses epoch floats directly (an ISO-string fallback is
  kept for robustness, but epoch-float is what a real export produces).
- The session-level platform identifier is `source` (confirmed on a real
  export, whose value was `desktop` for a CLI session); compared against
  `"whatsapp"`. `--source whatsapp` is also a documented, verified filter
  flag on `hermes sessions export` and is used server-side in
  `idle_scan.py` to avoid pulling every session's metadata locally.

**What was *not* verified:** no WhatsApp-sourced session existed locally at
implementation time (`hermes sessions export --source whatsapp --dry-run`
returned "Would export 0 session(s)"), so WhatsApp-specific values for
`source`, contact identity fields, and any WhatsApp-only message metadata
are unconfirmed. Before enabling this against real WhatsApp traffic, run:

```bash
hermes sessions export /tmp/whatsapp-check.jsonl --source whatsapp --session-id <a-real-whatsapp-session-id>
```

and confirm the record matches the shape above. If it doesn't,
`session_export.py` is the only file that needs to change —
`extract_whatsapp_messages` is deliberately conservative and drops anything
it doesn't recognize rather than guessing, so a schema mismatch causes
messages to go missing, not to be fabricated or corrupted.

Re-run `hermes plugins doctor` (below) after any Hermes upgrade, since this
plugin's import strategy depends on the loader's current packaging
behavior.

## Install

1. Copy this directory to `~/.hermes/plugins/trouidees-crm/` (the plugin
   loader expects a flat directory with `plugin.yaml` and `__init__.py` at
   its root):

   ```bash
   cp -r integrations/hermes-crm-plugin ~/.hermes/plugins/trouidees-crm
   ```

2. Validate the plugin manifest and registration:

   ```bash
   hermes plugins doctor ~/.hermes/plugins/trouidees-crm --ci
   ```

3. Enable the plugin and the `crm-writeback` skill per your Hermes
   configuration (see your Hermes install's plugin-enable mechanism; this
   repo does not assume a specific one beyond `hermes plugins doctor`).

## Secret configuration

Set these through Hermes's own secret configuration — never in prompts,
skill text, shell history, or committed files:

| Variable | Secret | Purpose |
|---|---|---|
| `CRM_API_BASE_URL` | No | Base URL of the CRM agent API, e.g. `https://crm.example.com` (no trailing slash). |
| `CRM_AGENT_API_KEY` | Yes | Bearer key for Andrew's agent identity. It needs `leads:search`, `leads:read`, `leads:assign:self`, `conversations:read`, `conversations:write`, `notes:write`, and `leads:update:limited`; add `dnc:set` if Andrew should record DNC requests. Obtained from an admin via `POST /api/admin/agent-keys`; the secret is shown once at creation. |
| `CRM_API_TIMEOUT_SECONDS` | No | Optional. Defaults to `15`. |

This plugin never reads any Neon/database credential; it only ever talks to
the CRM's scoped `/api/agent/*` HTTP API.

### Key rotation and revocation

1. Ask a CRM admin to create a new key (`POST /api/admin/agent-keys`) and
   update `CRM_AGENT_API_KEY` in Hermes's secret store to the new value.
2. Ask the admin to revoke the old key
   (`DELETE /api/admin/agent-keys/:id`). Old and new keys can safely overlap
   during rotation since revocation is immediate and independent.
3. If a key is compromised, revoke it immediately; `crm_commit_sync` will
   surface subsequent `401`/`403` responses as non-retryable failures
   (segment stays `failed`, transcript preserved) until a valid key is
   configured again.

## Scheduling

Two Hermes cron jobs are required. Confirmed against this repo's installed
`hermes cron create --help`: `--script` takes a path "under
`~/.hermes/scripts/`", not an arbitrary repo path, so the scanner script must
be copied (or symlinked) there first.

**24-hour idle scan (script-only, no LLM, no CRM call):**

```bash
cp integrations/hermes-crm-plugin/scripts/queue_idle_sessions.py \
  ~/.hermes/scripts/crm-writeback-idle-scan.py

hermes cron create "every 5m" \
  --no-agent \
  --script crm-writeback-idle-scan.py \
  --name "crm-writeback-idle-scan"
```

Re-copy the script after any update to `scripts/queue_idle_sessions.py` in
this repo, since `~/.hermes/scripts/` holds an independent copy, not a live
reference back into the plugin directory. This job only queues locally; it
makes no CRM request and invokes no LLM, so it is safe to run frequently and
cheaply.

**Pending-segment processing (LLM-driven, every 5 minutes):**

Configure a normal (agent) Hermes scheduled task with the `crm-writeback`
skill attached, roughly every 5 minutes:

```bash
hermes cron create "every 5m" \
  --skill crm-writeback \
  --deliver local \
  --name "crm-writeback-process-pending" \
  "Process any pending CRM write-back segments per the crm-writeback skill."
```

This path does call the LLM (to write the summary) and does make an outbound
HTTPS request to the CRM for each segment it commits. Verify `--skill` and
`--deliver` semantics against your installed Hermes version's `hermes cron
create --help` before relying on this in production; flags can change
between releases.

## Monitoring pending/failed segments

The outbox is a plain SQLite file at
`~/.hermes/plugins/trouidees-crm/state/crm_outbox.sqlite3` by default. To
check on it without exposing transcript contents in a terminal you don't
control:

```bash
sqlite3 ~/.hermes/plugins/trouidees-crm/state/crm_outbox.sqlite3 \
  "SELECT segment_id, session_id, status, attempts, reason, lead_id, updated_at FROM segments ORDER BY updated_at DESC LIMIT 20;"
```

- `pending` / `retry`: not yet confirmed by the CRM; will be retried
  automatically (or is waiting for the agent to call `crm_commit_sync`). A
  `pending` row with `lead_id`/`summary` both `NULL` has never had
  `crm_commit_sync` called for it yet; once either is set, they are bound
  for this segment's entire lifetime (see "How it works" above).
- `syncing`: currently being submitted.
- `synced`: confirmed by the CRM; `remote_conversation_id` is set.
- `failed`: a non-retryable error (auth/validation) or an ambiguous legacy
  segment that needs manual reconciliation. The transcript, and any bound
  `lead_id`/`summary`, are still present in the row; nothing is
  deleted. For a normal bound segment, after fixing a rejected request's
  cause, the agent may call `crm_commit_sync` again: it will replay the same
  lead, summary, transcript, and idempotency key. Do not edit or clear those
  bound fields, and do not delete the row to re-queue it; the segment boundary
  is retained, and deleting the segment can make the captured transcript
  disappear from future scans.
- On upgrade, an unbound `retry`, `syncing`, or `failed` segment is moved to
  `failed` with a manual-reconciliation message. Its earlier network request
  may have reached the CRM before the old plugin lost its response, and the
  old outbox did not save the original lead/summary. The plugin will refuse
  to bind a new target or submit that segment. Keep the transcript and resolve
  its CRM state with an administrator before any manual recovery. An unbound
  `pending` segment with zero attempts remains safe to send for the first time.

If a segment was bound to the wrong lead, do not change its binding and retry:
the CRM may already have accepted it on that lead. Preserve the outbox row and
have an administrator reconcile the CRM record and choose a safe recovery.

`last_error` is sanitized before being stored (no API key, no `Authorization`
header value) but do treat the database file itself as sensitive, since it
does contain real conversation transcripts, the bound `lead_id`, and the
generated `summary`.

## Staging smoke test (no real key required)

Before pointing this at any real CRM environment:

1. Set `CRM_API_BASE_URL` to a local/staging CRM instance and
   `CRM_AGENT_API_KEY` to a staging-only test key (never a production key).
2. Run the plugin's unit test suite (see below) — it exercises the export
   filter, outbox, idle segmentation, and retry logic entirely with fakes,
   with no live Hermes CLI, network, or WhatsApp send required.
3. In a real Hermes+staging-CRM environment, run through the staging
   acceptance checks described in
   `docs/superpowers/plans/2026-09-29-hermes-crm-writeback.md` (Task 6)
   before treating this as production-ready.

## Running the tests

```bash
python -m unittest discover -s integrations/hermes-crm-plugin/tests
```

(The plugin directory name contains a hyphen, so `discover -s <path>` must
be used instead of a dotted module path like
`python -m unittest integrations.hermes-crm-plugin.tests...`, which is not
valid Python syntax.)

