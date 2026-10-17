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

import type { MascotAnimationOptions } from "./AnimationConfig.js";

/** Deep-clone a MascotAnimationOptions object to prevent mutation leakage. */
export function cloneOptions(options: MascotAnimationOptions): MascotAnimationOptions {
  return {
    ...options,
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
 * Lively (Web Default) animation preset.
 *
 * Tuned specifically for web pages:
 * - Moderate hold budgets for known idle leaves; short transitions stay short.
 * - Pacer and age budgets request a pick at completion, never erase a finite sequence.
 * - Long performances retain their XML timing; repeated global picks are gently reduced.
 * - Loop breaker (exitToPoolBehaviors): breaks closed nextBehavior loops so pets don't get stuck sitting.
 * - Boosts selection weight for expressive actions.
 */
export const LIVELY_ANIMATION_PRESET: Readonly<MascotAnimationOptions> = Object.freeze<MascotAnimationOptions>({
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
  repeatBehaviorWeight: 0.65,
  behaviorWeights: {
    SitWhileDanglingLegs: 150,
    SitAndFaceMouse: 8,
  },
});

/**
 * Backward-compatible alias for the default preset.
 * @deprecated Use `LIVELY_ANIMATION_PRESET` or `PresetRegistry.get("lively")` instead.
 */
export const ANIMATION_PRESET_DEFAULTS: MascotAnimationOptions = LIVELY_ANIMATION_PRESET;

/**
 * PresetRegistry — Decoupled repository of named animation presets.
 */
export class PresetRegistry {
  private static presets = new Map<string, MascotAnimationOptions>([
    ["lively", cloneOptions(LIVELY_ANIMATION_PRESET)],
    ["classic", cloneOptions(CLASSIC_ANIMATION_PRESET)],
  ]);
  private static defaultPresetName = "lively";

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
  preset: "lively", // Base preset: "lively" (default web-tuned) or "classic" (Qt desktop parity)
  respectReducedMotion: true, // Follow system prefers-reduced-motion (boolean, default true)
  defaults: {
    // --- 1. Pacing & Travel Limits ---
    // Request travel after 12s of stillness; finish finite behaviors and whole loops first.
    forcedSwitchTicks: 300,

    // Request a global-pool pick after 44s; never discard a finite sequence.
    maxBehaviorTicks: 1100,

    // Behaviors exempt from the travel request.
    pacerExemptBehaviors: ["SitWhileDanglingLegs"],

    // [exitToPoolBehaviors] Behaviors that return to global pool on end, breaking closed XML loops.
    exitToPoolBehaviors: ["SitWhileDanglingLegs"],

    // [maxTravelPx] Maximum horizontal wander travel distance in pixels. 0 = unlimited.
    maxTravelPx: 240,

    // --- 2. Behavior Selection & Duration Overrides ---
    // [behaviorWeights] Overrides XML <Behavior Frequency="...">. 0 = disable; >0 = enable/boost.
    behaviorWeights: {
      SitWhileDanglingLegs: 150,
      SitAndFaceMouse: 8,
    },

    // [actionDurations] Overrides XML <Action> duration for Stay actions. Single number or [min, max] range.
    actionDurations: {
      // Sit: [80, 150]
    },
    // Explicit idle wait poses share a budget; other poses retain native timing.
    actionHoldLimits: cloneOptions(LIVELY_ANIMATION_PRESET).actionHoldLimits,
    repeatBehaviorWeight: 0.65,

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

    // [interactionCooldownTicks] Cooldown ticks after interaction before another can start (default 0).
    interactionCooldownTicks: 0,

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
 */
export const ANIMATION_PRESET_FILE = {
  _readme: [
    "web-mascot 动画配置规范文件 (Standard Animation Configuration File)。",
    "引擎支持双预设体系：",
    "  - preset: 'lively' (默认)：温和缩短已知保持段，完整播放表演；12秒静止后请求在完成点换位；",
    "  - preset: 'classic'：沿用素材原生时长与合法候选权重，不启用 pacer 或保持预算。",
    "你可以在本文件中基于 preset 微调 defaults，或在 mascots 中按宠物定制。",
    "字段详细说明与约束区间见 ANIMATION_CONFIG.md 与 src/core/animationPreset.ts。",
  ],
  version: 1,
  preset: "lively",
  respectReducedMotion: true,
  defaults: LIVELY_ANIMATION_PRESET,
  mascots: {},
  reducedMotion: {},
};
