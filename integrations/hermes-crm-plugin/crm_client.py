"""Standard-library HTTP client for the CRM agent write-back endpoint.

POST /api/agent/leads/:id/conversations
  body: {segmentId, channel, messages: [{direction, speaker, body, timestamp}],
         summary, idempotencyKey}

The CRM side (lib/agent-api.mjs) validates each message strictly:
direction must be exactly "incoming" or "outgoing", speaker must be exactly
"contact" or "andrew", and timestamp must be a valid ISO string or null.
Internally (outbox.py, session_export.py) this plugin keeps the more
descriptive "inbound"/"outbound" direction and the sentinel string
"unknown" for a missing timestamp; this module is the single place that
translates that internal shape into the CRM's exact wire contract, right
before the POST.

Reads no secrets from prompts or logs; the API key is only ever read from
environment variables that Hermes populates from its own secret
configuration (CRM_API_BASE_URL, CRM_AGENT_API_KEY). Never prints the key or
message bodies.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Optional

# lib/agent-store.mjs's updateLeadLimited allow-list, mirrored here so a
# disallowed or DNC-clearing field is rejected before any network call, not
# just by the CRM's own 400. doNotContact is a permitted key but agents may
# only ever set it true (lib/agent-api.mjs: "Andrew cannot clear DNC").
_UPDATE_ALLOWED_FIELDS = frozenset(
    {
        "status",
        "feedback",
        "nextFollowUpAt",
        "lastContactedAt",
        "doNotContact",
        "dncReason",
        "dncWording",
    }
)

# Internal direction -> exact CRM wire value. The extractor only ever
# produces these two internal values (session_export.extract_whatsapp_messages),
# so an unrecognized value is a bug upstream, not a legitimate input to smooth
# over silently.
_DIRECTION_TO_CRM = {
    "inbound": "incoming",
    "outbound": "outgoing",
}


def _to_crm_direction(direction: str) -> str:
    try:
        return _DIRECTION_TO_CRM[direction]
    except KeyError:
        raise ValueError(f"unknown message direction: {direction!r}") from None


def _to_crm_timestamp(timestamp) -> Optional[str]:
    """Missing or the "unknown" sentinel becomes JSON null; anything else
    (expected to already be ISO 8601, per session_export.py) passes through."""
    if timestamp is None or timestamp == "unknown":
        return None
    return timestamp


class CRMClientError(RuntimeError):
    """Base class for CRM client errors. Messages are always secret-free."""


class CRMAuthError(CRMClientError):
    """401/403 — invalid, revoked, or insufficiently scoped key. Not retryable
    automatically; needs operator action."""


class CRMValidationError(CRMClientError):
    """Other 4xx — bad request/payload. Not retryable automatically."""


class CRMTransientError(CRMClientError):
    """5xx or network/timeout failure. Safe to retry with the same
    idempotency key."""


class CRMClient:
    def __init__(self, base_url: str, api_key: str, timeout_seconds: float = 15.0):
        if not base_url:
            raise ValueError("base_url is required")
        if not api_key:
            raise ValueError("api_key is required")
        self.base_url = base_url.rstrip("/")
        self._api_key = api_key
        self.timeout_seconds = timeout_seconds

    def submit_conversation(
        self,
        lead_id: str,
        segment_id: str,
        messages: list,
        summary: str,
        idempotency_key: str,
    ) -> dict:
        if not lead_id:
            raise ValueError("lead_id is required")

        payload = {
            "segmentId": segment_id,
            "channel": "whatsapp",
            "messages": [
                {
                    "direction": _to_crm_direction(m["direction"]),
                    "speaker": m["speaker"],
                    "body": m["body"],
                    "timestamp": _to_crm_timestamp(m.get("timestamp")),
                }
                for m in messages
            ],
            "summary": summary,
            "idempotencyKey": idempotency_key,
        }

        url = f"{self.base_url}/api/agent/leads/{_quote_path_segment(lead_id)}/conversations"
        return self._request("POST", url, payload)

    def search_leads(
        self,
        query: Optional[str] = None,
        lead_type: Optional[str] = None,
        status: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> dict:
        """GET /api/agent/leads?q=&leadType=&status=&limit=&cursor= — a bounded
        search; each filter is only included when given, so an all-default call
        doesn't send an unbounded query."""
        params = []
        if query is not None:
            params.append(("q", query))
        if lead_type is not None:
            params.append(("leadType", lead_type))
        if status is not None:
            params.append(("status", status))
        if limit is not None:
            params.append(("limit", limit))
        if cursor is not None:
            params.append(("cursor", cursor))

        url = f"{self.base_url}/api/agent/leads"
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        return self._request("GET", url)

    def get_lead(self, lead_id: str) -> dict:
        if not lead_id:
            raise ValueError("lead_id is required")
        url = f"{self.base_url}/api/agent/leads/{_quote_path_segment(lead_id)}"
        return self._request("GET", url)

    def list_conversations(self, lead_id: str) -> dict:
        if not lead_id:
            raise ValueError("lead_id is required")
        url = f"{self.base_url}/api/agent/leads/{_quote_path_segment(lead_id)}/conversations"
        return self._request("GET", url)

    def assign_self(self, lead_id: str) -> dict:
        if not lead_id:
            raise ValueError("lead_id is required")
        url = f"{self.base_url}/api/agent/leads/{_quote_path_segment(lead_id)}/assign-self"
        return self._request("POST", url, {})

    def add_note(self, lead_id: str, body: str) -> dict:
        if not lead_id:
            raise ValueError("lead_id is required")
        url = f"{self.base_url}/api/agent/leads/{_quote_path_segment(lead_id)}/notes"
        return self._request("POST", url, {"body": body})

    def update_lead(self, lead_id: str, patch: dict) -> dict:
        """PATCH /api/agent/leads/:id, restricted to the fields
        lib/agent-store.mjs's updateLeadLimited accepts. Rejects locally,
        before any network call, both fields outside that allow-list (e.g. any
        owner/assignment field) and doNotContact=False, since only a human
        admin may clear DNC (lib/agent-api.mjs, lib/agent-store.mjs)."""
        if not lead_id:
            raise ValueError("lead_id is required")

        disallowed = sorted(set(patch) - _UPDATE_ALLOWED_FIELDS)
        if disallowed:
            raise ValueError(f"update_lead: field(s) not allowed: {disallowed}")
        if patch.get("doNotContact") is False:
            raise ValueError(
                "update_lead: doNotContact cannot be cleared by the agent; "
                "only a human administrator may clear DNC"
            )

        url = f"{self.base_url}/api/agent/leads/{_quote_path_segment(lead_id)}"
        return self._request("PATCH", url, patch)

    def _request(self, method: str, url: str, payload: Optional[dict] = None) -> dict:
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8") if payload is not None else None,
            method=method,
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                body = response.read().decode("utf-8")
                return json.loads(body) if body else {}
        except urllib.error.HTTPError as exc:
            status = exc.code
            reason = exc.reason or "HTTP error"
            if status in (401, 403):
                raise CRMAuthError(f"CRM rejected credentials ({status} {reason})") from exc
            if 400 <= status < 500:
                raise CRMValidationError(f"CRM rejected request ({status} {reason})") from exc
            raise CRMTransientError(f"CRM server error ({status} {reason})") from exc
        except urllib.error.URLError as exc:
            raise CRMTransientError(f"CRM network error ({exc.reason})") from exc
        except TimeoutError as exc:
            raise CRMTransientError("CRM request timed out") from exc


def _quote_path_segment(value: str) -> str:
    return urllib.parse.quote(str(value), safe="")

