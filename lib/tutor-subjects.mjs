const CONTEXT = /\b(subjects?|tutors?|tutoring|tuition|lessons?|classes|grades?|curriculum|teach(?:ing|ers?)?|academic|learners?|students?)\b/i;

const SUBJECTS = [
  ["Mathematical Literacy", /\b(?:mathematical|maths?)\s+literacy\b/gi],
  ["Mathematics", /\b(?:mathematics|maths|math)\b/gi],
  ["Physical Sciences", /\bphysical\s+sciences?\b/gi],
  ["Life Sciences", /\blife\s+sciences?\b/gi],
  ["Natural Sciences", /\bnatural\s+sciences?\b/gi],
  ["Social Sciences", /\bsocial\s+sciences?\b/gi],
  ["Computer Applications Technology", /\b(?:computer\s+applications?\s+technology|CAT)\b/g],
  ["Information Technology", /\b(?:information\s+technology|IT)\b/g],
  ["Engineering Graphics and Design", /\b(?:engineering\s+graphics?(?:\s+and\s+design)?|EGD)\b/gi],
  ["Business Studies", /\bbusiness\s+studies\b/gi],
  ["Economic and Management Sciences", /\b(?:economic\s+and\s+management\s+sciences|EMS)\b/g],
  ["Physics", /\bphysics\b/gi],
  ["Chemistry", /\bchemistry\b/gi],
  ["Biology", /\bbiology\b/gi],
  ["Accounting", /\baccounting\b/gi],
  ["Economics", /\beconomics\b/gi],
  ["English", /\benglish\b/gi],
  ["Afrikaans", /\bafrikaans\b/gi],
  ["isiZulu", /\b(?:isizulu|zulu)\b/gi],
  ["isiXhosa", /\b(?:isixhosa|xhosa)\b/gi],
  ["French", /\bfrench\b/gi],
  ["German", /\bgerman\b/gi],
  ["Geography", /\bgeography\b/gi],
  ["History", /\bhistory\b/gi],
  ["Coding and Programming", /\b(?:coding|programming|computer\s+science)\b/gi],
];

export function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|quot|#39|lt|gt);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractTutorSubjects(text) {
  const content = String(text || "");
  const found = [];
  for (const [name, pattern] of SUBJECTS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content))) {
      const nearby = content.slice(Math.max(0, match.index - 140), Math.min(content.length, match.index + match[0].length + 140));
      if (CONTEXT.test(nearby)) {
        found.push(name);
        break;
      }
    }
  }
  if (found.includes("Mathematical Literacy")) {
    const index = found.indexOf("Mathematics");
    if (index >= 0 && !/\bmathematics\b.{0,100}\b(?:subject|tutor|lesson|grade)/i.test(content)) found.splice(index, 1);
  }
  return found;
}

export function relevantWebsiteLinks(html, baseUrl, limit = 2) {
  const base = new URL(baseUrl);
  const links = [];
  const pattern = /href\s*=\s*["']([^"'#]+)["']/gi;
  let match;
  while ((match = pattern.exec(String(html || "")))) {
    try {
      const url = new URL(match[1], base);
      if (url.origin !== base.origin || !/^https?:$/.test(url.protocol)) continue;
      if (!/(subject|service|tutor|tuition|programme|program|course|offering|academic)/i.test(`${url.pathname}${url.search}`)) continue;
      url.hash = "";
      if (!links.includes(url.href)) links.push(url.href);
      if (links.length >= limit) break;
    } catch {}
  }
  return links;
}
