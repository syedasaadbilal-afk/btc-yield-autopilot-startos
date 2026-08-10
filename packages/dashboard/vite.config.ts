import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // TODO: point at the daemon's HTTP API once it exposes one (design doc
      // mentions Fastify for this; not yet built - dashboard currently reads
      // mock data, see src/api.ts).
      "/api": "http://localhost:3000",
    },
  },
});
