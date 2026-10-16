import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";

async function bundle(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

const libCode = await bundle("src/index.ts");

class MockElement {
  style = {};
  attributes = new Map();
  complete = true;
  naturalWidth = 128;
  naturalHeight = 128;
  capturedPointers = new Set();
  listeners = new Map();

  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }

  dispatchEvent(name, event) {
    const handlers = this.listeners.get(name) ?? [];
    for (const h of handlers) h(event);
  }

  setPointerCapture(id) {
    this.capturedPointers.add(id);
  }

  releasePointerCapture(id) {
    this.capturedPointers.delete(id);
  }

  hasPointerCapture(id) {
    return this.capturedPointers.has(id);
  }

  appendChild(child) {
    child.parentNode = this;
  }
  removeChild(child) {
    child.parentNode = null;
  }
  getAttribute(key) {
    return this.attributes.get(key) ?? null;
  }
  setAttribute(key, val) {
    this.attributes.set(key, val);
  }
  removeAttribute(key) {
    this.attributes.delete(key);
  }
  set src(value) {
    this.attributes.set("src", value);
  }
  get src() {
    return this.getAttribute("src");
  }
  async decode() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 1000, bottom: 600, width: 1000, height: 600 };
  }
}

function fixture() {
  const events = new Map();
  const module = { exports: {} };
  const window = {
    innerWidth: 1000,
    innerHeight: 600,
    scrollY: 0,
    addEventListener(name, callback) {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(callback);
    },
    setTimeout,
    clearTimeout,
  };
  const createdElements = [];
  vm.runInNewContext(libCode, {
    module,
    exports: module.exports,
    console,
    performance,
    window,
    document: {
      hidden: false,
      createElement: () => {
        const el = new MockElement();
        createdElements.push(el);
        return el;
      },
      addEventListener() {},
    },
    AbortController,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });

  const pkg = module.exports;
  const Engine = pkg.MascotEngine;

  const pose = {
    image: "/stand.png",
    imageAnchor: { x: 64, y: 128 },
    velocity: { x: 0, y: 0 },
    duration: 100,
  };

  const leaf = (name, type = "Stay", borderType = "") => ({
    name,
    type,
    poses: [pose],
    attributes: borderType ? { BorderType: borderType } : {},
  });

  const reference = (name) => ({
    type: "ActionReference",
    referenceName: name,
    attributes: {},
  });

  const actions = {
    Stand: leaf("Stand", "Stay", "Floor"),
    Sit: leaf("Sit", "Stay", "Floor"),
    Climb: leaf("Climb", "Stay", "Wall"),
    Hang: leaf("Hang", "Stay", "Ceiling"),
    FreeFly: leaf("FreeFly", "Stay", ""),
    Dragged: leaf("Dragged", "Stay", ""),
    Thrown: leaf("Thrown", "Stay", ""),
    StandUp: { name: "StandUp", type: "Sequence", children: [reference("Stand")] },
    SitDown: { name: "SitDown", type: "Sequence", children: [reference("Sit")] },
    ClimbWall: { name: "ClimbWall", type: "Sequence", children: [reference("Climb")] },
    HangCeiling: { name: "HangCeiling", type: "Sequence", children: [reference("Hang")] },
    FlyAround: { name: "FlyAround", type: "Sequence", children: [reference("FreeFly")] },
  };

  const behaviors = [
    { name: "StandUp", id: 1, frequency: 10, hidden: false, nextBehaviors: [] },
    { name: "SitDown", id: 2, frequency: 10, hidden: false, nextBehaviors: [] },
    { name: "ClimbWall", id: 3, frequency: 10, hidden: true, nextBehaviors: [] },
    { name: "HangCeiling", id: 4, frequency: 10, hidden: true, nextBehaviors: [] },
    { name: "FlyAround", id: 5, frequency: 10, hidden: false, nextBehaviors: [] },
    // Duplicate behavior entry to verify de-duplication in getBehaviors()
    { name: "SitDown", id: 6, frequency: 5, hidden: false, nextBehaviors: [] },
  ];

  const config = { actions, behaviors };

  const createEngine = (pack = "Neuron") => {
    const engine = new Engine(new MockElement(), pack);
    engine.config = config;
    Engine.liveEngines.add(engine);
    return engine;
  };

  return { pkg, Engine, createEngine, config, window };
}

test("Behavior API: getBehaviors() returns distinct behavior list with surface requirements", () => {
  const { createEngine } = fixture();
  const engine = createEngine();
  engine.x = 500;
  engine.y = 600; // Floor

  const list = engine.getBehaviors();
  assert.equal(list.length, 5, "Duplicate behavior names should be deduplicated");

  const standUp = list.find((b) => b.name === "StandUp");
  assert.ok(standUp);
  assert.equal(standUp.requiredSurface, "Floor");
  assert.equal(standUp.available, true);
  assert.equal(standUp.hidden, false);

  const climbWall = list.find((b) => b.name === "ClimbWall");
  assert.ok(climbWall);
  assert.equal(climbWall.requiredSurface, "Wall");
  assert.equal(climbWall.available, false, "Wall action should not be immediately available on floor");
  assert.equal(climbWall.hidden, true);

  const flyAround = list.find((b) => b.name === "FlyAround");
  assert.ok(flyAround);
  assert.equal(flyAround.requiredSurface, null);
  assert.equal(flyAround.available, true);
});

test("Behavior API: canExecuteBehavior() checks surface support accurately", () => {
  const { createEngine } = fixture();
  const engine = createEngine();

  // 1. On Floor
  engine.x = 500;
  engine.y = 600;
  assert.equal(engine.canExecuteBehavior("StandUp"), true);
  assert.equal(engine.canExecuteBehavior("SitDown"), true);
  assert.equal(engine.canExecuteBehavior("ClimbWall"), false);
  assert.equal(engine.canExecuteBehavior("HangCeiling"), false);
  assert.equal(engine.canExecuteBehavior("FlyAround"), true);
  assert.equal(engine.canExecuteBehavior("NonExistent"), false);

  // 2. On Left Wall
  engine.x = 0;
  engine.y = 300;
  assert.equal(engine.canExecuteBehavior("StandUp"), false);
  assert.equal(engine.canExecuteBehavior("ClimbWall"), true);
  assert.equal(engine.canExecuteBehavior("HangCeiling"), false);
  assert.equal(engine.canExecuteBehavior("FlyAround"), true);

  // 3. On Ceiling
  engine.x = 500;
  engine.y = 0;
  assert.equal(engine.canExecuteBehavior("StandUp"), false);
  assert.equal(engine.canExecuteBehavior("HangCeiling"), true);
  assert.equal(engine.canExecuteBehavior("FlyAround"), true);
});

test("Behavior API: setBehavior() without force enforces surface constraint safely", () => {
  const { createEngine } = fixture();
  const engine = createEngine();

  // Position on Floor
  engine.x = 500;
  engine.y = 600;
  engine.setBehavior("StandUp", "test");
  assert.equal(engine.currentBehaviorName, "StandUp");

  // Attempt to switch to Wall action without force -> should fail and keep StandUp
  const failed = engine.setBehavior("ClimbWall");
  assert.equal(failed, false);
  assert.equal(engine.currentBehaviorName, "StandUp");

  // Switch to another Floor action -> should succeed
  const success = engine.setBehavior("SitDown");
  assert.equal(success, true);
  assert.equal(engine.currentBehaviorName, "SitDown");
});

test("Behavior API: forceBehavior() snaps to required surface and switches behavior", () => {
  const { createEngine } = fixture();
  const engine = createEngine();

  // 1. Start on Floor at x=800, y=600 (near right wall, width 1000)
  engine.x = 800;
  engine.y = 600;
  engine.setBehavior("StandUp", "test");

  // Force Wall action: should snap to right wall (x=1000)
  const switchedWall = engine.forceBehavior("ClimbWall");
  assert.equal(switchedWall, true);
  assert.equal(engine.currentBehaviorName, "ClimbWall");
  assert.equal(engine.x, 1000);
  assert.equal(engine.lookRight, true);
  assert.equal(engine.vx, 0);
  assert.equal(engine.vy, 0);

  // 2. From Wall, force SitDown (Floor action): should snap to floor (y=600)
  const switchedFloor = engine.forceBehavior("SitDown");
  assert.equal(switchedFloor, true);
  assert.equal(engine.currentBehaviorName, "SitDown");
  assert.equal(engine.y, 600);
  assert.equal(engine.vx, 0);
  assert.equal(engine.vy, 0);

  // 3. From Floor, force HangCeiling: should snap to ceiling (y=0)
  const switchedCeiling = engine.forceBehavior("HangCeiling");
  assert.equal(switchedCeiling, true);
  assert.equal(engine.currentBehaviorName, "HangCeiling");
  assert.equal(engine.y, 0);

  // 4. Test snapToSurface: false (force without snapping coordinates)
  engine.x = 350;
  engine.y = 250;
  engine.forceBehavior("StandUp", { snapToSurface: false });
  assert.equal(engine.currentBehaviorName, "StandUp");
  assert.equal(engine.x, 350);
  assert.equal(engine.y, 250);
});

test("Behavior API: forceBehavior() interrupts active drag cleanly", () => {
  const { createEngine } = fixture();
  const engine = createEngine();
  engine.x = 500;
  engine.y = 600;
  engine.setBehavior("StandUp", "test");

  // Simulate active drag
  engine.isDragging = true;
  engine.pressActive = true;
  engine.activePointerId = 99;

  // Manual force switch should cancel drag state
  const ok = engine.forceBehavior("SitDown");
  assert.equal(ok, true);
  assert.equal(engine.isDragging, false);
  assert.equal(engine.pressActive, false);
  assert.equal(engine.activePointerId, null);
  assert.equal(engine.currentBehaviorName, "SitDown");
});

test("Behavior API: Mascot wrapper class delegates behavior methods correctly", () => {
  const { pkg, createEngine } = fixture();
  const engine = createEngine();
  engine.x = 500;
  engine.y = 600;
  engine.setBehavior("StandUp", "test");

  const mascot = new pkg.Mascot(engine);

  assert.equal(mascot.currentBehavior, "StandUp");
  assert.equal(mascot.getCurrentBehavior(), "StandUp");

  const list = mascot.getBehaviors();
  assert.equal(list.length, 5);

  assert.equal(mascot.canExecuteBehavior("SitDown"), true);
  assert.equal(mascot.canExecuteBehavior("ClimbWall"), false);

  assert.equal(mascot.setBehavior("ClimbWall"), false);
  assert.equal(mascot.currentBehavior, "StandUp");

  assert.equal(mascot.setBehavior("SitDown"), true);
  assert.equal(mascot.currentBehavior, "SitDown");

  assert.equal(mascot.forceBehavior("ClimbWall"), true);
  assert.equal(mascot.currentBehavior, "ClimbWall");
  assert.equal(engine.x, 0); // Closer to left wall (from 500 default or snap)
});

test("Behavior API: MascotGroup setBehavior and forceBehavior support group and per-pack targeting", () => {
  const { pkg, createEngine } = fixture();
  const neuron = createEngine("Neuron");
  neuron.x = 500;
  neuron.y = 600;
  neuron.setBehavior("StandUp", "test");

  const eviling = createEngine("Eviling");
  eviling.x = 500;
  eviling.y = 600;
  eviling.setBehavior("StandUp", "test");

  const group = new pkg.MascotGroup();
  group.activeEngines.push(neuron, eviling);

  // 1. Group-level setBehavior for floor action
  const res1 = group.setBehavior("SitDown");
  assert.equal(res1, true);
  assert.equal(neuron.currentBehaviorName, "SitDown");
  assert.equal(eviling.currentBehaviorName, "SitDown");

  // 2. Targeted forceBehavior for Neuron only
  const res2 = group.forceBehavior("ClimbWall", {}, "Neuron");
  assert.equal(res2, true);
  assert.equal(neuron.currentBehaviorName, "ClimbWall");
  assert.equal(eviling.currentBehaviorName, "SitDown", "Eviling should not be modified");

  // 3. Target non-existent pack
  const res3 = group.setBehavior("StandUp", {}, "Ghost");
  assert.equal(res3, false);
});

