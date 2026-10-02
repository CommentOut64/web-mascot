import { MascotEngine } from "../core/MascotEngine";
import type { EngineEvent } from "../core/MascotEngine";

/**
 * Mascot observation log — minimal form.
 *
 * One browser session maps to one directory, one pet to one file:
 *
 *     <repo>/logs/<session>/pet-1-Neuron.log
 *     <repo>/logs/<session>/pet-2-Eviling.log
 *     <repo>/logs/<session>/pet-_index.log    session header + visibility + JS errors
 *
 * The engine emits a rich, flat event stream (action stack frames, decoded
 * frames, diagnostics, milestones). This recorder is deliberately a *filter*:
 * it keeps only the events that are needed to reconstruct where a mascot went,
 * what it was doing, and how the recording was interrupted. Everything the
 * filter drops is either a restatement of an event that is still kept, or
 * per-frame noise that the trajectory can be rebuilt without.
 *
 * Per pet, the whole motion history is four primary record kinds (always JSON
 * lines with a `t` in seconds and a `k`); fields are only what the kind cannot
 * imply:
 *
 *   {"t":3.3,"k":"spawn","mascot":"Neuron","x":501,"y":100}
 *   {"t":20.5,"k":"behavior","from":"AskForHugs","to":"Fall","reason":"scroll-down-fall","x":501,"y":155}
 *   {"t":21,"k":"move","x":501,"y":293.55}
 *   {"t":17,"k":"stop","x":708.99,"y":755,"behavior":"WalkRightAndSit"}
 *   {"t":17.7,"k":"pose","img":"shime11.png","x":708.99,"y":755}
 *   {"t":154,"k":"heartbeat","x":950,"y":900,"behavior":"Stand"}
 *
 * Mascots can also act on each other through affordance broadcasts. Those records
 * use `k:"peer"` and are the only ones that describe two pets at once, so they
 * carry the affordance name (the shared key that pairs the two logs) and, for a
 * scanner, the target behaviour it is about to hand over to. Fields the engine
 * does not have at that moment are simply absent:
 *
 *   {"t":13.96,"k":"peer","event":"offer","side":"server","affordance":"CuddleNeuro","x":499.5,"y":795}
 *   {"t":15.45,"k":"peer","event":"connect","affordance":"CuddleNeuro","behavior":"IHugYou","distance":180,"x":679.5,"y":795}
 *   {"t":16.17,"k":"peer","event":"arrive","behavior":"IHugYou","target":[499.5,795],"x":499.5,"y":795}
 *   {"t":42.4,"k":"peer","event":"scan-miss","affordance":"CuddleEvil","behavior":"IHugYou","x":1.25,"y":795}
 *   {"t":43.1,"k":"peer","event":"abort","side":"client","affordance":"CuddleEvil","behavior":"IHugYou","x":640,"y":795}
 *   {"t":43.1,"k":"peer","event":"serve-timeout","side":"server","affordance":"CuddleNeuro","x":880,"y":795}
 *
 * `abort` / `serve-timeout` are the two ways a *claimed* handshake fails to finish:
 * the advertiser stopped advertising mid-approach (so the scanner's walk was
 * dropped), or the advertiser waited out `BROADCAST_SERVE_TIMEOUT_TICKS` for a
 * partner that never arrived. They are not collapsed, because each one is a lost
 * interaction rather than a repeated diagnostic.
 *
 * The two sides of one handshake are joined by `affordance` + `t`: one pet's
 * `offer` is the other pet's `connect`, and the resulting behaviour switches show
 * up as ordinary `behavior` records with `reason:"interaction-server"` /
 * `"interaction-client"`. A `scan-miss` is the one diagnostic kept, collapsed to
 * consecutive-identical form, because "this affordance has no partner" is a real
 * behavioural fact (it explains why a scan behaviour runs and nothing happens).
 * An `offer` only carries `behavior` when the advertising action declares one.
 *
 * Freezes are recorded per pet as `k:"lifecycle"`, so a gap in the timeline is
 * explained rather than ambiguous. The engine freezes for tab visibility,
 * viewport intersection, and same-origin page ownership:
 *
 *   {"t":11.8,"k":"lifecycle","event":"freeze","reason":"hidden","x":501,"y":755}
 *   {"t":26.2,"k":"lifecycle","event":"resume","reason":"hidden","x":501,"y":755}
 *   {"t":40.1,"k":"lifecycle","event":"freeze","reason":"viewport","x":501,"y":755}
 *   {"t":44.6,"k":"lifecycle","event":"resume","reason":"viewport","x":501,"y":755}
 *
 * While a pet is frozen nothing can move or switch behaviour, so `t` jumping
 * across a freeze/resume pair is the only correct reading of that gap. The
 * session index additionally carries one tab-level `visibility` record for the
 * whole page; this per-pet form is kept because the viewport reason is invisible
 * to the index and because the index does not say which pet was affected.
 *
 * A segment is therefore `behavior` + zero or more `move` + one `stop`, and the
 * path is the polyline of their (x, y). A `stop` is suppressed when the segment
 * it would close was just opened, or when the pet never actually moved, because
 * the surrounding `behavior` records already mark that boundary. `switch` (pacer /
 * cap) records explain why one segment ended and the next began when no behaviour
 * *name* changed, and `pose` records the frame the pet shows while standing still —
 * deliberately not while it moves, where `move` already describes the segment.
 *
 * `spawn` / `despawn` / `suspect` are kept verbatim: they are rare and each one
 * marks a real discontinuity (a new mascot, an end, or a single-tick jump).
 *
 * No record repeats itself in prose: an earlier revision carried a redundant
 * `msg`/`note` restating the structured fields, which roughly halved the payload
 * for no information a parser could not already read off the fields.
 *
 * Design constraints for a 30+ minute unattended recording:
 *   - records are produced only on state change, never per animation frame;
 *   - the client buffer is bounded and flushed on a timer, so memory cannot grow;
 *   - a failed write is re-queued up to a cap and then the recorder disables
 *     itself instead of spinning;
 *   - the page is flushed with sendBeacon when it is hidden or closed;
 *   - the files are written by a Vite middleware outside the Vite root, so
 *     logging never triggers HMR and never reloads the page.
 */

const ENDPOINT = "/__mascot-log";
const MAX_BUFFER_LINES = 256;
const MAX_REQUEUE_LINES = 4096;
/** Coarse scan of every live pet. Movement detail comes from the sampler below. */
const SAMPLE_INTERVAL_MS = 1000;
/** Log a `move` point once the pet has travelled this far inside a segment. */
const MOVE_MIN_PX = 32;
/** ...or once this much time passed with the pet still walking (slow crawls). */
const MOVE_MAX_GAP_MS = 3000;
/** Never emit two `move` points closer together than this. */
const MOVE_MIN_MS = 500;
/** Ignore drift smaller than this when deciding whether the pet is moving. */
const STILL_EPSILON_PX = 2;
/** No movement for this long closes the segment with a `stop`. */
const STOP_IDLE_MS = 1500;
/** A segment that never moved this far is not worth closing with a `stop`. */
const STOP_MIN_PX = 8;
/** Proof of life only after this much complete silence. */
const HEARTBEAT_MS = 120000;
const MAX_PING_ATTEMPTS = 6;
const PING_RETRY_MS = 500;
const INDEX_PET = "_index";

const session = new Date().toISOString().replace(/[:.]/g, "-");
const startedAt = performance.now();
const buffers = new Map<string, string[]>();
const trackers = new Map<string, MoveTracker>();

/**
 * Where batches go, when the host supplies a destination. A sink is the supported
 * way to collect records outside a Vite dev/preview server, where
 * `/__mascot-log` does not exist.
 */
export interface MascotLogBatch {
  session: string;
  pet: string;
  lines: string[];
}

export interface MascotLogSink {
  (batch: MascotLogBatch): void;
}

let sinkCallback: MascotLogSink | null = null;
const extraSinks: MascotLogSink[] = [];
/** Records produced before a destination was resolved; drained by `enable()`. */
const pending: { pet: string; line: string }[] = [];
let droppedPending = 0;

let enabled = false;
let disabled = false;
let failures = 0;
let started = false;

/** Everything needed to turn the per-second scan into a compact trajectory. */
interface MoveTracker {
  /** Last point written to the log, and when. */
  x: number;
  y: number;
  at: number;
  /** Last observed point, even if it was below the logging threshold. */
  seenX: number;
  seenY: number;
  /** When the pet last moved more than STILL_EPSILON_PX. */
  movingSince: number;
  /** Distance accumulated since the last written point. */
  travelled: number;
  /** The tick has been closed by a `stop`. */
  stopped: boolean;
  /** The pet moved during the last scan, so pose frames would be redundant. */
  moving: boolean;
  /** When anything was last written for this pet. */
  lastLogAt: number;
  /** When the last behaviour segment started, so a `stop` can be suppressed. */
  lastBehaviorAt: number;
  /** Signature of the last peer/switch event, to collapse repeated scans. */
  lastEvent: string;
  /** Pose already reported, so a static pose is written once. */
  pose: string;
}

const round = (value: number) => Math.round(value * 100) / 100;
const elapsed = () => (performance.now() - startedAt) / 1000;

function tracker(pet: string, x: number, y: number): MoveTracker {
  let state = trackers.get(pet);
  if (!state) {
    state = {
      x,
      y,
      at: 0,
      seenX: x,
      seenY: y,
      movingSince: 0,
      travelled: 0,
      stopped: true,
      moving: false,
      lastLogAt: 0,
      lastBehaviorAt: 0,
      lastEvent: "",
      pose: "",
    };
    trackers.set(pet, state);
  }
  return state;
}

function push(pet: string, record: Record<string, unknown>) {
  if (disabled) return;
  if (enabled) {
    const state = trackers.get(pet);
    if (state) state.lastLogAt = performance.now();
    const line = JSON.stringify(record);
    let buffer = buffers.get(pet);
    if (!buffer) {
      buffer = [];
      buffers.set(pet, buffer);
    }
    buffer.push(line);
    if (buffer.length >= MAX_BUFFER_LINES) void flush(pet, false);
    return;
  }
  // No destination resolved yet (the dev endpoint may still be booting, a host
  // sink may not be set). Records from this window are the most interesting ones
  // — a mascot's `spawn` and its first behaviour — so hold them in a bounded
  // queue for `enable()` instead of dropping them.
  if (pending.length < MAX_REQUEUE_LINES) pending.push({ pet, line: JSON.stringify(record) });
  else if (droppedPending++ === 0) {
    console.warn("[mascot-log] pre-start record queue is full; further records are dropped");
  }
}

function allSinks(): MascotLogSink[] {
  return sinkCallback ? [sinkCallback, ...extraSinks] : extraSinks;
}

async function flush(pet: string, beacon: boolean) {
  const buffer = buffers.get(pet);
  if (!buffer || buffer.length === 0) return;
  const lines = buffer.splice(0, buffer.length);
  const body = JSON.stringify({ session, pet, lines });
  // Host-provided sinks win: they are how an embedded or packaged build receives
  // records, where the dev endpoint below does not exist.
  for (const sink of allSinks()) {
    try {
      sink({ session, pet, lines });
    } catch {
      /* a throwing sink must not spin the recorder or lose the other sinks */
    }
  }
  if (sinkCallback) {
    failures = 0;
    return;
  }
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
  dropPending(reason);
  console.warn(`[mascot-log] recorder disabled: ${reason}`);
}

function observe(engine: MascotEngine, event: EngineEvent) {
  // `enabled` is deliberately not checked here: before a destination is resolved
  // `push()` queues the record for `enable()` to drain. Returning early would drop
  // the mascot's `spawn` and first behaviour, which is exactly what a recording is
  // most useful for. The engine does not subscribe otherwise, so it costs nothing
  // when no recorder is attached at all.
  if (disabled) return;
  const pet = engine.label;
  const t = round(elapsed());
  const where = engine.position();
  const x = round(where.x);
  const y = round(where.y);
  switch (event.kind) {
    case "spawn": {
      const snapshot = engine.snapshot();
      const now = performance.now();
      trackers.set(pet, {
        x: where.x,
        y: where.y,
        at: now,
        seenX: where.x,
        seenY: where.y,
        movingSince: now,
        travelled: 0,
        stopped: true,
        moving: false,
        lastLogAt: now,
        lastBehaviorAt: now,
        lastEvent: "",
        pose: `${snapshot.behavior}|${snapshot.image}`,
      });
      push(pet, {
        t,
        k: "spawn",
        mascot: snapshot.mascot,
        x,
        y,
      });
      break;
    }
    case "despawn":
      push(pet, { t, k: "despawn", x, y });
      break;
    case "behavior": {
      // A new segment: the previous one is implicitly closed here.
      const now = performance.now();
      const state = tracker(pet, where.x, where.y);
      state.x = where.x;
      state.y = where.y;
      state.at = now;
      state.seenX = where.x;
      state.seenY = where.y;
      state.travelled = 0;
      state.stopped = false;
      state.moving = false;
      state.movingSince = now;
      state.lastBehaviorAt = now;
      state.pose = `${event.to}|${engine.snapshot().image}`;
      push(pet, {
        t,
        k: "behavior",
        from: event.from || "",
        to: event.to,
        reason: event.reason,
        x,
        y,
      });
      break;
    }
    case "image": {
      // Pose frames are only interesting while the pet stands still. While it
      // moves, the `move` records already describe the segment, and emitting a
      // pose per frame would double the log for no extra information.
      const state = tracker(pet, where.x, where.y);
      if (state.moving) break;
      const signature = `${engine.snapshot().behavior}|${event.image}`;
      if (signature === state.pose) break;
      state.pose = signature;
      push(pet, {
        t,
        k: "pose",
        img: event.image,
        x,
        y,
      });
      break;
    }
    case "milestone": {
      // Two milestone families are state, not diagnostics:
      //   broadcast-*         a pet offers an affordance, or claims one nearby
      //   interaction-arrived the scanner reached its partner and hands over
      // Everything else (clamp, border-lost, target-x, offset, hotspot, ...) is a
      // per-tick diagnostic the trajectory does not need.
      const track = tracker(pet, where.x, where.y);
      // The engine freezes for three different reasons, and the session index only
      // sees the tab-level one (and only once for the whole page). Per pet, record
      // both the freeze and its recovery, with the reason, so a log can tell a
      // frozen mascot from an idle one and a viewport freeze from a tab freeze.
      if (event.name === "paused" || event.name === "resumed") {
        const freeze = event.name === "paused";
        const reason = event.detail === "viewport"
          ? "viewport"
          : event.detail === "background-page"
            ? "background-page"
            : "hidden";
        push(pet, {
          t,
          k: "lifecycle",
          event: freeze ? "freeze" : "resume",
          reason,
          x,
          y,
        });
        track.lastEvent = "";
        break;
      }
      if (event.name === "broadcast-connect" || event.name === "interaction-arrived") {
        push(pet, {
          t,
          k: "peer",
          event: event.name === "broadcast-connect" ? "connect" : "arrive",
          affordance: event.affordance || undefined,
          behavior: event.behavior || undefined,
          distance:
            typeof event.distance === "number" && Number.isFinite(event.distance)
              ? round(event.distance)
              : undefined,
          target: event.target ? [round(event.target[0]), round(event.target[1])] : undefined,
          x,
          y,
        });
        // A completed handshake resets the miss collapse: the same affordance going
        // unanswered again after a real interaction is new information.
        track.lastEvent = "";
        break;
      }
      if (event.name === "broadcast-abort" || event.name === "broadcast-serve-timeout") {
        // Both ends of a handshake usually agree on the offer: it is either claimed
        // and arrived, or never claimed. These two are the exceptions — a claim that
        // died mid-approach (the advertiser went away, or its wait ran out) — so they
        // are recorded rather than collapsed: each one is a lost interaction.
        push(pet, {
          t,
          k: "peer",
          event: event.name === "broadcast-abort" ? "abort" : "serve-timeout",
          side: event.name === "broadcast-abort" ? "client" : "server",
          affordance: event.affordance || undefined,
          behavior: event.behavior || undefined,
          x,
          y,
        });
        track.lastEvent = "";
        break;
      }
      if (event.name === "broadcast-start") {
        push(pet, {
          t,
          k: "peer",
          event: "offer",
          side: "server",
          affordance: event.affordance || undefined,
          behavior: event.behavior || undefined,
          x,
          y,
        });
        track.lastEvent = "";
        break;
      }
      if (event.name === "broadcast-scan") {
        // A scan that found nobody only matters for the affordances nobody offers;
        // the engine re-scans while walking, so consecutive identical misses are
        // collapsed into one record.
        const signature = `scan:${event.affordance ?? ""}`;
        if (track.lastEvent === signature) break;
        track.lastEvent = signature;
        push(pet, {
          t,
          k: "peer",
          event: "scan-miss",
          affordance: event.affordance || undefined,
          behavior: event.behavior || undefined,
          x,
          y,
        });
        break;
      }
      if (event.name !== "forced-switch" && event.name !== "behavior-cap") break;
      const signature = `switch:${event.name}`;
      if (track.lastEvent === signature) break;
      track.lastEvent = signature;
      push(pet, {
        t,
        k: "switch",
        reason: event.name,
        from: engine.snapshot().behavior,
        x,
        y,
      });
      break;
    }
    case "suspect": {
      push(pet, {
        t,
        k: "suspect",
        step: round(event.step),
        from: [round(event.px), round(event.py)],
        to: [round(event.x), round(event.y)],
        x,
        y,
      });
      break;
    }
    default:
      break;
  }
}

/**
 * Per-second scan. This is where the trajectory is written: while a pet moves it
 * accumulates distance from the last written point and emits one `move` record as
 * soon as the segment is long enough; when it falls still for a moment the
 * segment is closed with a `stop`; and after minutes of silence a single
 * `heartbeat` proves the mascot and its loop are still alive.
 */
function sampleOnTimer() {
  if (!enabled || disabled) return;
  const now = performance.now();
  for (const engine of MascotEngine.getInstances()) {
    const pet = engine.label;
    const snapshot = engine.snapshot();
    const state = tracker(pet, snapshot.x, snapshot.y);
    const step = Math.hypot(snapshot.x - state.seenX, snapshot.y - state.seenY);
    if (step > STILL_EPSILON_PX) {
      state.seenX = snapshot.x;
      state.seenY = snapshot.y;
      state.movingSince = now;
      state.stopped = false;
      state.moving = true;
    } else {
      state.moving = false;
    }
    state.travelled += step;
    const rest = now - state.movingSince;
    const t = round(elapsed());
    if (rest <= STOP_IDLE_MS) {
      // Moving: write a point once enough distance or time has accumulated.
      const gap = now - state.at;
      if (state.travelled >= MOVE_MIN_PX || (gap >= MOVE_MAX_GAP_MS && state.travelled >= STILL_EPSILON_PX)) {
        if (gap < MOVE_MIN_MS) continue;
        push(pet, {
          t,
          k: "move",
          x: round(snapshot.x),
          y: round(snapshot.y),
        });
        state.x = snapshot.x;
        state.y = snapshot.y;
        state.at = now;
        state.travelled = 0;
      }
      continue;
    }
    // At rest: close the segment once, then keep quiet. A segment is only worth
    // closing if the pet actually went somewhere — a static behaviour (LieDown,
    // HoldOntoWall) that was entered and left without moving has nothing to
    // report, and the behaviour records already bound it.
    if (!state.stopped) {
      state.stopped = true;
      state.moving = false;
      if (now - state.lastBehaviorAt < STOP_IDLE_MS) continue;
      if (Math.hypot(snapshot.x - state.x, snapshot.y - state.y) < STOP_MIN_PX) continue;
      push(pet, {
        t,
        k: "stop",
        x: round(snapshot.x),
        y: round(snapshot.y),
        behavior: snapshot.behavior,
      });
      state.x = snapshot.x;
      state.y = snapshot.y;
      state.at = now;
      state.travelled = 0;
      continue;
    }
    if (now - state.lastLogAt >= HEARTBEAT_MS) {
      push(pet, {
        t,
        k: "heartbeat",
        x: round(snapshot.x),
        y: round(snapshot.y),
        behavior: snapshot.behavior,
      });
    }
  }
  flushAll(false);
}

function enable(directory: string) {
  if (enabled || disabled) return;
  enabled = true;
  push(INDEX_PET, {
    t: 0,
    k: "session",
    session,
    dir: directory,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    dpr: window.devicePixelRatio,
    ua: navigator.userAgent,
    href: location.href,
    started: new Date().toISOString(),
  });
  // Drain through push() so the normal path (and its tracking) is used; `enabled`
  // is already true, so nothing re-queues and the loop cannot grow.
  const queued = pending.splice(0, pending.length);
  for (const item of queued) push(item.pet, JSON.parse(item.line) as Record<string, unknown>);
  for (const pet of new Set(queued.map((item) => item.pet))) void flush(pet, false);
}

/** Records that arrived before a destination was resolved. */
function dropPending(reason: string) {
  if (pending.length > 0) {
    console.warn(`[mascot-log] dropped ${pending.length} pre-start records: ${reason}`);
  }
  pending.length = 0;
}

async function probe(attempt = 1): Promise<void> {
  // A host-supplied sink is a complete destination on its own. The endpoint is a
  // Vite dev/preview middleware, so in an embedded or packaged build it does not
  // exist: probing it first only produces 404s (and, on a host page, visible
  // console noise) before falling back to the sink it was given all along.
  if (allSinks().length > 0) {
    enable("(host sink)");
    return;
  }
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
    return;
  }
  disable("log endpoint unavailable (recording is dev/preview only)");
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
    // gaps in a per-mascot log. While frozen the mascot does not move and does
    // not switch behaviour, so keeping this record only in the session index
    // avoids per-pet duplication.
    push(INDEX_PET, {
      t: round(elapsed()),
      k: "visibility",
      state: document.visibilityState,
    });
    if (document.visibilityState === "hidden") flushAll(true);
  });
  window.addEventListener("error", (event) => {
    push(INDEX_PET, {
      t: round(elapsed()),
      k: "error",
      detail: event.message,
      src: `${event.filename}:${event.lineno}`,
    });
  });
  window.addEventListener("unhandledrejection", (event) => {
    push(INDEX_PET, {
      t: round(elapsed()),
      k: "rejection",
      detail: String(event.reason),
    });
  });
}

/**
 * Route every batch to a host-provided destination instead of the dev endpoint.
 * Takes precedence over both the endpoint and any `addLogSink` mirror. Call it
 * before `startMascotLogRecorder()`.
 */
export function setLogSink(sink: MascotLogSink): void {
  sinkCallback = sink;
}

/**
 * Mirror every batch to an additional destination without replacing the dev
 * endpoint. Used for console fallbacks in hosts that have no dev server.
 */
export function addLogSink(sink: MascotLogSink): void {
  extraSinks.push(sink);
}

export function startMascotLogRecorder() {
  if (started) return;
  started = true;
  MascotEngine.addObserver(observe);
  installLifecycle();
  window.setInterval(sampleOnTimer, SAMPLE_INTERVAL_MS);
  startWhenVisible();
}
