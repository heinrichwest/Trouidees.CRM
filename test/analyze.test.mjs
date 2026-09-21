import test from "node:test";
import assert from "node:assert/strict";
import { buildDiscoveryReport, buildReport } from "../lib/analyze.mjs";

test("buildReport extracts public contact details and evidence signals", () => {
  const report = buildReport({
    input: {
      website: "https://example.co.za/",
      companyName: "Example Co",
      offering: "Training",
      maxPages: 8,
      includeSearch: false,
      useAgent: false,
    },
    crawlResult: {
      creditsUsed: 2,
      data: [{
        markdown: "# Example Co\nWe provide workforce training and skills development for growing teams.\nEmail sales@example.co.za or call +27 11 555 1234.",
        metadata: { title: "Example Co", description: "A South African workforce company serving growing teams.", sourceURL: "https://example.co.za/" },
      }],
    },
    warnings: [],
  });

  assert.equal(report.company.name, "Example Co");
  assert.equal(report.contacts[0].email, "sales@example.co.za");
  assert.ok(report.salesSignals.some((item) => item.signal === "Workforce training focus"));
  assert.equal(report.usage.pagesCrawled, 1);
  assert.ok(report.qualification.score > 20);
});

test("buildReport prefers structured Agent findings", () => {
  const report = buildReport({
    input: { website: "https://example.com/", companyName: "", offering: "", maxPages: 5 },
    crawlResult: { data: [], creditsUsed: 0 },
    agentResult: {
      creditsUsed: 5,
      data: {
        company: { name: "Agent Company", summary: "Verified summary", industries: ["Manufacturing"] },
        sales_signals: [{ signal: "Expansion", evidence: "New facility announced", source_url: "https://example.com/news" }],
        opportunities: [{ opportunity: "Onboarding", rationale: "New hiring", source_url: "https://example.com/jobs" }],
      },
    },
  });

  assert.equal(report.company.name, "Agent Company");
  assert.equal(report.salesSignals[0].signal, "Expansion");
  assert.equal(report.opportunities[0].opportunity, "Onboarding");
});

test("buildDiscoveryReport returns tutor leads with public contacts", () => {
  const report = buildDiscoveryReport({
    input: { mode: "discovery", searchQuery: "Tutors in South Africa", location: "South Africa", maxPages: 10, requestedFields: ["Name", "Phone numbers", "Email addresses"] },
    searchResult: { creditsUsed: 2, data: { web: [{ title: "Tutor One", url: "https://tutor.example/", description: "Maths tutor", markdown: "Contact info@tutor.example or +27 11 555 1234 for mathematics tutoring." }] } },
  });

  assert.equal(report.mode, "discovery");
  assert.equal(report.leads.length, 1);
  assert.equal(report.leads[0].email, "info@tutor.example");
  assert.equal(report.leads[0].phone, "+27 11 555 1234");
  assert.equal(report.qualification.score, 100);
});

test("buildDiscoveryReport excludes leads without email addresses", () => {
  const report = buildDiscoveryReport({
    input: { mode: "discovery", searchQuery: "Tutors", location: "South Africa", maxPages: 10, requestedFields: ["Name", "Email addresses"] },
    searchResult: { data: { web: [
      { title: "Email Tutor", url: "https://email.example/", markdown: "Email tutor@example.com" },
      { title: "Phone Only Tutor", url: "https://phone.example/", markdown: "Call +27 11 555 1234" },
    ] } },
  });

  assert.equal(report.leads.length, 1);
  assert.equal(report.leads[0].name, "Email Tutor");
});

test("education discovery splits staff pages into named professional contacts", () => {
  const report = buildDiscoveryReport({
    input: {
      mode: "discovery", searchQuery: "Teachers and headmasters", location: "Africa", unlimited: true,
      professionalEmailsOnly: true, individualEmailsOnly: true, englishSchoolsOnly: true,
      requestedFields: ["Name", "Role", "School name", "Email addresses", "Country", "Language", "School type"],
    },
    searchResult: { data: { web: [{
      title: "Faculty and Staff - Cape International School",
      url: "https://cape-school.co.za/staff",
      discoveryQuery: "teachers staff Cape Town",
      markdown: "English is the language of instruction.\n## Alice Mokoena\nMathematics Teacher\nalice.mokoena@cape-school.co.za\n## Office\nadmin@cape-school.co.za\nPersonal: alice.teacher@gmail.com",
    }] } },
  });

  assert.equal(report.leads.length, 1);
  assert.equal(report.leads[0].name, "Alice Mokoena");
  assert.equal(report.leads[0].role, "Teacher");
  assert.equal(report.leads[0].schoolName, "Cape International School");
  assert.equal(report.leads[0].country, "South Africa");
  assert.equal(report.leads[0].language, "English (confirmed)");
  assert.match(report.leads[0].schoolType, /International/);
});
