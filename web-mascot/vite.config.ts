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
  server: {
    watch: {
      // Editors write through transient *.tmpdir/*.tmp siblings; watching those
      // used to crash the dev server with EBUSY. Logs live outside the root, but
      // ignore them here too in case the root ever moves.
      ignored: ["**/.*.tmpdir/**", "**/*.tmpdir/**", "**/*.tmp", "**/logs/**"],
    },
  },
});
