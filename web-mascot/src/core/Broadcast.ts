/**
 * Affordance broadcasts — the port of libshijima's `broadcast/` subsystem.
 *
 * Two mascots can act on each other:
 *
 *   broadcast side  an action with an `Affordance` attribute advertises it
 *                   (`SitAffordance` broadcasts "CuddleNeuro");
 *   scan side       a `ScanMove` action asks the manager for a nearby broadcast
 *                   of the name it wants, walks to it, and on arrival both sides
 *                   switch to the behaviours named by their attributes
 *                   (`RunAffordance`: Behavior="IHugYou" TargetBehavior="IAmHugged");
 *   interaction     the two behaviours then run side by side while the shared
 *                   `ongoing` flag is set; whoever finishes first clears it and
 *                   ends the other side too.
 *
 * The constants and the merge rules are taken from the Qt sources:
 * `broadcast/manager.cc` (256 px scan distance, |Δy| ≤ 1), `server_state.hpp`
 * (availability / meet-up / ongoing flag), `client.cc`, `interaction.cc`.
 */

export interface Anchor {
  x: number;
  y: number;
}

/** libshijima `broadcast::server_state`. */
export class ServerState {
  public anchor: Anchor;
  public clientBehavior = "";
  public serverBehavior = "";
  private finalized = false;
  private available = true;
  private metUp = false;
  private shared: { value: boolean } | null = null;

  constructor(anchor: Anchor) {
    this.anchor = { ...anchor };
  }

  public get active(): boolean {
    return !this.finalized;
  }

  public get isAvailable(): boolean {
    return this.active && this.available;
  }

  /**
   * A scanner has claimed this advertisement and is on its way. libshijima has no
   * such state: the advertising animation ends when it wants to, the claim is
   * finalized with it, and the approaching scanner is dropped on its next tick.
   * The owner of the advertisement needs to be able to see the claim so it can
   * hold its pose until the partner arrives (see BroadcastManager).
   */
  public get isClaimed(): boolean {
    return this.active && !this.available && !this.metUp;
  }

  public get didMeetUp(): boolean {
    return this.metUp;
  }

  /** Keep the advertised position in sync with the broadcasting mascot. */
  public updateAnchor(anchor: Anchor): void {
    if (this.active) this.anchor = { ...anchor };
  }

  public notifyArrival(): void {
    this.metUp = true;
    this.finalized = true;
  }

  /** The action that advertised this affordance ended. */
  public finalize(): void {
    this.finalized = true;
  }

  public setAvailable(available: boolean): void {
    this.available = available;
  }

  public interaction(): Interaction {
    if (!this.shared) this.shared = { value: true };
    return new Interaction(this.shared, this.serverBehavior);
  }

  public ongoingPoint(): { value: boolean } {
    if (!this.shared) this.shared = { value: true };
    return this.shared;
  }
}

/** libshijima `broadcast::interaction`: the handshake both behaviours watch. */
export class Interaction {
  public started = false;
  private shared: { value: boolean } | null;
  private name: string;

  constructor(shared: { value: boolean } | null = null, behavior = "") {
    this.shared = shared;
    this.name = behavior;
  }

  public get available(): boolean {
    return this.shared !== null;
  }

  public get ongoing(): boolean {
    return this.shared !== null && this.shared.value;
  }

  public get behavior(): string {
    return this.name;
  }

  /** Ends the interaction for both sides. */
  public finalize(): void {
    if (this.shared) this.shared.value = false;
    this.shared = null;
    this.name = "";
    this.started = false;
  }
}

/** libshijima `broadcast::client`: one ScanMove action's link to a broadcast. */
export class ClientHandle {
  private server: ServerState | null;

  constructor(server: ServerState | null = null) {
    this.server = server;
  }

  public get connected(): boolean {
    return this.server !== null && this.server.active;
  }

  public get target(): Anchor | null {
    return this.server ? this.server.anchor : null;
  }

  public notifyArrival(): void {
    if (this.server) this.server.notifyArrival();
  }

  public interaction(): Interaction {
    return new Interaction(this.server ? this.server.ongoingPoint() : null, this.server ? this.server.clientBehavior : "");
  }

  /** Dropping the link frees the broadcast for another scanner. */
  public finalize(): void {
    if (this.server) this.server.setAvailable(true);
    this.server = null;
  }
}

/** libshijima `broadcast::manager`: shared by every mascot in the page. */
export class BroadcastManager {
  /** `broadcast/manager.cc`: ScanMove only claims a mascot that is already near. */
  public static readonly MAX_SCAN_DISTANCE = 256;
  private servers = new Map<string, ServerState[]>();

  /** Remove finalized advertisements that can no longer be reached. */
  public prune(): void {
    for (const [affordance, list] of this.servers) {
      const live = list.filter((server) => server.active);
      if (live.length === 0) this.servers.delete(affordance);
      else if (live.length !== list.length) this.servers.set(affordance, live);
    }
  }

  public startBroadcast(affordance: string, anchor: Anchor): ServerState {
    const server = new ServerState(anchor);
    const list = this.servers.get(affordance);
    if (list) list.push(server);
    else this.servers.set(affordance, [server]);
    return server;
  }

  public tryConnect(
    affordance: string,
    anchor: Anchor,
    clientBehavior: string,
    serverBehavior: string,
    maxDistance = BroadcastManager.MAX_SCAN_DISTANCE,
  ): ClientHandle | null {
    const list = this.servers.get(affordance);
    if (!list || list.length === 0) return null;
    const live = list.filter((server) => server.active);
    this.servers.set(affordance, live);

    let nearest: ServerState | null = null;
    let nearestDistance = maxDistance;
    for (const candidate of live) {
      if (!candidate.isAvailable) continue;
      if (Math.abs(anchor.y - candidate.anchor.y) > 1) continue;
      const distance = Math.abs(anchor.x - candidate.anchor.x);
      if (distance > maxDistance) continue;
      if (nearest === null || distance < nearestDistance) {
        nearest = candidate;
        nearestDistance = distance;
      }
    }
    if (!nearest) return null;

    nearest.clientBehavior = clientBehavior;
    nearest.serverBehavior = serverBehavior;
    nearest.setAvailable(false);
    return new ClientHandle(nearest);
  }

  /** Diagnostics for the observation log: what a scan would have seen. */
  public probe(affordance: string, anchor: Anchor): { live: number; nearest: number | null } {
    const live = (this.servers.get(affordance) ?? []).filter((server) => server.active);
    let nearest: number | null = null;
    for (const candidate of live) {
      const distance = Math.abs(anchor.x - candidate.anchor.x);
      if (nearest === null || distance < nearest) nearest = distance;
    }
    return { live: live.length, nearest };
  }

  /** Live broadcasts per affordance name, for the observation log. */
  public snapshot(): Record<string, number> {
    this.prune();
    const counts: Record<string, number> = {};
    for (const [affordance, list] of this.servers) {
      const live = list.filter((server) => server.active).length;
      if (live > 0) counts[affordance] = live;
    }
    return counts;
  }
}
