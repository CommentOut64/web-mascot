# web-mascot

**English** | [简体中文](README.md)

An embeddable, framework-agnostic browser mascot engine that lets you keep desktop pets inside any web page. It is a web port of NeurolingsCE-Qt / Shijima-Qt.

## 📖 Project Overview

This project brings the desktop mascot engine to the web browser. It allows you to embed interactive pets conforming to the [Shimeji](http://www.group-finity.com/Shimeji/) format standard into any web page. It requires no complex configuration or invasive integration to bring your web pages to life.

**Note:** The engine code itself is open-sourced under the GPL-3.0-or-later license, but the two bundled mascot packs (Neuron and Eviling) are protected by the `CC-BY-NC-SA-4.0` license, which **strictly prohibits commercial use**. Commercial projects must replace them with custom mascot assets. See the sub-project license file for details.

## ✨ Features

- **Lightweight integration**: copy the sprites into your static directory and point the engine at them with a single `configure()` call. In unbundled bare-ESM environments even that is optional — the module derives the asset base URL itself.
- **Framework-agnostic**: The core package is written in native JavaScript/TypeScript with zero runtime dependencies (does not depend on Vue/React) and can be seamlessly embedded into any web project.
- **Complete physical & interactive simulation**: Supports falling, horizontal/vertical resistance, dragging struggles, and perfectly restores the original grab and hotspot interaction experience.
- **Format-driven design**: Natively parses Shimeji XML (`actions.xml`, `behaviors.xml`) behavior chains and frame animation specifications.
- **Rich debugging support**: Includes an independent devtools entry, providing lifecycle probing, movement track recording, and behavior tree mutation logs.

## 🛠 Tech Stack

- **Core Language**: TypeScript
- **Build Tools**: Vite, vue-tsc (for build process only)
- **Module Output**: Pure ESM

---

## 🚀 Quick Start Guide

The following guide explains how to install the package from npm and implement the most basic mascot setup on your web page. **This guide is strictly aligned with the one in the npm package README.**

### 1. Installation

```bash
npm install web-mascot
```

### 2. 30-Second Setup

Copy the sprite directory out of the package into your site's public static directory, then point the engine at it — **before `createMascot()` is called**:

```bash
cp -r node_modules/web-mascot/dist/mascot_pack public/mascot_pack
```

```js
import { configure, createMascot } from "web-mascot";

// Under a sub-path deployment, include the prefix, e.g. "/blog/mascot_pack"
configure({ assets: "/mascot_pack" });

const mascot = await createMascot({ container: document.body, pack: "Neuron" });
// later: mascot.destroy() removes it (safe to call more than once)
```
*Tip: To switch to the other bundled pet, simply change the `pack` argument to `"Eviling"`. To load two (or more) pets at once, simply make multiple calls concurrently or sequentially (you only need to configure the assets path once):*

```js
// Load multiple pets concurrently
const [neuron, eviling] = await Promise.all([
  createMascot({ container: document.body, pack: "Neuron" }),
  createMascot({ container: document.body, pack: "Eviling" })
]);
// They share the BroadcastManager under the hood and will automatically interact when behaviors like "greeting" occur
```

> Note: the base URL derived from `import.meta.url` (`PACK_BASE_URL`) is only valid in unpackaged environments where the package directory is served verbatim (bare ESM, or a CDN that mirrors `dist/` as-is). Once a bundler pre-bundles or builds the module, the derived URL points into the build output (e.g. `node_modules/.vite/deps/mascot_pack`, `/_astro/mascot_pack`) and every pack request 404s — hence the explicit `configure({ assets })` above.
>
> Also note that `DEFAULT_PACK_BASE_URL` (`"/mascot_pack"`) only applies when the derivation fails outright. Under a bundler the derivation *succeeds with a wrong URL*, so that fallback never kicks in — copying the sprites to `/mascot_pack` alone is not enough.

### 3. Custom Configuration & Debugging (Important APIs)

If you wish to overwrite the asset server URL or need to enable the engine state debugging logs, you can use the `configure` and `devtools` exports as needed:

```js
import { configure, createMascot } from "web-mascot";
import { attach, configureLogging } from "web-mascot/devtools";

configure({
  assets: "https://cdn.example.com/mascot_pack",  // Replace with your own asset root
  animationConfigUrl: "/animation.config.json",
  runtime: { tickMs: 40 },                        // Unlisted fields will remain default
});

configureLogging({ console: "info" });                        // Library diagnostic logs
attach({ console: true, kinds: ["spawn", "behavior", "peer"] }); // Observation records

const mascot = await createMascot({
  container: document.querySelector("#pet-root"),
  pack: "Neuron",
});
```

📚 **Detailed API Documentation**
The above are only the most essential API integrations. For complete documentation on `MascotEngine` state snapshots, event listeners, and `RuntimeOptions`, developers should consult the [Detailed API documentation](web-mascot/docs/API.md) directly.

---

## 🙏 Acknowledgements

This project is a web port and continuation of the following excellent open-source projects. Special thanks to:
- [NeurolingsCE-Qt](https://github.com/qingchenyouforcc/NeurolingsCE-Qt) (by qingchenyou)
- [Shijima-Qt](https://github.com/pixelomer/Shijima-Qt) (by pixelomer)
- [libshijima](https://github.com/pixelomer/libshijima) (by pixelomer)

Thanks to the original [Shimeji](http://www.group-finity.com/Shimeji/) (Group Finity) for creating this classic desktop mascot interaction model.
