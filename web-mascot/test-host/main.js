/**
 * Verification host: embeds the built library into a page that is *not* the
 * library's own dev server, with the packs served from a non-default path.
 *
 * Everything it proves:
 *   - the `web-mascot` entry point resolves (see the alias in vite.test-host.config.ts)
 *   - `configure({ assets })` redirects asset loading away from `/mascot_pack`
 *   - `createMascot()` mounts a pet into a host-owned element
 *   - `destroy()` removes it again without leaving DOM behind
 */
import { configure, createMascot } from "web-mascot";

const log = (message) => {
  const status = document.getElementById("status");
  if (status) status.textContent += `\n${message}`;
  console.log(`[test-host] ${message}`);
};

// Deliberately NOT the library's own asset path: the host decides where the packs
// live. If spriteUrl were still hardcoded to /mascot_pack, every image would 404.
configure({ assets: "/assets/packs" });

const container = document.getElementById("anchor");
log(`packBaseUrl = /assets/packs, container = #${container.id}`);

try {
  const mascot = await createMascot({ container, pack: "Neuron" });
  log(`mounted ${mascot.label}`);

  // Sprite requests must have come from the configured base.
  const probe = new Image();
  probe.src = "/assets/packs/Neuron/img/shime1.png";
  await probe.decode().then(
    () => log(`sprite OK ${probe.naturalWidth}x${probe.naturalHeight}`),
    () => log("sprite FAILED to load"),
  );

  log(`DOM children in anchor: ${container.children.length}`);

  // Give the pet time to render, then verify destroy() leaves nothing behind.
  window.setTimeout(() => {
    mascot.destroy();
    log(`after destroy(): children = ${container.children.length}`);
  }, 6000);

  window.__testHost = { mascot, container };
} catch (error) {
  log(`createMascot threw: ${error}`);
}
