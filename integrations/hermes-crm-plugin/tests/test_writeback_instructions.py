import os
import re
import unittest

SKILL_PATH = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "skills", "crm-writeback", "SKILL.md")
)


class WritebackSkillInstructionsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(SKILL_PATH, "r", encoding="utf-8") as handle:
            cls.text = handle.read()

    def test_requires_eligible_lead_ownership(self):
        lowered = self.text.lower()
        self.assertIn("own", lowered)
        self.assertIn("never write a conversation to a lead you do not own", lowered)

    def test_requires_all_visible_messages_verbatim(self):
        lowered = self.text.lower()
        self.assertIn("verbatim", lowered)
        self.assertRegex(lowered, r"never edit, reorder,\s+paraphrase, or drop")

    def test_requires_separate_summary(self):
        lowered = self.text.lower()
        self.assertIn("separate", lowered)
        self.assertIn("never replaces or edits the original", lowered)

    def test_excludes_internal_and_tool_content(self):
        lowered = self.text.lower()
        self.assertIn("system prompts, your internal reasoning, tool calls, and tool results", lowered)

    def test_requires_commit_after_each_completed_conversation(self):
        lowered = self.text.lower()
        self.assertIn("after each conversation you consider complete", lowered)
        self.assertIn("crm_commit_sync", lowered)

    def test_no_whatsapp_sending_instructed(self):
        lowered = self.text.lower()
        self.assertIn("you do not send whatsapp messages through this skill", lowered)

    def test_has_frontmatter_name_and_description(self):
        self.assertTrue(self.text.startswith("---\n"))
        self.assertIn("name: crm-writeback", self.text)
        self.assertIn("description:", self.text)


if __name__ == "__main__":
    unittest.main()
