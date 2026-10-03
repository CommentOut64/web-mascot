import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mascotLog } from "./vite-plugin-mascot-log";
import { ANIMATION_PRESET_FILE } from "./src/core/animationPreset";

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    vue(),
    // Observation log: web-mascot/logs/<session>/pet-<n>-<mascot>.log
    // It lives inside the package so a log always sits with the code that produced
    // it, and `server.watch.ignored` keeps it out of the watcher — writing a log
    // must never trigger HMR. `logs/` is gitignored, so recordings never ship.
    mascotLog({ logRoot: resolve(projectRoot, "logs"), text: true }),
    // The copy of the built-in preset that ships as `dist/animation.config.json`
    // (exported as `web-mascot/animation.config.json` for hosts that want a file to
    // edit). It is generated from the very data the engine applies by default, so
    // the template and the default behaviour cannot drift apart.
    {
      name: "web-mascot:emit-animation-preset",
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "animation.config.json",
          source: `${JSON.stringify(ANIMATION_PRESET_FILE, null, 2)}\n`,
        });
      },
    },
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
      // The library entries import nothing from Vue — only this repo's demo app
      // does (`src/main.ts`), and the demo is not part of the lib build. The rule
      // is kept as a guard so that if a Vue-based helper is ever added to an
      // entry, the host's own Vue instance is still never duplicated.
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
