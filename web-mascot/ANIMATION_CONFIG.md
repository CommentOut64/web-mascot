# 动画自定义配置与预设体系（Animation Configuration & Presets）

`web-mascot` 采用**平等的预设表 + 注册中心机制（`PresetRegistry`）**管理宠物的行为与动画。系统内置两套标准预设，并允许宿主自由克隆、修改、注册与切换：

1. **`"lively"`（活跃预设，默认启用）**：专为**网页环境**调优。温和缩短已知保持段，静止 12 秒后请求在完整行为／循环结束处换位；保留完整表演，轻度降低连续重复抽选。
2. **`"classic"`（原版 Qt 预设）**：沿用原版 Shimeji / NeurolingsCE-Qt 的素材时长与合法候选权重。不设节奏催促（`forcedSwitchTicks: 0`），允许宠物依据原生 XML 静坐或躺卧 20~60 秒，完全遵循素材包原生权重。
3. **自定义预设（Custom Presets）**：宿主可通过 `getPreset("lively")` 拿已有配置微调，然后 `registerPreset("my-style", cfg)` 注册并切换。

生效的配置按标准的优先级叠加，后写的覆盖先写的（**逐字段**，对象型字段按 key 合并）：

```
基础预设 (PresetRegistry: lively / classic / 自定义)
   └── 文件 / 运行时配置中的 defaults
          └── 系统偏好 reducedMotion (当操作系统开启减少动效时)
                 └── mascots.<宠物名> (单宠个性化覆写)
```

配置文件默认从 `/animation.config.json` 读取（亦可 `?config=/my.config.json` 指定路径）。

---

## 一、 快速切换与用法

| 想要的效果 | 推荐写法 | 兼容写法（旧版） |
|---|---|---|
| **默认活跃档（Web 优化）** | 什么都不用配置 | `{}` |
| **纯正 Qt / 原版桌宠档** | `configure({ preset: "classic" })` 或配置 JSON 中写 `"preset": "classic"` | `configure({ ignoreBuiltin: true })` |
| **在基础预设上微调** | 配置文件只写要修改的字段，例如 `{"defaults":{"forcedSwitchTicks":400}}` | — |
| **自定义注册新预设** | `const cfg = getPreset("lively"); cfg.forcedSwitchTicks = 300; registerPreset("my-preset", cfg); usePreset("my-preset");` | — |

---

## 二、 标准配置表规范与参数字典

标准配置文件结构（`animation.config.json`）：

```jsonc
{
  "version": 1,
  "preset": "lively", // 继承的基础预设名："lively"（默认）或 "classic"（Qt原版）
  "respectReducedMotion": true, // 是否跟随系统「减少动态效果」偏好，默认 true
  "defaults": { /* 对所有宠物生效的微调覆盖 */ },
  "mascots": { "Neuron": { /* 仅对该宠物覆盖 */ }, "Eviling": { } },
  "reducedMotion": { /* 系统开启减少动效时追加覆盖 defaults */ }
}
```

### 全参数规格与约束

| 字段 | 类型 | 单位 | 有效区间 | Classic (Qt) | Lively (活跃) | 功能说明与约束边界 |
|---|---|---|---|---|---|---|
| `preset` | `string` | 字符串 | 已注册预设名 | `"classic"` | `"lively"` | **基底预设**：决定底层继承哪套行为策略。 |
| `forcedSwitchTicks` | `number` | ticks (40ms) | `0 ~ 1,000,000` | `0` | `300` (12s) | 静止换位请求：有限行为结束后执行，无限循环完成一整轮后退出。 |
| `maxBehaviorTicks` | `number` | ticks (40ms) | `0 ~ 1,000,000` | `0` | `1100` (44s) | 行为年龄预算：在完成点回全局池，不清空正在执行的有限序列。 |
| `pacerExemptBehaviors` | `string[]` | 数组 | 行为名 | `[]` | `["SitWhileDanglingLegs"]` | 不受静止换位请求影响；有限表演原本就不会被调度计时器截断。 |
| `exitToPoolBehaviors` | `string[]` | 数组 | 行为名 | `[]` | `["SitWhileDanglingLegs"]` | **闭环打破名单**：原版 XML 中部分行为（如坐下）使用 `Add="false"` 形成死循环；列入此名单的行为执行完强制回全局池抽签。 |
| `behaviorWeights` | `Record<string, number>` | 字典 | `0 ~ 100,000` | `{}` (原生) | `{ SitWhileDanglingLegs: 150, SitAndFaceMouse: 8 }` | **行为选择权重覆盖**：覆盖 XML 中的 `Frequency`。`0` = 禁用；正数提高抽取概率。 |
| `actionDurations` | `Record<string, number \| [min,max]>` | ticks (40ms) | `1 ~ 1,000,000` | `{}` (原生) | `{}` | **动作停留时长固定/范围覆盖**：覆盖 XML 中 Stay 类动作的 `Duration`。 |
| `actionHoldLimits` | 动作名 → `{ticks, waitPoses}` | ticks / 帧下标 | 见下文 | 无 | 见下表 | 仅调整明确标注的静止等待帧，保留完整帧顺序及其余帧时长。 |
| `repeatBehaviorWeight` | `number` | 权重倍率 | 0～1 | 1 | 0.65 | 有其他可执行候选时，温和降低全局池立即重复抽选的权重。 |
| `durationScale` | `number` | 浮点数 | `0.05 ~ 20.0` | `1.0` (原速) | `1.0` | **全局时长缩放倍率**：按比例缩放 XML 自带的所有 Stay 动作持续时间。 |
| `scale` | `number` | 浮点数 | `0.2 ~ 4.0` | `1.0` (原尺寸) | `1.0` | **宠物视口渲染尺寸缩放**：1.0 = 原生 128px 贴图大小。引擎内部保持 1:1 虚拟坐标计算。 |
| `maxTravelPx` | `number` | px | `10 ~ 100,000` | `0` (不限制) | `0` (不限制) | **水平漫游最大距离**：限制随机游走步长，防止横穿全屏破坏排版。爬墙等边界目标不受此限。 |
| `interactionCooldownTicks` | `number` | ticks (40ms) | `0 ~ 100,000` | `0` | `0` | **互动冷却时间**：完成一次互动（如拥抱）后的冷却期，防止两只宠物贴身无限连续拥抱。 |
| `scanDistancePx` | `number` | px | `16 ~ 4,096` | `256` | `256` | **伙伴搜索半径**：扫描附近可互动伙伴的有效直线距离。 |
| `partnerWeights` | `{alone, withPartner, reachable}` | 对象 | `0 ~ 100,000` | `{}` | `{}`（使用 XML 权重） | **伙伴互动场景权重**：根据“单只独处”、“同场有伴”、“同高度且在搜索半径内”三档动态调节互动欲望。 |
| `allowBehaviors` | `string[]` | 数组 | 行为名 | `[]` (全允许) | `[]` (全允许) | **行为白名单**：只允许出现列表内的行为。 |
| `denyBehaviors` | `string[]` | 数组 | 行为名 | `[]` (无禁用) | `[]` (无禁用) | **行为黑名单**：永不出现列表内的行为，优先级高于白名单。 |
| `spawn` | `{ vertical, x, topOffset, staggerPx }` | 对象 | 复合结构 | `{ topOffset: 100, staggerPx: 180 }` | `{ topOffset: 100, staggerPx: 180 }` | **生成位置**：`vertical` 可选 `"top"` 或 `"floor"`；`staggerPx` 为多只生成时的错开位移（防重叠）。 |
| `zone` | `{ left, right, top, bottom }` | 对象 | 复合结构 | 全视口 | 全视口 | **活动限制区域**：将宠物的生活区域约束在指定盒子内。 |
| `ignoreBuiltin` | `boolean` | 布尔值 | `true / false` | `@deprecated` | `@deprecated` | **向后兼容字段**：旧代码设置 `ignoreBuiltin: true` 等价于自动切换至 `"classic"` 预设。 |

## 活跃配置与完整结束规则

`forcedSwitchTicks` 和 `maxBehaviorTicks` 是调度请求，均不会直接重置动作栈。有限行为依照素材时长、目标和子动作顺序完成；显式无限循环在完整一轮结束时响应请求。跌落、拖拽和有效互动保持自己的执行规则。真实失去支撑、条件失效、显式命令等仍可结束动作。

`actionHoldLimits` 每项为 `{ ticks: number | [min,max], waitPoses: number[] }`，下标从 0 开始。它只作用于无位移、无条件动画变体的 Stay 叶节点。每次进入仅均匀抽样一次整数预算；等待帧按原时长比例分配剩余 tick，每帧至少 1 tick，未标注帧的时长及全部帧顺序保持原样。原素材对象不会被改写。

该字段仅支持上述对象格式；开发阶段使用过的 `[min,max]` 数组项已移除，不提供兼容解析。迁移时必须同时明确 `ticks` 与素材中的 `waitPoses`，不能根据动作名称自动猜测等待帧。

例如两套内置素材的普通保持为 `[150,4,100,4,150]`，第 0、2、4 帧是等待，第 1、3 帧是眨眼。配置为：

```json
"actionHoldLimits": { "Stand": { "ticks": [150,250], "waitPoses": [0,2,4] } }
```

旧算法把预算向上取整到 408 tick，使整个区间失效；现在一轮完整帧序列实际耗时等于抽样预算，两个眨眼仍各为 4 tick。短 XML 过渡不被拉长，也不为了压缩等待而重播完整表演。未标注、条件动画、互动及目标移动保留原时序。下标与素材不匹配时不应用该项；预算小于“固定表现帧总时长＋等待帧数”时，使用这个可行下界，`idle-timing` 日志同时记录 requested/effective。

| lively 保持段 | 预算 tick | 预算时间 | 实际叶节点时长 |
|---|---|---|---|
| `Stand` | [150,250] | 6～10 秒 | 长保持等于预算，短过渡沿用 XML |
| `Sit`、`Sprawl` | [200,350] | 8～14 秒 | 同上 |
| `GrabWall`、`GrabCeiling` | [200,300] | 8～12 秒 | 同上 |

行为总时长还包含容器推进和其他子动作，不能与单个保持叶节点时长混为一谈。`forcedSwitchTicks: 300` 表示在完成点检查是否已经静止 12 秒；`maxBehaviorTicks: 1100` 表示在完成点检查行为是否已执行 44 秒。二者都没有硬截止时刻，也不会在阈值 tick 单独发出请求事件。

`repeatBehaviorWeight: 0.65` 温和降低立即重复当前行为的全局抽选权重；不干预 `Add=false` 的专用下一行为链。`exitToPoolBehaviors` 让指定行为完整结束后回全局池，避免封闭坐姿链。

`actionDurations` 仍可显式指定叶节点时长。对 Sequence/Select 容器，它只为重复设置预算，有限容器保留全部子动作。调节普通保持应优先使用 `actionHoldLimits`。

注册、克隆、切换和 JSON 导出沿用原接口。合并顺序为预设 → defaults → reducedMotion → 单宠覆盖；`actionHoldLimits` 按动作名合并，ticks 范围与 waitPoses 数组均深复制。`usePreset()` 清除有效配置缓存。切换配置不重抽正在执行的保持预算，新进入的动作使用新配置。

## 互动（broadcast）与候选资格

互动沿用广播握手：广告方发布 Affordance，扫描方完成当前行为后才能选择接近动作，抵达后双方分别执行 Behavior / TargetBehavior。近距直接连接的范围仍为 `scanDistancePx`（默认 256 页面像素），高度差最多 1 个引擎单位。

同高度、双方声明为 Floor 的远端广播可被独占预留，扫描方执行素材原有的前置动作和 ScanMove，沿水平路线接近实时目标。其他表面没有远端寻路。广告方的自然结束会等待已认领的扫描方，仍受 `broadcastServeTimeoutTicks` 限制；拖拽、销毁、显式切换或路线失效会释放预留。远端阶段记录 `broadcast-reserve`，抵达时才记录 `broadcast-connect` 和 `interaction-arrived`，不会把预留计作成功握手。

自动选择先确认资格，再使用权重：

1. 扫描行为必须存在相同 Affordance 的可用广播，来自另一只宠物，满足近距连接或远端地面接近规则，双方交接动作均存在且未被白/黑名单禁用。SayItBack 在两套内置素材中没有提供方，因此不会自动空扫。
2. 广告行为必须有另一只已加载宠物具备相容的扫描行为；双方角色不匹配时不进入自动候选。
3. 到正常选择边界时，若最终合法候选池内有可连接机会，优先在这些候选中按现有权重抽取，并当场认领广播；前置动作照常执行，进入 ScanMove 后接续使用这条连接。有限动作不为此中断，必需的 Add=false 下一行为链、禁用项及冷却继续生效。
4. 近距资格查询和连接共用 BroadcastManager.findAvailable；远端查询和预留共用 findReachable，排除自身、已认领及已结束的广告。正常选中后已认领的广告会等待伙伴；显式换行为、关闭宠物或等待超时仍可撤销连接。

`partnerWeights` 只覆盖有资格候选的权重，不提供广播或越过资格检查。内置 lively 未配置此字段，沿用 XML 权重；完整示例中的三档值仅作显式自定义示例。`behaviorWeights` 同样不能重新启用当前不可执行的扫描或绕过冷却。

互动次数取决于双方的合法选择时刻、素材时长与空间位置，不能无条件承诺每分钟固定次数。验收应先验证“机会存在时在下一合法选择点被消费、连接后抵达、无提供方时不空扫”，自然运行频次单独报告。

## 条件与观测语义

动作实例中的 `${...}` 条件只求值一次；`#{...}` 条件每 tick 求值一次。子节点使用自己的属性，引用和 Select 不会额外重抽同一条件；接力保存冻结条件及已分配的等待时长。行为资格同时要求祖先 Condition 与自身 Condition 成立。

每次行为进入（包括同名重入）都有 behavior 事件，带 instance、tick、entryId、restart、previousTicks。reason 表示退出/进入原因，selectionPolicy 单独表示完成后采用的调度策略。例如目标移动正常抵达后，reason 为 behavior-end，selectionPolicy 可以为 behavior-cap；这不表示移动被 44 秒截断。

`npm run test:scheduling` 跑真实素材及核心回归；`npm run test:soak` 跑固定种子的三组 30 分钟模拟及按行为条目的遍历，报告写入 `../tmp/scheduling-verification/report.json`。模拟时间不等同于真实浏览器墙钟时间。`test-run/harness.html?plan=sweep|drill` 用于浏览器运行，等待生命周期事件并将超时标为失败。

## 历史调参记录：怎么把「活泼」和「Qt 质感」拆开

> 本节记录旧版硬切调度的实验；全局上限和容器截断说明不再适用于当前实现。当前规则见前文「活跃配置与完整结束规则」。

网页版一开始为了让页面不显得呆，用了两个**全局**旋钮：`forcedSwitchTicks`（静止太久必须换）和
`maxBehaviorTicks`（单个行为硬上限）。但它们会**连 pack 本来就设计好的长保持一起掐掉**：

```xml
<Action Name="SitDown" Type="Sequence" Loop="false"> <ActionReference Name="Sit"   Duration="${500+Math.random()*1000}"/></Action>
<Action Name="LieDown" Type="Sequence" Loop="false"> <ActionReference Name="Sprawl" Duration="${500+Math.random()*1000}"/></Action>
```

也就是"坐着/趴着保持 **20–60 秒**"——而全局上限 15 秒、pacer 10 秒直接把它们截断，
换姿势频率因此是 Qt 的 2–6 倍；而 pack 里**一共 143 个行为、`NextBehavior` 声明为 0 个**，
每次换行为都是随机抽取、且 `SitDown`/`StandUp` **没有过渡帧**，所以换得越勤就越像"抽帧跳变"。

拆法是**用按动作的时长替代全局上限**：

```json
"forcedSwitchTicks": 750,          // 30 s：地板上的坐/趴接近 pack 原意，但页面不会定格
"maxBehaviorTicks": 900,           // 36 s 兜底
"actionDurations": {               // 只掐"该赶紧下来/别磨蹭"的动作
  "HoldOntoWall": 120, "HoldOntoCeiling": 120,      // 挂墙/挂顶 ≤5 s
  "ClimbWall": 150, "ClimbCeiling": 150,            // 单段攀爬 ≤6 s
  "ClimbAlongWall": 200, "ClimbAlongCeiling": 200,
  "ClimbHalfwayAlongWall": 200,
  "CrawlAlongWorkAreaFloor": 300                    // 漫长爬行 ≤12 s
},
"partnerWeights": { "alone": 40, "withPartner": 150, "reachable": 1800 }
```

最后一条也是同一个思路：**互动只在"能成事"时才活跃**。`withPartner` 压低之后，两只离得远时
不再反复抽取必然落空的扫描（`HugEvil`/`HugNeuro` 每次只活约 1.2 秒，是短切换的最大来源）；
而对方同高度且在扫描半径内时用 `reachable: 1800`，该抱还是照抱。

⚠️ `actionDurations` 可以写**容器动作**的名字（`HoldOntoWall` 是 `Sequence`，真正的保持在内层
`GrabWall`）。引擎现在会在容器帧上同样判定这个上限，否则钉在 Sequence 上的值会被静默忽略
（实测：钉了 `HoldOntoWall: 120` 却仍然挂墙 30 秒，因为内层 `GrabWall` 吃的是 pack 的 20–60 秒）。

实测对照（两只宠物、约 5.5 分钟）：

| 指标 | 全局上限（pacer 250 / cap 375） | 拆分后（pacer 750 / cap 900 + 按动作钉值） |
|---|---|---|
| 行为时长中位 | 2.4 s | **6.0 s** |
| 行为时长最长 | 10.0 s | **82.0 s**（pack 的 20–60 秒长保持回来了） |
| 不足 8 秒就换掉 | 83% | **57%** |
| 换行为频率 | 16.7 次/分 | **8.7 次/分** |
| `forced-switch` 次数 | 29 | **8** |
| 墙上时间（宠物2） | 9–21% | **3%**（单次挂墙从 30 s 降到 <3 s） |
| 地板时间 | 93–95% | **96–98%** |
| 完成的互动 | 3 次 / 5.6 分 | 2 次 / 5.4 分（`reachable` 期间仍约每 1 分钟一次） |

## 标准配置表完整样例（全字段注释）

你可以直接复制以下结构保存为 `animation.config.json`，按需修改对应项：

```jsonc
{
  "version": 1,
  // 基础预设："lively"（活跃预设，默认）或 "classic"（Qt桌面桌宠原版）
  "preset": "lively",
  // 是否跟随系统减少动效偏好 (boolean)
  "respectReducedMotion": true,

  "defaults": {
    // ---------------- 1. 节奏与移动控制 ----------------
    // 静止达到 N tick 后请求在完整结束点换位，0=关闭
    // Classic 推荐 0（还原20-60秒静坐），Lively 推荐 300
    "forcedSwitchTicks": 300,

    // 行为年龄预算；有限序列完整结束，循环完成一轮后退出
    // Classic 推荐 0，Lively 推荐 1100 (44s)
    "maxBehaviorTicks": 1100,

    // [pacerExemptBehaviors] 节奏调节器豁免名单（位移为0但本身在播放的长动画）
    "pacerExemptBehaviors": ["SitWhileDanglingLegs"],

    // [exitToPoolBehaviors] 行为结束后强制返回全局抽签池（打破XML坐姿死循环）
    "exitToPoolBehaviors": ["SitWhileDanglingLegs"],

    // [maxTravelPx] 横向漫游最大距离，防止横穿全屏破坏网页正文排版 (px, 0=不限制)
    "maxTravelPx": 240,

    // 仅调整已审核的静止等待帧，其余帧时长和完整顺序保持
    "actionHoldLimits": {
      "Stand": { "ticks": [150,250], "waitPoses": [0,2,4] },
      "Sit": { "ticks": [200,350], "waitPoses": [0,2,4] },
      "Sprawl": { "ticks": [200,350], "waitPoses": [0,2,4] },
      "GrabWall": { "ticks": [200,300], "waitPoses": [0,2,4] },
      "GrabCeiling": { "ticks": [200,300], "waitPoses": [0,2,4] }
    },
    "repeatBehaviorWeight": 0.65,

    // ---------------- 2. 行为选择与动作时长 ----------------
    // [behaviorWeights] 覆盖 XML 中的 <Behavior Frequency="..."> (0=禁用, >0提高概率)
    "behaviorWeights": {
      "SitWhileDanglingLegs": 150,
      "SitAndFaceMouse": 8
    },

    // [actionDurations] 覆盖 XML 中 Stay 动作的持续时间，可写数字或 [min, max] (ticks)
    "actionDurations": {
      // "Sit": [80, 150]
    },

    // [durationScale] 全局动作时长倍率，等比缩放 XML 中所有的 Stay 动作时长 (0.05 ~ 20.0)
    "durationScale": 1.0,

    // [allowBehaviors] 白名单：只允许抽选列表内的行为（缺省/空=全部允许）
    "allowBehaviors": [],

    // [denyBehaviors] 黑名单：永不抽选列表内的行为
    "denyBehaviors": [],

    // ---------------- 3. 尺寸与生成几何 ----------------
    // [scale] 宠物视口渲染缩放倍率 (0.2 ~ 4.0, 1.0=128px原生贴图)
    "scale": 1.0,

    // [spawn] 生成位置与错开
    "spawn": {
      "vertical": "top", // "top" 顶部落下，"floor" 地板起步
      "x": "center", // 水平位置：像素(如 300)、百分比(如 "50%") 或 "center"/"left"/"right"
      "topOffset": 100, // 顶部落下时的起始下落偏移 (px)
      "staggerPx": 180 // 多只同时生成时的错位间距 (px, >128防重叠)
    },

    // [zone] 活动限制区域 (工作区盒模型，px / % / 关键字)
    // "zone": { "left": 0, "right": "100%", "top": 0, "bottom": "100%" },

    // ---------------- 4. 伙伴与双宠互动 ----------------
    // [scanDistancePx] 寻找伙伴的扫描半径 (16 ~ 4096 px, 默认 256)
    "scanDistancePx": 256,

    // [interactionCooldownTicks] 完成一次互动后的冷却 ticks，防贴脸无限连击
    "interactionCooldownTicks": 0,

    // [partnerWeights] 伙伴互动动作的场景权重 (alone / withPartner / reachable)
    "partnerWeights": {
      "alone": 40,
      "withPartner": 150,
      "reachable": 1800
    }
  },

  "mascots": {
    // 针对特定宠物名称的个性化覆盖 (按 key 合并 defaults)
    // "Neuron": {},
    // "Eviling": {}
  },

  "reducedMotion": {
    // 系统开启减弱动态效果时额外叠加的配置
  }
}
```

## 场景定制示例

**只让它在地板上跑和坐，坐得短一点，每 8 秒必须动一次：**

```json
{
  "defaults": {
    "allowBehaviors": ["SitDown", "RunAlongWorkAreaFloor", "StandUp"],
    "behaviorWeights": { "RunAlongWorkAreaFloor": 300, "SitDown": 100, "StandUp": 100 },
    "actionDurations": { "Sit": [80, 150] },
    "forcedSwitchTicks": 200
  }
}
```

**嵌入页面：底部条带活动 + 地板起步 + 两只错开，并且尊重系统的减少动态偏好：**

```json
{
  "respectReducedMotion": true,
  "defaults": {
    "zone": { "left": "10%", "right": "90%", "top": 640, "bottom": "bottom" },
    "maxTravelPx": 180,
    "spawn": { "vertical": "floor", "x": "25%", "staggerPx": 220 },
    "forcedSwitchTicks": 300,
    "maxBehaviorTicks": 450
  },
  "reducedMotion": { "forcedSwitchTicks": 600, "maxTravelPx": 80, "denyBehaviors": ["RunAlongWorkAreaFloor"] }
}
```

**让两只宠物风格不同（`defaults` 打底，`mascots` 覆盖）：**

```json
{
  "defaults": { "durationScale": 0.5, "actionDurations": { "Sit": 120 } },
  "mascots": {
    "Neuron":  { "allowBehaviors": ["RunAlongWorkAreaFloor", "RunAndGrabBottomLeftWall"], "spawn": { "x": "20%" } },
    "Eviling": { "allowBehaviors": ["SitDown"], "actionDurations": { "Sit": [40, 60] }, "spawn": { "vertical": "floor", "x": "80%" } }
  }
}
```

## 历史默认档的取值理由

> 本节及其旧版探针结果仅作历史对照。当前 lively 已改为完成点调度，默认阈值 300 tick；请以前文配置表和源码为准。

内置预设（`src/core/animationPreset.ts`，并原样出现在 `dist/animation.config.json`）是按
「**网页宠物**，不是桌面宠物」定的 —— 不显得呆，但也不把 pack 本来设计好的长动画掐断：

| 取值 | 为什么 |
|---|---|
| `forcedSwitchTicks: 200`（8 s） | 访客对装饰元素的注意力窗口约 5–15 s；静止超过 8 s 就可能一直没被看到在动 |
| `pacerExemptBehaviors: ["SitWhileDanglingLegs"]` | pacer 的"静止"按**位置是否变化**判定，坐着晃腿这种速度为零的长序列也会命中，所以必须豁免，否则它永远播不完 |
| `exitToPoolBehaviors: ["SitWhileDanglingLegs"]` | 与上一条配套：pack 的 `SitAndFaceMouse` 用 `Add="false"` 构成闭链，不回主池就再也出不来 |
| `maxBehaviorTicks: 1100`（44 s） | pacer 只管静止，这条兜住其余行为；放在晃腿序列长度之上，让那一段播完 |
| `behaviorWeights: { SitWhileDanglingLegs: 150, SitAndFaceMouse: 8 }` | 两个 pack 原生都给它 `50`，而它是最有戏的动作；`SitAndFaceMouse` 是上面那个闭链的入口，压低 |
| `spawn: { topOffset: 100, staggerPx: 180 }` | 顶部落下；多只宠物按 ±180 px 交替错开（大于 128 px 的精灵宽），不叠在一起 |

### 可选示例：更克制的网页档

早期随包附带的 `animation.config.json` 是另一套取向：节奏更慢、禁掉鼠标追人、宠物缩放 1.25，
并用 `partnerWeights` 让两只更容易互动。想换成这一套，就把它整块写进你的 `defaults`
（它会覆盖内置预设的同名字段）：

| 取值 | 为什么 |
|---|---|
| `forcedSwitchTicks: 750`（30 s） | 让地板上的坐/趴接近 pack 原意，页面又不会定格 |
| `maxBehaviorTicks: 900`（36 s） | 单个行为的兜底 |
| `maxTravelPx: 240` | 桌面宠物可以横穿整个屏幕，网页宠物会踩到正文 |
| `partnerWeights: {alone: 40, withPartner: 150, reachable: 1800}` + `scanDistancePx: 520` | 单只时不空转；"对方同高度且在半径内"时加码，两只才真的抱得上 |
| `denyBehaviors: ["ChaseMouse"]` | 不要一有鼠标移动就冲过去；`SitAndFaceMouse` 只是转头，保留 |
| `scale: 1.25` | 128 px 素材下 1.25 尚可、1.5 起明显发虚 |
| `actionDurations: { HoldOntoWall: 120, … }` | 只掐"该赶紧下来"的动作（挂墙/攀爬/爬行），而不是全局上限 |

> 下面的实测对照来自**历史迭代**（pacer 250 / cap 375 那一版），保留是为了说明各旋钮的作用量级；
> 它既不是内置预设的数字，也不是上面这套示例档的数字。

### 实测对照（40 ms tick，两只宠物约 240 s）

| 指标 | pack 原始 | 本默认档 |
|---|---|---|
| 位移时间占比 | 28% / 33% | 30% / 43% |
| 最长静止 | 96 s / 79 s | 20 s / 25 s |
| 每分钟真实位移事件（≥50 px） | 1.8 / 1.3 | 4.2 / 6.2 |
| 画面变化次数/分钟 | 62 / 61 | 77 / 85 |

其它已实测的配置项：

| 场景 | 结果 |
|---|---|
| `actionDurations: {"Sit": [40,60]}` | 每次坐下 1.56–2.33 s（未配置时 20–60 s） |
| `durationScale: 0.25` | `Fall` 里的 `Stand`（XML 100–200 tick）→ 1.44 s |
| `spawn.staggerPx: 180` | 第 1 只 x=558.5（居中），第 2 只 x=738.5（+180） |
| `maxTravelPx: 240` | 横穿全屏的 `RunAlongWorkAreaFloor` 目标被夹到 ±240 px 内；`RunAndGrab*Wall`（目标恰好是边界）不受影响 |
| `partnerWeights.withPartner: 20000` + `scanDistancePx: 2000` | 75 s 内完成 2 次 `broadcast-connect` → 1 次 `interaction-arrived` → 双方进入 `IHugYou` / `IAmHugged` |
| `forcedSwitchTicks: 100` | 每 4 s 出现一次 `forced-switch` 里程碑 |
| 点击精灵中心（坐在 `Sit` 上） | `hotspot behavior=SitDownBlush shape=Ellipse local=64,63` → 行为切到 `SitDownBlush`，贴图变 `shime11pat.png`，且 `Dragged` 为 0 |
| 点击精灵中心（站在 `Stand` 上） | 未命中热点 → 正常进入 `Dragged`（`reason=drag-start`） |

## 点击热点（Hotspot）

`actions.xml` 的 `<Animation>` 里可以声明可点击区域（`parser.cc::parse_hotspot`）：

```xml
<Hotspot Shape="Ellipse" Origin="39,18" Size="46,27" Behavior="StandBlush"/>
```

**按在热点上 → 执行 `Behavior` 指定的行为，并且不会把宠物抓起来拖走**；按在精灵其它位置才进入拖拽
（libshijima `animation::handle_dragging()`）。鼠标悬停在热点上时光标变成 `pointer`。

pack 用它做「摸头脸红」：Neuron 8 处、Eviling 10 处，目标是 `StandBlush` / `SitDownBlush` /
`SprawlBlush`（Eviling 还有 `HurledSprawlBlush`）。这些行为在 `behaviors.xml` 里是
`Frequency="0" Hidden="true"`，所以**点击是它们唯一的触发途径**。

两个容易踩的语义：

- `Size` 是**半轴**：libshijima 的椭圆判定除以 `size` 本身，所以实际区域是声明值的 **2 倍**（pack 数据就是这么写的），
  边界用严格 `< 1`；
- 坐标按贴图算，朝右时贴图被镜像，左边缘为 `anchor.x - (width - ImageAnchor.x)`（Qt 里硬编码了
  `width = 128`，这里取贴图实际宽度）。

与配置的关系：热点是访客的**主动操作**，所以不受 `allowBehaviors` / `behaviorWeights`（它们只管随机抽取）
限制；但 `denyBehaviors` 里明确禁止的行为依然不会通过点击触发。

## 拖拽、投掷与边界吸附（为什么拖到墙边会扒住墙）

这套逻辑不在配置里，而是 Qt 引擎 + pack 数据共同决定的，网页版已对齐：

1. **松手 → `Thrown`**（libshijima `dragged::handle_dragging()`）。`Thrown` 与 `Fall` 结构相同：
   `Falling`（初速度取 `mascot.environment.cursor.dx/dy`）后面接一个 `Select`：
   `floor.isOn(anchor)` 成立 → `Bouncing` + `Stand`；**否则 → `GrabWall Duration=100`**。
2. **下落何时算"落地"** = `floor.isOn || ceiling.isOn || workArea.isOn`（`fall.cc` / `state::on_land()`），
   其中 `workArea.isOn` 指**工作区四条边中的任意一条**（`|Δ| < 1` 且在跨度内）。
   下落过程中还会把锚点夹回工作区，所以越过边界时锚点会**精确落在边界线上**。
3. 于是「拖到侧墙中部松手」= 锚点已在墙边 → 下一 tick 就判定落地 → 但 `floor.isOn` 为假 →
   走 `GrabWall` 分支 → 扒住墙（贴图变 `shime12.png`）→ 之后 `BorderType="Wall"` 的行为
   （`HoldOntoWall` / `ClimbHalfwayAlongWall` / `ClimbAlongWall` / `FallFromWall`）进入候选 → 攀爬。
   反过来，若松手时带着横向速度把宠物甩出去，它会划弧落到地板，走 `Bouncing` + `Stand` —— 两者都对。
4. `BorderType` 不再满足的行为会立刻结束（`check_border_type`），所以攀爬是一串「边界动作」的接力；
   一旦被拖离墙面，链条断开并掉落。

实测（生成在左墙中部 `x=0, y=300`）：`land "fall ended at wall"` → `Fall > Select > GrabWall`
→ `HoldOntoWall` → `ClimbAlongWall`；普通模式下 70 秒内出现 14 次「落在墙边」，
且 `position-jump` 误报为 0。

**两个实现要点，都踩过坑：**

1. **判定顺序**：`fall::subtick` 是**先判定落地、后加重力与速度**。反过来写（先移动）会让一个重力步把锚点推离它所在的边，
   而 `is_on` 容差只有 1px，于是判定失败——表现为「右侧能吸附、左侧和顶部不能」：右侧的投掷速度被墙夹回去（仍贴边），
   左侧的速度把锚点推离墙，顶部的重力把锚点推离天花板。
2. **顶部（天花板）另有一层问题，网页版在此刻意偏离 Qt**：pack 里 `Fall`/`Thrown` 的 `Select` 兜底是
   `GrabWall`（`BorderType="Wall"`），而它在顶部不成立 → libshijima 会 `queued_behavior = "Fall"`
   → 再次落在天花板 → 再 `GrabWall`……**Qt 自己在顶部中间也会来回打转**。
   网页版的做法：边界丢失时，如果宠物正站在**另一条边**上，就交接给「从这条边开始」的行为
   （`firstBorderOf()` 取动作树里第一个 `BorderType`），于是顶部会切到 `HoldOntoCeiling` / `ClimbAlongCeiling`
   （日志里记为 `border-change:Wall->Ceiling`）；只有池子里没有该边界的行为时才退回 Qt 的 `Fall`。
   这是有意的、可回退的改进；要严格复刻 Qt 就把 `updatePhysics()` 的 `border-lost` 分支改回无条件 `Fall`。

**拖拽已按 Qt 实现（`dragged` / `resist` 两个动作类）：**

- **偏移固定**：按住后锚点每 tick 置于 `cursor + (OffsetX, OffsetY)`，这两个值取自动作自身属性，
  pack 未定义时用 Qt 的默认值 `0, 120` —— 也就是**总是拎着后颈**（精灵 128 高、锚点在脚底，所以头正好落在光标处），
  抓起瞬间会跳一下，与 Qt 一致。按住期间朝向固定为朝左（`dragged::subtick` 里 `looking_right = false`）。
- **10 秒挣扎挣脱**：被拎着时 pack 的 `Pinched`（`Class="...Dragged"`）动画只是循环；它**只**因
  `elapsed() >= time_to_resist`（250 tick = 10 秒）而结束，而**光标一移动就把计时器清零**
  （阈值 `5/subtick_count ≈ 1.25px`）。计时满 → 外层 `Dragged` 序列前进到 `Resisting`
  （`Class="...Regist"`）：若光标相对锚点移动 ≥ 5px 就**回到被拎着**（计时重置），
  否则等它的攀扎动画播完 → `dragging = false` → 宠物**挣脱并被抛出**（走 `Thrown` 掉落）。
  日志里对应 `drag-resist`（开始挣扎）与 `resist-escape`（挣脱）/ `resist-abort`（放弃挣扎）。
- 被拎着时 `Pinched` 的姿势按其动画条件（`FootX`/`FootDX`，平滑跟随光标的脚部位置）切换。
- 被拎着期间**不接受**配置的节奏调节（`forcedSwitchTicks`/`maxBehaviorTicks`）：Qt 只在
  `Dragged` 动作内部前进到 `Resisting`，不会回到行为池重抽。

**两个健壮性要点（都来自实测踩坑）：**

1. **换动画变体必须重置姿势时钟**。libshijima 的 `get_animation()` 在选中的变体改变时会
   `start_time = mascot->time`（动画重新开始）；网页版一开始只换了变体却保留 `poseIndex`，
   而 pack 里确有「同一动作各变体姿势数不同」的情况——`Pinched` 是 `1,1,1,2,1,1,1`，
   `RunToThrow` 是 `3,4,4`。拖拽时 `FootX` 变化会切换 `Pinched` 的变体，从 2 姿势切到 1 姿势时
   `poses[1]` 为 `undefined` → `TypeError` → rAF 循环被打断 → 宠物永久卡住。
2. **单个 tick 的异常不再杀死循环**。`loop()` 现在捕获异常、以 `tick-error` 里程碑记录
   （最多每秒一条）并继续下一帧；`poses` 取值也有兜底。装饰性组件不该因为一次异常就永久冻结。

## 历史调参：墙上 / 顶部的停留时间

> 当前应配置 GrabWall／GrabCeiling 等叶节点的 actionHoldLimits；本节旧容器硬上限做法不再适用。

pack 里每个表面都只有一两个「离开」行为，而它们的权重不高：

| 位置 | 该位置可用的行为（权重） | 离开的行为 |
|---|---|---|
| 天花板 | `HoldOntoCeiling` 100、`ClimbAlongCeiling` 100 | `FallFromCeiling` **50**（→ 20%） |
| 墙 | `ClimbHalfwayAlongWall` 100、`ClimbAlongWall` 100、`HoldOntoWall` 100 | `FallFromWall` **50**（→ 14%） |

而 `FallFromCeiling` / `FallFromWall` 都写成 `Offset`（离表面 1px）→ `Stand`（Floor 不成立 →
`border-lost` → `Fall`）——**靠边界机制绕下来**，不是真的"跳"。所以停留时间本身是几何分布的（期望约 5–7 次
抽取），Qt 没有单次上限（`HoldOntoCeiling` 的 `GrabCeiling` 是 500–1500 tick = 20–60 秒），
期望停留会到几分钟。

网页版最初是**永远不下来**，原因是三个叠加的 bug：

1. **哨兵值冲突**：判断「行为从哪条边开始」时用 `null` 同时表示「Offset 先行，无约束」和「没找到」，
   递归处 `if (found)` 把 null 当"继续找"，于是 `FallFromCeiling` 被判成从 **Floor** 开始 →
   在天花板处被「只保留能在此处起手的行为」过滤掉。改用独立哨兵 `FLEXIBLE_BORDER`（`"*"`）。
2. **缺 Qt 的贴墙朝向规则**：`move::tick` 对带 `TargetY` 的动作会强制「在左墙→朝左、在右墙→朝右」，
   而 pack 的墙行为组条件是 `lookRight ? 右墙 : 左墙` → 少这条会让某一侧的攀爬整组不可用。
3. **自己的权重稀释**：`partnerWeights.withPartner: 1200` × 4 个互动行为 = 4800，而天花板候选池只有
   250 → 下来概率被压到 ~1%，且互动行为在墙上/顶部会瞬间失败、白抽一轮。

现在加了**「能不能在此处起手」的池过滤**（Qt 没有这个过滤，这正是它反复抽到跑不了的行为、进而在
顶部 `Fall`/`GrabWall` 死循环的原因）：只保留「起始边界 = 当前所在边界」「无边界要求」和
「Offset 先行（可在此处起手）」的行为。实测：右墙 `FallFromWall` 恢复正常出现（3 次停留里 2 次），
天花板池变为 `HoldOntoCeiling=100 ClimbAlongCeiling=100 FallFromCeiling=50`（下来概率 20%）。

如果仍嫌待得久，这是**配置能直接调的**：

```json
"behaviorWeights": { "FallFromCeiling": 300, "FallFromWall": 300, "HoldOntoCeiling": 60, "HoldOntoWall": 60 }
```

把「下来」的权重抬上去、把「挂住」的压下来即可（例如上面这组把天花板下来的概率提到 ~65%）。

## 宠物大小（`scale`）与"虚拟单位"

```json
"defaults": { "scale": 1.25 }
```

`scale` 是**绘制大小倍率**（1 = pack 原生 128px）。它之所以能"完整改好"，是因为采用了 libshijima
`environment::set_scale` 的思路：**引擎内部所有坐标都是"虚拟单位"，1 虚拟单位 = 1 贴图像素**，
只在三个边界换算：

| 边界 | 换算 |
|---|---|
| 渲染（虚拟 → 屏幕） | 根节点 `translate(x·S, y·S)`；精灵 `translate(-flip·ax·S, -ay·S) scaleX(flip·S) scaleY(S)`，`transform-origin: 0 0` |
| 指针输入（屏幕 → 虚拟） | 客户端坐标 ÷ S；此时贴图的 `ImageAnchor`、128px 宽度**就是**虚拟几何，所以热点局部坐标与大小无关 |
| 观测日志（虚拟 → 屏幕） | `emit()` / `snapshot()` / `position()` 输出页面像素，日志与宿主代码看到的一律是页面像素 |

这样做的收益：pack 里写死的像素常量——`workArea.top+64`、`width-128`、`RunWithIe` 的 `±400`、
Pose 的 `Velocity`（如 `-8,0`）、`Offset Y=1`、热点 `Origin/Size`——在任何大小下都**语义不变**，
不需要改 pack 一个字节；而且速度按虚拟单位走，**相对运动手感与节奏指标不变**（大宠物每帧覆盖更多像素）。

哪些仍是**页面像素**（与宠物大小无关，只是边界换算）：

- `zone`（活动矩形）、`spawn.x` / `spawn.topOffset` / `spawn.staggerPx`、`maxTravelPx`、`scanDistancePx`
- 百分比与关键字（`"40%"`、`left`/`right`/`center`）相对**视口**，与大小无关

素材限制：源图最长边 128px（个别 175），所以 **1.25 尚可、1.5 起明显发虚**，缩小反而更锐利；
想让宠物"又大又清晰"必须换高分辨率素材，这不是配置能解决的。

实测（同一配置，仅改 `scale`）：

| 检查 | S=1 | S=1.25 |
|---|---|---|
| 生成位置（`x:"center"`） | 558.5 px | **558.5 px**（百分比相对视口，屏幕位置不变） |
| 点击精灵中心的局部坐标 | `local=64,63` | **`local=64,63`**（与大小无关 → 换算正确） |
| 天花板落地链路 | `land ceiling → GrabCeiling` | 同样成立（`Offset Y=1`、容差 `<1` 都在虚拟单位里） |
| 回归 | — | `tick-error`/`position-jump`/`init-limit` 全 0 |

## 引擎强制、配置管不到的行为

- `Fall` / `Dragged` / `Thrown`：掉落、拖拽、抛掷由引擎设置，`allowBehaviors` / `behaviorWeights`
  管不到，`maxBehaviorTicks` 也不会打断它们；
- IE（`activeIE`）相关行为在网页版不可达（没有 IE 实体），相关条件恒为假；
- `SplitIntoTwo` / `Gymbag`（Breed）未实现；
- 互动行为里，Eviling 的 `RunAffordance2` 指向的 `IHurlYou` 在 Eviling 的 `behaviors.xml` 里**没有定义**
  （pack 本身的缺陷，与 Qt 行为一致）：此时 `setBehavior` 会优雅回退到 `StandUp`。
## 后续封装建议

- 设置界面可直接读写 `AnimationConfig.toJSON()` / `optionsFor(mascot)` / `details(mascot)`，字段与文件一一对应；
- 想“预览而不落地”，先用 `__mascotConfig.set()` 试，满意后再写回文件；
- 需要更细的粒度（例如逐 pose 的帧时长、按时间段切换风格）时，扩展 `MascotAnimationOptions`
  并在 `MascotEngine` 的 `advanceActionTree()` / `scaledTicks()` / `onBehaviorEnd()` 里消费新字段即可。
