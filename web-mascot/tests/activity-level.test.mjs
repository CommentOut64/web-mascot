import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fixture } from "./helpers/engine-fixture.mjs";
import { realFixture } from "./helpers/real-packs.mjs";
import {
  setActivityLevel,
  getActivityLevel,
  usePreset,
  PresetRegistry,
  MascotEngine,
  AnimationConfig,
  MascotGroup,
  CALM_ANIMATION_PRESET,
  NORMAL_ANIMATION_PRESET,
  ACTIVE_ANIMATION_PRESET,
} from "../dist/index.js";

test("ActivityLevel: default level is 'normal'", () => {
  usePreset("normal");
  assert.equal(getActivityLevel(), "normal");
  assert.equal(MascotEngine.getActivityLevel(), "normal");
  assert.equal(PresetRegistry.getDefaultPresetName(), "normal");
});

test("ActivityLevel: switching between calm, normal, and active", () => {
  // 1. Calm
  setActivityLevel("calm");
  assert.equal(getActivityLevel(), "calm");
  assert.equal(MascotEngine.getPreset(), "calm");
  const calmCfg = new AnimationConfig({ preset: "calm" });
  assert.equal(calmCfg.forcedSwitchTicks("Neuron"), 0);
  assert.deepEqual(calmCfg.travelDwellTicks("Neuron"), [50, 75]);

  // 2. Active
  setActivityLevel("active");
  assert.equal(getActivityLevel(), "active");
  assert.equal(MascotEngine.getPreset(), "active");
  const activeCfg = new AnimationConfig({ preset: "active" });
  assert.equal(activeCfg.forcedSwitchTicks("Neuron"), 250);
  assert.deepEqual(activeCfg.travelDwellTicks("Neuron"), [0, 10]);

  // 3. Normal
  setActivityLevel("normal");
  assert.equal(getActivityLevel(), "normal");
  assert.equal(MascotEngine.getPreset(), "normal");
  const normalCfg = new AnimationConfig({ preset: "normal" });
  assert.equal(normalCfg.forcedSwitchTicks("Neuron"), 750);
  assert.deepEqual(normalCfg.travelDwellTicks("Neuron"), [30, 50]);

  // Invalid throws
  assert.throws(() => setActivityLevel("invalid"));
});

test("ActivityLevel: Preset definitions match requirements", () => {
  assert.equal(CALM_ANIMATION_PRESET.activityLevel, "calm");
  assert.equal(CALM_ANIMATION_PRESET.forcedSwitchTicks, 0);
  assert.deepEqual(CALM_ANIMATION_PRESET.travelDwellTicks, [50, 75]);

  assert.equal(NORMAL_ANIMATION_PRESET.activityLevel, "normal");
  assert.equal(NORMAL_ANIMATION_PRESET.forcedSwitchTicks, 750);
  assert.deepEqual(NORMAL_ANIMATION_PRESET.travelDwellTicks, [30, 50]);
  assert.ok(NORMAL_ANIMATION_PRESET.actionHoldLimits?.Stand);

  assert.equal(ACTIVE_ANIMATION_PRESET.activityLevel, "active");
  assert.equal(ACTIVE_ANIMATION_PRESET.forcedSwitchTicks, 250);
  assert.deepEqual(ACTIVE_ANIMATION_PRESET.travelDwellTicks, [0, 10]);
  assert.ok(ACTIVE_ANIMATION_PRESET.actionHoldLimits?.Stand);
});

test("ActivityLevel: MascotGroup delegates setActivityLevel to all engines or specific pack", () => {
  usePreset("normal");
  const group = new MascotGroup();
  assert.equal(group.getActivityLevel(), "normal");

  group.setActivityLevel("calm");
  assert.equal(group.getActivityLevel(), "calm");
  assert.equal(MascotEngine.getActivityLevel(), "calm");

  group.setActivityLevel("normal");
  assert.equal(group.getActivityLevel(), "normal");
});

test("ActivityLevel: real pack walk actually inserts a travel-dwell", () => {
  usePreset("normal");
  const f = realFixture();
  f.Engine.setAnimationConfig({ preset: "normal" });
  const engine = f.make("Neuron");
  engine.forceBehavior("StandUp");

  const dwells = [];
  const stop = f.Engine.addObserver((_, event) => {
    if (event.kind === "milestone" && event.name === "travel-dwell") {
      dwells.push(event);
    }
  });
  // 20 simulated minutes: real packs only offer the dwell when a target-arrival
  // behavior is followed by a travel pick.
  for (let tick = 0; tick < 25 * 60 * 20; tick++) engine.tick();
  stop();

  assert.ok(
    dwells.length > 0,
    `expected at least one travel-dwell in a real pack, got ${dwells.length}`,
  );
  for (const dwell of dwells) {
    const ticks = Number(/ticks=(\d+)/.exec(dwell.detail)?.[1]);
    assert.ok(
      Number.isFinite(ticks) && ticks >= 25 && ticks <= 40,
      `normal dwell must stay in [25, 40] ticks, got ${dwell.detail}`,
    );
  }

  engine.destroy();
  usePreset("normal");
});

test("ActivityLevel: a target arrival dwells even when the next action is not travel", () => {
  usePreset("normal");
  const f = realFixture();
  f.Engine.setAnimationConfig({
    preset: "normal",
    defaults: {
      allowBehaviors: ["WalkAlongWorkAreaFloor", "SitDown"],
      behaviorWeights: { WalkAlongWorkAreaFloor: 1, SitDown: 1000 },
      forcedSwitchTicks: 0,
      travelDwellTicks: [10, 10],
    },
  });
  const engine = f.make("Neuron");
  engine.forceBehavior("WalkAlongWorkAreaFloor");

  const dwells = [];
  const stop = f.Engine.addObserver((_, event) => {
    if (event.kind === "milestone" && event.name === "travel-dwell") {
      dwells.push(event);
    }
  });
  for (let tick = 0; tick < 25 * 60 * 3; tick++) engine.tick();
  stop();

  assert.ok(
    dwells.some((dwell) => /next=SitDown/.test(dwell.detail)),
    `arrival must dwell before a sit, got: ${dwells.map((d) => d.detail).join(" | ")}`,
  );

  engine.destroy();
  usePreset("normal");
});

test("ActivityLevel: active -> calm clears the previous preset's hold limits", () => {
  const config = new AnimationConfig({ preset: "normal" });
  config.setMascotActivityLevel("Neuron", "active");
  assert.ok(
    config.optionsFor("Neuron").actionHoldLimits?.Stand,
    "active must install its hold limits",
  );

  config.setMascotActivityLevel("Neuron", "calm");
  const calm = config.optionsFor("Neuron");
  assert.equal(calm.activityLevel, "calm");
  assert.deepEqual(calm.travelDwellTicks, [50, 75]);
  assert.equal(calm.forcedSwitchTicks, 0);
  assert.equal(
    calm.actionHoldLimits?.Stand,
    undefined,
    "calm must clear the active preset's Stand cap",
  );
});

test("ActivityLevel: a saved level survives loading the shipped config file", async () => {
  const file = JSON.parse(readFileSync("dist/animation.config.json", "utf8"));
  const f = fixture({
    fetch: async () => ({
      ok: true,
      headers: { get: () => "application/json; charset=utf-8" },
      json: async () => file,
    }),
  });

  f.Engine.setActivityLevel("calm");
  await f.Engine.reloadAnimationConfig("http://test/animation.config.json");

  assert.equal(f.Engine.getActivityLevel(), "calm");
  const options = f.Engine.getAnimationConfig().optionsFor("Neuron");
  assert.equal(options.travelDwellTicks?.[0], 50);
  assert.equal(options.travelDwellTicks?.[1], 75);
  assert.equal(
    options.actionHoldLimits?.Stand,
    undefined,
    "the shipped file's defaults must not pin the normal hold limits",
  );

});

test("ActivityLevel: displacement target arrival triggers adaptive stand dwell when next is travel", () => {
  usePreset("normal");
  const f = fixture();
  f.config.actions.Walk = {
    name: "Walk",
    type: "Move",
    borderType: "Floor",
    poses: [
      { image: "/step.png", imageAnchor: { x: 64, y: 128 }, velocity: { x: 5, y: 0 }, duration: 1 },
    ],
    attributes: { TargetX: "400" },
  };
  f.config.actions.Run = {
    name: "Run",
    type: "Move",
    borderType: "Floor",
    poses: [
      { image: "/step.png", imageAnchor: { x: 64, y: 128 }, velocity: { x: 8, y: 0 }, duration: 1 },
    ],
    attributes: { TargetX: "600" },
  };
  f.config.actions.Stand = {
    name: "Stand",
    type: "Stay",
    borderType: "Floor",
    poses: [{ image: "/stand.png", imageAnchor: { x: 64, y: 128 }, velocity: { x: 0, y: 0 }, duration: 250 }],
  };

  f.config.behaviors = [
    { name: "Walk", frequency: 100, hidden: false, condition: "true", nextBehaviors: [] },
    { name: "Run", frequency: 100, hidden: false, condition: "true", nextBehaviors: [] },
  ];

  f.Engine.setAnimationConfig({
    preset: "normal",
    defaults: {
      travelDwellTicks: 10,
      allowBehaviors: ["Walk", "Run"],
    },
  });

  const engine = f.createEngine();
  engine.x = 200;
  engine.y = 600; // on floor
  engine.lookRight = false; // velocity=5, lookRight=false -> x += 5

  const milestones = [];
  const behaviors = [];
  const stop = f.Engine.addObserver((_, event) => {
    if (event.kind === "milestone") milestones.push(event);
    if (event.kind === "behavior") behaviors.push(event);
  });

  engine.forceBehavior("Walk");

  // Step until TargetX=400 is reached (from 200 to 400 at 5px/tick is 40 ticks)
  for (let i = 0; i < 50; i++) {
    engine.tick();
    if (milestones.some((m) => m.name === "target-x")) break;
  }

  stop();

  assert.ok(milestones.some((m) => m.name === "target-x"), "Should reach target-x");
  assert.ok(milestones.some((m) => m.name === "travel-dwell"), "Should insert travel-dwell milestone");
  assert.equal(engine.currentBehaviorName, "Stand", "During dwell, mascot should be in Stand action");

  // Advance 10 ticks for the dwell to finish
  const dwellEndEvents = [];
  const stop2 = f.Engine.addObserver((_, event) => {
    if (event.kind === "behavior") dwellEndEvents.push(event);
  });

  for (let i = 0; i < 15; i++) {
    engine.tick();
  }
  stop2();

  assert.ok(
    dwellEndEvents.some((e) => e.reason === "travel-dwell-end"),
    "Dwell should end and transition to next travel behavior with reason 'travel-dwell-end'",
  );

  engine.destroy();
  usePreset("normal");
});

