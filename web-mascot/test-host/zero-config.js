/**
 * Unbundled-host verification page (bare ESM only).
 *
 * The one thing this proves, which `main.js` deliberately does *not*: a host that
 * never calls `configure()` still gets working sprites, because the asset base URL
 * is derived from the library module's own location. It also reports the derived
 * URL and proves the sprite actually decoded, so a silent 404 cannot pass.
 *
 * Scope: that only holds while the library module is served *in place* — this host
 * aliases the bare specifier to `dist/index.js` and serves `dist/mascot_pack` at
 * the derived URL. It says nothing about a bundler, which relocates the module and
 * therefore needs `configure({ assets })` (see `main.js` and the README).
 */
import { createMascot, PACK_BASE_URL, assetBaseUrl } from "web-mascot";

const status = document.getElementById("status");
const log = (message) => {
  if (status) status.textContent += `\n${message}`;
  console.log(`[zero-config] ${message}`);
};

log(`PACK_BASE_URL = ${PACK_BASE_URL}`);
log(`assetBaseUrl() = ${assetBaseUrl()}`);

const container = document.getElementById("anchor");

try {
  const mascot = await createMascot({ container, pack: "Neuron" });
  log(`mounted ${mascot.label}`);

  // The decisive check: a sprite fetched from the *derived* base must decode. If
  // the derivation were wrong this rejects, which is the whole point of this page.
  const probe = new Image();
  probe.src = `${assetBaseUrl()}/Neuron/img/shime1.png`;
  await probe.decode().then(
    () => log(`sprite OK ${probe.naturalWidth}x${probe.naturalHeight} from ${probe.src}`),
    () => log(`sprite FAILED from ${probe.src}`),
  );

  window.__zeroConfig = { mascot, PACK_BASE_URL, base: assetBaseUrl() };
} catch (error) {
  log(`createMascot threw: ${error}`);
}
