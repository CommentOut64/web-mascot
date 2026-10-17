import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, parseConfig } from "./helpers/engine-fixture.mjs";
import { realFixture } from "./helpers/real-packs.mjs";


for (const name of ["Neuron", "Eviling"]) {
  test(`Real ${name}: ChaseMouse completes its ceiling/wall departure before the floor dash`, () => {
    for (const [x, y] of [[500, 0], [0, 250], [1000, 250]]) {
      const f = realFixture(); f.Engine.setAnimationConfig({ preset: "lively" });
      const engine = f.make(name); engine.x = x; engine.y = y;
      assert.equal(engine.forceBehavior("ChaseMouse", { snapToSurface: false }), true);
      let sawFall = false, sawDash = false;
      for (let tick = 0; tick < 1000; tick++) {
        engine.tick();
        const leaf = engine.currentLeaf();
        if (leaf?.name === "Falling") sawFall = true;
        if (leaf?.name === "Dash") { sawDash = true; assert.equal(engine.y, 600); break; }
      }
      assert.ok(sawFall, `departure at ${x},${y} must retain its Falling step`);
      assert.ok(sawDash, "fall and bounce must finish before chasing");
    }
  });

  test(`Real ${name}: idle budgets control a complete cycle without changing blink timing or XML`, () => {
    for (const random of [0, 0.5, 0.999999]) {
      const f = realFixture(() => random); f.Engine.setAnimationConfig({ preset: "lively" });
      for (const [behavior, action, low, high] of [
        ["StandUp", "Stand", 150, 250], ["SitDown", "Sit", 200, 350],
        ["LieDown", "Sprawl", 200, 350], ["HoldOntoWall", "GrabWall", 200, 300],
        ["HangFromCeiling", "GrabCeiling", 200, 300],
      ]) {
        const engine = f.make(name);
        // Exercise the actual Stay definition with a long XML hold, independent of behavior aliases.
        engine.config.actions.TestIdle = { name: "TestIdle", type: "Sequence", children: [
          { type: "ActionReference", referenceName: action, attributes: { Duration: "1000" } } ] };
        assert.equal(engine.forceBehavior("TestIdle"), true, behavior);
        engine.advanceActionTree();
        const frame = engine.actionStack.at(-1);
        const expected = low + Math.floor(random * (high - low + 1));
        assert.equal(frame.durationLimit, expected, `${action} budget`);
        assert.deepEqual(Array.from(frame.poseDurations).filter((_, i) => i === 1 || i === 3), [4, 4]);
        assert.equal(frame.poseDurations.reduce((a, b) => a + b, 0), expected);
        assert.equal((frame.node.animations?.[0]?.poses ?? frame.node.poses).reduce((a, p) => a + p.duration, 0), 408);
      }
    }
  });
}

test("Condition scope: ${} is frozen, #{} is live, and child conditions use the child's variables", () => {
  const f = fixture(); const engine = f.createEngine(); engine.y = 600;
  const child = (condition) => ({ type: "Sequence", condition, attributes: { Condition: condition, Flag: "true" },
    children: [{ type: "ActionReference", referenceName: "Stand", attributes: { Duration: "100" } }] });
  f.config.actions.Test = { name: "Test", type: "Sequence", children: [child("${Flag && mascot.lookRight}")] };
  engine.lookRight = true; engine.forceBehavior("Test");
  engine.lookRight = false; for (let i = 0; i < 10; i++) engine.tick();
  assert.equal(engine.currentLeaf().name, "Stand");
  const snapshot = JSON.parse(JSON.stringify(engine.createRelaySnapshot()));
  const target = f.createEngine(); target.restoreRelaySnapshot(snapshot); target.advanceActionTree();
  assert.equal(target.currentLeaf().name, "Stand");
  // Return to the conditional container after its first child; live conditions are checked again.
  f.config.actions.Test.children[0] = child("#{Flag && mascot.lookRight}");
  engine.lookRight = true; engine.forceBehavior("Test");
  engine.lookRight = false; engine.actionStack.pop(); engine.tick();
  assert.notEqual(engine.currentLeaf()?.name, "Stand");
});

test("Frozen random attributes and conditions are sampled once per action instance", () => {
  let calls = 0;
  const f = fixture({ random: () => { calls++; return 0.5; } });
  f.Engine.setAnimationConfig({ preset: "classic" });
  f.config.actions.Test = { name: "Test", type: "Sequence", children: [
    { type: "ActionReference", referenceName: "Stand", condition: "${Math.random() < 1}",
      attributes: { Condition: "${Math.random() < 1}", Duration: "${100 + Math.random()*20}" } },
  ] };
  const engine = f.createEngine(); engine.y = 600; calls = 0; engine.forceBehavior("Test");
  assert.equal(calls, 2);
  for (let i = 0; i < 20; i++) engine.tick();
  assert.equal(calls, 2);
  assert.equal(engine.actionStack.at(-1).durationLimit, 110);
});

test("Interaction eligibility requires the matching live offer, correct peer role, height and distance", () => {
  const f = realFixture(); const neuron = f.make(); const evil = f.make("Eviling");
  assert.equal(neuron.effectiveWeight("NoticeFallingTutel", 20000), 0, "SayItBack has no provider");
  assert.equal(neuron.effectiveWeight("HugEvil", 1000), 0, "a nearby pet alone is not an offer");
  evil.x = 650; evil.forceBehavior("AskForHugs"); evil.advanceActionTree();
  assert.equal(neuron.hasInteractionOpportunity("HugEvil"), true);
  evil.y = 0; evil.maintainBroadcasts(); assert.equal(neuron.hasInteractionOpportunity("HugEvil"), false);
  evil.y = 600; evil.x = 900; evil.maintainBroadcasts(); assert.equal(neuron.hasInteractionOpportunity("HugEvil"), false);
  evil.x = 650; evil.maintainBroadcasts();
  neuron.config.actions.IHugYou = undefined;
  assert.equal(neuron.hasInteractionOpportunity("HugEvil"), false, "both handover actions must exist");
});

test("Natural selection consumes an available hug opportunity and completes the handshake in both roles", () => {
  for (const [serverName, clientName, consumer] of [["Eviling", "Neuron", "HugEvil"], ["Neuron", "Eviling", "HugNeuro"]]) {
    const f = realFixture(); f.Engine.setAnimationConfig({ preset: "lively" });
    const server = f.make(serverName), client = f.make(clientName);
    server.x = 650;
    const events = []; f.Engine.addObserver((engine, event) => events.push({ engine, ...event }));
    server.forceBehavior("AskForHugs"); server.advanceActionTree();
    client.forceBehavior("StandUp");
    let arrived = false;
    for (let tick = 0; tick < 2000; tick++) {
      server.tick(); client.tick();
      if (events.some((event) => event.name === "interaction-arrived")) { arrived = true; break; }
    }
    assert.ok(events.some((event) => event.engine === client && event.kind === "behavior" && event.to === consumer && event.reason === "behavior-end"));
    assert.ok(arrived, `${serverName} advertises, ${clientName} approaches`);
    server.tick();
    assert.ok(server.interaction.started && client.interaction.started);
  }
});

test("Remote floor offers are reserved at completion and reached using the real ScanMove in both roles", () => {
  for (const [serverName, clientName] of [["Eviling", "Neuron"], ["Neuron", "Eviling"]]) {
    const f = realFixture();
    f.Engine.setAnimationConfig({ preset: "lively", defaults: { behaviorWeights: { HurlEvil: 0 } } });
    const server = f.make(serverName), client = f.make(clientName), rival = f.make(clientName);
    server.x = 1000; client.x = 0; rival.x = 100;
    const events = []; f.Engine.addObserver((pet, event) => events.push({ pet, ...event }));
    server.forceBehavior("AskForHugs"); server.advanceActionTree();
    client.forceBehavior("StandUp");
    const consumer = clientName === "Neuron" ? "HugEvil" : "HugNeuro";
    assert.equal(client.hasInteractionOpportunity(consumer), false, "direct scan range is unchanged");
    assert.equal(client.hasReachableInteractionOpportunity(consumer), true);
    client.tick();
    assert.equal(client.currentBehaviorName, "StandUp", "offer cannot interrupt the running hold");
    assert.equal(client.pendingScan, null);
    let arrived = false;
    for (let tick = 0; tick < 1000; tick++) {
      server.tick(); client.tick();
      if (client.pendingScan) {
        assert.equal(rival.reserveInteraction(consumer), undefined, "one reservation per offer");
      }
      if (events.some((event) => event.name === "interaction-arrived")) { arrived = true; break; }
    }
    assert.ok(arrived);
    const milestones = events.filter((event) => event.pet === client && event.kind === "milestone");
    assert.equal(milestones.filter((event) => event.name === "broadcast-reserve").length, 1);
    assert.equal(milestones.filter((event) => event.name === "broadcast-connect").length, 1);
    assert.equal(milestones.filter((event) => ["broadcast-scan", "broadcast-abort"].includes(event.name)).length, 0);
    assert.equal(client.x, server.x);
    server.tick(); assert.ok(server.interaction.started && client.interaction.started);
    for (let tick = 0; tick < 150; tick++) { server.tick(); client.tick(); }
    assert.equal(client.interaction.ongoing, false, "handshake must complete and release both sides");
  }
});

test("Remote reservation follows a moving floor offer and releases on cancellation or lost height", () => {
  for (const cancellation of ["none", "server", "height", "client"]) {
    const f = realFixture();
    f.Engine.setAnimationConfig({ preset: "lively", defaults: { behaviorWeights: { HurlEvil: 0 } } });
    const server = f.make("Eviling"), client = f.make(); server.x = 900; client.x = 0;
    const events = []; f.Engine.addObserver((_, event) => events.push(event));
    server.forceBehavior("AskForHugs"); server.advanceActionTree();
    client.forceBehavior("StandUp"); client.onBehaviorEnd();
    assert.ok(client.pendingScan?.client.reserved);
    for (let tick = 0; tick < 50; tick++) { server.tick(); client.tick(); }
    if (cancellation === "client") {
      client.forceBehavior("StandUp");
      assert.equal(server.actionStack.at(-1).server.isClaimed, false);
      continue;
    }
    if (cancellation === "server") server.forceBehavior("StandUp");
    else if (cancellation === "height") { server.y = 0; server.maintainBroadcasts(); }
    else { server.x = 1000; server.maintainBroadcasts(); }
    for (let tick = 0; tick < 150; tick++) {
      client.tick();
      if (events.some((event) => event.name === "interaction-arrived" || event.name === "broadcast-abort")) break;
    }
    if (cancellation === "none") {
      assert.equal(client.x, 1000, "approach uses the live target position");
      assert.ok(events.some((event) => event.name === "interaction-arrived"));
    } else {
      assert.equal(events.filter((event) => event.name === "broadcast-abort").length, 1);
      assert.equal(events.filter((event) => event.name === "interaction-arrived").length, 0);
    }
  }
});

test("Remote lookup rejects a floor offer at another height and non-floor routes", () => {
  const f = realFixture(); const server = f.make("Eviling"), client = f.make();
  server.x = 900; client.x = 0;
  server.forceBehavior("AskForHugs"); server.advanceActionTree();
  assert.equal(client.hasReachableInteractionOpportunity("HugEvil"), true);
  server.y = 0; server.maintainBroadcasts();
  assert.equal(client.hasReachableInteractionOpportunity("HugEvil"), false);
  server.y = 600; server.maintainBroadcasts();
  const manager = f.Engine.getBroadcasts();
  assert.equal(manager.findReachable("CuddleEvil", { x: 0, y: 600 }, "Wall", client, "IAmHugged"), null);
  const ceiling = manager.startBroadcast("CeilingOffer", { x: 900, y: 0 }, server, () => true, "Ceiling");
  assert.equal(manager.findReachable("CeilingOffer", { x: 0, y: 0 }, "Ceiling", client), null);
  ceiling.finalize();
});

test("Without advertisements the remote lookup preserves the direct-only selection sequence and random calls", () => {
  const run = (directOnly) => {
    let state = 17, calls = 0;
    const f = realFixture(() => { calls++; state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; });
    f.Engine.setAnimationConfig({ preset: "lively" });
    const engine = f.make();
    if (directOnly) engine.hasReachableInteractionOpportunity = (name) => engine.hasInteractionOpportunity(name);
    const entries = [];
    f.Engine.addObserver((_, event) => { if (event.kind === "behavior") entries.push([event.to, event.tick, event.reason]); });
    engine.forceBehavior("StandUp");
    for (let tick = 0; tick < 5000; tick++) engine.tick();
    return { entries, calls };
  };
  assert.deepEqual(run(false), run(true));
});

test("Behavior entry events include same-name restarts and distinguish policy from completion", () => {
  const f = fixture(); f.Engine.setAnimationConfig({ preset: "classic", defaults: { maxBehaviorTicks: 2 } });
  const engine = f.createEngine(); engine.y = 600;
  const events = []; f.Engine.addObserver((_, event) => { if (event.kind === "behavior") events.push(event); });
  engine.forceBehavior("StandUp"); engine.forceBehavior("StandUp");
  assert.equal(events.at(-1).restart, true);
  assert.equal(events.at(-1).instance, events.at(-2).instance + 1);
  for (let i = 0; i < 260; i++) engine.tick();
  const completed = events.find((event) => event.selectionPolicy === "behavior-cap");
  assert.ok(completed); assert.equal(completed.reason, "behavior-end");
  assert.ok(completed.previousTicks >= 250);
});

test("Interaction reservation survives a short offer and releases on explicit cancellation", () => {
  const f = realFixture(); const server = f.make("Eviling"), client = f.make();
  f.Engine.setAnimationConfig({ preset: "lively", defaults: { behaviorWeights: { HurlEvil: 0 } } });
  server.x = 650;
  server.config.actions.SitAffordance.animations[0].poses[0].duration = 1;
  server.config.actions.SitAffordance.animations[0].poses.length = 1;
  server.forceBehavior("AskForHugs"); server.advanceActionTree();
  client.forceBehavior("StandUp"); client.onBehaviorEnd();
  assert.equal(client.currentBehaviorName, "HugEvil");
  assert.ok(client.pendingScan?.client.connected);
  server.tick(); server.tick();
  assert.equal(server.currentBehaviorName, "AskForHugs", "claimed offer must survive the client's prelude");
  client.forceBehavior("StandUp");
  assert.equal(client.pendingScan, null);
  assert.equal(server.actionStack.at(-1).server.isClaimed, false);
  // A fresh short offer must also survive all the way to a normal handshake.
  server.forceBehavior("AskForHugs"); server.advanceActionTree(); client.onBehaviorEnd();
  let arrived = false;
  const stop = f.Engine.addObserver((_, event) => { if (event.name === "interaction-arrived") arrived = true; });
  for (let i = 0; i < 300 && !arrived; i++) { server.tick(); client.tick(); }
  stop(); assert.ok(arrived);
});

test("Interaction eligibility excludes self, wrong handover, claimed offers and cooldown even with explicit weights", () => {
  const f = realFixture(); const client = f.make(), server = f.make("Eviling"), rival = f.make(); server.x = 650;
  f.Engine.setAnimationConfig({ preset: "lively", defaults: { behaviorWeights: { HugEvil: 10000 } } });
  client.forceBehavior("AskForHugs"); client.advanceActionTree();
  assert.equal(client.hasInteractionOpportunity("HugEvil"), false);
  server.forceBehavior("AskForHugs"); server.advanceActionTree();
  server.config.actions.IAmHugged = undefined;
  assert.equal(client.hasInteractionOpportunity("HugEvil"), false);
  server.config.actions.IAmHugged = f.configs.get("Neuron").actions.IAmHugged;
  const reserved = rival.reserveInteraction("HugEvil"); assert.ok(reserved);
  assert.equal(client.hasInteractionOpportunity("HugEvil"), false);
  reserved.client.finalize(); assert.equal(client.hasInteractionOpportunity("HugEvil"), true);
  client.interactionCooldownUntil = 100;
  assert.equal(client.effectiveWeight("HugEvil", 1000), 0);
});

test("Required Add=false chain is retained in the presence of an unrelated live opportunity", () => {
  const f = realFixture(); const server = f.make("Eviling"), client = f.make(); server.x = 650;
  server.forceBehavior("AskForHugs"); server.advanceActionTree();
  const current = client.config.behaviors.find((behavior) => behavior.name === "StandUp");
  current.addNext = false; current.nextBehaviors = [{ name: "SitDown", frequency: 100 }];
  client.forceBehavior("StandUp"); client.onBehaviorEnd();
  assert.equal(client.currentBehaviorName, "SitDown");
  assert.equal(client.pendingScan, null);
});

test("A long target move passes the behavior age threshold and ends only at its target", () => {
  const f = fixture(); f.Engine.setAnimationConfig({ preset: "classic", defaults: { maxBehaviorTicks: 10 } });
  f.config.actions.Walk = { name: "Walk", type: "Move", borderType: "Floor", poses: [
    { image: "/wait.png", imageAnchor: { x: 64, y: 128 }, velocity: { x: 0, y: 0 }, duration: 2 },
    { image: "/step.png", imageAnchor: { x: 64, y: 128 }, velocity: { x: 1, y: 0 }, duration: 1 },
  ], attributes: { TargetX: "900" } };
  const engine = f.createEngine(); engine.x = 100; engine.y = 600; engine.lookRight = true;
  engine.forceBehavior("Walk");
  for (let i = 0; i < 1100; i++) engine.tick();
  assert.equal(engine.currentBehaviorName, "Walk");
  const events = []; const stop = f.Engine.addObserver((_, event) => { if (event.kind === "behavior") events.push(event); });
  for (let i = 0; i < 2000 && engine.currentBehaviorName === "Walk"; i++) engine.tick();
  stop();
  assert.equal(engine.x, 900); assert.equal(events[0].reason, "behavior-end");
  assert.equal(events[0].selectionPolicy, "behavior-cap");
});

test("Weighted selection follows the configured 1:3:6 probabilities across the whole random interval", () => {
  let draw = 0.5; const f = fixture({ random: () => draw }); f.Engine.setAnimationConfig({ preset: "classic" });
  f.config.behaviors = ["StandUp", "SitDown", "FlyAround"].map((name, id) =>
    ({ name, id, frequency: [1, 3, 6][id], hidden: false, nextBehaviors: [] }));
  const engine = f.createEngine(); engine.y = 600; engine.forceBehavior("StandUp");
  const counts = { StandUp: 0, SitDown: 0, FlyAround: 0 };
  for (let i = 0; i < 1000; i++) {
    draw = (i + 0.5) / 1000; engine.behaviorInitsThisTick = 0; engine.onBehaviorEnd(); counts[engine.currentBehaviorName]++;
  }
  assert.deepEqual(counts, { StandUp: 100, SitDown: 300, FlyAround: 600 });
});

test("Live expressions resolve dependencies once per tick regardless of attribute declaration order", () => {
  let calls = 0; const f = fixture({ random: () => { calls++; return 0.5; } });
  const engine = f.createEngine();
  const frame = engine.newFrame({ name: "Test", type: "Stay", attributes: {
    TargetX: "#{Gap + 100}", Gap: "#{Math.random() * 20}", Duration: "${Base * 2}", Base: "${Math.random()*10}",
  } });
  calls = 0;
  assert.equal(engine.varNumber(frame, "TargetX"), 110);
  assert.equal(engine.varNumber(frame, "Duration"), 10);
  assert.equal(calls, 2);
  engine.varNumber(frame, "TargetX"); assert.equal(calls, 2);
  engine.tickCount++;
  assert.equal(engine.varNumber(frame, "TargetX"), 110); assert.equal(calls, 3);
});

test("XML behavior eligibility includes every enclosing Condition and the behavior's own Condition", () => {
  const f = fixture(); const engine = f.createEngine();
  const parsed = parseConfig('<Mascot><ActionList><Action Name="StandUp" Type="Stay"/></ActionList></Mascot>',
    '<Mascot><BehaviorList><Condition Condition="#{true}"><Condition Condition="#{false}"><Behavior Name="StandUp" Frequency="1" Condition="#{true}"/></Condition></Condition></BehaviorList></Mascot>', 'Test');
  assert.equal(engine.evaluateCondition(parsed.behaviors[0].condition), false);
  parsed.behaviors = parseConfig('<Mascot/>', '<Mascot><BehaviorList><Behavior Name="StandUp" Condition="#{false}"/></BehaviorList></Mascot>', 'Test').behaviors;
  assert.equal(engine.evaluateCondition(parsed.behaviors[0].condition), false);
});

test("Reference conditions retain their lifetime after expansion without leaking to siblings", () => {
  const f = fixture(); f.Engine.setAnimationConfig({ preset: "classic" });
  f.config.actions.Test = { name: "Test", type: "Sequence", children: [
    { type: "ActionReference", referenceName: "Stand", condition: "#{mascot.lookRight}", attributes: { Condition: "#{mascot.lookRight}" } },
    { type: "ActionReference", referenceName: "Sit", attributes: { Duration: "100" } },
  ] };
  const engine = f.createEngine(); engine.y = 600; engine.lookRight = true; engine.forceBehavior("Test");
  engine.lookRight = false; engine.tick(); engine.tick();
  assert.equal(engine.currentLeaf().name, "Sit");
});

test("Idle allocation preserves its sampled timings and pose progress across relay", () => {
  const f = realFixture(); f.Engine.setAnimationConfig({ preset: "lively" });
  const source = f.make(); source.forceBehavior("StandUp");
  for (let i = 0; i < 80; i++) source.tick();
  const frame = source.actionStack.at(-1);
  const snapshot = JSON.parse(JSON.stringify(source.createRelaySnapshot()));
  const target = f.make(); assert.equal(target.restoreRelaySnapshot(snapshot), true);
  assert.deepEqual(Array.from(target.actionStack.at(-1).poseDurations), Array.from(frame.poseDurations));
  assert.equal(target.actionStack.at(-1).poseIndex, frame.poseIndex);
  assert.equal(target.actionStack.at(-1).poseTick, frame.poseTick);
  assert.equal(target.actionStack.at(-1).durationLimit, 200);
});

test("Unachievable idle budgets preserve fixed performance frames and report the feasible minimum", () => {
  const f = fixture(); f.Engine.setAnimationConfig({ preset: "classic", defaults: {
    actionHoldLimits: { Sit: { ticks: 1, waitPoses: [0, 2] } },
  } });
  const base = f.config.actions.Sit.poses[0];
  f.config.actions.Sit.poses = [10, 4, 10].map((duration) => ({ ...base, duration }));
  const engine = f.createEngine(); engine.y = 600;
  const events = []; f.Engine.addObserver((_, event) => events.push(event));
  engine.forceBehavior("SitDown");
  assert.deepEqual(Array.from(engine.actionStack.at(-1).poseDurations), [1, 4, 1]);
  assert.match(events.find((event) => event.name === "idle-timing").detail, /requested=1 effective=6/);
});

test("Real hurl interaction completes the throw, ballistic fall, bounce and recovery", () => {
  const f = realFixture(); f.Engine.setAnimationConfig({ preset: "lively" });
  // Keep the flight clear of walls; a real boundary contact legitimately grabs
  // the wall and follows a different physical completion path.
  f.window.innerWidth = 10000;
  const server = f.make("Eviling"), client = f.make(); server.x = 5150; client.x = 5000;
  const leaves = new Set(); let arrived = false, completed = false, minY = 600;
  f.Engine.addObserver((engine, event) => {
    if (event.name === "interaction-arrived") arrived = true;
    if (engine === server && event.kind === "behavior" && event.from === "IAmHurled" && event.reason === "behavior-end") completed = true;
  });
  server.forceBehavior("AskForHugs"); server.advanceActionTree(); client.forceBehavior("HurlEvil");
  for (let i = 0; i < 2500 && !completed; i++) {
    server.tick(); client.tick();
    if (server.currentBehaviorName === "IAmHurled") {
      leaves.add(server.currentLeaf()?.name); minY = Math.min(minY, server.y);
    }
  }
  assert.ok(arrived && completed);
  assert.ok(minY < 500, "the throw must lift the target off the floor");
  // Falling may complete immediately: the preceding ballistic Fall has already
  // reached the floor. The authored bounce and recovery must still be retained.
  for (const leaf of ["HurledAction", "HurledKnockback", "HurledKnockback2", "HurledBounce", "HurledSprawl"]) {
    assert.ok(leaves.has(leaf), `missing authored step: ${leaf}`);
  }
});

test("A landing clears the stillness clock, and a scroll landing also defers interactions", () => {
  const f = realFixture();
  f.Engine.setAnimationConfig({ preset: "lively" });
  const engine = f.make();
  const area = engine.area();

  // 1) Landing after a real fall: an airborne mascot has not "stood still", and a
  //    pending travel intent from before the fall must not survive it.
  engine.x = 300;
  engine.y = area.bottom - 120;
  engine.forceBehavior("Fall", { snapToSurface: false });
  engine.advanceActionTree();
  engine.stillTicks = 400;
  engine.anchorStillTicks = 400;
  engine.wantMovement = true;
  for (let tick = 0; tick < 400 && engine.y < area.bottom; tick++) engine.tick();
  assert.equal(engine.y, area.bottom, "the fall must reach the floor");
  assert.equal(engine.stillTicks, 0, "landing must clear the stillness clock");
  assert.equal(engine.wantMovement, false, "landing must drop the travel intent");

  // 2) Scroll landing (the pet is pushed below the floor while the page scrolls):
  //    the next pick must not be a partner behaviour.
  const scrolled = f.make();
  scrolled.x = 300;
  scrolled.y = area.bottom;
  scrolled.forceBehavior("Fall", { snapToSurface: false });
  scrolled.advanceActionTree();
  scrolled.stillTicks = 400;
  scrolled.wantMovement = true;
  scrolled.pendingScrollShift = -80;
  scrolled.applyScrollIntent();
  assert.equal(scrolled.stillTicks, 0, "scroll landing must clear the stillness clock");
  assert.equal(scrolled.wantMovement, false, "scroll landing must drop the travel intent");
  assert.ok(
    scrolled.interactionCooldownUntil >= scrolled.tickCount + 250,
    "scroll landing must keep partner behaviours out of the pool for the grace window",
  );
});
