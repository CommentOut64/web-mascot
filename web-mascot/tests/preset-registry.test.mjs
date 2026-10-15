import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PresetRegistry,
  getPreset,
  registerPreset,
  usePreset,
  CLASSIC_ANIMATION_PRESET,
  LIVELY_ANIMATION_PRESET,
  STANDARD_CONFIG_SAMPLE,
  AnimationConfig,
  MascotEngine,
  configure,
} from "../dist/index.js";

test("PresetRegistry: contains standard lively and classic presets by default", () => {
  const presets = PresetRegistry.list();
  assert.ok(presets.includes("lively"), "should include lively preset");
  assert.ok(presets.includes("classic"), "should include classic preset");
  assert.equal(PresetRegistry.getDefaultPresetName(), "lively");
});

test("PresetRegistry: provides accurate definitions for lively vs classic", () => {
  const lively = getPreset("lively");
  assert.ok(lively);
  assert.equal(lively.forcedSwitchTicks, 200);
  assert.equal(lively.maxBehaviorTicks, 1100);
  assert.deepEqual(lively.pacerExemptBehaviors, ["SitWhileDanglingLegs"]);
  assert.deepEqual(lively.exitToPoolBehaviors, ["SitWhileDanglingLegs"]);
  assert.equal(lively.behaviorWeights.SitWhileDanglingLegs, 150);
  assert.equal(lively.behaviorWeights.SitAndFaceMouse, 8);

  const classic = getPreset("classic");
  assert.ok(classic);
  assert.equal(classic.forcedSwitchTicks, undefined, "classic preset has no pacer override (falls back to 0 in engine)");
  assert.equal(classic.maxBehaviorTicks, undefined, "classic preset has no behavior hard cap override");
  assert.deepEqual(classic.behaviorWeights, undefined, "classic preset has no behavior weight overrides");
});

test("PresetRegistry: returns deep clone to prevent external mutation leakage", () => {
  const p1 = getPreset("lively");
  p1.forcedSwitchTicks = 99999;
  p1.pacerExemptBehaviors.push("HackedBehavior");

  const p2 = getPreset("lively");
  assert.equal(p2.forcedSwitchTicks, 200, "original preset must not be mutated");
  assert.deepEqual(p2.pacerExemptBehaviors, ["SitWhileDanglingLegs"]);
});

test("PresetRegistry: supports custom preset registration and activation via usePreset", () => {
  const custom = {
    forcedSwitchTicks: 450,
    maxBehaviorTicks: 800,
    behaviorWeights: { Walk: 200 },
  };
  registerPreset("relaxed-web", custom);
  assert.ok(PresetRegistry.has("relaxed-web"));

  usePreset("relaxed-web");
  assert.equal(MascotEngine.getPreset(), "relaxed-web");

  const config = new AnimationConfig({ preset: "relaxed-web" });
  const options = config.optionsFor("Neuron");
  assert.equal(options.forcedSwitchTicks, 450);
  assert.equal(options.maxBehaviorTicks, 800);
  assert.equal(options.behaviorWeights.Walk, 200);

  // Switch back to lively for subsequent tests
  usePreset("lively");
  assert.equal(MascotEngine.getPreset(), "lively");
});

test("AnimationConfig: backward compatibility for ignoreBuiltin flag", () => {
  const config = new AnimationConfig({ ignoreBuiltin: true });
  assert.equal(config.getPreset(), "classic", "ignoreBuiltin: true should map to classic preset");
  assert.equal(config.forcedSwitchTicks("Neuron"), 0);
  assert.equal(config.maxBehaviorTicks("Neuron"), 0);
  assert.deepEqual(config.optionsFor("Neuron").behaviorWeights, {});
});

test("AnimationConfig: overrides base preset with defaults and per-mascot options", () => {
  const config = new AnimationConfig({
    preset: "lively",
    defaults: {
      forcedSwitchTicks: 300,
      behaviorWeights: { SitDown: 80 },
    },
    mascots: {
      Eviling: {
        forcedSwitchTicks: 500,
      },
    },
  });

  const neuron = config.optionsFor("Neuron");
  assert.equal(neuron.forcedSwitchTicks, 300);
  // Merged behaviorWeights from lively preset + defaults
  assert.equal(neuron.behaviorWeights.SitWhileDanglingLegs, 150);
  assert.equal(neuron.behaviorWeights.SitDown, 80);

  const eviling = config.optionsFor("Eviling");
  assert.equal(eviling.forcedSwitchTicks, 500);
});

test("STANDARD_CONFIG_SAMPLE: provides complete, structured sample", () => {
  assert.equal(STANDARD_CONFIG_SAMPLE.version, 1);
  assert.equal(STANDARD_CONFIG_SAMPLE.preset, "lively");
  assert.ok(STANDARD_CONFIG_SAMPLE.defaults);
  assert.equal(STANDARD_CONFIG_SAMPLE.defaults.forcedSwitchTicks, 200);
  assert.equal(STANDARD_CONFIG_SAMPLE.defaults.scale, 1.0);
});

