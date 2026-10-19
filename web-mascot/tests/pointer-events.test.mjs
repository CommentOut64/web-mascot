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

const engineCode = await bundle("src/core/MascotEngine.ts");

class Element {
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
  vm.runInNewContext(engineCode, {
    module,
    exports: module.exports,
    console,
    performance,
    window,
    document: {
      hidden: false,
      createElement: () => {
        const el = new Element();
        createdElements.push(el);
        return el;
      },
      addEventListener() {},
    },
    AbortController,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
  });
  const Engine = module.exports.MascotEngine;
  const pose = {
    image: "/stand.png",
    imageAnchor: { x: 64, y: 128 },
    velocity: { x: 0, y: 0 },
    duration: 100,
  };
  const leaf = (name, type = "Stay") => ({ name, type, poses: [pose], attributes: {} });
  const reference = (name, attributes = {}) => ({
    type: "ActionReference",
    referenceName: name,
    attributes,
  });
  const actions = {
    Stand: leaf("Stand"),
    Dragged: leaf("Dragged"),
    Thrown: leaf("Thrown"),
    GrabWall: leaf("GrabWall"),
    HoldOntoWall: { name: "HoldOntoWall", type: "Sequence", children: [reference("GrabWall")] },
    Fall: { name: "Fall", type: "Sequence", children: [reference("Stand")] },
    StandUp: { name: "StandUp", type: "Sequence", children: [reference("Stand")] },
  };
  const config = {
    actions,
    behaviors: Object.keys(actions).map((name, id) => ({
      name,
      id,
      frequency: 1,
      nextBehaviors: [],
    })),
  };
  const engine = new Engine(new Element(), "Neuron");
  engine.config = config;
  Engine.liveEngines.add(engine);

  return { Engine, engine, events, createdElements, window };
}

test("PointerEvents: elRoot and elImg have touchAction set to none", () => {
  const { engine } = fixture();
  assert.equal(engine.elRoot.style.touchAction, "none");
  assert.equal(engine.elImg.style.touchAction, "none");
});

test("PointerEvents: global listeners bind pointermove, pointerup, pointercancel instead of mouse events", () => {
  const { events } = fixture();
  assert.ok(events.has("pointermove"), "pointermove should be registered");
  assert.ok(events.has("pointerup"), "pointerup should be registered");
  assert.ok(events.has("pointercancel"), "pointercancel should be registered");
  assert.ok(!events.has("mousemove"), "mousemove should NOT be registered");
  assert.ok(!events.has("mouseup"), "mouseup should NOT be registered");
});

test("PointerEvents: single touch drag lifecycle with pointerId capture and throw", () => {
  const { engine, events } = fixture();
  // Mock isOpaqueAt to return true so pointerdown hits the mascot
  engine.isOpaqueAt = () => true;

  // 1. Pointerdown on elRoot
  engine.elRoot.dispatchEvent("pointerdown", {
    button: 0,
    buttons: 1,
    clientX: 200,
    clientY: 300,
    pointerId: 42,
    pointerType: "touch",
  });

  assert.equal(engine.pressActive, true);
  assert.equal(engine.activePointerId, 42);
  assert.ok(engine.elRoot.hasPointerCapture(42), "should capture pointer ID");

  // 2. Pointermove for the active pointer
  const moveHandlers = events.get("pointermove") ?? [];
  for (const h of moveHandlers) {
    h({
      buttons: 1,
      clientX: 250,
      clientY: 350,
      pointerId: 42,
      pointerType: "touch",
    });
  }

  assert.equal(engine.isDragging, true);
  assert.equal(engine.cursorX, 250);
  assert.equal(engine.cursorY, 350);

  // 3. Foreign pointermove (multi-touch second finger) should be ignored
  for (const h of moveHandlers) {
    h({
      buttons: 1,
      clientX: 500,
      clientY: 600,
      pointerId: 99,
      pointerType: "touch",
    });
  }
  assert.equal(engine.cursorX, 250, "foreign pointer must not hijack cursor coordinates");

  // 4. Pointerup finishes press and triggers Thrown behavior
  const upHandlers = events.get("pointerup") ?? [];
  for (const h of upHandlers) {
    h({
      buttons: 0,
      clientX: 260,
      clientY: 360,
      pointerId: 42,
      pointerType: "touch",
    });
  }

  assert.equal(engine.pressActive, false);
  assert.equal(engine.activePointerId, null);
  assert.equal(engine.isDragging, false);
  assert.equal(engine.currentBehavior?.name, "Thrown");
  assert.ok(!engine.elRoot.hasPointerCapture(42), "pointer capture should be released");
});

test("PointerEvents: pointercancel aborts drag cleanly", () => {
  const { engine, events } = fixture();
  engine.isOpaqueAt = () => true;

  engine.elRoot.dispatchEvent("pointerdown", {
    button: 0,
    buttons: 1,
    clientX: 100,
    clientY: 100,
    pointerId: 7,
    pointerType: "touch",
  });

  const moveHandlers = events.get("pointermove") ?? [];
  for (const h of moveHandlers) {
    h({ buttons: 1, clientX: 150, clientY: 150, pointerId: 7, pointerType: "touch" });
  }
  assert.equal(engine.isDragging, true);

  const cancelHandlers = events.get("pointercancel") ?? [];
  for (const h of cancelHandlers) {
    h({ pointerId: 7 });
  }

  assert.equal(engine.pressActive, false);
  assert.equal(engine.activePointerId, null);
  assert.equal(engine.isDragging, false);
  assert.equal(engine.currentBehavior?.name, "Thrown");
});

test("PointerEvents: dragging beyond right boundary and releasing stationary clings to wall", () => {
  const { engine, events, window } = fixture();
  engine.isOpaqueAt = () => true;
  engine.x = 500;
  engine.y = 300;

  engine.elRoot.dispatchEvent("pointerdown", {
    button: 0,
    buttons: 1,
    clientX: 500,
    clientY: 300,
    pointerId: 10,
    pointerType: "touch",
  });

  const moveHandlers = events.get("pointermove") ?? [];
  for (const h of moveHandlers) {
    h({ buttons: 1, clientX: 1600, clientY: 300, pointerId: 10, pointerType: "touch" });
  }
  assert.equal(engine.isDragging, true);
  assert.equal(engine.x, window.innerWidth);

  const upHandlers = events.get("pointerup") ?? [];
  for (const h of upHandlers) {
    h({ buttons: 0, clientX: 1600, clientY: 300, pointerId: 10, pointerType: "touch" });
  }

  assert.equal(engine.isDragging, false);
  assert.equal(engine.currentBehavior?.name, "HoldOntoWall");
  assert.equal(engine.x, window.innerWidth);
  assert.equal(engine.lookRight, true);
});

test("PointerEvents: dragging beyond left boundary and releasing stationary clings to wall", () => {
  const { engine, events } = fixture();
  engine.isOpaqueAt = () => true;

  engine.elRoot.dispatchEvent("pointerdown", {
    button: 0,
    buttons: 1,
    clientX: 200,
    clientY: 300,
    pointerId: 11,
    pointerType: "touch",
  });

  const moveHandlers = events.get("pointermove") ?? [];
  for (const h of moveHandlers) {
    h({ buttons: 1, clientX: -100, clientY: 300, pointerId: 11, pointerType: "touch" });
  }
  assert.equal(engine.isDragging, true);
  assert.equal(engine.x, 0);

  const upHandlers = events.get("pointerup") ?? [];
  for (const h of upHandlers) {
    h({ buttons: 0, clientX: -100, clientY: 300, pointerId: 11, pointerType: "touch" });
  }

  assert.equal(engine.isDragging, false);
  assert.equal(engine.currentBehavior?.name, "HoldOntoWall");
  assert.equal(engine.x, 0);
  assert.equal(engine.lookRight, false);
});

test("PointerEvents: pointercancel while dragged beyond right boundary clings to wall", () => {
  const { engine, events, window } = fixture();
  engine.isOpaqueAt = () => true;

  engine.elRoot.dispatchEvent("pointerdown", {
    button: 0,
    buttons: 1,
    clientX: 500,
    clientY: 300,
    pointerId: 12,
    pointerType: "touch",
  });

  const moveHandlers = events.get("pointermove") ?? [];
  for (const h of moveHandlers) {
    h({ buttons: 1, clientX: 1500, clientY: 300, pointerId: 12, pointerType: "touch" });
  }
  assert.equal(engine.isDragging, true);

  const cancelHandlers = events.get("pointercancel") ?? [];
  for (const h of cancelHandlers) {
    h({ pointerId: 12 });
  }

  assert.equal(engine.isDragging, false);
  assert.equal(engine.currentBehavior?.name, "HoldOntoWall");
  assert.equal(engine.x, window.innerWidth);
});

