import type { RelaySnapshot } from "./types.js";

type Area = RelaySnapshot["area"];

export function mapRelayPoint(x: number, y: number, source: Area, target: Area) {
  return {
    x: target.left + (x - source.left) * (target.right - target.left) / (source.right - source.left),
    y: target.top + (y - source.top) * (target.bottom - target.top) / (source.bottom - source.top),
  };
}

export function relayPosition(snapshot: RelaySnapshot, target: Area) {
  const point = mapRelayPoint(snapshot.x, snapshot.y, snapshot.area, target);
  if (snapshot.anchorX === "left") point.x = target.left;
  if (snapshot.anchorX === "right") point.x = target.right;
  if (snapshot.anchorY === "ceiling") point.y = target.top;
  if (snapshot.anchorY === "floor") point.y = target.bottom;
  return point;
}
