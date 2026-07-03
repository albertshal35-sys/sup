import type { Config } from "tailwindcss";

/**
 * LienWolf design tokens — dual-theme "Obsidian / Paper" system.
 * All colors resolve through CSS variables set per-theme in index.css,
 * so every component works in both light and dark without variants.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: "rgb(var(--bg) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        raised: "rgb(var(--raised) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        tx1: "rgb(var(--tx1) / <alpha-value>)",
        tx2: "rgb(var(--tx2) / <alpha-value>)",
        tx3: "rgb(var(--tx3) / <alpha-value>)",
        accent: "rgb(var(--accent) / <alpha-value>)",
        violet: "rgb(var(--violet) / <alpha-value>)",
        ok: "rgb(var(--ok) / <alpha-value>)",
        warn: "rgb(var(--warn) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
      },
      fontFamily: {
        sans: [
          "Instrument Sans",
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Text",
          "Segoe UI",
          "sans-serif",
        ],
        display: [
          "Schibsted Grotesk",
          "Instrument Sans",
          "-apple-system",
          "sans-serif",
        ],
        mono: ["IBM Plex Mono", "SF Mono", "ui-monospace", "monospace"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      boxShadow: {
        pop: "0 24px 80px rgba(0,0,0,0.35), 0 2px 8px rgba(0,0,0,0.18)",
      },
      animation: {
        "fade-up": "fadeUp 0.35s cubic-bezier(0.22,1,0.36,1) both",
        "scale-in": "scaleIn 0.25s cubic-bezier(0.22,1,0.36,1) both",
        "pulse-dot": "pulseDot 2.4s ease-in-out infinite",
      },
      keyframes: {
        fadeUp: {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        scaleIn: {
          from: { opacity: "0", transform: "scale(0.97)" },
          to: { opacity: "1", transform: "scale(1)" },
        },
        pulseDot: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
