"""Behavior tests for the user-facing CRM tools."""

import json
import os
import sys
import unittest
from unittest import mock

PLUGIN_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, PLUGIN_DIR)
import tools


class FakeCRM:
    def __init__(self):
        self.calls = []

    def search_leads(self, query="", lead_type=None, status=None, limit=25, cursor="0"):
        self.calls.append(("search_leads", query, lead_type, status, limit, cursor))
        return {"ambiguous": True, "candidates": ["lead-1", "lead-2"], "leads": [], "nextCursor": None}

    def get_lead(self, lead_id):
        self.calls.append(("get_lead", lead_id))
        return {"lead": {"id": lead_id, "name": "One", "phone": "0821234567"}}

    def list_conversations(self, lead_id):
        self.calls.append(("list_conversations", lead_id))
        return {"conversations": [{"id": "conv-1", "messages": [{"body": "Original message"}], "summary": "Conversation summary"}]}

    def assign_self(self, lead_id):
        self.calls.append(("assign_self", lead_id))
        return {"lead": {"id": lead_id, "assignedTo": "Andrew"}}

    def add_note(self, lead_id, body):
        self.calls.append(("add_note", lead_id, body))
        return {"note": {"id": "note-1", "body": body}}

    def update_lead(self, lead_id, fields):
        self.calls.append(("update_lead", lead_id, fields))
        return {"lead": {"id": lead_id, **fields}}


def result_json(value):
    return json.loads(value)


class CRMLeadToolTests(unittest.TestCase):
    def setUp(self):
        self.client = FakeCRM()

    def test_search_preserves_phone_ambiguity_and_does_not_select_a_candidate(self):
        with mock.patch.object(tools, "_build_client", return_value=self.client):
            result = result_json(tools.crm_search_leads({"query": "0821234567"}))
        self.assertEqual(result["candidates"], ["lead-1", "lead-2"])
        self.assertEqual(result["leads"], [])
        self.assertTrue(result["ambiguous"])
        self.assertEqual(self.client.calls, [("search_leads", "0821234567", None, None, 25, "0")])

    def test_search_validates_query_and_bounds_limit(self):
        with mock.patch.object(tools, "_build_client", return_value=self.client):
            invalid = result_json(tools.crm_search_leads({"query": "", "limit": 5000}))
        self.assertIn("limit", invalid["error"])
        self.assertEqual(self.client.calls, [])

    def test_get_lead_requires_id_and_returns_contact_details(self):
        with mock.patch.object(tools, "_build_client", return_value=self.client):
            missing = result_json(tools.crm_get_lead({}))
            result = result_json(tools.crm_get_lead({"lead_id": "lead-1"}))
        self.assertIn("lead_id", missing["error"])
        self.assertEqual(result["lead"]["phone"], "0821234567")
        self.assertEqual(self.client.calls, [("get_lead", "lead-1")])

    def test_get_conversations_requires_id_and_returns_history_verbatim(self):
        expected = {"conversations": [{"id": "conv-1", "messages": [{"body": "Original message"}], "summary": "Conversation summary"}]}
        with mock.patch.object(tools, "_build_client", return_value=self.client):
            missing = result_json(tools.crm_get_conversations({}))
            result = result_json(tools.crm_get_conversations({"lead_id": "lead-1"}))
        self.assertIn("lead_id", missing["error"])
        self.assertEqual(result, expected)
        self.assertEqual(self.client.calls, [("list_conversations", "lead-1")])

    def test_assign_self_calls_only_the_self_assignment_endpoint(self):
        with mock.patch.object(tools, "_build_client", return_value=self.client):
            result = result_json(tools.crm_assign_self({"lead_id": "lead-1"}))
        self.assertEqual(result["lead"]["assignedTo"], "Andrew")
        self.assertEqual(self.client.calls, [("assign_self", "lead-1")])

    def test_add_note_requires_nonempty_body_and_records_internal_note(self):
        with mock.patch.object(tools, "_build_client", return_value=self.client):
            missing = result_json(tools.crm_add_note({"lead_id": "lead-1", "body": "  "}))
            result = result_json(tools.crm_add_note({"lead_id": "lead-1", "body": "Call back Friday"}))
        self.assertIn("body", missing["error"])
        self.assertEqual(result["note"]["body"], "Call back Friday")
        self.assertEqual(self.client.calls, [("add_note", "lead-1", "Call back Friday")])

    def test_update_lead_accepts_crm_fields_and_rejects_assignment_or_comments(self):
        fields = {"status": "Contacted", "feedback": "Asked for pricing"}
        with mock.patch.object(tools, "_build_client", return_value=self.client):
            result = result_json(tools.crm_update_lead({"lead_id": "lead-1", "fields": fields}))
            forbidden = result_json(tools.crm_update_lead({"lead_id": "lead-1", "fields": {"assignedTo": "Andrew"}}))
            unsupported = result_json(tools.crm_update_lead({"lead_id": "lead-1", "fields": {"comments": "note"}}))
        self.assertEqual(result["lead"]["feedback"], "Asked for pricing")
        self.assertIn("Unsupported", forbidden["error"])
        self.assertIn("Unsupported", unsupported["error"])
        self.assertEqual(self.client.calls, [("update_lead", "lead-1", fields)])

    def test_unexpected_client_errors_are_json_safe_and_do_not_echo_secrets_or_bodies(self):
        self.client.search_leads = mock.Mock(side_effect=RuntimeError("Bearer private-key customer-message"))
        with mock.patch.object(tools, "_build_client", return_value=self.client):
            result = result_json(tools.crm_search_leads({"query": "Smith"}))
        self.assertIn("error", result)
        self.assertNotIn("private-key", json.dumps(result))
        self.assertNotIn("customer-message", json.dumps(result))


if __name__ == "__main__":
    unittest.main()

