import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

async function bundle(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false,
    platform: "node", format: "cjs", logLevel: "silent" });
  return result.outputFiles[0].text;
}
const engineCode = await bundle("src/core/MascotEngine.ts");
const apiCode = await bundle("src/index.ts");
const backgroundCode = await bundle("extension/src/background.ts");

class Element {
  style = {};
  attributes = new Map();
  complete = true;
  naturalWidth = 128;
  naturalHeight = 128;
  addEventListener() {}
  appendChild(child) { child.parentNode = this; }
  removeChild(child) { child.parentNode = null; }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  set src(value) { this.attributes.set("src", value); }
  get src() { return this.getAttribute("src"); }
  async decode() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 }; }
}

function engineFixture(options = {}) {
  let rafs = 0;
  const events = new Map();
  const module = { exports: {} };
  const window = { innerWidth: 1000, innerHeight: 600, scrollY: 0,
    addEventListener(name, callback) { events.set(name, callback); }, setTimeout, clearTimeout };
  vm.runInNewContext(options.api ? apiCode : engineCode, { module, exports: module.exports, console, performance,
    window, document: { hidden: false, createElement: () => new Element(), addEventListener() {} },
    AbortController, fetch: options.fetch,
    requestAnimationFrame: () => ++rafs, cancelAnimationFrame() {} });
  const Engine = module.exports.MascotEngine;
  const pose = { image: "/stand.png", imageAnchor: { x: 64, y: 128 },
    velocity: { x: 0, y: 0 }, duration: 100 };
  const leaf = (name, type = "Stay") => ({ name, type, poses: [pose], attributes: {} });
  const reference = (name, attributes = {}) => ({ type: "ActionReference", referenceName: name, attributes });
  const actions = {
    Stand: leaf("Stand"), GrabWall: leaf("GrabWall"), GrabCeiling: leaf("GrabCeiling"),
    Falling: { ...leaf("Falling", "Embedded"), className: "test.Fall" },
    StandUp: { name: "StandUp", type: "Sequence", children: [reference("Stand")] },
    HoldOntoWall: { name: "HoldOntoWall", type: "Sequence", children: [reference("GrabWall")] },
    HoldOntoCeiling: { name: "HoldOntoCeiling", type: "Sequence", children: [reference("GrabCeiling")] },
    Fall: { name: "Fall", type: "Sequence", children: [reference("Falling")] },
  };
  const config = { actions, behaviors: Object.keys(actions).map((name, id) =>
    ({ name, id, frequency: 1, nextBehaviors: [] })) };
  const make = () => {
    const engine = new Engine(new Element(), "Neuron");
    engine.config = config;
    engine.x = 500; engine.y = 600;
    engine.prevX = 500; engine.prevY = 600;
    engine.setBehavior("StandUp", "test"); engine.advanceActionTree(); engine.renderNow();
    Engine.liveEngines.add(engine);
    return engine;
  };
  return { make, config, window, leaf, reference, events, Engine,
    createMascot: module.exports.createMascot, rafs: () => rafs };
}

test("resize immediately preserves floor contact and maps frozen targets before handoff", () => {
  const f = engineFixture(); const engine = f.make();
  engine.actionStack.at(-1).resolved.TargetX = 700;
  f.window.innerWidth = 1400; f.window.innerHeight = 620;
  f.events.get("resize")();
  const snapshot = engine.createRelaySnapshot();
  assert.equal(snapshot.y, 620); assert.equal(snapshot.anchorY, "floor");
  assert.equal(snapshot.x, 700); assert.equal(snapshot.frames.at(-1).resolved.TargetX, 980);
});

test("floor/ceiling/walls follow changed work area; targets use the same mapping", () => {
  const f = engineFixture(); const source = f.make();
  source.actionStack.at(-1).resolved.TargetX = 700;
  const snapshot = source.createRelaySnapshot();
  f.window.innerWidth = 1400; f.window.innerHeight = 620;
  const target = f.make(); assert.equal(target.restoreRelaySnapshot(snapshot), true);
  assert.equal(target.y, 620); assert.equal(target.x, 700);
  assert.equal(target.actionStack.at(-1).resolved.TargetX, 980);
  assert.equal(snapshot.frames.at(-1).resolved.TargetX, 700, "restoration must not mutate its input");
  source.area = () => ({ left: 100, right: 900, top: 50, bottom: 550 });
  source.x = 100; source.y = 50; source.prevX = 100; source.prevY = 50; source.renderNow();
  const custom = source.createRelaySnapshot();
  target.area = () => ({ left: 200, right: 1800, top: 80, bottom: 780 });
  target.restoreRelaySnapshot(custom);
  assert.equal(target.x, 200); assert.equal(target.y, 80);
});

test("anonymous Sequence and non-first Select children preserve exact paths and pose clocks", () => {
  const f = engineFixture();
  f.config.actions.Test = { name: "Test", type: "Sequence", children: [
    { type: "Sequence", condition: "false", children: [f.reference("Stand")] },
    { type: "Sequence", children: [{ type: "Select", children: [
      { ...f.reference("GrabWall"), condition: "false" }, f.reference("Stand", { Duration: "90" }),
    ] }] },
  ] };
  f.config.behaviors.push({ name: "Test", id: 100, nextBehaviors: [] });
  const source = f.make(); source.setBehavior("Test", "test"); source.actionExpansionsThisTick = 0;
  source.advanceActionTree();
  source.actionStack.at(-1).poseTick = 37;
  const snapshot = JSON.parse(JSON.stringify(source.createRelaySnapshot()));
  const target = f.make(); target.restoreRelaySnapshot(snapshot);
  assert.equal(target.currentBehavior.name, "Test");
  assert.equal(target.actionStack[1].node, f.config.actions.Test.children[1]);
  assert.equal(target.actionStack.at(-1).parentIndex, 1);
  assert.equal(target.actionStack.at(-1).node.name, "Stand");
  assert.equal(target.actionStack.at(-1).poseTick, 37);
  assert.equal(target.actionStack.at(-1).durationLimit, 90);
});

test("pending and expanded ActionReferences restore without extra expansion", () => {
  const f = engineFixture(); const source = f.make();
  source.setBehavior("StandUp", "pending");
  source.actionStack.push(source.newFrame(f.reference("Stand"), {}, {}, 0));
  source.actionStack[0].childIndex = 1;
  const snapshot = source.createRelaySnapshot();
  const target = f.make(); target.restoreRelaySnapshot(snapshot);
  assert.equal(target.actionStack.at(-1).node.type, "ActionReference");
  target.actionExpansionsThisTick = 0; target.advanceActionTree();
  assert.equal(target.actionStack.at(-1).node.name, "Stand");
});

test("warm restoration releases old broadcasts and ends interactions, matching cold restoration", () => {
  const f = engineFixture(); const source = f.make(); const snapshot = source.createRelaySnapshot();
  snapshot.interaction = true;
  let servers = 0, clients = 0, interactions = 0;
  const warm = f.make(); warm.actionStack.at(-1).server = { finalize() { servers++; } };
  warm.actionStack.at(-1).client = { finalize() { clients++; } };
  warm.interaction = { finalize() { interactions++; }, available: true };
  warm.restoreRelaySnapshot(snapshot);
  const cold = f.make(); cold.restoreRelaySnapshot(snapshot);
  assert.equal(servers, 1); assert.equal(clients, 1); assert.ok(interactions >= 1);
  assert.equal(warm.currentBehavior.name, cold.currentBehavior.name);
  assert.equal(warm.currentBehavior.name, "StandUp");
  assert.ok(warm.actionStack.every((frame) => !frame.server && !frame.client));
});

test("invalid action path takes one surface-aware fallback; invalid position leaves old state intact", () => {
  const f = engineFixture(); const source = f.make(); const snapshot = source.createRelaySnapshot();
  snapshot.frames.at(-1).parentIndex = 99;
  const target = f.make(); assert.equal(target.restoreRelaySnapshot(snapshot), true);
  assert.equal(target.currentBehavior.name, "StandUp");
  const old = target.actionStack;
  assert.equal(target.restoreRelaySnapshot({ ...snapshot, x: NaN }), false);
  assert.equal(target.actionStack, old);
});

test("preparation decodes a bitmap while paused; only explicit resume schedules simulation", async () => {
  const f = engineFixture(); const source = f.make(); const target = f.make();
  let decoded = false;
  target.elImg.decode = async () => { decoded = true; };
  await target.prepareForRelay(source.createRelaySnapshot());
  assert.equal(decoded, true); assert.equal(f.rafs(), 0);
  assert.equal(target.elRoot.style.visibility, "hidden");
  target.resumeForRelay(); assert.equal(f.rafs(), 1);
  assert.equal(target.elRoot.style.visibility, "visible");
});

test("failed first bitmap preparation stays hidden and never starts simulation", async () => {
  const f = engineFixture(); const source = f.make(); const target = f.make();
  target.elImg.decode = async () => { throw Error("missing sprite"); };
  await assert.rejects(target.prepareForRelay(source.createRelaySnapshot()), /missing sprite/);
  assert.equal(target.elRoot.style.visibility, "hidden");
  assert.equal(f.rafs(), 0);
});

test("cancelling creation aborts both XML requests and leaves no live engine or mounted DOM", async () => {
  let requests = 0, aborted = 0;
  const f = engineFixture({ api: true, fetch: (_, { signal }) => new Promise((_, reject) => {
    requests++;
    signal.addEventListener("abort", () => { aborted++; reject(signal.reason); }, { once: true });
  }) });
  f.Engine.loadAnimationConfig = async () => undefined;
  const container = new Element();
  const controller = new AbortController();
  const pending = f.createMascot({ container, pack: "Neuron", startPaused: true, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 2);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(aborted, 2); assert.equal(f.Engine.getInstances().length, 0);
  assert.equal(f.rafs(), 0);
});

function backgroundFixture(initial = {}) {
  let listener, storageListener, removedListener, now = 10000;
  const writes = [], transfers = [];
  const tabs = new Map([[1, { id: 1, windowId: 1, active: true }], [2, { id: 2, windowId: 1, active: false }],
    [3, { id: 3, windowId: 2, active: true }]]);
  const windows = new Map([[1, { focused: true }], [2, { focused: false }]]);
  const settings = { enabled: true, mascotMode: "Neuron", blacklist: [] };
  let delivery = () => Promise.reject(new Error("old document absent"));
  const event = { addListener() {} };
  const module = { exports: {} };
  vm.runInNewContext(backgroundCode, { module, exports: module.exports, console, setTimeout, clearTimeout,
    URL, Date: class extends Date { static now() { return now; } },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } },
      storage: { session: { async get() { return structuredClone({ mascotLeaseOwner: null,
        mascotLeaseEpoch: 0, mascotRelaySnapshots: [], ...initial }); },
        async set(state) { writes.push(structuredClone(state)); } }, local: { async get() { return settings; } },
        onChanged: { addListener(fn) { storageListener = fn; } } },
      tabs: { async get(id) { if (!tabs.has(id)) throw Error("closed"); return tabs.get(id); },
        async query() { return [...tabs.values()].filter((tab) => tab.active && windows.get(tab.windowId).focused); },
        sendMessage(id, message, options) { transfers.push({ id, message, options }); return delivery(id, message); },
        onActivated: event, onRemoved: { addListener(fn) { removedListener = fn; } } }, windows: { async getLastFocused() {
          const [id, window] = [...windows].find(([, window]) => window.focused);
          return { id, ...window };
        },
        onFocusChanged: event, onRemoved: event, WINDOW_ID_NONE: -1 } } });
  const sender = (id, documentId) => ({ tab: tabs.get(id), frameId: 0, documentId,
    documentLifecycle: "active", url: "https://example.test/page" });
  return { writes, transfers, tabs, windows, settings,
    advance(ms) { now += ms; }, deliver(fn) { delivery = fn; },
    send(id, documentId, message) { return new Promise((resolve) => listener(message, sender(id, documentId), resolve)); },
    change(changes) { storageListener(changes, "local"); },
    remove(id) { tabs.delete(id); removedListener(id); } };
}
const submission = (marker) => ({ status: "READY", packs: ["Neuron"],
  pets: [{ schemaVersion: 2, pack: "Neuron", marker }] });

test("uninitialized/partial/wrong-pack submissions preserve the last complete group", async () => {
  const b = backgroundFixture(); const grant = await b.send(1, "a", { type: "ACQUIRE_LEASE" });
  await b.send(1, "a", { type: "HEARTBEAT_SNAPSHOT", epoch: grant.epoch, submission: submission("good") });
  await b.send(1, "a", { type: "YIELD_LEASE", epoch: grant.epoch, submission: { status: "UNINITIALIZED" } });
  let next = await b.send(1, "b", { type: "ACQUIRE_LEASE" });
  assert.equal(next.snapshots[0].marker, "good");
  await b.send(1, "b", { type: "YIELD_LEASE", epoch: next.epoch,
    submission: { status: "READY", packs: ["Neuron"], pets: [] } });
  next = await b.send(1, "c", { type: "ACQUIRE_LEASE" });
  assert.equal(next.snapshots[0].marker, "good");
  await b.send(1, "c", { type: "YIELD_LEASE", epoch: next.epoch, submission: { status: "CLEARED" } });
  next = await b.send(1, "d", { type: "ACQUIRE_LEASE" });
  assert.equal(next.snapshots.length, 0);
});

test("old document cannot yield, overwrite, or heartbeat a new document in the same tab", async () => {
  const b = backgroundFixture(); const old = await b.send(1, "old", { type: "ACQUIRE_LEASE" });
  const current = await b.send(1, "new", { type: "ACQUIRE_LEASE" });
  assert.ok(current.epoch > old.epoch);
  const yieldReply = await b.send(1, "old", { type: "YIELD_LEASE", epoch: old.epoch, submission: { status: "CLEARED" } });
  assert.equal(yieldReply.leaseValid, false);
  const heartbeat = await b.send(1, "old", { type: "HEARTBEAT_SNAPSHOT", epoch: current.epoch, submission: submission("old") });
  assert.equal(heartbeat.leaseValid, false);
  assert.equal(b.writes.at(-1).mascotLeaseOwner.documentId, "new");
  assert.equal(b.transfers[0].options.documentId, "old");
});

test("YIELD wakes a pending transfer immediately; late pull response cannot roll state back", async () => {
  const b = backgroundFixture(); const grant = await b.send(1, "a", { type: "ACQUIRE_LEASE" });
  let reply;
  b.deliver(() => new Promise((resolve) => { reply = resolve; }));
  b.tabs.get(1).active = false; b.tabs.get(2).active = true;
  const acquiring = b.send(2, "b", { type: "ACQUIRE_LEASE" });
  await new Promise((resolve) => setImmediate(resolve));
  await b.send(1, "a", { type: "YIELD_LEASE", epoch: grant.epoch, submission: submission("latest") });
  const next = await acquiring;
  assert.equal(next.snapshots[0].marker, "latest");
  reply({ success: true, submission: submission("stale") });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(b.writes.at(-1).mascotRelaySnapshots[0].marker, "latest");
});

test("visible other window cannot steal ownership without focus; unacknowledged visible owner blocks transfer", async () => {
  const b = backgroundFixture(); await b.send(1, "a", { type: "ACQUIRE_LEASE" });
  let next = await b.send(3, "c", { type: "ACQUIRE_LEASE" });
  assert.equal(next.success, false);
  b.windows.get(1).focused = false; b.windows.get(2).focused = true;
  next = await b.send(3, "c", { type: "ACQUIRE_LEASE" });
  assert.equal(next.success, false, "failed delivery is not proof that a visible old owner stopped");
  b.deliver(async () => ({ success: true, submission: submission("transferred") }));
  next = await b.send(3, "c", { type: "ACQUIRE_LEASE" });
  assert.equal(next.success, true); assert.equal(next.snapshots[0].marker, "transferred");
});

test("heartbeat updates memory while session writes are throttled; worker restart recovers persisted state", async () => {
  const b = backgroundFixture(); const grant = await b.send(1, "a", { type: "ACQUIRE_LEASE" });
  const count = b.writes.length;
  for (let i = 0; i < 9; i++) {
    b.advance(500); await b.send(1, "a", { type: "HEARTBEAT_SNAPSHOT", epoch: grant.epoch, submission: submission(i) });
  }
  assert.equal(b.writes.length, count);
  const same = await b.send(1, "a", { type: "ACQUIRE_LEASE" });
  assert.equal(same.snapshots[0].marker, 8);
  b.advance(500); await b.send(1, "a", { type: "HEARTBEAT_SNAPSHOT", epoch: grant.epoch, submission: submission(9) });
  assert.equal(b.writes.length, count + 1);
  const restarted = backgroundFixture(b.writes.at(-1));
  const recovered = await restarted.send(1, "a", { type: "ACQUIRE_LEASE" });
  assert.equal(recovered.snapshots[0].marker, 9); assert.equal(recovered.epoch, grant.epoch);
});

test("closing the owner preserves checkpoints and wakes the remaining active tab", async () => {
  const b = backgroundFixture(); const grant = await b.send(1, "a", { type: "ACQUIRE_LEASE" });
  await b.send(1, "a", { type: "HEARTBEAT_SNAPSHOT", epoch: grant.epoch, submission: submission("last") });
  b.tabs.get(2).active = true;
  b.remove(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(b.writes.at(-1).mascotLeaseOwner, null);
  assert.equal(b.writes.at(-1).mascotRelaySnapshots[0].marker, "last");
  assert.equal(b.transfers.at(-1).message.type, "ACQUIRE_IF_FOCUSED");
  assert.equal(b.transfers.at(-1).id, 2);
});

test("timed-out visible handoff waits for acknowledgement and then permits recovery", async () => {
  const b = backgroundFixture(); await b.send(1, "a", { type: "ACQUIRE_LEASE" });
  b.windows.get(1).focused = false; b.windows.get(2).focused = true;
  let respond;
  b.deliver((_, message) => message.type === "PREPARE_TRANSFER"
    ? new Promise((resolve) => { respond = resolve; }) : Promise.resolve());
  const denied = await b.send(3, "c", { type: "ACQUIRE_LEASE" });
  assert.equal(denied.success, false);
  respond({ success: true, submission: submission("late-valid") });
  await new Promise((resolve) => setImmediate(resolve));
  const next = await b.send(3, "c", { type: "ACQUIRE_LEASE" });
  assert.equal(next.success, true);
  assert.equal(next.snapshots[0].marker, "late-valid");
});
