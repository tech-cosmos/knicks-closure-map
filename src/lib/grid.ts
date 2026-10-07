import type { ClosureClaim, ClosureGeometry, LngLat, PlaceKey } from "./types";

/**
 * Lightweight Manhattan street-grid model so the demo works offline and
 * deterministically. Coordinates are approximate (~50–100 m).
 * Production: swap for NYC LION street centerlines or OSM ways.
 *
 * Local frame: origin at 5th Ave & 42nd St, v = meters "uptown" along the
 * avenues, u = meters "east" across them. The grid is rotated ~29° from true north.
 */
const ORIGIN = { lat: 40.7531, lng: -73.9808 };
const THETA = (29 * Math.PI) / 180;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LNG = M_PER_DEG_LAT * Math.cos((ORIGIN.lat * Math.PI) / 180);
const BLOCK_M = 80; // one numbered street to the next

const AVENUE_U: Record<string, number> = {
  "1": 1010, "2": 810, "3": 610, lex: 480, park: 350, madison: 170,
  "5": 0, "6": -280, "7": -560, "8": -840, "9": -1120, "10": -1400, "11": -1680, "12": -1960,
};
const AVENUE_LABEL: Record<string, string> = {
  "1": "1st Ave", "2": "2nd Ave", "3": "3rd Ave", lex: "Lexington Ave", park: "Park Ave",
  madison: "Madison Ave", "5": "5th Ave", "6": "6th Ave", "7": "7th Ave", "8": "8th Ave",
  "9": "9th Ave", "10": "10th Ave", "11": "11th Ave", "12": "12th Ave", broadway: "Broadway",
};
const WORD_NUM: Record<string, string> = {
  first: "1", second: "2", third: "3", fifth: "5", sixth: "6", seventh: "7",
  eighth: "8", ninth: "9", tenth: "10", eleventh: "11", twelfth: "12",
};

/** Broadway runs diagonally: [street, u] knots through midtown. */
const BROADWAY_KNOTS: [number, number][] = [
  [14, 380], [23, 0], [34, -280], [45, -560], [59, -840], [72, -1120],
];

function broadwayU(street: number): number {
  const k = BROADWAY_KNOTS;
  if (street <= k[0][0]) return k[0][1];
  for (let i = 1; i < k.length; i++) {
    if (street <= k[i][0]) {
      const [s0, u0] = k[i - 1];
      const [s1, u1] = k[i];
      return u0 + ((street - s0) / (s1 - s0)) * (u1 - u0);
    }
  }
  return k[k.length - 1][1];
}

export function toLngLat(u: number, v: number): LngLat {
  const east = u * Math.cos(THETA) + v * Math.sin(THETA);
  const north = -u * Math.sin(THETA) + v * Math.cos(THETA);
  return [ORIGIN.lng + east / M_PER_DEG_LNG, ORIGIN.lat + north / M_PER_DEG_LAT];
}

const streetV = (n: number) => (n - 42) * BLOCK_M;

/** Point at an (avenue, street) intersection. */
export function intersection(avenue: string, street: number): LngLat {
  const u = avenue === "broadway" ? broadwayU(street) : AVENUE_U[avenue];
  return toLngLat(u, streetV(street));
}

type Parsed = { type: "avenue"; key: string } | { type: "street"; n: number };

/**
 * Normalize "W 33rd St", "33rd street", "Seventh Avenue", "8th", "Bway"...
 * `hint` resolves bare ordinals like "8th" (avenue or street?).
 */
export function parseName(raw: string, hint?: "avenue" | "street"): Parsed | null {
  let s = raw.toLowerCase().replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  s = s.replace(/^(west|east|w|e) /, "");
  if (/^(broadway|bway|b'way)$/.test(s)) return { type: "avenue", key: "broadway" };
  for (const [w, n] of Object.entries(WORD_NUM)) s = s.replace(new RegExp(`^${w}\\b`), n);
  if (/^(lex|lexington)( ave(nue)?| av)?$/.test(s)) return { type: "avenue", key: "lex" };
  if (/^park( ave(nue)?| av)$/.test(s)) return { type: "avenue", key: "park" };
  if (/^madison( ave(nue)?| av)?$/.test(s)) return { type: "avenue", key: "madison" };

  const m = s.match(/^(\d{1,3})(?:st|nd|rd|th)?(?: (st|street|ave|avenue|av))?$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const suffix = m[2];
  const isAve = suffix ? suffix.startsWith("av") : hint === "avenue" || (!hint && n <= 12);
  if (isAve) return AVENUE_U[String(n)] !== undefined ? { type: "avenue", key: String(n) } : null;
  return n >= 1 && n <= 110 ? { type: "street", n } : null;
}

const ordinal = (n: number) =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;

/** Rectangle of half-width `w` meters around the segment a→b, in lng/lat. */
function bufferSegment(a: LngLat, b: LngLat, w = 18): LngLat[] {
  const ax = (a[0] - ORIGIN.lng) * M_PER_DEG_LNG, ay = (a[1] - ORIGIN.lat) * M_PER_DEG_LAT;
  const bx = (b[0] - ORIGIN.lng) * M_PER_DEG_LNG, by = (b[1] - ORIGIN.lat) * M_PER_DEG_LAT;
  const len = Math.hypot(bx - ax, by - ay) || 1;
  const nx = (-(by - ay) / len) * w, ny = ((bx - ax) / len) * w;
  const tx = ((bx - ax) / len) * w, ty = ((by - ay) / len) * w; // extend past the ends a bit
  const pts: [number, number][] = [
    [ax - tx + nx, ay - ty + ny], [bx + tx + nx, by + ty + ny],
    [bx + tx - nx, by + ty - ny], [ax - tx - nx, ay - ty - ny],
  ];
  const ring = pts.map(([x, y]) => [ORIGIN.lng + x / M_PER_DEG_LNG, ORIGIN.lat + y / M_PER_DEG_LAT] as LngLat);
  return [...ring, ring[0]];
}

function lineGeometry(key: string, label: string, line: LngLat[]): ClosureGeometry {
  const polygons: LngLat[][] = [];
  for (let i = 1; i < line.length; i++) polygons.push(bufferSegment(line[i - 1], line[i]));
  return { key, label, line, polygons, area: false };
}

function rectGeometry(key: string, label: string, aves: [string, string], streets: [number, number]): ClosureGeometry {
  const [a1, a2] = aves, [s1, s2] = streets;
  const ring = [intersection(a1, s1), intersection(a1, s2), intersection(a2, s2), intersection(a2, s1)];
  const closed = [...ring, ring[0]];
  return { key, label, line: closed, polygons: [closed], area: true };
}

const PLACES: Record<PlaceKey, () => ClosureGeometry> = {
  msg: () => rectGeometry("place:msg", "Madison Square Garden block", ["7", "8"], [31, 33]),
  "times-square": () => rectGeometry("place:times-square", "Times Square", ["6", "8"], [42, 47]),
  "penn-station": () => rectGeometry("place:penn-station", "Penn Station entrances", ["7", "8"], [31, 34]),
  // Canyon of Heroes is downtown, below the grid: hand-placed Broadway centerline.
  "canyon-of-heroes": () =>
    lineGeometry("place:canyon-of-heroes", "Canyon of Heroes (Broadway, Battery Pl → Chambers St)", [
      [-74.0137, 40.7049], [-74.0122, 40.7074], [-74.0104, 40.7093],
      [-74.0093, 40.7105], [-74.0078, 40.7121], [-74.0062, 40.7138],
    ]),
};

/** Turn an extracted claim into map geometry, or null if we can't place it. */
export function resolveClaim(claim: ClosureClaim): ClosureGeometry | null {
  if (claim.kind === "place" && claim.place) return PLACES[claim.place]?.() ?? null;
  if (!claim.street || !claim.from_street || !claim.to_street) {
    return claim.place ? PLACES[claim.place]?.() ?? null : null;
  }

  // Figure out whether the main street is an avenue (cross streets numbered) or vice versa.
  let main = parseName(claim.street);
  const crossHint = main?.type === "avenue" ? "street" : main?.type === "street" ? "avenue" : undefined;
  let from = parseName(claim.from_street, crossHint);
  let to = parseName(claim.to_street, crossHint);
  if (!main && from && to) {
    main = parseName(claim.street, from.type === "street" ? "avenue" : "street");
  }
  if (main?.type === "avenue" && (from?.type !== "street" || to?.type !== "street")) {
    from = parseName(claim.from_street, "street");
    to = parseName(claim.to_street, "street");
  }
  if (!main || !from || !to) return null;

  if (main.type === "avenue" && from.type === "street" && to.type === "street") {
    const lo = Math.min(from.n, to.n), hi = Math.max(from.n, to.n);
    const line: LngLat[] = [];
    for (let n = lo; n <= hi; n++) line.push(intersection(main.key, n));
    return lineGeometry(`ave:${main.key}:${lo}-${hi}`, `${AVENUE_LABEL[main.key]}, ${ordinal(lo)}–${ordinal(hi)} St`, line);
  }
  if (main.type === "street" && from.type === "avenue" && to.type === "avenue") {
    const [a, b] = [from.key, to.key].sort((x, y) => (AVENUE_U[y] ?? 0) - (AVENUE_U[x] ?? 0));
    const line = [intersection(a, main.n), intersection(b, main.n)];
    return lineGeometry(`st:${main.n}:${a}-${b}`, `${ordinal(main.n)} St, ${AVENUE_LABEL[a]} → ${AVENUE_LABEL[b]}`, line);
  }
  return null;
}

export const PLACE_DESCRIPTIONS: Record<PlaceKey, string> = {
  msg: "Madison Square Garden, the block bounded by 7th/8th Ave and W 31st/33rd St",
  "times-square": "Times Square area, 6th–8th Ave between W 42nd and W 47th St",
  "penn-station": "Penn Station / 34 St–Penn Station subway entrances",
  "canyon-of-heroes": "Canyon of Heroes parade route, Broadway from Battery Pl to Chambers St",
};

/** Origins / destinations for the route planner. */
export const ROUTE_POINTS: { id: string; label: string; at: LngLat }[] = [
  { id: "msg", label: "MSG crowd exit (8th Ave & 35th St)", at: intersection("8", 35) },
  { id: "bar", label: "Hell's Kitchen bar (9th Ave & 46th St)", at: intersection("9", 46) },
  { id: "herald", label: "Herald Square (6th Ave & 35th St)", at: intersection("6", 35) },
  { id: "uws", label: "Home: Upper West Side (Broadway & W 72nd St)", at: [-73.9819, 40.7783] },
  { id: "murray", label: "Home: Murray Hill (3rd Ave & E 34th St)", at: intersection("3", 34) },
  { id: "les", label: "Home: Lower East Side (Delancey & Essex)", at: [-73.9877, 40.7185] },
  { id: "bk", label: "Home: Barclays Center, Brooklyn", at: [-73.9754, 40.6826] },
];
