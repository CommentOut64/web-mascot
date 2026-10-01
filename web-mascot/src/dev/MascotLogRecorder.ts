import { MascotEngine } from "../core/MascotEngine";
import type { EngineEvent } from "../core/MascotEngine";

/**
 * Permanent mascot observation log.
 *
 * Every mascot gets its own file, so two mascots released one after another end
 * up in two logs. One browser session (one page load / frontend start) maps to
 * one directory:
 *
 *     <repo>/logs/<session>/pet-1-Neuron.log
 *     <repo>/logs/<session>/pet-2-Eviling.log
 *     <repo>/logs/<session>/pet-_index.log     session header + JS errors
 *
 * Design constraints for a 30+ minute unattended recording:
 *   - records are produced only on state change (plus a slow heartbeat), never
 *     per animation frame;
 *   - the client buffer is bounded and flushed on a timer, so memory cannot grow;
 *   - a failed write is re-queued up to a cap and then the recorder disables
 *     itself instead of spinning;
 *   - the page is flushed with sendBeacon when it is hidden or closed;
 *   - the files are written by a Vite middleware outside the Vite root, so
 *     logging never triggers HMR and never reloads the page.
 */

const ENDPOINT = "/__mascot-log";
const FLUSH_INTERVAL_MS = 1000;
const MAX_BUFFER_LINES = 256;
const MAX_REQUEUE_LINES = 4096;
/** Position sample cadence while the mascot is on the move. */
const POS_INTERVAL_MS = 5000;
/** Position sample cadence while it is standing still (proof of life). */
const HEARTBEAT_MS = 15000;
/** Ignore movement smaller than this for the position samples. */
const POS_MIN_DELTA = 4;
const MAX_PING_ATTEMPTS = 6;
const PING_RETRY_MS = 500;
const INDEX_PET = "_index";

const session = new Date().toISOString().replace(/[:.]/g, "-");
const startedAt = performance.now();
const buffers = new Map<string, string[]>();
const lastSample = new Map<string, { x: number; y: number; at: number }>();
const episodes = new Map<string, Episode>();

let enabled = false;
let disabled = false;
let failures = 0;
let started = false;

interface Episode {
  leaf: string;
  samples: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  travelled: number;
  x: number;
  y: number;
}

const round = (value: number) => Math.round(value * 100) / 100;
const elapsed = () => (performance.now() - startedAt) / 1000;

function push(pet: string, record: Record<string, unknown>) {
  if (!enabled || disabled) return;
  const line = JSON.stringify(record);
  let buffer = buffers.get(pet);
  if (!buffer) {
    buffer = [];
    buffers.set(pet, buffer);
  }
  buffer.push(line);
  if (buffer.length >= MAX_BUFFER_LINES) void flush(pet, false);
}

async function flush(pet: string, beacon: boolean) {
  const buffer = buffers.get(pet);
  if (!buffer || buffer.length === 0) return;
  const lines = buffer.splice(0, buffer.length);
  const body = JSON.stringify({ session, pet, lines });
  if (beacon && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    try {
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }));
      return;
    } catch {
      /* fall through to fetch */
    }
  }
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      keepalive: true,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    failures = 0;
  } catch {
    failures++;
    const current = buffers.get(pet) ?? [];
    if (current.length + lines.length <= MAX_REQUEUE_LINES) buffers.set(pet, lines.concat(current));
    if (failures >= 3) disable("log endpoint keeps failing");
  }
}

function flushAll(beacon: boolean) {
  for (const pet of Array.from(buffers.keys())) void flush(pet, beacon);
}

function disable(reason: string) {
  if (disabled) return;
  disabled = true;
  enabled = false;
  buffers.clear();
  console.warn(`[mascot-log] recorder disabled: ${reason}`);
}

function episodeRecord(pet: string, episode: Episode, endX: number, endY: number) {
  // Sequence/Select frames never own a pose, so they would only add noise.
  if (episode.samples === 0) return;
  const x = [round(episode.xMin), round(episode.xMax)];
  const y = [round(episode.yMin), round(episode.yMax)];
  push(pet, {
    t: round(elapsed()),
    k: "episode",
    leaf: episode.leaf,
    samples: episode.samples,
    x,
    y,
    travelled: round(episode.travelled),
    endedAt: [round(endX), round(endY)],
    msg:
      `episode ${episode.leaf}: samples=${episode.samples} x=${x[0]}..${x[1]} y=${y[0]}..${y[1]}` +
      ` travelled=${round(episode.travelled)} endedAt=(${round(endX)},${round(endY)})`,
  });
}

/** Coarse movement bookkeeping per action, emitted when the action ends. */
function trackEpisode(pet: string, leaf: string, x: number, y: number) {
  if (!leaf || leaf === "-") return;
  const current = episodes.get(pet);
  if (!current || current.leaf !== leaf) {
    if (current) episodeRecord(pet, current, x, y);
    episodes.set(pet, {
      leaf,
      samples: 0,
      xMin: x,
      xMax: x,
      yMin: y,
      yMax: y,
      travelled: 0,
      x,
      y,
    });
    return;
  }
  current.samples++;
  current.travelled += Math.hypot(x - current.x, y - current.y);
  current.x = x;
  current.y = y;
  current.xMin = Math.min(current.xMin, x);
  current.xMax = Math.max(current.xMax, x);
  current.yMin = Math.min(current.yMin, y);
  current.yMax = Math.max(current.yMax, y);
}

const targetText = (targetX: number | null, targetY: number | null) => {
  const parts: string[] = [];
  if (targetX !== null) parts.push(`X=${round(targetX)}`);
  if (targetY !== null) parts.push(`Y=${round(targetY)}`);
  return parts.length ? parts.join(",") : "none";
};

function observe(engine: MascotEngine, event: EngineEvent) {
  if (!enabled || disabled) return;
  const pet = engine.label;
  const t = round(elapsed());
  switch (event.kind) {
    case "spawn": {
      const snapshot = engine.snapshot();
      // Positions in the log are page pixels; the engine works in virtual units.
      const where = engine.position();
      const animation = MascotEngine.getAnimationConfig();
      push(pet, {
        t,
        k: "spawn",
        mascot: snapshot.mascot,
        x: round(where.x),
        y: round(where.y),
        detail: event.detail,
        config: animation.describe(snapshot.mascot),
        msg:
          `spawn ${snapshot.mascot} at (${round(where.x)},${round(where.y)}) ${event.detail}` +
          ` | animation config: ${animation.describe(snapshot.mascot)}`,
      });
      for (const line of animation.details(snapshot.mascot)) {
        push(pet, { t, k: "config", detail: line, msg: `animation config ${line}` });
      }
      break;
    }
    case "despawn":
      push(pet, { t, k: "despawn", detail: event.detail, msg: `despawn ${event.detail}` });
      break;
    case "behavior":
      push(pet, {
        t,
        k: "behavior",
        from: event.from,
        to: event.to,
        reason: event.reason,
        x: round(event.x),
        y: round(event.y),
        leaf: event.leaf,
        msg:
          `behavior ${event.from || "(none)"} -> ${event.to} [${event.reason}]` +
          ` @(${round(event.x)},${round(event.y)}) leaf=${event.leaf}`,
      });
      trackEpisode(pet, event.leaf, event.x, event.y);
      break;
    case "stack":
      push(pet, {
        t,
        k: "stack",
        path: event.path,
        leaf: event.leaf,
        type: event.nodeType,
        cls: event.className,
        border: event.border,
        target: targetText(event.targetX, event.targetY),
        img: event.image,
        lookRight: event.lookRight,
        x: round(event.x),
        y: round(event.y),
        msg:
          `action ${event.path} [${event.nodeType}${event.className ? " " + event.className : ""}` +
          `${event.border ? " BorderType=" + event.border : ""}] target=${targetText(event.targetX, event.targetY)}` +
          ` img=${event.image} lookRight=${event.lookRight} @(${round(event.x)},${round(event.y)})`,
      });
      trackEpisode(pet, event.leaf, event.x, event.y);
      break;
    case "image":
      push(pet, {
        t,
        k: "image",
        img: event.image,
        leaf: event.leaf,
        x: round(event.x),
        y: round(event.y),
        msg: `frame ${event.image} leaf=${event.leaf} @(${round(event.x)},${round(event.y)})`,
      });
      trackEpisode(pet, event.leaf, event.x, event.y);
      break;
    case "milestone":
      push(pet, {
        t,
        k: "milestone",
        name: event.name,
        detail: event.detail,
        x: round(event.x),
        y: round(event.y),
        leaf: event.leaf,
        msg: `${event.name} ${event.detail} @(${round(event.x)},${round(event.y)}) leaf=${event.leaf}`,
      });
      trackEpisode(pet, event.leaf, event.x, event.y);
      break;
    case "suspect":
      push(pet, {
        t,
        k: "suspect",
        name: event.name,
        detail: event.detail,
        step: round(event.step),
        dx: round(event.dx),
        dy: round(event.dy),
        from: [round(event.px), round(event.py)],
        to: [round(event.x), round(event.y)],
        leaf: event.leaf,
        msg:
          `SUSPECT ${event.name} ${event.detail} (${round(event.px)},${round(event.py)}) ->` +
          ` (${round(event.x)},${round(event.y)}) leaf=${event.leaf}`,
      });
      trackEpisode(pet, event.leaf, event.x, event.y);
      break;
  }
}

function sampleOnTimer() {
  if (!enabled || disabled) return;
  const now = performance.now();
  for (const engine of MascotEngine.getInstances()) {
    const pet = engine.label;
    const snapshot = engine.snapshot();
    const previous = lastSample.get(pet);
    const moved = !previous || Math.hypot(snapshot.x - previous.x, snapshot.y - previous.y) >= POS_MIN_DELTA;
    const interval = moved ? POS_INTERVAL_MS : HEARTBEAT_MS;
    if (!previous || now - previous.at >= interval) {
      lastSample.set(pet, { x: snapshot.x, y: snapshot.y, at: now });
      push(pet, {
        t: round(elapsed()),
        k: moved ? "pos" : "heartbeat",
        x: round(snapshot.x),
        y: round(snapshot.y),
        behavior: snapshot.behavior,
        leaf: snapshot.leaf,
        img: snapshot.image,
        depth: snapshot.stackDepth,
        msg:
          `${moved ? "pos" : "heartbeat"} @(${round(snapshot.x)},${round(snapshot.y)})` +
          ` behavior=${snapshot.behavior} leaf=${snapshot.leaf} img=${snapshot.image}`,
      });
      trackEpisode(pet, snapshot.leaf, snapshot.x, snapshot.y);
    }
  }
  flushAll(false);
}

function enable(directory: string) {
  if (enabled || disabled) return;
  enabled = true;
  const animation = MascotEngine.getAnimationConfig();
  push(INDEX_PET, {
    t: 0,
    k: "session",
    session,
    dir: directory,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    dpr: window.devicePixelRatio,
    visibility: document.visibilityState,
    ua: navigator.userAgent,
    href: location.href,
    animationConfig: animation.describe("(defaults)"),
    msg:
      `session start dir=${directory} viewport=${window.innerWidth}x${window.innerHeight}` +
      ` | animation config: ${animation.describe("(defaults)")}`,
  });
}

async function probe(attempt = 1): Promise<void> {
  try {
    const response = await fetch(`${ENDPOINT}/ping`, { cache: "no-store" });
    const contentType = response.headers.get("content-type") ?? "";
    if (response.ok && contentType.includes("json")) {
      const info = (await response.json()) as { ok?: boolean; dir?: string };
      if (info && info.ok) {
        enable(String(info.dir ?? "unknown"));
        return;
      }
    }
  } catch {
    /* the dev server may still be starting */
  }
  if (attempt < MAX_PING_ATTEMPTS) {
    window.setTimeout(() => void probe(attempt + 1), PING_RETRY_MS);
  } else {
    disable("log endpoint unavailable (recording is dev/preview only)");
  }
}

/**
 * Recording only starts while the page is in the foreground. A page cannot pull
 * itself to the front (browsers ignore window.focus()), so instead of fighting
 * background throttling the recorder simply waits until the page is visible and
 * then starts - every record then comes from a page that was actually rendering.
 */
function startWhenVisible() {
  if (document.visibilityState === "visible") {
    void probe();
    return;
  }
  console.info("[mascot-log] page is in the background; recording starts once it is visible again");
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    document.removeEventListener("visibilitychange", onVisible);
    void probe();
  };
  document.addEventListener("visibilitychange", onVisible);
}

function installLifecycle() {
  window.addEventListener("pagehide", () => flushAll(true));
  window.addEventListener("beforeunload", () => flushAll(true));
  document.addEventListener("visibilitychange", () => {
    // A hidden tab stops requestAnimationFrame, so these markers explain the
    // gaps in a per-mascot log.
    push(INDEX_PET, {
      t: round(elapsed()),
      k: "visibility",
      state: document.visibilityState,
      msg: `visibility ${document.visibilityState}`,
    });
    if (document.visibilityState === "hidden") flushAll(true);
  });
  window.addEventListener("error", (event) => {
    push(INDEX_PET, {
      t: round(elapsed()),
      k: "error",
      detail: event.message,
      source: `${event.filename}:${event.lineno}`,
      msg: `error ${event.message} @${event.filename}:${event.lineno}`,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    push(INDEX_PET, {
      t: round(elapsed()),
      k: "rejection",
      detail: String(event.reason),
      msg: `unhandledrejection ${String(event.reason)}`,
    });
  });
}

export function startMascotLogRecorder() {
  if (started) return;
  started = true;
  MascotEngine.addObserver(observe);
  installLifecycle();
  window.setInterval(sampleOnTimer, FLUSH_INTERVAL_MS);
  startWhenVisible();
}
