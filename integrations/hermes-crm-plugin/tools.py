"""Hermes tool handlers for the CRM write-back plugin.

crm_pending_syncs and crm_queue_session are local-only: they read/write the
SQLite outbox and, for queueing, call the supported session export, but they
never contact the CRM and never require an LLM turn to be useful. Only
crm_commit_sync talks to the network, and only after the LLM has produced a
separate summary — code copies the original messages, the LLM only supplies
the summary text, matching the spec's "code copies session-log messages
while the LLM generates only the summary" requirement.

crm_commit_sync binds the first lead_id/summary it is given for a segment
via Outbox.prepare_sync_payload before making any network request, and
reuses that bound pair on every later call for the same segment_id. This
keeps a retry (after a timeout or transient failure) from submitting a
different payload than the one the CRM may have already accepted under the
same idempotency key.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Callable, Optional

try:
    # Real Hermes plugin loading (package-relative); see __init__.py.
    from .outbox import Outbox, STATUS_SYNCED
    from .session_export import export_session, extract_whatsapp_messages, SessionExportError
    from .crm_client import (
        CRMClient,
        CRMClientError,
        CRMAuthError,
        CRMValidationError,
        CRMTransientError,
    )
except ImportError:
    # Flat top-level loading (unit tests, standalone scripts).
    from outbox import Outbox, STATUS_SYNCED
    from session_export import export_session, extract_whatsapp_messages, SessionExportError
    from crm_client import (
        CRMClient,
        CRMClientError,
        CRMAuthError,
        CRMValidationError,
        CRMTransientError,
    )

_outbox_singleton: Optional[Outbox] = None


def _get_outbox() -> Outbox:
    global _outbox_singleton
    if _outbox_singleton is None:
        _outbox_singleton = Outbox()
    return _outbox_singleton


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def queue_closed_session(
    session_id: str,
    reason: str = "close",
    outbox: Optional[Outbox] = None,
    export_fn: Optional[Callable[[str], dict]] = None,
) -> Optional[str]:
    """Shared, local-only queuing logic used by both the on_session_finalize
    hook and the crm_queue_session tool. Returns the segment_id, or None if
    there was nothing new to queue.

    `hermes sessions export` returns a session's full history every time, so
    this goes through Outbox.queue_new_messages (the same entry point the
    24-hour idle scanner uses) rather than queue_segment directly: if this
    session already has a queued segment (from an earlier explicit close, or
    from an idle-timeout capture), only messages after that segment's
    boundary are queued here. A session closing for the first time, or
    closing with nothing new since its last capture, is handled the same way
    regardless of which trigger (idle vs. explicit close) saw it last.
    """
    export = (export_fn or export_session)(session_id)
    messages = extract_whatsapp_messages(export, platform="whatsapp")
    if not messages:
        return None
    box = outbox or _get_outbox()
    return box.queue_new_messages(session_id=session_id, messages=messages, closed_at=_now_iso(), reason=reason)


def crm_pending_syncs(args: dict, **kwargs) -> str:
    limit = int(args.get("limit") or 25)
    box = _get_outbox()
    segments = box.list_pending(limit=limit)
    return json.dumps(
        {
            "segments": [
                {
                    "segment_id": segment["segment_id"],
                    "session_id": segment["session_id"],
                    "reason": segment["reason"],
                    "closed_at": segment["closed_at"],
                    "messages": segment["messages"],
                }
                for segment in segments
            ]
        }
    )


def crm_queue_session(args: dict, **kwargs) -> str:
    session_id = args.get("session_id")
    if not session_id:
        return json.dumps({"queued": False, "error": "session_id is required"})

    reason = args.get("reason") or "manual"
    try:
        segment_id = queue_closed_session(session_id, reason=reason)
    except SessionExportError as exc:
        return json.dumps({"queued": False, "error": str(exc)})

    if segment_id is None:
        return json.dumps({"queued": False, "reason": "no visible WhatsApp messages in session"})
    return json.dumps({"queued": True, "segment_id": segment_id})


def _build_client() -> CRMClient:
    base_url = os.environ.get("CRM_API_BASE_URL")
    api_key = os.environ.get("CRM_AGENT_API_KEY")
    if not base_url or not api_key:
        raise CRMClientError("CRM_API_BASE_URL and CRM_AGENT_API_KEY must be configured")
    timeout_seconds = float(os.environ.get("CRM_API_TIMEOUT_SECONDS", "15"))
    return CRMClient(base_url, api_key, timeout_seconds=timeout_seconds)


def crm_commit_sync(args: dict, client: Optional[CRMClient] = None, outbox: Optional[Outbox] = None, **kwargs) -> str:
    segment_id = args.get("segment_id")
    lead_id = args.get("lead_id")
    summary = args.get("summary")
    if not segment_id or not lead_id or not summary:
        return json.dumps({"committed": False, "error": "segment_id, lead_id, and summary are required"})

    box = outbox or _get_outbox()
    segment = box.get_segment(segment_id)
    if segment is None:
        return json.dumps({"committed": False, "error": "unknown segment_id"})

    if segment["status"] == STATUS_SYNCED:
        # Idempotent: never re-submit an already-confirmed segment.
        return json.dumps({"committed": True, "conversation_id": segment["remote_conversation_id"]})

    # Bind the first lead_id/summary submitted for this segment before any
    # network request. If this call is a retry after a prior attempt already
    # bound different values (e.g. the LLM regenerated the summary, or
    # picked a different lead), those original bound values are used
    # instead of the ones just passed in — a retry always submits exactly
    # what the CRM already saw, so a timeout-after-accept can be safely
    # replayed without a same-idempotency-key conflict or landing on a
    # different lead.
    try:
        bound = box.prepare_sync_payload(segment_id, lead_id=lead_id, summary=summary)
    except ValueError as exc:
        # In particular, migrated legacy retry rows have no reliable way to
        # recover the original remote target/payload. Keep them quarantined
        # and make sure this call cannot fall through to the CRM client.
        return json.dumps({"committed": False, "error": str(exc), "retryable": False})
    bound_lead_id = bound["lead_id"]
    bound_summary = bound["summary"]

    box.mark_syncing(segment_id)

    try:
        crm = client or _build_client()
    except CRMClientError as exc:
        box.mark_retry(segment_id, str(exc))
        return json.dumps({"committed": False, "error": str(exc), "retryable": True})

    try:
        response = crm.submit_conversation(
            lead_id=bound_lead_id,
            segment_id=segment_id,
            messages=segment["messages"],
            summary=bound_summary,
            idempotency_key=segment_id,
        )
    except (CRMAuthError, CRMValidationError) as exc:
        box.mark_failed(segment_id, str(exc))
        return json.dumps({"committed": False, "error": str(exc), "retryable": False})
    except CRMTransientError as exc:
        box.mark_retry(segment_id, str(exc))
        return json.dumps({"committed": False, "error": str(exc), "retryable": True})

    conversation_id = (
        response.get("conversationId")
        or response.get("id")
        or (response.get("conversation") or {}).get("id")
        or segment_id
    )
    box.mark_synced(segment_id, conversation_id)
    return json.dumps({"committed": True, "conversation_id": conversation_id})


_UPDATE_FIELDS = {
    "status": 150,
    "feedback": 5000,
    "nextFollowUpAt": 150,
    "lastContactedAt": 150,
    "doNotContact": None,
    "dncReason": 2000,
    "dncWording": 5000,
}


def _tool_json(value: dict) -> str:
    return json.dumps(value, ensure_ascii=False)


def _tool_error(exc: Exception) -> str:
    # CRMClient errors are constructed from status/reason only and never include
    # request headers or bodies. Do not echo arbitrary exception text: it can
    # contain credentials or customer message content from an unexpected layer.
    if isinstance(exc, CRMClientError):
        return _tool_json({"error": str(exc)})
    return _tool_json({"error": "CRM request failed."})


def _required_text(args: dict, key: str) -> Optional[str]:
    value = args.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else None


def crm_search_leads(args: dict, client: Optional[CRMClient] = None, **kwargs) -> str:
    args = args if isinstance(args, dict) else {}
    query = args.get("query", "")
    lead_type = args.get("lead_type")
    status = args.get("status")
    limit = args.get("limit", 25)
    cursor = args.get("cursor", "0")
    if not isinstance(query, str) or len(query) > 200:
        return _tool_json({"error": "query must be a string of at most 200 characters."})
    if any(value is not None and (not isinstance(value, str) or len(value) > 100) for value in (lead_type, status)):
        return _tool_json({"error": "lead_type and status must be strings of at most 100 characters."})
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 100:
        return _tool_json({"error": "limit must be an integer from 1 to 100."})
    if not isinstance(cursor, str) or not cursor.isdigit() or len(cursor) > 7:
        return _tool_json({"error": "cursor must be a numeric pagination cursor."})
    try:
        return _tool_json((client or _build_client()).search_leads(
            query=query, lead_type=lead_type, status=status, limit=limit, cursor=cursor,
        ))
    except Exception as exc:
        return _tool_error(exc)


def crm_get_lead(args: dict, client: Optional[CRMClient] = None, **kwargs) -> str:
    args = args if isinstance(args, dict) else {}
    lead_id = _required_text(args, "lead_id")
    if not lead_id:
        return _tool_json({"error": "lead_id is required."})
    try:
        return _tool_json((client or _build_client()).get_lead(lead_id))
    except Exception as exc:
        return _tool_error(exc)


def crm_get_conversations(args: dict, client: Optional[CRMClient] = None, **kwargs) -> str:
    args = args if isinstance(args, dict) else {}
    lead_id = _required_text(args, "lead_id")
    if not lead_id:
        return _tool_json({"error": "lead_id is required."})
    try:
        return _tool_json((client or _build_client()).list_conversations(lead_id))
    except Exception as exc:
        return _tool_error(exc)


def crm_assign_self(args: dict, client: Optional[CRMClient] = None, **kwargs) -> str:
    args = args if isinstance(args, dict) else {}
    lead_id = _required_text(args, "lead_id")
    if not lead_id:
        return _tool_json({"error": "lead_id is required."})
    try:
        return _tool_json((client or _build_client()).assign_self(lead_id))
    except Exception as exc:
        return _tool_error(exc)


def crm_add_note(args: dict, client: Optional[CRMClient] = None, **kwargs) -> str:
    args = args if isinstance(args, dict) else {}
    lead_id = _required_text(args, "lead_id")
    body = args.get("body")
    if not lead_id:
        return _tool_json({"error": "lead_id is required."})
    if not isinstance(body, str) or not body.strip() or len(body) > 10_000:
        return _tool_json({"error": "body is required and must be at most 10000 characters."})
    try:
        return _tool_json((client or _build_client()).add_note(lead_id, body))
    except Exception as exc:
        return _tool_error(exc)


def crm_update_lead(args: dict, client: Optional[CRMClient] = None, **kwargs) -> str:
    args = args if isinstance(args, dict) else {}
    lead_id = _required_text(args, "lead_id")
    fields = args.get("fields")
    if not lead_id:
        return _tool_json({"error": "lead_id is required."})
    if not isinstance(fields, dict) or not fields:
        return _tool_json({"error": "fields must be a non-empty object."})
    if any(key not in _UPDATE_FIELDS for key in fields):
        return _tool_json({"error": "Unsupported lead update field."})
    for key, maximum in _UPDATE_FIELDS.items():
        if key not in fields:
            continue
        value = fields[key]
        if maximum is None:
            if not isinstance(value, bool):
                return _tool_json({"error": "doNotContact must be a boolean."})
            if value is False:
                return _tool_json({"error": "Andrew cannot clear do-not-contact."})
        elif not isinstance(value, str) or len(value) > maximum:
            return _tool_json({"error": f"{key} must be a string of at most {maximum} characters."})
    try:
        return _tool_json((client or _build_client()).update_lead(lead_id, fields))
    except Exception as exc:
        return _tool_error(exc)

