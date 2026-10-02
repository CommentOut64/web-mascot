import { MascotEngine } from "./core/MascotEngine";

/**
 * Public entry point of the web-mascot library.
 *
 * A host page imports this module and mounts one or more mascots into its own
 * DOM. Nothing here assumes the page is served from its root: the pack base URL
 * is configuration, not a constant, so the same build works from a CDN, a
 * sub-path, or an npm package whose `mascot_pack/` the host serves itself.
 *
 *     import { configure, createMascot } from "web-mascot";
 *
 *     configure({ packBaseUrl: new URL("./mascot_pack", import.meta.url).href });
 *     const neuron = await createMascot({ container, pack: "Neuron" });
 *     // later
 *     neuron.destroy();
 *
 * The observation log is deliberately *not* part of this entry point. It is a
 * development tool that writes to a Vite middleware endpoint, so it lives in the
 * `web-mascot/devtools` entry; see `src/devtools.ts`.
 */

/** Where the engine reads the packs and the editable configuration file from. */
export interface MascotConfig {
  /** Base URL that contains one directory per pack, without a trailing slash.
   *  Each mascot reads `<packBaseUrl>/<pack>/img...`. */
  packBaseUrl?: string;
  /** URL of the animation configuration JSON. Omit it and no file is fetched, so
   *  the packs keep their own settings. */
  animationConfigUrl?: string;
}

export interface MascotOptions {
  /** Host element the mascot is anchored to. The mascot itself roams the whole
   *  viewport — this element decides *where in the document the mascot belongs*,
   *  and the engine pauses it while that element is scrolled out of view. */
  container: HTMLElement;
  /** Pack directory name, e.g. `"Neuron"`. `spriteUrl` reads `<pack>/img/<pose>`. */
  pack: string;
}

let hasConfigured = false;

/**
 * Point the engine at its assets and its configuration file. Call it before the
 * first mascot is created; the configuration file is fetched once and cached for
 * the page, so a later change only takes effect through the devtools console
 * helpers or `MascotEngine.reloadAnimationConfig()`.
 */
export function configure(options: MascotConfig): void {
  hasConfigured = true;
  MascotEngine.configure(options);
}

/** True once the host has pointed the engine at its own assets. */
export function isConfigured(): boolean {
  return hasConfigured;
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

export { MascotEngine } from "./core/MascotEngine";
export { AnimationConfig } from "./core/AnimationConfig";
export { BroadcastManager } from "./core/Broadcast";
export type { EngineEvent, EngineObserver } from "./core/MascotEngine";
export type { Pose, ActionNode, Behavior } from "./core/types";
export type { Hotspot } from "./core/Hotspot";
