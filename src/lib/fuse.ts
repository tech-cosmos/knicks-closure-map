import type { FusedClosure, Report, SourceType, Tier } from "./types";

/** How much a single report moves confidence, before decay. */
const WEIGHT: Record<SourceType, number> = { official: 0.9, social: 0.35, report: 0.5 };
/** Unofficial reports go stale; official alerts hold until reopened. */
const HALF_LIFE_MIN: Record<SourceType, number> = { official: Infinity, social: 30, report: 45 };
const HEARSAY_FACTOR = 0.4;

export function tierFor(confidence: number): Tier {
  if (confidence >= 0.85) return "confirmed";
  if (confidence >= 0.5) return "likely";
  return "rumored";
}

export const TIER_COLOR: Record<Tier, string> = {
  confirmed: "#dc2626",
  likely: "#f97316",
  rumored: "#eab308",
};

/**
 * Cluster reports by closure key and combine them with noisy-OR:
 *   confidence = 1 - Π(1 - weight_i · decay_i)
 * An official "reopened" wipes earlier evidence; an unofficial one halves it.
 */
export function fuse(reports: Report[], now: number): FusedClosure[] {
  const byKey = new Map<string, Report[]>();
  for (const r of reports) {
    if (r.t > now) continue;
    const list = byKey.get(r.geo.key) ?? [];
    list.push(r);
    byKey.set(r.geo.key, list);
  }

  const out: FusedClosure[] = [];
  for (const [key, list] of byKey) {
    list.sort((a, b) => a.t - b.t);
    let miss = 1; // Π(1 - p)
    let active: Report[] = [];
    for (const r of list) {
      if (r.claim.status === "reopened") {
        if (r.source === "official") {
          miss = 1;
          active = [];
        } else {
          miss = 1 - (1 - miss) * 0.5;
        }
        continue;
      }
      const age = now - r.t;
      const decay = Math.pow(0.5, age / HALF_LIFE_MIN[r.source]);
      const p = WEIGHT[r.source] * decay * (r.claim.certainty === "hearsay" ? HEARSAY_FACTOR : 1);
      miss *= 1 - p;
      active.push(r);
    }
    const confidence = 1 - miss;
    if (active.length === 0 || confidence < 0.05) continue;

    const counts: Record<SourceType, number> = { official: 0, social: 0, report: 0 };
    for (const r of active) counts[r.source]++;
    const latest = active[active.length - 1];
    // Prefer the official alert's mode, otherwise the most recent report's.
    const mode = (active.find((r) => r.source === "official") ?? latest).claim.mode;
    out.push({
      key,
      label: latest.geo.label,
      geo: latest.geo,
      mode,
      confidence,
      tier: tierFor(confidence),
      counts,
      reports: active,
      lastSeen: latest.t,
    });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}
