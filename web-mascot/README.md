# web-mascot

在任意网页里养桌宠 — 可在浏览器中运行的 Shimeji 格式桌宠引擎，NeurolingsCE-Qt 的网页移植。

![npm](https://img.shields.io/npm/v/web-mascot)
![code license](https://img.shields.io/badge/code-GPL--3.0--or--later-blue)
![assets license](https://img.shields.io/badge/assets-CC--BY--NC--SA--4.0-orange)

零运行时依赖、框架无关（库本身不依赖 Vue / React）。内置 **Neuron** 与 **Eviling** 两只宠物包：把精灵拷进站点静态目录、一行 `configure()` 即可使用。

---

## ⚠️ 商业使用前必读

**内置的两只宠物包（Neuron / Eviling）是 `CC-BY-NC-SA-4.0`，NC = 非商业。商业产品不得随包分发或提供这两只宠物。**

| 部分 | 许可证 | 能否商用 |
| --- | --- | --- |
| 引擎源码（`dist/`、`src/`） | `GPL-3.0-or-later` | ✅ 可以（但衍生作品必须同样开源） |
| 内置宠物包（`Neuron`、`Eviling`） | `CC-BY-NC-SA-4.0` | ❌ **不可以** |

商业项目请走两条路之一：取得原作者授权，或**换成你自己的宠物包**——引擎接受任何 Shimeji 格式的 pack 目录（见下文"加自己的宠物"）。

完整出处、署名与修改声明见 [NOTICE](NOTICE)；代码许可见 [LICENSE](LICENSE)；每只宠物包目录内另有各自的许可文件。

---

## 安装

```bash
npm install web-mascot
```

## 30 秒上手

先把包里的精灵目录拷到站点的公共静态目录，再显式指定资源基址（**必须在 `createMascot()` 之前调用**）：

```bash
cp -r node_modules/web-mascot/dist/mascot_pack public/mascot_pack
```

```js
import { configure, createMascot } from "web-mascot";

// 指向静态目录下的 mascot_pack；部署在子路径时要带前缀，如 "/blog/mascot_pack"
configure({ assets: "/mascot_pack" });

const mascot = await createMascot({ container: document.body, pack: "Neuron" });
// 之后可调用 mascot.destroy() 移除（可重复调用）
```

`container` 是"这只宠物属于文档的哪一处"的锚点，宠物本身在整个视口内活动。想换成 Eviling 就把 `pack` 改成 `"Eviling"`。如果要同时挂载两只（或多只）宠物，只需并发或连续调用（全局资源配置仅需一次）：

```js
// 并发加载多只宠物
const [neuron, eviling] = await Promise.all([
  createMascot({ container: document.body, pack: "Neuron" }),
  createMascot({ container: document.body, pack: "Eviling" })
]);
// 它们底层共享 BroadcastManager，在发生如“打招呼”等行为时会自动产生双宠互动
```

> **注**：模块通过 `import.meta.url` 推导出的资源基址（`PACK_BASE_URL`）只在**未打包、且包目录被原样服务**的环境下有效（裸 ESM，或原样镜像 `dist/` 的 CDN）。经打包器预构建后，推导值会指向构建产物路径（如 `node_modules/.vite/deps/mascot_pack`、`/_astro/mascot_pack`），所有 pack 请求都会 404，因此必须如上文显式配置。
>
> 另外，`DEFAULT_PACK_BASE_URL`（`"/mascot_pack"`）只在推导**彻底失败**时才兜底；打包环境里推导是「成功但错误」，兜底不会生效——所以「把精灵放到 `/mascot_pack`」这件事本身还不够，必须显式 `configure()`。
>
> **动画行为不需要配置**：引擎自带一套偏活跃的默认预设（普通静止约 8 秒即被推动，长静止动画允许完整播完）。想退回 pack 原生行为（无 pacer、无权重覆盖、无长序列豁免），加一句 `configure({ ignoreBuiltin: true })`；想微调就在静态根放一份 `animation.config.json`，字段说明见 [ANIMATION_CONFIG.md](ANIMATION_CONFIG.md)。

---

## 入口速查

| 导入 | 用途 |
| --- | --- |
| `web-mascot` | 主入口：创建、挂载、销毁宠物 |
| `web-mascot/devtools` | 开发工具：观测日志（记录宠物去了哪里）与库自身诊断日志 |
| `web-mascot/animation.config.json` | 内置默认档的可拷贝副本（引擎已内建同样的值，通常不需要；要改就在静态根放一份） |
| `web-mascot/mascot_pack/*` | 按真实路径取包内精灵（自定义 loader、上传 CDN、`new URL()`） |

> `web-mascot/mascot_pack/*` 是**打包器/Node 的模块解析**能力；浏览器运行时不会解析裸说明符。页面里请用绝对 URL，例如 `/mascot_pack/Neuron/img/shime1.png`。

## API 速查

### 主入口 `web-mascot`

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `createMascot` | `(options) => Promise<Mascot>` | 创建并挂载一只，解析完 pack 且画出首帧后 resolve |
| `configure` | `(options) => void` | **打包环境必须**（须在 `createMascot()` 之前）：`assets`、`animationConfigUrl`、`runtime`；裸 ESM 下可省略 |
| `Mascot` | `class` | `.engine` / `.label` / `.destroy()`（可重复调用） |
| `assetBaseUrl` | `() => string` | 当前**生效**的资源基址 |
| `runtimeOptions` | `() => RuntimeSnapshot` | 当前运行参数（含默认值） |
| `PACK_BASE_URL` | `string` | 推导出的资源基址（仅未打包环境有效；打包后需 `configure` 覆盖） |
| `DEFAULT_PACK_BASE_URL` | `string` | 兜底常量 `"/mascot_pack"` |
| `resolveAssetBase` | `(url?) => string \| undefined` | 从模块 URL 推导包根目录，纯函数 |
| `isConfigured` | `() => boolean` | 是否显式调用过 `configure()`，仅诊断用 |

**类型**：`MascotOptions`、`MascotConfig`、`Mascot`、`RuntimeOptions`、`RuntimeSnapshot`、`Pose`、`ActionNode`、`Behavior`、`Hotspot`、`EngineEvent`、`EngineObserver`。

**高级用法（不承诺语义化版本稳定性）**：`MascotEngine`、`AnimationConfig`、`BroadcastManager`。

### 开发工具入口 `web-mascot/devtools`

| 导出 | 说明 |
| --- | --- |
| `attach(options?)` | 打开/配置**观测日志**（宠物去哪了，每行一个 JSON 记录） |
| `configureLogging(options)` / `disableLogging()` / `loggingState()` | 库自身诊断日志（`[web-mascot] ...`） |
| `setLogSink(sink)` / `addLogSink(sink)` | 观测日志的自定义目的地 |
| `startMascotLogRecorder()` / `stopMascotLogRecorder()` / `isRecording()` / `resetMascotLogRecorder()` | 录制器生命周期 |

> 观测日志与诊断日志是**两套互不相干**的开关，不要混用。发布构建里请用 sink 收集（`attach({ file: false, silent: true, sinks: [...] })`）。

常用覆盖式用法：

```js
import { configure, createMascot } from "web-mascot";
import { attach, configureLogging } from "web-mascot/devtools";

configure({
  assets: "https://cdn.example.com/mascot_pack",  // 换成自己的资源根
  animationConfigUrl: "/animation.config.json",
  runtime: { tickMs: 40 },                        // 未列出的字段保持默认
});

configureLogging({ console: "info" });                        // 库诊断
attach({ console: true, kinds: ["spawn", "behavior", "peer"] }); // 观测记录

const mascot = await createMascot({
  container: document.querySelector("#pet-root"),
  pack: "Neuron",
});
```

---

## 加自己的宠物

引擎是**格式驱动**的：宠物的身份就是你传给 `createMascot({ pack })` 的那个字符串，库代码里没有任何写死的宠物名。一个 pack 目录最少需要：

```
mascot_pack/MyPet/
├── actions.xml      # 必需：动作与逐帧图像
├── behaviors.xml    # 必需：行为与权重
└── img/             # 必需：<Pose Image="..."> 引用的图片
    └── shime1.png
```

然后：

```js
configure({ assets: "/mascot_pack" });                  // 当前为全局资源根
const pet = await createMascot({ container: document.body, pack: "MyPet" });
```

**当前限制（重要）**：`assets` 是**全局**设置，页面内所有宠物共用一个资源根。所以"内置 Neuron + 你自己的 MyPet（放在别处）"目前需要在同一个目录下提供两者。按宠物单独指定资源根在路线图上。

资源服务的两个要求：

- 精灵文件名必须与 XML 里的 `Image` 属性**完全一致**（例如 `Image="/shime1.png"` 就要求文件叫 `shime1.png`）；静态服务器要给出正确的 `Content-Type: image/png`。
- 资源与页面不同源时需要允许 CORS（XML 用 `fetch` 读取，必须放行）。

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/API.md](docs/API.md) | 对外接口契约：入口、全部导出、运行参数、输入手势、日志格式、已知约束 |
| [ANIMATION_CONFIG.md](ANIMATION_CONFIG.md) | 动画配置文件字段详解（节奏、权重、活动区域等） |
| [NOTICE](NOTICE) | 许可证拆分、上游署名、GPLv3 §7 附加条款、对内嵌宠物包的修改声明 |

## 许可证与署名

**本包不是单一许可证。** `package.json` 声明的是 `"SEE LICENSE IN LICENSE"` —— 写成单一 SPDX 标识（例如 `GPL-3.0-or-later`）会让人误以为整个 tarball 适用同一许可。包根 [`LICENSE`](LICENSE) 划定下面两部分的适用范围，并附两份许可**全文**；[`NOTICE`](NOTICE) 载明上游署名、GPLv3 §7 附加条款与资产修改声明。

- **软件**（`dist/`、`src/`、`docs/`）：`GPL-3.0-or-later`。本包是下列 GPLv3-or-later 项目的衍生作品，可直接溯源：
  - [libshijima](https://github.com/pixelomer/libshijima) — Copyright (C) 2024-2025 pixelomer
  - [Shijima-Qt](https://github.com/pixelomer/Shijima-Qt) — Copyright (C) 2025 pixelomer
  - [NeurolingsCE-Qt](https://github.com/qingchenyouforcc/NeurolingsCE-Qt) — Copyright (c) qingchenyou（作者 轻尘呦；上游 `VERSION.txt` 未声明年份，故不添加）
- **格式来源**：本包不含 Shimeji / Shimeji-ee 的代码，但它读取的 mascot XML 格式与实现的 `com.group_finity.mascot.*` 动作类名来自原版 [Shimeji](http://www.group-finity.com/Shimeji/)（作者 Yuki Yamada，Group Finity）及其英文分支 [Shimeji-ee](https://kilkakon.com/shimeji/)（作者 Kilkakon 与社区）。
- **内置宠物包**（`dist/mascot_pack/Neuron`、`Eviling`）：`CC-BY-NC-SA-4.0`，按角色分别署名 —— 美术 **Paccha**（<https://linktr.ee/paccha_>）；行为配置 **@promote.** 与 **@dalekcraft**；打包、`.mascot` 包格式与 pack 元数据 **qingchenyouforcc**（<https://github.com/qingchenyouforcc>，依据上游 `CHANGELOG.md` 贡献者名单与 `mascot_pack/` 提交作者）；"Neurolings" 角色设定的出处由上游标注为 **@Monikaphobia**（[原帖](https://x.com/Monikaphobia/status/1844272129619132682)）。**非商业**。该许可要求署名、给出许可链接、说明修改情况。
- **两部分是独立作品。** 引擎是格式驱动的：源码里对具体宠物名**零引用**，也不 import 任何资产，删掉两个 pack 目录引擎依然完整工作。所以宠物包是随同一介质分发的独立作品，不在 GPL 覆盖范围内；反过来，GPL 也不授予它们任何商用权利。
- 上游随附、但**本包未移植**的组件（Qt / Duktape / pugixml / rapidxml / libarchive / unarr / ElaWidgetTools / cpp-httplib / libshimejifinder）及其版权归属逐条列在 [NOTICE](NOTICE) §1.3。
- **GPLv3 §7 附加条款**（继承自上游）：须保留原始版权与许可声明；不得冒充官方版本；未经许可不得使用上游商标、Logo 或项目名暗示官方背书。
- 本包是**非官方**的独立网页移植，与上述项目及美术作者无从属或背书关系。
- 本包**无运行时依赖**；随包提供对应源码（`src/`）。

## 状态

`0.0.3` — 接口尚未承诺语义化版本稳定性（0.x 允许破坏性变更）。

**0.0.3 的行为变更**：引擎开始自带默认动画预设（`src/core/animationPreset.ts`），因此**什么都不配置的宿主现在也是这套偏活跃的节奏**，不再是 pack 原生；要回到原生的宿主加 `configure({ ignoreBuiltin: true })`。随包的 `dist/animation.config.json` 改为构建期由同一份数据生成，不再单独维护。

当前只内置 Neuron / Eviling 两只宠物。计划中的方向：通用 Shimeji 规范兼容、按宠物指定资源根、运行时导入用户自己的模型。反馈与问题请提到 [issues](https://github.com/CommentOut64/web-mascot/issues)。

---

## English summary

`web-mascot` is an embeddable, framework-agnostic browser mascot engine — a TypeScript port of the NeurolingsCE-Qt / Shijima-Qt mascot simulation engine. It reads Shimeji-format mascot packs.

Copy the sprites into your static root first, then point the engine at them —
`configure()` is required under any bundler (see the note in the Chinese section):

```bash
cp -r node_modules/web-mascot/dist/mascot_pack public/mascot_pack
```

```js
import { configure, createMascot } from "web-mascot";
configure({ assets: "/mascot_pack" }); // before createMascot()
const mascot = await createMascot({ container: document.body, pack: "Neuron" });
```

- **Code**: `GPL-3.0-or-later` (derivative of libshijima / Shijima-Qt / NeurolingsCE-Qt).
- **Bundled mascot packs (Neuron, Eviling)**: `CC-BY-NC-SA-4.0` — **non-commercial only**. Commercial projects must not ship them; supply your own pack instead.

This package is **not single-licensed**: `package.json` declares `SEE LICENSE IN LICENSE`, and the root LICENSE states the scope of each part and contains both license texts in full. See [NOTICE](NOTICE) for full attribution and modification statements. The rest of this document is in Chinese.
