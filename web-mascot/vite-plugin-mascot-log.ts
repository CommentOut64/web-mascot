import type { Plugin } from "vite";

/**
 * Dev/preview middleware that stores the mascot observation log on disk.
 *
 * The browser recorder batches JSON-lines records and POSTs them here; this
 * plugin appends them to one file per mascot under `<logRoot>/<session>/`.
 * Keeping the files outside the Vite root means writing them never triggers the
 * file watcher, so a long recording session can not reload the page.
 *
 *   GET  /__mascot-log/ping  -> { ok: true, dir } (the recorder probes this)
 *   POST /__mascot-log       -> { session, pet, lines: string[] }
 *
 * A browser cannot write files, so this middleware is the *only* way a log
 * reaches disk. A published package has no such route: hosts that are not running
 * Vite supply their own sink instead (see `attach({ sinks })` in the library).
 */
export interface MascotLogOptions {
  /** Directory that receives one sub-directory per browser session. */
  logRoot: string;
  /** Rotate a single mascot log once it grows past this many bytes. */
  maxFileBytes?: number;
  /** How many rotated files to keep per mascot. */
  maxRotations?: number;
  /**
   * Also write a human-readable `.txt` next to each `.log`. The `.log` file is
   * the machine format (one compact JSON object per line, meant to be parsed);
   * the `.txt` is the same records spaced out for a human reading `tail -f`.
   */
  text?: boolean;
}

const ENDPOINT = "/__mascot-log";
/** Exact paths only. A substring test here would swallow real log posts. */
const PING_PATH = `${ENDPOINT}/ping`;
const POST_PATH = ENDPOINT;
/** Session and pet identifiers are used as path segments, so be strict. */
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function mascotLog(options: MascotLogOptions): Plugin {
  const maxFileBytes = options.maxFileBytes ?? 16 * 1024 * 1024;
  const maxRotations = Math.max(1, options.maxRotations ?? 4);
  const wantText = options.text ?? false;
  const sizes = new Map<string, number>();
  const textSizes = new Map<string, number>();
  let fsMod: any;
  let pathMod: any;
  let resolvedRoot: string | null = null;

  async function node() {
    if (!fsMod) fsMod = await import("node:fs/promises");
    if (!pathMod) pathMod = await import("node:path");
    return { fs: fsMod as any, path: pathMod as any };
  }

  async function logRootAbs(): Promise<string> {
    if (resolvedRoot) return resolvedRoot;
    const { path } = await node();
    resolvedRoot = path.resolve(options.logRoot);
    return resolvedRoot;
  }

  /**
   * Rotate `file` to `file.1`, shifting the older segments along.
   *
   * The renames are best-effort on purpose: Windows raises EEXIST/EPERM for a few
   * hundred milliseconds after a file handle closes, and a rotation that fails is
   * always preferable to losing the batch that triggered it. The size map is
   * updated by the caller, so a skipped rotation only means the file grows past
   * the threshold for one more batch.
   */
  async function rotate(fs: any, file: string, sizeMap: Map<string, number>) {
    for (let index = maxRotations - 1; index >= 1; index--) {
      try {
        await fs.rename(`${file}.${index}`, `${file}.${index + 1}`);
      } catch {
        /* the older segment does not exist yet */
      }
    }
    try {
      await fs.rename(file, `${file}.1`);
    } catch {
      /* first rotation */
    }
    try {
      await fs.rm(`${file}.${maxRotations + 1}`, { force: true });
    } catch {
      /* nothing to prune */
    }
    sizeMap.delete(file);
  }

  /** Append one batch, rotating first when it would cross the size threshold. */
  async function appendFile(
    fs: any,
    file: string,
    payload: string,
    bytes: number,
    sizeMap: Map<string, number>,
  ) {
    let size = sizeMap.get(file);
    if (size === undefined) {
      try {
        size = (await fs.stat(file)).size;
      } catch {
        size = 0;
      }
    }
    if (size > 0 && size + bytes > maxFileBytes) {
      await rotate(fs, file, sizeMap);
      size = 0;
    }
    await fs.appendFile(file, payload, "utf8");
    sizeMap.set(file, size + bytes);
  }

  /** One record line per JSON line, prefixed with its own `t` for readability. */
  function toText(lines: string[]): string {
    let out = "";
    for (const line of lines) {
      let stamp = "";
      try {
        const record = JSON.parse(line) as { t?: number };
        if (typeof record.t === "number") stamp = `[${record.t.toFixed(3)}s] `;
      } catch {
        /* keep the raw line */
      }
      out += `${stamp}${line}\n`;
    }
    return out;
  }

  async function append(session: string, pet: string, lines: string[]) {
    const { fs, path } = await node();
    const absoluteRoot = await logRootAbs();
    const directory = path.join(absoluteRoot, session);
    const file = path.join(directory, `pet-${pet}.log`);
    // Defence in depth: never write outside the configured log root.
    if (!path.resolve(file).startsWith(absoluteRoot + path.sep)) {
      throw new Error("log path escapes root");
    }
    await fs.mkdir(directory, { recursive: true });

    const payload = `${lines.join("\n")}\n`;
    await appendFile(fs, file, payload, Buffer.byteLength(payload, "utf8"), sizes);

    if (wantText) {
      const textFile = path.join(directory, `pet-${pet}.txt`);
      const text = toText(lines);
      await appendFile(fs, textFile, text, Buffer.byteLength(text, "utf8"), textSizes);
    }
  }

  function readBody(req: any): Promise<string | null> {
    return new Promise((resolve) => {
      let size = 0;
      const chunks: any[] = [];
      req.on("data", (chunk: any) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", () => resolve(null));
    });
  }

  const middleware = (req: any, res: any, next: () => void) => {
    // Exact path matching. `url.includes("ping")` used to accept any request whose
    // URL merely contained those four letters, and those were answered 200 and
    // dropped on the floor — a silent log loss that was very hard to see.
    const path = String(req.url ?? "").split("?")[0];
    if (req.method === "GET" || req.method === "HEAD") {
      if (path !== PING_PATH) {
        next();
        return;
      }
      void (async () => {
        try {
          const { fs } = await node();
          const absoluteRoot = await logRootAbs();
          await fs.mkdir(absoluteRoot, { recursive: true });
          res.statusCode = 200;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: true, dir: absoluteRoot }));
        } catch (error) {
          console.error("[mascot-log] ping failed:", error);
          res.statusCode = 500;
          res.end();
        }
      })();
      return;
    }
    if (req.method !== "POST" || path !== POST_PATH) {
      next();
      return;
    }
    void (async () => {
      // The whole body is parsed inside a try: a client that disconnects mid-POST
      // (sendBeacon during unload does this routinely) would otherwise leave an
      // unhandled rejection behind.
      try {
        const raw = await readBody(req);
        if (raw === null) {
          res.statusCode = 413;
          res.end();
          return;
        }
        let payload: any;
        try {
          payload = JSON.parse(raw);
        } catch {
          res.statusCode = 400;
          res.end();
          return;
        }
        const session = String(payload?.session ?? "");
        const pet = String(payload?.pet ?? "");
        const lines = Array.isArray(payload?.lines)
          ? (payload.lines as unknown[]).filter((line): line is string => typeof line === "string")
          : [];
        if (!NAME_PATTERN.test(session) || !NAME_PATTERN.test(pet) || lines.length === 0) {
          res.statusCode = 400;
          res.end();
          return;
        }
        await append(session, pet, lines);
        res.statusCode = 204;
        res.end();
      } catch (error) {
        console.error("[mascot-log] write failed:", error);
        if (!res.headersSent) res.statusCode = 500;
        res.end();
      }
    })();
  };

  return {
    name: "mascot-log",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
