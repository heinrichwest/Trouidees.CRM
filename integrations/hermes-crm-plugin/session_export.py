"""Export a Hermes session through the supported `hermes sessions export`
CLI and filter it down to the contact-visible WhatsApp messages.

Per the official Hermes sessions guide, exported files contain one JSON
object per line with full session metadata and all messages. We never read
the legacy per-session JSONL files directly; we only shell out to the
documented CLI, without shell interpolation, and parse its JSONL output.

Message shape was verified against a real `hermes sessions export --format
jsonl` payload (Hermes Agent v0.21.5) rather than assumed from docs alone:
each message has `role` (`system`/`user`/`assistant`/`tool`/`developer`),
`content` (observed as a plain string; a list-of-text-parts shape is also
accepted defensively since other providers/configs commonly emit it),
`tool_calls`, `tool_call_id`, and a `timestamp` field holding a Unix epoch
float (not an ISO string) — converted to ISO 8601 UTC here for the CRM
payload. Re-verify against a real WhatsApp-sourced export before production
use, since no local WhatsApp session existed to confirm platform-specific
fields at implementation time (see README.md "Assumptions and risks").
"""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
import os
from datetime import datetime, timezone
from typing import Callable, Optional

SESSION_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]+$")

# Keys that may hold a per-message timestamp, checked in order. `timestamp`
# is the field observed on a real export; the rest are defensive fallbacks.
_TIMESTAMP_KEYS = ("timestamp", "ts", "created_at", "time")

# Roles that are never contact-visible.
_EXCLUDED_ROLES = {"system", "tool", "developer"}


class SessionExportError(RuntimeError):
    """Raised when a session cannot be exported or parsed."""


def _default_runner(session_id: str, timeout: float) -> str:
    """Invoke the real `hermes sessions export` CLI and return raw JSONL text.

    Uses a temp file (not stdout) and an argv list (no shell=True, no string
    interpolation) as required by the plan.
    """
    fd, tmp_path = tempfile.mkstemp(prefix="hermes-export-", suffix=".jsonl")
    os.close(fd)
    try:
        subprocess.run(
            ["hermes", "sessions", "export", tmp_path, "--session-id", session_id],
            check=True,
            capture_output=True,
            timeout=timeout,
        )
        with open(tmp_path, "r", encoding="utf-8") as handle:
            return handle.read()
    except FileNotFoundError as exc:
        raise SessionExportError("hermes CLI not found on PATH") from exc
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or b"").decode("utf-8", "replace").strip()
        raise SessionExportError(f"hermes sessions export failed: {stderr[:500]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise SessionExportError("hermes sessions export timed out") from exc
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass


def export_session(
    session_id: str,
    *,
    timeout: float = 30.0,
    runner: Optional[Callable[[str, float], str]] = None,
) -> dict:
    """Export one Hermes session and return its parsed JSON record.

    `runner` is an injectable seam for tests; it must return the raw JSONL
    text `hermes sessions export` would have written for a single session.
    """
    if not session_id or not SESSION_ID_PATTERN.match(session_id):
        raise SessionExportError("invalid or missing session_id")

    run = runner or _default_runner
    raw = run(session_id, timeout)

    lines = [line for line in raw.splitlines() if line.strip()]
    if not lines:
        raise SessionExportError(f"no export record returned for session {session_id}")

    try:
        record = json.loads(lines[0])
    except json.JSONDecodeError as exc:
        raise SessionExportError("could not parse hermes export output as JSON") from exc

    if not isinstance(record, dict):
        raise SessionExportError("unexpected hermes export record shape")

    return record


def _normalize_timestamp(value) -> str:
    """Render a raw timestamp value as ISO 8601 UTC.

    Real exports carry Unix epoch floats/ints; some tool/legacy paths may
    carry an already-formatted string. Anything that can't be interpreted as
    an epoch number is passed through unchanged rather than discarded, so we
    never silently drop a real timestamp we don't yet recognize.
    """
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            return str(value)
    return str(value)


def _message_timestamp(message: dict) -> str:
    for key in _TIMESTAMP_KEYS:
        value = message.get(key)
        if value:
            return _normalize_timestamp(value)
    return "unknown"


def _message_text(content) -> Optional[str]:
    """Return the visible text body of a message's content, or None if the
    message carries no visible text (e.g. a pure tool-call placeholder)."""
    if content is None:
        return None
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        # Common multi-part content shape: [{"type": "text", "text": "..."}]
        parts = []
        for part in content:
            if isinstance(part, dict) and part.get("type") in (None, "text"):
                text = part.get("text")
                if text is not None:
                    parts.append(text)
        if parts:
            return "".join(parts)
        return None
    return None


def extract_whatsapp_messages(export: dict, platform: str) -> list:
    """Return contact-visible WhatsApp messages from an exported session.

    Each returned record is {direction, speaker, body, timestamp, source_order}.
    Only inbound contact messages and outbound assistant final replies are
    included. System prompts, developer/tool roles, tool calls, and tool
    results are always excluded. Bodies and ordering are preserved exactly;
    missing timestamps are marked "unknown" rather than invented.
    """
    session_platform = export.get("source") or export.get("platform")
    if session_platform != platform:
        return []

    messages = export.get("messages") or []
    result = []

    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            continue

        role = message.get("role")
        if role in _EXCLUDED_ROLES:
            continue
        if role not in ("user", "assistant"):
            continue

        # Assistant messages that only carry tool calls (no visible reply)
        # are not contact-visible.
        if message.get("tool_calls"):
            continue
        if message.get("function_call"):
            continue

        body = _message_text(message.get("content"))
        if body is None:
            continue

        direction = "inbound" if role == "user" else "outbound"
        speaker = "contact" if direction == "inbound" else "andrew"

        result.append(
            {
                "direction": direction,
                "speaker": speaker,
                "body": body,
                "timestamp": _message_timestamp(message),
                "source_order": index,
            }
        )

    return result
