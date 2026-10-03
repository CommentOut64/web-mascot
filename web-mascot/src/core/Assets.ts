/**
 * Where the pack assets live, derived from the module's own URL.
 *
 * The derived URL is only valid while `dist/index.js` is served from its published
 * location — an unbundled bare-ESM host, or a CDN that mirrors the package
 * directory verbatim. A bundler (Vite, Webpack, …) relocates this module into its
 * own output (`node_modules/.vite/deps/…`, `_astro/<hash>.js`), where the derived
 * `<dir>/mascot_pack` does not exist, so every pack request 404s. That is the case
 * `configure({ assets })` exists for: bundled hosts copy `dist/mascot_pack/` into
 * their static root (usually `/mascot_pack`, i.e. `DEFAULT_PACK_BASE_URL`) and
 * point the engine at it.
 *
 * The build layout this is derived from (see `vite.config.ts`):
 *
 *     dist/index.js            ← entry
 *     dist/chunks/<name>.js    ← this module, when code-split
 *     dist/mascot_pack/Neuron/...  ← the assets
 *
 * so the package root is `<entry>/../` from an entry chunk and `<chunk>/../../`
 * from a split chunk. Rooting at the *directory* rather than reconstructing the
 * file name keeps working when the entry keeps its published directory depth, is
 * renamed, or is hashed — only the depth is assumed. Moving the module into a
 * different directory (which is what a bundler does) invalidates the result.
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
