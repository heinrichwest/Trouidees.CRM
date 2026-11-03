-- Scope native ready-lead claims to the claiming agent's markets.
--
-- One CRM serves agents for different markets (tutors, photographers, ...). Without this, a claim
-- took the oldest ready lead of any type, so a photographer agent could be handed a tutoring centre.
-- p_lead_types restricts the ready pool to those crm_leads.lead_type values. NULL keeps the
-- original behaviour (any type), so existing three-argument callers are unchanged.
--
-- The three-argument function is dropped first: keeping it next to a four-argument function whose
-- last argument has a default would make three-argument calls ambiguous.
-- An existing claim for the same (agent, requestKey) is still returned as-is (idempotent replay).

DROP FUNCTION IF EXISTS crm_claim_ready_lead(TEXT, TEXT, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION crm_claim_ready_lead(p_agent TEXT, p_request_key TEXT, p_now TIMESTAMPTZ, p_lead_types TEXT[] DEFAULT NULL)
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
  IF p_lead_types IS NOT NULL AND (cardinality(p_lead_types) NOT BETWEEN 1 AND 20
      OR EXISTS (SELECT 1 FROM unnest(p_lead_types) AS t(v) WHERE NULLIF(BTRIM(v), '') IS NULL OR length(v) > 100)) THEN
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
      AND (p_lead_types IS NULL OR leads.lead_type = ANY(p_lead_types))
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
