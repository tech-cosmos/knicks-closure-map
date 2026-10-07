import "server-only";
import type { JevTriage } from "./types";

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const MODEL = process.env.TYPESAFE_MODEL ?? "jev-latest";

/**
 * Both questions go in one call and are answered in parallel. They are asked about the
 * whole post, so a post that mixes a rumor with a first-hand report gets one blended value.
 */
const QUESTIONS = {
  relevant: {
    type: "noul",
    instructions: "Does this post say that a street, intersection, area or subway station in New York City is closed, blocked, or has reopened?",
    criteria: {
      true: "Names or describes a specific place that is closed, blocked by crowds or police, or reopened",
      false: "Only celebration, hype, opinions or general crowd talk, with no place said to be closed, blocked or reopened",
    },
  },
  stated: {
    type: "noul",
    instructions: "Does the author state the closure as a fact, from an official notice or from what they see themselves?",
    criteria: {
      true: "An official notice, or the author describes what they are seeing in person",
      false: "A rumor, second-hand claim (\"heard\", \"someone said\"), a question, or a guess",
    },
  },
} as const;

type NoulAnswer = { type: "noul"; noul: number };

/** Jev (TypeSafe System One) triage of one post. Null when there is no API key or the call fails. */
export async function jevTriage(text: string): Promise<JevTriage | null> {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch(TYPESAFE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, state: text, questions: QUESTIONS }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) throw new Error(`TypeSafe HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as { answers?: Record<keyof typeof QUESTIONS, NoulAnswer | undefined> };
    const relevant = data.answers?.relevant?.noul;
    const stated = data.answers?.stated?.noul;
    if (typeof relevant !== "number" || typeof stated !== "number") return null;
    return { relevant, stated };
  } catch (err) {
    console.warn("[jev] triage failed, skipping:", (err as Error).message);
    return null;
  }
}
