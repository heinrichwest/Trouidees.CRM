import io
import json
import os
import sys
import unittest
import urllib.error
import urllib.request
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from crm_client import (
    CRMClient,
    CRMAuthError,
    CRMValidationError,
    CRMTransientError,
)

MESSAGES = [
    {"direction": "inbound", "speaker": "contact", "body": "hi", "timestamp": "2026-09-29T10:00:00Z"},
    {"direction": "outbound", "speaker": "andrew", "body": "hello", "timestamp": "unknown"},
]


class _FakeResponse:
    def __init__(self, body: dict):
        self._body = json.dumps(body).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class SubmitConversationTests(unittest.TestCase):
    def test_sends_bearer_header_and_expected_json_shape(self):
        client = CRMClient("https://crm.example.com", "secret-key", timeout_seconds=5)
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["request"] = request
            captured["timeout"] = timeout
            return _FakeResponse({"conversationId": "conv-1"})

        with mock.patch.object(urllib.request, "urlopen", fake_urlopen):
            result = client.submit_conversation(
                lead_id="lead-42",
                segment_id="seg-1",
                messages=MESSAGES,
                summary="Contact asked about pricing; Andrew replied with a quote.",
                idempotency_key="seg-1",
            )

        self.assertEqual(result, {"conversationId": "conv-1"})
        request = captured["request"]
        self.assertEqual(request.get_header("Authorization"), "Bearer secret-key")
        self.assertTrue(request.full_url.endswith("/api/agent/leads/lead-42/conversations"))
        self.assertEqual(captured["timeout"], 5)

        body = json.loads(request.data.decode("utf-8"))
        self.assertEqual(body["segmentId"], "seg-1")
        self.assertEqual(body["channel"], "whatsapp")
        self.assertEqual(body["idempotencyKey"], "seg-1")
        self.assertEqual(
            body["messages"],
            [
                {"direction": "incoming", "speaker": "contact", "body": "hi", "timestamp": "2026-09-29T10:00:00Z"},
                {"direction": "outgoing", "speaker": "andrew", "body": "hello", "timestamp": None},
            ],
        )
        self.assertIn("summary", body)

    def test_wire_payload_matches_crm_contract_exactly_and_preserves_body_and_order(self):
        """lib/agent-api.mjs requires direction in {"incoming","outgoing"},
        speaker in {"contact","andrew"}, and timestamp as a valid ISO string
        or null. The extractor's internal shape uses "inbound"/"outbound" and
        the sentinel "unknown"; this test locks in the exact translation."""
        client = CRMClient("https://crm.example.com", "secret-key")
        internal_messages = [
            {"direction": "inbound", "speaker": "contact", "body": "First: is this still available?", "timestamp": "2026-09-29T10:00:00+00:00", "source_order": 0},
            {"direction": "outbound", "speaker": "andrew", "body": "Yes, still available!", "timestamp": "unknown", "source_order": 1},
            {"direction": "inbound", "speaker": "contact", "body": "Great, multiline:\nLine two – café ☃️", "timestamp": None, "source_order": 2},
            {"direction": "outbound", "speaker": "andrew", "body": "Sounds good.", "timestamp": "2026-09-29T10:05:30.123456+00:00", "source_order": 3},
        ]
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["request"] = request
            return _FakeResponse({"conversationId": "conv-exact"})

        with mock.patch.object(urllib.request, "urlopen", fake_urlopen):
            client.submit_conversation(
                lead_id="lead-1",
                segment_id="seg-exact",
                messages=internal_messages,
                summary="Contact confirmed availability and pricing.",
                idempotency_key="seg-exact",
            )

        body = json.loads(captured["request"].data.decode("utf-8"))
        self.assertEqual(
            body["messages"],
            [
                {
                    "direction": "incoming",
                    "speaker": "contact",
                    "body": "First: is this still available?",
                    "timestamp": "2026-09-29T10:00:00+00:00",
                },
                {
                    "direction": "outgoing",
                    "speaker": "andrew",
                    "body": "Yes, still available!",
                    "timestamp": None,
                },
                {
                    "direction": "incoming",
                    "speaker": "contact",
                    "body": "Great, multiline:\nLine two – café ☃️",
                    "timestamp": None,
                },
                {
                    "direction": "outgoing",
                    "speaker": "andrew",
                    "body": "Sounds good.",
                    "timestamp": "2026-09-29T10:05:30.123456+00:00",
                },
            ],
        )
        # Every direction/speaker value is one the CRM's strict validator accepts.
        for message in body["messages"]:
            self.assertIn(message["direction"], ("incoming", "outgoing"))
            self.assertIn(message["speaker"], ("contact", "andrew"))
            self.assertTrue(message["timestamp"] is None or isinstance(message["timestamp"], str))

    def test_unknown_direction_raises_instead_of_sending_bad_payload(self):
        client = CRMClient("https://crm.example.com", "secret-key")
        bad_messages = [{"direction": "sideways", "speaker": "contact", "body": "hi", "timestamp": None}]

        def fake_urlopen(request, timeout=None):
            self.fail("must not send a request with an unrecognized direction")

        with mock.patch.object(urllib.request, "urlopen", fake_urlopen):
            with self.assertRaises(ValueError):
                client.submit_conversation("lead-1", "seg-1", bad_messages, "summary", "seg-1")

    def test_401_raises_auth_error(self):
        client = CRMClient("https://crm.example.com", "bad-key")

        def fake_urlopen(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, io.BytesIO(b""))

        with mock.patch.object(urllib.request, "urlopen", fake_urlopen):
            with self.assertRaises(CRMAuthError):
                client.submit_conversation("lead-1", "seg-1", MESSAGES, "summary", "seg-1")

    def test_400_raises_validation_error(self):
        client = CRMClient("https://crm.example.com", "key")

        def fake_urlopen(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, 400, "Bad Request", {}, io.BytesIO(b""))

        with mock.patch.object(urllib.request, "urlopen", fake_urlopen):
            with self.assertRaises(CRMValidationError):
                client.submit_conversation("lead-1", "seg-1", MESSAGES, "summary", "seg-1")

    def test_500_raises_transient_error(self):
        client = CRMClient("https://crm.example.com", "key")

        def fake_urlopen(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, 503, "Service Unavailable", {}, io.BytesIO(b""))

        with mock.patch.object(urllib.request, "urlopen", fake_urlopen):
            with self.assertRaises(CRMTransientError):
                client.submit_conversation("lead-1", "seg-1", MESSAGES, "summary", "seg-1")

    def test_network_error_raises_transient_error(self):
        client = CRMClient("https://crm.example.com", "key")

        def fake_urlopen(request, timeout=None):
            raise urllib.error.URLError("connection refused")

        with mock.patch.object(urllib.request, "urlopen", fake_urlopen):
            with self.assertRaises(CRMTransientError):
                client.submit_conversation("lead-1", "seg-1", MESSAGES, "summary", "seg-1")

    def test_timeout_raises_transient_error(self):
        client = CRMClient("https://crm.example.com", "key", timeout_seconds=1)

        def fake_urlopen(request, timeout=None):
            raise TimeoutError("timed out")

        with mock.patch.object(urllib.request, "urlopen", fake_urlopen):
            with self.assertRaises(CRMTransientError):
                client.submit_conversation("lead-1", "seg-1", MESSAGES, "summary", "seg-1")

    def test_error_messages_never_contain_api_key(self):
        client = CRMClient("https://crm.example.com", "sk-top-secret")

        def fake_urlopen(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, io.BytesIO(b""))

        with mock.patch.object(urllib.request, "urlopen", fake_urlopen):
            try:
                client.submit_conversation("lead-1", "seg-1", MESSAGES, "summary", "seg-1")
            except CRMAuthError as exc:
                self.assertNotIn("sk-top-secret", str(exc))


if __name__ == "__main__":
    unittest.main()
