"""Durable SQLite outbox for queued WhatsApp conversation segments.

A segment is identified by a content hash of (session_id, ordered messages),
not just the session_id. This makes queuing idempotent: an explicit close and
a 24-hour idle scan that observe the exact same message set produce the same
segment_id and collapse into one row, while a message that arrives after an
idle close changes the message set and therefore produces a new segment_id,
i.e. a new segment. This directly satisfies the close/idle race and
post-idle-message requirements in the plan without depending on any
Hermes-internal segment/conversation identifier.

Every queued segment also durably advances a per-session boundary
(`session_boundaries`, keyed by session_id, storing the highest
`source_order` seen). A long-lived Hermes session can go idle, get queued,
then receive more messages and go idle again; the scanner (idle_scan.py)
uses `get_session_boundary` to export only messages *after* that boundary
before calling `queue_segment`, so the resulting segment never repeats
messages a previous segment for the same session already captured.

A segment also durably binds the *first* lead_id and summary submitted for
it, before any network request is attempted (`prepare_sync_payload`). Hermes
retries a sync attempt after a transient failure or timeout, and the LLM
that supplies lead_id/summary can pick a different lead or phrase a slightly
different summary on that retry. Without binding, a retry could resubmit a
segment under the same idempotency key but with a different payload (which
the CRM may reject as a conflict) or, worse, to a *different* lead's
endpoint (a different lead_id changes the request URL entirely, so the
CRM's per-lead idempotency store would never see it as a duplicate and would
create a second, wrongly-owned conversation). Once bound, every retry for
that segment submits the exact original lead_id + summary + messages +
segment/idempotency key, regardless of what a later tool call is given.

All state lives in a single SQLite file under the Hermes profile's state
directory so a restart or CRM outage never loses a queued transcript.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from contextlib import closing
from datetime import datetime, timedelta, timezone
from typing import Optional

DEFAULT_STATE_DIR = os.path.join(os.path.expanduser("~"), ".hermes", "plugins", "trouidees-crm", "state")
DEFAULT_DB_FILENAME = "crm_outbox.sqlite3"

STATUS_PENDING = "pending"
STATUS_SYNCING = "syncing"
STATUS_SYNCED = "synced"
STATUS_RETRY = "retry"
STATUS_FAILED = "failed"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS segments (
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
    lead_id TEXT,
    summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segments_status ON segments(status);
CREATE INDEX IF NOT EXISTS idx_segments_session ON segments(session_id);

CREATE TABLE IF NOT EXISTS session_boundaries (
    session_id TEXT PRIMARY KEY,
    last_source_order INTEGER NOT NULL,
    updated_at TEXT NOT NULL
);
"""

# Columns added after the initial release. `CREATE TABLE IF NOT EXISTS` above
# only covers brand-new databases; an outbox file created before these
# columns existed needs them added in place so its already-queued (and
# possibly still-pending) segments keep working.
_BINDING_COLUMNS = (
    ("lead_id", "TEXT"),
    ("summary", "TEXT"),
)
_WAL_RETRY_TIMEOUT_SECONDS = 5.0
SYNCING_STALE_AFTER_SECONDS = 10 * 60


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def compute_segment_id(session_id: str, messages: list) -> str:
    fingerprint = json.dumps(
        {
            "session_id": session_id,
            "messages": [
                {
                    "direction": m["direction"],
                    "body": m["body"],
                    "timestamp": m.get("timestamp"),
                    "source_order": m.get("source_order"),
                }
                for m in messages
            ],
        },
        sort_keys=True,
        ensure_ascii=False,
    )
    return hashlib.sha256(fingerprint.encode("utf-8")).hexdigest()[:32]


def compute_backoff_seconds(attempts: int, base_seconds: int = 30, cap_seconds: int = 3600) -> int:
    """Exponential backoff with a cap, used for transient CRM/network failures."""
    return min(base_seconds * (2 ** max(attempts, 0)), cap_seconds)


def _sanitize_error(error: str) -> str:
    """Best-effort scrub so a stray secret never lands in the outbox.

    Callers are expected to already pass short, secret-free messages (see
    crm_client.py), but this is a defense-in-depth backstop.
    """
    text = str(error)
    for marker in ("Authorization", "Bearer", "api_key", "CRM_AGENT_API_KEY"):
        if marker.lower() in text.lower():
            return "sync error (details redacted)"
    return text[:500]


class Outbox:
    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path or os.path.join(DEFAULT_STATE_DIR, DEFAULT_DB_FILENAME)
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=30)
        conn.row_factory = sqlite3.Row
        deadline = time.monotonic() + _WAL_RETRY_TIMEOUT_SECONDS
        delay = 0.01
        while True:
            try:
                conn.execute("PRAGMA journal_mode=WAL")
                break
            except sqlite3.OperationalError as exc:
                message = str(exc).lower()
                if "locked" not in message and "busy" not in message:
                    conn.close()
                    raise
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    conn.close()
                    raise
                time.sleep(min(delay, remaining))
                delay = min(delay * 2, 0.25)
        return conn

    def _init_schema(self) -> None:
        with closing(self._connect()) as conn, conn:
            conn.executescript(_SCHEMA)
            self._migrate_binding_columns(conn)

    @staticmethod
    def _migrate_binding_columns(conn: sqlite3.Connection) -> None:
        # Reserve the SQLite writer lock before inspecting the schema. Without
        # this, two plugin processes can both see a missing column and race on
        # ALTER TABLE, leaving one startup with "duplicate column".
        conn.execute("BEGIN IMMEDIATE")
        existing = {row["name"] for row in conn.execute("PRAGMA table_info(segments)").fetchall()}
        for column, sql_type in _BINDING_COLUMNS:
            if column not in existing:
                conn.execute(f"ALTER TABLE segments ADD COLUMN {column} {sql_type}")

        # Before binding was introduced, a retrying/syncing segment may have
        # already reached the CRM while its response was lost. Its original
        # target and summary cannot be reconstructed, so never let a new LLM
        # choice silently re-target that idempotency key.
        conn.execute(
            """
            UPDATE segments
            SET status = ?,
                last_error = ?,
                updated_at = ?
            WHERE lead_id IS NULL AND summary IS NULL
              AND status <> ? AND status <> ?
            """,
            (
                STATUS_FAILED,
                "Legacy segment has no saved payload binding; manual reconciliation required before retry",
                _now_iso(),
                STATUS_PENDING,
                STATUS_SYNCED,
            ),
        )

    def queue_segment(self, session_id: str, messages: list, closed_at: str, reason: str) -> str:
        if not messages:
            raise ValueError("cannot queue a segment with no messages")

        with closing(self._connect()) as conn, conn:
            return self._insert_segment(conn, session_id, messages, closed_at, reason)

    def _insert_segment(
        self, conn: sqlite3.Connection, session_id: str, messages: list,
        closed_at: str, reason: str,
    ) -> str:
        segment_id = compute_segment_id(session_id, messages)
        now = _now_iso()
        existing = conn.execute(
            "SELECT segment_id FROM segments WHERE segment_id = ?", (segment_id,)
        ).fetchone()
        if existing:
            return segment_id

        conn.execute(
            """
            INSERT INTO segments (
                segment_id, session_id, messages_json, reason, closed_at,
                status, attempts, next_attempt_at, last_error,
                remote_conversation_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, ?, ?)
            """,
            (
                segment_id,
                session_id,
                json.dumps(messages, ensure_ascii=False),
                reason,
                closed_at,
                STATUS_PENDING,
                now,
                now,
            ),
        )
        self._advance_session_boundary(conn, session_id, messages, now)
        return segment_id

    def get_session_boundary(self, session_id: str) -> Optional[int]:
        """Highest message `source_order` already captured in some
        previously queued segment for this session, or None if this session
        has never been queued. `queue_new_messages` is the preferred way to
        use this; call it directly only if you need the boundary value
        itself."""
        with closing(self._connect()) as conn:
            row = conn.execute(
                "SELECT last_source_order FROM session_boundaries WHERE session_id = ?",
                (session_id,),
            ).fetchone()
        return row["last_source_order"] if row else None

    def queue_new_messages(
        self, session_id: str, messages: list, closed_at: str, reason: str
    ) -> Optional[str]:
        """Queue only the messages after this session's durable boundary.

        `hermes sessions export` always returns a session's *full* message
        history, never a delta. A single long-lived Hermes session can be
        observed by either trigger this plugin has (the `on_session_finalize`
        explicit-close hook, or the 24-hour idle scanner) more than once, and
        those observations can also interleave: idle-then-close and
        close-then-idle must both behave the same way. This is the one place
        both triggers funnel through (via tools.queue_closed_session and
        idle_scan.queue_idle_sessions) so that guarantee holds regardless of
        which trigger fires, and in which order:

        - No prior segment for this session -> the full message list is
          queued as one segment (first close or first idle capture is whole).
        - A prior segment exists -> only messages after its boundary
          (`source_order > get_session_boundary(session_id)`) are queued as a
          new segment; anything at or before the boundary was already
          captured and is dropped here rather than resubmitted.
        - Nothing new since the last queued segment -> returns None and
          queues nothing, so two triggers observing the same boundary (an
          idle scan and a later explicit close with no new messages in
          between, or vice versa) are idempotent.
        """
        if not messages:
            return None
        with closing(self._connect()) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT last_source_order FROM session_boundaries WHERE session_id = ?",
                (session_id,),
            ).fetchone()
            boundary = row["last_source_order"] if row else None
            if boundary is not None:
                messages = [m for m in messages if m.get("source_order", -1) > boundary]
            if not messages:
                return None
            return self._insert_segment(conn, session_id, messages, closed_at, reason)

    @staticmethod
    def _advance_session_boundary(conn: sqlite3.Connection, session_id: str, messages: list, now: str) -> None:
        orders = [m.get("source_order") for m in messages if isinstance(m.get("source_order"), int)]
        if not orders:
            return
        max_order = max(orders)
        conn.execute(
            """
            INSERT INTO session_boundaries (session_id, last_source_order, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                last_source_order = MAX(last_source_order, excluded.last_source_order),
                updated_at = excluded.updated_at
            """,
            (session_id, max_order, now),
        )

    def get_segment(self, segment_id: str) -> Optional[dict]:
        with closing(self._connect()) as conn:
            row = conn.execute("SELECT * FROM segments WHERE segment_id = ?", (segment_id,)).fetchone()
        return self._row_to_dict(row) if row else None

    def prepare_sync_payload(self, segment_id: str, lead_id: str, summary: str) -> dict:
        """Atomically bind the first (lead_id, summary) submitted for this
        segment, before any CRM network request is attempted.

        The first call for a segment persists the given lead_id/summary and
        returns them back. Every later call for the *same* segment_id
        ignores whatever lead_id/summary it was given and returns the
        already-bound values instead, so a retry after a timeout — even one
        where the LLM regenerated a different summary or picked a different
        lead — always submits exactly what the first attempt did. Binding is
        guarded by a `WHERE lead_id IS NULL` update so two racing callers
        converge on whichever one commits first, rather than each writing
        their own value.

        Raises ValueError if the segment does not exist.
        """
        now = _now_iso()
        requires_reconciliation = False
        with closing(self._connect()) as conn, conn:
            row = conn.execute(
                "SELECT lead_id, summary, status, attempts FROM segments WHERE segment_id = ?",
                (segment_id,),
            ).fetchone()
            if row is None:
                raise ValueError(f"unknown segment_id: {segment_id}")

            if row["lead_id"] is None:
                if row["status"] != STATUS_PENDING or row["attempts"] > 0:
                    # Also guard against an ambiguous row created after startup
                    # (or one that missed the migration's quarantine update).
                    conn.execute(
                        """
                        UPDATE segments
                        SET status = ?, last_error = ?, updated_at = ?
                        WHERE segment_id = ? AND lead_id IS NULL AND summary IS NULL
                        """,
                        (
                            STATUS_FAILED,
                            "Legacy segment has no saved payload binding; manual reconciliation required before retry",
                            now,
                            segment_id,
                        ),
                    )
                    requires_reconciliation = True
                else:
                    conn.execute(
                        """
                        UPDATE segments
                        SET lead_id = ?, summary = ?, updated_at = ?
                        WHERE segment_id = ? AND lead_id IS NULL
                        """,
                        (lead_id, summary, now, segment_id),
                    )
                row = conn.execute(
                    "SELECT lead_id, summary FROM segments WHERE segment_id = ?", (segment_id,)
                ).fetchone()

        if requires_reconciliation:
            raise ValueError("legacy segment requires manual reconciliation before retry")
        return {"lead_id": row["lead_id"], "summary": row["summary"]}

    def list_pending(self, limit: int = 25) -> list:
        now = _now_iso()
        stale_syncing_before = (
            datetime.fromisoformat(now) - timedelta(seconds=SYNCING_STALE_AFTER_SECONDS)
        ).isoformat()
        with closing(self._connect()) as conn:
            rows = conn.execute(
                """
                SELECT * FROM segments
                WHERE (status IN (?, ?) OR
                       (status = ? AND updated_at <= ? AND lead_id IS NOT NULL AND summary IS NOT NULL))
                  AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
                ORDER BY created_at ASC
                LIMIT ?
                """,
                (STATUS_PENDING, STATUS_RETRY, STATUS_SYNCING, stale_syncing_before, now, limit),
            ).fetchall()
        return [self._row_to_dict(row) for row in rows]

    def mark_syncing(self, segment_id: str) -> None:
        with closing(self._connect()) as conn, conn:
            conn.execute(
                "UPDATE segments SET status = ?, updated_at = ? WHERE segment_id = ?",
                (STATUS_SYNCING, _now_iso(), segment_id),
            )

    def mark_synced(self, segment_id: str, conversation_id: str) -> None:
        with closing(self._connect()) as conn, conn:
            conn.execute(
                """
                UPDATE segments
                SET status = ?, remote_conversation_id = ?, last_error = NULL, updated_at = ?
                WHERE segment_id = ?
                """,
                (STATUS_SYNCED, conversation_id, _now_iso(), segment_id),
            )

    def mark_retry(self, segment_id: str, error: str, next_attempt_at: Optional[str] = None) -> None:
        with closing(self._connect()) as conn, conn:
            row = conn.execute(
                "SELECT attempts FROM segments WHERE segment_id = ?", (segment_id,)
            ).fetchone()
            attempts = (row["attempts"] if row else 0) + 1
            if next_attempt_at is None:
                delay = compute_backoff_seconds(attempts)
                next_attempt_at = datetime.fromtimestamp(
                    time.time() + delay, tz=timezone.utc
                ).isoformat()
            conn.execute(
                """
                UPDATE segments
                SET status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
                WHERE segment_id = ?
                """,
                (STATUS_RETRY, attempts, next_attempt_at, _sanitize_error(error), _now_iso(), segment_id),
            )

    def mark_failed(self, segment_id: str, error: str) -> None:
        with closing(self._connect()) as conn, conn:
            conn.execute(
                """
                UPDATE segments
                SET status = ?, last_error = ?, updated_at = ?
                WHERE segment_id = ?
                """,
                (STATUS_FAILED, _sanitize_error(error), _now_iso(), segment_id),
            )

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        data = dict(row)
        data["messages"] = json.loads(data.pop("messages_json"))
        return data

