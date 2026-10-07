export type SourceType = "official" | "social" | "report";

export type LngLat = [number, number];

/** One raw item from any feed (official alert, social post, crowd report). */
export interface FeedEvent {
  id: string;
  /** Simulated minutes after the final buzzer. */
  t: number;
  source: SourceType;
  author: string;
  text: string;
}

export const PLACE_KEYS = [
  "msg",
  "times-square",
  "penn-station",
  "canyon-of-heroes",
] as const;
export type PlaceKey = (typeof PLACE_KEYS)[number];

export type ClosureMode = "vehicles" | "pedestrians" | "all" | "transit";

/** Structured claim the extractor pulls out of free text. */
export interface ClosureClaim {
  kind: "segment" | "place";
  street: string | null;
  from_street: string | null;
  to_street: string | null;
  place: PlaceKey | null;
  status: "closed" | "reopened";
  mode: ClosureMode;
  /** "hearsay" = "heard that...", "someone said...", rumors. */
  certainty: "stated" | "hearsay";
  summary: string;
}

export interface ClosureGeometry {
  /** Stable cluster key, e.g. "ave:7:31-34" or "place:msg". */
  key: string;
  label: string;
  /** Centerline for drawing (segments) or outline (places). */
  line: LngLat[];
  /** Closed rings to avoid when routing. */
  polygons: LngLat[][];
  /** True for named areas (drawn filled), false for street segments. */
  area: boolean;
}

/** A claim that was successfully placed on the map. */
export interface Report {
  eventId: string;
  source: SourceType;
  author: string;
  text: string;
  t: number;
  claim: ClosureClaim;
  geo: ClosureGeometry;
}

export type Tier = "confirmed" | "likely" | "rumored";

export interface FusedClosure {
  key: string;
  label: string;
  geo: ClosureGeometry;
  mode: ClosureMode;
  confidence: number;
  tier: Tier;
  counts: Record<SourceType, number>;
  reports: Report[];
  lastSeen: number;
}

export interface ExtractResponse {
  placed: { claim: ClosureClaim; geo: ClosureGeometry }[];
  unresolved: ClosureClaim[];
  engine: "claude" | "heuristic";
}
