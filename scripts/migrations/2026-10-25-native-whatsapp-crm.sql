ALTER TABLE lead_conversations
  ADD COLUMN IF NOT EXISTS native_delivery JSONB;

CREATE TABLE IF NOT EXISTS lead_research_readiness (
  lead_id UUID PRIMARY KEY REFERENCES crm_leads(id) ON DELETE CASCADE,
  research JSONB NOT NULL,
  messageable BOOLEAN NOT NULL DEFAULT FALSE,
  requested_ready BOOLEAN NOT NULL DEFAULT FALSE,
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

CREATE OR REPLACE FUNCTION crm_outreach_quota(p_agent TEXT, p_now TIMESTAMPTZ)
RETURNS JSONB LANGUAGE SQL STABLE AS $$
  SELECT jsonb_build_object(
    'agent', p_agent,
    'day', to_char((p_now AT TIME ZONE 'Africa/Johannesburg')::date, 'YYYY-MM-DD'),
    'timezone', 'Africa/Johannesburg',
    'target', 8,
    'delivered', COALESCE((SELECT COUNT(DISTINCT lead_id)::int FROM lead_first_contacts
      WHERE kind = 'native' AND agent = p_agent
        AND (effective_delivered_at AT TIME ZONE 'Africa/Johannesburg')::date = (p_now AT TIME ZONE 'Africa/Johannesburg')::date), 0),
    'outstanding', COALESCE((SELECT COUNT(*)::int FROM lead_outreach_claims
      WHERE agent = p_agent AND state IN ('reserved', 'submitted')), 0),
    'remaining', GREATEST(0, 8
      - COALESCE((SELECT COUNT(DISTINCT lead_id)::int FROM lead_first_contacts
        WHERE kind = 'native' AND agent = p_agent
          AND (effective_delivered_at AT TIME ZONE 'Africa/Johannesburg')::date = (p_now AT TIME ZONE 'Africa/Johannesburg')::date), 0)
      - COALESCE((SELECT COUNT(*)::int FROM lead_outreach_claims
        WHERE agent = p_agent AND state IN ('reserved', 'submitted')), 0))
  )
$$;

ALTER TABLE lead_research_readiness
  ADD COLUMN IF NOT EXISTS requested_ready BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION crm_put_lead_research(
  p_lead_id UUID,
  p_research JSONB,
  p_messageable BOOLEAN,
  p_ready BOOLEAN,
  p_researched_at TIMESTAMPTZ,
  p_actor_user_id UUID
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  lead_row crm_leads%ROWTYPE;
  current_row lead_research_readiness%ROWTYPE;
  saved_row lead_research_readiness%ROWTYPE;
  may_publish BOOLEAN;
BEGIN
  SELECT * INTO lead_row FROM crm_leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LEAD_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;

  may_publish := p_ready AND p_messageable
    AND COALESCE(BTRIM(lead_row.data->>'assignedTo'), '') = ''
    AND COALESCE(lead_row.data->>'status', '') IN ('New', 'To contact')
    AND NOT COALESCE(lead_row.do_not_contact, FALSE)
    AND NOT EXISTS (SELECT 1 FROM lead_first_contacts WHERE lead_id = p_lead_id);

  SELECT * INTO current_row FROM lead_research_readiness WHERE lead_id = p_lead_id FOR UPDATE;
  IF FOUND THEN
    IF current_row.researched_at > p_researched_at THEN
      RETURN jsonb_build_object('leadId', current_row.lead_id, 'researchedAt', current_row.researched_at,
        'ready', current_row.ready, 'messageable', current_row.messageable, 'research', current_row.research, 'readyAt', current_row.ready_at);
    END IF;
    IF current_row.researched_at = p_researched_at THEN
      IF current_row.research IS DISTINCT FROM p_research OR current_row.messageable IS DISTINCT FROM p_messageable OR current_row.requested_ready IS DISTINCT FROM p_ready THEN
        RAISE EXCEPTION 'RESEARCH_CONFLICT' USING ERRCODE = 'P0001';
      END IF;
      RETURN jsonb_build_object('leadId', current_row.lead_id, 'researchedAt', current_row.researched_at,
        'ready', current_row.ready, 'messageable', current_row.messageable, 'research', current_row.research, 'readyAt', current_row.ready_at);
    END IF;
  END IF;

  INSERT INTO lead_research_readiness (lead_id, research, messageable, requested_ready, ready, researched_at, ready_at, actor_user_id, updated_at)
  VALUES (p_lead_id, p_research, p_messageable, p_ready, may_publish, p_researched_at,
    CASE WHEN may_publish THEN NOW() END, p_actor_user_id, NOW())
  ON CONFLICT (lead_id) DO UPDATE SET research = EXCLUDED.research,
    messageable = EXCLUDED.messageable, requested_ready = EXCLUDED.requested_ready, ready = EXCLUDED.ready, researched_at = EXCLUDED.researched_at,
    ready_at = CASE WHEN EXCLUDED.ready THEN COALESCE(lead_research_readiness.ready_at, EXCLUDED.researched_at) ELSE NULL END,
    actor_user_id = EXCLUDED.actor_user_id, updated_at = NOW()
  RETURNING * INTO saved_row;
  RETURN jsonb_build_object('leadId', saved_row.lead_id, 'researchedAt', saved_row.researched_at,
    'ready', saved_row.ready, 'messageable', saved_row.messageable, 'research', saved_row.research, 'readyAt', saved_row.ready_at);
END;
$$;

CREATE OR REPLACE FUNCTION crm_claim_ready_lead(p_agent TEXT, p_request_key TEXT, p_now TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  existing_claim lead_outreach_claims%ROWTYPE;
  new_claim lead_outreach_claims%ROWTYPE;
  lead_row crm_leads%ROWTYPE;
  research_row lead_research_readiness%ROWTYPE;
  quota_row JSONB;
  day_delivered INT;
  pending INT;
  reason_value TEXT;
BEGIN
  IF NULLIF(BTRIM(p_agent), '') IS NULL OR length(p_agent) > 200 OR length(p_request_key) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'INVALID_CLAIM_REQUEST' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('native-outreach-agent:' || p_agent, 0));

  SELECT * INTO existing_claim FROM lead_outreach_claims WHERE agent = p_agent AND request_key = p_request_key FOR UPDATE;
  IF FOUND THEN
    SELECT * INTO lead_row FROM crm_leads WHERE id = existing_claim.lead_id;
    SELECT * INTO research_row FROM lead_research_readiness WHERE lead_id = existing_claim.lead_id;
    quota_row := crm_outreach_quota(p_agent, p_now);
    RETURN jsonb_build_object(
      'claim', jsonb_build_object('id', existing_claim.id, 'leadId', existing_claim.lead_id, 'requestKey', existing_claim.request_key, 'state', existing_claim.state, 'jobKey', existing_claim.job_key),
      'lead', lead_row.data || jsonb_build_object('id', lead_row.id, 'doNotContact', COALESCE(lead_row.do_not_contact, FALSE)),
      'research', jsonb_build_object('leadId', research_row.lead_id, 'researchedAt', research_row.researched_at, 'ready', research_row.ready,
        'messageable', research_row.messageable, 'research', research_row.research, 'readyAt', research_row.ready_at),
      'quota', quota_row, 'reason', NULL);
  END IF;

  quota_row := crm_outreach_quota(p_agent, p_now);
  day_delivered := (quota_row->>'delivered')::int;
  pending := (quota_row->>'outstanding')::int;
  IF day_delivered >= 8 THEN
    reason_value := 'daily_cap';
  ELSIF day_delivered + pending >= 8 THEN
    reason_value := 'capacity_held';
  ELSE
    SELECT leads.* INTO lead_row
    FROM crm_leads leads
    JOIN lead_research_readiness research ON research.lead_id = leads.id AND research.ready AND research.messageable
    WHERE COALESCE(BTRIM(leads.data->>'assignedTo'), '') = ''
      AND COALESCE(leads.data->>'status', '') IN ('New', 'To contact')
      AND NOT COALESCE(leads.do_not_contact, FALSE)
      AND NOT EXISTS (SELECT 1 FROM lead_first_contacts contacts WHERE contacts.lead_id = leads.id)
      AND NOT EXISTS (SELECT 1 FROM lead_outreach_claims claims WHERE claims.lead_id = leads.id AND claims.state IN ('reserved', 'submitted'))
    ORDER BY research.ready_at, leads.id
    LIMIT 1 FOR UPDATE OF leads SKIP LOCKED;
    IF NOT FOUND THEN
      reason_value := 'pool_empty';
    ELSE
      UPDATE crm_leads SET data = jsonb_set(data, '{assignedTo}', to_jsonb(p_agent::text), TRUE), updated_at = p_now
        WHERE id = lead_row.id RETURNING * INTO lead_row;
      INSERT INTO lead_outreach_claims (agent, lead_id, request_key, state, created_at, updated_at)
        VALUES (p_agent, lead_row.id, p_request_key, 'reserved', p_now, p_now) RETURNING * INTO new_claim;
      SELECT * INTO research_row FROM lead_research_readiness WHERE lead_id = lead_row.id;
      quota_row := crm_outreach_quota(p_agent, p_now);
      RETURN jsonb_build_object(
        'claim', jsonb_build_object('id', new_claim.id, 'leadId', new_claim.lead_id, 'requestKey', new_claim.request_key, 'state', new_claim.state, 'jobKey', new_claim.job_key),
        'lead', lead_row.data || jsonb_build_object('id', lead_row.id, 'doNotContact', COALESCE(lead_row.do_not_contact, FALSE)),
        'research', jsonb_build_object('leadId', research_row.lead_id, 'researchedAt', research_row.researched_at, 'ready', research_row.ready,
          'messageable', research_row.messageable, 'research', research_row.research, 'readyAt', research_row.ready_at),
        'quota', quota_row, 'reason', NULL);
    END IF;
  END IF;

  quota_row := crm_outreach_quota(p_agent, p_now);
  RETURN jsonb_build_object('claim', NULL, 'lead', NULL, 'research', NULL, 'quota', quota_row, 'reason', reason_value);
END;
$$;

CREATE OR REPLACE FUNCTION crm_update_outreach_claim(p_agent TEXT, p_claim_id UUID, p_action JSONB, p_now TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  claim_row lead_outreach_claims%ROWTYPE;
  lead_owner TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('native-outreach-agent:' || p_agent, 0));
  SELECT * INTO claim_row FROM lead_outreach_claims WHERE id = p_claim_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CLAIM_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF claim_row.agent <> p_agent THEN RAISE EXCEPTION 'CLAIM_FORBIDDEN' USING ERRCODE = 'P0001'; END IF;

  IF p_action->>'state' = 'submitted' THEN
    IF NULLIF(BTRIM(p_action->>'jobKey'), '') IS NULL THEN RAISE EXCEPTION 'INVALID_JOB_KEY' USING ERRCODE = '22023'; END IF;
    IF claim_row.state = 'submitted' AND claim_row.job_key = p_action->>'jobKey' THEN
      RETURN jsonb_build_object('id', claim_row.id, 'leadId', claim_row.lead_id, 'requestKey', claim_row.request_key, 'state', claim_row.state, 'jobKey', claim_row.job_key);
    END IF;
    IF claim_row.state <> 'reserved' OR claim_row.job_key IS NOT NULL THEN RAISE EXCEPTION 'CLAIM_CONFLICT' USING ERRCODE = 'P0001'; END IF;
    UPDATE lead_outreach_claims SET state = 'submitted', job_key = p_action->>'jobKey', updated_at = p_now
      WHERE id = p_claim_id RETURNING * INTO claim_row;
  ELSIF p_action->>'state' = 'released' THEN
    IF p_action->>'reason' NOT IN ('not_submitted', 'terminal_no_delivery') THEN RAISE EXCEPTION 'INVALID_RELEASE_REASON' USING ERRCODE = '22023'; END IF;
    IF claim_row.state = 'released' AND claim_row.release_reason = p_action->>'reason' THEN
      RETURN jsonb_build_object('id', claim_row.id, 'leadId', claim_row.lead_id, 'requestKey', claim_row.request_key, 'state', claim_row.state, 'jobKey', claim_row.job_key);
    END IF;
    IF EXISTS (SELECT 1 FROM lead_first_contacts WHERE lead_id = claim_row.lead_id) THEN RAISE EXCEPTION 'CLAIM_CONFLICT' USING ERRCODE = 'P0001'; END IF;
    IF (p_action->>'reason' = 'not_submitted' AND claim_row.state <> 'reserved')
      OR (p_action->>'reason' = 'terminal_no_delivery' AND claim_row.state <> 'submitted') THEN
      RAISE EXCEPTION 'CLAIM_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    SELECT BTRIM(COALESCE(data->>'assignedTo', '')) INTO lead_owner FROM crm_leads WHERE id = claim_row.lead_id FOR UPDATE;
    IF lead_owner IS DISTINCT FROM '' AND lead_owner IS DISTINCT FROM p_agent THEN RAISE EXCEPTION 'CLAIM_CONFLICT' USING ERRCODE = 'P0001'; END IF;
    UPDATE crm_leads SET data = jsonb_set(data, '{assignedTo}', '""'::jsonb, TRUE), updated_at = p_now
      WHERE id = claim_row.lead_id AND NOT EXISTS (SELECT 1 FROM lead_first_contacts WHERE lead_id = claim_row.lead_id);
    UPDATE lead_outreach_claims SET state = 'released', release_reason = p_action->>'reason', updated_at = p_now
      WHERE id = p_claim_id RETURNING * INTO claim_row;
  ELSE
    RAISE EXCEPTION 'INVALID_CLAIM_ACTION' USING ERRCODE = '22023';
  END IF;
  RETURN jsonb_build_object('id', claim_row.id, 'leadId', claim_row.lead_id, 'requestKey', claim_row.request_key, 'state', claim_row.state, 'jobKey', claim_row.job_key);
END;
$$;

CREATE OR REPLACE FUNCTION crm_append_native_conversation(p_agent TEXT, p_input JSONB, p_now TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  lead_key UUID;
  conversation_key UUID := gen_random_uuid();
  claim_key UUID;
  lead_row crm_leads%ROWTYPE;
  claim_row lead_outreach_claims%ROWTYPE;
  existing_row lead_conversations%ROWTYPE;
  source_at TIMESTAMPTZ;
  effective_at TIMESTAMPTZ;
  current_delivered INTEGER := 0;
  first_contact BOOLEAN;
  claim_matches BOOLEAN := FALSE;
  violation BOOLEAN := FALSE;
  requested_meta JSONB;
  saved_meta JSONB;
BEGIN
  IF NULLIF(BTRIM(p_agent), '') IS NULL OR length(p_agent) > 200 THEN
    RAISE EXCEPTION 'INVALID_NATIVE_AGENT' USING ERRCODE = '22023';
  END IF;
  IF (p_input->'nativeDelivery'->>'state') IS DISTINCT FROM 'delivered'
    OR COALESCE(p_input->'nativeDelivery'->>'agent', '') IS DISTINCT FROM p_agent
    OR jsonb_typeof(p_input->'messages') IS DISTINCT FROM 'array'
    OR jsonb_array_length(COALESCE(p_input->'messages', '[]'::jsonb)) <> 1
    OR p_input->>'channel' IS DISTINCT FROM 'whatsapp'
    OR p_input->>'summary' IS DISTINCT FROM 'WhatsApp message delivered'
    OR p_input->'messages'->0->>'direction' IS DISTINCT FROM 'outgoing'
    OR p_input->'messages'->0->>'speaker' IS DISTINCT FROM p_agent
    OR jsonb_typeof(p_input->'messages'->0->'body') IS DISTINCT FROM 'string'
    OR NULLIF(p_input->>'segmentId', '') IS NULL
    OR NULLIF(p_input->>'idempotencyKey', '') IS NULL THEN
    RAISE EXCEPTION 'INVALID_NATIVE_DELIVERY' USING ERRCODE = '22023';
  END IF;
  lead_key := (p_input->>'leadId')::uuid;
  claim_key := NULLIF(p_input->'nativeDelivery'->>'claimId', '')::uuid;
  source_at := NULLIF(p_input->'nativeDelivery'->>'sourceDeliveredAt', '')::timestamptz;
  IF NULLIF(p_input->'messages'->0->>'timestamp', '')::timestamptz IS DISTINCT FROM source_at THEN
    RAISE EXCEPTION 'INVALID_NATIVE_DELIVERY_TIME' USING ERRCODE = '22023';
  END IF;
  IF source_at IS NOT NULL AND source_at > p_now THEN
    RAISE EXCEPTION 'INVALID_NATIVE_DELIVERY_TIME' USING ERRCODE = '22023';
  END IF;
  effective_at := COALESCE(source_at, p_now);

  PERFORM pg_advisory_xact_lock(hashtextextended('native-outreach-agent:' || p_agent, 0));
  SELECT * INTO lead_row FROM crm_leads WHERE id = lead_key FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LEAD_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF BTRIM(COALESCE(lead_row.data->>'assignedTo', '')) IS DISTINCT FROM p_agent THEN
    RAISE EXCEPTION 'NOT_OWNED' USING ERRCODE = 'P0001';
  END IF;

  IF claim_key IS NOT NULL THEN
    SELECT * INTO claim_row FROM lead_outreach_claims WHERE id = claim_key FOR UPDATE;
    claim_matches := FOUND AND claim_row.lead_id = lead_key AND claim_row.agent = p_agent
      AND claim_row.state IN ('reserved', 'submitted', 'delivered');
  END IF;
  SELECT COUNT(DISTINCT lead_id)::int INTO current_delivered
    FROM lead_first_contacts WHERE kind = 'native' AND agent = p_agent
      AND (effective_delivered_at AT TIME ZONE 'Africa/Johannesburg')::date = (p_now AT TIME ZONE 'Africa/Johannesburg')::date;
  first_contact := NOT EXISTS (SELECT 1 FROM lead_first_contacts WHERE lead_id = lead_key);
  violation := first_contact AND (NOT claim_matches OR current_delivered >= 8);
  requested_meta := jsonb_build_object('state', 'delivered', 'claimId', claim_key, 'agent', p_agent,
    'sourceDeliveredAt', source_at, 'contactedAt', effective_at, 'firstContact', first_contact,
    'allocationViolation', violation);

  INSERT INTO lead_conversations (id, lead_id, segment_id, channel, messages, summary, idempotency_key, occurred_at, native_delivery)
  VALUES (conversation_key, lead_key, p_input->>'segmentId', p_input->>'channel', p_input->'messages',
    p_input->>'summary', p_input->>'idempotencyKey', source_at, requested_meta)
  ON CONFLICT DO NOTHING RETURNING * INTO existing_row;

  IF NOT FOUND THEN
    SELECT * INTO existing_row FROM lead_conversations
      WHERE (lead_id = lead_key AND (idempotency_key = p_input->>'idempotencyKey' OR segment_id = p_input->>'segmentId'))
        OR segment_id = p_input->>'segmentId'
      ORDER BY created_at, id LIMIT 1;
    IF NOT FOUND
      OR existing_row.lead_id <> lead_key
      OR existing_row.segment_id <> p_input->>'segmentId'
      OR existing_row.channel <> p_input->>'channel'
      OR existing_row.messages IS DISTINCT FROM p_input->'messages'
      OR existing_row.summary <> p_input->>'summary'
      OR existing_row.idempotency_key <> p_input->>'idempotencyKey'
      OR existing_row.occurred_at IS DISTINCT FROM source_at
      OR existing_row.native_delivery->>'state' IS DISTINCT FROM 'delivered'
      OR NULLIF(existing_row.native_delivery->>'claimId', '') IS DISTINCT FROM NULLIF(requested_meta->>'claimId', '')
      OR existing_row.native_delivery->>'agent' IS DISTINCT FROM p_agent
      OR NULLIF(existing_row.native_delivery->>'sourceDeliveredAt', '')::timestamptz IS DISTINCT FROM source_at THEN
      RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    saved_meta := existing_row.native_delivery;
    RETURN jsonb_build_object('conversation', jsonb_build_object('id', existing_row.id, 'leadId', existing_row.lead_id,
      'segmentId', existing_row.segment_id, 'channel', existing_row.channel, 'messages', existing_row.messages,
      'summary', existing_row.summary, 'occurredAt', existing_row.occurred_at, 'createdAt', existing_row.created_at,
      'nativeDelivery', saved_meta), 'contactedAt', saved_meta->>'contactedAt',
      'firstContact', COALESCE((saved_meta->>'firstContact')::boolean, FALSE),
      'allocationViolation', COALESCE((saved_meta->>'allocationViolation')::boolean, FALSE));
  END IF;

  IF claim_matches AND claim_row.state <> 'delivered' THEN
    UPDATE lead_outreach_claims SET state = 'delivered', updated_at = p_now WHERE id = claim_key;
  END IF;
  IF first_contact THEN
    INSERT INTO lead_first_contacts (lead_id, kind, agent, source_delivered_at, effective_delivered_at, source_time_known, first_conversation_id)
    VALUES (lead_key, 'native', p_agent, source_at, effective_at, source_at IS NOT NULL, conversation_key)
    ON CONFLICT (lead_id) DO NOTHING;
  END IF;
  RETURN jsonb_build_object('conversation', jsonb_build_object('id', conversation_key, 'leadId', lead_key,
    'segmentId', p_input->>'segmentId', 'channel', p_input->>'channel', 'messages', p_input->'messages',
    'summary', p_input->>'summary', 'occurredAt', source_at, 'createdAt', existing_row.created_at, 'nativeDelivery', requested_meta),
    'contactedAt', effective_at, 'firstContact', first_contact, 'allocationViolation', violation);
END;
$$;

CREATE OR REPLACE FUNCTION crm_finalize_native_delivery(p_agent TEXT, p_lead_id UUID, p_conversation_id UUID)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  lead_row crm_leads%ROWTYPE;
  conversation_row lead_conversations%ROWTYPE;
  delivery_at TIMESTAMPTZ;
  prior_contact_at TIMESTAMPTZ;
  next_status TEXT;
BEGIN
  SELECT * INTO lead_row FROM crm_leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LEAD_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF BTRIM(COALESCE(lead_row.data->>'assignedTo', '')) IS DISTINCT FROM p_agent THEN
    RAISE EXCEPTION 'NOT_OWNED' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO conversation_row FROM lead_conversations
    WHERE id = p_conversation_id AND lead_id = p_lead_id FOR SHARE;
  IF NOT FOUND OR conversation_row.native_delivery->>'state' IS DISTINCT FROM 'delivered'
    OR conversation_row.native_delivery->>'agent' IS DISTINCT FROM p_agent THEN
    RAISE EXCEPTION 'NATIVE_CONVERSATION_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  delivery_at := NULLIF(conversation_row.native_delivery->>'contactedAt', '')::timestamptz;
  IF delivery_at IS NULL THEN RAISE EXCEPTION 'INVALID_NATIVE_DELIVERY' USING ERRCODE = '22023'; END IF;
  IF lead_row.data->>'lastContactedAt' ~ '^\d{4}-\d{2}-\d{2}' THEN
    prior_contact_at := (lead_row.data->>'lastContactedAt')::timestamptz;
  END IF;
  next_status := lead_row.data->>'status';
  UPDATE crm_leads SET data = CASE WHEN COALESCE(next_status, '') IN ('New', 'To contact', 'Contacted')
      THEN jsonb_set(jsonb_set(data, '{lastContactedAt}', to_jsonb(CASE WHEN prior_contact_at > delivery_at THEN data->>'lastContactedAt' ELSE delivery_at::text END), TRUE), '{status}', '"Contacted"'::jsonb, TRUE)
      ELSE jsonb_set(data, '{lastContactedAt}', to_jsonb(CASE WHEN prior_contact_at > delivery_at THEN data->>'lastContactedAt' ELSE delivery_at::text END), TRUE)
    END, updated_at = NOW()
    WHERE id = p_lead_id RETURNING * INTO lead_row;
  RETURN lead_row.data || jsonb_build_object('id', lead_row.id, 'doNotContact', COALESCE(lead_row.do_not_contact, FALSE));
END;
$$;
