import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mascotLog } from "./vite-plugin-mascot-log";

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    vue(),
    // Observation log: <repo>/logs/<session>/pet-<n>-<mascot>.log
    // Deliberately outside the Vite root so writing it never triggers HMR.
    mascotLog({ logRoot: resolve(projectRoot, "..", "logs") }),
  ],
  build: {
    // Library build. The demo app (index.html + src/main.ts) is not part of it:
    // in lib mode Vite ignores index.html, and the recorder stays out of the main
    // entry so a published build cannot make host pages post to the dev endpoint.
    lib: {
      entry: {
        index: resolve(projectRoot, "src/index.ts"),
        devtools: resolve(projectRoot, "src/devtools.ts"),
      },
      formats: ["es"],
    },
    rollupOptions: {
      // Vue is a peer dependency: the host owns the Vue instance. Everything else
      // is either bundled or browser-native.
      external: [/^vue(\/.*)?$/],
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
    // Declarations are emitted by `tsc -p tsconfig.lib.json`, which must run
    // AFTER this build: `emptyOutDir` above would otherwise delete `dist/types`
    // and leave the package's `types` export pointing at nothing.
    sourcemap: true,
    emptyOutDir: true,
  },
  server: {
    watch: {
      // Editors write through transient *.tmpdir/*.tmp siblings; watching those
      // used to crash the dev server with EBUSY. Logs live outside the root, but
      // ignore them here too in case the root ever moves.
      ignored: ["**/.*.tmpdir/**", "**/*.tmpdir/**", "**/*.tmp", "**/logs/**"],
    },
  },
});
