import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";
import { VitePWA } from "vite-plugin-pwa";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  base: mode === 'development' ? '/' : './',
  server: {
    host: "0.0.0.0",
    port: 8080,
    hmr: {
      overlay: false,
    },
    proxy: {
      // Optional: bypass Hono and hit LM Studio directly (no LLM_MAX_CONCURRENT). Prefer /api → 3001 and Base URL /api/llm/v1 for normal dev.
      '/lmstudio': {
        target: 'http://127.0.0.1:1234',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/lmstudio/, '/v1'),
      },
      // Team API (Postgres, auth, /api/llm LLM proxy). UI default Base URL /api/llm/v1 uses this.
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  plugins: [
    react(),
    mode === "development" && componentTagger(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.ico", "robots.txt"],
      manifest: {
        name: "EvigStudio",
        short_name: "EvigStudio",
        description: "Local-first agentic coding assistant — languages, frameworks, databases, powered by local AI",
        start_url: "/",
        display: "standalone",
        background_color: "#0d1017",
        theme_color: "#17b8a6",
        icons: [
          {
            src: "/favicon.ico",
            sizes: "64x64",
            type: "image/x-icon",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff,woff2}"],
        // Strict air-gap: visit online once so jsdelivr Monaco assets populate this cache, or bundle Monaco later.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/i,
            handler: "CacheFirst",
            options: {
              cacheName: "monaco-cdn-cache",
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
