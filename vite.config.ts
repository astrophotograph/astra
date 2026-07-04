import { defineConfig, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

import { cloudflare } from "@cloudflare/vite-plugin";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // `--mode web` builds the browser bundle the daemon serves under /app:
  // base-pathed assets, dist-web/ output, and no Cloudflare worker plugin
  // (that belongs to the astra.gallery worker, not the app).
  const web = mode === "web";
  const plugins: PluginOption[] = web ? [react()] : [react(), cloudflare()];
  const desktopTarget =
    process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13";

  return {
    plugins,

    base: web ? "/app/" : "/",

    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
      // Web dev (`pnpm dev:web`): API + health go to the local daemon so the
      // browser app works same-origin-ish without the Rust static server.
      proxy: {
        "/api": "http://127.0.0.1:27872",
        "/healthz": "http://127.0.0.1:27872",
      },
    },

    // Build optimizations
    build: {
      outDir: web ? "dist-web" : "dist",
      target: web ? "es2022" : desktopTarget,
      minify: !process.env.TAURI_ENV_DEBUG ? ("esbuild" as const) : false,
      sourcemap: !!process.env.TAURI_ENV_DEBUG,
    },
  };
});
