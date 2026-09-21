const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

export const GOOGLE_PLACES_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.location",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.googleMapsUri",
  "places.primaryType",
  "places.primaryTypeDisplayName",
  "places.businessStatus",
  "places.rating",
  "places.userRatingCount",
  "nextPageToken",
].join(",");

export class GooglePlacesError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "GooglePlacesError";
    this.status = status;
  }
}

export function isLikelySouthAfricanMobileNumber(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  const local = digits.startsWith("27") && digits.length === 11 ? `0${digits.slice(2)}` : digits;
  return /^0(?:6\d|7\d|8[1-5])\d{7}$/.test(local);
}

export function placeToLead(place, fallbackLocation = "") {
  const name = place.displayName?.text || "Unnamed business";
  const category = place.primaryTypeDisplayName?.text || place.primaryType || "Business";
  return {
    placeId: String(place.id || ""),
    name,
    organization: name,
    role: category,
    email: "",
    phone: String(place.internationalPhoneNumber || place.nationalPhoneNumber || ""),
    details: `${category}${place.businessStatus ? ` · ${place.businessStatus.replaceAll("_", " ").toLowerCase()}` : ""}`,
    location: String(place.formattedAddress || fallbackLocation),
    country: fallbackLocation,
    services: category,
    website: String(place.websiteUri || ""),
    sourceUrl: String(place.googleMapsUri || ""),
    googleMapsUrl: String(place.googleMapsUri || ""),
    latitude: Number.isFinite(place.location?.latitude) ? place.location.latitude : null,
    longitude: Number.isFinite(place.location?.longitude) ? place.location.longitude : null,
    rating: Number.isFinite(place.rating) ? place.rating : null,
    ratingCount: Number.isFinite(place.userRatingCount) ? place.userRatingCount : null,
    source: "Google Places",
  };
}

export class GooglePlacesClient {
  constructor(apiKey, fetchImpl = fetch) {
    if (!String(apiKey || "").trim()) throw new GooglePlacesError("A Google Maps API key is required.", 401);
    this.apiKey = String(apiKey).trim();
    this.fetch = fetchImpl;
  }

  async searchText(textQuery, options = {}, onPage = async () => {}) {
    const query = String(textQuery || "").trim();
    if (!query) throw new GooglePlacesError("A Google Places text query is required.", 400);
    const maxPages = Math.max(1, Math.min(3, Number(options.maxPages) || 3));
    const pageSize = Math.max(1, Math.min(20, Number(options.pageSize) || 20));
    const places = [];
    const seen = new Set();
    let pageToken = "";
    let requests = 0;

    for (let page = 1; page <= maxPages; page += 1) {
      if (options.shouldStop?.()) break;
      const body = {
        textQuery: query,
        pageSize,
        languageCode: String(options.languageCode || "en"),
        regionCode: String(options.regionCode || "ZA").toUpperCase().slice(0, 2),
      };
      if (pageToken) body.pageToken = pageToken;
      const response = await this.fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.apiKey,
          "X-Goog-FieldMask": GOOGLE_PLACES_FIELD_MASK,
        },
        body: JSON.stringify(body),
      });
      requests += 1;
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = payload.error?.message || `Google Places request failed with status ${response.status}.`;
        throw new GooglePlacesError(message, response.status === 401 || response.status === 403 ? 401 : 502);
      }
      const pagePlaces = (Array.isArray(payload.places) ? payload.places : []).filter((place) => {
        const key = place.id || `${place.displayName?.text || ""}|${place.formattedAddress || ""}`;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        places.push(place);
        return true;
      });
      await onPage(pagePlaces, { page, requests, total: places.length, hasNextPage: Boolean(payload.nextPageToken) });
      pageToken = String(payload.nextPageToken || "");
      if (!pageToken || !pagePlaces.length) break;
    }

    return { places, requests };
  }
}
