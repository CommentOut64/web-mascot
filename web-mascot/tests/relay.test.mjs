import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { build, transform } from "esbuild";

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
  const document = { hidden: false, createElement: () => new Element(), addEventListener() {} };
  vm.runInNewContext(options.api ? apiCode : engineCode, { module, exports: module.exports, console,
    performance: options.performance ?? performance, window, document,
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
  return { make, config, window, document, leaf, reference, events, Engine,
    createMascot: module.exports.createMascot, rafs: () => rafs };
}

test("resize leaves position, velocity and frozen targets untouched; new space starts a fall", () => {
  const f = engineFixture(); const engine = f.make();
  f.config.actions.Stand.borderType = "Floor";
  engine.actionStack.at(-1).resolved.TargetX = 700;
  f.window.innerWidth = 1400; f.window.innerHeight = 620;
  f.events.get("resize")();
  const snapshot = engine.createRelaySnapshot();
  assert.equal(snapshot.y, 600); assert.equal(snapshot.anchorY, "free");
  assert.equal(snapshot.x, 500); assert.equal(snapshot.frames.at(-1).resolved.TargetX, 700);
  engine.tick(); assert.equal(engine.currentBehavior.name, "Fall");
  assert.equal(engine.y, 600, "losing support must not relocate the anchor");
  engine.tick(); assert.ok(engine.y > 600 && engine.y < 620);
});

function falling(f, x = 500, y = 300, vx = 0, vy = 0) {
  const engine = f.make();
  engine.x = x; engine.y = y; engine.prevX = x; engine.prevY = y;
  engine.setBehavior("Fall", "test"); engine.actionExpansionsThisTick = 0; engine.advanceActionTree();
  engine.vx = vx; engine.vy = vy;
  return engine;
}

test("rapid opposing scrolls leave the entire airborne trajectory and action clock unchanged", () => {
  const f = engineFixture(); const scrolling = falling(f, 500, -150, 3, -8);
  const control = falling(f, 500, -150, 3, -8);
  for (let i = 0; i < 40; i++) {
    for (const delta of [1, -1, 120, -120, 900, -900]) scrolling.handleExternalScroll(delta);
    scrolling.tick(); control.tick();
    assert.deepEqual([scrolling.x, scrolling.y, scrolling.vx, scrolling.vy, scrolling.stackPath()],
      [control.x, control.y, control.vx, control.vy, control.stackPath()]);
  }
});

test("document scroll is accumulated and rebased while gravity alone changes document motion", () => {
  const f = engineFixture(); const engine = f.make(); f.config.actions.Stand.borderType = "Floor";
  engine.handleExternalScroll(1); engine.handleExternalScroll(119);
  engine.applyScrollIntent();
  assert.equal(engine.y, 480); assert.equal(engine.prevY, 480);
  assert.equal(engine.vx, 0); assert.equal(engine.vy, 0); assert.equal(engine.currentLeaf().name, "Falling");
  const control = falling(f, 500, 480);
  let scrollY = 0;
  for (let i = 0; i < 10; i++) {
    const delta = i % 2 ? -20 : 40; scrollY += delta;
    engine.handleExternalScroll(delta); engine.tick(); control.tick();
    assert.ok(Math.abs(engine.y + scrollY - control.y) < 1e-9);
    assert.deepEqual([engine.x, engine.vx, engine.vy, engine.stackPath()],
      [control.x, control.vx, control.vy, control.stackPath()]);
  }
});

test("camera translation preserves interpolation, velocity and animation age between physics ticks", () => {
  const f = engineFixture(); const engine = falling(f, 500, 300, 3, 7);
  engine.prevY = 290; engine.accumulator = 20; engine.render(true);
  const before = engine.lastRenderedY; const state = engine.createRelaySnapshot();
  engine.handleExternalScroll(0.25); engine.handleExternalScroll(9.75); engine.applyScrollIntent(); engine.render(true);
  assert.equal(engine.lastRenderedY, before - 10);
  assert.equal(engine.y - engine.prevY, 10);
  assert.equal(engine.vy, 7); assert.equal(engine.vx, 3);
  assert.deepEqual(engine.createRelaySnapshot().frames, state.frames);
  engine.handleExternalScroll(-10); engine.applyScrollIntent(); engine.render(true);
  assert.equal(engine.lastRenderedY, before);
});

test("smooth downward scroll remains active after the first tiny event and follows paint before physics", () => {
  const f = engineFixture(); const engine = f.make();
  engine.lastTime = 0; engine.accumulator = 0;
  engine.handleExternalScroll(0.25); engine.loop(16);
  assert.equal(engine.tickCount, 0); assert.equal(engine.lastRenderedY, 599.75);
  assert.equal(engine.currentLeaf().name, "Falling");
  engine.handleExternalScroll(3.75); engine.handleExternalScroll(8); engine.loop(32);
  assert.equal(engine.lastRenderedY, 588); assert.equal(engine.vy, 0);
  engine.handleExternalScroll(20); engine.loop(48);
  assert.ok(engine.lastRenderedY < 570); assert.equal(engine.vy, 2);
});

test("opposing scroll before paint cancels instead of inventing a floor fall", () => {
  const f = engineFixture(); const engine = f.make();
  engine.handleExternalScroll(120); engine.handleExternalScroll(-120); engine.applyScrollIntent();
  assert.equal(engine.y, 600); assert.equal(engine.currentBehavior.name, "StandUp");
});

test("upward scroll meeting falling mascot triggers physical floor landing impact", () => {
  const f = engineFixture();
  f.config.actions.Land = { ...f.leaf("Land", "Animate"), borderType: "Floor" };
  f.config.actions.Fall.children.push(f.reference("Land"));
  const engine = falling(f, 500, 590, 0, 8);
  const events = []; f.Engine.addObserver((_, event) => events.push(event));
  engine.handleExternalScroll(-20); engine.tick();
  assert.equal(engine.y, 600); assert.equal(engine.prevY, 600);
  assert.equal(engine.currentLeaf().name, "Land");
  assert.equal(events.filter(e => e.name === "land").length, 1);
});

test("upward scroll releasing low wall climb lands with physical impact animation", () => {
  const f = engineFixture();
  f.config.actions.Land = { ...f.leaf("Land", "Animate"), borderType: "Floor" };
  f.config.actions.Fall.children.push(f.reference("Land"));
  f.config.actions.GrabWall.borderType = "Wall";
  const engine = f.make();
  engine.x = 0; engine.y = 590; engine.prevX = 0; engine.prevY = 590;
  engine.setBehavior("HoldOntoWall", "test"); engine.advanceActionTree();
  const events = []; f.Engine.addObserver((_, event) => events.push(event));
  engine.handleExternalScroll(-20); engine.tick();
  assert.equal(engine.y, 600);
  assert.equal(engine.currentLeaf().name, "Land");
  assert.equal(events.filter(e => e.name === "land").length, 1);
});

test("upward scroll on supported floor preserves standing without tripping", () => {
  const f = engineFixture();
  f.config.actions.Land = { ...f.leaf("Land", "Animate"), borderType: "Floor" };
  f.config.actions.Fall.children.push(f.reference("Land"));
  f.config.actions.Stand.borderType = "Floor";
  const engine = f.make();
  const events = []; f.Engine.addObserver((_, event) => events.push(event));
  for (let i = 0; i < 20; i++) {
    engine.handleExternalScroll(-50);
    engine.loop(16 * (i + 1));
    engine.tick();
    assert.equal(engine.y, 600);
    assert.notEqual(engine.currentLeaf().name, "Land");
    assert.equal(events.filter(e => e.name === "land").length, 0);
  }
});

test("upward page scroll and internal container scroll preserve floor support", () => {
  const f = engineFixture(); const engine = f.make(); f.config.actions.Stand.borderType = "Floor";
  for (let i = 0; i < 20; i++) {
    engine.handleExternalScroll(-120); engine.handleExternalScroll(120, false); engine.tick();
    assert.equal(engine.currentBehavior.name, "StandUp"); assert.equal(engine.y, 600);
  }
});

test("floor scroll converts screen pixels by scale and allows a large release above the viewport", () => {
  const f = engineFixture(); const engine = f.make();
  Object.defineProperty(engine, "spriteScale", { get: () => 2 });
  engine.x = 250; engine.y = 300; engine.prevY = 300;
  engine.handleExternalScroll(120); engine.applyScrollIntent();
  assert.equal(engine.y, 240); assert.equal(engine.prevY, 240);
  const other = f.make(); other.handleExternalScroll(900); other.applyScrollIntent();
  assert.equal(other.y, -300); assert.equal(other.currentBehavior.name, "Fall");
  other.tick(); assert.ok(other.y < 0 && other.y > -300);
});

test("floor release lands through the pack animation and fresh input can detach immediately", () => {
  const f = engineFixture(); f.config.actions.Land = { ...f.leaf("Land", "Animate"), borderType: "Floor" };
  f.config.actions.Fall.children.push(f.reference("Land"));
  const engine = f.make(); const events = []; f.Engine.addObserver((_, event) => events.push(event));
  engine.handleExternalScroll(120); engine.tick();
  assert.equal(events.filter((e) => e.name === "land").length, 0);
  for (let i = 0; i < 40 && engine.currentLeaf().name !== "Land"; i++) engine.tick();
  assert.equal(engine.y, 600); assert.equal(engine.currentLeaf().name, "Land");
  assert.equal(events.filter((e) => e.name === "land").length, 1);
  f.events.get("wheel")({ deltaY: 60 });
  engine.handleExternalScroll(60); engine.applyScrollIntent();
  assert.equal(engine.y, 540); assert.equal(engine.currentLeaf().name, "Falling");
});

test("decaying document scroll lands once and advances beyond the first impact pose", () => {
  for (const squash of [false, true]) {
    let now = 0;
    const f = engineFixture({ performance: { now: () => now } });
    f.config.actions.Land = { ...f.leaf("Land", "Animate"), borderType: "Floor", poses: [
      { ...f.config.actions.Stand.poses[0], image: "/impact-first.png", duration: 6 },
      { ...f.config.actions.Stand.poses[0], image: "/impact-next.png", duration: 100 },
    ] };
    f.config.actions.Fall.children.push(f.reference("Land"));
    const engine = falling(f, 500, 598, 0, 8); engine.setScrollSquash(squash);
    const events = []; f.Engine.addObserver((_, event) => events.push(event));
    const images = new Set();
    for (let i = 0; i < 40; i++) {
      now = (i + 1) * 16;
      engine.handleExternalScroll(0.8 * 0.9 ** i); engine.loop(now);
      images.add(engine.currentPose()?.image);
      if (i >= 2) assert.equal(engine.y, 600, "the easing tail must preserve floor support");
    }
    assert.equal(events.filter(e => e.name === "land").length, 1);
    assert.equal(engine.currentLeaf().name, "Land");
    assert.ok(images.has("/impact-next.png"), "impact animation must advance without restarting");
    assert.ok(engine.actionStack.at(-1).elapsed >= 6);
  }
});

test("one eased notch has a visible fall regardless of the starting physics phase", () => {
  for (const phase of [0, 8, 16, 24, 32, 39]) {
    let now = 0;
    const f = engineFixture({ performance: { now: () => now } });
    f.config.actions.Land = { ...f.leaf("Land", "Animate"), borderType: "Floor" };
    f.config.actions.Fall.children.push(f.reference("Land"));
    const engine = f.make(); engine.accumulator = phase; engine.lastTime = 0;
    const deltas = [1, 5, 10, 20, 20, 15, 10, 8, 5, 3, 2, 1];
    const impacts = []; let height = 0;
    f.Engine.addObserver((_, event) => { if (event.name === "land") impacts.push(now); });
    for (let i = 0; i < 80; i++) {
      now = (i + 1) * 16;
      if (i < deltas.length) engine.handleExternalScroll(deltas[i]);
      engine.loop(now); height = Math.max(height, 600 - engine.lastRenderedY);
    }
    assert.ok(height > 50, `phase=${phase}: a 100px notch must leave visible airtime, height=${height}`);
    assert.equal(impacts.length, 1, `phase=${phase}: only the real landing emits impact`);
    assert.ok(impacts[0] > 160, `phase=${phase}: the first tiny shift must not consume the notch`);
  }
});

test("a subpixel scroll responds immediately then settles without an impact animation", () => {
  let now = 0;
  const f = engineFixture({ performance: { now: () => now } });
  f.config.actions.Land = { ...f.leaf("Land", "Animate"), borderType: "Floor" };
  f.config.actions.Fall.children.push(f.reference("Land"));
  const engine = f.make(); engine.lastTime = 0; engine.accumulator = 0;
  const impacts = []; f.Engine.addObserver((_, event) => { if (event.name === "land") impacts.push(event); });
  engine.handleExternalScroll(0.25); now = 16; engine.loop(now);
  assert.equal(engine.lastRenderedY, 599.75, "the first delta must still be painted immediately");
  for (let i = 2; i < 40; i++) { now = i * 16; engine.loop(now); }
  assert.equal(impacts.length, 0);
  assert.equal(engine.y, 600); assert.equal(engine.currentBehavior.name, "StandUp");
});

test("scroll startup uses CSS height and cannot suppress a separate physical fall", () => {
  for (const scale of [0.5, 2]) {
    let now = 0;
    const f = engineFixture({ performance: { now: () => now } });
    f.config.actions.Land = { ...f.leaf("Land", "Animate"), borderType: "Floor" };
    f.config.actions.Fall.children.push(f.reference("Land"));
    const engine = f.make(); Object.defineProperty(engine, "spriteScale", { get: () => scale });
    const floor = engine.area().bottom; engine.y = engine.prevY = floor;
    engine.handleExternalScroll(1); engine.applyScrollIntent(); engine.tick();
    assert.equal(engine.currentLeaf().name, "Falling", "startup contact must not enter Land");
    now = 16; engine.handleExternalScroll(20); engine.applyScrollIntent();
    assert.ok((floor - engine.y) * scale >= 20, "scroll height must follow screen pixels");
    engine.vy = 100 / scale; engine.tick();
    assert.equal(engine.currentLeaf().name, "Land", "visible airtime must still land normally");
    // A new behavior must discard the startup exemption, even during the same scroll.
    engine.setBehavior("StandUp", "test"); engine.advanceActionTree();
    f.events.get("wheel")({ deltaY: 1 }); engine.handleExternalScroll(0.25); engine.applyScrollIntent();
    engine.setBehavior("Fall", "manual-test"); engine.advanceActionTree(); engine.vy = 8;
    engine.tick(); assert.equal(engine.currentLeaf().name, "Land");
  }
});

function scrollLanding(f) {
  f.config.actions.Land = { ...f.leaf("Land", "Animate"), borderType: "Floor" };
  f.config.actions.Fall.children.push(f.reference("Land"));
  const engine = falling(f, 500, 590, 0, 8);
  engine.handleExternalScroll(-20); engine.applyScrollIntent();
  assert.equal(engine.currentLeaf().name, "Land");
  return engine;
}

test("camera-induced landing protects its anchor, but fresh input releases on a tiny delta", () => {
  for (const [name, event] of [
    ["wheel", { deltaY: 1 }], ["touchmove", {}],
    ["keydown", { key: "ArrowDown" }], ["keydown", { key: " " }],
    ["pointerdown", { button: 0 }],
    ["pointermove", { buttons: 1, pointerType: "mouse", clientX: 10, clientY: 10 }],
  ]) {
    const f = engineFixture(); f.Engine.externalScroll = true;
    const engine = scrollLanding(f);
    const landed = engine.actionStack.at(-1);
    engine.handleExternalScroll(0.25); engine.applyScrollIntent(); engine.tick();
    assert.equal(engine.y, 600); assert.equal(engine.actionStack.at(-1), landed);
    // Suppressed movement must not be replayed when intent arrives before paint.
    engine.handleExternalScroll(40);
    f.events.get(name)(event); engine.applyScrollIntent();
    assert.equal(engine.y, 600, "intent alone must not move the mascot");
    engine.handleExternalScroll(0.25); engine.applyScrollIntent();
    assert.equal(engine.y, 599.75); assert.equal(engine.currentLeaf().name, "Falling");
  }
});

test("zoom, typing and unrelated key/pointer events do not rearm an easing tail", () => {
  const f = engineFixture(); const engine = scrollLanding(f);
  for (const [name, event] of [
    ["wheel", { ctrlKey: true, deltaY: 1 }], ["wheel", { deltaY: 0 }],
    ["keydown", { key: "a" }], ["keydown", { key: "ArrowDown", ctrlKey: true }],
    ["keydown", { key: " ", target: { tagName: "INPUT" } }],
    ["keydown", { key: "ArrowDown", target: { isContentEditable: true } }],
    ["pointerdown", { button: 2 }],
    ["pointermove", { buttons: 0, pointerType: "mouse", clientX: 10, clientY: 10 }],
  ]) {
    f.events.get(name)(event); engine.handleExternalScroll(0.25); engine.applyScrollIntent();
    assert.equal(engine.y, 600); assert.equal(engine.currentLeaf().name, "Land");
  }
});

test("per-frame scrollend from script easing cannot repeatedly unlock a landing", () => {
  let now = 0;
  const f = engineFixture({ performance: { now: () => now } }); f.window.onscrollend = null;
  const engine = scrollLanding(f);
  for (let i = 0; i < 100; i++) {
    now += 16;
    f.events.get("scrollend")?.({ target: f.document });
    engine.handleExternalScroll(0.25); engine.applyScrollIntent();
    assert.equal(engine.y, 600); assert.equal(engine.currentLeaf().name, "Land");
  }
  now += 201;
  engine.handleExternalScroll(0.25); engine.applyScrollIntent();
  assert.equal(engine.y, 599.75); assert.equal(engine.currentLeaf().name, "Falling");
});

test("the next script scroll after an idle gap responds immediately without scrollend", () => {
  let now = 0;
  const f = engineFixture({ performance: { now: () => now } }); const engine = scrollLanding(f);
  now = 100; engine.handleExternalScroll(10); engine.applyScrollIntent();
  assert.equal(engine.y, 600);
  now = 301; engine.handleExternalScroll(0.25); engine.applyScrollIntent();
  assert.equal(engine.y, 599.75); assert.equal(engine.currentLeaf().name, "Falling");
});

test("landing protection leaves airborne camera tracking and upward floor squash active", () => {
  const f = engineFixture(); const engine = scrollLanding(f); engine.setScrollSquash(true);
  engine.handleExternalScroll(-20); engine.applyScrollIntent();
  assert.equal(engine.y, 600); assert.ok(engine.squashAmount > 0);
  engine.y = engine.prevY = 300; engine.setBehavior("Fall", "test"); engine.advanceActionTree();
  engine.vy = 7;
  engine.handleExternalScroll(0.25); engine.applyScrollIntent();
  assert.equal(engine.y, 299.75); assert.equal(engine.prevY, 299.75); assert.equal(engine.vy, 7);
});

test("reset, pause and drag discard the previous scroll landing protection", () => {
  for (const boundary of ["reset", "pause", "drag"]) {
    const f = engineFixture(); const engine = scrollLanding(f);
    if (boundary === "reset") engine.resetToSpawn();
    if (boundary === "pause") {
      engine.setPauseReason("hidden", true); engine.setPauseReason("hidden", false);
    }
    if (boundary === "drag") { engine.beginDrag(500, 500); engine.isDragging = false; }
    engine.y = engine.prevY = 600; engine.setBehavior("StandUp", "test"); engine.advanceActionTree();
    engine.handleExternalScroll(0.25); engine.applyScrollIntent();
    assert.equal(engine.y, 599.75); assert.equal(engine.currentLeaf().name, "Falling");
  }
});

test("pause clears camera movement and changed support does not restart an existing fall", () => {
  const f = engineFixture(); const engine = f.make();
  engine.handleExternalScroll(120); engine.setPauseReason("hidden", true); engine.setPauseReason("hidden", false);
  engine.applyScrollIntent(); assert.equal(engine.y, 600);
  engine.handleExternalScroll(120); engine.setBehavior("Fall", "test"); engine.advanceActionTree();
  engine.y = 400; engine.vy = 8; engine.applyScrollIntent();
  assert.equal(engine.y, 280); assert.equal(engine.vy, 8);
});

test("internal container scroll releases wall/ceiling without translating the document or resetting fall", () => {
  for (const [behavior, border, x, y] of [
    ["HoldOntoWall", "Wall", 0, 250], ["HoldOntoWall", "Wall", 1000, 250],
    ["HoldOntoCeiling", "Ceiling", 500, 0],
  ]) {
    const f = engineFixture(); const engine = f.make();
    f.config.actions[border === "Wall" ? "GrabWall" : "GrabCeiling"].borderType = border;
    engine.x = x; engine.y = y; engine.setBehavior(behavior, "test"); engine.advanceActionTree();
    engine.handleExternalScroll(1, false); engine.applyScrollIntent();
    assert.equal(engine.x, x); assert.equal(engine.y, y);
    assert.equal(engine.currentBehavior.name, "Fall"); assert.equal(engine.surfaceAt(), null);
    for (let i = 0; i < 8; i++) { engine.handleExternalScroll(i % 2 ? 120 : -120, false); engine.tick(); }
    assert.equal(engine.x, x); assert.ok(engine.y > y); assert.equal(engine.currentBehavior.name, "Fall");
  }
});

test("scroll input is discarded across dragging, reset and pause boundaries", () => {
  const f = engineFixture(); const engine = f.make(); f.config.actions.GrabWall.borderType = "Wall";
  engine.x = 0; engine.y = 200; engine.setBehavior("HoldOntoWall", "test"); engine.advanceActionTree();
  engine.handleExternalScroll(120); engine.resetScrollTracking(); engine.applyScrollIntent();
  assert.equal(engine.currentBehavior.name, "HoldOntoWall");
  engine.isDragging = true; engine.handleExternalScroll(120); engine.isDragging = false;
  engine.applyScrollIntent(); assert.equal(engine.currentBehavior.name, "HoldOntoWall");
  engine.setPauseReason("hidden", true); engine.handleExternalScroll(120);
  engine.setPauseReason("hidden", false); engine.applyScrollIntent();
  assert.equal(engine.currentBehavior.name, "HoldOntoWall");
});

test("fall crosses floor once and continues the pack's landing sequence", () => {
  const f = engineFixture();
  f.config.actions.Land = { ...f.leaf("Land", "Animate"), borderType: "Floor" };
  f.config.actions.Fall.children.push(f.reference("Land"));
  const engine = falling(f, 500, 590, 10, 100);
  const events = []; f.Engine.addObserver((_, event) => events.push(event));
  engine.tick(); assert.equal(engine.y, 600); assert.equal(engine.vy, 0);
  assert.equal(engine.currentLeaf().name, "Land");
  assert.ok(engine.x > 500 && engine.x < 510, "landing uses the segment intersection");
  for (let i = 0; i < 10; i++) engine.tick();
  assert.equal(events.filter((e) => e.name === "land").length, 1);
});

test("throws can launch upward from the floor without premature landing", () => {
  const f = engineFixture(); const engine = falling(f, 500, 600, 0, -20);
  engine.tick(); assert.ok(engine.y < 600); assert.ok(engine.vy < 0);
  assert.equal(engine.currentBehavior.name, "Fall");
});

test("starting Fall on the supported floor returns to standing without an impact animation", () => {
  const f = engineFixture(); const engine = falling(f, 500, 600);
  const events = []; f.Engine.addObserver((_, event) => events.push(event));
  engine.tick();
  assert.equal(engine.y, 600); assert.equal(engine.currentBehavior.name, "StandUp");
  assert.equal(events.filter((e) => e.name === "land").length, 0);
});

function hurledFixture(nextVelocity = {}) {
  const f = engineFixture();
  f.config.actions.HurledKnockback2 = { ...f.leaf("HurledKnockback2", "Embedded"), className: "test.Fall" };
  f.config.actions.HurledBounce = { ...f.leaf("HurledBounce", "Animate"), borderType: "Floor",
    poses: [{ ...f.config.actions.Stand.poses[0], image: "/impact.png", duration: 6 }] };
  f.config.actions.HurledSprawl = { ...f.leaf("HurledSprawl", "Animate"), borderType: "Floor",
    poses: [{ ...f.config.actions.Stand.poses[0], image: "/sprawl.png", duration: 100 }] };
  f.config.actions.IAmHurled = { name: "IAmHurled", type: "Sequence", children: [
    f.reference("HurledKnockback2"), f.reference("Falling", { InitialVX: "-50", ...nextVelocity }),
    f.reference("HurledBounce"), f.reference("HurledSprawl"),
  ] };
  const engine = f.make(); engine.y = engine.prevY = 590;
  engine.setBehavior("IAmHurled", "test"); engine.advanceActionTree(); engine.vy = 20;
  return { ...f, engine };
}

test("interaction throw landing passes adjacent fall stages and keeps bounce then sprawl", () => {
  for (const cameraImpact of [false, true]) {
    const f = hurledFixture(); const engine = f.engine;
    const impacts = []; f.Engine.addObserver((_, event) => { if (event.name === "land") impacts.push(event); });
    if (cameraImpact) { engine.handleExternalScroll(-20); engine.applyScrollIntent(); }
    else engine.tick();
    assert.equal(engine.currentBehavior.name, "IAmHurled");
    assert.equal(engine.currentLeaf().name, "HurledBounce");
    assert.equal(engine.currentPose().image, "/impact.png");
    assert.equal(engine.vx, 0); assert.equal(engine.vy, 0);
    for (let i = 0; i < 7; i++) engine.tick();
    assert.equal(engine.currentBehavior.name, "IAmHurled");
    assert.equal(engine.currentLeaf().name, "HurledSprawl");
    assert.equal(engine.currentPose().image, "/sprawl.png");
    assert.equal(impacts.length, 1);
  }
});

test("a fall stage after landing can still deliberately launch upward", () => {
  const { engine } = hurledFixture({ InitialVY: "-10" });
  engine.tick();
  assert.equal(engine.currentLeaf().name, "Falling"); assert.equal(engine.vy, -10);
  engine.tick();
  assert.ok(engine.y < 600); assert.ok(engine.vy < 0);
  assert.equal(engine.currentBehavior.name, "IAmHurled");
});

test("landing also preserves recovery after nested consecutive fall actions", () => {
  const f = hurledFixture(); const engine = f.engine;
  const children = f.config.actions.IAmHurled.children;
  children[0] = { type: "Sequence", children: [children[0]] };
  children[1] = { type: "Select", children: [children[1]] };
  engine.setBehavior("IAmHurled", "test"); engine.advanceActionTree(); engine.vy = 20;
  engine.tick();
  assert.equal(engine.currentBehavior.name, "IAmHurled");
  assert.equal(engine.currentLeaf().name, "HurledBounce");
  assert.equal(engine.currentPose().image, "/impact.png");
});

test("fall catches a wall impact and only its top can overflow", () => {
  for (const [x, vx, edge] of [[2, -20, 0], [998, 20, 1000]]) {
    const f = engineFixture(); const engine = falling(f, x, 200, vx, 0);
    engine.tick(); assert.equal(engine.x, edge); assert.equal(engine.vx, 0);
    assert.ok(engine.y > 200); assert.equal(engine.currentLeaf().name, "GrabWall");
    assert.equal(engine.currentBehavior.name, "HoldOntoWall");
    assert.equal(engine.lookRight, edge === 1000);
  }
  const f = engineFixture(); const engine = falling(f, 500, -200, 0, 0);
  engine.tick(); assert.ok(engine.y < 0); assert.ok(engine.vy > 0);
});

test("Thrown catches side/ceiling impacts while remaining within all four bounds", () => {
  const f = engineFixture();
  f.config.actions.Thrown = { name: "Thrown", type: "Sequence", children: [f.reference("Falling")] };
  for (const [x, y, vx, vy] of [[2, 200, -50, 0], [998, 200, 50, 0], [500, 1, 0, -50]]) {
    const engine = falling(f, x, y);
    engine.setBehavior("Thrown", "test"); engine.advanceActionTree(); engine.vx = vx; engine.vy = vy;
    engine.tick();
    assert.ok(engine.x >= 0 && engine.x <= 1000 && engine.y >= 0 && engine.y <= 600);
    if (vy < 0) { assert.equal(engine.y, 0); assert.equal(engine.vy, 0); }
    else assert.equal(engine.vx, 0);
    assert.equal(engine.currentLeaf().name, vy < 0 ? "GrabCeiling" : "GrabWall");
  }
  f.config.actions.Land = { ...f.leaf("Land", "Animate"), borderType: "Floor" };
  f.config.actions.Thrown.children.push(f.reference("Land"));
  const engine = falling(f, 500, 590);
  engine.setBehavior("Thrown", "test"); engine.advanceActionTree(); engine.vy = 100;
  engine.tick(); assert.equal(engine.y, 600); assert.equal(engine.currentLeaf().name, "Land");
});

test("ground movement, wall climbing, offsets and dragging keep four bounds", () => {
  const f = engineFixture();
  const engine = f.make();
  f.config.actions.Stand.borderType = "Floor";
  f.config.actions.Stand.poses = [{ ...f.config.actions.Stand.poses[0], velocity: { x: -30, y: 0 } }];
  engine.x = 990; engine.tick(); assert.equal(engine.x, 1000); assert.equal(engine.y, 600);
  engine.tick(); assert.equal(engine.currentBehavior.name, "StandUp");
  f.config.actions.GrabWall.borderType = "Wall";
  f.config.actions.GrabWall.poses = [{ ...f.config.actions.GrabWall.poses[0], velocity: { x: 0, y: -30 } }];
  engine.x = 0; engine.y = 2; engine.setBehavior("HoldOntoWall", "test"); engine.advanceActionTree();
  engine.tick(); assert.equal(engine.x, 0); assert.equal(engine.y, 0);
  f.config.actions.Offset = { name: "Offset", type: "Embedded", className: "test.Offset" };
  engine.setBehavior("Offset", "test");
  engine.actionStack[0].vars = { X: "-500", Y: "-500" }; engine.tick();
  assert.ok(engine.x >= 0 && engine.y >= 0);
  engine.isDragging = true; engine.dragGrab = { x: 0, y: 0 }; engine.cursorX = -500; engine.cursorY = -500;
  engine.applyDragAnchor(); assert.equal(engine.x, 0); assert.equal(engine.y, 0);
  engine.cursorX = 2000; engine.cursorY = 2000;
  engine.applyDragAnchor(); assert.equal(engine.x, 1000); assert.equal(engine.y, 600);
});

test("ordinary floor movement hitting a wall starts climbing, and scrolling releases the new climb", () => {
  const f = engineFixture();
  f.config.actions.Stand.borderType = "Floor";
  f.config.actions.Stand.poses = [{ ...f.config.actions.Stand.poses[0], velocity: { x: -30, y: 0 } }];
  f.config.actions.ClimbWall = { ...f.leaf("ClimbWall", "Move"), borderType: "Wall" };
  f.config.actions.ClimbAlongWall = { name: "ClimbAlongWall", type: "Sequence", children: [f.reference("ClimbWall", { TargetY: "64" })] };
  const engine = f.make(); engine.x = 990; engine.tick();
  assert.equal(engine.x, 1000); assert.equal(engine.currentLeaf().name, "ClimbWall");
  engine.handleExternalScroll(1, false); engine.tick();
  assert.equal(engine.currentBehavior.name, "StandUp"); assert.equal(engine.x, 1000);
  // At the floor corner, releasing support returns to standing without a fake impact.
  assert.equal(engine.y, 600);
});

test("wall contact followed by scroll falls vertically to the floor without recapture", () => {
  const f = engineFixture(); f.config.actions.GrabWall.borderType = "Wall";
  f.config.actions.Land = { ...f.leaf("Land", "Animate"), borderType: "Floor" };
  f.config.actions.Fall.children.push(f.reference("Land"));
  const engine = falling(f, 998, 200, 40, 0); engine.tick();
  assert.equal(engine.currentLeaf().name, "GrabWall");
  engine.handleExternalScroll(-1); engine.tick();
  assert.equal(engine.currentLeaf().name, "Falling"); assert.equal(engine.x, 1000);
  for (let i = 0; i < 60 && engine.currentLeaf().name === "Falling"; i++) {
    engine.handleExternalScroll(i % 2 ? 1 : -1); engine.tick();
  }
  assert.equal(engine.currentLeaf().name, "Land"); assert.equal(engine.y, 600);
});

test("floor impact takes precedence over a later wall impact", () => {
  const f = engineFixture();
  f.config.actions.Falling.attributes = { Gravity: "0", RegistanceX: "0", RegistanceY: "0" };
  f.config.actions.Land = { ...f.leaf("Land", "Animate"), borderType: "Floor" };
  f.config.actions.Fall.children.push(f.reference("Land"));
  const engine = falling(f, 900, 599, 200, 100); engine.tick();
  assert.equal(engine.currentLeaf().name, "Land"); assert.equal(engine.y, 600);
});

test("floor impact at a side collision lands inside the closed viewport", () => {
  const f = engineFixture();
  f.config.actions.Falling.attributes = { Gravity: "0", RegistanceX: "0", RegistanceY: "0" };
  const engine = falling(f, 990, 590, 100, 100);
  engine.tick(); assert.equal(engine.y, 600); assert.equal(engine.x, 1000);
});

test("shrinking the viewport contains position without producing an impact animation", () => {
  const f = engineFixture(); const engine = falling(f, 900, 550, 3, 5);
  const events = []; f.Engine.addObserver((_, event) => events.push(event));
  engine.renderNow(); f.window.innerWidth = 800; f.window.innerHeight = 500; f.events.get("resize")();
  assert.equal(engine.x, 800); assert.equal(engine.y, 500);
  assert.equal(engine.vx, 0); assert.equal(engine.vy, 0);
  engine.tick(); assert.equal(engine.currentBehavior.name, "StandUp");
  assert.equal(events.filter((e) => e.name === "land").length, 0);
});

test("explicit target jump can still establish a wall grab", () => {
  const f = engineFixture(); f.config.actions.GrabWall.borderType = "Wall";
  f.config.actions.Jumping = { ...f.leaf("Jumping", "Embedded"), className: "test.Jump" };
  f.config.actions.JumpToWall = { name: "JumpToWall", type: "Sequence", children: [
    f.reference("Jumping", { TargetX: "0", TargetY: "200" }), f.reference("GrabWall"),
  ] };
  const engine = f.make(); engine.x = 5; engine.y = 200;
  engine.setBehavior("JumpToWall", "test"); engine.advanceActionTree(); engine.tick();
  assert.equal(engine.x, 0); assert.equal(engine.currentLeaf().name, "GrabWall");
  assert.equal(engine.surfaceAt(), "left-wall");
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

test("content delivers the first container scroll and keeps baselines while disabled or unowned", async () => {
  const source = await readFile("extension/src/content.ts", "utf8");
  const start = source.indexOf("  const lastScrollYMap");
  const end = source.indexOf("  /**", start);
  let listener; const delivered = []; const sources = [];
  class ScrollElement { scrollTop = 0; }
  const window = { scrollY: 0 };
  const document = { documentElement: {}, body: {}, addEventListener(_, callback) { listener = callback; } };
  const context = vm.createContext({ window, document, HTMLElement: ScrollElement,
    isOrphaned: false, isLeaseHolder: true, isScrollInteraction: false,
    activeMascots: [{ engine: { handleExternalScroll: (delta, documentScroll) => { delivered.push(delta); sources.push(documentScroll); }, resetScrollTracking() {} } }] });
  const compiled = await transform(source.slice(start, end), { loader: "ts" });
  vm.runInContext(compiled.code, context);
  window.scrollY = 400; listener({ target: document });
  context.isScrollInteraction = true; window.scrollY = 401; listener({ target: document });
  assert.deepEqual(delivered, [1]);
  context.isLeaseHolder = false; window.scrollY = 800; listener({ target: document });
  context.isLeaseHolder = true; window.scrollY = 802; listener({ target: document });
  assert.deepEqual(delivered, [1, 2]);
  const container = new ScrollElement(); container.scrollTop = 50; listener({ target: container });
  assert.equal(delivered.at(-1), 50, "the first container event must not be swallowed");
  assert.equal(sources.at(-1), false); assert.equal(sources[0], true);
  container.scrollTop = 51; listener({ target: container });
  assert.equal(delivered.at(-1), 1);
  context.isLeaseHolder = false;
  window.scrollY = 1200; container.scrollTop = 900;
  listener({ target: document }); listener({ target: container });
  context.isLeaseHolder = true;
  vm.runInContext("resetScrollInput()", context);
  listener({ target: document }); listener({ target: container });
  assert.equal(delivered.length, 4, "resume establishes baselines without inventing a gesture");
  window.scrollY = 1201; listener({ target: document });
  assert.equal(delivered.at(-1), 1);
});

test("relay contains obsolete side/bottom overflow and preserves only Fall above the top", () => {
  const f = engineFixture(); const source = falling(f, -200, 900, -3, 20);
  source.renderNow(); const target = f.make();
  assert.equal(target.restoreRelaySnapshot(source.createRelaySnapshot()), true);
  assert.equal(target.x, 0); assert.equal(target.y, 600);
  assert.equal(target.vx, 0); assert.equal(target.vy, 0);
  target.tick(); assert.equal(target.currentBehavior.name, "StandUp");
  source.x = 500; source.y = -200; source.vx = 0; source.vy = 20; source.renderNow();
  assert.equal(target.restoreRelaySnapshot(source.createRelaySnapshot()), true);
  assert.equal(target.y, -200); target.tick(); assert.ok(target.y < 0 && target.y > -200);
  f.config.actions.Thrown = { name: "Thrown", type: "Sequence", children: [f.reference("Falling")] };
  f.config.behaviors.push({ name: "Thrown", id: 90, nextBehaviors: [] });
  source.setBehavior("Thrown", "test"); source.advanceActionTree(); source.y = -200; source.vy = -20; source.renderNow();
  assert.equal(target.restoreRelaySnapshot(source.createRelaySnapshot()), true);
  assert.equal(target.y, 0); assert.equal(target.vy, 0);
});

test("scrollSquash is disabled by default and toggles via MascotEngine and MascotGroup API", () => {
  const f = engineFixture();
  const engine = f.make();
  assert.equal(engine.getScrollSquash(), false);
  engine.setScrollSquash(true);
  assert.equal(engine.getScrollSquash(), true);
  engine.setScrollSquash(false);
  assert.equal(engine.getScrollSquash(), false);
});

test("scrollSquash produces vertical compression on upward floor scroll and recovers smoothly", () => {
  const f = engineFixture();
  const engine = f.make();
  f.config.actions.Stand.borderType = "Floor";
  engine.setScrollSquash(true);
  assert.equal(engine.y, 600);

  const initialTransform = engine.elImg.style.transform;

  engine.handleExternalScroll(-60);
  engine.applyScrollIntent();
  engine.render(false);

  const transform1 = engine.elImg.style.transform;
  assert.notEqual(transform1, initialTransform, "must apply squash transform on upward scroll");

  // Verify spring recovery over frames
  for (let i = 0; i < 35; i++) {
    engine.render(false);
  }
  const transformRecovered = engine.elImg.style.transform;
  assert.equal(transformRecovered, initialTransform, "must recover to initial transform");
});
