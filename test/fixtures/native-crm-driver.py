"""Test-only stdin/stdout bridge to the actual CRM client and native adapter."""

import json
import sys
import urllib.parse

from crm_client import CRMClient
from native_delivery_state import NativeDeliveryState
from native_writeback import NativeWriteback


def main():
    request = json.load(sys.stdin)
    base_url = request.get("baseUrl", "")
    parsed = urllib.parse.urlparse(base_url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "localhost", "::1"} or not parsed.port:
        raise ValueError("test bridge only permits an explicit loopback HTTP server")
    client = CRMClient(base_url, request["apiKey"])
    state = NativeDeliveryState(request["statePath"])
    adapter = NativeWriteback(client, state, request["namespace"], request["account"], request["speaker"])
    result = adapter.apply(request["event"], request.get("binding"))
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Do not echo credentials, event bodies, server responses or tracebacks.
        sys.stderr.write(f"native CRM test driver failed ({type(exc).__name__})\n")
        raise SystemExit(1)
