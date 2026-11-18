export interface Point {
  lat: number;
  lng: number;
}

export interface Located extends Point {
  source: "nominatim" | "zone";
}

const EARTH_RADIUS_KM = 6371;
const rad = (deg: number) => (deg * Math.PI) / 180;

export function haversineKm(a: Point, b: Point) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export const depot = () => ({
  name: process.env.DEPOT_NAME ?? "Centro de acopio Montería",
  lat: Number(process.env.DEPOT_LAT ?? 8.7479),
  lng: Number(process.env.DEPOT_LNG ?? -75.8814),
});

export function nearestNeighborOrder<T extends Point>(origin: Point, stops: T[]): T[] {
  const remaining = [...stops];
  const ordered: T[] = [];
  let current = origin;
  while (remaining.length > 0) {
    let best = 0;
    let bestDistance = Infinity;
    remaining.forEach((stop, i) => {
      const d = haversineKm(current, stop);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    });
    const [next] = remaining.splice(best, 1);
    ordered.push(next);
    current = next;
  }
  return ordered;
}

export function routeDistanceKm(origin: Point, ordered: Point[]) {
  let total = 0;
  let current = origin;
  for (const stop of ordered) {
    total += haversineKm(current, stop);
    current = stop;
  }
  return Math.round(total * 100) / 100;
}

const ZONE_OFFSETS: Record<string, Point> = {
  centro: { lat: 0, lng: 0 },
  norte: { lat: 0.03, lng: 0 },
  sur: { lat: -0.03, lng: 0 },
  occidente: { lat: 0, lng: -0.035 },
  oriente: { lat: 0, lng: 0.035 },
};

function hash(text: string) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

export function approximateByZone(zone: string, address: string): Located {
  const base = depot();
  const offset = ZONE_OFFSETS[zone.trim().toLowerCase()] ?? { lat: 0, lng: 0 };
  const h = hash(address);
  const jitterLat = ((h % 1000) / 1000 - 0.5) * 0.012;
  const jitterLng = (((h >>> 10) % 1000) / 1000 - 0.5) * 0.012;
  return { lat: base.lat + offset.lat + jitterLat, lng: base.lng + offset.lng + jitterLng, source: "zone" };
}

const NOMINATIM_URL = process.env.GEOCODER_URL ?? "https://nominatim.openstreetmap.org/search";
const MIN_GAP_MS = 1100;
let queue: Promise<unknown> = Promise.resolve();

export function geocode(address: string, zone: string): Promise<Located | null> {
  if (process.env.GEOCODING_ENABLED === "false") return Promise.resolve(null);
  const run = async (): Promise<Located | null> => {
    try {
      const url = new URL(NOMINATIM_URL);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("limit", "1");
      url.searchParams.set("countrycodes", "co");
      url.searchParams.set("q", `${address}, ${process.env.GEOCODING_CITY ?? "Montería, Córdoba"}, Colombia`);
      const res = await fetch(url, {
        headers: { "User-Agent": "FarmToTable-logistics/1.0 (proyecto academico)", Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const results = (await res.json()) as { lat: string; lon: string }[];
      const first = results[0];
      if (!first) return null;
      const lat = Number(first.lat);
      const lng = Number(first.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      const maxKm = Number(process.env.GEOCODING_MAX_KM ?? 60);
      if (haversineKm({ lat, lng }, depot()) > maxKm) return null;
      return { lat, lng, source: "nominatim" };
    } catch {
      return null;
    }
  };
  const result = queue.then(run);
  queue = result.then(() => new Promise((r) => setTimeout(r, MIN_GAP_MS)));
  return result;
}

export async function locate(address: string, zone: string): Promise<Located> {
  return (await geocode(address, zone)) ?? approximateByZone(zone, address);
}
