# Hermes Andrew CRM Write-Back Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Install a Hermes plugin that lets Andrew browse and manage eligible CRM leads and also preserves every completed WhatsApp exchange verbatim, generates a separate summary, and durably synchronizes both to CRM.

**Architecture:** A native Hermes plugin calls scoped CRM API routes for lead search/read, self-assignment, allowed updates, notes, and conversation history. It also exports session history through the supported Hermes session export command, filters contact-visible WhatsApp messages, and stores a stable segment payload in a local SQLite outbox. A finalize hook queues closed sessions; an idle scanner queues sessions after 24 hours; an LLM-driven Hermes task summarizes pending transcripts and submits them to the CRM API. A Hermes skill instructs safe lead handling and automatic post-conversation processing.

**Tech Stack:** Hermes native Python plugin, Hermes session export CLI, Python standard library, SQLite, urllib, Hermes skill Markdown, unittest.

**Spec:** docs/superpowers/specs/2026-09-29-andrew-crm-writeback.md

## Global Constraints

- Include only contact-visible WhatsApp inbound messages and Andrew outbound final messages; exclude system, reasoning, tool calls/results.
- Preserve body verbatim/order and available timestamps; mark missing metadata unknown.
- Generate and store summary separately; never substitute generated text for originals.
- Queue on explicit close or after 24 hours idle; later messages start new segment.
- Persist before network attempts; retry same idempotency key until CRM confirms.
- Read API key from Hermes secret configuration, never prompts or logs. No Neon credentials in Hermes.
- Sync failure cannot drop transcript; expose pending/failed state.
- Recheck current Hermes APIs and run hermes plugins doctor --ci before installation.
- No WhatsApp sending, CRM deletion, or fine-tuning.

## Review Focus

- Non-WhatsApp session ignored (Task 2 extraction test).
- Mixed visible/tool traffic keeps only user and assistant final messages (Task 2).
- Close/idle race is idempotent and post-idle message makes new segment (Task 3).
- Restart/outage preserves queued transcript and retries same key (Task 4).
- Missing timestamps and Unicode/multiline body remain exact (Task 2).

## File Structure

- integrations/hermes-crm-plugin/plugin.yaml, __init__.py, schemas.py: plugin manifest and tool/hook registration.
- session_export.py: supported export invocation and visible-message filtering.
- outbox.py, idle_scan.py, scripts/queue_idle_sessions.py: SQLite persistence and 24-hour scanner.
- crm_client.py, tools.py, schemas.py: scoped CRM API calls and Hermes lead-management and transcript tools.
- skills/crm-writeback/SKILL.md: agent operating instructions.
- tests/: plugin, extraction, segmentation, retry and instruction checks.
- README.md: installation, secret configuration, cron, monitoring, recovery.

## Task 1: Scaffold Plugin Contracts

**Files:** create plugin.yaml, __init__.py, schemas.py, tests/test_plugin_registration.py under integrations/hermes-crm-plugin/.

**Interfaces:** Register tools crm_pending_syncs, crm_queue_session, crm_commit_sync and on_session_finalize hook. Hook accepts keyword arguments and no-ops on absent/unsupported session ID.

- [ ] Test metadata, exact tool names, and missing-session hook behavior.
- [ ] Run python -m unittest discover -s integrations/hermes-crm-plugin/tests; expected fail.
- [ ] Check current official [plugin guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/plugins/index.md) and [hook guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/hooks.md); adapt only to documented current manifest/registration contracts.
- [ ] Implement minimal metadata/schema/registration; finalize hook only enqueues local session ID.
- [ ] Run hermes plugins doctor integrations/hermes-crm-plugin --ci in a Hermes-enabled environment; expected validation pass. If CLI is unavailable, run unit tests and retain doctor as install-time check.
- [ ] Commit in Git clone: feat: scaffold Hermes CRM plugin.

## Task 2: Export and Filter Visible WhatsApp Messages

**Files:** create session_export.py and tests/test_session_export.py.

**Interfaces:** export_session(session_id: str) -> dict; extract_whatsapp_messages(export: dict, platform: str) -> list[dict] with each record {direction, speaker, body, timestamp, source_order}.

- [ ] Test inbound WhatsApp user message, assistant final replies, system, tool call/result, non-WhatsApp, unknown timestamps, and multiline Unicode; assert exact body/order and excluded records.
- [ ] Run python -m unittest integrations.hermes-crm-plugin.tests.test_session_export; expected fail.
- [ ] Verify the official [sessions guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md). Invoke hermes sessions export <temp-file> --session-id <id> safely without shell interpolation and parse JSONL. Do not read legacy session JSONL directly.
- [ ] Filter by WhatsApp platform and role/content/tool-call metadata; include inbound user and assistant final user-visible messages only. Do not alter bodies or invent timestamps.
- [ ] Run focused tests; expected pass, non-WhatsApp returns no transcript.
- [ ] Commit in Git clone: feat: extract visible WhatsApp transcript.

## Task 3: Add Session Segmentation and Durable Outbox

**Files:** create outbox.py, idle_scan.py, scripts/queue_idle_sessions.py, tests/test_outbox.py, tests/test_idle_scan.py.

**Interfaces:** queue_segment(session_id,messages,closed_at,reason)->segment_id; list_pending(limit=25); mark_syncing(segment_id); mark_synced(segment_id,conversation_id); mark_retry(segment_id,error,next_attempt_at); find_idle_whatsapp_sessions(now,idle_hours=24). Segment identity must distinguish later messages after idle closure while deduping close/idle triggers for same segment.

- [ ] Test SQLite reopen persistence, duplicate queue idempotency, state transitions, retry payload preservation, and secret-free errors.
- [ ] Run python -m unittest integrations.hermes-crm-plugin.tests.test_outbox; expected fail.
- [ ] Implement SQLite table in Hermes profile state directory with segment key, payload, status, attempts, retry time, safe error, remote ID.
- [ ] Test 23h59m not due, 24h due, explicit close, and post-idle message as a new segment.
- [ ] Implement scanner from supported Hermes session metadata/export; filter WhatsApp only and queue after 24 hours. No-agent scanner makes no CRM request and invokes no LLM.
- [ ] Run outbox and idle tests; expected pass and finalize hook remains local-only.
- [ ] Commit in Git clone: feat: persist Hermes CRM sync outbox.

## Task 4: Add CRM API Client and LLM Summary/Retry Flow

**Files:** create crm_client.py, tests/test_crm_client.py, tests/test_sync_retry.py; modify tools.py and schemas.py.

**Interfaces:** CRMClient(base_url,api_key,timeout_seconds=15); search_leads(query,lead_type,status,limit,cursor), get_lead(lead_id), assign_self(lead_id), list_conversations(lead_id), add_note(lead_id,body), update_lead(lead_id,fields), submit_conversation(lead_id,segment_id,messages,summary,idempotency_key). Hermes tools expose those operations as crm_search_leads, crm_get_lead, crm_assign_self, crm_get_conversations, crm_add_note, crm_update_lead, crm_pending_syncs and crm_commit_sync.

- [ ] Test bearer header, JSON/query/path encoding, lead search/detail, assignment, conversations, notes, limited updates including CRM comments, timeout, 4xx handling, 5xx/network retry, DNC restrictions, and secret-free errors.
- [ ] Run python -m unittest integrations.hermes-crm-plugin.tests.test_crm_client; expected fail.
- [ ] Implement standard-library urllib client reading CRM_API_BASE_URL and CRM_AGENT_API_KEY from Hermes profile environment. Expose only the scoped CRM routes; reject update fields outside the API allow-list before network calls. Do not print keys or transcript bodies.
- [ ] Register schemas and handlers for bounded lead search, one-lead read, self-assignment, owned conversation history, append-only note, and limited field updates including `comments`. Preserve ambiguous-phone results and require human resolution rather than choosing a candidate.
- [ ] Test timeout retains queued data, replay after success returns same remote ID, and transient failure retries idempotently.
- [ ] Implement tool flow: pending tool returns exact messages; LLM generates separate summary; commit submits payload and marks synced only after 2xx. Auth/validation 4xx stays visible for operator action; transient errors use exponential backoff until confirmed.
- [ ] Run client and retry tests; expected pass.
- [ ] Commit in Git clone: feat: sync Hermes conversation outbox to CRM.

## Task 5: Add Hermes Instructions, Schedules, and Operator Setup

**Files:** create skills/crm-writeback/SKILL.md, README.md, tests/test_writeback_instructions.py; modify __init__.py.

**Interfaces:** Skill instructs automatic sync after each explicit conversation close; idle processing handles 24-hour stalls. Summary is factual and separate from original transcript.

- [ ] Test skill text requires eligible lead ownership, all visible messages verbatim, separate summary, exclusion of internal/tool content, and commit after each completed conversation.
- [ ] Run python -m unittest integrations.hermes-crm-plugin.tests.test_writeback_instructions; expected fail.
- [ ] Write skill instructions: identify/claim lead, process pending transcript after close, make factual summary without fabricating, and report unresolved sync failure while retaining outbox data.
- [ ] Document a no-agent idle scan every 5 minutes and an LLM task to process pending segments every 5 minutes. Verify current syntax in the official [script-only cron guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/cron-script-only.md); no-agent scan only queues locally.
- [ ] Document install to ~/.hermes/plugins/trouidees-crm/, skill installation, secret setup, key rotation/revocation, pending/failed monitoring, and staging smoke test; include no real key.
- [ ] Run python -m unittest discover -s integrations/hermes-crm-plugin/tests; expected pass.
- [ ] In Hermes-enabled environment run hermes plugins doctor ~/.hermes/plugins/trouidees-crm --ci; expected pass. Staging-check explicit close, simulated 24h idle, and restart during CRM outage; confirm one transcript and one summary after recovery.
- [ ] Commit in Git clone: docs: install and operate Hermes CRM writeback.

## Task 6: Staging Acceptance

**Files:** modify integrations/hermes-crm-plugin/README.md and docs/agent-writeback-rollout.md.

- [ ] Use staging WhatsApp fixture with two inbound and two outbound visible messages interleaved with tool traffic; assert only four visible messages stored verbatim in order.
- [ ] Verify Andrew can search unassigned/Andrew-owned leads but cannot read a lead owned by another user.
- [ ] Verify explicit close and 24-hour idle each queue once, and a later message starts a new segment.
- [ ] Simulate CRM downtime, restart Hermes, restore CRM; verify one conversation, exact transcript, separate summary, synced outbox.
- [ ] Record staging results and rollback steps; do not claim production acceptance until an authorized operator repeats them.
- [ ] Commit in Git clone: docs: record Hermes CRM staging acceptance procedure.

