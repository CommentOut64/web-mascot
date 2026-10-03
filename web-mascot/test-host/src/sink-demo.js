/**
 * 消费方如何收集观测日志。
 *
 * 这是打包后宿主唯一需要做的事：把 sink 交给 `attach()`，记录器就把每批记录
 * 交给它，完全不依赖任何 dev 服务器。真实项目里把 `batches.push` 换成你的
 * 上报函数（后端接口、IndexedDB、埋点系统）即可。
 */
import { configure, createMascot } from "web-mascot";
import { attach } from "web-mascot/devtools";

const out = document.getElementById("out");
const batches = [];
const allLines = () => batches.flatMap((b) => b.lines);

const render = () => {
  const counts = {};
  for (const line of allLines()) {
    const rec = JSON.parse(line);
    const key = rec.event ? `${rec.k}:${rec.event}` : rec.k;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  out.textContent = [
    `批次: ${batches.length}   记录: ${allLines().length}`,
    `类型: ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(" ") || "(none)"}`,
    `宠物: ${[...new Set(batches.map((b) => b.pet))].join(", ") || "(none)"}`,
    "",
    "记录明细:",
    ...allLines().map((l) => `  ${l}`),
  ].join("\n");
};

// ↓ 生产宿主的写法
attach({
  sinks: [(batch) => {
    batches.push(batch);
    // 真实项目在这里上报：fetch("/api/pet-log", { method: "POST", body: JSON.stringify(batch) })
    render();
  }],
});

configure({ assets: "/assets/packs" });
const container = document.createElement("div");
container.id = "anchor";
document.body.appendChild(container);
const mascot = await createMascot({ container, pack: "Neuron" });
void mascot;
render();
