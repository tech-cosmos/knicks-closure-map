"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fuse, TIER_COLOR } from "@/lib/fuse";
import { ROUTE_POINTS } from "@/lib/grid";
import { SCENARIO } from "@/lib/scenario";
import type { ExtractResponse, FeedEvent, FusedClosure, LngLat, Report, SourceType } from "@/lib/types";
import type { MapRoutes } from "./MapView";

const MapView = dynamic(() => import("./MapView"), { ssr: false });

type FeedItem = {
  event: FeedEvent;
  status: "extracting" | "done" | "error";
  engine?: ExtractResponse["engine"];
  placed?: number;
  unresolved?: number;
};

type Costing = "auto" | "pedestrian";
type RouteLeg = { line: LngLat[]; minutes: number; km: number };
type RouteState = {
  baseline: RouteLeg;
  adjusted: RouteLeg;
  avoided: string[];
  blockedOnBaseline: string[];
  skipped: string[];
};

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

function pointInRing([x, y]: LngLat, ring: LngLat[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const hits = (pt: LngLat, c: FusedClosure) => c.geo.polygons.some((ring) => pointInRing(pt, ring));

function blocks(c: FusedClosure, costing: Costing) {
  if (c.mode === "transit") return false;
  return c.mode === "all" || (costing === "auto" ? c.mode === "vehicles" : c.mode === "pedestrians");
}

export default function Dashboard() {
  const [simTime, setSimTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1); // sim minutes per real second
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [threshold, setThreshold] = useState(0.5);
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
        })),
      ]);
      setFeed((f) => f.map((it) => it.event.id === event.id
        ? { ...it, status: "done", engine: data.engine, placed: data.placed.length, unresolved: data.unresolved.length }
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
    setRoute(null);
    seen.current.clear();
  };

  // --- Fusion -----------------------------------------------------------------
  const closures = useMemo(() => fuse(reports, simTime), [reports, simTime]);

  // --- Routing ----------------------------------------------------------------
  const from = ROUTE_POINTS.find((p) => p.id === fromId)!.at;
  const to = ROUTE_POINTS.find((p) => p.id === toId)!.at;
  const avoidSet = useMemo(
    () => closures.filter((c) => c.confidence >= threshold && blocks(c, costing)),
    [closures, threshold, costing],
  );
  const avoidSignature = avoidSet.map((c) => c.key).sort().join("|");

  const plan = useCallback(async () => {
    setRouting(true);
    setRouteError(null);
    // Valhalla can't route out of an excluded polygon, so skip closures containing an endpoint.
    const usable = avoidSet.filter((c) => !hits(from, c) && !hits(to, c));
    const skipped = avoidSet.filter((c) => !usable.includes(c)).map((c) => c.label);
    try {
      const res = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, costing, avoid: usable.flatMap((c) => c.geo.polygons) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Routing failed");
      const blockedOnBaseline = usable
        .filter((c) => (data.baseline.line as LngLat[]).some((pt) => hits(pt, c)))
        .map((c) => c.label);
      setRoute({ ...data, avoided: usable.map((c) => c.label), blockedOnBaseline, skipped });
    } catch (err) {
      setRouteError((err as Error).message);
    } finally {
      setRouting(false);
    }
  }, [avoidSet, from, to, costing]);

  // Re-plan automatically when the set of closures we avoid changes.
  const planRef = useRef(plan);
  planRef.current = plan;
  const hasRoute = route !== null;
  useEffect(() => {
    if (hasRoute) void planRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avoidSignature, costing, fromId, toId]);

  const mapRoutes: MapRoutes = useMemo(() => ({
    baseline: route && route.blockedOnBaseline.length ? route.baseline.line : undefined,
    adjusted: route?.adjusted.line,
    from,
    to,
  }), [route, from, to]);

  const delta = route ? route.adjusted.minutes - route.baseline.minutes : 0;

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
            {feed.map(({ event, status, engine, placed, unresolved }) => (
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
                  {status === "done" && (
                    <span>
                      {placed ? `📍 ${placed} closure${placed > 1 ? "s" : ""} mapped` : "No closure found"}
                      {unresolved ? ` · ${unresolved} couldn't be placed` : ""} · via {engine}
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
        <MapView closures={closures} routes={mapRoutes} />

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
                  <span className="flex-1 font-medium">{c.label}</span>
                  <span className="font-mono">{Math.round(c.confidence * 100)}%</span>
                </div>
                <div className="ml-4 h-1 rounded bg-neutral-100">
                  <div className="h-1 rounded" style={{ width: `${c.confidence * 100}%`, background: c.mode === "transit" ? "#2563eb" : TIER_COLOR[c.tier] }} />
                </div>
                <div className="ml-4 text-[10px] text-neutral-500">
                  {c.counts.official} official · {c.counts.social} social · {c.counts.report} reports · {c.mode}
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* Route planner */}
        <div className="absolute bottom-3 left-3 right-3 rounded-lg bg-white/95 p-3 text-sm shadow-lg md:right-auto md:w-[380px]">
          <h2 className="mb-2 font-semibold">Get me home</h2>
          <div className="grid grid-cols-[40px_1fr] items-center gap-x-2 gap-y-1.5 text-xs">
            <span className="text-neutral-500">From</span>
            <select value={fromId} onChange={(e) => setFromId(e.target.value)} className="rounded border border-neutral-300 px-1 py-1">
              {ROUTE_POINTS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
            <span className="text-neutral-500">To</span>
            <select value={toId} onChange={(e) => setToId(e.target.value)} className="rounded border border-neutral-300 px-1 py-1">
              {ROUTE_POINTS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
          <div className="mt-2 flex items-center gap-2 text-xs">
            {(["auto", "pedestrian"] as const).map((c) => (
              <button key={c} onClick={() => setCosting(c)}
                className={`rounded-md px-2 py-1 ${costing === c ? "bg-neutral-900 text-white" : "border border-neutral-300"}`}>
                {c === "auto" ? "🚕 Drive" : "🚶 Walk"}
              </button>
            ))}
            <label className="ml-auto flex items-center gap-1 text-neutral-600" title="Avoid closures at or above this confidence">
              Avoid ≥
              <input type="range" min={0.1} max={0.9} step={0.05} value={threshold} onChange={(e) => setThreshold(+e.target.value)} className="w-20" />
              <span className="w-8 font-mono">{Math.round(threshold * 100)}%</span>
            </label>
          </div>
          <button onClick={() => void plan()} disabled={routing}
            className="mt-2 w-full rounded-md bg-green-600 py-1.5 font-medium text-white hover:bg-green-500 disabled:opacity-60">
            {routing ? "Routing…" : route ? "Re-plan route" : "Plan route"}
          </button>
          {routeError && <p className="mt-2 text-xs text-red-600">{routeError}</p>}
          {route && (
            <div className="mt-2 space-y-1 text-xs">
              <div className="flex justify-between">
                <span>Recommended route</span>
                <span className="font-mono font-semibold">{route.adjusted.minutes.toFixed(0)} min · {route.adjusted.km.toFixed(1)} km</span>
              </div>
              {route.blockedOnBaseline.length > 0 ? (
                <p className="rounded bg-orange-50 p-1.5 text-orange-800">
                  Usual route ({route.baseline.minutes.toFixed(0)} min, dashed) goes through{" "}
                  <b>{route.blockedOnBaseline.join(", ")}</b>.{" "}
                  {Math.round(delta) > 0 ? `The detour adds ${Math.round(delta)} min.` : "The detour takes about the same time."}
                </p>
              ) : (
                <p className="text-neutral-500">Your usual route is clear of the {route.avoided.length} closures you&apos;re avoiding.</p>
              )}
              {route.skipped.length > 0 && (
                <p className="text-neutral-500">Starting or ending inside {route.skipped.join(", ")}, so that closure can&apos;t be avoided.</p>
              )}
              <p className="text-[10px] text-neutral-400">Re-plans automatically when the closure picture changes.</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
