"""Durable immutable bindings for confirmed native delivery outcomes."""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing


class NativeDeliveryState:
    def __init__(self, path: str):
        if not path:
            raise ValueError("state path is required")
        self.path = path
        with closing(self._connect()) as conn, conn:
            conn.execute("""CREATE TABLE IF NOT EXISTS native_deliveries (
                segment_id TEXT PRIMARY KEY,
                payload TEXT NOT NULL,
                conversation_id TEXT,
                applied_at TEXT
            )""")

    def _connect(self):
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        return conn

    def bind(self, segment_id: str, payload: dict) -> dict:
        if not isinstance(segment_id, str) or not segment_id.strip() or not isinstance(payload, dict):
            raise ValueError("segment ID and binding payload are required")
        encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        with closing(self._connect()) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT payload FROM native_deliveries WHERE segment_id=?", (segment_id,)).fetchone()
            if row is None:
                conn.execute("INSERT INTO native_deliveries(segment_id,payload) VALUES(?,?)", (segment_id, encoded))
                return json.loads(encoded)
            if row["payload"] != encoded:
                raise ValueError("native delivery identity is already bound to different content")
            return json.loads(row["payload"])

    def mark_applied(self, segment_id: str, conversation_id: str) -> None:
        if not conversation_id:
            raise ValueError("conversation ID is required")
        with closing(self._connect()) as conn, conn:
            cursor = conn.execute(
                "UPDATE native_deliveries SET conversation_id=?, applied_at=COALESCE(applied_at,CURRENT_TIMESTAMP) WHERE segment_id=?",
                (conversation_id, segment_id),
            )
            if cursor.rowcount != 1:
                raise KeyError("native delivery binding does not exist")

    def get(self, segment_id: str):
        with closing(self._connect()) as conn:
            row = conn.execute("SELECT payload,conversation_id,applied_at FROM native_deliveries WHERE segment_id=?", (segment_id,)).fetchone()
        if row is None:
            return None
        result = json.loads(row["payload"])
        result["conversation_id"] = row["conversation_id"]
        result["applied_at"] = row["applied_at"]
        return result
