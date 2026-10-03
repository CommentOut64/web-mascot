import { XMLParser } from "./XMLParser.js";
import { AnimationConfig } from "./AnimationConfig.js";
import { BroadcastManager, ClientHandle, Interaction, ServerState } from "./Broadcast.js";
import { hotspotAt } from "./Hotspot.js";
import { registerMascotPage } from "./MascotPageCoordinator.js";
import { evaluateExpression } from "./ExpressionEvaluator.js";
import { loggerFor } from "./Logger.js";
import type { Hotspot } from "./Hotspot.js";
import type { ActionNode, AnimationVariant, Behavior, BehaviorReference, MascotConfig, Pose } from "./types.js";

const expressionLog = loggerFor("engine");
const loggedExpressionFailures = new Set<string>();

/**
 * Runtime tuning. Every field here is a *number the simulation reads*, exposed so a
 * host can match the engine to its page without patching the source. The defaults
 * are what the engine shipped with, and they are calibrated against the packs'
 * own physics — changing `gravity` or the resistances without re-checking the packs
 * will make mascots behave unlike libshijima, which is why they are documented as
 * "match the pack" rather than "tune freely".
 *
 * Deliberately *not* here: internal safety valves (`MAX_FRAME_DELTA_MS`,
 * `MAX_BEHAVIOR_INITS_PER_TICK`, `STALL_LIMIT_TICKS`). They exist to stop a bug
 * from locking the page, and a host that lowers them turns a cosmetic problem into
 * a broken mascot.
 */
export interface RuntimeOptions {
  /** Simulation step, in ms. 40 ms is libshijima's rate; raising it slows every
   *  animation down proportionally and is the closest thing to a speed control. */
  tickMs?: number;
  /** Downward acceleration per tick. */
  gravity?: number;
  /** Horizontal / vertical air drag, as a per-tick multiplier below 1. */
  resistanceX?: number;
  resistanceY?: number;
  /** A `Stay` action with no `Duration` of its own holds this many ticks. */
  stayDurationTicks?: number;
  /** Motionless ticks of a held mascot before it starts to struggle. */
  dragResistTicks?: number;
  /** Cursor movement that aborts the struggle, in px. */
  dragResistAbortPx?: number;
  /** How far the held anchor hangs from the cursor. The pack's own
   *  `OffsetX`/`OffsetY` override these when it defines them. */
  dragOffsetX?: number;
  dragOffsetY?: number;
  /** How long an advertiser holds its pose for a claimed-but-absent partner. */
  broadcastServeTimeoutTicks?: number;
  /** Anchor movement in one tick above which a jump is reported as a suspect. */
  suspectStepPx?: number;
}

export type RuntimeSnapshot = Readonly<Required<RuntimeOptions>>;

const RUNTIME_DEFAULTS: Required<RuntimeOptions> = {
  tickMs: 40,
  gravity: 2,
  resistanceX: 0.05,
  resistanceY: 0.1,
  stayDurationTicks: 250,
  dragResistTicks: 250,
  dragResistAbortPx: 5,
  dragOffsetX: 0,
  dragOffsetY: 120,
  broadcastServeTimeoutTicks: 600,
  suspectStepPx: 24,
};

/** Live tuning; read by the simulation, so it can be changed between ticks. */
let runtime: Required<RuntimeOptions> = { ...RUNTIME_DEFAULTS };

/**
 * Add every sprite a pack action node can show to `urls`.
 *
 * A `<Pose>` may carry no `Image` (the shipped packs use one as a bare delay): it
 * has nothing to preload, and `spriteUrl("")` would request the `img` directory
 * itself, which the dev server answers with a 500 and an error overlay on the
 * host page.
 */
function collectSpriteUrls(node: ActionNode, urls: Set<string>, toUrl: (image: string) => string): void {
  for (const pose of node.poses ?? []) if (pose.image) urls.add(toUrl(pose.image));
  for (const animation of node.animations ?? []) {
    for (const pose of animation.poses) if (pose.image) urls.add(toUrl(pose.image));
  }
  for (const child of node.children ?? []) collectSpriteUrls(child, urls, toUrl);
}

/** Counterpart of `RuntimeOptions`, without repeating every default. */
function mergeRuntime(options: RuntimeOptions | undefined): Required<RuntimeOptions> {
  const merged = { ...runtime };
  const limits: Record<keyof RuntimeOptions, readonly [number, number]> = {
    tickMs: [1, 1000],
    gravity: [-1000, 1000],
    resistanceX: [0, 1],
    resistanceY: [0, 1],
    stayDurationTicks: [1, 1_000_000],
    dragResistTicks: [1, 1_000_000],
    dragResistAbortPx: [0, 100_000],
    dragOffsetX: [-100_000, 100_000],
    dragOffsetY: [-100_000, 100_000],
    broadcastServeTimeoutTicks: [1, 1_000_000],
    suspectStepPx: [0, 100_000],
  };
  if (!options) return merged;
  for (const key of Object.keys(RUNTIME_DEFAULTS) as (keyof RuntimeOptions)[]) {
    const value = options[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      const [min, max] = limits[key];
      merged[key] = Math.min(max, Math.max(min, value));
    }
  }
  return merged;
}


/** A target-seeking action that makes no progress for this long gives up instead
 *  of walking into a border for ever (6 s at 40 ms per tick). */
const STALL_LIMIT_TICKS = 150;
/** Sprite width used when the bitmap has not reported its size yet (libshijima
 *  hardcodes 128 for the same purpose). */
const SPRITE_WIDTH = 128;
/** `firstBorderOf` sentinel: an `Offset` moves the mascot before any border is
 *  demanded, so the behaviour can start on any surface (this is how the packs get
 *  off a wall or the ceiling). It has to be distinct from "nothing found", because
 *  the tree walk propagates truthy results and ignores a null. */
const FLEXIBLE_BORDER = "*";
/** Largest cursor movement counted per logic tick (px), for the throw velocity. */
const MAX_CURSOR_STEP = 80;
/** libshijima dragged::init(): ticks of a motionless cursor before the held mascot
 *  starts to struggle (`time_to_resist`). */

/** dragged::subtick() resets that timer once the cursor moves 5/subtick_count px. */
const DRAG_STILL_EPSILON = 1.25;
/**
 * Gesture policy for a press on a hotspot, copied from NeurolingsCE's
 * `ui/mascot/MascotHoldGesture.hpp`: the press is only a *candidate* — it becomes the
 * hotspot's hold behaviour after `HOLD_TRIGGER_MS`, counts as a click when released
 * inside the click tolerances, and turns into a pickup once the pointer travels
 * farther than the hold tolerance. libshijima itself only owns the "is the cursor on
 * a hotspot" test (`animation::handle_dragging`); the rest is app policy.
 */
const HOLD_TRIGGER_MS = 260;
const HOLD_MOVEMENT_TOLERANCE_PX = 12;
const CLICK_MOVEMENT_TOLERANCE_PX = 6;
const CLICK_DURATION_MS = 400;
/** resist::tick(): this much cursor movement aborts the struggle. */

/** dragged::subtick() offsets: the anchor is placed this far from the cursor
 *  (OffsetX/OffsetY, read from the action when the pack defines them). */


/** libshijima's `mascot::tick::reached_init_limit()`: a behaviour chain that keeps
 *  ending instantly must not loop for ever inside a single tick. */
const MAX_BEHAVIOR_INITS_PER_TICK = 20;
/** Maximum synchronous action-tree expansion work in one logic tick. */
const MAX_ACTION_EXPANSIONS_PER_TICK = 200;
/**
 * How long an advertiser holds its pose for a scanner that has already claimed its
 * affordance but has not arrived yet.
 *
 * libshijima lets the advertising animation end whenever it ends: the offer is
 * finalized with it, the claim goes with it, and the scanner — which is already
 * walking — is dropped by the `!client.connected` guard on its next tick, with no
 * event and no retry. On the shipped packs the advertisement is a fixed 409-tick
 * animation (`SitAffordance`), and a scanner that claims it in the last ~50 ticks
 * loses the hug: measured over 180 000 ticks, 3 of 46 claims (6.5%) died this way.
 *
 * The wait is bounded so a scanner that never arrives (killed, dragged, frozen, or
 * simply stopped by its own behaviour cap) cannot leave the advertiser holding for
 * ever. The shipped packs need ≤ 52 ticks from claim to arrival (p99), so this is
 * an order of magnitude of headroom while still ending well before the default
 * `forcedSwitchTicks` (750) would normally pace the mascot.
 */


/** A single-tick anchor movement larger than this is reported as a jump suspect. */

/** Never simulate more than this much time in one frame. A hidden tab stops
 *  requestAnimationFrame, and replaying the whole pause in one frame would burn
 *  CPU and lurch the mascot across the screen when the tab comes back. */
const MAX_FRAME_DELTA_MS = 200;

/** Observation events. Deliberately small and flat so a long recording stays
 *  cheap; the recorder turns them into one JSON line each. */
export type EngineEvent =
  | { kind: "spawn"; detail: string }
  | { kind: "despawn"; detail: string }
  | { kind: "behavior"; from: string; to: string; reason: string; x: number; y: number; leaf: string }
  | {
      kind: "stack";
      path: string;
      leaf: string;
      nodeType: string;
      className: string;
      border: string;
      targetX: number | null;
      targetY: number | null;
      image: string;
      lookRight: boolean;
      x: number;
      y: number;
    }
  | { kind: "image"; image: string; leaf: string; x: number; y: number }
  | {
      kind: "milestone";
      name: string;
      detail: string;
      x: number;
      y: number;
      leaf: string;
      /** Interaction milestones: who advertised / scanned / arrived. */
      affordance?: string;
      side?: "server" | "client";
      /** The behaviour the interaction will hand over to, when known. */
      behavior?: string;
      /** The peer's anchor, in viewport pixels, for `interaction-arrived`. */
      target?: [number, number];
      /** Scan distance to the nearest live broadcast. */
      distance?: number;
    }
  | {
      kind: "suspect";
      name: string;
      detail: string;
      step: number;
      dx: number;
      dy: number;
      px: number;
      py: number;
      x: number;
      y: number;
      leaf: string;
    };

export type EngineObserver = (engine: MascotEngine, event: EngineEvent) => void;

type ActionFrame = {
  node: ActionNode;
  childIndex: number;
  vars: Record<string, string>;
  /** Values of the ${...} attributes, frozen when the frame was created. */
  resolved: Record<string, unknown>;
  /** Values of the #{...} attributes, re-evaluated once per tick. */
  live: Record<string, unknown>;
  liveTick: number;
  durationLimit: number | null;
  elapsed: number;
  poseIndex: number;
  poseTick: number;
  /** Progress watchdog state for target-seeking actions. */
  stallTicks: number;
  progressX: number;
  progressY: number;
  /** Affordance state owned by this action instance (see Broadcast.ts). */
  server: ServerState | null;
  client: ClientHandle | null;
  /** The animation variant chosen for this frame, so a change can restart the pose
   *  clock the way libshijima's get_animation() does. */
  animation?: AnimationVariant;
  /** The tick this frame was created in. libshijima ticks the current action and
   *  only then moves on, so a frame must not be advanced by the same tick that
   *  created it — see the guard in advanceActionTree. */
  bornTick: number;
};

type Area = { top: number; right: number; bottom: number; left: number };
type Surface = "floor" | "left-wall" | "right-wall" | "ceiling";
type PauseReason = "hidden" | "viewport" | "background-page";

export class MascotEngine {
  /** Every live mascot, so `mascot.totalCount` means something to the packs. */
  private static liveEngines = new Set<MascotEngine>();
  /** Sprite URLs already fetched, shared by every mascot of the same pack. */
  private static preloaded = new Set<string>();  /** Observation points; the log recorder subscribes instead of polling. */
  private static observers = new Set<EngineObserver>();
  private static nextId = 1;
  /** Animation customisation, shared by every mascot (see AnimationConfig). */
  private static animationConfig = new AnimationConfig();
  private static animationConfigLoad: Promise<void> | null = null;
  private static animationConfigSetExplicitly = false;
  /**
   * Host-level answer to "should the built-in preset apply?", set through
   * `configure({ ignoreBuiltin })`. `null` means "whatever the file says", which
   * `AnimationConfig` tracks on its own.
   */
  private static builtinPreference: boolean | null = null;
  /** Affordance registry, shared by every mascot in the page (broadcast/manager). */
  private static broadcasts = new BroadcastManager();
  private static globalEventsInstalled = false;
  /** Removes the reduced-motion listener again; null while none is installed. */
  private static reducedMotionWatcher: (() => void) | null = null;
  /** Default location of the editable configuration file. */
  public static readonly ANIMATION_CONFIG_URL = "/animation.config.json";
  /** Default base URL of the mascot packs. A hosted or embedded build overrides
   *  this so sprites never resolve against the host page's root path. */
  public static readonly PACK_BASE_URL = "/mascot_pack";

  /** Stable per-session identity, used to name this mascot's log file. */
  public readonly id: number;
  public readonly label: string;

  private container: HTMLElement;
  private mascotName: string;
  /** This pack's resolved base URL, captured at construction so `configure()`
   *  after the fact cannot leave one mascot reading from another pack. */
  private packBaseUrl: string;
  private config: MascotConfig | null = null;
  private elRoot: HTMLDivElement;
  private elImg: HTMLImageElement;
  /** An Interact action with image-less hold frames must hide its old standalone frame. */
  private interactionVisualActive = false;
  private actionStack: ActionFrame[] = [];
  private currentBehavior: Behavior | null = null;
  private behaviorUsability = new Map<string, boolean>();
  /** Whether a behaviour's action needs a partner, cached per behaviour name. */
  private partnerCache = new Map<string, boolean>();
  /** Whether a behaviour's action can move the mascot, cached per behaviour name. */
  private travelCache = new Map<string, { moves: boolean; scans: boolean }>();
  /** The border a behaviour starts on, cached per behaviour name. */
  private borderStartCache = new Map<string, string | null>();
  private tickCount = 0;
  /** Anchor at the previous logic tick, used to interpolate the sub-steps. */
  private prevX = 0;
  private prevY = 0;
  private isDragging = false;
  /** Ticks the cursor has been motionless while the mascot is held
   *  (libshijima dragged::init's `time_to_resist` timer). */
  private dragStillTicks = 0;
  /** Timestamp of the last swallowed tick error, so it is reported at most once a
   *  second instead of flooding the observation log. */
  private lastTickErrorAt = 0;
  private lastTime = 0;
  private accumulator = 0;
  private loopId = 0;
  private pauseReasons = new Set<PauseReason>();
  private unregisterPage: (() => void) | null = null;
  /** Scroll is an external intent; mascot coordinates remain viewport coordinates. */
  private lastScrollY = 0;
  private scrollDirection: -1 | 0 | 1 = 0;
  private scrollGestureDirection: -1 | 0 | 1 = 0;
  /** Pending page movement, in virtual viewport units, waiting for the next tick. */
  private pendingScrollShift = 0;
  private scrollStopPending = false;
  private scrollHold: "none" | "resting" = "none";
  private lastSurface: Surface | null = null;
  private cursorX = 0;
  private cursorY = 0;
  /** Cursor movement during the last logic tick, i.e. `environment.cursor.dx/dy`.
   *  libshijima rolls the raw per-subtick deltas over one tick; the packs use this
   *  as the throw velocity (`Thrown`: InitialVX/InitialVY), so it must be a per-tick
   *  delta — a per-mousemove delta makes a synthetic pointer jump launch the mascot
   *  across the screen (caught by the position-jump suspect). */
  private cursorTickDX = 0;
  private cursorTickDY = 0;
  private lastTickCursorX = 0;
  private lastTickCursorY = 0;
  /** Velocity at the start of the tick, so the jump detector can tell physics from
   *  a bug even when the phase ended and zeroed the velocity during the tick. */
  private tickStartVX = 0;
  private tickStartVY = 0;
  /** libshijima dragged::init/subtick(): the smoothed x the held mascot dangles
   *  from. The pack's own Pinched action reads it to choose its pose. */
  private footX = 0;
  private footDX = 0;
  /**
   * Qt `state::local_cursor` (see `state::get_raw_cursor()`): while the mascot is
   * held, the cursor the simulation reads is the pointer *plus this drag's grab
   * offset*, seeded when the drag starts so that `anchor = cursor + OffsetX/OffsetY`
   * reproduces the anchor the mascot had when it was picked up. Without it the first
   * held tick snaps the mascot to the pack's fixed hold point — measured 108 px for a
   * grab 12 px above the feet — because the old code kept only the *fixed* offsets.
   * `null` means "no drag in progress, the pointer is the cursor".
   */
  private dragGrab: { x: number; y: number } | null = null;
  /** Anchor and pointer at mousedown, in virtual units, so the grab offset can be
   *  derived on the first held tick — which is when the action's own OffsetX/OffsetY
   *  (the values Qt seeds the local cursor from) are known. */
  private dragPressAnchorX = 0;
  private dragPressAnchorY = 0;
  private dragPressCursorX = 0;
  private dragPressCursorY = 0;
  /**
   * Press bookkeeping for the hotspot gesture (HOLD_TRIGGER_MS …). A press is
   * tracked until the button is released, because which gesture it is (hold, click or
   * pickup) is only decided by how long and how far the pointer moved.
   */
  private pressActive = false;
  private pressStartAt = 0;
  private pressClientX = 0;
  private pressClientY = 0;
  /** Largest Manhattan distance the pointer travelled during this press. */
  private pressMaxMovement = 0;
  /** The hotspot the press landed on, while it can still become a hold or a click. */
  private hotspotHold: Hotspot | null = null;
  private hotspotHoldTriggered = false;
  /** Buttons currently held, as reported by the last pointer event. Qt queries
   *  `QGuiApplication::mouseButtons()` per tick so a release that never arrives
   *  cannot leave a press or a drag stuck; this is the DOM's equivalent. */
  private cursorButtons = 0;
  /** Offscreen copy of the frame the mascot is showing, for the opaque-pixel hit
   *  test (`ShijimaWidget::pointInside`). Re-read whenever the image changes. */
  private alphaCanvas: HTMLCanvasElement | null = null;
  private alphaData: ImageData | null = null;
  private alphaSrc = "";
  /** Cached host-CSS offset between this engine's coordinates and the drawn anchor
   *  (see `hostShift()`); refreshed at most once per logic tick. */
  private hostShiftCache = { x: 0, y: 0, tick: -1 };
  /** Change detection for the observation stream. */
  private observedPath = "";
  private observedImage = "";
  private clampReported = false;
  private eventsAbortController = new AbortController();
  private resizeTimer = 0;
  private isScrolling = false;
  private scrollDebounceTimer = 0;
  /**
   * One-shot timers that are not already covered by `resizeTimer` /
   * `scrollDebounceTimer`. `init()` and `setVisible()` schedule work that can fire
   * after `destroy()`, which used to let a torn-down mascot poke at a detached DOM
   * node (and at `this.visible`, which no longer means anything).
   */
  private pendingTimers = new Set<number>();
  private destroyed = false;
  /** Set for the tick on which an Offset action moved the anchor on purpose. */
  private offsetJumped = false;
  /** How long the current behaviour has been running, for the hard cap. */
  private behaviorTicks = 0;
  /** Consecutive ticks the anchor has not moved, for the "standing still" pacer. */
  private stillTicks = 0;
  /** Same, but only reset by real movement: it is what guarantees a lively page. */
  private anchorStillTicks = 0;
  /** Set once the mascot has been in the same spot too long: the next pick must travel. */
  private wantMovement = false;
  /** Tick until which partner behaviours stay out of the pool (see the config's
   *  `interactionCooldownTicks`); refreshed while an interaction is running. */
  private interactionCooldownUntil = 0;
  /** Behaviours initialised in the current tick, for the runaway guard. */
  private behaviorInitsThisTick = 0;
  private actionExpansionsThisTick = 0;
  /** Affordance state (see Broadcast.ts). Advertisements and scan links belong to
   *  the action instance and live on its frame; the handshake belongs to the
   *  mascot, because its behaviour is what the partner is waiting on. */
  private interaction = new Interaction();
  /** Tick at which this mascot first noticed that its advertisement had been
   *  claimed, or 0 when it is not holding a pose for anybody (see
   *  runtime.broadcastServeTimeoutTicks). */
  private servingClaimSince = 0;
  /** Paused while the mascot's container is scrolled out of view. */
  private visible = true;
  private intersectionObserver: IntersectionObserver | null = null;

  public x = 0;
  public y = 0;
  public vx = 0;
  public vy = 0;
  public lookRight = true;

  public static addObserver(observer: EngineObserver) {
    MascotEngine.observers.add(observer);
  }

  /** One page-level dispatcher handles events for all mascots. */
  private static installGlobalEvents(): void {
    if (MascotEngine.globalEventsInstalled || typeof window === "undefined") return;
    MascotEngine.globalEventsInstalled = true;
    window.addEventListener("mousemove", (event) => {
      for (const engine of MascotEngine.liveEngines) {
        engine.cursorX = event.clientX;
        engine.cursorY = event.clientY;
        engine.cursorButtons = event.buttons;
        if (engine.pressActive) {
          if ((event.buttons & 1) === 0) {
            // `MascotHoldGesture::leftButtonIsDown`: a release that never reached the
            // window must not leave a press (or a drag) stuck.
            engine.finishPress(event.clientX, event.clientY);
          } else {
            engine.updatePressMovement();
            // Qt re-pins the anchor once per 10 ms subtick; doing it on every pointer
            // event is what keeps a fast drag from trailing the cursor.
            if (engine.isDragging) engine.applyDragAnchor();
          }
        }
        if (!engine.isDragging) engine.elRoot.style.cursor = engine.hotspotUnderCursor(event.clientX, event.clientY) ? "pointer" : "grab";
      }
    });
    window.addEventListener("mouseup", (event) => {
      for (const engine of MascotEngine.liveEngines) {
        engine.cursorButtons = event.buttons;
        // ShijimaWidget::mouseReleaseEvent(): click or throw, decided by the gesture.
        if (engine.pressActive) engine.finishPress(event.clientX, event.clientY);
      }
    });
    document.addEventListener("visibilitychange", () => {
      for (const engine of MascotEngine.liveEngines) {
        if (document.hidden) {
          if (engine.isDragging) {
            engine.endDrag();
            engine.setBehavior("Thrown", "drag-release");
          }
          // MascotHoldGesture::cancelsForEvent(Hide): a hidden page drops the press.
          engine.cancelPress();
          window.clearTimeout(engine.scrollDebounceTimer);
          engine.setPauseReason("hidden", true);
        } else engine.setPauseReason("hidden", false);
      }
    });
    window.addEventListener("resize", () => {
      for (const engine of MascotEngine.liveEngines) {
        window.clearTimeout(engine.resizeTimer);
        engine.resizeTimer = window.setTimeout(() => {
          const borderBefore = engine.currentBorderAt(undefined);
          engine.partnerCache.clear();
          engine.travelCache.clear();
          engine.borderStartCache.clear();
          engine.behaviorUsability.clear();
          engine.clampToWorkArea();
          const area = engine.area();
          for (const frame of engine.actionStack) {
            if (typeof frame.resolved.TargetX === "number") frame.resolved.TargetX = Math.max(area.left, Math.min(area.right, frame.resolved.TargetX));
            if (typeof frame.resolved.TargetY === "number") frame.resolved.TargetY = Math.max(area.top, Math.min(area.bottom, frame.resolved.TargetY));
          }
          const borderAfter = engine.currentBorderAt(undefined);
          if (borderBefore && !borderAfter && !/Jump|Fall|Thrown|Dragged/i.test(engine.currentBehavior?.name || "")) engine.setBehavior("Fall", "resize-border-lost");
        }, 200);
      }
    });
    window.addEventListener("scroll", () => {
      for (const engine of MascotEngine.liveEngines) {
        const delta = window.scrollY - engine.lastScrollY;
        engine.lastScrollY = window.scrollY;
        if (delta === 0) continue;
        engine.isScrolling = true;
        engine.scrollDirection = delta > 0 ? 1 : -1;
        engine.pendingScrollShift += delta / engine.spriteScale;
        engine.scrollStopPending = false;
        window.clearTimeout(engine.scrollDebounceTimer);
        engine.scrollDebounceTimer = window.setTimeout(() => {
          engine.isScrolling = false;
          engine.scrollDirection = 0;
          engine.scrollStopPending = true;
        }, 160);
      }
    });
  }

  public static removeObserver(observer: EngineObserver) {
    MascotEngine.observers.delete(observer);
  }

  public static getInstances(): MascotEngine[] {
    return Array.from(MascotEngine.liveEngines);
  }

  /** The active animation configuration. */
  public static getAnimationConfig(): AnimationConfig {
    return MascotEngine.animationConfig;
  }

  /** The shared affordance registry (two mascots use it to find each other). */
  public static getBroadcasts(): BroadcastManager {
    return MascotEngine.broadcasts;
  }

  /** Decided on the first load; `reloadAnimationConfig(url)` re-decides it. */
  private static animationConfigUrl: string | null = null;
  /** Overridden by the host so a pack can live anywhere; see `configure()`. */
  private static packBaseUrl: string = MascotEngine.PACK_BASE_URL;

  /**
   * Point the engine at its assets. Every URL is resolved by the caller, because
   * an embedded or published build cannot assume it is served from the page root.
   *
   * Call this before the first mascot is created: the animation configuration is
   * fetched once and then cached for the page, so a later change is only picked up
   * by `reloadAnimationConfig()`.
   */
  public static configure(options: {
    packBaseUrl?: string;
    animationConfigUrl?: string;
    /** True drops the built-in animation preset for this page; false is the default. */
    ignoreBuiltin?: boolean;
  }): void {
    if (options.packBaseUrl) {
      MascotEngine.packBaseUrl = options.packBaseUrl.replace(/\/+$/, "");
    }
    if (options.animationConfigUrl && !MascotEngine.animationConfigUrl) {
      MascotEngine.animationConfigUrl = options.animationConfigUrl;
    }
    if (options.ignoreBuiltin !== undefined) {
      // Remembered as a page-level preference instead of being written into the
      // current instance, because a configuration file may replace that instance
      // later: `applyBuiltinPreference()` re-applies it afterwards.
      MascotEngine.builtinPreference = options.ignoreBuiltin;
      MascotEngine.applyBuiltinPreference();
    }
  }

  /**
   * Change how the simulation is tuned. Each field is validated as a finite number
   * and anything else is ignored, so a partially-written settings object is safe.
   *
   * It applies to every mascot, including the ones already on the page: the values
   * are read per tick rather than captured at construction, which is what makes a
   * live settings panel possible. The exceptions are positions already computed
   * from the old values (a mascot mid-fall keeps its velocity), so a change is
   * smooth rather than instantaneous.
   */
  public static setRuntimeOptions(options: RuntimeOptions): RuntimeSnapshot {
    runtime = mergeRuntime(options);
    return Object.freeze({ ...runtime });
  }

  /** The tuning currently in effect. */
  public static getRuntimeOptions(): RuntimeSnapshot {
    return Object.freeze({ ...runtime });
  }

  /** The asset base URL in effect, for diagnostics and for hosts that build their
   *  own sprite URLs (`spriteUrl()` returns the same shape). */
  public static getPackBaseUrl(): string {
    return MascotEngine.packBaseUrl;
  }

  /**
   * Install a configuration from an object in the same shape as the JSON file.
   * This is the entry point a settings UI would use; it wins over the file until
   * `loadAnimationConfig()` is called again with `force`.
   */
  public static setAnimationConfig(file: unknown, source = "(programmatic)"): AnimationConfig {
    // An explicit object that carries the flag also updates the page-level
    // preference; otherwise the last `configure({ ignoreBuiltin })` stays in force.
    const flag = (file as { ignoreBuiltin?: unknown } | null | undefined)?.ignoreBuiltin;
    if (typeof flag === "boolean") MascotEngine.builtinPreference = flag;
    MascotEngine.animationConfig = new AnimationConfig(file, source);
    MascotEngine.animationConfigSetExplicitly = true;
    MascotEngine.applyBuiltinPreference();
    MascotEngine.watchReducedMotion();
    return MascotEngine.animationConfig;
  }

  /**
   * Re-apply the page-level `ignoreBuiltin` preference to the configuration in
   * effect.
   *
   * `toJSON()` hands back the host's own layer only, so re-seeding it never bakes
   * the built-in preset into anything; a page that never passes the flag keeps
   * whatever the file said.
   */
  private static applyBuiltinPreference(): void {
    const preference = MascotEngine.builtinPreference;
    if (preference === null) return;
    const current = MascotEngine.animationConfig;
    const host = current.toJSON();
    if ((host.ignoreBuiltin === true) === preference) return;
    MascotEngine.animationConfig = new AnimationConfig(
      { ...host, ignoreBuiltin: preference },
      current.source,
    );
  }

  /**
   * Read the configuration file once and keep it. A missing or invalid file leaves
   * the built-in preset in place (or the packs' own settings, when the page asked
   * for `ignoreBuiltin`), so this never breaks the app.
   *
   * Probing the classic path is the price of the "just drop a file at
   * `/animation.config.json`" workflow: a host that has no file sees one expected
   * 404 per page load, and nothing else.
   */
  public static loadAnimationConfig(url?: string): Promise<void> {
    if (url) MascotEngine.animationConfigUrl = url;
    const target = MascotEngine.animationConfigUrl ?? MascotEngine.ANIMATION_CONFIG_URL;
    if (MascotEngine.animationConfigLoad) return MascotEngine.animationConfigLoad;
    MascotEngine.animationConfigLoad = (async () => {
      try {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 3000);
        try {
          const response = await fetch(target, { cache: "no-store", signal: controller.signal });
          const contentType = response.headers.get("content-type") ?? "";
          if (!response.ok || !contentType.includes("json")) return;
          const file: unknown = await response.json();
          if (!MascotEngine.animationConfigSetExplicitly) {
            MascotEngine.animationConfig = new AnimationConfig(file, target);
          }
          MascotEngine.applyBuiltinPreference();
        } finally {
          window.clearTimeout(timer);
        }
      } catch {
        /* no configuration file, or it is unreachable: keep the current settings */
      } finally {
        // Runs on the "no file" path too: the OS reduced-motion preference has to
        // be followed whether or not this site happens to serve a file.
        MascotEngine.watchReducedMotion();
      }
    })();
    return MascotEngine.animationConfigLoad;
  }

  /**
   * Follow the OS reduced-motion preference, now and on later changes.
   *
   * The disposer is kept instead of the listener because a bare listener can never
   * be unregistered: `matchMedia` needs the very `MediaQueryList` it came from, so
   * the old code left a page-lifetime listener behind with no way to remove it.
   */
  private static watchReducedMotion() {
    MascotEngine.animationConfig.refreshReducedMotion();
    if (MascotEngine.reducedMotionWatcher) return;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    try {
      const query = window.matchMedia("(prefers-reduced-motion: reduce)");
      const listener = () => MascotEngine.animationConfig.setReducedMotion(query.matches);
      query.addEventListener("change", listener);
      MascotEngine.reducedMotionWatcher = () => {
        query.removeEventListener("change", listener);
        MascotEngine.reducedMotionWatcher = null;
      };
    } catch {
      /* the preference is still read once by refreshReducedMotion() */
    }
  }

  /** Re-read the file, discarding both the cache and any programmatic override. */
  public static async reloadAnimationConfig(url?: string): Promise<AnimationConfig> {
    MascotEngine.animationConfigLoad = null;
    MascotEngine.animationConfigSetExplicitly = false;
    if (url) MascotEngine.animationConfigUrl = url;
    await MascotEngine.loadAnimationConfig();
    return MascotEngine.animationConfig;
  }

  constructor(container: HTMLElement, mascotName: string) {
    this.container = container;
    this.mascotName = mascotName;
    this.packBaseUrl = `${MascotEngine.packBaseUrl}/${mascotName}`;
    this.id = MascotEngine.nextId++;
    this.label = `${this.id}-${mascotName}`;
    this.elRoot = document.createElement("div");
    Object.assign(this.elRoot.style, {
      position: "fixed", left: "0px", top: "0px", pointerEvents: "auto",
      cursor: "grab", zIndex: "1", userSelect: "none", visibility: "hidden",
      // A definite box as well: the root carries a transform and nothing else, so
      // without this it has a zero-size hit box and is invisible to hit testing.
      width: `${SPRITE_WIDTH}px`, height: `${SPRITE_WIDTH}px`,
    });
    this.elImg = document.createElement("img");
    this.elImg.style.position = "absolute";
    this.elImg.style.visibility = "hidden";
    this.elImg.ondragstart = () => false;
    // Give the sprite a *definite* size from its bitmap instead of relying on
    // intrinsic sizing to inflate a shrink-to-fit box.
    //
    // `max-width: none` is essential, not cosmetic. The UA stylesheet applies
    // `img { max-width: 100% }`, which against a shrink-to-fit `position: fixed`
    // wrapper (one that has no width of its own) resolves to 0% in a circular
    // way — the wrapper sizes to the images, the images clamp to the wrapper — so
    // the sprite collapses to width 0 while its height stays correct. The engine
    // then keeps running, keeps logging poses, and paints nothing at all.
    this.elImg.style.maxWidth = "none";
    this.elImg.style.maxHeight = "none";
    this.elImg.addEventListener("load", () => {
      this.applySpriteIntrinsicSize();
      this.elImg.style.visibility = "visible";
    });
    this.elImg.style.width = `${SPRITE_WIDTH}px`;
    this.elImg.style.height = `${SPRITE_WIDTH}px`;
    this.elRoot.appendChild(this.elImg);
    this.bindEvents();
    MascotEngine.installGlobalEvents();
  }

  public async init() {
    // Customisation is read first so the very first tick already obeys it.
    await MascotEngine.loadAnimationConfig();
    this.config = await XMLParser.loadConfig(this.mascotName, this.packBaseUrl);
    // Both awaits above are network-bound, so `destroy()` can legitimately have run
    // in between. Continuing would re-register a dead engine and re-attach its DOM,
    // leaving a zombie mascot that nothing can ever remove.
    if (this.destroyed) return;
    this.applySpawnPosition();
    this.resetScrollTracking();
    this.prevX = this.x;
    this.prevY = this.y;
    MascotEngine.liveEngines.add(this);
    this.container.appendChild(this.elRoot);
    this.watchVisibility();
    // Warm the sprite cache before the first frames: assigning a fresh `src` to the
    // visible <img> shows an empty/broken image until the file arrives, which reads
    // as a flicker on every pose change.
    this.preloadSprites();
    await this.warmFirstPose();
    if (this.destroyed) return;
    // Do not expose the fixed box while the first real bitmap is still pending.
    // This prevents the browser's empty-image placeholder from flashing at (0, 0).
    this.elRoot.style.visibility = "visible";
    this.emit({ kind: "spawn", detail: `viewport=${window.innerWidth}x${window.innerHeight}` });
    this.setBehavior("Fall", "spawn");
    this.lastTime = performance.now();
    if (document.hidden) this.setPauseReason("hidden", true);
    this.unregisterPage = registerMascotPage((owner) => this.setPauseReason("background-page", !owner));
    if (this.pauseReasons.size === 0) this.loopId = requestAnimationFrame((t) => this.loop(t));
  }

  /** URL of a pack sprite. */
  private spriteUrl(image: string): string {
    return `${this.packBaseUrl}/img${image}`;
  }

  /**
   * Fetch every sprite the pack can show, once per pack. The browser then serves the
   * pose changes from its decoded cache, so swapping poses no longer flashes an empty
   * image. Cheap: these packs are ~100 images of 128 px.
   */
  private preloadSprites(): void {
    const actions = this.config?.actions;
    if (!actions) return;
    const urls = new Set<string>();
    for (const node of Object.values(actions)) {
      collectSpriteUrls(node, urls, (image) => this.spriteUrl(image));
    }
    for (const url of urls) {
      if (MascotEngine.preloaded.has(url)) continue;
      MascotEngine.preloaded.add(url);
      const image = new Image();
      image.decoding = "async";
      image.src = url;
    }
  }

  /** Decode the poses the spawn paints, so even the landing sequence has no gap.
   *  Bounded by a timeout: a slow network must never delay the mascot. */
  private async warmFirstPose(): Promise<void> {
    const pose = this.currentPose() ?? this.firstPose();
    if (!pose || !pose.image) return;

    // The whole "Fall" tree is warmed (it carries Bouncing, Stand and friends): a
    // landing sequence whose frames arrive one by one flashes empty sprites.
    const first = this.spriteUrl(pose.image);
    const urls = new Set<string>([first]);
    const spawnAction = this.config?.actions?.["Fall"];
    if (spawnAction) collectSpriteUrls(spawnAction, urls, (image) => this.spriteUrl(image));

    // The instances are kept: the first pose's bitmap is what seeds the sprite box
    // below, and `naturalWidth` is only trustworthy on the instance that has
    // actually finished decoding.
    const images = new Map<string, HTMLImageElement>();
    const decodes: Promise<void>[] = [];
    for (const url of urls) {
      const image = new Image();
      images.set(url, image);
      image.src = url;
      decodes.push(
        typeof image.decode === "function" ? image.decode().catch(() => undefined) : Promise.resolve(),
      );
    }
    await Promise.race([Promise.all(decodes), new Promise((resolve) => window.setTimeout(resolve, 1500))]);

    // Seed the sprite box before the first frame so the initial paint already has
    // a real size (this image is decoded, so its bitmap size is known).
    const warm = images.get(first);
    if (warm && warm.naturalWidth > 0) {
      this.elImg.style.width = `${warm.naturalWidth}px`;
      this.elImg.style.height = `${warm.naturalHeight}px`;
      this.elRoot.style.width = `${warm.naturalWidth}px`;
      this.elRoot.style.height = `${warm.naturalHeight}px`;
    }
  }

  /** The first pose of the action a fresh mascot starts with (Fall/Bouncing). */
  private firstPose(): Pose | undefined {
    const node = this.config?.actions["Fall"];
    const fromAnimations = node?.animations?.[0]?.poses?.[0];
    return fromAnimations ?? node?.poses?.[0];
  }

  /**
   * Size the sprite box from the decoded bitmap. Packs may declare anything, and
   * a zero-area box would defeat both painting and hit testing, so the previous
   * value is kept until a real one is known (see the constructor for why the size
   * must be definite at all).
   */
  private applySpriteIntrinsicSize(): void {
    const img = this.elImg;
    const width = img.naturalWidth || SPRITE_WIDTH;
    const height = img.naturalHeight || SPRITE_WIDTH;
    if (img.style.width === `${width}px` && img.style.height === `${height}px`) return;
    img.style.width = `${width}px`;
    img.style.height = `${height}px`;
    // Mirror the size onto the wrapper so it has a non-zero hit box as well: the
    // root itself only carries a transform, never its own box.
    this.elRoot.style.width = `${width}px`;
    this.elRoot.style.height = `${height}px`;
  }

  /** Pause while the mascot's container is scrolled out of view, so an embedded
   *  mascot costs nothing when the visitor is reading another part of the page. */
  private watchVisibility() {
    if (typeof IntersectionObserver !== "function") return;
    // Observe the container, not elRoot: elRoot is an empty fixed div whose only
    // child is absolutely positioned, so its own box is 0x0 and an observer on it
    // reports "not intersecting" for ever (which used to freeze the mascot).
    const target = this.container ?? this.elRoot;
    try {
      this.intersectionObserver = new IntersectionObserver(
        (entries) => {
          const entry = entries[entries.length - 1];
          if (!entry) return;
          const box = entry.boundingClientRect;
          // A zero-area box carries no information: fail open and stay visible.
          if (box.width <= 0 || box.height <= 0) {
            this.setVisible(true);
            return;
          }
          this.setVisible(entry.isIntersecting);
        },
        { root: null, threshold: 0 },
      );
      this.intersectionObserver.observe(target);
    } catch {
      this.intersectionObserver = null;
    }
  }

  private resetScrollTracking() {
    this.lastScrollY = window.scrollY;
    this.scrollDirection = 0;
    this.scrollGestureDirection = 0;
    this.pendingScrollShift = 0;
    this.scrollStopPending = false;
    this.isScrolling = false;
    this.scrollHold = "none";
  }

  private setVisible(visible: boolean) {
    if (this.visible === visible) return;
    this.visible = visible;
    this.setPauseReason("viewport", !visible);
    // Defence in depth: a wrong or stale observation must never freeze the mascot
    // for good, so re-check the geometry shortly afterwards.
    this.later(() => {
      if (this.destroyed) return;
      if (!this.visible && this.isOnScreen()) this.setVisible(true);
    }, 2000);
  }

  /** `setTimeout` that `destroy()` will cancel. */
  private later(callback: () => void, ms: number): void {
    const id = window.setTimeout(() => {
      this.pendingTimers.delete(id);
      callback();
    }, ms);
    this.pendingTimers.add(id);
  }

  private setPauseReason(reason: PauseReason, paused: boolean) {
    const wasPaused = this.pauseReasons.size > 0;
    if (paused) this.pauseReasons.add(reason);
    else this.pauseReasons.delete(reason);
    const isPaused = this.pauseReasons.size > 0;
    if (wasPaused === isPaused) return;

    if (isPaused) {
      cancelAnimationFrame(this.loopId);
      window.clearTimeout(this.scrollDebounceTimer);
      this.resetScrollTracking();
      this.emit({ kind: "milestone", name: "paused", detail: reason, x: this.x, y: this.y, leaf: this.leafLabel() });
    } else {
      this.resetScrollTracking();
      this.emit({ kind: "milestone", name: "resumed", detail: reason, x: this.x, y: this.y, leaf: this.leafLabel() });
      this.resumeLoop();
    }
  }

  private isOnScreen() {
    const rect = (this.container ?? this.elRoot).getBoundingClientRect();
    return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  private resumeLoop() {
    if (this.destroyed) return;
    cancelAnimationFrame(this.loopId);
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.loopId = requestAnimationFrame((t) => this.loop(t));
  }

  public destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.loopId);
    this.unregisterPage?.();
    this.unregisterPage = null;
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;
    this.eventsAbortController.abort();
    window.clearTimeout(this.resizeTimer);
    window.clearTimeout(this.scrollDebounceTimer);
    for (const timer of this.pendingTimers) window.clearTimeout(timer);
    this.pendingTimers.clear();
    this.releaseStack();
    this.actionStack = [];
    this.interaction.finalize();
    this.emit({ kind: "despawn", detail: "destroy()" });
    MascotEngine.liveEngines.delete(this);
    if (this.elRoot.parentNode) this.elRoot.parentNode.removeChild(this.elRoot);
  }

  /** Current observable state, for timers and for poking at the mascot in the
   *  browser console: `__mascotEngines[0].snapshot()`. */
  /** Where the mascot is drawn, in viewport pixels. The engine's own coordinates are
   *  virtual units (1 unit = 1 sprite pixel at `scale`), so anything outside the
   *  engine — logs, host code — should read this instead of `x`/`y`. */
  public position(): { x: number; y: number } {
    const scale = this.spriteScale;
    return { x: this.x * scale, y: this.y * scale };
  }

  public snapshot() {
    const node = this.currentLeaf();
    const scale = this.spriteScale;
    return {
      pet: this.label,
      mascot: this.mascotName,
      x: this.x * scale,
      y: this.y * scale,
      behavior: this.currentBehavior?.name ?? "",
      leaf: this.leafLabel(),
      path: this.stackPath(),
      nodeType: node?.type ?? "",
      border: node?.borderType ?? "",
      image: this.currentImage(),
      lookRight: this.lookRight,
      stackDepth: this.actionStack.length,
      dragging: this.isDragging,
      tick: this.tickCount,
    };
  }

  /** Convert a virtual length or coordinate to viewport pixels (the log's unit). */
  private toPage(value: number): number {
    return value * this.spriteScale;
  }

  private emit(event: EngineEvent) {
    if (!MascotEngine.observers.size) return;
    // Boundary three: the observation log and `?debug` consumers work in *page*
    // pixels, so every positional field is converted before it leaves the engine.
    // Text that embeds a coordinate has to convert at its own source.
    const scale = this.spriteScale;
    let reported: EngineEvent = event;
    if (scale !== 1) {
      const source = event as unknown as Record<string, unknown>;
      const keys = ["x", "y", "px", "py", "dx", "dy", "step", "targetX", "targetY"];
      let converted: Record<string, unknown> | null = null;
      for (const key of keys) {
        if (typeof source[key] !== "number") continue;
        converted ??= { ...source };
        converted[key] = (source[key] as number) * scale;
      }
      if (converted) reported = converted as unknown as EngineEvent;
    }
    for (const observer of MascotEngine.observers) {
      // Logging must never be able to break the mascot.
      try {
        observer(this, reported);
      } catch {
        /* ignore */
      }
    }
  }

  private currentImage() {
    const src = this.elImg.getAttribute("src") ?? "";
    return src.split("/").pop() ?? "";
  }

  private leafLabel() {
    const node = this.currentLeaf();
    if (!node) return "-";
    return `${node.name ?? node.className ?? "?"}|${node.type}`;
  }

  /**
   * A client point in sprite (bitmap) coordinates, matching how the image is drawn
   * and how libshijima computes it:
   *
   *   looking left   left edge = anchor.x - ImageAnchor.x
   *   looking right  left edge = anchor.x - (width - ImageAnchor.x)   (mirrored)
   *
   * Qt hardcodes 128 here ("FIXME: assumes width of 128"); the real bitmap width is
   * used instead, which is the same number for these packs and stays correct for
   * others.
   */
  /**
   * A client point in sprite (bitmap) coordinates — boundary two, screen → virtual.
   *
   * Because the engine works in virtual units and one virtual unit is one sprite
   * pixel, the bitmap's own geometry (ImageAnchor, the 128 px width) *is* the virtual
   * geometry, so the local point is simply the virtual cursor minus the sprite's
   * virtual top-left. The hotspot origins then compare directly, at any drawn size.
   */
  private spritePoint(clientX: number, clientY: number): { x: number; y: number } | null {
    const pose = this.currentPose();
    if (!pose) return null;
    // `x`/`y` and pointer coordinates are both in the viewport frame.
    const cursor = this.toVirtual(clientX, clientY);
    const width = this.elImg.naturalWidth || SPRITE_WIDTH;
    const shift = this.hostShift();
    const left =
      (this.lookRight ? this.x - (width - pose.imageAnchor.x) : this.x - pose.imageAnchor.x) + shift.x;
    const top = this.y - pose.imageAnchor.y + shift.y;
    return { x: cursor.x - left, y: cursor.y - top };
  }

  /**
   * How far the host's CSS moves the anchor away from the coordinates this engine
   * computes, in virtual units.
   *
   * The engine's own model is `x`/`y`, but nothing stops the host from moving the
   * anchor with CSS — firefly lifts it above its music player
   * (`body.has-global-player #mascot-pet-anchor { transform: translateY(-4.5rem) }`).
   * Pointer mapping has to follow the pixels the visitor sees, or a press lands on
   * whatever the engine *would* have drawn at that spot: measured 56–72 px off in
   * firefly, which made the drawn head unpressable and put the hotspots on the body.
   *
   * The shift is measured from the DOM at most once per logic tick (and forced before
   * a press), because the anchor's border box already carries both this engine's
   * transform and the host's.
   */
  private hostShift(force = false): { x: number; y: number } {
    if (!force && this.hostShiftCache.tick === this.tickCount) return this.hostShiftCache;
    const scale = this.spriteScale;
    const rect = this.elRoot.getBoundingClientRect();
    this.hostShiftCache = {
      x: rect.left / scale - this.x,
      y: rect.top / scale - this.y,
      tick: this.tickCount,
    };
    return this.hostShiftCache;
  }

  /** The hotspot under a client point, if that behaviour is allowed to run. */
  private hotspotUnderCursor(clientX: number, clientY: number): Hotspot | null {
    if (!this.config || !this.actionStack.length) return null;
    const frame = this.actionStack[this.actionStack.length - 1];
    const animation = frame ? this.activeAnimation(frame) : undefined;
    if (!animation?.hotspots) return null;
    const point = this.spritePoint(clientX, clientY);
    if (!point) return null;
    const hotspot = hotspotAt(animation.hotspots, point);
    if (!hotspot) return null;
    // A hotspot is a deliberate visitor action, so it is not filtered by the random
    // selection knobs — but an explicit "never show this" is still honoured.
    if (MascotEngine.animationConfig.denies(this.mascotName, hotspot.behavior)) return null;
    return hotspot;
  }

  private stackPath() {
    return this.actionStack
      .map((frame) => frame.node.name ?? frame.node.className ?? frame.node.type)
      .join(" > ");
  }

  private bindEvents() {
    const signal = this.eventsAbortController.signal;

    this.elRoot.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      // A press has to be mapped through the *drawn* position, so measure any host CSS
      // offset now instead of reusing this tick's cached value.
      this.hostShift(true);
      // ShijimaWidget::pointInside(): the press only belongs to the mascot when it
      // lands on an opaque pixel of the frame it is showing, so the transparent
      // corners of the 128 px box are not a handle.
      if (!this.isOpaqueAt(e.clientX, e.clientY)) return;
      this.pressActive = true;
      this.pressStartAt = performance.now();
      this.pressClientX = e.clientX;
      this.pressClientY = e.clientY;
      this.pressMaxMovement = 0;
      this.hotspotHoldTriggered = false;
      // The press is itself a pointer report. Qt reads `QCursor::pos()` every tick, so
      // its cursor is always current; here the cursor would otherwise stay where the
      // last `mousemove` left it — a mascot that walked under a resting pointer would
      // look like it had been dragged away from the press point.
      this.cursorX = e.clientX;
      this.cursorY = e.clientY;
      this.cursorButtons = e.buttons;
      // libshijima animation::handle_dragging(): a press inside a hotspot runs that
      // behaviour instead of picking the mascot up. The gesture policy decides *when*
      // (long press or click), and moving past the hold tolerance turns the press into
      // a pickup anyway (MascotWidgetInteraction::mouseMoveEvent).
      const hotspot = this.hotspotUnderCursor(e.clientX, e.clientY);
      if (hotspot) {
        this.hotspotHold = hotspot;
        this.elRoot.style.cursor = "pointer";
        return;
      }
      this.hotspotHold = null;
      this.beginDrag(e.clientX, e.clientY);
    }, { signal });

    // Page-level input is dispatched once for all mascots by installGlobalEvents().
  }

  /**
   * Linear size multiplier of the drawn mascot. The engine keeps every coordinate
   * in *virtual* units where one unit is one sprite pixel, exactly like libshijima's
   * `environment::set_scale`, and converts only at the two boundaries: rendering
   * (virtual → screen) and pointer input (screen → virtual). That is what lets the
   * packs' own pixel constants — `workArea.top+64`, `width-128`, pose velocities,
   * `Offset Y=1`, hotspot origins — stay correct at any drawn size, and it keeps the
   * relative motion feel identical (a bigger mascot covers more pixels per tick).
   */
  private get spriteScale(): number {
    return MascotEngine.animationConfig.mascotScale(this.mascotName);
  }

  /** Viewport extent in virtual units. */
  private get virtualWidth(): number {
    return window.innerWidth / this.spriteScale;
  }

  private get virtualHeight(): number {
    return window.innerHeight / this.spriteScale;
  }

  /** A client (screen) point in virtual units. */
  private toVirtual(clientX: number, clientY: number): { x: number; y: number } {
    const scale = this.spriteScale;
    return { x: clientX / scale, y: clientY / scale };
  }

  /**
   * The cursor the *simulation* reads, in virtual units: the pointer, plus this
   * drag's grab offset while the mascot is held. Qt reads the same value here and in
   * the pack's `mascot.environment.cursor` (`state::get_raw_cursor()` →
   * `roll_dcursor()` → `get_cursor()`), so the held pose's `FootX` comparison and the
   * anchor stay in one reference frame.
   */
  private simulationCursorVirtual(): { x: number; y: number } {
    const cursor = this.toVirtual(this.cursorX, this.cursorY);
    return this.dragGrab ? { x: cursor.x + this.dragGrab.x, y: cursor.y + this.dragGrab.y } : cursor;
  }

  /** `environment.cursor` for the pack expressions: position and per-tick delta,
   *  both in virtual units. */
  private cursorInVirtualUnits(): { x: number; y: number; dx: number; dy: number } {
    const cursor = this.simulationCursorVirtual();
    return { x: cursor.x, y: cursor.y, dx: this.cursorTickDX, dy: this.cursorTickDY };
  }

  /** Release a held mascot: the grab offset goes away, so the pointer is the cursor
   *  again. The behaviour change (Thrown, resist-escape) is the caller's job. */
  private endDrag(): void {
    this.isDragging = false;
    this.dragGrab = null;
    this.elRoot.style.cursor = "grab";
  }

  /** Pick the mascot up: Qt does this from `beginLeftPress()` when the press is not on
   *  a hotspot, and from `mouseMoveEvent()` when a hotspot candidate leaves the hold
   *  tolerance. */
  private beginDrag(clientX: number, clientY: number): void {
    this.isDragging = true;
    this.resetScrollTracking();
    this.elRoot.style.cursor = "grabbing";
    // dragged::init(ctx): `foot_x = cursor.x + OffsetX` — and the local cursor is
    // seeded on the first anchor write below so that this equals the anchor the
    // mascot already has. That is what keeps the grab point under the cursor instead
    // of snapping to the pack's fixed hold point. The anchor itself is placed by
    // `applyDragAnchor()`, not here (dragged::subtick).
    const pressCursor = this.toVirtual(clientX, clientY);
    this.dragPressAnchorX = this.x;
    this.dragPressAnchorY = this.y;
    this.dragPressCursorX = pressCursor.x;
    this.dragPressCursorY = pressCursor.y;
    this.dragGrab = null;
    this.cursorX = clientX;
    this.cursorY = clientY;
    this.footX = this.x;
    this.footDX = 0;
    this.dragStillTicks = 0;
    this.vx = this.vy = 0;
    // libshijima animation::handle_dragging(): picking a mascot up ends any
    // interaction it is in.
    this.interaction.finalize();
    this.setBehavior("Dragged", "drag-start");
  }

  /**
   * `dragged::subtick()`: pin the anchor to `cursor + OffsetX/OffsetY`.
   *
   * Qt runs this once per *subtick* — every 10 ms, i.e. four times per logic frame —
   * and assigns the anchor directly, with no clamp and no interpolation, so a held
   * mascot can never drift away from the cursor however fast the pointer moves. The
   * web engine ticks every 40 ms, so this is called from the tick *and* from every
   * pointer event, and `render()` skips interpolation while a drag is active.
   */
  private applyDragAnchor(): void {
    const frame = this.actionStack[this.actionStack.length - 1];
    // libshijima writes the anchor from `dragged::subtick()` only: while the pack's
    // `Resisting` action (`resist::tick`) runs, the held mascot stays where it was —
    // which is also what makes that action's "the cursor has moved" test fire.
    if (this.isResistAction(frame?.node)) return;
    const offsetX = this.varNumber(frame, "OffsetX") ?? runtime.dragOffsetX;
    const offsetY = this.varNumber(frame, "OffsetY") ?? runtime.dragOffsetY;
    if (!this.dragGrab) {
      // Qt reads a *local* cursor here (`state::get_raw_cursor()`); seeding it from
      // the grab point is what keeps the mascot from snapping to the pack's hold point.
      this.dragGrab = {
        x: this.dragPressAnchorX - this.dragPressCursorX - offsetX,
        y: this.dragPressAnchorY - this.dragPressCursorY - offsetY,
      };
      this.footX = this.dragPressAnchorX;
    }
    const cursor = this.simulationCursorVirtual();
    this.x = cursor.x + offsetX;
    this.y = cursor.y + offsetY;
  }

  /** Qt `ShijimaWidget::mouseMoveEvent()`: remember how far the pointer has travelled
   *  since the press, and let a hotspot candidate become a pickup once it leaves the
   *  hold tolerance. */
  private updatePressMovement(): void {
    if (!this.pressActive) return;
    const distance =
      Math.abs(this.cursorX - this.pressClientX) + Math.abs(this.cursorY - this.pressClientY);
    this.pressMaxMovement = Math.max(this.pressMaxMovement, distance);
    if (this.isDragging || !this.hotspotHold) return;
    if (distance <= HOLD_MOVEMENT_TOLERANCE_PX) return;
    // Past the tolerance the candidate is dropped and the press picks the mascot up,
    // so a drag that starts on the head still works.
    this.hotspotHold = null;
    this.beginDrag(this.cursorX, this.cursorY);
  }

  /** Qt `ShijimaWidget::maintainHotspotHold()`: a press that has been held inside the
   *  tolerances long enough runs the hotspot's behaviour, and keeps it running. Qt
   *  pins the behaviour's next selection to itself (`prefer_next_behavior`) so the
   *  patpat repeats; re-issuing it whenever the mascot has moved on is the equivalent
   *  here, without touching the behaviour-selection machinery. */
  private maintainHotspotHold(): void {
    if (!this.pressActive || !this.hotspotHold || this.isDragging) return;
    if (performance.now() - this.pressStartAt < HOLD_TRIGGER_MS) return;
    if (this.pressMaxMovement > HOLD_MOVEMENT_TOLERANCE_PX) return;
    const behavior = this.hotspotHold.behavior;
    this.hotspotHoldTriggered = true;
    if (this.currentBehavior?.name === behavior) return;
    this.emitHotspot("hold", this.hotspotHold);
    this.setBehavior(behavior, "hotspot-hold");
  }

  /** Qt `ShijimaWidget::mouseReleaseEvent()`: a short, still release counts as a click
   *  and triggers the hotspot under the *release* point (`manager::trigger_hotspot`);
   *  a release after a pickup throws the mascot (`dragged::handle_dragging`). */
  private finishPress(clientX: number, clientY: number): void {
    if (!this.pressActive) return;
    const elapsed = performance.now() - this.pressStartAt;
    const triggeredHold = this.hotspotHoldTriggered;
    const hadCandidate = this.hotspotHold !== null;
    const movement = this.pressMaxMovement;
    this.pressActive = false;
    this.hotspotHold = null;
    this.hotspotHoldTriggered = false;
    if (this.isDragging) {
      this.endDrag();
      this.setBehavior("Thrown", "drag-release");
      return;
    }
    // A release that follows a completed hold simply stops patting; only a short,
    // still release is a click (`MascotHoldGesture::qualifiesAsClick`).
    if (triggeredHold || !hadCandidate) return;
    if (elapsed > CLICK_DURATION_MS || movement > CLICK_MOVEMENT_TOLERANCE_PX) return;
    const hotspot = this.hotspotUnderCursor(clientX, clientY);
    if (!hotspot) return;
    this.emitHotspot("click", hotspot);
    this.setBehavior(hotspot.behavior, "hotspot");
  }

  /** Drop a press without deciding a gesture (the tab went hidden mid-press). */
  private cancelPress(): void {
    this.pressActive = false;
    this.hotspotHold = null;
    this.hotspotHoldTriggered = false;
  }

  private emitHotspot(phase: "hold" | "click", hotspot: Hotspot): void {
    const local = this.spritePoint(this.cursorX, this.cursorY);
    this.emit({
      kind: "milestone",
      name: "hotspot",
      detail: `${phase} behavior=${hotspot.behavior} shape=${hotspot.shape} local=${local ? `${local.x.toFixed(0)},${local.y.toFixed(0)}` : "?"}(sprite px)`,
      x: this.x,
      y: this.y,
      leaf: this.leafLabel(),
    });
  }

  /** `ShijimaWidget::pointInside()`: a press only belongs to the mascot when it lands
   *  on an opaque pixel of the frame it is showing. The bitmap is cached until the
   *  image changes; a canvas that cannot be read (sprites served from another origin)
   *  degrades to the whole box. */
  private isOpaqueAt(clientX: number, clientY: number): boolean {
    const point = this.spritePoint(clientX, clientY);
    if (!point) return false;
    const img = this.elImg;
    const width = img.naturalWidth || SPRITE_WIDTH;
    const height = img.naturalHeight || SPRITE_WIDTH;
    if (point.x < 0 || point.y < 0 || point.x > width || point.y > height) return false;
    const data = this.frameAlpha();
    if (!data) return true;
    // `spritePoint()` is in drawn (possibly mirrored) space; the bitmap is not.
    const x = Math.min(width - 1, Math.max(0, Math.round(this.lookRight ? width - point.x : point.x)));
    const y = Math.min(height - 1, Math.max(0, Math.round(point.y)));
    return data.data[(y * data.width + x) * 4 + 3] !== 0;
  }

  /** The pixels of the frame the mascot is currently showing, cached per image URL. */
  private frameAlpha(): ImageData | null {
    const src = this.elImg.getAttribute("src") ?? "";
    if (this.alphaSrc === src) return this.alphaData;
    this.alphaSrc = src;
    this.alphaData = null;
    const img = this.elImg;
    if (!src || !img.complete || img.naturalWidth === 0) return null;
    const canvas = this.alphaCanvas ?? (this.alphaCanvas = document.createElement("canvas"));
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    try {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(img, 0, 0);
      this.alphaData = context.getImageData(0, 0, canvas.width, canvas.height);
    } catch {
      // Tainted canvas (sprites served from another origin): fall back to the box.
      this.alphaData = null;
    }
    return this.alphaData;
  }

  /** Resolve a configuration Metric against one viewport axis. A bare number is a
   *  page pixel value, so it is divided by the sprite scale to reach virtual units;
   *  percentages and `left`/`right`/`top`/`bottom`/`center` follow the viewport. */
  private metric(value: number | string | undefined, axis: "x" | "y", fallback: number): number {
    if (value === undefined) return fallback;
    const extent = axis === "x" ? this.virtualWidth : this.virtualHeight;
    const scale = this.spriteScale;
    if (typeof value === "number") return Number.isFinite(value) ? value / scale : fallback;
    const text = String(value).trim().toLowerCase();
    if (text.endsWith("%")) {
      const percent = Number(text.slice(0, -1));
      return Number.isFinite(percent) ? (extent * percent) / 100 : fallback;
    }
    if (text === "left" || text === "top") return 0;
    if (text === "right" || text === "bottom") return extent;
    if (text === "center") return extent / 2;
    const numeric = Number(text);
    return Number.isFinite(numeric) ? numeric / scale : fallback;
  }

  /** The mascot's activity rectangle in viewport coordinates. */
  private area(): Area {
    const zone = MascotEngine.animationConfig.zone(this.mascotName);
    const left = this.metric(zone.left, "x", 0);
    const right = this.metric(zone.right, "x", this.virtualWidth);
    const top = this.metric(zone.top, "y", 0);
    const bottom = this.metric(zone.bottom, "y", this.virtualHeight);
    return {
      left,
      right: Math.max(left + 1, right),
      top,
      bottom: Math.max(top + 1, bottom),
    };
  }

  /** Start position from the configuration: top or floor, any x, and several
   *  mascots are spread apart instead of stacking on one spot. */
  private applySpawnPosition() {
    const spawn = MascotEngine.animationConfig.spawn(this.mascotName);
    const area = this.area();
    const base = this.metric(spawn.x, "x", (area.left + area.right) / 2);
    const index = MascotEngine.liveEngines.size;
    const stagger = (spawn.staggerPx ?? 0) / this.spriteScale;
    const offset = index === 0 || stagger === 0 ? 0 : (index % 2 === 1 ? 1 : -1) * Math.ceil(index / 2) * stagger;
    this.x = Math.min(area.right, Math.max(area.left, base + offset));
    this.y =
      spawn.vertical === "floor"
        ? area.bottom
        : area.top + (spawn.topOffset ?? 100) / this.spriteScale;
  }

  /** Is `point` on one of the work-area borders? */
  private borderIsOn(side: "top" | "right" | "bottom" | "left", point: { x: number; y: number }, area = this.area()) {
    const tolerance = 1;
    if (side === "top" || side === "bottom") {
      const y = side === "top" ? area.top : area.bottom;
      const crossed = side === "bottom" && point.y >= y;
      const near = Math.abs(point.y - y) < tolerance;
      return (crossed || near) && point.x >= area.left && point.x <= area.right;
    }
    const x = side === "left" ? area.left : area.right;
    return Math.abs(point.x - x) < tolerance && point.y >= area.top && point.y <= area.bottom;
  }

  private environment() {
    const area = this.area();
    const border = (side: "top" | "right" | "bottom" | "left") => ({ isOn: (point: { x: number; y: number }) => this.borderIsOn(side, point, area) });
    const workArea = {
      ...area,
      width: area.right - area.left,
      height: area.bottom - area.top,
      topBorder: border("top"), rightBorder: border("right"),
      bottomBorder: border("bottom"), leftBorder: border("left"),
      isOn: (point: { x: number; y: number }) => ["top", "right", "bottom", "left"].some((side) => this.borderIsOn(side as "top" | "right" | "bottom" | "left", point, area)),
    };
    return {
      floor: { isOn: (point: { x: number; y: number }) => this.borderIsOn("bottom", point, area) },
      ceiling: { isOn: (point: { x: number; y: number }) => this.borderIsOn("top", point, area) },
      wall: { isOn: (point: { x: number; y: number }) => this.borderIsOn("left", point, area) || this.borderIsOn("right", point, area) },
      workArea,
      screen: { ...workArea },
      activeIE: {
        visible: false, left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0,
        topBorder: { isOn: () => false }, bottomBorder: { isOn: () => false },
        leftBorder: { isOn: () => false }, rightBorder: { isOn: () => false }, isOn: () => false,
      },
      // The cursor is a sprite-unit quantity for the packs: `Pinched` picks its held
      // pose from `#{FootX < mascot.environment.cursor.x-50}`, `ChaseMouse` targets
      // `cursor.x`, `SitAndFaceMouse` compares against `anchor.x` — all virtual. It
      // has to be converted here, otherwise every such comparison mixes units and
      // the mascot is stuck on one variant (which is what a held mascot did at any
      // scale other than 1).
      cursor: this.cursorInVirtualUnits(),
    };
  }

  private mascotScope(vars: Record<string, unknown>) {
    const mascot = {
      anchor: { x: this.x, y: this.y },
      lookRight: this.lookRight,
      environment: this.environment(),
      totalCount: Math.max(1, MascotEngine.liveEngines.size),
      ...vars,
    } as Record<string, unknown>;
    return { finalMascot: mascot, mascot, Math, ...vars };
  }

  private run(expression: string, scope: Record<string, unknown>) {
    return evaluateExpression(this.cleanExpression(expression), scope);
  }

  /**
   * libshijima splits the attributes of an <ActionReference> in two
   * (scripting::variables::add_attr):
   *   ${expr} is "dynamic (once)"       — evaluated when the action starts;
   *   #{expr} is "dynamic (every frame)" — re-evaluated on each tick.
   * Freezing ${...} is what keeps TargetX/TargetY stable for the whole action: a
   * target that is re-rolled every tick makes the mascot jitter around it
   * ("stuck halfway up the wall") instead of travelling to it.
   */
  private resolveVars(attributes: Record<string, string>, inherited: Record<string, unknown> = {}) {
    const resolved: Record<string, unknown> = { ...inherited };
    // Two passes: an attribute may reference another attribute of the same
    // <ActionReference> (TargetX="#{...cursor.x+Gap}" Gap="${...}"), which only
    // evaluates correctly once its dependency has been resolved.
    for (let pass = 0; pass < 2; pass++) {
      for (const [key, raw] of Object.entries(attributes)) {
        if (/^#\{/.test(raw)) continue; // dynamic (every frame)
        if (/^\$\{/.test(raw)) {
          try {
            resolved[key] = this.run(raw, this.mascotScope({ ...attributes, ...resolved }));
          } catch {
            if (!(key in resolved)) resolved[key] = raw;
          }
        } else if (raw === "true" || raw === "false") {
          resolved[key] = raw === "true";
        } else if (raw.trim() !== "" && Number.isFinite(Number(raw))) {
          resolved[key] = Number(raw);
        } else {
          resolved[key] = raw;
        }
      }
    }
    return resolved;
  }

  /** Every attribute of the frame as a value: frozen for ${...} (evaluated once,
   *  the first time it is needed) and re-evaluated per tick for #{...}. */
  private frameVars(frame: ActionFrame | undefined): Record<string, unknown> {
    if (!frame) return {};
    const raw = frame.vars || {};
    // ${...} on an <ActionReference> is already frozen when the frame is created;
    // this covers the attributes declared on the action node itself.
    for (const [key, value] of Object.entries(raw)) {
      if (key in frame.resolved || !/^\$\{/.test(value)) continue;
      try {
        frame.resolved[key] = this.run(value, this.mascotScope({ ...raw, ...frame.resolved }));
      } catch {
        frame.resolved[key] = value;
      }
    }
    const frozen = frame.resolved;
    // While the mascot is held, the pack's own `Pinched` action picks its pose from
    // FootX/FootDX (libshijima dragged::init/subtick maintain them). Without them
    // every one of its animation conditions is false and the held pose never
    // changes. `resolved` is where a live attribute value belongs: it overrides the
    // raw attribute and the ${...} freezer leaves existing keys alone.
    if (this.isDragging) {
      frozen.FootX = this.footX;
      frozen.footX = this.footX;
      frozen.FootDX = this.footDX;
      frozen.footDX = this.footDX;
    }
    const hasDynamic = Object.values(raw).some((value) => /^#\{/.test(value));
    if (!hasDynamic) return { ...raw, ...frozen };
    if (frame.liveTick === this.tickCount) return { ...raw, ...frame.live };
    const live: Record<string, unknown> = { ...frozen };
    for (let pass = 0; pass < 2; pass++) {
      for (const [key, value] of Object.entries(raw)) {
        if (key in frozen) continue;
        if (/^#\{/.test(value)) {
          try {
            live[key] = this.run(value, this.mascotScope({ ...raw, ...live }));
          } catch {
            live[key] = value;
          }
        } else if (value === "true" || value === "false") {
          live[key] = value === "true";
        } else if (value.trim() !== "" && Number.isFinite(Number(value))) {
          live[key] = Number(value);
        } else {
          live[key] = value;
        }
      }
    }
    frame.live = live;
    frame.liveTick = this.tickCount;
    return { ...raw, ...live };
  }

  private varValue(frame: ActionFrame | undefined, key: string): unknown {
    return this.frameVars(frame)[key];
  }

  private varString(frame: ActionFrame | undefined, key: string): string {
    const value = this.varValue(frame, key);
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : String(value);
  }

  private varNumber(frame: ActionFrame | undefined, key: string): number | null {
    const value = this.varValue(frame, key);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  private context(frame?: ActionFrame) {
    const target = frame?.client?.target;
    return this.mascotScope({
      ...this.frameVars(frame),
      target: target ? { anchor: { x: target.x, y: target.y } } : undefined,
    });
  }

  private cleanExpression(expression: string) {
    return expression.replace(/^\$\{|^#\{|\}$/g, "").trim();
  }

  private evaluate(expression: string | undefined, frame?: ActionFrame): unknown {
    if (!expression) return undefined;
    try {
      return this.run(expression, this.context(frame));
    } catch (error) {
      const key = `${this.mascotName}:${expression}`;
      if (!loggedExpressionFailures.has(key)) {
        loggedExpressionFailures.add(key);
        expressionLog.warn("expression evaluation failed", {
          mascot: this.mascotName,
          expression,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return undefined;
    }
  }

  private evaluateCondition(condition: string | undefined, frame?: ActionFrame) {
    if (!condition) return true;
    return Boolean(this.evaluate(condition, frame));
  }

  private evaluateNumber(expression: string | undefined, frame?: ActionFrame) {
    const value = this.evaluate(expression, frame);
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  private newFrame(node: ActionNode, vars: Record<string, string> = {}, resolved: Record<string, unknown> = {}): ActionFrame {
    const frame: ActionFrame = {
      node,
      childIndex: 0,      // libshijima layers the action's own attributes under the <ActionReference>
      // overlay, so a condition may read either of them.
      vars: { ...(node.attributes || {}), ...vars },
      resolved,
      live: {},
      liveTick: -1,
      durationLimit: null,
      elapsed: 0,
      poseIndex: 0,
      poseTick: 0,
      stallTicks: 0,
      progressX: NaN,
      progressY: NaN,
      server: null,
      client: null,
      animation: undefined,
      bornTick: this.tickCount,
    };
    this.initBroadcast(frame);
    return frame;
  }

  /** libshijima `base::init()`: an action that advertises an `Affordance` starts a
   *  broadcast as it is created and clears the attribute, so it advertises once.
   *  A ScanMove action is the scanning side: it looks for somebody else's
   *  advertisement instead (`scanmove::init`). */
  private initBroadcast(frame: ActionFrame) {
    const affordance = frame.vars.Affordance;
    if (typeof affordance !== "string" || affordance.trim() === "") return;
    const label = `${frame.node.name ?? frame.node.className ?? "?"}|${frame.node.type}`;
    if (this.isScanMove(frame.node)) {
      const probe = affordance.trim();
      const scan = MascotEngine.broadcasts.probe(probe, { x: this.x, y: this.y });
      frame.client = MascotEngine.broadcasts.tryConnect(
        probe,
        { x: this.x, y: this.y },
        this.varString(frame, "Behavior"),
        this.varString(frame, "TargetBehavior"),
        MascotEngine.animationConfig.scanDistancePx(this.mascotName),
      );
      this.emit({
        kind: "milestone",
        name: frame.client ? "broadcast-connect" : "broadcast-scan",
        detail: `affordance=${affordance} live=${scan.live} nearest=${scan.nearest === null ? "-" : this.toPage(scan.nearest).toFixed(0)}px found=${!!frame.client}`,
        affordance: probe,
        side: "client",
        behavior: this.varString(frame, "Behavior"),
        distance: scan.nearest === null ? undefined : this.toPage(scan.nearest),
        x: this.x,
        y: this.y,
        leaf: label,
      });
      return;
    }
    frame.server = MascotEngine.broadcasts.startBroadcast(affordance.trim(), { x: this.x, y: this.y });
    const vars = { ...frame.vars };
    delete vars.Affordance;
    frame.vars = vars;
    this.emit({
      kind: "milestone",
      name: "broadcast-start",
      detail: `affordance=${affordance}`,
      affordance: affordance.trim(),
      side: "server",
      behavior: this.varString(frame, "Behavior"),
      x: this.x,
      y: this.y,
      leaf: label,
    });
  }

  /** libshijima `base::finalize()`: an action instance that ends stops advertising
   *  and hands its scan target back to the pool. */
  private releaseFrame(frame: ActionFrame | undefined) {
    if (!frame) return;
    frame.server?.finalize();
    frame.server = null;
    frame.client?.finalize();
    frame.client = null;
  }

  private releaseStack() {
    for (const frame of this.actionStack) this.releaseFrame(frame);
  }

  private setBehavior(name: string, reason = "engine", behaviorId?: number) {
    if (!this.config) return;
    if (this.behaviorInitsThisTick >= MAX_BEHAVIOR_INITS_PER_TICK) {
      if (name === "StandUp") return;
      name = "StandUp";
      reason = "init-limit";
    }
    this.behaviorInitsThisTick++;
    const behavior =
      this.config.behaviors.find((entry) => entry.name === name && (behaviorId === undefined || entry.id === behaviorId)) ||
      (this.config.actions[name] ? { name, frequency: 100, hidden: false, nextBehaviors: [] } : undefined);
    const selected =
      behavior ||
      this.config.behaviors.find((entry) => entry.name === "StandUp") ||
      this.config.behaviors[0];
    if (!selected) return;
    const action = this.config.actions[selected.name];
    const from = this.currentBehavior?.name ?? "";
    this.clampReported = false;
    this.behaviorTicks = 0;
    // The pacer measures how long *this* behaviour has been standing still. Without
    // this reset an exhausted counter would switch behaviours on every tick, which
    // both looked broken and stopped sequences (Stand -> scan) from ever advancing.
    this.stillTicks = 0;
    if (!action) {
      this.interactionVisualActive = false;
      this.currentBehavior = selected;
      this.onBehaviorEnd(reason);
      return;
    }
    // libshijima activate_queued_behavior(): running the behaviour a live handshake
    // asked for marks that handshake as started.
    if (this.interaction.available && !this.interaction.started && this.interaction.behavior === selected.name) {
      this.interaction.started = true;
    }
    if (
      this.interaction.ongoing &&
      selected.name !== this.interaction.behavior &&
      !reason.startsWith("interaction-")
    ) {
      this.interaction.finalize();
    }
    // Frames that are being replaced stop advertising and let go of scan targets.
    this.releaseStack();
    this.currentBehavior = selected;
    this.interactionVisualActive = !!action && this.actionTreeMatches(action, (node) => this.isInteract(node));
    if (this.interactionVisualActive) {
      // Remove the standalone frame at the moment the interaction starts. The
      // partner's interaction sprite must not be paired with this stale frame.
      this.elImg.style.visibility = "hidden";
      this.elImg.removeAttribute("src");
    }
    this.actionStack = [this.newFrame(action)];
    if (from !== selected.name) {
      this.emit({
        kind: "behavior",
        from,
        to: selected.name,
        reason,
        x: this.x,
        y: this.y,
        leaf: this.leafLabel(),
      });
    }
  }

  private loop(timestamp: number) {
    if (this.destroyed) return;
    // Clamp only: a pause is already explained by the visibility markers the
    // recorder writes, so there is nothing else to do about the background case.
    this.accumulator += Math.min(timestamp - this.lastTime, MAX_FRAME_DELTA_MS);
    this.lastTime = timestamp;
    // A mascot is decoration: one bad tick must not kill the animation loop and
    // leave it frozen for ever. Swallow the error, report it, and keep going.
    try {
      while (this.accumulator >= runtime.tickMs) { this.tick(); this.accumulator -= runtime.tickMs; }
      // libshijima interpolates the anchor of *move* actions between subticks, but the
      // dragged action opts out (`dragged::requests_interpolation() == false`): a held
      // mascot is painted exactly where the cursor is, so it cannot trail behind a fast
      // drag. Its smoothness comes from pointer events re-pinning the anchor instead.
      this.render(!this.isDragging);
    } catch (error) {
      this.accumulator = 0;
      const now = performance.now();
      if (now - this.lastTickErrorAt > 1000) {
        this.lastTickErrorAt = now;
        this.emit({
          kind: "milestone",
          name: "tick-error",
          detail: `${error instanceof Error ? error.name : "Error"}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          x: this.x,
          y: this.y,
          leaf: this.leafLabel(),
        });
      }
    }
    if (!this.destroyed) this.loopId = requestAnimationFrame((t) => this.loop(t));
  }

  private tick() {
    if (!this.config || !this.actionStack.length) return;
    // ShijimaWidget::tick() runs the gesture policy before ticking the engine: a
    // release that never arrived must not leave a press (or a drag) stuck
    // (`MascotHoldGesture::leftButtonIsDown`), and a press held long enough becomes
    // the hotspot's hold behaviour.
    if (this.pressActive) {
      if ((this.cursorButtons & 1) === 0) this.finishPress(this.cursorX, this.cursorY);
      else {
        this.updatePressMovement();
        this.maintainHotspotHold();
      }
    }
    const beforeX = this.x;
    const beforeY = this.y;
    this.prevX = this.x;
    this.prevY = this.y;
    this.tickCount++;
    this.behaviorInitsThisTick = 0;
    this.actionExpansionsThisTick = 0;
    const surfaceBeforeScroll = this.surfaceAt();
    if (!this.isDragging && this.pendingScrollShift !== 0) {
      this.y -= this.pendingScrollShift;
      this.pendingScrollShift = 0;
      this.clampToWorkArea();
    }
    this.applyScrollIntent(surfaceBeforeScroll);
    // Cursor velocity for this tick (see the field comment), in virtual units so the
    // packs' `InitialVX/InitialVY` and `cursor.dx/dy` expressions stay sprite-unit
    // quantities. The clamp is a screen-pixel budget, so a pointer that teleports —
    // a synthetic click, a window move, a remote session — cannot fling the mascot.
    const cursorStepLimit = MAX_CURSOR_STEP / this.spriteScale;
    this.cursorTickDX = Math.max(-cursorStepLimit, Math.min(cursorStepLimit, (this.cursorX - this.lastTickCursorX) / this.spriteScale));
    this.cursorTickDY = Math.max(-cursorStepLimit, Math.min(cursorStepLimit, (this.cursorY - this.lastTickCursorY) / this.spriteScale));
    this.lastTickCursorX = this.cursorX;
    this.lastTickCursorY = this.cursorY;
    if (this.isDragging) {
      const frame = this.actionStack[this.actionStack.length - 1];
      // libshijima writes the anchor and the foot state from `dragged::subtick()`
      // only: while the pack's `Resisting` action (`resist::tick`) runs, the held
      // mascot stays where it was — which is also what makes that action's "the
      // cursor has moved" test fire, because the anchor stops tracking the pointer.
      if (!this.isResistAction(frame?.node)) {
        // dragged::subtick(): the anchor is pinned to the local cursor plus the
        // action's offsets (OffsetX = 0, OffsetY = 120 in these packs) and assigned
        // directly — Qt clamps nothing while a mascot is held.
        this.applyDragAnchor();
        const cursor = this.simulationCursorVirtual();
        // dragged::subtick() keeps a held mascot facing left (the held sprites are
        // drawn that way).
        this.lookRight = false;
        // dragged::subtick(idx 0), once per tick: a smoothed follow of the cursor that
        // the held pose is chosen from (it is compared against cursor.x in the pack).
        this.footDX = (this.footDX + (cursor.x - this.footX) * 0.1) * 0.8;
        this.footX += this.footDX;
      }
    }
    this.maintainBroadcasts();
    this.tickStartVX = this.vx;
    this.tickStartVY = this.vy;
    if (!this.isDragging) this.updatePhysics();
    this.advanceActionTree();
    this.behaviorTicks++;
    // Track how long the mascot has actually been standing still; the pacer keys
    // off this rather than behaviour age, so a "walk then sit" sequence is not
    // punished for the time its walk already used up.
    const moved = Math.abs(this.x - beforeX) + Math.abs(this.y - beforeY) > 0.05;
    this.stillTicks = moved ? 0 : this.stillTicks + 1;
    this.anchorStillTicks = moved ? 0 : this.anchorStillTicks + 1;
    if (moved) this.wantMovement = false;
    if (!this.isDragging) this.enforceBehaviorSwitch();
    this.lastSurface = this.surfaceAt();
    this.observeTick(beforeX, beforeY);
  }

  /**
   * libshijima `base::tick()` for every advertisement this mascot currently owns:
   * keep the advertised position current, and when somebody walked up to it, start
   * the behaviour the handshake asked for.
   */
  private maintainBroadcasts() {
    MascotEngine.broadcasts.prune();
    let claimed: ServerState | null = null;
    let claimedAffordance = "";
    for (const frame of this.actionStack) {
      const server = frame.server;
      if (!server) continue;
      if (server.active) server.updateAnchor({ x: this.x, y: this.y });
      if (server.isClaimed && !claimed) {
        claimed = server;
        // initBroadcast() deletes `Affordance` from the frame's vars once it has
        // advertised, so the name is read back off the action node.
        claimedAffordance = frame.node.attributes?.Affordance ?? frame.node.name ?? "";
      }
      if (!server.didMeetUp) continue;
      this.interaction = server.interaction();
      const next = this.interaction.behavior;
      if (next) this.setBehavior(next, "interaction-server");
      return;
    }
    // Somebody claimed an advertisement and is on its way: hold the pose until it
    // arrives (see runtime.broadcastServeTimeoutTicks). Without this the advertising
    // animation ends under the approaching partner and the handshake is lost.
    if (!claimed) {
      this.servingClaimSince = 0;
      return;
    }
    if (this.servingClaimSince === 0) this.servingClaimSince = this.tickCount;
    if (this.tickCount - this.servingClaimSince >= runtime.broadcastServeTimeoutTicks) {
      this.emit({
        kind: "milestone",
        name: "broadcast-serve-timeout",
        detail: `affordance=${claimedAffordance} waited=${this.tickCount - this.servingClaimSince} ticks`,
        affordance: claimedAffordance,
        side: "server",
        x: this.x,
        y: this.y,
        leaf: this.leafLabel(),
      });
      claimed.finalize();
      this.servingClaimSince = 0;
    }
  }

  /**
   * Is this frame the advertisement of a claim that has not arrived yet, and is the
   * wait still within its bound? While it is true the frame must not end and the
   * pacer must not pull the mascot away, otherwise the scanner loses its partner
   * mid-approach. Everything else (a drag, a scroll, a forced `Fall`) still releases
   * the advertisement the normal way — only the advertisement's *own* animation
   * ending is deferred.
   */
  private holdingClaim(frame: ActionFrame | undefined): boolean {
    const server = frame?.server;
    if (!server || !server.isClaimed) return false;
    if (this.servingClaimSince === 0) return true;
    return this.tickCount - this.servingClaimSince < runtime.broadcastServeTimeoutTicks;
  }

  /**
   * Animation configuration, two different limits with two different jobs:
   *
   *   forcedSwitchTicks  how long the mascot may stand still before it is nudged
   *                      into something else, so a page never looks frozen. Travel
   *                      is never cut: it is moving, so the counter is zero.
   *   maxBehaviorTicks   a hard cap on any one behaviour, so a long wall climb or
   *                      a crawl cannot monopolise the mascot. A fall (and a drag)
   *                      is still left alone, since those are engine-driven states.
   */
  private enforceBehaviorSwitch() {
    const animation = MascotEngine.animationConfig;
    // A held mascot keeps the behaviour the drag put it in: libshijima only moves on
    // to Resisting from inside that action, and never re-picks from the pool.
    if (this.isDragging) return;
    if (this.isFallLike(this.currentLeaf())) return;
    if (this.currentBehavior?.name === "Dragged") return;
    // A claimed advertisement holds its pose for the approaching partner. The pacer
    // exists so the page never looks asleep, but a mascot that is waiting to be
    // hugged is not idle — and pulling it away here is exactly what drops the scan.
    // The wait is bounded by runtime.broadcastServeTimeoutTicks, so this cannot last.
    if (this.holdingClaim(this.actionStack[this.actionStack.length - 1])) return;
    const pacer = animation.forcedSwitchTicks(this.mascotName);
    if (
      pacer > 0 &&
      this.stillTicks >= pacer &&
      !this.isTravelling() &&
      // A behaviour may opt out of the pacer so a long *stationary* animation can
      // finish. The check is on the behaviour, not on the mascot: a plain idle Stay
      // still gets nudged on time.
      animation.pacerApplies(this.mascotName, this.currentBehavior?.name)
    ) {
      // A long stretch of stillness means the page looks asleep: the behaviour that
      // replaces this one has to be one that moves the mascot somewhere.
      if (this.anchorStillTicks >= pacer) this.wantMovement = true;
      this.switchBehavior("forced-switch");
      return;
    }
    const cap = animation.maxBehaviorTicks(this.mascotName);
    if (cap > 0 && this.behaviorTicks >= cap) this.switchBehavior("behavior-cap");
  }

  private switchBehavior(reason: string) {
    this.emit({
      kind: "milestone",
      name: reason,
      detail: `behavior=${this.currentBehavior?.name ?? "?"} behaviorTicks=${this.behaviorTicks} anchorStill=${this.anchorStillTicks}${this.wantMovement ? " force-travel" : ""}`,
      x: this.x,
      y: this.y,
      leaf: this.leafLabel(),
    });
    this.onBehaviorEnd(reason);
  }

  /** Is the mascot currently going somewhere? Used so the pacer only interrupts
   *  standing still, never a walk, run, climb or jump in progress. */
  private isTravelling() {
    const node = this.currentLeaf();
    const frame = this.actionStack[this.actionStack.length - 1];
    if (!node || !frame) return false;
    if (node.type === "Move") return true;
    if (this.isScanMove(node)) return true;
    if (this.varNumber(frame, "TargetX") !== null || this.varNumber(frame, "TargetY") !== null) return true;
    const pose = this.currentPose();
    return !!pose && (pose.velocity.x !== 0 || pose.velocity.y !== 0);
  }

  /** Feed the observation stream: stack/frame changes and impossible steps.
   *  Runs once per logic tick and does nothing when nobody is listening. */
  private observeTick(beforeX: number, beforeY: number) {
    if (!MascotEngine.observers.size) return;
    const leaf = this.leafLabel();
    const image = this.currentImage();
    const path = this.stackPath();
    if (path !== this.observedPath) {
      this.observedPath = path;
      this.clampReported = false;
      const node = this.currentLeaf();
      const frame = this.actionStack[this.actionStack.length - 1];
      this.emit({
        kind: "stack",
        path,
        leaf,
        nodeType: node?.type ?? "-",
        className: node?.className ?? "",
        border: node?.borderType ?? "",
        targetX: this.varNumber(frame, "TargetX"),
        targetY: this.varNumber(frame, "TargetY"),
        image,
        lookRight: this.lookRight,
        x: this.x,
        y: this.y,
      });
    }
    if (image !== this.observedImage) {
      this.observedImage = image;
      this.emit({ kind: "image", image, leaf, x: this.x, y: this.y });
    }
    const step = Math.hypot(this.x - beforeX, this.y - beforeY);
    // A big step is only suspicious when nothing explains it. Offset actions move
    // the anchor on purpose; a thrown or falling mascot travels by its velocity
    // (`Thrown` starts with InitialVX/InitialVY from the cursor); a fast run travels
    // by its pose velocity. The tick's starting velocity matters because a landing
    // resets the velocity before this observation runs.
    const pose = this.currentPose();
    const budget =
      Math.abs(this.vx) + Math.abs(this.vy) +
      Math.abs(this.tickStartVX) + Math.abs(this.tickStartVY) +
      (pose ? Math.abs(pose.velocity.x) + Math.abs(pose.velocity.y) : 0);
    const explained = this.isDragging || this.offsetJumped || step <= budget + runtime.suspectStepPx;
    this.offsetJumped = false;
    if (step > runtime.suspectStepPx && !explained) {
      this.emit({
        kind: "suspect",
        name: "position-jump",
        detail: `single-tick step=${step.toFixed(1)}`,
        step,
        dx: this.x - beforeX,
        dy: this.y - beforeY,
        px: beforeX,
        py: beforeY,
        x: this.x,
        y: this.y,
        leaf,
      });
    }
  }

  private activeAnimation(frame: ActionFrame): AnimationVariant | undefined {
    const animations = frame.node.animations || [];
    return animations.find((animation) => this.evaluateCondition(animation.condition, frame)) || animations[0];
  }

  private advanceActionTree(): void {
    const frame = this.actionStack[this.actionStack.length - 1];
    if (!frame || !this.config) return;
    if (++this.actionExpansionsThisTick > MAX_ACTION_EXPANSIONS_PER_TICK) {
      this.emit({
        kind: "milestone",
        name: "action-expansion-limit",
        detail: `>${MAX_ACTION_EXPANSIONS_PER_TICK} expansions in one tick`,
        x: this.x,
        y: this.y,
        leaf: this.leafLabel(),
      });
      this.popActionStack();
      return;
    }
    const node = frame.node;

    if (node.type === "ActionReference") {
      // A reference carries its own Condition; it has to be honoured before the
      // reference is expanded, otherwise it is silently dropped inside a Sequence.
      if (node.condition && !this.evaluateCondition(node.condition, frame)) { this.popActionStack(); return; }
      if (!node.referenceName) { this.popActionStack(); return; }
      const referenced = this.config.actions[node.referenceName];
      if (!referenced) { this.popActionStack(); return; }
      const attributes = node.attributes || {};
      const vars = { ...frame.vars, ...attributes };
      const resolved = { ...frame.resolved, ...this.resolveVars(attributes, frame.resolved) };
      this.clampTravelTarget(resolved);
      const next = this.newFrame(referenced, vars, resolved);
      // libshijima: stay::tick() runs for Duration ticks, defaulting to 250;
      // animate ends with its animation and move ends at its target. On top of
      // that the animation configuration may pin an explicit duration to any
      // action, and may scale the pack's own holds.
      const override = MascotEngine.animationConfig.durationTicks(this.mascotName, node.referenceName);
      if (override !== null) next.durationLimit = override;
      else if (referenced.type === "Stay") next.durationLimit = this.scaledTicks(this.varNumber(next, "Duration") ?? runtime.stayDurationTicks);
      else next.durationLimit = null;
      this.actionStack[this.actionStack.length - 1] = next;
      const initialVX = this.varNumber(next, "InitialVX");
      const initialVY = this.varNumber(next, "InitialVY");
      if (initialVX !== null) this.vx = initialVX;
      if (initialVY !== null) this.vy = initialVY;
      const lookRight = this.varValue(next, "LookRight");
      if (typeof lookRight === "boolean") this.lookRight = lookRight;
      return this.advanceActionTree();
    }

    if (node.condition && !this.evaluateCondition(node.condition, frame)) { this.popActionStack(); return; }
    if (node.type === "Sequence" || node.type === "Select") {
      // `actionDurations` may name a container action too (`HoldOntoWall` is a
      // Sequence around a 500–1500 tick Stay, `ClimbAlongWall` a Sequence around a
      // climb). The limit has to be enforced here as well, otherwise pinning a
      // sequence silently does nothing and only the leaf actions respond.
      frame.elapsed++;
      if (frame.durationLimit !== null && frame.elapsed >= frame.durationLimit) {
        this.popActionStack();
        return;
      }
    }
    if (node.type === "Select") {
      if (frame.childIndex > 0) { this.popActionStack(); return; }
      const child = (node.children || []).find((candidate) => this.evaluateCondition(candidate.condition, frame));
      frame.childIndex = 1;
      if (child) this.actionStack.push(this.newFrame(child, { ...frame.vars }, { ...frame.resolved }));
      else this.popActionStack();
      return this.advanceActionTree();
    }
    if (node.type === "Sequence") {
      const children = node.children || [];
      while (frame.childIndex < children.length) {
        const child = children[frame.childIndex++];
        if (child.condition !== undefined && !this.evaluateCondition(child.condition, frame)) continue;
        this.actionStack.push(this.newFrame(child, { ...frame.vars }, { ...frame.resolved }));
        return this.advanceActionTree();
      }
      if (node.loop) { frame.childIndex = 0; return this.advanceActionTree(); }
      this.popActionStack();
      return;
    }

    if (node.className?.endsWith(".Look") || node.name === "Look") {
      // libshijima's look::tick(): looking_right = get_bool("LookRight", !looking_right),
      // so a Look without the attribute flips the mascot around.
      const value = this.varValue(frame, "LookRight");
      this.lookRight = typeof value === "boolean" ? value : !this.lookRight;
      this.popActionStack();
      return;
    }
    if (node.className?.endsWith(".Offset") || node.name === "Offset") {
      // libshijima's offset::tick() casts to int before adding.
      const offsetX = Math.trunc(this.varNumber(frame, "X") ?? 0);
      const offsetY = Math.trunc(this.varNumber(frame, "Y") ?? 0);
      this.x += offsetX;
      this.y += offsetY;
      this.clampToWorkArea();
      if (offsetX !== 0 || offsetY !== 0) {
        // An offset is a deliberate instant move, so report it as a milestone and
        // keep the jump-suspect detector for movement nothing explains.
        this.offsetJumped = true;
        this.emit({
          kind: "milestone",
          name: "offset",
          detail: `d=(${offsetX},${offsetY}) sprite px = (${this.toPage(offsetX).toFixed(1)},${this.toPage(offsetY).toFixed(1)}) page px`,
          x: this.x,
          y: this.y,
          leaf: this.leafLabel(),
        });
      }
      this.popActionStack();
      return;
    }

    // A scanning action with no partner to walk to is over at once, so the
    // surrounding sequence continues as normal (libshijima scanmove::tick:
    // `if (!client.connected()) return false;`). The walk itself happens in
    // updatePhysics(), which is where libshijima's move::tick also runs.
    if (this.isScanMove(node) && !(frame.client && frame.client.connected)) {
      // A link that *was* connected and is not any more means the advertiser went
      // away before the scanner arrived. libshijima drops this scan without a word;
      // that silence is what made the loss invisible, so it is reported here.
      if (frame.client) {
        this.emit({
          kind: "milestone",
          name: "broadcast-abort",
          detail: `affordance=${frame.vars.Affordance ?? "-"} partner stopped advertising`,
          affordance: frame.vars.Affordance,
          side: "client",
          behavior: this.varString(frame, "Behavior"),
          x: this.x,
          y: this.y,
          leaf: this.leafLabel(),
        });
      }
      this.popActionStack();
      return;
    }

    // An interaction action only runs while the partner handshake is live; without
    // it the action ends immediately (libshijima interact::tick).
    if (this.isInteract(node) && (!this.interaction.available || !this.interaction.started || !this.interaction.ongoing)) {
      this.popActionStack();
      return;
    }
    if (this.isInteract(node)) {
      // A live interaction keeps refreshing the cooldown, so it starts counting when
      // the hug/hurl actually ends. Both participants pass through here, so neither
      // of them can immediately re-initiate: without it two mascots that finish a hug
      // standing next to each other connect again on the very next pick and chain
      // hugs back to back (measured gaps of 0.1 s).
      this.interactionCooldownUntil = this.tickCount + MascotEngine.animationConfig.interactionCooldown(this.mascotName);
    }

    // libshijima dragged::subtick() — the pack's own `Pinched` action (Class
    // ...Dragged). While the mascot is held its animation merely loops; the action
    // ends only after `time_to_resist` ticks without the cursor moving, and moving
    // the cursor restarts that timer. Ending it lets the enclosing `Dragged`
    // sequence advance to `Resisting`, which is what makes the mascot struggle.
    if (this.isDraggedAction(node)) {
      if (!this.isDragging) {
        // handle_dragging(): released, so the mascot is thrown from here.
        this.setBehavior("Thrown", "drag-release");
        return;
      }
      if (Math.abs(this.cursorTickDX) >= DRAG_STILL_EPSILON) this.dragStillTicks = 0;
      else this.dragStillTicks++;
      if (this.dragStillTicks >= runtime.dragResistTicks) {
        this.emit({
          kind: "milestone",
          name: "drag-resist",
          detail: `held still for ${runtime.dragResistTicks} ticks`,
          x: this.x,
          y: this.y,
          leaf: this.leafLabel(),
        });
        this.popActionStack();
        return;
      }
    }

    // libshijima resist::tick() — the pack's `Resisting` action (Class ...Regist).
    // Moving the cursor aborts the struggle and hands the mascot back to being held;
    // if it is left alone the animation plays out and the mascot breaks free.
    // Both sides are virtual units, and the cursor is the same local (grab-offset)
    // cursor `dragged::subtick()` used — which is also why the difference grows while
    // the struggle runs: nothing writes the anchor any more, so the pointer walks away
    // from it.
    if (this.isResistAction(node) && Math.abs(this.simulationCursorVirtual().x - this.x) >= runtime.dragResistAbortPx) {
      // Handed back to being held: dragged::init() restarts its timer.
      this.dragStillTicks = 0;
      this.setBehavior("Dragged", "resist-abort");
      return;
    }

    // libshijima ticks the current action and only then advances to the next one, so
    // a frame created during this very tick must not also be advanced by it. Without
    // this guard an action whose entire animation is one tick long is entered and
    // finished inside a single pass: the packs use exactly that shape for their
    // physics launch steps (`HurledKnockback` is one pose with
    // `Velocity="50,-50" Duration="1"`, `HurlKnockback` similarly), and because
    // updatePhysics() had already run for this tick before the tree advanced, their
    // velocity was never applied — the mascot stayed glued to the floor and the whole
    // knockback/fall chain collapsed to three ticks, so "flung away" never happened.
    if (frame.bornTick === this.tickCount) return;
    const animation = this.activeAnimation(frame);
    if (animation && frame.animation !== animation) {      // libshijima get_animation() restarts the animation when the chosen variant
      // changes (`anim_idx != i` → `start_time = mascot->time`). Without that reset
      // the pose index from a longer variant survives into a shorter one and
      // `poses[index]` is undefined — the packs do have such variants (the `Pinched`
      // drag action is 1,1,1,2,1,1,1 poses), so the pose clock has to restart.
      frame.animation = animation;
      frame.poseIndex = 0;
      frame.poseTick = 0;
    }
    const poses = animation?.poses || node.poses || [];
    if (!poses.length) { this.popActionStack(); return; }
    // A Stay action reached without going through an <ActionReference> still gets
    // libshijima's default hold time instead of looping for ever, and any action
    // named in the animation configuration gets its configured duration.
    if (frame.durationLimit === null) {
      const override = MascotEngine.animationConfig.durationTicks(this.mascotName, node.name);
      if (override !== null) frame.durationLimit = override;
      else if (node.type === "Stay") frame.durationLimit = this.scaledTicks(this.varNumber(frame, "Duration") ?? runtime.stayDurationTicks);
    }
    frame.elapsed++;
    frame.poseTick++;
    if (frame.durationLimit !== null && frame.elapsed >= frame.durationLimit && !this.holdingClaim(frame)) {
      this.popActionStack();
      return;
    }
    const pose = poses[frame.poseIndex] ?? poses[0];
    if (!pose) { this.popActionStack(); return; }
    if (frame.poseTick >= Math.max(1, pose.duration)) {
      frame.poseTick = 0;
      frame.poseIndex++;
      if (frame.poseIndex >= poses.length) {
        frame.poseIndex = 0;
        // libshijima resist::tick(): once the struggle animation has played out the
        // mascot is no longer held, so it breaks free — and, being released, is
        // thrown from where it is.
        if (this.isResistAction(node)) {
          this.endDrag();
          this.emit({
            kind: "milestone",
            name: "resist-escape",
            detail: "struggle finished, mascot broke free",
            x: this.x,
            y: this.y,
            leaf: this.leafLabel(),
          });
          this.setBehavior("Thrown", "resist-escape");
          return;
        }
        // An action heading for a target, carrying an explicit Duration, or driven
        // by the physics loop keeps looping its animation. Only an action that
        // cannot continue on its own ends together with its animation.
        const endsByPhysics = this.isFallLike(node) || (this.isJumpLike(node) && this.hasTarget(frame));
        // A connected ScanMove gets its target from the interaction handle, not from
        // a pack attribute, so `hasTarget()` is false for it — yet it is exactly the
        // action that has to keep running until it reaches the partner. Ending it
        // with its (short) run animation made every walk longer than one animation
        // cycle die after ~0.6 s, i.e. a hug only ever completed when the two mascots
        // were already almost touching. libshijima's scanmove is a move action: it
        // ends on arrival, or when the interaction goes away (handled above).
        const drivenByInteraction = this.isScanMove(node) && !!frame.client?.connected;
        // The dragged action loops its animation for as long as the mascot is held;
        // only its own timer (see above) ends it.
        if (
          !node.loop &&
          !this.isDraggedAction(node) &&
          !drivenByInteraction &&
          !this.holdingClaim(frame) &&
          !this.hasTarget(frame) &&
          frame.durationLimit === null &&
          !endsByPhysics
        ) {
          // libshijima interact::tick(): a finished interaction animation hands over
          // to the behaviour named by its Behavior attribute, otherwise it ends.
          const handover = this.isInteract(node) ? this.varString(frame, "Behavior") : "";
          if (handover) {
            this.setBehavior(handover, "interact-behavior");
            return;
          }
          this.popActionStack();
        }
      }
    }
  }

  private popActionStack() {
    const frame = this.actionStack.pop();
    this.releaseFrame(frame);
    if (!this.actionStack.length) {
      // libshijima manager::_tick(): the action tree ended, so any interaction ends
      // with it and tells the partner to stop waiting.
      this.interaction.finalize();
      this.onBehaviorEnd("behavior-end");
    }
  }

  private currentPose(): Pose | undefined {
    const frame = this.actionStack[this.actionStack.length - 1];
    if (!frame) return undefined;
    const animation = this.activeAnimation(frame);
    const poses = animation?.poses || frame.node.poses || [];
    return poses[frame.poseIndex] || poses[0];
  }

  private currentLeaf() { return this.actionStack[this.actionStack.length - 1]?.node; }

  private borderTypeSatisfied(type: string | undefined) {
    const env = this.environment();
    const point = { x: this.x, y: this.y };
    if (!type) return true;
    if (type === "Floor") return env.floor.isOn(point);
    if (type === "Wall") return env.wall.isOn(point);
    if (type === "Ceiling") return env.ceiling.isOn(point);
    return false;
  }

  /** Actions that end when they touch the floor. `Thrown`/`Fall` are Sequence
   *  behaviours whose Falling child does the physics, so only the fall action
   *  itself (and the embedded Fall class) counts here. */
  private isFallLike(node: ActionNode | undefined) {
    if (!node) return false;
    return !!node.className?.endsWith(".Fall") || node.name === "Falling";
  }

  /** Actions that end when they reach their target. */
  private isJumpLike(node: ActionNode | undefined) {
    if (!node) return false;
    return !!node.className?.endsWith(".Jump") || node.name === "Jumping";
  }

  /** An action with a usable TargetX/TargetY runs until it arrives there, so its
   *  animation must be allowed to loop instead of ending the action.
   *
   *  The value is what counts, not the presence of the attribute: the packs
   *  contain a broken target expression (`Math.random*100` in ClimbAlongWall)
   *  that evaluates to NaN. Treating "attribute present" as "seeking a target"
   *  while the movement code sees no target made the action impossible to
   *  finish, which left the mascot pressed against a border for ever. */
  private hasTarget(frame: ActionFrame | undefined) {
    return this.varNumber(frame, "TargetX") !== null || this.varNumber(frame, "TargetY") !== null;
  }

  /** libshijima's action classes for the drag: `Pinched` is `...Dragged` (follows
   *  the cursor and times the struggle) and `Resisting` is `...Regist` (breaks free). */
  private isDraggedAction(node: ActionNode | undefined) {
    return !!node?.className?.endsWith(".Dragged");
  }

  private isResistAction(node: ActionNode | undefined) {
    return !!node?.className?.endsWith(".Regist");
  }

  /** `com.group_finity.mascot.action.Offset` — an instant anchor translation. */
  private isOffsetAction(node: ActionNode | undefined) {
    return !!node && (node.className?.endsWith(".Offset") === true || node.name === "Offset");
  }

  /** Affordance actions. The scan side (`ScanMove`) walks to somebody else's
   *  advertisement; the interaction side (`Interact`) runs alongside the partner. */
  private isScanMove(node: ActionNode | undefined) {
    return !!node?.className?.endsWith(".ScanMove");
  }

  private isInteract(node: ActionNode | undefined) {
    return !!node?.className?.endsWith(".Interact");
  }

  /** Actions whose mascot-level feature this port does not implement. */
  private isUnsupportedAction(node: ActionNode | undefined) {
    return !!node?.className?.endsWith(".Breed");
  }

  private actionTreeMatches(node: ActionNode, predicate: (candidate: ActionNode) => boolean, visited = new Set<ActionNode>()): boolean {
    if (visited.has(node)) return false;
    visited.add(node);
    if (predicate(node)) return true;
    if (node.type === "ActionReference" && node.referenceName) {
      const referenced = this.config?.actions[node.referenceName];
      if (referenced && this.actionTreeMatches(referenced, predicate, visited)) return true;
    }
    for (const child of node.children || []) {
      if (this.actionTreeMatches(child, predicate, visited)) return true;
    }
    return false;
  }

  /**
   * Which border a behaviour *starts* on: the first `BorderType` its action tree
   * requires, in the order libshijima evaluates them. Returns `FLEXIBLE_BORDER` when
   * an `Offset` comes first (the behaviour can begin anywhere), or `null` when the
   * behaviour needs no border at all.
   */
  private firstBorderOf(behaviorName: string): string | null {
    const cached = this.borderStartCache.get(behaviorName);
    if (cached !== undefined) return cached;
    const action = this.config?.actions[behaviorName];
    const result = action ? this.firstBorderInTree(action, new Set()) : null;
    this.borderStartCache.set(behaviorName, result);
    return result;
  }

  private firstBorderInTree(node: ActionNode, visited: Set<ActionNode>): string | null {
    if (visited.has(node)) return null;
    visited.add(node);
    const own = node.attributes?.BorderType;
    if (typeof own === "string" && own.trim() !== "") return own.trim();
    // An Offset moves the anchor before demanding anything, so a border needed after
    // it does not have to be the one the mascot is on now. This is exactly how the
    // packs leave a surface: FallFromWall / FallFromCeiling are `Offset` (1 px off)
    // followed by `Stand`, whose Floor border then fails and drops the mascot.
    if (this.isOffsetAction(node)) return FLEXIBLE_BORDER;
    if (node.type === "ActionReference" && node.referenceName) {
      const referenced = this.config?.actions[node.referenceName];
      if (referenced) {
        const found = this.firstBorderInTree(referenced, visited);
        if (found) return found;
      }
    }
    for (const child of node.children || []) {
      const found = this.firstBorderInTree(child, visited);
      if (found) return found;
    }
    return null;
  }

  /** A border the mascot is standing on right now, other than the one it just lost. */
  private currentBorderAt(lost: string | undefined): "Floor" | "Wall" | "Ceiling" | null {
    const surface = this.surfaceAt();
    const border = surface === "floor" ? "Floor" : surface === "ceiling" ? "Ceiling" : surface ? "Wall" : null;
    if (border && border !== lost) return border;
    const point = { x: this.x, y: this.y };
    const area = this.area();
    if (lost !== "Floor" && this.borderIsOn("bottom", point, area)) return "Floor";
    if (lost !== "Wall" && (this.borderIsOn("left", point, area) || this.borderIsOn("right", point, area))) return "Wall";
    if (lost !== "Ceiling" && this.borderIsOn("top", point, area)) return "Ceiling";
    return null;
  }

  /** The surface currently supporting the anchor, preserving the active side at corners. */
  private surfaceAt(point = { x: this.x, y: this.y }, area = this.area()): Surface | null {
    const floor = this.borderIsOn("bottom", point, area);
    const left = this.borderIsOn("left", point, area);
    const right = this.borderIsOn("right", point, area);
    const ceiling = this.borderIsOn("top", point, area);
    const required = this.currentLeaf()?.borderType;

    if (required === "Floor" && floor) return "floor";
    if (required === "Wall" && (left || right)) return left ? "left-wall" : "right-wall";
    if (required === "Ceiling" && ceiling) return "ceiling";

    if (this.lastSurface === "floor" && floor) return "floor";
    if (this.lastSurface === "left-wall" && left) return "left-wall";
    if (this.lastSurface === "right-wall" && right) return "right-wall";
    if (this.lastSurface === "ceiling" && ceiling) return "ceiling";

    if (floor) return "floor";
    if (left) return "left-wall";
    if (right) return "right-wall";
    if (ceiling) return "ceiling";
    return null;
  }

  /** Detach from the current surface before starting Fall; Fall tests contact first. */
  private detachAndFall(surface: Surface, reason: string) {
    const area = this.area();
    const epsilon = 2;
    if (surface === "floor" && this.y >= area.bottom) this.y = Math.max(area.top, area.bottom - epsilon);
    else if (surface === "left-wall") this.x = Math.min(area.right, area.left + epsilon);
    else if (surface === "right-wall") this.x = Math.max(area.left, area.right - epsilon);
    else if (surface === "ceiling") this.y = Math.min(area.bottom, area.top + epsilon);
    this.vx = 0;
    this.vy = 0;
    this.lastSurface = null;
    this.setBehavior("Fall", reason);
  }

  /** Consume one scroll gesture or direction change after applying its page shift. */
  private applyScrollIntent(surfaceBeforeScroll: Surface | null) {
    if (this.isDragging) return;

    if (this.scrollStopPending) {
      this.scrollStopPending = false;
      this.scrollGestureDirection = 0;
      if (this.scrollHold === "resting") {
        this.scrollHold = "none";
        if (this.currentBehavior?.name === "SitDown" && this.surfaceAt() === "floor") {
          this.setBehavior("StandUp", "scroll-stop");
        }
      }
    }

    const direction = this.scrollDirection;
    if (!this.isScrolling || direction === 0 || direction === this.scrollGestureDirection) return;
    this.scrollGestureDirection = direction;
    const surface = surfaceBeforeScroll ?? this.lastSurface ?? this.surfaceAt();
    if (direction < 0 && surface === "floor") {
      this.scrollHold = "resting";
      if (this.currentBehavior?.name !== "SitDown") this.setBehavior("SitDown", "scroll-up-sitdown");
      return;
    }
    this.scrollHold = "none";
    if (surface) this.detachAndFall(surface, direction > 0 ? "scroll-down-fall" : "scroll-up-surface-drop");
  }

  /** Can this behaviour actually move the mascot? Used to guarantee that the
   *  mascot goes somewhere after standing still for a while. */
  private canTravel(behaviorName: string): boolean {
    const structural = this.travelStructure(behaviorName);
    if (structural.moves) return true;
    if (!structural.scans) return false;
    // A ScanMove *is* a move action in libshijima (`action::scanmove : action::move`):
    // it walks to the mascot that advertised the affordance. It only walks while there
    // is somebody to walk to — with nobody in reach it pops on its first tick — so it
    // counts as "goes somewhere" exactly when the partner is reachable right now.
    // Without this, the pacer's "you have stood still long enough, go somewhere" pick
    // could never choose a hug, and the partner behaviours were diluted to a fraction
    // of the picks their weight asked for.
    return this.partnerReachable();
  }

  /** Structural part of `canTravel`: does the tree contain a Move / a ScanMove? */
  private travelStructure(behaviorName: string): { moves: boolean; scans: boolean } {
    const cached = this.travelCache.get(behaviorName);
    if (cached) return cached;
    const action = this.config?.actions[behaviorName];
    const structure = {
      moves: action ? this.actionTreeMatches(action, (node) => node.type === "Move") : false,
      scans: action ? this.actionTreeMatches(action, (node) => this.isScanMove(node)) : false,
    };
    this.travelCache.set(behaviorName, structure);
    return structure;
  }

  /** Does this behaviour only make sense with a second mascot around? */
  private needsPartnerToAct(behaviorName: string): boolean {
    const cached = this.partnerCache.get(behaviorName);
    if (cached !== undefined) return cached;
    const action = this.config?.actions[behaviorName];
    let needs = false;
    if (action) {
      needs = this.actionTreeMatches(
        action,
        (node) =>
          this.isScanMove(node) ||
          this.isInteract(node) ||
          (typeof node.attributes?.Affordance === "string" && node.attributes.Affordance !== ""),
      );
    }
    this.partnerCache.set(behaviorName, needs);
    return needs;
  }

  /**
   * Selection weight after the configuration:
   *   1. an explicit `behaviorWeights` entry for this behaviour wins;
   *   2. a partner behaviour uses `partnerWeights` (alone / with partner), so the
   *      pack's 1000–3000 weights do not turn a lone page mascot into a statue;
   *   3. otherwise the pack's own Frequency.
   */
  private effectiveWeight(behaviorName: string, packFrequency: number): number {
    const animation = MascotEngine.animationConfig;
    const override = animation.weightOverride(this.mascotName, behaviorName);
    if (override !== undefined) return override;
    if (this.needsPartnerToAct(behaviorName)) {
      // Just interacted: take partner behaviours out of the pool for a while so the
      // mascot goes and does something else instead of hugging on repeat.
      if (this.tickCount < this.interactionCooldownUntil) return 0;
      const shared = animation.partnerWeight(
        this.mascotName,
        MascotEngine.liveEngines.size > 1,
        this.partnerReachable(),
      );
      if (shared !== null) return shared;
    }
    return packFrequency;
  }

  /**
   * Is another mascot somewhere a scan could succeed right now? Mirrors the two
   * positional gates in `BroadcastManager.tryConnect`: the same surface (|Δy| ≤ 1)
   * and within the scan distance. Two mascots both walking the floor are "reachable",
   * one on the floor and one on the ceiling are not — which is what makes
   * `partnerWeights.reachable` boost exactly the hugs that can actually happen.
   */
  private partnerReachable(): boolean {
    const scan = MascotEngine.animationConfig.scanDistancePx(this.mascotName) / this.spriteScale;
    for (const other of MascotEngine.liveEngines) {
      if (other === this) continue;
      if (Math.abs(other.y - this.y) > 1) continue;
      if (Math.abs(other.x - this.x) > scan) continue;
      return true;
    }
    return false;
  }

  /** A behavior can only be offered when its action is present and this engine
   *  can actually carry it out. */
  private behaviorUsable(behavior: Behavior) {    const cached = this.behaviorUsability.get(behavior.name);
    if (cached !== undefined) return cached;
    const action = this.config?.actions[behavior.name];
    let usable = !!action;
    if (action) {
      if (this.actionTreeMatches(action, (node) => this.isUnsupportedAction(node))) usable = false;
    }
    this.behaviorUsability.set(behavior.name, usable);
    return usable;
  }

  /** Stop an action that keeps trying to move but never gets anywhere: a target
   *  it can never reach, or a border it is pressed against. */
  private guardStall(frame: ActionFrame | undefined) {
    if (!frame) return;
    if (frame.progressX === this.x && frame.progressY === this.y) {
      frame.stallTicks++;
      if (frame.stallTicks >= STALL_LIMIT_TICKS) this.popActionStack();
      return;
    }
    frame.progressX = this.x;
    frame.progressY = this.y;
    frame.stallTicks = 0;
  }

  /** Apply the configuration's duration multiplier to a pack hold time. */
  private scaledTicks(ticks: number): number {
    return Math.max(1, Math.round(ticks * MascotEngine.animationConfig.scale(this.mascotName)));
  }

  /**
   * `maxTravelPx`: pull a wander target in so the mascot stays near where it is.
   *
   * Targets that point exactly at a border are left alone — the packs use those to
   * send a mascot to a wall ("walk to the right edge, then climb"), and clamping
   * them would break the sequence that follows. Interior targets are the "wander
   * somewhere" kind, and those are what would otherwise cross the whole page.
   */
  private clampTravelTarget(resolved: Record<string, unknown>) {
    const limit = MascotEngine.animationConfig.maxTravelPx(this.mascotName) / this.spriteScale;
    if (limit <= 0) return;
    const area = this.area();
    const targetX = resolved.TargetX;
    if (typeof targetX !== "number" || !Number.isFinite(targetX)) return;
    if (targetX <= area.left + 0.5 || targetX >= area.right - 0.5) return;
    resolved.TargetX = Math.max(this.x - limit, Math.min(this.x + limit, targetX));
  }

  private updatePhysics() {
    const leaf = this.currentLeaf();
    if (!leaf) return;
    if (leaf.borderType && !this.borderTypeSatisfied(leaf.borderType)) {
      this.emit({
        kind: "milestone",
        name: "border-lost",
        detail: `BorderType=${leaf.borderType} not satisfied`,
        x: this.x,
        y: this.y,
        leaf: this.leafLabel(),
      });
      // libshijima animation::check_border_type() queues "Fall" here. That is right
      // when the mascot really left its surface, but it strands one that simply
      // moved onto a *different* border: the ceiling fallback in the packs is
      // GrabWall, which cannot hold there, so the mascot bounces between Fall and
      // GrabWall at the top for ever. If it is standing on another border, hand over
      // to a behaviour that belongs there instead (the pick below is filtered to
      // behaviours that can run on the current border).
      const here = this.currentBorderAt(leaf.borderType);
      if (here) {
        this.onBehaviorEnd(`border-change:${leaf.borderType}->${here}`);
        return;
      }
      this.setBehavior("Fall", `border-lost:${leaf.borderType}`);
      return;
    }
    const frame = this.actionStack[this.actionStack.length - 1];
    const pose = this.currentPose();
    const targetX = this.varNumber(frame, "TargetX");
    const targetY = this.varNumber(frame, "TargetY");

    // libshijima scanmove::tick(): walk to the mascot that advertised the affordance
    // this action is looking for, and hand over to the interaction on arrival.
    // scanmove delegates to move::tick(), so arrival uses the same "did this tick's
    // movement pass the target" test — a tolerance test would make an 8 px/tick run
    // overshoot and oscillate around the target for ever.
    if (this.isScanMove(leaf)) {
      const handle = frame?.client;
      if (!handle || !handle.connected) return;
      const target = handle.target;
      if (!target) return;
      const beforeX = this.x;
      if (pose && pose.velocity.x !== 0) {
        this.lookRight = pose.velocity.x > 0 ? target.x < this.x : target.x > this.x;
        this.x += (this.lookRight ? -1 : 1) * pose.velocity.x;
      }
      this.clampToWorkArea();
      const passed = (beforeX <= target.x && this.x >= target.x) || (beforeX >= target.x && this.x <= target.x);
      if (passed) {
        this.x = target.x;
        handle.notifyArrival();
        this.interaction = handle.interaction();
        const next = this.interaction.behavior;
        this.emit({
          kind: "milestone",
          name: "interaction-arrived",
          detail: `partner=(${this.toPage(target.x).toFixed(1)},${this.toPage(target.y).toFixed(1)}) behavior=${next || "-"}`,
          behavior: next || undefined,
          target: [this.toPage(target.x), this.toPage(target.y)],
          x: this.x,
          y: this.y,
          leaf: this.leafLabel(),
        });
        this.setBehavior(next || "StandUp", "interaction-client");
        return;
      }
      this.guardStall(frame);
      return;
    }

    if (this.isFallLike(leaf)) {
      // libshijima fall::subtick() tests the landing *before* applying gravity and
      // velocity, and only then moves. The order matters: testing afterwards lets
      // one gravity step push the anchor off the edge it is sitting on, and the
      // 1 px tolerance then rejects it. That asymmetry is why a right wall seemed
      // to cling (a rightward throw is clamped back onto it) while the left wall and
      // the ceiling did not.
      const environment = this.environment();
      const point = { x: this.x, y: this.y };
      const onFloor = environment.floor.isOn(point);
      const onCeiling = environment.ceiling.isOn(point);
      const onWall = environment.wall.isOn(point);
      const landingOnCeiling = onCeiling && this.currentBehavior?.name !== "Fall";
      const onEdge = onFloor || onWall || landingOnCeiling;
      if (onEdge) {
        this.vx = this.vy = 0;
        if (onFloor) this.y = this.area().bottom;
        this.emit({
          kind: "milestone",
          name: "land",
          detail: `fall ended at ${onFloor ? "floor" : landingOnCeiling ? "ceiling" : "wall"}`,
          x: this.x,
          y: this.y,
          leaf: this.leafLabel(),
        });
        this.popActionStack();
        return;
      }
      const resistanceX = this.evaluateNumber(leaf.attributes?.RegistanceX, frame) ?? runtime.resistanceX;
      const resistanceY = this.evaluateNumber(leaf.attributes?.RegistanceY, frame) ?? runtime.resistanceY;
      const gravity = this.evaluateNumber(leaf.attributes?.Gravity, frame) ?? runtime.gravity;
      this.vx -= this.vx * resistanceX;
      this.vy += gravity - this.vy * resistanceY;
      this.x += this.vx;
      this.y += this.vy;
      this.clampToWorkArea();
      return;
    }
    if (this.isJumpLike(leaf) && targetX !== null && targetY !== null) {
      const dx = targetX - this.x;
      const dy = targetY - this.y - Math.abs(dx);
      const distance = Math.hypot(dx, dy);
      const speed = this.evaluateNumber(leaf.attributes?.VelocityParam, frame) ?? 20;
      this.lookRight = dx > 0;
      if (distance <= speed) {
        this.x = targetX;
        this.y = targetY;
        this.emit({
          kind: "milestone",
          name: "jump-arrived",
          detail: `target=(${this.toPage(targetX).toFixed(1)},${this.toPage(targetY).toFixed(1)})`,
          x: this.x,
          y: this.y,
          leaf: this.leafLabel(),
        });
        this.popActionStack();
        return;
      }
      this.x += speed * dx / distance;
      this.y += speed * dy / distance;
      this.guardStall(frame);
      return;
    }

    // A pose velocity translates the anchor whatever the action's Type is: the
    // packs use Type="Embedded" (ScanMove / WalkWithIE) for actions that really
    // do move, so movement cannot be decided by Type alone.
    const translates = !!pose && (pose.velocity.x !== 0 || pose.velocity.y !== 0);
    const moves = !!pose && (leaf.type === "Move" || leaf.type === "Animate" || translates);
    if (moves) {
      const beforeX = this.x;
      const beforeY = this.y;
      if (targetX !== null) {
        if (pose.velocity.x > 0) this.lookRight = targetX < this.x;
        else if (pose.velocity.x < 0) this.lookRight = targetX > this.x;
      }
      // libshijima move::tick() also faces a vertically-moving mascot away from the
      // wall it is on. That is not cosmetic: the packs gate their wall behaviours on
      // `lookRight ? rightBorder : leftBorder`, so a mascot clinging to the left wall
      // while facing right loses ClimbHalfwayAlongWall/ClimbAlongWall entirely.
      if (targetY !== null) {
        if (this.borderIsOn("left", { x: this.x, y: this.y })) this.lookRight = false;
        if (this.borderIsOn("right", { x: this.x, y: this.y })) this.lookRight = true;
      }
      this.x += (this.lookRight ? -1 : 1) * pose.velocity.x;
      this.y += pose.velocity.y;
      if (targetX !== null && ((beforeX <= targetX && this.x >= targetX) || (beforeX >= targetX && this.x <= targetX))) {
        this.x = targetX;
        this.emit({
          kind: "milestone",
          name: "target-x",
          detail: `TargetX=${this.toPage(targetX).toFixed(1)}`,
          x: this.x,
          y: this.y,
          leaf: this.leafLabel(),
        });
        this.popActionStack();
        return;
      }
      if (targetY !== null && ((beforeY <= targetY && this.y >= targetY) || (beforeY >= targetY && this.y <= targetY))) {
        this.y = targetY;
        this.emit({
          kind: "milestone",
          name: "target-y",
          detail: `TargetY=${this.toPage(targetY).toFixed(1)}`,
          x: this.x,
          y: this.y,
          leaf: this.leafLabel(),
        });
        this.popActionStack();
        return;
      }
    }
    this.clampToWorkArea();
    // A mascot clinging to a *wall* faces away from it, for every running action —
    // the guard is the action's own BorderType, so a floor/ceiling pose keeps
    // whatever facing its behaviour chose, and `Fall`/`Dragged` (no BorderType) are
    // left to the drag and throw code, which sets `lookRight` per tick itself.
    //
    // Why it cannot live in the moving branch above: the packs' wall *holds* are
    // `Stay` actions — `HoldOntoWall` is `GrabWall`, Type="Stay" BorderType="Wall" —
    // so they never reach it. Their pose carries no LookRight, so they used to
    // inherit whatever the previous behaviour left behind, and the pack flips that
    // value on the way in: `JumpFromRightWall` / `JumpFromLeftWall` end with a
    // `Look`, which toggles when it has no `LookRight` attribute (libshijima's
    // look::tick()). So a mascot that climbed the right wall, jumped and settled back
    // onto the wall held its pose mirrored. Climbing itself looked right only because
    // `ClimbWall` is Type="Move" and already re-normalised every tick.
    const clinging = this.currentLeaf();
    if (clinging?.borderType === "Wall") {
      if (this.borderIsOn("left", { x: this.x, y: this.y })) this.lookRight = false;
      if (this.borderIsOn("right", { x: this.x, y: this.y })) this.lookRight = true;
    }
    // Guard every action that is supposed to travel, not just target-seekers: a
    // mascot pushed into a border by a pose velocity is stuck just as badly.
    if (targetX !== null || targetY !== null || translates || leaf.type === "Move") this.guardStall(frame);
  }

  /** Clamp the viewport-space anchor into its work area. */
  private clampToWorkArea() {
    const area = this.area();
    const wasX = this.x;
    const wasY = this.y;
    this.x = Math.max(area.left, Math.min(area.right, this.x));

    this.y = Math.max(area.top, Math.min(area.bottom, this.y));

    const moved = Math.abs(this.x - wasX) + Math.abs(this.y - wasY);
    if (moved > 0.5 && !this.clampReported) {
      this.clampReported = true;
      this.emit({
        kind: "milestone",
        name: "clamp",
        detail: `(${this.toPage(wasX).toFixed(1)},${this.toPage(wasY).toFixed(1)}) -> (${this.toPage(this.x).toFixed(1)},${this.toPage(this.y).toFixed(1)})`,
        x: this.x,
        y: this.y,
        leaf: this.leafLabel(),
      });
    }
  }

  private onBehaviorEnd(reason = "behavior-end") {
    if (!this.config) return;
    if (this.scrollHold === "resting" && this.isScrolling && this.scrollDirection < 0 && this.surfaceAt() === "floor") {
      this.setBehavior("SitDown", "scroll-up-hold");
      return;
    }
    const animation = MascotEngine.animationConfig;
    const mascot = this.mascotName;
    const candidates: BehaviorReference[] = [];
    const next = this.currentBehavior?.nextBehaviors || [];
    // A listed behaviour ignores its `<NextBehaviorList>` and re-enters the global
    // pool. The shipped packs chain related behaviours, and some of those chains are
    // closed: SitAndFaceMouse lists only itself and SitWhileDanglingLegs with
    // Add="false", so a mascot that sits down can never leave that pair by itself.
    const forcePool = animation.exitsToPool(mascot, this.currentBehavior?.name);
    for (const reference of forcePool ? [] : next) {
      if (!this.evaluateCondition(reference.condition)) continue;
      if (!animation.allows(mascot, reference.name)) continue;
      const behavior = this.config.behaviors.find((entry) => entry.name === reference.name);
      if (behavior && !this.behaviorUsable(behavior)) continue;
      const frequency = this.effectiveWeight(reference.name, reference.frequency);
      // A weight of 0 means "not now" (a cooldown, or an explicit 0 override), and the
      // <NextBehavior> pass used to add it anyway.
      if (frequency <= 0) continue;
      candidates.push({ ...reference, frequency });
    }
    if (!candidates.length || this.currentBehavior?.addNext !== false) {
      for (const behavior of this.config.behaviors) {
        // Hidden is not the same as unavailable: the packs mark the wall, ceiling
        // and work-area behaviours Hidden and they still have to be selectable,
        // otherwise a mascot that reaches a wall or the ceiling can never leave it.
        const override = animation.weightOverride(mascot, behavior.name);
        // Without an override the pack's own rule applies (Frequency > 0). An
        // override may also switch a Frequency="0" behaviour on, or one off.
        if (override !== undefined ? override <= 0 : behavior.frequency <= 0) continue;
        if (!animation.allows(mascot, behavior.name)) continue;
        if (!this.evaluateCondition(behavior.condition) || !this.behaviorUsable(behavior)) continue;
        const frequency = this.effectiveWeight(behavior.name, behavior.frequency);
        if (frequency <= 0) continue;
        candidates.push({ name: behavior.name, id: behavior.id, frequency });
      }
    }
    if (!candidates.length) {
      // Everything was filtered out by the configuration; fall back to the pack's
      // own list so a restrictive config cannot leave the mascot frozen.
      const idle = this.config.behaviors.find((entry) => entry.name === "StandUp") ?? this.config.behaviors[0];
      if (idle) this.setBehavior(idle.name, "no-candidates");
      return;
    }
    // The mascot has not moved for a while, so this pick has to be one that goes
    // somewhere. Restricting the pool (instead of switching every tick) is what
    // keeps the page lively without the mascot looking like it is glitching.
    let pool = candidates;
    if (this.wantMovement) {
      this.wantMovement = false;
      const travel = candidates.filter((candidate) => this.canTravel(candidate.name));
      if (travel.length > 0) pool = travel;
    }
    // Only offer behaviours that can actually run where the mascot is standing.
    // libshijima has no such filter, so while a mascot is on a wall or the ceiling it
    // keeps drawing floor behaviours (and, on a two-mascot page, the heavily weighted
    // partner behaviours), each of which fails its BorderType check on the first
    // tick. That churn is what made a mascot sit on the ceiling for minutes: the one
    // behaviour that brings it down, `FallFromCeiling` (weight 50 against a ceiling
    // pool of ~250), became a ~1% draw. Behaviours with no border requirement, and
    // those that move the mascot first (`Offset`), stay available.
    const standingOn = this.currentBorderAt(undefined);
    if (standingOn) {
      const runnable = pool.filter((candidate) => {
        const start = this.firstBorderOf(candidate.name);
        return start === null || start === FLEXIBLE_BORDER || start === standingOn;
      });
      if (runnable.length > 0) pool = runnable;
    }
    const total = pool.reduce((sum, candidate) => sum + Math.max(0, candidate.frequency), 0);
    if (total <= 0) { this.setBehavior(pool[0].name, reason, pool[0].id); return; }
    let random = Math.random() * total;
    for (const candidate of pool) {
      random -= candidate.frequency;
      if (random <= 0) { this.setBehavior(candidate.name, reason, candidate.id); return; }
    }
    this.setBehavior(candidates[0].name, reason, candidates[0].id);
  }

  private render(interpolate = true) {
    const pose = this.currentPose();
    if (!pose) return;
    // libshijima runs one 40 ms logic tick but advances and repaints the anchor
    // kSubtickCount (= 4) times per tick, which is why its motion is smooth.
    // Interpolating the paint between ticks reproduces that here; without it the
    // mascot moves one whole tick of travel at a time and a fall reads as a jump.
    const progress = interpolate ? Math.max(0, Math.min(1, this.accumulator / runtime.tickMs)) : 1;
    const x = this.prevX + (this.x - this.prevX) * progress;
    const y = this.prevY + (this.y - this.prevY) * progress;
    // Boundary one: virtual viewport units → screen pixels.
    const scale = this.spriteScale;
    this.elRoot.style.transform = `translate3d(${x * scale}px, ${y * scale}px, 0)`;
    // A pose may legitimately carry no Image at all: the packs use that for the
    // interaction hold frames (`HuggedAction` is `<Pose Velocity="0,0" Duration="93"/>`,
    // `HurledAction` the same with 128). A normal image-less delay keeps its frame;
    // an image-less Interact hold intentionally stays hidden after clearing its
    // standalone frame above.
    if (!pose.image) {
      if (this.interactionVisualActive) {
        this.elImg.style.visibility = "hidden";
        this.elImg.removeAttribute("src");
      }
      return;
    }
    const src = this.spriteUrl(pose.image);
    if (this.elImg.getAttribute("src") !== src) {
      // Keep the previous decoded frame visible until the replacement is ready.
      // Hiding/clearing here makes normal 4-10 frame animations flash on every pose.
      this.elImg.src = src;
    }
    if (this.elImg.complete && this.elImg.naturalWidth > 0) this.elImg.style.visibility = "visible";
    // A cached bitmap already reports its size, so the box is correct on the
    // very first painted frame; the `load` listener covers a cold cache.
    if (this.elImg.naturalWidth > 0) this.applySpriteIntrinsicSize();
    // Draw the sprite `scale`x larger with its pose ImageAnchor on the root origin,
    // mirrored in place when facing right. Written against `transform-origin: 0 0`
    // so mirroring and sizing combine in one matrix: a bitmap point p lands at
    // (tx + sx*p.x, ty + sy*p.y), and the anchor (ax, ay) must land on (0, 0) —
    // hence tx = -flip*ax*scale with sx = flip*scale.
    //
    // An image-less pose parses as `imageAnchor: {x: 0, y: 0}`, so applying it here
    // would translate the *kept* frame by the whole ImageAnchor (64,128) — the sprite
    // visibly jumps down-right and reads as a second mascot at the floor for as long
    // as the hold lasts. libshijima leaves the transform alone in this case, and so
    // does this now (the non-image fields of the pose still apply above).
    const ax = pose.imageAnchor.x;
    const ay = pose.imageAnchor.y;
    const flip = this.lookRight ? -1 : 1;
    this.elImg.style.transform = `translate(${-flip * ax * scale}px, ${-ay * scale}px) scaleX(${flip * scale}) scaleY(${scale})`;
    this.elImg.style.transformOrigin = "0 0";
  }
}
