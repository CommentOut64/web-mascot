import type { Hotspot } from "./Hotspot.js";

export interface Pose {
  image: string;
  imageAnchor: { x: number; y: number };
  velocity: { x: number; y: number };
  duration: number;
}

export interface AnimationVariant {
  condition?: string;
  poses: Pose[];
  /** Clickable regions of this animation (see Hotspot.ts). */
  hotspots?: Hotspot[];
}

export interface RelayFrameSnapshot {
  /** Exact source slot in the parent, distinct from this frame's execution cursor. */
  parentIndex: number;
  referenceDepth: number;
  nodeType: ActionType;
  nodeName?: string;
  nodeClassName?: string;
  childIndex: number;
  vars: Record<string, string>;
  resolved: Record<string, unknown>;
  elapsed: number;
  poseIndex: number;
  poseTick: number;
  animationIndex: number;
  stallTicks: number;
  progressX: number;
  progressY: number;
  durationLimit: number | null;
  /** Shortened holds wait for their active animation cycle, including after relay. */
  finishCycle?: boolean;
  conditions?: Record<string, boolean>;
  poseDurations?: number[];
}

export interface RelayVisualSnapshot {
  image: string;
  imageAnchor: { x: number; y: number };
  lookRight: boolean;
  /** Anchor position in screen pixels at the last painted frame. */
  screenX: number;
  screenY: number;
  scale: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface RelaySnapshot {
  schemaVersion: 2;
  pack: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  lookRight: boolean;
  behaviorName: string;
  behaviorId?: number;
  behaviorTicks: number;
  stillTicks: number;
  anchorStillTicks: number;
  area: { left: number; top: number; right: number; bottom: number };
  anchorX: "left" | "right" | "free";
  anchorY: "floor" | "ceiling" | "free";
  /** Partner relationships cannot be carried between documents. */
  interaction: boolean;
  frames: RelayFrameSnapshot[];
  visual?: RelayVisualSnapshot;
}


export type ActionType =
  | "Stay"
  | "Move"
  | "Animate"
  | "Embedded"
  | "Sequence"
  | "Select"
  | "ActionReference";

export interface ActionNode {
  name?: string;
  type: ActionType;
  className?: string; // For Embedded
  borderType?: string;
  condition?: string;
  duration?: string; // Evaluated at runtime
  loop?: boolean;
  poses?: Pose[]; // For Stay, Move, Embedded
  animations?: AnimationVariant[];
  children?: ActionNode[]; // For Sequence, Select
  referenceName?: string; // For ActionReference
  initialVX?: string; // Embedded args
  initialVY?: string;
  /** All XML attributes are retained because ActionReference overlays them
   * onto the referenced action (TargetX, LookRight, X/Y, custom variables...). */
  attributes?: Record<string, string>;
}

export interface BehaviorReference {
  name: string;
  frequency: number;
  condition?: string;
  /** Stable position in behaviors.xml, preserving duplicate names. */
  id?: number;
}

export interface Behavior {
  name: string;
  /** Stable position in behaviors.xml, preserving duplicate names. */
  id?: number;
  frequency: number;
  hidden: boolean;
  condition?: string; // <--- ADDED THIS to support parent <Condition> wrapper
  nextBehaviors: BehaviorReference[];
  addNext?: boolean;
}

export interface MascotConfig {
  actions: Record<string, ActionNode>;
  /** Every <Behavior> entry in document order. The same Name may legitimately
   *  appear more than once with a different Frequency/Condition (e.g.
   *  NoticeFallingTutel); Shimeji treats each entry as its own candidate, so
   *  they must not be collapsed into a map keyed by Name. */
  behaviors: Behavior[];
}

export interface BehaviorInfo {
  name: string;
  requiredSurface: "Floor" | "Wall" | "Ceiling" | null;
  /** Whether this behavior can immediately execute on the mascot's current surface. */
  available: boolean;
  hidden: boolean;
}

export interface ForceBehaviorOptions {
  /**
   * Whether to bypass surface constraint checking.
   * - `false` (default): if the target behavior cannot execute on the current surface, the call returns false.
   * - `true`: force switch to target behavior.
   */
  force?: boolean;
  /**
   * Whether to automatically snap/teleport the mascot to the target behavior's required surface.
   * Defaults to `true` when `force` is `true`; otherwise defaults to `false`.
   */
  snapToSurface?: boolean;
  /**
   * Optional reason identifier for logging and event observers. Defaults to `"manual-api"`.
   */
  reason?: string;
}
