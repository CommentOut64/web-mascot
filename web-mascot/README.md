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

### 或者：直接导入第三方/自定义 Shimeji ZIP 资源包（无需静态目录部署）

支持直接传入由用户上传的 `File`/`Blob`、`ArrayBuffer` 或远程 ZIP `URL`，纯前端解压并在内存中构建虚拟模型，所有 API 与控制方法完全通用：

```js
import { importMascotPack, createMascot } from "web-mascot";

// 导入 Shimeji-ee 或日版 Shimeji ZIP 资源包（支持 URL、Blob、File）
const { name, warnings, unregister } = await importMascotPack(
  "https://example.com/assets/shimeji-pack.zip"
);

// 像内置模型一样直接创建
const mascot = await createMascot({ container: document.body, pack: name });

// 当不再需要时释放内存
// unregister();
```

> **注**：模块通过 `import.meta.url` 推导出的资源基址（`PACK_BASE_URL`）只在**未打包、且包目录被原样服务**的环境下有效（裸 ESM，或原样镜像 `dist/` 的 CDN）。经打包器预构建后，推导值会指向构建产物路径（如 `node_modules/.vite/deps/mascot_pack`、`/_astro/mascot_pack`），所有 pack 请求都会 404，因此必须如上文显式配置。
>
> 另外，`DEFAULT_PACK_BASE_URL`（`"/mascot_pack"`）只在推导**彻底失败**时才兜底；打包环境里推导是「成功但错误」，兜底不会生效——所以「把精灵放到 `/mascot_pack`」这件事本身还不够，必须显式 `configure()`。
>
> **动画行为与配置预设**：引擎提供标准化的预设注册系统（`PresetRegistry`），默认使用偏活跃的 `"lively"` 预设（温和缩短已知保持段，12 秒静止后在完整行为／循环结束处推动换位，长表演完整播放）。想退回 Qt / Shimeji-ee 原生桌面行为（无 pacer、无权重覆盖、无长序列豁免），调用 `configure({ preset: "classic" })` 即可；如需注册自定义行为风格或微调，请参阅 [ANIMATION_CONFIG.md](ANIMATION_CONFIG.md)。

---

## 入口速查

| 导入 | 用途 |
| --- | --- |
| `web-mascot` | 主入口：创建、挂载、销毁宠物，预设注册与切换 |
| `web-mascot/devtools` | 开发工具：观测日志（记录宠物去了哪里）与库自身诊断日志 |
| `web-mascot/animation.config.json` | 预设配置文件的标准导出模版（通常不需要；需要自定义微调时在静态根放一份） |
| `web-mascot/mascot_pack/*` | 按真实路径取包内精灵（自定义 loader、上传 CDN、`new URL()`） |

> `web-mascot/mascot_pack/*` 是**打包器/Node 的模块解析**能力；浏览器运行时不会解析裸说明符。页面里请用绝对 URL，例如 `/mascot_pack/Neuron/img/shime1.png`。

## API 速查

### 主入口 `web-mascot`

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `createMascot` | `(options) => Promise<Mascot>` | 创建并挂载一只，解析完 pack 且画出首帧后 resolve |
| `importMascotPack` | `(input, options?) => Promise<ImportedMascotPack>` | 纯前端导入 Shimeji ZIP / Blob / URL 资源包，注册为虚拟模型 |
| `registerMascotPack` | `(pack) => void` | 手动注册自定义模型资源包（支持同名替换内置模型） |
| `unregisterMascotPack` | `(name) => void` | 注销虚拟模型并自动释放 Blob URL 内存 |
| `hasMascotPack` | `(name) => boolean` | 查询指定名称的虚拟模型是否已注册 |
| `configure` | `(options) => void` | **打包环境必须**（须在 `createMascot()` 之前）：`assets`、`preset`、`animationConfigUrl`、`runtime` |
| `PresetRegistry` | `class` | 动画行为预设注册中心（内置 `"lively"`、`"classic"`，支持动态扩展与校验） |
| `registerPreset` | `(name, preset) => void` | 便捷注册自定义动画配置预设 |
| `usePreset` | `(name) => void` | 便捷切换全局当前生效的动画预设 |
| `getPreset` | `(name) => MascotAnimationOptions \| undefined` | 获取已注册预设的深拷贝配置 |
| `Mascot` | `class` | `.engine` / `.label` / `.destroy()`（可重复调用） |
| `assetBaseUrl` | `() => string` | 当前**生效**的资源基址 |
| `runtimeOptions` | `() => RuntimeSnapshot` | 当前运行参数（含默认值） |
| `PACK_BASE_URL` | `string` | 推导出的资源基址（仅未打包环境有效；打包后需 `configure` 覆盖） |
| `DEFAULT_PACK_BASE_URL` | `string` | 兜底常量 `"/mascot_pack"` |
| `resolveAssetBase` | `(url?) => string \| undefined` | 从模块 URL 推导包根目录，纯函数 |
| `isConfigured` | `() => boolean` | 是否显式调用过 `configure()`，仅诊断用 |

**类型**：`MascotOptions`、`MascotConfig`、`Mascot`、`RuntimeOptions`、`RuntimeSnapshot`、`MascotAnimationOptions`、`AnimationPresetFile`、`Pose`、`ActionNode`、`Behavior`、`Hotspot`、`EngineEvent`、`EngineObserver`、`MascotPackInput`、`ImportMascotPackOptions`、`ImportedMascotPack`、`MascotPackData`、`ShimejiWarning` 等。

**高级用法（不承诺语义化版本稳定性）**：`PackRegistry`、`ShimejiFinder`、`translateShimejiXml`、`normalizeSpriteKey`、`MascotEngine`、`AnimationConfig`、`BroadcastManager`、`CLASSIC_ANIMATION_PRESET`、`LIVELY_ANIMATION_PRESET`、`STANDARD_CONFIG_SAMPLE`。

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

引擎是**格式驱动**的：宠物的身份就是你传给 `createMascot({ pack })` 的那个字符串，库代码里没有任何写死的宠物名。你有两种方式添加自己的宠物：

### 方式 A：纯前端动态导入 ZIP 资源包（推荐）

直接通过 `importMascotPack()` 导入用户上传的 ZIP 文件或远程 URL，完全无需在静态目录部署任何文件：

```js
import { importMascotPack, createMascot } from "web-mascot";

// 支持传入 File、Blob、ArrayBuffer 或远程 zip URL
const { name, warnings, unregister } = await importMascotPack(fileOrUrl);

// 直接创建，所有现有控制 API 保持完全一致
const mascot = await createMascot({ container: document.body, pack: name });
```

- **全面兼容**：支持标准 Shimeji-ee（含 `conf/`）与扁平结构、原版日文 XML 自动翻译、46 帧无 XML 皮肤包自动装配模版。
- **虚拟注册中心**：内存虚拟包（`PackRegistry`）优先级高于静态 HTTP 目录。若导入同名包（如 `"Neuron"`），将自动替换内置模型。
- **优雅降级**：Shimeji-ee 中的桌面专属动作（如 `ThrowIE`、`Breed`）在网页端自动平滑降级，绝不抛出未捕获异常中断渲染。

### 方式 B：作为静态资源部署

也可以像内置模型一样，将解压后的 Shimeji pack 目录放置到静态服务器中：

```
mascot_pack/MyPet/
├── actions.xml      # 必需：动作与逐帧图像（或在 conf/actions.xml）
├── behaviors.xml    # 必需：行为与权重（或在 conf/behaviors.xml）
└── img/             # 必需：<Pose Image="..."> 引用的图片
    └── shime1.png
```

然后通过 `configure({ assets })` 指定全局静态根：

```js
configure({ assets: "/mascot_pack" });
const pet = await createMascot({ container: document.body, pack: "MyPet" });
```

资源服务的两个要求：
- 精灵文件名必须与 XML 里的 `Image` 属性匹配（忽略大小写，不带扩展名时自动尝试 `.png`）；静态服务器需给出正确的 `Content-Type: image/png`。
- 资源与页面不同源时需要允许 CORS（XML 与精灵需可跨域访问）。

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

`0.1.1` — 接口尚未承诺语义化版本稳定性（0.x 允许破坏性变更）。支持贴地上滚弹性形变物理反馈（Squash & Stretch）与配置 API；修复贴地滚动落地过渡与平地摔异常。全面升级交互层为标准 Pointer Events，提供触控屏/移动端触摸拖拽与抛掷基础兼容，完善多指触控隔离与指针捕获。

**动画预设架构**：引擎内置标准化的预设注册体系（`PresetRegistry`），默认采用偏活跃的 `"lively"` 预设（`src/core/animationPreset.ts`）；要回到 Qt / Shimeji-ee 原生桌面行为的宿主，传入 `configure({ preset: "classic" })` 即可。用户亦可拿已有预设派生并调用 `registerPreset()` 注册专属风格。随包的 `dist/animation.config.json` 为标准化配置导出模版。

内置 Neuron 与 Eviling 两只官方宠物，现已支持通用 Shimeji-ee 与日版 Shimeji 资源包动态导入与虚拟注册（支持替换内置模型，桌面不支持动作自动优雅降级）。反馈与问题请提到 [issues](https://github.com/CommentOut64/web-mascot/issues)。

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
