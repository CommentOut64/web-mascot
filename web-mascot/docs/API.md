# web-mascot 接口文档

本文只描述**封装后对外暴露的接口**，即 `package.json` 的 `exports` 映射所声明的入口。内部实现（`src/core/*`、`src/dev/*`）不属于本契约的一部分，可能随版本变动。

## 快速开始

```bash
npm install web-mascot
```

```js
import { configure, createMascot } from "web-mascot";

// 在打包器环境下需将资源放入公共目录，并显式指向它
configure({ assets: "/mascot_pack" });

const mascot = await createMascot({ container: document.body, pack: "Neuron" });
```

在打包器环境下（Vite、Webpack 等）使用时，由于预构建和代码分割会导致资源路径推导失效，必须调用 `configure()` 显式指定资源基址。`pack` 传内置的 `"Neuron"` 或 `"Eviling"`。

需要覆盖默认值时：

```js
import { configure, createMascot } from "web-mascot";

configure({ assets: "https://cdn.example.com/mascot_pack", runtime: { tickMs: 40 } });
const mascot = await createMascot({ container: document.querySelector("#pet-root"), pack: "Neuron" });
```

只想看日志：

```js
import { attach, configureLogging } from "web-mascot/devtools";

configureLogging({ console: "info" });   // 库自身诊断：[web-mascot] ...
attach({ console: true });               // 观测日志：宠物移动史
```

## 导出速查

本表用于"我知道要什么、只要签名"的场景；完整语义见右侧指向的章节。

### 主入口 `web-mascot`（12 个值 + 10 个类型）

| 导出 | 签名 | 一句话 | 详见 |
| --- | --- | --- | --- |
| `createMascot` | `(options: MascotOptions) => Promise<Mascot>` | 创建并挂载一只宠物，解析完 pack 且画出首帧后 resolve | 3.2 |
| `configure` | `(options: MascotConfig) => void` | **打包环境必须**（在 `createMascot()` 之前）：资源根 / 动画配置 / 物理参数 | 3.1 |
| `Mascot` | `class` | 一只已挂载的宠物 | 3.3 |
| `Mascot.engine` | `MascotEngine` | 引擎实例，取仿真状态（`snapshot()` / `position()`）用 | 3.3 |
| `Mascot.label` | `string` | 稳定标识，形如 `1-Neuron` | 3.3 |
| `Mascot.destroy` | `() => void` | 移除宠物，释放 DOM / 定时器 / 监听器；**可重复调用** | 3.3 |
| `assetBaseUrl` | `() => string` | 当前**生效**的资源基址（推导值或被覆盖值） | 3.4 |
| `runtimeOptions` | `() => RuntimeSnapshot` | 当前生效的运行参数（含默认值） | 3.4 / 3.5 |
| `isConfigured` | `() => boolean` | 是否显式调用过 `configure()`，仅诊断 | 3.4 |
| `PACK_BASE_URL` | `string` | 推导出的资源基址（仅未打包环境有效） | 3.4 |
| `DEFAULT_PACK_BASE_URL` | `string` | 兜底常量 `"/mascot_pack"` | 3.4 |
| `resolveAssetBase` | `(url?: string) => string \| undefined` | 从模块 URL 推导包根目录，纯函数 | 3.4 |
| `MascotEngine` | `class` | 高级用法，**不承诺稳定** | 3.4 |
| `AnimationConfig` | `class` | 高级用法，**不承诺稳定** | 3.4 |
| `BroadcastManager` | `class` | 高级用法，**不承诺稳定** | 3.4 |

类型：`MascotOptions`、`MascotConfig`、`RuntimeOptions`、`RuntimeSnapshot`、`Pose`、`ActionNode`、`Behavior`、`Hotspot`、`EngineEvent`、`EngineObserver`。

### 开发工具入口 `web-mascot/devtools`（13 个值 + 8 个类型）

| 导出 | 签名 | 一句话 | 详见 |
| --- | --- | --- | --- |
| `attach` | `(options?: DevtoolsOptions) => boolean` | 打开**观测日志**；返回 `false` 表示没装任何东西 | 4.2 |
| `configureLogging` | `(options: LogOptions) => void` | 打开库自身**诊断日志** | 4.1 |
| `disableLogging` | `() => void` | 关掉诊断日志 | 4.3 |
| `loggingState` | `() => { ... }` | 读诊断日志当前配置（内联对象类型） | 4.3 |
| `consoleSink` | `(level?: LogLevel) => LogSinkEntry` | 现成的诊断输出目的地 | 4.3 |
| `loggerFor` | `(channel: LogChannel) => Logger` | 取某通道的 logger | 4.3 |
| `setLogSink` | `(sink: MascotLogSink) => void` | 观测日志的目的地（覆盖式，兼容旧用法） | 4.3 |
| `addLogSink` | `(sink: MascotLogSink) => void` | 追加一个观测日志目的地 | 4.3 |
| `startMascotLogRecorder` | `() => boolean` | 开始录制；无可用目的地时返回 `false` | 4.3 |
| `stopMascotLogRecorder` | `() => void` | 停止录制 | 4.3 |
| `isRecording` | `() => boolean` | 是否正在录制 | 4.3 |
| `resetMascotLogRecorder` | `() => void` | 重置录制器状态 | 4.3 |
| `MascotEngine` | `class` | 便于只用本入口的宿主也能拿到引擎 | 4.3 |

类型：`DevtoolsOptions`、`MascotLogSink`、`MascotLogBatch`、`LogLevel`、`LogSink`、`LogRecord`、`LogChannel`、`LogOptions`。

> **两处类型泄漏**（已知，暂未修）：`consoleSink()` 的返回类型 `LogSinkEntry`、`loggerFor()` 的返回类型 `Logger` 都没有从本入口导出，所以 TS 里无法显式标注这两个返回值。需要时用 `ReturnType<typeof consoleSink>` 绕开。

## 1. 入口与产物

构建：

```bash
npm run build:lib     # 等价于 vue-tsc && vite build && tsc -p tsconfig.lib.json
```

产物（体积随构建变化，故不在此写死）：

| 文件 | 内容 |
| --- | --- |
| `dist/index.js` | 主入口（不含记录器） |
| `dist/devtools.js` | 开发工具入口（含记录器） |
| `dist/chunks/MascotEngine-*.js` | 两个入口共享的引擎实现 |
| `dist/types/**/*.d.ts` | 类型声明（由 `tsc` 直接产出） |
| `dist/animation.config.json` | 内置默认档的副本（构建时由 `src/core/animationPreset.ts` 生成），可经 `web-mascot/animation.config.json` 导入 |
| `dist/mascot_pack/**` | 精灵资源（由 Vite 从 `public/` 拷入）。每个 pack 还带自己的 `LICENSE` 与 `LICENSE-CC-BY-NC-SA-4.0.txt` |
| `src/**` | 库源码，随包提供：既是 GPL 要求的对应源码，也让 sourcemap 能解析到真实文件 |

`exports` 映射：

```json
{
  ".":                       { "types": "./dist/types/index.d.ts",    "import": "./dist/index.js",    "default": "./dist/index.js" },
  "./devtools":              { "types": "./dist/types/devtools.d.ts", "import": "./dist/devtools.js", "default": "./dist/devtools.js" },
  "./animation.config.json": "./dist/animation.config.json",
  "./mascot_pack":           "./dist/mascot_pack",
  "./mascot_pack/*":         "./dist/mascot_pack/*",
  "./package.json":          "./package.json"
}
```

`exports` 是一份**严格白名单**：未列出的子路径在 Node 与打包器里都会解析失败（`ERR_PACKAGE_PATH_NOT_EXPORTED`）。所以 `web-mascot/dist/mascot_pack/...` 是**取不到**的，要按上面的映射走 `web-mascot/mascot_pack/...`。库源码 `src/**` 随包分发，但**不在** `exports` 里——它是给你读的，不是给你 import 的。

因此导入形式为：

```js
import { createMascot } from "web-mascot";
import { attach } from "web-mascot/devtools";
```

`./mascot_pack/*` 是给**自己取资源**的宿主用的：需要按真实路径拿包内精灵时（自定义 loader、CDN 上传脚本、`new URL()`），可以直接引用该子路径。注意这是**打包器/Node 的模块解析**能力，浏览器运行时不会解析裸说明符 —— 页面里请用绝对 URL，例如 `/mascot_pack/Neuron/img/shime1.png`（这正是 `assetBaseUrl()` 的用途）。

`vue` 是**开发依赖**，不是运行时依赖：库的两个入口都不导入 Vue（只有本仓库的 demo 应用 `src/main.ts` 用），包本身可在任何框架下使用。本包**没有运行时依赖**。

## 2. 最小用法

```bash
cp -r node_modules/web-mascot/dist/mascot_pack public/mascot_pack
```

```js
import { configure, createMascot } from "web-mascot";

// 在打包器环境需将资源放入公共目录，并显式指向它
configure({ assets: "/mascot_pack" });

const mascot = await createMascot({ container: document.body, pack: "Neuron" });
// 之后可调用 mascot.destroy(); 销毁
```

**必须显式调用** `configure({ assets })`：在打包环境（Vite / Webpack 等）下，由于预构建和产物移动，由模块 `import.meta.url` 推导出的 `PACK_BASE_URL` 会指向无效路径（如 `node_modules/.vite/deps/...` 或 `_astro/...`）。此时要求手动同步精灵文件到网站公共根目录（如 `public/mascot_pack`），并通过上述配置项进行纠正。

调用顺序：`assets` 在**创建每只宠物时被快照**（见 3.1），所以要在这之前 `configure()`，否则该宠物会用到推导值。

子路径部署：`assets` 是根绝对路径，部署在 `/blog/` 之类前缀下时要写成 `"/blog/mascot_pack"`。

> **注 1**：仅在未打包、且包目录被原样服务的环境（裸 ESM，或原样镜像 `dist/` 的 CDN）下，基于 `import.meta.url` 的自动推导才会如预期工作。
>
> **注 2**：`DEFAULT_PACK_BASE_URL`（`"/mascot_pack"`）只在推导**彻底失败**时兜底。打包环境里推导是「成功但错误」，兜底不会生效——把精灵放到 `/mascot_pack` 并不能替代 `configure()`。

## 3. 主入口 `web-mascot`

### 3.1 `configure(options)` —— 资源与运行参数覆盖

```ts
function configure(options: MascotConfig): void
```

**打包器宿主必须调用**（且在 `createMascot()` 之前）；只有在未打包、包目录被原样服务的环境里才可以省略。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `assets` | `string?` | 含每个 pack 目录的基址，**不带结尾斜杠**。**打包环境必须给出**；只在未打包环境下可省略（那时才用推导值 `PACK_BASE_URL`）。**当前是全局设置**：页面内所有宠物共用一个资源根 |
| `animationConfigUrl` | `string?` | 动画配置文件 URL。省略则每页探测一次默认路径 `/animation.config.json`；文件不存在不报错，内置预设继续生效 |
| `ignoreBuiltin` | `boolean?` | 设为 `true` 丢弃内置预设，回到 pack 原生行为（无 pacer、无权重覆盖、无长序列豁免）。默认 `false`。与 `animationConfigUrl` 正交：它拿掉的是**最底层**，不会禁用文件 |
| `runtime` | `RuntimeOptions?` | 仿真调参，见 3.5 |

日志**不在这里**配置：观测日志走 `web-mascot/devtools` 的 `attach()`，库诊断走 `configureLogging()`（见第 4 节）。

行为与约束：

- `assets` 在**创建每只宠物时被快照**：之后再调用 `configure()` 不会影响已存在的宠物，也不会让同一页面里的宠物读到不同 pack。
- `animationConfigUrl` 遵循同一规则（快照于首次生效）。这不影响 `runtime`——运行参数是**每 tick 读取**的，改了立刻对已有宠物生效。
- 全部字段可选，且多次调用会合并；只传 `runtime` 不会清掉之前的 `assets`。
- `ignoreBuiltin` 是**页面级**偏好：设过之后，后续加载的配置文件也不会把它顶掉；文件里的 `ignoreBuiltin` 只在页面没有显式设置时生效。

> **当前限制与路线图**：`assets` 是**全局**的（`MascotEngine.packBaseUrl` 是静态字段），所以"内置的 Neuron + 你自己放在别处的 MyPet"目前要求两者的 pack 目录位于同一个资源根下（把内置 pack 拷到你的静态目录即可）。**按宠物单独指定资源根在路线图上**，届时 `MascotOptions` 会新增可选的 `assets`，优先级为 per-mascot > 全局 > 推导默认值——纯追加，不会影响现在写好的代码。

### 3.2 `createMascot(options)`

```ts
function createMascot(options: MascotOptions): Promise<Mascot>
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `container` | `HTMLElement` | **锚点**：宠物属于文档的哪个位置 |
| `pack` | `string` | **mascot key**：不透明标识，同时是动画配置 `mascots` 的索引键。当前实现里它等于 pack 目录名，如 `"Neuron"`；未来支持运行时导入用户模型后，它可能不再是目录名，所以不要把它当路径解析 |

`container` 是**锚点语义**，不是裁剪框：宠物在**整个视口**内活动，`container` 只决定它属于文档的哪一处。当 `container` 被滚动出视口时，引擎会暂停这只宠物（`IntersectionObserver`）。这与 libshijima 的"桌宠属于桌面"不同，是网页场景下的等价物。

初始化会解析 pack 的 XML、预热精灵、画出第一帧；失败则 `reject`，且不在页面上留下任何东西。

### 3.3 `class Mascot`

| 成员 | 说明 |
| --- | --- |
| `engine: MascotEngine` | 引擎实例，供控制台调试或需要仿真状态时使用 |
| `label: string` | 稳定标识，形如 `1-Neuron`；dev 构建下用于命名日志文件 |
| `destroy(): void` | 移除宠物，释放 DOM、定时器与监听器。**可重复调用** |

### 3.4 其余导出

| 导出 | 说明 |
| --- | --- |
| `PACK_BASE_URL` | 推导出的资源基址 |
| `assetBaseUrl()` | **当前生效**的资源基址（推导值或被覆盖值） |
| `isConfigured()` | 是否显式调用过 `configure()`。仅用于诊断：`false` 只表示"用的是推导默认值"，不表示未配置 |
| `runtimeOptions()` | 当前生效的运行参数（含默认值） |
| `DEFAULT_PACK_BASE_URL` | 兜底常量 `"/mascot_pack"` |
| `resolveAssetBase(url?)` | 从模块 URL 推导包根目录；纯函数，便于自行诊断 |
| `MascotEngine` / `AnimationConfig` / `BroadcastManager` | 高级用法，**不承诺语义化版本稳定性**（0.x 期间可能重构）。类型与全貌见 `dist/types/` |
| 类型 `Pose` / `ActionNode` / `Behavior` / `Hotspot` / `EngineEvent` / `EngineObserver` / `RuntimeOptions` | — |

### 3.5 运行参数 `RuntimeOptions`

通过 `configure({ runtime })` 设置，或 `MascotEngine.setRuntimeOptions()` 直接设置；`runtimeOptions()` 读取当前值。所有字段可选，非有限数会被忽略。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `tickMs` | `40` | 仿真步长。40 ms 是 libshijima 的速率；调大等于整体放慢 |
| `gravity` | `2` | 每 tick 的下落加速度 |
| `resistanceX` | `0.05` | 水平空气阻力 |
| `resistanceY` | `0.1` | 垂直空气阻力 |
| `stayDurationTicks` | `250` | `Stay` 动作未自带 `Duration` 时的保持时长 |
| `dragResistTicks` | `250` | 被拖住后静止多少 tick 开始挣扎 |
| `dragResistAbortPx` | `5` | 挣扎（`Resisting`）期间光标离锚点多远算挣脱；挣扎期间锚点不跟随（`resist::tick` 只比较），所以等价于"开始挣扎后鼠标移动了多少" |
| `dragOffsetX` / `dragOffsetY` | `0` / `120` | 被拖住时锚点距**局部光标**的偏移；pack 自带 `OffsetX/OffsetY` 时以其为准。局部光标在按下时被播种，使第一个 tick 复现抓取时的锚点 —— 也就是**抓在哪里就从哪里跟手**，不会跳到固定握点（Qt `state::local_cursor` 的语义）。 |
| `broadcastServeTimeoutTicks` | `600` | 广告方等待已被认领的伙伴多久 |
| `suspectStepPx` | `24` | 单 tick 位移超过此值上报为跳变嫌疑 |

> **校准警告**：`gravity` 与两个 `resistance` 是与 pack 自身物理常数配套的。改它们而不重新核对 pack，宠物行为会偏离 libshijima。`tickMs` 是最接近"速度调节"的开关。

**故意不暴露**的常量：`MAX_FRAME_DELTA_MS`、`MAX_BEHAVIOR_INITS_PER_TICK`、`STALL_LIMIT_TICKS`。它们是防止 bug 锁死页面的安全阀，调低会把"表现问题"变成"宠物坏掉"。

### 3.6 动画配置里的节奏字段

这些不在 `configure()` 里，而是写在**动画配置文件**（`animationConfigUrl` 指向的 JSON，或引擎默认请求的 `/animation.config.json`）的 `defaults` / `mascots` 中。列在这里是因为它们与 3.5 的运行参数容易混淆：**3.5 改的是引擎物理，这里改的是行为选择**。

生效优先级：`内置预设 → defaults → reducedMotion → mascots.<名字>`（逐字段合并，对象型字段按 key 叠加）。引擎**自带一套默认预设**（`src/core/animationPreset.ts`，同一份数据生成随包的 `dist/animation.config.json`）；`ignoreBuiltin: true` 把最底层整层拿掉，等价于 0.0.3 之前"什么都不配"的行为。

| 字段 | 说明 |
| --- | --- |
| `forcedSwitchTicks` | 静止超过这么多 tick 就换行为（pacer）。"静止"按**位置是否变化**判定，所以速度为零的长序列也算静止 |
| `pacerExemptBehaviors` | 上面这条的**例外名单**。列出的行为不会被 pacer 打断，让长静止动画播完；普通 `Stay` 仍按时被推动 |
| `maxBehaviorTicks` | 单个行为的**硬上限**，超时即换（掉落/拖拽除外）。pacer 的豁免不影响它，所以豁免的行为也不会无限持续 |
| `exitToPoolBehaviors` | 列出的行为结束时回到**全局抽签池**，而不是走 pack 的 `<NextBehaviorList>` |
| `behaviorWeights` | 覆盖 pack 的 `Frequency`（0 = 禁用；给 `Frequency="0"` 的行为赋正值可打开它） |
| `interactionCooldownTicks` | 互动结束后，需要伙伴的行为移出候选池这么多 tick |
| `maxTravelPx` | 水平游走目标的最大距离（px）。0/缺省 = 不限 |
| `durationScale` | 全局时长倍率（0.05–20），只作用于 XML 自带的 `Duration` |
| `actionDurations` | 按动作名覆盖持续 tick 数，可写单值或 `[min,max]` |

**为什么需要后两个字段**：pack 用 `<NextBehaviorList Add="false">` 串接相关行为，而部分链是**闭链**。内置 pack 的 `SitAndFaceMouse` 只能重新选自己或 `SitWhileDanglingLegs`，宠物一旦坐下就再也出不来。所以"让长静止动画播完"必须和"播完回主池"一起用：

```json
{
  "defaults": {
    "forcedSwitchTicks": 200,
    "pacerExemptBehaviors": ["SitWhileDanglingLegs"],
    "exitToPoolBehaviors": ["SitWhileDanglingLegs"],
    "maxBehaviorTicks": 1100
  }
}
```

### 3.7 输入与手势（与 NeurolingsCE 对齐）

鼠标交互按 NeurolingsCE 的 `ui/mascot/MascotHoldGesture.hpp`、`MascotWidget::pointInside()` 与 `manager::trigger_hotspot()` 实现：

| 操作 | 行为 |
| --- | --- |
| 按下**透明像素** | 不属于宠物，不产生任何交互（`pointInside` 的 alpha 判定；跨域精灵读不到像素时退化为整个精灵盒） |
| 按下**当前动画的 hotspot** | 只是候选，不立刻播行为 |
| 候选按住 ≥ **260 ms** 且位移 ≤ **12 px** | 播该 hotspot 的行为，并在按住期间持续重发（对应 Qt 的 `prefer_next_behavior` 连播） |
| 候选在 ≤ **400 ms** 内松手且位移 ≤ **6 px** | 视为**点击**，触发**松手点**下的 hotspot |
| 候选位移 > **12 px** | 取消候选，转为**抓起**宠物（所以从头上开始拖也能抓起来） |
| 按下非 hotspot 的不透明像素 | 立刻抓起 |

hotspot 来自 pack 的 `actions.xml`（`<Hotspot Shape/Origin/Size Behavior>`），随当前动画变化；动画配置的 `denyBehaviors` 依旧过滤它们。

被抓起时：锚点 = **局部光标** + `OffsetX/OffsetY`（缺省 `dragOffsetX/dragOffsetY`），局部光标在按下时播种，因此**抓在哪里就从哪里跟手**，不会跳到 pack 的固定握点。指针事件里即时重钉锚点、且拖拽期间不做绘制插值（Qt 每 10 ms 重钉一次，且 `dragged::requests_interpolation() == false`），所以高速拖动不会落后于指针。`Resisting` 期间锚点不跟随（`resist::tick` 只比较），光标离开 `dragResistAbortPx` 即中止挣扎。

## 4. 开发工具入口 `web-mascot/devtools`

### 4.1 两种日志，两个开关

库里有**两类互不相干**的日志，刻意分开配置：

| | 观测日志 | 库自身诊断 |
| --- | --- | --- |
| 内容 | 宠物去了哪里（每行一个 JSON 记录） | 引擎内部消息（`[web-mascot] ...`） |
| 配置入口 | `attach(options)`（本入口） | `configureLogging(options)` |
| 默认 | 关 | 关 |
| 记录格式 | `{"t":3.3,"k":"spawn",...}` | 人类可读文本 |

启用观测日志**不会**改变诊断日志的等级，反之亦然。之前 `attach({ level })` 会顺带配置诊断日志，已移除——一个选项同时管两件事是这次拆分要消除的耦合。

### 4.2 `attach(options?)`

```ts
function attach(options?: DevtoolsOptions): boolean
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 观测日志总开关；`false` 时不安装任何东西 |
| `console` | `false` | 把观测记录镜像到浏览器 console |
| `sinks` | `[]` | 额外目的地，收到**整批**记录 |
| `kinds` | 不限 | 只镜像这些记录类型。吵的是 `move` / `pose` / `lifecycle`；有信息量的是 `spawn` / `behavior` / `peer` / `stop` / `switch` / `suspect` |
| `file` | `true` | 是否允许 Vite dev/preview 文件端点 |
| `silent` | `false` | 连那一次端点探测请求都不发 |

**目的地可组合**：console 镜像、文件端点、任意数量的宿主 sink 可同时开启。

返回值：`false` 表示 `enabled: false` 或没有任何可用目的地，此时未安装任何东西。

```js
attach();                                        // 仅文件端点（dev/preview）
attach({ console: true });                       // console + 文件
attach({ console: true, kinds: ["spawn", "behavior", "peer"] });  // 降噪
attach({ file: false, silent: true });           // 只走 sink，不碰网络
```

诊断日志单独开：

```js
import { configureLogging } from "web-mascot/devtools";
configureLogging({ console: "info" });   // 打开 [web-mascot] ... 诊断
```

### 4.3 其它导出

按入口的导出语句顺序列出，便于与本包的类型声明逐行对照：

| 来源 | 导出 |
| --- | --- |
| 记录器 | `setLogSink(sink)`、`addLogSink(sink)`（兼容旧的单目的地用法） |
| 记录器 | `isRecording()`、`resetMascotLogRecorder()`、`startMascotLogRecorder()`、`stopMascotLogRecorder()` |
| Logger | `configureLogging()`、`disableLogging()`、`loggingState()`、`consoleSink()`、`loggerFor()` |
| 引擎 | `MascotEngine`（便于只用本入口的宿主也能拿到引擎） |
| 类型 | `DevtoolsOptions`、`MascotLogSink`、`MascotLogBatch`、`LogLevel`、`LogSink`、`LogRecord`、`LogChannel`、`LogOptions` |

`DevtoolsOptions`（`attach()` 的选项，见 4.2）与 `configureLogging()` 的 `LogOptions` 是**两个不同的类型**：前者配置观测日志，后者配置库自身诊断。不要混用。

### 4.4 文件落盘：`web-mascot/logs/`

记录由 **Vite 中间件**写入磁盘（浏览器无法自己写文件）：

```
GET  /__mascot-log/ping   -> { ok: true, dir }        记录器探测
POST /__mascot-log        -> { session, pet, lines }  写入一批
```

落盘位置：`web-mascot/logs/<session>/`，每只宠物一个文件，另有一份人可读副本：

| 文件 | 内容 |
| --- | --- |
| `pet-<n>-<Mascot>.log` | 机器格式，每行一个紧凑 JSON 对象 |
| `pet-<n>-<Mascot>.txt` | 同一批记录，带 `[12.340s]` 时间戳前缀，供 `tail -f` |
| `pet-_index.log` | 会话头、可见性、JS 错误 |

该目录在 `.gitignore` 中，且被 `server.watch.ignored` 排除，所以写日志**不会**触发 HMR 或页面重载。

中间件配置见 `vite.config.ts`（`mascotLog({ logRoot, text })`）；`maxFileBytes` / `maxRotations` 控制轮转。

### 4.5 发布构建中如何收集日志

发布的包里没有 `/__mascot-log` 端点。宿主用 sink 接收，并同时声明"没有端点可探测"：

```js
import { attach } from "web-mascot/devtools";

attach({
  file: false,                        // 不允许文件端点
  silent: true,                       // 连那一次探测请求也不发
  sinks: [(batch) => postToMyBackend(batch)],
});
```

三个开关的关系（容易混淆，特意分开）：

| 开关 | 管什么 | 不设时 |
| --- | --- | --- |
| `file: false` | 记录**不许发往** `/__mascot-log` | 端点可用时写文件 |
| `silent: true` | 记录器**不去探测**端点（连一次请求都没有） | 会 ping 一次 |
| `sinks` / `console` | 记录**发到哪里** | 只有端点 |

- `file: false` 但提供了 `sink` 时，**录制照常进行**，只是不发端点——这正是发布构建的用法。
- 既没有 `sink` 又不允许端点（`file: false`）时，`attach()` 返回 `false` 且**什么都不安装**。
- 只想在控制台看记录、完全不想有网络请求：`attach({ console: true, file: false, silent: true })`。

### 4.6 日志格式

每只宠物的运动史由少量记录类型组成，`t` 为秒、`k` 为类型：

```
{"t":3.3,"k":"spawn","mascot":"Neuron","x":501,"y":100}
{"t":20.5,"k":"behavior","from":"AskForHugs","to":"Fall","reason":"scroll-down-fall","x":501,"y":155}
{"t":21,"k":"move","x":501,"y":293.55}
{"t":17,"k":"stop","x":708.99,"y":755,"behavior":"WalkRightAndSit"}
{"t":17.7,"k":"pose","img":"shime11.png","x":708.99,"y":755}
{"t":154,"k":"heartbeat","x":950,"y":900,"behavior":"Stand"}
{"t":0.4,"k":"mark","reason":"recording-started","behavior":"Stand","x":501,"y":755}
```

- `mark` 表示**录制开始时该宠物已经存在**，它的 `spawn` 从未被看到；否则时间线会以一个来路不明的站立宠物开头。
- `peer` 记录双宠互动（`offer` / `connect` / `arrive` / `scan-miss` / `abort` / `serve-timeout`），用 `affordance` 把两只宠物的日志配对。
- `lifecycle` 记录冻结与恢复（`hidden` / `viewport` / `background-page`），用于解释时间线上的空档。
- `move` 只在**状态变化**时产生（累计位移 ≥32 px 或静默 ≥3 s），不是每帧一条。

## 5. 资源要求（宿主必须处理）

- **静态服务**：精灵文件在包的 `dist/mascot_pack/<Pack>/img/` 下；宿主要把整个 `dist/mascot_pack/` 拷到自己的静态根（如 `public/mascot_pack`），再把该根传给 `configure({ assets })`。文件名必须与 XML 里 `<Pose Image="...">` 的值**完全一致**（本包内置的两只全是 `.png`，如 `Image="/shime1.png"`）；Shimeji 生态里也有不带扩展名的写法，所以静态服务器必须给出正确的 `Content-Type`（`image/png`），不能靠扩展名推断。本仓库的 `vite.test-host.config.ts` 展示了手工服务写法。
- **pack 结构**：每个 pack 一个目录，`img/` 放精灵，XML 行为定义**直接位于 pack 根目录**（`actions.xml`、`behaviors.xml`），不在 `conf/` 之类子目录下；另有 `info.json`、`bubble_context.txt`。
- **跨域**：资源与页面不同源时需允许 CORS（精灵以 `<img>` 加载，通常无需凭据）。

## 6. 完整示例

最小（打包器环境，精灵已拷到静态根）：

```js
import { configure, createMascot } from "web-mascot";

configure({ assets: "/mascot_pack" });   // 必须在 createMascot() 之前

const mascot = await createMascot({ container: document.body, pack: "Neuron" });
window.addEventListener("pagehide", () => mascot.destroy());   // 可选：卸载时清理
```

未打包的裸 ESM 环境（包目录被原样服务）可省略 `configure()`，见 §2 注 1。

带覆盖与日志：

```js
import { configure, createMascot } from "web-mascot";
import { attach, configureLogging } from "web-mascot/devtools";

configure({
  assets: "https://cdn.example.com/mascot_pack",
  animationConfigUrl: "/animation.config.json",
  runtime: { tickMs: 40, gravity: 2 },  // 未列出的字段保持默认
});

configureLogging({ console: "debug" });            // 库自身诊断
attach({ console: true, kinds: ["spawn", "behavior", "peer"] });  // 观测日志

const mascot = await createMascot({ container: document.querySelector("#pet-root"), pack: "Neuron" });
```

## 7. 已知约束

- 引擎在**每页每实例**基础上工作；同时挂载的宠物越多，共享的 `BroadcastManager` 上互动机会越多。
- 宠物的 `x`/`y` 是**虚拟单位**（1 单位 = 1 精灵像素，受动画配置的 `scale` 影响）。外部取坐标请用 `engine.position()` 或 `engine.snapshot()`，不要直接读 `x`/`y`。
- `animationConfigUrl` 每页面只拉取一次；要重新读取需 `MascotEngine.reloadAnimationConfig()`。
- 宿主可以用 CSS 移动挂载点（Firefly 的 `body.has-global-player #mascot-pet-anchor { transform: translateY(-4.5rem) }` 就是把它抬到播放器上方）。此时引擎会**从 DOM 测量**挂载点相对自己坐标系的位移（每个逻辑 tick 至多测一次，按下时强制重测），指针映射与热区/命中判定都以**实际绘制位置**为准 —— 否则点击会整体偏移，且不透明像素判定会把正常按下判成盒外。
- 中间件只在 Vite dev/preview 下存在；发布构建请用 sink。

## 8. 发布状态与许可

`version` 为 `0.0.3`。接口尚未承诺语义化版本稳定性：0.x 允许破坏性变更，其中 `MascotEngine` / `AnimationConfig` / `BroadcastManager` 属于**明确不稳定**的高级用法（见 3.4）。

许可拆成两部分，不要混：

| 部分 | 许可证 | 商用 |
| --- | --- | --- |
| 源码（`dist/`、`src/`） | `GPL-3.0-or-later` | ✅ 可以，但衍生作品须同样开源 |
| 内置宠物包 `Neuron` / `Eviling` | `CC-BY-NC-SA-4.0` | ❌ **不可以** |

`package.json` 声明的是 `"SEE LICENSE IN LICENSE"`，而**不是**单一 SPDX 标识——单一标识会被读成"整包同一许可"。包根 `LICENSE` 划定了上面两部分的适用范围，并附 GPLv3 与 CC BY-NC-SA 4.0 两份**全文**；`NOTICE` 载明上游署名、GPLv3 §7 附加条款以及对内嵌 pack 的修改声明。每个 pack 目录内另有自己的 `LICENSE` 与 `LICENSE-CC-BY-NC-SA-4.0.txt`。商业产品请自备素材包，或用 `configure({ assets })` 指向你自己的资源根。
