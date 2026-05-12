import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#05060c",
          900: "#0a0c14",
          800: "#10131d",
          700: "#171b29",
          600: "#222839",
          500: "#3a4258",
          400: "#5d6680",
          300: "#8a93ac",
          200: "#c2c8d8",
          100: "#e8eaf2",
        },
        accent: {
          400: "#7c8cff",
          500: "#5b6dff",
          600: "#4658ff",
        },
        success: {
          400: "#34d399",
          500: "#10b981",
        },
        danger: {
          400: "#f87171",
          500: "#ef4444",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "Helvetica Neue",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      backgroundImage: {
        "grid-pattern":
          "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.05) 1px, transparent 0)",
        "accent-glow":
          "radial-gradient(ellipse at top, rgba(91,109,255,0.22), transparent 60%)",
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(124,140,255,0.35), 0 8px 32px -8px rgba(91,109,255,0.5)",
      },
      keyframes: {
        "fade-in": {
          "0%": { opacity: "0", transform: "translateY(4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
      },
      animation: {
        "fade-in": "fade-in 200ms ease-out",
        shimmer: "shimmer 2.4s linear infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
