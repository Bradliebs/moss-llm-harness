import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  resolve: {
    alias: {
      "@common": resolve(__dirname, "common"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Fonts stay files: the CSP (default-src 'self') blocks data: fonts, and
    // an inlined font subset silently fell back to a system font.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : undefined),
  },
});
