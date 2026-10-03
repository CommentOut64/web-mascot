import { MascotEngine } from "../core/MascotEngine.js";
import type { EngineEvent } from "../core/MascotEngine.js";
import { loggerFor } from "../core/Logger.js";

/**
 * Mascot observation log — minimal form.
 *
 * One browser session maps to one directory, one pet to one file:
 *
 *     web-mascot/logs/<session>/pet-1-Neuron.log
 *     web-mascot/logs/<session>/pet-2-Eviling.log
 *     web-mascot/logs/<session>/pet-_index.log    session header + visibility + JS errors
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
 * `k:"mark"` is the one kind that describes the recorder rather than the pet: it
 * is written when a recording starts while that pet was *already* alive, so its
 * `spawn` was never seen. Without it the timeline would begin with an unexplained
 * mascot standing in the middle of the screen.
 *
 *   {"t":0.4,"k":"mark","reason":"recording-started","behavior":"Stand","x":501,"y":755}
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
 * to the index and because the index does not say which pet was affected. A
 * `resume` closes a *recording* gap the same way: the engine is not told to emit
 * anything for a hidden tab, so the recorder timestamps the transition itself.
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
 * ## Cost
 *
 * Recording is *not* a background service. Nothing is observed, no timer exists
 * and no record is built until a destination has actually been resolved, and
 * `detach()`/`disable()` tears both back down. Before a destination is known the
 * recorder never even subscribes, so a page that does not record pays for one
 * module import and nothing else. That is why the interesting startup records
 * (`spawn`, and the first behaviour) are *reconstructed* from the live engines at
 * enable time instead of being buffered — a bounded queue would either grow
 * without limit or silently drop the very records it existed to keep.
 *
 * The other half of the cost is on the sink side: records are plain JSON lines and
 * the browser never talks HTTP itself in the file case — the Vite middleware does,
 * outside the Vite root, so writing a log never triggers HMR or a page reload.
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

const log = loggerFor("observe");

const session = new Date().toISOString().replace(/[:.]/g, "-");
const startedAt = performance.now();
const buffers = new Map<string, string[]>();
const flushQueues = new Map<string, Promise<void>>();
const trackers = new Map<string, MoveTracker>();
/** Pets whose `spawn` this recorder has seen, so enable() knows what to synthesise. */
const spawned = new Map<string, { x: number; y: number; behavior: string; mascot: string }>();

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

let enabled = false;
let disabled = false;
let failures = 0;
let started = false;
/** Non-null only while attached: the sampler is not a permanent resident. */
let sampleTimer: number | null = null;
/** Set while the tab is hidden, so the record after a resume can explain the gap. */
let hiddenSince: number | null = null;

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
  // The single guard that makes "logging off" free: before a destination exists
  // this returns without touching JSON.stringify, the buffers or the trackers.
  if (disabled || !enabled) return;
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
}

function allSinks(): MascotLogSink[] {
  return sinkCallback ? [sinkCallback, ...extraSinks] : extraSinks;
}

async function flushNow(pet: string, beacon: boolean) {
  if (disabled) return;
  const buffer = buffers.get(pet);
  if (!buffer || buffer.length === 0) return;
  const lines = buffer.splice(0, buffer.length);
  const body = JSON.stringify({ session, pet, lines });
  // Host-provided sinks win: they are how an embedded or packaged build receives
  // records, where the dev endpoint below does not exist.
  for (const sink of allSinks()) {
    if (disabled) return;
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
  if (disabled) return;
  // The endpoint has to be permitted before anything is sent to it. A host that
  // declined it (`file: false` / `silent: true`) has said the route does not
  // exist, so posting anyway would only produce a 404 per batch — the records are
  // already delivered to the extra sinks above, and losing the endpoint copy is
  // exactly what the host asked for.
  if (!endpointAllowed) {
    failures = 0;
    return;
  }
  if (beacon && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    try {
      if (navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }))) return;
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

/** Serialize delivery per pet so batches cannot reorder under concurrent timers. */
function flush(pet: string, beacon: boolean): Promise<void> {
  const previous = flushQueues.get(pet) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => flushNow(pet, beacon));
  flushQueues.set(pet, next.finally(() => {
    if (flushQueues.get(pet) === next) flushQueues.delete(pet);
  }));
  return next;
}

function flushAll(beacon: boolean) {
  for (const pet of Array.from(buffers.keys())) void flush(pet, beacon);
}

function disable(reason: string) {
  if (disabled) return;
  disabled = true;
  enabled = false;
  buffers.clear();
  // Tearing the subscription down is what keeps a disabled recorder free: the old
  // version left the observer and the 1 s timer installed for the life of the
  // page, so every engine event and every second still cost a snapshot() call.
  detach();
  log.warn(`recorder disabled: ${reason}`);
}

function observe(engine: MascotEngine, event: EngineEvent) {
  if (disabled) return;
  if (!enabled) {
    // Reachable only during the window between subscribing and resolving a
    // destination, which is now a single ping round-trip. The live-engine scan in
    // `enable()` reconstructs whatever happened in it, so nothing is buffered here.
    if (event.kind === "spawn") {
      const snapshot = engine.snapshot();
      const where = engine.position();
      spawned.set(engine.label, {
        x: where.x,
        y: where.y,
        behavior: snapshot.behavior,
        mascot: snapshot.mascot,
      });
    } else if (event.kind === "despawn") {
      spawned.delete(engine.label);
    }
    return;
  }
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
      spawned.set(pet, {
        x: where.x,
        y: where.y,
        behavior: snapshot.behavior,
        mascot: snapshot.mascot,
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
      spawned.delete(pet);
      trackers.delete(pet);
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
  // Reconstruct the timeline for pets that were already alive when recording
  // began: their `spawn` happened before there was anywhere to write it, and a
  // trajectory that starts with an unexplained standing mascot is not readable.
  for (const engine of MascotEngine.getInstances()) {
    const pet = engine.label;
    const snapshot = engine.snapshot();
    const now = performance.now();
    const state = tracker(pet, snapshot.x, snapshot.y);
    state.x = snapshot.x;
    state.y = snapshot.y;
    state.at = now;
    state.seenX = snapshot.x;
    state.seenY = snapshot.y;
    state.movingSince = now;
    state.lastLogAt = now;
    state.lastBehaviorAt = now;
    state.pose = `${snapshot.behavior}|${snapshot.image}`;
    const spawn = spawned.get(pet);
    if (spawn) {
      // Its `spawn` was seen but could not be written; write it now, at t≈0.
      push(pet, { t: round(elapsed()), k: "spawn", mascot: spawn.mascot, x: round(spawn.x), y: round(spawn.y) });
    } else {
      push(pet, {
        t: round(elapsed()),
        k: "mark",
        reason: "recording-started",
        behavior: snapshot.behavior,
        x: round(snapshot.x),
        y: round(snapshot.y),
      });
    }
  }
  for (const pet of buffers.keys()) void flush(pet, false);
  if (document.visibilityState === "hidden") hiddenSince = performance.now();
}

/** Records that arrived before a destination was resolved. */
function dropState(reason: string) {
  if (trackers.size > 0 || spawned.size > 0) {
    log.debug(`dropping observation state: ${reason}`, {
      pets: trackers.size,
      spawned: spawned.size,
    });
  }
  trackers.clear();
  spawned.clear();
  buffers.clear();
}

async function probe(attempt = 1): Promise<void> {
  // The host has already told us there is no endpoint worth calling — a packaged
  // build, or a page that is not served by Vite. Skipping the request entirely is
  // the point of the option: a decorative feature should not put a 404 in every
  // visitor's network panel just to discover what the host already said.
  if (probeSilent) {
    // The host said there is nothing to probe. If it also supplied nowhere to
    // write, `startMascotLogRecorder` has already refused to attach, so reaching
    // here means there is a sink: enable without touching the network.
    enable("(host sink only)");
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
    /* no middleware: the dev server may still be starting, or there is none */
  }
  // A host-supplied sink is a complete destination *for the records*, so the
  // endpoint is not worth retrying for: it would only delay the records and keep
  // re-requesting a route that is evidently absent.
  if (allSinks().length > 0) {
    enable("(host sink only)");
    return;
  }
  if (attempt < MAX_PING_ATTEMPTS) {
    window.setTimeout(() => void probe(attempt + 1), PING_RETRY_MS);
    return;
  }
  disable("log endpoint unavailable (recording is dev/preview only)");
}

/**
 * Install the observation subscription and the sampler. Called once a destination
 * is viable — never speculatively, because the subscription itself is the cost.
 */
function attach() {
  if (sampleTimer !== null) return;
  MascotEngine.addObserver(observe);
  installLifecycle();
  sampleTimer = window.setInterval(sampleOnTimer, SAMPLE_INTERVAL_MS);
}

/** Remove the subscription, the sampler and every page listener again. */
function detach() {
  if (sampleTimer !== null) {
    window.clearInterval(sampleTimer);
    sampleTimer = null;
  }
  MascotEngine.removeObserver(observe);
  removeLifecycle();
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
  log.info("page is in the background; recording starts once it is visible again");
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    document.removeEventListener("visibilitychange", onVisible);
    void probe();
  };
  document.addEventListener("visibilitychange", onVisible);
}

// Named handlers, not inline arrows: `detach()` has to be able to remove them
// again, and an anonymous listener can never be unregistered.
const onPageHide = () => flushAll(true);
const onBeforeUnload = () => flushAll(true);
const onVisibilityChange = () => {
  // A hidden tab stops requestAnimationFrame, so these markers explain the gaps in
  // a per-mascot log. While frozen the mascot does not move and does not switch
  // behaviour, so keeping this record only in the session index avoids per-pet
  // duplication. The engine is not told about the transition at all, so the
  // recorder notes the time itself and reports it on the way back.
  const state = document.visibilityState;
  if (state === "hidden") {
    hiddenSince = performance.now();
    flushAll(true);
  }
  push(INDEX_PET, {
    t: round(elapsed()),
    k: "visibility",
    state,
    ...(state === "visible" && hiddenSince !== null
      ? { gapMs: Math.round(performance.now() - hiddenSince) }
      : {}),
  });
  if (state === "visible") hiddenSince = null;
};
const onWindowError = (event: ErrorEvent) => {
  push(INDEX_PET, {
    t: round(elapsed()),
    k: "error",
    detail: event.message,
    src: `${event.filename}:${event.lineno}`,
  });
};
const onUnhandledRejection = (event: PromiseRejectionEvent) => {
  push(INDEX_PET, {
    t: round(elapsed()),
    k: "rejection",
    detail: String(event.reason),
  });
};

function installLifecycle() {
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("beforeunload", onBeforeUnload);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("error", onWindowError);
  window.addEventListener("unhandledrejection", onUnhandledRejection);
}

function removeLifecycle() {
  window.removeEventListener("pagehide", onPageHide);
  window.removeEventListener("beforeunload", onBeforeUnload);
  document.removeEventListener("visibilitychange", onVisibilityChange);
  window.removeEventListener("error", onWindowError);
  window.removeEventListener("unhandledrejection", onUnhandledRejection);
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

/** Set when the host's log configuration allows the dev-server file endpoint. */
let endpointAllowed = true;
/** Set when the host has declared that no endpoint exists, so not even one request
 *  is worth making. Distinct from `endpointAllowed`: refusing the endpoint still
 *  implies one probe would be harmless, while `silent` says it would be noise. */
let probeSilent = false;

/**
 * Tell the recorder whether the dev-server file endpoint may be used. A published
 * package has no such route, so `configure({ log: { file: false } })` turns the
 * probe into a no-op and leaves the page completely untouched.
 */
export function allowDevEndpoint(allowed: boolean): void {
  endpointAllowed = allowed;
}

/**
 * Declare that there is no endpoint to probe, so the recorder does not issue even
 * one request. Use it when the host knows its page is not served by the Vite
 * dev/preview middleware (a packaged build, a static host, a CDN): `file: false`
 * already skips the network, and this keeps the *first* probe from being made in
 * the case where the endpoint would otherwise be assumed to exist.
 */
export function silenceDevEndpoint(silent: boolean): void {
  probeSilent = silent;
}

/**
 * Start recording: subscribe, sample, and resolve a destination. A host-provided
 * sink wins over the dev endpoint, so an embedded build never probes it.
 *
 * Returns `false` when the caller explicitly asked for every destination to be
 * off, in which case nothing at all was installed.
 */
export function startMascotLogRecorder(): boolean {
  if (started) return enabled;
  started = true;
  // Two independent questions, deliberately not folded into one test:
  //
  //   1. Is there anywhere for the *records* to go? A host sink or the endpoint.
  //   2. May the *endpoint* be touched? Declining it (`file: false`) must not stop
  //      recording when a sink exists — that is exactly the packaged-build case,
  //      where the host supplies a destination and no route exists.
  //
  // The previous version only checked "no sink at all AND no endpoint", so a host
  // that passed its own sink still had the endpoint probed, and a host that
  // declined the endpoint had recording turned off entirely.
  const hasSink = sinkCallback !== null || extraSinks.length > 0;
  if (!hasSink && !endpointAllowed) {
    disabled = true;
    return false;
  }
  attach();
  startWhenVisible();
  return true;
}

/** Stop recording and release everything. Safe to call more than once. */
export function stopMascotLogRecorder(): void {
  disable("stopped by the host");
}

/** Whether a destination has been resolved and records are being produced. */
export function isRecording(): boolean {
  return enabled && !disabled;
}

/** Drop the accumulated per-pet tracking state without touching destinations. */
export function resetMascotLogRecorder(): void {
  dropState("reset by the host");
}
