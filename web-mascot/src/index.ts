import { MascotEngine } from "./core/MascotEngine.js";
import type { RuntimeOptions, RuntimeSnapshot } from "./core/MascotEngine.js";
import { defaultPackBaseUrl } from "./core/Assets.js";

/**
 * Public entry point of the web-mascot library.
 *
 * A host page imports this module and mounts one or more mascots into its own
 * DOM. The pack assets are addressed relative to this module by default, but that
 * derivation is only valid while this module file is served from its published
 * location. A bundler relocates it (`node_modules/.vite/deps/…`, `_astro/…`), and
 * then the derived URL points at a directory that does not exist, so every pack
 * request 404s. Bundled hosts must therefore copy `dist/mascot_pack/` into their
 * static root and say where it went:
 *
 *     import { configure, createMascot } from "web-mascot";
 *
 *     configure({ assets: "/mascot_pack" });   // before createMascot()
 *     const neuron = await createMascot({ container: document.body, pack: "Neuron" });
 *     // later
 *     neuron.destroy();
 *
 * So `configure()` is required for bundled hosts; it also overrides the animation
 * config file, runtime tuning and logging (packs served from a CDN, a rewritten
 * asset path, a data URL).
 *
 * Animation *behaviour* needs no configuration at all: the engine ships a built-in
 * preset (see `ANIMATION_CONFIG.md`). A config file overrides it field by field,
 * and `configure({ ignoreBuiltin: true })` drops it altogether so the packs behave
 * exactly as they ship.
 *
 * The observation log is deliberately *not* part of this entry point. It is a
 * development tool that writes through a Vite middleware endpoint, so it lives in
 * the `web-mascot/devtools` entry; see `src/devtools.ts`.
 */

/** The asset base URL derived from this module's own location. */
export const PACK_BASE_URL = defaultPackBaseUrl(import.meta.url);

// Make the derived URL the engine's default immediately. This is an override of
// the engine's classic `/mascot_pack` fallback, not a user configuration: a later
// `configure({ assets })` still wins, because each mascot snapshots the value when
// it is constructed.
//
// Caveat: the derived value is only correct while this module is served from its
// published location; bundled hosts must call `configure({ assets })` (see the
// entry-point note above). Because the derivation *succeeds* with a wrong URL
// under a bundler, `DEFAULT_PACK_BASE_URL` never gets a chance to act as a
// fallback — copying the packs to `/mascot_pack` alone is not enough.
MascotEngine.configure({ packBaseUrl: PACK_BASE_URL });

/** Where the engine reads the packs and the editable configuration file from. */
export interface MascotConfig {
  /** Base URL that contains one directory per pack, without a trailing slash.
   *  Each mascot reads `<assets>/<pack>/img...`.
   *
   *  **Bundled hosts must set this**, before `createMascot()`, to wherever the
   *  packs were copied (usually the site's static root, e.g. `"/mascot_pack"`).
   *  Omitting it falls back to `PACK_BASE_URL`, derived from this module's own
   *  location: correct only when that module is served from its published path
   *  (an unbundled bare-ESM host, or a CDN mirroring `dist/` verbatim). After
   *  bundling the derived URL points into the build output (`_astro/…`,
   *  `node_modules/.vite/deps/…`) and every pack request 404s. */
  assets?: string;
  /** URL of the animation configuration JSON. Omitting it probes the classic
   *  `/animation.config.json` once per page; if that file is absent nothing breaks
   *  and the built-in preset stays in effect. */
  animationConfigUrl?: string;
  /** Set true to drop the built-in animation preset and run the packs exactly as
   *  they ship: no pacer, no behaviour-weight overrides, no long-sequence
   *  exemption. Default false — the built-in preset is what a host gets when it
   *  configures nothing. Orthogonal to `animationConfigUrl`: this removes the
   *  layer underneath, it does not disable the file. */
  ignoreBuiltin?: boolean;
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
 * Override the derived defaults. Entirely optional: calling nothing still gives a
 * working mascot, with the engine's built-in animation preset.
 *
 * The assets URL is snapshotted when each mascot is constructed, so changing it
 * later never leaves one mascot reading from a different pack root. Runtime tuning
 * is *not* snapshotted — it is read per tick, so a later change affects mascots
 * that are already on the page. `ignoreBuiltin` lasts for the whole page.
 */
export function configure(options: MascotConfig): void {
  hasConfigured = true;
  if (options.assets || options.animationConfigUrl || options.ignoreBuiltin !== undefined) {
    MascotEngine.configure({
      packBaseUrl: options.assets,
      animationConfigUrl: options.animationConfigUrl,
      ignoreBuiltin: options.ignoreBuiltin,
    });
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
