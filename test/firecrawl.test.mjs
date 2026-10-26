import test from "node:test";
import assert from "node:assert/strict";
import { FirecrawlClient } from "../lib/firecrawl.mjs";

test("crawl uses Firecrawl v2 and returns completed page data", async () => {
  const requests = [];
  const mockFetch = async (url, options) => {
    requests.push({ url: url.toString(), options });
    if (url.pathname === "/v2/crawl" && options.method === "POST") {
      return Response.json({ success: true, id: "crawl-job" });
    }
    return Response.json({
      status: "completed",
      completed: 1,
      creditsUsed: 1,
      data: [{ markdown: "# Example", metadata: { sourceURL: "https://example.com/" } }],
    });
  };

  const client = new FirecrawlClient("test-key", mockFetch);
  const result = await client.crawl("https://example.com/", 4);
  const crawlBody = JSON.parse(requests[0].options.body);

  assert.equal(requests[0].url, "https://api.firecrawl.dev/v2/crawl");
  assert.equal(requests[1].url, "https://api.firecrawl.dev/v2/crawl/crawl-job");
  assert.equal(crawlBody.limit, 4);
  assert.deepEqual(crawlBody.scrapeOptions.formats, ["markdown", "links"]);
  assert.equal(result.data.length, 1);
});

test("search requests web results without scraping full external pages", async () => {
  let requestBody;
  const mockFetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return Response.json({ success: true, data: { web: [] }, creditsUsed: 1 });
  };
  const client = new FirecrawlClient("test-key", mockFetch);
  await client.search("Example news", { country: "ZA", location: "South Africa", limit: 5 });

  assert.deepEqual(requestBody.sources, ["web"]);
  assert.equal(requestBody.country, "ZA");
  assert.equal(requestBody.scrapeOptions, undefined);
});

test("mapAndScrape selects relevant pages and returns page content", async () => {
  const scrapedUrls = [];
  const mockFetch = async (url, options) => {
    if (url.pathname === "/v2/map") {
      return Response.json({ success: true, links: [
        { url: "https://example.com/privacy" },
        { url: "https://example.com/contact" },
        { url: "https://example.com/services" },
      ] });
    }
    const body = JSON.parse(options.body);
    scrapedUrls.push(body.url);
    return Response.json({ success: true, creditsUsed: 1, data: { markdown: `# ${body.url}`, metadata: { sourceURL: body.url } } });
  };

  const client = new FirecrawlClient("test-key", mockFetch);
  const result = await client.mapAndScrape("https://example.com/", 2, ["Public contact details"]);

  assert.equal(result.data.length, 2);
  assert.equal(scrapedUrls[0], "https://example.com/");
  assert.ok(scrapedUrls.includes("https://example.com/contact"));
  assert.ok(!scrapedUrls.includes("https://example.com/privacy"));
});

test("strict map-and-scrape reports provider usage without inventing missing credits", async () => {
  let calls = 0;
  const client = new FirecrawlClient("test-key", async (url) => {
    calls += 1;
    if (url.pathname === "/v2/map") return Response.json({ success: true, links: [{ url: "https://example.com/about" }] });
    return Response.json({ success: true, creditsUsed: 2, data: { markdown: "About", metadata: { sourceURL: "https://example.com/about" } } });
  });
  const result = await client.mapAndScrape("https://example.com/", 1, [], () => {}, { strictAttempt: true, deadlineAt: Date.now() + 1000, reportUsage: true });
  assert.deepEqual(result.usage, { reportedTotal: null, reportedSubtotal: 2, complete: false });
  assert.equal(result.creditsUsed, null);
  assert.equal(calls, 2);
});

test("strict map-and-scrape preserves an explicitly reported zero", async () => {
  const client = new FirecrawlClient("test-key", async (url) => url.pathname === "/v2/map"
    ? Response.json({ success: true, creditsUsed: 0, links: [{ url: "https://example.com/about" }] })
    : Response.json({ success: true, creditsUsed: 0, data: { markdown: "About", metadata: { sourceURL: "https://example.com/about" } } }));
  const result = await client.mapAndScrape("https://example.com/", 1, [], () => {}, { strictAttempt: true, deadlineAt: Date.now() + 1000, reportUsage: true });
  assert.deepEqual(result.usage, { reportedTotal: 0, reportedSubtotal: 0, complete: true });
  assert.equal(result.creditsUsed, 0);
});

test("strict paid operations do not retry an ambiguous map failure or exceed the deadline", async () => {
  let calls = 0;
  const client = new FirecrawlClient("test-key", async () => { calls += 1; return new Response("{}", { status: 503, headers: { "retry-after": "30" } }); });
  await assert.rejects(client.mapAndScrape("https://example.com/", 1, [], () => {}, { strictAttempt: true, deadlineAt: Date.now() + 100, reportUsage: true }));
  assert.equal(calls, 1);
  await assert.rejects(client.request("/v2/map", { method: "POST", body: {}, maxAttempts: 1, deadlineAt: Date.now() - 1 }));
  assert.equal(calls, 1);
});

test("an excessive Retry-After is rejected before sleeping past the operation deadline", async () => {
  let calls = 0;
  const client = new FirecrawlClient("test-key", async () => {
    calls += 1;
    return new Response("{}", { status: 429, headers: { "retry-after": "30" } });
  });
  await assert.rejects(client.request("/v2/map", { maxAttempts: 2, deadlineAt: Date.now() + 50 }));
  assert.equal(calls, 1);
});

test("existing Firecrawl callers retain bounded transient retries", async () => {
  let calls = 0;
  const client = new FirecrawlClient("test-key", async () => {
    calls += 1;
    return calls === 1
      ? new Response("{}", { status: 503, headers: { "retry-after": "0" } })
      : Response.json({ success: true, data: [] });
  });
  assert.deepEqual(await client.request("/v2/map"), { success: true, data: [] });
  assert.equal(calls, 2);
});

test("overnight discovery checkpoints results after every completed search", async () => {
  let stopped = false;
  const checkpoints = [];
  const mockFetch = async () => Response.json({
    success: true,
    creditsUsed: 3,
    data: { web: [{ title: "Cape Tutor", url: "https://tutor.example/", markdown: "Email hello@tutor.example" }] },
  });
  const client = new FirecrawlClient("test-key", mockFetch);

  const result = await client.discoverOvernight(
    "Tutors",
    { runHours: 1 },
    () => {},
    () => stopped,
    async (checkpoint) => { checkpoints.push(checkpoint); stopped = true; },
  );

  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].data.web.length, 1);
  assert.equal(checkpoints[0].creditsUsed, 3);
  assert.equal(result.data.web.length, 1);
});
