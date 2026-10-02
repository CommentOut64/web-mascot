import { setLogSink, startMascotLogRecorder } from "./dev/MascotLogRecorder";
import type { MascotLogSink } from "./dev/MascotLogRecorder";

export { setLogSink, addLogSink } from "./dev/MascotLogRecorder";
export type { MascotLogSink, MascotLogBatch } from "./dev/MascotLogRecorder";

/**
 * Development entry point of the web-mascot library.
 *
 * This entry owns the observation log, kept out of the main entry by design: the
 * recorder is a development tool, and a published build should not make every
 * host page post to the dev endpoint unless the host asked for it.
 *
 *     import { attach } from "web-mascot/devtools";
 *
 *     attach();                                 // Vite dev/preview middleware
 *     attach({ consoleSink: true });             // console, no endpoint involved
 *     attach({ sink: (batch) => send(batch) });  // any other destination
 */

export interface DevtoolsOptions {
  /** Receives every batch. Omit it and the Vite dev/preview middleware endpoint
   *  is used; pass one and it takes precedence. */
  sink?: MascotLogSink;
  /** Write every batch to the console. Use it as a *replacement* destination — an
   *  embedded or packaged host has no `/__mascot-log` endpoint, so combining this
   *  with the endpoint would only produce 404s. */
  consoleSink?: boolean;
}

/** Where batches go when the host wants them on the console. */
const toConsole: MascotLogSink = ({ pet, lines }) => {
  for (const line of lines) console.info(`[mascot-log] ${pet} ${line}`);
};

/**
 * Start recording. With a sink, records are delivered to it; without one, the Vite
 * dev/preview middleware endpoint is used. Both options replace the endpoint rather
 * than mirroring to it: a host that supplies a destination does not want the
 * recorder hitting a route that does not exist.
 */
export function attach(options: DevtoolsOptions = {}): void {
  if (options.sink) setLogSink(options.sink);
  else if (options.consoleSink) setLogSink(toConsole);
  startMascotLogRecorder();
}
