import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { GooglePlacesClient, isLikelySouthAfricanMobileNumber, placeToLead } from "../lib/google-places.mjs";
import { NeonStore } from "../lib/neon-store.mjs";

const root = new URL("../", import.meta.url);
const stateUrl = new URL("../data/logs/google-places-nationwide-state.log", import.meta.url);
const progressUrl = new URL("../data/logs/google-places-nationwide.log", import.meta.url);
const sessionUrl = new URL("../data/logs/crm-session-cookie.log", import.meta.url);
const keyFile = process.env.GOOGLE_API_KEYS_FILE || "C:\\Dev\\API Keys.txt";
const appUrl = String(process.env.APP_URL || "https://trouidees-crm.vercel.app").replace(/\/$/, "");
const pageDelayMs = Math.max(250, Number(process.env.GOOGLE_PLACES_DELAY_MS) || 500);

const searches = [
  { oldType: "Coffee Shops - Gauteng Mobile", leadType: "Coffee Shops - South Africa Mobile", query: "coffee shops" },
  { oldType: "Salons - Gauteng Mobile", leadType: "Salons - South Africa Mobile", query: "hair and beauty salons" },
  { oldType: "", leadType: "Photographers - South Africa Mobile", query: "professional photographers" },
  { oldType: "", leadType: "Tutors - South Africa Mobile", query: "tutors and tutoring services" },
  { oldType: "", leadType: "Tutors - South Africa Mobile", checkpoint: "Tutors Mathematics Science", query: "mathematics and science tutors", maxPages: 1 },
  { oldType: "", leadType: "Tutors - South Africa Mobile", checkpoint: "Tutors English", query: "English language tutors", maxPages: 1 },
  { oldType: "", leadType: "Tutors - South Africa Mobile", checkpoint: "Tutors Afrikaans", query: "Afrikaans tutors", maxPages: 1 },
  { oldType: "", leadType: "Tutors - South Africa Mobile", checkpoint: "Tutors Accounting Economics", query: "accounting and economics tutors", maxPages: 1 },
  { oldType: "", leadType: "Tutors - South Africa Mobile", checkpoint: "Tutors Primary School", query: "primary school tutors", maxPages: 1 },
  { oldType: "", leadType: "Tutors - South Africa Mobile", checkpoint: "Tutors High School", query: "high school tutors", maxPages: 1 },
];

const locations = [...new Set(`
Johannesburg|Sandton|Randburg|Rosebank Johannesburg|Melville Johannesburg|Fourways|Bryanston|Midrand|Centurion|Pretoria|Pretoria East|Hatfield Pretoria|Menlyn|Brooklyn Pretoria|Montana Pretoria|Akasia|Soshanguve|Mamelodi|Atteridgeville|Ga-Rankuwa|Soweto|Roodepoort|Krugersdorp|Randfontein|Westonaria|Carletonville|Vanderbijlpark|Vereeniging|Meyerton|Alberton|Germiston|Bedfordview|Edenvale|Kempton Park|Boksburg|Benoni|Brakpan|Springs|Nigel|Heidelberg Gauteng|Bronkhorstspruit|Cullinan|Hammanskraal|Tembisa|Katlehong|Vosloorus|Sebokeng|Lenasia|Alexandra Johannesburg|Midvaal
Cape Town|Cape Town CBD|Sea Point|Green Point Cape Town|Camps Bay|Claremont Cape Town|Rondebosch|Newlands Cape Town|Observatory Cape Town|Woodstock Cape Town|Century City|Milnerton|Table View|Bloubergstrand|Durbanville|Bellville|Brackenfell|Kraaifontein|Parow|Goodwood Cape Town|Kuils River|Somerset West|Strand Western Cape|Gordon's Bay|Stellenbosch|Paarl|Wellington Western Cape|Franschhoek|Worcester Western Cape|Robertson Western Cape|Montagu Western Cape|Ceres Western Cape|Tulbagh|Malmesbury|Saldanha|Vredenburg|Langebaan|Piketberg|Clanwilliam|Yzerfontein|Hermanus|Caledon|Bredasdorp|Swellendam|Mossel Bay|George Western Cape|Knysna|Plettenberg Bay|Oudtshoorn|Beaufort West|Laingsburg|Prince Albert Western Cape|Grabouw|Fish Hoek|Simon’s Town|Hout Bay|Mitchells Plain|Khayelitsha
Durban|Durban North|Umhlanga|Ballito|Salt Rock|KwaDukuza|Tongaat|Verulam|Phoenix Durban|Chatsworth|Pinetown|Westville|Hillcrest KwaZulu-Natal|Kloof KwaZulu-Natal|Amanzimtoti|Scottburgh|Margate|Port Shepstone|Shelly Beach|Hibberdene|Pietermaritzburg|Howick KwaZulu-Natal|Hilton KwaZulu-Natal|Mooi River|Estcourt|Ladysmith KwaZulu-Natal|Newcastle KwaZulu-Natal|Dundee KwaZulu-Natal|Vryheid|Ulundi|Richards Bay|Empangeni|Mtunzini|Eshowe|St Lucia KwaZulu-Natal|Kokstad|Underberg|Ixopo|Greytown|KwaMashu|Umlazi|Queensburgh|Waterfall KwaZulu-Natal
Gqeberha|Port Elizabeth Central|Summerstrand|Walmer Gqeberha|Kariega|Despatch Eastern Cape|Jeffreys Bay|Humansdorp|St Francis Bay|Makhanda|Graaff-Reinet|Cradock Eastern Cape|Kariega Eastern Cape|East London|Gonubie|Beacon Bay|King William's Town|Bhisho|Mthatha|Port St Johns|Coffee Bay|Butterworth Eastern Cape|Komani|Queenstown Eastern Cape|Aliwal North|Stutterheim|Fort Beaufort|Alice Eastern Cape|Addo|Kenton-on-Sea|Port Alfred|Bathurst Eastern Cape
Bloemfontein|Welkom|Virginia Free State|Odendaalsrus|Kroonstad|Sasolburg|Parys Free State|Bethlehem Free State|Clarens|Harrismith|Phuthaditjhaba|Ficksburg|Ladybrand|Botshabelo|Thaba Nchu|Senekal|Reitz|Frankfort Free State|Heilbron|Bothaville|Hennenman|Wesselsbron|Zastron
Polokwane|Mankweng|Seshego|Tzaneen|Phalaborwa|Hoedspruit|Louis Trichardt|Makhado|Musina|Thohoyandou|Giyani|Mokopane|Modimolle|Bela-Bela|Lephalale|Thabazimbi|Burgersfort|Jane Furse|Groblersdal Limpopo|Marble Hall|Alldays|Haenertsburg
Mbombela|Nelspruit Central|White River Mpumalanga|Hazyview|Sabie|Graskop|Barberton|Malalane|Komatipoort|Ermelo|Secunda|Evander|Bethal|Standerton|eMalahleni|Witbank Central|Middelburg Mpumalanga|Dullstroom|Lydenburg|Mashishing|Delmas|Carolina Mpumalanga|Piet Retief|Volksrust|Kriel Mpumalanga|KwaMhlanga
Rustenburg|Hartbeespoort|Brits|Mooinooi|Klerksdorp|Orkney|Stilfontein|Potchefstroom|Ventersdorp|Mahikeng|Mmabatho|Lichtenburg|Zeerust|Vryburg|Schweizer-Reneke|Wolmaransstad|Christiana North West|Bloemhof|Sun City South Africa|Pilanesberg|Coligny|Delareyville
Kimberley|Upington|Kuruman|Kathu|Postmasburg|Springbok Northern Cape|Port Nolloth|De Aar|Colesberg|Prieska|Douglas Northern Cape|Hopetown|Kakamas|Keimoes|Calvinia|Victoria West|Britstown|Sutherland Northern Cape|Hartswater|Jan Kempdorp|Alexander Bay
`.split(/[|\n]+/).map((location) => location.trim()).filter(Boolean))];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const stamp = () => new Date().toISOString();

async function log(message) {
  const line = `[${stamp()}] ${message}`;
  console.log(line);
  await appendFile(progressUrl, `${line}\n`);
}

async function readState() {
  try {
    return JSON.parse(await readFile(stateUrl, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { completed: [], imported: 0, skipped: 0, requests: 0, startedAt: stamp() };
  }
}

async function saveState(state) {
  state.updatedAt = stamp();
  await writeFile(stateUrl, JSON.stringify(state, null, 2));
}

async function findGoogleKey() {
  const candidates = [];
  if (process.env.GOOGLE_MAPS_API_KEY) candidates.push(process.env.GOOGLE_MAPS_API_KEY.trim());
  const keyContents = await readFile(keyFile, "utf8");
  candidates.push(...(keyContents.match(/AIza[0-9A-Za-z_-]{30,}/g) || []));
  for (const key of [...new Set(candidates.filter(Boolean))]) {
    try {
      const client = new GooglePlacesClient(key);
      await client.searchText("coffee shop in Pofadder South Africa", { maxPages: 1, pageSize: 1 });
      return key;
    } catch (error) {
      if (![401, 403].includes(error.status) && !/api key|credential|permission|billing/i.test(error.message)) throw error;
    }
  }
  throw new Error("No working Google Places API key was found.");
}

async function searchWithRetry(client, query, maxPages, onPage) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      return await client.searchText(query, { maxPages, regionCode: "ZA" }, onPage);
    } catch (error) {
      lastError = error;
      if ([400, 401, 403].includes(error.status) || attempt === 4) throw error;
      await sleep(attempt * 2_000);
    }
  }
  throw lastError;
}

class RemoteStore {
  constructor(cookie) {
    this.cookie = cookie;
  }

  async request(path, options = {}) {
    let lastError;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        const response = await fetch(`${appUrl}${path}`, {
          ...options,
          headers: { "Content-Type": "application/json", Cookie: this.cookie, ...(options.headers || {}) },
        });
        const payload = await response.json().catch(() => ({}));
        if (response.ok) return payload;
        const error = Object.assign(new Error(payload.error || `CRM request failed with status ${response.status}.`), { status: response.status });
        if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 6) throw error;
        lastError = error;
      } catch (error) {
        lastError = error;
        if (error.status || attempt === 6) throw error;
      }
      await sleep(attempt * 2_000);
    }
    throw lastError;
  }

  async ensureSchema() {}
  async listTypes() { return (await this.request("/api/crm/types")).types || []; }
  async addType(name) { return (await this.request("/api/crm/types", { method: "POST", body: JSON.stringify({ name }) })).name; }
  async renameType(oldName, newName) { return (await this.request("/api/crm/types", { method: "PATCH", body: JSON.stringify({ oldName, newName }) })).name; }
  async importLeads(leads, leadType) {
    return this.request("/api/admin/import", {
      method: "POST",
      body: JSON.stringify({ leads: leads.map((lead) => ({ ...lead, leadType })) }),
    });
  }
}

async function createStore() {
  if (process.env.DATABASE_URL && !process.env.DATABASE_URL.includes("[SENSITIVE]")) return new NeonStore();
  let cookie;
  try { cookie = String(await readFile(sessionUrl, "utf8")).trim(); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!cookie) throw new Error("Production CRM session is missing. Run the authenticated session setup first.");
  return new RemoteStore(cookie);
}

await mkdir(new URL("../data/logs/", import.meta.url), { recursive: true });
const state = await readState();
const completed = new Set(state.completed);
const store = await createStore();
await store.ensureSchema();

const currentTypes = await store.listTypes();
for (const search of searches) {
  const oldType = currentTypes.find((type) => type.name.toLowerCase() === search.oldType.toLowerCase());
  const newType = currentTypes.find((type) => type.name.toLowerCase() === search.leadType.toLowerCase());
  if (oldType && !newType) {
    await store.renameType(oldType.name, search.leadType);
    await log(`Renamed ${oldType.name} to ${search.leadType}.`);
  } else {
    await store.addType(search.leadType);
  }
}

const apiKey = await findGoogleKey();
const client = new GooglePlacesClient(apiKey);
const total = searches.length * locations.length;
if (completed.size < total) delete state.completedAt;
state.importedByType ||= {};
await log(`Nationwide Google Places run ready: ${locations.length} areas, ${searches.length} lead types, up to ${total * 3} API requests.`);

for (const search of searches) {
  for (const location of locations) {
    const checkpoint = `${search.checkpoint || search.leadType}|${location}`;
    if (completed.has(checkpoint)) continue;
    const query = `${search.query} in ${location}, South Africa`;
    let queryImported = 0;
    let querySkipped = 0;
    try {
      const result = await searchWithRetry(client, query, search.maxPages || 3, async (places) => {
        const leads = places
          .map((place) => placeToLead(place, `${location}, South Africa`))
          .filter((lead) => lead.phone && isLikelySouthAfricanMobileNumber(lead.phone));
        if (leads.length) {
          const imported = await store.importLeads(leads, search.leadType, { requireEmail: false, requirePhone: true });
          queryImported += imported.imported;
          querySkipped += imported.skipped;
          state.imported += imported.imported;
          state.skipped += imported.skipped;
          state.importedByType[search.leadType] = (state.importedByType[search.leadType] || 0) + imported.imported;
        }
        await sleep(pageDelayMs);
      });
      state.requests += result.requests;
      completed.add(checkpoint);
      state.completed = [...completed];
      await saveState(state);
      await log(`${completed.size}/${total} ${search.leadType} · ${location}: +${queryImported}, ${querySkipped} duplicates, ${result.requests} requests. Run total: +${state.imported}.`);
    } catch (error) {
      state.errors = [...(state.errors || []).slice(-49), { checkpoint, message: error.message, at: stamp() }];
      await saveState(state);
      await log(`ERROR ${checkpoint}: ${error.message}. This area remains pending for the next run.`);
      if ([401, 403].includes(error.status)) throw error;
      await sleep(3_000);
    }
  }
}

state.completedAt = stamp();
await saveState(state);
await log(`COMPLETE: ${state.imported} new mobile-qualified business leads, ${state.skipped} duplicates, ${state.requests} Google requests.`);
