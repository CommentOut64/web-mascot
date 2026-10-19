import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./helpers/engine-fixture.mjs";

function pacingFixture(defaults = {}) {
  const f = fixture({ random: () => 0.5 });
  f.Engine.setAnimationConfig({ preset: "classic", defaults });
  const pose = (image, duration = 2, vx = 0) => ({ image,
    imageAnchor: { x: 64, y: 128 }, velocity: { x: vx, y: 0 }, duration });
  const leaf = (name, type = "Stay", poses = [pose(`/${name}.png`)]) =>
    ({ name, type, poses, attributes: {} });
  const ref = (name, attributes = {}) => ({ type: "ActionReference", referenceName: name, attributes });
  const sequence = (name, children, loop = false) => ({ name, type: "Sequence", children, loop });
  Object.assign(f.config.actions, {
    Performance: leaf("Performance", "Animate", [pose("/first.png", 5), pose("/last.png", 5)]),
    Finish: leaf("Finish", "Animate"),
    Rest: sequence("Rest", [ref("Sit", { Duration: "1000" })]),
    Travel: sequence("Travel", [ref("Walk", { TargetX: "800" })]),
    Walk: { ...leaf("Walk", "Move", [pose("/walk.png", 2, 2)]), borderType: "Floor" },
    Show: sequence("Show", [ref("Performance"), ref("Finish")]),
  });
  f.config.behaviors = ["Show", "Rest", "Travel"].map((name, id) =>
    ({ name, id, frequency: 100, hidden: false, nextBehaviors: [] }));
  const engine = f.createEngine(); engine.x = 500; engine.y = 600;
  const events = []; f.Engine.addObserver((_, event) => events.push(event));
  const start = (name) => engine.forceBehavior(name);
  const ticks = (count) => { for (let i = 0; i < count; i++) engine.tick(); };
  return { ...f, engine, events, leaf, pose, ref, sequence, start, ticks };
}

test("Pacing: timers preserve finite performances and their final step before selecting travel", () => {
  const f = pacingFixture({ forcedSwitchTicks: 3, maxBehaviorTicks: 4 });
  f.start("Show"); f.ticks(5);
  assert.equal(f.engine.currentBehaviorName, "Show", "Pacer must not replace a performance halfway through");
  assert.equal(f.engine.currentPose().image, "/last.png");
  f.ticks(6);
  assert.equal(f.engine.currentLeaf().name, "Finish", "The final sequence step must execute");
  f.ticks(4);
  assert.equal(f.engine.currentBehaviorName, "Travel", "A completed stationary behavior should still select travel");
  assert.equal(f.events.filter((e) => e.name === "forced-switch").length, 1);
});

test("Pacing: behavior age does not cut a finite target move or the following pose", () => {
  const f = pacingFixture({ maxBehaviorTicks: 3 });
  f.config.actions.Travel.children.push(f.ref("Finish"));
  f.start("Travel"); f.ticks(10);
  assert.equal(f.engine.currentBehaviorName, "Travel");
  assert.equal(f.engine.currentLeaf().name, "Walk");
  f.ticks(140);
  assert.equal(f.engine.x, 800);
  assert.equal(f.engine.currentLeaf().name, "Finish");
});

test("Pacing: an indefinite sequence yields only after all children finish", () => {
  const f = pacingFixture({ forcedSwitchTicks: 3 });
  f.config.actions.Show.loop = true;
  f.start("Show"); f.ticks(5);
  assert.equal(f.engine.currentPose().image, "/last.png");
  f.ticks(6); assert.equal(f.engine.currentLeaf().name, "Finish");
  f.ticks(4); assert.equal(f.engine.currentBehaviorName, "Travel");
});

test("Pacing: a nested indefinite animation yields at its cycle end and preserves the tail", () => {
  const f = pacingFixture({ maxBehaviorTicks: 3 });
  f.config.actions.Performance.loop = true;
  f.start("Show"); f.ticks(5);
  assert.equal(f.engine.currentLeaf().name, "Performance");
  f.ticks(6); assert.equal(f.engine.currentLeaf().name, "Finish");
});

test("Pacing: explicit container budgets cannot discard a finite sequence tail", () => {
  const f = pacingFixture({ actionDurations: { Show: 3 } });
  f.start("Show"); f.ticks(11);
  assert.equal(f.engine.currentLeaf().name, "Finish");
});

test("Pacing: an explicit loop duration finishes its current animation cycle", () => {
  const f = pacingFixture({ actionDurations: { Performance: 3 } });
  f.config.actions.Performance.loop = true;
  f.start("Show"); f.ticks(5);
  assert.equal(f.engine.currentPose().image, "/last.png");
  f.ticks(6);
  assert.equal(f.engine.currentLeaf().name, "Finish");
});

test("Pacing: only marked waits change and short XML transitions remain short", () => {
  const f = pacingFixture({ actionHoldLimits: { Sit: { ticks: 6, waitPoses: [0, 2] } } });
  f.config.actions.Sit.poses = [f.pose("/wait-a.png", 8), f.pose("/blink.png", 2), f.pose("/wait-b.png", 8)];
  f.config.actions.Rest.children = [f.ref("Sit", { Duration: "1000" }), f.ref("Finish")];
  f.start("Rest");
  assert.deepEqual(Array.from(f.engine.actionStack.at(-1).poseDurations), [2, 2, 2]);
  f.ticks(2); assert.equal(f.engine.currentPose().image, "/blink.png");
  f.ticks(2); assert.equal(f.engine.currentPose().image, "/wait-b.png");
  f.ticks(2); assert.equal(f.engine.currentLeaf().name, "Rest");
  f.ticks(1); assert.equal(f.engine.currentLeaf().name, "Finish");
  f.config.actions.Rest.children[0].attributes.Duration = "2";
  f.start("Rest"); f.ticks(3);
  assert.equal(f.engine.currentLeaf().name, "Finish");
});

test("Pacing: unknown long holds and classic timing retain the XML duration", () => {
  const f = pacingFixture({ actionHoldLimits: { Sit: { ticks: 5, waitPoses: [0] } } });
  f.config.actions.Custom = f.leaf("Custom");
  f.config.actions.Rest.children = [f.ref("Custom", { Duration: "40" })];
  f.start("Rest"); f.ticks(20);
  assert.equal(f.engine.currentLeaf().name, "Custom");
  f.Engine.setAnimationConfig({ preset: "classic" });
  f.config.actions.Rest.children = [f.ref("Sit", { Duration: "40" })];
  f.start("Rest"); f.ticks(20);
  assert.equal(f.engine.currentLeaf().name, "Sit");
});

test("Pacing: changing hold configuration affects the next entry without restarting the current hold", () => {
  const f = pacingFixture({ actionHoldLimits: { Sit: { ticks: 8, waitPoses: [0] } } });
  f.config.actions.Sit.poses = [f.pose("/sit.png", 2)];
  f.start("Rest"); f.ticks(2);
  f.Engine.setAnimationConfig({ preset: "classic", defaults: { actionHoldLimits: { Sit: { ticks: 2, waitPoses: [0] } } } });
  f.ticks(5);
  assert.equal(f.engine.currentLeaf().name, "Sit");
  assert.equal(f.engine.actionStack.at(-1).elapsed, 7, "Changing a table must preserve the current action clock");
  f.start("Rest"); f.ticks(2);
  assert.equal(f.engine.currentLeaf().name, "Rest", "A new entry must use the new budget");
});

test("Pacing: conditional animation variants retain native timing", () => {
  const f = pacingFixture({ actionHoldLimits: { Sit: { ticks: 4, waitPoses: [0] } } });
  f.config.actions.Sit.animations = [
    { condition: "#{mascot.lookRight}", poses: [f.pose("/right-a.png", 4), f.pose("/right-b.png", 4)] },
    { poses: [f.pose("/left.png", 2)] },
  ];
  f.start("Rest"); f.ticks(1); f.engine.lookRight = true; f.ticks(1);
  const restored = f.createEngine();
  assert.equal(restored.restoreRelaySnapshot(JSON.parse(JSON.stringify(f.engine.createRelaySnapshot()))), true);
  for (let i = 0; i < 10; i++) restored.tick();
  assert.equal(restored.currentLeaf().name, "Sit");
  assert.equal(restored.actionStack.at(-1).durationLimit, 1000);
});

test("Pacing: relay restoration retains a pending loop exit and its remaining poses", () => {
  const f = pacingFixture({ maxBehaviorTicks: 3 });
  f.config.actions.Show.loop = true;
  f.start("Show"); f.ticks(5);
  const snapshot = JSON.parse(JSON.stringify(f.engine.createRelaySnapshot()));
  const restored = f.createEngine();
  assert.equal(restored.restoreRelaySnapshot(snapshot), true);
  assert.equal(restored.currentPose().image, "/last.png");
  for (let i = 0; i < 6; i++) restored.tick();
  assert.equal(restored.currentLeaf().name, "Finish");
  for (let i = 0; i < 4; i++) restored.tick();
  assert.notEqual(restored.currentBehaviorName, "Show", "The restored age budget must release the loop after its tail");
});

test("Pacing: wall contact preserves the remaining steps of a compound behavior", () => {
  const f = pacingFixture();
  f.config.actions.Travel.children.push(f.ref("Finish"));
  f.config.actions.Travel.children[0].attributes.TargetX = "1500";
  f.start("Travel"); f.engine.x = 999; f.ticks(1);
  assert.equal(f.engine.x, 1000);
  assert.equal(f.engine.currentBehaviorName, "Travel");
  assert.equal(f.engine.currentLeaf().name, "Finish");
});

test("Pacing: a long stationary pose inside a move is not mistaken for a stall", () => {
  const f = pacingFixture({ maxBehaviorTicks: 3 });
  f.config.actions.Walk.poses = [f.pose("/pause.png", 200), f.pose("/walk.png", 2, 2)];
  f.start("Travel"); f.ticks(160);
  assert.equal(f.engine.currentLeaf().name, "Walk");
  assert.equal(f.engine.x, 500);
  f.ticks(42);
  assert.ok(f.engine.x > 500, "The movement must resume after its authored pause");
});

test("Pacing: an unreachable target with no moving poses still recovers into the tail", () => {
  const f = pacingFixture();
  f.config.actions.Walk.poses = [f.pose("/broken-move.png", 2)];
  f.config.actions.Travel.children.push(f.ref("Finish"));
  f.start("Travel"); f.ticks(151);
  assert.equal(f.engine.currentBehaviorName, "Travel");
  assert.equal(f.engine.currentLeaf().name, "Finish");
});

test("Pacing: a claimed advertisement and a live interaction keep their running loops", () => {
  for (const protection of ["claim", "interaction"]) {
    const f = pacingFixture({ forcedSwitchTicks: 3, maxBehaviorTicks: 4 });
    f.config.actions.Performance.loop = true;
    f.start("Show");
    const frame = f.engine.actionStack.at(-1);
    if (protection === "claim") frame.server = { isClaimed: true, active: false, didMeetUp: false };
    else f.engine.interaction = { ongoing: true };
    f.ticks(25);
    assert.equal(f.engine.currentLeaf().name, "Performance", `${protection} must protect the loop`);
  }
});

test("Pacing: short finite holds continue random switching without any pacer", () => {
  const f = pacingFixture();
  f.config.behaviors.find((entry) => entry.name === "Rest").frequency = 0;
  f.config.actions.Rest.children[0].attributes.Duration = "3";
  f.start("Rest"); f.ticks(6);
  assert.notEqual(f.engine.currentBehaviorName, "Rest");
  assert.equal(f.events.find((e) => e.kind === "behavior" && e.from === "Rest").reason, "behavior-end");
});

test("Pacing: repeat weighting changes a global pick but preserves a required next-list", () => {
  const f = pacingFixture({ repeatBehaviorWeight: 0.65 });
  f.config.behaviors = ["Rest", "Show"].map((name, id) =>
    ({ name, id, frequency: 100, nextBehaviors: [] }));
  f.start("Show"); f.engine.onBehaviorEnd();
  assert.equal(f.engine.currentBehaviorName, "Rest", "Equal global weights should favor the alternative at this fixed draw");
  f.config.behaviors[1].addNext = false;
  f.config.behaviors[1].nextBehaviors = [{ name: "Show", frequency: 100 }];
  f.start("Show"); f.engine.onBehaviorEnd();
  assert.equal(f.engine.currentBehaviorName, "Show", "Required XML next-list must remain authoritative");
});

test("Pacing: registered hold policies survive layer merging, cloning and JSON reload", () => {
  const f = pacingFixture();
  f.config.actions.Sit.poses = [f.pose("/sit.png", 2)];
  f.pkg.registerPreset("gentle", { actionHoldLimits: { Sit: { ticks: [8, 8], waitPoses: [0] }, Sprawl: { ticks: 12, waitPoses: [0] } }, repeatBehaviorWeight: 0.8 });
  const copy = f.pkg.getPreset("gentle"); copy.actionHoldLimits.Sit.ticks[0] = 999; copy.actionHoldLimits.Sit.waitPoses[0] = 999;
  f.pkg.usePreset("gentle");
  const cfg = f.Engine.setAnimationConfig({ preset: "gentle",
    defaults: { actionHoldLimits: { Sit: { ticks: 6, waitPoses: [0] } } },
    reducedMotion: { actionHoldLimits: { Sit: { ticks: 5, waitPoses: [0] } } },
    mascots: { Neuron: { actionHoldLimits: { Sit: { ticks: 4, waitPoses: [0] } } } } });
  cfg.setReducedMotion(true);
  const reloaded = f.Engine.setAnimationConfig(cfg.toJSON()); reloaded.setReducedMotion(true);
  assert.equal(reloaded.holdLimitTicks("Neuron", "Sit"), 4);
  assert.equal(reloaded.holdLimitTicks("Eviling", "Sit"), 5);
  assert.equal(reloaded.holdLimitTicks("Neuron", "Sprawl"), 12);
  assert.equal(reloaded.optionsFor("Neuron").repeatBehaviorWeight, 0.8);
  f.config.actions.Rest.children[0].attributes.Duration = "1000";
  f.start("Rest"); f.ticks(4);
  assert.equal(f.engine.currentLeaf().name, "Rest", "Reloaded policy must actually shorten the hold");
  f.pkg.usePreset("classic");
  f.Engine.setAnimationConfig({ preset: "classic" });
  f.start("Rest"); f.ticks(4);
  assert.equal(f.engine.currentLeaf().name, "Sit", "Switching to classic must remove the hold policy");
  f.Engine.setAnimationConfig({ preset: "gentle" });
  f.start("Rest"); f.ticks(8);
  assert.equal(f.engine.currentLeaf().name, "Rest", "Mutating a returned preset must not mutate registered ranges");
});

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

test("Behavior API: Mascot and MascotGroup bouncy methods delegate correctly", () => {
  const { pkg, createEngine } = fixture();
  const engine = createEngine("Neuron");
  const mascot = new pkg.Mascot(engine);

  // Mascot delegation
  assert.equal(mascot.getBouncy(), false);
  mascot.setBouncy(true, { frequency: 4.0, squashAmount: 0.15 });
  assert.equal(mascot.getBouncy(), true);
  assert.equal(mascot.getBouncyOptions().frequency, 4.0);
  assert.equal(mascot.getBouncyOptions().squashAmount, 0.15);

  mascot.setBouncy(false);
  assert.equal(mascot.getBouncy(), false);

  // MascotGroup delegation
  const eviling = createEngine("Eviling");
  const group = new pkg.MascotGroup();
  group.activeEngines.push(engine, eviling);

  // 全局设置
  group.setBouncy(true, { frequency: 5.0 });
  assert.equal(engine.getBouncy(), true);
  assert.equal(eviling.getBouncy(), true);
  assert.equal(group.getBouncy(), true);
  assert.equal(group.getBouncyOptions()?.frequency, 5.0);

  // 指定 pack 单独调整
  group.setBouncy(false, undefined, "Eviling");
  assert.equal(engine.getBouncy(), true);
  assert.equal(eviling.getBouncy(), false);
  assert.equal(group.getBouncy("Neuron"), true);
  assert.equal(group.getBouncy("Eviling"), false);
});

