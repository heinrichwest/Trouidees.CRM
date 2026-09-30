import importlib.util
import os
import sys
import unittest
from unittest import mock

PLUGIN_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, PLUGIN_DIR)


def _load_plugin_init():
    """Load the plugin's __init__.py directly by file path.

    The plugin directory name (hermes-crm-plugin) contains a hyphen, so it
    cannot be imported as a normal dotted Python package; this mirrors how
    Hermes's own plugin loader would load it (by path, not by package name).
    """
    spec = importlib.util.spec_from_file_location(
        "trouidees_crm_writeback_plugin", os.path.join(PLUGIN_DIR, "__init__.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeContext:
    def __init__(self):
        self.tools = {}
        self.hooks = {}
        self.skills = {}

    def register_tool(self, name, toolset, schema, handler, **kwargs):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, **kwargs}

    def register_hook(self, name, callback):
        self.hooks[name] = callback

    def register_skill(self, name, path):
        self.skills[name] = path


class PluginManifestTests(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(PLUGIN_DIR, "plugin.yaml"), "r", encoding="utf-8") as handle:
            self.manifest_text = handle.read()

    def test_declares_required_metadata(self):
        self.assertIn("name: trouidees-crm-writeback", self.manifest_text)
        self.assertIn("version:", self.manifest_text)
        self.assertIn("description:", self.manifest_text)

    def test_declares_exact_tool_and_hook_names(self):
        for tool_name in ("crm_pending_syncs", "crm_queue_session", "crm_commit_sync"):
            self.assertIn(f"- {tool_name}", self.manifest_text)
        self.assertIn("- on_session_finalize", self.manifest_text)

    def test_declares_required_env_vars_without_secret_values(self):
        self.assertIn("CRM_API_BASE_URL", self.manifest_text)
        self.assertIn("CRM_AGENT_API_KEY", self.manifest_text)
        self.assertNotRegex(self.manifest_text, r"CRM_AGENT_API_KEY:\s*['\"]?sk-")


class PluginRegistrationTests(unittest.TestCase):
    def setUp(self):
        self.plugin = _load_plugin_init()
        self.ctx = FakeContext()
        self.plugin.register(self.ctx)

    def test_registers_exact_tool_names(self):
        self.assertEqual(set(self.ctx.tools.keys()), {"crm_pending_syncs", "crm_queue_session", "crm_commit_sync"})

    def test_registers_on_session_finalize_hook(self):
        self.assertIn("on_session_finalize", self.ctx.hooks)

    def test_each_tool_has_a_callable_handler_and_schema(self):
        for name, registration in self.ctx.tools.items():
            self.assertTrue(callable(registration["handler"]))
            self.assertEqual(registration["schema"]["name"], name)
            self.assertIn("parameters", registration["schema"])


class SessionFinalizeHookTests(unittest.TestCase):
    def setUp(self):
        self.plugin = _load_plugin_init()

    def test_noops_on_missing_session_id(self):
        with mock.patch.object(self.plugin.tools, "queue_closed_session") as spy:
            self.plugin.on_session_finalize(session_id=None, platform="whatsapp")
            self.plugin.on_session_finalize(platform="whatsapp")
        spy.assert_not_called()

    def test_noops_on_unsupported_platform(self):
        with mock.patch.object(self.plugin.tools, "queue_closed_session") as spy:
            self.plugin.on_session_finalize(session_id="20260101_000000_abc", platform="telegram")
        spy.assert_not_called()

    def test_queues_whatsapp_session_locally(self):
        with mock.patch.object(self.plugin.tools, "queue_closed_session") as spy:
            self.plugin.on_session_finalize(session_id="20260101_000000_abc", platform="whatsapp", reason="close")
        spy.assert_called_once_with("20260101_000000_abc", reason="close")

    def test_extra_kwargs_do_not_raise(self):
        with mock.patch.object(self.plugin.tools, "queue_closed_session"):
            # Must not raise even with unexpected/forward-compatible kwargs.
            self.plugin.on_session_finalize(
                session_id="20260101_000000_abc",
                platform="whatsapp",
                old_session_id="prev",
                new_session_id="20260101_000000_abc",
                reason="reset",
            )

    def test_export_failure_does_not_raise_out_of_hook(self):
        with mock.patch.object(self.plugin.tools, "queue_closed_session", side_effect=RuntimeError("export failed")):
            try:
                self.plugin.on_session_finalize(session_id="20260101_000000_abc", platform="whatsapp")
            except Exception as exc:  # pragma: no cover - failure path
                self.fail(f"hook raised unexpectedly: {exc}")


if __name__ == "__main__":
    unittest.main()
