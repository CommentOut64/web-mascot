import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { realFixture } from "../tests/helpers/real-packs.mjs";

function seeded(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

const inputs = ["src/core/MascotEngine.ts", "src/core/Broadcast.ts", "src/core/idleTiming.ts", "src/core/XMLParser.ts", "src/core/animationPreset.ts", "src/core/AnimationConfig.ts",
  ...["Neuron", "Eviling"].flatMap((pack) => ["actions.xml", "behaviors.xml"].map((file) => `public/mascot_pack/${pack}/${file}`))];
const report = { generated: new Date().toISOString(), tickMs: 40, viewport: [1000, 600], preset: "lively",
  hashes: Object.fromEntries(inputs.map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")])),
  seeds: [1, 17, 20261017], soak: [], sweep: [] };
for (const seed of report.seeds) {
  const f = realFixture(seeded(seed)); f.Engine.setAnimationConfig({ preset: "lively" });
  const a = f.make(), b = f.make("Eviling"); a.x = 410; b.x = 590;
  const result = { seed, simulatedMinutes: 30, offers: 0, connects: 0, arrivals: 0, misses: 0, aborts: 0, invalidChase: 0,
    errors: [], entries: 0, behaviors: {}, idle: {} };
  let reachableSelections = 0;
  f.Engine.addObserver((engine, event) => {
    if (event.kind === "behavior") {
      result.entries++; result.behaviors[event.to] = (result.behaviors[event.to] ?? 0) + 1;
      if (engine.pendingScan) reachableSelections++;
      if (!Number.isFinite(event.tick)) result.errors.push("missing entry tick");
    }
    if (event.kind !== "milestone") return;
    if (event.name === "broadcast-start") result.offers++;
    if (event.name === "broadcast-connect") result.connects++;
    if (event.name === "interaction-arrived") result.arrivals++;
    if (event.name === "broadcast-scan") { result.misses++; if (event.affordance === "SayItBack") result.errors.push("impossible scan"); }
    if (event.name === "broadcast-abort" || event.name === "broadcast-serve-timeout") result.aborts++;
    if (event.name === "border-lost" && engine.currentBehaviorName === "ChaseMouse") result.invalidChase++;
    if (["tick-error", "action-expansion-limit"].includes(event.name)) result.errors.push(event);
    if (event.name === "idle-timing") {
      const match = /action=(\S+) requested=(\d+) effective=(\d+)/.exec(event.detail);
      if (!match || match[2] !== match[3]) { result.errors.push(event); return; }
      (result.idle[match[1]] ??= []).push(Number(match[3]));
    }
  });
  a.forceBehavior("StandUp"); b.forceBehavior("StandUp");
  for (let tick = 0; tick < 30 * 60 * 25; tick++) { a.tick(); b.tick(); }
  assert.deepEqual(result.errors, []);
  assert.equal(result.invalidChase, 0);
  assert.equal(result.misses, 0, "natural selections must not start an unconnected scan");
  assert.equal(result.aborts, 0, "normal reservations must reach their partner");
  assert.ok(result.arrivals > 0, "natural opportunities must produce interactions");
  result.reservations = reachableSelections;
  report.soak.push(result);
  console.log(JSON.stringify({ ...result, behaviors: Object.keys(result.behaviors).length, idle: Object.fromEntries(
    Object.entries(result.idle).map(([name, ticks]) => [name, { count: ticks.length, min: Math.min(...ticks), max: Math.max(...ticks), distinct: new Set(ticks).size }])) }));
}

// Force each real behavior entry once, then observe its first exit instead of
// cutting it after a fixed dwell. Context-bound interactions/drag and unsupported
// desktop actions are recorded separately, never counted as a successful sweep.
for (const name of ["Neuron", "Eviling"]) {
  const f = realFixture(seeded(17)); f.Engine.setAnimationConfig({ preset: "lively" });
  for (const behavior of f.configs.get(name).behaviors) {
    const engine = f.make(name);
    const entry = { pack: name, name: behavior.name, id: behavior.id };
    const action = engine.config.actions[behavior.name];
    if (!engine.behaviorUsable(behavior)) entry.status = "unsupported";
    else if (engine.needsPartnerToAct(behavior.name) || engine.actionTreeMatches(action, (node) =>
      engine.isDraggedAction(node) || engine.isResistAction(node))) entry.status = "requires-interaction-or-pointer";
    else {
      const area = engine.area();
      const positions = [[(area.left + area.right) / 2, area.bottom], [area.left, (area.top + area.bottom) / 2],
        [area.right, (area.top + area.bottom) / 2], [(area.left + area.right) / 2, area.top]];
      let eligible = false;
      for (const [x, y] of positions) {
        for (const lookRight of [false, true]) {
          engine.x = x; engine.y = y; engine.lookRight = lookRight;
          if (engine.evaluateCondition(behavior.condition)) { eligible = true; break; }
        }
        if (eligible) break;
      }
      if (!eligible) {
        entry.status = "requires-environment";
        engine.releaseStack(); f.Engine.liveEngines.delete(engine); report.sweep.push(entry); continue;
      }
      let exit;
      const stop = f.Engine.addObserver((pet, event) => {
        if (pet === engine && event.kind === "behavior" && event.instance > 1 && !exit) exit = event;
      });
      engine.setBehavior(behavior.name, { force: true, snapToSurface: true }, behavior.id);
      const limit = 25 * 180; // Failure watchdog only; never an engine timing setting.
      let ticks = 0;
      while (!exit && ticks < limit) { engine.tick(); ticks++; }
      entry.status = exit ? "completed" : "watchdog";
      entry.ticks = ticks; entry.exit = exit?.reason; entry.policy = exit?.selectionPolicy;
      stop();
    }
    engine.releaseStack(); f.Engine.liveEngines.delete(engine);
    report.sweep.push(entry);
  }
}
mkdirSync("../tmp/scheduling-verification", { recursive: true });
writeFileSync("../tmp/scheduling-verification/report.json", JSON.stringify(report, null, 2));
const summary = Object.fromEntries([...new Set(report.sweep.map((entry) => entry.status))].map((status) =>
  [status, report.sweep.filter((entry) => entry.status === status).length]));
console.log("sweep", JSON.stringify(summary));
const timing = Object.fromEntries(["Stand", "Sit", "Sprawl", "GrabWall", "GrabCeiling"].map((name) => {
  const ticks = report.soak.flatMap((run) => run.idle[name] ?? []);
  return [name, { count: ticks.length, min: Math.min(...ticks), max: Math.max(...ticks), distinct: new Set(ticks).size }];
}));
const markdown = ["# 动作调度验证", "", `生成：${report.generated}`, "",
  "使用真实 Neuron/Eviling XML，1000×600 视口，lively，40ms/tick。随机源为脚本内的固定种子 LCG。以下是加速逻辑模拟，不能当作 90 分钟浏览器墙钟实测。",
  "", "| 种子 | 模拟分钟 | 行为进入 | 广播 | 认领 | 抵达 | 空扫 | 中止 | 追鼠错误 |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...report.soak.map((run) => `| ${run.seed} | 30 | ${run.entries} | ${run.offers} | ${run.reservations} | ${run.arrivals} | ${run.misses} | ${run.aborts} | ${run.invalidChase} |`),
  "", "| 保持叶节点 | 次数 | 最短 tick | 最长 tick | 不同时长数 |", "|---|---:|---:|---:|---:|",
  ...Object.entries(timing).map(([name, value]) => `| ${name} | ${value.count} | ${value.min} | ${value.max} | ${value.distinct} |`),
  "", "时长验收依据：animationPreset.ts 中沿用的预算范围，以及实际 XML 的 [150,4,100,4,150]。每次 idle-timing 的 requested 必须等于 effective；表现帧 1/3 保留 4 tick，由 scheduling.test.mjs 验证。",
  "", `143 个 Behavior 条目逐项遍历：${JSON.stringify(summary)}。completed 表示在满足素材环境条件下观察到首次退出；互动/指针类由专用测试覆盖，浏览器不支持的 IE 等环境条目单列，未算作通过。`,
  "", "概率依据：配置权重比和加权累计区间；单元测试用均匀分层的随机输入验证 1:3:6 恰好对应 100:300:600，并验证静态/动态随机表达式的调用次数。没有以两次独立随机运行的表观频率替代概率验收。",
  "", "复现：在 web-mascot 下运行 npm run test:soak。逐项结果、采样明细和输入 SHA-256 见同目录 report.json。自然互动次数不设经验阈值；验收的是有机会时的合法认领、完整前置动作、抵达和零无效扫描。", ""];
writeFileSync("../tmp/scheduling-verification/report.md", markdown.join("\n"));
assert.ok(!report.sweep.some((entry) => entry.status === "watchdog"), "every autonomous supported behavior must exit within the watchdog");
