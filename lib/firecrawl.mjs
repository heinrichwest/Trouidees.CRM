import { spawn } from "node:child_process";

const API_BASE = "https://api.firecrawl.dev";

export class FirecrawlError extends Error {
  constructor(message, status = 500, details = null) {
    super(message);
    this.name = "FirecrawlError";
    this.status = status;
    this.details = details;
  }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class FirecrawlClient {
  constructor(apiKey, fetchImplementation = fetch) {
    if (!apiKey) throw new FirecrawlError("A Firecrawl API key is required.", 401);
    this.apiKey = apiKey;
    this.fetch = fetchImplementation;
    this.preferCurl = false;
  }

  async request(pathOrUrl, { method = "GET", body, timeoutMs = 120_000 } = {}) {
    const url = new URL(pathOrUrl, API_BASE);
    if (url.origin !== API_BASE) {
      throw new FirecrawlError("Firecrawl returned an unexpected pagination URL.", 502);
    }

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let response;

      const requestBody = body === undefined ? undefined : JSON.stringify(body);
      try {
        response = this.preferCurl
          ? await curlRequest(url, method, this.apiKey, requestBody, timeoutMs)
          : await this.fetch(url, {
            method,
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              "Content-Type": "application/json",
            },
            body: requestBody,
            signal: controller.signal,
          });
      } catch (error) {
        clearTimeout(timeout);
        if (!this.preferCurl && process.platform === "win32" && error.cause?.code === "ENOTFOUND") {
          this.preferCurl = true;
          response = await curlRequest(url, method, this.apiKey, requestBody, timeoutMs);
        } else {
          if (error.name === "AbortError") {
            throw new FirecrawlError("Firecrawl did not respond before the timeout.", 504);
          }
          throw new FirecrawlError("Could not connect to Firecrawl.", 502, error.message);
        }
      }
      clearTimeout(timeout);

      const payload = await response.json().catch(() => ({}));
      if (response.ok) return payload;

      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 800 * 2 ** attempt);
        continue;
      }

      const message = payload.error || payload.message || `Firecrawl request failed (${response.status}).`;
      throw new FirecrawlError(message, response.status, payload.details || null);
    }

    throw new FirecrawlError("Firecrawl request failed after retries.", 502);
  }

  async crawl(url, limit, onProgress = () => {}) {
    const started = await this.request("/v2/crawl", {
      method: "POST",
      body: {
        url,
        limit,
        maxDiscoveryDepth: 3,
        sitemap: "include",
        crawlEntireDomain: false,
        allowExternalLinks: false,
        allowSubdomains: false,
        ignoreQueryParameters: true,
        scrapeOptions: {
          formats: ["markdown", "links"],
          onlyMainContent: true,
          removeBase64Images: true,
          blockAds: true,
          timeout: 60_000,
        },
      },
    });

    if (!started.id) throw new FirecrawlError("Firecrawl did not return a crawl job ID.", 502);

    onProgress({ stage: "crawl", message: "Website crawl started", completed: 0, total: limit });
    const deadline = Date.now() + 8 * 60_000;
    let result;
    let latest = null;

    while (Date.now() < deadline) {
      latest = await this.request(`/v2/crawl/${started.id}`);
      onProgress({
        stage: "crawl",
        message: `Crawled ${latest.completed || 0} of ${latest.total || limit} discovered pages`,
        completed: latest.completed || 0,
        total: latest.total || limit,
      });
      if (latest.status === "completed") {
        result = latest;
        break;
      }
      if (latest.status === "failed" || latest.status === "cancelled") {
        throw new FirecrawlError(latest.error || "Firecrawl crawl failed.", 502);
      }
      await sleep(2_000);
    }

    if (!result) {
      if (latest?.data?.length) {
        result = { ...latest, status: "partial", partial: true };
        onProgress({ stage: "crawl", message: "Using pages completed before the crawl timeout", completed: latest.completed || latest.data.length, total: latest.total || limit });
      } else {
        throw new FirecrawlError("Firecrawl did not return any pages before the eight-minute timeout.", 504);
      }
    }
    const pages = [...(result.data || [])];
    let next = result.next;
    let pageCount = 0;

    while (next && pageCount < 20) {
      const batch = await this.request(next);
      pages.push(...(batch.data || []));
      next = batch.next;
      pageCount += 1;
    }

    return { ...result, data: pages };
  }

  async mapAndScrape(url, limit, requestedFields = [], onProgress = () => {}) {
    const warnings = [];
    let mappedLinks = [];
    onProgress({ stage: "map", message: "Discovering relevant pages", completed: 0, total: limit });

    try {
      const mapped = await this.request("/v2/map", {
        method: "POST",
        body: {
          url,
          sitemap: "include",
          includeSubdomains: false,
          ignoreQueryParameters: true,
          limit: Math.max(50, limit * 5),
          timeout: 60_000,
        },
        timeoutMs: 90_000,
      });
      mappedLinks = mapped.links || [];
    } catch (error) {
      warnings.push(`Page discovery failed; scraped the supplied website page instead: ${error.message}`);
    }

    const urls = selectRelevantUrls(url, mappedLinks, limit, requestedFields);
    const data = [];
    let creditsUsed = 0;
    let cursor = 0;
    let finished = 0;

    const worker = async () => {
      while (cursor < urls.length) {
        const currentIndex = cursor;
        cursor += 1;
        const targetUrl = urls[currentIndex];
        try {
          const result = await this.request("/v2/scrape", {
            method: "POST",
            body: {
              url: targetUrl,
              formats: ["markdown", "links"],
              onlyMainContent: true,
              removeBase64Images: true,
              blockAds: true,
              timeout: 60_000,
            },
            timeoutMs: 90_000,
          });
          if (result.data) data.push(result.data);
          creditsUsed += Number(result.creditsUsed || 1);
        } catch (error) {
          warnings.push(`Could not scrape ${targetUrl}: ${error.message}`);
        }
        finished += 1;
        onProgress({ stage: "scrape", message: `Scraped ${finished} of ${urls.length} selected pages`, completed: finished, total: urls.length });
      }
    };

    await Promise.all(Array.from({ length: Math.min(3, urls.length) }, () => worker()));
    if (!data.length) throw new FirecrawlError(warnings.join(" ") || "Firecrawl did not return any page content.", 502);
    return { status: "completed", completed: data.length, total: urls.length, creditsUsed, data, warnings };
  }

  async search(query, { country = "ZA", location = "South Africa", limit = 5 } = {}) {
    return this.request("/v2/search", {
      method: "POST",
      body: {
        query,
        limit,
        sources: ["web"],
        ...(country ? { country } : {}),
        location,
        timeout: 60_000,
        ignoreInvalidURLs: true,
      },
    });
  }

  async discover(query, { country = "ZA", location = "South Africa", limit = 10 } = {}, onProgress = () => {}) {
    onProgress({ stage: "search", message: `Searching for ${query}`, completed: 0, total: limit });
    const result = await this.request("/v2/search", {
      method: "POST",
      body: {
        query: `${query} contact email phone`,
        limit,
        sources: ["web"],
        ...(country ? { country } : {}),
        location,
        timeout: 120_000,
        ignoreInvalidURLs: true,
        scrapeOptions: {
          formats: ["markdown", "links"],
          onlyMainContent: true,
          removeBase64Images: true,
          blockAds: true,
          timeout: 60_000,
        },
      },
      timeoutMs: 150_000,
    });
    const count = result.data?.web?.length || 0;
    onProgress({ stage: "search", message: `Found and scraped ${count} candidate results`, completed: count, total: limit });
    return result;
  }

  async discoverOvernight(query, { country = "ZA", location = "South Africa", runHours = 8 } = {}, onProgress = () => {}, shouldStop = () => false, onCheckpoint = () => {}) {
    const variants = discoveryQueries(query, location);
    const deadline = Date.now() + runHours * 60 * 60_000;
    const web = [];
    const seen = new Set();
    const warnings = [];
    let creditsUsed = 0;
    const educationSearch = /teacher|tutor|headmaster|principal|school|faculty|educator/i.test(query);

    for (let index = 0; index < variants.length && Date.now() < deadline && !shouldStop(); index += 1) {
      try {
        const region = discoveryRegion(variants[index], country, location);
        const result = await this.discover(variants[index], { country: region.country, location: region.location, limit: 10 });
        creditsUsed += Number(result.creditsUsed || 0);
        for (const item of result.data?.web || []) {
          const key = item.url || item.metadata?.sourceURL;
          if (educationSearch && /\.pdf(?:$|[?#])/i.test(key || "")) continue;
          if (key && !seen.has(key)) {
            seen.add(key);
            web.push({ ...item, discoveryQuery: variants[index] });
          }
        }
      } catch (error) {
        warnings.push(`${variants[index]}: ${error.message}`);
        if (error.status === 402) break;
      }
      onProgress({
        stage: "overnight",
        message: `Overnight discovery: ${web.length} unique leads found across ${index + 1} searches`,
        completed: index + 1,
        total: variants.length,
        leadsFound: web.length,
        creditsUsed,
      });
      await onCheckpoint({ success: true, data: { web: [...web] }, creditsUsed, warnings: [...warnings], stopped: shouldStop() });
      if (!shouldStop()) await sleep(2_500);
    }

    return { success: true, data: { web }, creditsUsed, warnings, stopped: shouldStop() };
  }

  async discoveryAgent({ query, location, offering, requestedFields, maxCredits, limit }, onProgress = () => {}) {
    const fieldList = requestedFields.join(", ");
    const offeringContext = offering ? `The seller offers ${offering}; include a concise fit note for each lead.` : "";
    const started = await this.request("/v2/agent", {
      method: "POST",
      body: {
        prompt: `Find up to ${limit} active businesses or professionals matching "${query}" in ${location}. Return public business information only. Required fields: ${fieldList}. For every phone number or email, provide the public page where it appears. Do not guess missing details; use an empty string. Prefer official websites and current sources over social profiles or generic directories. ${offeringContext}`,
        schema: DISCOVERY_SCHEMA,
        model: "spark-1-mini",
        maxCredits,
      },
      timeoutMs: 120_000,
    });
    if (!started.id) throw new FirecrawlError("Firecrawl did not return a discovery Agent job ID.", 502);
    onProgress({ stage: "agent", message: "AI discovery is verifying lead details" });
    return this.poll(`/v2/agent/${started.id}`, 8 * 60_000, onProgress);
  }

  async agent({ url, companyName, offering, includeExternalResearch, maxCredits, requestedFields = [], researchGoal = "" }, onProgress = () => {}) {
    const target = companyName || new URL(url).hostname.replace(/^www\./, "");
    const offeringContext = offering
      ? `The seller offers: ${offering}. Evaluate fit specifically for that offering.`
      : "Identify credible business-to-business sales opportunities without assuming a specific offering.";
    const externalRule = includeExternalResearch
      ? "You may use trustworthy public sources outside the company website for recent developments."
      : "Use only the supplied company website.";

    const fields = requestedFields.length ? requestedFields.join(", ") : "company overview, products and services, contacts, buying signals and opportunities";
    const goalContext = researchGoal ? `The user's research goal is: ${researchGoal}.` : "";
    const started = await this.request("/v2/agent", {
      method: "POST",
      body: {
        urls: [url],
        prompt: `Research ${target} for a sales account brief. ${goalContext} ${offeringContext} ${externalRule} Return one requested_fields entry for every one of these exact fields: ${fields}. Use only publicly available evidence. Do not invent people, contact details, needs, or events. Include a source URL and short evidence for each requested field, signal and opportunity; use an empty string when a source is unavailable. Distinguish facts from recommendations.`,
        schema: SALES_RESEARCH_SCHEMA,
        model: "spark-1-mini",
        maxCredits,
        strictConstrainToURLs: !includeExternalResearch,
      },
      timeoutMs: 120_000,
    });

    if (!started.id) throw new FirecrawlError("Firecrawl did not return an Agent job ID.", 502);
    onProgress({ stage: "agent", message: "AI synthesis started" });
    return this.poll(`/v2/agent/${started.id}`, 8 * 60_000, onProgress);
  }

  async poll(path, deadlineMs, onProgress = () => {}) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      const result = await this.request(path);
      if (result.status === "completed") return result;
      if (result.status === "failed" || result.status === "cancelled") {
        throw new FirecrawlError(result.error || "Firecrawl job failed.", 502);
      }
      onProgress({ stage: "agent", message: "AI synthesis is gathering and checking evidence" });
      await sleep(2_000);
    }
    throw new FirecrawlError("Firecrawl job is still running after the local timeout.", 504);
  }
}

function curlRequest(url, method, apiKey, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const marker = "\n__FIRECRAWL_STATUS__:";
    const args = [
      "--silent", "--show-error", "--max-time", String(Math.ceil(timeoutMs / 1000)),
      "--request", method, "--url", url.toString(),
      "--header", `Authorization: Bearer ${apiKey}`,
      "--header", "Content-Type: application/json",
      "--write-out", `${marker}%{http_code}`,
    ];
    if (body !== undefined) args.push("--data-binary", "@-");
    const child = spawn(process.platform === "win32" ? "curl.exe" : "curl", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const output = [];
    const errors = [];
    let outputSize = 0;
    child.stdout.on("data", (chunk) => {
      outputSize += chunk.length;
      if (outputSize > 50 * 1024 * 1024) child.kill();
      else output.push(chunk);
    });
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(Buffer.concat(errors).toString("utf8").trim() || `curl exited with code ${code}`));
      const text = Buffer.concat(output).toString("utf8");
      const markerIndex = text.lastIndexOf(marker);
      if (markerIndex < 0) return reject(new Error("curl response did not include an HTTP status."));
      const status = Number(text.slice(markerIndex + marker.length).trim());
      const payloadText = text.slice(0, markerIndex);
      resolve({
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        json: async () => JSON.parse(payloadText || "{}"),
      });
    });
    child.stdin.end(body);
  });
}

const stringArray = { type: "array", items: { type: "string" } };

function discoveryQueries(baseQuery, targetLocation = "South Africa") {
  const southAfricanLocations = [
    "South Africa", "Johannesburg", "Pretoria", "Cape Town", "Durban", "Gqeberha", "Bloemfontein", "East London",
    "Polokwane", "Mbombela", "Rustenburg", "Kimberley", "George", "Stellenbosch", "Pietermaritzburg", "Centurion",
    "Midrand", "Sandton", "Roodepoort", "Soweto", "Randburg", "Benoni", "Boksburg", "Alberton", "Umhlanga",
  ];
  const educationSearch = /teacher|tutor|headmaster|principal|school|faculty|educator/i.test(baseQuery);
  if (educationSearch) {
    const africanCountries = [
      "Nigeria", "Ghana", "Kenya", "Uganda", "Tanzania", "Rwanda", "Botswana", "Namibia", "Zambia", "Zimbabwe",
      "Malawi", "Mauritius", "Seychelles", "Lesotho", "Eswatini", "Liberia", "Sierra Leone", "Gambia", "Cameroon",
      "Ethiopia", "Mozambique", "Angola", "Madagascar", "Mauritania",
    ];
    const locations = /africa/i.test(targetLocation) && !/south africa/i.test(targetLocation)
      ? [...southAfricanLocations, ...africanCountries]
      : southAfricanLocations;
    const templates = [
      '"staff directory" teacher email school', '"faculty and staff" email school', '"teacher email" school',
      'principal headmaster email school', '"English medium school" staff email', '"international school" faculty email',
      '"meet the teachers" email school', 'tutor email education', '"staff email" academy',
      '"primary school" teachers email', '"secondary school" teachers email', '"high school" staff email',
      '"elementary school" faculty email', '"mathematics teacher" email school', '"English teacher" email school',
      '"science teacher" email school', '"head of department" email school', '"school principal" email',
      '"head of school" email', '"online tutor" email', '"private school" staff directory',
      '"public school" staff directory', '"independent school" teachers email', '"school counsellor" email',
    ];
    const countryDomains = {
      Nigeria: "ng", Ghana: "gh", Kenya: "ke", Uganda: "ug", Tanzania: "tz", Rwanda: "rw", Botswana: "bw", Namibia: "na",
      Zambia: "zm", Zimbabwe: "zw", Malawi: "mw", Mauritius: "mu", Seychelles: "sc", Lesotho: "ls", Eswatini: "sz",
      Liberia: "lr", "Sierra Leone": "sl", Gambia: "gm", Cameroon: "cm", Ethiopia: "et", Mozambique: "mz", Angola: "ao",
      Madagascar: "mg", Mauritania: "mr",
    };
    return locations.flatMap((place) => {
      const domain = southAfricanLocations.includes(place) ? "za" : countryDomains[place];
      return templates.map((template) => `${baseQuery} ${template} ${place} ${domain ? `site:.${domain}` : ""} -filetype:pdf`.replace(/\s+/g, " ").trim());
    });
  }
  const locations = /africa/i.test(targetLocation) && !/south africa/i.test(targetLocation) ? ["South Africa"] : southAfricanLocations;
  const businessTypes = ["", "business", "company", "professional", "supplier", "studio", "shop", "store", "online service", "directory", "local service", "independent"];
  const contactIntents = ["", "email", "contact details", "website", "request a quote", "sales contact", "bookings"];
  return locations.flatMap((place) => businessTypes.flatMap((businessType) => contactIntents.map((intent) => `${baseQuery} ${businessType} ${intent} ${place}`.replace(/\s+/g, " ").trim())));
}

function discoveryRegion(query, fallbackCountry, fallbackLocation) {
  const regions = [
    ["Nigeria", "NG"], ["Ghana", "GH"], ["Kenya", "KE"], ["Uganda", "UG"], ["Tanzania", "TZ"], ["Rwanda", "RW"],
    ["Botswana", "BW"], ["Namibia", "NA"], ["Zambia", "ZM"], ["Zimbabwe", "ZW"], ["Malawi", "MW"], ["Mauritius", "MU"],
    ["Seychelles", "SC"], ["Lesotho", "LS"], ["Eswatini", "SZ"], ["Liberia", "LR"], ["Sierra Leone", "SL"],
    ["Gambia", "GM"], ["Cameroon", "CM"], ["Ethiopia", "ET"], ["Mozambique", "MZ"], ["Angola", "AO"],
    ["Madagascar", "MG"], ["Mauritania", "MR"],
  ];
  const region = regions.find(([name]) => new RegExp(`\\b${name.replace(" ", "\\s+")}\\b`, "i").test(query));
  if (region) return { location: region[0], country: region[1] };
  if (/\b(?:South Africa|Johannesburg|Pretoria|Cape Town|Durban|Gqeberha|Bloemfontein|East London|Polokwane|Mbombela|Rustenburg|Kimberley|George|Stellenbosch|Pietermaritzburg|Centurion|Midrand|Sandton|Roodepoort|Soweto|Randburg|Benoni|Boksburg|Alberton|Umhlanga)\b/i.test(query)) {
    return { location: "South Africa", country: "ZA" };
  }
  return { location: fallbackLocation, country: fallbackCountry };
}

function selectRelevantUrls(baseUrl, links, limit, requestedFields) {
  const base = new URL(baseUrl);
  const fieldTerms = requestedFields.join(" ").toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 3);
  const priorityTerms = ["about", "contact", "team", "people", "leadership", "service", "product", "solution", "school", "tutor", "pricing", "news", "blog", "career", "vacan", "partner"];
  const candidates = [{ url: base.href, title: "", description: "" }, ...links.map((link) => typeof link === "string" ? { url: link } : link)]
    .map((link) => {
      try {
        const parsed = new URL(link.url, base);
        parsed.hash = "";
        return { ...link, url: parsed.href, parsed };
      } catch { return null; }
    })
    .filter((link) => link && link.parsed.hostname === base.hostname && ["http:", "https:"].includes(link.parsed.protocol));

  const seen = new Set();
  return candidates
    .filter((link) => !seen.has(link.url) && seen.add(link.url))
    .map((link) => {
      const text = `${link.parsed.pathname} ${link.title || ""} ${link.description || ""}`.toLowerCase();
      let score = link.url === base.href ? 1_000 : 100 - link.parsed.pathname.split("/").filter(Boolean).length * 4;
      score += priorityTerms.filter((term) => text.includes(term)).length * 25;
      score += fieldTerms.filter((term) => text.includes(term)).length * 8;
      if (/privacy|terms|cookie|login|register|cart|checkout/i.test(text)) score -= 200;
      return { url: link.url, score };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item) => item.url);
}

const SALES_RESEARCH_SCHEMA = {
  type: "object",
  properties: {
    company: {
      type: "object",
      properties: {
        name: { type: "string" },
        summary: { type: "string" },
        industries: stringArray,
        locations: stringArray,
        products_services: stringArray,
        target_customers: stringArray,
        differentiators: stringArray,
        size_indicators: stringArray,
      },
    },
    contacts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          role: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
          source_url: { type: "string" },
        },
      },
    },
    sales_signals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          signal: { type: "string" },
          why_it_matters: { type: "string" },
          evidence: { type: "string" },
          source_url: { type: "string" },
        },
      },
    },
    likely_needs: stringArray,
    opportunities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          opportunity: { type: "string" },
          rationale: { type: "string" },
          source_url: { type: "string" },
        },
      },
    },
    recommended_contacts: stringArray,
    outreach_angles: stringArray,
    risks_or_unknowns: stringArray,
    next_steps: stringArray,
    requested_fields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          value: { type: "string" },
          evidence: { type: "string" },
          source_url: { type: "string" },
        },
      },
    },
  },
};

const DISCOVERY_SCHEMA = {
  type: "object",
  properties: {
    leads: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          role: { type: "string" },
          school_name: { type: "string" },
          details: { type: "string" },
          phone: { type: "string" },
          email: { type: "string" },
          location: { type: "string" },
          country: { type: "string" },
          language: { type: "string" },
          school_type: { type: "string" },
          subjects_services: { type: "string" },
          website: { type: "string" },
          source_url: { type: "string" },
          fit_note: { type: "string" },
        },
      },
    },
  },
};
