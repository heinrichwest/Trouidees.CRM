# Native WhatsApp CRM contract

This document describes the dormant hosted writeback boundary for native
WhatsApp outreach. It does not authorize installation, scheduling, enabling
the native flag, applying a migration to a production database, or sending a
live message. The new paths remain disabled unless
`AGENT_NATIVE_OUTREACH_ENABLED=1` is set alongside the existing agent API
gate.

## Routes and scopes

| Method and route | Scope | Purpose |
|---|---|---|
| `POST /api/agent/outreach/claim` | `outreach:claim` | Atomically claim one ready, CRM researched lead using a durable `requestKey`. |
| `PATCH /api/agent/outreach/claims/:id` | `outreach:claim` | Mark a reservation submitted with a stable gateway `jobKey`, or release it only when delivery cannot occur. |
| `GET /api/agent/outreach/quota` | `outreach:read` | Read Johannesburg-day delivered and outstanding capacity for the authenticated key label. |
| `GET /api/agent/outreach/resolve-contact?contact=...` | `leads:search` | Resolve an exact normalized contact only when one visible lead matches. |
| `POST /api/agent/leads/:id/conversations` with `nativeDelivery` | `conversations:write` and `outreach:write` | Persist one confirmed delivered outgoing WhatsApp message. |
| `PATCH /api/agent/leads/:id` with `{ "nativeConversationId": "..." }` | `leads:update:limited` and `outreach:write` | Repair Contacted fields after the conversation has committed. |
| `GET /api/agent/outreach/no-reply-due` | `outreach:read` | Read due first contacts and separately identify records without source delivery time. |
| `POST /api/agent/leads/:id/no-reply` with `{ "firstConversationId": "..." }` | `outreach:write` | Record a due, transactionally rechecked no-reply outcome. |

Agent identity and the current time come from the authenticated server
context. A caller cannot choose the label or business clock. Existing keys
keep their stored scopes; an administrator must deliberately issue keys with
the additional scopes.

## Reservation and delivery payloads

A claim request body is exactly `{ "requestKey": "<durable opaque key>" }`.
Persist and reuse the same key after a lost response. An empty pool result
does not consume the key. The target is eight confirmed first deliveries per
authenticated label and Johannesburg calendar day. Outstanding reservations
across all dates also hold capacity. `held`, `accepted`, or unknown gateway
outcomes do not increase delivered count and do not release a reservation.
Release only a reservation that was never submitted or a terminal job proven
unable to deliver.

For a delivered event, the CRM receives one exact rendered message:

```json
{
  "segmentId": "native-whatsapp:v1:<sha256>",
  "idempotencyKey": "native-whatsapp:v1:<sha256>",
  "channel": "whatsapp",
  "messages": [{
    "direction": "outgoing",
    "speaker": "<authenticated agent label>",
    "body": "<event.text, byte-for-byte>",
    "timestamp": null
  }],
  "summary": "WhatsApp message delivered",
  "occurredAt": null,
  "nativeDelivery": {"state": "delivered", "claimId": "<UUID or null>"}
}
```

The identity is `native-whatsapp:v1:` plus SHA-256 of the UTF-8 compact JSON
array `[stableNamespace, account, outbox_id]`. Namespace and account are
stable deployment configuration and must be supplied explicitly. Message body,
summary, state, credentials, and filesystem
paths are never part of identity. The segment is unique across leads.

The adapter freezes the lead, claim, channel, summary, exact body, speaker,
nullable timestamp, segment, and idempotency key in a local SQLite database
before network writes. Reusing an outbox identity with different content or
a different lead is a conflict and must be reconciled manually. If the event
does not retain a lead ID, the adapter asks the scoped resolver and requires
exactly one visible match before binding it.

The write order is conversation POST, native conversation PATCH, then local
applied receipt. The POST inserts first-contact evidence and consumes a
matching reservation in one CRM transaction, before the later Contacted
field repair. A timeout or failure at any step leaves local application
unconfirmed. Retry the identical frozen POST; CRM idempotency returns the
original conversation, then retry the field repair. Do not acknowledge an
upstream event cursor until the companion has persisted a successful
writeback receipt for every delivered event in that batch.

Existing version 1 receipts from a status-only companion must be reconciled
through the hosted writeback path before being treated as complete. A future
companion implementation should version those receipts and replay old
delivered outcomes once; do not infer that an older status receipt proves a
CRM transcript exists.

## Time and no-reply policy

Until the matching native Hermes outcome producer exposes a verified source
delivery-time field, native writeback sends a null timestamp. CRM preserves
the receipt time as an operational first-contact fallback and marks the
source time unknown. Unknown-time records are visible from the no-reply
listing but are deferred for reconciliation; they are not presented as a
known response deadline and cannot be classified automatically.

For a known first-delivery time, the deadline is the same Johannesburg local
wall time on the next Monday-to-Friday business day. Weekends are skipped;
public holidays count as ordinary weekdays. At or after the deadline, the
CRM locks the lead row and rechecks ownership, the exact first conversation,
and all inbound history before inserting one `no_reply` outcome. Inbound
conversation inserts lock the same lead row. A later inbound message
supersedes the outcome without deleting its historical activity. Outcomes
are activity entries, not synthetic conversations. No task, reminder, or
message is sent by classification.

The SALES reporting client must refresh its local reply ledger before
classification, veto locally observed replies, POST the CRM outcome first,
and mirror the returned outcome ID idempotently only after CRM success. If
inbound state cannot be refreshed, defer classification visibly. CRM generic
report sync must not overwrite Contacted time or re-post an unsupported
generic no-reply field.

## Recovery and operational constraints

- A label rename changes the quota identity. Reconcile ownership and
  outstanding reservations before assigning a new label to a key.
- A first native delivery without a matching reservation still records the
  physical delivery and first-contact evidence, reports an allocation
  violation, and blocks further allocation as needed. It cannot undo a send
  that already happened.
- The eight-send guarantee applies only when every native cold-send path
  obtains and submits a matching reservation. Existing upstream send paths
  are outside this guarantee until a separately authorized cutover.
- Manual lead enrichment and ready research remain CRM administrator work.
  Hosted-native nightly processing must consume those saved dossiers and
  must not run local research or select outside the shared ready pool.
- Capacity shortfalls must report delivered, pending, target, and shortfall
  separately. Drafts, accepted jobs, and held jobs are not deliveries.
- Apply `scripts/migrations/2026-10-25-native-whatsapp-crm.sql`,
  `scripts/migrations/2026-10-25-crm-enrichment-batches.sql`, and
  `scripts/migrations/2026-10-26-native-no-reply.sql` only later through the
  reviewed migration procedure against the intended database. This work
  applied migrations only to a disposable local PostgreSQL database.
- Keep the native gate off during setup and tests unless an isolated test
  explicitly sets it. No profiles, jobs, credentials, or production
  migrations are changed by this repository work.

The isolated SALES branch now contains durable job bindings and versioned
cursor receipts, CRM-claimed batch allocation, hosted-native manual-send
guards, and the no-reply reporting mirror. Its offline tests pass. The complete
loopback CRM/SALES flow requires a disposable database and an explicit
`SALES_OPS_SOURCE_ROOT`; native gateway runtime acceptance also requires the
matching Hermes fork pinned by `tests/run_native.sh`. Those external acceptance
checks are not deployment approval. No production pilot or deployment
readiness is claimed here.
