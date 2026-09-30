# Andrew CRM writeback rollout

This rollout covers the CRM side only. The API flag is disabled unless `AGENT_API_ENABLED=1`; keep it disabled until the CRM schema, staging checks, key handoff, and the separate Hermes integration are ready. CRM conversations store completed exchanges. No CRM endpoint sends WhatsApp messages.

## Staging preparation

1. Use a disposable staging Neon database with the existing CRM base schema initialized. Set `DATABASE_URL` to that staging database in the migration shell only.
2. Apply the explicit additive migration:

   ```powershell
   node scripts/migrate-neon.mjs scripts/migrations/2026-09-29-andrew-crm.sql
   ```

3. Report duplicate eligible South African phone matches before any cleanup decision. Do not merge rows or add a unique phone constraint:

   ```sql
   SELECT crm_normalize_za_phone(phone) AS normalized_phone, array_agg(id ORDER BY id) AS lead_ids, count(*) AS matches
   FROM crm_leads
   WHERE phone <> ''
   GROUP BY crm_normalize_za_phone(phone)
   HAVING count(*) > 1
   ORDER BY matches DESC, normalized_phone;
   ```

   Agent search reports multiple eligible matches as ambiguous and returns candidate IDs.

4. Record the pool-wide consent attestation only after an authorized administrator confirms the evidence. Keep the source, attestation date, actor, and durable evidence reference:

   ```sql
   INSERT INTO lead_consent_attestations (id, source, attested_at, actor, evidence_reference)
   VALUES (gen_random_uuid(), '<attestation source>', '<date with timezone>', '<admin identity>', '<evidence reference>');
   ```

5. Set `AGENT_TEST_DATABASE_URL` to the disposable, migrated staging database and run `node --test test/agent-store.integration.test.mjs`. This test creates uniquely named fixture rows and removes them afterward. Never point it at production.
6. Run the CRM API unit tests and browser activity test. Confirm a sales session cannot change an owner, Andrew cannot view another owner's leads, retries do not duplicate a segment, and notes display as internal notes.

## Key provisioning and enablement

After staging checks and the separate Hermes implementation/readiness checks are complete, a human administrator can create a scoped key through the authenticated CRM session:

```http
POST /api/admin/agent-keys
Content-Type: application/json

{"label":"Andrew"}
```

The response includes the random secret once. Deliver it directly to Andrew's runtime secret store; do not put it in source, prompts, transcripts, browser storage, or logs. The database retains only its SHA-256 hash. Revoke a key with `DELETE /api/admin/agent-keys/{id}`. Provision a replacement before revoking the old key when rotating.

Keep `AGENT_API_ENABLED=0` until the approved Hermes client is configured to browse, claim, record the verbatim ordered transcript and separate summary, write notes, and retry durable outbox entries with the same segment and idempotency IDs. Enable with `AGENT_API_ENABLED=1` only after those checks pass. Human CRM routes continue to use cookie authentication.

## DNC and ownership

Andrew can set DNC after a stop request; the request may include `dncReason` and `dncWording`. The store writes the DNC state and a set audit row together. Andrew cannot clear it. A human administrator clears DNC through `POST /api/admin/leads/{id}/dnc/clear` with a required reason; actor, time, and reason are recorded. Only admins may change lead ownership in the human CRM.

## Rollback

Set `AGENT_API_ENABLED=0` to disable bearer routes immediately and revoke the issued key through the admin API. Keep the additive conversation, note, audit, consent, and key tables in place; this rollout introduces no automatic retention or deletion behavior. Existing cookie-authenticated CRM use remains available.

Production enablement requires the production operator to use the authorized production environment and credentials. This repository contains no production credential and this rollout does not apply the migration or create keys in production.
