import { NextResponse } from "next/server";
import polyline from "@mapbox/polyline";
import type { LngLat } from "@/lib/types";

/** Public Valhalla instance (FOSSGIS). Self-host with Docker for anything beyond a demo. */
const VALHALLA_URL = process.env.VALHALLA_URL ?? "https://valhalla1.openstreetmap.de/route";

interface RouteRequest {
  from: LngLat;
  to: LngLat;
  costing: "auto" | "pedestrian";
  avoid: LngLat[][];
}

export interface RouteResult {
  line: LngLat[];
  minutes: number;
  km: number;
}

async function valhalla(req: RouteRequest, avoid: LngLat[][]): Promise<RouteResult> {
  const body = {
    locations: [
      { lon: req.from[0], lat: req.from[1] },
      { lon: req.to[0], lat: req.to[1] },
    ],
    costing: req.costing,
    exclude_polygons: avoid,
    units: "kilometers",
  };
  const res = await fetch(VALHALLA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  // The public server answers rate limits / overload with HTML, not JSON.
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.trip) throw new Error(json?.error ?? `Routing server busy (HTTP ${res.status}), try again`);
  const { trip } = json;
  const line: LngLat[] = trip.legs
    .flatMap((leg: { shape: string }) => polyline.decode(leg.shape, 6))
    .map(([lat, lng]: [number, number]) => [lng, lat] as LngLat);
  return { line, minutes: trip.summary.time / 60, km: trip.summary.length };
}

export async function POST(request: Request) {
  const req = (await request.json()) as RouteRequest;
  try {
    // Sequential on purpose: the public Valhalla instance rate-limits bursts.
    const baseline = await valhalla(req, []);
    const adjusted = req.avoid.length ? await valhalla(req, req.avoid) : null;
    return NextResponse.json({ baseline, adjusted: adjusted ?? baseline });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
