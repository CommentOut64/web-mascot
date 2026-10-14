import type { RelaySnapshot } from "../../src/core/types.js";

export type SnapshotSubmission =
  | { status: "UNINITIALIZED" }
  | { status: "CLEARED" }
  | { status: "READY"; packs: string[]; pets: RelaySnapshot[] };

export interface LeaseReply {
  success: boolean;
  epoch: number;
  snapshots: RelaySnapshot[];
}

export function packsForMode(mode: string): string[] {
  return mode === "both" ? ["Neuron", "Eviling"] : [mode === "Eviling" ? "Eviling" : "Neuron"];
}

/** Incomplete loads and outdated configurations cannot replace a complete group. */
export function acceptsGroup(submission: SnapshotSubmission, expected: string[]): boolean {
  return submission.status === "READY" &&
    submission.packs.length === expected.length &&
    submission.pets.length === expected.length &&
    expected.every((pack) => submission.packs.filter((p) => p === pack).length === 1 &&
      submission.pets.filter((pet) => pet.pack === pack && pet.schemaVersion === 2).length === 1);
}
