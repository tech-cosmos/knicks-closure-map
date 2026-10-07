"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fuse, TIER_COLOR } from "@/lib/fuse";
import { ROUTE_POINTS } from "@/lib/grid";
import { SCENARIO } from "@/lib/scenario";
import type { ExtractResponse, FeedEvent, FusedClosure, JevTriage, LngLat, Report, SourceType } from "@/lib/types";
import type { MapRoutes } from "./MapView";

const MapView = dynamic(() => import("./MapView"), { ssr: false });

type FeedItem = {
  event: FeedEvent;
  status: "extracting" | "done" | "error";
  engine?: ExtractResponse["engine"];
  placed?: number;
  unresolved?: number;
  jev?: JevTriage | null;
};

type Costing = "auto" | "pedestrian";
type RouteLeg = { line: LngLat[]; minutes: number; km: number };
type RouteState = {
  baseline: RouteLeg;
  adjusted: RouteLeg;
  /** Avoided closures the usual (fastest) route would have gone through. */
  detouredAround: FusedClosure[];
  /** Closures the recommended route still touches because they're below the avoid level. */
  passesThrough: FusedClosure[];
  /** Avoided closures containing the start or end point (can't be routed around). */
  skipped: FusedClosure[];
  /** Lowest-confidence closures dropped to stay under the router's polygon limit. */
  overLimit: FusedClosure[];
};

/** The public Valhalla server rejects requests with more exclude_polygons vertices than this. */
const MAX_AVOID_VERTICES = 100;

const AVOID_LEVELS = [
  { id: "confirmed", label: "Confirmed", min: 0.85 },
  { id: "likely", label: "+ Likely", min: 0.5 },
  { id: "all", label: "+ Rumors", min: 0.05 },
] as const;
type AvoidLevel = (typeof AVOID_LEVELS)[number]["id"];

const SOURCE_BADGE: Record<SourceType, string> = {
  official: "bg-blue-100 text-blue-800",
  social: "bg-purple-100 text-purple-800",
  report: "bg-emerald-100 text-emerald-800",
};

function clock(t: number) {
  const base = 22 * 60 + 30 + Math.floor(t);
  const h = Math.floor(base / 60) % 24, m = base % 60;
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;

function pointInRing([x, y]: LngLat, ring: LngLat[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const hits = (pt: LngLat, c: FusedClosure) => c.geo.polygons.some((ring) => pointInRing(pt, ring));

/**
 * Tonight, street closures are caused by crowds, so walkers avoid them too even when the
 * alert says "closed to vehicles". Transit notices (station entrances) never block streets.
 */
const blocksStreets = (c: FusedClosure) => c.mode !== "transit";
/** Does the route touch the closure? Samples every ~10 m, since route vertices sit at intersections. */
function crosses(line: LngLat[], c: FusedClosure) {
  for (let i = 1; i < line.length; i++) {
    const [a, b] = [line[i - 1], line[i]];
    const steps = Math.max(1, Math.ceil(Math.hypot((b[0] - a[0]) * 84_000, (b[1] - a[1]) * 111_000) / 10));
    for (let k = 0; k <= steps; k++) {
      if (hits([a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps], c)) return true;
    }
  }
  return false;
}

export default function Dashboard() {
  const [simTime, setSimTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1); // sim minutes per real second
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [avoidLevel, setAvoidLevel] = useState<AvoidLevel>("likely");
  const [costing, setCosting] = useState<Costing>("auto");
  const [fromId, setFromId] = useState("bar");
  const [toId, setToId] = useState("les");
  const [route, setRoute] = useState<RouteState | null>(null);
  const [routing, setRouting] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const seen = useRef(new Set<string>());

  // --- Simulation clock -------------------------------------------------------
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setSimTime((t) => Math.min(t + speed * 0.25, 45)), 250);
    return () => clearInterval(id);
  }, [playing, speed]);

  // --- Ingest: extract every event whose time has come ------------------------
  const ingest = useCallback(async (event: FeedEvent) => {
    setFeed((f) => [{ event, status: "extracting" }, ...f]);
    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: event.text, source: event.source }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as ExtractResponse;
      setReports((rs) => [
        ...rs,
        ...data.placed.map(({ claim, geo }) => ({
          eventId: event.id, source: event.source, author: event.author, text: event.text, t: event.t, claim, geo,
          stated: data.jev?.stated,
        })),
      ]);
      setFeed((f) => f.map((it) => it.event.id === event.id
        ? { ...it, status: "done", engine: data.engine, placed: data.placed.length, unresolved: data.unresolved.length, jev: data.jev }
        : it));
    } catch {
      setFeed((f) => f.map((it) => (it.event.id === event.id ? { ...it, status: "error" } : it)));
    }
  }, []);

  useEffect(() => {
    for (const ev of SCENARIO) {
      if (ev.t <= simTime && !seen.current.has(ev.id)) {
        seen.current.add(ev.id);
        void ingest(ev);
      }
    }
  }, [simTime, ingest]);

  const submitReport = () => {
    const text = draft.trim();
    if (!text) return;
    const ev: FeedEvent = { id: `u${Date.now()}`, t: simTime, source: "report", author: "You", text };
    seen.current.add(ev.id);
    setDraft("");
    void ingest(ev);
  };

  const reset = () => {
    setPlaying(false);
    setSimTime(0);
    setFeed([]);
    setReports([]);
    seen.current.clear();
  };

  // --- Fusion -----------------------------------------------------------------
  const closures = useMemo(() => fuse(reports, simTime), [reports, simTime]);

  // --- Routing ----------------------------------------------------------------
  const from = ROUTE_POINTS.find((p) => p.id === fromId)!.at;
  const to = ROUTE_POINTS.find((p) => p.id === toId)!.at;
  const threshold = AVOID_LEVELS.find((l) => l.id === avoidLevel)!.min;
  const avoidSet = useMemo(
    () => closures.filter((c) => c.confidence >= threshold && blocksStreets(c)),
    [closures, threshold],
  );
  const avoidedKeys = useMemo(() => new Set(avoidSet.map((c) => c.key)), [avoidSet]);
  const avoidSignature = [...avoidedKeys].sort().join("|");

  const latestClosures = useRef(closures);
  latestClosures.current = closures;
  const requestId = useRef(0);

  // Always keep a route on screen: re-plan whenever the trip or the avoided closures change.
  useEffect(() => {
    const id = ++requestId.current;
    const timer = setTimeout(async () => {
      setRouting(true);
      setRouteError(null);
      // Valhalla can't route out of an excluded polygon, so skip closures containing an endpoint.
      const routable = avoidSet.filter((c) => !hits(from, c) && !hits(to, c));
      const skipped = avoidSet.filter((c) => !routable.includes(c));
      // Keep the most confident closures that fit the router's vertex budget (avoidSet is sorted by confidence).
      const usable: FusedClosure[] = [], overLimit: FusedClosure[] = [];
      let vertices = 0;
      for (const c of routable) {
        const n = c.geo.polygons.reduce((sum, ring) => sum + ring.length, 0);
        if (vertices + n <= MAX_AVOID_VERTICES) {
          usable.push(c);
          vertices += n;
        } else overLimit.push(c);
      }
      try {
        const res = await fetch("/api/route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from, to, costing, avoid: usable.flatMap((c) => c.geo.polygons) }),
        });
        const data = await res.json();
        if (id !== requestId.current) return; // a newer request superseded this one
        if (!res.ok) throw new Error(data.error ?? "Routing failed");
        const usableKeys = new Set(usable.map((c) => c.key));
        setRoute({
          baseline: data.baseline,
          adjusted: data.adjusted,
          detouredAround: usable.filter((c) => crosses(data.baseline.line, c)),
          passesThrough: latestClosures.current.filter(
            (c) => blocksStreets(c) && !usableKeys.has(c.key) && crosses(data.adjusted.line, c),
          ),
          skipped,
          overLimit,
        });
      } catch (err) {
        if (id === requestId.current) setRouteError((err as Error).message);
      } finally {
        if (id === requestId.current) setRouting(false);
      }
    }, 300);
    return () => clearTimeout(timer);
    // avoidSignature stands in for avoidSet; confidence wiggles alone shouldn't re-route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avoidSignature, costing, fromId, toId]);

  const mapRoutes: MapRoutes = useMemo(() => ({
    baseline: route && route.detouredAround.length ? route.baseline.line : undefined,
    adjusted: route?.adjusted.line,
    from,
    to,
  }), [route, from, to]);

  return (
    <div className="flex h-screen w-full flex-col bg-neutral-50 text-neutral-900 md:flex-row">
      {/* Sidebar */}
      <aside className="flex w-full flex-col border-r border-neutral-200 bg-white md:h-full md:w-[400px]">
        <header className="border-b border-neutral-200 px-4 py-3">
          <h1 className="text-lg font-bold tracking-tight">
            <span className="text-orange-500">Knicks Win</span> Closure Map
          </h1>
          <p className="text-xs text-neutral-500">Official alerts, social posts and crowd reports, combined into one map</p>
        </header>

        {/* Replay controls */}
        <section className="space-y-2 border-b border-neutral-200 px-4 py-3">
          <div className="flex items-center gap-2">
            <button onClick={() => setPlaying((p) => !p)}
              className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700">
              {playing ? "Pause" : simTime === 0 ? "Start replay" : "Resume"}
            </button>
            <button onClick={reset} className="rounded-md border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-100">Reset</button>
            <div className="ml-auto text-right">
              <div className="font-mono text-lg font-semibold">{clock(simTime)}</div>
              <div className="text-[11px] text-neutral-500">+{simTime.toFixed(0)} min after buzzer</div>
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-neutral-600">
            Speed
            <input type="range" min={0.5} max={5} step={0.5} value={speed} onChange={(e) => setSpeed(+e.target.value)} className="flex-1" />
            <span className="w-16 text-right font-mono">{speed} min/s</span>
          </label>
        </section>

        {/* Live feed */}
        <section className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="mb-2 flex gap-2">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitReport()}
              placeholder='Report a closure, e.g. "8th ave blocked 40th to 42nd"'
              className="flex-1 rounded-md border border-neutral-300 px-2 py-1.5 text-sm outline-none focus:border-neutral-900" />
            <button onClick={submitReport} className="rounded-md bg-emerald-600 px-3 text-sm font-medium text-white hover:bg-emerald-500">Report</button>
          </div>
          {feed.length === 0 && <p className="py-6 text-center text-sm text-neutral-400">Press Start replay to begin the night.</p>}
          <ul className="space-y-2">
            {feed.map(({ event, status, engine, placed, unresolved, jev }) => (
              <li key={event.id} className="rounded-lg border border-neutral-200 p-2.5 text-sm">
                <div className="mb-1 flex items-center gap-2 text-[11px]">
                  <span className={`rounded px-1.5 py-0.5 font-semibold uppercase ${SOURCE_BADGE[event.source]}`}>{event.source}</span>
                  <span className="font-medium text-neutral-700">{event.author}</span>
                  <span className="ml-auto font-mono text-neutral-400">{clock(event.t)}</span>
                </div>
                <p className="leading-snug">{event.text}</p>
                <div className="mt-1 text-[11px] text-neutral-500">
                  {status === "extracting" && <span className="animate-pulse">Extracting…</span>}
                  {status === "error" && <span className="text-red-600">Extraction failed</span>}
                  {status === "done" && engine === "skipped" && <span>Skipped: Jev saw no closure</span>}
                  {status === "done" && engine !== "skipped" && (
                    <span>
                      {placed ? `📍 ${placed} closure${placed > 1 ? "s" : ""} mapped` : "No closure found"}
                      {unresolved ? ` · ${unresolved} couldn't be placed` : ""} · via {engine}
                    </span>
                  )}
                  {status === "done" && jev && (
                    <span className="ml-1 font-mono text-violet-600" title="Jev: chance this reports a closure · chance it's first-hand rather than hearsay">
                      · closure {pct(jev.relevant)} · first-hand {pct(jev.stated)}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </aside>

      {/* Map + overlays */}
      <main className="relative min-h-[60vh] flex-1">
        <MapView closures={closures} avoidedKeys={avoidedKeys} routes={mapRoutes} />

        {/* Closure list / legend */}
        <div className="absolute left-3 top-3 w-72 max-h-[45%] overflow-y-auto rounded-lg bg-white/95 p-3 text-sm shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-semibold">Active closures</h2>
            <span className="text-xs text-neutral-500">{closures.length}</span>
          </div>
          <div className="mb-2 flex flex-wrap gap-2 text-[11px]">
            {(["confirmed", "likely", "rumored"] as const).map((t) => (
              <span key={t} className="flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: TIER_COLOR[t] }} />{t}</span>
            ))}
            <span className="flex items-center gap-1"><i className="inline-block h-2.5 w-2.5 rounded-full bg-blue-600" />transit</span>
          </div>
          {closures.length === 0 && <p className="text-xs text-neutral-400">Nothing reported yet.</p>}
          <ul className="space-y-1.5">
            {closures.map((c) => (
              <li key={c.key} className="text-xs">
                <div className="flex items-center gap-2">
                  <i className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c.mode === "transit" ? "#2563eb" : TIER_COLOR[c.tier] }} />
                  <span className={`flex-1 font-medium ${blocksStreets(c) && !avoidedKeys.has(c.key) ? "text-neutral-400" : ""}`}>{c.label}</span>
                  <span className="font-mono">{Math.round(c.confidence * 100)}%</span>
                </div>
                <div className="ml-4 h-1 rounded bg-neutral-100">
                  <div className="h-1 rounded" style={{ width: `${c.confidence * 100}%`, background: c.mode === "transit" ? "#2563eb" : TIER_COLOR[c.tier] }} />
                </div>
                <div className="ml-4 text-[10px] text-neutral-500">
                  {c.counts.official} official · {c.counts.social} social · {c.counts.report} reports
                  {c.mode === "transit" ? " · transit only" : avoidedKeys.has(c.key) ? " · avoiding" : " · not avoiding"}
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* Route planner */}
        <div className="absolute bottom-3 left-3 right-3 rounded-lg bg-white/95 p-3 text-sm shadow-lg md:right-auto md:w-[380px]">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="font-semibold">Get me home</h2>
            <div className="flex rounded-md border border-neutral-300 p-0.5 text-xs">
              {(["auto", "pedestrian"] as const).map((c) => (
                <button key={c} onClick={() => setCosting(c)}
                  className={`rounded px-2 py-0.5 ${costing === c ? "bg-neutral-900 text-white" : "text-neutral-600"}`}>
                  {c === "auto" ? "🚕 Drive" : "🚶 Walk"}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-[40px_1fr] items-center gap-x-2 gap-y-1.5 text-xs">
            <span className="text-neutral-500">From</span>
            <select value={fromId} onChange={(e) => setFromId(e.target.value)} className="rounded border border-neutral-300 px-1 py-1">
              {ROUTE_POINTS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <span className="text-neutral-500">To</span>
            <select value={toId} onChange={(e) => setToId(e.target.value)} className="rounded border border-neutral-300 px-1 py-1">
              {ROUTE_POINTS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <span className="text-neutral-500">Avoid</span>
            <div className="flex rounded-md border border-neutral-300 p-0.5">
              {AVOID_LEVELS.map((l) => (
                <button key={l.id} onClick={() => setAvoidLevel(l.id)}
                  className={`flex-1 rounded px-1.5 py-0.5 ${avoidLevel === l.id ? "bg-neutral-900 text-white" : "text-neutral-600"}`}>
                  {l.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-3 border-t border-neutral-200 pt-2 text-xs">
            {routeError ? (
              <p className="text-red-600">{routeError}</p>
            ) : !route ? (
              <p className="text-neutral-500">Finding a route…</p>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <span className="flex items-center gap-1.5 font-medium">
                    <i className="inline-block h-1 w-4 rounded bg-green-600" /> Your route
                    {routing && <span className="animate-pulse text-neutral-400">updating…</span>}
                  </span>
                  <span className="font-mono text-sm font-semibold">
                    {route.adjusted.minutes.toFixed(0)} min · {route.adjusted.km.toFixed(1)} km
                  </span>
                </div>
                {route.detouredAround.length > 0 ? (
                  <p className="rounded bg-green-50 p-1.5 text-green-900">
                    ✓ Detours around <b>{route.detouredAround.map((c) => c.label).join(", ")}</b>.{" "}
                    The usual route (gray dashes) would take {route.baseline.minutes.toFixed(0)} min if the streets were clear
                    {Math.round(route.adjusted.minutes - route.baseline.minutes) > 0
                      ? `; this one adds ${Math.round(route.adjusted.minutes - route.baseline.minutes)} min.`
                      : "."}
                  </p>
                ) : (
                  <p className="text-green-800">✓ No closures on this route.</p>
                )}
                {route.passesThrough.length > 0 && (
                  <p className="rounded bg-yellow-50 p-1.5 text-yellow-900">
                    Goes through {route.passesThrough.map((c) => `${c.label} (${c.tier}, ${Math.round(c.confidence * 100)}%)`).join(", ")}.
                    {avoidLevel !== "all" && (
                      <>{" "}<button onClick={() => setAvoidLevel(avoidLevel === "confirmed" ? "likely" : "all")} className="underline">Avoid these too</button></>
                    )}
                  </p>
                )}
                {route.overLimit.length > 0 && (
                  <p className="text-neutral-500">
                    Too many closures for the router at once. Not avoiding the least certain: {route.overLimit.map((c) => c.label).join(", ")}.
                  </p>
                )}
                {route.skipped.length > 0 && (
                  <p className="text-neutral-500">
                    You&apos;re starting or ending inside {route.skipped.map((c) => c.label).join(", ")}, so it can&apos;t be avoided.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
