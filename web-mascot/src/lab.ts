/**
 * Interaction lab — drives the *real* engine and measures the two-pet
 * affordance chain end to end.
 *
 * Phase 1  unit level  : BroadcastManager offer / availability / distance / Δy
 *                        gates, broken handshake, release.
 * Phase 2  campaign    : N seeded trials of two mascots, driven tick by tick by
 *                        hand (rAF stubbed out) so simulated minutes cost
 *                        seconds. Per tick it samples the two positions and the
 *                        live offer table, so "reachable" is measured, not
 *                        assumed.
 * Phase 3  live        : real rAF restored, two mascots left on screen.
 *
 * The report is POSTed to the Vite /__mascot-log middleware (logs/<session>/)
 * and mirrored into <pre id="out">.
 */
import { MascotEngine } from "./core/MascotEngine";
import type { EngineEvent } from "./core/MascotEngine";
import { BroadcastManager } from "./core/Broadcast";
import { XMLParser } from "./core/XMLParser";

const TICK_MS = 40;
const TICKS_PER_MINUTE = 60000 / TICK_MS; // 1500
/** `?trials=4&ticks=30000` widens each observation window (gap tails need long
 *  windows: a 6-minute window cannot show a 10-minute silence). */
const query = new URLSearchParams(location.search);
const TRIALS = Number(query.get("trials") ?? 20);
const TICKS_PER_TRIAL = Number(query.get("ticks") ?? 9000); // 6 simulated minutes by default
const CHUNK = 250; // ticks between event-loop yields

const stage = document.getElementById("stage") as HTMLElement;
const out = document.getElementById("out") as HTMLElement;
const report: string[] = [];
function put(line = "") {
  report.push(line);
  out.textContent = report.join("\n");
  out.scrollTop = out.scrollHeight;
}

// ---------------------------------------------------------------- seeded rng
// The engine is the only consumer of Math.random (one weighted pick per
// behaviour end), so seeding it makes the whole campaign reproducible.
let rngState = 0x1234abcd;
function seedRandom(seed: number) {
  rngState = seed | 0;
}
function seededRandom(): number {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const realRandom = Math.random;
const realRaf = window.requestAnimationFrame.bind(window);
const realCaf = window.cancelAnimationFrame.bind(window);

// ------------------------------------------------------------- 1. unit tests
function unitTests(): number {
  let pass = 0;
  let fail = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    if (ok) {
      pass++;
      put(`  PASS  ${name}`);
    } else {
      fail++;
      put(`  FAIL  ${name}${detail ? `  [${detail}]` : ""}`);
    }
  };

  put("[1] BroadcastManager 单元验证  (libshijima broadcast/manager.cc)");
  check("MAX_SCAN_DISTANCE = 256", BroadcastManager.MAX_SCAN_DISTANCE === 256, String(BroadcastManager.MAX_SCAN_DISTANCE));

  const m = new BroadcastManager();
  const server = m.startBroadcast("CuddleNeuro", { x: 100, y: 500 });
  check("startBroadcast → probe 看到 1 个 live", m.probe("CuddleNeuro", { x: 0, y: 500 }).live === 1);
  check("未知 affordance → probe 0", m.probe("CuddleEvil", { x: 0, y: 500 }).live === 0);

  const far = m.tryConnect("CuddleNeuro", { x: 100 + 257, y: 500 }, "IHugYou", "IAmHugged");
  check("距离 257 > 256 → 拒绝连接", far === null);

  const dy = m.tryConnect("CuddleNeuro", { x: 150, y: 502 }, "IHugYou", "IAmHugged");
  check("|Δy| = 2 > 1 → 拒绝连接（不同表面）", dy === null);

  const handle = m.tryConnect("CuddleNeuro", { x: 250, y: 500 }, "IHugYou", "IAmHugged");
  check("距离 150 ≤ 256 且 |Δy| = 0 → 连接成功", !!handle);
  check("连接后 offer 变为不可用", !server.isAvailable);
  check("第二个扫描者拿不到同一个 offer", m.tryConnect("CuddleNeuro", { x: 260, y: 500 }, "IHugYou", "IAmHugged") === null);
  check("offer 被认领后 live 仍为 1（active，只是 unavailable）", m.probe("CuddleNeuro", { x: 0, y: 500 }).live === 1);

  const serverSide = server.interaction();
  const clientSide = handle!.interaction();
  check("server/client 共享 ongoing 标志", serverSide.ongoing && clientSide.ongoing);
  check("握手携带双方行为名", serverSide.behavior === "IAmHugged" && clientSide.behavior === "IHugYou");
  serverSide.finalize();
  check("任一方 finalize → ongoing = false", !clientSide.ongoing && !serverSide.ongoing);

  handle!.finalize();
  check("扫描者中途放弃 → offer 重新可用", server.isAvailable);
  const again = m.tryConnect("CuddleNeuro", { x: 250, y: 500 }, "IHugYou", "IAmHugged");
  check("释放后可被再次认领", !!again);

  again!.notifyArrival();
  check("到达后 didMeetUp = true", server.didMeetUp);
  check("到达同时结束广告（active=false）", !server.active);
  check("offer 结束 → 从 live 中消失", m.probe("CuddleNeuro", { x: 0, y: 500 }).live === 0);
  check("snapshot() 只报告 live>0 的 affordance", Object.keys(m.snapshot()).length === 0);

  put(`  → ${pass} passed, ${fail} failed`);
  put();
  return fail;
}

// ---------------------------------------------------------------- engine bits
type AnyEngine = {
  x: number;
  y: number;
  spriteScale: number;
  init(): Promise<void>;
  destroy(): void;
};

function makeContainers() {
  stage.innerHTML = "";
  const containers: HTMLElement[] = [];
  for (let i = 0; i < 2; i++) {
    const div = document.createElement("div");
    div.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;";
    stage.appendChild(div);
    containers.push(div);
  }
  return containers;
}

async function spawnPair(containers: HTMLElement[], packs: string[]): Promise<AnyEngine[]> {
  const engines: AnyEngine[] = [];
  for (let i = 0; i < 2; i++) {
    const engine = new MascotEngine(containers[i], packs[i]) as unknown as AnyEngine;
    await engine.init();
    engines.push(engine);
  }
  return engines;
}

// ------------------------------------------------------------- 2. campaign
/** Wilson score interval, 95%. */
function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - m) / d), Math.min(1, (c + m) / d)];
}

/** Normal-approximation interval for a count (Poisson), expressed per minute. */
function poissonCI(k: number, minutes: number): [number, number] {
  const sd = Math.sqrt(Math.max(1, k));
  return [Math.max(0, (k - 1.96 * sd) / minutes), (k + 1.96 * sd) / minutes];
}

interface Stats {
  offer: number;
  connect: number;
  scanMiss: number;
  scanNoOffer: number;
  scanWithOffer: number;
  arrive: number;
  interactionSwitch: number;
  behaviorSwitches: number;
  connectDistances: number[];
  connectBeyondConfig: number;
  offerToConnect: number[];
  connectToArrive: number[];
  unresolvedConnect: number[];
  abortedByOfferer: number;
  engineAbort: number;
  serveTimeout: number;
  offerLifetime: number[];
  arrivalTicks: number[];
  gaps: number[];
  headGaps: number[];
  tailGaps: number[];
  picksPerBehavior: Map<string, number>;
  retries: Map<string, number>;
}

function newStats(): Stats {
  return {
    offer: 0,
    connect: 0,
    scanMiss: 0,
    scanNoOffer: 0,
    scanWithOffer: 0,
    arrive: 0,
    interactionSwitch: 0,
    behaviorSwitches: 0,
    connectDistances: [],
    connectBeyondConfig: 0,
    offerToConnect: [],
    connectToArrive: [],
    unresolvedConnect: [],
    abortedByOfferer: 0,
    engineAbort: 0,
    serveTimeout: 0,
    offerLifetime: [],
    arrivalTicks: [],
    gaps: [],
    headGaps: [],
    tailGaps: [],
    picksPerBehavior: new Map(),
    retries: new Map(),
  };
}

async function campaign(): Promise<void> {
  put("[2] 双宠互动统计学（每 tick 手动步进，rAF 已停用）");
  put(`    试验 ${TRIALS} × ${TICKS_PER_TRIAL} ticks = ${TRIALS * TICKS_PER_TRIAL} ticks ≈ ${((TRIALS * TICKS_PER_TRIAL) / TICKS_PER_MINUTE).toFixed(0)} 模拟分钟`);

  const containers = makeContainers();
  const animationConfig = MascotEngine.getAnimationConfig();
  const scale = animationConfig.mascotScale("Neuron");
  const scanPx = animationConfig.scanDistancePx("Neuron");

  // Which behaviours need a partner? Same rule as MascotEngine.needsPartnerToAct()
  // (ScanMove / Interact / Affordance anywhere in the action tree, following
  // ActionReference), evaluated with the same parser over the same pack files.
  const partnerBehaviors = new Set<string>();
  for (const pack of ["Neuron", "Eviling"]) {
    const cfg = await XMLParser.loadConfig(pack, `${MascotEngine.PACK_BASE_URL}/${pack}`);
    const walk = (node: any, visited: Set<any>): boolean => {
      if (!node || visited.has(node)) return false;
      visited.add(node);
      const cls = String(node.className ?? "");
      if (cls.endsWith(".ScanMove") || cls.endsWith(".Interact")) return true;
      if (typeof node.attributes?.Affordance === "string" && node.attributes.Affordance !== "") return true;
      if (node.type === "ActionReference" && node.referenceName) {
        const referenced = cfg.actions[node.referenceName];
        if (referenced && walk(referenced, visited)) return true;
      }
      for (const child of node.children ?? []) if (walk(child, visited)) return true;
      return false;
    };
    for (const [name, action] of Object.entries(cfg.actions)) {
      if (walk(action as any, new Set())) partnerBehaviors.add(name);
    }
  }
  put(`    伙伴行为（按动作结构识别）: ${[...partnerBehaviors].sort().join(", ")}`);
  put(`    scanDistancePx = ${scanPx}px(页)  mascotScale = ${scale}  durationScale = ${animationConfig.scale("Neuron")}  interactionCooldown = ${animationConfig.interactionCooldown("Neuron")} ticks`);
  put(`    引擎内部的门槛是「虚拟单位」: tryConnect 用 |Δx| ≤ ${scanPx}(虚拟), partnerReachable 用 |Δx| ≤ ${(scanPx / scale).toFixed(1)}(虚拟)`);
  put();

  const aggregate = newStats();
  const perTrial: { arrive: number; connect: number; scanMiss: number; offer: number }[] = [];
  let tickTotal = 0;
  let sameSurfaceTicks = 0;
  let withinConnectTicks = 0; // dx ≤ 520/scale → page 650 px  (tryConnect gate)
  let withinWeightTicks = 0; // dx ≤ 416/scale → page 520 px  (partnerReachable gate)
  let offerLiveTicks = 0;
  let trace: string[] = [];

  for (let trial = 0; trial < TRIALS; trial++) {
    seedRandom(0x5eed0000 + trial * 7919);
    const stats = newStats();
    MascotEngine.setAnimationConfig(animationConfig.toJSON());
    const engines = await spawnPair(containers, ["Neuron", "Eviling"]);
    let globalTick = 0;
    let traceArmed = false;
    let traceCount = 0;
    const offerQueue = new Map<string, number[]>();
    const lastConnectTick = new Map<string, number>();
    const pendingConnect = new Map<string, number>();
    /** The offer this engine currently has on the air, and when it was raised. */
    const liveOffer = new Map<string, { affordance: string; tick: number }>();
    /** A scanner's outstanding claim: who it claimed and who advertised it. */
    const pendingClaim = new Map<string, { offerer: string; tick: number }>();

    const observer = (_engine: MascotEngine, event: EngineEvent) => {
      const label = _engine.label;
      if (event.kind === "milestone") {
        if (event.name === "broadcast-start") {
          stats.offer++;
          liveOffer.set(label, { affordance: event.affordance ?? "", tick: globalTick });
          const queue = offerQueue.get(event.affordance ?? "") ?? [];
          queue.push(globalTick);
          offerQueue.set(event.affordance ?? "", queue);
          if (trace.length < 40) trace.push(`     t+${String(globalTick).padStart(5)} ${label}  offer     ${event.affordance}  @(${event.x.toFixed(0)},${event.y.toFixed(0)})`);
          if (!traceArmed) {
            traceArmed = true;
            trace.push(`  —— 首次握手追踪（试验 ${trial + 1}）——`);
            trace.push(`     t+${String(globalTick).padStart(5)} ${label}  offer     ${event.affordance}  @(${event.x.toFixed(0)},${event.y.toFixed(0)})`);
          }
        } else if (event.name === "broadcast-connect") {
          stats.connect++;
          if (typeof event.distance === "number") {
            stats.connectDistances.push(event.distance);
            if (event.distance > scanPx) stats.connectBeyondConfig++;
          }
          const queue = offerQueue.get(event.affordance ?? "");
          // Offers of the same affordance can overlap, and the scan claims the
          // nearest one, not the oldest. Pairing is therefore only unambiguous
          // while a single offer of that affordance is outstanding; ambiguous
          // windows are skipped rather than reported as a made-up latency.
          if (queue && queue.length === 1) stats.offerToConnect.push(globalTick - queue[0]);
          if (queue) queue.length = 0;
          pendingConnect.set(label, globalTick);
          lastConnectTick.set(label, globalTick);
          for (const [offerer, offer] of liveOffer) {
            if (offerer !== label && offer.affordance === (event.affordance ?? "")) {
              pendingClaim.set(label, { offerer, tick: offer.tick });
              break;
            }
          }
          if (traceArmed && traceCount++ < 12)
            trace.push(`     t+${String(globalTick).padStart(5)} ${label}  connect   ${event.affordance} → ${event.behavior}  距离 ${event.distance?.toFixed(0)}px  @(${event.x.toFixed(0)},${event.y.toFixed(0)})`);
        } else if (event.name === "broadcast-abort") {
          stats.engineAbort++;
          if (traceArmed && traceCount++ < 12)
            trace.push(`     t+${String(globalTick).padStart(5)} ${label}  ABORT     ${event.affordance} (广告方提前收手)`);
        } else if (event.name === "broadcast-serve-timeout") {
          stats.serveTimeout++;
          if (traceArmed && traceCount++ < 12)
            trace.push(`     t+${String(globalTick).padStart(5)} ${label}  TIMEOUT   ${event.affordance} (等待超时)`);
        } else if (event.name === "broadcast-scan") {
          stats.scanMiss++;
          const live = Number(/live=(\d+)/.exec(event.detail)?.[1] ?? "0");
          if (live > 0) stats.scanWithOffer++;
          else stats.scanNoOffer++;
        } else if (event.name === "interaction-arrived") {
          stats.arrive++;
          stats.arrivalTicks.push(globalTick);
          const from = lastConnectTick.get(label);
          if (from !== undefined) stats.connectToArrive.push(globalTick - from);
          pendingConnect.delete(label);
          pendingClaim.delete(label);
          if (traceArmed && traceCount++ < 12)
            trace.push(`     t+${String(globalTick).padStart(5)} ${label}  arrive    ${event.behavior}  target=(${event.target?.[0].toFixed(0)},${event.target?.[1].toFixed(0)})  @(${event.x.toFixed(0)},${event.y.toFixed(0)})`);
        }
      } else if (event.kind === "behavior") {
        // setBehavior() runs releaseStack(), so any advertisement this pet owned is
        // finalized the moment it switches — and any scanner mid-approach is then
        // dropped by the `!client.connected` guard with no event of its own.
        const offer = liveOffer.get(label);
        if (offer) {
          stats.offerLifetime.push(globalTick - offer.tick);
          liveOffer.delete(label);
        }
        for (const [scanner, claim] of pendingClaim) {
          if (claim.offerer === label) {
            stats.abortedByOfferer++;
            pendingClaim.delete(scanner);
          }
        }
        stats.behaviorSwitches++;
        stats.picksPerBehavior.set(event.to, (stats.picksPerBehavior.get(event.to) ?? 0) + 1);
        if (event.reason === "interaction-server" || event.reason === "interaction-client") {
          stats.interactionSwitch++;
          if (traceArmed && traceCount++ < 12)
            trace.push(`     t+${String(globalTick).padStart(5)} ${label}  切换 ${event.to}  (${event.reason})`);
        }
      }
    };
    MascotEngine.addObserver(observer);

    for (let done = 0; done < TICKS_PER_TRIAL; ) {
      const slice = Math.min(CHUNK, TICKS_PER_TRIAL - done);
      for (let i = 0; i < slice; i++) {
        for (const engine of engines) (engine as unknown as { tick(): void }).tick();
        globalTick++;
        const [a, b] = engines;
        const dy = Math.abs(a.y - b.y);
        const dx = Math.abs(a.x - b.x);
        tickTotal++;
        if (dy <= 1) sameSurfaceTicks++;
        if (dy <= 1 && dx <= scanPx) withinConnectTicks++;
        if (dy <= 1 && dx <= scanPx / scale) withinWeightTicks++;
        if (Object.keys(MascotEngine.getBroadcasts().snapshot()).length > 0) offerLiveTicks++;
      }
      done += slice;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    MascotEngine.removeObserver(observer);
    for (const [, at] of pendingConnect) stats.unresolvedConnect.push(TICKS_PER_TRIAL - at);
    // Silence gaps inside this window only: a gap spanning two trials would be an
    // artefact of the harness restarting the pair, not of the engine.
    for (let i = 1; i < stats.arrivalTicks.length; i++) stats.gaps.push(stats.arrivalTicks[i] - stats.arrivalTicks[i - 1]);
    stats.headGaps.push(stats.arrivalTicks.length ? stats.arrivalTicks[0] : TICKS_PER_TRIAL);
    stats.tailGaps.push(stats.arrivalTicks.length ? TICKS_PER_TRIAL - stats.arrivalTicks[stats.arrivalTicks.length - 1] : TICKS_PER_TRIAL);
    perTrial.push({ arrive: stats.arrive, connect: stats.connect, scanMiss: stats.scanMiss, offer: stats.offer });
    aggregate.offer += stats.offer;
    aggregate.connect += stats.connect;
    aggregate.scanMiss += stats.scanMiss;
    aggregate.scanNoOffer += stats.scanNoOffer;
    aggregate.scanWithOffer += stats.scanWithOffer;
    aggregate.arrive += stats.arrive;
    aggregate.interactionSwitch += stats.interactionSwitch;
    aggregate.behaviorSwitches += stats.behaviorSwitches;
    aggregate.connectDistances.push(...stats.connectDistances);
    aggregate.connectBeyondConfig += stats.connectBeyondConfig;
    aggregate.offerToConnect.push(...stats.offerToConnect);
    aggregate.connectToArrive.push(...stats.connectToArrive);
    aggregate.unresolvedConnect.push(...stats.unresolvedConnect);
    aggregate.abortedByOfferer += stats.abortedByOfferer;
    aggregate.engineAbort += stats.engineAbort;
    aggregate.serveTimeout += stats.serveTimeout;
    aggregate.offerLifetime.push(...stats.offerLifetime);
    aggregate.arrivalTicks.push(...stats.arrivalTicks);
    aggregate.gaps.push(...stats.gaps);
    aggregate.headGaps.push(...stats.headGaps);
    aggregate.tailGaps.push(...stats.tailGaps);
    for (const [k, v] of stats.picksPerBehavior) aggregate.picksPerBehavior.set(k, (aggregate.picksPerBehavior.get(k) ?? 0) + v);

    for (const engine of engines) engine.destroy();
    containers.forEach((c) => (c.innerHTML = ""));
  }

  // -------- report --------
  const minutes = tickTotal / TICKS_PER_MINUTE;
  const pct = (x: number, n: number) => (n === 0 ? "n/a" : `${((100 * x) / n).toFixed(3)}%`);
  const perMin = (x: number) => (x / minutes).toFixed(2);

  put("    每次试验（arrive = 完整握手次数）：");
  perTrial.forEach((t, i) =>
    put(`      试验 ${String(i + 1).padStart(2)}: offer=${String(t.offer).padStart(4)} connect=${String(t.connect).padStart(4)} miss=${String(t.scanMiss).padStart(4)} arrive=${String(t.arrive).padStart(3)}`),
  );
  put();
  put(`    总计 ticks=${tickTotal}  ≈ ${minutes.toFixed(1)} 模拟分钟`);
  put(`    offer(broadcast-start)      ${String(aggregate.offer).padStart(6)}   ${perMin(aggregate.offer)}/min`);
  put(`    connect(broadcast-connect)  ${String(aggregate.connect).padStart(6)}   ${perMin(aggregate.connect)}/min`);
  put(`    miss   (broadcast-scan)     ${String(aggregate.scanMiss).padStart(6)}   ${perMin(aggregate.scanMiss)}/min`);
  put(`    arrive (interaction-arrived)${String(aggregate.arrive).padStart(6)}   ${perMin(aggregate.arrive)}/min  ← 完整握手`);
  put(`    互动行为切换（interaction-* reason）${String(aggregate.interactionSwitch).padStart(6)}`);
  put();
  put(`    同表面 tick 占比            ${pct(sameSurfaceTicks, tickTotal)}  (${sameSurfaceTicks})`);
  put(`    在 tryConnect 门槛内(≤${scanPx}虚拟)   ${pct(withinConnectTicks, tickTotal)}  (${withinConnectTicks})`);
  put(`    在 partnerReachable 内(≤${(scanPx / scale).toFixed(1)}虚拟) ${pct(withinWeightTicks, tickTotal)}  (${withinWeightTicks})`);
  put(`    场上存在 offer 的 tick 占比 ${pct(offerLiveTicks, tickTotal)}  (${offerLiveTicks})`);
  put();
  put("    概率估计：");
  const acceptCI = wilson(aggregate.connect, aggregate.connect + aggregate.scanMiss);
  const acceptLiveCI = wilson(aggregate.connect, aggregate.connect + aggregate.scanWithOffer);
  const rateCI = poissonCI(aggregate.arrive, minutes);
  put(`      P(一次扫描就找到伙伴)   = connect/(connect+miss) = ${pct(aggregate.connect, aggregate.connect + aggregate.scanMiss)}  95%CI ${(acceptCI[0] * 100).toFixed(1)}–${(acceptCI[1] * 100).toFixed(1)}%`);
  put(`      P(扫描时场上确有 offer → 连上) = ${pct(aggregate.connect, aggregate.connect + aggregate.scanWithOffer)}  95%CI ${(acceptLiveCI[0] * 100).toFixed(1)}–${(acceptLiveCI[1] * 100).toFixed(1)}%`);
  put(`      P(每个 tick 发生一次完整握手) = ${pct(aggregate.arrive, tickTotal)}   (${perMin(aggregate.arrive)} 次/分, 95%CI ${rateCI[0].toFixed(2)}–${rateCI[1].toFixed(2)}/min)`);
  put(`      P(同表面 tick 内发生握手)     = ${pct(aggregate.arrive, sameSurfaceTicks)}`);
  put(`      P(可达 tick 内发生握手)       = ${pct(aggregate.arrive, withinWeightTicks)}   (可达=同表面且 partnerReachable)`);
  put(`      offer 被认领的比率 connect/offer = ${pct(aggregate.connect, aggregate.offer)}`);
  put(`      平均每次完整握手间隔          = ${(minutes / Math.max(1, aggregate.arrive)).toFixed(2)} 模拟分钟 (${((minutes * 60000) / TICK_MS / Math.max(1, aggregate.arrive)).toFixed(0)} ticks)`);
  put();
  const q = (arr: number[], p: number) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(p * arr.length))] : NaN);
  const qs = (arr: number[], p: number) => (arr.length ? q(arr, p).toFixed(0) : "-");
  const dists = aggregate.connectDistances;
  const beyond = aggregate.connectBeyondConfig;
  put("    扫描/连接细节：");
  put(`      扫描尝试 ${aggregate.connect + aggregate.scanMiss} 次: 成功 ${aggregate.connect}, 失败 ${aggregate.scanMiss} (其中场上无 offer ${aggregate.scanNoOffer}，有 offer 却没连上 ${aggregate.scanWithOffer})`);
  put(`      连接时距离(页px): n=${dists.length} min=${dists.length ? Math.min(...dists).toFixed(0) : "-"} p50=${qs(dists, 0.5)} p90=${qs(dists, 0.9)} max=${dists.length ? Math.max(...dists).toFixed(0) : "-"}`);
  put(`      其中距离 > scanDistancePx(${scanPx}px，文档半径) 的连接: ${beyond} / ${dists.length} = ${pct(beyond, dists.length)}  ← tryConnect 用虚拟单位比较，实际半径是 ${(scanPx * scale).toFixed(0)}px`);
  put(`      offer→connect 延迟(tick): n=${aggregate.offerToConnect.length} (仅唯一 offer 窗口) p50=${qs(aggregate.offerToConnect, 0.5)} p90=${qs(aggregate.offerToConnect, 0.9)}`);
  put(`      connect→arrive 延迟(tick): n=${aggregate.connectToArrive.length} p50=${qs(aggregate.connectToArrive, 0.5)} p90=${qs(aggregate.connectToArrive, 0.9)}  max=${qs(aggregate.connectToArrive, 0.999)}`);
  put(`      连上但没等到 arrive 的: ${aggregate.unresolvedConnect.length} / ${aggregate.connect}  剩余到试验结束的 tick = [${aggregate.unresolvedConnect.join(", ")}]`);
  put(`      其中因「广告方切换行为导致 offer 消失、扫描被静默丢弃」= ${aggregate.abortedByOfferer}`);
  put(`      引擎现在自己报告的 broadcast-abort = ${aggregate.engineAbort}, broadcast-serve-timeout = ${aggregate.serveTimeout}`);
  put(`      offer 存活到下一条 behavior 事件(tick): n=${aggregate.offerLifetime.length} p50=${qs(aggregate.offerLifetime, 0.5)} p90=${qs(aggregate.offerLifetime, 0.9)} max=${qs(aggregate.offerLifetime, 0.999)}`);
  put(`      连接→到达完成率 = ${pct(aggregate.arrive, aggregate.connect)}`);
  put();

  put("    无互动时长（同一观察窗口内两次 arrive 之间的间隔）：");
  {
    const g = aggregate.gaps;
    const mins = (t: number) => t / TICKS_PER_MINUTE;
    const allGaps = [...g, ...aggregate.headGaps, ...aggregate.tailGaps];
    const over = (limit: number) => allGaps.filter((x) => x > limit * TICKS_PER_MINUTE).length;
    put(`      样本 n=${g.length} 组内间隔 + ${aggregate.headGaps.length} 个起始空窗 + ${aggregate.tailGaps.length} 个末尾空窗`);
    put(`      组内间隔: 平均 ${mins(g.reduce((a, b) => a + b, 0) / Math.max(1, g.length)).toFixed(2)}  p50 ${mins(q(g, 0.5)).toFixed(2)}  p90 ${mins(q(g, 0.9)).toFixed(2)}  p99 ${mins(q(g, 0.99)).toFixed(2)}  max ${mins(Math.max(0, ...g)).toFixed(2)} 分钟`);
    put(`      >2 分钟: ${over(2)} / ${allGaps.length} = ${pct(over(2), allGaps.length)}    >3 分钟: ${over(3)}    >5 分钟: ${over(5)}    >10 分钟: ${over(10)}`);
    put(`      窗内最长连续无互动 ${mins(Math.max(0, ...allGaps)).toFixed(2)} 分钟（窗口长 ${(TICKS_PER_TRIAL / TICKS_PER_MINUTE).toFixed(0)} 分钟，head/tail 会被窗口边界截断）`);
    // head + interior + tail tile the window exactly, so "total gap time" is always
    // 100%; what matters is how much of the time sits inside a *long* gap.
    const longTicks = allGaps.filter((x) => x > 3 * TICKS_PER_MINUTE).reduce((a, b) => a + b, 0);
    put(`      处在 >3 分钟空窗内的时间占比 = ${pct(longTicks, TICKS_PER_TRIAL * TRIALS)}`);
  }
  put();

  const partnerPicks = [...aggregate.picksPerBehavior].filter(([name]) => partnerBehaviors.has(name)).reduce((s, [, v]) => s + v, 0);
  put("    行为抽取构成（决定 offer/scan 何时被选中）：");
  put(`      全部行为切换 ${aggregate.behaviorSwitches} 次，其中伙伴行为 ${partnerPicks} 次 = ${pct(partnerPicks, aggregate.behaviorSwitches)}`);
  const top = [...aggregate.picksPerBehavior].sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const [name, count] of top) put(`        ${name.padEnd(26)} ${String(count).padStart(5)}  ${pct(count, aggregate.behaviorSwitches)}${partnerBehaviors.has(name) ? "  [伙伴]" : ""}`);
  put();
  put("    首次握手事件序列：");
  for (const line of trace) put(line);
  put();
}

// ------------------------------------------------------------- 3. live phase
async function livePhase(): Promise<void> {
  put("[3] 实时阶段：恢复 rAF，两只宠物留在页面上");
  window.requestAnimationFrame = realRaf;
  window.cancelAnimationFrame = realCaf;
  makeContainers();
  await spawnPair([...stage.children] as HTMLElement[], ["Neuron", "Eviling"]);
  put("    已启动 1-Neuron + 2-Eviling（真实 rAF / 40ms tick）");
}

// ---------------------------------------------------------------------- main
(async () => {
  put("web-mascot 双宠互动链路实测");
  put(`页 ${window.innerWidth}×${window.innerHeight}  动画配置 ${MascotEngine.ANIMATION_CONFIG_URL}`);
  put();
  Math.random = seededRandom;
  window.requestAnimationFrame = (() => 0) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = (() => {}) as typeof window.cancelAnimationFrame;

  await MascotEngine.loadAnimationConfig();
  let failures = 0;
  try {
    failures = unitTests();
  } catch (error) {
    put(`  [1] 抛错: ${String(error)}`);
    failures = -1;
  }
  try {
    await campaign();
  } catch (error) {
    put(`  [2] 抛错: ${error instanceof Error ? error.stack : String(error)}`);
  }

  Math.random = realRandom;
  document.title = failures === 0 ? "LAB-OK" : "LAB-FAIL";

  // Archive the report through the dev middleware so it lands on disk too.
  try {
    await fetch("/__mascot-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session: `lab-${new Date().toISOString().replace(/[:.]/g, "-")}`,
        pet: "_lab",
        lines: report,
      }),
    });
  } catch {
    /* no dev server: the DOM copy is authoritative */
  }

  try {
    await livePhase();
  } catch (error) {
    put(`  [3] 抛错: ${String(error)}`);
  }
})();
