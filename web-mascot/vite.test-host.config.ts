import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

/**
 * Config for `test-host/`: a minimal host page that embeds the library, and
 * serves the mascot packs itself from a path of its own choosing.
 *
 * The aliases point at the *built* entry points, so this exercises exactly what
 * the `exports` map in package.json declares. Run `npm run build:lib` first.
 */
const projectRoot = dirname(fileURLToPath(import.meta.url));
const dist = (file) => resolve(projectRoot, "dist", file);
const packRoot = resolve(projectRoot, "public", "mascot_pack");
const PREFIX = "/assets/packs";
const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".xml": "application/xml",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * Serve `<projectRoot>/public/mascot_pack` under `PREFIX`, by hand, so the host
 * controls the path and the content types (sprite files have no extension).
 */
function servePacks() {
  return {
    name: "test-host-packs",
    configureServer(server) {
      server.middlewares.use(PREFIX, (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
        const file = resolve(packRoot, rel);
        if (!file.startsWith(packRoot + sep)) {
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
            createReadStream(file).pipe(res);
          } catch {
            next();
          }
        })();
      });
    },
  };
}

/**
 * Serve the *built package's* own packs at their real published path,
 * `/dist/mascot_pack/...`.
 *
 * This is what makes `zero-config.html` a real test: the derived asset URL points
 * here, so if the derivation were wrong the sprites would 404 and the page would
 * say so. Vite's own dev server does not serve a hashed/derived directory like
 * this on its own, and an npm consumer would get it from the package tarball.
 */
function serveDistPacks() {
  const distPackRoot = dist("mascot_pack");
  const prefix = "/dist/mascot_pack";
  return {
    name: "test-host-dist-packs",
    configureServer(server) {
      server.middlewares.use(prefix, (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
        const file = resolve(distPackRoot, rel);
        if (!file.startsWith(distPackRoot + sep)) {
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
            createReadStream(file).pipe(res);
          } catch {
            next();
          }
        })();
      });
    },
  };
}

export default defineConfig({
  root: resolve(projectRoot, "test-host"),
  publicDir: false,
  plugins: [servePacks(), serveDistPacks()],
  resolve: {
    alias: [
      { find: "web-mascot/devtools", replacement: dist("devtools.js") },
      { find: /^web-mascot$/, replacement: dist("index.js") },
    ],
  },
  server: {
    port: 5199,
    strictPort: true,
    fs: { allow: [projectRoot] },
    watch: {
      // Editors write through transient *.tmpdir/*.tmp siblings; watching those
      // crashes the dev server with EBUSY (observed while editing test-host/main.js).
      ignored: ["**/.*.tmpdir/**", "**/*.tmpdir/**", "**/*.tmp", "**/dist/**"],
    },
  },
});
