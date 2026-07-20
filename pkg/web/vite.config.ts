import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // Listen on all interfaces so phones on the LAN can reach the dev server.
    host: true,
    // Pin the port so `bun dev:tunnel` (and the Cloudflare quick tunnel it
    // points at localhost:5173) always line up; fail loudly rather than
    // silently hopping to 5174 if it's taken.
    port: 5173,
    strictPort: true,
    // Allow tunneling the dev server for phone testing (Cloudflare quick
    // tunnels serve on *.trycloudflare.com; ngrok kept for compatibility).
    allowedHosts: [".trycloudflare.com", ".ngrok-free.app"],
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
