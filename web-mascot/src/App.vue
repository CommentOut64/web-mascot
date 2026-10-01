<template>
  <div class="test-panel">
    <h3>Web Mascot Engine</h3>
    <div class="controls">
      <button @click="spawnPet('Neuron')">Spawn Neuron</button>
      <button @click="spawnPet('Eviling')">Spawn Eviling</button>
      <button @click="clearPets()">Clear Pets</button>
    </div>
  </div>

  <div ref="petContainer" id="web-mascot-root"></div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { MascotEngine } from "./core/MascotEngine";

const petContainer = ref<HTMLElement | null>(null);
const activeEngines: MascotEngine[] = [];
// Dev convenience: `__mascotEngines[0].snapshot()` in the browser console.
// Note: an engine's own `x`/`y` are *virtual* units (1 unit = 1 sprite pixel; see
// `scale` in the animation config). Use `position()`, `snapshot()` or the
// observation log for page pixels.
(window as unknown as { __mascotEngines: MascotEngine[] }).__mascotEngines = activeEngines;

async function spawnPet(name: string) {
  if (!petContainer.value) return;
  console.log(`Spawning ${name}...`);
  const engine = new MascotEngine(petContainer.value, name);
  await engine.init();
  activeEngines.push(engine);
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
  position: absolute;
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
</style>
