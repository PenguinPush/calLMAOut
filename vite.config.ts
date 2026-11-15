import { cpSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const src = resolve(import.meta.dirname, "src");
const outDir = resolve(import.meta.dirname, "dist");
const modules = resolve(import.meta.dirname, "node_modules");

// MediaPipe loads its WASM runtime by URL at runtime, so it has to be copied in as-is.
function copyWasm(): Plugin {
  const files = {
    "@mediapipe/tasks-vision/wasm/vision_wasm_internal.js": "mediapipe/vision_wasm_internal.js",
    "@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm": "mediapipe/vision_wasm_internal.wasm",
  };
  return {
    name: "copy-wasm",
    writeBundle() {
      for (const [from, to] of Object.entries(files)) cpSync(resolve(modules, from), resolve(outDir, to));
    },
  };
}

// Content scripts can't be ES modules, so `--mode content` builds content.ts
// on its own as a single IIFE into the same dist/.
export default defineConfig(({ mode }) =>
  mode === "content"
    ? {
        build: {
          outDir,
          emptyOutDir: false,
          rolldownOptions: {
            input: resolve(src, "content.ts"),
            output: { format: "iife", entryFileNames: "content.js" },
          },
        },
      }
    : {
        root: src,
        publicDir: resolve(import.meta.dirname, "public"),
        base: "./",
        plugins: [react(), tailwindcss(), copyWasm()],
        build: {
          outDir,
          emptyOutDir: true,
          rolldownOptions: {
            input: {
              popup: resolve(src, "popup.html"),
              options: resolve(src, "options.html"),
              offscreen: resolve(src, "offscreen.html"),
              background: resolve(src, "background.ts"),
            },
            // Chrome rejects files starting with "_", and the manifest needs stable names.
            output: {
              entryFileNames: (chunk) =>
                chunk.name === "background" ? "background.js" : "assets/[name].js",
              chunkFileNames: "assets/chunk-[hash].js",
              assetFileNames: "assets/[name][extname]",
            },
          },
        },
      },
);
