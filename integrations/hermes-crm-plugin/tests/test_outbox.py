import json
import os
import sqlite3
import sys
import tempfile
import shutil
import threading
import unittest
from unittest import mock
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from outbox import Outbox, STATUS_PENDING, STATUS_SYNCING, STATUS_SYNCED, STATUS_RETRY, STATUS_FAILED
import outbox


SAMPLE_MESSAGES = [
    {"direction": "inbound", "speaker": "contact", "body": "Hi there", "timestamp": "2026-09-29T10:00:00Z", "source_order": 0},
    {"direction": "outbound", "speaker": "andrew", "body": "Hello! How can I help?", "timestamp": "unknown", "source_order": 1},
]


class OutboxTestCase(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmpdir, "outbox.sqlite3")

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)


class WalModeRetryTests(unittest.TestCase):
    def test_retries_transient_locked_error_while_enabling_wal(self):
        class BusyOnceConnection:
            row_factory = None

            def __init__(self):
                self.execute_calls = 0

            def execute(self, sql):
                self.execute_calls += 1
                if sql == "PRAGMA journal_mode=WAL" and self.execute_calls == 1:
                    raise sqlite3.OperationalError("database is locked")
                return None

        connection = BusyOnceConnection()
        instance = object.__new__(Outbox)
        instance.db_path = "unused.sqlite3"
        with mock.patch("outbox.sqlite3.connect", return_value=connection), \
                mock.patch("outbox.time.sleep") as sleep:
            result = instance._connect()

        self.assertIs(result, connection)
        self.assertEqual(connection.execute_calls, 2)
        sleep.assert_called_once()


class QueueSegmentTests(OutboxTestCase):
    def test_queue_then_reopen_persists_segment(self):
        outbox = Outbox(self.db_path)
        segment_id = outbox.queue_segment("sess-1", SAMPLE_MESSAGES, closed_at="2026-09-29T10:05:00Z", reason="close")

        reopened = Outbox(self.db_path)
        segment = reopened.get_segment(segment_id)
        self.assertIsNotNone(segment)
        self.assertEqual(segment["session_id"], "sess-1")
        self.assertEqual(segment["messages"], SAMPLE_MESSAGES)
        self.assertEqual(segment["status"], STATUS_PENDING)

    def test_duplicate_queue_same_messages_is_idempotent(self):
        outbox = Outbox(self.db_path)
        id_a = outbox.queue_segment("sess-1", SAMPLE_MESSAGES, closed_at="2026-09-29T10:05:00Z", reason="close")
        id_b = outbox.queue_segment("sess-1", SAMPLE_MESSAGES, closed_at="2026-09-29T10:05:00Z", reason="idle")

        self.assertEqual(id_a, id_b)
        self.assertEqual(len(outbox.list_pending(limit=100)), 1)

    def test_later_message_produces_new_segment(self):
        outbox = Outbox(self.db_path)
        id_a = outbox.queue_segment("sess-1", SAMPLE_MESSAGES, closed_at="2026-09-29T10:05:00Z", reason="close")

        extended = SAMPLE_MESSAGES + [
            {"direction": "inbound", "speaker": "contact", "body": "One more thing", "timestamp": "unknown", "source_order": 2}
        ]
        id_b = outbox.queue_segment("sess-1", extended, closed_at="2026-09-30T10:05:00Z", reason="close")

        self.assertNotEqual(id_a, id_b)
        self.assertEqual(len(outbox.list_pending(limit=100)), 2)

    def test_cannot_queue_empty_messages(self):
        outbox = Outbox(self.db_path)
        with self.assertRaises(ValueError):
            outbox.queue_segment("sess-1", [], closed_at="2026-09-29T10:05:00Z", reason="close")


class StateTransitionTests(OutboxTestCase):
    def test_full_success_lifecycle(self):
        outbox = Outbox(self.db_path)
        segment_id = outbox.queue_segment("sess-1", SAMPLE_MESSAGES, closed_at="now", reason="close")

        pending = outbox.list_pending()
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["segment_id"], segment_id)

        outbox.mark_syncing(segment_id)
        self.assertEqual(outbox.get_segment(segment_id)["status"], STATUS_SYNCING)
        self.assertEqual(outbox.list_pending(), [])

        outbox.mark_synced(segment_id, "conv-123")
        segment = outbox.get_segment(segment_id)
        self.assertEqual(segment["status"], STATUS_SYNCED)
        self.assertEqual(segment["remote_conversation_id"], "conv-123")
        self.assertEqual(outbox.list_pending(), [])

    def test_fresh_syncing_segment_is_hidden_but_stale_bound_syncing_segment_replays_same_payload(self):
        outbox = Outbox(self.db_path)
        segment_id = outbox.queue_segment("sess-1", SAMPLE_MESSAGES, closed_at="now", reason="close")
        original = outbox.prepare_sync_payload(segment_id, lead_id="lead-1", summary="first summary")
        outbox.mark_syncing(segment_id)
        self.assertEqual(outbox.list_pending(), [])

        with sqlite3.connect(self.db_path) as conn:
            conn.execute("UPDATE segments SET updated_at = ? WHERE segment_id = ?", ("2000-01-01T00:00:00+00:00", segment_id))

        pending = outbox.list_pending()
        self.assertEqual([item["segment_id"] for item in pending], [segment_id])
        replay = outbox.prepare_sync_payload(segment_id, lead_id="lead-2", summary="regenerated summary")
        self.assertEqual(replay, original)

    def test_retry_preserves_payload_and_increments_attempts(self):
        outbox = Outbox(self.db_path)
        segment_id = outbox.queue_segment("sess-1", SAMPLE_MESSAGES, closed_at="now", reason="close")

        outbox.mark_syncing(segment_id)
        outbox.mark_retry(segment_id, "connection reset", next_attempt_at="2020-01-01T00:00:00+00:00")

        segment = outbox.get_segment(segment_id)
        self.assertEqual(segment["status"], STATUS_RETRY)
        self.assertEqual(segment["attempts"], 1)
        self.assertEqual(segment["messages"], SAMPLE_MESSAGES)

        # next_attempt_at is in the past, so it should be picked up again.
        pending = outbox.list_pending()
        self.assertEqual(len(pending), 1)

        outbox.mark_retry(segment_id, "connection reset again", next_attempt_at="2020-01-01T00:00:00+00:00")
        self.assertEqual(outbox.get_segment(segment_id)["attempts"], 2)

    def test_retry_respects_future_next_attempt(self):
        outbox = Outbox(self.db_path)
        segment_id = outbox.queue_segment("sess-1", SAMPLE_MESSAGES, closed_at="now", reason="close")
        outbox.mark_retry(segment_id, "timeout", next_attempt_at="2999-01-01T00:00:00+00:00")

        self.assertEqual(outbox.list_pending(), [])

    def test_failed_is_not_returned_by_list_pending_but_data_retained(self):
        outbox = Outbox(self.db_path)
        segment_id = outbox.queue_segment("sess-1", SAMPLE_MESSAGES, closed_at="now", reason="close")
        outbox.mark_failed(segment_id, "401 Unauthorized")

        self.assertEqual(outbox.list_pending(), [])
        segment = outbox.get_segment(segment_id)
        self.assertEqual(segment["status"], STATUS_FAILED)
        self.assertEqual(segment["messages"], SAMPLE_MESSAGES)

    def test_error_messages_are_secret_free(self):
        outbox = Outbox(self.db_path)
        segment_id = outbox.queue_segment("sess-1", SAMPLE_MESSAGES, closed_at="now", reason="close")
        outbox.mark_retry(segment_id, "failed with Authorization: Bearer sk-super-secret-key")

        segment = outbox.get_segment(segment_id)
        self.assertNotIn("sk-super-secret-key", segment["last_error"])
        self.assertNotIn("Bearer", segment["last_error"])


class SessionBoundaryTests(OutboxTestCase):
    def test_boundary_none_before_any_segment_queued(self):
        outbox = Outbox(self.db_path)
        self.assertIsNone(outbox.get_session_boundary("sess-1"))

    def test_boundary_set_to_max_source_order_after_queueing(self):
        outbox = Outbox(self.db_path)
        outbox.queue_segment("sess-1", SAMPLE_MESSAGES, closed_at="now", reason="close")
        self.assertEqual(outbox.get_session_boundary("sess-1"), 1)

    def test_boundary_advances_on_a_later_segment_for_the_same_session(self):
        outbox = Outbox(self.db_path)
        outbox.queue_segment("sess-1", SAMPLE_MESSAGES, closed_at="now", reason="close")

        more = [
            {"direction": "inbound", "speaker": "contact", "body": "one more thing", "timestamp": "unknown", "source_order": 5},
        ]
        outbox.queue_segment("sess-1", more, closed_at="now", reason="idle")

        self.assertEqual(outbox.get_session_boundary("sess-1"), 5)

    def test_boundary_is_tracked_independently_per_session(self):
        outbox = Outbox(self.db_path)
        outbox.queue_segment("sess-1", SAMPLE_MESSAGES, closed_at="now", reason="close")

        self.assertIsNone(outbox.get_session_boundary("sess-2"))

    def test_boundary_persists_across_reopen(self):
        outbox = Outbox(self.db_path)
        outbox.queue_segment("sess-1", SAMPLE_MESSAGES, closed_at="now", reason="close")

        reopened = Outbox(self.db_path)
        self.assertEqual(reopened.get_session_boundary("sess-1"), 1)

    def test_concurrent_overlapping_snapshots_queue_each_source_message_once(self):
        outbox = Outbox(self.db_path)
        first_snapshot = [
            {"direction": "inbound", "speaker": "contact", "body": "first", "timestamp": "unknown", "source_order": 0},
            {"direction": "outbound", "speaker": "andrew", "body": "second", "timestamp": "unknown", "source_order": 1},
        ]
        later_snapshot = first_snapshot + [
            {"direction": "inbound", "speaker": "contact", "body": "third", "timestamp": "unknown", "source_order": 2},
        ]
        original_connect = outbox._connect
        first_read = threading.Event()
        allow_first = threading.Event()
        second_read = threading.Event()

        class ObservedConnection:
            def __init__(self, connection, worker):
                self.connection = connection
                self.worker = worker

            @property
            def row_factory(self):
                return self.connection.row_factory

            @row_factory.setter
            def row_factory(self, value):
                self.connection.row_factory = value

            def execute(self, sql, *params):
                if "SELECT last_source_order FROM session_boundaries" in sql:
                    if self.worker == "capture-first":
                        first_read.set()
                        if not allow_first.wait(timeout=5):
                            raise TimeoutError("test did not release first capture")
                    elif self.worker == "capture-second":
                        second_read.set()
                return self.connection.execute(sql, *params)

            def __enter__(self):
                self.connection.__enter__()
                return self

            def __exit__(self, *args):
                return self.connection.__exit__(*args)

            def close(self):
                return self.connection.close()

        def observed_connect():
            return ObservedConnection(original_connect(), threading.current_thread().name)

        outbox._connect = observed_connect
        results = {}

        def capture(name, snapshot):
            results[name] = outbox.queue_new_messages("sess-1", snapshot, closed_at=name, reason="idle")

        first = threading.Thread(name="capture-first", target=capture, args=("first", first_snapshot))
        second = threading.Thread(name="capture-second", target=capture, args=("second", later_snapshot))
        first.start()
        self.assertTrue(first_read.wait(timeout=5))
        second.start()
        second_read_before_release = second_read.wait(timeout=0.2)
        allow_first.set()
        first.join(timeout=5)
        second.join(timeout=5)

        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertFalse(second_read_before_release, "second capture read boundary before first commit")
        segments = outbox.list_pending(limit=10)
        captured_orders = [message["source_order"] for segment in segments for message in segment["messages"]]
        self.assertEqual(sorted(captured_orders), [0, 1, 2])
        self.assertEqual(len(set(captured_orders)), len(captured_orders))


class PrepareSyncPayloadTests(OutboxTestCase):
    def test_raises_for_unknown_segment(self):
        outbox = Outbox(self.db_path)
        with self.assertRaises(ValueError):
            outbox.prepare_sync_payload("does-not-exist", lead_id="lead-1", summary="s")

    def test_first_call_binds_the_given_lead_and_summary(self):
        outbox = Outbox(self.db_path)
        segment_id = outbox.queue_segment("sess-1", SAMPLE_MESSAGES, closed_at="now", reason="close")

        bound = outbox.prepare_sync_payload(segment_id, lead_id="lead-1", summary="first summary")

        self.assertEqual(bound, {"lead_id": "lead-1", "summary": "first summary"})
        segment = outbox.get_segment(segment_id)
        self.assertEqual(segment["lead_id"], "lead-1")
        self.assertEqual(segment["summary"], "first summary")

    def test_second_call_with_different_lead_and_summary_returns_original_binding(self):
        outbox = Outbox(self.db_path)
        segment_id = outbox.queue_segment("sess-1", SAMPLE_MESSAGES, closed_at="now", reason="close")

        outbox.prepare_sync_payload(segment_id, lead_id="lead-1", summary="first summary")
        bound_again = outbox.prepare_sync_payload(segment_id, lead_id="lead-2", summary="a completely different summary")

        self.assertEqual(bound_again, {"lead_id": "lead-1", "summary": "first summary"})
        segment = outbox.get_segment(segment_id)
        self.assertEqual(segment["lead_id"], "lead-1")
        self.assertEqual(segment["summary"], "first summary")

    def test_binding_survives_reopen_and_still_wins_over_new_args(self):
        outbox = Outbox(self.db_path)
        segment_id = outbox.queue_segment("sess-1", SAMPLE_MESSAGES, closed_at="now", reason="close")
        outbox.prepare_sync_payload(segment_id, lead_id="lead-1", summary="first summary")

        reopened = Outbox(self.db_path)
        segment = reopened.get_segment(segment_id)
        self.assertEqual(segment["lead_id"], "lead-1")
        self.assertEqual(segment["summary"], "first summary")

        bound = reopened.prepare_sync_payload(segment_id, lead_id="lead-99", summary="ignored on retry")
        self.assertEqual(bound, {"lead_id": "lead-1", "summary": "first summary"})

    def test_binding_does_not_alter_the_original_transcript(self):
        outbox = Outbox(self.db_path)
        segment_id = outbox.queue_segment("sess-1", SAMPLE_MESSAGES, closed_at="now", reason="close")

        outbox.prepare_sync_payload(segment_id, lead_id="lead-1", summary="a summary")

        segment = outbox.get_segment(segment_id)
        self.assertEqual(segment["messages"], SAMPLE_MESSAGES)

    def test_bound_segment_defaults_lead_id_and_summary_to_none(self):
        outbox = Outbox(self.db_path)
        segment_id = outbox.queue_segment("sess-1", SAMPLE_MESSAGES, closed_at="now", reason="close")

        segment = outbox.get_segment(segment_id)
        self.assertIsNone(segment["lead_id"])
        self.assertIsNone(segment["summary"])


class BindingColumnMigrationTests(OutboxTestCase):
    def test_pre_existing_database_without_binding_columns_is_migrated_in_place(self):
        # Simulate an outbox file created before lead_id/summary existed.
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """
            CREATE TABLE segments (
                segment_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                messages_json TEXT NOT NULL,
                reason TEXT NOT NULL,
                closed_at TEXT NOT NULL,
                status TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt_at TEXT,
                last_error TEXT,
                remote_conversation_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            INSERT INTO segments (
                segment_id, session_id, messages_json, reason, closed_at,
                status, attempts, next_attempt_at, last_error,
                remote_conversation_id, created_at, updated_at
            ) VALUES ('seg-old', 'sess-1', ?, 'close', 'now', 'pending', 0, NULL, NULL, NULL, 'now', 'now')
            """,
            (json.dumps(SAMPLE_MESSAGES),),
        )
        conn.commit()
        conn.close()

        # Opening the outbox must migrate the existing table in place, not
        # lose the already-queued (pre-migration) segment.
        outbox = Outbox(self.db_path)
        segment = outbox.get_segment("seg-old")
        self.assertIsNotNone(segment)
        self.assertEqual(segment["messages"], SAMPLE_MESSAGES)
        self.assertIsNone(segment["lead_id"])
        self.assertIsNone(segment["summary"])

        bound = outbox.prepare_sync_payload("seg-old", lead_id="lead-1", summary="s")
        self.assertEqual(bound, {"lead_id": "lead-1", "summary": "s"})

    def test_migration_quarantines_an_unbound_legacy_retry(self):
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """
            CREATE TABLE segments (
                segment_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                messages_json TEXT NOT NULL,
                reason TEXT NOT NULL,
                closed_at TEXT NOT NULL,
                status TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt_at TEXT,
                last_error TEXT,
                remote_conversation_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            INSERT INTO segments (
                segment_id, session_id, messages_json, reason, closed_at,
                status, attempts, next_attempt_at, last_error,
                remote_conversation_id, created_at, updated_at
            ) VALUES ('seg-ambiguous', 'sess-1', ?, 'close', 'now', 'retry', 1,
                      NULL, 'timeout', NULL, 'now', 'now')
            """,
            (json.dumps(SAMPLE_MESSAGES),),
        )
        conn.commit()
        conn.close()

        outbox = Outbox(self.db_path)

        segment = outbox.get_segment("seg-ambiguous")
        self.assertEqual(segment["status"], STATUS_FAILED)
        self.assertIn("reconciliation", segment["last_error"].lower())
        with self.assertRaisesRegex(ValueError, "reconciliation"):
            outbox.prepare_sync_payload("seg-ambiguous", lead_id="different-lead", summary="new summary")
        segment = outbox.get_segment("seg-ambiguous")
        self.assertIsNone(segment["lead_id"])
        self.assertIsNone(segment["summary"])

    def test_concurrent_initializers_migrate_binding_columns_once(self):
        conn = sqlite3.connect(self.db_path)
        conn.execute(
            """
            CREATE TABLE segments (
                segment_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                messages_json TEXT NOT NULL,
                reason TEXT NOT NULL,
                closed_at TEXT NOT NULL,
                status TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                next_attempt_at TEXT,
                last_error TEXT,
                remote_conversation_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        conn.commit()
        conn.close()

        barrier = threading.Barrier(6)

        def initialize():
            barrier.wait()
            return Outbox(self.db_path)

        with ThreadPoolExecutor(max_workers=6) as executor:
            outboxes = list(executor.map(lambda _index: initialize(), range(6)))

        self.assertEqual(len(outboxes), 6)
        conn = sqlite3.connect(self.db_path)
        columns = {row[1] for row in conn.execute("PRAGMA table_info(segments)")}
        conn.close()
        self.assertTrue({"lead_id", "summary"}.issubset(columns))


if __name__ == "__main__":
    unittest.main()

