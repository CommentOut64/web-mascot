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
 */
export interface MascotLogOptions {
  /** Directory that receives one sub-directory per browser session. */
  logRoot: string;
  /** Rotate a single mascot log once it grows past this many bytes. */
  maxFileBytes?: number;
  /** How many rotated files to keep per mascot. */
  maxRotations?: number;
}

const ENDPOINT = "/__mascot-log";
/** Session and pet identifiers are used as path segments, so be strict. */
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export function mascotLog(options: MascotLogOptions): Plugin {
  const maxFileBytes = options.maxFileBytes ?? 16 * 1024 * 1024;
  const maxRotations = Math.max(1, options.maxRotations ?? 4);
  const sizes = new Map<string, number>();
  let fsMod: any;
  let pathMod: any;

  async function node() {
    if (!fsMod) fsMod = await import("node:fs/promises");
    if (!pathMod) pathMod = await import("node:path");
    return { fs: fsMod as any, path: pathMod as any };
  }

  async function rotate(fs: any, file: string) {
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
    sizes.delete(file);
  }

  async function append(session: string, pet: string, lines: string[]) {
    const { fs, path } = await node();
    const directory = path.resolve(options.logRoot, session);
    const file = path.join(directory, `pet-${pet}.log`);
    // Defence in depth: never write outside the configured log root.
    const root = path.resolve(options.logRoot);
    if (!path.resolve(file).startsWith(root + path.sep)) throw new Error("log path escapes root");
    await fs.mkdir(directory, { recursive: true });
    const payload = `${lines.join("\n")}\n`;
    const bytes = Buffer.byteLength(payload, "utf8");
    let size = sizes.get(file);
    if (size === undefined) {
      try {
        size = (await fs.stat(file)).size;
      } catch {
        size = 0;
      }
    }
    if (size > 0 && size + bytes > maxFileBytes) {
      await rotate(fs, file);
      size = 0;
    }
    await fs.appendFile(file, payload, "utf8");
    sizes.set(file, size + bytes);
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
    const url: string = req.url ?? "";
    if (url.includes("ping")) {
      void (async () => {
        const { fs, path } = await node();
        await fs.mkdir(options.logRoot, { recursive: true });
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true, dir: path.resolve(options.logRoot) }));
      })();
      return;
    }
    if (req.method !== "POST") {
      next();
      return;
    }
    void (async () => {
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
      try {
        await append(session, pet, lines);
        res.statusCode = 204;
      } catch (error) {
        console.error("[mascot-log] write failed:", error);
        res.statusCode = 500;
      }
      res.end();
    })();
  };

  return {
    name: "mascot-log",
    configureServer(server) {
      server.middlewares.use(ENDPOINT, middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(ENDPOINT, middleware);
    },
  };
}
