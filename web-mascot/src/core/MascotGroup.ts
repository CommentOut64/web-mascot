import { MascotEngine } from "./MascotEngine.js";
import type { BouncyOptions, ForceBehaviorOptions, RelaySnapshot } from "./types.js";
import type { ViewportHost } from "./ViewportHost.js";

export interface MascotGroupSpawnOptions {
  packs: string[];
  snapshots?: RelaySnapshot[];
  container?: HTMLElement;
  host?: ViewportHost;
  isClickThrough?: boolean;
  signal?: AbortSignal;
  scrollSquash?: boolean;
  bouncy?: boolean | BouncyOptions;
  bouncySquash?: boolean | BouncyOptions;
  onSpawned?: (pack: string, isRestored: boolean) => void;
  onFailed?: (pack: string, error: unknown) => void;
}

/**
 * Manages a cohesive group of mascots (e.g. companion pairs like Neuron & Eviling).
 * Coordinates parallel creation, synchronized start, bulk state snapshots and relay handoffs.
 */
export class MascotGroup {
  private activeEngines: MascotEngine[] = [];
  private spawnEpoch = 0;
  private spawnAbort: AbortController | null = null;
  private groupReady = false;
  private isClickThrough = false;
  private currentMode: string | null = null;

  public get engines(): readonly MascotEngine[] {
    return this.activeEngines;
  }

  public get isReady(): boolean {
    return this.groupReady;
  }

  public get count(): number {
    return this.activeEngines.length;
  }

  public get mode(): string | null {
    return this.currentMode;
  }

  public setMode(mode: string | null): void {
    this.currentMode = mode;
  }

  public findEngine(pack: string): MascotEngine | undefined {
    return this.activeEngines.find((e) => e.mascotName === pack);
  }

  /**
   * Fast resume: when instances already exist and match expected packs,
   * restore snapshots and resume without tearing down DOM or re-parsing XML.
   */
  public async fastResume(
    expectedPacks: string[],
    snapshots: RelaySnapshot[],
  ): Promise<boolean> {
    const packsMatch =
      this.groupReady &&
      this.activeEngines.length === expectedPacks.length &&
      expectedPacks.every((p) => this.activeEngines.some((e) => e.mascotName === p));

    if (!packsMatch) return false;
    if (!expectedPacks.every((pack) => snapshots.some((pet) => pet.pack === pack))) {
      return false;
    }

    this.groupReady = false;
    try {
      await Promise.all(
        this.activeEngines.map((engine) => {
          const snapshot = snapshots.find((pet) => pet.pack === engine.mascotName);
          return engine.prepareForRelay(snapshot!);
        })
      );
      this.groupReady = true;
      for (const engine of this.activeEngines) {
        engine.resumeForRelay();
      }
      return true;
    } catch (error) {
      this.groupReady = false;
      throw error;
    }
  }

  /**
   * Spawns a full group of mascots with race-condition protection and synchronized first-frame resume.
   */
  public async spawn(options: MascotGroupSpawnOptions): Promise<boolean> {
    const { packs, snapshots = [], container, host, isClickThrough = false, signal, onSpawned, onFailed } = options;

    // Clear existing mascots BEFORE claiming the epoch for this spawn. despawn()
    // bumps spawnEpoch and aborts spawnAbort, so capturing the epoch (or creating
    // the controller) first would make the guards below reject this very spawn:
    // every call would return false without constructing a single engine and any
    // relay placeholder would stay frozen on the page. despawn() already cancels
    // an older in-flight spawn, so no separate abort() is needed here.
    this.despawn();

    const currentEpoch = ++this.spawnEpoch;
    const abort = new AbortController();
    this.spawnAbort = abort;

    if (packs.length === 0) return false;

    // Show placeholders if host is provided
    if (host) {
      host.showPlaceholders(
        snapshots.filter((pet) => packs.includes(pet.pack)),
        MascotEngine.getPackBaseUrl()
      );
    }

    const targetContainer = container || (host ? host.ensureHost().container : null);
    if (!targetContainer) {
      throw new Error("[MascotGroup] No container or ViewportHost available for spawn");
    }

    this.isClickThrough = isClickThrough;

    for (let i = 0; i < packs.length; i++) {
      const pack = packs[i];
      if (currentEpoch !== this.spawnEpoch || abort.signal.aborted || signal?.aborted) {
        return false;
      }

      const saved = snapshots.find((r) => r.pack === pack);
      const initialSnapshot = saved && typeof saved.x === "number" && typeof saved.y === "number" ? saved : undefined;

      try {
        const engine = new MascotEngine(targetContainer, pack);
        const cancel = () => engine.destroy();
        abort.signal.addEventListener("abort", cancel, { once: true });
        signal?.addEventListener("abort", cancel, { once: true });

        try {
          await engine.init({
            initialSnapshot,
            startPaused: true,
            signal: abort.signal,
            enablePageCoordinator: false,
            scrollSquash: options.scrollSquash,
            bouncy: options.bouncy ?? options.bouncySquash ?? true,
          });
        } finally {
          abort.signal.removeEventListener("abort", cancel);
          signal?.removeEventListener("abort", cancel);
        }

        if (currentEpoch !== this.spawnEpoch || abort.signal.aborted || signal?.aborted) {
          engine.destroy();
          return false;
        }

        if (engine.elRoot) {
          engine.elRoot.style.zIndex = "2147483647";
          engine.setClickThrough(this.isClickThrough);
        }

        onSpawned?.(pack, Boolean(initialSnapshot));
        this.activeEngines.push(engine);
      } catch (err) {
        if (abort.signal.aborted || signal?.aborted || currentEpoch !== this.spawnEpoch) {
          return false;
        }
        onFailed?.(pack, err);
        this.despawn();
        throw err;
      }
    }

    if (currentEpoch === this.spawnEpoch && !abort.signal.aborted && this.activeEngines.length === packs.length) {
      this.groupReady = true;
      this.spawnAbort = null;
      for (const engine of this.activeEngines) {
        engine.resumeForRelay();
      }
      host?.clearPlaceholders();
      return true;
    }

    return false;
  }

  public pauseForRelay(): void {
    for (const engine of this.activeEngines) {
      engine.pauseForRelay();
    }
  }

  public resumeForRelay(): void {
    for (const engine of this.activeEngines) {
      engine.resumeForRelay();
    }
  }

  public createRelaySnapshots(): RelaySnapshot[] {
    return this.activeEngines.map((engine) => engine.createRelaySnapshot());
  }

  public setClickThrough(clickThrough: boolean): void {
    this.isClickThrough = clickThrough;
    for (const engine of this.activeEngines) {
      engine.setClickThrough(clickThrough);
    }
  }

  public setScrollSquash(enabled: boolean): void {
    for (const engine of this.activeEngines) {
      engine.setScrollSquash(enabled);
    }
  }

  public setBouncy(
    enabledOrOptions: boolean | BouncyOptions,
    options?: BouncyOptions,
    pack?: string,
  ): void {
    const targets = pack
      ? this.activeEngines.filter((e) => e.mascotName === pack)
      : this.activeEngines;
    for (const engine of targets) {
      engine.setBouncy(enabledOrOptions, options);
    }
  }

  public getBouncy(pack?: string): boolean {
    const target = pack
      ? this.activeEngines.find((e) => e.mascotName === pack)
      : this.activeEngines[0];
    return target ? target.getBouncy() : false;
  }

  public getBouncyOptions(pack?: string): BouncyOptions | undefined {
    const target = pack
      ? this.activeEngines.find((e) => e.mascotName === pack)
      : this.activeEngines[0];
    return target?.getBouncyOptions();
  }

  public setBouncySquash(
    enabledOrOptions: boolean | BouncyOptions,
    options?: BouncyOptions,
    pack?: string,
  ): void {
    this.setBouncy(enabledOrOptions, options, pack);
  }

  public getBouncySquash(pack?: string): boolean {
    return this.getBouncy(pack);
  }

  /**
   * Set behavior on active engines in this group.
   * If `pack` is specified, only targets that pack; otherwise targets all mascots in the group.
   * Returns true if at least one mascot switched behavior successfully.
   */
  public setBehavior(
    name: string,
    options?: ForceBehaviorOptions,
    pack?: string,
  ): boolean {
    const targets = pack
      ? this.activeEngines.filter((e) => e.mascotName === pack)
      : this.activeEngines;
    let anySuccess = false;
    for (const engine of targets) {
      if (engine.setBehavior(name, options)) {
        anySuccess = true;
      }
    }
    return anySuccess;
  }

  /**
   * Force behavior on active engines in this group (ignoring surface constraints and snapping by default).
   * If `pack` is specified, only targets that pack; otherwise targets all mascots in the group.
   * Returns true if at least one mascot switched behavior successfully.
   */
  public forceBehavior(
    name: string,
    options?: Omit<ForceBehaviorOptions, "force">,
    pack?: string,
  ): boolean {
    return this.setBehavior(name, { ...options, force: true }, pack);
  }

  public resetToSpawn(): void {
    for (let i = 0; i < this.activeEngines.length; i++) {
      this.activeEngines[i].resetToSpawn(i);
    }
  }

  public handleExternalScroll(delta: number, documentScroll = true): void {
    for (const engine of this.activeEngines) {
      engine.handleExternalScroll(delta, documentScroll);
    }
  }

  public resetScrollTracking(): void {
    for (const engine of this.activeEngines) {
      engine.resetScrollTracking();
    }
  }

  public despawn(): void {
    this.groupReady = false;
    ++this.spawnEpoch;
    this.spawnAbort?.abort();
    this.spawnAbort = null;
    for (const engine of this.activeEngines) {
      engine.destroy();
    }
    this.activeEngines = [];
  }

  public destroy(): void {
    this.despawn();
  }
}
