<template>
  <div class="test-panel">
    <h3>Web Mascot Engine</h3>
    <div class="controls">
      <button @click="spawnPet('Neuron')">Spawn Neuron</button>
      <button @click="spawnPet('Eviling')">Spawn Eviling</button>
      <button @click="clearPets()">Clear Pets</button>
      <label class="toggle-label">
        <input type="checkbox" v-model="bouncyEnabled" @change="updateBouncy" />
        Q 弹动效 (Bouncy)
      </label>
      <div v-if="bouncyEnabled" class="slider-group">
        <label>频率: {{ bouncyFreq }} Hz</label>
        <input type="range" min="1" max="8" step="0.5" v-model.number="bouncyFreq" @input="updateBouncy" />
        <label>压缩量: {{ Math.round(bouncySquash * 100) }}%</label>
        <input type="range" min="0.05" max="0.3" step="0.01" v-model.number="bouncySquash" @input="updateBouncy" />
      </div>
    </div>
  </div>

  <div class="scroll-content">
    <h1>Scroll Test Page</h1>
    <p>向下滚动网页来测试宠物的滚动反馈！</p>
    <p v-for="i in 100" :key="i">
      这是第 {{ i }} 段测试文本。尝试在这里上下滚动，你可以观察到：<br/>
      1. 滚动时，挂墙或挂顶的宠物会松手自由下落。<br/>
      2. 滚动换算宠物的文档位置，保留自身速度与动作，不额外施力。<br/>
      3. 地面宠物在页面下滚时从原文档位置下落；页面上滚时保持底部支撑。<br/>
      4. 下落触底后播放落地动画；左右和底部有界，仅自由下落可越过顶部。
    </p>
  </div>

  <div ref="petContainer" id="web-mascot-root"></div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { MascotEngine } from "./core/MascotEngine";

const petContainer = ref<HTMLElement | null>(null);
const activeEngines: MascotEngine[] = [];
const bouncyEnabled = ref(true);
const bouncyFreq = ref(1.8);
const bouncySquash = ref(0.22);

// Dev convenience: `__mascotEngines[0].snapshot()` in the browser console.
// Note: an engine's own `x`/`y` are *virtual* units (1 unit = 1 sprite pixel; see
// `scale` in the animation config). Use `position()`, `snapshot()` or the
// observation log for viewport pixels.
(window as unknown as { __mascotEngines: MascotEngine[] }).__mascotEngines = activeEngines;

function updateBouncy() {
  for (const engine of activeEngines) {
    engine.setBouncy(bouncyEnabled.value, {
      frequency: bouncyFreq.value,
      squashAmount: bouncySquash.value,
    });
  }
}

async function spawnPet(name: string) {
  if (!petContainer.value) return;
  console.log(`Spawning ${name}...`);
  const engine = new MascotEngine(petContainer.value, name);
  activeEngines.push(engine);
  try {
    await engine.init({
      bouncy: {
        enabled: bouncyEnabled.value,
        frequency: bouncyFreq.value,
        squashAmount: bouncySquash.value,
      },
    });
  } catch (error) {
    const index = activeEngines.indexOf(engine);
    if (index >= 0) activeEngines.splice(index, 1);
    engine.destroy();
    console.error(`Failed to spawn ${name}`, error);
  }
}

function clearPets() {
  for (const engine of activeEngines) {
    engine.destroy();
  }
  activeEngines.length = 0;
  if (petContainer.value) {
    petContainer.value.innerHTML = "";
  }
}
</script>

<style scoped>
.test-panel {
  position: fixed;
  top: 20px;
  right: 20px;
  background: white;
  padding: 15px;
  border-radius: 8px;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
  z-index: 10000;
  border: 1px solid #ccc;
  font-family: sans-serif;
}
.controls {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
button {
  padding: 8px 12px;
  cursor: pointer;
}
#web-mascot-root {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  pointer-events: none; /* Let clicks pass through to background */
  z-index: 9999;
}
.scroll-content {
  padding: 40px;
  max-width: 800px;
  margin: 0 auto;
  font-family: sans-serif;
  color: #444;
}
.scroll-content h1 {
  font-size: 2em;
  margin-bottom: 1em;
}
.scroll-content p {
  margin-bottom: 2em;
  line-height: 1.8;
  font-size: 1.1em;
  background-color: #fff;
  padding: 15px;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.05);
}
</style>
