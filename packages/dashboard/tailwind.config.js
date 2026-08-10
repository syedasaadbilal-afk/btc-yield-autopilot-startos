/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        mono: ["'JetBrains Mono'", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      colors: {
        // Hashrate Autopilot's palette: near-black navy background, emerald
        // for positive/live values, amber/gold for the LIVE state and key
        // accents, slate for borders/muted text.
        ink: {
          950: "#080b14",
          900: "#0c1120",
          800: "#111827",
        },
      },
    },
  },
  plugins: [],
};
