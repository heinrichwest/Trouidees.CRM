import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { appendFeedbackHistory } from "./feedback-history.mjs";

export const CRM_STATUSES = ["New", "To contact", "Contacted", "Interested", "Follow-up", "Won", "Not interested"];
export const DEFAULT_LEAD_TYPES = ["Tutors", "Photographers", "Gift Sellers", "Education Contacts"];
let writeQueue = Promise.resolve();

const normalizeType = (value) => String(value || "").trim().replace(/\s+/g, " ").slice(0, 100);
const sameType = (left, right) => normalizeType(left).toLowerCase() === normalizeType(right).toLowerCase();

async function readLeads(filePath) {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function writeLeads(filePath, leads) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(leads, null, 2), "utf8");
}

async function readTypes(filePath) {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    return Array.isArray(value) ? value.map(normalizeType).filter(Boolean) : [...DEFAULT_LEAD_TYPES];
  } catch (error) {
    if (error.code === "ENOENT") return [...DEFAULT_LEAD_TYPES];
    throw error;
  }
}

async function writeTypes(filePath, types) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(types, null, 2), "utf8");
}

function uniqueTypes(types) {
  return types.reduce((result, type) => {
    const normalized = normalizeType(type);
    if (normalized && !result.some((item) => sameType(item, normalized))) result.push(normalized);
    return result;
  }, []);
}

export async function listCrmLeads(filePath) {
  return readLeads(filePath);
}

export async function listLeadTypes(typesFilePath, leadsFilePath) {
  const [storedTypes, leads] = await Promise.all([readTypes(typesFilePath), readLeads(leadsFilePath)]);
  return uniqueTypes([...storedTypes, ...leads.map((lead) => lead.leadType)])
    .map((name) => ({ name, count: leads.filter((lead) => sameType(lead.leadType, name)).length }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function addLeadType(typesFilePath, name) {
  const operation = writeQueue.then(async () => {
    const normalized = normalizeType(name);
    if (!normalized) throw new Error("Enter a lead type name.");
    const types = uniqueTypes(await readTypes(typesFilePath));
    if (!types.some((type) => sameType(type, normalized))) types.push(normalized);
    await writeTypes(typesFilePath, types);
    return normalized;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

export function renameLeadType(typesFilePath, leadsFilePath, oldName, newName) {
  const operation = writeQueue.then(async () => {
    const oldType = normalizeType(oldName);
    const newType = normalizeType(newName);
    if (!oldType || !newType) throw new Error("Both the current and new lead type are required.");
    const [storedTypes, leads] = await Promise.all([readTypes(typesFilePath), readLeads(leadsFilePath)]);
    const types = uniqueTypes([...storedTypes, ...leads.map((lead) => lead.leadType)]);
    if (!types.some((type) => sameType(type, oldType))) return null;
    if (!sameType(oldType, newType) && types.some((type) => sameType(type, newType))) {
      const error = new Error("That lead type already exists.");
      error.code = "TYPE_EXISTS";
      throw error;
    }
    const updatedTypes = uniqueTypes(types.map((type) => sameType(type, oldType) ? newType : type));
    const now = new Date().toISOString();
    for (const lead of leads) {
      if (sameType(lead.leadType, oldType)) {
        lead.leadType = newType;
        lead.updatedAt = now;
      }
    }
    await Promise.all([writeTypes(typesFilePath, updatedTypes), writeLeads(leadsFilePath, leads)]);
    return newType;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

export function deleteLeadType(typesFilePath, leadsFilePath, name) {
  const operation = writeQueue.then(async () => {
    const normalized = normalizeType(name);
    const [storedTypes, leads] = await Promise.all([readTypes(typesFilePath), readLeads(leadsFilePath)]);
    if (leads.some((lead) => sameType(lead.leadType, normalized))) {
      const error = new Error("Move or remove the leads in this type before deleting it.");
      error.code = "TYPE_IN_USE";
      throw error;
    }
    const types = uniqueTypes(storedTypes).filter((type) => !sameType(type, normalized));
    await writeTypes(typesFilePath, types);
    return types;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

export function importCrmLeads(filePath, sourceLeads, leadType, typesFilePath, options = {}) {
  const operation = writeQueue.then(async () => {
    const normalizedType = normalizeType(leadType);
    if (!normalizedType) throw new Error("Choose a lead type before saving.");
    const leads = await readLeads(filePath);
    let imported = 0;
    let skipped = 0;
    const now = new Date().toISOString();
    for (const source of sourceLeads) {
      const email = String(source.email || "").trim();
      const phone = String(source.phone || "").trim();
      const placeId = String(source.placeId || "").trim();
      if (options.requireEmail !== false && !email) { skipped += 1; continue; }
      if (options.requirePhone === true && !phone) { skipped += 1; continue; }
      if (!email && !phone && !String(source.website || "").trim()) { skipped += 1; continue; }
      const duplicate = leads.some((lead) => {
        if (!sameType(lead.leadType, normalizedType)) return false;
        if (placeId && String(lead.placeId || "") === placeId) return true;
        if (email && String(lead.email || "").toLowerCase() === email.toLowerCase()) return true;
        return !email && phone && String(lead.phone || "").replace(/\D/g, "") === phone.replace(/\D/g, "")
          && String(lead.name || "").toLowerCase() === String(source.name || "").toLowerCase();
      });
      if (duplicate) { skipped += 1; continue; }
      leads.push({
        id: randomUUID(), leadType: normalizedType, name: String(source.name || "Unnamed lead"), email,
        role: String(source.role || ""), organization: String(source.schoolName || source.organization || ""),
        phone, details: String(source.details || ""), location: String(source.location || ""), country: String(source.country || source.location || ""),
        language: String(source.language || ""), schoolType: String(source.schoolType || ""),
        services: String(source.subjectsServices || source.services || ""), website: String(source.website || ""), sourceUrl: String(source.sourceUrl || ""),
        placeId, googleMapsUrl: String(source.googleMapsUrl || ""), latitude: source.latitude ?? null, longitude: source.longitude ?? null,
        rating: source.rating ?? null, ratingCount: source.ratingCount ?? null, source: String(source.source || "Firecrawl"),
        status: "New", priority: "Normal", assignedTo: "", feedback: "", comments: "", lastContactedAt: "", nextFollowUpAt: "", createdAt: now, updatedAt: now,
      });
      imported += 1;
    }
    const writes = [writeLeads(filePath, leads)];
    if (typesFilePath) {
      const types = uniqueTypes([...(await readTypes(typesFilePath)), normalizedType]);
      writes.push(writeTypes(typesFilePath, types));
    }
    await Promise.all(writes);
    return { imported, skipped, total: leads.length };
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

export function updateCrmLead(filePath, id, changes) {
  const operation = writeQueue.then(async () => {
    const leads = await readLeads(filePath);
    const lead = leads.find((item) => item.id === id);
    if (!lead) return null;
    if (changes.leadType !== undefined) lead.leadType = String(changes.leadType).trim().slice(0, 100) || lead.leadType;
    if (changes.status !== undefined && CRM_STATUSES.includes(changes.status)) lead.status = changes.status;
    if (changes.priority !== undefined && ["Low", "Normal", "High", "Urgent"].includes(changes.priority)) lead.priority = changes.priority;
    if (changes.assignedTo !== undefined) lead.assignedTo = String(changes.assignedTo).trim().slice(0, 150);
    if (changes.services !== undefined) lead.services = String(changes.services).trim().slice(0, 5_000);
    if (changes.comments !== undefined) lead.comments = String(changes.comments).slice(0, 5_000);
    if (changes.lastContactedAt !== undefined) lead.lastContactedAt = String(changes.lastContactedAt).slice(0, 10);
    if (changes.nextFollowUpAt !== undefined) lead.nextFollowUpAt = String(changes.nextFollowUpAt).slice(0, 10);
    const updatedAt = new Date().toISOString();
    const feedbackEntry = changes.feedbackEntry !== undefined ? changes.feedbackEntry : changes.feedback;
    if (String(feedbackEntry || "").trim()) {
      lead.feedbackHistory = appendFeedbackHistory(lead, feedbackEntry, changes.feedbackAuthor, updatedAt);
      lead.feedback = String(feedbackEntry).trim().slice(0, 5_000);
    }
    lead.updatedAt = updatedAt;
    await writeLeads(filePath, leads);
    return lead;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

export function deleteCrmLead(filePath, id) {
  const operation = writeQueue.then(async () => {
    const leads = await readLeads(filePath);
    const index = leads.findIndex((item) => item.id === id);
    if (index < 0) return false;
    leads.splice(index, 1);
    await writeLeads(filePath, leads);
    return true;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}
