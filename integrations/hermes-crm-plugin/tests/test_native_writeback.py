import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from native_delivery_state import NativeDeliveryState
from native_writeback import NativeWriteback


class FakeClient:
    def __init__(self, resolve=None, fail_at=None):
        self.resolve = resolve or {"matchCount": 1, "leadId": "lead-1"}
        self.fail_at = fail_at
        self.calls = []
        self.payloads = []

    def resolve_contact(self, contact):
        self.calls.append("resolve")
        return self.resolve

    def submit_conversation(self, lead_id, segment_id, messages, summary, idempotency_key, **kwargs):
        self.calls.append("conversation")
        self.payloads.append((lead_id, segment_id, messages, summary, idempotency_key, kwargs))
        if self.fail_at == "conversation":
            raise TimeoutError("safe timeout")
        return {"conversationId": "conversation-1"}

    def finalize_delivery(self, lead_id, conversation_id):
        self.calls.append("finalize")
        if self.fail_at == "finalize":
            raise TimeoutError("safe timeout")
        return {"updated": True}


def event(state="delivered"):
    return {
        "id": "event-1",
        "outbox_id": "outbox-1",
        "state": state,
        "text": "  Hello 🛰️\n",
        "request_id": "request-1",
        "job_id": "job-1",
        "contact": "+27820000000",
    }


class NativeWritebackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = NativeDeliveryState(os.path.join(self.tmp.name, "delivery.sqlite3"))

    def tearDown(self):
        self.tmp.cleanup()

    def adapter(self, client):
        return NativeWriteback(client, self.state, "namespace", "account", "Agent A")

    def test_delivered_text_is_verbatim_and_replay_is_frozen(self):
        client = FakeClient()
        writer = self.adapter(client)
        result = writer.apply(event(), {"lead_id": "lead-1", "claim_id": "223e4567-e89b-42d3-a456-426614174000"})
        self.assertTrue(result["applied"])
        saved = client.payloads[0][2][0]
        self.assertEqual(saved["body"], "  Hello 🛰️\n")
        self.assertIsNone(saved["timestamp"])
        self.assertEqual(client.calls, ["conversation", "finalize"])
        first_payload = client.payloads[0]
        restarted = NativeDeliveryState(os.path.join(self.tmp.name, "delivery.sqlite3"))
        replay = NativeWriteback(client, restarted, "namespace", "account", "Agent A")
        replay.apply(event(), {"lead_id": "lead-1", "claim_id": "223e4567-e89b-42d3-a456-426614174000"})
        self.assertEqual(client.payloads[1], first_payload)

    def test_partial_write_repairs_after_process_restart(self):
        path = os.path.join(self.tmp.name, "delivery.sqlite3")
        failing = FakeClient(fail_at="finalize")
        with self.assertRaises(TimeoutError):
            NativeWriteback(failing, self.state, "namespace", "account", "Agent A").apply(event(), {"lead_id": "lead-1"})
        retry_client = FakeClient()
        result = NativeWriteback(retry_client, NativeDeliveryState(path), "namespace", "account", "Agent A").apply(event(), {"lead_id": "lead-1"})
        self.assertTrue(result["applied"])
        self.assertEqual(retry_client.calls, ["conversation", "finalize"])

    def test_all_non_delivered_states_write_nothing(self):
        for state in ("held", "approved", "scheduled", "accepted", "rejected", "failed", "unknown", "uncertain"):
            client = FakeClient()
            result = self.adapter(client).apply(event(state))
            self.assertEqual(result, {"applied": False, "ignored": True, "segmentId": None})
            self.assertEqual(client.calls, [])

    def test_ambiguous_or_foreign_lead_blocks_apply(self):
        for resolution in ({"matchCount": 2}, {"matchCount": 0}, {"matchCount": 1}):
            client = FakeClient(resolve=resolution)
            with self.assertRaises(ValueError):
                self.adapter(client).apply(event())
            self.assertNotIn("conversation", client.calls)
        client = FakeClient()
        foreign = event()
        foreign["job"] = {"lead_id": "lead-2"}
        with self.assertRaises(ValueError):
            self.adapter(client).apply(foreign, {"lead_id": "lead-1"})
        self.assertNotIn("conversation", client.calls)

    def test_reused_outbox_cannot_change_lead_or_body(self):
        client = FakeClient()
        writer = self.adapter(client)
        writer.apply(event(), {"lead_id": "lead-1"})
        changed = event()
        changed["text"] = "different"
        with self.assertRaises(ValueError):
            writer.apply(changed, {"lead_id": "lead-1"})


if __name__ == "__main__":
    unittest.main()
