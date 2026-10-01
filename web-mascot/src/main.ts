import { createApp } from "vue";
import App from "./App.vue";
import { MascotEngine } from "./core/MascotEngine";
import { startMascotLogRecorder } from "./dev/MascotLogRecorder";

/**
 * Observation log switch. Everything the recorder does lives in
 * src/dev/MascotLogRecorder.ts; with the flag below off (or with `?nolog` in the
 * URL) the mascot engine runs exactly as if the recorder did not exist, because
 * the engine only does extra work while an observer is subscribed.
 *
 *   npm run dev          -> <repo>/logs/<session>/pet-<n>-<mascot>.log
 *   http://127.0.0.1:5173/?nolog  -> no log files, no recorder
 */
const LOG_ENABLED = true;
const logDisabledByUrl = new URLSearchParams(location.search).has("nolog");
if (LOG_ENABLED && !logDisabledByUrl) startMascotLogRecorder();

/**
 * Animation customisation: `public/animation.config.json` by default, or any other
 * file with `?config=/my.config.json`. MascotEngine.init() also awaits this, so the
 * first tick already obeys it.
 *
 * Console helpers:
 *   __mascotConfig.get()            // effective settings (file shape)
 *   __mascotConfig.get("Neuron")    // resolved settings for one mascot
 *   __mascotConfig.set({...})       // apply an object live (wins over the file)
 *   __mascotConfig.reload()         // re-read the file from disk
 *   __mascotConfig.broadcasts()     // live affordance broadcasts (interactions)
 */
const configUrl = new URLSearchParams(location.search).get("config") ?? MascotEngine.ANIMATION_CONFIG_URL;
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
};

createApp(App).mount("#app");
