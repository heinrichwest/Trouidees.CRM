"""JSON tool schemas exposed to the Hermes LLM loop.

Handlers live in tools.py. Keeping schemas separate mirrors the layout the
Hermes plugin-development guide shows (schemas.py for definitions, tools.py
for implementations).
"""

CRM_PENDING_SYNCS_SCHEMA = {
    "name": "crm_pending_syncs",
    "description": (
        "List WhatsApp conversation segments queued in the local outbox that "
        "are waiting for CRM write-back. Returns each segment's exact, "
        "verbatim, ordered messages so the agent can write a factual summary. "
        "Never edit or fabricate the returned message bodies."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "limit": {
                "type": "number",
                "description": "Maximum number of pending segments to return. Defaults to 25.",
            }
        },
        "required": [],
    },
}

CRM_QUEUE_SESSION_SCHEMA = {
    "name": "crm_queue_session",
    "description": (
        "Explicitly queue the current (or named) WhatsApp session's visible "
        "transcript into the local durable outbox for later CRM write-back. "
        "Use this once a conversation is clearly finished, in addition to the "
        "automatic close/idle triggers. This only writes to local storage; it "
        "never contacts the CRM."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "session_id": {
                "type": "string",
                "description": "The Hermes session ID to queue.",
            },
            "reason": {
                "type": "string",
                "description": "Why the session is being queued now, e.g. 'close'.",
            },
        },
        "required": ["session_id"],
    },
}

CRM_COMMIT_SYNC_SCHEMA = {
    "name": "crm_commit_sync",
    "description": (
        "Submit a pending outbox segment's exact original messages plus a "
        "separately generated factual summary to the CRM for the given lead. "
        "lead_id must be a lead Andrew already owns. Marks the segment synced "
        "only after the CRM confirms; safe to retry on transient failure."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "segment_id": {
                "type": "string",
                "description": "The outbox segment ID returned by crm_pending_syncs or crm_queue_session.",
            },
            "lead_id": {
                "type": "string",
                "description": "The CRM lead ID Andrew owns that this conversation belongs to.",
            },
            "summary": {
                "type": "string",
                "description": (
                    "A separate, factual summary of the exchange. Must not "
                    "replace or alter the original messages."
                ),
            },
        },
        "required": ["segment_id", "lead_id", "summary"],
    },
}

CRM_SEARCH_LEADS_SCHEMA = {
    "name": "crm_search_leads",
    "description": (
        "Search the leads Andrew may work on: unassigned leads and leads already "
        "assigned to Andrew. A phone search can return an ambiguity response; "
        "when it does, use the returned candidate IDs to inspect matches and do "
        "not choose one without confirming which contact is intended."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Name, phone number, email, or other lead text. May be empty to browse."},
            "lead_type": {"type": "string", "description": "Optional lead type filter."},
            "status": {"type": "string", "description": "Optional status filter."},
            "limit": {"type": "integer", "description": "Page size from 1 to 100. Defaults to 25."},
            "cursor": {"type": "string", "description": "Opaque pagination cursor returned by a prior search. Defaults to 0."},
        },
        "required": [],
        "additionalProperties": False,
    },
}

CRM_GET_LEAD_SCHEMA = {
    "name": "crm_get_lead",
    "description": "Read one lead's contact and lead details by its CRM lead ID.",
    "parameters": {"type": "object", "properties": {
        "lead_id": {"type": "string", "description": "CRM lead ID."},
    }, "required": ["lead_id"], "additionalProperties": False},
}

CRM_GET_CONVERSATIONS_SCHEMA = {
    "name": "crm_get_conversations",
    "description": "Read the stored WhatsApp conversation messages and summaries for a lead assigned to Andrew.",
    "parameters": {"type": "object", "properties": {
        "lead_id": {"type": "string", "description": "CRM lead ID."},
    }, "required": ["lead_id"], "additionalProperties": False},
}

CRM_ASSIGN_SELF_SCHEMA = {
    "name": "crm_assign_self",
    "description": "Assign an unassigned lead to Andrew. This cannot reassign a lead owned by someone else.",
    "parameters": {"type": "object", "properties": {
        "lead_id": {"type": "string", "description": "CRM lead ID."},
    }, "required": ["lead_id"], "additionalProperties": False},
}

CRM_ADD_NOTE_SCHEMA = {
    "name": "crm_add_note",
    "description": "Add an internal note to a lead. Use for an agent note, not the conversation transcript.",
    "parameters": {"type": "object", "properties": {
        "lead_id": {"type": "string", "description": "CRM lead ID."},
        "body": {"type": "string", "description": "Internal note text."},
    }, "required": ["lead_id", "body"], "additionalProperties": False},
}

CRM_UPDATE_LEAD_SCHEMA = {
    "name": "crm_update_lead",
    "description": (
        "Update supported lead fields for a lead assigned to Andrew. Allowed fields are "
        "status, feedback, comments, nextFollowUpAt, lastContactedAt, doNotContact, dncReason, "
        "and dncWording. Andrew may set doNotContact true but cannot clear it."
    ),
    "parameters": {"type": "object", "properties": {
        "lead_id": {"type": "string", "description": "CRM lead ID."},
        "fields": {"type": "object", "properties": {
            "status": {"type": "string"},
            "feedback": {"type": "string"},
            "comments": {"type": "string", "description": "Internal comments or next action, up to 5000 characters."},
            "nextFollowUpAt": {"type": "string"},
            "lastContactedAt": {"type": "string"},
            "doNotContact": {"type": "boolean"},
            "dncReason": {"type": "string"},
            "dncWording": {"type": "string"},
        }, "additionalProperties": False},
    }, "required": ["lead_id", "fields"], "additionalProperties": False},
}

