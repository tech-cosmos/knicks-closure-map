import { NextResponse } from "next/server";
import { extract } from "@/lib/extract";
import type { SourceType } from "@/lib/types";

const SOURCES: SourceType[] = ["official", "social", "report"];

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { text?: string; source?: SourceType } | null;
  const text = body?.text?.trim();
  if (!text || text.length > 2000) {
    return NextResponse.json({ error: "text is required (max 2000 chars)" }, { status: 400 });
  }
  const source = SOURCES.includes(body?.source as SourceType) ? (body!.source as SourceType) : "report";
  return NextResponse.json(await extract(text, source));
}
