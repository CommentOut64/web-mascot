/**
 * Animation customisation — one config file for everything a host may want to
 * change about how the mascots behave.
 *
 *   allowBehaviors / denyBehaviors  which behaviours may appear at all
 *   behaviorWeights                 selection weight (probability) of each
 *   actionDurations                 how long an action holds, in 40 ms ticks
 *   durationScale                   global multiplier on the pack's own holds
 *   forcedSwitchTicks               never stand still longer than this
 *   maxBehaviorTicks                hard cap on one behaviour (never cuts a fall)
 *   maxTravelPx                     how far a wander target may be (border
 *                                   targets, i.e. "walk to the wall", are kept)
 *   zone                            the rectangle the mascot lives in; it becomes
 *                                   the work area, so floor/walls/ceiling follow
 *   spawn                           where a new mascot appears, and how several
 *                                   mascots are spread apart
 *   reducedMotion / respectReducedMotion
 *                                   what to change when the OS asks for reduced
 *                                   motion (the host decides; the engine ships no
 *                                   reduced-motion preset)
 *   ignoreBuiltin                   true drops the engine's built-in preset
 *
 * The engine ships a built-in preset (see `animationPreset.ts`) — the layer every
 * host starts from. Each field above overrides it, and `ignoreBuiltin` removes it.
 * The same data is emitted as `dist/animation.config.json`, so the template a host
 * copies and the behaviour it gets by default cannot drift apart.
 *
 * Everything is optional and validated: a malformed value is ignored rather than
 * breaking the mascot, and unknown names are kept (they simply never match) so a
 * config can be written ahead of the pack. `MascotEngine.setAnimationConfig()`
 * accepts the same shape as an object, and `toJSON()` / `optionsFor()` hand the
 * effective settings back for a settings UI.
 */

import { ANIMATION_PRESET_DEFAULTS } from "./animationPreset.js";

/** A position or size: pixels as a number, a percentage like "40%", or a keyword
 *  ("left" | "right" | "top" | "bottom" | "center"). */
export type Metric = number | string;

export interface SpawnOptions {
  /** `"top"` (default) drops the mascot in from above, `"floor"` starts it on
   *  the floor of its zone already standing. */
  vertical?: "top" | "floor";
  /** Horizontal start position (Metric), default the middle of the zone. */
  x?: Metric;
  /** Extra offset per already-live mascot so several mascots do not stack. */
  staggerPx?: number;
  /** How far below the zone's top a "top" spawn starts. Default 100. */
  topOffset?: number;
}

export interface ZoneOptions {
  left?: Metric;
  right?: Metric;
  top?: Metric;
  bottom?: Metric;
}

/** Weight for partner behaviours, in the situations that matter. */
export interface PartnerWeights {
  /** While this mascot is the only one on the page. */
  alone?: number;
  /** While other mascots are live, so an interaction can actually happen. */
  withPartner?: number;
  /**
   * While another mascot is on the *same* surface and within the scan distance —
   * i.e. a scan started right now could connect. Raising this is what makes two
   * mascots that are both on the floor seek each other out. It cannot make a hug
   * certain: a scan still only connects if the other one happens to be advertising
   * at that exact tick, so the interaction stays stochastic.
   */
  reachable?: number;
}

export interface MascotAnimationOptions {
  /** Only these behaviours may be chosen. Empty/absent means "all of them". */
  allowBehaviors?: string[];
  /** These behaviours are never chosen. */
  denyBehaviors?: string[];
  /** Selection weight per behaviour, overriding the pack's Frequency. 0 disables. */
  behaviorWeights?: Record<string, number>;
  /** Hold duration per action in ticks; 40 ms each. `[min,max]` or a single value. */
  actionDurations?: Record<string, DurationSetting>;
  /** Multiplier applied to the pack's own Duration values. 1 = unchanged. */
  durationScale?: number;
  /**
   * How much bigger the mascot is drawn, as a linear multiplier (1 = the pack's
   * native 128 px sprite). The engine keeps working in *virtual* units, where one
   * unit is one sprite pixel, and converts at the two boundaries (rendering and
   * pointer input) — the same thing libshijima does with `environment::set_scale`.
   * That is what keeps the packs' own pixel constants (`workArea.top+64`,
   * `width-128`, velocities, `Offset Y=1`, hotspot origins) meaningful at any size.
   */
  scale?: number;
  /** Nudge a standing mascot into a new behaviour after this many ticks. */
  forcedSwitchTicks?: number;
  /**
   * Behaviours the pacer above must not interrupt.
   *
   * `forcedSwitchTicks` keys off *movement*: any pose with zero velocity counts as
   * standing still, so a long stationary animation — a sit-and-dangle sequence is
   * ~400 ticks — gets cut off mid-way by a pacer shorter than it. Listing it here
   * lets the whole sequence play, while a plain idle `Stay` is still nudged on time.
   * Only the pacer is suspended; `maxBehaviorTicks` still applies, so a listed
   * behaviour cannot run for ever.
   */
  pacerExemptBehaviors?: string[];
  /**
   * Behaviours that return to the *global* pool when they end, instead of following
   * the pack's `<NextBehaviorList>`.
   *
   * The packs use that list to chain related behaviours, and some chains are closed
   * (`Add="false"` with their own name among the targets). `SitAndFaceMouse` in the
   * shipped packs is exactly that: it can only re-pick itself or
   * `SitWhileDanglingLegs`, forever. A mascot that sits down therefore never leaves
   * that pair on its own; combining a pacer exemption with this list is what lets it
   * finish the animation *and* move on afterwards.
   */
  exitToPoolBehaviors?: string[];
  /** After a completed interaction (hug/hurl), partner behaviours are suppressed for
   *  this many ticks. Without it two mascots that end a hug next to each other simply
   *  connect again on the next pick and chain hugs back to back. */
  interactionCooldownTicks?: number;
  /** Hard cap on one behaviour, in ticks. A fall or a drag is never cut. */
  maxBehaviorTicks?: number;
  /** Longest horizontal wander target, in pixels. 0/absent = unlimited. */
  maxTravelPx?: number;
  /**
   * Weight given to *partner* behaviours (hugging, hurling, waiting for a hug,
   * noticing a falling friend) regardless of the name the pack uses and regardless
   * of how large the pack's own Frequency is.
   *
   * The packs weight these at 1000–3000 because a busy desktop has several
   * mascots; on a page a lone mascot would just stand around. Naming the pack's
   * behaviours here would be brittle — Neuron calls it HugEvil and Eviling calls it
   * HugNeuro — so the engine decides by inspecting the action instead, and this
   * pair of numbers says how much that class of behaviour is worth.
   */
  partnerWeights?: PartnerWeights;
  /**
   * How far a scanning mascot looks for an advertisement, in pixels (libshijima
   * uses 256, which suits a desktop). A page is often much wider than a mascot
   * neighbourhood, so raising this is what lets two mascots find each other.
   */
  scanDistancePx?: number;
  /** The activity rectangle; it becomes the mascot's work area. */
  zone?: ZoneOptions;
  /** Where a new mascot appears. */
  spawn?: SpawnOptions;
}

/** A duration may be written as one fixed value or as a `[min,max]` range. */
export type DurationSetting = number | [number, number];

export interface AnimationConfigFile {
  version?: number;
  /** Set true to drop the engine's built-in preset and run the packs exactly as
   *  they ship: no pacer, no behaviour-weight overrides, no long-sequence
   *  exemption. Default false. Orthogonal to the fields below — this removes the
   *  layer *underneath*, it does not disable the file. */
  ignoreBuiltin?: boolean;
  /** Applied to every mascot. */
  defaults?: MascotAnimationOptions;
  /** Per-mascot overrides, keyed by mascot name (`Neuron`, `Eviling`, ...). */
  mascots?: Record<string, MascotAnimationOptions>;
  /** Merged on top of `defaults` while the OS asks for reduced motion. */
  reducedMotion?: MascotAnimationOptions;
  /** Set false to ignore the OS reduced-motion preference. Default true. */
  respectReducedMotion?: boolean;
}

const TICK_MS = 40;
const MIN_SCALE = 0.05;
const MAX_SCALE = 20;
/** Drawn-size limits: below ~0.3 or above ~2 the 128 px source art shows. */
const MIN_SPRITE_SCALE = 0.2;
const MAX_SPRITE_SCALE = 4;
/** Upper bound for `interactionCooldownTicks` (2 minutes). */
const MAX_COOLDOWN_TICKS = 3000;
const MAX_TICKS = 1_000_000;
const MAX_PIXELS = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function nameList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return names.length > 0 || value.length === 0 ? names : undefined;
}

function tickCount(value: unknown, min: number): number | undefined {
  const parsed = numberOr(value);
  if (parsed === undefined) return undefined;
  return Math.round(Math.min(MAX_TICKS, Math.max(min, parsed)));
}

function pixelCount(value: unknown, min: number, max = MAX_PIXELS): number | undefined {
  const parsed = numberOr(value);
  if (parsed === undefined) return undefined;
  return Math.min(max, Math.max(min, parsed));
}

function metric(value: unknown): Metric | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return undefined;
}

function keyword<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase() as T;
  return allowed.includes(text) ? text : undefined;
}

function weights(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const name = key.trim();
    const parsed = numberOr(raw);
    if (!name || parsed === undefined || parsed < 0) continue;
    result[name] = Math.min(MAX_TICKS, parsed);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function durations(value: unknown): Record<string, DurationSetting> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, DurationSetting> = {};
  for (const [key, raw] of Object.entries(value)) {
    const name = key.trim();
    if (!name) continue;
    if (Array.isArray(raw)) {
      let low = tickCount(raw[0], 1);
      let high = tickCount(raw[1], 1);
      if (low === undefined) continue;
      if (high === undefined) high = low;
      if (high < low) [low, high] = [high, low];
      result[name] = low === high ? low : [low, high];
    } else {
      const fixed = tickCount(raw, 1);
      if (fixed === undefined) continue;
      result[name] = fixed;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function zone(value: unknown): ZoneOptions | undefined {
  if (!isRecord(value)) return undefined;
  const result: ZoneOptions = {};
  const left = metric(value.left);
  if (left !== undefined) result.left = left;
  const right = metric(value.right);
  if (right !== undefined) result.right = right;
  const top = metric(value.top);
  if (top !== undefined) result.top = top;
  const bottom = metric(value.bottom);
  if (bottom !== undefined) result.bottom = bottom;
  return Object.keys(result).length > 0 ? result : undefined;
}

function weightValue(value: unknown): number | undefined {
  const parsed = numberOr(value);
  if (parsed === undefined || parsed < 0) return undefined;
  return Math.min(MAX_TICKS, parsed);
}

function partnerWeights(value: unknown): PartnerWeights | undefined {
  if (!isRecord(value)) return undefined;
  const result: PartnerWeights = {};
  const alone = weightValue(value.alone);
  if (alone !== undefined) result.alone = alone;
  const withPartner = weightValue(value.withPartner);
  if (withPartner !== undefined) result.withPartner = withPartner;
  const reachable = weightValue(value.reachable);
  if (reachable !== undefined) result.reachable = reachable;
  return Object.keys(result).length > 0 ? result : undefined;
}

function spawn(value: unknown): SpawnOptions | undefined {
  if (!isRecord(value)) return undefined;
  const result: SpawnOptions = {};
  const vertical = keyword(value.vertical, ["top", "floor"] as const);
  if (vertical) result.vertical = vertical;
  const x = metric(value.x);
  if (x !== undefined) result.x = x;
  const stagger = pixelCount(value.staggerPx, 0);
  if (stagger !== undefined) result.staggerPx = stagger;
  const topOffset = pixelCount(value.topOffset, 0);
  if (topOffset !== undefined) result.topOffset = topOffset;
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeOptions(value: unknown): MascotAnimationOptions {
  if (!isRecord(value)) return {};
  const options: MascotAnimationOptions = {};
  const allow = nameList(value.allowBehaviors);
  if (allow) options.allowBehaviors = allow;
  const deny = nameList(value.denyBehaviors);
  if (deny) options.denyBehaviors = deny;
  const weightMap = weights(value.behaviorWeights);
  if (weightMap) options.behaviorWeights = weightMap;
  const durationMap = durations(value.actionDurations);
  if (durationMap) options.actionDurations = durationMap;
  const scale = numberOr(value.durationScale);
  if (scale !== undefined) options.durationScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  const spriteScale = numberOr(value.scale);
  if (spriteScale !== undefined) options.scale = Math.min(MAX_SPRITE_SCALE, Math.max(MIN_SPRITE_SCALE, spriteScale));
  const forced = tickCount(value.forcedSwitchTicks, 0);
  if (forced !== undefined) options.forcedSwitchTicks = forced;
  const pacerExempt = nameList(value.pacerExemptBehaviors);
  if (pacerExempt) options.pacerExemptBehaviors = pacerExempt;
  const exitToPool = nameList(value.exitToPoolBehaviors);
  if (exitToPool) options.exitToPoolBehaviors = exitToPool;
  const cooldown = tickCount(value.interactionCooldownTicks, 0);
  if (cooldown !== undefined) options.interactionCooldownTicks = Math.min(MAX_COOLDOWN_TICKS, cooldown);
  const maxBehavior = tickCount(value.maxBehaviorTicks, 0);
  if (maxBehavior !== undefined) options.maxBehaviorTicks = maxBehavior;
  const travel = pixelCount(value.maxTravelPx, 0);
  if (travel !== undefined) options.maxTravelPx = travel;
  const partner = partnerWeights(value.partnerWeights);
  if (partner) options.partnerWeights = partner;
  const scan = pixelCount(value.scanDistancePx, 16, 4096);
  if (scan !== undefined) options.scanDistancePx = scan;
  const zoneOptions = zone(value.zone);
  if (zoneOptions) options.zone = zoneOptions;
  const spawnOptions = spawn(value.spawn);
  if (spawnOptions) options.spawn = spawnOptions;
  return options;
}

function mergeOptions(base: MascotAnimationOptions, override: MascotAnimationOptions): MascotAnimationOptions {
  return {
    allowBehaviors: override.allowBehaviors ?? base.allowBehaviors,
    denyBehaviors: override.denyBehaviors ?? base.denyBehaviors,
    behaviorWeights: { ...base.behaviorWeights, ...override.behaviorWeights },
    actionDurations: { ...base.actionDurations, ...override.actionDurations },
    durationScale: override.durationScale ?? base.durationScale,
    scale: override.scale ?? base.scale,
    forcedSwitchTicks: override.forcedSwitchTicks ?? base.forcedSwitchTicks,
    pacerExemptBehaviors: override.pacerExemptBehaviors ?? base.pacerExemptBehaviors,
    exitToPoolBehaviors: override.exitToPoolBehaviors ?? base.exitToPoolBehaviors,
    interactionCooldownTicks: override.interactionCooldownTicks ?? base.interactionCooldownTicks,
    maxBehaviorTicks: override.maxBehaviorTicks ?? base.maxBehaviorTicks,
    maxTravelPx: override.maxTravelPx ?? base.maxTravelPx,
    partnerWeights: { ...base.partnerWeights, ...override.partnerWeights },
    scanDistancePx: override.scanDistancePx ?? base.scanDistancePx,
    zone: { ...base.zone, ...override.zone },
    spawn: { ...base.spawn, ...override.spawn },
  };
}

function hasContent(options: MascotAnimationOptions): boolean {
  return (
    options.allowBehaviors !== undefined ||
    options.denyBehaviors !== undefined ||
    (options.behaviorWeights !== undefined && Object.keys(options.behaviorWeights).length > 0) ||
    (options.actionDurations !== undefined && Object.keys(options.actionDurations).length > 0) ||
    options.durationScale !== undefined ||
    options.scale !== undefined ||
    options.forcedSwitchTicks !== undefined ||
    (options.pacerExemptBehaviors !== undefined && options.pacerExemptBehaviors.length > 0) ||
    (options.exitToPoolBehaviors !== undefined && options.exitToPoolBehaviors.length > 0) ||
    options.interactionCooldownTicks !== undefined ||
    options.maxBehaviorTicks !== undefined ||
    options.maxTravelPx !== undefined ||
    (options.partnerWeights !== undefined && Object.keys(options.partnerWeights).length > 0) ||
    options.scanDistancePx !== undefined ||
    (options.zone !== undefined && Object.keys(options.zone).length > 0) ||
    (options.spawn !== undefined && Object.keys(options.spawn).length > 0)
  );
}

/**
 * The built-in preset, normalised once.
 *
 * It is declared *below* the helpers on purpose: module-level `const`
 * initialisation runs in source order, and `normalizeOptions` reads constants of
 * its own, so hoisting the function is not enough. Moving this above them throws
 * "Cannot access '…' before initialization" on import.
 */
const BUILTIN_ANIMATION_CONFIG: MascotAnimationOptions = normalizeOptions(ANIMATION_PRESET_DEFAULTS);

export class AnimationConfig {
  private defaults: MascotAnimationOptions = {};
  private perMascot = new Map<string, MascotAnimationOptions>();
  private reduced: MascotAnimationOptions = {};
  private reducedActive = false;
  private respectReduced = true;
  private respectBuiltin = true;
  private resolved = new Map<string, MascotAnimationOptions>();
  /** Where the settings came from, for logs and diagnostics. */
  public readonly source: string;

  constructor(file?: unknown, source = "(built-in defaults)") {
    this.source = source;
    this.apply(file);
  }

  /** Replace the settings. Invalid input leaves the config empty (= pack default). */
  public apply(file: unknown): void {
    this.defaults = {};
    this.perMascot = new Map();
    this.reduced = {};
    this.respectReduced = true;
    this.respectBuiltin = true;
    this.resolved = new Map();
    if (!isRecord(file)) return;
    this.respectBuiltin = file.ignoreBuiltin !== true;
    this.defaults = normalizeOptions(file.defaults);
    this.reduced = normalizeOptions(file.reducedMotion);
    this.respectReduced = file.respectReducedMotion !== false;
    const mascots = file.mascots;
    if (isRecord(mascots)) {
      for (const [key, raw] of Object.entries(mascots)) {
        const name = key.trim();
        if (!name) continue;
        this.perMascot.set(name, normalizeOptions(raw));
      }
    }
    this.refreshReducedMotion();
  }

  /** Called by the engine when the OS preference changes. */
  public setReducedMotion(active: boolean): void {
    if (this.reducedActive === active) return;
    this.reducedActive = active;
    this.resolved.clear();
  }

  /** Re-read the OS preference (used at load time and on change). */
  public refreshReducedMotion(): boolean {
    let active = false;
    if (this.respectReduced && typeof window !== "undefined" && typeof window.matchMedia === "function") {
      try {
        active = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      } catch {
        active = false;
      }
    }
    this.setReducedMotion(active);
    return active;
  }

  public get reducedMotionActive(): boolean {
    return this.reducedActive;
  }

  /** True when this configuration cannot affect anything: the built-in preset is
   *  off and the host supplied nothing of its own. */
  public get isEmpty(): boolean {
    return !this.respectBuiltin && !hasContent(this.defaults) && this.perMascot.size === 0 && !hasContent(this.reduced);
  }

  /** Effective options: built-in (if not ignored), then file defaults, then reduced-motion block, then mascot overrides. */
  public optionsFor(mascot: string): MascotAnimationOptions {
    const cached = this.resolved.get(mascot);
    if (cached) return cloneOptions(cached);
    let base = this.respectBuiltin ? BUILTIN_ANIMATION_CONFIG : {};
    let merged = mergeOptions(base, this.defaults);
    merged = mergeOptions(merged, this.reducedActive ? this.reduced : {});
    merged = mergeOptions(merged, this.perMascot.get(mascot) ?? {});
    this.resolved.set(mascot, merged);
    return cloneOptions(merged);
  }

  /** Whether a behaviour may be selected for this mascot. */
  public allows(mascot: string, behavior: string): boolean {
    const options = this.optionsFor(mascot);
    if (options.denyBehaviors?.includes(behavior)) return false;
    if (options.allowBehaviors && options.allowBehaviors.length > 0 && !options.allowBehaviors.includes(behavior)) return false;
    return true;
  }

  /** Explicitly forbidden. Unlike `allows()`, this ignores `allowBehaviors`, which
   *  only restricts random selection — a visitor-triggered hotspot is deliberate. */
  public denies(mascot: string, behavior: string): boolean {
    return this.optionsFor(mascot).denyBehaviors?.includes(behavior) ?? false;
  }

  /** Weight override for a behaviour, or undefined to keep the pack's Frequency. */
  public weightOverride(mascot: string, behavior: string): number | undefined {
    return this.optionsFor(mascot).behaviorWeights?.[behavior];
  }

  /** Effective selection weight, falling back to the pack's Frequency. */
  public weight(mascot: string, behavior: string, fallback: number): number {
    return this.weightOverride(mascot, behavior) ?? fallback;
  }

  public scale(mascot: string): number {
    return this.optionsFor(mascot).durationScale ?? 1;
  }

  /** Linear size multiplier for the drawn mascot (virtual unit = one sprite px). */
  public mascotScale(mascot: string): number {
    return this.optionsFor(mascot).scale ?? 1;
  }

  public forcedSwitchTicks(mascot: string): number {
    return this.optionsFor(mascot).forcedSwitchTicks ?? 0;
  }

  /** May the pacer interrupt this behaviour? False only for the exempted ones, so a
   *  long stationary animation can finish while a plain idle `Stay` is still nudged. */
  public pacerApplies(mascot: string, behavior: string | undefined): boolean {
    if (!behavior) return true;
    return !(this.optionsFor(mascot).pacerExemptBehaviors?.includes(behavior) ?? false);
  }

  /** Does this behaviour re-enter the global pool when it ends, bypassing the pack's
   *  `<NextBehaviorList>`? Needed for the packs' closed chains (see the option docs). */
  public exitsToPool(mascot: string, behavior: string | undefined): boolean {
    if (!behavior) return false;
    return this.optionsFor(mascot).exitToPoolBehaviors?.includes(behavior) ?? false;
  }

  /** Ticks during which partner behaviours stay out of the pool after an interaction. */
  public interactionCooldown(mascot: string): number {
    return this.optionsFor(mascot).interactionCooldownTicks ?? 0;
  }

  public maxBehaviorTicks(mascot: string): number {
    return this.optionsFor(mascot).maxBehaviorTicks ?? 0;
  }

  public maxTravelPx(mascot: string): number {
    return this.optionsFor(mascot).maxTravelPx ?? 0;
  }

  /** Weight to use for a partner behaviour, or null to keep the pack's Frequency.
   *  `reachable` is the "another mascot is right here and level with me" case. */
  public partnerWeight(mascot: string, withPartner: boolean, reachable = false): number | null {
    const weights = this.optionsFor(mascot).partnerWeights;
    if (!weights) return null;
    if (reachable && weights.reachable !== undefined) return weights.reachable;
    const value = withPartner ? weights.withPartner : weights.alone;
    return value === undefined ? null : value;
  }

  /** How far this mascot scans for a partner advertisement. */
  public scanDistancePx(mascot: string): number {
    return this.optionsFor(mascot).scanDistancePx ?? 256;
  }

  public zone(mascot: string): ZoneOptions {
    return this.optionsFor(mascot).zone ?? {};
  }

  public spawn(mascot: string): SpawnOptions {
    return this.optionsFor(mascot).spawn ?? {};
  }

  /**
   * A hold duration in ticks for an action, picked once from its `[min,max]`
   * range, or null when the action is not configured. The caller must call this
   * once per action instance: calling it per tick would re-roll the range.
   */
  public durationTicks(mascot: string, action: string | undefined): number | null {
    if (!action) return null;
    const setting = this.optionsFor(mascot).actionDurations?.[action];
    if (setting === undefined) return null;
    if (typeof setting === "number") return setting;
    const [low, high] = setting;
    if (high <= low) return low;
    return low + Math.round(Math.random() * (high - low));
  }

  /** True when this action has an explicit duration override. */
  public hasDurationOverride(mascot: string, action: string | undefined): boolean {
    if (!action) return false;
    return this.optionsFor(mascot).actionDurations?.[action] !== undefined;
  }

  /** Round-trip view of the raw file shape, for a settings UI. */
  public toJSON(): AnimationConfigFile {
    const mascots: Record<string, MascotAnimationOptions> = {};
    for (const [name, options] of this.perMascot) mascots[name] = cloneOptions(options);
    const result: AnimationConfigFile = {
      version: 1,
      defaults: cloneOptions(this.defaults),
      mascots,
      reducedMotion: cloneOptions(this.reduced),
      respectReducedMotion: this.respectReduced,
    };
    if (!this.respectBuiltin) result.ignoreBuiltin = true;
    return result;
  }

  /** One-line summary written into the observation log with every spawn. */
  public describe(mascot: string): string {
    const options = this.optionsFor(mascot);
    const parts = [
      `source=${this.source}${this.respectBuiltin ? " +builtin" : " no-builtin"}`,
      `durationScale=${options.durationScale ?? 1}`,
      `scale=${options.scale ?? 1}`,
      `cap=${options.maxBehaviorTicks ?? 0}`,
      `pacer=${options.forcedSwitchTicks ?? 0}`,
      `cooldown=${options.interactionCooldownTicks ?? 0}`,
      `travel=${options.maxTravelPx ?? 0}`,
      `partner=${options.partnerWeights ? `${options.partnerWeights.alone ?? "-"}/${options.partnerWeights.withPartner ?? "-"}/${options.partnerWeights.reachable ?? "-"}` : "pack"}`,
      `scan=${options.scanDistancePx ?? 256}`,
      `allow=${options.allowBehaviors ? options.allowBehaviors.length : "all"}`,
      `deny=${options.denyBehaviors ? options.denyBehaviors.length : 0}`,
      `weights=${options.behaviorWeights ? Object.keys(options.behaviorWeights).length : 0}`,
      `durations=${options.actionDurations ? Object.keys(options.actionDurations).length : 0}`,
      `zone=${options.zone && Object.keys(options.zone).length ? JSON.stringify(options.zone) : "full"}`,
      `spawn=${options.spawn && Object.keys(options.spawn).length ? JSON.stringify(options.spawn) : "default"}`,
      `reduced=${this.reducedActive ? "on" : "off"}`,
    ];
    return parts.join(" ");
  }

  /** Human-readable list of the effective settings, for logs. */
  public details(mascot: string): string[] {
    const options = this.optionsFor(mascot);
    const lines: string[] = [];
    const seconds = (ticks: number) => `${((ticks * TICK_MS) / 1000).toFixed(1)}s`;
    if (options.allowBehaviors) lines.push(`allowBehaviors: ${options.allowBehaviors.join(", ")}`);
    if (options.denyBehaviors) lines.push(`denyBehaviors: ${options.denyBehaviors.join(", ")}`);
    if (options.behaviorWeights && Object.keys(options.behaviorWeights).length > 0) {
      lines.push(
        `behaviorWeights: ${Object.entries(options.behaviorWeights)
          .map(([name, value]) => `${name}=${value}`)
          .join(", ")}`,
      );
    }
    if (options.actionDurations && Object.keys(options.actionDurations).length > 0) {
      lines.push(
        `actionDurations: ${Object.entries(options.actionDurations)
          .map(([name, value]) => `${name}=${Array.isArray(value) ? `[${value[0]},${value[1]}]` : value}ticks`)
          .join(", ")}`,
      );
    }
    if (options.durationScale !== undefined) lines.push(`durationScale: ${options.durationScale}`);
    if (options.scale !== undefined) {
      lines.push(`scale: ${options.scale}x (1 virtual unit = 1 sprite px, drawn ${options.scale}x)`);
    }
    if (options.interactionCooldownTicks) {
      lines.push(
        `interactionCooldownTicks: ${options.interactionCooldownTicks} (${seconds(options.interactionCooldownTicks)})`,
      );
    }
    if (options.forcedSwitchTicks) {
      lines.push(`forcedSwitchTicks: ${options.forcedSwitchTicks} (${seconds(options.forcedSwitchTicks)})`);
    }
    if (options.pacerExemptBehaviors?.length) {
      lines.push(`pacerExemptBehaviors: ${options.pacerExemptBehaviors.join(", ")}`);
    }
    if (options.exitToPoolBehaviors?.length) {
      lines.push(`exitToPoolBehaviors: ${options.exitToPoolBehaviors.join(", ")}`);
    }
    if (options.maxBehaviorTicks) {
      lines.push(`maxBehaviorTicks: ${options.maxBehaviorTicks} (${seconds(options.maxBehaviorTicks)})`);
    }
    if (options.maxTravelPx) lines.push(`maxTravelPx: ${options.maxTravelPx}px`);
    if (options.partnerWeights && Object.keys(options.partnerWeights).length > 0) {
      lines.push(
        `partnerWeights: alone=${options.partnerWeights.alone ?? "pack"} withPartner=${options.partnerWeights.withPartner ?? "pack"} reachable=${options.partnerWeights.reachable ?? "pack"}`,
      );
    }
    if (options.zone && Object.keys(options.zone).length > 0) lines.push(`zone: ${JSON.stringify(options.zone)}`);
    if (options.spawn && Object.keys(options.spawn).length > 0) lines.push(`spawn: ${JSON.stringify(options.spawn)}`);
    if (this.reducedActive) lines.push("reducedMotion: active (OS preference)");
    return lines;
  }
}

function cloneOptions(options: MascotAnimationOptions): MascotAnimationOptions {
  return {
    ...options,
    allowBehaviors: options.allowBehaviors ? [...options.allowBehaviors] : undefined,
    denyBehaviors: options.denyBehaviors ? [...options.denyBehaviors] : undefined,
    pacerExemptBehaviors: options.pacerExemptBehaviors ? [...options.pacerExemptBehaviors] : undefined,
    exitToPoolBehaviors: options.exitToPoolBehaviors ? [...options.exitToPoolBehaviors] : undefined,
    behaviorWeights: options.behaviorWeights ? { ...options.behaviorWeights } : undefined,
    actionDurations: options.actionDurations
      ? Object.fromEntries(Object.entries(options.actionDurations).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]))
      : undefined,
    partnerWeights: options.partnerWeights ? { ...options.partnerWeights } : undefined,
    zone: options.zone ? { ...options.zone } : undefined,
    spawn: options.spawn ? { ...options.spawn } : undefined,
  };
}
