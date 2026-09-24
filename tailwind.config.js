/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        mono: [
          "JetBrains Mono",
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
      },
      colors: {
        // Canvas / panels / insets
        canvas: "#0c0e17",
        panel: "#141724",
        inset: "#0a0b12",
        // Accents
        neon: "#00FF9D",
        "neon-dim": "#10B981",
        glow: "#6366F1",
        "glow-dim": "#4F46E5",
        // Status: warnings + failures (tokenized so no raw palette leaks)
        warn: "#FBBF24",
        danger: "#F87171",
        "danger-strong": "#DC2626",  // close-button fill; white text needs the darker red
        // Text
        "text-primary": "#CBD5E1",
        "text-muted": "#64748B",
        // Borders
        edge: "#1E293B",
        "edge-bright": "#2A2F45",
      },
      backgroundImage: {
        "grid-stripes":
          "repeating-linear-gradient(45deg, #0c0e17, #0c0e17 10px, #0e101b 10px, #0e101b 20px)",
      },
      boxShadow: {
        "glow-sm": "0 0 12px rgba(99, 102, 241, 0.25)",
        neon: "0 0 8px rgba(0, 255, 157, 0.3)",
      },
    },
  },
  plugins: [],
};