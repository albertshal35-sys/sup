import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // wrangler dev (worker API) runs on 8787 locally
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
});
