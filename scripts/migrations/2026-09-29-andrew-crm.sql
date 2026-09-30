ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS do_not_contact BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION crm_normalize_za_phone(value TEXT)
RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE
    WHEN digits LIKE '27%' AND length(digits) >= 11 THEN digits
    WHEN digits LIKE '0%' AND length(digits) >= 10 THEN '27' || substr(digits, 2)
    ELSE digits
  END
  FROM (SELECT regexp_replace(COALESCE(value, ''), '\D', '', 'g') AS digits) input
$$;

CREATE INDEX IF NOT EXISTS crm_leads_phone_normalized_idx
  ON crm_leads (crm_normalize_za_phone(phone)) WHERE phone <> '';

CREATE TABLE IF NOT EXISTS agent_keys (
  id UUID PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS lead_consent_attestations (
  id UUID PRIMARY KEY,
  source TEXT NOT NULL,
  attested_at TIMESTAMPTZ NOT NULL,
  actor TEXT NOT NULL,
  evidence_reference TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lead_conversations (
  id UUID PRIMARY KEY,
  lead_id UUID NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  messages JSONB NOT NULL,
  summary TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lead_id, segment_id),
  UNIQUE (lead_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS lead_notes (
  id UUID PRIMARY KEY,
  lead_id UUID NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lead_dnc_audit (
  id UUID PRIMARY KEY,
  lead_id UUID NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('set', 'clear')),
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  wording TEXT NOT NULL DEFAULT '',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
