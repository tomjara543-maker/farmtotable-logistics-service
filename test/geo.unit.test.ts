import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { approximateByZone, depot, geocode, haversineKm, locate, nearestNeighborOrder, routeDistanceKm } from "../src/geo";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GEOCODING_ENABLED;
});

test("haversineKm calcula la distancia entre dos coordenadas y nearestNeighborOrder visita primero la parada más cercana", () => {
  const bogota = { lat: 4.711, lng: -74.0721 };
  const medellin = { lat: 6.2442, lng: -75.5812 };
  const km = haversineKm(bogota, medellin);
  assert.ok(km > 205 && km < 250, `distancia inesperada: ${km}`);
  assert.equal(haversineKm(bogota, bogota), 0);

  const origin = { lat: 4.7, lng: -74.0 };
  const near = { id: "cerca", lat: 4.71, lng: -74.0 };
  const far = { id: "lejos", lat: 4.9, lng: -74.0 };
  const middle = { id: "medio", lat: 4.8, lng: -74.0 };
  const ordered = nearestNeighborOrder(origin, [far, near, middle]);
  assert.deepEqual(ordered.map((s) => s.id), ["cerca", "medio", "lejos"]);
  assert.ok(routeDistanceKm(origin, ordered) < routeDistanceKm(origin, [far, near, middle]));
});

test("geocode usa Nominatim con un fetch simulado y locate recurre a la zona cuando el servicio falla", async () => {
  let requested = "";
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    requested = String(input);
    return new Response(JSON.stringify([{ lat: "8.76", lon: "-75.89" }]), { status: 200 });
  }) as typeof fetch;

  const found = await geocode("Calle 10 # 5-20", "Norte");
  assert.deepEqual(found, { lat: 8.76, lng: -75.89, source: "nominatim" });
  assert.equal(new URL(requested).searchParams.get("q"), "Calle 10 # 5-20, Montería, Córdoba, Colombia");

  globalThis.fetch = (async () => new Response("error", { status: 503 })) as typeof fetch;
  const fallback = await locate("Calle 10 # 5-20", "Norte");
  assert.equal(fallback.source, "zone");
  assert.ok(fallback.lat > depot().lat);
  assert.deepEqual(approximateByZone("Norte", "Calle 10 # 5-20"), fallback);

  globalThis.fetch = (async () => new Response(JSON.stringify([{ lat: "4.65", lon: "-74.05" }]), { status: 200 })) as typeof fetch;
  assert.equal(await geocode("Calle 10 # 5-20", "Norte"), null);

  process.env.GEOCODING_ENABLED = "false";
  assert.equal(await geocode("cualquiera", "Sur"), null);
});
