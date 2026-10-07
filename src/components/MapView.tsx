"use client";

import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { TIER_COLOR } from "@/lib/fuse";
import type { FusedClosure, LngLat } from "@/lib/types";

const STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

export interface MapRoutes {
  baseline?: LngLat[];
  adjusted?: LngLat[];
  from?: LngLat;
  to?: LngLat;
}

function closuresGeoJSON(closures: FusedClosure[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: closures.flatMap((c) => {
      const props = {
        key: c.key,
        label: c.label,
        color: c.mode === "transit" ? "#2563eb" : TIER_COLOR[c.tier],
        confidence: Math.round(c.confidence * 100),
        tier: c.tier,
        mode: c.mode,
        sources: `${c.counts.official} official · ${c.counts.social} social · ${c.counts.report} reports`,
      };
      return [
        c.geo.area
          ? { type: "Feature" as const, properties: { ...props, area: 1 }, geometry: { type: "Polygon" as const, coordinates: [c.geo.line] } }
          : { type: "Feature" as const, properties: { ...props, area: 0 }, geometry: { type: "LineString" as const, coordinates: c.geo.line } },
      ];
    }),
  };
}

function lineFC(line?: LngLat[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: line?.length ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: line } }] : [],
  };
}

function pointsFC(points: (LngLat | undefined)[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: points
      .map((p, i) => (p ? { type: "Feature" as const, properties: { role: i === 0 ? "A" : "B" }, geometry: { type: "Point" as const, coordinates: p } } : null))
      .filter((f): f is NonNullable<typeof f> => f !== null),
  };
}

export default function MapView({ closures, routes }: { closures: FusedClosure[]; routes: MapRoutes }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const loaded = useRef(false);
  const latest = useRef({ closures, routes });
  latest.current = { closures, routes };

  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({
      container: container.current,
      style: STYLE,
      center: [-73.988, 40.748],
      zoom: 13.3,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

    map.on("load", () => {
      map.addSource("closures", { type: "geojson", data: closuresGeoJSON([]) });
      map.addSource("baseline", { type: "geojson", data: lineFC() });
      map.addSource("adjusted", { type: "geojson", data: lineFC() });
      map.addSource("endpoints", { type: "geojson", data: pointsFC([]) });

      map.addLayer({ id: "baseline", type: "line", source: "baseline",
        paint: { "line-color": "#6b7280", "line-width": 4, "line-dasharray": [1.5, 1.5], "line-opacity": 0.8 } });
      map.addLayer({ id: "adjusted", type: "line", source: "adjusted",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#16a34a", "line-width": 5, "line-opacity": 0.9 } });
      map.addLayer({ id: "closure-areas", type: "fill", source: "closures", filter: ["==", ["get", "area"], 1],
        paint: { "fill-color": ["get", "color"], "fill-opacity": ["interpolate", ["linear"], ["get", "confidence"], 0, 0.1, 100, 0.35] } });
      map.addLayer({ id: "closure-area-outline", type: "line", source: "closures", filter: ["==", ["get", "area"], 1],
        paint: { "line-color": ["get", "color"], "line-width": 2, "line-dasharray": [2, 1] } });
      map.addLayer({ id: "closure-lines", type: "line", source: "closures", filter: ["==", ["get", "area"], 0],
        layout: { "line-cap": "round" },
        paint: { "line-color": ["get", "color"], "line-width": ["interpolate", ["linear"], ["get", "confidence"], 0, 4, 100, 9], "line-opacity": 0.85 } });
      map.addLayer({ id: "endpoints", type: "circle", source: "endpoints",
        paint: { "circle-radius": 7, "circle-color": ["match", ["get", "role"], "A", "#111827", "#16a34a"], "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });

      for (const layer of ["closure-lines", "closure-areas"]) {
        map.on("click", layer, (e) => {
          const p = e.features?.[0]?.properties;
          if (!p) return;
          new maplibregl.Popup({ closeButton: false })
            .setLngLat(e.lngLat)
            .setHTML(`<strong>${p.label}</strong><br/>${p.tier} · ${p.confidence}% · ${p.mode}<br/><span style="color:#6b7280">${p.sources}</span>`)
            .addTo(map);
        });
        map.on("mouseenter", layer, () => (map.getCanvas().style.cursor = "pointer"));
        map.on("mouseleave", layer, () => (map.getCanvas().style.cursor = ""));
      }
      loaded.current = true;
      sync(map, latest.current.closures, latest.current.routes);
    });
    return () => {
      loaded.current = false;
      map.remove();
    };
  }, []);

  useEffect(() => {
    if (mapRef.current && loaded.current) sync(mapRef.current, closures, routes);
  }, [closures, routes]);

  return <div ref={container} className="h-full w-full" />;
}

function sync(map: MLMap, closures: FusedClosure[], routes: MapRoutes) {
  (map.getSource("closures") as GeoJSONSource).setData(closuresGeoJSON(closures));
  (map.getSource("baseline") as GeoJSONSource).setData(lineFC(routes.baseline));
  (map.getSource("adjusted") as GeoJSONSource).setData(lineFC(routes.adjusted));
  (map.getSource("endpoints") as GeoJSONSource).setData(pointsFC([routes.from, routes.to]));
}
