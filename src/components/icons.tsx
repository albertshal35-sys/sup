/** Minimal 1.5px-stroke icon set, tuned for the obsidian UI. */

interface IconProps {
  className?: string;
}

const base = (props: IconProps) => ({
  className: props.className ?? "h-4 w-4",
  fill: "none" as const,
  viewBox: "0 0 24 24",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export const IconGrid = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.8" />
  </svg>
);

export const IconClock = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

export const IconCash = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="2.5" y="6.5" width="19" height="11" rx="2" />
    <circle cx="12" cy="12" r="2.6" />
    <path d="M6 9.5v.01M18 14.5v.01" />
  </svg>
);

export const IconHammer = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M14.5 3.5l6 6-2.2 2.2a1.5 1.5 0 01-2.1 0l-3.9-3.9a1.5 1.5 0 010-2.1l2.2-2.2z" />
    <path d="M12.5 9.5l-8.7 8.7a1.7 1.7 0 002.4 2.4l8.7-8.7" />
  </svg>
);

export const IconAlert = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 4l9 15.5H3L12 4z" />
    <path d="M12 10v4M12 17v.01" />
  </svg>
);

export const IconBookmark = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M7 3.5h10a1 1 0 011 1v16l-6-4-6 4v-16a1 1 0 011-1z" />
  </svg>
);

export const IconGear = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19 12a7 7 0 00-.14-1.4l2-1.55-2-3.46-2.35.94a7 7 0 00-2.42-1.4L13.7 2.6h-3.4l-.39 2.53a7 7 0 00-2.42 1.4l-2.35-.94-2 3.46 2 1.55A7 7 0 005 12c0 .48.05.94.14 1.4l-2 1.55 2 3.46 2.35-.94a7 7 0 002.42 1.4l.39 2.53h3.4l.39-2.53a7 7 0 002.42-1.4l2.35.94 2-3.46-2-1.55c.09-.46.14-.92.14-1.4z" />
  </svg>
);

export const IconSearch = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M20 20l-4.2-4.2" />
  </svg>
);

export const IconPhone = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5 4h3.5l1.5 4-2 1.5a12 12 0 006.5 6.5L16 14l4 1.5V19a1.5 1.5 0 01-1.6 1.5C10.6 19.9 4.1 13.4 3.5 5.6A1.5 1.5 0 015 4z" />
  </svg>
);

export const IconMail = (p: IconProps) => (
  <svg {...base(p)}>
    <rect x="3" y="5.5" width="18" height="13" rx="2" />
    <path d="M3.5 7l8.5 6 8.5-6" />
  </svg>
);

export const IconX = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const IconChevronRight = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export const IconFlame = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M12 3s5.5 4.2 5.5 9.5a5.5 5.5 0 11-11 0C6.5 9 9 7 9 7s-.3 2.4 1 3.6C10.5 8 12 3 12 3z" />
  </svg>
);

export const IconPulse = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M3 12h4l2.5-6 4 12L16 12h5" />
  </svg>
);

export const IconBuilding = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4.5 20.5v-14a1 1 0 011-1h7a1 1 0 011 1v14M13.5 9.5h5a1 1 0 011 1v10M4.5 20.5h17" />
    <path d="M7.5 9h2.5M7.5 12.5h2.5M7.5 16h2.5M16.5 13h1M16.5 16.5h1" />
  </svg>
);

export const IconRadar = (p: IconProps) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="8.5" />
    <circle cx="12" cy="12" r="4.5" opacity="0.55" />
    <path d="M12 12l5.5-5.5" />
    <circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none" />
  </svg>
);

export const IconMenu = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);

export const IconExternal = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M14 5h5v5M19 5l-8 8M19 14v4.5a1.5 1.5 0 01-1.5 1.5h-12A1.5 1.5 0 014 18.5v-12A1.5 1.5 0 015.5 5H10" />
  </svg>
);

export const IconCheck = (p: IconProps) => (
  <svg {...base(p)}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);
