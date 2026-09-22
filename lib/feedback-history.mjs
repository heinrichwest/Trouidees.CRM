import { randomUUID } from "node:crypto";

function cleanEntry(entry) {
  const text = String(entry?.text || "").trim().slice(0, 5_000);
  if (!text) return null;
  return {
    id: String(entry.id || randomUUID()),
    text,
    author: String(entry.author || "Unknown user").slice(0, 150),
    createdAt: String(entry.createdAt || new Date().toISOString()),
    status: String(entry.status || "").slice(0, 50),
  };
}

export function appendFeedbackHistory(lead, feedback, author, createdAt = new Date().toISOString()) {
  const history = (Array.isArray(lead.feedbackHistory) ? lead.feedbackHistory : []).map(cleanEntry).filter(Boolean);
  const legacy = String(lead.feedback || "").trim();
  if (legacy && !history.some((entry) => entry.text === legacy)) {
    history.push(cleanEntry({
      text: legacy,
      author: "Previous CRM entry",
      createdAt: lead.updatedAt || lead.createdAt || createdAt,
      status: lead.status,
    }));
  }
  const text = String(feedback || "").trim().slice(0, 5_000);
  if (text) history.push(cleanEntry({ text, author, createdAt, status: lead.status }));
  return history.slice(-200);
}
