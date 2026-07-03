/**
 * Borough map — every live signal pinned across the five boroughs.
 * Circle markers colored by urgency, sized by intent score; click a pin
 * to open the borrower resume. Tiles restyle with the app theme.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useApp, useVisibleFeed } from "../store";
import type { TriggerItem, TriggerKind } from "../types";
import { money } from "../lib/format";
import { Select, type SelectOption } from "./ui";

const NYC_CENTER: [number, number] = [40.72, -73.93];

const KIND_OPTIONS: SelectOption<"all" | TriggerKind>[] = [
  { value: "all", label: "All signals" },
  { value: "maturity", label: "Maturities" },
  { value: "cash_poor", label: "Cash-poor buys" },
  { value: "permit", label: "Permits" },
  { value: "lien", label: "Distress" },
  { value: "custom", label: "Your signals" },
];

const URGENCY_COLOR: Record<TriggerItem["urgency"], string> = {
  critical: "#e0796b",
  hot: "#d9a954",
  warm: "#6cc3d5",
};

export function MapView() {
  const maturity = useVisibleFeed("maturity");
  const cashPoor = useVisibleFeed("cash_poor");
  const permit = useVisibleFeed("permit");
  const lien = useVisibleFeed("lien");
  const custom = useVisibleFeed("custom");
  const openResume = useApp((s) => s.openResume);
  const theme = useApp((s) => s.theme);
  const [kind, setKind] = useState<"all" | TriggerKind>("all");

  const items = useMemo(() => {
    const all = [...maturity, ...cashPoor, ...permit, ...lien, ...custom];
    return all.filter(
      (t) =>
        t.property?.lat != null &&
        t.property?.lng != null &&
        (kind === "all" || t.kind === kind)
    );
  }, [maturity, cashPoor, permit, lien, custom, kind]);

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layerRef = useRef<L.LayerGroup | null>(null);

  const tilesRef = useRef<L.TileLayer | null>(null);

  // init once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: NYC_CENTER,
      zoom: 11,
      zoomControl: true,
      attributionControl: true,
    });
    layerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
      tilesRef.current = null;
    };
  }, []);

  // theme-matched basemap (CARTO dark/light)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    tilesRef.current?.remove();
    tilesRef.current = L.tileLayer(
      `https://{s}.basemaps.cartocdn.com/${theme === "dark" ? "dark_all" : "light_all"}/{z}/{x}/{y}{r}.png`,
      {
        maxZoom: 19,
        subdomains: "abcd",
        attribution: "&copy; OpenStreetMap &copy; CARTO",
      }
    ).addTo(map);
  }, [theme]);

  // render markers when data/filter changes
  useEffect(() => {
    const layer = layerRef.current;
    const map = mapRef.current;
    if (!layer || !map) return;
    layer.clearLayers();
    const bounds: [number, number][] = [];
    items.forEach((t) => {
      const lat = t.property!.lat!;
      const lng = t.property!.lng!;
      bounds.push([lat, lng]);
      const marker = L.circleMarker([lat, lng], {
        radius: 6 + (t.score / 100) * 8,
        color: URGENCY_COLOR[t.urgency],
        weight: 2,
        fillColor: URGENCY_COLOR[t.urgency],
        fillOpacity: 0.35,
      });
      marker.bindTooltip(
        `<strong>${t.entity.name}</strong><br/>${t.property!.address} · ${t.property!.city}<br/>${t.headline}`,
        { direction: "top", offset: [0, -6], opacity: 0.95 }
      );
      marker.on("click", () => void openResume(t.entity.id, t));
      marker.addTo(layer);
    });
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
  }, [items, openResume]);

  const counts = {
    maturity: items.filter((t) => t.kind === "maturity").length,
    cash_poor: items.filter((t) => t.kind === "cash_poor").length,
    permit: items.filter((t) => t.kind === "permit").length,
    lien: items.filter((t) => t.kind === "lien").length,
  };
  const totalValue = items.reduce((s, t) => {
    const p = t.payload;
    return s + Number(p.principal ?? p.cashDeployed ?? p.valuation ?? p.amount ?? 0);
  }, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <Select size="sm" className="w-44" value={kind} options={KIND_OPTIONS} onChange={setKind} />
          <div className="flex shrink-0 items-center gap-2.5 text-2xs text-tx3">
            {(["critical", "hot", "warm"] as const).map((u) => (
              <span key={u} className="flex items-center gap-1 capitalize">
                <span className="h-2 w-2 rounded-full" style={{ background: URGENCY_COLOR[u] }} />
                {u}
              </span>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-tx3">
          <span className="tabular-nums">
            <span className="font-semibold text-tx1">{items.length}</span> pins ·{" "}
            <span className="font-semibold text-tx1">{money(totalValue)}</span> in signals
          </span>
          <span>{counts.maturity} maturities</span>
          <span>{counts.cash_poor} cash-poor</span>
          <span>{counts.permit} permits</span>
          <span>{counts.lien} liens</span>
        </div>
      </div>

      <div className="card overflow-hidden p-0">
        <div ref={containerRef} className="h-[calc(100vh-230px)] min-h-[420px] w-full" />
      </div>
      <p className="text-2xs text-tx3">
        Click a pin to open the borrower resume. Pin size tracks intent score.
      </p>
    </div>
  );
}
