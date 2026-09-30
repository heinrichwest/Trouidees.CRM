import json
import os
import sqlite3
import sys
import shutil
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from outbox import Outbox, STATUS_SYNCED, STATUS_RETRY, STATUS_FAILED
from crm_client import CRMAuthError, CRMTransientError
import tools

MESSAGES = [
    {"direction": "inbound", "speaker": "contact", "body": "hi", "timestamp": "unknown", "source_order": 0},
]


class _FakeClient:
    def __init__(self, outcomes):
        self._outcomes = list(outcomes)
        self.calls = []

    def submit_conversation(self, lead_id, segment_id, messages, summary, idempotency_key):
        self.calls.append(
            {
                "lead_id": lead_id,
                "segment_id": segment_id,
                "messages": messages,
                "summary": summary,
                "idempotency_key": idempotency_key,
            }
        )
        outcome = self._outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class SyncRetryTestCase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.outbox = Outbox(os.path.join(self.tmpdir, "outbox.sqlite3"))
        self.segment_id = self.outbox.queue_segment("sess-1", MESSAGES, closed_at="now", reason="close")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)


class PendingSyncsToolTests(SyncRetryTestCase):
    def test_returns_exact_original_messages(self):
        tools._outbox_singleton = self.outbox
        try:
            result = json.loads(tools.crm_pending_syncs({}))
        finally:
            tools._outbox_singleton = None

        self.assertEqual(len(result["segments"]), 1)
        self.assertEqual(result["segments"][0]["messages"], MESSAGES)
        self.assertEqual(result["segments"][0]["segment_id"], self.segment_id)


class CommitSyncTests(SyncRetryTestCase):
    def test_success_marks_synced_with_remote_id(self):
        client = _FakeClient([{"conversationId": "conv-99"}])
        result = json.loads(
            tools.crm_commit_sync(
                {"segment_id": self.segment_id, "lead_id": "lead-1", "summary": "Asked about pricing."},
                client=client,
                outbox=self.outbox,
            )
        )

        self.assertTrue(result["committed"])
        self.assertEqual(result["conversation_id"], "conv-99")
        segment = self.outbox.get_segment(self.segment_id)
        self.assertEqual(segment["status"], STATUS_SYNCED)
        self.assertEqual(segment["remote_conversation_id"], "conv-99")

    def test_success_with_nested_conversation_id_shape_is_persisted_and_returned(self):
        """The real CRM API responds {"conversation": {"id": "..."}}, not a
        top-level conversationId/id. crm_commit_sync must extract the nested
        id, not silently fall back to the segment_id."""
        client = _FakeClient([{"conversation": {"id": "conv-nested-1"}}])
        result = json.loads(
            tools.crm_commit_sync(
                {"segment_id": self.segment_id, "lead_id": "lead-1", "summary": "Asked about pricing."},
                client=client,
                outbox=self.outbox,
            )
        )

        self.assertTrue(result["committed"])
        self.assertEqual(result["conversation_id"], "conv-nested-1")
        segment = self.outbox.get_segment(self.segment_id)
        self.assertEqual(segment["status"], STATUS_SYNCED)
        self.assertEqual(segment["remote_conversation_id"], "conv-nested-1")

    def test_transient_failure_retries_and_keeps_data_queued(self):
        client = _FakeClient([CRMTransientError("503")])
        result = json.loads(
            tools.crm_commit_sync(
                {"segment_id": self.segment_id, "lead_id": "lead-1", "summary": "summary"},
                client=client,
                outbox=self.outbox,
            )
        )

        self.assertFalse(result["committed"])
        self.assertTrue(result["retryable"])
        segment = self.outbox.get_segment(self.segment_id)
        self.assertEqual(segment["status"], STATUS_RETRY)
        self.assertEqual(segment["messages"], MESSAGES)

    def test_auth_failure_marks_failed_not_retried_automatically(self):
        client = _FakeClient([CRMAuthError("401")])
        result = json.loads(
            tools.crm_commit_sync(
                {"segment_id": self.segment_id, "lead_id": "lead-1", "summary": "summary"},
                client=client,
                outbox=self.outbox,
            )
        )

        self.assertFalse(result["committed"])
        self.assertFalse(result["retryable"])
        segment = self.outbox.get_segment(self.segment_id)
        self.assertEqual(segment["status"], STATUS_FAILED)
        self.assertEqual(segment["messages"], MESSAGES)

    def test_replay_after_success_does_not_resubmit_and_returns_same_id(self):
        client = _FakeClient([{"conversationId": "conv-1"}])
        tools.crm_commit_sync(
            {"segment_id": self.segment_id, "lead_id": "lead-1", "summary": "summary"},
            client=client,
            outbox=self.outbox,
        )

        result = json.loads(
            tools.crm_commit_sync(
                {"segment_id": self.segment_id, "lead_id": "lead-1", "summary": "a different summary"},
                client=client,
                outbox=self.outbox,
            )
        )

        self.assertTrue(result["committed"])
        self.assertEqual(result["conversation_id"], "conv-1")
        self.assertEqual(len(client.calls), 1)  # not called again

    def test_retry_then_success_uses_same_idempotency_key(self):
        client = _FakeClient([CRMTransientError("timeout"), {"conversationId": "conv-7"}])

        tools.crm_commit_sync(
            {"segment_id": self.segment_id, "lead_id": "lead-1", "summary": "summary"},
            client=client,
            outbox=self.outbox,
        )
        result = json.loads(
            tools.crm_commit_sync(
                {"segment_id": self.segment_id, "lead_id": "lead-1", "summary": "summary"},
                client=client,
                outbox=self.outbox,
            )
        )

        self.assertTrue(result["committed"])
        self.assertEqual(client.calls[0]["idempotency_key"], client.calls[1]["idempotency_key"])
        self.assertEqual(client.calls[0]["idempotency_key"], self.segment_id)

    def test_unknown_segment_id_returns_error(self):
        client = _FakeClient([])
        result = json.loads(
            tools.crm_commit_sync(
                {"segment_id": "does-not-exist", "lead_id": "lead-1", "summary": "summary"},
                client=client,
                outbox=self.outbox,
            )
        )
        self.assertFalse(result["committed"])
        self.assertIn("error", result)

    def test_missing_required_fields_returns_error_without_touching_outbox(self):
        result = json.loads(tools.crm_commit_sync({"segment_id": self.segment_id}, outbox=self.outbox))
        self.assertFalse(result["committed"])
        segment = self.outbox.get_segment(self.segment_id)
        self.assertEqual(segment["status"], "pending")


class BoundPayloadRetryTests(SyncRetryTestCase):
    """A retry (after a transient failure or a timeout) can be given a
    different lead_id/summary than the first attempt — the LLM may
    regenerate the summary, or pick a different lead. Every retry must
    submit the exact lead_id/summary bound on the first attempt for this
    segment, never what a later call happens to pass in."""

    def test_retry_with_different_lead_and_summary_submits_the_original_bound_values(self):
        client = _FakeClient([CRMTransientError("timeout"), {"conversationId": "conv-1"}])

        tools.crm_commit_sync(
            {"segment_id": self.segment_id, "lead_id": "lead-A", "summary": "original summary"},
            client=client,
            outbox=self.outbox,
        )
        result = json.loads(
            tools.crm_commit_sync(
                {"segment_id": self.segment_id, "lead_id": "lead-B", "summary": "a regenerated, different summary"},
                client=client,
                outbox=self.outbox,
            )
        )

        self.assertTrue(result["committed"])
        self.assertEqual(len(client.calls), 2)
        for call in client.calls:
            self.assertEqual(call["lead_id"], "lead-A")
            self.assertEqual(call["summary"], "original summary")

        segment = self.outbox.get_segment(self.segment_id)
        self.assertEqual(segment["lead_id"], "lead-A")
        self.assertEqual(segment["summary"], "original summary")

    def test_timeout_after_server_acceptance_then_replay_is_byte_identical_and_does_not_duplicate(self):
        """Simulates a network timeout on the first attempt where the CRM may
        have already committed the write server-side. The retry must submit
        the exact same lead_id/summary/messages/idempotency_key as the first
        attempt even though *this* call is given different arguments, so the
        CRM's same-idempotency-key handling sees a byte-identical replay
        (safe to treat as already-applied) instead of a conflicting payload
        (409) or, worse, a write landing on a different lead."""
        client = _FakeClient(
            [CRMTransientError("timed out waiting for response"), {"conversationId": "conv-accepted"}]
        )

        first = json.loads(
            tools.crm_commit_sync(
                {"segment_id": self.segment_id, "lead_id": "lead-A", "summary": "first summary"},
                client=client,
                outbox=self.outbox,
            )
        )
        self.assertFalse(first["committed"])
        self.assertTrue(first["retryable"])

        second = json.loads(
            tools.crm_commit_sync(
                {"segment_id": self.segment_id, "lead_id": "lead-Z", "summary": "different summary entirely"},
                client=client,
                outbox=self.outbox,
            )
        )

        self.assertTrue(second["committed"])
        self.assertEqual(second["conversation_id"], "conv-accepted")

        first_call, second_call = client.calls
        self.assertEqual(first_call["lead_id"], second_call["lead_id"])
        self.assertEqual(first_call["summary"], second_call["summary"])
        self.assertEqual(first_call["messages"], second_call["messages"])
        self.assertEqual(first_call["idempotency_key"], second_call["idempotency_key"])
        self.assertEqual(first_call["lead_id"], "lead-A")
        self.assertEqual(first_call["summary"], "first summary")

        # Exactly one segment for this session/transcript — no duplicate.
        self.assertEqual(len(self.outbox.list_pending(limit=100)), 0)
        synced = self.outbox.get_segment(self.segment_id)
        self.assertEqual(synced["status"], STATUS_SYNCED)
        self.assertEqual(synced["remote_conversation_id"], "conv-accepted")
        self.assertEqual(synced["lead_id"], "lead-A")
        self.assertEqual(synced["summary"], "first summary")

    def test_legacy_retry_without_saved_binding_is_quarantined_before_network(self):
        # Simulate a row from the pre-binding outbox: it already had a
        # transient attempt, but its original lead and summary were not saved.
        with sqlite3.connect(self.outbox.db_path) as conn:
            conn.execute(
                "UPDATE segments SET status = ?, attempts = 1, last_error = ? WHERE segment_id = ?",
                (STATUS_RETRY, "timeout", self.segment_id),
            )

        client = _FakeClient([])
        result = json.loads(
            tools.crm_commit_sync(
                {"segment_id": self.segment_id, "lead_id": "new-lead", "summary": "new summary"},
                client=client,
                outbox=self.outbox,
            )
        )

        self.assertFalse(result["committed"])
        self.assertFalse(result["retryable"])
        self.assertIn("reconciliation", result["error"].lower())
        self.assertEqual(client.calls, [])
        segment = self.outbox.get_segment(self.segment_id)
        self.assertEqual(segment["status"], STATUS_FAILED)
        self.assertIsNone(segment["lead_id"])
        self.assertIsNone(segment["summary"])


if __name__ == "__main__":
    unittest.main()

