import { createApp } from "vue";
import App from "./App.vue";
import { MascotEngine } from "./core/MascotEngine";
import { attach } from "./devtools";
import { configureLogging, loggingState } from "./core/Logger";
import { isRecording } from "./dev/MascotLogRecorder";

/**
 * Two independent switches, deliberately configured in two places:
 *
 *   1. the **observation log** (`attach`) — where the mascots went, as JSON lines;
 *   2. the library's own **diagnostics** (`configureLogging`) — `[web-mascot] ...`
 *      messages about the engine itself.
 *
 * Both are off by default in the library; this dev app is the one place that turns
 * them on, so a published build is never chatty unless its host asks.
 *
 *   npm run dev                     -> console + web-mascot/logs/<session>/*.log
 *   http://127.0.0.1:5173/?nolog    -> nothing installed, zero cost
 */
const params = new URLSearchParams(location.search);
if (!params.has("nolog")) {
  // Diagnostics have their own entry, and their own verbosity.
  configureLogging({ console: "info" });
  attach({
    // Mirror the observation records to the console so a session can be watched
    // live, while the same records are appended to the session's log files.
    console: true,
    file: true,
  });
}

/**
 * Animation customisation: `public/animation.config.json` by default, or any other
 * file with `?config=/my.config.json`. MascotEngine.init() also awaits this, so
 * the first tick already obeys it.
 *
 * Console helpers:
 *   __mascotConfig.get()            // effective settings (file shape)
 *   __mascotConfig.get("Neuron")    // resolved settings for one mascot
 *   __mascotConfig.set({...})       // apply an object live (wins over the file)
 *   __mascotConfig.reload()         // re-read the file from disk
 *   __mascotConfig.broadcasts()     // live affordance broadcasts (interactions)
 *   __mascotConfig.log()            // log destinations and recording state
 */
const configUrl = params.get("config") ?? MascotEngine.ANIMATION_CONFIG_URL;
void MascotEngine.loadAnimationConfig(configUrl);
(window as unknown as { __mascotConfig: unknown }).__mascotConfig = {
  url: configUrl,
  get: (mascot?: string) => {
    const config = MascotEngine.getAnimationConfig();
    return mascot ? config.optionsFor(mascot) : config.toJSON();
  },
  set: (file: unknown) => MascotEngine.setAnimationConfig(file).toJSON(),
  reload: (url?: string) =>
    MascotEngine.reloadAnimationConfig(url ?? configUrl).then(() => MascotEngine.getAnimationConfig().toJSON()),
  broadcasts: () => MascotEngine.getBroadcasts().snapshot(),
  log: () => ({ ...loggingState(), recording: isRecording() }),
};

createApp(App).mount("#app");
