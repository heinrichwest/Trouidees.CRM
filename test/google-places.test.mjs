import test from "node:test";
import assert from "node:assert/strict";
import { GOOGLE_PLACES_FIELD_MASK, GooglePlacesClient, placeToLead } from "../lib/google-places.mjs";

test("Google Places text search requests phone fields and follows pagination", async () => {
  const calls = [];
  const responses = [
    { places: [{ id: "one", displayName: { text: "One Cafe" }, nationalPhoneNumber: "021 555 0101" }], nextPageToken: "next" },
    { places: [{ id: "two", displayName: { text: "Two Cafe" }, internationalPhoneNumber: "+27 21 555 0102" }] },
  ];
  const client = new GooglePlacesClient("test-key", async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => responses.shift() };
  });

  const result = await client.searchText("coffee shops in Cape Town", { maxPages: 3 });

  assert.equal(result.places.length, 2);
  assert.equal(result.requests, 2);
  assert.equal(calls[0].init.headers["X-Goog-Api-Key"], "test-key");
  assert.equal(calls[0].init.headers["X-Goog-FieldMask"], GOOGLE_PLACES_FIELD_MASK);
  assert.equal(JSON.parse(calls[1].init.body).pageToken, "next");
});

test("Google place converts to a phone-qualified CRM lead", () => {
  const lead = placeToLead({
    id: "place-1",
    displayName: { text: "Example Salon" },
    primaryTypeDisplayName: { text: "Hair salon" },
    formattedAddress: "1 Main Road, Cape Town",
    internationalPhoneNumber: "+27 21 555 0101",
    googleMapsUri: "https://maps.google.com/example",
    location: { latitude: -33.9, longitude: 18.4 },
  }, "Cape Town");

  assert.equal(lead.name, "Example Salon");
  assert.equal(lead.phone, "+27 21 555 0101");
  assert.equal(lead.source, "Google Places");
  assert.equal(lead.latitude, -33.9);
});
