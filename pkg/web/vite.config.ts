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
    // Pin the port so `bun dev:tunnel` (and the ngrok tunnel it points at
    // localhost:5173) always line up; fail loudly rather than silently
    // hopping to 5174 if it's taken.
    port: 5173,
    strictPort: true,
    // Allow tunneling the dev server for phone testing (ngrok serves
    // *.ngrok-free.app on the free plan and *.ngrok.app/*.ngrok.dev on paid
    // ones; Cloudflare quick tunnels kept for compatibility).
    allowedHosts: [".ngrok-free.app", ".ngrok.app", ".ngrok.dev", ".trycloudflare.com"],
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
