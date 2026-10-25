import test from "node:test";
import assert from "node:assert/strict";
import { realFixture } from "./helpers/real-packs.mjs";

test("Action Tail Dwell: Neuron HeartHeartHeart holds shime29a pose for configured dwell in Normal mode", () => {
  const f = realFixture();
  const engine = f.make("Neuron");
  engine.setActivityLevel("normal");

  const milestones = [];
  f.Engine.addObserver((pet, ev) => {
    if (ev.kind === "milestone") milestones.push(ev);
  });

  // Ensure engine is on the floor
  engine.y = 600;
  engine.forceBehavior("HeartHeartHeart");

  let heartPoseCount = 0;
  let dwellMilestone = null;

  for (let t = 0; t < 200; t++) {
    engine.tick();
    engine.renderNow();
    const poseImg = engine.currentImage();
    if (poseImg === "shime29a.png") {
      heartPoseCount++;
    }
    if (!dwellMilestone) {
      dwellMilestone = milestones.find((m) => m.name === "action-tail-dwell");
    }
    if (engine.currentBehaviorName !== "HeartHeartHeart" && heartPoseCount > 0) {
      break;
    }
  }

  assert.ok(dwellMilestone, "Must emit action-tail-dwell milestone");
  const match = dwellMilestone.detail.match(/dwellTicks=(\d+)/);
  assert.ok(match, "Milestone detail must contain dwellTicks");
  const expectedDwell = parseInt(match[1], 10);
  assert.ok(expectedDwell >= 40 && expectedDwell <= 60, `Normal dwellTicks should be 40~60, got ${expectedDwell}`);
  assert.ok(
    heartPoseCount >= expectedDwell && heartPoseCount <= expectedDwell + 2,
    `shime29a.png must be displayed for ${expectedDwell} ticks (plus stack unwind ticks), got ${heartPoseCount}`,
  );
});

test("Action Tail Dwell: Eviling FrickYou holds shime28 pose across different activity levels", () => {
  const f = realFixture();
  const engine = f.make("Eviling");

  // Test across Calm, Normal, Active
  const scenarios = [
    { level: "calm", min: 60, max: 90 },
    { level: "normal", min: 40, max: 60 },
    { level: "active", min: 20, max: 30 },
  ];

  for (const { level, min, max } of scenarios) {
    engine.setActivityLevel(level);
    engine.y = 600;
    engine.forceBehavior("FrickYou");

    let middleFingerCount = 0;
    for (let t = 0; t < 200; t++) {
      engine.tick();
      engine.renderNow();
      const poseImg = engine.currentImage();
      if (poseImg === "shime28.png") {
        middleFingerCount++;
      }
      if (engine.currentBehaviorName !== "FrickYou" && middleFingerCount > 0) {
        break;
      }
    }

    assert.ok(
      middleFingerCount >= min && middleFingerCount <= max + 2,
      `In ${level} mode, shime28.png must stay ${min}~${max + 2} ticks, got ${middleFingerCount}`,
    );
  }

  // Classic preset retains raw XML 10 ticks (+ 2 unwinding ticks = 12 ticks)
  const fClassic = realFixture();
  fClassic.Engine.animationConfig.setPreset("classic");
  const classicEngine = fClassic.make("Eviling");
  classicEngine.y = 600;
  classicEngine.forceBehavior("FrickYou");

  let classicFingerCount = 0;
  for (let t = 0; t < 100; t++) {
    classicEngine.tick();
    classicEngine.renderNow();
    const poseImg = classicEngine.currentImage();
    if (poseImg === "shime28.png") {
      classicFingerCount++;
    }
    if (classicEngine.currentBehaviorName !== "FrickYou" && classicFingerCount > 0) {
      break;
    }
  }

  assert.ok(
    classicFingerCount >= 10 && classicFingerCount <= 12,
    `Classic mode must strictly preserve raw XML duration (10~12 ticks), got ${classicFingerCount}`,
  );
});

test("Action Tail Dwell: Activity level switching updates actionTailDwellTicks dynamically without leakage", () => {
  const config = realFixture().Engine.animationConfig;

  // Calm level has 60~90 ticks
  config.setActivityLevel("calm", "Neuron");
  const calmDwell = config.sampleActionTailDwellTicks("Neuron", "HeartHeartHeartAction");
  assert.ok(calmDwell >= 60 && calmDwell <= 90, `Calm tail dwell should be 60~90, got ${calmDwell}`);

  // Switch to Active level: 20~30 ticks
  config.setActivityLevel("active", "Neuron");
  const activeDwell = config.sampleActionTailDwellTicks("Neuron", "HeartHeartHeartAction");
  assert.ok(activeDwell >= 20 && activeDwell <= 30, `Active tail dwell should be 20~30, got ${activeDwell}`);

  // Switch to Classic: no tail dwell override (null)
  config.setPreset("classic");
  const classicDwell = config.sampleActionTailDwellTicks("Neuron", "HeartHeartHeartAction");
  assert.equal(classicDwell, null, "Classic tail dwell must be null");
});
