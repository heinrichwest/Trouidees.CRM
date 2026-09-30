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
import urllib.request
from typing import Optional

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

        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
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
    import urllib.parse as _p

    return _p.quote(str(value), safe="")
