import test from "node:test";
import assert from "node:assert/strict";
import { realFixture } from "./helpers/real-packs.mjs";

test("Landing Dwell: Floor touchdown after a fall inserts landing-dwell stand before next behavior", () => {
  const f = realFixture();
  const engine = f.make("Neuron");
  engine.setActivityLevel("normal");

  const milestones = [];
  const behaviors = [];
  f.Engine.addObserver((pet, ev) => {
    if (ev.kind === "milestone") milestones.push(ev);
    if (ev.kind === "behavior") behaviors.push(ev);
  });

  // Spawn in the air above floor (y=200, floor=600)
  engine.y = 200;
  engine.setBehavior("Fall", "spawn");

  // Run ticks until landing occurs and next behavior begins
  let landingDwellSeen = false;
  for (let i = 0; i < 400; i++) {
    engine.tick();
    if (behaviors.some((b) => b.reason === "landing-dwell")) {
      landingDwellSeen = true;
      break;
    }
  }

  assert.ok(landingDwellSeen, "Must transition into landing-dwell after touchdown");
  const dwellMilestone = milestones.find((m) => m.name === "landing-dwell");
  assert.ok(dwellMilestone, "Must emit landing-dwell milestone event");
  assert.match(dwellMilestone.detail, /action=Stand ticks=\d+ next=\w+/);
});

test("Landing Anti-Sit Guard: Active mode completely forbids sitting down immediately after landing", () => {
  const f = realFixture();
  const engine = f.make("Neuron");
  engine.setActivityLevel("active");

  // Simulate 30 consecutive landings in active mode
  for (let run = 0; run < 30; run++) {
    engine.y = 300;
    engine.setBehavior("Fall", "spawn");

    // Advance until Fall and landing-dwell finish
    let postLandingBehavior = null;
    for (let t = 0; t < 300; t++) {
      engine.tick();
      if (engine.currentBehaviorName !== "Fall" && engine.currentBehaviorName !== "Stand") {
        postLandingBehavior = engine.currentBehaviorName;
        break;
      }
    }

    assert.ok(postLandingBehavior, "Must transition to an autonomous behavior after landing dwell");
    assert.notEqual(postLandingBehavior, "SitDown", "Active mode must never choose SitDown right after landing");
    assert.notEqual(postLandingBehavior, "LieDown", "Active mode must never choose LieDown right after landing");
    assert.notEqual(postLandingBehavior, "SitWhileDanglingLegs", "Active mode must never choose SitWhileDanglingLegs right after landing");
  }
});

test("Post-Rest StandUp Gate: Normal mode breaks out of SitDown closed loops and forces movement or stand up", () => {
  const f = realFixture();
  const engine = f.make("Neuron");
  engine.setActivityLevel("normal");
  engine.x = 500;
  engine.y = 600;

  let restBehaviorsObserved = 0;
  let nonRestBehaviorsObserved = 0;

  for (let i = 0; i < 20; i++) {
    // Force a rest behavior
    engine.forceBehavior("SitDown");
    // Advance until SitDown finishes
    let nextBehavior = null;
    for (let t = 0; t < 2000; t++) {
      engine.tick();
      if (engine.currentBehaviorName !== "SitDown" && engine.currentBehaviorName !== "Stand") {
        nextBehavior = engine.currentBehaviorName;
        break;
      }
    }
    if (nextBehavior) {
      if (["SitDown", "LieDown", "SitWhileDanglingLegs"].includes(nextBehavior)) {
        restBehaviorsObserved++;
      } else {
        nonRestBehaviorsObserved++;
      }
    }
  }

  // Because of post-rest dampening (85% decay) and loop breakage, non-rest (walk/climb/leap) should strongly dominate
  assert.ok(nonRestBehaviorsObserved > restBehaviorsObserved,
    `Non-rest behaviors (${nonRestBehaviorsObserved}) must dominate over rest loops (${restBehaviorsObserved})`);
});

test("Surface Detach Handover: FallFromWall transitions smoothly to Fall with surface-detach reason", () => {
  const f = realFixture();
  const engine = f.make("Neuron");
  const area = engine.area();

  // Position clinging to left wall with native outward look direction
  engine.x = area.left;
  engine.y = 300;
  engine.lookRight = false;
  engine.setBehavior("HoldOntoWall", "wall-supported");

  const behaviors = [];
  const milestones = [];
  f.Engine.addObserver((pet, ev) => {
    if (ev.kind === "behavior") behaviors.push(ev);
    if (ev.kind === "milestone") milestones.push(ev);
  });

  // Initiate voluntary detach
  engine.setBehavior("FallFromWall", "voluntary");
  for (let t = 0; t < 10; t++) {
    engine.tick();
    if (engine.currentBehaviorName === "Fall") break;
  }

  assert.equal(engine.currentBehaviorName, "Fall", "Must transition into Fall");
  const detachEvent = behaviors.find((b) => b.to === "Fall" && b.reason === "surface-detach");
  assert.ok(detachEvent, "Must transition to Fall with reason='surface-detach'");
  
  // Ensure no false border-lost error milestone was emitted for intentional detach
  const borderLost = milestones.find((m) => m.name === "border-lost" && m.detail?.includes("BorderType=Floor"));
  assert.equal(borderLost, undefined, "Intentional surface detach must not emit false border-lost milestone");
});
