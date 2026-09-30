"""Hermes plugin entry point.

register(ctx) is called by Hermes's plugin loader. Per the plugin
development guide, the plugin directory is a flat set of top-level modules
(plugin.yaml, __init__.py, schemas.py, tools.py, ...); sibling modules import
each other as plain top-level names, not as a dotted package.
"""

import os

try:
    # Hermes's plugin loader imports this file as part of a real Python
    # package (confirmed via `hermes plugins doctor`), so relative imports
    # are required there.
    from . import schemas
    from . import tools
except ImportError:
    # Our own unit tests and the standalone idle-scan script load these
    # modules as flat top-level modules (via sys.path), where a relative
    # import has no parent package to resolve against.
    import schemas
    import tools

PLUGIN_NAME = "trouidees-crm-writeback"


def on_session_finalize(session_id=None, platform=None, **kwargs):
    """Session lifecycle hook. Per the hooks guide, on_session_finalize fires
    during CLI/gateway teardown with `session_id: str | None, platform: str,
    **kwargs`. This must no-op on an absent session_id or an unsupported
    (non-WhatsApp) platform, and must stay local-only: it queues the closed
    session into the SQLite outbox and never makes a network or LLM call.
    """
    if not session_id or platform != "whatsapp":
        return
    try:
        tools.queue_closed_session(session_id, reason="close")
    except Exception:
        # Hook callbacks must never raise into Hermes's teardown path; a
        # failed export here is recoverable by the 24-hour idle scanner or a
        # manual crm_queue_session call.
        return


def register(ctx) -> None:
    ctx.register_tool(
        name="crm_pending_syncs",
        toolset="crm_writeback",
        schema=schemas.CRM_PENDING_SYNCS_SCHEMA,
        handler=tools.crm_pending_syncs,
    )
    ctx.register_tool(
        name="crm_queue_session",
        toolset="crm_writeback",
        schema=schemas.CRM_QUEUE_SESSION_SCHEMA,
        handler=tools.crm_queue_session,
    )
    ctx.register_tool(
        name="crm_commit_sync",
        toolset="crm_writeback",
        schema=schemas.CRM_COMMIT_SYNC_SCHEMA,
        handler=tools.crm_commit_sync,
    )
    for schema_name, schema_attr, handler_name in (
        ("crm_search_leads", "CRM_SEARCH_LEADS_SCHEMA", "crm_search_leads"),
        ("crm_get_lead", "CRM_GET_LEAD_SCHEMA", "crm_get_lead"),
        ("crm_get_conversations", "CRM_GET_CONVERSATIONS_SCHEMA", "crm_get_conversations"),
        ("crm_assign_self", "CRM_ASSIGN_SELF_SCHEMA", "crm_assign_self"),
        ("crm_add_note", "CRM_ADD_NOTE_SCHEMA", "crm_add_note"),
        ("crm_update_lead", "CRM_UPDATE_LEAD_SCHEMA", "crm_update_lead"),
    ):
        ctx.register_tool(
            name=schema_name,
            toolset="crm_writeback",
            schema=getattr(schemas, schema_attr),
            handler=getattr(tools, handler_name),
        )
    ctx.register_hook("on_session_finalize", on_session_finalize)

    skill_path = os.path.join(os.path.dirname(__file__), "skills", "crm-writeback", "SKILL.md")
    if hasattr(ctx, "register_skill"):
        ctx.register_skill("crm-writeback", skill_path)

