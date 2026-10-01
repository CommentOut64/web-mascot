/**
 * Clickable regions on a mascot sprite — the port of libshijima's `hotspot`.
 *
 * A hotspot is declared inside an `<Animation>` and triggers a behaviour when the
 * visitor presses the mouse button on that part of the sprite:
 *
 *   <Hotspot Shape="Ellipse" Origin="39,18" Size="46,27" Behavior="StandBlush"/>
 *
 * In the packs this is the "pet it and it blushes" interaction: the head of a
 * standing mascot maps to `StandBlush`, the body of a sitting one to
 * `SitDownBlush`, and so on. Those behaviours have `Frequency="0"` in
 * behaviours.xml, so a hotspot is the *only* way they can ever run.
 *
 * The geometry is kept pure (no DOM, no engine state) so it can be tested directly
 * against the pack data; `MascotEngine` supplies the sprite-local point.
 */

export interface Hotspot {
  shape: "Ellipse" | "Rectangle";
  /** Top-left of the region, in sprite (bitmap) pixels. */
  origin: { x: number; y: number };
  /** Full width/height of the region, in sprite pixels. */
  size: { x: number; y: number };
  /** Behaviour to run when the region is pressed. */
  behavior: string;
}

/** libshijima `hotspot::point_inside()`.
 *
 *  Note the ellipse divides by `size` itself, not by `size / 2`: the declared
 *  `Size` acts as the **semi-axis**, so the region actually tested is twice the
 *  declared size on each axis. The pack data is authored for that reading (a
 *  `Size="46,27"` head around `Origin="39,18"` covers roughly x 16–108, y 5–58 of
 *  a 128 px sprite, which is the head), and the comparison is a strict `< 1`. */
export function pointInHotspot(hotspot: Hotspot, point: { x: number; y: number }): boolean {
  const { x, y } = hotspot.origin;
  const { x: width, y: height } = hotspot.size;
  if (width <= 0 || height <= 0) return false;
  if (hotspot.shape === "Ellipse") {
    const nx = (point.x - (x + width / 2)) / width;
    const ny = (point.y - (y + height / 2)) / height;
    return nx * nx + ny * ny < 1;
  }
  return point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height;
}

/** The hotspot under a sprite-local point, or null. Later regions win, matching
 *  the order libshijima walks the animation's hotspot list in. */
export function hotspotAt(hotspots: readonly Hotspot[] | undefined, point: { x: number; y: number }): Hotspot | null {
  if (!hotspots) return null;
  let found: Hotspot | null = null;
  for (const hotspot of hotspots) {
    if (pointInHotspot(hotspot, point)) found = hotspot;
  }
  return found;
}
