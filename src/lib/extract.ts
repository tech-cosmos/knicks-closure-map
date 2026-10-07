import "server-only";
import { z } from "zod";
import { PLACE_DESCRIPTIONS, resolveClaim } from "./grid";
import { heuristicExtract } from "./heuristic";
import { PLACE_KEYS, type ClosureClaim, type ExtractResponse, type SourceType } from "./types";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env.OPENROUTER_MODEL ?? "anthropic/claude-opus-5.5";

const ClaimSchema = z.object({
  kind: z.enum(["segment", "place"]),
  street: z.string().nullable(),
  from_street: z.string().nullable(),
  to_street: z.string().nullable(),
  place: z.enum(PLACE_KEYS).nullable(),
  status: z.enum(["closed", "reopened"]),
  mode: z.enum(["vehicles", "pedestrians", "all", "transit"]),
  certainty: z.enum(["stated", "hearsay"]),
  summary: z.string(),
});
const ExtractionSchema = z.object({ closures: z.array(ClaimSchema) });
const EXTRACTION_JSON_SCHEMA = z.toJSONSchema(ExtractionSchema);
delete EXTRACTION_JSON_SCHEMA.$schema; // OpenRouter/providers reject the draft URI

const SYSTEM = `You turn NYC alerts, social media posts and crowd reports about street closures into structured data.
It is the night the Knicks win the championship; posts are noisy, slangy and full of emoji.

For each distinct closure or reopening mentioned, output one entry:
- kind "segment": a single street between two cross streets. Put the main street in "street" and the two cross streets in "from_street"/"to_street", written plainly (e.g. "7th Ave", "W 33rd St", "Broadway"). Bare ordinals are fine ("31st").
- kind "place": use only when the post names one of these places rather than specific streets:
${PLACE_KEYS.map((k) => `  - ${k}: ${PLACE_DESCRIPTIONS[k]}`).join("\n")}
  The parade route is always the place "canyon-of-heroes", even when streets are named.
- status: "reopened" if the post says a closure has ended, otherwise "closed".
- mode: "vehicles" if only cars are blocked, "pedestrians" if only foot traffic is, "transit" for subway/bus/station notices, "all" for crowds filling the street.
- certainty: "hearsay" for rumors, questions, or second-hand claims ("heard...", "someone said...", "??"); otherwise "stated".
- summary: under 15 words.

If the text mentions no closure (just hype), return an empty list. Never invent cross streets that are not in the text.`;

/** Claude via OpenRouter's OpenAI-compatible endpoint, constrained to our JSON schema. */
async function llmExtract(text: string, source: SourceType): Promise<ClosureClaim[] | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "Knicks Win Closure Map",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      reasoning: { effort: "low" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Source type: ${source}\n\n<post>\n${text}\n</post>` },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "closures", strict: true, schema: EXTRACTION_JSON_SCHEMA },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const content: string | undefined = data.choices?.[0]?.message?.content;
  if (!content) return null;
  const parsed = ExtractionSchema.safeParse(JSON.parse(content));
  return parsed.success ? parsed.data.closures : null;
}

export async function extract(text: string, source: SourceType): Promise<ExtractResponse> {
  let claims: ClosureClaim[] | null = null;
  let engine: ExtractResponse["engine"] = "claude";
  if (process.env.EXTRACTOR !== "heuristic") {
    try {
      claims = await llmExtract(text, source);
    } catch (err) {
      console.warn("[extract] OpenRouter call failed, using heuristic:", (err as Error).message);
    }
  }
  if (!claims) {
    claims = heuristicExtract(text);
    engine = "heuristic";
  }

  const placed: ExtractResponse["placed"] = [];
  const unresolved: ClosureClaim[] = [];
  for (const claim of claims) {
    const geo = resolveClaim(claim);
    if (geo) placed.push({ claim, geo });
    else unresolved.push(claim);
  }
  return { placed, unresolved, engine };
}
