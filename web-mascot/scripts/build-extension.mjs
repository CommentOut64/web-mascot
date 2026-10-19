import { build } from "vite";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const pkgPath = path.resolve(projectRoot, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
const version = pkg.version;

const distExtDir = path.resolve(projectRoot, "dist-extension");
const releaseDir = path.resolve(projectRoot, "release");
const distMascotPack = path.resolve(projectRoot, "dist/mascot_pack");
const distAnimConfig = path.resolve(projectRoot, "dist/animation.config.json");

console.log(`\n======================================================`);
console.log(`[Web Mascot] 开始全自动构建浏览器扩展 (Chrome / Edge) v${version}`);
console.log(`======================================================\n`);

// 1. 确保基础依赖产物已就绪
if (!fs.existsSync(distMascotPack) || !fs.existsSync(distAnimConfig)) {
  console.log(">> 检测到 dist 基础产物缺失，正在自动运行 npm run build:lib ...");
  execSync("npm run build:lib", { cwd: projectRoot, stdio: "inherit" });
}

// 2. 清理并初始化目标目录
if (fs.existsSync(distExtDir)) {
  if (path.dirname(distExtDir) !== projectRoot) throw new Error("Extension output must stay in project root");
  fs.rmSync(distExtDir, { recursive: true, force: true });
}
fs.mkdirSync(distExtDir, { recursive: true });

if (!fs.existsSync(releaseDir)) {
  fs.mkdirSync(releaseDir, { recursive: true });
}

// 3. 构建 Content Script (独立 IIFE 打包，无外部依赖)
console.log(">> 正在构建 Content Script (content.js) ...");
await build({
  configFile: false,
  root: projectRoot,
  build: {
    rollupOptions: {
      input: {
        content: path.resolve(projectRoot, "extension/src/content.ts")
      },
      output: {
        entryFileNames: "[name].js",
        format: "iife"
      }
    },
    outDir: distExtDir,
    emptyOutDir: false,
    sourcemap: false,
    minify: true,
  },
});

console.log(">> 正在构建 Background Service Worker (background.js) ...");
await build({
  configFile: false,
  root: projectRoot,
  build: {
    rollupOptions: {
      input: {
        background: path.resolve(projectRoot, "extension/src/background.ts")
      },
      output: {
        entryFileNames: "[name].js",
        format: "iife"
      }
    },
    outDir: distExtDir,
    emptyOutDir: false,
    sourcemap: false,
    minify: true,
  },
});

// 4. 构建 Popup 控制面板
console.log(">> 正在构建 Popup 面板 (popup.html / popup.js / popup.css) ...");
await build({
  configFile: false,
  root: path.resolve(projectRoot, "extension"),
  base: "./",
  build: {
    rollupOptions: {
      input: {
        popup: path.resolve(projectRoot, "extension/popup.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name].[ext]",
      },
    },
    outDir: distExtDir,
    emptyOutDir: false,
    sourcemap: false,
    minify: true,
  },
});

// 5. 注入版本号并复制 manifest.json
console.log(`>> 同步版本号 v${version} 到 manifest.json ...`);
const manifestSource = JSON.parse(
  fs.readFileSync(path.resolve(projectRoot, "extension/manifest.json"), "utf-8")
);
const cleanVersion = version.split("-")[0];
manifestSource.version = cleanVersion;
if (version !== cleanVersion) {
  manifestSource.version_name = version;
} else {
  delete manifestSource.version_name;
}
fs.writeFileSync(
  path.resolve(distExtDir, "manifest.json"),
  JSON.stringify(manifestSource, null, 2),
  "utf-8"
);

// 6. 复制静态资产 (mascot_pack, animation.config.json, icons)
console.log(">> 复制桌宠素材包与配置文件 ...");
fs.cpSync(distMascotPack, path.resolve(distExtDir, "mascot_pack"), { recursive: true });
fs.copyFileSync(distAnimConfig, path.resolve(distExtDir, "animation.config.json"));

// 确保图标符合 Chrome Web Store 与 Edge Add-ons 规范 (16/32/48/128 严格尺寸匹配)
const icon32Path = path.resolve(projectRoot, "extension/icons/icon-32.png");
if (!fs.existsSync(icon32Path) && process.platform === "win32") {
  console.log(">> 正在生成符合商店规范的多尺寸图标 (16/32/48/128)...");
  execSync(`powershell -ExecutionPolicy Bypass -File "${path.resolve(__dirname, "resize-icons.ps1")}"`, { stdio: "inherit" });
}
fs.cpSync(path.resolve(projectRoot, "extension/icons"), path.resolve(distExtDir, "icons"), { recursive: true });

// 7. 自动生成符合 Chrome Web Store 与 Edge Add-ons 规范的标准 ZIP 压缩包
// 确保 manifest.json 位于 ZIP 顶级根目录，且条目无多余 ./ 路径前缀
const zipName = `web-mascot-extension-v${version}.zip`;
const zipPath = path.resolve(releaseDir, zipName);
if (fs.existsSync(zipPath)) {
  fs.rmSync(zipPath);
}

console.log(`>> 正在生成符合商店规范的分发压缩包: ${zipName} ...`);
if (process.platform === "win32") {
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${distExtDir}/*' -DestinationPath '${zipPath}' -Force"`,
    { stdio: "inherit" }
  );
} else {
  try {
    execSync(`(cd "${distExtDir}" && zip -r "${zipPath}" ./*)`, { stdio: "inherit" });
  } catch {
    execSync(`tar -a -c -f "${zipPath}" -C "${distExtDir}" .`, { stdio: "inherit" });
  }
}

const stats = fs.statSync(zipPath);
const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);

console.log(`\n======================================================`);
console.log(`[成功] 浏览器扩展构建与打包完成！`);
console.log(`- 解压即用目录: ${distExtDir}`);
console.log(`- 发布离线 ZIP: ${zipPath} (${sizeMb} MB)`);
console.log(`\n【Edge / Chrome 安装使用指南】:`);
console.log(` 1. 打开 edge://extensions 或 chrome://extensions`);
console.log(` 2. 开启页面右上角的「开发人员模式 (Developer mode)」`);
console.log(` 3. 点击「加载解压缩的扩展 / 加载已解压的扩展程序」`);
console.log(` 4. 选择上方生成的 dist-extension 目录即可！`);
console.log(`======================================================\n`);
