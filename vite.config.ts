import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Относительные пути работают и на GitHub Pages, и на своём домене.
  base: "./",
  plugins: [react()],
  build: { chunkSizeWarningLimit: 900 },
});
