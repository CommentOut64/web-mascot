import { MascotEngine } from "./core/MascotEngine.js";
import type { RuntimeOptions, RuntimeSnapshot } from "./core/MascotEngine.js";
import { defaultPackBaseUrl } from "./core/Assets.js";

/**
 * Public entry point of the web-mascot library.
 *
 * A host page imports this module and mounts one or more mascots into its own
 * DOM. Nothing here assumes the page is served from its root, and nothing has to
 * be configured to get started: the pack assets are addressed relative to this
 * module, so `dist/mascot_pack/` works from a CDN, a sub-path, or a bundler that
 * hashed the entry name.
 *
 *     import { createMascot } from "web-mascot";
 *
 *     const neuron = await createMascot({ container: document.body, pack: "Neuron" });
 *     // later
 *     neuron.destroy();
 *
 * `configure()` is therefore optional — it exists to *override* the derived
 * defaults (packs on a CDN, an animation config file, runtime tuning, logging).
 *
 * The observation log is deliberately *not* part of this entry point. It is a
 * development tool that writes through a Vite middleware endpoint, so it lives in
 * the `web-mascot/devtools` entry; see `src/devtools.ts`.
 */

/** The asset base URL derived from this module's own location. */
export const PACK_BASE_URL = defaultPackBaseUrl(import.meta.url);

// Make the derived URL the engine's default immediately, so a host that never
// calls `configure()` still gets working sprite URLs. This is an override of the
// engine's classic `/mascot_pack` fallback, not a user configuration: a later
// `configure({ assets })` still wins, because each mascot snapshots the value when
// it is constructed.
MascotEngine.configure({ packBaseUrl: PACK_BASE_URL });

/** Where the engine reads the packs and the editable configuration file from. */
export interface MascotConfig {
  /** Base URL that contains one directory per pack, without a trailing slash.
   *  Each mascot reads `<assets>/<pack>/img...`.
   *
   *  Omit it and the engine uses `PACK_BASE_URL`, derived from the installed
   *  package, so no configuration is needed for the common case. Set it when the
   *  packs are relocated (a CDN, a rewritten asset path, a data URL). */
  assets?: string;
  /** URL of the animation configuration JSON. Omit it and no file is fetched, so
   *  the packs keep their own settings. */
  animationConfigUrl?: string;
  /** Simulation tuning. See `RuntimeOptions`; omitted fields keep their defaults. */
  runtime?: RuntimeOptions;
}

export interface MascotOptions {
  /** Host element the mascot is anchored to. The mascot itself roams the whole
   *  viewport — this element decides *where in the document the mascot belongs*,
   *  and the engine pauses it while that element is scrolled out of view. */
  container: HTMLElement;
  /** Pack directory name, e.g. `"Neuron"`. `spriteUrl` reads `<assets>/<pack>/img/<pose>`. */
  pack: string;
}

let hasConfigured = false;

/**
 * Override the derived defaults. Entirely optional: calling nothing gives a
 * working mascot with the pack's own animation settings.
 *
 * The assets URL is snapshotted when each mascot is constructed, so changing it
 * later never leaves one mascot reading from a different pack root. Runtime tuning
 * is *not* snapshotted — it is read per tick, so a later change affects mascots
 * that are already on the page.
 */
export function configure(options: MascotConfig): void {
  hasConfigured = true;
  if (options.assets) {
    MascotEngine.configure({ packBaseUrl: options.assets, animationConfigUrl: options.animationConfigUrl });
  } else if (options.animationConfigUrl) {
    MascotEngine.configure({ animationConfigUrl: options.animationConfigUrl });
  }
  if (options.runtime) MascotEngine.setRuntimeOptions(options.runtime);
}

/** True once the host has explicitly configured something. Diagnostic only: a
 *  `false` here does not mean the engine is unconfigured, only that the derived
 *  defaults are in use. */
export function isConfigured(): boolean {
  return hasConfigured;
}

/** The asset base URL actually in effect (derived, or overridden). */
export function assetBaseUrl(): string {
  return MascotEngine.getPackBaseUrl();
}

/** The runtime tuning actually in effect. */
export function runtimeOptions(): RuntimeSnapshot {
  return MascotEngine.getRuntimeOptions();
}

/** One mounted mascot. `destroy()` releases its DOM, timers and observers. */
export class Mascot {
  /** The engine instance, exposed for the browser console and for hosts that
   *  need the simulation state (`snapshot()`, `position()`). */
  public readonly engine: MascotEngine;

  private destroyed = false;

  /** Use `createMascot()` instead of constructing this directly. */
  public constructor(engine: MascotEngine) {
    this.engine = engine;
  }

  /** Stable identity, also used to name this mascot's log file in dev builds. */
  public get label(): string {
    return this.engine.label;
  }

  /** Remove the mascot from the page. Safe to call more than once. */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.engine.destroy();
  }
}

/**
 * Create and mount a mascot, resolving once it has parsed its pack and drawn its
 * first frame. A pack that fails to load throws, and nothing is left behind on
 * the page.
 */
export async function createMascot(options: MascotOptions): Promise<Mascot> {
  const { container, pack } = options;
  if (!container) throw new Error("[web-mascot] createMascot() needs a container element");
  if (!pack) throw new Error("[web-mascot] createMascot() needs a pack name");

  const engine = new MascotEngine(container, pack);
  try {
    await engine.init();
  } catch (error) {
    engine.destroy();
    throw error;
  }
  return new Mascot(engine);
}

export { MascotEngine } from "./core/MascotEngine.js";
export type { RuntimeOptions, RuntimeSnapshot } from "./core/MascotEngine.js";
export { AnimationConfig } from "./core/AnimationConfig.js";
export { BroadcastManager } from "./core/Broadcast.js";
export { DEFAULT_PACK_BASE_URL, resolveAssetBase } from "./core/Assets.js";
export type { EngineEvent, EngineObserver } from "./core/MascotEngine.js";
export type { Pose, ActionNode, Behavior } from "./core/types.js";
export type { Hotspot } from "./core/Hotspot.js";
