# Andrew CRM API and Activity Timeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Add a scoped Andrew bearer API and human CRM activity timeline backed by Neon while preserving existing cookie-authenticated workflows.

**Architecture:** Add an explicit additive SQL migration and focused agent auth/store/API modules. Route agent and admin operations before the current cookie-only gate. Conversation segments store ordered message JSON and a separate summary; notes and DNC audit events remain separate records. Extend the lead detail view with a combined timeline.

**Tech Stack:** Node.js >=20, ES modules, @neondatabase/serverless, PostgreSQL/Neon, node:test, existing vanilla JS/HTML/CSS CRM.

**Spec:** docs/superpowers/specs/2026-09-29-andrew-crm-writeback.md

## Global Constraints

- Vercel production and Neon are the only write target; integration checks use isolated staging Neon.
- Andrew is a fixed assignee label; he sees unassigned and Andrew-assigned leads only.
- Andrew must own a lead before conversation reads/writes, notes, or updates.
- Andrew may set DNC but cannot clear it; admin clear requires a reason and audit.
- Preserve WhatsApp message bodies verbatim and in order, with available timestamps; store summaries separately.
- Internal notes are append-only and distinct from contact-visible messages.
- Existing cookie authentication and sales lead deletion remain; only admins may change ownership.
- No API sends messages, deletes leads, or adds retention/deletion behavior.
- Agent API defaults off with AGENT_API_ENABLED=0. Never fall back to local JSON when Neon is unavailable.
- Never place credentials or raw agent keys in source, logs, plans, or tests.

## Review Focus

- Foreign assignment visibility: no other person's leads in search/direct read; test Task 3.
- Concurrent self-assignment: exactly one unassigned-to-Andrew transition; test Task 2 against staging.
- Duplicate normalized phone: explicit ambiguity, no implicit selection/merge; test Tasks 2–3.
- Unauthorized ownership/DNC clear: sales cannot change owner; Andrew cannot clear DNC; test Task 3.
- Interrupted/retried writes: same conversation ID, no duplicate messages/summary; test Task 2.

## File Structure

- scripts/migrations/2026-09-29-andrew-crm.sql: additive schema for normalized phone lookup, keys, pool attestation, conversations, notes, DNC/audit.
- scripts/migrate-neon.mjs: explicit migration runner, separate from request-time ensureSchema.
- lib/agent-auth.mjs: bearer key parsing, hash lookup, scopes, create/revoke.
- lib/agent-store.mjs: narrow SQL operations, DTOs, assignment guards, timeline.
- lib/agent-api.mjs: route handlers, validation, scope/ownership checks, error mapping.
- server.mjs: route agent/admin endpoints before cookie-only gate; make ownership change admin-only.
- public/index.html, public/app.js, public/styles.css: timeline UI in existing lead detail dialog.
- .env.example: disabled-by-default flag.
- test/agent-migration.test.mjs, test/agent-auth.test.mjs, test/agent-api.test.mjs: unit/contract tests.
- test/agent-store.integration.test.mjs: opt-in tests using AGENT_TEST_DATABASE_URL.
- e2e/agent-activity.spec.mjs: timeline rendering and distinction.
- docs/agent-writeback-rollout.md: staging, attestation, key, enable/rollback steps.

## Task 1: Add the Explicit Neon Migration

**Files:** create the migration, runner, and test/agent-migration.test.mjs; modify .env.example.

**Interfaces:** Migration adds agent_keys, lead_conversations, lead_notes, lead_dnc_audit, lead_consent_attestations, crm_leads.do_not_contact, and a non-unique normalized phone index. Runner: node scripts/migrate-neon.mjs <migration-file>.

- [ ] Write tests asserting additive objects, no normalized-phone unique constraint, and foreign keys.
- [ ] Run node --test test/agent-migration.test.mjs; expected fail because migration is absent.
- [ ] Create the migration. Normalize South African 27... and 0... forms; add partial non-unique index; store key hash/scopes/active/last-used; consent source/date/actor/evidence; conversation segment ID, JSONB messages, separate summary, idempotency key; append-only notes; DNC and audit.
- [ ] Implement runner requiring DATABASE_URL, accepting migration files only from scripts/migrations, running transactionally, and printing no SQL params or credentials. Set AGENT_API_ENABLED=0 in .env.example.
- [ ] Run node --test test/agent-migration.test.mjs; expected pass.
- [ ] Commit in a Git clone: feat: add Andrew CRM writeback schema.

## Task 2: Implement Store Operations

**Files:** create lib/agent-store.mjs and test/agent-store.integration.test.mjs.

**Interfaces:** listVisibleLeads({query, filters, limit, cursor}), getVisibleLead(id), assignSelf(id), appendConversation({leadId, segmentId, channel, messages, summary, idempotencyKey}), listConversations(leadId), appendNote(leadId, body, author), updateLeadLimited(id, patch), setDnc(id, reason, wording), clearDnc(id, adminId, reason), listActivity(leadId). Ownership mutations require expectedOwner: "Andrew".

- [ ] Write opt-in isolated Neon tests for visibility, duplicate phone ambiguity, concurrent/repeated assignment, idempotent writes, append-only notes, allow-list updates, DNC audit, and timeline order. Skip unless AGENT_TEST_DATABASE_URL points at disposable DB.
- [ ] Run node --test test/agent-store.integration.test.mjs; expected skip without URL and fail against migrated test DB until methods exist.
- [ ] Implement bounded paging (default 25, max 100), filter assignment to blank or Andrew, normalize phone search, and return ambiguity with candidate IDs; construct DTOs without DB internals.
- [ ] Implement atomic JSONB assignment; repeated Andrew assignment succeeds; writes verify ownership within SQL mutation; upsert conversation by lead and segment ID; insert notes only.
- [ ] Implement allow-list status, feedback, nextFollowUpAt, lastContactedAt, doNotContact; agent cannot set DNC false. Admin clear records actor/reason. Merge transcript, summary, notes into stable chronological activity records.
- [ ] Run integration tests against isolated migrated staging DB; expected all pass, including one concurrent assignment winner and one row after replay.
- [ ] Commit in a Git clone: feat: add atomic Andrew CRM store operations.

## Task 3: Add Bearer Authentication and Scoped Routes

**Files:** create lib/agent-auth.mjs, lib/agent-api.mjs, test/agent-auth.test.mjs, test/agent-api.test.mjs; modify server.mjs and .env.example.

**Interfaces:** Scopes: leads:search, leads:read, leads:assign:self, conversations:read, conversations:write, notes:write, leads:update:limited, dnc:set. handleAgentRequest({request,response,store}); handleAgentAdminRequest({request,response,store,user}).

- [ ] Test missing/malformed/unknown/revoked keys, SHA-256 hashing, missing-scope 403, valid scopes.
- [ ] Run node --test test/agent-auth.test.mjs; expected fail.
- [ ] Implement Authorization Bearer parsing, reuse hashToken from lib/auth.mjs, lookup active key, update last_used_at, scope check. Generate 32-byte base64url secrets; store hashes only; revoke by active=false.
- [ ] Test approved routes, bounded pagination, visibility, ownership, duplicate phone ambiguity, idempotency, forbidden update fields, and admin-only DNC clear/key management.
- [ ] Run node --test test/agent-api.test.mjs; expected fail until routes exist.
- [ ] Implement GET /api/agent/leads and /:id, POST /:id/assign-self, GET/POST /:id/conversations, POST /:id/notes, PATCH /:id; validate ordered {direction,speaker,body,timestamp} messages and idempotency key. Implement human-admin POST /api/admin/agent-keys, DELETE /api/admin/agent-keys/:id, and POST /api/admin/leads/:id/dnc/clear with required reason.
- [ ] Wire routes before cookie gate; flag off returns 503. Admin endpoints remain behind currentUser plus admin role. Preserve sales deletion, prevent sales assignment changes.
- [ ] Run node --test test/agent-auth.test.mjs test/agent-api.test.mjs test/auth.test.mjs test/crm.test.mjs; expected pass.
- [ ] Commit in Git clone: feat: add scoped Andrew API.

## Task 4: Add Human Activity Timeline

**Files:** modify public/index.html, public/app.js, public/styles.css, server.mjs; create e2e/agent-activity.spec.mjs.

**Interfaces:** Cookie-authenticated GET /api/crm/leads/:id/activity returns records {id,type,occurredAt} where type is message, summary, or note plus the corresponding payload.

- [ ] Add browser fixture with alternating messages, summary, note; assert presence, chronological order, and distinct record labels.
- [ ] Run npm run test:e2e -- e2e/agent-activity.spec.mjs; expected fail.
- [ ] Add cookie-protected activity endpoint using listActivity; missing lead returns 404.
- [ ] Add timeline markup/rendering. Escape content using existing safe text pattern; show unknown time when missing; distinguish incoming/outgoing and internal note; show empty state.
- [ ] Run the browser test; expected pass and no note rendered as WhatsApp.
- [ ] Commit in Git clone: feat: show conversation activity in lead details.

## Task 5: Document and Stage the CRM Side

**Files:** create docs/agent-writeback-rollout.md; modify README.md.

- [ ] Document staging migration, duplicate report, pool attestation fields, test-key creation/revocation, and feature flag.
- [ ] Document production enablement only after admin key provisioning and Hermes readiness; rollback by disabling flag/revoking key; keep additive data.
- [ ] Add README operator pointer without credential values.
- [ ] Review steps against spec; confirm no credentials or unsupported production claims.
- [ ] Commit in Git clone: docs: document Andrew CRM rollout.

