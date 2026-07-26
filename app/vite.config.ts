import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: proxy API + generated models to the Python backend on :8000.
// LAN prod: `npm run build` -> dist/, served by the backend.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // expose on the LAN for testing from other machines
    proxy: {
      "/api": "http://localhost:8000",
      "/model": "http://localhost:8000",
    },
  },
});
