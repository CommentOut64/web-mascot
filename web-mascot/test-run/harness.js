/**
 * 30-minute run harness.
 *
 * Two recorders, on purpose:
 *
 *   L1  the product's own observation log (`attach()` -> /__mascot-log -> logs/),
 *       unchanged: 1 Hz positions + behaviour/pose/peer/lifecycle records.
 *   L2  this harness: `MascotEngine.addObserver` (every engine event, including
 *       the action-stack path and leaf) + a 10 Hz snapshot sampler, shipped to
 *       the trace server so a segment can be checked against what the action
 *       tree was actually doing.
 *
 * The page also owns the control panel, because the browser automation can only
 * click real DOM: every manual trigger (force behaviour, pair the two pets,
 * synthetic drag, poke) is a button, and every trigger writes a `mark` into the
 * trace so the analysis can drop that window from the randomness statistics.
 *
 *   /test-run/harness.html?import=dist     shipped build (default)
 *   /test-run/harness.html?import=src      dev sources
 */
const params = new URLSearchParams(location.search);
const mode = params.get("import") === "src" ? "src" : "dist";
const assets = params.get("assets") ?? "/mascot_pack";
const configUrl = params.get("config") ?? "/dist/animation.config.json";
const TRACE = params.get("trace") ?? "http://127.0.0.1:5401/trace";

const api = await (mode === "src" ? import("/src/index.ts") : import("/dist/index.js"));
const dev = await (mode === "src" ? import("/src/devtools.ts") : import("/dist/devtools.js"));
const { configure, createMascot, MascotEngine } = api;

const RUN = new Date().toISOString().replace(/[:.]/g, "-");
const T0 = performance.now();
const now = () => Math.round((performance.now() - T0) / 1000 * 1000) / 1000;

const $ = (id) => document.getElementById(id);
const meta = $("meta");
const statusEl = $("status");
const feedEl = $("feed");
const select = $("behavior");

const pets = new Map();
const buffers = new Map();
let sweeping = false;

function push(pet, record) {
  let buffer = buffers.get(pet);
  if (!buffer) buffers.set(pet, (buffer = []));
  buffer.push(JSON.stringify(record));
  if (buffer.length >= 400) void flush(pet);
}

async function flush(pet) {
  const buffer = buffers.get(pet);
  if (!buffer || buffer.length === 0) return;
  const lines = buffer.splice(0, buffer.length);
  try {
    await fetch(TRACE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session: RUN, pet, lines }),
      keepalive: true,
    });
  } catch {
    /* the trace server is optional; a failed batch must not break the page */
  }
}

function mark(note, extra = {}) {
  push("harness", { t: now(), k: "mark", note, ...extra });
  feed(`# mark ${note}`);
}

function feed(line) {
  const text = `${line}\n${feedEl.textContent}`.split("\n").slice(0, 14).join("\n");
  feedEl.textContent = text;
}

/* ------------------------------------------------------------------ L2 wiring */

MascotEngine.addObserver((engine, event) => {
  const pet = engine.snapshot().pet;
  const base = { t: now(), k: event.kind, pet };
  switch (event.kind) {
    case "behavior":
      push("events", { ...base, ...event, k: "behavior", x: round(event.x), y: round(event.y) });
      feed(`beh ${pet} ${event.from || "∅"}→${event.to} [${event.reason}]`);
      break;
    case "stack":
      push("events", { ...base, path: event.path, leaf: event.leaf, node: event.nodeType, cls: event.className, border: event.border, tx: n(event.targetX), ty: n(event.targetY), img: event.image, x: round(event.x), y: round(event.y) });
      break;
    case "image":
      push("events", { ...base, img: event.image, leaf: event.leaf, x: round(event.x), y: round(event.y) });
      break;
    case "spawn":
      push("events", { ...base, detail: event.detail });
      break;
    case "despawn":
      push("events", { ...base, detail: event.detail });
      feed(`despawn ${pet}`);
      break;
    case "suspect":
      push("events", { ...base, step: round(event.step), from: [round(event.px), round(event.py)], to: [round(event.x), round(event.y)] });
      feed(`SUSPECT ${pet} ${Math.round(event.step)}px`);
      break;
    case "milestone":
      {
        push("events", { ...base, name: event.name, detail: event.detail, affordance: event.affordance, behavior: event.behavior, x: round(event.x), y: round(event.y) });
        if (event.name === "tick-error" || event.name === "position-jump") feed(`!! ${event.name} ${pet} ${event.detail ?? ""}`);
      }
      break;
    default:
      break;
  }
});

const round = (value) => (typeof value === "number" ? Math.round(value * 100) / 100 : value);
const n = (value) => (typeof value === "number" ? round(value) : null);

/* ------------------------------------------- 10 Hz position/stack sampler */

setInterval(() => {
  for (const [pet, engine] of pets) {
    const snapshot = engine.snapshot();
    push("pos", {
      t: now(),
      k: "pos",
      pet,
      x: round(snapshot.x),
      y: round(snapshot.y),
      b: snapshot.behavior,
      leaf: snapshot.leaf,
      dep: snapshot.stackDepth,
      node: snapshot.nodeType,
      img: snapshot.image,
      drag: snapshot.dragging ? 1 : 0,
      tick: snapshot.tick,
      vis: document.visibilityState,
    });
  }
}, 1000 / Math.max(1, Math.min(25, Number(params.get("sampleHz")) || 10)));

/**
 * Frame-rate probe. The engine advances on requestAnimationFrame, so a throttled
 * or occluded window does not freeze it — it slows it down proportionally, and
 * every wall-clock duration in the log then reads 3–5x too long. This record is
 * what lets the analysis tell "the pet held a pose" from "the browser stopped
 * painting", and it is also the only place the run's real speed is provable.
 */
let frames = 0;
let frameWindowStart = performance.now();
const onFrame = () => {
  frames += 1;
  requestAnimationFrame(onFrame);
};
requestAnimationFrame(onFrame);
setInterval(() => {
  const at = performance.now();
  const elapsed = at - frameWindowStart;
  const count = frames;
  frames = 0;
  frameWindowStart = at;
  push("harness", {
    t: now(),
    k: "raf",
    frames: count,
    ms: Math.round(elapsed),
    fps: Math.round((count / elapsed) * 1000 * 10) / 10,
    vis: document.visibilityState,
    hidden: document.hidden ? 1 : 0,
  });
}, 5000);

setInterval(() => {
  for (const pet of buffers.keys()) void flush(pet);
  render();
}, 4000);

/* --------------------------------------------------------------- mounting */

let spawnChain = Promise.resolve();

function spawn(pack) {
  // Serialised, not guarded: two `createMascot()` calls must both run, but they
  // share a global asset base, so they are queued rather than raced.
  spawnChain = spawnChain.then(() => doSpawn(pack));
  return spawnChain;
}

async function doSpawn(pack) {
  try {
    mark(`spawn-request ${pack}`);
    const mascot = await createMascot({ container: document.body, pack });
    pets.set(mascot.label, mascot.engine);
    mark(`spawn-ok ${mascot.label}`);
    feed(`mounted ${mascot.label}`);
    describe();
    refreshBehaviors();
    render();
  } catch (error) {
    feed(`spawn FAILED ${pack}: ${error}`);
  }
}

/**
 * Build provenance: record which files this page actually loaded, so a later
 * claim ("this run used build X") is checkable instead of assumed. The chunk
 * name plus its content hash is what ties the run to a dist directory.
 */
async function probeBuild() {
  try {
    const indexText = await (await fetch("/dist/index.js", { cache: "no-store" })).text();
    const chunkName = /chunks\/([\w.-]+\.js)/.exec(indexText)?.[1] ?? "(none)";
    const chunkText = chunkName === "(none)" ? "" : await (await fetch(`/dist/chunks/${chunkName}`, { cache: "no-store" })).text();
    const sha = async (text) => {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    mark(`build chunk=${chunkName} chunkSha=${(await sha(chunkText)).slice(0, 16)} indexSha=${(await sha(indexText)).slice(0, 16)} bytes=${chunkText.length}`);
  } catch (error) {
    mark(`build probe-error ${error}`);
  }
}

function describe() {
  void probeBuild();
  const engine = [...pets.values()][0];
  if (!engine) return;
  const config = MascotEngine.getAnimationConfig().toJSON();
  push("harness", {
    t: now(),
    k: "meta",
    run: RUN,
    mode,
    assets,
    configUrl,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    dpr: window.devicePixelRatio,
    ua: navigator.userAgent,
    href: location.href,
    config: JSON.stringify(config),
    behaviors: JSON.stringify(engine.getBehaviors()),
    runtime: JSON.stringify(api.runtimeOptions()),
    assetBase: api.assetBaseUrl(),
  });
  meta.textContent = `${RUN}  mode=${mode}  assets=${assets}  dpr=${window.devicePixelRatio}  ${window.innerWidth}x${window.innerHeight}`;
}

function refreshBehaviors() {
  const engine = [...pets.values()][0];
  if (!engine) return;
  const current = select.value;
  select.innerHTML = "";
  for (const info of engine.getBehaviors()) {
    if (info.hidden) continue;
    const option = document.createElement("option");
    option.value = info.name;
    option.textContent = `${info.name}${info.requiredSurface ? ` [${info.requiredSurface}]` : ""}${info.available ? "" : " (不可用)"}`;
    select.append(option);
  }
  if (current) select.value = current;
}

/* -------------------------------------------------------------------- panel */

function render() {
  if (pets.size === 0) {
    statusEl.textContent = `(no pets)\nrun=${RUN}\nmode=${mode}\nt=${now()}s`;
    return;
  }
  const lines = [];
  for (const [pet, engine] of pets) {
    const s = engine.snapshot();
    lines.push(
      `${pet}\n` +
        `  beh  ${s.behavior}\n` +
        `  leaf ${s.leaf}\n` +
        `  dep  ${s.stackDepth}  node=${s.nodeType}\n` +
        `  pos  ${Math.round(s.x)},${Math.round(s.y)}  drag=${s.dragging ? "Y" : "n"}\n` +
        `  tick ${s.tick}  img=${s.image}`,
    );
  }
  lines.push(`t=${now()}s`);
  statusEl.textContent = lines.join("\n");
}

function sleeper(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function sweep() {
  if (sweeping) return;
  const engine = pets.get(select.dataset.pet ?? "") ?? [...pets.values()][0];
  if (!engine) return;
  sweeping = true;
  try { await runSweep([engine], () => sweeping); }
  finally { sweeping = false; mark("sweep-end"); }
}

$("spawn-neuron").addEventListener("click", () => void spawn("Neuron"));
$("spawn-eviling").addEventListener("click", () => void spawn("Eviling"));
$("clear").addEventListener("click", () => {
  mark("clear");
  for (const engine of pets.values()) engine.destroy?.();
  pets.clear();
  statusEl.textContent = "(cleared)";
});
$("force-neuron").addEventListener("click", () => forceOn("Neuron"));
$("force-eviling").addEventListener("click", () => forceOn("Eviling"));
$("sweep").addEventListener("click", () => void sweep());
$("sweep-stop").addEventListener("click", () => { sweeping = false; mark("sweep-stop"); });
$("mark").addEventListener("click", () => mark(`manual @${Date.now()}`));

function forceOn(pack) {
  const engine = [...pets.values()].find((e) => e.mascotName === pack);
  const name = select.value;
  if (!engine || !name) return;
  const ok = engine.forceBehavior(name);
  mark(`force ${engine.snapshot().pet} <- ${name} ok=${ok}`);
  push("harness", { t: now(), k: "force", pet: engine.snapshot().pet, name, ok });
}

$("pair").addEventListener("click", () => {
  const engines = [...pets.values()];
  if (engines.length < 2) {
    mark("pair-skipped (need 2 pets)");
    return;
  }
  // Same floor line, 180 px apart, kept clear of the right-hand panel.
  const pointX = Math.min(window.innerWidth - 560, 440);
  const pointY = window.innerHeight - 8;
  engines.forEach((engine, index) => {
    const scale = engine.spriteScale ?? 1;
    engine.x = (pointX + (index === 0 ? -90 : 90)) / scale;
    engine.y = pointY / scale;
    engine.relayJumpTo?.(engine.x, engine.y);
  });
  mark(`pair -> y=${Math.round(engines[0].position().y)} dx=180`);
  render();
});

$("drag").addEventListener("click", () => {
  const engine = [...pets.values()][0];
  if (!engine) return;
  const img = engine.elImg;
  const target = img ?? engine.elWrap ?? document.body;
  const point = engine.position();
  const send = (type, x, y) =>
    target.dispatchEvent(
      new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, isPrimary: true }),
    );
  mark(`drag-sim start at ${Math.round(point.x)},${Math.round(point.y)}`);
  send("pointerdown", point.x, point.y);
  let step = 0;
  const timer = setInterval(() => {
    step += 1;
    const x = point.x + step * 6;
    const y = point.y - step * 2;
    send("pointermove", x, y);
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: "mouse", buttons: 1 }));
    if (step >= 12) {
      clearInterval(timer);
      send("pointerup", x, y);
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: "mouse" }));
      mark("drag-sim end");
    }
  }, 125);
});

$("poke").addEventListener("click", () => {
  const engine = [...pets.values()][0];
  if (!engine) return;
  const point = engine.position();
  const img = engine.elImg ?? document.body;
  mark(`poke at ${Math.round(point.x)},${Math.round(point.y)}`);
  for (const type of ["pointerdown", "pointerup", "click"]) {
    img.dispatchEvent(new MouseEvent(type, { clientX: point.x, clientY: point.y, bubbles: true, cancelable: true, view: window }));
  }
});

/* ---------------------------------------------------------------- bootstrap */

configure({ assets, animationConfigUrl: configUrl });
dev.attach({ console: false, file: true });
mark(`boot mode=${mode}`);

// Leave the pets out of the panel's way.
const stage = $("stage");
stage.style.pointerEvents = "none";
void stage;

const autostart = params.get("autostart") ?? "";
if (autostart.split(",").includes("Neuron")) void spawn("Neuron");
if (autostart.split(",").includes("Eviling")) void spawn("Eviling");

/* ------------------------------------------------------- scripted plans */
/**
 * URL-driven runs, so a dedicated window can execute a plan unattended while the
 * browser-automation window is closed:
 *
 *   ?plan=sweep&hidden=1                observe each eligible behavior's exit
 *   ?plan=drill&rounds=8                pair the pets and walk both hug chains
 *
 * Every step writes a `mark`, so the analysis can subtract these windows from the
 * passive statistics instead of mistaking forced switches for natural ones.
 */
const plan = params.get("plan") ?? "";
const sleep = sleeper;

// Watchdogs are test failure bounds, never animation dwell or product timing.
const watchdogMs = Math.max(1000, Number(params.get("timeout")) || 180000);
function waitForEvent(engine, predicate) {
  return new Promise((resolve, reject) => {
    const stop = MascotEngine.addObserver((pet, event) => {
      if (pet !== engine || !predicate(event)) return;
      clearTimeout(timer); stop(); resolve(event);
    });
    const timer = setTimeout(() => {
      stop(); mark(`plan-fail timeout ${engine.snapshot().pet}`); reject(new Error(`Lifecycle timeout: ${engine.snapshot().pet}`));
    }, watchdogMs);
  });
}

function waitForEntryExit(engine) {
  let entered = false;
  return waitForEvent(engine, (event) => {
    if (event.kind !== "behavior") return false;
    if (!entered) { entered = true; return false; }
    return true;
  });
}

async function waitForPets(count) {
  for (let i = 0; i < 200 && pets.size < count; i++) await sleep(150);
}

function forceOnLabel(label, name) {
  const engine = pets.get(label);
  if (!engine) return false;
  const ok = engine.forceBehavior(name);
  push("harness", { t: now(), k: "force", pet: label, name, ok, plan });
  mark(`plan-force ${label} <- ${name} ok=${ok}`);
  return ok;
}

function pairEngines() {
  const engines = [...pets.values()];
  if (engines.length < 2) return;
  const pointX = Math.min(window.innerWidth - 560, 440);
  const pointY = window.innerHeight - 8;
  engines.forEach((engine, index) => {
    const scale = engine.spriteScale ?? 1;
    engine.x = (pointX + (index === 0 ? -90 : 90)) / scale;
    engine.y = pointY / scale;
  });
  mark(`plan-pair dx=180`);
}

async function runSweep(engines = [...pets.values()], keepGoing = () => true) {
  const includeHidden = params.get("hidden") === "1";
  if (engines.length === 0) return;
  mark(`plan-sweep start pets=${engines.length} lifecycle=true hidden=${includeHidden}`);
  for (const engine of engines) {
    const list = engine.config.behaviors.filter((info) => includeHidden || !info.hidden);
    mark(`plan-sweep pet=${engine.snapshot().pet} behaviors=${list.length}`);
    for (const behavior of list) {
      if (!keepGoing()) return;
      const action = engine.config.actions[behavior.name];
      if (!engine.behaviorUsable(behavior) || engine.needsPartnerToAct(behavior.name) ||
          engine.actionTreeMatches(action, (node) => engine.isDraggedAction(node) || engine.isResistAction(node))) {
        mark(`plan-sweep context-required ${engine.snapshot().pet} ${behavior.name} id=${behavior.id}`); continue;
      }
      const area = engine.area();
      let eligible = false;
      for (const [x, y] of [[(area.left + area.right) / 2, area.bottom], [area.left, (area.top + area.bottom) / 2],
        [area.right, (area.top + area.bottom) / 2], [(area.left + area.right) / 2, area.top]]) {
        for (const lookRight of [false, true]) {
          engine.x = x; engine.y = y; engine.lookRight = lookRight;
          if (engine.evaluateCondition(behavior.condition)) { eligible = true; break; }
        }
        if (eligible) break;
      }
      if (!eligible) { mark(`plan-sweep environment-required ${behavior.name} id=${behavior.id}`); continue; }
      const done = waitForEntryExit(engine);
      const ok = engine.setBehavior(behavior.name, { force: true, snapToSurface: true }, behavior.id);
      mark(`plan-force ${engine.snapshot().pet} ${behavior.name} id=${behavior.id} ok=${ok}`);
      const exit = await done;
      push("harness", { t: now(), k: "sweep-exit", pet: engine.snapshot().pet, name: behavior.name, id: behavior.id,
        reason: exit.reason, selectionPolicy: exit.selectionPolicy, ticks: exit.previousTicks });
    }
  }
  mark("plan-sweep end");
}

async function runDrill() {
  const rounds = Math.max(1, Number(params.get("rounds")) || 8);
  mark(`plan-drill start rounds=${rounds}`);
  for (let round = 0; round < rounds; round += 1) {
    const server = pets.get(round % 2 ? "1-Neuron" : "2-Eviling");
    const client = pets.get(round % 2 ? "2-Eviling" : "1-Neuron");
    // Hold the client while preparing the advertisement; do not overwrite it
    // with another advertiser or force the server into a scanning behavior.
    client.pauseForRelay();
    pairEngines();
    const offered = waitForEvent(server, (event) => event.kind === "milestone" && event.name === "broadcast-start");
    forceOnLabel(server.snapshot().pet, "AskForHugs");
    await offered;
    const arrived = waitForEvent(client, (event) => event.kind === "milestone" && event.name === "interaction-arrived");
    const serverEnd = waitForEvent(server, (event) => event.kind === "behavior" && event.reason === "behavior-end" && !server.interaction.ongoing);
    const clientEnd = waitForEvent(client, (event) => event.kind === "behavior" && event.reason === "behavior-end" &&
      !client.interaction.ongoing);
    forceOnLabel(client.snapshot().pet, round % 2 ? "HugNeuro" : "HugEvil");
    client.resumeForRelay();
    await arrived;
    await Promise.all([clientEnd, serverEnd]);
    mark(`plan-drill round ${round} done`);
  }
  mark("plan-drill end");
}

if (plan === "sweep") {
  void (async () => {
    await waitForPets(2);
    await runSweep();
  })();
}
if (plan === "drill") {
  void (async () => {
    await waitForPets(2);
    await runDrill();
  })();
}
/**
 * Remote-reservation drill: one pet advertises on the floor at one edge, the other
 * is placed at the opposite edge and forced to complete a behaviour, so the next
 * selection happens while a reachable offer exists. This is the only path the
 * passive run does not reliably produce on its own.
 */
if (plan === "remote") {
  void (async () => {
    await waitForPets(2);
    const server = pets.get("1-Neuron");
    const client = pets.get("2-Eviling");
    if (!server || !client) return;
    const floorY = window.innerHeight - 8;
    const place = (engine, px) => {
      const scale = engine.spriteScale ?? 1;
      engine.x = px / scale;
      engine.y = floorY / scale;
    };
    place(server, 900);
    place(client, 120);
    mark("plan-remote placed server@900 client@120");
    mark("plan-remote forcing server offer");
    forceOnLabel("1-Neuron", "AskForHugs");
    await sleep(1200);
    mark("plan-remote forcing client StandUp");
    forceOnLabel("2-Eviling", "StandUp");
    await sleep(400);
    // Selection is asserted from events only (`reserve` / `connect` / `arrive`);
    // engine internals are not part of the tested surface.
    try { client.onBehaviorEnd(); } catch (error) { mark(`plan-remote end-error ${error}`); }
    await sleep(14000);
    mark("plan-remote end");
  })();
}
