import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  importMascotPack,
  registerMascotPack,
  unregisterMascotPack,
  hasMascotPack,
  PackRegistry,
  ShimejiFinder,
  translateShimejiXml,
  normalizeSpriteKey,
} from "../dist/index.js";

// Polyfill URL.createObjectURL/revokeObjectURL in Node environment
if (typeof globalThis.URL.createObjectURL === "undefined") {
  let counter = 0;
  const createdUrls = new Set();
  globalThis.URL.createObjectURL = () => {
    const url = `blob:mock-blob-${++counter}`;
    createdUrls.add(url);
    return url;
  };
  globalThis.URL.revokeObjectURL = (url) => {
    createdUrls.delete(url);
  };
}

const JAPANESE_ZIP_PATH = resolve("..", "test-assets", "japanese-shimeji-ayaka.zip");
const SHIMEJIEE_ZIP_PATH = resolve("..", "test-assets", "shimejiee-pierrot.zip");

test("Real Pack Test 1: Japanese Shimeji ZIP with Japanese XML & 46 frames", async () => {
  assert.ok(existsSync(JAPANESE_ZIP_PATH), `Test asset must exist: ${JAPANESE_ZIP_PATH}`);
  const buf = readFileSync(JAPANESE_ZIP_PATH);

  // 1. Import Japanese pack with explicit name
  const { name, warnings, unregister } = await importMascotPack(new Uint8Array(buf), { name: "Ayaka" });
  assert.equal(name, "Ayaka");
  assert.equal(hasMascotPack("Ayaka"), true);
  assert.ok(Array.isArray(warnings));

  // 2. Inspect registered data
  const packData = PackRegistry.get("Ayaka");
  assert.ok(packData, "Pack data must be retrieved from PackRegistry");

  // Verify XML translation: Japanese tags & attributes converted to English
  assert.ok(!packData.actionsXml.includes("<マスコット"), "Japanese <マスコット> must be translated to <Mascot>");
  assert.ok(packData.actionsXml.includes("<Mascot"), "<Mascot> tag must be present");
  assert.ok(!packData.actionsXml.includes("<動作リスト>"), "<動作リスト> must be translated to <ActionList>");
  assert.ok(packData.actionsXml.includes("<ActionList>"), "<ActionList> must be present");
  assert.ok(packData.actionsXml.includes("<Animation>"), "<Animation> must be present");
  assert.ok(packData.actionsXml.includes("<Pose"), "<Pose> must be present");
  assert.ok(packData.actionsXml.includes('Image="/shime1.png"'), 'Pose Image="/shime1.png" translated');
  assert.ok(packData.actionsXml.includes('ImageAnchor="64,128"'), 'ImageAnchor translated');

  // Verify behaviors.xml
  assert.ok(!packData.behaviorsXml.includes("<行動リスト>"), "<行動リスト> translated to <BehaviorList>");
  assert.ok(packData.behaviorsXml.includes("<BehaviorList>"), "<BehaviorList> must be present");
  assert.ok(packData.behaviorsXml.includes("<NextBehaviorList"), "<NextBehaviorList> translated");

  // Verify sprites extraction: all 46 frames mapped
  assert.ok(packData.sprites.size >= 46, `Expected at least 46 sprites, found ${packData.sprites.size}`);
  for (let i = 1; i <= 46; i++) {
    const key = `shime${i}.png`;
    assert.ok(packData.sprites.has(key), `Sprite ${key} must exist in pack`);
    assert.ok(packData.sprites.get(key).startsWith("blob:"), `Sprite ${key} must be a Blob URL`);
  }

  // 3. Unregister and check cleanup
  const unregSuccess = unregister();
  assert.equal(unregSuccess, true);
  assert.equal(hasMascotPack("Ayaka"), false);
});

test("Real Pack Test 2: Standard Shimeji-ee ZIP with nested folders and UTF-8 BOM", async () => {
  assert.ok(existsSync(SHIMEJIEE_ZIP_PATH), `Test asset must exist: ${SHIMEJIEE_ZIP_PATH}`);
  const buf = readFileSync(SHIMEJIEE_ZIP_PATH);

  // 1. Import Shimeji-ee pack without specifying name; verify auto-inference from img/Shimeji/
  const { name, warnings, unregister } = await importMascotPack(new Uint8Array(buf));
  assert.equal(name, "Shimeji", "Pack name should be inferred from img/Shimeji/");
  assert.equal(hasMascotPack("Shimeji"), true);
  assert.ok(Array.isArray(warnings));

  // 2. Inspect pack data
  const packData = PackRegistry.get("Shimeji");
  assert.ok(packData, "Pack data must exist");

  // Verify BOM stripped
  assert.ok(!packData.actionsXml.startsWith("\uFEFF"), "BOM must be stripped from actions.xml");
  assert.ok(!packData.behaviorsXml.startsWith("\uFEFF"), "BOM must be stripped from behaviors.xml");

  // Verify standard Shimeji-ee action & behavior definitions
  assert.ok(packData.actionsXml.includes('Name="Look"'), 'Standard action "Look" present');
  assert.ok(packData.behaviorsXml.includes('Name="ChaseMouse"'), 'Standard behavior "ChaseMouse" present');

  // Verify deep nested images under shimejiee/img/Shimeji/ are mapped
  for (let i = 1; i <= 46; i++) {
    const key = `shime${i}.png`;
    assert.ok(packData.sprites.has(key), `Sprite ${key} must be normalized and accessible`);
  }

  // 3. Unregister
  unregister();
  assert.equal(hasMascotPack("Shimeji"), false);
});

test("Real Pack Test 3: URL fetch import simulation with real pack", async () => {
  // Mock global fetch to return the Japanese pack buffer
  const originalFetch = globalThis.fetch;
  const buf = readFileSync(JAPANESE_ZIP_PATH);

  globalThis.fetch = async (url) => {
    if (url === "https://example.com/ayaka-pack.zip") {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      };
    }
    return originalFetch(url);
  };

  try {
    const { name, unregister } = await importMascotPack("https://example.com/ayaka-pack.zip");
    assert.ok(name);
    assert.equal(hasMascotPack(name), true);
    unregister();
    assert.equal(hasMascotPack(name), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Real Pack Test 4: Shimeji-ee unsupported desktop action detection", () => {
  const sampleEeActionXml = `
  <ActionList>
    <Action Name="ThrowIE" Type="Animate" Class="com.group_finity.mascot.action.ThrowIE" />
    <Action Name="Breed" Type="Animate" Class="com.group_finity.mascot.action.Breed" />
    <Action Name="WalkWithIE" Type="Move" Class="com.group_finity.mascot.action.WalkWithIE" />
  </ActionList>
  `;

  // Verify actions are parsed without syntax errors
  const translated = translateShimejiXml(sampleEeActionXml);
  assert.ok(translated.includes("ThrowIE"));
  assert.ok(translated.includes("Breed"));
  assert.ok(translated.includes("WalkWithIE"));
});

test("Real Pack Test 5: MascotEngine physics execution, gravity fall, and interaction with imported packs", async () => {
  const { build } = await import("esbuild");
  const vm = await import("node:vm");

  // Bundle src/index.ts for headless execution
  const bundleResult = await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  });

  class MockElement {
    style = {};
    attributes = new Map();
    complete = true;
    naturalWidth = 128;
    naturalHeight = 128;
    addEventListener() {}
    removeEventListener() {}
    appendChild(child) { child.parentNode = this; }
    removeChild(child) { child.parentNode = null; }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    setAttribute(key, val) { this.attributes.set(key, val); }
    removeAttribute(key) { this.attributes.delete(key); }
    set src(value) { this.attributes.set("src", value); }
    get src() { return this.getAttribute("src"); }
    async decode() { return Promise.resolve(); }
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 1000, bottom: 800, width: 1000, height: 800 };
    }
  }

  class StackDOMParser {
    parseFromString(xmlText) {
      const clean = xmlText.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[^>]*\?>/g, "").trim();
      const tagRegex = /<([a-zA-Z0-9_\-:]+)((?:\s+[^>]*)?)\s*(\/?>)|<\/([a-zA-Z0-9_\-:]+)\s*>/g;
      let root = null;
      const stack = [];
      let match;

      while ((match = tagRegex.exec(clean)) !== null) {
        const isCloseTag = !!match[4];
        if (isCloseTag) {
          const closeTagName = match[4];
          if (stack.length > 0 && (stack[stack.length - 1].tagName === closeTagName || stack[stack.length - 1].localName === closeTagName)) {
            stack.pop();
          }
          continue;
        }

        const tagName = match[1];
        let attrStr = match[2] || "";
        const isSelfClosing = match[3] === "/>" || attrStr.trimEnd().endsWith("/");
        if (attrStr.trimEnd().endsWith("/")) {
          attrStr = attrStr.trimEnd().slice(0, -1);
        }
        const localName = tagName.includes(":") ? tagName.split(":")[1] : tagName;

        const map = new Map();
        const items = [];
        const re = /([a-zA-Z0-9_\-:]+)=["']([^"']*)["']/g;
        let m;
        while ((m = re.exec(attrStr)) !== null) {
          map.set(m[1], m[2]);
          items.push({ name: m[1], value: m[2] });
        }
        const attrs = { length: items.length, item: (i) => items[i] || null, get: (k) => map.get(k) ?? null };

        const elem = {
          tagName,
          localName,
          attributes: attrs,
          children: [],
          childNodes: [],
          getAttribute: (k) => attrs.get(k),
          getElementsByTagName: function (name) {
            const list = [];
            function scan(e) {
              for (const ch of e.children) {
                if (name === "*" || ch.tagName === name || ch.localName === name) list.push(ch);
                scan(ch);
              }
            }
            scan(this);
            return list;
          },
          getElementsByTagNameNS: function (ns, name) {
            return this.getElementsByTagName(name);
          },
        };

        if (!root) root = elem;
        if (stack.length > 0) {
          stack[stack.length - 1].children.push(elem);
          stack[stack.length - 1].childNodes.push(elem);
        }
        if (!isSelfClosing) stack.push(elem);
      }

      return {
        documentElement: root,
        getElementsByTagName: (name) => {
          const list = [];
          if (root) {
            if (name === "*" || root.tagName === name || root.localName === name) list.push(root);
            list.push(...root.getElementsByTagName(name));
          }
          return list;
        },
        getElementsByTagNameNS: (ns, name) => root ? root.getElementsByTagName(name) : [],
      };
    }
  }

  const sandboxModule = { exports: {} };
  const sandbox = {
    module: sandboxModule,
    exports: sandboxModule.exports,
    console,
    performance,
    window: {
      innerWidth: 1000,
      innerHeight: 800,
      scrollY: 0,
      addEventListener: () => {},
      removeEventListener: () => {},
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    },
    document: {
      hidden: false,
      createElement: () => new MockElement(),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    AbortController,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => {} },
    Blob: globalThis.Blob,
    Uint8Array: globalThis.Uint8Array,
    ArrayBuffer: globalThis.ArrayBuffer,
    TextDecoder: globalThis.TextDecoder,
    TextEncoder: globalThis.TextEncoder,
    DOMParser: StackDOMParser,
    Image: MockElement,
  };

  vm.default.runInNewContext(bundleResult.outputFiles[0].text, sandbox);
  const pkg = sandboxModule.exports;

  // 1. Import Japanese Ayaka & Shimeji-ee in sandbox
  const jpBuf = readFileSync(JAPANESE_ZIP_PATH);
  await pkg.importMascotPack(new Uint8Array(jpBuf), { name: "Ayaka" });
  assert.equal(pkg.hasMascotPack("Ayaka"), true);

  const eeBuf = readFileSync(SHIMEJIEE_ZIP_PATH);
  await pkg.importMascotPack(new Uint8Array(eeBuf));
  assert.equal(pkg.hasMascotPack("Shimeji"), true);

  // 2. Initialize engines and verify action/behavior tree
  const container = new MockElement();
  const jpEngine = new pkg.MascotEngine(container, "Ayaka");
  await jpEngine.init();
  assert.ok(Object.keys(jpEngine.config.actions).length >= 90, "Japanese Ayaka should parse 90+ actions");
  assert.ok(jpEngine.config.behaviors.length >= 50, "Japanese Ayaka should parse 50+ behaviors");
  assert.equal(jpEngine.currentBehavior.name, "Fall");

  const eeEngine = new pkg.MascotEngine(container, "Shimeji");
  await eeEngine.init();
  assert.ok(Object.keys(eeEngine.config.actions).length >= 90, "Shimeji-ee should parse 90+ actions");
  assert.ok(eeEngine.config.behaviors.length >= 50, "Shimeji-ee should parse 50+ behaviors");
  assert.equal(eeEngine.currentBehavior.name, "Fall");

  // 3. Step physics ticks: verify gravity acceleration and floor landing
  let prevY = jpEngine.position().y;
  let didFall = false;
  for (let tick = 1; tick <= 50; tick++) {
    jpEngine.tick();
    if (jpEngine.position().y > prevY) didFall = true;
    prevY = jpEngine.position().y;
  }
  assert.ok(didFall, "Ayaka should physically fall due to gravity");
  assert.equal(jpEngine.surfaceAt(), "floor", "Ayaka should land on floor");

  // 4. Drag & drop interaction
  jpEngine.beginDrag(jpEngine.position().x, jpEngine.position().y);
  assert.equal(jpEngine.isDragging, true, "Dragging should be active");
  assert.equal(jpEngine.currentBehavior.name, "Dragged", "Behavior should switch to Dragged");

  jpEngine.endDrag();
  assert.equal(jpEngine.isDragging, false, "Dragging should be released");

  // 5. Cleanup
  jpEngine.destroy();
  eeEngine.destroy();
  pkg.PackRegistry.clear();
});


