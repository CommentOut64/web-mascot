import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { mascotLog } from "./vite-plugin-mascot-log";
import { ANIMATION_PRESET_FILE } from "./src/core/animationPreset";

const projectRoot = dirname(fileURLToPath(import.meta.url));

/**
 * Serve `dist/` **raw**, straight from disk.
 *
 * Why this exists: a Vite dev server started before `npm run build:lib` keeps
 * answering `/dist/...` from its transform cache, so a browser test can silently
 * run the *previous* build. That happened once and produced a whole round of
 * wrong conclusions ("remote reservation never happens") — the page was running a
 * bundle from before the feature existed.
 *
 * These routes bypass the module graph entirely: no transform, no cache, no
 * sourcemap rewriting. The bytes the page receives are byte-identical to the
 * files the packer ships, so the harness can hash what it loaded and compare it
 * with `dist/` and the tarball.
 */
function serveDistRaw() {
  const roots = [
    { prefix: "/dist", root: resolve(projectRoot, "dist") },
    { prefix: "/pkg", root: resolve(projectRoot, "dist") },
  ];
  const MIME: Record<string, string> = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".xml": "application/xml; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
  };
  return {
    name: "web-mascot:serve-dist-raw",
    configureServer(server: { middlewares: { use: (path: string, fn: any) => void } }) {
      for (const { prefix, root } of roots) {
        server.middlewares.use(prefix, (req: any, res: any, next: () => void) => {
          const rel = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
          const file = resolve(root, rel);
          if (file !== root && !file.startsWith(root + sep)) {
            res.statusCode = 403;
            res.end();
            return;
          }
          void (async () => {
            try {
              const info = await stat(file);
              if (!info.isFile()) {
                next();
                return;
              }
              res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
              res.setHeader("cache-control", "no-store");
              res.setHeader("content-length", String(info.size));
              createReadStream(file).pipe(res);
            } catch {
              next();
            }
          })();
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [
    vue(),
    // Raw dist passthrough for browser verification; see serveDistRaw().
    serveDistRaw(),
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
