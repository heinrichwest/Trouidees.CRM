"""CRM credentials come from the serving profile's secret scope, not the process environment.

A multiplexing gateway never unions a profile's .env into os.environ, so a plugin that reads
os.environ finds nothing and every CRM tool fails with "must be configured".
"""

import os
import sys
import unittest
from unittest import mock

PLUGIN_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, PLUGIN_DIR)
import tools

try:
    from agent.secret_scope import reset_secret_scope, set_secret_scope
except ImportError:  # Hermes is not importable in a standalone checkout
    set_secret_scope = None

CRM_KEYS = ("CRM_API_BASE_URL", "CRM_AGENT_API_KEY", "CRM_API_TIMEOUT_SECONDS")


@unittest.skipIf(set_secret_scope is None, "needs Hermes on PYTHONPATH")
class ScopedCredentialsTest(unittest.TestCase):
    def setUp(self):
        for key in CRM_KEYS:
            patcher = mock.patch.dict(os.environ)
            patcher.start()
            self.addCleanup(patcher.stop)
            os.environ.pop(key, None)

    def test_build_client_reads_the_profile_scope(self):
        token = set_secret_scope({"CRM_API_BASE_URL": "https://crm.example", "CRM_AGENT_API_KEY": "scoped-key",
                                  "CRM_API_TIMEOUT_SECONDS": "7"})
        self.addCleanup(reset_secret_scope, token)

        client = tools._build_client()

        self.assertEqual(client.base_url, "https://crm.example")
        self.assertEqual(client._api_key, "scoped-key")
        self.assertEqual(client.timeout_seconds, 7.0)

    def test_missing_credentials_still_fail_clearly(self):
        token = set_secret_scope({})
        self.addCleanup(reset_secret_scope, token)

        with self.assertRaises(tools.CRMClientError):
            tools._build_client()


class StandaloneFallbackTest(unittest.TestCase):
    def test_without_hermes_the_environment_is_used(self):
        env = {"CRM_API_BASE_URL": "https://crm.example", "CRM_AGENT_API_KEY": "env-key"}
        with mock.patch.dict(os.environ, env), mock.patch.dict(sys.modules, {"agent.secret_scope": None}):
            client = tools._build_client()

        self.assertEqual(client._api_key, "env-key")


if __name__ == "__main__":
    unittest.main()
