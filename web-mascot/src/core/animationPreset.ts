/**
 * The engine's built-in animation preset — the defaults every host gets when it
 * configures nothing.
 *
 * This module is deliberately the *only* copy of these values:
 *
 *   - `AnimationConfig` imports `ANIMATION_PRESET_DEFAULTS` and applies it as the
 *     bottom layer of `optionsFor()`;
 *   - `vite.config.ts` emits `ANIMATION_PRESET_FILE` as `dist/animation.config.json`,
 *     the copy a host may take as a starting point (also exported as
 *     `web-mascot/animation.config.json`).
 *
 * so the shipped template and the default behaviour can never drift apart.
 *
 * The values are tuned for a *web page* rather than a desktop: a mascot that
 * stands still for more than a few seconds reads as broken, while the packs' own
 * long animations still have to be allowed to finish. Field-by-field rationale,
 * measurements and the "how lively vs. how Qt" trade-off live in
 * ANIMATION_CONFIG.md.
 */
import type { MascotAnimationOptions } from "./AnimationConfig.js";

/** The `defaults` block of the built-in preset. */
export const ANIMATION_PRESET_DEFAULTS: MascotAnimationOptions = {
  // Several mascots must not spawn on top of each other: 180 px is comfortably
  // more than the packs' 128 px sprite, so the offsets never overlap.
  spawn: { topOffset: 100, staggerPx: 180 },
  // 200 ticks = 8 s. Long enough to look calm, short enough that a visitor
  // notices the mascot is alive.
  forcedSwitchTicks: 200,
  // ...but the sit-and-dangle sequence is a long *stationary* animation, and the
  // pacer keys off movement rather than behaviour, so without the exemption it is
  // cut off mid-way and never plays through. The pool exit is its partner: the
  // packs chain SitAndFaceMouse with `Add="false"` into a closed loop, so a
  // mascot that sits down would otherwise never leave it again.
  pacerExemptBehaviors: ["SitWhileDanglingLegs"],
  exitToPoolBehaviors: ["SitWhileDanglingLegs"],
  // The pacer only acts on a stationary mascot; this is the cap for everything
  // else. It sits above the dangle sequence so that one still finishes.
  maxBehaviorTicks: 1100,
  // Both packs ship SitWhileDanglingLegs at 50, and it is the most characterful
  // thing they do, so it is worth raising. SitAndFaceMouse is lowered because it
  // is the entry to the closed chain above.
  behaviorWeights: {
    SitWhileDanglingLegs: 150,
    SitAndFaceMouse: 8,
  },
};

/**
 * The same preset in file shape, emitted as `dist/animation.config.json` by the
 * build. `_readme` is ignored by the parser (see `normalizeOptions`), exactly
 * like the labels inside the packs' own XML.
 */
export const ANIMATION_PRESET_FILE = {
  _readme: [
    "web-mascot 的默认动画配置档。",
    "引擎已经内建了下面这套默认值，所以本文件通常不必存在：配好精灵路径即可。",
    "要改某项，就把它写进 defaults —— 对象型字段（behaviorWeights/actionDurations/zone/spawn/partnerWeights）按 key 合并，数组与数值整体替换。",
    "要完全退回 pack 原生行为（无 pacer、无权重覆盖、无长序列豁免），写 ignoreBuiltin: true。",
    "字段逐条说明见 ANIMATION_CONFIG.md。",
  ],
  version: 1,
  respectReducedMotion: true,
  defaults: ANIMATION_PRESET_DEFAULTS,
  mascots: {},
};
