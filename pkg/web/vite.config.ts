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
    // Allow tunneling the dev server through ngrok (e.g. for HTTPS on a phone).
    allowedHosts: [".ngrok-free.app"],
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});
