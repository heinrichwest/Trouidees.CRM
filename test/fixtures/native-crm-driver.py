"""Test-only stdin/stdout bridge to the actual CRM client and native adapter."""

import json
import os
import sys
import urllib.parse
from datetime import datetime
from pathlib import Path

from crm_client import CRMClient
from native_delivery_state import NativeDeliveryState
from native_writeback import NativeWriteback


def main():
    request = json.load(sys.stdin)
    base_url = request.get("baseUrl", "")
    parsed = urllib.parse.urlparse(base_url)
    if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1"} or not parsed.port:
        raise ValueError("test bridge only permits an explicit loopback HTTP server")
    if request.get("mode") == "sync_no_reply":
        sales_root = os.environ.get("SALES_OPS_SOURCE_ROOT")
        if not sales_root:
            raise ValueError("SALES_OPS_SOURCE_ROOT is required for reporting acceptance")
        sys.path.insert(0, sales_root)
        from reporting.no_reply import sync_no_reply
        from reporting.pipeline import Deployment, TZ, open_ledger

        profile = Path(request["profile"])
        dep = Deployment(profile, request["agent"], "Test Manager", "Test Product", set(), set(), set(),
                         Path(os.environ["CRM_PLUGIN_SOURCE_ROOT"]))
        conn = open_ledger(dep)
        try:
            now = datetime.fromisoformat(request["now"]).astimezone(TZ)
            result = sync_no_reply(dep, CRMClient(base_url, request["apiKey"]), conn, now, write=True)
            details = result.get("details") or []
            phone = details[0].get("phone") if details else None
            row = conn.execute("SELECT outcome,crm_outcome_id FROM conversations WHERE agent=? AND phone=?",
                               (dep.agent_name, phone)).fetchone() if phone else None
            report_outcome = dict(row) if row else None
        finally:
            conn.close()
        sys.stdout.write(json.dumps({"result": result, "reportOutcome": report_outcome}, ensure_ascii=False, separators=(",", ":")))
        return
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
