import os
import sys
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import tools
import idle_scan
from outbox import Outbox

NOW = datetime(2026, 9, 29, 12, 0, 0, tzinfo=timezone.utc)
SESSION_ID = "sess-longlived"


def _idle_records(when):
    return [
        {
            "id": SESSION_ID,
            "source": "whatsapp",
            "last_activity_at": (when - timedelta(hours=25)).timestamp(),
        }
    ]


class ExplicitCloseBoundaryTests(unittest.TestCase):
    """The explicit-finalize path (tools.queue_closed_session, used by
    on_session_finalize and the crm_queue_session tool) must apply the same
    durable per-session boundary as the idle scanner: a new message after an
    idle close starts a new segment regardless of how that later segment
    itself closes, and both triggers observing the same boundary must be
    idempotent."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.outbox = Outbox(os.path.join(self.tmpdir, "outbox.sqlite3"))

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_first_explicit_close_captures_full_transcript(self):
        export = {
            "source": "whatsapp",
            "messages": [
                {"role": "user", "content": "hi, is this available?"},
                {"role": "assistant", "content": "yes it is!"},
            ],
        }

        segment_id = tools.queue_closed_session(
            SESSION_ID, reason="close", outbox=self.outbox, export_fn=lambda sid: export
        )

        self.assertIsNotNone(segment_id)
        pending = self.outbox.list_pending()
        self.assertEqual(len(pending), 1)
        bodies = [m["body"] for m in pending[0]["messages"]]
        self.assertEqual(bodies, ["hi, is this available?", "yes it is!"])
        self.assertEqual(self.outbox.get_session_boundary(SESSION_ID), 1)

    def test_idle_then_later_explicit_close_captures_only_new_messages(self):
        idle_export = {
            "source": "whatsapp",
            "messages": [
                {"role": "user", "content": "hi, is this available?"},
                {"role": "assistant", "content": "yes it is!"},
            ],
        }
        idle_queued = idle_scan.queue_idle_sessions(
            now=NOW,
            outbox=self.outbox,
            list_sessions=lambda timeout, platform: _idle_records(NOW),
            export_fn=lambda sid: idle_export,
        )
        self.assertEqual(len(idle_queued), 1)

        # More messages arrive, then the session finalizes explicitly. A real
        # export always returns the full history, old messages included.
        close_export = {
            "source": "whatsapp",
            "messages": [
                {"role": "user", "content": "hi, is this available?"},
                {"role": "assistant", "content": "yes it is!"},
                {"role": "user", "content": "actually, one more question"},
                {"role": "assistant", "content": "sure, go ahead"},
            ],
        }
        segment_id = tools.queue_closed_session(
            SESSION_ID, reason="close", outbox=self.outbox, export_fn=lambda sid: close_export
        )

        self.assertIsNotNone(segment_id)
        pending = self.outbox.list_pending(limit=100)
        self.assertEqual(len(pending), 2)

        second_segment = sorted(pending, key=lambda s: s["created_at"])[1]
        self.assertEqual(second_segment["reason"], "close")
        bodies = [m["body"] for m in second_segment["messages"]]
        self.assertEqual(bodies, ["actually, one more question", "sure, go ahead"])
        self.assertEqual([m["source_order"] for m in second_segment["messages"]], [2, 3])
        self.assertEqual(self.outbox.get_session_boundary(SESSION_ID), 3)

    def test_close_then_later_idle_captures_only_new_messages(self):
        """The reverse order: explicit close first, then the session
        receives more messages and later goes idle. The idle scanner must
        only pick up the new tail, not the whole history again."""
        close_export = {
            "source": "whatsapp",
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "hello!"},
            ],
        }
        tools.queue_closed_session(SESSION_ID, reason="close", outbox=self.outbox, export_fn=lambda sid: close_export)

        later = NOW + timedelta(hours=1)
        idle_export = {
            "source": "whatsapp",
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "hello!"},
                {"role": "user", "content": "quick follow-up"},
                {"role": "assistant", "content": "no problem"},
            ],
        }
        idle_queued = idle_scan.queue_idle_sessions(
            now=later,
            outbox=self.outbox,
            list_sessions=lambda timeout, platform: _idle_records(later),
            export_fn=lambda sid: idle_export,
        )

        self.assertEqual(len(idle_queued), 1)
        pending = self.outbox.list_pending(limit=100)
        self.assertEqual(len(pending), 2)
        second_segment = sorted(pending, key=lambda s: s["created_at"])[1]
        self.assertEqual(second_segment["reason"], "idle")
        bodies = [m["body"] for m in second_segment["messages"]]
        self.assertEqual(bodies, ["quick follow-up", "no problem"])

    def test_idle_then_close_seeing_same_unchanged_transcript_is_idempotent(self):
        export = {"source": "whatsapp", "messages": [{"role": "user", "content": "hi"}]}

        idle_queued = idle_scan.queue_idle_sessions(
            now=NOW,
            outbox=self.outbox,
            list_sessions=lambda timeout, platform: _idle_records(NOW),
            export_fn=lambda sid: export,
        )
        self.assertEqual(len(idle_queued), 1)

        # Session finalizes explicitly with no messages beyond what the idle
        # scan already captured: must not create a second, duplicate segment.
        segment_id = tools.queue_closed_session(
            SESSION_ID, reason="close", outbox=self.outbox, export_fn=lambda sid: export
        )

        self.assertIsNone(segment_id)
        self.assertEqual(len(self.outbox.list_pending(limit=100)), 1)

    def test_close_then_idle_seeing_same_unchanged_transcript_is_idempotent(self):
        export = {"source": "whatsapp", "messages": [{"role": "user", "content": "hi"}]}

        segment_id = tools.queue_closed_session(
            SESSION_ID, reason="close", outbox=self.outbox, export_fn=lambda sid: export
        )
        self.assertIsNotNone(segment_id)

        # Idle scan later observes the exact same (unchanged) transcript:
        # must not create a second, duplicate segment.
        idle_queued = idle_scan.queue_idle_sessions(
            now=NOW,
            outbox=self.outbox,
            list_sessions=lambda timeout, platform: _idle_records(NOW),
            export_fn=lambda sid: export,
        )

        self.assertEqual(idle_queued, [])
        self.assertEqual(len(self.outbox.list_pending(limit=100)), 1)

    def test_repeated_explicit_close_with_no_new_messages_is_idempotent(self):
        export = {
            "source": "whatsapp",
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "hello!"},
            ],
        }

        first = tools.queue_closed_session(SESSION_ID, reason="close", outbox=self.outbox, export_fn=lambda sid: export)
        second = tools.queue_closed_session(SESSION_ID, reason="close", outbox=self.outbox, export_fn=lambda sid: export)

        self.assertIsNotNone(first)
        self.assertIsNone(second)
        self.assertEqual(len(self.outbox.list_pending(limit=100)), 1)


if __name__ == "__main__":
    unittest.main()
