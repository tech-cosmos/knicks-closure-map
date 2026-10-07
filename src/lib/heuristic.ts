import type { ClosureClaim, ClosureMode, PlaceKey } from "./types";

/**
 * Regex fallback extractor, used when no Anthropic credentials are configured or
 * the API call fails. Good enough for the scripted demo; Claude handles the messy stuff.
 */
const S =
  "(?:broadway|(?:(?:w|e|west|east)\\.?\\s+)?\\d{1,3}(?:st|nd|rd|th)?(?:\\s+(?:st|street|ave|avenue|av)\\b)?" +
  "|(?:first|second|third|fifth|sixth|seventh|eighth|ninth|tenth|lexington|lex)(?:\\s+(?:ave|avenue|av)\\b)?" +
  "|(?:park|madison)\\s+(?:ave|avenue|av)\\b)"; // "Madison Square Garden" is not Madison Ave
// Allow a few filler words ("8th ave is PACKED, cops just shut it between 31st and 34th"), within one sentence.
const SEGMENT = new RegExp(`(${S})(?:\\s+[^\\s.!?]+){0,7}?\\s+(?:between|btwn|b/w|from)\\s+(${S})\\s*(?:and|&|(?:up |down )?to|thru|through|-|–)\\s*(${S})`, "gi");

const PLACE_PATTERNS: [PlaceKey, RegExp][] = [
  ["canyon-of-heroes", /canyon of heroes|parade/i],
  ["penn-station", /penn station|34 st-penn/i],
  ["times-square", /times (sq|square)/i],
  ["msg", /\bmsg\b|madison square garden|the garden/i],
];

export function heuristicExtract(text: string): ClosureClaim[] {
  const reopened = /re-?open|back open|cleared|lifted/i.test(text);
  const hearsay = /\bheard\b|someone said|rumou?r|can anyone confirm|\?\?/i.test(text);
  const mode: ClosureMode = /\b(mta|subway|station|entrance)/i.test(text)
    ? "transit"
    : /to (vehic|vehicular)|vehicular traffic/i.test(text)
      ? "vehicles"
      : "all";
  const base = {
    status: reopened ? "reopened" : "closed",
    mode,
    certainty: hearsay ? "hearsay" : "stated",
    summary: text.slice(0, 120),
  } as const;

  const claims: ClosureClaim[] = [];
  for (const m of text.matchAll(SEGMENT)) {
    claims.push({ ...base, kind: "segment", street: m[1], from_street: m[2], to_street: m[3], place: null });
  }
  // Only fall back to a named place when no specific segment was given, or for transit/parade notices.
  for (const [place, re] of PLACE_PATTERNS) {
    const specific = place === "penn-station" || place === "canyon-of-heroes";
    if (re.test(text) && (specific || claims.length === 0)) {
      if (place === "canyon-of-heroes") claims.length = 0; // the route is the place
      if (place === "msg" && !/clos|block|shut|packed/i.test(text)) continue;
      claims.push({ ...base, kind: "place", street: null, from_street: null, to_street: null, place });
      if (specific) break;
    }
  }
  return claims;
}
