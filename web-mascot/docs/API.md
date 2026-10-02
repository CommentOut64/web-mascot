# web-mascot 接口文档

本文只描述**封装后对外暴露的接口**，即 `package.json` 的 `exports` 映射所声明的两个入口。内部实现（`src/core/*`、`src/dev/*`）不属于本契约的一部分，可能随版本变动。

## 1. 入口与产物

构建：

```bash
npm run build:lib     # 等价于 vue-tsc && tsc -p tsconfig.lib.json && vite build
```

产物：

| 文件 | 内容 | 大小（实测） |
| --- | --- | --- |
| `dist/index.js` | 主入口（不含记录器） | 1.57 kB |
| `dist/devtools.js` | 开发工具入口（含记录器） | 9.34 kB |
| `dist/chunks/MascotEngine-*.js` | 两个入口共享的引擎实现 | 91.6 kB |
| `dist/types/**/*.d.ts` | 类型声明（由 `tsc` 直接产出） | — |
| `dist/mascot_pack/**` | 精灵资源（由 Vite 从 `public/` 拷入） | 2.57 MB |

`exports` 映射：

```json
{
  ".":            { "types": "./dist/types/index.d.ts",    "import": "./dist/index.js" },
  "./devtools":   { "types": "./dist/types/devtools.d.ts", "import": "./dist/devtools.js" },
  "./package.json": "./package.json"
}
```

因此只有两种导入形式：

```js
import { configure, createMascot } from "web-mascot";
import { attach } from "web-mascot/devtools";
```

`dist/` 与 `public/` 同时存在资源是 Vite 的构建行为：`public/` 会被原样拷贝进 `dist/`。包的 `files` 只声明 `dist`，因此**资源只随包发布一份**。

## 2. 主入口 `web-mascot`

### 2.1 `configure(options)`

```ts
function configure(options: MascotConfig): void
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `packBaseUrl` | `string?` | 含每个 pack 目录的基址，**不带结尾斜杠**。引擎按 `<packBaseUrl>/<pack>/img/<pose>` 取图 |
| `animationConfigUrl` | `string?` | 动画配置文件 URL。省略则完全不发起请求，各 pack 使用自身设置 |

行为与约束：

- `packBaseUrl` 默认值为 `MascotEngine.PACK_BASE_URL`（即 `/mascot_pack`）。不调用 `configure()` 时引擎会请求宿主根的 `/mascot_pack/...`，**嵌入到别人页面时必然 404**，所以嵌入场景应当显式配置。
- 该值在**创建每只宠物时被快照**。之后再调用 `configure()` 不会影响已存在的宠物，也不会让同一页面里的宠物读到不同 pack。
- `animationConfigUrl` **只在首次设置时生效**。配置文件每页面只拉取一次并缓存；要重新读取需走 `MascotEngine.reloadAnimationConfig()`。
- 建议在 `createMascot()` 之前调用。

### 2.2 `isConfigured()`

```ts
function isConfigured(): boolean
```

`configure()` 是否被调用过。用于诊断，不参与运行逻辑。

### 2.3 `createMascot(options)`

```ts
function createMascot(options: MascotOptions): Promise<Mascot>
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `container` | `HTMLElement` | **锚点**：宠物属于文档的哪个位置。见下方「container 语义」 |
| `pack` | `string` | pack 目录名，如 `"Neuron"` |

- 在 pack 解析完成并画出第一帧后 resolve。
- pack 加载失败时 **reject**，并已清理现场，页面上不留残骸。
- `container` 或 `pack` 为空时同步抛 `Error`。

**container 语义（重要）**：宠物在**整个视口**内活动（`position: fixed`，工作区等于窗口尺寸），`container` **不是**它的活动范围，而是：

1. 挂载点（引擎把自己的根节点 append 进去）；
2. 可见性门（该元素滚出视口时宠物冻结，回到视口时恢复）。

因此传一个 0 尺寸或始终不可见的元素会导致宠物立即冻结。活动范围若要限制，用动画配置里的 `zone`（当前版本尚未从本接口暴露）。

### 2.4 `class Mascot`

| 成员 | 类型 | 说明 |
| --- | --- | --- |
| `engine` | `MascotEngine`（只读） | 底层实例。暴露给浏览器控制台和需要读取模拟状态的宿主 |
| `label` | `string`（getter） | 稳定标识，形如 `1-Neuron`；dev 构建里用它命名日志文件 |
| `destroy()` | `void` | 移除宠物，释放 DOM、定时器与 observer。**可重复调用** |

### 2.5 再导出的类型与类

```ts
export { MascotEngine } from "./core/MascotEngine";
export { AnimationConfig } from "./core/AnimationConfig";
export { BroadcastManager } from "./core/Broadcast";
export type { EngineEvent, EngineObserver } from "./core/MascotEngine";
export type { Pose, ActionNode, Behavior } from "./core/types";
export type { Hotspot } from "./core/Hotspot";
```

这些是给「需要深入控制」的宿主用的。**只要用 `configure` + `createMascot` + `destroy` 就够日常使用**；下面的成员属于进阶面，非稳定契约。

#### `MascotEngine` 静态成员

| 成员 | 说明 |
| --- | --- |
| `PACK_BASE_URL` | 只读常量，`"/mascot_pack"`。`configure()` 未指定时的默认值 |
| `ANIMATION_CONFIG_URL` | 只读常量，`"/animation.config.json"` |
| `configure(options)` | 与顶层 `configure()` 同源；顶层函数是它的封装 |
| `getInstances()` | 当前页所有存活实例 |
| `addObserver(fn)` / `removeObserver(fn)` | 订阅观测事件流。**没有订阅者时引擎不做额外工作** |
| `getAnimationConfig()` | 当前生效的动画配置 |
| `setAnimationConfig(file, source?)` | 用对象直接安装配置，优先于文件 |
| `loadAnimationConfig(url?)` | 读取配置文件（幂等，只读一次） |
| `reloadAnimationConfig(url?)` | 丢弃缓存并重新读取 |

#### `MascotEngine` 实例成员

| 成员 | 说明 |
| --- | --- |
| `id` / `label` | 自增序号 / `${id}-${pack}` |
| `x` `y` `vx` `vy` `lookRight` | **虚拟单位**（1 单位 = 1 精灵像素），不是页面像素 |
| `init()` | 由 `createMascot()` 调用 |
| `destroy()` | 由 `Mascot.destroy()` 调用；**建议走包装类** |
| `position()` | `{ x, y }`，已换算为**视口像素** |
| `snapshot()` | 完整状态快照，见下 |

`snapshot()` 返回：

| 字段 | 说明 |
| --- | --- |
| `pet` / `mascot` | 同 `label` / pack 名 |
| `x` `y` | 视口像素 |
| `behavior` | 当前行为名，如 `"Fall"`、`"AskForHugs"` |
| `leaf` | 当前动作叶，形如 `"Falling\|Embedded"` |
| `path` | 动作栈路径，形如 `"Fall > Select > Sequence"` |
| `nodeType` / `border` | 叶节点类型 / 边界类型（`"Floor"`、`"Wall"` 等） |
| `image` | 当前帧文件名 |
| `lookRight` / `stackDepth` / `dragging` / `tick` | 朝向 / 栈深 / 是否被拖拽 / 逻辑 tick 计数 |

#### `AnimationConfig` 公开方法

`source`、`apply(file)`、`setReducedMotion(bool)`、`refreshReducedMotion()`、`reducedMotionActive`、`isEmpty`、`toJSON()`、`describe(mascot)`、`details(mascot)`，以及一组按 mascot 查询的取值器：`optionsFor`、`allows`、`denies`、`weight`、`weightOverride`、`scale`、`mascotScale`、`forcedSwitchTicks`、`interactionCooldown`、`maxBehaviorTicks`、`maxTravelPx`、`partnerWeight`、`scanDistancePx`、`zone`、`spawn`、`durationTicks`、`hasDurationOverride`。

#### `BroadcastManager` 公开方法

宠物间 affordance 交互的注册表（每页面共享一份）：`startBroadcast(affordance, anchor)`、`tryConnect(affordance, anchor, clientBehavior, serverBehavior, maxDistance?)`、`probe(affordance, anchor)`、`snapshot()`；常量 `MAX_SCAN_DISTANCE = 256`。配套类型 `ServerState`、`ClientHandle`、`Interaction`。

## 3. 开发工具入口 `web-mascot/devtools`

记录器**不在主入口**里。已发布的构建不应让每个宿主页面去向一个不存在的 dev 端点发请求，所以它单独成一个入口。

### 3.1 `attach(options?)`

```ts
function attach(options?: DevtoolsOptions): void
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sink` | `MascotLogSink?` | 接收每个批次。传入后**优先于** dev 端点 |
| `fallbackToConsole` | `boolean?` | 额外把批次镜像到控制台，供既无 dev 服务器也无自有 sink 的宿主使用 |

未传 `sink` 时，记录器先尝试 Vite 的 `/__mascot-log` 中间件；两者都没有时**自动禁用自己**，不会反复重试。

### 3.2 `setLogSink(sink)`

```ts
function setLogSink(sink: MascotLogSink): void
```

把批次送到宿主指定的目的地，**优先于 dev 端点与 `addLogSink` 的镜像**。应在 `attach()` / `startMascotLogRecorder()` 之前调用。

### 3.3 `addLogSink(sink)`

```ts
function addLogSink(sink: MascotLogSink): void
```

追加一个镜像目的地，不取代 dev 端点。

### 3.4 类型

```ts
interface MascotLogBatch {
  session: string;   // UTC 时间戳派生的会话 id
  pet: string;       // 宠物 label，如 "1-Neuron"；"_index" 为会话级
  lines: string[];   // 每项是一条 JSON 记录
}

type MascotLogSink = (batch: MascotLogBatch) => void;
```

sink 抛出异常不会中断记录器，也不会导致批次丢失重排队。

### 3.5 日志格式

文件布局与每条记录的字段含义见 [src/dev/MascotLogRecorder.ts](../src/dev/MascotLogRecorder.ts) 顶部的说明。记录的 `k` 取值分两组：

| 分组 | `k` |
| --- | --- |
| 每只宠物（10 类） | `spawn`、`behavior`、`move`、`stop`、`pose`、`heartbeat`、`peer`、`lifecycle`、`switch`、`suspect` |
| 会话级 `pet-_index`（4 类） | `session`、`visibility`、`error`、`rejection` |

其中 `behavior` + `move` + `stop` 构成一个行为段，`x`/`y` 的折线即轨迹；`peer` 是唯一跨宠物的记录；`lifecycle` 标注冻结与恢复。

记录器以约 1 秒的节奏按宠物分批交付（或缓冲满 256 行时）。**`attach()` 之前与目的地解析完成之前产生的记录不会丢**：记录器把它们暂存在一个上限 4096 条的队列里，解析成功后立即补交，所以 `spawn` 总是在日志的第一条。

### 3.6 发布构建中如何收集日志

```js
import { configure, createMascot } from "web-mascot";
import { attach } from "web-mascot/devtools";

attach({
  sink: (batch) => {
    // batch = { session, pet, lines: string[] }，lines 每项是一条 JSON 记录
    navigator.sendBeacon("/api/pet-log", JSON.stringify(batch));
  },
});

configure({ packBaseUrl: "/mascot_pack" });
const container = document.createElement("div");
document.body.appendChild(container);
await createMascot({ container, pack: "Neuron" });
```

要点：

- **包本身不写任何文件、不打任何日志到控制台**（唯一的 `console.warn` 出现在记录器因无目的地而自行禁用时），所以宿主控制台不会被污染。
- **`sink` 是封装后唯一可靠的落盘途径**：`/__mascot-log` 端点是 Vite dev/preview 中间件，生产环境不存在。
- 日志随宠物存活期持续产生，**宿主自己负责量控**（采样、上限、只在 debug 模式启用）。库不做清理。
- 不想收集时**不要引入 `web-mascot/devtools`** 即可——记录器不在主入口里，也不会被主入口加载。

可直接运行的示例见 [test-host/sink-demo.js](../test-host/src/sink-demo.js)（页面 `test-host/sink-demo.html`）。

## 4. 资源要求（宿主必须处理）

包内含 `dist/mascot_pack/`（Neuron 1.25 MB / Eviling 1.32 MB，共 97+ 张 PNG），但**引擎按 URL 取图，不识别 `node_modules`**。宿主必须把资源送到浏览器可访问的位置，然后让 `packBaseUrl` 指向它。三种做法：

```js
// A. 构建时拷贝到自己的产物目录（推荐）
configure({ packBaseUrl: new URL("mascot_pack", location.origin + import.meta.env.BASE_URL).pathname });

// B. 指向 CDN，包内资源不参与部署
configure({ packBaseUrl: "https://cdn.example.com/mascot_pack" });
```

C. 用 postinstall 自动拷贝——**不建议**：多数包管理器默认禁用 install scripts，写入消费者源码树是侵入性的，CDN 场景下无用，失败时用户会拿到一个「装好了但没图」的包。

## 5. 完整示例

```js
import { configure, createMascot } from "web-mascot";

// 子路径部署也不会 404
const packBaseUrl = new URL(
  "mascot_pack",
  new URL(import.meta.env.BASE_URL, location.origin),
).pathname;
configure({ packBaseUrl });

const container = document.createElement("div");
document.body.appendChild(container);

const mascot = await createMascot({ container, pack: "Neuron" });
console.log(mascot.label, mascot.engine.snapshot());

// 不需要时
mascot.destroy();
```

## 6. 已知约束

| 约束 | 说明 |
| --- | --- |
| 宠物浮在宿主内容之上 | 根节点为 `position: fixed; z-index: 99999; pointer-events: auto`，会遮挡其覆盖区域的点击 |
| 活动范围是视口 | 与 `container` 无关；限制区域需用 `zone`（尚未从公开接口暴露） |
| 配置文件只读一次 | 每页面一次并缓存；改配置需 `reloadAnimationConfig()` |
| 空 `Image` 的 `<Pose>` | 部分 pack（`Neuron/actions.xml:878`）含无 `Image` 属性的 Pose。引擎已跳过其预加载，但宿主侧不需要做任何事 |
| 无清理机制 | 宿主页面关闭即结束；记录器若启用 sink，长期运行需自行控制落盘量 |

## 7. 发布状态

- `package.json` 中 `private: true`，**尚不能发布到公共 registry**；当前分发方式是 `npm pack` 得到 tarball、消费方 `npm install <tarball>`。
- 精灵素材的**再分发授权**需在公开发布前确认，这与拆包无关。
- 资源占包体积的 87%（代码仅 371 KB）。若需瘦身，方向是拆出 `@web-mascot/pack-*` 独立包或把 PNG 转 WebP，两者都应等有第二个消费者后再做。
