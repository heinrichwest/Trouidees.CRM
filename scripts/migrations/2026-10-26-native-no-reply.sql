-- A no-reply deadline is the same Johannesburg wall time on the next weekday.
-- Public holidays are intentionally ordinary weekdays under the approved policy.
CREATE OR REPLACE FUNCTION crm_no_reply_due_at(p_delivered_at TIMESTAMPTZ)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE local_at TIMESTAMP; due_day DATE;
BEGIN
  local_at := p_delivered_at AT TIME ZONE 'Africa/Johannesburg';
  due_day := local_at::date + 1;
  WHILE EXTRACT(ISODOW FROM due_day) IN (6, 7) LOOP due_day := due_day + 1; END LOOP;
  RETURN (due_day + local_at::time) AT TIME ZONE 'Africa/Johannesburg';
END;
$$;

CREATE OR REPLACE FUNCTION crm_list_no_reply_due(
  p_agent TEXT, p_now TIMESTAMPTZ, p_after_due TIMESTAMPTZ, p_after_lead UUID, p_limit INT
) RETURNS TABLE(lead_id UUID, phone TEXT, first_conversation_id UUID, first_delivered_at TIMESTAMPTZ, due_at TIMESTAMPTZ)
LANGUAGE SQL STABLE AS $$
  SELECT lead.id, lead.phone, first_contact.first_conversation_id, first_contact.effective_delivered_at,
    crm_no_reply_due_at(first_contact.effective_delivered_at)
  FROM lead_first_contacts first_contact
  JOIN crm_leads lead ON lead.id = first_contact.lead_id
  WHERE first_contact.first_conversation_id IS NOT NULL
    AND first_contact.source_time_known
    AND BTRIM(COALESCE(lead.data->>'assignedTo','')) = p_agent
    AND crm_no_reply_due_at(first_contact.effective_delivered_at) <= p_now
    AND (p_after_due IS NULL OR (crm_no_reply_due_at(first_contact.effective_delivered_at), lead.id) > (p_after_due, p_after_lead))
    AND NOT EXISTS (
      SELECT 1 FROM lead_contact_outcomes outcome
      WHERE outcome.lead_id = lead.id AND outcome.first_conversation_id = first_contact.first_conversation_id
        AND outcome.outcome = 'no_reply' AND outcome.superseded_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM lead_conversations incoming_conversation
      CROSS JOIN LATERAL jsonb_array_elements(incoming_conversation.messages) message
      WHERE incoming_conversation.lead_id = lead.id
        AND message->>'direction' IN ('incoming','inbound')
        AND COALESCE(NULLIF(message->>'timestamp','')::timestamptz,
          incoming_conversation.occurred_at, incoming_conversation.created_at) >= first_contact.effective_delivered_at
    )
  ORDER BY crm_no_reply_due_at(first_contact.effective_delivered_at), lead.id
  LIMIT LEAST(GREATEST(p_limit,1),101);
$$;

CREATE OR REPLACE FUNCTION crm_record_no_reply(p_agent TEXT, p_lead_id UUID, p_conversation_id UUID, p_now TIMESTAMPTZ)
RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE lead_row crm_leads%ROWTYPE; first_contact lead_first_contacts%ROWTYPE; due_at TIMESTAMPTZ;
  existing lead_contact_outcomes%ROWTYPE; created_id UUID;
BEGIN
  SELECT * INTO lead_row FROM crm_leads WHERE id=p_lead_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'LEAD_NOT_FOUND' USING ERRCODE='P0001'; END IF;
  IF BTRIM(COALESCE(lead_row.data->>'assignedTo','')) <> p_agent THEN RAISE EXCEPTION 'NOT_OWNED' USING ERRCODE='P0001'; END IF;
  SELECT * INTO first_contact FROM lead_first_contacts
    WHERE lead_id=p_lead_id AND first_conversation_id=p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('recorded',false,'reason','unknown_delivery_time','outcomeId',NULL); END IF;
  IF NOT first_contact.source_time_known THEN RETURN jsonb_build_object('recorded',false,'reason','unknown_delivery_time','outcomeId',NULL); END IF;
  due_at := crm_no_reply_due_at(first_contact.effective_delivered_at);
  IF p_now < due_at THEN RETURN jsonb_build_object('recorded',false,'reason','not_due','outcomeId',NULL); END IF;
  SELECT * INTO existing FROM lead_contact_outcomes WHERE lead_id=p_lead_id AND first_conversation_id=p_conversation_id AND outcome='no_reply';
  IF FOUND THEN
    RETURN jsonb_build_object('recorded',false,'reason',CASE WHEN existing.superseded_at IS NULL THEN 'no_reply' ELSE 'replied' END,'outcomeId',existing.id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM lead_conversations conversation
    CROSS JOIN LATERAL jsonb_array_elements(conversation.messages) message
    WHERE conversation.lead_id=p_lead_id AND message->>'direction' IN ('incoming','inbound')
      AND COALESCE(NULLIF(message->>'timestamp','')::timestamptz,conversation.occurred_at,conversation.created_at) >= first_contact.effective_delivered_at
  ) THEN RETURN jsonb_build_object('recorded',false,'reason','replied','outcomeId',NULL); END IF;
  INSERT INTO lead_contact_outcomes(lead_id,first_conversation_id,outcome,observed_at)
    VALUES(p_lead_id,p_conversation_id,'no_reply',p_now) ON CONFLICT(lead_id,first_conversation_id,outcome) DO NOTHING RETURNING id INTO created_id;
  IF created_id IS NULL THEN
    SELECT * INTO existing FROM lead_contact_outcomes WHERE lead_id=p_lead_id AND first_conversation_id=p_conversation_id AND outcome='no_reply';
    RETURN jsonb_build_object('recorded',false,'reason',CASE WHEN existing.superseded_at IS NULL THEN 'no_reply' ELSE 'replied' END,'outcomeId',existing.id);
  END IF;
  RETURN jsonb_build_object('recorded',true,'reason','no_reply','outcomeId',created_id);
END;
$$;

-- The lead row is the serialization point shared with no-reply classification.
CREATE OR REPLACE FUNCTION crm_lock_conversation_lead()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM crm_leads WHERE id=NEW.lead_id FOR UPDATE;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS crm_conversation_lead_lock ON lead_conversations;
CREATE TRIGGER crm_conversation_lead_lock BEFORE INSERT ON lead_conversations
FOR EACH ROW EXECUTE FUNCTION crm_lock_conversation_lead();

CREATE OR REPLACE FUNCTION crm_supersede_no_reply_on_inbound()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE replied BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.messages) message WHERE message->>'direction' IN ('incoming','inbound')
  ) INTO replied;
  IF replied THEN
    UPDATE lead_contact_outcomes outcome SET superseded_at=COALESCE(superseded_at,COALESCE(NEW.occurred_at,NEW.created_at,NOW()))
    FROM lead_first_contacts first_contact
    WHERE outcome.lead_id=NEW.lead_id AND outcome.lead_id=first_contact.lead_id
      AND outcome.first_conversation_id=first_contact.first_conversation_id
      AND outcome.outcome='no_reply' AND outcome.superseded_at IS NULL
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.messages) message
        WHERE message->>'direction' IN ('incoming','inbound')
          AND COALESCE(NULLIF(message->>'timestamp','')::timestamptz,NEW.occurred_at,NEW.created_at,NOW()) >= first_contact.effective_delivered_at);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS crm_conversation_supersede_no_reply ON lead_conversations;
CREATE TRIGGER crm_conversation_supersede_no_reply AFTER INSERT ON lead_conversations
FOR EACH ROW EXECUTE FUNCTION crm_supersede_no_reply_on_inbound();
