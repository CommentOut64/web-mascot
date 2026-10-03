/**
 * The one logging front door for the whole library.
 *
 * Design goals, in priority order:
 *
 *  1. **Off costs nothing.** With no destination configured, `log()` returns on a
 *     single modulo check and every `logger` is the same inert object. Nothing
 *     allocates, nothing formats, nothing subscribes. Call sites can therefore be
 *     left in place permanently without paying for them — which is the whole
 *     reason this is a module of its own instead of `if (enabled) console.log()`.
 *  2. **On costs little.** A record is only formatted once a sink actually wants
 *     it, and only for sinks whose level admits it. Sinks are called directly, so
 *     the browser's own console (the expensive part, because devtools keeps the
 *     formatted text alive) is skipped entirely unless the console sink is on.
 *  3. **Destinations compose.** Console, a host-provided sink and the dev-server
 *     file endpoint are independent switches. The old API made `sink` and
 *     `consoleSink` mutually exclusive, which meant a host that wanted both had to
 *     write its own fan-out.
 *
 * Deliberately *not* here: buffering, batching, HTTP, file writing. A browser
 * cannot write files, so persistence is always a sink (see `vite-plugin-mascot-log`
 * for the dev-server one). Keeping this module DOM- and timer-free is what makes
 * the "off" path provably free.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/** Severity order; `sinks` are filtered with it. */
const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Which subsystem a record came from, so a sink can route by area. */
export type LogChannel = "engine" | "observe" | "logger";

export interface LogRecord {
  /** Monotonic milliseconds since the page's time origin. */
  t: number;
  level: LogLevel;
  channel: LogChannel;
  /** `[web-mascot]`-prefixed message, already interpolated. */
  message: string;
  /** Structured fields; omitted when the call site passed none. */
  data?: Record<string, unknown>;
}

export type LogSink = (record: LogRecord) => void;

/** A named destination plus its own level threshold. */
export interface LogSinkEntry {
  name: string;
  level: LogLevel;
  sink: LogSink;
}

export interface LogOptions {
  /**
   * Level for the console sink. `false` disables it, `true` means `"info"`.
   * The console is the only *display* destination; sinks are for transport.
   */
  console?: boolean | LogLevel;
  /** Extra destinations. They compose with the console and with each other. */
  sinks?: LogSinkEntry[];
  /** Level a record must reach before any sink is consulted. */
  level?: LogLevel;
  /**
   * Prefix for every message. `null` drops the prefix; a function can tag each
   * channel differently.
   */
  prefix?: string | null | ((channel: LogChannel) => string);
}

const now = () =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

/**
 * A logger handle. One exists per channel; all of them share the module state
 * below, so a level change applies everywhere at once.
 */
export class Logger {
  private readonly channel: LogChannel;

  /** @internal — hosts get handles from `loggerFor()`. */
  public constructor(channel: LogChannel) {
    this.channel = channel;
  }

  /** True when nothing would be emitted, including the console. Call sites may
   *  use it to skip building an expensive `data` object. */
  public get active(): boolean {
    return active;
  }

  public get level(): LogLevel {
    return currentLevel;
  }
  public debug(message: string, data?: Record<string, unknown>): void {
    if (!active || LEVEL_RANK.debug < threshold) return;
    emit("debug", this.channel, message, data);
  }

  public info(message: string, data?: Record<string, unknown>): void {
    if (!active || LEVEL_RANK.info < threshold) return;
    emit("info", this.channel, message, data);
  }

  public warn(message: string, data?: Record<string, unknown>): void {
    if (!active || LEVEL_RANK.warn < threshold) return;
    emit("warn", this.channel, message, data);
  }

  public error(message: string, data?: Record<string, unknown>): void {
    // `error` is the one level an enabled logger never filters out: a sink that
    // asked to be told about failures should not miss one because a threshold
    // was set for chatty debug output.
    if (!active) return;
    emit("error", this.channel, message, data);
  }
}

const loggers: Record<LogChannel, Logger> = {
  engine: new Logger("engine"),
  observe: new Logger("observe"),
  logger: new Logger("logger"),
};

export function loggerFor(channel: LogChannel): Logger {
  return loggers[channel];
}

/** Minimum rank a record needs before any sink is consulted. */
let currentLevel: LogLevel = "info";
let threshold = LEVEL_RANK.info;
let active = false;
let consoleEnabled = false;
let prefix: LogOptions["prefix"] = "[web-mascot]";
let sinks: LogSinkEntry[] = [];

const compact = (message: string, data?: Record<string, unknown>): string =>
  data ? `${message} ${safeJson(data)}` : message;

function safeJson(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data);
  } catch {
    // A cyclic or throwing toJSON must not turn a log call into an exception.
    return "[unserialisable]";
  }
}

function prefixFor(channel: LogChannel): string {
  const value = prefix;
  if (value === null || value === undefined) return "";
  if (typeof value === "function") {
    try {
      return value(channel);
    } catch {
      return "[web-mascot]";
    }
  }
  return value;
}

/** Rank the console sink needs; independent of the `sinks` thresholds. */
let consoleThreshold = LEVEL_RANK.info;

function emit(
  level: LogLevel,
  channel: LogChannel,
  message: string,
  data?: Record<string, unknown>,
): void {
  const record: LogRecord = { t: now(), level, channel, message: `${prefixFor(channel)} ${message}` };
  if (data !== undefined) record.data = data;

  // The console sink is handled separately because it has its own switch and
  // because the browser's console is the one destination worth avoiding: it
  // retains the formatted arguments for as long as devtools is open.
  if (consoleEnabled && LEVEL_RANK[level] >= consoleThreshold) {
    const text = data ? compact(record.message, data) : record.message;
    const method = level === "debug" ? "debug" : level;
    try {
      // eslint-disable-next-line no-console
      (console[method] ?? console.log)(text);
    } catch {
      /* a stubbed console must not break the caller */
    }
  }

  for (let index = 0; index < sinks.length; index++) {
    const entry = sinks[index]!;
    if (LEVEL_RANK[level] < LEVEL_RANK[entry.level]) continue;
    try {
      entry.sink(record);
    } catch {
      /* one throwing sink must not silence the others or the caller */
    }
  }
}

/**
 * Install the destinations. Called by `configure()`/`attach()`; also usable on
 * its own by a host that only wants library diagnostics.
 */
export function configureLogging(options: LogOptions): void {
  if (options.console === false || options.console === undefined) {
    consoleEnabled = false;
  } else {
    consoleEnabled = true;
    consoleThreshold = LEVEL_RANK[options.console === true ? "info" : options.console];
  }
  if (options.sinks) sinks = options.sinks.slice();
  if (options.level) {
    currentLevel = options.level;
    threshold = LEVEL_RANK[options.level];
  }
  if (options.prefix !== undefined) prefix = options.prefix;
  active = consoleEnabled || sinks.length > 0;
}

/** Stop emitting entirely. Everything keeps working; nothing is formatted. */
export function disableLogging(): void {
  active = false;
  consoleEnabled = false;
  sinks = [];
}

/** Current destinations, for diagnostics (`__mascotConfig.log()`). */
export function loggingState(): {
  active: boolean;
  console: boolean;
  prefix: string;
  sinks: string[];
} {
  return {
    active,
    console: consoleEnabled,
    prefix: typeof prefix === "function" ? "(function)" : String(prefix),
    sinks: sinks.map((entry) => `${entry.name}>=${entry.level}`),
  };
}

/** Convenience for a host that only wants the console. */
export function consoleSink(level: LogLevel = "info"): LogSinkEntry {
  return {
    name: "console",
    level,
    sink: (record) => {
      const text = record.data ? compact(record.message, record.data) : record.message;
      // eslint-disable-next-line no-console
      (console[record.level] ?? console.log)(text);
    },
  };
}
