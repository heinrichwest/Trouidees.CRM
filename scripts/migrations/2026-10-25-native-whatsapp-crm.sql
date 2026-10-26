ALTER TABLE lead_conversations
  ADD COLUMN IF NOT EXISTS native_delivery JSONB;

CREATE TABLE IF NOT EXISTS lead_research_readiness (
  lead_id UUID PRIMARY KEY REFERENCES crm_leads(id) ON DELETE CASCADE,
  research JSONB NOT NULL,
  messageable BOOLEAN NOT NULL DEFAULT FALSE,
  ready BOOLEAN NOT NULL DEFAULT FALSE,
  researched_at TIMESTAMPTZ NOT NULL,
  ready_at TIMESTAMPTZ,
  actor_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (NOT ready OR (messageable AND ready_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS lead_research_readiness_pool_idx
  ON lead_research_readiness (ready_at, lead_id) WHERE ready;

CREATE TABLE IF NOT EXISTS lead_outreach_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent TEXT NOT NULL CHECK (BTRIM(agent) <> ''),
  lead_id UUID NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 1 AND 200),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'submitted', 'delivered', 'released')),
  job_key TEXT,
  release_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (agent, request_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS lead_outreach_claims_unresolved_lead_idx
  ON lead_outreach_claims (lead_id) WHERE state IN ('reserved', 'submitted');
CREATE INDEX IF NOT EXISTS lead_outreach_claims_agent_state_idx
  ON lead_outreach_claims (agent, state, created_at);

CREATE TABLE IF NOT EXISTS lead_first_contacts (
  lead_id UUID PRIMARY KEY REFERENCES crm_leads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('legacy', 'native')),
  agent TEXT NOT NULL DEFAULT '',
  source_delivered_at TIMESTAMPTZ,
  effective_delivered_at TIMESTAMPTZ NOT NULL,
  source_time_known BOOLEAN NOT NULL DEFAULT FALSE,
  first_conversation_id UUID REFERENCES lead_conversations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (source_time_known = (source_delivered_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS lead_first_contacts_agent_day_idx
  ON lead_first_contacts (agent, effective_delivered_at, lead_id);

CREATE TABLE IF NOT EXISTS lead_contact_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  first_conversation_id UUID NOT NULL REFERENCES lead_conversations(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('no_reply')),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (lead_id, first_conversation_id, outcome)
);
CREATE INDEX IF NOT EXISTS lead_contact_outcomes_current_idx
  ON lead_contact_outcomes (lead_id, observed_at DESC) WHERE superseded_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS lead_conversations_native_segment_idx
  ON lead_conversations (segment_id) WHERE native_delivery IS NOT NULL;

-- A prior delivered native conversation is already a native first contact;
-- keep it distinct from conservative legacy evidence below.
INSERT INTO lead_first_contacts
  (lead_id, kind, agent, source_delivered_at, effective_delivered_at, source_time_known, first_conversation_id)
SELECT DISTINCT ON (conversation.lead_id)
  conversation.lead_id,
  'native',
  COALESCE(NULLIF(conversation.native_delivery->>'agent', ''),
    (SELECT message->>'speaker' FROM jsonb_array_elements(conversation.messages) message
      WHERE message->>'direction' = 'outgoing' LIMIT 1),
    NULLIF(BTRIM(leads.data->>'assignedTo'), ''), ''),
  NULLIF(conversation.native_delivery->>'sourceDeliveredAt', '')::timestamptz,
  COALESCE(NULLIF(conversation.native_delivery->>'sourceDeliveredAt', '')::timestamptz,
    conversation.occurred_at, conversation.created_at),
  NULLIF(conversation.native_delivery->>'sourceDeliveredAt', '') IS NOT NULL,
  conversation.id
FROM lead_conversations conversation
JOIN crm_leads leads ON leads.id = conversation.lead_id
WHERE conversation.native_delivery->>'state' = 'delivered'
ORDER BY conversation.lead_id, COALESCE(conversation.occurred_at, conversation.created_at), conversation.id
ON CONFLICT (lead_id) DO NOTHING;

-- Status, a contact date, or any historical outgoing transcript excludes a lead
-- permanently from the new-contact pool, even when exact delivery time is unknown.
INSERT INTO lead_first_contacts
  (lead_id, kind, agent, source_delivered_at, effective_delivered_at, source_time_known, first_conversation_id)
SELECT leads.id, 'legacy', COALESCE(NULLIF(BTRIM(leads.data->>'assignedTo'), ''), ''),
  NULL,
  COALESCE(outgoing.occurred_at,
    CASE WHEN leads.data->>'lastContactedAt' ~ '^\d{4}-\d{2}-\d{2}'
      THEN (leads.data->>'lastContactedAt')::timestamptz END,
    leads.updated_at, leads.created_at),
  FALSE,
  outgoing.id
FROM crm_leads leads
LEFT JOIN LATERAL (
  SELECT conversation.id, conversation.occurred_at
  FROM lead_conversations conversation
  WHERE conversation.lead_id = leads.id
    AND conversation.native_delivery->>'state' IS DISTINCT FROM 'delivered'
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(conversation.messages) message WHERE message->>'direction' = 'outgoing')
  ORDER BY COALESCE(conversation.occurred_at, conversation.created_at), conversation.id
  LIMIT 1
) outgoing ON TRUE
WHERE COALESCE(leads.data->>'lastContactedAt', '') <> ''
  OR COALESCE(leads.data->>'status', '') NOT IN ('New', 'To contact')
  OR outgoing.id IS NOT NULL
ON CONFLICT (lead_id) DO NOTHING;

CREATE OR REPLACE FUNCTION crm_retain_legacy_lead_contact()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  contact_date TIMESTAMPTZ;
BEGIN
  IF COALESCE(NEW.data->>'lastContactedAt', '') = ''
    AND COALESCE(NEW.data->>'status', '') IN ('New', 'To contact') THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM lead_first_contacts WHERE lead_id = NEW.id AND kind = 'native') THEN
    RETURN NEW;
  END IF;
  contact_date := CASE WHEN NEW.data->>'lastContactedAt' ~ '^\d{4}-\d{2}-\d{2}'
    THEN (NEW.data->>'lastContactedAt')::timestamptz END;
  INSERT INTO lead_first_contacts (lead_id, kind, agent, source_delivered_at, effective_delivered_at, source_time_known)
  VALUES (NEW.id, 'legacy', COALESCE(NULLIF(BTRIM(NEW.data->>'assignedTo'), ''), ''), NULL,
    COALESCE(contact_date, NEW.updated_at, NEW.created_at, NOW()), FALSE)
  ON CONFLICT (lead_id) DO NOTHING;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS crm_retain_legacy_lead_contact_trigger ON crm_leads;
CREATE TRIGGER crm_retain_legacy_lead_contact_trigger
  AFTER INSERT OR UPDATE OF data ON crm_leads
  FOR EACH ROW EXECUTE FUNCTION crm_retain_legacy_lead_contact();

CREATE OR REPLACE FUNCTION crm_retain_legacy_outgoing_conversation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  speaker_name TEXT;
BEGIN
  IF NEW.native_delivery->>'state' = 'delivered'
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.messages) message WHERE message->>'direction' = 'outgoing') THEN
    RETURN NEW;
  END IF;
  SELECT COALESCE(NULLIF(message->>'speaker', ''), '') INTO speaker_name
    FROM jsonb_array_elements(NEW.messages) message WHERE message->>'direction' = 'outgoing' LIMIT 1;
  INSERT INTO lead_first_contacts (lead_id, kind, agent, source_delivered_at, effective_delivered_at, source_time_known, first_conversation_id)
  VALUES (NEW.lead_id, 'legacy', speaker_name, NULL,
    COALESCE(NEW.occurred_at, NEW.created_at, NOW()), FALSE, NEW.id)
  ON CONFLICT (lead_id) DO NOTHING;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS crm_retain_legacy_outgoing_conversation_trigger ON lead_conversations;
CREATE TRIGGER crm_retain_legacy_outgoing_conversation_trigger
  AFTER INSERT OR UPDATE OF messages, native_delivery ON lead_conversations
  FOR EACH ROW EXECUTE FUNCTION crm_retain_legacy_outgoing_conversation();
