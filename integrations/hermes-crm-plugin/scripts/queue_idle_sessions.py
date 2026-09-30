#!/usr/bin/env python3
"""Entry point for the Hermes script-only (no-agent) 24-hour idle scan cron
job. See README.md for the `hermes cron create ... --no-agent --script`
registration. Prints a short, secret-free summary line and nothing else."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from idle_scan import queue_idle_sessions


def main() -> int:
    queued = queue_idle_sessions()
    print(f"queued {len(queued)} idle WhatsApp session segment(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
