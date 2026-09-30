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


class LeadOperationsTests(unittest.TestCase):
    def setUp(self):
        self.client = CRMClient("https://crm.example.com", "agent-secret", timeout_seconds=4)
        self.requests = []

    def _respond(self, response):
        def fake_urlopen(request, timeout=None):
            self.requests.append((request, timeout))
            return _FakeResponse(response)
        return fake_urlopen

    def test_search_leads_uses_bounded_query_and_returns_contact_details(self):
        expected = {"leads": [{"id": "lead-1", "name": "Example", "phone": "+27821234567", "email": "a@example.test"}], "nextCursor": None}
        with mock.patch.object(urllib.request, "urlopen", self._respond(expected)):
            result = self.client.search_leads(query="082 123 4567", lead_type="Tutor", status="New", limit=10, cursor="0")
        request, timeout = self.requests[0]
        self.assertEqual(result, expected)
        self.assertTrue(request.full_url.endswith("/api/agent/leads?q=082+123+4567&leadType=Tutor&status=New&limit=10&cursor=0"))
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.get_header("Authorization"), "Bearer agent-secret")
        self.assertEqual(timeout, 4)

    def test_get_lead_encodes_id_and_returns_single_lead_dto(self):
        expected = {"lead": {"id": "lead-1", "phone": "+27821234567", "assignedTo": "Andrew"}}
        with mock.patch.object(urllib.request, "urlopen", self._respond(expected)):
            result = self.client.get_lead("lead/1")
        request, _ = self.requests[0]
        self.assertEqual(result, expected)
        self.assertTrue(request.full_url.endswith("/api/agent/leads/lead%2F1"))

    def test_assign_note_and_limited_update_use_the_approved_endpoints(self):
        responses = iter([
            {"lead": {"id": "lead-1", "assignedTo": "Andrew"}},
            {"note": {"id": "note-1", "body": "Call back Friday"}},
            {"lead": {"id": "lead-1", "status": "Contacted", "feedback": "Asked for pricing"}},
        ])
        with mock.patch.object(urllib.request, "urlopen", lambda request, timeout=None: (self.requests.append((request, timeout)) or _FakeResponse(next(responses)))):
            self.assertEqual(self.client.assign_self("lead-1")["lead"]["assignedTo"], "Andrew")
            self.assertEqual(self.client.add_note("lead-1", "Call back Friday")["note"]["body"], "Call back Friday")
            self.assertEqual(self.client.update_lead("lead-1", {"status": "Contacted", "feedback": "Asked for pricing", "comments": "Send the service list tomorrow"})["lead"]["status"], "Contacted")
        self.assertEqual([r.get_method() for r, _ in self.requests], ["POST", "POST", "PATCH"])
        self.assertTrue(self.requests[0][0].full_url.endswith("/api/agent/leads/lead-1/assign-self"))
        self.assertTrue(self.requests[1][0].full_url.endswith("/api/agent/leads/lead-1/notes"))
        self.assertTrue(self.requests[2][0].full_url.endswith("/api/agent/leads/lead-1"))
        self.assertEqual(json.loads(self.requests[1][0].data), {"body": "Call back Friday"})
        self.assertEqual(json.loads(self.requests[2][0].data), {"status": "Contacted", "feedback": "Asked for pricing", "comments": "Send the service list tomorrow"})

    def test_update_rejects_fields_outside_the_crm_allow_list_before_network(self):
        with mock.patch.object(urllib.request, "urlopen", self._respond({})):
            with self.assertRaises(ValueError):
                self.client.update_lead("lead-1", {"assignedTo": "Someone else"})
        self.assertEqual(self.requests, [])

    def test_update_rejects_any_owner_or_assignment_field_before_network(self):
        for forbidden_patch in (
            {"owner": "Andrew"},
            {"ownerId": "andrew-1"},
            {"assignedTo": "Andrew"},
        ):
            with mock.patch.object(urllib.request, "urlopen", self._respond({})):
                with self.assertRaises(ValueError):
                    self.client.update_lead("lead-1", forbidden_patch)
        self.assertEqual(self.requests, [])

    def test_update_rejects_doNotContact_false_even_though_the_key_itself_is_allowed(self):
        """lib/agent-store.mjs: DNC_CLEAR_FORBIDDEN — only a human admin may clear
        DNC. doNotContact is otherwise an allowed field, so this must be rejected
        by value, not just by key."""
        with mock.patch.object(urllib.request, "urlopen", self._respond({})):
            with self.assertRaises(ValueError):
                self.client.update_lead("lead-1", {"doNotContact": False})
        self.assertEqual(self.requests, [])

    def test_update_allows_setting_dnc_true_with_reason_and_wording(self):
        expected = {"lead": {"id": "lead-1", "doNotContact": True}}
        with mock.patch.object(urllib.request, "urlopen", self._respond(expected)):
            result = self.client.update_lead(
                "lead-1",
                {
                    "doNotContact": True,
                    "dncReason": "Contact asked not to be called again",
                    "dncWording": "Please stop contacting me",
                },
            )
        self.assertEqual(result, expected)
        request, _ = self.requests[0]
        self.assertEqual(request.get_method(), "PATCH")
        self.assertEqual(
            json.loads(request.data),
            {
                "doNotContact": True,
                "dncReason": "Contact asked not to be called again",
                "dncWording": "Please stop contacting me",
            },
        )

    def test_update_allows_follow_up_and_contact_timestamp_fields(self):
        expected = {"lead": {"id": "lead-1", "nextFollowUpAt": "2026-10-01"}}
        with mock.patch.object(urllib.request, "urlopen", self._respond(expected)):
            result = self.client.update_lead(
                "lead-1",
                {"nextFollowUpAt": "2026-10-01", "lastContactedAt": "2026-09-30"},
            )
        self.assertEqual(result, expected)

    def test_search_leads_percent_encodes_reserved_characters_in_query(self):
        expected = {"leads": [], "nextCursor": None}
        with mock.patch.object(urllib.request, "urlopen", self._respond(expected)):
            self.client.search_leads(query="Smith & Sons / Co?")
        request, _ = self.requests[0]
        self.assertTrue(
            request.full_url.endswith("/api/agent/leads?q=Smith+%26+Sons+%2F+Co%3F")
        )

    def test_search_leads_omits_absent_optional_filters(self):
        expected = {"leads": [], "nextCursor": None}
        with mock.patch.object(urllib.request, "urlopen", self._respond(expected)):
            self.client.search_leads(query="Jane")
        request, _ = self.requests[0]
        self.assertTrue(request.full_url.endswith("/api/agent/leads?q=Jane"))

    def test_search_leads_401_raises_auth_error(self):
        def fake_urlopen(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, io.BytesIO(b""))

        with mock.patch.object(urllib.request, "urlopen", fake_urlopen):
            with self.assertRaises(CRMAuthError):
                self.client.search_leads(query="Jane")

    def test_list_conversations_encodes_id_bearer_auth_and_returns_json(self):
        expected = {
            "conversations": [
                {"segmentId": "seg-1", "channel": "whatsapp", "summary": "Asked about pricing."}
            ]
        }
        with mock.patch.object(urllib.request, "urlopen", self._respond(expected)):
            result = self.client.list_conversations("lead/1")
        request, _ = self.requests[0]
        self.assertEqual(result, expected)
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(request.get_header("Authorization"), "Bearer agent-secret")
        self.assertTrue(request.full_url.endswith("/api/agent/leads/lead%2F1/conversations"))

    def test_list_conversations_401_raises_auth_error(self):
        def fake_urlopen(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, 401, "Unauthorized", {}, io.BytesIO(b""))

        with mock.patch.object(urllib.request, "urlopen", fake_urlopen):
            with self.assertRaises(CRMAuthError):
                self.client.list_conversations("lead-1")

    def test_list_conversations_404_raises_validation_error(self):
        def fake_urlopen(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, 404, "Not Found", {}, io.BytesIO(b""))

        with mock.patch.object(urllib.request, "urlopen", fake_urlopen):
            with self.assertRaises(CRMValidationError):
                self.client.list_conversations("lead-1")


if __name__ == "__main__":
    unittest.main()

