import { test, expect } from "@playwright/test";

const mappedLeads = [
  { id:"1", leadType:"Coffee Shops - South Africa Mobile", name:"Jozi Coffee", status:"New", phone:"+27 82 111 1111", location:"Johannesburg", googleMapsUrl:"https://maps.google.com/?cid=1", latitude:-26.2041, longitude:28.0473 },
  { id:"2", leadType:"Coffee Shops - South Africa Mobile", name:"Cape Coffee", status:"Contacted", phone:"+27 82 222 2222", location:"Cape Town", googleMapsUrl:"https://maps.google.com/?cid=2", latitude:-33.9249, longitude:18.4241 },
  { id:"3", leadType:"Salons - South Africa Mobile", name:"Pretoria Salon", status:"New", phone:"+27 82 333 3333", location:"Pretoria", googleMapsUrl:"https://maps.google.com/?cid=3", latitude:-25.7479, longitude:28.2293 },
  { id:"4", leadType:"Photographers - South Africa Mobile", name:"Durban Photos", status:"New", phone:"+27 82 444 4444", location:"Durban", googleMapsUrl:"https://maps.google.com/?cid=4", latitude:-29.8587, longitude:31.0218 },
];

test("maps CRM leads and filters them by lead type", async ({ page }) => {
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.route("**/api/crm/map-leads", (route) => route.fulfill({ json:{ leads:mappedLeads } }));
  await page.route("**/api/crm/types", (route) => route.fulfill({ json:{ types:[
    { name:"Coffee Shops - South Africa Mobile", count:2 },
    { name:"Salons - South Africa Mobile", count:1 },
    { name:"Photographers - South Africa Mobile", count:1 },
  ] } }));
  await page.route("**/api/maps/browser-config", (route) => route.fulfill({ json:{ apiKey:"test-browser-key" } }));
  await page.route(/https:\/\/maps\.googleapis\.com\/maps\/api\/js.*/, async (route) => {
    const callback = new URL(route.request().url()).searchParams.get("callback");
    await route.fulfill({ contentType:"text/javascript", body:`
      class FakeMap {
        constructor(element) { this.element = element; this.zoom = 5; this.listeners = {}; }
        addListener(name, listener) { this.listeners[name] = listener; if (name === "idle") setTimeout(listener); return { remove() {} }; }
        getZoom() { return this.zoom; }
        getBounds() { return { contains() { return true; } }; }
        fitBounds() { setTimeout(() => this.listeners.idle?.()); }
        setCenter() {}
        setZoom(zoom) { this.zoom = zoom; setTimeout(() => this.listeners.idle?.()); }
      }
      class FakeMarker { constructor(options) { this.options = options; } addListener() {} setMap() {} }
      class FakeInfoWindow { setContent() {} open() {} }
      class FakeBounds { extend() {} }
      window.google = { maps:{
        importLibrary: async () => ({ Map:FakeMap, InfoWindow:FakeInfoWindow }),
        Marker:FakeMarker,
        LatLngBounds:FakeBounds,
        SymbolPath:{ CIRCLE:"circle" }
      } };
      window[${JSON.stringify(callback)}]();
    ` });
  });

  await page.goto("/");
  await page.getByRole("button", { name:"Lead Map" }).click();
  await expect(page.getByRole("heading", { name:"Lead Map" })).toBeVisible();
  await expect(page.locator("#leadMapCount")).toHaveText("4");
  await expect(page.locator("#leadMapCanvas")).toHaveAttribute("data-marker-count", /[1-9]\d*/);

  await page.locator("#leadMapTypeFilter").selectOption({ label:"Coffee Shops - South Africa Mobile" });
  await expect(page.locator("#leadMapCount")).toHaveText("2");
  await expect(page.locator("#leadMapMeta")).toContainText("2 of 4");
  await page.locator("#leadMapSearch").fill("Cape Town");
  await expect(page.locator("#leadMapCount")).toHaveText("1");
  expect(browserErrors).toEqual([]);
});
