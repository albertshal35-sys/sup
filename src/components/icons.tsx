/**
 * Icon layer — Lucide, tuned to a 1.75px stroke for the hairline aesthetic.
 * Components keep semantic Icon* names so call sites stay stable.
 */

import type { ComponentType } from "react";
import {
  Activity,
  AlertTriangle,
  Banknote,
  Bookmark,
  Building2,
  CalendarClock,
  Check,
  ChevronRight,
  ExternalLink,
  Hammer,
  LayoutGrid,
  Mail,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Phone,
  Radar,
  Search,
  Settings,
  Sun,
  X,
  type LucideProps,
} from "lucide-react";

export type IconType = (p: { className?: string }) => JSX.Element;

const tune =
  (C: ComponentType<LucideProps>): IconType =>
  ({ className }) => <C strokeWidth={1.75} className={className ?? "h-4 w-4"} aria-hidden />;

export const IconGrid = tune(LayoutGrid);
export const IconClock = tune(CalendarClock);
export const IconCash = tune(Banknote);
export const IconHammer = tune(Hammer);
export const IconAlert = tune(AlertTriangle);
export const IconBookmark = tune(Bookmark);
export const IconGear = tune(Settings);
export const IconSearch = tune(Search);
export const IconPhone = tune(Phone);
export const IconMail = tune(Mail);
export const IconX = tune(X);
export const IconChevronRight = tune(ChevronRight);
export const IconPulse = tune(Activity);
export const IconBuilding = tune(Building2);
export const IconRadar = tune(Radar);
export const IconMenu = tune(Menu);
export const IconExternal = tune(ExternalLink);
export const IconCheck = tune(Check);
export const IconSun = tune(Sun);
export const IconMoon = tune(Moon);
export const IconCollapse = tune(PanelLeftClose);
export const IconExpand = tune(PanelLeftOpen);
