import type { Config } from "tailwindcss";

/**
 * LienWolf design tokens — "Obsidian" dark system.
 * Deep neutral blacks, desaturated glacier-cyan + dusk-violet accents.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#070709",
          900: "#0a0a0e",
          850: "#0e0e13",
          800: "#13131a",
          700: "#1a1a23",
          600: "#25252f",
        },
        mist: {
          100: "#f2f2f5",
          200: "#dcdce2",
          300: "#c2c2cb",
          400: "#9696a3",
          500: "#6c6c79",
          600: "#4a4a55",
        },
        glow: {
          cyan: "#6fd6e4",
          cyanDim: "#2e6b76",
          violet: "#988ceb",
          violetDim: "#4a4380",
          green: "#5ec99a",
          amber: "#dcae5f",
          red: "#e07a6c",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Text",
          "Segoe UI",
          "sans-serif",
        ],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      boxShadow: {
        glass: "0 8px 32px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.04)",
        pop: "0 24px 80px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4)",
        "glow-cyan": "0 0 24px rgba(111,214,228,0.14)",
      },
      backdropBlur: {
        xs: "2px",
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
