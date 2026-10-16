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
| `configure` | `(options: MascotConfig) => void` | **打包环境必须**（在 `createMascot()` 之前）：资源根 / 预设名 / 动画配置 / 物理参数 | 3.1 |
| `PresetRegistry` | `class` | 动画行为预设注册中心（注册、获取、切换预设） | 3.6 |
| `registerPreset` | `(name: string, preset: MascotAnimationOptions) => void` | 便捷注册动画配置预设 | 3.6 |
| `usePreset` | `(name: string) => void` | 便捷切换全局当前激活预设 | 3.6 |
| `getPreset` | `(name: string) => MascotAnimationOptions \| undefined` | 获取已注册预设的配置深拷贝 | 3.6 |
| `Mascot` | `class` | 一只已挂载的宠物 | 3.3 |
| `Mascot.engine` | `MascotEngine` | 引擎实例，取仿真状态（`snapshot()` / `position()`）用 | 3.3 |
| `Mascot.label` | `string` | 稳定标识，形如 `1-Neuron` | 3.3 |
| `Mascot.currentBehavior` | `string \| null` | 当前正在运行的行为名称（只读属性 / `getCurrentBehavior()`） | 3.3 |
| `Mascot.getBehaviors` | `() => BehaviorInfo[]` | 获取所有支持的顶层动作列表及其表面约束与可用性 | 3.3 |
| `Mascot.canExecuteBehavior` | `(name: string) => boolean` | 查询指定动作在当前表面是否可立即执行 | 3.3 |
| `Mascot.setBehavior` | `(name: string, options?: ForceBehaviorOptions) => boolean` | 安全切换至指定动作（受当前表面约束，不满足返回 `false`） | 3.3 |
| `Mascot.forceBehavior` | `(name: string, options?: ForceBehaviorOptions) => boolean` | 强制切换动作（绕过表面检查，默认自动吸附/瞬移至目标表面） | 3.3 |
| `Mascot.setClickThrough` | `(enabled: boolean) => void` | 设置该宠物的鼠标穿透（忽略交互命中） | 3.3 |
| `Mascot.setScrollSquash` | `(enabled: boolean) => void` | 设置是否开启贴地响应上滚的弹性形变物理反馈 | 3.3 |
| `Mascot.getScrollSquash` | `() => boolean` | 查询是否开启贴地响应上滚的弹性形变物理反馈 | 3.3 |
| `Mascot.destroy` | `() => void` | 移除宠物，释放 DOM / 定时器 / 监听器；**可重复调用** | 3.3 |
| `importMascotPack` | `(input: MascotPackInput, options?: ImportMascotPackOptions) => Promise<ImportedMascotPack>` | 导入 Shimeji ZIP / Blob / URL 资源包，注册为虚拟模型 | 3.8 |
| `registerMascotPack` | `(pack: MascotPackData) => void` | 注册自定义虚拟模型数据（支持替换内置模型） | 3.8 |
| `unregisterMascotPack` | `(name: string) => void` | 注销虚拟模型并释放 Blob URL 内存 | 3.8 |
| `hasMascotPack` | `(name: string) => boolean` | 查询是否已注册虚拟模型 | 3.8 |
| `PackRegistry` | `class` | 虚拟模型包内存注册中心 | 3.8 |
| `ShimejiFinder` | `class` | 纯前端 Shimeji 资源包解压与解析器 | 3.8 |
| `translateShimejiXml` | `(xmlString: string) => string` | 日文 Shimeji XML 标签/属性/值翻译器 | 3.8 |
| `normalizeSpriteKey` | `(raw: string) => string` | 精灵图片路径规范化工具函数 | 3.8 |
| `assetBaseUrl` | `() => string` | 当前**生效**的资源基址（推导值或被覆盖值） | 3.4 |
| `runtimeOptions` | `() => RuntimeSnapshot` | 当前生效的运行参数（含默认值） | 3.4 / 3.5 |
| `isConfigured` | `() => boolean` | 是否显式调用过 `configure()`，仅诊断 | 3.4 |
| `PACK_BASE_URL` | `string` | 推导出的资源基址（仅未打包环境有效） | 3.4 |
| `DEFAULT_PACK_BASE_URL` | `string` | 兜底常量 `"/mascot_pack"` | 3.4 |
| `resolveAssetBase` | `(url?: string) => string \| undefined` | 从模块 URL 推导包根目录，纯函数 | 3.4 |
| `MascotEngine` | `class` | 高级用法，**不承诺稳定** | 3.4 |
| `MascotGroup` | `class` | 多宠群组生命周期与编排管理（含群组级 `setBehavior` / `forceBehavior`） | 3.9 |
| `ViewportHost` | `class` | 全屏 Shadow DOM 隔离视口与占位图管理 | 3.6 |
| `AnimationConfig` | `class` | 高级用法，**不承诺稳定** | 3.4 |
| `BroadcastManager` | `class` | 高级用法，**不承诺稳定** | 3.4 |
| `CLASSIC_ANIMATION_PRESET` | `MascotAnimationOptions` | 纯净 Qt 移植行为基线预设（`{}`） | 3.6 |
| `LIVELY_ANIMATION_PRESET` | `MascotAnimationOptions` | 网页偏活跃默认预设（含防发呆与出池断环） | 3.6 |
| `STANDARD_CONFIG_SAMPLE` | `AnimationPresetFile` | 标准化配置样例文档对象 | 3.6 |

类型：`MascotOptions`、`MascotConfig`、`MascotGroupSpawnOptions`、`RuntimeOptions`、`RuntimeSnapshot`、`MascotAnimationOptions`、`AnimationPresetFile`、`Pose`、`ActionNode`、`Behavior`、`BehaviorInfo`、`ForceBehaviorOptions`、`Hotspot`、`EngineEvent`、`EngineObserver`、`MascotPackInput`、`ImportMascotPackOptions`、`ImportedMascotPack`、`MascotPackData`、`ShimejiFinderResult`、`ShimejiPackEntry`、`ShimejiWarning`。

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
| `preset` | `string?` | 指定生效的动画预设名称。内置 `"lively"`（网页活跃默认预设）与 `"classic"`（纯净 Qt 移植无覆盖预设），支持传注册中心中的自定义预设名 |
| `animationConfigUrl` | `string?` | 动画配置文件 URL。省略则每页探测一次默认路径 `/animation.config.json`；文件不存在不报错，所选预设继续生效 |
| `ignoreBuiltin` | `boolean?` | *(已废弃，建议用 `preset: "classic"`)*。若为 `true`，等价于切换至经典基线预设 |
| `runtime` | `RuntimeOptions?` | 仿真调参，见 3.5 |

日志**不在这里**配置：观测日志走 `web-mascot/devtools` 的 `attach()`，库诊断走 `configureLogging()`（见第 4 节）。

行为与约束：

- `assets` 在**创建每只宠物时被快照**：之后再调用 `configure()` 不会影响已存在的宠物，也不会让同一页面里的宠物读到不同 pack。
- `preset` 可以在全局通过 `configure({ preset })` 或 `usePreset(name)` 设置，也可以在单个 `MascotEngine` 上通过 `engine.setPreset(name)` 独立切换。
- `animationConfigUrl` 遵循同一规则（快照于首次生效）。这不影响 `runtime`——运行参数是**每 tick 读取**的，改了立刻对已有宠物生效。
- 全部字段可选，且多次调用会合并；只传 `runtime` 不会清掉之前的 `assets`。

> **虚拟包优先机制**：`configure({ assets })` 指定的是 HTTP 静态服务下的全局资源根路径。若要加载任意第三方或用户上传的宠物模型，推荐使用 `importMascotPack()` 或 `registerMascotPack()`。注册到内存注册中心（`PackRegistry`）的虚拟模型**优先于静态 HTTP 目录**被引擎读取，不同宠物无需存放在同一资源目录下，亦支持通过同名覆盖内置的 `"Neuron"` 或 `"Eviling"`。

### 3.2 `createMascot(options)`

```ts
function createMascot(options: MascotOptions): Promise<Mascot>
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `container` | `HTMLElement` | **锚点**：宠物属于文档的哪个位置 |
| `pack` | `string` | **mascot key**：不透明标识，同时是动画配置 `mascots` 的索引键。当前实现里它等于 pack 目录名，如 `"Neuron"`；未来支持运行时导入用户模型后，它可能不再是目录名，所以不要把它当路径解析 |
| `clickThrough` | `boolean?` | 初始是否开启鼠标穿透（默认 `false`） |
| `scrollSquash` | `boolean?` | 初始是否开启贴地响应上滚的弹性形变物理反馈（默认 `false`） |

`container` 是**锚点语义**，不是裁剪框：宠物在**整个视口**内活动，`container` 只决定它属于文档的哪一处。当 `container` 被滚动出视口时，引擎会暂停这只宠物（`IntersectionObserver`）。这与 libshijima 的"桌宠属于桌面"不同，是网页场景下的等价物。

初始化会解析 pack 的 XML、预热精灵、画出第一帧；失败则 `reject`，且不在页面上留下任何东西。

### 3.3 `class Mascot`

一只已挂载到页面的宠物主控制对象，由 `createMascot()` 返回。

#### 3.3.1 属性与方法

| 成员 | 签名 / 类型 | 说明 |
| --- | --- | --- |
| `engine` | `MascotEngine` | 底层仿真引擎实例，供调试或高级底层调度使用 |
| `label` | `string` | 宠物的稳定会话标识，形如 `1-Neuron` |
| `currentBehavior` | `string \| null` | 当前正在运行的行为名称（只读属性），等价于 `getCurrentBehavior()` |
| `getCurrentBehavior()` | `() => string \| null` | 获取当前正在运行的行为名称，未就绪时返回 `null` |
| `getBehaviors()` | `() => BehaviorInfo[]` | 查询该宠物支持的全部顶层动作列表及其表面约束与即时可用性 |
| `canExecuteBehavior(name)` | `(name: string) => boolean` | 查询指定动作在宠物**当前所处表面**是否可立即执行 |
| `setBehavior(name, options?)` | `(name: string, options?: ForceBehaviorOptions) => boolean` | 安全切换动作。默认受当前物理表面约束；若不匹配则返回 `false` 且不中断当前行为 |
| `forceBehavior(name, options?)` | `(name: string, options?: Omit<ForceBehaviorOptions, "force">) => boolean` | 强制切换动作。绕过表面检查，**默认自动吸附/瞬移至目标所需表面** |
| `setClickThrough(enabled)` | `(enabled: boolean) => void` | 设置是否开启鼠标穿透模式（开启后宠物忽略所有指针事件） |
| `setScrollSquash(enabled)` | `(enabled: boolean) => void` | 设置是否开启贴地响应上滚的弹性形变物理反馈 |
| `getScrollSquash()` | `() => boolean` | 查询当前是否开启贴地响应上滚的弹性形变物理反馈 |
| `destroy()` | `() => void` | 移除宠物，销毁 DOM 节点、定时器及事件监听器。**安全且可重复调用** |

#### 3.3.2 动作控制类型定义

```ts
export interface BehaviorInfo {
  /** 行为名称，如 "StandUp"、"SitDown"、"ClimbAlongWall" */
  name: string;
  /** 该动作所要求的起始接触表面；若为 null 则表示空中动作或无表面约束 */
  requiredSurface: "Floor" | "Wall" | "Ceiling" | null;
  /** 当前表面是否可立即执行该动作（true 表示无需强切瞬移即可运行） */
  available: boolean;
  /** 该动作在模型配置中是否被标记为隐藏（如爬墙、天花板动作通常为 true） */
  hidden: boolean;
}

export interface ForceBehaviorOptions {
  /**
   * 是否绕过表面约束检查。
   * - false（默认）：若当前表面与动作要求的表面不符，切换失败并返回 false。
   * - true：强制切换至该动作。
   */
  force?: boolean;
  /**
   * 是否在强制切换时自动将宠物吸附/瞬移至目标表面。
   * - force 为 true 时默认为 true：地面动作吸附至底部、墙壁动作就近吸附至左/右墙并同步朝向、天花板动作吸附至顶部，重置速度为 0。
   * - 若显式设为 false，宠物将在原地强行切入该动作（若无表面支撑可能在后续物理帧触发掉落）。
   */
  snapToSurface?: boolean;
  /**
   * 触发原因标识，用于 EngineEvent 与开发日志追踪。默认为 "manual-api"。
   */
  reason?: string;
}
```

#### 3.3.3 动作切换机制与边缘保护

1. **零延迟即刻响应**：调用 `setBehavior` 或 `forceBehavior` 后，引擎会在当前调用内重置动作展开深度，立即展开动作树并完成首帧绘制（`renderNow()`），开发者无需等待 40ms 的物理步长间隔。
2. **指针与拖拽防护**：若在宠物正被用户鼠标/手指拖拽（`isDragging`）或长按时调用了主动切换 API，引擎会自动释放 Pointer Capture 并中止拖拽状态，恢复正常指针样式，确保不会因拖拽状态滞留导致逻辑死锁。
3. **智能表面就近吸附 (`snapToSurface`)**：
   - 切换至 `Floor` 动作：瞬移至工作区底部边界（`area.bottom`），纵向速度归零，表面标记为 `floor`。
   - 切换至 `Wall` 动作：计算宠物当前坐标距左墙与右墙的水平距离，就近吸附至最近的一侧边缘，自动同步朝向（在右墙面向右，在左墙面向左），横纵向速度归零。
   - 切换至 `Ceiling` 动作：瞬移至工作区顶部边界（`area.top`），纵向速度归零，表面标记为 `ceiling`。

#### 3.3.4 右键菜单与控制面板实战示例

```ts
import { createMascot } from "web-mascot";

const mascot = await createMascot({
  container: document.body,
  pack: "Neuron",
});

// 1. 获取所有支持的行为构建自定义右键菜单
const menuItems = mascot.getBehaviors().map((b) => ({
  label: b.name,
  // 可以在 UI 上标记当前是否可直接点击
  enabled: b.available,
  onClick: () => {
    // 强制切换并就近吸附到对应表面（推荐）
    mascot.forceBehavior(b.name);
  },
}));

// 2. 快捷键直接让宠物坐下（只有在地面时才生效）
window.addEventListener("keydown", (e) => {
  if (e.key === "s") {
    const success = mascot.setBehavior("SitDown");
    if (!success) {
      console.log("当前宠物不在地面，无法就地坐下！");
    }
  }
  // 3. 快捷键强制让宠物爬墙（无论身在何处，自动就近吸附到最近的墙壁爬墙）
  if (e.key === "w") {
    mascot.forceBehavior("ClimbAlongWall");
  }
});
```

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

### 3.6 动画配置与预设系统（PresetRegistry）

引擎采用分层解耦的配置体系。**3.5 改的是底层物理，这里改的是行为编排与节奏**。

#### 3.6.1 预设注册与切换

引擎内置了预设注册中心 `PresetRegistry`，内置两个平等预设：
- `"lively"`（默认）：针对网页端优化的活跃预设，包含防发呆推动机制与闭环打破。
- `"classic"`：纯净对齐 Qt / Shimeji-ee 桌面原版的基线预设（`{}`），不注入任何覆盖。

```ts
import { registerPreset, usePreset, getPreset, PresetRegistry } from "web-mascot";

// 1. 获取已有预设进行派生微调
const custom = getPreset("lively")!;
custom.forcedSwitchTicks = 300; // 调整为静止 12 秒推动

// 2. 注册自定义预设
registerPreset("my-chill-pet", custom);

// 3. 激活预设（全局切换）
usePreset("my-chill-pet");

// 也可在单个宠物实例引擎上独立切换
mascot.engine.setPreset("classic");
```

生效优先级：`PresetRegistry 预设（如 lively / classic） → 静态 JSON defaults → reducedMotion → mascots.<名字>`（逐字段合并，对象型字段按 key 叠加）。

#### 3.6.2 核心行为控制字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `forcedSwitchTicks` | `number` | 静止超过这么多 tick 就换行为（pacer）。"静止"按**位置是否变化**判定，所以速度为零的长序列也算静止 |
| `pacerExemptBehaviors` | `string[]` | 上面这条的**例外名单**。列出的行为不会被 pacer 打断，让长静止动画完整播完；普通 `Stay` 仍按时被推动 |
| `maxBehaviorTicks` | `number` | 单个行为的**硬上限**，超时即换（掉落/拖拽除外）。pacer 的豁免不影响它，所以豁免的行为也不会无限持续 |
| `exitToPoolBehaviors` | `string[]` | 列出的行为结束时强制回到**全局抽签池**，而不是走 pack 的 `<NextBehaviorList>` |
| `behaviorWeights` | `Record<string, number>` | 覆盖 pack 的 `Frequency`（0 = 禁用；给 `Frequency="0"` 的行为赋正值可打开它） |
| `interactionCooldownTicks` | `number` | 互动结束后，需要伙伴的行为移出候选池这么多 tick |
| `maxTravelPx` | `number` | 水平游走目标的最大距离（px）。0/缺省 = 不限 |
| `durationScale` | `number` | 全局时长倍率（0.05–20），只作用于 XML 自带的 `Duration` |
| `actionDurations` | `Record<string, number | [number, number]>` | 按动作名覆盖持续 tick 数，可写单值或 `[min,max]` |

**为什么需要 pacer 与出池破环**：pack 用 `<NextBehaviorList Add="false">` 串接相关行为，部分链条是**自闭环**（如 `SitAndFaceMouse` $\leftrightarrow$ `SitWhileDanglingLegs`）。如果不配置出池破环，网页宠物坐下后可能永远无法站起走动。预设系统将这一逻辑标准化解耦：

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

更多参数细节、取值约束及完整标准配置样例，请参阅专门文档 [ANIMATION_CONFIG.md](ANIMATION_CONFIG.md)。

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

### 3.8 自定义资源包导入与虚拟注册中心（Shimeji-ee / 日版 Shimeji 兼容）

`web-mascot` 提供了纯 TypeScript 移植的 Shimeji 资源包解析与虚拟注册方案（基于 `fflate/browser`），能够在纯前端环境解压与加载任何通用 Shimeji 资源包。

#### 3.8.1 `importMascotPack(input, options?)`

```ts
function importMascotPack(
  input: File | Blob | ArrayBuffer | Uint8Array | string,
  options?: ImportMascotPackOptions
): Promise<ImportedMascotPack>
```

- **参数 `input`**：
  - 可以是用户通过 `<input type="file">` 选取的 `File` 或 `Blob`。
  - 可以是二进制 `ArrayBuffer` 或 `Uint8Array`。
  - 可以是远程 ZIP 包的 URL 字符串（自动通过 `fetch` 下载）。
- **参数 `options`**（可选）：
  - `name?: string`：指定模型名称。若不指定，将自动从 ZIP 内的主目录名（或文件名前缀）推导。
  - `replaceBuiltin?: boolean`：若名称与内置模型（如 `"Neuron"`、`"Eviling"`）冲突，是否允许替换。默认为 `true`。
  - `onWarning?: (warning: ShimejiWarning) => void`：自定义警告监听器。若未提供，不兼容动作等警告将直接通过 `console.warn` 输出。
- **返回值 `Promise<ImportedMascotPack>`**：
  - `name: string`：注册后的模型名，可直接传给 `createMascot({ pack: name })` 或 `MascotGroup.spawn()`。
  - `warnings: ShimejiWarning[]`：解析与降级过程产生的所有警告列表。
  - `data: MascotPackData`：已注册的虚拟模型元数据（含 Blob URL 映射表）。
  - `unregister: () => void`：一键注销函数（等价于 `unregisterMascotPack(name)`）。

**使用示例**：

```ts
import { importMascotPack, createMascot } from "web-mascot";

// 用户上传 zip 文件或传入 URL
const { name, warnings, unregister } = await importMascotPack(fileOrUrl);

// 挂载自定义模型（所有现有 API 完全无缝支持）
const mascot = await createMascot({ container: document.body, pack: name });

// 页面离开或不再需要时注销并释放 Blob URL 内存
// unregister();
```

#### 3.8.2 `PackRegistry` 与内存模型生命周期

```ts
import { registerMascotPack, unregisterMascotPack, hasMascotPack, PackRegistry } from "web-mascot";
```

- `PackRegistry.register(pack: MascotPackData)`：底层注册 API。
- `PackRegistry.unregister(name: string)`：注销指定名称的模型包，**并自动调用 `URL.revokeObjectURL()` 释放所有精灵图片占用的内存**，防止长时间运行导致内存泄漏。
- `PackRegistry.has(name: string)`：检查指定名称的虚拟模型是否存在。
- **替换内置模型**：只需导入或注册同名包（例如 `name: "Neuron"`），引擎在后续调用 `createMascot({ pack: "Neuron" })` 时便会自动优先读取新模型资源，而原有测试用例和控制逻辑保持原样。

#### 3.8.3 格式兼容性与动作优雅降级

1. **目录结构兼容**：
   - 支持 Shimeji-ee 经典规范（`conf/actions.xml`、`conf/behaviors.xml`、`img/shime*.png`）。
   - 支持扁平化结构（XML 位于根目录，`img/` 存放精灵）。
   - 支持忽略大小写的精灵文件名、去除或补充 `.png` 扩展名。
2. **日文 XML 自动翻译**：
   - 自动翻译原版日文 XML 标签与属性（如 `<マスコット>`, `<動作>`, `<ポーズ>`, `画像`, `基準座標`, `枠`, `地面` 等），支持 Shift-JIS / UTF-8 编码自动探测。
3. **46 帧无 XML 皮肤包合成**：
   - 对于只有 46 张连续帧图片（`shime1.png` ~ `shime46.png`）的古早 Shimeji 资源包，自动为其注入官方通用的 `default_actions.xml` 和 `default_behaviors.xml` 模版，确保正常渲染与移动。
4. **桌面动作优雅降级**：
   - 网页环境无法操控系统窗口，对于 `ThrowIE`、`ThrowWindow`、`WalkWithIE`、`PullWindow`、`FallWithIE`、`Breed`、`Divide` 等桌面/克隆动作，引擎会自动降级为等价的常规动作（如 `Fall`、`Walk`、`Stand`）并输出诊断 warning，绝不抛出异常中断渲染。

### 3.9 `class MascotGroup` 多宠群组编排与批量动作控制

管理多只桌宠（如 Neuron 与 Eviling 伴侣双宠）的并发创建、快照接力以及群组动作同步调度。

#### 3.9.1 动作控制方法

| 成员 | 签名 | 说明 |
| --- | --- | --- |
| `setBehavior(name, options?, pack?)` | `(name: string, options?: ForceBehaviorOptions, pack?: string) => boolean` | 在群组上设置动作。若指定 `pack` 则仅控制该特定模型，未指定则向所有宠物分发；至少有一只成功即返回 `true` |
| `forceBehavior(name, options?, pack?)` | `(name: string, options?: Omit<ForceBehaviorOptions, "force">, pack?: string) => boolean` | 在群组上强制切换动作（绕过表面检查并默认自动吸附）；若指定 `pack` 则仅控制该模型 |
| `setScrollSquash(enabled, pack?)` | `(enabled: boolean, pack?: string) => void` | 设置群组全部或指定模型的贴地上滚弹性形变开关 |

```ts
import { MascotGroup } from "web-mascot";

const group = new MascotGroup();
await group.spawn({ packs: ["Neuron", "Eviling"], container: document.body });

// 1. 全员坐下（地面动作受表面检查约束）
group.setBehavior("SitDown");

// 2. 仅让 Neuron 强制去爬墙（自动就近吸附至墙壁）
group.forceBehavior("ClimbAlongWall", {}, "Neuron");
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

`version` 为 `0.1.1`。接口尚未承诺语义化版本稳定性：0.x 允许破坏性变更，其中 `MascotEngine` / `AnimationConfig` / `BroadcastManager` 属于**明确不稳定**的高级用法（见 3.4）。

许可拆成两部分，不要混：

| 部分 | 许可证 | 商用 |
| --- | --- | --- |
| 源码（`dist/`、`src/`） | `GPL-3.0-or-later` | ✅ 可以，但衍生作品须同样开源 |
| 内置宠物包 `Neuron` / `Eviling` | `CC-BY-NC-SA-4.0` | ❌ **不可以** |

`package.json` 声明的是 `"SEE LICENSE IN LICENSE"`，而**不是**单一 SPDX 标识——单一标识会被读成"整包同一许可"。包根 `LICENSE` 划定了上面两部分的适用范围，并附 GPLv3 与 CC BY-NC-SA 4.0 两份**全文**；`NOTICE` 载明上游署名、GPLv3 §7 附加条款以及对内嵌 pack 的修改声明。每个 pack 目录内另有自己的 `LICENSE` 与 `LICENSE-CC-BY-NC-SA-4.0.txt`。商业产品请自备素材包，或用 `configure({ assets })` 指向你自己的资源根。
