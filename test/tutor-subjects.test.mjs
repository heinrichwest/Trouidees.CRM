import test from "node:test";
import assert from "node:assert/strict";
import { extractTutorSubjects, htmlToText, relevantWebsiteLinks } from "../lib/tutor-subjects.mjs";

test("extracts tutor subjects only when academic context is present", () => {
  const text = htmlToText("<main><h2>Subjects we tutor</h2><p>Mathematics, English, Physical Sciences and Accounting for grades 8-12.</p></main>");
  assert.deepEqual(extractTutorSubjects(text), ["Mathematics", "Physical Sciences", "Accounting", "English"]);
  assert.deepEqual(extractTutorSubjects("Our website is available in English. Contact the office."), []);
});

test("finds same-site subject and tutoring pages", () => {
  const links = relevantWebsiteLinks('<a href="/subjects">Subjects</a><a href="https://other.example/tutors">Other</a><a href="/about">About</a>', "https://tutors.example/");
  assert.deepEqual(links, ["https://tutors.example/subjects"]);
});
