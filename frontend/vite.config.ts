import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/etf-portfolio-profiler/",
  build: {
    chunkSizeWarningLimit: 1500,
  },
  plugins: [react()],
});
