import { StackDOMParser } from "./xml-dom.mjs";
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
const parserCode = await bundle("src/core/XMLParser.ts");
const parserModule = { exports: {} };
vm.runInNewContext(parserCode, { module: parserModule, exports: parserModule.exports, DOMParser: StackDOMParser });
export const parseConfig = (...args) => parserModule.exports.XMLParser.parseRawConfig(...args);

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

export function fixture(options = {}) {
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
    DOMParser: StackDOMParser,
    ...(options.random ? { Math: Object.assign(Object.create(Math), { random: options.random }) } : {}),
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

