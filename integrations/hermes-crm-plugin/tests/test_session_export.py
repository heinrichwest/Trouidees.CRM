import json
import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from session_export import export_session, extract_whatsapp_messages, SessionExportError


def _make_runner(payload):
    def runner(session_id, timeout):
        return json.dumps(payload) + "\n"

    return runner


class ExportSessionTests(unittest.TestCase):
    def test_invalid_session_id_rejected(self):
        with self.assertRaises(SessionExportError):
            export_session("")
        with self.assertRaises(SessionExportError):
            export_session("not a safe id; rm -rf")

    def test_parses_single_jsonl_record(self):
        record = {"session_id": "20260101_000000_abc123", "source": "whatsapp", "messages": []}
        result = export_session("20260101_000000_abc123", runner=_make_runner(record))
        self.assertEqual(result["session_id"], "20260101_000000_abc123")

    def test_empty_output_raises(self):
        def runner(session_id, timeout):
            return ""

        with self.assertRaises(SessionExportError):
            export_session("20260101_000000_abc123", runner=runner)

    def test_invalid_json_raises(self):
        def runner(session_id, timeout):
            return "not json\n"

        with self.assertRaises(SessionExportError):
            export_session("20260101_000000_abc123", runner=runner)


class ExtractWhatsappMessagesTests(unittest.TestCase):
    def test_inbound_and_outbound_visible_messages_kept_in_order(self):
        export = {
            "source": "whatsapp",
            "messages": [
                {"role": "system", "content": "You are Andrew."},
                {"role": "user", "content": "Hi, is this still available?"},
                {"role": "assistant", "content": None, "tool_calls": [{"name": "lookup_lead"}]},
                {"role": "tool", "content": "{\"lead\": 1}"},
                {"role": "assistant", "content": "Yes! It's still available."},
            ],
        }
        messages = extract_whatsapp_messages(export, platform="whatsapp")
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[0]["direction"], "inbound")
        self.assertEqual(messages[0]["speaker"], "contact")
        self.assertEqual(messages[0]["body"], "Hi, is this still available?")
        self.assertEqual(messages[0]["source_order"], 1)
        self.assertEqual(messages[1]["direction"], "outbound")
        self.assertEqual(messages[1]["speaker"], "andrew")
        self.assertEqual(messages[1]["body"], "Yes! It's still available.")
        self.assertEqual(messages[1]["source_order"], 4)

    def test_non_whatsapp_session_returns_no_transcript(self):
        export = {
            "source": "telegram",
            "messages": [{"role": "user", "content": "hello"}],
        }
        self.assertEqual(extract_whatsapp_messages(export, platform="whatsapp"), [])

    def test_system_and_tool_traffic_excluded(self):
        export = {
            "source": "whatsapp",
            "messages": [
                {"role": "system", "content": "sys prompt"},
                {"role": "tool", "content": "tool result", "name": "lookup_lead"},
                {"role": "developer", "content": "dev note"},
            ],
        }
        self.assertEqual(extract_whatsapp_messages(export, platform="whatsapp"), [])

    def test_unknown_timestamp_marked_unknown_and_present_timestamp_preserved(self):
        export = {
            "source": "whatsapp",
            "messages": [
                {"role": "user", "content": "no ts here"},
                {"role": "assistant", "content": "has ts", "timestamp": "2026-09-29T10:00:00Z"},
            ],
        }
        messages = extract_whatsapp_messages(export, platform="whatsapp")
        self.assertEqual(messages[0]["timestamp"], "unknown")
        self.assertEqual(messages[1]["timestamp"], "2026-09-29T10:00:00Z")

    def test_multiline_unicode_body_preserved_verbatim(self):
        body = "Line one\nLine two – café ☃️"
        export = {
            "source": "whatsapp",
            "messages": [{"role": "user", "content": body}],
        }
        messages = extract_whatsapp_messages(export, platform="whatsapp")
        self.assertEqual(messages[0]["body"], body)

    def test_epoch_timestamp_normalized_to_iso8601(self):
        export = {
            "source": "whatsapp",
            "messages": [{"role": "user", "content": "hi", "timestamp": 1790688828.4747572}],
        }
        messages = extract_whatsapp_messages(export, platform="whatsapp")
        self.assertEqual(messages[0]["timestamp"], "2026-09-29T13:33:48.474757+00:00")

    def test_multipart_content_text_joined(self):
        export = {
            "source": "whatsapp",
            "messages": [
                {
                    "role": "assistant",
                    "content": [
                        {"type": "text", "text": "Part one. "},
                        {"type": "text", "text": "Part two."},
                    ],
                }
            ],
        }
        messages = extract_whatsapp_messages(export, platform="whatsapp")
        self.assertEqual(messages[0]["body"], "Part one. Part two.")


if __name__ == "__main__":
    unittest.main()
