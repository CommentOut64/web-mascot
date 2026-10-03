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
