/**
 * Build / package provenance — the check that keeps a "tested build" claim honest.
 *
 * Why this exists: a Vite dev server started before a rebuild can keep serving the
 * previous bundle. One round of conclusions was invalidated by exactly that. A run
 * is only allowed to claim "tested build X" if three things agree:
 *
 *   1. `dist/` is not older than the newest source file it was built from;
 *   2. the tarball (if present) contains byte-identical `dist/` files;
 *   3. the hash the browser page reports matches the `dist/` file it came from.
 *
 * Point 3 is recorded by the harness itself (`build chunk=... chunkSha=...`) and is
 * checked here against the local file when a trace directory is passed in.
 *
 *   node test-run/verify-build.mjs [traceSessionDir]
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const root = resolve(".");
const dist = resolve(root, "dist");
const errors = [];
const notes = [];

const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });

if (!existsSync(dist)) {
  console.error("dist/ is missing — run `npm run build:lib` first");
  process.exit(1);
}

/* 1. freshness: every source file must be older than the build it feeds. */
const distIndex = join(dist, "index.js");
const buildTime = statSync(distIndex).mtimeMs;
const sources = [...walk(resolve(root, "src")), resolve(root, "index.html")].filter((file) => existsSync(file));
const newer = sources.filter((file) => statSync(file).mtimeMs > buildTime + 1000);
if (newer.length) {
  errors.push(`dist is older than ${newer.length} source file(s), e.g. ${relative(root, newer[0])} — rebuild before testing`);
} else {
  notes.push(`fresh: dist/index.js is newer than all ${sources.length} tracked source files`);
}

/* 2. tarball parity: the shipped archive must carry the same bytes. */
const tgzs = readdirSync(root).filter((file) => file.endsWith(".tgz")).sort();
const tarball = tgzs.at(-1);
const distHashes = new Map(walk(dist).map((file) => [relative(dist, file), sha(readFileSync(file))]));
if (tarball) {
  const work = mkdtempSync(join(tmpdir(), "mascot-tgz-"));
  try {
    execFileSync("tar", ["-xzf", join(root, tarball), "-C", work, "package/dist"], { stdio: "pipe" });
    const packedRoot = join(work, "package", "dist");
    const packed = new Map(walk(packedRoot).map((file) => [relative(packedRoot, file), sha(readFileSync(file))]));
    const missing = [...distHashes.keys()].filter((key) => !packed.has(key));
    const differing = [...distHashes.entries()].filter(([key, hash]) => packed.has(key) && packed.get(key) !== hash);
    const extra = [...packed.keys()].filter((key) => !distHashes.has(key));
    if (missing.length) errors.push(`${tarball}: missing ${missing.length} dist file(s), e.g. ${missing[0]}`);
    if (differing.length) errors.push(`${tarball}: ${differing.length} dist file(s) differ from the build, e.g. ${differing[0][0]}`);
    if (extra.length) notes.push(`${tarball}: carries ${extra.length} extra dist file(s) (types/sourcemaps), not a failure`);
    if (!missing.length && !differing.length) notes.push(`${tarball}: ${distHashes.size} dist files match byte-for-byte`);
  } catch (error) {
    errors.push(`could not inspect ${tarball}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
} else {
  notes.push("no tarball present — package parity not checked");
}

/* 3. the build the browser actually loaded, when a trace directory is given. */
const traceDir = process.argv[2];
let browser = null;
if (traceDir) {
  const harness = readFileSync(join(traceDir, "trace-harness.log"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const record = harness.find((entry) => entry.k === "mark" && /build chunk=/.test(entry.note ?? ""));
  if (!record) {
    errors.push("trace has no build provenance record — the run cannot be tied to a build");
  } else {
    const match = /chunk=(\S+) chunkSha=([0-9a-f]+)/.exec(record.note);
    const chunkName = match?.[1];
    const recorded = match?.[2];
    const chunkPath = chunkName ? join(dist, "chunks", chunkName) : null;
    if (!chunkPath || !existsSync(chunkPath)) {
      errors.push(`trace reports chunk ${chunkName}, which is not in dist/chunks/`);
    } else {
      const disk = sha(readFileSync(chunkPath));
      browser = { chunkName, recorded, disk: disk.slice(0, 16) };
      if (!disk.startsWith(recorded)) {
        errors.push(`browser loaded ${recorded} but dist/chunks/${chunkName} is ${disk.slice(0, 16)} — the run used another build`);
      } else {
        notes.push(`browser build matches dist: ${chunkName} ${recorded}`);
      }
    }
  }
}

const report = {
  generated: new Date().toISOString(),
  distIndexSha: sha(readFileSync(distIndex)).slice(0, 16),
  tarball: tarball ?? null,
  distFiles: distHashes.size,
  browser,
  errors,
  notes,
};
mkdirSync(resolve(root, "../tmp/scheduling-verification"), { recursive: true });
writeFileSync(resolve(root, "../tmp/scheduling-verification/build.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");

for (const note of notes) console.log(`  ok   ${note}`);
for (const error of errors) console.log(`  FAIL ${error}`);
console.log(`\ndist index sha=${report.distIndexSha}  files=${report.distFiles}  tarball=${report.tarball ?? "(none)"}`);
if (errors.length) process.exit(1);
console.log("build provenance: consistent");
