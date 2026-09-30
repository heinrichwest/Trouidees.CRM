"""No-agent (script-only) scanner that queues WhatsApp sessions idle for 24
hours into the local outbox.

This module makes no CRM network request and invokes no LLM: it only reads
session metadata through the supported `hermes sessions export` CLI (bulk,
multi-session form filtered server-side with `--source`), exports each idle
WhatsApp session's full transcript, and writes newly appended visible
messages to the local SQLite outbox via outbox.Outbox.queue_new_messages.

`hermes sessions export` always returns a session's *full* message history,
not just what's new since the last scan. A long-lived Hermes session can go
idle, get queued, then receive more messages and go idle again — and it can
also be closed explicitly (tools.queue_closed_session, on session-finalize)
before or after an idle capture. Without correction, any later trigger would
re-export and re-queue the entire history, duplicating an already-queued
segment. Both this scanner and the explicit-close path funnel through
`Outbox.queue_new_messages`, which drops every message whose source_order is
at or before the last boundary already recorded for that session (across
either trigger), so only the truly new tail is ever queued as a new segment.
The first capture for a session (no boundary yet) is queued whole, and a
capture with no new messages since the last queued segment queues nothing —
this holds no matter which trigger (idle or explicit close) sees the
unchanged transcript.

Field names and the epoch-timestamp format below were verified against a
real `hermes sessions export` payload (Hermes Agent v0.21.5) rather than
assumed: the session identifier field is `id` (not `session_id`), and
`last_activity_at`/`ended_at`/`started_at` are Unix epoch floats, not ISO
strings. No WhatsApp-sourced session was available locally to confirm
platform-specific values, so re-verify `--source whatsapp` output before
production use (see README.md "Assumptions and risks").

Meant to run as a Hermes script-only cron job
(`hermes cron create "every 5m" --no-agent --script ...`), not as an LLM tool.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from numbers import Real
from typing import Callable, Optional

try:
    from .outbox import Outbox
    from .session_export import export_session, extract_whatsapp_messages, SessionExportError
except ImportError:
    from outbox import Outbox
    from session_export import export_session, extract_whatsapp_messages, SessionExportError

# Checked in order; `last_activity_at` is the field observed on a real
# export, the rest are fallbacks for sessions missing it.
_TIMESTAMP_KEYS = ("last_activity_at", "ended_at", "started_at")


def _default_list_sessions(timeout: float, platform: str) -> list:
    """Export metadata for every session on the given platform, filtered
    server-side via the documented `--source` flag."""
    fd, tmp_path = tempfile.mkstemp(prefix="hermes-export-all-", suffix=".jsonl")
    os.close(fd)
    try:
        subprocess.run(
            ["hermes", "sessions", "export", tmp_path, "--source", platform],
            check=True,
            capture_output=True,
            timeout=timeout,
        )
        records = []
        with open(tmp_path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return records
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def _parse_timestamp(value) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, Real):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str) and value:
        try:
            text = value.replace("Z", "+00:00")
            parsed = datetime.fromisoformat(text)
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            return parsed
        except ValueError:
            return None
    return None


def _last_activity(record: dict) -> Optional[datetime]:
    for key in _TIMESTAMP_KEYS:
        parsed = _parse_timestamp(record.get(key))
        if parsed is not None:
            return parsed
    return None


def find_idle_whatsapp_sessions(
    now: datetime,
    idle_hours: int = 24,
    *,
    platform: str = "whatsapp",
    list_sessions: Optional[Callable[[float, str], list]] = None,
    timeout: float = 60.0,
) -> list:
    """Return session IDs for WhatsApp sessions idle for >= idle_hours."""
    lister = list_sessions or _default_list_sessions
    records = lister(timeout, platform)
    threshold = timedelta(hours=idle_hours)

    idle_ids = []
    for record in records:
        if not isinstance(record, dict):
            continue
        source = record.get("source") or record.get("platform")
        if source != platform:
            continue
        last_activity = _last_activity(record)
        if last_activity is None:
            continue
        if now - last_activity >= threshold:
            session_id = record.get("id") or record.get("session_id")
            if session_id:
                idle_ids.append(session_id)
    return idle_ids


def queue_idle_sessions(
    now: Optional[datetime] = None,
    idle_hours: int = 24,
    *,
    outbox: Optional[Outbox] = None,
    list_sessions: Optional[Callable[[float, str], list]] = None,
    export_fn: Optional[Callable[[str], dict]] = None,
) -> list:
    """Queue every WhatsApp session idle for idle_hours. Local-only: no CRM
    request, no LLM call. Returns the list of segment IDs queued this run."""
    now = now or datetime.now(timezone.utc)
    box = outbox or Outbox()
    export = export_fn or export_session

    session_ids = find_idle_whatsapp_sessions(now, idle_hours, list_sessions=list_sessions)
    queued = []
    for session_id in session_ids:
        try:
            record = export(session_id)
        except SessionExportError:
            continue
        messages = extract_whatsapp_messages(record, platform="whatsapp")
        if not messages:
            continue

        # Export always returns the session's *full* history, not a delta.
        # queue_new_messages (shared with the explicit-close path in
        # tools.py) drops anything already captured by an earlier segment
        # for this session, so a session that goes idle more than once only
        # ever has its newly appended messages queued.
        segment_id = box.queue_new_messages(
            session_id=session_id,
            messages=messages,
            closed_at=now.isoformat(),
            reason="idle",
        )
        if segment_id is not None:
            queued.append(segment_id)
    return queued
