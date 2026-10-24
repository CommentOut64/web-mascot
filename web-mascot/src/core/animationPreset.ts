/**
 * Standard Animation Preset & Preset Registry
 *
 * Provides standardized animation presets, clear parameter definitions,
 * and a decoupled registration mechanism for Web Mascot.
 *
 * Layers & Responsibilities:
 *   1. Engine Baseline (Runtime Defaults): Hard physics & engine constraints (in MascotEngine).
 *   2. Classic Preset ("classic"): native XML timing and selection weights.
 *   3. Lively Preset ("lively"): Tuned specifically for web pages (anti-freeze, active wandering).
 *   4. PresetRegistry: Allows getting, modifying, registering, and switching presets without coupling.
 */

import type { MascotAnimationOptions, ActivityLevel } from "./AnimationConfig.js";

/** Deep-clone a MascotAnimationOptions object to prevent mutation leakage. */
export function cloneOptions(options: MascotAnimationOptions): MascotAnimationOptions {
  return {
    ...options,
    activityLevel: options.activityLevel,
    travelDwellTicks: Array.isArray(options.travelDwellTicks) ? [...options.travelDwellTicks] : options.travelDwellTicks,
    allowBehaviors: options.allowBehaviors ? [...options.allowBehaviors] : undefined,
    denyBehaviors: options.denyBehaviors ? [...options.denyBehaviors] : undefined,
    pacerExemptBehaviors: options.pacerExemptBehaviors ? [...options.pacerExemptBehaviors] : undefined,
    exitToPoolBehaviors: options.exitToPoolBehaviors ? [...options.exitToPoolBehaviors] : undefined,
    behaviorWeights: options.behaviorWeights ? { ...options.behaviorWeights } : undefined,
    actionDurations: options.actionDurations
      ? Object.fromEntries(
          Object.entries(options.actionDurations).map(([key, value]) => [
            key,
            Array.isArray(value) ? [...value] : value,
          ]),
        )
      : undefined,
    actionHoldLimits: options.actionHoldLimits
      ? Object.fromEntries(Object.entries(options.actionHoldLimits).map(([key, value]) => [
          key, { ticks: Array.isArray(value?.ticks) ? [...value.ticks] : value?.ticks,
            waitPoses: Array.isArray(value?.waitPoses) ? [...value.waitPoses] : value?.waitPoses },
        ]))
      : undefined,
    partnerWeights: options.partnerWeights ? { ...options.partnerWeights } : undefined,
    zone: options.zone ? { ...options.zone } : undefined,
    spawn: options.spawn ? { ...options.spawn } : undefined,
  };
}

/**
 * Classic (Qt) animation preset.
 *
 * Native Shimeji / NeurolingsCE-Qt timing and weights among eligible behaviors:
 * - Empty patch layer (no pacer, no behavior caps, no weight overrides, raw XML).
 * - All options fall back directly to XML definitions and engine runtime defaults.
 */
export const CLASSIC_ANIMATION_PRESET: Readonly<MascotAnimationOptions> = Object.freeze({});

/**
 * Calm (偏安静) animation preset — Qt desktop parity with composed standing dwell:
 * - forcedSwitchTicks: 0 (no forced movement pacing, full native idle durations).
 * - No hold limits: Stand, Sit, Sprawl etc. retain native XML timings (20~60s).
 * - travelDwellTicks: [50, 75] (2.0~3.0s of calm standing after movement).
 * - repeatBehaviorWeight: 0.6 (moderate repeat dampening to prevent behavioral loops while preserving calm dwell).
 * - interactionCooldownTicks: 1500 (60s cooldown to prevent interaction storm in dual-mascot mode).
 * - Suppressed partner weights: HugEvil, AskForHugs, NoticeFallingTutel, HurlEvil scaled down so idle dominates.
 */
export const CALM_ANIMATION_PRESET: Readonly<MascotAnimationOptions> = Object.freeze<MascotAnimationOptions>({
  activityLevel: "calm",
  spawn: { topOffset: 100, staggerPx: 180 },
  forcedSwitchTicks: 0,
  maxBehaviorTicks: 0,
  travelDwellTicks: [50, 75],
  repeatBehaviorWeight: 0.6,
  interactionCooldownTicks: 1500,
  pacerExemptBehaviors: ["SitWhileDanglingLegs"],
  exitToPoolBehaviors: ["SitWhileDanglingLegs", "LieDown"],
  behaviorWeights: {
    SitAndFaceMouse: 8,
    HugEvil: 50,
    AskForHugs: 50,
    NoticeFallingTutel: 100,
    HurlEvil: 20,
  },
});

/**
 * Normal (正常, Default) animation preset — web-tuned balanced timing:
 * - forcedSwitchTicks: 750 (30s: generous sitting/lying down time, keeps page natural without freezing).
 * - actionHoldLimits: Stand (12~20s), Sit & Sprawl (14~24s), Wall/Ceiling grabs (10~16s).
 * - travelDwellTicks: [30, 50] (1.2~2.0s of natural standing dwell after reaching target-x, before the next action).
 * - repeatBehaviorWeight: 0.4.
 * - interactionCooldownTicks: 750 (30s cooldown between dual-mascot interactions).
 */
export const NORMAL_ANIMATION_PRESET: Readonly<MascotAnimationOptions> = Object.freeze<MascotAnimationOptions>({
  activityLevel: "normal",
  spawn: { topOffset: 100, staggerPx: 180 },
  forcedSwitchTicks: 750,
  maxBehaviorTicks: 1500,
  pacerExemptBehaviors: ["SitWhileDanglingLegs"],
  exitToPoolBehaviors: ["SitWhileDanglingLegs", "LieDown"],
  interactionCooldownTicks: 750,
  behaviorWeights: {
    SitAndFaceMouse: 8,
    HugEvil: 120,
    AskForHugs: 120,
    NoticeFallingTutel: 200,
    HurlEvil: 50,
  },
  actionHoldLimits: {
    Stand: { ticks: [300, 500], waitPoses: [0, 2, 4] },
    Sit: { ticks: [350, 600], waitPoses: [0, 2, 4] },
    Sprawl: { ticks: [350, 600], waitPoses: [0, 2, 4] },
    GrabWall: { ticks: [250, 400], waitPoses: [0, 2, 4] },
    GrabCeiling: { ticks: [250, 400], waitPoses: [0, 2, 4] },
  },
  travelDwellTicks: [30, 50],
  repeatBehaviorWeight: 0.4,
});

/**
 * Active (偏活跃) animation preset — high mobility, compressed pauses:
 * - forcedSwitchTicks: 250 (10s: prompt travel quickly).
 * - actionHoldLimits: Stand (3.2~6s), Sit & Sprawl (4~7.2s).
 * - travelDwellTicks: [0, 10] (0~0.4s: fast transitions, near-zero dwell).
 * - repeatBehaviorWeight: 0.35.
 * - interactionCooldownTicks: 150 (6s cooldown for frequent partner interplay).
 */
export const ACTIVE_ANIMATION_PRESET: Readonly<MascotAnimationOptions> = Object.freeze<MascotAnimationOptions>({
  activityLevel: "active",
  spawn: { topOffset: 100, staggerPx: 180 },
  forcedSwitchTicks: 250,
  maxBehaviorTicks: 800,
  pacerExemptBehaviors: ["SitWhileDanglingLegs"],
  exitToPoolBehaviors: ["SitWhileDanglingLegs", "LieDown"],
  interactionCooldownTicks: 150,
  actionHoldLimits: {
    Stand: { ticks: [80, 150], waitPoses: [0, 2, 4] },
    Sit: { ticks: [100, 180], waitPoses: [0, 2, 4] },
    Sprawl: { ticks: [100, 180], waitPoses: [0, 2, 4] },
    GrabWall: { ticks: [80, 150], waitPoses: [0, 2, 4] },
    GrabCeiling: { ticks: [80, 150], waitPoses: [0, 2, 4] },
  },
  travelDwellTicks: [0, 10],
  repeatBehaviorWeight: 0.35,
  behaviorWeights: {
    SitAndFaceMouse: 8,
  },
});

/**
 * Lively (Legacy Web Default) animation preset.
 * Retained for backward compatibility.
 */
export const LIVELY_ANIMATION_PRESET: Readonly<MascotAnimationOptions> = Object.freeze<MascotAnimationOptions>({
  activityLevel: "active",
  spawn: { topOffset: 100, staggerPx: 180 },
  forcedSwitchTicks: 300,
  pacerExemptBehaviors: ["SitWhileDanglingLegs"],
  exitToPoolBehaviors: ["SitWhileDanglingLegs"],
  maxBehaviorTicks: 1100,
  actionHoldLimits: {
    Stand: { ticks: [150, 250], waitPoses: [0, 2, 4] },
    Sit: { ticks: [200, 350], waitPoses: [0, 2, 4] },
    Sprawl: { ticks: [200, 350], waitPoses: [0, 2, 4] },
    GrabWall: { ticks: [200, 300], waitPoses: [0, 2, 4] },
    GrabCeiling: { ticks: [200, 300], waitPoses: [0, 2, 4] },
  },
  travelDwellTicks: [10, 25],
  repeatBehaviorWeight: 0.65,
  interactionCooldownTicks: 500,
  behaviorWeights: {
    SitWhileDanglingLegs: 150,
    SitAndFaceMouse: 8,
  },
});

/**
 * Default preset instance applied by the engine.
 */
export const ANIMATION_PRESET_DEFAULTS: MascotAnimationOptions = NORMAL_ANIMATION_PRESET;

/**
 * PresetRegistry — Decoupled repository of named animation presets.
 */
export class PresetRegistry {
  private static presets = new Map<string, MascotAnimationOptions>([
    ["normal", cloneOptions(NORMAL_ANIMATION_PRESET)],
    ["calm", cloneOptions(CALM_ANIMATION_PRESET)],
    ["active", cloneOptions(ACTIVE_ANIMATION_PRESET)],
    ["lively", cloneOptions(LIVELY_ANIMATION_PRESET)],
    ["classic", cloneOptions(CLASSIC_ANIMATION_PRESET)],
  ]);
  private static defaultPresetName = "normal";

  /** Register a custom preset. */
  public static register(name: string, preset: MascotAnimationOptions): void {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error("[PresetRegistry] Preset name cannot be empty");
    }
    PresetRegistry.presets.set(trimmed, cloneOptions(preset));
  }

  /**
   * Get an independent, mutable clone of a registered preset.
   * Modifying the returned object will NOT affect the registry.
   */
  public static get(name: string): MascotAnimationOptions | undefined {
    const found = PresetRegistry.presets.get(name.trim());
    return found ? cloneOptions(found) : undefined;
  }

  /** Check if a preset exists. */
  public static has(name: string): boolean {
    return PresetRegistry.presets.has(name.trim());
  }

  /** List all registered preset names. */
  public static list(): string[] {
    return Array.from(PresetRegistry.presets.keys());
  }

  /** Get the active default preset name. */
  public static getDefaultPresetName(): string {
    return PresetRegistry.defaultPresetName;
  }

  /** Set the active default preset name. */
  public static setDefaultPresetName(name: string): void {
    const trimmed = name.trim();
    if (!PresetRegistry.presets.has(trimmed)) {
      throw new Error(`[PresetRegistry] Preset "${name}" is not registered`);
    }
    PresetRegistry.defaultPresetName = trimmed;
  }
}

/**
 * Standard configuration template with exhaustive field-by-field annotations.
 */
export const STANDARD_CONFIG_SAMPLE = {
  $schema: "https://github.com/CommentOut64/web-mascot/blob/main/web-mascot/ANIMATION_CONFIG.md",
  version: 1,
  preset: "normal", // Base preset: "normal" (default web-tuned), "calm" (Qt desktop parity), "active" (high mobility)
  activityLevel: "normal" as ActivityLevel,
  respectReducedMotion: true, // Follow system prefers-reduced-motion (boolean, default true)
  defaults: {
    // --- 1. Pacing & Travel Limits ---
    // Request travel after 30s of stillness; finish finite behaviors and whole loops first.
    forcedSwitchTicks: 750,

    // Request a global-pool pick after 60s; never discard a finite sequence.
    maxBehaviorTicks: 1500,

    // [travelDwellTicks] Dwell duration in ticks after reaching target-x before the next action.
    travelDwellTicks: [25, 40],

    // Behaviors exempt from the travel request.
    pacerExemptBehaviors: ["SitWhileDanglingLegs"],

    // [exitToPoolBehaviors] Behaviors that return to global pool on end, breaking closed XML loops.
    exitToPoolBehaviors: ["SitWhileDanglingLegs", "LieDown"],

    // [maxTravelPx] Maximum horizontal wander travel distance in pixels. 0 = unlimited.
    maxTravelPx: 240,

    // --- 2. Behavior Selection & Duration Overrides ---
    // [behaviorWeights] Overrides XML <Behavior Frequency="...">. 0 = disable; >0 = enable/boost.
    behaviorWeights: {
      SitAndFaceMouse: 8,
    },

    // [actionDurations] Overrides XML <Action> duration for Stay actions. Single number or [min, max] range.
    actionDurations: {
      // Sit: [80, 150]
    },
    // Explicit idle wait poses share a budget; other poses retain native timing.
    actionHoldLimits: cloneOptions(NORMAL_ANIMATION_PRESET).actionHoldLimits,
    repeatBehaviorWeight: 0.4,

    // [durationScale] Multiplier applied to all XML Duration attributes (0.05 ~ 20.0, 1 = unscaled).
    durationScale: 1.0,

    // [allowBehaviors] Whitelist: only these behaviors may appear (empty/absent = all allowed).
    allowBehaviors: [] as string[],

    // [denyBehaviors] Blacklist: behaviors that never appear (takes precedence over allowBehaviors).
    denyBehaviors: [] as string[],

    // --- 3. Sizing & Geometry ---
    // [scale] Visual size multiplier (0.2 ~ 4.0, 1.0 = native 128 px sprite).
    scale: 1.0,

    // [spawn] Initial spawn location and multi-mascot displacement.
    spawn: {
      vertical: "top", // "top" (drop from ceiling) | "floor" (start on floor)
      x: "center", // Horizontal position: number (px), "50%", "center", "left", "right"
      topOffset: 100, // Pixels below work area top for "top" spawn
      staggerPx: 180, // Horizontal offset per already-spawned mascot to prevent stacking
    },

    // [zone] Activity bounding box (work area). Omit for full container.
    // zone: { left: 0, right: "100%", top: 0, bottom: "100%" },

    // --- 4. Partner Interactions ---
    // [scanDistancePx] Search radius (px) for partner advertisement detection (16 ~ 4096 px, default 256).
    scanDistancePx: 256,

    // [interactionCooldownTicks] Cooldown ticks after interaction before another can start.
    interactionCooldownTicks: 500,

    // [partnerWeights] Dynamic weights for partner-seeking behaviors based on presence & reachability.
    partnerWeights: {
      alone: 40, // When this mascot is the only one on page
      withPartner: 150, // When another mascot exists on page
      reachable: 1800, // When partner is on same surface within scanDistancePx
    },
  },
  mascots: {
    // Specific per-mascot overrides merged on top of defaults
    // Neuron: { ... },
    // Eviling: { ... }
  },
  reducedMotion: {
    // Options merged on top of defaults when OS asks for reduced motion
  },
};

/**
 * File shape emitted as `dist/animation.config.json` by the build.
 *
 * `defaults` is deliberately empty. The file's `defaults` layer is merged *on
 * top of* the base preset, so shipping a full copy of the normal preset here
 * would pin every timing value to "normal": switching to calm/active could no
 * longer change forcedSwitchTicks, actionHoldLimits or travelDwellTicks. Put
 * only genuine host overrides in this object; `STANDARD_CONFIG_SAMPLE` is the
 * annotated template that shows every field.
 */
export const ANIMATION_PRESET_FILE = {
  _readme: [
    "web-mascot 动画配置规范文件 (Standard Animation Configuration File)。",
    "引擎支持三档活跃度预设体系：",
    "  - preset: 'normal' (默认)：适度站立与静止，30秒静止后温和换位，位移到站驻留缓冲；",
    "  - preset: 'calm' (偏安静)：Qt 原版桌面从容发呆节奏，长时保持，不设换位催促；",
    "  - preset: 'active' (偏活跃)：高频游走，停顿极短，充满活力。",
    "defaults 只写你自己的覆盖项；不要整份拷贝某个预设，否则会锁死活跃度切换。",
    "字段详细说明与约束区间见 ANIMATION_CONFIG.md 与 src/core/animationPreset.ts。",
  ],
  version: 1,
  preset: "normal",
  respectReducedMotion: true,
  defaults: {},
  mascots: {},
  reducedMotion: {},
};
