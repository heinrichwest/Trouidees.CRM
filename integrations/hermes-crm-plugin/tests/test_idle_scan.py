import os
import sys
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from idle_scan import find_idle_whatsapp_sessions, queue_idle_sessions
from outbox import Outbox

NOW = datetime(2026, 9, 29, 12, 0, 0, tzinfo=timezone.utc)


def _iso(dt):
    return dt.isoformat()


def _epoch(dt):
    return dt.timestamp()


class FindIdleWhatsappSessionsTests(unittest.TestCase):
    def test_23h59m_not_due(self):
        records = [
            {
                "id": "s1",
                "source": "whatsapp",
                "last_activity_at": _epoch(NOW - timedelta(hours=23, minutes=59)),
            }
        ]
        result = find_idle_whatsapp_sessions(NOW, idle_hours=24, list_sessions=lambda timeout, platform: records)
        self.assertEqual(result, [])

    def test_24h_exactly_due(self):
        records = [
            {
                "id": "s1",
                "source": "whatsapp",
                "last_activity_at": _epoch(NOW - timedelta(hours=24)),
            }
        ]
        result = find_idle_whatsapp_sessions(NOW, idle_hours=24, list_sessions=lambda timeout, platform: records)
        self.assertEqual(result, ["s1"])

    def test_non_whatsapp_sessions_ignored(self):
        records = [
            {"id": "s1", "source": "telegram", "last_activity_at": _epoch(NOW - timedelta(hours=48))},
        ]
        result = find_idle_whatsapp_sessions(NOW, idle_hours=24, list_sessions=lambda timeout, platform: records)
        self.assertEqual(result, [])

    def test_missing_last_activity_falls_back_to_ended_at(self):
        records = [
            {"id": "s1", "source": "whatsapp", "ended_at": _epoch(NOW - timedelta(hours=30))},
        ]
        result = find_idle_whatsapp_sessions(NOW, idle_hours=24, list_sessions=lambda timeout, platform: records)
        self.assertEqual(result, ["s1"])

    def test_no_usable_timestamp_excluded(self):
        records = [{"id": "s1", "source": "whatsapp"}]
        result = find_idle_whatsapp_sessions(NOW, idle_hours=24, list_sessions=lambda timeout, platform: records)
        self.assertEqual(result, [])

    def test_passes_platform_through_to_lister(self):
        seen = {}

        def lister(timeout, platform):
            seen["platform"] = platform
            return []

        find_idle_whatsapp_sessions(NOW, idle_hours=24, list_sessions=lister)
        self.assertEqual(seen["platform"], "whatsapp")

    def test_iso_string_timestamp_also_accepted(self):
        records = [
            {
                "id": "s1",
                "source": "whatsapp",
                "last_activity_at": _iso(NOW - timedelta(hours=25)),
            }
        ]
        result = find_idle_whatsapp_sessions(NOW, idle_hours=24, list_sessions=lambda timeout, platform: records)
        self.assertEqual(result, ["s1"])


class QueueIdleSessionsTests(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.outbox = Outbox(os.path.join(self.tmpdir, "outbox.sqlite3"))

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_queues_only_idle_whatsapp_sessions_and_makes_no_network_or_llm_call(self):
        records = [
            {"id": "idle-1", "source": "whatsapp", "last_activity_at": _epoch(NOW - timedelta(hours=25))},
            {"id": "fresh-1", "source": "whatsapp", "last_activity_at": _epoch(NOW - timedelta(hours=1))},
        ]
        exports = {
            "idle-1": {
                "source": "whatsapp",
                "messages": [{"role": "user", "content": "still there?"}],
            }
        }

        def fake_export(session_id):
            return exports[session_id]

        queued = queue_idle_sessions(
            now=NOW,
            outbox=self.outbox,
            list_sessions=lambda timeout, platform: records,
            export_fn=fake_export,
        )

        self.assertEqual(len(queued), 1)
        pending = self.outbox.list_pending()
        self.assertEqual(len(pending), 1)
        self.assertEqual(pending[0]["session_id"], "idle-1")
        self.assertEqual(pending[0]["reason"], "idle")

    def test_repeated_scan_of_same_idle_session_does_not_duplicate(self):
        records = [
            {"id": "idle-1", "source": "whatsapp", "last_activity_at": _epoch(NOW - timedelta(hours=25))},
        ]
        export = {"source": "whatsapp", "messages": [{"role": "user", "content": "hi"}]}

        queue_idle_sessions(now=NOW, outbox=self.outbox, list_sessions=lambda timeout, platform: records, export_fn=lambda sid: export)
        queue_idle_sessions(now=NOW, outbox=self.outbox, list_sessions=lambda timeout, platform: records, export_fn=lambda sid: export)

        self.assertEqual(len(self.outbox.list_pending(limit=100)), 1)

    def test_message_after_idle_close_starts_new_segment(self):
        records = [
            {"id": "idle-1", "source": "whatsapp", "last_activity_at": _epoch(NOW - timedelta(hours=25))},
        ]
        first_export = {"source": "whatsapp", "messages": [{"role": "user", "content": "hi"}]}
        queue_idle_sessions(now=NOW, outbox=self.outbox, list_sessions=lambda timeout, platform: records, export_fn=lambda sid: first_export)

        later = NOW + timedelta(hours=25)
        records_later = [
            {"id": "idle-1", "source": "whatsapp", "last_activity_at": _epoch(later - timedelta(hours=25))},
        ]
        second_export = {
            "source": "whatsapp",
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "welcome back"},
            ],
        }
        queue_idle_sessions(now=later, outbox=self.outbox, list_sessions=lambda timeout, platform: records_later, export_fn=lambda sid: second_export)

        self.assertEqual(len(self.outbox.list_pending(limit=100)), 2)


class SessionBoundaryQueueingTests(unittest.TestCase):
    """`hermes sessions export` always returns a session's full history, not
    just what changed. A long-lived session that goes idle, gets queued, then
    receives more messages and goes idle again must not have its whole
    history re-queued: only the newly appended messages should form the next
    segment, and a scan that observes no new messages must queue nothing."""

    SESSION_ID = "sess-longlived"

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.outbox = Outbox(os.path.join(self.tmpdir, "outbox.sqlite3"))

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _records_idle_at(self, when):
        return [
            {
                "id": self.SESSION_ID,
                "source": "whatsapp",
                "last_activity_at": _epoch(when - timedelta(hours=25)),
            }
        ]

    def test_first_idle_scan_queues_the_full_transcript_whole(self):
        export = {
            "source": "whatsapp",
            "messages": [
                {"role": "user", "content": "hi, is this available?"},
                {"role": "assistant", "content": "yes it is!"},
            ],
        }

        queued = queue_idle_sessions(
            now=NOW,
            outbox=self.outbox,
            list_sessions=lambda timeout, platform: self._records_idle_at(NOW),
            export_fn=lambda sid: export,
        )

        self.assertEqual(len(queued), 1)
        pending = self.outbox.list_pending()
        self.assertEqual(len(pending), 1)
        bodies = [m["body"] for m in pending[0]["messages"]]
        self.assertEqual(bodies, ["hi, is this available?", "yes it is!"])
        self.assertEqual(self.outbox.get_session_boundary(self.SESSION_ID), 1)

    def test_later_appended_message_forms_a_second_segment_with_only_the_new_messages(self):
        first_export = {
            "source": "whatsapp",
            "messages": [
                {"role": "user", "content": "hi, is this available?"},
                {"role": "assistant", "content": "yes it is!"},
            ],
        }
        queue_idle_sessions(
            now=NOW,
            outbox=self.outbox,
            list_sessions=lambda timeout, platform: self._records_idle_at(NOW),
            export_fn=lambda sid: first_export,
        )

        later = NOW + timedelta(hours=25)
        # A real export always returns the full session history, old messages included.
        second_export = {
            "source": "whatsapp",
            "messages": [
                {"role": "user", "content": "hi, is this available?"},
                {"role": "assistant", "content": "yes it is!"},
                {"role": "user", "content": "actually, one more question"},
                {"role": "assistant", "content": "sure, go ahead"},
            ],
        }
        queued = queue_idle_sessions(
            now=later,
            outbox=self.outbox,
            list_sessions=lambda timeout, platform: self._records_idle_at(later),
            export_fn=lambda sid: second_export,
        )

        self.assertEqual(len(queued), 1)
        pending = self.outbox.list_pending(limit=100)
        self.assertEqual(len(pending), 2)

        second_segment = sorted(pending, key=lambda s: s["created_at"])[1]
        bodies = [m["body"] for m in second_segment["messages"]]
        self.assertEqual(bodies, ["actually, one more question", "sure, go ahead"])
        self.assertEqual([m["source_order"] for m in second_segment["messages"]], [2, 3])
        self.assertEqual(self.outbox.get_session_boundary(self.SESSION_ID), 3)

    def test_repeated_scan_after_second_segment_queues_no_further_duplicate(self):
        first_export = {"source": "whatsapp", "messages": [{"role": "user", "content": "hi"}]}
        queue_idle_sessions(
            now=NOW,
            outbox=self.outbox,
            list_sessions=lambda timeout, platform: self._records_idle_at(NOW),
            export_fn=lambda sid: first_export,
        )

        later = NOW + timedelta(hours=25)
        second_export = {
            "source": "whatsapp",
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "welcome back"},
            ],
        }
        queue_idle_sessions(
            now=later,
            outbox=self.outbox,
            list_sessions=lambda timeout, platform: self._records_idle_at(later),
            export_fn=lambda sid: second_export,
        )
        self.assertEqual(len(self.outbox.list_pending(limit=100)), 2)

        # A third scan re-exports the same (unchanged) full history: no new
        # messages exist since the second segment, so nothing new is queued.
        even_later = later + timedelta(hours=25)
        queued_third = queue_idle_sessions(
            now=even_later,
            outbox=self.outbox,
            list_sessions=lambda timeout, platform: self._records_idle_at(even_later),
            export_fn=lambda sid: second_export,
        )

        self.assertEqual(queued_third, [])
        self.assertEqual(len(self.outbox.list_pending(limit=100)), 2)

        # And repeating that same no-op scan again stays stable too.
        queued_fourth = queue_idle_sessions(
            now=even_later + timedelta(hours=1),
            outbox=self.outbox,
            list_sessions=lambda timeout, platform: self._records_idle_at(even_later + timedelta(hours=1)),
            export_fn=lambda sid: second_export,
        )
        self.assertEqual(queued_fourth, [])
        self.assertEqual(len(self.outbox.list_pending(limit=100)), 2)


if __name__ == "__main__":
    unittest.main()
