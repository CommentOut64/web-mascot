# web-mascot

[English](README_en.md) | **简体中文**

在任意网页里养桌宠 — 可在浏览器中运行的 Shimeji 格式桌宠引擎，NeurolingsCE-Qt 的网页移植版本。

## 📖 项目情况

本项目是一个将桌面级宠物引擎移植到 Web 端的开源项目。它允许你在任何网页中嵌入遵循 [Shimeji](http://www.group-finity.com/Shimeji/) 格式规范的交互式桌面宠物。无需复杂的配置或侵入式的集成，即可让网页焕发生机。

**注意：** 引擎代码本身遵循 GPL-3.0-or-later 开源协议，但内置的两只宠物包（Neuron 与 Eviling）受 `CC-BY-NC-SA-4.0` 协议保护，**严禁用于任何商业项目**。商业使用必须替换为你自己的宠物资产，详见子项目许可说明。

## ✨ 功能特点

- **轻量接入**：把精灵拷进站点静态目录、一行 `configure()` 即可；未打包的裸 ESM 环境下连这一步都可省（模块会自动推导资产基址）。
- **框架无关**：核心包以原生 JavaScript/TypeScript 编写，无运行时依赖（不依赖 Vue/React），可无缝嵌入任何 Web 项目中。
- **完整的物理及交互模拟**：支持下落、水平/垂直阻力、拖拽挣扎等物理特性；完美还原原版桌面宠物的抓取与热区交互体验。
- **格式驱动设计**：原生解析 Shimeji 的 XML (`actions.xml`, `behaviors.xml`) 行为链以及帧动画规范。
- **丰富的调试支持**：包含独立的开发者工具入口，提供生命周期探测、宠物运动轨迹及行为树变更的观测记录功能。

## 🛠 技术栈

- **核心语言**：TypeScript
- **构建工具**：Vite, vue-tsc (仅作为构建流程工具)
- **产物标准**：纯 ESM 模块

---

## 🚀 使用指南 (快速接入)

以下指南介绍了如何从 npm 安装包到在你的网页中实现最基础的宠物接入。**此使用指南与 npm 包内部指南严格对齐。**

### 1. 安装

```bash
npm install web-mascot
```

### 2. 30 秒上手

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
*提示：想换成另一只内置宠物，只需将 `pack` 参数改为 `"Eviling"`。如果要同时挂载两只（或多只）宠物，只需并发或连续调用（全局资源配置仅需一次）：*

```js
// 并发加载多只宠物
const [neuron, eviling] = await Promise.all([
  createMascot({ container: document.body, pack: "Neuron" }),
  createMascot({ container: document.body, pack: "Eviling" })
]);
// 它们底层共享 BroadcastManager，在发生如“打招呼”等行为时会自动产生双宠互动
```

> 注：模块通过 `import.meta.url` 推导出的资源基址（`PACK_BASE_URL`）只在**未打包、且包目录被原样服务**的环境下有效（裸 ESM，或原样镜像 `dist/` 的 CDN）。经打包器预构建后，推导值会指向构建产物路径（如 `node_modules/.vite/deps/mascot_pack`、`/_astro/mascot_pack`），所有 pack 请求都会 404，因此必须如上文显式配置。
>
> 另外，`DEFAULT_PACK_BASE_URL`（`"/mascot_pack"`）只在推导**彻底失败**时才兜底；打包环境里推导是「成功但错误」，兜底不会生效——所以「把精灵放到 `/mascot_pack`」这件事本身还不够，必须显式 `configure()`。

### 3. 自定义配置与调试 (按需高级接入)

如果你想使用自己的资源服务器地址，或需要开启引擎状态调试日志，可以按需使用 `configure` 和 `devtools` 导出：

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

📚 **详细 API 说明**
以上仅为最简可用核心 API 接入。关于 `MascotEngine` 状态快照、事件监听器以及 `RuntimeOptions` 的完整文档，请开发者自行查阅 [API 详细文档](web-mascot/docs/API.md)。

---

## 🙏 致谢 (Acknowledgements)

本项目是对以下优秀开源项目的 Web 端移植与延续，特此致谢：
- [NeurolingsCE-Qt](https://github.com/qingchenyouforcc/NeurolingsCE-Qt) (by qingchenyou)
- [Shijima-Qt](https://github.com/pixelomer/Shijima-Qt) (by pixelomer)
- [libshijima](https://github.com/pixelomer/libshijima) (by pixelomer)

感谢原版 [Shimeji](http://www.group-finity.com/Shimeji/) (Group Finity) 创造了这一经典的桌面宠物互动模式。
