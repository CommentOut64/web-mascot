import { XMLParser } from "./XMLParser";
import { AnimationConfig } from "./AnimationConfig";
import { BroadcastManager, ClientHandle, Interaction, ServerState } from "./Broadcast";
import { hotspotAt } from "./Hotspot";
import type { Hotspot } from "./Hotspot";
import type { ActionNode, AnimationVariant, Behavior, BehaviorReference, MascotConfig, Pose } from "./types";

const GRAVITY = 2;
const TICK_MS = 40;
const DEFAULT_RESISTANCE_X = 0.05;
const DEFAULT_RESISTANCE_Y = 0.1;
/** libshijima's stay::tick() ends at elapsed() >= Duration, default 250. */
const DEFAULT_STAY_DURATION = 250;
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
const DRAG_RESIST_TICKS = 250;
/** dragged::subtick() resets that timer once the cursor moves 5/subtick_count px. */
const DRAG_STILL_EPSILON = 1.25;
/** resist::tick(): this much cursor movement aborts the struggle. */
const DRAG_RESIST_ABORT_PX = 5;
/** dragged::subtick() offsets: the anchor is placed this far from the cursor
 *  (OffsetX/OffsetY, read from the action when the pack defines them). */
const DRAG_OFFSET_X = 0;
const DRAG_OFFSET_Y = 120;
/** libshijima's `mascot::tick::reached_init_limit()`: a behaviour chain that keeps
 *  ending instantly must not loop for ever inside a single tick. */
const MAX_BEHAVIOR_INITS_PER_TICK = 20;
/** A single-tick anchor movement larger than this is reported as a jump suspect. */
const SUSPECT_STEP_PX = 24;
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
  | { kind: "milestone"; name: string; detail: string; x: number; y: number; leaf: string }
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
  /** Affordance registry, shared by every mascot in the page (broadcast/manager). */
  private static broadcasts = new BroadcastManager();
  /** Kept so the reduced-motion listener is only installed once. */
  private static reducedMotionWatcher: (() => void) | null = null;
  /** Default location of the editable configuration file. */
  public static readonly ANIMATION_CONFIG_URL = "/animation.config.json";

  /** Stable per-session identity, used to name this mascot's log file. */
  public readonly id: number;
  public readonly label: string;

  private container: HTMLElement;
  private mascotName: string;
  private config: MascotConfig | null = null;
  private elRoot: HTMLDivElement;
  private elImg: HTMLImageElement;
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
  private lastScrollY = 0;
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
  /** Change detection for the observation stream. */
  private observedPath = "";
  private observedImage = "";
  private clampReported = false;
  private eventsAbortController = new AbortController();
  private resizeTimer = 0;
  private isScrolling = false;
  private scrollDebounceTimer = 0;
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
  /** Affordance state (see Broadcast.ts). Advertisements and scan links belong to
   *  the action instance and live on its frame; the handshake belongs to the
   *  mascot, because its behaviour is what the partner is waiting on. */
  private interaction = new Interaction();
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

  /**
   * Install a configuration from an object in the same shape as the JSON file.
   * This is the entry point a settings UI would use; it wins over the file until
   * `loadAnimationConfig()` is called again with `force`.
   */
  public static setAnimationConfig(file: unknown, source = "(programmatic)"): AnimationConfig {
    MascotEngine.animationConfig = new AnimationConfig(file, source);
    MascotEngine.animationConfigSetExplicitly = true;
    return MascotEngine.animationConfig;
  }

  /**
   * Read the configuration file once and keep it. Missing or invalid files leave
   * the mascots on the pack's own settings, so this never breaks the app.
   */
  public static loadAnimationConfig(url = MascotEngine.ANIMATION_CONFIG_URL): Promise<void> {
    if (MascotEngine.animationConfigLoad) return MascotEngine.animationConfigLoad;
    MascotEngine.animationConfigLoad = (async () => {
      try {
        const controller = new AbortController();
        const timer = window.setTimeout(() => controller.abort(), 3000);
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        window.clearTimeout(timer);
        const contentType = response.headers.get("content-type") ?? "";
        if (!response.ok || !contentType.includes("json")) return;
        const file: unknown = await response.json();
        if (!MascotEngine.animationConfigSetExplicitly) {
          MascotEngine.animationConfig = new AnimationConfig(file, url);
        }
      } catch {
        /* no configuration file, or it is unreachable: keep the pack defaults */
      }
      MascotEngine.watchReducedMotion();
    })();
    return MascotEngine.animationConfigLoad;
  }

  /** Follow the OS reduced-motion preference, now and on later changes. */
  private static watchReducedMotion() {
    MascotEngine.animationConfig.refreshReducedMotion();
    if (MascotEngine.reducedMotionWatcher) return;
    if (typeof window.matchMedia !== "function") return;
    try {
      const query = window.matchMedia("(prefers-reduced-motion: reduce)");
      const listener = () => MascotEngine.animationConfig.setReducedMotion(query.matches);
      query.addEventListener("change", listener);
      MascotEngine.reducedMotionWatcher = listener;
    } catch {
      /* the preference is still read once by refreshReducedMotion() */
    }
  }

  /** Re-read the file, discarding both the cache and any programmatic override. */
  public static async reloadAnimationConfig(url = MascotEngine.ANIMATION_CONFIG_URL): Promise<AnimationConfig> {
    MascotEngine.animationConfigLoad = null;
    MascotEngine.animationConfigSetExplicitly = false;
    await MascotEngine.loadAnimationConfig(url);
    return MascotEngine.animationConfig;
  }

  constructor(container: HTMLElement, mascotName: string) {
    this.container = container;
    this.mascotName = mascotName;
    this.id = MascotEngine.nextId++;
    this.label = `${this.id}-${mascotName}`;
    this.elRoot = document.createElement("div");
    Object.assign(this.elRoot.style, {
      position: "fixed", left: "0px", top: "0px", pointerEvents: "auto",
      cursor: "grab", zIndex: "99999", userSelect: "none",
    });
    this.elImg = document.createElement("img");
    this.elImg.style.position = "absolute";
    this.elImg.ondragstart = () => false;
    this.elRoot.appendChild(this.elImg);
    this.bindEvents();
  }

  public async init() {
    // Customisation is read first so the very first tick already obeys it.
    await MascotEngine.loadAnimationConfig();
    this.config = await XMLParser.loadConfig(this.mascotName);
    this.applySpawnPosition();
    this.prevX = this.x;
    this.prevY = this.y;
    this.lastScrollY = window.scrollY;
    MascotEngine.liveEngines.add(this);
    this.container.appendChild(this.elRoot);
    this.watchVisibility();
    // Warm the sprite cache before the first frames: assigning a fresh `src` to the
    // visible <img> shows an empty/broken image until the file arrives, which reads
    // as a flicker on every pose change.
    this.preloadSprites();
    await this.warmFirstPose();
    this.emit({ kind: "spawn", detail: `viewport=${window.innerWidth}x${window.innerHeight}` });    this.setBehavior("Fall", "spawn");
    this.lastTime = performance.now();
    this.loopId = requestAnimationFrame((t) => this.loop(t));
  }

  /** URL of a pack sprite. */
  private spriteUrl(image: string): string {
    return `/mascot_pack/${this.mascotName}/img${image}`;
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
    const collect = (node: ActionNode) => {
      for (const pose of node.poses ?? []) urls.add(this.spriteUrl(pose.image));
      for (const animation of node.animations ?? []) {
        for (const pose of animation.poses) urls.add(this.spriteUrl(pose.image));
      }
      for (const child of node.children ?? []) collect(child);
    };
    for (const node of Object.values(actions)) collect(node);
    for (const url of urls) {
      if (MascotEngine.preloaded.has(url)) continue;
      MascotEngine.preloaded.add(url);
      const image = new Image();
      image.decoding = "async";
      image.src = url;
    }
  }

  /** Decode the pose that will be painted first, so even the spawn has no gap.
   *  Bounded by a timeout: a slow network must never delay the mascot. */
  private async warmFirstPose(): Promise<void> {
    const pose = this.currentPose() ?? this.firstPose();
    if (!pose) return;
    const image = new Image();
    image.src = this.spriteUrl(pose.image);
    const decode = typeof image.decode === "function" ? image.decode().catch(() => undefined) : Promise.resolve();
    await Promise.race([decode, new Promise((resolve) => window.setTimeout(resolve, 1500))]);
  }

  /** The first pose of the action a fresh mascot starts with (Fall/Bouncing). */
  private firstPose(): Pose | undefined {
    const node = this.config?.actions["Fall"];
    const fromAnimations = node?.animations?.[0]?.poses?.[0];
    return fromAnimations ?? node?.poses?.[0];
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

  private setVisible(visible: boolean) {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible) {
      if (!document.hidden) this.resumeLoop();
      return;
    }
    cancelAnimationFrame(this.loopId);
    this.emit({ kind: "milestone", name: "paused", detail: "container left the viewport", x: this.x, y: this.y, leaf: this.leafLabel() });
    // Defence in depth: a wrong or stale observation must never freeze the mascot
    // for good, so re-check the geometry shortly afterwards.
    window.setTimeout(() => {
      if (!this.visible && this.isOnScreen()) this.setVisible(true);
    }, 2000);
  }

  private isOnScreen() {
    const rect = (this.container ?? this.elRoot).getBoundingClientRect();
    return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
  }

  private resumeLoop() {
    cancelAnimationFrame(this.loopId);
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.loopId = requestAnimationFrame((t) => this.loop(t));
  }

  public destroy() {
    cancelAnimationFrame(this.loopId);
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;
    this.eventsAbortController.abort();
    window.clearTimeout(this.resizeTimer);
    window.clearTimeout(this.scrollDebounceTimer);
    this.emit({ kind: "despawn", detail: "destroy()" });
    MascotEngine.liveEngines.delete(this);
    if (this.elRoot.parentNode) this.elRoot.parentNode.removeChild(this.elRoot);
  }

  /** Current observable state, for timers and for poking at the mascot in the
   *  browser console: `__mascotEngines[0].snapshot()`. */
  /** Where the mascot is drawn, in page pixels. The engine's own coordinates are
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

  /** Convert a virtual length or coordinate to page pixels (the log's unit). */
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
    const cursor = this.toVirtual(clientX, clientY);
    const width = this.elImg.naturalWidth || SPRITE_WIDTH;
    const left = this.lookRight ? this.x - (width - pose.imageAnchor.x) : this.x - pose.imageAnchor.x;
    const top = this.y - pose.imageAnchor.y;
    return { x: cursor.x - left, y: cursor.y - top };
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
      // libshijima animation::handle_dragging(): a press inside a hotspot runs that
      // behaviour and does *not* pick the mascot up. Clicking a mascot's head is how
      // the packs trigger their Blush behaviours, which nothing else can reach.
      const hotspot = this.hotspotUnderCursor(e.clientX, e.clientY);
      if (hotspot) {
        this.emit({
          kind: "milestone",
          name: "hotspot",
          detail: `behavior=${hotspot.behavior} shape=${hotspot.shape} local=${this.spritePoint(e.clientX, e.clientY)?.x.toFixed(0)},${this.spritePoint(e.clientX, e.clientY)?.y.toFixed(0)}(sprite px)`,
          x: this.x,
          y: this.y,
          leaf: this.leafLabel(),
        });
        this.setBehavior(hotspot.behavior, "hotspot");
        this.elRoot.style.cursor = "grab";
        return;
      }
      this.isDragging = true;
      this.elRoot.style.cursor = "grabbing";
      // dragged::init(ctx): foot_x = cursor.x + OffsetX, and the struggle timer.
      // The anchor itself is placed by the tick, not here (dragged::subtick).
      this.cursorX = e.clientX;
      this.cursorY = e.clientY;
      this.footX = e.clientX / this.spriteScale;
      this.footDX = 0;
      this.dragStillTicks = 0;
      this.vx = this.vy = 0;
      // libshijima animation::handle_dragging(): picking a mascot up ends any
      // interaction it is in.
      this.interaction.finalize();
      this.setBehavior("Dragged", "drag-start");
    }, { signal });

    window.addEventListener("mousemove", (e) => {
      this.cursorX = e.clientX;
      this.cursorY = e.clientY;
      // While the mascot is held there is nothing to do here: libshijima's
      // dragged::subtick() moves the anchor from the cursor once per tick, and the
      // render loop paints it.
      if (this.isDragging) return;
      // libshijima's UI asks for the hotspot under the cursor to give feedback.
      this.elRoot.style.cursor = this.hotspotUnderCursor(e.clientX, e.clientY) ? "pointer" : "grab";
    }, { signal });

    window.addEventListener("mouseup", () => {
      if (!this.isDragging) return;
      this.isDragging = false;
      this.elRoot.style.cursor = "grab";
      this.setBehavior("Thrown", "drag-release");
    }, { signal });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        if (this.isDragging) {
          this.isDragging = false;
          this.elRoot.style.cursor = "grab";
          this.setBehavior("Thrown", "drag-release");
        }
        window.clearTimeout(this.scrollDebounceTimer);
        this.isScrolling = false;
        cancelAnimationFrame(this.loopId);
        this.emit({
          kind: "milestone",
          name: "paused",
          detail: "tab hidden",
          x: this.x,
          y: this.y,
          leaf: this.leafLabel(),
        });
      } else {
        this.lastScrollY = window.scrollY;
        if (this.visible) {
          this.emit({
            kind: "milestone",
            name: "resumed",
            detail: "tab visible",
            x: this.x,
            y: this.y,
            leaf: this.leafLabel(),
          });
          this.resumeLoop();
        }
      }
    }, { signal });

    window.addEventListener("resize", () => {
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => {
        const borderBefore = this.currentBorderAt(undefined);
        
        this.partnerCache.clear();
        this.travelCache.clear();
        this.borderStartCache.clear();
        this.behaviorUsability.clear();
        
        this.clampToWorkArea();
        
        const area = this.area();
        for (const frame of this.actionStack) {
          if (frame.resolved) {
            if (typeof frame.resolved.TargetX === "number") {
               frame.resolved.TargetX = Math.max(area.left, Math.min(area.right, frame.resolved.TargetX));
            }
            if (typeof frame.resolved.TargetY === "number") {
               frame.resolved.TargetY = Math.max(area.top, Math.min(area.bottom, frame.resolved.TargetY));
            }
          }
        }

        const borderAfter = this.currentBorderAt(undefined);
        if (borderBefore && !borderAfter && !/Jump|Fall|Thrown|Dragged/i.test(this.currentBehavior?.name || "")) {
           this.setBehavior("Fall", "resize-border-lost");
        }
      }, 200);
    }, { signal });

    window.addEventListener("scroll", () => {
      const delta = (window.scrollY - this.lastScrollY) / this.spriteScale;
      this.lastScrollY = window.scrollY;
      
      if (this.isDragging || delta === 0) return;
      this.isScrolling = true;

      const borderBefore = this.currentBorderAt(undefined);

      this.y -= delta;
      
      const area = this.area();
      let targetOutOfBounds = false;
      for (const frame of this.actionStack) {
        if (frame.resolved && typeof frame.resolved.TargetY === "number") {
          frame.resolved.TargetY -= delta;
          if (frame.resolved.TargetY < area.top || frame.resolved.TargetY > area.bottom) {
             targetOutOfBounds = true;
          }
        }
      }
      this.clampToWorkArea();
      
      const isAtCeiling = this.y <= area.top + 1;
      const isAtFloor = this.y >= area.bottom - 1;

      // 1. 若原本在天花板上：页面滚动无论上下，立即脱离天花板下落
      if (borderBefore === "Ceiling") {
        this.y = area.top + 2;
        if (this.currentBehavior?.name !== "Fall") {
          this.setBehavior("Fall", "scroll-ceiling-drop");
        }
      }
      // 2. 向上滚动（delta < 0）：宠物被推向地面
      else if (delta < 0) {
        if (isAtFloor) {
          // 只要处于或接触地面，必定进入/保持趴地状态（无论此前是地面动作还是下落/落地弹跳）
          if (this.currentBehavior?.name !== "LieDown") {
            this.setBehavior("LieDown", "scroll-up-liedown");
          }
        } else if (borderBefore === "Wall") {
          if (this.x <= area.left + 1) this.x += 2;
          else if (this.x >= area.right - 1) this.x -= 2;
          if (this.currentBehavior?.name !== "Fall") {
            this.setBehavior("Fall", "scroll-hit-floor");
          }
        }
      }
      // 3. 向下滚动（delta > 0）：宠物被推向顶部或脱离地面
      else if (delta > 0) {
        if (borderBefore === "Wall") {
          if (isAtCeiling) {
            if (this.x <= area.left + 1) this.x += 2;
            else if (this.x >= area.right - 1) this.x -= 2;
            this.y = area.top + 2;
            if (this.currentBehavior?.name !== "Fall") this.setBehavior("Fall", "scroll-hit-ceiling");
          }
        } else if (targetOutOfBounds) {
          if (this.currentBehavior?.name !== "Fall") {
            if (this.x <= area.left + 1) this.x += 2;
            else if (this.x >= area.right - 1) this.x -= 2;
            this.setBehavior("Fall", "scroll-target-lost");
          }
        } else if (this.currentBehavior?.name === "Fall") {
          // 下落中接触顶部：保持下落状态，消除向上动量
          if (isAtCeiling) {
            this.vy = 0;
          }
        } else {
          // 在地面时向下滚动：脱离地面掉落
          if (isAtCeiling) {
            this.y = area.top + 2;
          }
          if (this.currentBehavior?.name !== "Fall") {
            this.setBehavior("Fall", "scroll-down-fall");
          }
        }
      }

      // 滚动停止后恢复
      window.clearTimeout(this.scrollDebounceTimer);
      this.scrollDebounceTimer = window.setTimeout(() => {
        this.isScrolling = false;
        if (!this.isDragging && this.currentBehavior?.name === "LieDown") {
          this.setBehavior("StandUp", "scroll-stop");
        }
      }, 250);

    }, { signal });
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

  /** `environment.cursor` for the pack expressions: position and per-tick delta,
   *  both in virtual units. */
  private cursorInVirtualUnits(): { x: number; y: number; dx: number; dy: number } {
    const cursor = this.toVirtual(this.cursorX, this.cursorY);
    return { x: cursor.x, y: cursor.y, dx: this.cursorTickDX, dy: this.cursorTickDY };
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

  /** The mascot's activity rectangle: `zone` from the configuration, defaulting to
   *  the whole viewport. Floor, ceiling, walls and every clamp follow it, so a host
   *  page can keep the mascot inside a strip instead of over its content. */
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

  private borderIsOn(side: "top" | "right" | "bottom" | "left", point: { x: number; y: number }, area = this.area()) {
    const tolerance = 1;
    if (side === "top" || side === "bottom") {
      const y = side === "top" ? area.top : area.bottom;
      return Math.abs(point.y - y) < tolerance && point.x >= area.left && point.x <= area.right;
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
    return Function(...Object.keys(scope), `return (${this.cleanExpression(expression)})`)(...Object.values(scope));
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
    return this.mascotScope(this.frameVars(frame));
  }

  private cleanExpression(expression: string) {
    return expression.replace(/^\$\{|^#\{|\}$/g, "").trim();
  }

  private evaluate(expression: string | undefined, frame?: ActionFrame): unknown {
    if (!expression) return undefined;
    try {
      return this.run(expression, this.context(frame));
    } catch {
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
      const scan = MascotEngine.broadcasts.probe(affordance.trim(), { x: this.x, y: this.y });
      frame.client = MascotEngine.broadcasts.tryConnect(
        affordance.trim(),
        { x: this.x, y: this.y },
        this.varString(frame, "Behavior"),
        this.varString(frame, "TargetBehavior"),
        MascotEngine.animationConfig.scanDistancePx(this.mascotName),
      );
      this.emit({
        kind: "milestone",
        name: frame.client ? "broadcast-connect" : "broadcast-scan",
        detail: `affordance=${affordance} live=${scan.live} nearest=${scan.nearest === null ? "-" : this.toPage(scan.nearest).toFixed(0)}px found=${!!frame.client}`,
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

  private setBehavior(name: string, reason = "engine") {
    if (!this.config) return;
    if (this.behaviorInitsThisTick >= MAX_BEHAVIOR_INITS_PER_TICK) {
      if (name === "StandUp") return;
      name = "StandUp";
      reason = "init-limit";
    }
    this.behaviorInitsThisTick++;
    const behavior =
      this.config.behaviors.find((entry) => entry.name === name) ||
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
    if (!action) { this.currentBehavior = selected; this.onBehaviorEnd(reason); return; }
    // libshijima activate_queued_behavior(): running the behaviour a live handshake
    // asked for marks that handshake as started.
    if (this.interaction.available && !this.interaction.started && this.interaction.behavior === selected.name) {
      this.interaction.started = true;
    }
    // Frames that are being replaced stop advertising and let go of scan targets.
    this.releaseStack();
    this.currentBehavior = selected;
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
    // Clamp only: a pause is already explained by the visibility markers the
    // recorder writes, so there is nothing else to do about the background case.
    this.accumulator += Math.min(timestamp - this.lastTime, MAX_FRAME_DELTA_MS);
    this.lastTime = timestamp;
    // A mascot is decoration: one bad tick must not kill the animation loop and
    // leave it frozen for ever. Swallow the error, report it, and keep going.
    try {
      while (this.accumulator >= TICK_MS) { this.tick(); this.accumulator -= TICK_MS; }
      this.render();
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
    this.loopId = requestAnimationFrame((t) => this.loop(t));
  }

  private tick() {
    if (!this.config || !this.actionStack.length) return;
    const beforeX = this.x;
    const beforeY = this.y;
    this.prevX = this.x;
    this.prevY = this.y;
    this.tickCount++;
    this.behaviorInitsThisTick = 0;
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
      // libshijima dragged::subtick(): the anchor is placed at the cursor plus the
      // action's offsets (OffsetX = 0, OffsetY = 120 in these packs), so the mascot
      // is always held by the same point rather than wherever it was grabbed. The
      // clamp to the activity area is a page-specific guard that also puts the anchor
      // exactly on a wall edge, which is what the wall grab after the release needs.
      const frame = this.actionStack[this.actionStack.length - 1];
      const offsetX = this.varNumber(frame, "OffsetX") ?? DRAG_OFFSET_X;
      const offsetY = this.varNumber(frame, "OffsetY") ?? DRAG_OFFSET_Y;
      const area = this.area();
      // The cursor comes from the DOM in screen pixels; the offsets are sprite-unit
      // quantities, so the anchor is cursorVirtual + offset (which is
      // cursorScreen + offset*scale on screen).
      const cursor = this.toVirtual(this.cursorX, this.cursorY);
      this.x = Math.max(area.left, Math.min(area.right, cursor.x + offsetX));
      this.y = Math.max(area.top, Math.min(area.bottom, cursor.y + offsetY));
      // dragged::subtick() keeps a held mascot facing left (the held sprites are
      // drawn that way).
      this.lookRight = false;
      // dragged::subtick(idx 0), once per tick: a smoothed follow of the cursor that
      // the held pose is chosen from (it is compared against cursor.x in the pack).
      this.footDX = (this.footDX + (cursor.x - this.footX) * 0.1) * 0.8;
      this.footX += this.footDX;
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
    this.observeTick(beforeX, beforeY);
  }

  /**
   * libshijima `base::tick()` for every advertisement this mascot currently owns:
   * keep the advertised position current, and when somebody walked up to it, start
   * the behaviour the handshake asked for.
   */
  private maintainBroadcasts() {
    for (const frame of this.actionStack) {
      const server = frame.server;
      if (!server) continue;
      if (server.active) server.updateAnchor({ x: this.x, y: this.y });
      if (!server.didMeetUp) continue;
      this.interaction = server.interaction();
      const next = this.interaction.behavior;
      if (next) this.setBehavior(next, "interaction-server");
      return;
    }
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
    const pacer = animation.forcedSwitchTicks(this.mascotName);
    if (pacer > 0 && this.stillTicks >= pacer && !this.isTravelling()) {
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
    const explained = this.isDragging || this.offsetJumped || step <= budget + SUSPECT_STEP_PX;
    this.offsetJumped = false;
    if (step > SUSPECT_STEP_PX && !explained) {
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
      else if (referenced.type === "Stay") next.durationLimit = this.scaledTicks(this.varNumber(next, "Duration") ?? DEFAULT_STAY_DURATION);
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
      if (this.dragStillTicks >= DRAG_RESIST_TICKS) {
        this.emit({
          kind: "milestone",
          name: "drag-resist",
          detail: `held still for ${DRAG_RESIST_TICKS} ticks`,
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
    // `get_cursor()` is a virtual-units quantity, so the raw screen cursor has to be
    // converted before comparing it with the anchor.
    if (this.isResistAction(node) && Math.abs(this.toVirtual(this.cursorX, this.cursorY).x - this.x) >= DRAG_RESIST_ABORT_PX) {
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
      else if (node.type === "Stay") frame.durationLimit = this.scaledTicks(this.varNumber(frame, "Duration") ?? DEFAULT_STAY_DURATION);
    }
    frame.elapsed++;
    frame.poseTick++;
    if (frame.durationLimit !== null && frame.elapsed >= frame.durationLimit) { this.popActionStack(); return; }
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
          this.isDragging = false;
          this.elRoot.style.cursor = "grab";
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
    const point = { x: this.x, y: this.y };
    const environment = this.environment();
    const candidates: Array<["Floor" | "Wall" | "Ceiling", boolean]> = [
      ["Floor", environment.floor.isOn(point)],
      ["Wall", environment.wall.isOn(point)],
      ["Ceiling", !this.isScrolling && environment.ceiling.isOn(point)],
    ];
    for (const [name, on] of candidates) {
      if (on && name !== lost) return name;
    }
    return null;
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
      const onTop = onCeiling || this.borderIsOn("top", point, this.area());

      // 页面滚动时或自由下落时碰触顶部，绝不能算作着陆，始终保持掉落状态
      if (onTop && (this.isScrolling || this.currentBehavior?.name === "Fall")) {
        if (this.vy < 0) this.vy = 0;
      }

      const landingOnCeiling = !this.isScrolling && this.currentBehavior?.name !== "Fall" && onCeiling;
      const onEdge = onFloor || onWall || landingOnCeiling;
      if (onEdge) {
        this.vx = this.vy = 0;
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
      const resistanceX = this.evaluateNumber(leaf.attributes?.RegistanceX, frame) ?? DEFAULT_RESISTANCE_X;
      const resistanceY = this.evaluateNumber(leaf.attributes?.RegistanceY, frame) ?? DEFAULT_RESISTANCE_Y;
      const gravity = this.evaluateNumber(leaf.attributes?.Gravity, frame) ?? GRAVITY;
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
    // Guard every action that is supposed to travel, not just target-seekers: a
    // mascot pushed into a border by a pose velocity is stuck just as badly.
    if (targetX !== null || targetY !== null || translates || leaf.type === "Move") this.guardStall(frame);
  }

  /** Clamps the anchor into the work area; reports when it actually had to move
   *  the mascot, once per action so sliding along a border is not spammed. */
  private clampToWorkArea() {
    const area = this.area();
    const clampedX = Math.max(area.left, Math.min(area.right, this.x));
    const clampedY = Math.max(area.top, Math.min(area.bottom, this.y));
    const moved = Math.abs(clampedX - this.x) + Math.abs(clampedY - this.y);
    const wasX = this.x;
    const wasY = this.y;
    this.x = clampedX;
    this.y = clampedY;
    if (moved > 0.5 && !this.clampReported) {
      this.clampReported = true;
      this.emit({
        kind: "milestone",
        name: "clamp",
        detail: `(${this.toPage(wasX).toFixed(1)},${this.toPage(wasY).toFixed(1)}) -> (${this.toPage(clampedX).toFixed(1)},${this.toPage(clampedY).toFixed(1)})`,
        x: this.x,
        y: this.y,
        leaf: this.leafLabel(),
      });
    }
  }

  private onBehaviorEnd(reason = "behavior-end") {
    if (!this.config) return;
    const animation = MascotEngine.animationConfig;
    const mascot = this.mascotName;
    const candidates: BehaviorReference[] = [];
    const next = this.currentBehavior?.nextBehaviors || [];
    for (const reference of next) {
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
        if (!candidates.some((candidate) => candidate.name === behavior.name)) {
          candidates.push({ name: behavior.name, frequency });
        }
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
    if (this.isScrolling && (standingOn === "Ceiling" || this.y <= this.area().top + 1)) {
      this.setBehavior("Fall", "scroll-no-ceiling");
      return;
    }
    if (standingOn) {
      const runnable = pool.filter((candidate) => {
        const start = this.firstBorderOf(candidate.name);
        return start === null || start === FLEXIBLE_BORDER || start === standingOn;
      });
      if (runnable.length > 0) pool = runnable;
    }
    const total = pool.reduce((sum, candidate) => sum + Math.max(0, candidate.frequency), 0);
    if (total <= 0) { this.setBehavior(pool[0].name, reason); return; }
    let random = Math.random() * total;
    for (const candidate of pool) {
      random -= candidate.frequency;
      if (random <= 0) { this.setBehavior(candidate.name, reason); return; }
    }
    this.setBehavior(candidates[0].name, reason);
  }

  private render(interpolate = true) {
    const pose = this.currentPose();
    if (!pose) return;
    // libshijima runs one 40 ms logic tick but advances and repaints the anchor
    // kSubtickCount (= 4) times per tick, which is why its motion is smooth.
    // Interpolating the paint between ticks reproduces that here; without it the
    // mascot moves one whole tick of travel at a time and a fall reads as a jump.
    const progress = interpolate ? Math.max(0, Math.min(1, this.accumulator / TICK_MS)) : 1;
    const x = this.prevX + (this.x - this.prevX) * progress;
    const y = this.prevY + (this.y - this.prevY) * progress;
    // Boundary one: virtual units → screen pixels.
    const scale = this.spriteScale;
    this.elRoot.style.transform = `translate3d(${x * scale}px, ${y * scale}px, 0)`;
    // A pose may legitimately carry no Image at all: the packs use that for the
    // interaction hold frames (`HurledAction` is `<Pose Velocity="0,0" Duration="128"/>`).
    // Setting an empty `src` made the browser show a broken-image glyph for the whole
    // hug, so an image-less pose simply keeps whatever frame is on screen.
    if (pose.image) {
      const src = this.spriteUrl(pose.image);
      if (this.elImg.getAttribute("src") !== src) this.elImg.src = src;
    }
    // Draw the sprite `scale`x larger with its pose ImageAnchor on the root origin,
    // mirrored in place when facing right. Written against `transform-origin: 0 0`
    // so mirroring and sizing combine in one matrix: a bitmap point p lands at
    // (tx + sx*p.x, ty + sy*p.y), and the anchor (ax, ay) must land on (0, 0) —
    // hence tx = -flip*ax*scale with sx = flip*scale.
    const ax = pose.imageAnchor.x;
    const ay = pose.imageAnchor.y;
    const flip = this.lookRight ? -1 : 1;
    this.elImg.style.transform = `translate(${-flip * ax * scale}px, ${-ay * scale}px) scaleX(${flip * scale}) scaleY(${scale})`;
    this.elImg.style.transformOrigin = "0 0";
  }
}
