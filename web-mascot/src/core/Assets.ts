/**
 * Where the pack assets live, without the host having to say so.
 *
 * The point of this module is `import`-and-go: a published package carries its own
 * `dist/mascot_pack/`, so the sprite URL can be derived from the module's own URL
 * instead of being guessed as `/mascot_pack` — which only works if the host
 * happens to serve the package at its document root, and 404s for every real
 * bundler or CDN. `configure({ assets })` still wins when a host relocates the
 * packs (a custom CDN, a rewritten asset path, an inline data URL).
 *
 * The build layout this is derived from (see `vite.config.ts`):
 *
 *     dist/index.js            ← entry
 *     dist/chunks/<name>.js    ← this module, when code-split
 *     dist/mascot_pack/Neuron/...  ← the assets
 *
 * so the package root is `<entry>/../` from an entry chunk and `<chunk>/../../`
 * from a split chunk. Rooting at the *directory* rather than reconstructing the
 * file name is deliberate: it keeps working when the entry is renamed, hashed, or
 * served through a CDN, because only the directory depth is assumed.
 */

/** Classic Vite public-dir location; the fallback when nothing can be derived. */
export const DEFAULT_PACK_BASE_URL = "/mascot_pack";

/**
 * The mascot pack root, derived from the module URL.
 *
 * `moduleUrl` is injectable on purpose: the caller passes `import.meta.url` of a
 * *bundled* module (where `import.meta` is legal), which keeps this function pure
 * and unit-testable from plain Node without a bundler.
 */
export function resolveAssetBase(moduleUrl?: string): string | undefined {
  if (!moduleUrl) return undefined;
  try {
    const url = new URL(moduleUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "file:") {
      return undefined;
    }
    // `new URL("./", <file>)` drops the file name and keeps the directory.
    return new URL("./", url).href;
  } catch {
    return undefined;
  }
}

/** The derived `<packageRoot>/mascot_pack`, or the classic fallback. */
export function defaultPackBaseUrl(moduleUrl?: string): string {
  const root = resolveAssetBase(moduleUrl);
  if (!root) return DEFAULT_PACK_BASE_URL;
  return `${root}mascot_pack`;
}
