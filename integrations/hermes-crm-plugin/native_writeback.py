"""Apply only confirmed, rendered native delivery outcomes to hosted CRM."""

from __future__ import annotations

import hashlib
import json
from typing import Optional

try:
    from .crm_client import CRMClient
    from .native_delivery_state import NativeDeliveryState
except ImportError:
    from crm_client import CRMClient
    from native_delivery_state import NativeDeliveryState


_IGNORED = {"held", "approved", "scheduled", "accepted", "rejected", "failed", "unknown", "uncertain"}


class NativeWriteback:
    def __init__(self, client: CRMClient, state: NativeDeliveryState, namespace: str, account: str, speaker: str):
        if not all(isinstance(value, str) and value.strip() for value in (namespace, account, speaker)):
            raise ValueError("namespace, account and speaker must be configured")
        self.client, self.state = client, state
        self.namespace, self.account, self.speaker = namespace, account, speaker

    def apply(self, event: dict, binding: Optional[dict] = None) -> dict:
        if not isinstance(event, dict):
            raise ValueError("native outcome must be an object")
        if event.get("state") != "delivered":
            if event.get("state") in _IGNORED or event.get("state") is None:
                return {"applied": False, "ignored": True, "segmentId": None}
            return {"applied": False, "ignored": True, "segmentId": None}
        outbox_id = event.get("outbox_id")
        text = event.get("text")
        if not isinstance(outbox_id, str) or not outbox_id.strip() or not isinstance(text, str):
            raise ValueError("delivered outcome requires outbox_id and exact rendered text")
        if "job" in event and isinstance(event["job"], dict):
            job_lead = event["job"].get("lead_id")
        else:
            job_lead = event.get("lead_id")
        if binding is not None and not isinstance(binding, dict):
            raise ValueError("binding must be an object")
        lead_id = binding.get("lead_id") if binding else None
        claim_id = binding.get("claim_id") if binding else None
        if lead_id and job_lead and lead_id != job_lead:
            raise ValueError("delivered outcome lead conflicts with its durable binding")
        if not lead_id:
            if job_lead:
                lead_id = job_lead
            else:
                contact = event.get("contact") or event.get("recipient")
                if not isinstance(contact, str) or not contact.strip():
                    raise ValueError("delivered outcome has no retained lead or exact contact")
                resolved = self.client.resolve_contact(contact)
                if resolved.get("matchCount") != 1 or not resolved.get("leadId"):
                    raise ValueError("contact does not resolve to exactly one visible CRM lead")
                lead_id = resolved["leadId"]

        digest_input = json.dumps([self.namespace, self.account, outbox_id], ensure_ascii=False, separators=(",", ":"))
        digest = hashlib.sha256(digest_input.encode("utf-8")).hexdigest()
        segment_id = "native-whatsapp:v1:" + digest
        payload = {
            "lead_id": lead_id,
            "claim_id": claim_id,
            "channel": "whatsapp",
            "summary": "WhatsApp message delivered",
            "body": text,
            "speaker": self.speaker,
            "timestamp": None,
            "source_occurred_at": None,
            "segment_id": segment_id,
            "idempotency_key": segment_id,
        }
        frozen = self.state.bind(segment_id, payload)
        messages = [{"direction": "outbound", "speaker": frozen["speaker"], "body": frozen["body"], "timestamp": frozen["timestamp"]}]
        response = self.client.submit_conversation(
            frozen["lead_id"], frozen["segment_id"], messages, frozen["summary"], frozen["idempotency_key"],
            occurred_at=frozen["source_occurred_at"], native_delivery={"state": "delivered", "claimId": frozen["claim_id"]},
        )
        conversation = response.get("conversation") if isinstance(response, dict) else None
        conversation_id = (conversation or {}).get("id") if isinstance(conversation, dict) else None
        conversation_id = conversation_id or (response.get("conversationId") if isinstance(response, dict) else None)
        if not conversation_id:
            raise ValueError("CRM response omitted the persisted conversation ID")
        self.client.finalize_delivery(frozen["lead_id"], conversation_id)
        self.state.mark_applied(segment_id, conversation_id)
        return {"applied": True, "ignored": False, "segmentId": segment_id}
