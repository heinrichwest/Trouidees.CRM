import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from native_delivery_state import NativeDeliveryState


class NativeDeliveryStateTests(unittest.TestCase):
    def test_binding_is_immutable_across_instances_and_applied_receipt_is_durable(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "delivery.sqlite3")
            state = NativeDeliveryState(path)
            first = state.bind("segment-1", {"lead_id": "lead-1", "body": "  Hello 🛰️\n"})
            self.assertEqual(first["body"], "  Hello 🛰️\n")
            restarted = NativeDeliveryState(path)
            self.assertEqual(restarted.bind("segment-1", first), first)
            with self.assertRaises(ValueError):
                restarted.bind("segment-1", {"lead_id": "lead-2", "body": "changed"})
            restarted.mark_applied("segment-1", "conversation-1")
            self.assertEqual(restarted.get("segment-1")["conversation_id"], "conversation-1")
            with self.assertRaises(ValueError):
                restarted.mark_applied("segment-1", "conversation-2")


if __name__ == "__main__":
    unittest.main()
