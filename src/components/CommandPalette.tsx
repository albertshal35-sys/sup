/**
 * ⌘K command palette — fuzzy search across every entity in the feeds
 * (name, principal, address, city) plus quick view navigation.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useApp, type View } from "../store";
import type { TriggerItem } from "../types";
import { classNames, money } from "../lib/format";
import { IconAlert, IconCash, IconClock, IconGrid, IconHammer, IconKanban, IconSearch } from "./icons";

interface EntityHit {
  type: "entity";
  key: string;
  item: TriggerItem;
  label: string;
  sub: string;
}
interface NavHit {
  type: "nav";
  key: string;
  view: View;
  label: string;
  icon: JSX.Element;
}
type Hit = EntityHit | NavHit;

const NAV_HITS: NavHit[] = [
  { type: "nav", key: "nav-dash", view: "dashboard", label: "Go to Command Center", icon: <IconGrid className="h-4 w-4" /> },
  { type: "nav", key: "nav-mat", view: "maturity", label: "Go to Maturities", icon: <IconClock className="h-4 w-4" /> },
  { type: "nav", key: "nav-cash", view: "cash_poor", label: "Go to Cash-Poor Buyers", icon: <IconCash className="h-4 w-4" /> },
  { type: "nav", key: "nav-permit", view: "permit", label: "Go to Permits", icon: <IconHammer className="h-4 w-4" /> },
  { type: "nav", key: "nav-lien", view: "lien", label: "Go to Lien Alerts", icon: <IconAlert className="h-4 w-4" /> },
  { type: "nav", key: "nav-pipe", view: "watchlist", label: "Go to Pipeline", icon: <IconKanban className="h-4 w-4" /> },
];

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const setPalette = useApp((s) => s.setPalette);
  const setView = useApp((s) => s.setView);
  const openResume = useApp((s) => s.openResume);
  const feeds = useApp((s) => s.feeds);

  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Global shortcut lives here so it works on every view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette(!useApp.getState().paletteOpen);
      }
      if (e.key === "Escape" && useApp.getState().paletteOpen) setPalette(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPalette]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setHi(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase();

    // one hit per entity: its strongest signal
    const byEntity = new Map<string, TriggerItem>();
    Object.values(feeds)
      .flat()
      .forEach((t) => {
        const prev = byEntity.get(t.entity.id);
        if (!prev || t.score > prev.score) byEntity.set(t.entity.id, t);
      });

    const entityHits: EntityHit[] = [...byEntity.values()]
      .filter((t) => {
        if (!q) return true;
        const hay = [
          t.entity.name,
          t.entity.principalName ?? "",
          t.property?.address ?? "",
          t.property?.city ?? "",
          t.property?.county ?? "",
        ]
          .join(" ")
          .toLowerCase();
        return q.split(/\s+/).every((part) => hay.includes(part));
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 7)
      .map((t) => ({
        type: "entity",
        key: t.entity.id,
        item: t,
        label: t.entity.name,
        sub: `${t.property?.address ?? "—"} · ${t.property?.city ?? ""}${
          t.entity.principalName ? ` · ${t.entity.principalName}` : ""
        }`,
      }));

    const navHits = q
      ? NAV_HITS.filter((n) => n.label.toLowerCase().includes(q))
      : NAV_HITS.slice(0, 3);

    return [...entityHits, ...navHits];
  }, [feeds, query]);

  useEffect(() => setHi(0), [query]);

  if (!open) return null;

  const run = (hit: Hit) => {
    setPalette(false);
    if (hit.type === "entity") void openResume(hit.item.entity.id, hit.item);
    else setView(hit.view);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[12vh]">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm dark:bg-black/60"
        onClick={() => setPalette(false)}
      />
      <div className="relative w-full max-w-lg animate-scale-in overflow-hidden rounded-2xl border border-line bg-surface shadow-pop">
        <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
          <IconSearch className="h-4 w-4 shrink-0 text-tx3" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHi((h) => Math.min(hits.length - 1, h + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setHi((h) => Math.max(0, h - 1));
              } else if (e.key === "Enter" && hits[hi]) {
                e.preventDefault();
                run(hits[hi]);
              }
            }}
            placeholder="Search borrowers, principals, addresses…"
            className="w-full bg-transparent text-sm text-tx1 placeholder:text-tx3 focus:outline-none"
          />
          <span className="kbd shrink-0">esc</span>
        </div>

        <div className="max-h-[50vh] overflow-y-auto p-1.5">
          {hits.length === 0 && (
            <p className="px-3 py-6 text-center text-xs text-tx3">No matches for “{query}”.</p>
          )}
          {hits.map((hit, i) => (
            <button
              key={hit.key}
              onClick={() => run(hit)}
              onPointerEnter={() => setHi(i)}
              className={classNames(
                "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors",
                i === hi ? "bg-raised" : ""
              )}
            >
              {hit.type === "entity" ? (
                <>
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-raised text-2xs font-semibold text-tx2">
                    {hit.item.entity.name.slice(0, 2).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-tx1">{hit.label}</span>
                    <span className="block truncate text-2xs text-tx3">{hit.sub}</span>
                  </span>
                  <span className="shrink-0 text-2xs tabular-nums text-tx3">
                    {hit.item.property?.estValue ? money(hit.item.property.estValue) : ""}
                  </span>
                  <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-tx2">
                    {hit.item.score}
                  </span>
                </>
              ) : (
                <>
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-raised text-tx3">
                    {hit.icon}
                  </span>
                  <span className="flex-1 truncate text-[13px] text-tx2">{hit.label}</span>
                  <span className="kbd shrink-0">↵</span>
                </>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
