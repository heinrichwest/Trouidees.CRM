CREATE TABLE IF NOT EXISTS crm_enrichment_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  creator_user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 1 AND 200),
  lead_ids UUID[] NOT NULL CHECK (cardinality(lead_ids) BETWEEN 1 AND 20),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'cancelled')) DEFAULT 'queued',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (creator_user_id, request_key)
);
CREATE INDEX IF NOT EXISTS crm_enrichment_batches_creator_idx
  ON crm_enrichment_batches (creator_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS crm_enrichment_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES crm_enrichment_batches(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  ordinal INT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'needs_review', 'failed', 'interrupted', 'cancelled')) DEFAULT 'queued',
  attempt_id UUID,
  lease_until TIMESTAMPTZ,
  report JSONB,
  research JSONB,
  reason TEXT,
  credits_used NUMERIC,
  usage JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (batch_id, lead_id),
  UNIQUE (batch_id, ordinal)
);
CREATE INDEX IF NOT EXISTS crm_enrichment_items_batch_idx
  ON crm_enrichment_items (batch_id, ordinal);

CREATE TABLE IF NOT EXISTS crm_enrichment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES crm_enrichment_batches(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('running', 'ready', 'needs_review', 'failed', 'interrupted')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_until TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS crm_enrichment_attempts_active_lead_idx
  ON crm_enrichment_attempts (lead_id) WHERE state = 'running';
CREATE INDEX IF NOT EXISTS crm_enrichment_attempts_batch_idx
  ON crm_enrichment_attempts (batch_id, started_at);

ALTER TABLE crm_enrichment_items
  DROP CONSTRAINT IF EXISTS crm_enrichment_items_attempt_id_fkey;
ALTER TABLE crm_enrichment_items
  ADD CONSTRAINT crm_enrichment_items_attempt_id_fkey
  FOREIGN KEY (attempt_id) REFERENCES crm_enrichment_attempts(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS crm_enrichment_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id UUID NOT NULL REFERENCES crm_enrichment_batches(id) ON DELETE CASCADE,
  operation_key UUID NOT NULL,
  attempt_id UUID REFERENCES crm_enrichment_attempts(id) ON DELETE SET NULL,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (batch_id, operation_key)
);

CREATE OR REPLACE FUNCTION crm_create_enrichment_batch(p_user_id UUID, p_request_key TEXT, p_lead_ids UUID[])
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE
  batch_id UUID;
  existing_ids UUID[];
BEGIN
  IF p_user_id IS NULL OR NULLIF(BTRIM(p_request_key), '') IS NULL OR length(p_request_key) > 200
    OR p_lead_ids IS NULL OR cardinality(p_lead_ids) NOT BETWEEN 1 AND 20
    OR cardinality(p_lead_ids) <> (SELECT COUNT(DISTINCT lead_id) FROM unnest(p_lead_ids) AS lead_id) THEN
    RAISE EXCEPTION 'INVALID_BATCH' USING ERRCODE = '22023';
  END IF;
  IF (SELECT COUNT(*) FROM crm_leads WHERE id = ANY(p_lead_ids)) <> cardinality(p_lead_ids) THEN
    RAISE EXCEPTION 'LEAD_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO crm_enrichment_batches (creator_user_id, request_key, lead_ids)
    VALUES (p_user_id, p_request_key, p_lead_ids)
    ON CONFLICT (creator_user_id, request_key) DO NOTHING
    RETURNING id INTO batch_id;
  IF batch_id IS NULL THEN
    SELECT id, lead_ids INTO batch_id, existing_ids FROM crm_enrichment_batches
      WHERE creator_user_id = p_user_id AND request_key = p_request_key FOR UPDATE;
    IF cardinality(existing_ids) <> cardinality(p_lead_ids) OR NOT (existing_ids @> p_lead_ids AND p_lead_ids @> existing_ids) THEN
      RAISE EXCEPTION 'BATCH_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    RETURN batch_id;
  END IF;
  INSERT INTO crm_enrichment_items (batch_id, lead_id, ordinal)
    SELECT batch_id, lead_id, ordinal::int FROM unnest(p_lead_ids) WITH ORDINALITY AS selected(lead_id, ordinal);
  RETURN batch_id;
END;
$$;

CREATE OR REPLACE FUNCTION crm_claim_enrichment_item(p_batch_id UUID, p_operation_key UUID, p_now TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  batch_row crm_enrichment_batches%ROWTYPE;
  item_row crm_enrichment_items%ROWTYPE;
  attempt_row crm_enrichment_attempts%ROWTYPE;
  operation_row crm_enrichment_operations%ROWTYPE;
BEGIN
  UPDATE crm_enrichment_attempts SET state = 'interrupted', finished_at = p_now
    WHERE state = 'running' AND lease_until <= p_now;
  UPDATE crm_enrichment_items item SET state = 'interrupted', reason = 'The research attempt lease expired; retry is explicit.', lease_until = NULL, updated_at = p_now
    WHERE item.state = 'running' AND item.attempt_id IN (
      SELECT id FROM crm_enrichment_attempts WHERE state = 'interrupted' AND finished_at = p_now);
  UPDATE crm_enrichment_batches batch SET status = CASE
      WHEN EXISTS (SELECT 1 FROM crm_enrichment_items WHERE batch_id = batch.id AND state = 'queued') THEN 'queued'
      ELSE 'completed' END,
    updated_at = p_now
    WHERE batch.status = 'running'
      AND NOT EXISTS (SELECT 1 FROM crm_enrichment_items WHERE batch_id = batch.id AND state = 'running');

  SELECT * INTO batch_row FROM crm_enrichment_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BATCH_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO operation_row FROM crm_enrichment_operations WHERE batch_id = p_batch_id AND operation_key = p_operation_key FOR UPDATE;
  IF FOUND THEN
    RETURN jsonb_build_object('attempt', NULL, 'replay', TRUE, 'result', operation_row.result);
  END IF;
  IF batch_row.status = 'cancelled' THEN RETURN jsonb_build_object('attempt', NULL, 'replay', FALSE, 'result', NULL); END IF;

  SELECT * INTO item_row FROM crm_enrichment_items
    WHERE batch_id = p_batch_id AND state = 'running' AND lease_until > p_now ORDER BY ordinal LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('attempt', NULL, 'replay', FALSE, 'result', NULL);
  END IF;

  SELECT item.* INTO item_row FROM crm_enrichment_items item
    WHERE item.batch_id = p_batch_id AND item.state = 'queued'
      AND NOT EXISTS (SELECT 1 FROM crm_enrichment_attempts active WHERE active.lead_id = item.lead_id AND active.state = 'running')
    ORDER BY item.ordinal LIMIT 1 FOR UPDATE OF item SKIP LOCKED;
  IF NOT FOUND THEN
    IF NOT EXISTS (SELECT 1 FROM crm_enrichment_items WHERE batch_id = p_batch_id AND state IN ('queued', 'running')) THEN
      UPDATE crm_enrichment_batches SET status = 'completed', updated_at = p_now WHERE id = p_batch_id;
    END IF;
    RETURN jsonb_build_object('attempt', NULL, 'replay', FALSE, 'result', NULL);
  END IF;

  INSERT INTO crm_enrichment_attempts (batch_id, lead_id, state, started_at, lease_until)
    VALUES (p_batch_id, item_row.lead_id, 'running', p_now, p_now + INTERVAL '10 minutes') RETURNING * INTO attempt_row;
  UPDATE crm_enrichment_items SET state = 'running', attempt_id = attempt_row.id, lease_until = attempt_row.lease_until, updated_at = p_now
    WHERE id = item_row.id;
  INSERT INTO crm_enrichment_operations (batch_id, operation_key, attempt_id) VALUES (p_batch_id, p_operation_key, attempt_row.id);
  UPDATE crm_enrichment_batches SET status = 'running', updated_at = p_now WHERE id = p_batch_id;
  RETURN jsonb_build_object('attempt', jsonb_build_object('id', attempt_row.id, 'batchId', p_batch_id, 'leadId', attempt_row.lead_id, 'startedAt', attempt_row.started_at, 'leaseUntil', attempt_row.lease_until), 'replay', FALSE, 'result', NULL);
END;
$$;

DROP FUNCTION IF EXISTS crm_complete_enrichment_attempt(UUID, JSONB, TIMESTAMPTZ);
CREATE OR REPLACE FUNCTION crm_complete_enrichment_attempt(p_attempt_id UUID, p_result JSONB, p_now TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  attempt_row crm_enrichment_attempts%ROWTYPE;
  item_row crm_enrichment_items%ROWTYPE;
  batch_row crm_enrichment_batches%ROWTYPE;
  state_value TEXT;
  reason_value TEXT;
  research_dto JSONB;
  research_input JSONB;
BEGIN
  SELECT * INTO attempt_row FROM crm_enrichment_attempts WHERE id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ATTEMPT_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  SELECT * INTO item_row FROM crm_enrichment_items WHERE attempt_id = p_attempt_id FOR UPDATE;
  SELECT * INTO batch_row FROM crm_enrichment_batches WHERE id = attempt_row.batch_id FOR UPDATE;
  IF attempt_row.state <> 'running' OR attempt_row.lease_until <= p_now OR item_row.state <> 'running' THEN
    IF EXISTS (SELECT 1 FROM crm_enrichment_operations WHERE attempt_id = p_attempt_id AND result IS NOT NULL) THEN
      RETURN jsonb_build_object('batchId', attempt_row.batch_id, 'applied', TRUE);
    END IF;
    IF attempt_row.state = 'running' THEN
      UPDATE crm_enrichment_attempts SET state = 'interrupted', finished_at = p_now WHERE id = p_attempt_id;
      UPDATE crm_enrichment_items SET state = 'interrupted', reason = 'The research attempt lease expired; retry is explicit.', lease_until = NULL, updated_at = p_now WHERE id = item_row.id;
    END IF;
    RETURN jsonb_build_object('batchId', attempt_row.batch_id, 'applied', FALSE);
  END IF;

  state_value := p_result->>'state';
  IF state_value IS NULL OR state_value NOT IN ('ready', 'needs_review', 'failed', 'interrupted') THEN RAISE EXCEPTION 'INVALID_RESULT' USING ERRCODE = '22023'; END IF;
  reason_value := NULLIF(p_result->>'reason', '');
  IF state_value IN ('ready', 'needs_review') THEN
    research_input := p_result->'research';
    SELECT crm_put_lead_research(attempt_row.lead_id, research_input->'research',
      COALESCE((research_input->>'messageable')::boolean, FALSE), COALESCE((research_input->>'ready')::boolean, FALSE),
      (research_input->>'researchedAt')::timestamptz, batch_row.creator_user_id) INTO research_dto;
    IF state_value = 'ready' AND research_dto->>'ready' <> 'true' THEN
      state_value := 'needs_review';
      reason_value := COALESCE(reason_value || ' ', '') || 'Lead eligibility changed while research was running.';
    END IF;
  END IF;

  UPDATE crm_enrichment_attempts SET state = state_value, finished_at = p_now WHERE id = p_attempt_id;
  UPDATE crm_enrichment_items SET state = state_value, report = p_result->'report',
    research = CASE WHEN research_dto IS NOT NULL THEN research_dto ELSE p_result->'research' END,
    reason = reason_value, credits_used = NULLIF(p_result->>'creditsUsed', '')::numeric, usage = p_result->'usage',
    lease_until = NULL, updated_at = p_now WHERE id = item_row.id;
  UPDATE crm_enrichment_operations SET result = jsonb_build_object('leadId', item_row.lead_id, 'state', state_value, 'reason', reason_value,
      'report', p_result->'report', 'research', COALESCE(research_dto, p_result->'research'), 'creditsUsed', p_result->'creditsUsed', 'usage', p_result->'usage')
    WHERE attempt_id = p_attempt_id;
  IF batch_row.status <> 'cancelled' THEN
    UPDATE crm_enrichment_batches SET status = CASE WHEN EXISTS (SELECT 1 FROM crm_enrichment_items WHERE batch_id = batch_row.id AND state IN ('queued', 'running')) THEN 'queued' ELSE 'completed' END,
      updated_at = p_now WHERE id = batch_row.id;
  END IF;
  RETURN jsonb_build_object('batchId', attempt_row.batch_id, 'applied', TRUE);
END;
$$;

CREATE OR REPLACE FUNCTION crm_retry_enrichment_items(p_batch_id UUID, p_lead_ids UUID[], p_now TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM crm_enrichment_batches WHERE id = p_batch_id AND status <> 'cancelled' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BATCH_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  IF p_lead_ids IS NULL OR cardinality(p_lead_ids) = 0 OR EXISTS (
    SELECT 1 FROM unnest(p_lead_ids) AS selected(lead_id) WHERE NOT EXISTS (
      SELECT 1 FROM crm_enrichment_items item WHERE item.batch_id = p_batch_id AND item.lead_id = selected.lead_id AND item.state IN ('failed', 'interrupted'))) THEN
    RAISE EXCEPTION 'RETRY_NOT_ALLOWED' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_lead_ids) AS selected(lead_id) JOIN crm_enrichment_attempts active ON active.lead_id = selected.lead_id AND active.state = 'running') THEN
    RAISE EXCEPTION 'LEAD_ALREADY_ACTIVE' USING ERRCODE = 'P0001';
  END IF;
  UPDATE crm_enrichment_items SET state = 'queued', attempt_id = NULL, lease_until = NULL, report = NULL, research = NULL, reason = NULL, credits_used = NULL, usage = NULL, updated_at = p_now
    WHERE batch_id = p_batch_id AND lead_id = ANY(p_lead_ids);
  UPDATE crm_enrichment_batches SET status = 'queued', updated_at = p_now WHERE id = p_batch_id;
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION crm_cancel_enrichment_batch(p_batch_id UUID, p_now TIMESTAMPTZ)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM crm_enrichment_batches WHERE id = p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BATCH_NOT_FOUND' USING ERRCODE = 'P0001'; END IF;
  UPDATE crm_enrichment_items SET state = 'cancelled', updated_at = p_now WHERE batch_id = p_batch_id AND state = 'queued';
  UPDATE crm_enrichment_batches SET status = 'cancelled', updated_at = p_now WHERE id = p_batch_id;
  RETURN TRUE;
END;
$$;
