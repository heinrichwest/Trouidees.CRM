# Andrew CRM Read and Write-Back Design

**Status:** Approved design; implementation not started  
**Date:** 2026-09-29  
**Target:** Vercel production with Neon as the single source of truth

## Goal

Let Andrew, running in Hermes Agent, browse and search eligible CRM leads, read their contact and business details, assign an unassigned lead to himself, and automatically write each WhatsApp exchange back to the production CRM. He also writes limited CRM updates and internal notes.

The CRM records conversations that Andrew has already had. It does not send messages on Andrew's behalf.

## Scope

The Andrew API provides:

- Paginated lead browse and search over unassigned leads and leads assigned to Andrew only, including contact details. Leads assigned to other people are not visible to Andrew.
- A single-lead detail read.
- Atomic self-assignment of an unassigned lead. Andrew appears as the fixed `Andrew` assignee label, not as a CRM user account. Only a human admin can unassign or change ownership. Andrew must own a lead before reading its conversation history, logging an exchange, adding an internal note, or updating its CRM fields.
- Automatic write-back after each WhatsApp conversation, with each contact-visible incoming WhatsApp message and each outgoing WhatsApp message copied verbatim and in order from Hermes session history, plus a separate LLM-generated summary for the exchange. System prompts, internal reasoning, tool calls, and tool results are excluded. Each message retains its speaker/direction and source timestamp when present. Missing metadata is marked unknown; the system does not invent messages or timestamps.
- Append-only internal notes, separate from WhatsApp messages and visible to human CRM users. Andrew cannot edit or delete a note; corrections are new notes.
- A CRM lead activity timeline that shows the message-by-message transcript, exchange summary, and internal notes as distinct, chronologically ordered record types.
- Updates to an explicit allow-list of CRM fields: status, feedback, next follow-up date, last-contact date, and DNC state.
- DNC setting when a contact asks not to be contacted. Andrew cannot clear DNC; a human admin can clear it with an audit record.

Andrew cannot delete leads, assign them to other people, change lead types, manage users, access reports, or enumerate the database without pagination.

Out of scope: outbound message sending, send scheduling, daily caps, reply queues, automatic message retention/deletion, and broader sales automation.

## Architecture

Vercel production and its Neon database are the only write target. Existing human cookie authentication and browser routes remain in place. A separate `/api/agent/*` route family authenticates Andrew with a dedicated bearer key. Neon stores only a hash of each key. An admin creates, revokes, and rotates keys; the secret is displayed once at creation. The Hermes integration stores the key in Hermes's secret configuration, not in prompts or session logs.

Agent keys use explicit scopes for lead search/read, self-assignment, conversation logging, internal notes, and limited updates. Every route checks its required scope. Lead search and detail reads enforce the unassigned-or-Andrew visibility rule. The API rejects arbitrary update fields, writes to leads Andrew does not own, and assigning a lead to anyone other than Andrew. Human sales users retain lead deletion access and other existing workflow; changing lead ownership becomes admin-only.

The database adds a conversation table that stores each exchange's ordered message array and separate summary, append-only internal notes, agent-key records, a DNC flag and audit history, and an assignment mechanism. Phone normalization supports reliable phone search. Existing duplicate normalized phone numbers are reported and handled as ambiguous search results; the migration does not merge leads or add a uniqueness constraint without a separate cleanup decision.

Hermes instructions require a CRM write-back after each completed WhatsApp conversation. A Hermes plugin reads session history through the supported session export interface, preserving only the contact-visible incoming and outgoing WhatsApp message records verbatim; it excludes system prompts, internal reasoning, tool calls, and tool results. The LLM produces a separate summary. If summary generation fails, raw messages remain queued and the summary can be retried without losing or duplicating the transcript.

A conversation is written when Hermes closes the chat or when it has had no new message for 24 hours. The Hermes session-finalize hook queues explicit closes/resets, while a Hermes scheduled task identifies sessions idle for 24 hours. The 24-hour idle timeout closes that conversation segment; a later message starts a new segment. Each segment is submitted once with all original messages, source ordering, available timestamps, channel, and one summary. A stable segment id and idempotency key prevent duplicate writes if close and idle triggers race or Hermes retries.

Before Andrew performs write-back, he atomically claims the lead if it is unassigned. If another actor owns it, he cannot write to it. Only a human admin can release or reassign Andrew's lead.

Human CRM users can view the transcript, summary, and internal notes together in the lead activity timeline. This UI makes the exchange flow reviewable while preserving the distinction between messages sent to/from the contact and internal CRM notes. The integration uses Hermes's supported session export interface, rather than assuming legacy JSONL session files are current.

## API contract

| Method and path | Purpose |
|---|---|
| `GET /api/agent/leads` | Paginated search/browse of unassigned and Andrew-assigned leads, with supported filters and a bounded page size |
| `GET /api/agent/leads/:id` | Read one lead's contact and CRM details |
| `POST /api/agent/leads/:id/assign-self` | Atomically assign an unassigned lead to the fixed `Andrew` label; repeated assignment by Andrew is idempotent |
| `GET /api/agent/leads/:id/conversations` | Read message-by-message transcript and exchange summaries for a lead Andrew owns |
| `POST /api/agent/leads/:id/conversations` | Idempotently append an exchange transcript copied from Hermes session logs and a separate summary with channel and exchange time |
| `POST /api/agent/leads/:id/notes` | Append an internal CRM note to a lead Andrew owns |
| `PATCH /api/agent/leads/:id` | Update only the approved CRM fields; DNC can be set, never cleared through this route |
| Human-session `GET /api/crm/leads/:id/activity` | Read transcript, summaries, and notes for display in the existing CRM lead view |
| Admin-only `POST /api/admin/agent-keys` and `DELETE /api/admin/agent-keys/:id` | Create and revoke Andrew's keys; creation returns the secret once |
| Admin-only `POST /api/admin/leads/:id/dnc/clear` | Clear DNC with a required reason and an audit entry |

Search accepts pagination and bounded query/filter parameters; it never returns the whole table in one response. It excludes leads assigned to anyone other than Andrew. When phone normalization matches more than one eligible lead, the response makes the ambiguity explicit so Andrew can choose the correct record.

Conversation writes accept an idempotency key so retrying after a timeout does not duplicate messages or summaries. Notes are append-only. Validation, missing leads, leads not owned by Andrew, stale/conflicting assignments, insufficient scopes, and duplicate phone matches have explicit error responses. Sensitive key material is never returned after creation.

Hermes persists each completed exchange in a durable local outbox before attempting CRM write-back. It retries failed writes until Neon confirms success, then marks the entry complete. Retries use the same idempotency key. Pending and failed writes are visible to operators; a failed CRM connection never causes the only copy of a transcript to be discarded.

## Consent and DNC records

The user confirms consent for all existing leads. Record one documented admin attestation covering the existing pool, with the attestation source, date, actor, and evidence/reference. This record is kept as evidence and does not gate Andrew's read or write-back workflow.

DNC is independent of sales status. Andrew may set it based on a stop request. Clearing it requires a human admin action with actor, time, and reason in an audit record. The Andrew API has no operation to clear DNC. Human admin routes use existing cookie authentication and require the admin role.

## Rollout

1. Prepare an explicit, additive Neon migration and validate it against a staging database.
2. Report normalized-phone duplicates and preserve them until a human resolves any required merges; do not block the initial rollout on uniqueness.
3. Apply the pool-wide consent attestation with its evidence fields.
4. Deploy the scoped `/api/agent/*` routes behind a feature flag, leaving browser authentication and routes unchanged.
5. Have an admin create Andrew's key, store it in his runtime secret store, and verify revocation/rotation.
6. Configure Hermes instructions and the Hermes-to-CRM integration, including the durable outbox and transcript extraction from session logs.
7. Enable Andrew after staging checks pass and verify automatic write-back after a WhatsApp exchange, including recovery after an interrupted CRM request.

The real production Neon credential is managed in the production environment by someone authorized to operate it. No production credential is part of this spec or stored in the repository.

## Verification criteria

- Agent-key requests without the required scope fail; revoked keys stop working.
- Search is paginated, bounded, and returns contact details only within its documented DTO.
- Search and direct reads never reveal leads assigned to someone other than Andrew; unassigned and Andrew-assigned leads are visible.
- Duplicate phone matches are represented as ambiguous, without silently selecting or merging a lead.
- Two concurrent self-assignment attempts cannot assign one unassigned lead to two owners; only an admin can unassign or reassign Andrew's lead.
- Andrew can repeat his own assignment without an error or reassignment.
- Andrew must own a lead before he can log an exchange, add a note, or update it.
- Every original WhatsApp message is preserved verbatim and in session-log order, with direction/speaker and original timestamp when available; the exchange summary is stored separately.
- Hermes automatically queues the transcript and summary after each WhatsApp conversation; transient CRM failures retry durably until confirmed, without duplicate entries or losing the transcript.
- Hermes closes and writes a conversation on explicit close or after 24 hours of inactivity. A message arriving after an idle close begins a new segment.
- Internal notes are separate from transcript messages, visible to human CRM users, append-only, and cannot be edited or deleted by Andrew.
- Human CRM lead view displays the full ordered transcript, its summary, and internal notes as distinct timeline records.
- Updates outside the field allow-list fail; Andrew cannot assign to another person or clear DNC.
- A stop request can set DNC; a human admin can clear it only with an audited reason.
- Existing human cookie login and human `sales` behavior remain unchanged.
- No API operation sends a message or deletes a lead.
- Hermes instructions require automatic post-conversation write-back; code copies session-log messages while the LLM generates only the summary.

Message-body retention/deletion is not part of this rollout; no automatic deletion is introduced.
