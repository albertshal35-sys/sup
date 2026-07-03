/**
 * Custom form/overlay primitives — no native selects, date inputs or menus.
 * Popovers render into a document-body portal with fixed positioning, so
 * they overlay every container (kanban columns, modals, scroll areas)
 * instead of being clipped by overflow.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { classNames, shortDate } from "../lib/format";
import { IconCalendar, IconCheck, IconChevronLeft, IconChevronRight, IconX } from "./icons";
import { ChevronDown, MoreHorizontal } from "lucide-react";

/* ----------------------------- popover core ----------------------------- */

interface Anchor {
  top: number;
  left?: number;
  right?: number;
  width: number;
}

/** Shared open/anchor/dismiss logic for portal popovers. */
function usePopover(align: "left" | "right") {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);

  const toggle = useCallback(() => {
    setOpen((o) => !o);
  }, []);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    setAnchor({
      top: r.bottom + 6,
      left: align === "left" ? r.left : undefined,
      right: align === "right" ? window.innerWidth - r.right : undefined,
      width: r.width,
    });
  }, [open, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!triggerRef.current?.contains(t) && !popRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    // reposition is fiddly on scroll — just dismiss, like native menus
    const onScroll = (e: Event) => {
      if (popRef.current?.contains(e.target as Node)) return;
      close();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
    };
  }, [open, close]);

  return { open, toggle, close, anchor, triggerRef, popRef };
}

function Portal({
  anchor,
  popRef,
  matchWidth,
  children,
  width,
}: {
  anchor: Anchor | null;
  popRef: React.RefObject<HTMLDivElement>;
  matchWidth?: boolean;
  width?: number;
  children: ReactNode;
}) {
  if (!anchor) return null;
  return createPortal(
    <div
      ref={popRef}
      style={{
        position: "fixed",
        top: anchor.top,
        left: anchor.left,
        right: anchor.right,
        minWidth: matchWidth ? anchor.width : undefined,
        width,
        zIndex: 90,
      }}
      className="animate-scale-in rounded-xl border border-line bg-surface p-1 shadow-pop"
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body
  );
}

/* -------------------------------- Toggle -------------------------------- */

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={classNames(
        "relative h-5 w-9 shrink-0 overflow-hidden rounded-full border transition-colors duration-200",
        checked ? "border-accent/50 bg-accent/80" : "border-line bg-raised",
        disabled && "cursor-not-allowed opacity-40"
      )}
    >
      <span
        className={classNames(
          "absolute left-0.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-white shadow-sm transition-transform duration-200",
          checked ? "translate-x-[15px]" : "translate-x-0"
        )}
      />
    </button>
  );
}

/* -------------------------------- Select -------------------------------- */

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  hint?: string;
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder = "Select…",
  className,
  size = "md",
}: {
  value: T | null;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  placeholder?: string;
  className?: string;
  size?: "sm" | "md";
}) {
  const { open, toggle, close, anchor, triggerRef, popRef } = usePopover("left");
  const [hi, setHi] = useState(-1);
  const current = options.find((o) => o.value === value);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open && (e.key === "Enter" || e.key === " " || e.key === "ArrowDown")) {
      e.preventDefault();
      toggle();
      setHi(Math.max(0, options.findIndex((o) => o.value === value)));
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHi((h) => Math.min(options.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter" && hi >= 0) {
      e.preventDefault();
      onChange(options[hi].value);
      close();
    }
  };

  return (
    <div ref={triggerRef} className={classNames("relative", className)} onKeyDown={onKeyDown}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
        className={classNames(
          "flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-surface text-left transition-colors hover:border-tx3/40",
          size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3 py-2 text-[13px]"
        )}
      >
        <span className={classNames("truncate", current ? "text-tx1" : "text-tx3")}>
          {current?.label ?? placeholder}
        </span>
        <ChevronDown
          strokeWidth={1.75}
          className={classNames("h-3.5 w-3.5 shrink-0 text-tx3 transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <Portal anchor={anchor} popRef={popRef} matchWidth>
          <div role="listbox">
            {options.map((o, i) => (
              <button
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                onClick={() => {
                  onChange(o.value);
                  close();
                }}
                onPointerEnter={() => setHi(i)}
                className={classNames(
                  "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-1.5 text-left text-xs",
                  i === hi ? "bg-raised text-tx1" : "text-tx2"
                )}
              >
                <span className="truncate">
                  {o.label}
                  {o.hint && <span className="ml-1.5 text-2xs text-tx3">{o.hint}</span>}
                </span>
                {o.value === value && <IconCheck className="h-3.5 w-3.5 shrink-0 text-accent" />}
              </button>
            ))}
          </div>
        </Portal>
      )}
    </div>
  );
}

/* --------------------------------- Menu --------------------------------- */

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  divider?: boolean; // draw a hairline above this item
}

export function Menu({
  items,
  button,
  align = "right",
  header,
}: {
  items: MenuItem[];
  button?: ReactNode; // custom trigger content; defaults to a kebab
  align?: "left" | "right";
  header?: ReactNode;
}) {
  const { open, toggle, close, anchor, triggerRef, popRef } = usePopover(align);

  return (
    <div ref={triggerRef} className="relative inline-flex">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
        className={classNames(
          "rounded-lg transition-colors",
          button ? "" : "p-1 text-tx3 hover:bg-raised hover:text-tx1"
        )}
      >
        {button ?? <MoreHorizontal strokeWidth={1.75} className="h-4 w-4" />}
      </button>
      {open && (
        <Portal anchor={anchor} popRef={popRef} width={208}>
          <div role="menu">
            {header && <div className="border-b border-line px-2.5 py-2">{header}</div>}
            {items.map((item, i) => (
              <div key={i}>
                {item.divider && <div className="mx-1 my-1 border-t border-line" />}
                <button
                  role="menuitem"
                  onClick={() => {
                    close();
                    item.onSelect();
                  }}
                  className={classNames(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-raised",
                    item.danger ? "text-danger" : "text-tx2 hover:text-tx1"
                  )}
                >
                  {item.icon}
                  {item.label}
                </button>
              </div>
            ))}
          </div>
        </Portal>
      )}
    </div>
  );
}

/* ------------------------------- DatePicker ------------------------------ */

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function DatePicker({
  value,
  onChange,
  placeholder = "Set date",
  className,
}: {
  value: string | null; // ISO yyyy-mm-dd
  onChange: (v: string | null) => void;
  placeholder?: string;
  className?: string;
}) {
  const { open, toggle, close, anchor, triggerRef, popRef } = usePopover("left");
  const todayIso = toIso(new Date());
  const anchorDate = value ? new Date(value + "T00:00:00") : new Date();
  const [viewYear, setViewYear] = useState(anchorDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(anchorDate.getMonth());

  useEffect(() => {
    if (open && value) {
      const d = new Date(value + "T00:00:00");
      setViewYear(d.getFullYear());
      setViewMonth(d.getMonth());
    }
  }, [open, value]);

  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: firstDay }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const shift = (delta: number) => {
    const d = new Date(viewYear, viewMonth + delta, 1);
    setViewYear(d.getFullYear());
    setViewMonth(d.getMonth());
  };

  return (
    <div ref={triggerRef} className={classNames("relative", className)}>
      <button
        type="button"
        onClick={toggle}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-left text-xs transition-colors hover:border-tx3/40"
      >
        <span className={classNames("truncate tabular-nums", value ? "text-tx1" : "text-tx3")}>
          {value ? shortDate(value) : placeholder}
        </span>
        <span className="flex items-center gap-1">
          {value && (
            <span
              role="button"
              tabIndex={0}
              aria-label="Clear date"
              onClick={(e) => {
                e.stopPropagation();
                onChange(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.stopPropagation();
                  onChange(null);
                }
              }}
              className="rounded p-0.5 text-tx3 hover:bg-raised hover:text-danger"
            >
              <IconX className="h-3 w-3" />
            </span>
          )}
          <IconCalendar className="h-3.5 w-3.5 shrink-0 text-tx3" />
        </span>
      </button>

      {open && (
        <Portal anchor={anchor} popRef={popRef} width={240}>
          <div className="p-1.5">
            <div className="flex items-center justify-between pb-2">
              <button
                onClick={() => shift(-1)}
                aria-label="Previous month"
                className="rounded-lg p-1 text-tx3 hover:bg-raised hover:text-tx1"
              >
                <IconChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="text-xs font-semibold text-tx1">
                {MONTHS[viewMonth]} {viewYear}
              </span>
              <button
                onClick={() => shift(1)}
                aria-label="Next month"
                className="rounded-lg p-1 text-tx3 hover:bg-raised hover:text-tx1"
              >
                <IconChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-7 gap-0.5 pb-1">
              {WEEKDAYS.map((d) => (
                <span key={d} className="py-0.5 text-center text-2xs font-medium text-tx3">
                  {d}
                </span>
              ))}
              {cells.map((day, i) => {
                if (day == null) return <span key={`x${i}`} />;
                const iso = toIso(new Date(viewYear, viewMonth, day));
                const selected = iso === value;
                const isToday = iso === todayIso;
                return (
                  <button
                    key={iso}
                    onClick={() => {
                      onChange(iso);
                      close();
                    }}
                    className={classNames(
                      "rounded-lg py-1 text-center text-xs tabular-nums transition-colors",
                      selected
                        ? "bg-accent/15 font-semibold text-accent"
                        : isToday
                          ? "text-tx1 ring-1 ring-inset ring-line"
                          : "text-tx2 hover:bg-raised hover:text-tx1"
                    )}
                  >
                    {day}
                  </button>
                );
              })}
            </div>
            <div className="flex items-center justify-between border-t border-line pt-1.5">
              <button
                onClick={() => {
                  onChange(todayIso);
                  close();
                }}
                className="rounded-lg px-2 py-1 text-2xs font-medium text-accent hover:bg-accent/10"
              >
                Today
              </button>
              <button
                onClick={() => {
                  onChange(null);
                  close();
                }}
                className="rounded-lg px-2 py-1 text-2xs text-tx3 hover:bg-raised hover:text-tx1"
              >
                Clear
              </button>
            </div>
          </div>
        </Portal>
      )}
    </div>
  );
}

/* -------------------------------- Modal -------------------------------- */

export function Modal({
  open,
  onClose,
  title,
  children,
  maxWidth = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  maxWidth?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center sm:p-6">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div
        className={classNames(
          "card relative flex max-h-[88vh] w-full animate-scale-in flex-col overflow-hidden rounded-t-3xl !bg-surface shadow-pop sm:rounded-2xl",
          maxWidth
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <h2 className="font-display text-[15px] font-bold tracking-tight text-tx1">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-tx2 transition-colors hover:bg-raised"
          >
            <IconX className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body
  );
}

/* ------------------------------ TextField ------------------------------ */

export function TextField({
  value,
  onChange,
  placeholder,
  type = "text",
  onBlur,
  className,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  onBlur?: () => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type={type}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      className={classNames(
        "w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-tx1 placeholder:text-tx3 transition-colors focus:border-accent/40 focus:outline-none disabled:opacity-40",
        className
      )}
    />
  );
}

/* ------------------------------ TextArea ------------------------------ */

export function TextArea({
  value,
  onChange,
  placeholder,
  onBlur,
  rows = 2,
  className,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  onBlur?: () => void;
  rows?: number;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <textarea
      rows={rows}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      className={classNames(
        "w-full resize-none rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-tx1 placeholder:text-tx3 transition-colors focus:border-accent/40 focus:outline-none disabled:opacity-40",
        className
      )}
    />
  );
}
