/**
 * Regression tests for the layered-refactor orchestration modules.
 *
 * `relay.test.mjs` exercises MascotEngine only; it never touches MascotGroup,
 * ViewportHost or MascotPageCoordinator, so the whole group/relay layer that the
 * browser extension drives was unverified. These tests bundle MascotGroup with
 * its engine aliased to a stub, so the orchestration logic is asserted in
 * isolation (no DOM, no network).
 *
 * Run: node --test tests/mascot-group.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";

const STUB_ENGINE = `
export class MascotEngine {
  static extensionMode = false;
  static externalScroll = false;
  static observers = [];
  static addObserver(fn) { MascotEngine.observers.push(fn); return () => {}; }
  static getPackBaseUrl() { return "https://assets.test/pack"; }
  static constructed = 0;
  static destroyed = 0;
  constructor(container, pack) {
    MascotEngine.constructed++;
    this.container = container;
    this.mascotName = pack;
    this.elRoot = { style: {}, appendChild() {} };
    this.resumed = 0;
    this.destroyed = false;
  }
  async init() {}
  destroy() { if (!this.destroyed) { this.destroyed = true; MascotEngine.destroyed++; } }
  setClickThrough(v) { this.clickThrough = v; }
  pauseForRelay() { this.paused = true; }
  resumeForRelay() { this.paused = false; this.resumed++; }
  async prepareForRelay(snapshot) { this.prepared = snapshot; }
  createRelaySnapshot() { return { pack: this.mascotName, x: 1, y: 2 }; }
  resetToSpawn() { this.reset = (this.reset ?? 0) + 1; }
  handleExternalScroll() {}
  resetScrollTracking() {}
}
// MascotGroup does not re-export MascotEngine, so publish the stub for assertions.
globalThis.__STUB_ENGINE__ = MascotEngine;
`;

const aliasEnginePlugin = {
  name: "alias-mascot-engine",
  setup(buildApi) {
    buildApi.onResolve({ filter: /MascotEngine\.js$/ }, (args) =>
      args.importer.includes("MascotGroup")
        ? { path: "stub-engine", namespace: "stub" }
        : null
    );
    buildApi.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
      contents: STUB_ENGINE,
      loader: "js",
    }));
  },
};

let bundleSequence = 0;

async function loadMascotGroup() {
  const result = await build({
    entryPoints: ["src/core/MascotGroup.ts"],
    bundle: true,
    write: false,
    platform: "neutral",
    format: "esm",
    logLevel: "silent",
    plugins: [aliasEnginePlugin],
  });
  // Each load must be a distinct module URL, otherwise the ES module cache
  // returns the first evaluation and the stub's counters/globals are stale.
  const code = `${result.outputFiles[0].text}\n// bundle-instance-${++bundleSequence}\n`;
  delete globalThis.__STUB_ENGINE__;
  const module = await import(
    "data:text/javascript;base64," + Buffer.from(code).toString("base64")
  );
  return { MascotGroup: module.MascotGroup, Engine: globalThis.__STUB_ENGINE__ };
}

/** Minimal stand-ins for the DOM pieces MascotGroup touches. */
function makeHost() {
  const calls = [];
  const container = { id: "container" };
  return {
    calls,
    host: {
      isMounted: true,
      ensureHost() {
        calls.push("ensureHost");
        return { container, shadow: {}, hostEl: {} };
      },
      showPlaceholders() { calls.push("showPlaceholders"); },
      clearPlaceholders() { calls.push("clearPlaceholders"); },
      show() {}, hide() {}, destroy() {},
    },
  };
}

test("spawn() constructs and starts every requested pack", async () => {
  const { MascotGroup } = await loadMascotGroup();
  const { host } = makeHost();
  const group = new MascotGroup();
  const spawned = [];

  const ok = await group.spawn({
    packs: ["Neuron", "Eviling"],
    host,
    onSpawned: (pack) => spawned.push(pack),
  });

  assert.equal(ok, true, "spawn() must report success for a valid request");
  assert.equal(group.count, 2, "both requested engines must exist");
  assert.equal(group.isReady, true, "group must be ready after a successful spawn");
  assert.deepEqual(spawned, ["Neuron", "Eviling"], "onSpawned must fire per pack");
  assert.equal(
    group.engines.every((engine) => engine.resumed === 1),
    true,
    "every engine must be resumed exactly once after the group is ready"
  );
});

test("spawn() succeeds for a single pack", async () => {
  const { MascotGroup } = await loadMascotGroup();
  const { host } = makeHost();
  const group = new MascotGroup();

  const ok = await group.spawn({ packs: ["Neuron"], host });

  assert.equal(ok, true);
  assert.equal(group.count, 1);
});

test("spawn() clears relay placeholders once it succeeds", async () => {
  const { MascotGroup } = await loadMascotGroup();
  const { host, calls } = makeHost();
  const group = new MascotGroup();

  await group.spawn({ packs: ["Neuron"], host });

  assert.equal(calls.includes("showPlaceholders"), true, "placeholders are drawn first");
  assert.equal(
    calls.includes("clearPlaceholders"),
    true,
    "a successful spawn must remove the first-frame bitmap"
  );
});

test("spawn() with a visual snapshot leaves no stuck placeholder", async () => {
  const { MascotGroup } = await loadMascotGroup();
  const { host, calls } = makeHost();
  const group = new MascotGroup();
  const snapshot = { pack: "Neuron", x: 10, y: 20, visual: { image: "/a.png" } };

  await group.spawn({ packs: ["Neuron"], host, snapshots: [snapshot] });

  assert.equal(
    calls.includes("clearPlaceholders"),
    true,
    "the relay path must not strand a frozen bitmap on the page"
  );
});

test("createSubmission() gate becomes READY after a spawn", async () => {
  const { MascotGroup } = await loadMascotGroup();
  const { host } = makeHost();
  const group = new MascotGroup();
  const packs = ["Neuron", "Eviling"];

  await group.spawn({ packs, host });

  // Mirrors the predicate in extension/src/content.ts createSubmission().
  const ready =
    group.isReady &&
    group.count === packs.length &&
    packs.every(
      (pack) => group.engines.filter((m) => m.mascotName === pack).length === 1
    );
  assert.equal(ready, true, "the extension must be able to publish a READY submission");
});

test("fastResume() reuses existing engines without rebuilding them", async () => {
  const { MascotGroup, Engine } = await loadMascotGroup();
  const { host } = makeHost();
  const group = new MascotGroup();
  const packs = ["Neuron", "Eviling"];
  await group.spawn({ packs, host });

  const constructed = Engine.constructed;
  const snapshots = packs.map((pack, index) => ({ pack, x: index, y: index }));
  const resumed = await group.fastResume(packs, snapshots);

  assert.equal(resumed, true, "fastResume must accept a matching, complete snapshot set");
  assert.equal(Engine.constructed, constructed, "fastResume must not construct new engines");
  assert.equal(
    group.engines.every((engine) => engine.prepared),
    true,
    "every engine must receive its snapshot via prepareForRelay"
  );
});

test("despawn() destroys engines and resets readiness", async () => {
  const { MascotGroup, Engine } = await loadMascotGroup();
  const { host } = makeHost();
  const group = new MascotGroup();
  await group.spawn({ packs: ["Neuron"], host });

  group.despawn();

  assert.equal(group.count, 0);
  assert.equal(group.isReady, false);
  assert.equal(Engine.destroyed >= 1, true, "despawn must destroy the live engine");
});

test("an aborted spawn signal leaves no engines behind", async () => {
  const { MascotGroup } = await loadMascotGroup();
  const { host } = makeHost();
  const group = new MascotGroup();
  const controller = new AbortController();
  controller.abort();

  const ok = await group.spawn({ packs: ["Neuron"], host, signal: controller.signal });

  assert.equal(ok, false, "an already-aborted spawn must not report success");
  assert.equal(group.count, 0, "an aborted spawn must not leave engines mounted");
});
