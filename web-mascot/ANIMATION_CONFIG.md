# 动画自定义配置（Animation configuration）

引擎**自带一套默认预设**，宿主什么都不做就是它：普通静止约 8 秒即被推动（偏活跃），
但晃腿这类长静止序列允许完整播完再回主池。这份预设的**唯一事实源**是库源码里的
`src/core/animationPreset.ts`；构建时同一份数据会生成 `dist/animation.config.json`
（也就是 `web-mascot/animation.config.json`），供想要一份文件来改的宿主取用 —— 两者不会漂移。

生效的配置按下面的优先级叠加，后写的覆盖先写的（**逐字段**，对象型字段按 key 合并）：

```
内置预设  →  文件 / 运行时下发的 defaults  →  reducedMotion（系统要求减少动效时）  →  mascots.<宠物名>
```

配置文件默认从 `/animation.config.json` 读取（也可以 `?config=/my.config.json` 指向别的文件）。
一份配置同时管五件事：**出现哪些行为、各行为多大概率、各动作持续多久、多久换一次行为、
宠物出现在哪里、以及活动区域**。

## 生效方式

| 方式 | 用法 |
|---|---|
| 改文件 | 把 `animation.config.json` 放进站点静态根（或 `?config=` 指定）→ 刷新页面，或控制台 `__mascotConfig.reload()` |
| 改内置预设 | 编辑 `src/core/animationPreset.ts` 后重新构建 —— 它同时决定运行时默认值与随包附带的 `dist/animation.config.json` |
| 换文件 | URL 加 `?config=/my.config.json` |
| 运行时下发 | `__mascotConfig.set({ defaults: {...}, mascots: {...} })` —— 立即作用于**已在运行**的宠物 |
| 读回生效值 | `__mascotConfig.get()`（文件形状）/ `__mascotConfig.get("Neuron")`（该宠物的解析结果） |
| 看广播状态 | `__mascotConfig.broadcasts()` —— 当前存活的可互动告示（`{CuddleNeuro: 1, ...}`） |
| 代码内嵌 | `MascotEngine.setAnimationConfig(obj)` / `loadAnimationConfig(url)` / `reloadAnimationConfig(url)` |

文件缺失或格式错误时，配置退回**引擎内置预设**（若文件里写了 `ignoreBuiltin: true`，则退回 pack 原生行为），不会影响宠物运行。引擎每页会探测一次默认路径，所以没有这个文件的站点会看到**一次预期内的 404** —— 不影响运行，也不产生控制台噪音。

每次 `Spawn` 时，生效配置的摘要会写进观测日志（`k:"spawn"` 的 `config` 字段 + `k:"config"` 明细行），便于事后核对；摘要里的 `source=…` 会带 `+builtin` / `no-builtin`，一眼能看出内置预设是否生效。

### 三档用法（最容易混的地方）

| 想要 | 怎么写 |
|---|---|
| 引擎默认（内置的活跃预设） | 什么都不做 |
| 在内置预设之上微调 | 文件里只写要改的字段：`{"defaults":{"forcedSwitchTicks":400}}` |
| 纯正原版（pack 原生：无 pacer、无权重覆盖、无长序列豁免） | `{"version":1,"ignoreBuiltin":true}` —— **文件里只写这一项**；或代码里 `configure({ ignoreBuiltin: true })` / `setAnimationConfig({ ignoreBuiltin: true })` |

`ignoreBuiltin` 关掉的是**内置预设这一层**，不是"整个配置"：它与 `defaults` 正交，所以
`{"ignoreBuiltin":true,"defaults":{"forcedSwitchTicks":300}}` 得到的是「pack 原生 + 300 tick 的 pacer」。

## 字段

```jsonc
{
  "version": 1,
  "ignoreBuiltin": false, // true = 丢弃内置预设这一层（与下面的 defaults 正交，不会禁用本文件）
  "respectReducedMotion": true,
  "defaults": { /* 对所有宠物生效 */ },
  "mascots": { "Neuron": { /* 覆盖 defaults */ }, "Eviling": { } },
  "reducedMotion": { /* 系统要求「减少动态效果」时叠加到 defaults 上 */ }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `allowBehaviors` | `string[]` | **只允许**出现这些行为（缺省 = 全部允许）。名字取自 `behaviors.xml` 的 `<Behavior Name>` |
| `denyBehaviors` | `string[]` | **永不出现**这些行为，优先级高于 `allowBehaviors` |
| `behaviorWeights` | `{ [行为名]: number }` | 行为被抽中的权重，覆盖 XML 的 `Frequency`。`0` = 禁用；给 XML 里 `Frequency="0"` 的行为赋正值可**打开**它 |
| `actionDurations` | `{ [动作名]: number \| [min,max] }` | 动作持续 tick 数（1 tick = 40 ms，25 tick = 1 s）。名字取自 `actions.xml` 的 `<Action Name>` |
| `durationScale` | `number` | 全局时长倍率（0.05–20），只作用于 XML 自带的 `Duration`（Stay 类动作） |
| `scale` | `number` | **宠物绘制大小**（0.2–4，1 = pack 原生 128px）。引擎内部按「1 虚拟单位 = 1 贴图像素」工作，见下文 |
| `forcedSwitchTicks` | `number` | **节奏调节器**：原地不动超过 N tick，下一次行为必须挑一个**会移动**的；单个姿势静止超过 N tick 也会被换掉。`0`/缺省 = 不启用 |
| `maxBehaviorTicks` | `number` | **硬上限**：单个行为最长 N tick，超时即换（掉落/拖拽除外）。用于刹住 40 s 级的爬墙与爬行 |
| `pacerExemptBehaviors` | `string[]` | **节奏调节器的例外名单**：列出的行为不被 `forcedSwitchTicks` 打断，让长静止动画播完。注意「静止」按位置判定，速度为零的长序列（如 `SitWhileDanglingLegs`，约 400 tick）默认会被节奏调节器拦腰截断 |
| `exitToPoolBehaviors` | `string[]` | **绕开 pack 闭链**：列出的行为结束时回到**全局抽签池**，而不是走 `<NextBehaviorList>`。内置 pack 的 `SitAndFaceMouse` 用 `Add="false"` 只能重选自己或 `SitWhileDanglingLegs`，是闭链——宠物坐下后就再也出不来 |
| `interactionCooldownTicks` | `number` | **刚互动完的冷却**：这段时间内"需要伙伴的行为"从候选池里拿掉。缺省 `0`。没有它，两只抱完还贴在一起，下一次抽取立刻又连上（实测间隔 **0.1 秒**），会连续抱个不停 |
| `maxTravelPx` | `number` | 水平「游走型」目标的最大距离（px）。指向边界的目标（走过去爬墙那种）不受影响，否则会破坏后续动作 |
| `partnerWeights` | `{ alone, withPartner, reachable }` | **需要伙伴的行为**（抱/扔/等抱/注意掉落）专用权重：单只时用 `alone`，场上有伙伴时 `withPartner`，对方同高度且在扫描半径内时 `reachable`（见下文） |
| `scanDistancePx` | `number` | 「找伙伴」的搜索半径（px），缺省 256（libshijima 为桌面选的）。网页更宽，调大才能让两只宠物互相发现 |
| `zone` | `{ left, right, top, bottom }` | 宠物活动矩形；它会成为宠物的**工作区**，地板/墙/天花板、以及所有边界夹紧都跟着变 |
| `spawn` | `{ vertical, x, topOffset, staggerPx }` | 启动位置与多只宠物之间的错开 |
| `respectReducedMotion` | `boolean` | 缺省 `true`：跟随系统「减少动态效果」偏好，并监听其变化 |
| `reducedMotion` | `MascotAnimationOptions` | 上述偏好开启时，叠加在 `defaults` 之上的一组选项（内容由宿主决定） |

### 位置取值（`zone` 与 `spawn.x` 通用）

像素数字 `240`；百分比字符串 `"40%"`；或关键字 `left` / `right` / `top` / `bottom` / `center`。

### 合并优先级

`defaults` → （若系统要求减少动态）`reducedMotion` → `mascots.<名字>`。

- 对象型字段（`behaviorWeights`、`actionDurations`、`zone`、`spawn`、`partnerWeights`）**按 key 合并**；
- 数组与数值（`allowBehaviors`、`denyBehaviors`、`durationScale`、`forcedSwitchTicks`、
  `pacerExemptBehaviors`、`exitToPoolBehaviors`、`maxBehaviorTicks`、`maxTravelPx`、`scanDistancePx`）
  **整体替换**——所以 `reducedMotion` 里写 `denyBehaviors` 时要自己把 `defaults` 的项一并列出。

### 取值范围与校验

- `durationScale` 限制在 `0.05 ~ 20`；tick 数限制在 `1 ~ 1000000`；`scanDistancePx` 限制在 `16 ~ 4096`；
  非数字/负数会被忽略（该字段退回默认，其余字段照常生效）；
- `[min,max]` 顺序写反会自动交换；`min == max` 会存成单个数字；
- 未知字段（如 `_readme`、`_example`）被忽略；未知行为/动作名保留但不匹配（方便先写配置后加动作）。

## 两个上限的分工（重要）

它们**语义不同**，别再当成同一个：

- `forcedSwitchTicks`（节奏调节器）——解决「网页看上去是死的」。它只在宠物**确实原地不动**时生效；
  它触发时，下一次行为会从**会移动的行为**里挑（`canTravel` 判定动作树里有没有 `Move`），
  而不是每 tick 硬切——硬切会造成行为抖动、还会让 `Stand → 扫描` 这类序列永远走不完。
- `maxBehaviorTicks`（硬上限）——解决「一个行为占住宠物太久」。它无视是否在移动，到点就换；
  但**掉落（`Fall`）与拖拽（`Dragged`）永远不被它打断**。
- `pacerExemptBehaviors` ——节奏调节器的**例外**。它是必须的，因为「静止」按位置变化判定：
  速度为零的长序列（`SitWhileDanglingLegs` 约 400 tick）也满足"静止"，于是会被比它短的调节器
  拦腰截断，永远播不完。**例外只针对 `forcedSwitchTicks`**，`maxBehaviorTicks` 仍然生效，
  所以豁免的行为不会无限持续。
- `exitToPoolBehaviors` ——与上一条**配套**。pack 用 `<NextBehaviorList Add="false">` 串接行为，
  其中一部分是闭链：内置 pack 的 `SitAndFaceMouse` 只能重选自己或 `SitWhileDanglingLegs`。
  若只加例外不加这一条，宠物会在这个环里无限坐下去——「跳调节器」反而变成了「再也不动」。
  加了它，动画播完后回全局池重新抽签。

> 注意：`pacerExemptBehaviors` 与 `exitToPoolBehaviors` 是后加的字段；旧版本引擎会忽略它们，
> 此时给长静止动画设 `forcedSwitchTicks` 会把它截断。

实测：默认档 `forcedSwitchTicks: 250` + `maxBehaviorTicks: 375` 会把最长静止从 **96 s 压到 ~20 s**，
位移时间占比 28% → **30–43%**，每分钟真实位移事件 1.8 → **4–6** 次。

## 互动（broadcast）与 `partnerWeights`

两只宠物会互相发现并互动，链路是：**一方做着 `Affordance` 动作 → 广播告示 → 另一方 `ScanMove`
在 `scanDistancePx` 内找到 → 跑过去 → 到达 → 双方同时切到互动行为**（例如一方 `IHugYou`、
另一方 `IAmHugged`）。观察日志里对应 `broadcast-start` / `broadcast-scan` / `broadcast-connect` /
`interaction-arrived` / `interaction-client` / `interaction-server` 事件。

这类行为在 pack 里权重高达 1000–3000（那是为「桌面同时好几只」设计的），而且**两家 pack 命名不同**
（Neuron 叫 `HugEvil`，Eviling 叫 `HugNeuro`），所以**不要按名字去配**——引擎是按动作类型识别的，
`partnerWeights.alone` / `.withPartner` / `.reachable` 直接给这一类行为赋值：

| 场景 | 效果 |
|---|---|
| 单只（`alone`） | 它们多数是空转（扫描必然落空），所以要低。默认 40，约占抽取的 8% |
| 有伙伴（`withPartner`） | 要让互动真的发生，需要足够的轮转速度。默认 1200 + `scanDistancePx: 520` |
| **另一只就在旁边（`reachable`）** | 对方**同高度**且**在 `scanDistancePx` 内**——此刻发起扫描就能连上——时用这一档。默认 1800 |

`reachable` 是"条件性提高"：只在**能成事的时候**加码，所以单只、或一只在墙上另一只在地板时都不受影响。
它**不会**让拥抱变成必然：连接仍然取决于「扫描发起的那一帧，对方是否正好在广播」，
实测每次扫描的连接率是 **25–50%**——即"更容易，但不是每次"。

若确实要对**某个具体行为**单独设权重，`behaviorWeights` 里的同名项优先级更高。

## 为什么两只宠物很难抱上（实测）

把 `reachable` 加进去之后先做了一次实测，结果是 **6 分钟里 0 次拥抱** ✗。原因不在权重，
而在两个前置条件几乎不成立，加上一个引擎 bug：

### 1. 两只很少处在同一高度（`|Δy| ≤ 1` 是硬门槛）

连接判定里对方必须**在同一条边上**（跟 Qt 一样）。实测两只从地板出生，却只有 **7%** 的时间同高度：

| 宠物 | 地板 | 墙上 | 天花板 |
|---|---|---|---|
| Neuron | 32% | **62.5%** | 0.6% |
| Eviling | 30% | **51.5%** | 15.3% |

墙上池是 `ClimbHalfwayAlongWall 100 / ClimbAlongWall 100 / HoldOntoWall 100 / FallFromWall 50`，
"下来"只占 14% → 一次上墙期望待 7 次抽取 ≈ 110 s。默认档现在改成：

```json
"behaviorWeights": {
  "FallFromWall": 400, "ClimbHalfwayAlongWall": 60, "ClimbAlongWall": 60, "HoldOntoWall": 60,
  "FallFromCeiling": 300, "ClimbAlongCeiling": 60, "HoldOntoCeiling": 60,
  "GrabWorkAreaBottomLeftWall": 50, "GrabWorkAreaBottomRightWall": 50,
  "RunAndGrabBottomLeftWall": 50, "RunAndGrabBottomRightWall": 50
}
```

下来占 **69%**，单次上墙 ≈ 20 s；同时把"地板 → 上墙"的四个发起者减半。实测效果：

| 指标 | 调优前 | 调优后 |
|---|---|---|
| 两只同高度的时间 | 7% | **66–80%** |
| 满足 `reachable` 的时间 | 7% | **42–61%** |
| 扫描 → 连接 | 0/13 | **28.6% / 50%** |

### 2. 引擎 bug：扫描动作走不到伙伴身边（已修）

`RunAffordance` 在 pack 里是 `Type="Embedded" Class="...ScanMove"`——它的目标由引擎从**互动句柄**
提供，pack 里没有 `TargetX`。而"动作跟随动画结束"的规则用的是 `!hasTarget(frame)`，
于是 ScanMove 被判成"没有目标、动画播完就结束"，在它那段 **0.6 秒**的跑步动画播完后就把行为弹栈 ✗。

后果：**只有当两只已经近到"一个动画周期内能走完"（约 120px）时拥抱才可能完成**。
实测连接距离 223 / 254 / 404px 全部在 0.63 s 后夭折。

修复：连接到对话句柄的 ScanMove 不算"随动画结束"（它只在自己到达、或互动消失时结束）。
验证（把互动权重拉到 20000 制造远距离连接）：

```
t= 17.3  Eviling  interaction-arrived  partner=(279.3,843.0)  behavior=IHugYou
t=116.7  Neuron   interaction-arrived  partner=(935.0,843.0)  behavior=IHurlYou
```

走到 **935px** 处才握手——修复前不可能。修好后的实测速率：`reachable` 期间 **0.80 次/分钟**
（约每 75 秒一次拥抱/互扔），每次扫描的连接率仍是 25–50%。

### 3. 引擎 bug：互动行为被排除在"强制移动"池外（已修）

pacer（`forcedSwitchTicks`）在宠物静止够久后会**只从"能移动的行为"里抽**，否则它会一直坐着。
判定用的是"动作树里有 `Type="Move"`"——但 `RunAffordance` 在 pack 里是
`Type="Embedded" Class="...ScanMove"`，于是在 libshijima 里本身就是 move 子类的扫描动作被判成
"不会移动" ✗，`HugEvil` / `HurlEvil` 永远进不了那个池子。

实测池探针（临时加、已删）：

```
on=Floor n=22 total=7110 partnerShare=78.8%
partner=[NoticeFallingTutel=200 HugEvil=1800 HurlEvil=1800 AskForHugs=1800]
on=Floor n=11 total=830  partnerShare=0.0%     ← 强制移动时的池子：互动全被排除
```

修复：ScanMove 在**对方可达（`partnerReachable()`）时**算作会移动的行为——它确实会跑过去；
对方不可达时不算（那时它会在第一个 tick 就退场，选了也不会动）。

### 4. `NoticeFallingTutel` 是"永远失败"的扫描器

它扫的是 `SayItBack`，而本 pack 里没有 Tuteling，没人会广播这个告示——实测 **0/35 次连接** ✗，
却占了 25% 的互动权重。默认档把它压到 `200`（保留行为、不再白占预算）。若将来引入 Tuteling，
把它调回或删掉即可。

### 修完之后的实测（正式默认档，5.1 分钟）

| 指标 | 第一次实测 | 修完之后 |
|---|---|---|
| 两只同高度的时间 | 7% | **68%** |
| 满足 `reachable` 的时间 | 7% | **56%** |
| 扫描 → 连接 | 0/13 | **4/33 = 18%**（"更容易，但不会必定"） |
| 完成的互动 | **0** | **3 次**（2 次 `IHugYou` + 1 次 `IHurlYou`） |
| 握手距离 | — | **740px / 260px / 203px**（修复前最多约 120px） |
| 速率 | ~0 | 整体 **0.58 次/分钟**；`reachable` 期间 **1.07 次/分钟**（约每 56 秒一次） |

### 5. 抱完立刻又抱（已修：`interactionCooldownTicks`）

抱/互扔结束时两只还贴在一起，而地板池里 79% 是互动行为 → 下一次抽取立刻又连上。
实测（2407×1156 的窗口，一次会话）：

```
互动 21 次；间隔 = [0.1, 121.9, 180.0, 0.1, 12.0, 35.0, 51.4, 0.1, 5.4, 0.1, 11.9, 0.1]
                    ↑ 一串 0.1 秒的连抱
```

修法：**互动存活期间持续刷新冷却计时**，所以它从互动真正结束那一刻开始算；
冷却期内"需要伙伴的行为"权重直接为 0（`<NextBehavior>` 那条候选路径也补了 `<= 0` 过滤）。
默认 `500` tick = 20 秒。A/B 实测：

| `interactionCooldownTicks` | 间隔序列 |
|---|---|
| `0` | `[0.1, 17.5, 0.1, 5.0, 0.1, 6.5]` → 3 次连抱 ✗ |
| `500`（默认） | `[44.4]` → **0 次连抱** ✓ |

### 6. 甩飞只是"原地播完"，并没飞起来（已修）

被甩方在 pack 里是这样一串：

```xml
<ActionReference Name="HurledKnockback"/>                          <!-- Animate，单帧 Velocity="50,-50" -->
<ActionReference Name="HurledKnockback2" InitialVX="±50" InitialVY="-48"/>  <!-- Fall，Gravity=2 -->
<ActionReference Name="Falling" InitialVX="±50"/> → HurledBounce（砸地）→ Sprawl（趴地）
```

**起跳那一帧的速度是关键**：它先把宠物抛离地面，后面 `Fall` 的"先判定落地"才不成立。
但引擎里新进入的节点**在同一个 tick 里就被推进**（`poseTick++` 后立刻 "播完" 弹栈），
而本 tick 的 `updatePhysics()` 早已跑完 → 那一帧速度永远不会被应用 ✗：

```
修复前：y 全程 843、x 不动；HurledKnockback2/Falling/HurledBounce 各 1 tick 全跳过
```

修法：给帧记录 `bornTick`，**创建它的那个 tick 不推进它**（libshijima 也是"先 tick 当前动作、
再前进"）。修复后同一动作链的实测：

```
被甩方：390.9, 843 → 512.8, 723.6 → 965.5, 318.4 → 1117, 221.7（顶点：升高 621px、水平 726px）→ 835.7 砸地
施力方：415.9, 818 → 465.9, 799.2（自身后坐弹起 44px）
```

顺带修掉一个相关的显示问题：pack 里有些姿势**故意没有 `Image`**（`HurledAction` 是
`<Pose Velocity="0,0" Duration="128"/>`），引擎原先会拼出空 `src` → 整个拥抱过程显示破图 ✗。
现在**无 `Image` 的姿势保留上一帧画面** ✓。实测空贴图记录从 1 条降到 **0 条**。

## 怎么把「活泼」和「Qt 质感」拆开

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

## 示例

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

## 内置默认档的取值理由

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

## 墙上 / 顶部的停留时间（为什么会「不下来」）

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
