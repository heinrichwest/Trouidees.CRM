# Prospect Intelligence Desk

A local Node.js application that uses Firecrawl API v2 for web research and Google Places API (New) for public local-business leads.

## What it does

- Guides the user through objective, prospect, exact output fields and crawl scope before using credits.
- Uses Firecrawl Map to discover pages, prioritises the pages relevant to the requested fields, and scrapes up to 30 pages with progress updates.
- Optionally searches the web for news, hiring, expansion and partnership signals.
- Optionally runs Firecrawl Agent (`spark-1-mini`) for structured sales synthesis with a configurable credit cap.
- Extracts public contact details, buying signals, opportunities, unknowns and source links.
- Populates an evidence table with one row per requested field and source links.
- Excludes discovery results that do not contain a public email address.
- Supports education-contact discovery with one row per publicly listed work email, including role, school, country, school language and school type; free personal-mail providers and generic inboxes can be excluded.
- Offers unlimited overnight discovery across hundreds of location/speciality query combinations, with deduplication, automatic per-search CRM checkpoints and a stop control.
- Saves reports locally and exports Markdown, JSON and table CSV.
- Saves selected email-qualified leads into a local CRM table with lead type, status, feedback, comments and last-contact date.
- Maintains a reusable lead-type list, including add, rename and safe delete controls, so different markets stay separate.
- Searches Google Places by business category across multiple towns and checkpoints phone-qualified listings into the CRM after every results page.
- Uses Neon Postgres when `DATABASE_URL` is configured, with secure login, admin/sales roles and administrator-managed users.
- Tracks lead priority, owner, next follow-up date, overdue work and filtered CRM exports.

## Run locally

Requires Node.js 20 or newer. No `npm install` is needed.

```powershell
cd "C:\Dev\Projects\SpecconERP (Latest)\SalesResearchFirecrawl"
npm start
```

Open `http://127.0.0.1:4173`.

On Windows, double-click the **Prospect Intelligence Desk** desktop shortcut. It starts the local server in the background and opens the application in the default browser without showing a terminal. Repeated clicks reuse the running server.

`npm start` automatically loads a local `.env` file when present. You can alternatively omit `.env` and enter the key in the browser; a key entered there is sent only to the local server for that request and is not saved in report files or browser storage.

For Google Maps business search, enable **Places API (New)** and billing in Google Cloud, then add `GOOGLE_MAPS_API_KEY=...` to `.env` or enter the key on the Google Maps Leads screen. The CRM Lead Map also requires **Maps JavaScript API** and `GOOGLE_MAPS_BROWSER_API_KEY`; use a separate browser key restricted to your production domain.

For the resumable nationwide coffee-shop, salon and photographer run, use `npm run crm:session` once and then `npm run leads:google:nationwide`. It checkpoints every area in `data/logs/`, writes each results page directly to Neon, and resumes unfinished areas after a restart. The runner keeps only public numbers matching South African mobile-number patterns; it does not verify that a listed number belongs to the owner.

## Vercel and Neon

Connect a Neon Marketplace database to the Vercel project so `DATABASE_URL` is injected at runtime. Set `FIRECRAWL_API_KEY`, optional `GOOGLE_MAPS_API_KEY`, `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` as sensitive Production variables before the first login. The bootstrap credentials create the first administrator only while the user table is empty.

To migrate local CRM data after deployment, run `scripts/seed-neon.mjs` with `APP_URL` set to the production URL. The script signs in as the administrator and uploads ignored local CRM data in small batches; credentials and lead data are never committed.

## Research modes and cost control

- **Website crawl:** always runs and uses approximately one Firecrawl credit per crawled page.
- **External signal search:** optional; the Firecrawl response reports the exact credits used.
- **Unlimited overnight discovery:** removes the lead cap and runs until stopped, the selected time expires, query combinations are exhausted, or Firecrawl rejects further usage. Email-qualified leads are written to the report and CRM after every completed search, and browser polling reconnects without a fixed timeout. This can consume substantial credits.
- **AI synthesis:** optional and off by default. It uses Firecrawl Agent with a user-selected `maxCredits` cap.
- **Google Maps Leads:** uses Text Search (New), up to three pages per area. Phone fields can use a higher-priced Places SKU, so choose the area list and result cap deliberately.

API behaviour and billing can change, so check the Firecrawl dashboard for authoritative usage totals.

## Local data

Reports are stored in `data/reports/`; CRM leads and lead types are stored in `data/crm/`. They may contain public contact details and research notes, so handle exports according to your organisation's privacy and retention policies. `.gitignore` prevents generated data and `.env` files from being committed.

## Responsible use

Google Places returns public business listings, not verified owner identities. A listed number may be a landline or shared business number and should not be represented as an owner’s personal cell number without independent public evidence.

Research only information you are authorised to access. Respect website terms, robots directives, applicable privacy and direct-marketing laws, and internal policies. The evidence score is a research-completeness indicator—not a prediction of purchase intent. A person should verify every finding before sales outreach.

## Firecrawl API coverage

The application calls the current v2 endpoints directly:

- `POST /v2/map`
- `POST /v2/scrape`
- `POST /v2/search`
- `POST /v2/agent` and `GET /v2/agent/{id}`

The API key remains server-side when configured through `FIRECRAWL_API_KEY`.

## Tests

```powershell
npm test
npm run test:e2e
```

The Playwright test exercises the complete four-step wizard, background-job polling and evidence-table rendering in Chromium.
