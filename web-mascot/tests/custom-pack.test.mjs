import assert from "node:assert/strict";
import { test } from "node:test";
import { zipSync, strToU8 } from "fflate";
import {
  translateShimejiXml,
  PackRegistry,
  ShimejiFinder,
  normalizeSpriteKey,
  importMascotPack,
  registerMascotPack,
  unregisterMascotPack,
  hasMascotPack,
} from "../dist/index.js";

// Note: To test in Node environment without browser DOMParser/Blob,
// we provide lightweight shims for DOMParser and URL.createObjectURL.
if (typeof globalThis.DOMParser === "undefined") {
  // Use a regex/mock DOMParser for Node test environment
  globalThis.DOMParser = class MockDOMParser {
    parseFromString(text, type) {
      if (text.includes("<parsererror")) {
        return { getElementsByTagName: () => [{}], childNodes: [] };
      }
      return {
        getElementsByTagName: (name) => {
          if (name === "parsererror") return [];
          const matches = [];
          const regex = new RegExp(`<${name}[^>]*>`, "gi");
          let m;
          while ((m = regex.exec(text)) !== null) {
            const attrStr = m[0];
            const getAttr = (k) => {
              const am = attrStr.match(new RegExp(`${k}=["']([^"']*)["']`, "i"));
              return am ? am[1] : null;
            };
            matches.push({
              tagName: name,
              getAttribute: getAttr,
              attributes: {
                item: () => null,
                length: 0,
              },
            });
          }
          return matches;
        },
        getElementsByTagNameNS: () => [],
      };
    }
  };
}

if (typeof globalThis.URL.createObjectURL === "undefined") {
  let counter = 0;
  globalThis.URL.createObjectURL = () => `blob:mock-blob-${++counter}`;
  globalThis.URL.revokeObjectURL = () => {};
}

test("Translator: translates Japanese Shimeji tags and attributes to English", () => {
  const jpXml = `\uFEFF<?xml version="1.0" encoding="UTF-8" ?>
<マスコット xmlns="http://www.group-finity.com/Mascot">
  <動作リスト>
    <動作 名前="Stand" 種類="静止" 枠="地面">
      <アニメーション>
        <ポーズ 画像="/shime1.png" 基準座標="64,128" 移動速度="0,0" 長さ="250" />
      </アニメーション>
    </動作>
  </動作リスト>
</マスコット>`;

  const translated = translateShimejiXml(jpXml);

  assert.ok(!translated.startsWith("\uFEFF"), "BOM must be stripped");
  assert.ok(translated.includes("<Mascot"), "Tag <マスコット> translated to <Mascot>");
  assert.ok(translated.includes("<ActionList>"), "Tag <動作リスト> translated to <ActionList>");
  assert.ok(translated.includes('<Action Name="Stand" Type="Stay" BorderType="Floor">'), "Action attributes translated");
  assert.ok(translated.includes("<Animation>"), "Tag <アニメーション> translated");
  assert.ok(translated.includes('<Pose Image="/shime1.png" ImageAnchor="64,128" Velocity="0,0" Duration="250"'), "Pose and attributes translated");
});

test("PackRegistry: registers, retrieves, and unregisters packs cleanly", () => {
  PackRegistry.clear();
  assert.equal(PackRegistry.has("TestPet"), false);

  const pack = {
    name: "TestPet",
    actionsXml: "<Actions></Actions>",
    behaviorsXml: "<Behaviors></Behaviors>",
    sprites: new Map([
      ["shime1.png", "blob:mock-blob-1"],
      ["shime2.png", "blob:mock-blob-2"],
    ]),
  };

  PackRegistry.register(pack);
  assert.equal(PackRegistry.has("TestPet"), true);
  assert.equal(PackRegistry.get("TestPet")?.name, "TestPet");
  assert.deepEqual(PackRegistry.list(), ["TestPet"]);

  assert.equal(PackRegistry.unregister("TestPet"), true);
  assert.equal(PackRegistry.has("TestPet"), false);
  assert.equal(PackRegistry.get("TestPet"), undefined);
});

test("ShimejiFinder: parses Shimeji-ee zip archive and normalizes sprite paths", async () => {
  const dummyActions = `<Mascot><ActionList><Action Name="Stand" Type="Stay"><Animation><Pose Image="/shime1.png" Duration="10"/></Animation></Action></ActionList></Mascot>`;
  const dummyBehaviors = `<Mascot><BehaviorList><Behavior Name="Stand" Frequency="100"/></BehaviorList></Mascot>`;
  const dummyPng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]); // PNG magic bytes

  const zipData = zipSync({
    "MyCustomPet/conf/actions.xml": strToU8(dummyActions),
    "MyCustomPet/conf/behaviors.xml": strToU8(dummyBehaviors),
    "MyCustomPet/img/shime1.png": dummyPng,
    "MyCustomPet/info.json": strToU8(JSON.stringify({ author: "Tester", version: "1.0" })),
  });

  const pack = await ShimejiFinder.analyze(zipData);

  assert.equal(pack.name, "MyCustomPet");
  assert.ok(pack.actionsXml.includes("Stand"));
  assert.ok(pack.behaviorsXml.includes("Stand"));
  assert.equal(pack.meta?.author, "Tester");

  // Sprites should map normalized keys
  assert.ok(pack.sprites.has("shime1.png"));
  assert.ok(pack.sprites.has("/shime1.png"));
});

test("ShimejiFinder: synthesizes 46-frame default Shimeji when XML is missing", async () => {
  const files = {};
  const dummyPng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  for (let i = 1; i <= 46; i++) {
    files[`SkinPack/shime${i}.png`] = dummyPng;
  }

  const zipData = zipSync(files);
  const pack = await ShimejiFinder.analyze(zipData, { name: "Skin46" });

  assert.equal(pack.name, "Skin46");
  assert.ok(pack.actionsXml.includes("<Mascot"));
  assert.ok(pack.behaviorsXml.includes("ChaseMouse"));
  assert.ok(pack.sprites.has("shime1.png"));
  assert.ok(pack.sprites.has("/shime46.png"));
});

test("normalizeSpriteKey: handles paths with slashes, img prefix and missing extension", () => {
  assert.equal(normalizeSpriteKey("/shime1.png"), "shime1.png");
  assert.equal(normalizeSpriteKey("img/shime2.PNG"), "shime2.png");
  assert.equal(normalizeSpriteKey("/img/sub/shime3"), "sub/shime3.png");
  assert.equal(normalizeSpriteKey("shime4"), "shime4.png");
});

test("importMascotPack: imports archive and can replace built-in model", async () => {
  PackRegistry.clear();

  const dummyActions = `<Mascot><ActionList><Action Name="Stand" Type="Stay"><Animation><Pose Image="/shime1.png" Duration="10"/></Animation></Action></ActionList></Mascot>`;
  const dummyBehaviors = `<Mascot><BehaviorList><Behavior Name="Stand" Frequency="100"/></BehaviorList></Mascot>`;
  const dummyPng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  const zipData = zipSync({
    "CustomNeuron/conf/actions.xml": strToU8(dummyActions),
    "CustomNeuron/conf/behaviors.xml": strToU8(dummyBehaviors),
    "CustomNeuron/img/shime1.png": dummyPng,
  });

  // Import with explicit name "Neuron" (replacing built-in model in PackRegistry)
  const { name, warnings, unregister } = await importMascotPack(zipData, { name: "Neuron", replaceBuiltin: true });

  assert.equal(name, "Neuron");
  assert.equal(hasMascotPack("Neuron"), true);
  assert.ok(Array.isArray(warnings));
  const pack = PackRegistry.get("Neuron");
  assert.ok(pack !== undefined);
  assert.ok(pack.sprites.has("shime1.png"));

  // Clean up using unregister function returned by importMascotPack
  assert.equal(unregister(), true);
  assert.equal(hasMascotPack("Neuron"), false);
});


