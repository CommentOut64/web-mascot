# web-mascot 接口文档

本文只描述**封装后对外暴露的接口**，即 `package.json` 的 `exports` 映射所声明的入口。内部实现（`src/core/*`、`src/dev/*`）不属于本契约的一部分，可能随版本变动。

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
| `dist/mascot_pack/**` | 精灵资源（由 Vite 从 `public/` 拷入） |

`exports` 映射：

```json
{
  ".":              { "types": "./dist/types/index.d.ts",    "import": "./dist/index.js" },
  "./devtools":     { "types": "./dist/types/devtools.d.ts", "import": "./dist/devtools.js" },
  "./mascot_pack":  "./dist/mascot_pack",
  "./mascot_pack/*": "./dist/mascot_pack/*",
  "./package.json": "./package.json"
}
```

因此导入形式为：

```js
import { createMascot } from "web-mascot";
import { attach } from "web-mascot/devtools";
```

`./mascot_pack/*` 是给**自己取资源**的宿主用的：需要按真实路径拿包内精灵时（自定义 loader、CDN 上传脚本、`new URL()`），可以直接引用该子路径。注意这是**打包器/Node 的模块解析**能力，浏览器运行时不会解析裸说明符 —— 页面里请用绝对 URL，例如 `/mascot_pack/Neuron/img/shime1.png`（这正是 `assetBaseUrl()` 的用途）。

`vue` 是**开发依赖**，不是运行时依赖：库的两个入口都不导入 Vue（只有本仓库的 demo 应用 `src/main.ts` 用），包本身可在任何框架下使用。

## 2. 最小用法（零配置）

```js
import { createMascot } from "web-mascot";

const mascot = await createMascot({ container: document.body, pack: "Neuron" });
// 之后
mascot.destroy();
```

**不需要**调用 `configure()`，也**不需要**告诉引擎资源在哪：`PACK_BASE_URL` 由模块自身位置推导（`import.meta.url` → `<packageRoot>/mascot_pack`），因此 CDN、子路径、被哈希的入口名都能正确取图。

推导规则：入口 `dist/index.js` 的同级目录下找 `mascot_pack`。代码分割后的 chunk（`dist/chunks/*.js`）不参与推导，所以入口改名、加哈希都不影响结果。

## 3. 主入口 `web-mascot`

### 3.1 `configure(options)` —— 可选的覆盖

```ts
function configure(options: MascotConfig): void
```

只在需要**覆盖**推导默认值时才调用。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `assets` | `string?` | 含每个 pack 目录的基址，**不带结尾斜杠**。省略则用推导值 `PACK_BASE_URL` |
| `animationConfigUrl` | `string?` | 动画配置文件 URL。省略则完全不发起请求，各 pack 使用自身设置 |
| `runtime` | `RuntimeOptions?` | 仿真调参，见 3.5 |

日志**不在这里**配置：观测日志走 `web-mascot/devtools` 的 `attach()`，库诊断走 `configureLogging()`（见第 4 节）。

行为与约束：

- `assets` 在**创建每只宠物时被快照**：之后再调用 `configure()` 不会影响已存在的宠物，也不会让同一页面里的宠物读到不同 pack。
- `animationConfigUrl` 遵循同一规则（快照于首次生效）。这不影响 `runtime`——运行参数是**每 tick 读取**的，改了立刻对已有宠物生效。
- 全部字段可选，且多次调用会合并；只传 `runtime` 不会清掉之前的 `assets`。

### 3.2 `createMascot(options)`

```ts
function createMascot(options: MascotOptions): Promise<Mascot>
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `container` | `HTMLElement` | **锚点**：宠物属于文档的哪个位置 |
| `pack` | `string` | pack 目录名，如 `"Neuron"` |

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
| `MascotEngine` / `AnimationConfig` / `BroadcastManager` | 高级用法，见 `dist/types/` |
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
| `dragResistAbortPx` | `5` | 挣扎期间多大的鼠标位移算挣脱 |
| `dragOffsetX` / `dragOffsetY` | `0` / `120` | 被拖住时锚点距光标的偏移；pack 自带 `OffsetX/OffsetY` 时以其为准 |
| `broadcastServeTimeoutTicks` | `600` | 广告方等待已被认领的伙伴多久 |
| `suspectStepPx` | `24` | 单 tick 位移超过此值上报为跳变嫌疑 |

> **校准警告**：`gravity` 与两个 `resistance` 是与 pack 自身物理常数配套的。改它们而不重新核对 pack，宠物行为会偏离 libshijima。`tickMs` 是最接近"速度调节"的开关。

**故意不暴露**的常量：`MAX_FRAME_DELTA_MS`、`MAX_BEHAVIOR_INITS_PER_TICK`、`STALL_LIMIT_TICKS`。它们是防止 bug 锁死页面的安全阀，调低会把"表现问题"变成"宠物坏掉"。

### 3.6 动画配置里的节奏字段

这些不在 `configure()` 里，而是写在**动画配置文件**（`animationConfigUrl` 指向的 JSON，或引擎默认请求的 `/animation.config.json`）的 `defaults` / `mascots` 中。列在这里是因为它们与 3.5 的运行参数容易混淆：**3.5 改的是引擎物理，这里改的是行为选择**。

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

- **静态服务**：精灵文件在 `dist/mascot_pack/<Pack>/img/` 下，**多数没有扩展名**（Shimeji 资源格式），因此静态服务器必须给出正确的 `Content-Type`（`image/png`）。本仓库的 `vite.test-host.config.ts` 展示了手工服务写法。
- **pack 结构**：每个 pack 一个目录，`img/` 放精灵，XML 行为定义**直接位于 pack 根目录**（`actions.xml`、`behaviors.xml`），不在 `conf/` 之类子目录下；另有 `info.json`、`bubble_context.txt`。
- **跨域**：资源与页面不同源时需允许 CORS（精灵以 `<img>` 加载，通常无需凭据）。

## 6. 完整示例

最小（零配置）：

```js
import { createMascot } from "web-mascot";

const mascot = await createMascot({ container: document.body, pack: "Neuron" });
window.addEventListener("pagehide", () => mascot.destroy());
```

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
- 中间件只在 Vite dev/preview 下存在；发布构建请用 sink。

## 8. 发布状态

`version` 为 `0.0.0`，接口尚未承诺语义化版本稳定性。
